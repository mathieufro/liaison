// SPDX-License-Identifier: FSL-1.1-ALv2

import type {
  AppConfigKeyDecl,
  AppKind,
  SettingsSection,
  StoreCollectionDeclaration,
} from "@liaison/app-sdk"
import type { ApprovalSummary } from "@liaison/shared"
import type { z } from "zod"
import type { McpToolAnnotations } from "~/apps/mcp-manager/types"
import type { RlsClient } from "~/db"
import type { AppGuideInput } from "~/modules/agent/context/app-guide"
import type { BulkToolSchema } from "~/modules/apps/bulk-field-schemas"
import { bumpCatalogGeneration } from "~/modules/apps/catalog-generation"
import type { ToolOrigin } from "~/modules/apps/execute-tool"
import { pinnedOverlap } from "~/modules/apps/pinned-params"
import { createTypedRegistry, resetRegistrationTemplates } from "~/modules/apps/registries"
import type { ManifestSettingsEntry } from "~/modules/apps/settings-schema-from-manifest"
import type { SetupStepInput } from "~/modules/connection-guides/connection-setup"
import type { WebhookVerificationResult } from "~/modules/webhooks/verification"

/** Who reads an agent post: an existing thread's participants, or a new thread's people. */
export type TaintPostAudience =
  | { threadId: string }
  /** `newThread`: a titled or forced create (a thread of its own). `noShortcut`: it also writes
   *  unstamped text (title, references) that only an approval may disclose (scope-taint.ts, 14). */
  | { participantIds: string[]; newThread?: boolean; noShortcut?: boolean }

/** A manifest handler: its bundle and export, and whether it is a core app's (server code). */
export type ManifestHandlerRef = { bundlePath: string; exportName: string; core?: boolean }
export type ToolHandler = ((params: unknown, ctx: any) => Promise<unknown>) | ManifestHandlerRef

export interface OAuthClientConfig {
  clientId: string
  clientSecret: string
  /** Where a resolver found the client: the org's own setting or the
   *  deployment's environment. Absent: the app's own configuration. */
  source?: "org" | "deployment"
}

export interface OAuthClientResolverParams {
  orgId: string
  appName: string
  connectionName: string
}

export type OAuthClientResolver = (
  params: OAuthClientResolverParams,
) => Promise<OAuthClientConfig | null>

export function isManifestHandler(handler: any): handler is ManifestHandlerRef {
  return (
    handler !== null &&
    typeof handler === "object" &&
    "bundlePath" in handler &&
    "exportName" in handler
  )
}

/**
 * The minimal manifest snapshot the runtime attaches to every tool and webhook
 * registry entry (`runtime.ts` `manifestForBridge`). It carries the FULL
 * `schema` — including per-field `userRef`/`onErase` erasure declarations — which
 * the frontend-facing {@link manifestRegistry} deliberately strips. Compliance
 * paths (GDPR erasure) read the schema from here, keyed off the live registry.
 */
export interface BridgeManifestField {
  type?: string
  required?: boolean
  userRef?: boolean
  onErase?: "delete" | "anonymize"
  [key: string]: unknown
}

export interface BridgeManifest {
  name: string
  schema?: Record<string, { fields?: Record<string, BridgeManifestField | string> }>
  events?: { emits?: string[] }
  connections?: Record<string, { allowedDomains?: string[] }>
  network?: { allowedDomains?: string[] }
  capabilities?: string[]
  scopes?: string[]
  /** Declared cross-app call targets. The sandbox `executeTool` bridge keys the
   *  K4 envelope translation (`{ data } → { status, result }`) off this being
   *  non-empty — so it MUST survive the manifest→bridge projection, or a
   *  Phase-17+ app (invoicing, boxtal) that expects the K4 shape silently
   *  receives the legacy `{ data }` envelope and misreads every cross-app result. */
  cross_app_calls?: Array<{ target: string; reason: string }>
  /** Per kind of record, the read-only tool that can stop a mail about it before it leaves. */
  sendGuardProviders?: Record<
    string,
    { tool: string; serviceMessage?: boolean; pill?: { label: string; labelKey?: string } }
  >
  /** Per entity type, the read-only tool that says who an approval about such a record is for. */
  approvalRoute?: Record<string, string>
  /** Read-only tools that add a few lines about the entity a turn is about (context-providers.ts). */
  contextProviders?: Array<{ on: string[]; tool: string; scope: string; loadTools?: string[] }>
  /** Read-only tools that give a company's or a contact's timeline its rows (one per source). */
  activitySources?: Array<{
    tool: string
    scope: string
    label: string
    labelKey?: string
    filterKey: string
  }>
}

// Track registered orgId:appName to prevent duplicate registration
export const registeredApps = new Set<string>()

// The VERSION each `orgId:appName` key was registered at. A catalog upgrade
// swaps the installed bundle on disk (removing the old version dir), so a
// same-name registration at a stale version serves ENOENT on every tool call —
// registerSingleApp compares against this to re-register on version change
// instead of skipping.
export const registeredAppVersions = new Map<string, string>()

// Track completed org runtime initialization in this process.
export const initializedOrgRuntimes = new Set<string>()

/** When each set-up org was last touched in this process (`awaitOrgApps`), for idle release. */
export const orgRuntimeLastTouch = new Map<string, number>()

/**
 * Orgs whose runtime is being released right now (org-runtime-release.ts). A
 * touch waits for the release to finish before setting the org up again, so
 * the release never deletes what a new setup just wrote.
 */
export const orgRuntimeReleases = new Map<string, Promise<void>>()

/**
 * Live work holding each org's runtime in this process beyond what the move
 * accounting counts (transfer-state `beginOrgActivity`: writes, jobs, agent
 * turns): every authenticated request, reads included, and every open
 * WebSocket. The org runtime cap (org-runtime-release.ts) never evicts a held org.
 */
export const orgRuntimeHolds = new Map<string, number>()

/** Hold the org's runtime until the returned function is called (idempotent). */
export function holdOrgRuntime(orgId: string): () => void {
  orgRuntimeHolds.set(orgId, (orgRuntimeHolds.get(orgId) ?? 0) + 1)
  let ended = false
  return () => {
    if (ended) return
    ended = true
    const n = (orgRuntimeHolds.get(orgId) ?? 1) - 1
    if (n > 0) orgRuntimeHolds.set(orgId, n)
    else orgRuntimeHolds.delete(orgId)
  }
}

// Track in-flight org initialization promises so concurrent requests await the same work.
export const orgRuntimeInitPromises = new Map<string, Promise<void>>()

/** Orgs whose apps `registerApps` is registering right now (any caller), with a depth count. */
export const orgsRegistering = new Map<string, number>()

/**
 * Orgs `awaitOrgApps` found without an organization row (deleted, or never
 * existing), most recent last, at most `KNOWN_MISSING_ORGS_MAX`. A registry
 * miss for one is the right answer, not a missing ensure: a cleanup job or a
 * late webhook for a deleted org reads nothing and goes on.
 */
export const orgsKnownMissing = new Set<string>()
const KNOWN_MISSING_ORGS_MAX = 10_000

export function rememberMissingOrg(orgId: string): void {
  orgsKnownMissing.delete(orgId)
  orgsKnownMissing.add(orgId)
  if (orgsKnownMissing.size > KNOWN_MISSING_ORGS_MAX) {
    const oldest = orgsKnownMissing.values().next().value
    if (oldest !== undefined) orgsKnownMissing.delete(oldest)
  }
}

/**
 * A tool's scopes live in `requiredScopes` alone. Refuse a registration whose
 * `requiredScopes` is missing or empty (the tool would be refused to everyone),
 * or that still carries the retired single `scope` key, so a caller writing the
 * old shape fails loudly at registration instead of being authorized on a set
 * nobody reads.
 */
function assertToolRequiredScopes(
  [, appName, toolName]: [orgId: string, appName: string, toolName: string],
  toolDef: object,
): void {
  if (Object.hasOwn(toolDef, "scope")) {
    throw new Error(
      `tool ${appName}:${toolName} declares "scope": a tool lists its scopes in requiredScopes only`,
    )
  }
  const { requiredScopes } = toolDef as { requiredScopes?: unknown }
  if (
    !Array.isArray(requiredScopes) ||
    requiredScopes.length === 0 ||
    !requiredScopes.every((s) => typeof s === "string" && s.length > 0)
  ) {
    throw new Error(
      `tool ${appName}:${toolName} must declare requiredScopes as a non-empty list of scope strings`,
    )
  }
}

/**
 * What an entity puts in the search index and the mention picker. One type for
 * every registration, kernel built-ins and manifests alike.
 */
export interface SearchIndexFields {
  title: string
  body?: string
  /** More body text from the entity's own row: column names, or "column.key" for one key of a
   *  JSON column (an order reference kept in `external_refs`). */
  bodyFields?: string[]
  /** More body text from child rows of the same app schema: the rows of `tableName` whose
   *  `foreignKey` is this row's id, each row's `columns` (an invoice's line descriptions). */
  bodyFrom?: { tableName: string; foreignKey: string; columns: string[] }
  handle?: string
  /** A column of the entity's own row shown as the picker's second line. */
  labelSecondary?: string
  /**
   * The second line when the telling fact sits on a RELATED row of the same app
   * schema: `foreignKey` on the entity's row points at `tableName.id`, and the
   * first non-empty of `columns` is shown. A task shows its project this way.
   */
  labelSecondaryFrom?: { tableName: string; foreignKey: string; columns: string[] }
}

/** What a tool's `reconcile` handler found out about an approved execution
 *  whose outcome was unknown. `ref` names what the provider holds (e.g. the
 *  created comment's id); it becomes the decided result. */
export type ReconcileOutcome =
  | { outcome: "executed"; ref?: Record<string, unknown> }
  | { outcome: "not_executed"; reason?: string }
  | { outcome: "unknown"; reason?: string }

