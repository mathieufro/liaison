// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task B11 — Customer backfill job (Gap-log #5 closes via appCommit).
//
// Flow:
//  1. Look up or create a `backfill_progress` row for entityType="customers".
//  2. If a previous bulk-op completed URL is cached, attempt to stream from it.
//     On 404 (URL expired), fall through to re-run.
//  3. Otherwise issue `bulkOperationRunQuery({ query: "{ customers { … } }" })`.
//  4. Poll `currentBulkOperation` until status ∈ { COMPLETED, FAILED }.
//  5. On COMPLETED: `ctx.bulk.fetchToBlob(url)` → `iterateJsonl` with batchSize 50.
//     For each batch:
//       - Skip rows whose external id is <= cached `cursorExternalId` (resume).
//       - Call `ctx.resolveContact({ email, name, externalId })` per row.
//       - Advance cursor + persist after the batch.
//  6. On FAILED: persist status="failed", emit `customer:backfill_failed`.
//
// External id semantics (Task A0): the SDK passes `externalId: string` and the
// kernel-side bridge keys it under the calling app's name ("shopify"). The
// short id used here is the trailing numeric segment of the Shopify GID.
import type { AppContext } from "@liaison/app-sdk"
import { emitEvent } from "../lib/emit"
import { getShopifyClient } from "../lib/get-client"
import type { ShopifyClient } from "../lib/shopify-client"
import { createPollPacer } from "../lib/timers"

interface BackfillError extends Error {
  code: string
}

function makeError(code: string, message: string): BackfillError {
  const e = new Error(message) as BackfillError
  e.code = code
  return e
}

const BULK_QUERY = `
  mutation StartCustomerBackfill {
    bulkOperationRunQuery(query: "{ customers { edges { node { id email firstName lastName } } } }") {
      bulkOperation { id status }
      userErrors { field message }
    }
  }
`

const POLL_QUERY = `
  query CurrentBulkOp {
    currentBulkOperation {
      id status url errorCode
    }
  }
`

interface BulkOp {
  id: string
  status: "CREATED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELED" | "CANCELING"
  url?: string | null
  errorCode?: string | null
}

interface ShopifyCustomerRow {
  id?: string
  email?: string | null
  firstName?: string | null
  lastName?: string | null
}

interface BackfillProgressRow {
  id: string
  entityType: string
  cursorExternalId: string | null
  blobId: string | null
  status: "idle" | "running" | "failed" | "completed"
}

const BATCH_SIZE = 50

/** Extract the trailing numeric (or alphanumeric) segment from a Shopify GID. */
function shortExternalId(gid: string | undefined): string {
  if (!gid) return ""
  const m = gid.match(/\/(\w+)$/)
  return m ? m[1]! : gid
}

/**
 * Resume comparison: is `ext` at or before the resume `cursor`? Shopify bulk
 * customer exports are ordered by id ascending, so we resume by skipping every
 * row whose external id is `<= cursor`. Numeric ids (the common case) compare
 * numerically; non-numeric ids fall back to a stable string comparison. This
 * is robust to the cursor row itself being deleted between runs — we no longer
 * depend on observing the exact cursor row to stop skipping (the previous
 * equality check would skip the ENTIRE export if the cursor row vanished).
 */
function isAtOrBeforeCursor(ext: string, cursor: string): boolean {
  const a = Number(ext)
  const b = Number(cursor)
  if (Number.isFinite(a) && Number.isFinite(b)) return a <= b
  return ext <= cursor
}

function fullName(row: ShopifyCustomerRow): string | undefined {
  const parts = [row.firstName, row.lastName].filter((x) => x && x.length > 0)
  return parts.length > 0 ? parts.join(" ") : undefined
}

async function loadOrCreateProgress(
  ctx: AppContext,
): Promise<{ row: BackfillProgressRow; existed: boolean }> {
  const rows = (await ctx.db.findMany("backfill_progress", {
    where: { entityType: "customers" },
    limit: 1,
  })) as BackfillProgressRow[]
  if (rows.length > 0) return { row: rows[0]!, existed: true }
  const ins = await ctx.db.insert("backfill_progress", {
    entityType: "customers",
    cursorExternalId: null,
    blobId: null,
    status: "running",
  })
  return {
    row: {
      id: ins.id,
      entityType: "customers",
      cursorExternalId: null,
      blobId: null,
      status: "running",
    },
    existed: false,
  }
}

async function startBulkOp(client: ShopifyClient): Promise<BulkOp> {
  const data = await client.query<{
    bulkOperationRunQuery?: { bulkOperation?: BulkOp; userErrors?: Array<{ message: string }> }
  }>(BULK_QUERY, {})
  const op = data.bulkOperationRunQuery?.bulkOperation
  if (!op) {
    const msg = data.bulkOperationRunQuery?.userErrors?.[0]?.message ?? "no bulkOperation returned"
    throw makeError("BULK_RUN_FAILED", msg)
  }
  return op
}

/** Total wait between bulk-op polls: well inside the job's default 60 s budget. */
const BULK_POLL_WAIT_BUDGET_MS = 20_000

async function pollUntilFinal(client: ShopifyClient): Promise<BulkOp> {
  // The kernel job scheduler retries this whole job, so we only poll a handful
  // of times within one invocation. Between polls the pacer backs off (250 ms
  // doubling to 2 s, at most BULK_POLL_WAIT_BUDGET_MS in all) where the runtime
  // has a timer, and is a no-op where it has none.
  const pace = createPollPacer(BULK_POLL_WAIT_BUDGET_MS)
  for (let i = 0; i < 20; i++) {
    if (i > 0) await pace(i - 1)
    const data = await client.query<{ currentBulkOperation?: BulkOp }>(POLL_QUERY, {})
    const op = data.currentBulkOperation
    if (!op) throw makeError("NO_CURRENT_BULK_OP", "currentBulkOperation returned null")
    if (op.status === "COMPLETED" || op.status === "FAILED" || op.status === "CANCELED") {
      return op
    }
  }
  throw makeError("BULK_POLL_TIMEOUT", "bulk op did not reach a terminal state")
}

