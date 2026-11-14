// SPDX-License-Identifier: FSL-1.1-ALv2

import { sql as drizzleSql } from "drizzle-orm"
import { z } from "zod"
import { extractRows } from "~/db"
import { withReleasedSavepoint } from "~/db/savepoint"
import { sanitizeCustomerHtml } from "~/lib/email/sanitize"
import { fetchWithPinnedHost } from "~/lib/outbound-fetch"
import { quoteIdent } from "~/lib/sql-utils"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import {
  kernelCaller,
  kernelRoles,
  kernelUsersByEmail,
} from "~/modules/apps/sandbox/bridge/directory"
import {
  BASE_ENTITY_FIELDS,
  SANDBOX_FETCH_MAX_REDIRECTS,
  sandboxEgressOverrides,
  sandboxEgressPolicy,
  snakeCase,
  validateSandboxFetchUrl,
  withPgCause,
} from "~/modules/apps/sandbox/bridge/shared"
import {
  appContactAudience,
  resolveContact as resolveContactService,
} from "~/modules/contacts/service"
import { assertDemoAppFetchAllowed } from "~/modules/demo/demo-egress"
import { maybeDemoPaymentsResponse } from "~/modules/demo/worlds/saas/payments/provider"

/** The app's own tables (db_*), kernel reads, contact resolution and bulk blobs. */
/** The mail tables whose rows belong to one account and die with a reset. */
const MAILBOX_CONTENT_ENTITIES: ReadonlySet<string> = new Set([
  "messages",
  "conversations",
  "drafts",
])

/**
 * How long a commit-now write waits for a row lock. It runs on a second
 * connection beside the run's own transaction, so a row the run itself already
 * locked would otherwise wait on its own caller until the statement timeout.
 */
const COMMIT_NOW_LOCK_TIMEOUT = "5s"

/** Options of a db method set built for one caller (ctx.db.batch). */
export interface DbMethodsOptions {
  /**
   * Told the number of rows each `db_update` / `db_delete` statement matched
   * (the methods themselves still answer nothing to a handler). ctx.db.batch
   * reads it to check an op's `expect` guard.
   */
  onRowCount?: (rows: number) => void
}

/** The row count of a write statement's result (postgres.js `count`, node-postgres `rowCount`). */
export function affectedRows(result: unknown): number {
  const r = result as { rowCount?: unknown; count?: unknown } | null | undefined
  return Number(r?.rowCount ?? r?.count ?? 0)
}