export const toolRegistry = createTypedRegistry<
  [orgId: string, appName: string, toolName: string],
  {
    appName: string
    name: string
    description: string
    /** Every scope this tool requires. The tool is authorized only when the
     *  actor holds each entry (`checkToolScopes`). Registration refuses a
     *  missing or empty list, and any `scope` key: the retired single-scope
     *  field is deliberately absent from this type, so reading or writing it
     *  on a registered tool is a compile error. */
    requiredScopes: string[]
    /** The table this tool writes, schema-qualified with the unprefixed schema
     *  name (`kernel.messages`, `app_knowledge.documents`). Scope taint checks it
     *  against the enforcing-sink list in modules/agent/scopes/scope-taint.ts, so an
     *  enforcing-sink tool must use that module's exact string. A tool that
     *  declares neither this nor `readOnly` counts as a write to an unknown table
     *  and is refused on a tainted turn. */
    writesToTable?: string
    /** The scope every reader of `writesToTable` must hold: the table is read back only
     *  through tools requiring it. It lets scope taint judge the SINK's audience instead
     *  of refusing outright: on a tainted turn the write runs when every user of
     *  the org who can read the table (this scope, or its `:write` sibling, which the
     *  generated RLS also lets SELECT) holds every scope the turn read, and is refused
     *  otherwise (scope-taint.ts, consequence 4). Meaningless without `writesToTable`;
     *  runtime.ts copies it only for an app the platform vouches for, inside the app's
     *  own scope namespace. */
    sinkReadScope?: string
    /** The ONLY reader of what this tool writes is the acting user (notify_user: an
     *  attention item and a push for that user alone). On a tainted turn the write is
     *  judged by that one reader (scope-taint.ts, rule 6d): it runs when the user's own
     *  grants hold every scope the turn read, and is refused otherwise. */
    sinkReadersSelf?: boolean
    /** `sinkReadersSelf` for some calls only: true when this call's write is read by the
     *  acting user alone (a personal dashboard; an org one has every member for readers).
     *  Host-only, judged with the call's params (execute-tool.ts taintJudgedTool). */
    sinkReadersSelfWhen?: (params: unknown) => boolean
    /** Kernel code only. Never judged by the scope taint (scope-taint.ts): a write the
     *  product never gates, `kernel:report_bug` filing a bug report about Liaison itself into
     *  the org's own inbox, or preparing one that leaves only on its reporter's click. */
    taintUnjudgedWrite?: boolean
    /** The ONLY readers of what this tool writes are the requester and the participants of
     *  the conversation the call runs in (request_secret: the secret_requests RLS policy).
     *  On a tainted turn the write is judged by them (scope-taint.ts, rule 6e): it runs when
     *  they all hold every scope the turn read. Host-only: a manifest cannot declare it. */
    sinkReadersConversation?: boolean
    /** The readers of what this tool writes are those of one shared resource (a dashboard
     *  table's rows follow the table's sharing): `type` is its sharing resource type, `idParam`
     *  the call parameter naming it. On a tainted turn the write runs when every one of those
     *  readers holds every scope the turn read (scope-taint.ts, rule 6j). Host-only. */
    sinkReadersResource?: { type: string; idParam: string }
    /** A write whose real sink depends on its arguments (a dashboard table backed by an app's
     *  records writes read-through cells into that app): the tool (`<app>:<tool>`) this call
     *  is judged as by the scope taint, its sink and readers taken from it, or null to judge it
     *  as itself. A throw or an unknown tool judges it as an undeclared write (fails closed).
     *  Host-only (scope-taint.ts, rule 6k). */
    taintJudgedAs?: (params: unknown, ctx: { orgId: string }) => Promise<string | null>
    /** What a tainted proposal's card calls the place this call writes to, by name ("the table
     *  "Arrivages""), when the write target's table name would mean nothing to a person (a
     *  dashboard table's rows live in the data store). Null or absent: the generic label
     *  (scope-taint.ts, taintSurfaceLabelForTool). Host-only. */
    taintCardPlace?: (params: unknown, ctx: { orgId: string }) => Promise<string | null>
    /** An AGENT POST into a kernel thread (threads_reply, threads_create's first message):
     *  who will read it. On a tainted turn a post some of those people could not read parks
     *  for the requester's approval, which discloses it to them, instead of landing hidden
     *  (scope-taint.ts, rule 11). Null for a call that posts nothing judged here (a contact
     *  discussion, a create with no message, title or references). Host-only. */
    taintPostAudience?: (params: unknown) => TaintPostAudience | null
    /** The write edits the payload of a PENDING approval, which stays pending and is decided
     *  by that same approval: on a tainted turn it is not judged as a disclosure here. Its
     *  handler restages the row in place, narrowed to holders of the union taint
     *  (scope-taint.ts, rule 8g). Host-only: a manifest cannot declare it. */
    taintEditsPendingApproval?: boolean
    /** The table this READ tool reads its rows from, schema-qualified exactly like
     *  `writesToTable`. It makes the read an ORIGIN for the same-resource allowance
     *  (A46): a later write that names this table and one of the rows read here is
     *  allowed on a tainted turn. It never authorizes a write by itself. */
    readsFromTable?: string
    /** The parameter that names the row this call targets, in the table the tool
     *  declares. A write without it has no row to compare, so the same-resource
     *  allowance cannot apply and the write is refused as before. */
    targetRowParam?: string
    /** Where the row ids live in this READ tool's RESULT (A46b): a dot path, walked
     *  through arrays. Only rows the read actually returned are filed as origins, so
     *  a result that does not carry a top-level `id` names its path here. */
    resultRowPath?: string
    /** True only for a tool that writes no table and has no external side effect
     *  (no egress, no state change). Platform bookkeeping that carries none of the
     *  call's data does not count: the call's own audit row, the viewer's own
     *  participant row on a thread they may read, a usage counter, a result cache
     *  (scope-taint.ts, consequence 1). Scope taint lets it run on a tainted turn; an
     *  unmarked tool counts as a write. A declared `writesToTable` wins over it. */
    readOnly?: boolean
    /** Set by runtime.ts only, never copied from a manifest: `readOnly` counts because
     *  every run of the tool is a read-only run (a custom app's read, with no outside host
     *  of its own; a nested read it calls is judged as the agent's own call), so
     *  executeToolHandler builds its bridge with every write refused. */
    readOnlyEnforced?: boolean
    /** True only for a kernel tool whose output holds no org record content (the
     *  tool catalog, capability listings, UI navigation): calling it reads no
     *  scoped data, so the bridge does not record its scope into the turn's
     *  taint. Its own call is still checked like any other. Set in kernel code
     *  only; runtime.ts never copies it from a manifest. */
    taintFree?: boolean
    /** Taint free for THIS call only, decided from its arguments (kernel code only): the call
     *  brings nothing into the turn its context does not already hold, so the bridge does not
     *  record the tool's scope. threads_read of the conversation the turn is answering: its
     *  messages are the turn's own history, and the handler records their requiredScopes
     *  stamps itself. `executionThreadId` is the turn's conversation. */
    taintFreeWhen?: (params: unknown, ctx: { executionThreadId?: string }) => boolean
    /** The ONLY parameters through which this write carries anything of the turn: free
     *  text an audience will read (approval_withdraw's `reason`). Called with every one
     *  absent or blank, the write carries none of the turn and scope taint does not judge
     *  it (scope-taint.ts, rule 6j). Set in kernel code only. */
    contentParams?: readonly string[]
    gated?: boolean
    /** Gated for THIS call only, decided from its params before it runs (kernel code only):
     *  e.g. subagent_create when the slug names a role that already exists, which the call
     *  would overwrite. True composes like `gated` (a person decides, a person's own click
     *  runs). A failure to decide counts as gated. `userId` is the caller and `origin`
     *  where the call came from (threads_create gates only an agent's new conversation). */
    gatedWhen?: (
      params: unknown,
      ctx: { orgId: string; userId: string; origin: ToolOrigin },
    ) => Promise<boolean>
    /** True when this tool decides its own gating INSIDE the handler (manifest
     *  `conditionalGate`) — it parks an approval only for some params/targets
     *  (e.g. knowledge:create gates an org doc but not a personal note). Such a
     *  tool is NOT `gated`, but it can still park an approval, so it needs the
     *  same STAGE-TIME preflight: a gated call must never be queued for a human
     *  when the data it needs is missing. Copied from the manifest in runtime.ts. */
    conditionalGate?: boolean
    /** Blast-radius classification for a gated tool's approval (manifest
     *  `approvalImpact`). "external" = the effect leaves the org or is
     *  customer/world-visible; "internal" = org-internal and reversible.
     *  Consumers (attention feed) treat an undeclared value as "external" —
     *  fail-safe: nothing risky may read as safe. */
    approvalImpact?: "external" | "internal"
    /** Whether this call sets or widens the scopes something holds without a person present (a
     *  routine's scopes). Such a call is never auto-approved, whatever the org's policy: the
     *  approval card is the only confirmation of a standing capability (auto-approve.ts). */
    grantsScopes?: (params: unknown, orgId: string) => boolean | Promise<boolean>
    /** True when this tool's approval must be decided FROM THE RECORD it acts
     *  on, not from a feed row: the attention card then offers only a way into
     *  the record. For actions a reviewer cannot judge without the surrounding
     *  context (a customer-facing ticket reply). Presentation-level, not a
     *  security boundary. Copied from the manifest in runtime.ts. */
    decideInContext?: boolean
    /** Overrides the default `${appName}:approve` decision scope for this gated
     *  tool's approval (dimension-constrained approvals). E.g. the skill-mutation
     *  tools set `kernel:skills:approve`. Persisted on the approval row so the
     *  decide path + RLS resolve the same custom scope. */
    approveScope?: string
    /** Resolves an optional dimension constraint at PROPOSE time — the decider
     *  (and the notified audience) must hold a matching grant on `key` covering
     *  `values` (or `"*"`) to decide the approval. Returns null for unconstrained.
     *  E.g. the skill tools resolve `{ key: "kernel:skills_domain", values: [<domain>] }`. */
    approvalDimension?: (
      params: unknown,
      ctx: { orgId: string },
    ) => Promise<{ key: string; values: string[] } | null>
    preflight?: ToolHandler
    /** The params this tool's preflight PINS (`{ ok: true, pinnedParams }`): the approval card
     *  shows them and the execution checks them. A caller's own value for one is dropped before
     *  the preflight, and a call carrying an `@ref:` token (which skips the preflight) is refused
     *  at stage time (execute-tool.ts). */
    pinnedParams?: readonly string[]
    /** No field of this tool's pending approval may ever be edited (`approval_update_payload`
     *  refuses every edit): what a person approves is the whole payload as staged, so a change
     *  means withdrawing the request and asking again (the app builder's publish). */
    payloadImmutable?: boolean
    /** The tools of the same app that change what this tool's approval carries (manifest
     *  `editWith`): an edit refused on its approval names them (approvals/edit.ts). */
    editWith?: readonly string[]
    /** The params carrying text a person outside the org reads (an email body, a ticket reply,
     *  a DM). A call whose text there holds an unfilled placeholder ("[DATE]", "{{name}}", "TBD")
     *  is refused before any gate stages an approval (outbound-placeholders.ts). */
    outboundTextParams?: readonly string[]
    /** Webhook signing secrets (`webhookSecretConfigKey`s) this tool's answer may carry: the
     *  host writes each where the tool put its `{ "$configSecret": key }` marker
     *  (reveal-secrets.ts), so the app's code never reads the secret. */
    revealsSecrets?: readonly string[]
    handler: ToolHandler
    // A tool's params is either a Zod-like schema (validated via `safeParse` in
    // execute-tool) or a JSON Schema object (compiled via ajv in execute-tool /
    // approvals.editMessage). Consumers narrow on `"type" in params` vs
    // `typeof params.safeParse === "function"`.
    params?:
      | { safeParse: (data: unknown) => { success: boolean; error?: unknown } }
      | { type: string; properties?: Record<string, unknown>; required?: string[] }
    returns?: { dimensions?: Record<string, string>; schema?: Record<string, string> }
    trustBoundary?: "internal" | "agent" | "user"
    instructions?: string
    taintSource?: boolean
    /** Host-only narrowing of `taintSource`: when present, a successful call taints the turn only
     *  when it answers true for these params (analyze_media taints only for a file that came from
     *  outside the org). A throw counts as true (fail closed). Not settable from a manifest. */
    taintSourceWhen?: (params: unknown, ctx: { orgId: string }) => Promise<boolean>
    /** The manifest's `taintSourceWhen`: a field of a row the tool read and the value that makes
     *  that row outside text. Carried here; the function above stays host-only. */
    taintSourceWhenRow?: {
      field: string
      equals: string | number | boolean
      /** The app's `outsideTextFields`: where text beside the rows comes from outside. */
      outsideFields?: readonly string[]
    }
    /** The manifest's `resultTaintWhen`: a successful result holding one of `fields` adds
     *  `scopes` to the turn's scope taint (execute-tool.ts). */
    resultTaintWhen?: { fields: readonly string[]; scopes: readonly string[] }
    /** Manifest `approvalCard`: the summary template and the `pill` shown on the card. */
    approvalCard?: { summary?: string; pill?: { label: string; labelKey?: string } }
    /** Manifest `resultCard`: how the tool's result is drawn as a card. */
    resultCard?: Record<string, unknown>
    /** Manifest `runningLabel` / `runningLabelKey`: the line shown while the tool runs. */
    runningLabel?: string
    runningLabelKey?: string
    /** A call chaining `@ref` tokens to a tool with `pinnedParams` stages unpinned. */
    pinnedOptionalOnRefs?: boolean
    /** Manifest `feature`: the app feature this tool belongs to. */
    feature?: string
    /** Manifest `focusCore`: `true` loads the tool on its app's hard focus, a string only when the
     *  focus verified that entity type. */
    focusCore?: boolean | string
    /** On a hidden tool: the visible tool of the same app to use instead. */
    useInstead?: string
    /** The tool has an external side effect or an exfiltration channel. An ungated call after
     *  the turn read untrusted text parks as an approval (taint_escalation). */
    externalEffect?: boolean
    /** Manifest `humanTurnOnly` (first-party apps only): the tool runs only on a person's own turn,
     *  a chat turn they typed, the app, or their own MCP client. From a routine tick, a sub-run or a
     *  job it is refused `human_turn_only` before any gate, never parked (execute-tool.ts). */
    humanTurnOnly?: boolean
    /** Manifest `dmOnly` (first-party apps only): an in-app agent runs it only in its DM with the
     *  person (`resolveRoomFloor` kind `dm`); in a shared or approval thread it is refused `dm_only`
     *  before any gate. A person in the app and an MCP client are not in a room and pass. */
    dmOnly?: boolean
    /** Host-only. The param holding the URL an outward fetch goes to. A call whose URL there is
     *  exactly one this same turn's own `web_search` returned, while the turn has read nothing
     *  new since that search, once per URL and at most three per search (turn-scope-accumulator
     *  .ts, `claimSearchResultFetch`), carries nothing out of the turn: the search service
     *  produced the URL, the model did not compose it, so the web-read guardrails skip its shape
     *  and payload checks (web-read-guardrails.ts). Only a call in a live turn's frame that
     *  judges no second thread qualifies (execute-tool.ts). Not settable from a manifest. */
    searchResultUrlParam?: string
    /** Host-only. The tool reads the public web (web_fetch, web_search): its only way out of the
     *  turn is the request it sends (a URL, a query). It never parks (scope-taint.ts, rule 9): it
     *  is neither held by the outside-content rule nor judged as a scope-tainted write, on any
     *  surface. What the request can carry is bounded by the web-read guardrails instead
     *  (web-read-guardrails.ts, enforced in execute-tool.ts). Not settable from a manifest. */
    outboundWebRead?: boolean
    /** The tool runs code on the person's own machine: it parks as an approval whenever the
     *  turn is tainted OR does not come from a turn the human typed directly. Host-only: a
     *  predicate applies the rule only to the calls it answers true for, on the validated params
     *  (computer_session_settings: an autonomy change, A35). */
    requiresHumanTurn?: boolean | ((params: unknown) => boolean)
    /** Host-only. Who may call the tool at all, from the call's own run frame: a non-null
     *  refusal is answered as the tool's result BEFORE any gate, so a caller that may never run
     *  it (a routine, another agent's ask, a sub-run, an MCP gateway) never parks an approval
     *  either. Also a call that has nothing to do (an app switched to the state it is already
     *  in): its idempotent answer comes back the same way, with no approval card. A refusal shaped
     *  as a tool error with a status (`{ error: { code, message, status } }`) is answered as that
     *  error. Null lets the call through to the gates and the handler. */
    refuseBeforeGate?: (
      params: unknown,
      /** `userId` is "system" for a caller that is not a person; `scopes` are the call's. */
      ctx: { orgId: string; userId: string; scopes: readonly string[] },
    ) => unknown | null | Promise<unknown | null>
    /** When true, a TRANSIENT postgres write-contention / connection error (serialization
     *  40001, deadlock 40P01, a connection blip — NOT pool exhaustion) thrown by this tool's
     *  handler is AUTO-RETRIED with a fresh transaction. Safe because such an error aborts the
     *  transaction atomically (nothing committed), so re-issuing the identical call is correct,
     *  never a duplicate. Opt-in and intended ONLY for PURELY-transactional DB-write tools with
     *  no pre-commit external side-effect (an outbox `queueEvent` inside the same tx is fine —
     *  it rolls back too). Defaults off. (BL-180) */
    retryOnTransientDbError?: boolean
    /** Host-only (kernel). The handler runs no whole-call transaction: it gets the call's
     *  RlsSession as `ctx.rlsSession` (a short transaction per step) and `ctx.db` refuses
     *  every use, so a call that waits on long work (a build, an install's health gate)
     *  never holds a connection idle in a transaction. Its preflight and its approved
     *  execution get a session too. Without a session (a caller holding a live
     *  transaction) the handler gets that transaction as usual. */
    ownsTransactions?: boolean
    /** When true, this tool is deferred — the model sees only its name until it discovers
     *  it via the tool_search tool. App tools are deferred by default; kernel tools are not. */
    deferLoading?: boolean
    /** Host-only. Words a person uses for what the tool does that neither its name nor its
     *  description carries ("connect", "integration" for the adapter save): `tool_search`
     *  weighs them almost like a name part, so a deferred tool is found by the request's
     *  own words. */
    searchKeywords?: readonly string[]
    /** When false, this tool is hidden from agent discovery and rejected when invoked
     *  by an agent actor by exact name. Defaults to true (visible). */
    agentVisible?: boolean
    /** A provider-contract op: callable ONLY through the kernel contract dispatch
     *  (`ctx.contracts.call`), never by a user, an agent, the API or `ctx.executeTool`. */
    contractOnly?: boolean
    /** Gated tool whose approval no policy and no capability arm may grant: only a human
     *  approval, or a direct UI click by a holder of the approve scope, lets it run. */
    noAutoApprove?: boolean
    /** When true, this tool is CALLABLE only inside a routine tick (the run frame
     *  carries a `routineId`) — `buildToolSet` filters it out of interactive chat and
     *  sub-runs, where it has no per-routine state. It is still DISCOVERABLE: `tool_search`
     *  surfaces it (flagged routine-only) so the routine-AUTHORING agent learns the
     *  capability exists and references it in the routine PROMPT rather than improvising a
     *  manual workaround (the ines-weekly-review-watch tool-surface gap — web_watch /
     *  watch_state were execution-gated AND undiscoverable, so the authoring agent never
     *  learned the real stateful-diff path). Defaults off. */
    routineOnly?: boolean
    /** When true, this tool is offered ONLY where a bound agent is acting: an
     *  agent-bound MCP connection (`ctx.agentId` set) or an in-app agent turn.
     *  A plain user token's catalog never carries it. The agent coordination
     *  tools set it: a tool whose whole meaning is "as this agent, ask that
     *  agent" has none for a connection that is nobody's agent (A30 point 1).
     *  Defaults off. */
    agentBoundOnly?: boolean
    /** When true, a session running ON the person's computer (an MCP
     *  connection a node job runs with) neither lists nor calls it: sharing a
     *  folder, cloning or dispatching there are not the session's to do
     *  (modules/mcp/node-session-connection.ts). Defaults off. */
    notForNodeSessions?: boolean
    /** When true, a person with no computer set up for Liaison is not offered
     *  it (in-app agent turns): a tool that reads the person's own computer
     *  (its repositories, what its signed-in gh and glab reach) has nothing to
     *  read, and its description would read as a claim that a computer exists.
     *  The turn sets `RunContext.noOwnComputer`; defaults off. */
    needsOwnComputer?: boolean
    /** When true, this tool is hidden from the outbound MCP server projection
     *  (`listMcpTools` / `buildToolSet({audience: "gateway"})`). Inbound MCP
     *  tools whose connection has `expose_via_gateway=false` set this flag at
     *  projection time so external MCP clients never see them while the
     *  in-process agent still can. */
    gatewayHidden?: boolean
    /** When true, this tool STRUCTURALLY requires an in-process agent
     *  execution thread (`ctx.agentExecutionThreadId`) to function — e.g.
     *  `spawn_agent`, which chains the new sub-run's `parent_run_id` off the
     *  caller's run frame and has no meaningful behavior without one. Such a
     *  tool can never succeed when invoked by an external MCP client (there is
     *  no in-process agent loop to supply the thread id), so it is excluded
     *  from the outbound MCP gateway projection (`buildToolSet({audience:
     *  "gateway"})` / `listMcpTools`) the same way `gatewayHidden` is — the
     *  in-process agent still sees it. Distinct from `gatewayHidden`, which is
     *  a per-connection admin toggle; this is a structural property of the
     *  tool itself. */
    requiresAgentExecutionThread?: boolean
    /** For inbound MCP tools projected from a personal connection: the user
     *  who owns the connection. `buildToolSet` filters out projected tools
     *  whose `ownerUserId` doesn't match the calling actor's `userId`, so
     *  personal tools stay invisible to everyone else in the org (spec
     *  success criterion #9). Null for org-scope connections + non-MCP tools. */
    ownerUserId?: string | null
    /** For inbound MCP tools: the server's own `tools/list` annotations, read by the connection
     *  default policy and by the outside-content hold (scope-taint.ts, rule 6h). */
    mcpAnnotations?: McpToolAnnotations
    /** Result keys a later sequenced step may reference via @ref tokens.
     *  MUST be lowercase snake_case — validated at registration (see
     *  `assertReferenceableOutputs`). */
    referenceableOutputs?: string[]
    /** What a GATED call of this tool tells the proposing agent beside the
     *  pending approval: fields added to its pending result, for things the
     *  agent must relay before it confirms (a node routine's guardrail risk
     *  note, D18). The approval summary is the reviewer's card, capped at 8
     *  short lines; this is the agent's. Null: nothing to add. */
    gatedAgentNotes?: (
      params: unknown,
      ctx: { orgId: string; userId: string; scopes: string[] },
    ) => Promise<Record<string, unknown> | null>
    /** Poll handler for async outputs — called by the approval-poll-output job.
     *  Returns the final result when ready, else { ready: false }. It asks the
     *  provider, so it is called with NO transaction open and opens its own
     *  short ones (a sandboxed poll: one per bridge call); the job writes the
     *  result afterwards in one guarded statement (poll-output.ts). */
    poll?: (
      ctx: { orgId: string; userId: string },
      partialResult: unknown,
    ) => Promise<{ ready: true; result: Record<string, unknown> } | { ready: false }>
    /** Outcome reconciler for a gated tool with an external effect — called by
     *  the approving reaper (approving-reaper.ts) when an approved execution's
     *  outcome is unknown (an `ambiguous` or `started` protocol row, or none).
     *  It asks the provider whether the effect happened: `executed` (with the
     *  provider's ref) settles the approval as approved, `not_executed` reverts
     *  it to pending, `unknown` leaves it for a person. Read-only: it never
     *  performs the effect. Declared in a manifest as `reconcileHandler`.
     *  Called with NO transaction open (it asks the provider); the reaper
     *  records the answer afterwards in one guarded statement. */
    reconcile?: (
      ctx: { orgId: string },
      input: { approvalRequestId: string; payload: unknown; externalRef: unknown },
    ) => Promise<ReconcileOutcome>
    /** Manifest snapshot attached at registration (manifest-format apps only).
     *  Carries the full `schema` with erasure declarations — the source of
     *  truth for compliance enumeration via {@link appBridgeManifest}. */
    _manifest?: BridgeManifest
  }
