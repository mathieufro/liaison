// SPDX-License-Identifier: FSL-1.1-ALv2

import { sql as drizzleSql } from "drizzle-orm"
import { enqueueAppJob } from "~/infra/jobs/jobs"
import { emailBody } from "~/lib/email/email-body"
import { quoteIdent } from "~/lib/sql-utils"
import { civilTimeAt, instantOf } from "~/modules/apps/sandbox/bridge/civil-time"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { snakeCase } from "~/modules/apps/sandbox/bridge/shared"

/**
 * Job payload keys the host reads as the job's identity or as host handles:
 * the acting user and its scope snapshot (`infra/jobs/jobs.ts`, `runtime.ts`)
 * the injected transaction/session, and a cron fan-out run's epoch
 * (`infra/jobs/fanout.ts`). A sandbox never sets them.
 */
const HOST_JOB_FIELDS = new Set(["_userId", "_callerScopes", "_tx", "_session", "_fanout"])

export function withoutHostJobFields(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!HOST_JOB_FIELDS.has(k)) out[k] = v
  }
  return out
}

/** Kernel platform services: events, jobs, realtime, handles, idempotency, sequences, clock, PDF and codecs. */
export function createPlatformMethods(ctx: BridgeContext): Record<string, any> {
  const {
    appName,
    appTable,
    auditActorType,
    bridgeActingAgentId,
    bridgeOptions,
    callerScopes,
    errorEnvelope,
    manifest,
    orgId,
    requireCapability,
    schemaName,
    stampDeclaredEmit,
    txDb,
    userId,
    orgScopedAppChannel,
  } = ctx

  /** A declared discussion entity of this app named by a bridge call, or the refusal to return. */
  const discussionRef = async (
    paramsJson: string,
    verb: "deleted" | "pruned",
  ): Promise<{ app: string; entityType: string; entityId: string } | { error: string }> => {
    const p = JSON.parse(paramsJson || "{}") as { entityType?: unknown; entityId?: unknown }
    if (typeof p.entityType !== "string" || typeof p.entityId !== "string" || !p.entityId) {
      return {
        error: errorEnvelope(
          Object.assign(
            new Error(
              `Give entityType and entityId of the ${verb === "deleted" ? "deleted" : "narrowed"} record.`,
            ),
            {
              code: "invalid_params",
            },
          ),
        ),
      }
    }
    const ref = { app: appName, entityType: p.entityType, entityId: p.entityId }
    const { isDiscussionEntity } = await import("~/modules/threads/entity-discussion")
    if (appName === "projects" || !isDiscussionEntity(orgId, ref)) {
      return {
        error: errorEnvelope(
          Object.assign(
            new Error(
              `${appName}:${p.entityType} declares no discussion (entities.${p.entityType}.discussion): nothing was ${verb}.`,
            ),
            { code: "discussion_not_declared" },
          ),
        ),
      }
    }
    return ref
  }

  /**
   * Whether the record exists at all, past the caller's row security. On a login that can step
   * into liaison_admin the read runs on the handler's own transaction, so a delete it just made
   * counts. Otherwise the privileged read sees only what was committed, where a record the caller
   * deleted in this call still reads: it counts as gone when the caller could see it there.
   */
  const existsForSomeone = async (ref: {
    app: string
    entityType: string
    entityId: string
  }): Promise<boolean> => {
    const { actorContextOf, privilegedFrom, transactionRole } = await import("~/db/privileged")
    const { withRlsContext } = await import("~/db/rls")
    const { canReadThreadAnchorEntity } = await import("~/modules/threads/thread-anchor")
    const { role, canElevate } = await transactionRole(txDb)
    const present = await privilegedFrom(txDb, orgId, "entity-discussion-exists", (ptx) =>
      canReadThreadAnchorEntity(ptx as never, orgId, ref),
    )
    if (!present) return false
    if (role === "liaison_admin" || canElevate) return true
    const actor = await actorContextOf(txDb)
    if (actor.actorType !== "user") return true
    const sawIt = await withRlsContext(actor, (tx) => canReadThreadAnchorEntity(tx, orgId, ref))
    return !sawIt
  }

  /**
   * The file parent of a rendered PDF: one of the calling app's OWN registered fileParents. With
   * an `entityId`, the parent row must be visible in the handler's transaction (same rule as
   * `files_importAttachment`); without one the kernel mints a fresh id the caller then uses as the
   * primary key of the row it inserts (a row born complete, e.g. an immutable record).
   */
  const resolveRenderParent = async (raw: {
    entityType?: unknown
    entityId?: unknown
  }): Promise<{ entityType: string; entityId: string }> => {
    const IDENT_RE = /^[a-z][a-z0-9_-]*$/
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (typeof raw.entityType !== "string" || !IDENT_RE.test(raw.entityType)) {
      throw Object.assign(new Error("invalid parent entityType"), { code: "invalid_parent" })
    }
    const { resolveParent } = await import("~/modules/files/service")
    const reg = resolveParent(orgId, appName, raw.entityType)
    if (!reg)
      throw Object.assign(new Error("forbidden: unknown parent"), { code: "invalid_parent" })
    if (raw.entityId == null) {
      const { randomUUID } = await import("node:crypto")
      return { entityType: raw.entityType, entityId: randomUUID() }
    }
    if (typeof raw.entityId !== "string" || !UUID_RE.test(raw.entityId)) {
      throw Object.assign(new Error("invalid parent entityId"), { code: "invalid_parent" })
    }
    const { extractRows } = await import("~/db")
    const { schemaRef } = await import("~/db/schema-ref")
    const ps = drizzleSql.raw(`"${schemaRef(reg.schemaRef)}"`)
    const pt = drizzleSql.raw(`"${reg.tableName}"`)
    const pj = drizzleSql.raw(`"${reg.joinOn}"`)
    const vis = extractRows<{ id: string }>(
      await txDb.execute(
        drizzleSql`SELECT ${pj}::text AS id FROM ${ps}.${pt} WHERE ${pj}::text = ${raw.entityId} LIMIT 1`,
      ),
    )
    if (vis.length === 0)
      throw Object.assign(new Error("forbidden: parent not visible"), { code: "invalid_parent" })
    return { entityType: raw.entityType, entityId: raw.entityId }
  }

  return {
    // --- Events ---
    emit: async (eventJson: string) => {
      await txDb.queueEvent(stampDeclaredEmit(JSON.parse(eventJson)))
    },

    // --- Realtime pub/sub (capability: realtime.publish) ---
    realtime_publish: async (channel: string, payloadJson: string): Promise<string> => {
      let scoped: string
      try {
        requireCapability("realtime.publish")
        scoped = orgScopedAppChannel(appName, channel)
      } catch (e) {
        return errorEnvelope(e)
      }
      const { REDIS_PREFIX, publishRedis } = await import("~/lib/redis")
      await publishRedis(`${REDIS_PREFIX}${scoped}`, payloadJson)
      return JSON.stringify({ ok: true })
    },

    // --- Discussions ---
    //
    // The app deleted a record of its own that holds a discussion: the thread
    // goes with it (an empty shell where an approval was asked in it), as a
    // contact's does. Only for this app's declared discussion entities, and
    // only once the record is gone: not while it reads in the handler's own
    // transaction, and not while it exists for anyone else (a record hidden
    // from this caller is not a deleted one).
    threads_deleteEntityDiscussion: async (paramsJson: string): Promise<string> => {
      const ref = await discussionRef(paramsJson, "deleted")
      if ("error" in ref) return ref.error
      const { canReadThreadAnchorEntity } = await import("~/modules/threads/thread-anchor")
      const stillThere = (detail: string) =>
        errorEnvelope(
          Object.assign(
            new Error(
              `${appName}:${ref.entityType} ${ref.entityId} still exists${detail}: delete the record first, then its discussion. Nothing was deleted.`,
            ),
            { code: "entity_still_exists" },
          ),
        )
      if (await canReadThreadAnchorEntity(txDb as never, orgId, ref)) return stillThere("")
      if (await existsForSomeone(ref))
        return stillThere(" for people this caller cannot see it for")
      const { deleteEntityDiscussions } = await import("~/modules/threads/entity-discussion")
      const removed = await deleteEntityDiscussions({
        orgId,
        app: appName,
        entityType: ref.entityType,
        entityIds: [ref.entityId],
      })
      return JSON.stringify({
        ok: true,
        deleted: removed.length,
        result:
          removed.length > 0
            ? `The discussion of ${appName}:${ref.entityType} ${ref.entityId} was deleted.`
            : `${appName}:${ref.entityType} ${ref.entityId} had no discussion: nothing to delete.`,
      })
    },

    // The sharing of a record of this app's that holds a discussion narrowed (an
    // audience, a dimension, an owner changed): everyone seated is dropped but the
    // caller, while the caller still sees the record. Whoever still sees it is
    // seated again the next time they open it, so nobody keeps reading a
    // discussion about a record they lost sight of.
    threads_pruneEntityDiscussion: async (paramsJson: string): Promise<string> => {
      const ref = await discussionRef(paramsJson, "pruned")
      if ("error" in ref) return ref.error
      const { canReadThreadAnchorEntity } = await import("~/modules/threads/thread-anchor")
      const keep =
        auditActorType === "user" && (await canReadThreadAnchorEntity(txDb as never, orgId, ref))
          ? userId
          : null
      const { pruneEntityDiscussion } = await import("~/modules/threads/entity-discussion")
      const dropped = await pruneEntityDiscussion({ orgId, ref, keepUserId: keep })
      const what = `${appName}:${ref.entityType} ${ref.entityId}`
      return JSON.stringify({
        ok: true,
        dropped: dropped ?? 0,
        result:
          dropped === null
            ? `${what} has no discussion yet: nobody was seated, nothing to prune.`
            : `${dropped} ${dropped === 1 ? "person was" : "people were"} taken out of the discussion of ${what}${keep ? " (the caller stays)" : ""}. Whoever still sees the record is seated again when they open it.`,
      })
    },

    // --- Jobs ---
    enqueueJob: async (jobName: string, payloadJson: string, optsJson?: string) => {
      const opts = optsJson ? JSON.parse(optsJson) : undefined
      // SECURITY (cross-tenant escalation): pin the bridge's trusted `orgId`
      // into the payload and forbid the sandbox from overriding it. Spread the
      // sandbox-supplied payload FIRST so the trusted `orgId` always wins —
      // mirrors how `emit` stamps `orgId` (see emit() above). The BullMQ worker
      // (jobs.ts) and the on-demand sandbox handler (runtime.ts) both derive the
      // RLS tenant from `payload.orgId`; without this pin a handler reached via
      // a webhook (actorType "system") could enqueue a job against an arbitrary
      // victim org with full `<app>:*` scopes.
      const payload: Record<string, unknown> = {
        ...withoutHostJobFields(JSON.parse(payloadJson || "{}")),
        orgId,
      }
      // Propagate acting user so the job inherits their permissions.
      // Exclude system actors (bare "system" used by webhook handlers, plus
      // the "system:..." prefix used by scheduled/internal jobs). The identity
      // fields are always the bridge's own: whatever the sandbox put under
      // `_userId` / `_callerScopes` was dropped above, so a job runs as the
      // user whose turn enqueued it, or as the app, never as a user the app
      // named. A continuation job re-enqueued from a user's job is stamped here
      // again from that job's own bridge identity.
      if (
        !bridgeOptions?.jobsAttributedToSystem &&
        userId &&
        userId !== "system" &&
        !userId.startsWith("system:")
      ) {
        payload._userId = userId
        if (callerScopes?.length) payload._callerScopes = callerScopes
      }
      // `delay` lets continuation chains PACE themselves (e.g. the mail
      // initial sync sleeps between mailbox pages so a full-history import
      // trickles instead of hammering the box for hours). Clamped so a buggy
      // or malicious handler can't park a job unreachably far in the future.
      const MAX_SANDBOX_JOB_DELAY_MS = 15 * 60 * 1000
      const delay =
        typeof opts?.delay === "number" && opts.delay > 0
          ? Math.min(opts.delay, MAX_SANDBOX_JOB_DELAY_MS)
          : undefined
      // The job id is a deduplication key on a queue every org shares, so it is
      // scoped to this org: one org's handler can never collapse another org's
      // job into its own by naming the same id.
      const jobId =
        typeof opts?.jobId === "string" && opts.jobId !== "" ? `${orgId}:${opts.jobId}` : undefined
      await enqueueAppJob(
        appName,
        jobName,
        payload,
        opts ? { jobId, ...(delay ? { delay } : {}) } : undefined,
      )
    },

    // --- Codec utilities ---
    // Bulk binary/text transforms MUST NOT run inside QuickJS: the interpreter
    // executes on the Bun main thread with no await points, so a hand-rolled
    // per-byte encoder over a multi-MB payload (e.g. base64url of a whole
    // RFC 2822 message with attachments for the Gmail send API) freezes the
    // entire process for tens of seconds — every concurrent request 504s and
    // websockets drop. These host-side codecs do the same work natively in
    // milliseconds. Txless: pure CPU, no DB access.
    codec_base64UrlEncodeUtf8: async (text: string) =>
      Buffer.from(text, "utf8").toString("base64url"),
    codec_base64EncodeUtf8: async (text: string) => Buffer.from(text, "utf8").toString("base64"),
    // A body written as markdown or plain text, as the email the customer
    // receives: `{ html, text }` JSON (emailBody, size-capped).
    codec_markdownToEmail: async (markdown: string) =>
      JSON.stringify(emailBody({ textBody: markdown })),

    invalidateIdempotency: async (targetTool: string, idempotencyKey: string): Promise<void> => {
      // Only this app's own tools: releasing another app's key would let a
      // completed call of that app (a send, an issue) run a second time.
      if (typeof targetTool !== "string" || !targetTool.startsWith(`${appName}:`)) {
        throw new Error(
          `invalidateIdempotency: '${targetTool}' is not a tool of '${appName}'; an app may only release its own idempotency keys`,
        )
      }
      const { invalidateIdempotency } = await import("~/modules/apps/idempotency")
      await invalidateIdempotency(orgId, targetTool, idempotencyKey)
    },

    // Phase 17 K3 — `ctx.sequences.allocate(p)` bridge. Capability-gated by
    // the `sequences.allocate` manifest declaration; forwards to the
    // kernel-side `allocateSequence` helper running inside the calling
    // tool-handler's ambient transaction.
    sequences_allocate: async (paramsJson: string): Promise<string> => {
      requireCapability("sequences.allocate")
      const params = JSON.parse(paramsJson || "{}") as { key: string }
      try {
        const { allocateSequence } = await import("~/modules/sequences/allocate")
        const result = await allocateSequence(txDb, {
          orgId,
          callingAppId: appName,
          key: params.key,
        })
        return JSON.stringify(result)
      } catch (err) {
        return errorEnvelope(err)
      }
    },

    // `ctx.time.civil({timezone, at?})`: the wall clock of an instant in a zone. No capability: it
    // reads nothing of the org's beyond its zone. `UTC` is the default of the issuer and org
    // columns and so means "not set": the org's own zone answers. `Etc/UTC` is UTC, exactly.
    time_civil: async (paramsJson: string): Promise<string> => {
      const params = JSON.parse(paramsJson || "{}") as { timezone?: unknown; at?: unknown }
      const at = instantOf(params.at)
      let zone = typeof params.timezone === "string" ? params.timezone : ""
      if (zone === "UTC") {
        // Privileged: kernel.organizations is closed to the handler's RLS role, and a denied read
        // comes back empty, which would silently mean UTC.
        const { extractRows } = await import("~/db")
        const { withPrivilegedDb } = await import("~/db/privileged")
        const { schemaRef } = await import("~/db/schema-ref")
        const KS = drizzleSql.raw(schemaRef("kernel"))
        const rows = await withPrivilegedDb(orgId, "time-civil-org-zone", (tx) =>
          tx.execute(
            drizzleSql`SELECT timezone FROM ${KS}.organizations WHERE id = ${orgId} LIMIT 1`,
          ),
        )
        zone = extractRows<{ timezone: string | null }>(rows)[0]?.timezone || "UTC"
      }
      return JSON.stringify(civilTimeAt(zone, at))
    },

    // Phase 17 K2 — `ctx.pdf.render(p)` bridge. Capability-gated by the
    // `pdf.render` manifest declaration; forwards to the kernel-side
    // `renderPdf` helper. The renderer looks up the template by
    // `(orgId, callingAppId, template_kind)` against the in-process
    // registry and stores the resulting PDF as a `kernel.files` row owned
    // by the calling app.
    pdf_render: async (paramsJson: string): Promise<string> => {
      requireCapability("pdf.render")
      const params = JSON.parse(paramsJson || "{}") as {
        template_kind: string
        data: unknown
        pdf_a3?: boolean
        filename?: string
        link?: { table?: string; column?: string; row_id?: string }
        pdfa?: unknown
        attachments?: unknown
        xmp?: { extensions?: unknown } | null
        parent?: { entityType?: unknown; entityId?: unknown; commitRow?: unknown } | null
      }
      try {
        const { parsePdfAParams } = await import("~/modules/pdf/pdfa/params")
        const pdfa = parsePdfAParams(params)
        const parent = params.parent ? await resolveRenderParent(params.parent) : undefined
        const { renderPdf } = await import("~/modules/pdf/render")
        const result = await renderPdf(txDb, {
          orgId,
          callingAppId: appName,
          template_kind: params.template_kind,
          data: params.data,
          pdf_a3: params.pdf_a3,
          filename: params.filename,
          ...(pdfa.pdfa
            ? { pdfa: pdfa.pdfa, attachments: pdfa.attachments, xmpExtensions: pdfa.xmpExtensions }
            : {}),
          ...(parent ? { parent } : {}),
          // The host's own actor, for the storage quota (never an app-supplied value).
          actor: { actorType: auditActorType, actingAgentId: bridgeActingAgentId },
        })
        // Parent row committed WITH the file (the BL-191 problem for a parent that is a row of its
        // own, joined on `id`): when a cross-app reader must see the file before this handler's tx
        // commits, the app passes the row's declared fields and the host inserts it, with the file
        // id / hash / size columns it names, in its own committed transaction. Only the parent's own
        // table (a fileParent of the calling app joined on `id`), only declared fields, only scalar
        // values, and only when the host minted the id (no entityId given) — never an update.
        const commitRow = params.parent?.commitRow as
          | {
              values?: Record<string, unknown>
              fileIdColumn?: string
              sha256Column?: string
              sizeColumn?: string
            }
          | undefined
        if (commitRow && parent && params.parent && params.parent.entityId == null) {
          const { resolveParent } = await import("~/modules/files/service")
          const reg = resolveParent(orgId, appName, parent.entityType)
          const fields = reg ? manifest.schema?.[reg.tableName]?.fields : undefined
          if (!reg || reg.joinOn !== "id" || !fields) {
            throw Object.assign(new Error("commitRow needs a parent table joined on id"), {
              code: "invalid_parent",
            })
          }
          const r = result as { file_id: string; sha256: string; byte_size: number }
          const values: Record<string, unknown> = { ...(commitRow.values ?? {}) }
          if (commitRow.fileIdColumn) values[commitRow.fileIdColumn] = r.file_id
          if (commitRow.sha256Column) values[commitRow.sha256Column] = r.sha256
          if (commitRow.sizeColumn) values[commitRow.sizeColumn] = r.byte_size
          for (const [k, v] of Object.entries(values)) {
            if (!(k in fields))
              throw Object.assign(new Error(`commitRow: unknown field ${k}`), {
                code: "invalid_parent",
              })
            if (v !== null && !["string", "number", "boolean"].includes(typeof v)) {
              throw Object.assign(new Error(`commitRow: ${k} must be a scalar`), {
                code: "invalid_parent",
              })
            }
          }
          const cols = Object.keys(values)
          const colSql = drizzleSql.raw(
            ["id", "org_id", ...cols.map((c) => quoteIdent(snakeCase(c)))].join(", "),
          )
          const valSql = drizzleSql.join(
            [
              drizzleSql`${parent.entityId}::uuid`,
              drizzleSql`${orgId}::uuid`,
              ...cols.map((c) => drizzleSql`${values[c] as string | number | boolean | null}`),
            ],
            drizzleSql.raw(", "),
          )
          const { withPrivilegedDb } = await import("~/db/privileged")
          await withPrivilegedDb(orgId, "pdf:parent-row", async (tx) => {
            await tx.execute(
              drizzleSql`INSERT INTO ${appTable(schemaName, reg.tableName)} (${colSql}) VALUES (${valSql})`,
            )
          })
        }
        // BL-191 — optionally LINK the rendered file onto one of the calling app's OWN rows in a
        // COMMITTED transaction, so a subsequent CROSS-APP reader sees the file before THIS handler's
        // tx commits. The file ROW is already committed (renderPdf uses withPrivilegedDb); the LINK
        // column is what must also commit early — e.g. invoicing's on-demand `documents_send_to_customer`
        // render must commit `documents.pdf_file_id` before `mail:composeForApp` reads the PDF (the `pdf`
        // fileParent's RLS visibility joins `documents.pdf_file_id = files.entity_id`), or the send fails
        // closed with "Source file not visible to caller". Constrained to a column the app DECLARES in
        // its OWN manifest schema (validated below) + its own schema + org — never an arbitrary or
        // cross-app write, so it grants no capability the app's own RLS tools don't already have.
        const link = params.link
        if (
          link &&
          typeof link.table === "string" &&
          typeof link.column === "string" &&
          typeof link.row_id === "string" &&
          manifest.schema?.[link.table]?.fields?.[link.column]
        ) {
          const fileId = (result as { file_id: string }).file_id
          const col = drizzleSql.raw(quoteIdent(snakeCase(link.column)))
          const { withPrivilegedDb } = await import("~/db/privileged")
          await withPrivilegedDb(orgId, "pdf:link", async (tx) => {
            await tx.execute(
              drizzleSql`UPDATE ${appTable(schemaName, link.table as string)} SET ${col} = ${fileId}::uuid WHERE id = ${link.row_id as string}::uuid AND org_id = ${orgId}::uuid`,
            )
          })
        }
        return JSON.stringify(result)
      } catch (err) {
        return errorEnvelope(err)
      }
    },

    nextHandle: async (entityName: string): Promise<string> => {
      const { nextHandle: nextHandleUtil } = await import("~/lib/handle")
      const { entityRegistry } = await import("~/modules/apps/app-registries")
      const entityDef = entityRegistry.get([orgId, appName, entityName])
      if (!entityDef?.handlePrefix) {
        throw new Error(`Entity "${entityName}" has no handlePrefix declared`)
      }
      const seqName = `${schemaName}.${entityName}_handle_seq`
      return nextHandleUtil(txDb, seqName, entityDef.handlePrefix)
    },
  }
}
