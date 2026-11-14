// SPDX-License-Identifier: FSL-1.1-ALv2
import { randomUUID } from "node:crypto"
import { maskWithNote } from "@liaison/shared"
import { sql } from "drizzle-orm"
import {
  type DownloadResult,
  downloadVerifiedMedia as defaultDownloadVerifiedMedia,
  resolverRegistry as defaultResolverRegistry,
  type ResolvedDownload,
} from "~/apps/tickets/link-ingest-download"
import type { PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { type enqueueAppJob as defaultEnqueueAppJob, registerJobWorker } from "~/infra/jobs/jobs"
import { putObject as defaultPutObject, sanitizeFilename } from "~/infra/storage/object-storage"
import { filesLogger as log } from "~/lib/logger"
import { TRANSFER_HOST_WHITELIST } from "~/modules/agent/media/media-analysis-constants"
import { buildStorageKey } from "~/modules/files/service"

const K = sql.raw(schemaRef("kernel"))
const TICKETS = sql.raw(schemaRef("app_tickets"))
// SYSTEM_ACTOR: valid for the outbox `actorId` only — NEVER use for
// finalizeUsage.userId (billing attribution must be a real org user, resolved
// via resolveAnyOrgUser). This worker spends no model credits, so the sentinel
// is correct here.
const SYSTEM_ACTOR = "00000000-0000-0000-0000-000000000000"

export interface LinkIngestJobPayload {
  messageId: string
  orgId: string
  app: "tickets"
  entityId: string
  url: string
  _tx?: PrivilegedDb
}

export interface LinkIngestJobDeps {
  resolverRegistry?: typeof defaultResolverRegistry
  downloadVerifiedMedia?: typeof defaultDownloadVerifiedMedia
  putObject?: typeof defaultPutObject
  privileged?: <T>(
    orgId: string,
    reason: string,
    fn: (tx: PrivilegedDb) => Promise<T>,
  ) => Promise<T>
  /**
   * Injection seam for the analysis-enqueue surface. This worker NEVER analyzes
   * — it only materializes the file + emits `kernel:file:create` (analysis is
   * agent-driven, gated at C1). The seam exists so the "no analysis enqueued"
   * invariant is testable for real (a spy can assert it was never called with
   * `files-media-analysis`).
   */
  enqueueAppJob?: typeof defaultEnqueueAppJob
  whitelist?: string[]
}

/** Append a system/internal `note` message carrying the bare link + reason. */
async function appendSystemNote(
  privileged: NonNullable<LinkIngestJobDeps["privileged"]>,
  orgId: string,
  ticketIdMessageRef: { messageId: string },
  text: string,
): Promise<void> {
  await privileged(orgId, "files:link-ingest-note", async (tx) => {
    // Resolve the ticket id from the originating message so the note attaches to
    // the same ticket the agent is reading.
    const rows = (await tx.execute(
      sql`SELECT ticket_id FROM ${TICKETS}.messages WHERE id = ${ticketIdMessageRef.messageId} AND org_id = ${orgId} LIMIT 1`,
    )) as unknown as Array<{ ticket_id: string }>
    const ticketId = rows[0]?.ticket_id
    if (!ticketId) {
      log.warn({ messageId: ticketIdMessageRef.messageId }, "link-ingest: note skipped, no ticket")
      return
    }
    // The note quotes a link from a customer's mail: masked like the mail was.
    const masked = maskWithNote(text).text
    await tx.execute(
      sql`INSERT INTO ${TICKETS}.messages
            (id, org_id, ticket_id, kind, text_body, snippet, sent_at, created_at, updated_at)
          VALUES (gen_random_uuid(), ${orgId}, ${ticketId}, 'note', ${masked}, ${masked.slice(0, 200)}, now(), now(), now())`,
    )
  })
}

/**
 * Materialize a downloaded transfer-link media file as a normal `kernel.files`
 * row (privileged — no RLS context) and emit `kernel:file:create` via the
 * transactional outbox so thumbnailing/projections fire. No analysis is
 * enqueued. Failure → a system note (never a silent drop).
 */
export async function processLinkIngestJob(
  payload: LinkIngestJobPayload,
  deps: LinkIngestJobDeps = {},
): Promise<void> {
  const { messageId, orgId, url } = payload
  const resolverRegistry = deps.resolverRegistry ?? defaultResolverRegistry
  const downloadVerifiedMedia = deps.downloadVerifiedMedia ?? defaultDownloadVerifiedMedia
  const putObject = deps.putObject ?? defaultPutObject
  const privileged =
    deps.privileged ??
    (<T>(oid: string, reason: string, fn: (tx: PrivilegedDb) => Promise<T>) =>
      withPrivilegedDb(oid, reason, fn))
  const whitelist = deps.whitelist ?? TRANSFER_HOST_WHITELIST

  let host: string
  try {
    host = new URL(url).host.toLowerCase()
  } catch {
    await appendSystemNote(
      privileged,
      orgId,
      { messageId },
      `Could not parse transfer link: ${url}`,
    )
    return
  }

  const resolver = resolverRegistry[host]
  if (!resolver) {
    await appendSystemNote(
      privileged,
      orgId,
      { messageId },
      `No resolver for transfer link: ${url}`,
    )
    return
  }

  let resolved: ResolvedDownload[]
  try {
    resolved = await resolver(url, { whitelist })
  } catch (err) {
    resolved = []
    log.warn({ host }, `resolver threw: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (resolved.length === 0) {
    await appendSystemNote(
      privileged,
      orgId,
      { messageId },
      `Could not retrieve files from transfer link (no downloadable files found): ${url}`,
    )
    return
  }

  let materialized = 0
  for (const dl of resolved) {
    let result: DownloadResult
    try {
      result = await downloadVerifiedMedia(dl.downloadUrl, { whitelist })
    } catch (err) {
      result = { error: err instanceof Error ? err.message : String(err) }
    }
    if ("error" in result) {
      await appendSystemNote(
        privileged,
        orgId,
        { messageId },
        `Could not download a file from transfer link ${url}: ${result.error}`,
      )
      continue
    }

    const filename = sanitizeFilename(dl.filename || `transfer-${randomUUID().slice(0, 8)}`)
    const { bytes, mimeFromMagic } = result

    await privileged(orgId, "files:link-ingest", async (tx) => {
      const key = buildStorageKey({
        orgId,
        app: "tickets",
        entityType: "message",
        entityId: messageId,
        filename,
      })
      await putObject({ key, body: bytes, contentType: mimeFromMagic })
      const fileId = randomUUID()
      await tx.execute(
        sql`INSERT INTO ${K}.files
              (id, org_id, app, entity_type, entity_id, filename, mime_type, size_bytes,
               storage_key, uploaded_by, disposition, content_id, ordinal)
            VALUES (${fileId}, ${orgId}, 'tickets', 'message', ${messageId}, ${filename},
                    ${mimeFromMagic}, ${bytes.byteLength}, ${key}, NULL, 'attachment', NULL, 0)`,
      )
      // Emit kernel:file:create via the transactional outbox (NOT a process-local
      // publish) so the durable thumbnail consumer fires on restart. No analysis.
      await tx.queueEvent({
        app: "kernel",
        entity: "file",
        action: "create",
        entityId: fileId,
        orgId,
        actorId: SYSTEM_ACTOR,
        data: {
          id: fileId,
          app: "tickets",
          entityType: "message",
          entityId: messageId,
          filename,
          mimeType: mimeFromMagic,
          sizeBytes: bytes.byteLength,
          storageKey: key,
        },
      })
    })
    materialized += 1
  }

  if (materialized === 0) {
    log.warn({ messageId, url }, "link-ingest: no files materialized")
  }
}

export function registerLinkIngestJobWorker(): void {
  registerJobWorker("kernel", "files-link-ingest", async (payload) => {
    await processLinkIngestJob(payload as LinkIngestJobPayload)
  })
}