>({ validate: assertToolRequiredScopes, orgScoped: true })

/** Lowercase snake_case key — same charset the `@ref:` token regex enforces.
 *  Keeping `referenceableOutputs` keys strictly lowercase guarantees a built
 *  token's key segment always matches the handler's returned object key, so a
 *  "dumb model" pasting a token can never produce an unresolvable key. */
const REFERENCEABLE_OUTPUT_KEY_RE = /^[a-z][a-z0-9_]*$/

/** Throw a clear registration error if any `referenceableOutputs` key is not
 *  lowercase snake_case. Called by every tool-registration path. */
export function assertReferenceableOutputs(toolName: string, keys: string[] | undefined): void {
  if (!keys) return
  for (const key of keys) {
    if (!REFERENCEABLE_OUTPUT_KEY_RE.test(key)) {
      throw new Error(
        `Invalid referenceableOutput "${key}" on tool "${toolName}" — must be lowercase snake_case`,
      )
    }
  }
}

// Stores app-level agentInstructions keyed by [orgId, appName].
// Populated when an app with agentInstructions registers, read by the context assembler.
export const agentInstructionsRegistry = createTypedRegistry<
  [orgId: string, appName: string],
  AppGuideInput
>()

// Stores app-internal prompt content keyed by [orgId, appName, promptName].
// Built-in apps may ship internal prompts (e.g., tickets/summarizer) — these are NOT
// user-facing skills; they're invoked by app code via sandbox tools.
export const appPromptRegistry = createTypedRegistry<
  [orgId: string, appName: string, promptName: string],
  { content: string }
