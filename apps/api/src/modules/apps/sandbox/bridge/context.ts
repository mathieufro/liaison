// SPDX-License-Identifier: FSL-1.1-ALv2

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type RlsClient } from "~/db"
import { setEventAgentDefault } from "~/db/queue-event"
import type { ActorContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import type { AppEvent } from "~/infra/events/event-bus"
import { rootLogger } from "~/lib/logger"
import { quoteIdent } from "~/lib/sql-utils"
import { assertWritableRun } from "~/modules/agent/runtime/read-only-run"
import {
  captureReadOnlyRun,
  captureSpawnParentFrame,
  currentRunContext,
  type SpawnParentFrame,
} from "~/modules/agent/runtime/run-context"
import {
  capturedFrameWriteScopes,
  scopeUnknownError,
} from "~/modules/agent/scopes/write-required-scopes"
import {
  type AppManifestForBridge,
  BASE_ENTITY_FIELDS,
  coerceJson,
  ERROR_NOT_FOUND,
  envelopeError,
  snakeCase,
  toIso,
} from "~/modules/apps/sandbox/bridge/shared"
import type { UpstreamTrace } from "~/modules/apps/sandbox/upstream-trace"
import type { ExecPriority } from "~/modules/apps/sandbox/worker-pool"
import {
  isMailboxGuardedEntity,
  MailboxPlaintextForbiddenError,
  suppliedPlaintextFields,
} from "~/modules/mailbox-crypto/plaintext-guard"

const K = () => drizzleSql.raw(schemaRef("kernel"))

// Per-bridge state shared by every capability factory: the captured run frame,
// the resolved actor, schema names and the validation/lookup helpers the
// methods close over. Built once per createRpcBridge call, never module-level.

/** Shape of every app-table `id` (uuid, ddl.ts) -- see findEntityById. */
const UUID_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The `kernel.users` columns `kernel_findOne("users", id)` returns: the directory fields. */
export const KERNEL_USER_COLUMNS =
  "id, org_id, email, name, avatar_url, avatar_key, timezone, locale, status, created_at, updated_at"

/** Upper bound of a `where: { col: { in: [...] } }` value list (one bound parameter each). */
export const WHERE_IN_MAX = 1000

function stableHash(input: string): string {
  return new Bun.CryptoHasher("sha256").update(input).digest("hex")
}

export function jsonArray(value: unknown): unknown[] {
  const v = coerceJson(value)
  return Array.isArray(v) ? v : []
}

export function jsonObject(value: unknown): Record<string, any> | null {
  const v = coerceJson(value)
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : null
}

function collectAllowedDomains(manifest: AppManifestForBridge): string[] {
  const domains: string[] = []
  if (manifest.network?.allowedDomains) domains.push(...manifest.network.allowedDomains)
  if (manifest.connections) {
    for (const conn of Object.values(manifest.connections)) {
      if (conn.allowedDomains) domains.push(...conn.allowedDomains)
    }
  }
  return domains
}

/** What a guarded-write account resolver may answer: one account, a set of
 *  them, or nothing it could resolve. */
export type MaybeAccountIds = string | readonly (string | null | undefined)[] | undefined

export type ActorType = "user" | "agent" | "system" | "mcp"

export type RpcBridgeApprovalContext = {
  approvalRequestId: string
  approvalDeciderId: string
  toolName: string
  approvalExecutionId?: string
  /** The routine that RAISED the approval, recorded at request time. The
   *  approved re-entry runs in no routine frame, so a bridge callback that
   *  attributes work to the routine reads it from here. */
  originRoutineId?: string
}

export type RpcBridgeOptions = {
  callChain?: string[]
  /**
   * A job this bridge enqueues runs as the app (system), never as `userId`.
   * Set for event handler bridges, whose `userId` is merely whoever caused the
   * event (see event-handler-bridge.ts).
   */
  jobsAttributedToSystem?: boolean
  /**
   * The dispatch's cancellation signal (ExecuteToolParams.signal), handed to
   * app bridge extensions so host-side work a handler started (a database
   * statement) is stopped when the caller goes away, not left running.
   */
  signal?: AbortSignal
  /**
   * The sandbox execution this bridge serves, as a per-execution id. Every
   * `ctx.executeTool` hop the handler opens carries it, so the worker pool
   * bounds THIS execution's fan-out rather than every execution that happens
   * to have run the same chain of tool names.
   */
  parentExecutionToken?: string
  taintState?: { taintedSources: string[] }
  actor?: ActorContext
  threadId?: string
  origin?: "in-app-agent" | "mcp" | "human-ui" | "system"
  /**
   * The DECLARED cross-app caller (execute-tool.ts internalCall.callerApp) when
   * this bridge serves an app-to-app ctx.executeTool dispatch — undefined for a
   * direct user/agent/MCP call. U5.8: knowledge_create's placement guard exempts
   * connector-origin creates (machine-filed by the connector's own deterministic
   * convention — e.g. calls' 'Appel — <callRef>' title + tags — not collections).
   */
  callerApp?: string
  /**
   * The caller app when the kernel recognises this dispatch as an INGESTION path
   * (A45, FX22 F6): declared in the caller's `cross_app_calls` AND named in
   * `CROSS_APP_INGESTIONS`. "" or absent for everything else. Computed by
   * `executeToolCore` and never re-derived here, like `humanAuthorized` beside it.
   */
  ingestionCallerApp?: string
  /**
   * The calling app when this bridge serves a provider-contract op (`ctx.contracts.call`,
   * a dispatch `executeToolCore` verified as declared by the caller and implemented by this
   * provider). Lets the provider store a downloaded file onto one of the CALLER's own parents
   * (`files_importFromUrl`), which the caller hands over by entity id. Absent otherwise.
   * Set only together with `contractFileTarget`.
   */
  contractCallerApp?: string
  /**
   * The ONE caller record this contract dispatch may store a file onto: the op's `fileTarget`
   * param as the caller passed it (`provider-contracts/file-target.ts`). Absent for every op
   * whose contract spec names no file target, so the provider stores nothing on the caller.
   */
  contractFileTarget?: { app: string; entityType: string; entityId: string }
  /**
   * True when the invocation this bridge serves runs because a human
   * authorized it with the authority to do so — a direct human-UI call whose
   * user holds the tool's own `<app>:approve` scope. Computed by
   * `executeToolCore` (the only place that knows the approve-scope answer)
   * and consumed below for `internalCall.humanAuthorized`; NEVER re-derived
   * here from `origin`.
   */
  humanAuthorized?: boolean
  /**
   * A provider-contract op runs without the caller's data scopes; these are the caller's kernel
   * file ids (checked readable by the caller before the dispatch) it may still read, for the
   * multipart upload of a legal original. Set only by `executeToolCore` for a contract dispatch.
   */
  contractFileGrant?: readonly string[]
  /**
   * Worker-pool scheduling class of the originating dispatch. A background
   * sub-run / routine / webhook handler that calls another app via
   * `ctx.executeTool` keeps its "background" tag across the cross-app hop.
   */
  priority?: ExecPriority
  /**
   * Handler-conditional gating impl, injected by `executeToolHandler`. Backs
   * the `ctx.requestApproval` bridge method: a handler that decides mid-run to
   * park for approval (e.g. an over-threshold issuance) calls this to create a
   * pending approval whose post-approve re-entry re-invokes the same tool.
   */
  requestApprovalImpl?: (
    input: {
      tool_name: string
      summary: string
      /** Structured card detail (subtitle/lines/links) — see HandlerApprovalInput. */
      summary_detail?: {
        subtitle?: string
        lines?: string[]
        links?: Array<{ label: string; app: string; entityType: string; entityId: string }>
      }
      current_payload: unknown
      editable_fields?: string[]
      /** The handler proceeds at once when an auto-approve policy approves the call. */
      auto_approvable?: boolean
      /** The calling app's own scope that decides this request (see HandlerApprovalInput). */
      approve_scope?: string
    },
    /**
     * FX13: what the calling turn had READ, captured at bridge construction
     * where its frame was still live. This callback runs in the hop that lost
     * that frame, so without it the approval row records `[]` -- "no turn
     * proposed this" -- and FX4's approved re-entry writes an untagged row.
     */
    proposingTurnScopes?: string[] | null,
    /**
     * FX18: and WHICH AGENT is acting, from the same capture, so the approval
     * row this stages names it (A11).
     */
    actingAgentId?: string | null,
    /** The proposing agent run (id, root, depth), from the same capture. */
    originRun?: { runId: string; rootRunId: string; nestingDepth: number } | null,
  ) => Promise<{
    approval_id: string | null
    auto_approved?: true
    approved_by?: "policy" | "requester"
  }>
  /**
   * Test-only seam (knowledge app): a pre-built source registry to use in the
   * `knowledge_verify` source-link branch and `knowledge_addFolderSource`
   * folder harvest, in place of `registerDefaultKnowledgeSources` (which needs
   * a live Google-Drive OAuth token). Production never sets this — the bridge
   * builds a request-scoped real-Drive registry on demand.
   */
  knowledgeRegistryOverride?: import("~/apps/knowledge/federated-search").KnowledgeSourceRegistry
  /**
   * createSessionRpcBridge internals — NOT for direct callers. The session
   * bridge reconstructs this bridge's closures once per method invocation
   * (each invocation runs in its own short RLS transaction), so state that
   * must live for the whole HANDLER run is injected from the session-bridge
   * scope instead of being (re)captured here:
   *  - `routineIdOverride`: the ALS routine-tick id captured at session-bridge
   *    construction (in-frame); per-call reconstruction happens outside the
   *    ALS frame where currentRunContext() is undefined (BL-275 class).
   *  - `bulkCursorStore`: the bulk.fetch iterator-cursor map, shared across
   *    the handler's bridge calls so iteration survives per-call rebuilds.
   */
  routineIdOverride?: string
  /**
   * The calling run's "may read, may not write" mark (spec-security.md D4),
   * captured while its ALS frame was still live. Same reason as the two
   * neighbours: a per-call bridge rebuild, and every QuickJS callback into a
   * bridge method, happen where `currentRunContext()` is undefined, so without
   * the capture a read-only run's writes would look like writes from no run.
   */
  readOnlyRunOverride?: boolean
  /**
   * createSessionRpcBridge internals: the calling frame's spawn view (effective
   * scope and taint snapshot), captured at session-bridge construction for the
   * same reason as `routineIdOverride`. `null` records that there was no frame.
   */
  spawnParentFrameOverride?: SpawnParentFrame | null
  /**
   * The same capture for scope-tagged WRITES (D5), taken WITHOUT the calling
   * tool's own scope: a knowledge write tool's `knowledge:documents:create`
   * is the write itself, not data the turn read, and tagging documents with
   * it would hide every agent-authored doc from readers who may not create.
   */
  writeParentFrameOverride?: SpawnParentFrame | null
  bulkCursorStore?: Map<string, { iterator: AsyncIterator<unknown[]> | null; done: boolean }>
  /**
   * Shared cumulative attachment-bytes ledger for files_importAttachment /
   * files_getAttachmentBytes: the 35MB PER_SEND cap counts across the whole
   * HANDLER run, so under per-call bridge rebuilds the counter must live in
   * the session-bridge scope, not this construction's closures.
   */
  /**
   * Session bridges only: run `fn` in one short RLS transaction of the session. Lets a tx-less
   * method (the external `fetch`) read what it needs from the database (a multipart upload's
   * files) without holding a connection across its network I/O.
   */
  withShortTx?: <T>(fn: (tx: RlsClient) => Promise<T>) => Promise<T>
  attachmentBytesLedger?: {
    importAttachment: { cumulative: number }
    getAttachmentBytes: { cumulative: number }
  }
  /**
   * The database snapshot this HANDLER RUN first read under, shared across
   * per-call bridge rebuilds for the same reason as the ledger above. The mail
   * app's writes compare a mailbox reset against it: see
   * `assertMailboxNotResetMidRun`.
   */
  mailboxSnapshot?: { value: string | null }
  /**
   * The handler run's upstream trace (the connection it read, its last fetch
   * answer), shared across per-call bridge rebuilds like the ledger above. The
   * tool error of a redacted crash names them (`upstream-trace.ts`).
   */
  upstreamTrace?: UpstreamTrace
}

/**
 * A write from a run that started before its mailbox was reset. Named, and not
 * one of the seal failure codes, so the mail handler does not mistake it for a
 * key problem and block the mailbox.
 */
export class MailboxResetMidRunError extends Error {
  constructor(readonly accountId: string) {
    super(
      `MAILBOX_RESET_MID_RUN: mailbox ${accountId} was reset after this run started; ` +
        "refusing to write what the run read before the reset",
    )
    this.name = "MailboxResetMidRunError"
  }
}

export function createBridgeContext(
  appName: string,
  userId: string,
  orgId: string,
  txDb: RlsClient,
  manifest: AppManifestForBridge,
  callerScopes: string[] | undefined,
  actorType: ActorType,
  approvalContext: RpcBridgeApprovalContext | undefined,
  bridgeOptions: RpcBridgeOptions | undefined,
  rpcBridge: Record<string, any>,
) {
  const logger = rootLogger.child({ app: appName, sandbox: true })
  // ⛔ CAPTURE the routine-tick id AT BRIDGE-CONSTRUCTION TIME (BL-275, competitor-firmware-news-watch
  // duplicate-doc flake — the FORENSIC-CONFIRMED root cause). `createRpcBridge` runs HOST-SIDE, synchronously
  // INSIDE the routine tick's `runContextStore.run(runFrame, …)` ALS frame, so `currentRunContext()` is valid
  // HERE. But an UNTRUSTED sandbox app (knowledge) executes its bundle in a WORKER POOL, and when the QuickJS
  // code calls back into a host bridge method (e.g. `ctx.knowledge_create`), that callback runs OUTSIDE the
  // ALS frame — `currentRunContext()` returns undefined there, so the routine-bound-doc redirect saw
  // `routineId: null` and BYPASSED, landing a duplicate watch doc. Capturing the id in this closure (in-frame)
  // and threading it into the redirect makes the lookup independent of the lost ALS frame. Undefined for
  // non-routine bridges (foreground chat / sub-runs) — exactly as before.
  const bridgeRoutineId = bridgeOptions?.routineIdOverride ?? currentRunContext()?.routineId
  // Captured here for exactly the same reason (spec-security.md D4, FX10a): the
  // Share anyway rerun answers a withheld turn from READS alone, and a write
  // reaching this bridge through a sandboxed app arrives in a callback that has
  // lost the frame. The mark belongs to the RUN, so it is read here and not from
  // the calling tool's `readOnly` declaration, which the APP writes: a manifest
  // that marks a writing tool `readOnly: true` is admitted by the rerun catalog,
  // and this is the layer that still refuses its writes.
  const bridgeReadOnlyRun = bridgeOptions?.readOnlyRunOverride ?? captureReadOnlyRun()
  /** Refuses a write on a read-only run, naming the table it would have hit. */
  const refuseWriteOnReadOnlyRun = (writeTargetTable: string, what: string): void => {
    assertWritableRun(bridgeReadOnlyRun, writeTargetTable, what)
  }
  /** The app's own schema.table, unprefixed, as the taint markers spell it. */
  const writeTarget = (entity: string): string => `app_${appName.replace(/-/g, "_")}.${entity}`
  // Captured here for the same reason: ctx.agent.spawn runs in a callback that
  // lost the frame, and must still bound and taint the child by the calling turn.
  const bridgeSpawnParentFrame =
    bridgeOptions?.spawnParentFrameOverride !== undefined
      ? bridgeOptions.spawnParentFrameOverride
      : captureSpawnParentFrame({ includeCallingTool: true })
  /**
   * FX18 (A11): WHICH AGENT is acting, taken from the frame captured just above
   * rather than captured a fourth time, so the identity a write records and the
   * turn it is judged against can never name different agents. Every durable
   * event this bridge queues carries it, because the callback that queues it has
   * lost the frame and would otherwise record an agent action with no agent.
   *
   * `null` is a positive "no agent acted": no frame at all is a cron, a job or a
   * webhook. It rides `sharedOptions` with the frame itself, so a per-call
   * bridge rebuild (which happens outside the frame) keeps it.
   */
  const bridgeActingAgentId = bridgeSpawnParentFrame?.agentId ?? null
  /**
   * X10 (A11), the decision this seam records: `actorType` does DOUBLE DUTY.
   * It selects the bridge's RLS actor (`actorType === "user" ? "user" :
   * "system"`, and the derived `inheritedActor` below), AND it used to stamp
   * the audit category of everything this bridge queues. The two are SPLIT
   * here, and only the audit half moves.
   *
   * RLS actor: UNCHANGED, deliberately. A sandboxed tool call made on behalf
   * of a human keeps running in that human's user context; moving it to a
   * system context to make an audit row read better would widen what the call
   * can touch, which is the opposite of what A11 is for.
   *
   * AUDIT category: a sandboxed app tool call made INSIDE an agent turn is an
   * AGENT action and audits as one, exactly as a host-handler tool call
   * already does (execute-tool.ts derives "agent" from origin "in-app-agent"
   * for the non-sandboxed path). The upgrade applies only to "user": a system
   * or mcp bridge keeps its own category, and with no acting agent nothing
   * changes at all.
   *
   * FX2 extends the split to EVERY audit-bearing seam in this bridge, not just
   * queueAppEvent and the declared emit: the tickets state-machine calls carry
   * it as an explicit `auditActorType` (their own `actorType` still decides the
   * self-assignment sentinel, `created_by` and the note author, so it cannot be
   * overwritten), the converted-to-mail timeline write takes it directly, and
   * so does `attachFileToParent`, which reads the value for nothing but its
   * emitted event.
   *
   * Not covered, and deliberately so: `message:update` and `message:delete`
   * (modules/threads/message.ts) stay "user" — editMessage and deleteMessage
   * take no author type and cannot tell an agent's edit from a human's.
   */
  // A routine's work with no agent behind it (an app's job acting through its
  // routine, or such a call approved later) is the system's, not the owner's
  // the routine runs as: audited "system", never as the person's own action.
  const auditActorType: "user" | "agent" | "system" | "mcp" =
    actorType === "user" && bridgeActingAgentId
      ? "agent"
      : actorType === "user" && (bridgeRoutineId ?? approvalContext?.originRoutineId)
        ? "system"
        : actorType
  // ...and handed to the db handle the app's own services write through, so the
  // identity covers the writes this file never sees. `knowledge_create` runs
  // entirely inside `apps/knowledge/service.ts`, which queues the document
  // event itself and knows nothing about agents; without this its audit row
  // names no agent, and A11's "what did this agent do" misses every document an
  // agent ever wrote. Declared once here rather than threaded through every
  // service signature. A null agent declares nothing.
  setEventAgentDefault(txDb, bridgeActingAgentId, bridgeSpawnParentFrame)
  // D5 write inheritance, captured for the same reason and at the same moment:
  // a knowledge write arrives through a sandbox callback that has lost the
  // frame, and must still carry what the calling turn had READ (the snapshot
  // from before this tool call recorded its own scope).
  const bridgeWriteParentFrame =
    bridgeOptions?.writeParentFrameOverride !== undefined
      ? bridgeOptions.writeParentFrameOverride
      : captureSpawnParentFrame()
  /**
   * The calling turn's accumulated taint, resolved from the SAME captured frame
   * and by the same ladder as the knowledge write below, so what a write is
   * TAGGED with and what it is JUDGED against can never disagree. Three
   * meaningful answers, 2a's `capturedFrameWriteScopes` convention:
   *   `[]`   no frame at all, so no turn called this (a cron, a job, a webhook).
   *          Nothing has been read, so every sink is allowed.
   *   scopes what the turn had read before the calling tool ran.
   *   `null` a turn whose taint is not knowable, resolved to the worst case by
   *          the write guard and refused outside the enforcing sinks.
   * Forwarded across the sandbox hop into `executeToolCore` (FX12), whose own
   * in-frame read is blind here: the callback has already lost the frame, so
   * without this a tainted turn's sandboxed write evaluated NO taint at all and
   * could launder scoped data into a non-enforcing table.
   */
  const bridgeTurnTaintScopes = capturedFrameWriteScopes(bridgeWriteParentFrame, callerScopes)
  /**
   * And the STORE the taint's origin rows live in, taken from the same live frame, so
   * the same-resource allowance (A46) survives the hop too: a routine that read ticket A
   * and replies to ticket A through a sandboxed app is the same write as one made in
   * frame, and must be judged the same way. The store itself, never a snapshot of it
   * (A46b): a read made INSIDE the sandbox files its origin into the calling turn
   * through this same object, and the write that follows it in the same hop sees it.
   * It is the kernel's own accumulator; the sandbox never supplies a row list.
   */
  const bridgeTaintOriginStore = currentRunContext()?.turnScopeAccumulator
  /**
   * The requiredScopes a knowledge document written through this bridge
   * carries. No frame at all means no turn called it (a human request, a job):
   * the empty positive assertion. A turn whose taint is unknowable is refused,
   * never written untagged.
   */
  const knowledgeWriteRequiredScopes = (toolName: string): string[] => {
    if (bridgeTurnTaintScopes === null) throw scopeUnknownError(toolName)
    return bridgeTurnTaintScopes
  }
  const schemaName = schemaRef(`app_${appName.replace(/-/g, "_")}`)
  const declaredEmits = new Set(manifest.events?.emits ?? [])
  const allowedDomains = collectAllowedDomains(manifest)
  const declaredCapabilities = new Set(manifest.capabilities ?? [])
  // Per-bridge iterator-cursor map for `bulk.fetch` (Phase 16 Task A7). Each
  // open blob has at most one async-iterator instance, lazily started on the
  // first `bulk_iterateJsonl_next` call. `done` short-circuits subsequent
  // polls so the sandbox can keep calling until it sees `done: true`.
  const bulkIteratorCursors =
    bridgeOptions?.bulkCursorStore ??
    new Map<string, { iterator: AsyncIterator<unknown[]> | null; done: boolean }>()

  function requireCapability(name: string): void {
    if (!declaredCapabilities.has(name)) {
      const err = new Error(
        `App "${appName}" called ctx.${name.replace(/\./g, "_")} without declaring "${name}" in manifest.capabilities`,
      )
      ;(err as any).code = "CAPABILITY_NOT_DECLARED"
      throw err
    }
  }

  // Convert a thrown Error (with optional `.code`/`.retryable`) into the
  // same JSON envelope shape `envelopeError(code, message, retryable)`
  // already produces elsewhere in this file. Use this when the caller is
  // returning the envelope as a tool result; use `envelopeError` directly
  // when you have the components in hand.
  function errorEnvelope(err: any): string {
    return envelopeError(
      err?.code ?? "RPC_ERROR",
      err?.message ?? String(err),
      err?.retryable ?? false,
    )
  }

  // Positive-allowlist channel validator (security review 2026-05-23, Vuln 1).
  // ASCII alphanumerics + '/', '_', '.', '-' only. Rejects Redis glob
  // metacharacters (`*`, `?`, `[`, `]`, `\`) that would otherwise let a
  // publisher craft channel names intersecting cross-app PSUBSCRIBE patterns.
  const CHANNEL_ALLOWED = /^[a-zA-Z0-9/_.-]+$/

  /**
   * Validates an app's channel (`apps/<ownerApp>/...`) and returns the channel
   * the host actually publishes to: the org is stamped in by the host, after
   * the app prefix (`apps/<ownerApp>/orgs/<orgId>/...`), so two orgs of the
   * same app can never share a channel whatever name the app picks.
   */
  function orgScopedAppChannel(ownerApp: string, channel: string): string {
    const expectedPrefix = `apps/${ownerApp}/`
    if (!channel.startsWith(expectedPrefix)) {
      const err = new Error(
        `App "${ownerApp}" cannot publish to "${channel}" — must start with "${expectedPrefix}"`,
      )
      ;(err as any).code = "CHANNEL_NOT_OWNED"
      throw err
    }
    if (channel.length > 256 || !CHANNEL_ALLOWED.test(channel)) {
      const err = new Error(
        `Channel "${channel}" is malformed — only [a-zA-Z0-9/_.-] allowed, max 256 chars`,
      )
      ;(err as any).code = "CHANNEL_MALFORMED"
      throw err
    }
    const segments = channel.split("/")
    if (segments.some((s) => s === ".." || s === ".")) {
      const err = new Error(`Channel "${channel}" contains traversal segments`)
      ;(err as any).code = "CHANNEL_MALFORMED"
      throw err
    }
    return `${expectedPrefix}orgs/${orgId}/${channel.slice(expectedPrefix.length)}`
  }

  function validateEntity(entity: string): void {
    if (!manifest.schema?.[entity]) {
      throw new Error(`Entity "${entity}" not found in app schema`)
    }
  }

  function validateFields(entity: string, data: Record<string, unknown>): void {
    const entityDef = manifest.schema?.[entity]
    // SECURITY: field-level validation is NOT opt-in. An entity that declares
    // no `fields` map cannot be written through `db_insert`/`db_update` — a
    // sandbox could otherwise set arbitrary (manifest-author-internal) columns
    // of its own table by simply omitting the `fields` declaration. The write
    // path requires an explicit allowlist; declare `fields` to make a table
    // writable. (Reads of schemaless tables remain permissive.)
    if (!entityDef?.fields) {
      throw new Error(
        `Entity "${entity}" declares no fields and is not writable. Declare a "fields" map for "${entity}" in the manifest schema to allow db_insert/db_update.`,
      )
    }

    const typeMap: Record<string, string> = {}
    for (const [name, def] of Object.entries(entityDef.fields)) {
      typeMap[name] = typeof def === "string" ? def : ((def as any).type ?? "string")
    }

    for (const [key, val] of Object.entries(data)) {
      if (!(key in typeMap)) {
        throw new Error(
          `Unknown field "${key}" on entity "${entity}". Declared fields: ${Object.keys(typeMap).join(", ")}`,
        )
      }
      const declaredType = typeMap[key].replace(/\?$/, "")
      if (val === null || val === undefined) continue
      const jsType = typeof val
      const typeValid =
        declaredType === "string" || declaredType === "text"
          ? jsType === "string"
          : declaredType === "number"
            ? jsType === "number"
            : declaredType === "integer"
              ? jsType === "number" && Number.isInteger(val)
              : declaredType === "boolean"
                ? jsType === "boolean"
                : declaredType === "uuid"
                  ? jsType === "string" && /^[0-9a-f-]{36}$/.test(val as string)
                  : declaredType === "date" || declaredType === "day"
                    ? jsType === "string" || val instanceof Date
                    : declaredType === "bytea"
                      ? // Binary crosses the sandbox boundary as base64 text.
                        // Rejecting a non-base64 string here means the failure
                        // names the field, instead of surfacing as a Postgres
                        // decode error with no column in it.
                        jsType === "string" &&
                        (val as string).length % 4 === 0 &&
                        /^[A-Za-z0-9+/]*={0,2}$/.test(val as string)
                      : true
      if (!typeValid) {
        throw new Error(
          `Field "${key}" has invalid type: expected ${declaredType}, got ${jsType}${typeof val === "number" && declaredType === "integer" ? " (non-integer)" : ""}`,
        )
      }
    }
  }

  /**
   * Invariant P, second line of defence. The DATABASE trigger is the enforcement
   * point (a bundle rollback restores plaintext-writing handlers, and only the
   * database survives that); this layer turns the same violation into a readable
   * error naming the field, and only for the mail app.
   *
   * Cost: zero on the common path. The account lookup runs ONLY when the write
   * actually supplies a guarded plaintext field with content, which after Phase 5
   * means only a bug or an attack. Arming is resolved through the same
   * SECURITY DEFINER helper the trigger uses, so the two layers cannot disagree.
   *
   * The resolver may name MORE THAN ONE account, because `db_updateMany` writes
   * over a `where` clause rather than an id. Any armed account in the set is a
   * refusal: a bulk write cannot be split into a legal half and an illegal one.
   */
  async function assertNoMailboxPlaintext(
    entity: string,
    data: Record<string, unknown>,
    resolveAccountIds: () => MaybeAccountIds | Promise<MaybeAccountIds>,
  ): Promise<void> {
    if (appName !== "mail" || !isMailboxGuardedEntity(entity)) return
    const fields = suppliedPlaintextFields(entity, data)
    if (fields.length === 0) return
    const resolved = await resolveAccountIds()
    const accountIds = (typeof resolved === "string" ? [resolved] : (resolved ?? [])).filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    )
    // No resolvable account means the write cannot be shown to be safe. The
    // trigger raises `mailbox_account_unresolved` in the same situation; this
    // layer simply declines to pre-empt it, so the database still decides.
    if (accountIds.length === 0) return
    const armedFn = drizzleSql.raw(`${quoteIdent(schemaName)}.mailbox_invariant_armed`)
    const idList = drizzleSql.join(
      accountIds.map((id) => drizzleSql`${id}::uuid`),
      drizzleSql.raw(", "),
    )
    const rows = extractRows<{ armed: boolean }>(
      await txDb.execute(
        drizzleSql`SELECT bool_or(${armedFn}(t.id)) AS armed
                     FROM (SELECT unnest(ARRAY[${idList}]) AS id) t`,
      ),
    )
    if (rows[0]?.armed === true) {
      throw new MailboxPlaintextForbiddenError(entity, fields)
    }
  }

  /**
   * Stamp `encryption_state` on a personal mailbox at CREATION, host side.
   *
   * The manifest default is `none`, which means "this mailbox predates the
   * feature", and there is deliberately no runtime transition out of it. A
   * mailbox connected AFTER its owner enrolled would therefore be created at
   * `none` while Invariant P, which arms on the EXISTENCE of an active identity
   * and not on this column, was armed from the first insert: the writers read
   * `none`, decided no sealing was needed, and every message raised
   * `mailbox_plaintext_forbidden` forever, with no repair path.
   *
   * The value is derived here, from the owner's enrolment, and never taken from
   * the sandbox: a handler that supplied its own `encryptionState` would be
   * choosing whether its own mail gets sealed.
   */
  /**
   * A mailbox reset must not be undone by a sync run that was already in flight.
   *
   * Sync jobs run one short transaction per bridge call, so a Gmail import page
   * that read its account (and its cursor) BEFORE the owner reset the mailbox
   * would otherwise keep inserting rows and then write its stale page cursor
   * over the reset's empty one, so the re-download after re-enrollment would
   * skip everything before that page.
   *
   * The reset records its own transaction id in `accounts.sync_state.resetXid`
   * and takes an EXCLUSIVE advisory lock per mailbox. Every mail write here
   * takes the SHARED lock first, so a write and a reset never interleave: a
   * write in progress holds the reset back until it commits (and the reset then
   * deletes what it wrote), and a write that arrives during the reset waits for
   * it. Then the write checks whether that reset is visible in the snapshot the
   * run FIRST read under (`captureMailboxSnapshot`, taken before the handler's
   * first read). If it is not, everything this run knows about the mailbox
   * predates the reset, and the write is refused.
   *
   * Returns each account's current `resetXid`, so an accounts update can carry
   * it forward: a handler that writes `syncState: {}` must not erase the marker.
   */
  const mailboxSnapshot = bridgeOptions?.mailboxSnapshot ?? { value: null }

  async function captureMailboxSnapshot(): Promise<void> {
    if (appName !== "mail" || mailboxSnapshot.value !== null) return
    const rows = extractRows<{ snap: string }>(
      await txDb.execute(drizzleSql`SELECT pg_current_snapshot()::text AS snap`),
    )
    mailboxSnapshot.value = rows[0]?.snap ?? null
  }

  async function assertMailboxNotResetMidRun(
    accountIds: ReadonlyArray<string | null | undefined>,
  ): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>()
    if (appName !== "mail") return out
    const ids = [
      ...new Set(accountIds.filter((id): id is string => typeof id === "string" && id !== "")),
    ].sort()
    if (ids.length === 0) return out
    await captureMailboxSnapshot()
    const schema = drizzleSql.raw(quoteIdent(schemaName))
    for (const id of ids) {
      await txDb.execute(
        drizzleSql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${`mailbox-reset:${id}`}, 0))`,
      )
    }
    const rows = extractRows<{ id: string; reset_xid: string | null; stale: boolean | null }>(
      await txDb.execute(drizzleSql`
        SELECT id::text AS id, sync_state ->> 'resetXid' AS reset_xid,
               CASE WHEN sync_state ->> 'resetXid' IS NULL THEN false
                    ELSE NOT pg_visible_in_snapshot(
                      (sync_state ->> 'resetXid')::xid8, ${mailboxSnapshot.value}::pg_snapshot)
               END AS stale
          FROM ${schema}.accounts
         WHERE id IN (${drizzleSql.join(
           ids.map((id) => drizzleSql`${id}::uuid`),
           drizzleSql.raw(", "),
         )})`),
    )
    for (const row of rows) {
      out.set(row.id, row.reset_xid)
      if (row.stale === true) {
        throw new MailboxResetMidRunError(row.id)
      }
    }
    return out
  }

  async function stampMailAccountEncryptionState(
    entity: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (appName !== "mail" || entity !== "accounts") return
    // A mode conversion is the host's (mode-switch.ts), never the sandbox's.
    delete data.encryptionConversion
    if (data.ownerType !== "user") return
    const ownerId = typeof data.ownerId === "string" ? data.ownerId : null
    if (!ownerId) return
    // The owner's choice, inside the org's switch (encryption-mode.ts). A
    // transparent (server-managed) mailbox syncs at once: its key is minted on
    // the first seal. Only a private one waits for the mailbox password.
    const { effectiveMailboxEncryptionModeFor } = await import(
      "~/modules/mailbox-crypto/encryption-mode"
    )
    const mode = await effectiveMailboxEncryptionModeFor(orgId, ownerId, txDb)
    if (mode === "managed") {
      data.encryptionState = "managed"
      return
    }
    const rows = extractRows<{ enrolled: boolean }>(
      await txDb.execute(drizzleSql`
        SELECT EXISTS (
          SELECT 1 FROM ${K()}.user_mailbox_identities
           WHERE user_id = ${ownerId}::uuid AND status = 'active'
        ) AS enrolled`),
    )
    data.encryptionState = rows[0]?.enrolled === true ? "ready" : "pending_enrollment"
  }

  function validateWhereFields(
    entity: string,
    where: Record<string, unknown> | undefined,
    rejectProtected = false,
  ): void {
    if (!where) return
    const entityDef = manifest.schema?.[entity]
    const fields = entityDef?.fields ?? {}
    for (const key of Object.keys(where)) {
      if (key === "orgId") throw new Error("where.orgId is managed by the kernel")
      if (rejectProtected && key === "id") throw new Error("where.id is not allowed here")
      if (!BASE_ENTITY_FIELDS.has(key) && !(key in fields)) {
        throw new Error(
          `Unknown where field "${key}" on entity "${entity}". Declared fields: ${Object.keys(fields).join(", ")}`,
        )
      }
    }
  }

  function getDeclaredFieldType(entity: string, key: string): string | null {
    const fieldDef = manifest.schema?.[entity]?.fields?.[key]
    if (!fieldDef) return null
    const typeName = typeof fieldDef === "string" ? fieldDef : ((fieldDef as any).type ?? "string")
    return typeName.replace(/\?$/, "")
  }

  /**
   * postgres.js returns Postgres `numeric` columns as STRINGS (exact-precision
   * safety), so a row read through the sandbox delivers e.g.
   * `units_consumed_today: "0"` where the manifest declares a number. Handler
   * arithmetic then concatenates ("0" + 100 → "0100") and the eventual write
   * fails `validateFields` with "expected number, got string". First bitten
   * live by the social app's YouTube quota accounting — the FIRST nonzero
   * quota write ever attempted on a deployment died this way. Coerce every
   * manifest-declared number/integer field back to a JS number on the read
   * path so the row shape the sandbox sees matches the schema it declared.
   */
  function coerceNumericRowFields<T extends { [key: string]: unknown }>(
    entity: string,
    rows: (T | null)[],
  ): (T | null)[] {
    const fields = manifest.schema?.[entity]?.fields
    if (!fields) return rows
    const numericCols: string[] = []
    for (const [name, def] of Object.entries(fields)) {
      const typeName = typeof def === "string" ? def : ((def as { type?: string }).type ?? "string")
      const t = typeName.replace(/\?$/, "")
      if (t === "number" || t === "integer") numericCols.push(snakeCase(name))
    }
    if (numericCols.length === 0) return rows
    for (const row of rows) {
      if (!row) continue
      for (const col of numericCols) {
        const v = row[col]
        if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) {
          ;(row as { [key: string]: unknown })[col] = Number(v)
        }
      }
    }
    return rows
  }

  /**
   * The mirror of coerceNumericRowFields for `bytea`. postgres.js returns a
   * bytea column as a Buffer/Uint8Array, which JSON.stringify turns into
   * `{"type":"Buffer","data":[...]}` before the row reaches the sandbox. A
   * handler that echoes such a row pushes a bloated ciphertext blob into logs
   * and events, so every manifest-declared bytea field is converted back to
   * the base64 string the sandbox wrote.
   */
  function coerceByteaRowFields<T extends { [key: string]: unknown }>(
    entity: string,
    rows: (T | null)[],
  ): (T | null)[] {
    const fields = manifest.schema?.[entity]?.fields
    if (!fields) return rows
    const byteaCols: string[] = []
    for (const [name, def] of Object.entries(fields)) {
      const typeName = typeof def === "string" ? def : ((def as { type?: string }).type ?? "string")
      if (typeName.replace(/\?$/, "") === "bytea") byteaCols.push(snakeCase(name))
    }
    if (byteaCols.length === 0) return rows
    for (const row of rows) {
      if (!row) continue
      for (const col of byteaCols) {
        const v = row[col]
        if (v === null || v === undefined || typeof v === "string") continue
        if (v instanceof Uint8Array) {
          ;(row as { [key: string]: unknown })[col] = Buffer.from(v).toString("base64")
        } else if (Buffer.isBuffer(v)) {
          ;(row as { [key: string]: unknown })[col] = (v as Buffer).toString("base64")
        }
      }
    }
    return rows
  }

  function toSqlValue(entity: string, key: string, value: unknown) {
    const declaredType = getDeclaredFieldType(entity, key)
    if (declaredType === "json" && value !== null && value !== undefined) {
      return drizzleSql`${JSON.stringify(value)}::jsonb`
    }
    // A `bytea` column receives base64 from the sandbox. Decode it in the
    // database so the column stores real bytes, not the base64 text.
    if (declaredType === "bytea" && typeof value === "string") {
      return drizzleSql`decode(${value}, 'base64')`
    }
    return drizzleSql`${value}`
  }

  /**
   * The value list of a `{ in: [...] }` where operator, or null when `val` is a
   * plain equality value. Only primitives are accepted, and at most
   * WHERE_IN_MAX of them: the list becomes that many bound parameters.
   */
  function whereInValues(key: string, val: unknown): Array<string | number | boolean> | null {
    if (val === null || typeof val !== "object" || Array.isArray(val)) return null
    const keys = Object.keys(val)
    if (keys.length !== 1 || keys[0] !== "in") return null
    const list = (val as { in: unknown }).in
    if (!Array.isArray(list)) throw new Error(`where.${key}.in must be an array`)
    if (list.length > WHERE_IN_MAX) {
      throw new Error(`where.${key}.in accepts at most ${WHERE_IN_MAX} values (got ${list.length})`)
    }
    for (const v of list) {
      const t = typeof v
      if (t !== "string" && t !== "number" && t !== "boolean") {
        throw new Error(`where.${key}.in values must be strings, numbers or booleans`)
      }
    }
    return list as Array<string | number | boolean>
  }

  function buildWhereClause(
    entity: string,
    where?: Record<string, unknown>,
    rejectProtected = false,
  ) {
    validateWhereFields(entity, where, rejectProtected)
    let clause = drizzleSql`org_id = ${orgId}`
    if (where) {
      for (const [key, val] of Object.entries(where)) {
        const col = drizzleSql.raw(quoteIdent(snakeCase(key)))
        // `{ in: [...] }` is the one non-equality operator: a set lookup, so a
        // handler reads a whole sync page's rows in ONE query instead of one
        // round trip per id (the mail sync did one per message, each a
        // separate transaction). Values are bound parameters; an empty set
        // matches nothing rather than everything.
        const inValues = whereInValues(key, val)
        if (inValues) {
          clause =
            inValues.length === 0
              ? drizzleSql`${clause} AND false`
              : drizzleSql`${clause} AND ${col} IN (${drizzleSql.join(
                  inValues.map((v) => drizzleSql`${v}`),
                  drizzleSql.raw(", "),
                )})`
          continue
        }
        // `col = NULL` is never true in SQL (NULL is neither equal nor unequal to
        // anything, including itself) — a sandboxed app's `where: { platform: null }`
        // silently matched ZERO rows instead of the NULL-platform row it meant to
        // find, e.g. the social app's monitor_terms_add upsert-check never matched an
        // existing NULL-platform term, inserting a duplicate on every re-add. Emit the
        // `IS NULL` predicate SQL actually requires for a null value.
        clause =
          val === null
            ? drizzleSql`${clause} AND ${col} IS NULL`
            : drizzleSql`${clause} AND ${col} = ${val}`
      }
    }
    return clause
  }

  /** True iff `search` is a usable multi-term query — the only case the AND→OR
   *  relaxation (below) applies to (a single term is identical under AND or OR). */
  function multiTermSearch(search?: { fields?: string[]; query?: string }): boolean {
    const q = search?.query?.trim() ?? ""
    const fields = search?.fields?.filter(Boolean) ?? []
    return fields.length > 0 && q.split(/\s+/).filter(Boolean).length > 1
  }

  function buildFilteredWhereClause(
    entity: string,
    where?: Record<string, unknown>,
    search?: { fields?: string[]; query?: string },
    // How the per-term clauses combine. "all" (default) = AND-of-terms (precise: every
    // term must hit some field). "any" = OR-of-terms (the recall fallback below).
    termMode: "all" | "any" = "all",
  ) {
    let clause = buildWhereClause(entity, where)
    const query = search?.query?.trim()
    const fields = search?.fields?.filter(Boolean) ?? []
    if (!query || fields.length === 0) return clause

    const declaredFields = manifest.schema?.[entity]?.fields ?? {}
    for (const field of fields) {
      if (!(field in declaredFields))
        throw new Error(`Unknown search field "${field}" on entity "${entity}"`)
    }
    // TOKENIZED search (BL-51): a row matches when EVERY whitespace-separated term in the query
    // appears (case-insensitive substring) in AT LEAST ONE of the search fields — i.e. AND-of-(OR
    // across fields). Substring-matching the WHOLE multi-word query (`field ILIKE '%<query>%'`)
    // required the terms to be CONTIGUOUS, so a natural agent query like "Kestrel 6 firmware" missed a
    // subject "Kestrel 6 won't boot after the v2.4 firmware update" (the words are present but not
    // adjacent) → mail:search returned 0 and the agent abandoned. Tokenizing matches the words in any
    // position/order. Single-term queries are unchanged (one term ⇒ identical to the old behavior), so
    // this only widens multi-word matches — robust to phrasing without regressing existing searches.
    //
    // AND-of-terms is precise but BRITTLE (BL-53): one over-specific term zeroes an otherwise-strong
    // match. A weak model echoes the user's phrasing — "Kestrel 6 bricking firmware" — but the seeded
    // subject says "bricked"; "bricking" is a substring of nothing, so the whole AND collapses to 0
    // even though firmware/Kestrel/v2.4 all hit. The caller (db_findMany/db_count) therefore retries with
    // termMode:"any" (OR-of-terms) when the precise AND returns nothing for a multi-term query — recall
    // when precision finds nothing, with zero change to queries that already match.
    const terms = query.split(/\s+/).filter(Boolean)
    const termClauses = terms.map((term) => {
      const perField = fields.map(
        (field) => drizzleSql`${drizzleSql.raw(quoteIdent(snakeCase(field)))} ILIKE ${`%${term}%`}`,
      )
      return drizzleSql`(${drizzleSql.join(perField, drizzleSql.raw(" OR "))})`
    })
    const termJoiner = termMode === "any" ? " OR " : " AND "
    clause = drizzleSql`${clause} AND (${drizzleSql.join(termClauses, drizzleSql.raw(termJoiner))})`
    return clause
  }

  async function findEntityById(entity: string, id: string) {
    validateEntity(entity)
    // Every app table's `id` is a UUID (ddl.ts). A non-UUID id -- typically an agent
    // handing a Shopify order id / invoice number to a `<shipment|document>_id`
    // parameter -- can match nothing, so answer "not found" instead of letting
    // Postgres raise 22P02 (a level-50 "Failed query" line that pages the watchdog
    // as a new error signature every time the literal differs).
    if (!UUID_ID_RE.test(id)) return null
    const table = drizzleSql.raw(`${quoteIdent(schemaName)}.${quoteIdent(entity)}`)
    const rows = extractRows(
      await txDb.execute(
        drizzleSql`SELECT * FROM ${table} WHERE id = ${id} AND org_id = ${orgId} LIMIT 1`,
      ),
    )
    return coerceByteaRowFields(entity, coerceNumericRowFields(entity, [rows[0] ?? null]))[0]
  }

  async function findKernelEntityById(entity: string, id: string) {
    if (entity !== "contacts" && entity !== "users") {
      throw new Error(`kernel_findOne entity not allowed: ${entity}`)
    }
    const table = drizzleSql.raw(`${quoteIdent(schemaRef("kernel"))}.${quoteIdent(entity)}`)
    // A user row also holds credentials (password hash, TOTP secret, recovery
    // codes) and every app's per-user settings: an app reads the directory
    // fields only.
    const columns = drizzleSql.raw(entity === "users" ? KERNEL_USER_COLUMNS : "*")
    const rows = extractRows(
      await txDb.execute(
        drizzleSql`SELECT ${columns} FROM ${table} WHERE id = ${id} AND org_id = ${orgId} LIMIT 1`,
      ),
    )
    return rows[0] ?? null
  }

  /**
   * Cluster 6 — kernel read affordance for the reconcile/drift-backstop path.
   *
   * Lists `kernel.contacts` rows that carry an external id for the CALLING app
   * (i.e. `external_ids ? <appName>`), RLS-scoped to the bridge's `orgId`. This
   * is the only way a sandboxed app can page over the contacts it has linked —
   * `ctx.db.findMany("kernel.contacts", …)` cannot work because the sandbox db
   * resolves `entity` against `app_<name>.<entity>`, not the kernel schema.
   *
   * The app name is forced from the bridge's authenticated `appName`, so an app
   * can never enumerate another app's external-id linkage. Returns each row's
   * id plus this app's external id (extracted from the jsonb), with a stable
   * keyset cursor (the last contact id) for pagination.
   */
  async function findKernelContactsByExternalId(
    limit: number,
    cursor: string | null,
  ): Promise<{
    contacts: Array<{ id: string; externalId: string | null }>
    nextCursor: string | null
  }> {
    const cappedLimit = Math.min(Math.max(1, Math.floor(limit) || 50), 200)
    const table = drizzleSql.raw(`${quoteIdent(schemaRef("kernel"))}.contacts`)
    // Keyset pagination on the contact id (uuid) — stable ordering, no offset.
    const cursorClause =
      cursor && typeof cursor === "string" ? drizzleSql` AND id > ${cursor}` : drizzleSql.raw("")
    const rows = extractRows(
      await txDb.execute(
        drizzleSql`
          SELECT id, external_ids -> ${appName} AS external_id
          FROM ${table}
          WHERE org_id = ${orgId}
            AND external_ids ? ${appName}${cursorClause}
          ORDER BY id ASC
          LIMIT ${cappedLimit}
        `,
      ),
    ) as Array<{ id: string; external_id: unknown }>
    const contacts = rows.map((r) => ({
      id: String(r.id),
      externalId: typeof r.external_id === "string" ? r.external_id : null,
    }))
    const nextCursor =
      contacts.length === cappedLimit ? (contacts[contacts.length - 1]?.id ?? null) : null
    return { contacts, nextCursor }
  }

  async function resolveCredentials(connectionName: string, identifier: string) {
    const declaration = manifest.connections?.[connectionName]
    if (!declaration) {
      throw new Error(`Connection "${connectionName}" not declared in app manifest`)
    }
    const { getCredentialsForConnection } = await import("~/modules/apps/connections/service")
    const lookup = (db: RlsClient) =>
      getCredentialsForConnection(db, orgId, userId, appName, connectionName, identifier, {
        actorType: actorType === "user" ? "user" : "system",
      })
    // The external-I/O methods (imap_*, smtp_*) run with no transaction on a
    // session bridge (rpc-bridge.ts SESSION_TXLESS_METHOD_PREFIXES): the
    // caller's RLS lookup then takes its own short transaction instead of the
    // poisoned txDb, which made every person's IMAP/SMTP send fail with a 500.
    const credentials = bridgeOptions?.withShortTx
      ? await bridgeOptions.withShortTx(lookup)
      : await lookup(txDb)
    const allowed = new Set(declaration.credentialFields?.map((field) => field.name) ?? [])
    if (allowed.size === 0) return {}
    return Object.fromEntries(Object.entries(credentials).filter(([key]) => allowed.has(key)))
  }

  const inheritedActor: ActorContext =
    bridgeOptions?.actor ??
    (actorType === "user"
      ? {
          actorType: "user",
          userId,
          orgId,
          scopes: callerScopes ?? [],
          dimensionGrants: {},
        }
      : { actorType: "system", orgId, purpose: "job", scopes: callerScopes ?? [] })

  const mailSchema = schemaRef("app_mail")
  const ticketsSchema = schemaRef("app_tickets")
  const kernelSchema = schemaRef("kernel")

  function appTable(schema: string, table: string) {
    return drizzleSql.raw(`${quoteIdent(schema)}.${quoteIdent(table)}`)
  }

  /**
   * Stamp the bridge's identity on one of the app's own events and check it is
   * declared: what `emit` queues, and what host-side writers that emit on the
   * app's behalf (the mail page write) queue too.
   */
  function stampDeclaredEmit(event: any): AppEvent {
    const merged = {
      ...event,
      app: appName,
      orgId,
      actorId: userId,
      // Same split as queueAppEvent: an app's own declared emit made during
      // an agent turn is that agent's action, and carries its identity, so
      // the audit row this becomes is not an anonymous human write.
      actorType: auditActorType,
      agentId: bridgeActingAgentId,
      timestamp: new Date().toISOString(),
    }
    const eventKey = `${merged.entity}:${merged.action}`
    if (!declaredEmits.has(eventKey)) {
      throw new Error(`App "${appName}" emitted undeclared event "${eventKey}"`)
    }
    return merged
  }

  function requireApp(expected: string, method: string): void {
    if (appName !== expected) throw new Error(`${method} is only available to the ${expected} app`)
  }

  /** Resolve the org's Drive OAuth token for the `drive_*` bridge methods. */
  function actorIdForEvent(): string | null {
    return /^[0-9a-f-]{36}$/i.test(userId) ? userId : null
  }

  async function queueAppEvent(
    app: string,
    entity: string,
    action: string,
    entityId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await txDb.queueEvent({
      app,
      entity,
      action,
      entityId,
      data,
      actorId: actorIdForEvent(),
      // A11: a sandboxed app's write during an agent turn is an AGENT action,
      // and audits as one. `actorType` itself stays untouched (it selects the
      // RLS actor): see `auditActorType` above for the split.
      actorType: auditActorType,
      agentId: bridgeActingAgentId,
      orgId,
    })
  }

  function mapMailMessageRow(row: Record<string, any>) {
    const fromAddress = jsonObject(row.from_address)
    return {
      // Blueprint Task 9.7. The ticket-conversion path has to be able to NAME
      // the messages it is asking the mailbox owner's browser to decrypt, and a
      // list with no ids cannot be matched back to what comes home. Undefined
      // for callers whose SELECT omits it, which is harmless: every consumer
      // reads named fields.
      id: row.id,
      direction: row.direction,
      fromEmail: fromAddress?.email,
      fromName: fromAddress?.name,
      toEmails: jsonArray(row.to_addresses)
        .map((a: any) => a?.email)
        .filter(Boolean),
      ccEmails: jsonArray(row.cc_addresses)
        .map((a: any) => a?.email)
        .filter(Boolean),
      subject: row.subject ?? undefined,
      htmlBody: row.html_body ?? undefined,
      textBody: row.text_body ?? undefined,
      externalMessageId: row.external_message_id ?? null,
      externalProviderId: row.external_provider_id ?? null,
      inReplyTo: row.in_reply_to ?? null,
      references: jsonArray(row.message_references).filter(
        (v): v is string => typeof v === "string",
      ),
      sentAt: toIso(row.sent_at) ?? new Date().toISOString(),
    }
  }

  function mapTicketMessageRowToMail(row: Record<string, any>) {
    return {
      id: row.id,
      kind: row.kind,
      direction: row.kind,
      fromEmail: row.from_email ?? null,
      fromName: row.from_name ?? null,
      toEmails: jsonArray(row.to_emails).filter((v): v is string => typeof v === "string"),
      ccEmails: jsonArray(row.cc_emails).filter((v): v is string => typeof v === "string"),
      subject: row.subject ?? null,
      htmlBody: row.html_body ?? null,
      textBody: row.text_body ?? null,
      externalMessageId: row.external_message_id ?? null,
      externalProviderId: null,
      inReplyTo: row.in_reply_to ?? null,
      messageReferences: jsonArray(row.header_references).filter(
        (v): v is string => typeof v === "string",
      ),
      references: jsonArray(row.header_references).filter(
        (v): v is string => typeof v === "string",
      ),
      sentAt: toIso(row.sent_at) ?? new Date().toISOString(),
    }
  }

  function naturalAppendKey(conversationId: string, message: Record<string, any>): string {
    const external = typeof message.externalMessageId === "string" ? message.externalMessageId : ""
    const fallback = stableHash(String(message.textBody ?? message.htmlBody ?? ""))
    return `mail:appendInbound:${conversationId}:${external || fallback}`
  }

  async function dispatchRerouteAppend(
    parsed: unknown,
    conversationId: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const parsedMail = parsed as {
      messageId?: string | null
      from?: { email?: string; name?: string } | null
      to?: Array<{ email?: string }>
      cc?: Array<{ email?: string }>
      subject?: string | null
      htmlBody?: string | null
      textBody?: string | null
      inReplyTo?: string | null
      references?: string[]
      sentAt?: string | null
    }
    const message = {
      externalMessageId: parsedMail.messageId ?? null,
      fromEmail: parsedMail.from?.email,
      fromName: parsedMail.from?.name,
      toEmails: (parsedMail.to ?? []).map((addr) => addr.email).filter(Boolean),
      ccEmails: (parsedMail.cc ?? []).map((addr) => addr.email).filter(Boolean),
      subject: parsedMail.subject,
      htmlBody: parsedMail.htmlBody,
      textBody: parsedMail.textBody,
      inReplyTo: parsedMail.inReplyTo,
      references: parsedMail.references ?? [],
      sentAt: parsedMail.sentAt ?? new Date().toISOString(),
    }
    const idempotencyKey = naturalAppendKey(conversationId, message)
    const dispatch = JSON.parse(
      await rpcBridge.executeTool(
        "mail:appendInboundMessage",
        JSON.stringify({ idempotencyKey, conversationId, message }),
      ),
    )
    if (dispatch.error) {
      return { ok: false, reason: dispatch.error.code }
    }
    return { ok: true }
  }

  async function summaryEnvelope(ticketId: string): Promise<string> {
    const tickets = appTable(ticketsSchema, "tickets")
    const latest = extractRows<Record<string, any>>(
      await txDb.execute(
        drizzleSql`SELECT * FROM ${tickets} WHERE id = ${ticketId}::uuid AND org_id = ${orgId}::uuid LIMIT 1`,
      ),
    )[0]
    if (!latest) return envelopeError(ERROR_NOT_FOUND.code, "ticket not visible")
    return JSON.stringify({
      summary: latest.summary_text,
      summaryAt: toIso(latest.summary_at),
      summaryStatus: latest.summary_status,
      isStale: Number(latest.message_count) > Number(latest.summary_message_count),
      model: latest.summary_model,
      tokenUsage: latest.summary_token_usage,
      summaryError: latest.summary_error ?? null,
    })
  }

  return {
    appName,
    userId,
    orgId,
    txDb,
    manifest,
    callerScopes,
    actorType,
    approvalContext,
    bridgeOptions,
    logger,
    bridgeRoutineId,
    bridgeReadOnlyRun,
    refuseWriteOnReadOnlyRun,
    writeTarget,
    bridgeSpawnParentFrame,
    bridgeActingAgentId,
    auditActorType,
    bridgeWriteParentFrame,
    bridgeTurnTaintScopes,
    bridgeTaintOriginStore,
    knowledgeWriteRequiredScopes,
    schemaName,
    declaredEmits,
    allowedDomains,
    declaredCapabilities,
    bulkIteratorCursors,
    requireCapability,
    errorEnvelope,
    CHANNEL_ALLOWED,
    orgScopedAppChannel,
    validateEntity,
    validateFields,
    assertNoMailboxPlaintext,
    assertMailboxNotResetMidRun,
    captureMailboxSnapshot,
    stampMailAccountEncryptionState,
    validateWhereFields,
    getDeclaredFieldType,
    coerceNumericRowFields,
    coerceByteaRowFields,
    toSqlValue,
    buildWhereClause,
    multiTermSearch,
    buildFilteredWhereClause,
    findEntityById,
    findKernelEntityById,
    findKernelContactsByExternalId,
    resolveCredentials,
    inheritedActor,
    mailSchema,
    ticketsSchema,
    kernelSchema,
    appTable,
    requireApp,
    stampDeclaredEmit,
    actorIdForEvent,
    queueAppEvent,
    mapMailMessageRow,
    mapTicketMessageRowToMail,
    naturalAppendKey,
    dispatchRerouteAppend,
    summaryEnvelope,
    rpcBridge,
  }
}

export type BridgeContext = ReturnType<typeof createBridgeContext>