/** Look up the current bulk op (no run); used to detect a cached COMPLETED url. */
async function checkCurrentBulkOp(client: ShopifyClient): Promise<BulkOp | null> {
  const data = await client.query<{ currentBulkOperation?: BulkOp }>(POLL_QUERY, {})
  return data.currentBulkOperation ?? null
}

interface StreamResult {
  finalCursor: string | null
}

async function streamAndImport(
  ctx: AppContext,
  progress: BackfillProgressRow,
  url: string,
): Promise<StreamResult> {
  const { blobId } = await ctx.bulk.fetchToBlob(url)
  let lastCursor: string | null = progress.cursorExternalId
  // Resume semantics: skip every row whose external id is `<= cursor` (the
  // export is id-ascending). This is robust to the exact cursor row being
  // deleted between runs — we resume from the first id strictly greater than
  // the cursor regardless of whether the cursor row still exists. (The previous
  // exact-equality skip would silently process nothing if the cursor row had
  // been deleted, because it waited forever to observe a row that never came.)
  const resumeCursor = progress.cursorExternalId
  for await (const batch of ctx.bulk.iterateJsonl(blobId, { batchSize: BATCH_SIZE })) {
    const rows = batch as ShopifyCustomerRow[]
    for (const row of rows) {
      const ext = shortExternalId(row.id)
      if (!ext) continue
      if (resumeCursor && isAtOrBeforeCursor(ext, resumeCursor)) {
        // Already imported on a prior run — skip.
        continue
      }
      await ctx.resolveContact({
        email: row.email ?? undefined,
        name: fullName(row),
        externalId: ext,
      })
      lastCursor = ext
    }
    if (lastCursor !== progress.cursorExternalId) {
      await ctx.db.update("backfill_progress", progress.id, {
        cursorExternalId: lastCursor,
        blobId,
        status: "running",
      })
    }
  }
  await ctx.bulk.deleteBlob(blobId)
  return { finalCursor: lastCursor }
}

interface BlobError extends Error {
  status?: number
  code?: string
}

function isExpiredBlob(err: unknown): boolean {
  const e = err as BlobError
  return e?.status === 404 || e?.code === "BLOB_FETCH_404"
}

export async function backfillCustomersJob(
  _params: Record<string, unknown>,
  ctx: AppContext,
): Promise<{ status: string; cursor: string | null }> {
  const client = await getShopifyClient(ctx)
  const { row: progress, existed } = await loadOrCreateProgress(ctx)

  // Phase 1: reuse a cached COMPLETED bulk-op URL only when a previous run
  // left a progress row that's still `running` AND has no cursor yet — i.e.
  // we may have kicked off a bulk op but crashed before reading any rows.
  // (When `cursorExternalId` is set, we know rows were processed; per Shopify
  // bulk-op semantics the previous result blob is no longer reachable, so a
  // resume must start a fresh bulk op.)
  let bulkUrl: string | null = null
  if (existed && progress.status === "running" && !progress.cursorExternalId) {
    const cached = await checkCurrentBulkOp(client)
    if (cached?.status === "COMPLETED" && cached.url) {
      bulkUrl = cached.url
    }
  }
  if (!bulkUrl) {
    // Phase 2: kick off a fresh bulk op + poll.
    await startBulkOp(client)
    const op = await pollUntilFinal(client)
    if (op.status === "FAILED" || op.status === "CANCELED") {
      await ctx.db.update("backfill_progress", progress.id, {
        status: "failed",
      })
      await emitEvent(ctx, {
        entity: "customer",
        action: "backfill_failed",
        data: { errorCode: op.errorCode ?? null, opId: op.id },
      })
      return { status: "failed", cursor: progress.cursorExternalId }
    }
    if (!op.url) {
      await ctx.db.update("backfill_progress", progress.id, {
        status: "failed",
      })
      await emitEvent(ctx, {
        entity: "customer",
        action: "backfill_failed",
        data: { reason: "no_url" },
      })
      return { status: "failed", cursor: progress.cursorExternalId }
    }
    bulkUrl = op.url
  }

  // Phase 3: stream the JSONL.
  let result: StreamResult
  try {
    result = await streamAndImport(ctx, progress, bulkUrl)
  } catch (err) {
    if (!isExpiredBlob(err)) throw err
    // URL expired — re-run the bulk op once.
    await startBulkOp(client)
    const op = await pollUntilFinal(client)
    if (op.status !== "COMPLETED" || !op.url) {
      await ctx.db.update("backfill_progress", progress.id, {
        status: "failed",
      })
      await emitEvent(ctx, { entity: "customer", action: "backfill_failed", data: { reason: "rerun_failed" } })
      return { status: "failed", cursor: progress.cursorExternalId }
    }
    // Refresh progress from db (cursor may have been updated by partial run).
    const refreshedRows = (await ctx.db.findMany("backfill_progress", {
      where: { entityType: "customers" },
      limit: 1,
    })) as BackfillProgressRow[]
    const refreshed = refreshedRows[0] ?? progress
    result = await streamAndImport(ctx, refreshed, op.url)
  }

  await ctx.db.update("backfill_progress", progress.id, {
    status: "completed",
    cursorExternalId: result.finalCursor,
  })
  await emitEvent(ctx, {
    entity: "customer",
    action: "backfill_completed",
    data: { finalCursor: result.finalCursor },
  })
  return { status: "completed", cursor: result.finalCursor }
}