>()

// Stores user-facing skill entries keyed by [orgId, appName, skillName].
// Built-in apps declare these in their descriptor `skills` map and they are loaded
// at registration. User/org-authored skills live in `kernel.skills` (DB) and are
// merged at context-assembly time — they do NOT populate this registry.
// The context assembler emits a manifest of `name — description` lines and only
// re-injects `body` when the agent explicitly calls `skill_read`.
export const skillRegistry = createTypedRegistry<
  [orgId: string, appName: string, skillName: string],
  {
    name: string
    description: string
    body: string
    requiredScopes: string[]
    // Component A — optional so existing callsites need no churn; production
    // registration always supplies them. Consumers default kind→'playbook',
    // enabledByDefault→true when absent.
    kind?: "playbook" | "guide"
    enabledByDefault?: boolean
    /** The app feature the skill belongs to; absent for a skill of the whole app. */
    feature?: string
    // Manifest-declared trigger vocabulary (`skills.<name>.autoAttach` in the
    // app manifest). Same shape as `kernel.skills.auto_attach` (DB skills):
    // parsed with parseAutoAttachKeywords/parseAutoAttachApps at resolve time
    // so app and DB skills normalize identically. Absent/undefined for a
    // skill that declares nothing — no behaviour change.
    autoAttach?: { keywords?: string[]; apps?: string[] } | null
  }
>()

/**
 * Component-A routine templates, populated per-org during `registerApps` from
 * each app's manifest `routines` block, plus the kernel's own templates under
 * the app name "kernel" (registered with the kernel tools, S28). `handleEnableRoutineTemplate` reads
 * these to instantiate a user-owned routine on demand. Process-local in-memory
 * (like `skillRegistry`) — re-populated for every org at boot, so no DB-backed
 * template store is needed for Phase 1–3.
 */
export const routineTemplateRegistry = createTypedRegistry<
  [orgId: string, appName: string, templateKey: string],
  {
    description: string
    kind: "recurring" | "scheduled" | "event"
    cron?: string
    timezone?: string
    runAt?: string
    event?: string
    promptTemplate: string
    scopes: string[]
    enabledByDefault: boolean
    /** Copied to the routine when the template is enabled: its runs stage drafts and end. */
    followUp?: boolean
    /**
     * Kernel templates with options (`enable_routine_template`'s `quietDays`,
     * `pipelineId`): the prompt for the options chosen, or a plain error.
     */
    renderPrompt?: (options: {
      quietDays?: unknown
      pipelineId?: unknown
    }) => { prompt: string } | { error: string }
    /** The options a routine's prompt was rendered with, so a reset keeps them. */
    optionsOf?: (prompt: string) => { quietDays?: unknown; pipelineId?: unknown } | undefined
    /** Pinned output visibility; absent = personal. */
    visibility?: "personal" | "shared"
    /**
     * Where the template comes from: an app's manifest (absent = 'app'), or
     * the kernel itself ('kernel', registered under the app name "kernel" by
     * kernel-routine-templates.ts; its routines carry no app_name).
     */
    sourceKind?: "app" | "kernel"
    /** A flow template and its event filter (0303), placeholders unfilled. */
    flow?: Record<string, unknown>
    eventFilter?: Record<string, unknown>
  }
>()

export const timelineDeclarations = createTypedRegistry<
  [orgId: string, appName: string, entityName: string],
  { app: string; entity: string; fields: string[] }
>()

export const dimensionDefRegistry = createTypedRegistry<
  [orgId: string, appName: string, dimKey: string],
  {
    type: string
    order?: string[]
    values?: string[]
    label?: string
    description?: string
    manageHref?: string
  }
>()

export type ApprovalSummarizer = (
  params: unknown,
  ctx: {
    tx: RlsClient
    orgId: string
    userId: string
    /** Gate-time caller context, when available. Lets the summarizer wrapper
     *  hydrate entity detail via the app's own UNGATED read tools (manifest
     *  `summarizerContext`) under the caller's real authorization. */
    actor?: import("~/db/rls").ActorContext
    /** The conversation the call was made in, when there is one (gate time only). */
    threadId?: string
    /** The agent that made the call, when known (gate time only). */
    actingAgentId?: string | null
  },
  /** Enrichment payload built by the kernel wrapper (runtime.ts
   *  buildSummarizerMeta): the app's connection identifier for external deep
   *  links + the hydrated summarizerContext read result. Optional — direct
   *  registrations (host apps' own summarizers) may ignore it. */
  meta?: { connectionIdentifier: string | null; context: unknown },
) => Promise<ApprovalSummary>

export const approvalSummarizerRegistry = createTypedRegistry<
  [orgId: string, appName: string, toolName: string],
  ApprovalSummarizer
>()

export const approvalEditableFieldsRegistry = createTypedRegistry<
  [orgId: string, appName: string, toolName: string],
  // Phase 16 Task A5 — widget enum widened; `listSource` carries the dot-path
  // referenced by `checkbox-per-line`.
  Array<{
    field: string
    label: string
    widget: "text" | "richtext" | "checkbox" | "checkbox-per-line" | "key-value-list"
    listSource?: string
    /** Derived payload keys blanked when this field is edited (see
     *  ApprovalEditableField.invalidates in @liaison/shared). */
    invalidates?: string[]
  }>
>({
  // No editable field may reach a pinned param of its tool (registered first,
  // as every registration path does): a pinned value is the server's.
  validate: ([orgId, appName, toolName], fields) => {
    const pinned = toolRegistry.get([orgId, appName, toolName])?.pinnedParams ?? []
    for (const f of fields) {
      const hit = pinnedOverlap(pinned, f.field)
      if (hit !== null) {
        throw new Error(
          `${appName}:${toolName}: editable field "${f.field}" reaches the pinned param "${hit}"`,
        )
      }
    }
  },
})