export function createDbMethods(
  ctx: BridgeContext,
  opts: DbMethodsOptions = {},
): Record<string, any> {
  /**
   * `ctx.db.insertNow` / `ctx.db.updateNow`: the same write as `insert` /
   * `update`, with every check they make (the app's own declared tables only,
   * declared fields, `org_id` forced to the bridge's org, the run's RLS actor,
   * refused on a read-only run), committed in its own transaction at once. An
   * app writes its intent row this way before an outside call it cannot undo
   * (a paid label), so the row survives the run's rollback when the sandbox is
   * killed after the call.
   */
  async function commitNow(
    what: "ctx.db.insertNow" | "ctx.db.updateNow",
    entity: string,
    write: (methods: Record<string, any>) => Promise<unknown>,
  ): Promise<unknown> {
    ctx.refuseWriteOnReadOnlyRun(ctx.writeTarget(entity), what)
    ctx.validateEntity(entity)
    const commitNowTx = ctx.bridgeOptions?.commitNowTx
    if (!commitNowTx) {
      throw new Error(
        `${what}: this run has no transaction of its own to commit ahead in (only tool runs do). ` +
          `Use ${what === "ctx.db.insertNow" ? "ctx.db.insert" : "ctx.db.update"}, which commits with the run.`,
      )
    }
    return commitNowTx(async (tx) => {
      await tx.execute(drizzleSql.raw(`SET LOCAL lock_timeout = '${COMMIT_NOW_LOCK_TIMEOUT}'`))
      return write(createDbMethods({ ...ctx, txDb: tx }))
    })
  }

  const {
    appName,
    assertMailboxNotResetMidRun,
    assertNoMailboxPlaintext,
    buildFilteredWhereClause,
    bulkIteratorCursors,
    callerScopes,
    captureMailboxSnapshot,
    coerceByteaRowFields,
    coerceNumericRowFields,
    errorEnvelope,
    findEntityById,
    findKernelContactsByExternalId,
    findKernelEntityById,
    findKernelEntitiesByIds,
    manifest,
    multiTermSearch,
    orgId,
    refuseWriteOnReadOnlyRun,
    bridgeReadOnlyRun,
    requireCapability,
    schemaName,
    stampMailAccountEncryptionState,
    toSqlValue,
    txDb,
    userId,
    validateEntity,
    validateFields,
    validateWhereFields,
    writeTarget,
  } = ctx
  /** The account a mail row belongs to, for the reset guard. Mail app only. */
  async function mailAccountOfRow(entity: string, id: string): Promise<string | null> {
    if (appName !== "mail") return null
    const rows = extractRows<{ account_id: string | null }>(
      await txDb.execute(
        drizzleSql`SELECT account_id::text AS account_id FROM ${drizzleSql.raw(
          `${quoteIdent(schemaName)}.${quoteIdent(entity)}`,
        )} WHERE id = ${id} AND org_id = ${orgId}`,
      ),
    )
    return rows[0]?.account_id ?? null
  }

  return {
    // --- Database operations ---
    db_findMany: async (entity: string, optsJson: string) => {
      validateEntity(entity)
      await captureMailboxSnapshot()
      const rawOpts = JSON.parse(optsJson || "{}")
      // Validate pagination params before they reach SQL. NaN/negative/non-integer
      // values from the sandbox would surface as pg errors without this guard.
      const dbFindManyOptsSchema = z.object({
        limit: z.number().int().min(1).max(1000).optional().catch(undefined),
        offset: z.number().int().min(0).optional().catch(undefined),
        where: z.record(z.string(), z.unknown()).optional(),
        search: z
          .object({ fields: z.array(z.string()).optional(), query: z.string().optional() })
          .optional(),
        orderBy: z.record(z.string(), z.enum(["asc", "desc"])).optional(),
        // Column projection. Without it every read is `SELECT *`, which drags
        // full bodies (and their ciphertext, base64-inflated) into the sandbox
        // heap: a conversation-wide read of a 70-message thread was 8+ MB in
        // Postgres and blew the 32 MB QuickJS limit on every label change.
        select: z.array(z.string()).min(1).optional(),
      })
      const parsed = dbFindManyOptsSchema.safeParse(rawOpts)
      if (!parsed.success) {
        throw new Error(
          `db_findMany: invalid options — ${parsed.error.issues.map((i) => i.message).join("; ")}`,
        )
      }
      const opts = parsed.data
      const table = drizzleSql.raw(`${quoteIdent(schemaName)}.${quoteIdent(entity)}`)

      // SECURITY: validate select keys against the declared schema exactly like
      // orderBy, so an app cannot project undeclared / kernel-internal columns.
      let projection = drizzleSql.raw("*")
      if (opts.select) {
        const selectFields = manifest.schema?.[entity]?.fields ?? {}
        const cols = [...new Set(opts.select)].map((k) => {
          if (!BASE_ENTITY_FIELDS.has(k) && !(k in selectFields)) {
            throw new Error(
              `Unknown select field "${k}" on entity "${entity}". Declared fields: ${Object.keys(selectFields).join(", ")}`,
            )
          }
          return quoteIdent(snakeCase(k))
        })
        projection = drizzleSql.raw(cols.join(", "))
      }
      // Clamp and floor after schema validation: rejects NaN/negative/non-integer before here.
      const limit = Math.min(opts.limit ?? 1000, 1000)
      const offset = Math.max(0, Math.floor(opts.offset ?? 0))
      const whereClause = buildFilteredWhereClause(entity, opts.where, opts.search)

      let orderClause = drizzleSql.raw("")
      if (opts.orderBy) {
        // SECURITY: validate orderBy keys against the declared schema, mirroring
        // validateWhereFields. Without this, an app can order by undeclared /
        // manifest-author-internal columns; quoteIdent prevents injection but the
        // failure surfaces as a raw pg error instead of a clean validation
        // message, and it is inconsistent with the where/search field checks.
        const orderFields = manifest.schema?.[entity]?.fields ?? {}
        const parts = Object.entries(opts.orderBy)
          .map(([k, d]) => {
            // Allow the kernel-managed base columns present on every app entity
            // table (see generateTableDdl systemCols) in addition to the
            // manifest-declared fields — ordering by createdAt/updatedAt is a
            // routine, safe operation that apps must not have to redeclare.
            if (!BASE_ENTITY_FIELDS.has(k) && !(k in orderFields)) {
              throw new Error(
                `Unknown orderBy field "${k}" on entity "${entity}". Declared fields: ${Object.keys(orderFields).join(", ")}`,
              )
            }
            return `${quoteIdent(snakeCase(k))} ${d === "desc" ? "DESC" : "ASC"}`
          })
          .join(", ")
        orderClause = drizzleSql.raw(` ORDER BY ${parts}`)
      }

      try {
        let rows = extractRows(
          await txDb.execute(
            drizzleSql`SELECT ${projection} FROM ${table} WHERE ${whereClause} ${orderClause} LIMIT ${limit} OFFSET ${offset}`,
          ),
        )
        // BL-53 recall fallback: a precise AND-of-terms search that finds nothing on the FIRST page
        // re-runs as OR-of-terms, so an over-specific multi-term query (one term a non-match — e.g.
        // "bricking" vs the seeded "bricked") still surfaces the strong partial matches instead of an
        // empty result the agent gives up on. Guarded to offset 0 (an empty later page just means "no
        // more rows", not "AND was too strict") so deep pagination never silently widens.
        if (rows.length === 0 && offset === 0 && multiTermSearch(opts.search)) {
          const orClause = buildFilteredWhereClause(entity, opts.where, opts.search, "any")
          rows = extractRows(
            await txDb.execute(
              drizzleSql`SELECT ${projection} FROM ${table} WHERE ${orClause} ${orderClause} LIMIT ${limit} OFFSET ${offset}`,
            ),
          )
        }
        return JSON.stringify(coerceByteaRowFields(entity, coerceNumericRowFields(entity, rows)))
      } catch (err) {
        // Drizzle wraps the postgres error in a DrizzleQueryError whose .message
        // is the SQL+params, hiding the actual pg error in .cause. The QuickJS
        // bridge serializes only .message back to the sandbox, so without
        // surfacing the cause we lose visibility on RLS/role/column-mismatch
        // bugs that surface only inside chaos sim app handlers.
        const e = err as { message?: string; cause?: { message?: string; code?: string } }
        if (e?.cause?.message) {
          throw new Error(
            `${e.message ?? "db_findMany failed"} — pg: ${e.cause.message}${e.cause.code ? ` (${e.cause.code})` : ""}`,
          )
        }
        throw err
      }
    },

    db_findOne: async (entity: string, id: string) => {
      await captureMailboxSnapshot()
      return JSON.stringify(await findEntityById(entity, id))
    },

    kernel_findOne: async (entity: string, id: string) => {
      return JSON.stringify(await findKernelEntityById(entity, id))
    },

    kernel_findByIds: async (entity: string, idsJson: unknown) => {
      const ids = typeof idsJson === "string" ? JSON.parse(idsJson) : idsJson
      if (!Array.isArray(ids)) throw new Error("kernel_findByIds: ids is an array")
      return JSON.stringify(await findKernelEntitiesByIds(entity, ids))
    },

    // Directory reads for an app's own access rules (directory.ts).
    kernel_caller: async (scopesJson?: unknown) =>
      JSON.stringify(
        await kernelCaller({ orgId, userId, callerScopes: callerScopes ?? [] }, scopesJson),
      ),
    kernel_roles: async () => JSON.stringify(await kernelRoles(txDb, orgId)),
    kernel_findUsersByEmail: async (emailsJson: unknown) =>
      JSON.stringify(await kernelUsersByEmail(txDb, orgId, emailsJson)),

    // Cluster 6 — kernel read affordance. Exposed to handlers as both
    // `ctx.kernel.findContactsByExternalId(limit, cursor)` (kernel-convention
    // nested form, via the `kernel_` prefix split in the sandbox shim) and the
    // flat `ctx.listContactsByExternalId(limit, cursor)` alias the reconcile
    // job calls. Lists this app's externally-linked kernel.contacts, paged.
    kernel_findContactsByExternalId: async (limit?: number, cursor?: string) => {
      return JSON.stringify(await findKernelContactsByExternalId(limit ?? 50, cursor ?? null))
    },
    listContactsByExternalId: async (limit?: number, cursor?: string) => {
      return JSON.stringify(await findKernelContactsByExternalId(limit ?? 50, cursor ?? null))
    },

    /**
     * Phase 17 — pending approval read affordance for bundled apps.
     *
     * Returns approvals where the calling user is in `notify_user_ids` AND
     * holds the relevant `<app>:approve` scope, optionally filtered to
     * `tool_name` starting with `toolNamePrefix` (e.g. "invoicing:"). The
     * underlying `listApprovals` already RLS-scopes to `orgId` and enforces
     * the per-app approve-scope gate; this affordance is a thin pass-through
     * that exposes it to the sandbox.
     */
    kernel_listApprovals: async (toolNamePrefix?: string, limit?: number) => {
      const { listApprovals } = await import("~/modules/approvals/list")
      const all = await listApprovals(txDb, {
        orgId,
        userId,
        scopes: callerScopes ?? [],
      })
      const filtered = toolNamePrefix
        ? all.filter((a) => a.toolName.startsWith(toolNamePrefix))
        : all
      const cap = Math.max(1, Math.min(Math.floor(limit ?? 50) || 50, 200))
      return JSON.stringify(filtered.slice(0, cap))
    },

    db_insert: async (entity: string, dataJson: string) => {
      refuseWriteOnReadOnlyRun(writeTarget(entity), "ctx.db.insert")
      validateEntity(entity)
      const data = JSON.parse(dataJson)
      validateFields(entity, data)
      await assertNoMailboxPlaintext(entity, data, () => data.accountId as string | undefined)
      if (MAILBOX_CONTENT_ENTITIES.has(entity)) {
        await assertMailboxNotResetMidRun([data.accountId as string | undefined])
      }
      await stampMailAccountEncryptionState(entity, data)
      // Sanitize HTML bodies of inbound messages server-side as a defence-in-depth
      // measure — the client renderer is the last line of defence, but storing
      // already-stripped HTML prevents exfiltration via other read paths (exports,
      // webhooks, agent tool calls) and reduces CSP bypass surface.
      if (
        entity === "messages" &&
        data.direction === "inbound" &&
        typeof data.htmlBody === "string"
      ) {
        data.htmlBody = sanitizeCustomerHtml(data.htmlBody)
      }
      const allData = { ...data, org_id: orgId }
      const entries = Object.entries(allData)
      const tableRef = drizzleSql.raw(`${quoteIdent(schemaName)}.${quoteIdent(entity)}`)
      const colsChunk = drizzleSql.raw(entries.map(([k]) => quoteIdent(snakeCase(k))).join(", "))
      const valsChunk = drizzleSql.join(
        entries.map(([k, v]) => (k === "org_id" ? drizzleSql`${v}` : toSqlValue(entity, k, v))),
        drizzleSql.raw(", "),
      )
      // The INSERT runs in a driver savepoint (`txDb.transaction`) so a constraint violation (e.g. a
      // 23505 unique-key race on a read-then-insert upsert like boxtal's draft_override, or an insert
      // used as a claim) does NOT poison the surrounding transaction: the handler's own recovery
      // (catch the unique violation, re-read, UPDATE) keeps working on the same transaction. It must
      // be the driver's savepoint, not a raw SAVEPOINT statement: postgres.js rethrows the first
      // failed query of a transaction scope when the scope ends, even one the caller caught. It is
      // released when the insert ends, so a handler's many inserts do not nest.
      try {
        const rows = await withReleasedSavepoint(txDb, async (sp) =>
          extractRows(
            await sp.execute(
              drizzleSql`INSERT INTO ${tableRef} (${colsChunk}) VALUES (${valsChunk}) RETURNING *`,
            ),
          ),
        )
        return JSON.stringify(
          coerceByteaRowFields(entity, coerceNumericRowFields(entity, [rows[0] ?? null]))[0] ?? {
            id: null,
          },
        )
      } catch (err) {
        // Surface the postgres cause through Drizzle's wrap. Without this
        // we only see the SQL+params, losing visibility on RLS/role/column-
        // mismatch errors (same pattern as db_findMany above).
        const e = err as { message?: string; cause?: { message?: string; code?: string } }
        if (e?.cause?.message) {
          throw new Error(
            `${e.message ?? "db_insert failed"} — pg: ${e.cause.message}${e.cause.code ? ` (${e.cause.code})` : ""}`,
          )
        }
        throw err
      }
    },

    db_update: async (entity: string, id: string, dataJson: string) => {
      refuseWriteOnReadOnlyRun(writeTarget(entity), "ctx.db.update")
      validateEntity(entity)
      const data = JSON.parse(dataJson)
      validateFields(entity, data)
      await assertNoMailboxPlaintext(entity, data, async () => {
        const rows = extractRows<{ account_id: string }>(
          await txDb.execute(
            drizzleSql`SELECT account_id FROM ${drizzleSql.raw(
              `${quoteIdent(schemaName)}.${quoteIdent(entity)}`,
            )} WHERE id = ${id} AND org_id = ${orgId}`,
          ),
        )
        return rows[0]?.account_id
      })
      if (entity === "accounts") {
        const resetXid = (await assertMailboxNotResetMidRun([id])).get(id)
        // Carry the reset marker forward: a handler writing `syncState: {}`
        // (an expired Gmail history) must not erase it.
        if (
          resetXid &&
          data.syncState &&
          typeof data.syncState === "object" &&
          !("resetXid" in data.syncState)
        ) {
          data.syncState = { ...data.syncState, resetXid }
        }
      } else if (MAILBOX_CONTENT_ENTITIES.has(entity)) {
        await assertMailboxNotResetMidRun([await mailAccountOfRow(entity, id)])
      }
      const tableRef = drizzleSql.raw(`${quoteIdent(schemaName)}.${quoteIdent(entity)}`)
      const entries = Object.entries(data)
      const setChunk = drizzleSql.join(
        entries.map(
          ([k, v]) =>
            drizzleSql`${drizzleSql.raw(quoteIdent(snakeCase(k)))} = ${toSqlValue(entity, k, v)}`,
        ),
        drizzleSql.raw(", "),
      )
      try {
        const result = await txDb.execute(
          drizzleSql`UPDATE ${tableRef} SET ${setChunk}, updated_at = now() WHERE id = ${id} AND org_id = ${orgId}`,
        )
        opts.onRowCount?.(affectedRows(result))
      } catch (err) {
        throw withPgCause(err, "db_update failed")
      }
    },

    db_insertNow: async (entity: string, dataJson: string) =>
      commitNow("ctx.db.insertNow", entity, (m) => m.db_insert(entity, dataJson)),

    db_updateNow: async (entity: string, id: string, dataJson: string) =>
      commitNow("ctx.db.updateNow", entity, (m) => m.db_update(entity, id, dataJson)),

    db_updateMany: async (entity: string, optsJson: string) => {
      refuseWriteOnReadOnlyRun(writeTarget(entity), "ctx.db.updateMany")
      validateEntity(entity)
      const opts = JSON.parse(optsJson)
      if (!opts.where)
        throw new Error("db_updateMany requires a 'where' clause to prevent unbounded updates")
      validateFields(entity, opts.data ?? {})
      const tableRef = drizzleSql.raw(`${quoteIdent(schemaName)}.${quoteIdent(entity)}`)
      const dataEntries = Object.entries(opts.data ?? {})
      if (dataEntries.length === 0) return JSON.stringify({ count: 0 })
      const setChunk = drizzleSql.join(
        dataEntries.map(
          ([k, v]) =>
            drizzleSql`${drizzleSql.raw(quoteIdent(snakeCase(k)))} = ${toSqlValue(entity, k, v)}`,
        ),
        drizzleSql.raw(", "),
      )
      validateWhereFields(entity, opts.where, true)
      const whereClause = buildFilteredWhereClause(entity, opts.where, opts.search)
      // Same Invariant P pre-check as db_insert/db_update. A bulk write has no
      // id to resolve an account from, so the account set comes from the rows
      // the UPDATE is about to touch, read under the same clause.
      await assertNoMailboxPlaintext(entity, opts.data ?? {}, async () => {
        const rows = extractRows<{ account_id: string | null }>(
          await txDb.execute(
            drizzleSql`SELECT DISTINCT account_id FROM ${tableRef} WHERE ${whereClause}`,
          ),
        )
        return rows.map((row) => row.account_id)
      })
      if (appName === "mail" && (entity === "accounts" || MAILBOX_CONTENT_ENTITIES.has(entity))) {
        const column = drizzleSql.raw(entity === "accounts" ? "id" : "account_id")
        const touched = extractRows<{ account_id: string | null }>(
          await txDb.execute(
            drizzleSql`SELECT DISTINCT ${column}::text AS account_id FROM ${tableRef} WHERE ${whereClause}`,
          ),
        )
        await assertMailboxNotResetMidRun(touched.map((row) => row.account_id))
      }
      let result: unknown
      try {
        result = await txDb.execute(
          drizzleSql`UPDATE ${tableRef} SET ${setChunk}, updated_at = now() WHERE ${whereClause}`,
        )
      } catch (err) {
        throw withPgCause(err, "db_updateMany failed")
      }
      return JSON.stringify({ count: affectedRows(result) })
    },

    db_delete: async (entity: string, id: string) => {
      refuseWriteOnReadOnlyRun(writeTarget(entity), "ctx.db.delete")
      validateEntity(entity)
      const table = drizzleSql.raw(`${quoteIdent(schemaName)}.${quoteIdent(entity)}`)
      try {
        const result = await txDb.execute(
          drizzleSql`DELETE FROM ${table} WHERE id = ${id} AND org_id = ${orgId}`,
        )
        opts.onRowCount?.(affectedRows(result))
      } catch (err) {
        throw withPgCause(err, "db_delete failed")
      }
    },

    db_count: async (entity: string, optsJson: string) => {
      validateEntity(entity)
      const opts = JSON.parse(optsJson || "{}")
      const table = drizzleSql.raw(`${quoteIdent(schemaName)}.${quoteIdent(entity)}`)
      validateWhereFields(entity, opts.where, true)
      const whereClause = buildFilteredWhereClause(entity, opts.where, opts.search)
      const rows = extractRows(
        await txDb.execute(
          drizzleSql`SELECT count(*)::int AS count FROM ${table} WHERE ${whereClause}`,
        ),
      )
      let count = Number(rows[0]?.count ?? 0)
      // BL-53: mirror db_findMany's AND→OR recall fallback so totalCount matches the rows the agent
      // actually receives — a precise AND that counts 0 for a multi-term query re-counts under OR.
      if (count === 0 && multiTermSearch(opts.search)) {
        const orClause = buildFilteredWhereClause(entity, opts.where, opts.search, "any")
        const orRows = extractRows(
          await txDb.execute(
            drizzleSql`SELECT count(*)::int AS count FROM ${table} WHERE ${orClause}`,
          ),
        )
        count = Number(orRows[0]?.count ?? 0)
      }
      return String(count)
    },

    // --- Bulk-blob primitive (capability: bulk.fetch) ---
    // Phase 16 Task A7 (Gap 5). The sandbox-facing surface is three RPCs:
    //   bulk_fetchToBlob(urlJson) → { blobId, sizeBytes }
    //   bulk_iterateJsonl_next(blobId, cursor, batchSize) → { batch, nextCursor, done }
    //   bulk_deleteBlob(blobId)
    // The host streams the URL to a temp file (per-org quota); the iterator
    // is host-paginated so the sandbox memory envelope stays bounded.
    bulk_fetchToBlob: async (url: string, optsJson?: string): Promise<string> => {
      try {
        requireCapability("bulk.fetch")
        const opts = optsJson ? (JSON.parse(optsJson) as { headers?: Record<string, string> }) : {}
        const { bulkBlobScope, fetchToBlob } = await import("~/modules/apps/sandbox/bulk-blob")
        const allowPrivateHostsInTest = manifest.network?.allowPrivateHostsInTest ?? false
        // Reuse the sandbox URL validator so quota+fetch share the same allowlist
        // (declared AND granted, context.ts collectAllowedDomains) and private-net
        // protection as `ctx.fetch`.
        const { allowedDomains } = await ctx.egress()
        await validateSandboxFetchUrl(url, allowedDomains, allowPrivateHostsInTest, appName)
        // Same demo posture as `ctx.fetch`: a demo org's bulk download is
        // refused before the stream opens. Unlike `ctx.fetch` there is no
        // fixture exception, Shopify included — the demo provider answers the
        // Admin GraphQL API, not a bulk-export download, so a bulk URL on a
        // demo org has nowhere honest to go. The refusal comes back through
        // `errorEnvelope` below carrying its DEMO_RESTRICTED code and its
        // message, so the app reads an explanation instead of crashing.
        await assertDemoAppFetchAllowed(orgId, url)
        // SECURITY (DNS-rebinding SSRF): stream through `fetchWithPinnedHost`
        // instead of raw `globalThis.fetch`. The plain validator above only
        // checks scheme + literal-IP private ranges + the hostname allowlist
        // with NO DNS resolution; passing the raw URL to fetch would re-resolve
        // DNS at connect time, reopening the TOCTOU that `ctx.fetch` closes.
        // The pinned fetch resolves once, rejects private resolved IPs, and
        // re-runs the allowlist on every redirect hop.
        const pinnedBulkFetch = ((targetUrl: string | URL, init?: RequestInit) =>
          fetchWithPinnedHost(targetUrl, init ?? {}, {
            maxRedirects: SANDBOX_FETCH_MAX_REDIRECTS,
            fetchImpl: sandboxEgressOverrides.fetch ?? undefined,
            ...sandboxEgressPolicy(appName),
            allowPrivateHostsInTest,
            onHopValidate: async (next) => {
              await validateSandboxFetchUrl(next, allowedDomains, allowPrivateHostsInTest, appName)
            },
          })) as typeof fetch
        // Off demo mode the check above lets everything through: a demo org's bulk download from
        // the payments host is still the card-payments stand-in's, answered or refused
        // in-process and never put on the wire, whatever app asks.
        const standIn = await maybeDemoPaymentsResponse({
          orgId,
          appName,
          allowedDomains,
          url,
          method: "GET",
          body: undefined,
          headers: opts.headers,
        })
        const blobFetch = standIn
          ? ((async () => standIn) as unknown as typeof fetch)
          : pinnedBulkFetch
        const result = await fetchToBlob(bulkBlobScope(orgId, appName), url, opts, blobFetch)
        // Track which iterators are open per blobId — first iteration starts at offset 0.
        bulkIteratorCursors.set(result.blobId, { iterator: null, done: false })
        return JSON.stringify(result)
      } catch (e) {
        return errorEnvelope(e)
      }
    },

    bulk_iterateJsonl_next: async (blobId: string, batchSize?: number): Promise<string> => {
      try {
        requireCapability("bulk.fetch")
        const { bulkBlobScope, iterateJsonl } = await import("~/modules/apps/sandbox/bulk-blob")
        let entry = bulkIteratorCursors.get(blobId)
        if (!entry) {
          entry = { iterator: null, done: false }
          bulkIteratorCursors.set(blobId, entry)
        }
        if (entry.done) return JSON.stringify({ batch: [], done: true })
        if (!entry.iterator) {
          entry.iterator = iterateJsonl(bulkBlobScope(orgId, appName), blobId, {
            batchSize: batchSize ?? 50,
          })[Symbol.asyncIterator]()
        }
        const step = await entry.iterator.next()
        if (step.done) {
          entry.done = true
          return JSON.stringify({ batch: [], done: true })
        }
        return JSON.stringify({ batch: step.value, done: false })
      } catch (e) {
        return errorEnvelope(e)
      }
    },

    bulk_deleteBlob: async (blobId: string): Promise<string> => {
      try {
        requireCapability("bulk.fetch")
        const { bulkBlobScope, deleteBlob } = await import("~/modules/apps/sandbox/bulk-blob")
        await deleteBlob(bulkBlobScope(orgId, appName), blobId)
        bulkIteratorCursors.delete(blobId)
        return JSON.stringify({ ok: true })
      } catch (e) {
        return errorEnvelope(e)
      }
    },

    // --- Contacts ---
    resolveContact: async (paramsJson: string) => {
      // Mail resolves senders inside its host page write (`mail_writePage`), which
      // applies the mailbox's ownership: a personal mailbox never creates org
      // contacts. Left open here, this generic door would bypass that rule.
      if (appName === "mail") {
        throw new Error(
          "resolveContact is not available to the mail app: senders resolve in mail_writePage, " +
            "which applies the mailbox's contact policy",
        )
      }
      const rawParams = JSON.parse(paramsJson) as {
        email?: string
        name?: string
        phone?: string
        company?: string
        externalId?: string | Record<string, string>
        clear?: boolean
      }
      // I11 — `clear: true` + `externalId` removes this app's entry from
      // every matching contact's `kernel.contacts.external_ids[<appName>]`
      // jsonb key. The contact row itself is preserved.
      if (rawParams.clear === true) {
        refuseWriteOnReadOnlyRun("kernel.contacts", "ctx.resolveContact({ clear: true })")
        if (typeof rawParams.externalId !== "string" || !rawParams.externalId) {
          throw new Error(
            `App "${appName}" called resolveContact({ clear: true }) without a string externalId.`,
          )
        }
        const { clearContactExternalId } = await import("~/modules/contacts/service")
        const cleared = await clearContactExternalId(txDb, orgId, {
          appKey: appName,
          externalId: rawParams.externalId,
        })
        return JSON.stringify({ cleared })
      }
      // SDK contract (packages/app-sdk/src/types.ts): `externalId?: string` — a flat
      // string. The service layer keeps the multi-app shape `externalId?:
      // Record<string,string>` keyed by app name. The bridge is the keying
      // boundary: it forces the key from `appName` (the calling app's authenticated
      // identity in the bridge context), so an app cannot spoof another app's
      // namespace in `kernel.contacts.external_ids`. Object-shaped externalId from
      // the app is rejected for the same reason.
      const params: {
        email?: string
        name?: string
        phone?: string
        company?: string
        externalId?: Record<string, string>
      } = {
        email: rawParams.email,
        name: rawParams.name,
        phone: rawParams.phone,
        company: rawParams.company,
      }
      if (rawParams.externalId !== undefined && rawParams.externalId !== null) {
        if (typeof rawParams.externalId !== "string") {
          throw new Error(
            `App "${appName}" passed externalId as ${typeof rawParams.externalId}; expected string (the bridge keys it under the calling app's name automatically).`,
          )
        }
        params.externalId = { [appName]: rawParams.externalId }
      }
      try {
        const { contact } = await resolveContactService(
          txDb,
          orgId,
          userId,
          params,
          appContactAudience(manifest.capabilities),
          // A read-only run (an enforced read tool, a draft preview) only looks a
          // contact up: it never links, enriches or creates one, for any app.
          { lookupOnly: bridgeReadOnlyRun },
        )
        return JSON.stringify(contact)
      } catch (err) {
        const e = err as { message?: string; cause?: { message?: string; code?: string } }
        if (e?.cause?.message) {
          throw new Error(
            `${e.message ?? "resolveContact failed"} — pg: ${e.cause.message}${e.cause.code ? ` (${e.cause.code})` : ""}`,
          )
        }
        throw err
      }
    },
  }
}