export const approvalExpiryRegistry = createTypedRegistry<
  [orgId: string, appName: string, toolName: string],
  number
>()

// Opt-in gated-approval idempotency: maps a (org, app, gated-tool) to the NAME of
// the param whose value uniquely identifies the staged action (e.g. boxtal
// create_shipment's `draft_id`). When present, execute-tool dedupes a re-stage
// against an existing PENDING approval for the same (org, tool, key-value) instead
// of creating a duplicate. Unset for a tool = no dedupe (today's behavior).
export const approvalDedupeKeyRegistry = createTypedRegistry<
  [orgId: string, appName: string, toolName: string],
  string
>()

// Narrows the dedupe above to the SAME requester identity: a re-stage only
// restages a pending approval staged by the same person, acting agent and
// routine; anyone else's pending approval for the key is left alone and the
// call stages its own. Set for tools whose pending payload is someone's
// authored content (a ticket reply a human typed must never be overwritten
// by an agent's draft). Unset = requester-blind dedupe.
export const approvalDedupeSameRequesterRegistry = createTypedRegistry<
  [orgId: string, appName: string, toolName: string],
  true
>()

/**
 * Declarative resource-owner resolution for gated tools (privacy routing).
 * A tool may declare (manifest `resourceOwner`) that its call targets a row in
 * one of the app's own tables that can be PERSONALLY owned (owner_type='user').
 * `table` is the physical table in the app's schema, `param` names the tool
 * param carrying the row id. When the owning resource is not the account
 * itself, `account` hops one level: `column` on the target row references the
 * account table that carries the effective `visibility` ('personal' | 'shared',
 * defaulting from owner_type). createApprovalRequest consults this to route a
 * personal-resource approval to the OWNER alone instead of the org-wide
 * approver fan-out. The `requester` form is for a call that CREATES the
 * personal resource, so no row exists yet: the requester is its owner.
 */
export type ResourceOwnerDecl =
  | {
      table: string
      param: string
      account?: { table: string; column: string }
    }
  | {
      /** The call creates a personal resource for the requester: when
       *  `params[param] === equals`, the requesting user is the owner. */
      requester: { param: string; equals: string }
    }
  | {
      /** The call always acts on the requester's own resource (their own
       *  computer, say): the requesting user is always the owner. Host tools only. */
      requesterAlways: true
    }
  | {
      /** The call writes the ACTING AGENT's own resource (its memory tree): a personal
       *  agent's owner, or the requester when no agent acts (their own memory). A role or
       *  system agent's resource is shared by everyone who uses it: null, the org's deciders.
       *  Host tools only (scope-taint.ts, rule 13). */
      actingAgentTree: true
    }
  | {
      /** Decided per call from its params: the user who alone decides it (a personal resource),
       *  or null for the org's deciders. For an owner that is neither a row column nor a fixed
       *  param value, such as "the requester's own routine". Host tools only; a throw counts as
       *  null. */
      resolveOwner: (
        params: Record<string, unknown>,
        ctx: { orgId: string; requestedBy: string },
      ) => Promise<string | null>
    }

export const approvalResourceOwnerRegistry = createTypedRegistry<
  [orgId: string, appName: string, toolName: string],
  ResourceOwnerDecl
>()

export const webhookHandlers = createTypedRegistry<
  [orgId: string, appName: string, endpointName: string],
  {
    // Host handlers MAY return a `{ status, body? }` result (the webhook route
    // maps a non-2xx to a retriable HTTP status and releases the replay claim)
    // or resolve void for the legacy fire-and-forget contract. Manifest handlers
    // return their result through the sandbox bridge.
    handler: ((payload: unknown, ctx: any) => Promise<unknown>) | ManifestHandlerRef
    verify: ((request: Request) => Promise<WebhookVerificationResult>) | ManifestHandlerRef
    appName: string
    orgId: string
    bodyLimitBytes?: number
    /** Sandbox budget for one run of a manifest handler (manifest `timeoutMs`). */
    timeoutMs?: number
    _manifest?: BridgeManifest
    /**
     * U4.12 (CI→projects webhook): most webhook handlers only ever write to
     * their OWN app's schema (e.g. monitoring's `incidents`), where RLS
     * policies check `org_id` only — a plain `SystemContext` actor (no
     * `app.current_user_id`) is enough. A handler that calls into a
     * kernel-owned, user-scoped primitive (projects' `createTask`, which
     * inserts `kernel.thread_participants` under a `WITH CHECK (user_id =
     * current_setting('app.current_user_id')::uuid OR ...)` policy) needs the
     * RLS session's `app.current_user_id` to actually match the actor's
     * resolved userId — a `SystemContext` can never satisfy that (by design:
     * a webhook's HMAC trust boundary is not a specific human). Opt a webhook
     * into a resolved-user RLS actor by setting this flag on its manifest
     * entry; every existing webhook (monitoring/tickets/shopify/boxtal/
     * invoicing) leaves it unset and keeps today's SystemContext behavior
     * unchanged.
     */
    requiresUserActor?: boolean
  }
>({ orgScoped: true })

/** Records cross-app tool dependencies declared via `manifest.dependencies.tools`. */
export const appDependenciesRegistry = createTypedRegistry<
  [orgId: string, appName: string],
  { tools: string[] }
>()

/**
 * Records the install-approved cross-app tool capabilities declared via
 * `manifest.cross_app_calls[].target` (e.g. `shopify:variants_get`).
 *
 * This is the authorization surface for app↔app calls: a cross-app
 * (`internalCall`) invocation whose target appears here is authorized by the
 * operator-approved declaration itself, independent of the caller app-actor's
 * RBAC scopes. RBAC scopes gate *user/agent* access to a tool; they do not
 * express app↔app capabilities. Without this, event-driven handlers (which run
 * as a bare `${app}:*` system actor) can never call another app's tools.
 */
export const appCrossAppCallsRegistry = createTypedRegistry<
  [orgId: string, appName: string],
  { targets: string[] }
>()

/**
 * Provider contracts an app IMPLEMENTS (`manifest.implements`), keyed by "<contract>@<version>":
 * the op → tool-name map the kernel contract dispatch resolves through.
 */
export const appContractImplementationsRegistry = createTypedRegistry<
  [orgId: string, appName: string],
  Record<string, { ops: Record<string, string> }>
>()

/**
 * Provider contracts an app CALLS (`manifest.contract_calls`), keyed by "<contract>@<version>":
 * where the caller's admin-set binding lives (`<own table>.<column>`).
 */
export const appContractCallsRegistry = createTypedRegistry<
  [orgId: string, appName: string],
  Record<string, { bindingSetting: string }>
>()

/**
 * Settings schemas + defaults for an app's `organizations.settings.<app>` and
 * `users.settings.<app>` namespaces (read by the sandbox bridge and the user
 * settings routes), and the app's declarative settings page, derived from the
 * manifest `settings` (settings-schema-from-manifest.ts), so in-tree, bundled
 * and installed apps qualify alike.
 */
export const appSettingsRegistry = createTypedRegistry<
  [orgId: string, appName: string],
  {
    orgSchema?: z.ZodTypeAny
    userSchema?: z.ZodTypeAny
    userDefaults?: Record<string, unknown>
    /** The manifest `settings` page: sections (adminScope materialised) and a validator per field. */
    manifestSettings?: ManifestSettingsEntry
  }
>()

/** Per-app attention items provider declarations.
 * `orgId` may be the literal "*" to register a kernel-scoped (cross-org) provider.
 * `scope` is optional — providers without a declared scope perform row-level
 * authorization internally instead of being pre-filtered by the aggregator.
 */
export const attentionItemsRegistry = createTypedRegistry<
  [orgId: string, appName: string],
  {
    handler: string
    scope?: string
    bundlePath: string
    core: boolean
    /** Declared `passesOn`: also given the people away today who name the viewer next in line. */
    passesOn?: boolean
  }
>()

export const viewRegistry = createTypedRegistry<
  [orgId: string, appName: string],
  Record<string, any>
>()
// Phase 17 (B9/B10): slot registry value holds the manifest slot definition.
// Either flat `panels` (e.g. contact_detail.panels[]) or nested by host_app
// (e.g. invoicing.document_detail.tabs[]). `position` retained for legacy
// callers that only need the slot host position metadata.
export interface SlotRegistryPanel {
  id: string
  label: string
  component: string
  order?: number
  visibility_scope?: string
}
export interface SlotRegistryEntry {
  position?: string
  panels?: SlotRegistryPanel[]
  tabs?: SlotRegistryPanel[]
  // Nested host-slot contributions: the registry key's `slotName` is the HOST
  // app (e.g. `invoicing`) and the value carries one or more `<slot_id>` keys,
  // each holding a `tabs` array (e.g. `{ document_detail: { tabs: [...] } }`).
  // `listSlotPanels("invoicing.document_detail.tabs")` reads this shape (K1a).
  [slotId: string]: string | SlotRegistryPanel[] | { tabs?: SlotRegistryPanel[] } | undefined
}
export const slotRegistry = createTypedRegistry<
  [orgId: string, appName: string, slotName: string],
  SlotRegistryEntry
>()
/** One record path a template may map (manifest `entities.<e>.print.fields`). */
export interface PrintFieldDeclaration {
  path: string
  label: string
  type: "string" | "number" | "boolean" | "date"
  /** The list path this field repeats over: mapped as `<repeat>.<n>.<rest>`. */
  repeat?: string
}

/**
 * `entities.<e>.print` (manifest-schema.ts, contract.ts printDeclarationErrors):
 * the entity prints through the org's document templates
 * (modules/documents/print.ts).
 */
export interface PrintDeclaration {
  /** This app's readOnly, ungated tool returning the record. */
  recordTool: string
  /** The record tool's parameter that takes the record id. */
  idParam: string
  /** The fileParent row is made by the first print: a preview may read a record with no row
   *  yet (manifest-schema.ts; contract.ts checks the parent's visibility is its scope alone). */
  parentMadeOnPrint?: boolean
  /** What one record is called ("Shipment"). */
  label: string
  fields: PrintFieldDeclaration[]
}

/**
 * `entities.<e>.pick` (manifest-schema.ts, contract.ts pickDeclarationErrors): how a person
 * picks one record of the entity (a dashboard table's link cell) when the search index does not
 * hold it: this app's own readOnly, ungated tool, run as the person with `{ [queryParam]: q }`;
 * each item of its result (at `itemsPath`, else the result or its only list) gives the record's
 * id (`idField`) and label (`labelField`).
 */
export interface PickDeclaration {
  tool: string
  queryParam: string
  idField: string
  labelField: string
  itemsPath?: string
  /** Fixed params passed beside the query (e.g. `{ kind: "task" }`). */
  params?: Record<string, string | number | boolean>
}

export const entityRegistry = createTypedRegistry<
  [orgId: string, appName: string, entityName: string],
  {
    labelField: string
    handlePrefix: string
    searchable?: boolean
    mentionable?: boolean
    tableName?: string
    readScope?: string
    indexFields?: SearchIndexFields
    /** Soft-delete marker column — see manifest-schema.ts `archivedField`. */
    archivedField?: string
    /** Printable through the org's document templates (modules/documents/print.ts). */
    print?: PrintDeclaration
    /** Picked by its app's own read tool (a dashboard table's link cell). */
    pick?: PickDeclaration
    permissionFields?: {
      readScope: string
      participantIdsField?: string
      dimensionFields?: string[]
      /** Generic ACL search primitive — see manifest-schema.ts for field docs. */
      aclFields?: {
        orgWideField: string
        userIdsField: string
        roleIdsField: string
      }
    }
  }
>({ orgScoped: true })

/**
 * `entities.<e>.routineFlow` (manifest-schema.ts, contract.ts routineFlowDeclarationErrors): the
 * entity is a routine flow's trigger record. Read through modules/agent/routines/flow-records.ts,
 * never directly; `bundlePath` is the core app's server module its handler exports live in.
 */
export const routineFlowRecordRegistry = createTypedRegistry<
  [orgId: string, appName: string, entityName: string],
  {
    decl: import("~/modules/agent/routines/flow-records").RoutineFlowDeclaration
    bundlePath: string
  }
>({ orgScoped: true })

/**
 * `entities.<e>.tableBacking` (manifest-schema.ts, contract.ts tableBackingDeclarationErrors): the
 * entity's records can be a dashboard table's rows, one `parent` record's worth (a project's
 * tasks). `provider` names an export of the app's own server module (a core app only), loaded
 * by `load`; it reads and writes under the caller's RLS (modules/dashboards/tables/backing.ts,
 * TableBackingProvider).
 */
export const tableBackingRegistry = createTypedRegistry<
  [orgId: string, appName: string, entityName: string],
  {
    parent: string
    provider: string
    load: () => Promise<Record<string, unknown>>
  }
>({ orgScoped: true })

/**
 * Per-app, per-entity declarations describing where attached files live and the
 * read/write scopes used to gate them. Populated when a manifest entity declares
 * `fileParent`. The kernel files RLS builder reads this to project policies onto
 * `kernel.files` so any app entity can participate by a single manifest entry.
 */
export const manifestFileParentRegistry = createTypedRegistry<
  [orgId: string, appName: string, entityName: string],
  {
    tableName: string
    schemaRef: string
    joinOn: string
    readScope: string
    writeScope: string
    /** Delete: the uploader, or a holder of this scope. Absent: writeScope alone. */
    deleteScope?: string
    /** Set when the parent table is immutable with a legal retention period. */
    retention?: { retentionYears: number; anchor: string }
  }
>({ orgScoped: true })

/**
 * Per-app attention translations — declarative event-to-attention mappings.
 * Read by the Phase 10 translation worker when an event is delivered through the
 * outbox. Stored at the [orgId, appName] grain because translations live at the
 * top of the manifest (one set per app, applies to all of the app's entities).
 */
export type AttentionPredicate =
  | { op: "eq"; path: string; value: unknown }
  | { op: "in"; path: string; values: unknown[] }
  | { op: "exists"; path: string }
  | { op: "and"; clauses: AttentionPredicate[] }
  | { op: "or"; clauses: AttentionPredicate[] }
  | { op: "not"; clause: AttentionPredicate }

export type AttentionRecipientSpec =
  | { kind: "field"; path: string }
  | { kind: "participants"; path: string; excludeActor?: boolean }
  | { kind: "mentions"; path: string }
  | { kind: "actor" }
  | {
      kind: "scope_holders"
      scope: string
      dimensionFilter?: Record<string, unknown>
      excludeActor?: boolean
    }

export type AttentionTranslation = {
  event: string
  kind: string
  urgency: number
  isUrgent?: boolean
  summary: string
  when?: AttentionPredicate
  recipients: AttentionRecipientSpec
  /** The event RESOLVES the attention row (marks matching unread rows read)
   *  instead of upserting one. `{ field, equals }` resolves on a payload match
   *  (a digest whose backlog reached zero); `{ always: true }` resolves
   *  unconditionally (the event itself means the condition is over). */
  resolveWhen?: { field: string; equals: string | number | boolean } | { always: true }
}

export const manifestAttentionRegistry = createTypedRegistry<
  [orgId: string, appName: string],
  AttentionTranslation[]
>()

/**
 * Phase 16 Task A3 — declared `filterableAxes` per app (e.g. `["market", "currency"]`),
 * keyed by `[orgId, appName]`. These are the axes the Settings → Attention preferences
 * page surfaces as filter chips on subscription rules.
 *
 * Populated at app-registration time from `manifest.attention.filterableAxes`;
 * apps without the field are absent from this registry (empty list semantics).
 */
export const manifestAttentionAxesRegistry = createTypedRegistry<
  [orgId: string, appName: string],
  string[]
>()
export const exportRegistry = createTypedRegistry<
  [orgId: string, appName: string],
  {
    formats: string[]
    handler: ((ctx: any, format: string) => Promise<unknown>) | ManifestHandlerRef
    schema?: Record<string, string>
    dimensions?: Record<string, string>
  }
>()

/**
 * Import kinds an app declares (`import.kinds` in its manifest), keyed by
 * `[orgId, appName]` like `exportRegistry`. `bundle` is set for an app with a
 * handler bundle: a kind without a built-in host handler
 * (modules/imports/builtin-import-handlers.ts) runs that bundle's export.
 */
export const importRegistry = createTypedRegistry<
  [orgId: string, appName: string],
  {
    kinds: Record<string, import("~/modules/imports/kind-schema").ImportKindDecl>
    bundle?: { bundlePath: string; core: boolean }
    _manifest?: Record<string, unknown>
  }
>()

/**
 * One knowledge source kind an app declares (manifest `knowledgeSources.<kind>`):
 * the sync handler the platform wakes with `{ sourceId, kind, config, cursor }`
 * (apps/knowledge/app-sources.ts), the scope the source's owner must hold, and
 * the JSON Schema of a source's config.
 */
export interface KnowledgeSourceKindDecl {
  title: string
  description?: string
  handler: string
  readScope?: string
  configSchema?: Record<string, unknown>
  timeoutMs?: number
}

/** What the platform hands one sync run of an app's knowledge source. */
export interface KnowledgeSyncDispatchInput {
  sourceId: string
  kind: string
  config: Record<string, unknown>
  cursor: unknown
  /** Whose source it is: one person's own, or the organization's. */
  scope: "personal" | "organization"
}

/**
 * The knowledge source kinds an app declares, keyed by `[orgId, appName]`, with
 * the function that runs one sync page of a kind in the app's sandbox (built at
 * registration, like the external search handler). `userId` is the source's
 * owner: the run acts for them.
 */
export const knowledgeSourceKindRegistry = createTypedRegistry<
  [orgId: string, appName: string],
  {
    kinds: Record<string, KnowledgeSourceKindDecl>
    dispatch: (
      kind: string,
      input: KnowledgeSyncDispatchInput,
      tenant: { orgId: string; userId: string },
    ) => Promise<unknown>
  }
>()

// Declared emits per app, keyed by "orgId:appName" for multi-tenant isolation.
// Populated during registration, used to validate events at emit time.
// Lives here (not in event-bus.ts) to avoid circular imports since context.ts needs it.
export const declaredEmits = new Map<string, Set<string>>()

/**
 * Disposers for the event subscriptions an app registered, keyed by
 * [orgId, appName]. Each registration appends the disposer returned by
 * `subscribeToEvent`; registration rollback and uninstall call every disposer
 * for the app so its in-process channel handlers (and the underlying Redis
 * subscription, when the last handler goes) are torn down. Without this a
 * reinstall would stack duplicate handlers, double-processing every event.
 */
export const eventSubscriptionDisposers = createTypedRegistry<
  [orgId: string, appName: string],
  Array<() => Promise<void>>
>()

/**
 * Stores the `capabilities` array declared on each installed app's manifest,
 * keyed by `[orgId, appName]`. Populated at app-registration time (see
 * `modules/apps/runtime.ts`) and consulted by `tool-bridge.ts` to gate the
 * registration of capability-scoped kernel tools.
 *
 * The registry is the in-process source of truth — capabilities are NOT
 * persisted on `kernel.apps_installed`; they live on the in-memory app
 * descriptor and are re-derived on each runtime boot.
 */
export const appCapabilitiesRegistry = createTypedRegistry<
  [orgId: string, appName: string],
  string[]
>()

/**
 * The data store collections each app declares (manifest `store.collections`),
 * keyed by [orgId, appName]; set at registration for an app that declares any.
 * Read through modules/data-store/declared.ts.
 */
export const appStoreDeclarationsRegistry = createTypedRegistry<
  [orgId: string, appName: string],
  Readonly<Record<string, StoreCollectionDeclaration>>
>()

/**
 * Kernel-universal capabilities — core kernel primitives that are present in
 * EVERY org with NO app install required. `orgHasCapability` short-circuits to
 * `true` for these before scanning the per-app registry, so the kernel tools
 * they gate (e.g. `kernel:spawn_agent`) always register and surface.
 *
 * `agent.spawn` is the canonical member: sub-agent spawning is a core kernel
 * primitive, not an app-provided capability. (An app — e.g. the test-only
 * `chaos-debug` — may still declare `agent.spawn` in its manifest; that
 * declaration is now redundant but harmless.)
 */
const KERNEL_CAPABILITIES = new Set<string>(["agent.spawn"])

/**
 * True when the capability is kernel-universal (always present), or ≥1 app
 * installed in this org declares it.
 */
export function orgHasCapability(orgId: string, capability: string): boolean {
  // Kernel-universal primitives are present in every org with no app install.
  if (KERNEL_CAPABILITIES.has(capability)) return true
  for (const [, caps] of appCapabilitiesRegistry.entriesOf(orgId)) {
    if (caps.includes(capability)) return true
  }
  return false
}

export function getDeclaredEmits(orgId: string, appName: string): Set<string> | undefined {
  return declaredEmits.get(`${orgId}:${appName}`)
}

/**
 * Every subscribable in-tree event for an org, grouped by app — the catalog a
 * kind:'event' routine can bind to. Pulls both the org-scoped emits (the apps
 * installed in THIS org, keyed "orgId:appName") and the kernel-global emits
 * (keyed "*:kernel" etc.). Returns full `app:entity:action` strings so the agent
 * can DISCOVER which events exist (e.g. `projects:task:moved`) instead of guessing
 * from prose — this is what `list_routine_events` surfaces and what
 * `validateRoutineEvent` accepts. Sorted for stable output.
 */
export function getAllDeclaredEmits(orgId: string): Array<{ app: string; event: string }> {
  const out: Array<{ app: string; event: string }> = []
  const seen = new Set<string>()
  for (const [key, events] of declaredEmits.entries()) {
    const sep = key.indexOf(":")
    if (sep < 0) continue
    const keyOrg = key.slice(0, sep)
    const app = key.slice(sep + 1)
    // Org-scoped emits for THIS org, plus kernel-global emits keyed under "*".
    if (keyOrg !== orgId && keyOrg !== "*") continue
    for (const entityAction of events) {
      const full = `${app}:${entityAction}`
      if (seen.has(full)) continue
      seen.add(full)
      out.push({ app, event: full })
    }
  }
  out.sort((a, b) => a.event.localeCompare(b.event))
  return out
}

export function setDeclaredEmits(orgId: string, appName: string, emits: Set<string>): void {
  declaredEmits.set(`${orgId}:${appName}`, emits)
}

export function deleteDeclaredEmits(orgId: string, appName: string): void {
  declaredEmits.delete(`${orgId}:${appName}`)
}

/**
 * Stores the full {@link BridgeManifest} (carrying the `schema` with
 * `userRef`/`onErase` erasure declarations) for every installed manifest-format
 * app, keyed by [orgId, appName]. Populated at registration time for EVERY app —
 * including tool-less/webhook-less apps (e.g. contacts) whose schema would
 * otherwise be unreachable from the tool/webhook registries. Compliance paths
 * (GDPR erasure) read the schema from here via {@link appBridgeManifest}.
 */
export const appBridgeManifestRegistry = createTypedRegistry<
  [orgId: string, appName: string],
  BridgeManifest
>()

/**
 * Stores the frontend-facing manifest data for manifest-format apps, keyed by [orgId, appName].
 * The manifests endpoint reads this to return app UI configuration to the frontend.
 */
export const manifestRegistry = createTypedRegistry<
  [orgId: string, appName: string],
  {
    name: string
    views?: Record<string, any>
    slots?: Record<string, any>
    contributions?: Record<string, any>
    bulk?: Record<string, any>
    roles?: Record<string, any>
    savedViews?: Record<
      string,
      { defaults: Array<{ key: string; name: string; payload: unknown }> }
    >
    entities?: Record<string, any>
    /** Manifest `features`: the switches inside the app (org-features.ts reads them). */
    features?: Record<
      string,
      { adminScope: string; labelKey: string; offMessageKey?: string; offNextKey?: string }
    >
    /** Widget hints for the bulk form: only the bulk underlying tools' shared
     *  fields (see bulk-field-schemas.ts), never the full tool catalog. */
    tools?: Record<string, BulkToolSchema>
    /** Non-secret `kernel.apps.config` keys an admin may write (manifest `configKeys`). */
    configKeys?: AppConfigKeyDecl[]
    /** `app` or `connector` (manifest `kind`, default `app`). */
    kind?: AppKind
    /** The declarative settings page, each org section's adminScope materialised. */
    settings?: { sections: SettingsSection[] }
    /** Listing fields, for the app pages and the store. */
    description?: string
    displayName?: string
    version?: string
    license?: string
    author?: string
    /** The store listing's publisher (manifest `listing.publisher`). */
    publisher?: string
    /** The app's icon as data (S1): checked SVG markup, or a name from Liaison's icon set. */
    iconSvg?: string
    iconName?: string
    homepage?: string
    uiBundleUrl: string | null
  }
>()

/**
 * Stores connection config (from app manifests) keyed by [orgId, appName, connectionName].
 * Used by startOAuthFlow and credential validation to look up connection declarations.
 */
export const connectionConfigRegistry = createTypedRegistry<
  [orgId: string, appName: string, connectionName: string],
  {
    type: "oauth2" | "credentials"
    description?: string
    /** The app works without this connection (Settings > Apps demotes it). */
    optional?: boolean
    /** A few words naming what it connects, for the connect button. */
    purpose?: string
    /** Administers the connection for the org (connections/admin-scope.ts); default
     *  `<app>:accounts:admin`. */
    adminScope?: string
    authorizationUrl?: string
    tokenUrl?: string
    userinfoUrl?: string
    scopes?: string[]
    /** Scopes the app may ask for later, never in the base grant (Shopify `read_users`).
     *  Never written to a generated provider app configuration. */
    optionalScopes?: string[]
    /** Scopes the provider grants only after approving the app (Shopify
     *  `read_all_orders`): requested only when the org's `setting` toggle is on or
     *  the re-authorized account already holds them (connections/protected-scopes.ts). */
    protectedScopes?: Array<{ scope: string; setting: string }>
    /** Scopes of `scopes` Google allows only a client verified for restricted
     *  scopes (Drive `drive.readonly`): dropped when this client may not ask this
     *  person for them (connections/restricted-scopes.ts). */
    restrictedScopes?: string[]
    /** The provider grants the scopes of the provider app's released configuration,
     *  not the ones the authorize request names (Shopify-managed installation): a
     *  missing scope is added to that configuration and released before a reconnect. */
    scopesFromAppConfiguration?: boolean
    /** The provider API version the app pins (Shopify Admin API `YYYY-MM`): the
     *  generated provider app configuration (shopify.app.toml) carries it. */
    apiVersion?: string
    extraParams?: Record<string, string>
    /** `readable`: the stored value may be read back for an edit form (connections/settings.ts). */
    credentialFields?: Array<{
      name: string
      label: string
      type: string
      required?: boolean
      readable?: boolean
      /** A value refused before storage (manifest-schema.ts); the message never holds the value. */
      refusePattern?: { pattern: string; code: string; message: string; messageKey?: string }
    }>
    /** A read-only tool run with the candidate key before it is stored (connections/precheck.ts). */
    checkBeforeStore?: string
    allowedDomains: string[]
    templateVars?: Record<string, { lowercase?: boolean; pattern: string; appendSuffix?: string }>
    identifierVar?: string
    /** How the provider signs its OAuth callback (manifest-schema.ts). */
    callbackSignature?: "hmac-sha256-query"
    clientSecretConfigKey?: string
    webhookSecretConfigKey?: string
    appSecretConfigKeys?: string[]
    setupGuide?: { summary?: string; steps?: SetupStepInput[]; docsUrl?: string }
    /** Credentials only: the org holds several accounts of this connection, one per
     *  admin-chosen slug identifier (connections/service.ts, MULTI_INSTANCE_IDENTIFIER_RE). */
    multiInstance?: boolean
    // --- OAuth2 provider-quirk knobs (all OPTIONAL; defaults preserve the standard
    // OIDC/OAuth2 behaviour, so existing connections are unaffected). Added for
    // providers like Meta Instagram Business Login that diverge from the norm.
    /** Separator used to join `scopes` in the authorize URL. Default " " (space).
     *  Meta/Instagram want "," (comma). */
    scopeSeparator?: string
    /** When false, skip PKCE (no code_challenge in authorize, no code_verifier in
     *  the token exchange). Default true. Some providers reject unexpected PKCE. */
    usePkce?: boolean
    /** A SECOND token exchange after the code->token step: swap the short-lived
     *  token for a long-lived one (Instagram). GET `<url>?grant_type=<grantType>&
     *  client_secret=..&access_token=<short>`; the returned access_token replaces
     *  the short-lived one. */
    longLivedTokenUrl?: string
    /** grant_type for the long-lived exchange. Default "ig_exchange_token". */
    longLivedTokenGrantType?: string
    /** Query-param NAME that carries the short-lived token in the long-lived
     *  exchange. Default "access_token" (Instagram). Facebook's fb_exchange_token
     *  grant carries it under "fb_exchange_token". */
    longLivedTokenParamName?: string
    /** Include the OAuth client_id in the long-lived exchange (alongside
     *  client_secret). Facebook's fb_exchange_token grant requires it; Instagram's
     *  ig_exchange_token does not. Default false. */
    longLivedIncludeClientId?: boolean
    /** Read the connection identifier straight from a field of the TOKEN response
     *  (e.g. Instagram returns `user_id`), when there is no id_token/userinfo. */
    identifierFromTokenField?: string
    /** Field of the `userinfoUrl` response to use as the identifier. Default
     *  "email" (OIDC). Meta/Facebook use "id" (`GET /me` -> the user id). */
    identifierFromUserinfoField?: string
    /** The identifier at a dotted path of the `userinfoUrl` response (`data[].id`):
     *  one account is taken, several are never picked from silently
     *  (connections/oauth-manifest-knobs.ts). */
    identifierFromUserinfoPath?: string
    /** The field beside the id at `identifierFromUserinfoPath` naming the account. */
    accountNameField?: string
    /** Authorize parameters read from the app's config, by parameter name
     *  (connections/oauth-manifest-knobs.ts). */
    authorizeConfigParams?: Record<string, { configKey: string; pattern: string }>
    /** Endpoint that lists the permissions the user ACTUALLY granted, for
     *  providers whose token response carries no `scope` (Meta: Facebook Login
     *  lets the user untick individual permissions, and the token response never
     *  says which). GET with the new access token; the response is Meta's
     *  `{ data: [{ permission, status }] }` and only `status: "granted"` counts.
     *  Without it such a grant is never recorded, so scope drift is never
     *  flagged. */
    grantedScopesUrl?: string
    /** Endpoint that reports the token's own expiry (Meta's `debug_token`): GET
     *  `?input_token=<access token>` with the app token (`<client id>|<client
     *  secret>`) as bearer; the response is `{ data: { expires_at,
     *  data_access_expires_at } }` in Unix seconds (0 = never). Read at connect
     *  into `metadata.tokenExpiry`; the expiry reminder (connections/attention.ts)
     *  then uses the earlier of the two instead of the exchange's `expires_in`. */
    tokenDebugUrl?: string
    /** Endpoint that names the connected account, for providers whose identifier
     *  is an opaque id (Meta: a numeric user, Page or Instagram account id), so
     *  Settings never shows "Unnamed account". GET with the access token as a
     *  Bearer at connect, at token renewal and on reconcile; best effort (a
     *  failed lookup leaves the stored name as it was). */
    displayNameUrl?: string
    /** Where the name sits in the `displayNameUrl` response, in order of
     *  preference: dotted paths, where a `[]` suffix maps over an array and the
     *  names found are joined with ", " (`accounts.data[].name` = every managed
     *  Page's name). The first path that yields a name wins. Default `["name"]`. */
    displayNameFields?: string[]
    /** Endpoint that renews the access token. Default: `tokenUrl` (standard
     *  refresh_token grant). Instagram long-lived tokens renew at their OWN URL
     *  `https://graph.instagram.com/refresh_access_token`. */
    refreshTokenUrl?: string
    /** RFC 7009 token revocation endpoint (Google: `https://oauth2.googleapis.com/revoke`).
     *  Disconnecting the connection, or erasing its owner, POSTs the stored refresh
     *  token (else the access token) there before deleting it, unless another active
     *  connection of the org holds the same account at the same endpoint (one grant).
     *  Best effort: a failure is logged and never blocks the disconnect. */
    revocationUrl?: string
    /**
     * Ends a push watch at the provider when the connection goes (POST with its bearer
     * token, before the revocation): Gmail's users.stop. Kept while another active
     * connection on this instance declares the same endpoint for the same account.
     */
    watchStopUrl?: string
    /**
     * The same provider account may hold an ORGANIZATION connection and a
     * member's PERSONAL connection at once, as two separate rows (own tokens,
     * own metadata), because the app gives the two owners disjoint data: Drive's
     * org row reads only the Shared Drives an admin chose, the personal row that
     * person's own Drive (google-drive/drive-scope.ts). Default (absent) keeps
     * one owner per account: a personal connect over an org-held account is
     * refused, an org connect takes the account over. Leave it off where two
     * owners of one account would double-ingest or leak (a mailbox, a calendar,
     * a ticket inbox: both rows would sync the same messages, and the personal
     * row would expose the shared inbox's mail as one member's).
     */
    orgAndPersonalCoexist?: boolean
    /** Export name of the app handler the kernel runs BEFORE a disconnect (and before an
     *  org purge deletes the row), while the connection is still active and its token
     *  valid: the app removes what it registered at the provider with that token (Shopify
     *  webhook subscriptions). Best effort (connections/before-disconnect.ts). */
    beforeDisconnect?: string
    /** grant_type for the refresh. Default "refresh_token". Instagram long-lived
     *  self-refresh uses "ig_refresh_token". */
    refreshGrantType?: string
    /** When true, renew by presenting the CURRENT access token itself (GET
     *  `<refreshTokenUrl>?grant_type=<refreshGrantType>&access_token=<current>`),
     *  not a stored refresh_token + client secret. This is how Instagram
     *  Business Login long-lived tokens (which have NO refresh_token) self-renew
     *  into a fresh 60-day token. Default false (standard refresh_token flow). */
    refreshUsesAccessToken?: boolean
    /** How far BEFORE expiry to proactively refresh, in ms. Default ~2 min (only
     *  refresh a token that is basically expired). Long-lived tokens (Instagram,
     *  60 days) set a WIDE window (e.g. 10 days) so any routine sync in the tail
     *  window renews it -- and a failed early refresh falls back to the still-valid
     *  stored token instead of erroring. */
    refreshWindowMs?: number
  }
>()

/**
 * The sandboxed handler a connection's `beforeDisconnect` names, keyed by
 * [orgId, appName, connectionName]: the bundle it lives in, for
 * connections/before-disconnect.ts.
 */
export const connectionBeforeDisconnectRegistry = createTypedRegistry<
  [orgId: string, appName: string, connectionName: string],
  ManifestHandlerRef
>()

/**
 * Stores app-owned OAuth client resolvers keyed by [orgId, appName, connectionName].
 * Built-in apps can use this to provide deployment-scoped credentials without an
 * org-owned kernel.oauth_providers row.
 */
export const oauthClientResolverRegistry = createTypedRegistry<
  [orgId: string, appName: string, connectionName: string],
  OAuthClientResolver
>()

/**
 * Canonical accessor: list every app installed for `orgId` from the LIVE
 * `manifestRegistry`. This is the single rule established by T1 — kernel code
 * that needs to enumerate apps reads the live registry, never a static import
 * list and never a hardcoded manifest array. Mirrors the dynamic pattern the
 * export path already uses (`exportRegistry.entries()` filtered by orgId).
 *
 * Returns `{ appName, manifest }` so both name-only callers (e.g. setup
 * completeness enumeration) and manifest-consuming callers (scope catalog,
 * saved-view seeding, reference-label resolution) share one source of truth.
 * The `kernel` pseudo-app is included when registered — callers that must skip
 * it filter on `appName === "kernel"` themselves (see `apps/routes.ts`).
 */
export function listInstalledApps(
  orgId: string,
): Array<{ appName: string; manifest: ReturnType<typeof manifestRegistry.get> }> {
  const out: Array<{ appName: string; manifest: ReturnType<typeof manifestRegistry.get> }> = []
  for (const [[, appName], manifest] of manifestRegistry.entriesOf(orgId)) {
    out.push({ appName, manifest })
  }
  return out
}

/** Canonical accessor: the names of every app installed for `orgId`, from the
 *  live registry. Convenience wrapper over `listInstalledApps` for callers that
 *  only need the name set. */
export function listInstalledAppNames(orgId: string): string[] {
  return listInstalledApps(orgId).map((a) => a.appName)
}

/**
 * Resolve the full {@link BridgeManifest} (carrying the `schema` with erasure
 * declarations) for an installed app in `orgId`. The frontend-facing
 * {@link manifestRegistry} strips the schema, so compliance paths read it from
 * the snapshot the runtime attaches to every tool / webhook registry entry at
 * registration time. Returns `undefined` when no entry for `(orgId, appName)`
 * carries a manifest snapshot — the GDPR cascade treats that as a hard failure
 * (it cannot prove the app's PII columns are covered), never a silent skip.
 */
export function appBridgeManifest(orgId: string, appName: string): BridgeManifest | undefined {
  const direct = appBridgeManifestRegistry.get([orgId, appName])
  if (direct) return direct
  // Fallback for apps registered before the dedicated registry was populated
  // (defensive): the snapshot is also attached to tool/webhook entries.
  for (const [[, regApp], entry] of toolRegistry.entriesOf(orgId)) {
    if (regApp === appName && entry._manifest) return entry._manifest
  }
  for (const [[, regApp], entry] of webhookHandlers.entriesOf(orgId)) {
    if (regApp === appName && entry._manifest) return entry._manifest
  }
  return undefined
}

/** Reset all in-process app registries and registration tracking — for test isolation only */
export function resetAppRegistries(): void {
  resetRegistrationTemplates()
  toolRegistry.clear()
  agentInstructionsRegistry.clear()
  appPromptRegistry.clear()
  webhookHandlers.clear()
  viewRegistry.clear()
  slotRegistry.clear()
  timelineDeclarations.clear()
  dimensionDefRegistry.clear()
  entityRegistry.clear()
  manifestFileParentRegistry.clear()
  routineFlowRecordRegistry.clear()
  tableBackingRegistry.clear()
  manifestAttentionRegistry.clear()
  manifestAttentionAxesRegistry.clear()
  exportRegistry.clear()
  importRegistry.clear()
  skillRegistry.clear()
  approvalSummarizerRegistry.clear()
  approvalEditableFieldsRegistry.clear()
  approvalExpiryRegistry.clear()
  approvalDedupeKeyRegistry.clear()
  approvalDedupeSameRequesterRegistry.clear()
  manifestRegistry.clear()
  appBridgeManifestRegistry.clear()
  connectionConfigRegistry.clear()
  connectionBeforeDisconnectRegistry.clear()
  oauthClientResolverRegistry.clear()
  appDependenciesRegistry.clear()
  appCrossAppCallsRegistry.clear()
  appContractImplementationsRegistry.clear()
  appContractCallsRegistry.clear()
  appSettingsRegistry.clear()
  attentionItemsRegistry.clear()
  registeredApps.clear()
  registeredAppVersions.clear()
  initializedOrgRuntimes.clear()
  orgRuntimeInitPromises.clear()
  declaredEmits.clear()
  appCapabilitiesRegistry.clear()
  appStoreDeclarationsRegistry.clear()
  // The registrations' event subscriptions go with them. Clearing only their disposers left
  // the handlers on the bus: the org's next registration stacked another set, and every
  // event then ran each app handler once per earlier reset. A disposer drops its handler
  // before its first await, so the bus holds none of them when this returns.
  for (const [, disposers] of eventSubscriptionDisposers.entries()) {
    for (const dispose of disposers) void dispose().catch(() => {})
  }
  eventSubscriptionDisposers.clear()
  // The apps an org registers are cached per catalog generation (init.ts
  // `getDefaultApps`). A test that resets the registries has usually also
  // changed what that cache was built from (app rows deleted, install root
  // swapped) without going through the install path that bumps it, so the
  // next org would register the previous test's apps.
  bumpCatalogGeneration()
}

/**
 * What an app declares in its manifest's `knowledgeItems`: the export Knowledge's
 * federated search wakes, the export that resolves one item by reference (a
 * source link), the scope a person must hold for Knowledge to reach the app's
 * items for them, and whether federated search includes the app by default.
 */
export interface KnowledgeItemsDecl {
  search?: string
  resolve?: string
  readScope?: string
  searchByDefault: boolean
  timeoutMs?: number
}

/**
 * The `knowledgeItems` an app declares, keyed by `[orgId, appName]`, with the
 * function that wakes one of its exports in the app's sandbox (built at
 * registration, like the external search handler). `userId` is the person
 * Knowledge acts for: the run reaches the provider through their account.
 */
export const knowledgeItemsRegistry = createTypedRegistry<
  [orgId: string, appName: string],
  {
    decl: KnowledgeItemsDecl
    dispatch: (
      entry: "search" | "resolve",
      input: Record<string, unknown>,
      tenant: { orgId: string; userId: string },
    ) => Promise<unknown>
  }
>()
