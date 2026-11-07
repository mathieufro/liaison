// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A tool result's card, after the resolver (modules/apps/result-card.ts): the fields a tool call
// carries live and on its row, and the only writes that change a stored card.
//
// The card is resolved once, when the call returns, from the result its reader is allowed to
// hold (mail redaction first), and stored beside the call. A reload reads the stored card and
// never rebuilds it, because a stored result may be clipped. Nothing here feeds the model: the
// history and the checkpoint name each field of a stored call they replay, and these are not
// among them.
import type { CardLabel, CardTemplate, ResolvedCard, ResolvedCardAction } from "@liaison/shared"
import { and, asc, desc, eq, isNull, lte, sql } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type ActorContext, withRlsContext } from "~/db/rls"
import { messages } from "~/db/schema/kernel"
import { isTestEnv } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { UUID_RE } from "~/lib/uuid"
import { redactMailToolResult } from "~/modules/agent/mailbox-plaintext/mail-plaintext-redaction"
import { uncappedToolResult } from "~/modules/agent/runtime/result-truncation"
import { projectTaintScopesForOrg } from "~/modules/agent/scopes/taint-read-scopes"
import { isParkedForApproval } from "~/modules/agent/tools/tool-bridge"
import { toolFailureModelOutput } from "~/modules/agent/tools/tool-failure-output"
import { manifestRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { resolveToolCard } from "~/modules/apps/result-card"
import { hasScope } from "~/modules/permissions/permissions"
import { messageVisibilityFacts } from "~/services/security/visibility"

const log = rootLogger.child({ module: "tool-card-store" })

/** What a `tool_call` event and its stored row say about the tool, from the registry. */
export interface ToolCallPresentation {
  readOnly?: boolean
  appLabel?: string
  runningLabel?: string
  runningLabelKey?: string
}

/** What a `tool_result` event and its stored row carry beside the result. */
export interface ToolCardFields {
  card?: ResolvedCard
  /** A failed call of a tool that declares a card: the client draws `result.error` under this pill. */
  cardError?: { pill: CardLabel }
}

/** A tool call as `metadata.toolCalls[]` stores it, as far as this file reads it. */
export interface StoredToolCall extends ToolCardFields, ToolCallPresentation {
  toolCallId: string
  toolName: string
  result?: unknown
  /** Absent means 1: the card as the turn stored it. Each replace adds one. */
  cardRevision?: number
  /** A newer card with the same `latestKey` lives in this thread. */
  cardSuperseded?: true
}

/** Sent back with a card action: the stored card it came from. */
export interface ToolCardRef {
  messageId: string
  toolCallId: string
  /** The revision the client holds. Absent: the action runs whatever the card shows now. */
  revision?: number
}

/** The resolver, swappable in tests only: it never throws by itself. */
let resolveCard: typeof resolveToolCard = resolveToolCard

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** The app of a stored tool name (`app__tool`), or null for a tool of no app. */
export function appOfStoredToolName(toolName: string): string | null {
  const sep = toolName.indexOf("__")
  return sep > 0 ? toolName.slice(0, sep) : null
}

function sanitizedToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_")
}

/** The registered tool a stream names, or undefined (a chat tool, a node session's own step). */
function registeredTool(orgId: string, sdkName: string) {
  const app = appOfStoredToolName(sdkName)
  if (!app) return undefined
  const name = sdkName.slice(app.length + 2)
  try {
    const direct = toolRegistry.get([orgId, app, name])
    if (direct) return direct
    for (const [key, entry] of toolRegistry.entriesOf(orgId)) {
      if (key[1] === app && sanitizedToolName(key[2]) === name) return entry
    }
  } catch (err) {
    log.warn({ err, orgId, toolName: sdkName }, "Tool card: the tool could not be looked up")
  }
  return undefined
}

function templateOf(orgId: string, sdkName: string): CardTemplate | undefined {
  return registeredTool(orgId, sdkName)?.resultCard as CardTemplate | undefined
}

function appDisplayLabel(orgId: string, app: string): string | undefined {
  try {
    const manifest = manifestRegistry.get([orgId, app]) as
      | { displayName?: unknown; views?: { activityBar?: { label?: unknown } } }
      | undefined
    const label = manifest?.displayName ?? manifest?.views?.activityBar?.label
    return typeof label === "string" && label ? label : undefined
  } catch {
    return undefined
  }
}

/** The registry's facts on a tool, for the row that shows it. Empty for a tool of no app. */
export function toolCallPresentation(orgId: string, sdkName: string): ToolCallPresentation {
  const tool = registeredTool(orgId, sdkName)
  if (!tool) return {}
  const appLabel = appDisplayLabel(orgId, tool.appName)
  return {
    readOnly: tool.readOnly === true,
    ...(appLabel ? { appLabel } : {}),
    ...(tool.runningLabel ? { runningLabel: tool.runningLabel } : {}),
    ...(tool.runningLabelKey ? { runningLabelKey: tool.runningLabelKey } : {}),
  }
}

function resolvedOrNull(template: CardTemplate, source: unknown, toolName: string) {
  try {
    const card = resolveCard(template, source)
    if (!card) {
      log.warn({ toolName, kind: template.kind }, "Tool card did not fit the result: ordinary row")
    }
    return card
  } catch (err) {
    log.warn({ err, toolName }, "Tool card resolver threw: ordinary row")
    return null
  }
}

const isFailedResult = (result: unknown): boolean => toolFailureModelOutput(result) !== null

/**
 * The card fields of a returned call. `redacted` is the result as the row stores it. `output` is
 * what the stream handed over: when the model's cap clipped it, the card reads the uncut result,
 * redacted the same way, because the cap is there for the model and the card has its own bound.
 * Never throws: a card never breaks a turn.
 */
export async function toolCardFieldsForResult(
  orgId: string,
  toolName: string,
  redacted: unknown,
  output: unknown = redacted,
): Promise<ToolCardFields> {
  try {
    const template = templateOf(orgId, toolName)
    if (!template) return {}
    if (isParkedForApproval(redacted)) return {}
    if (isFailedResult(redacted)) return { cardError: { pill: template.pill } }
    const uncut = uncappedToolResult(output)
    const source = uncut === output ? redacted : await redactMailToolResult(orgId, toolName, uncut)
    const card = resolvedOrNull(template, source, toolName)
    return card ? { card } : {}
  } catch (err) {
    log.warn({ err, orgId, toolName }, "Tool card could not be built: ordinary row")
    return {}
  }
}

/** The card fields of a call that produced no result at all. */
export function toolCardFieldsForError(orgId: string, toolName: string): ToolCardFields {
  const template = templateOf(orgId, toolName)
  return template ? { cardError: { pill: template.pill } } : {}
}

/**
 * The steps a resumed turn read back from its journal, with what the journal does not keep. The
 * card is resolved again from the journaled result, so a result the model's cap cut to
 * `truncatedResult` in an earlier attempt draws the ordinary row on that one path.
 */
export async function withToolCardFieldsOnSteps<
  V extends {
    toolCalls: Array<{ toolCallId: string; toolName: string }>
    toolResults: Array<{ toolCallId: string; result: unknown }>
  },
>(orgId: string, views: readonly V[]): Promise<V[]> {
  return Promise.all(
    views.map(async (view) => ({
      ...view,
      toolCalls: view.toolCalls.map((tc) => ({
        ...tc,
        ...toolCallPresentation(orgId, tc.toolName),
      })),
      toolResults: await Promise.all(
        view.toolResults.map(async (r) => {
          const name = view.toolCalls.find((tc) => tc.toolCallId === r.toolCallId)?.toolName ?? ""
          return { ...r, ...(await toolCardFieldsForResult(orgId, name, r.result)) }
        }),
      ),
    })),
  )
}

/** Of a turn's own cards sharing a key, only the last stays live. */
export function markSupersededWithinTurn<T extends StoredToolCall>(calls: T[]): T[] {
  const newest = new Map<string, string>()
  for (const tc of calls) {
    if (tc.card?.latestKey) newest.set(keyOf(tc, tc.card.latestKey), tc.toolCallId)
  }
  return calls.map((tc) =>
    tc.card?.latestKey && newest.get(keyOf(tc, tc.card.latestKey)) !== tc.toolCallId
      ? { ...tc, cardSuperseded: true as const }
      : tc,
  )
}

/** A key belongs to its app: one app's key never touches another app's card. */
function keyOf(tc: { toolName: string }, key: string): string {
  return `${appOfStoredToolName(tc.toolName) ?? ""}\u0000${key}`
}

function storedCalls(metadata: unknown): StoredToolCall[] {
  const calls = (metadata as { toolCalls?: unknown } | null)?.toolCalls
  return Array.isArray(calls) ? (calls as StoredToolCall[]) : []
}

export const storedCardRevision = (tc: StoredToolCall): number => tc.cardRevision ?? 1

/** The `latestKey` filter on a thread's rows: an index-free jsonb test, on the rare card that has one. */
function holdsKey(key: string) {
  const shape = JSON.stringify([{ card: { latestKey: key } }])
  return sql`${messages.metadata} -> 'toolCalls' @> ${shape}::text::jsonb`
}

const ROW_FACTS = {
  id: messages.id,
  threadId: messages.threadId,
  createdAt: messages.createdAt,
  metadata: messages.metadata,
  requiredScopes: messages.requiredScopes,
  disclosureList: messages.disclosureList,
  replyRootId: messages.replyRootId,
  alsoInChannel: messages.alsoInChannel,
}

type LockedRow = {
  id: string
  threadId: string
  metadata: unknown
  requiredScopes: unknown
  disclosureList: unknown
  replyRootId: string | null
  alsoInChannel: boolean | null
}

/**
 * Write a row's tool calls, and tell whoever may read the row. The frame carries the calls and
 * nothing else of the metadata, as the row's first live copy does: other keys are not for readers.
 */
async function writeToolCalls(
  tx: PrivilegedDb,
  orgId: string,
  actorId: string,
  row: LockedRow,
  toolCalls: StoredToolCall[],
): Promise<void> {
  const metadata = { ...(row.metadata as Record<string, unknown>), toolCalls }
  await tx
    .update(messages)
    .set({ metadata })
    .where(and(eq(messages.id, row.id), eq(messages.orgId, orgId)))
  await tx.queueEvent({
    app: "kernel",
    entity: "message",
    action: "update",
    entityId: row.id,
    orgId,
    actorId,
    data: {
      id: row.id,
      threadId: row.threadId,
      toolCalls,
      replyRootId: row.replyRootId ?? null,
      alsoInChannel: row.alsoInChannel === true,
      ...messageVisibilityFacts(row),
    },
  })
}

/** Mark the older cards of a key superseded, on rows at or before `upTo`, except the newest's own. */
async function supersedeOlder(
  tx: PrivilegedDb,
  params: {
    orgId: string
    actorId: string
    threadId: string
    app: string
    key: string
    newest: { messageId: string; upTo: Date }
  },
): Promise<void> {
  const { orgId, threadId, app, key, newest } = params
  const rows = await tx
    .select(ROW_FACTS)
    .from(messages)
    .where(
      and(
        eq(messages.threadId, threadId),
        eq(messages.orgId, orgId),
        lte(messages.createdAt, newest.upTo),
        holdsKey(key),
      ),
    )
    .orderBy(asc(messages.id))
    .for("update")
  for (const row of rows) {
    if (row.id === newest.messageId) continue
    let changed = false
    const next = storedCalls(row.metadata).map((tc) => {
      if (tc.card?.latestKey !== key || appOfStoredToolName(tc.toolName) !== app) return tc
      if (tc.cardSuperseded) return tc
      changed = true
      return { ...tc, cardSuperseded: true as const }
    })
    if (changed) await writeToolCalls(tx, orgId, params.actorId, row, next)
  }
}

/**
 * A reply was just stored: its cards with a `latestKey` supersede the older cards of that key in
 * the thread. A failure here leaves an older card live, never a broken turn.
 */
export async function supersedeOlderToolCards(params: {
  orgId: string
  actorId: string
  threadId: string
  messageId: string
  createdAt: Date
  toolCalls: readonly StoredToolCall[]
}): Promise<void> {
  const keyed = params.toolCalls.filter((tc) => tc.card?.latestKey && !tc.cardSuperseded)
  if (keyed.length === 0) return
  try {
    await withPrivilegedDb(params.orgId, "tool-card-supersede", async (tx) => {
      for (const tc of keyed) {
        await supersedeOlder(tx, {
          orgId: params.orgId,
          actorId: params.actorId,
          threadId: params.threadId,
          app: appOfStoredToolName(tc.toolName) ?? "",
          key: tc.card?.latestKey as string,
          newest: { messageId: params.messageId, upTo: params.createdAt },
        })
      }
    })
  } catch (err) {
    log.warn({ err, threadId: params.threadId }, "Could not supersede older tool cards")
  }
}

/**
 * Remove the cards of a key from a thread, with the stored results of those calls, for an app
 * whose own retention requires it. The call stays, so its ordinary row still draws. Answers how
 * many calls lost their card.
 */
export async function clearToolCardsByKey(params: {
  orgId: string
  actorId: string
  threadId: string
  app: string
  key: string
}): Promise<number> {
  const { orgId, threadId, app, key } = params
  return withPrivilegedDb(orgId, "tool-card-clear", async (tx) => {
    const rows = await tx
      .select(ROW_FACTS)
      .from(messages)
      .where(and(eq(messages.threadId, threadId), eq(messages.orgId, orgId), holdsKey(key)))
      .orderBy(asc(messages.id))
      .for("update")
    let cleared = 0
    for (const row of rows) {
      let changed = false
      const next = storedCalls(row.metadata).map((tc): StoredToolCall => {
        if (tc.card?.latestKey !== key || appOfStoredToolName(tc.toolName) !== app) return tc
        changed = true
        cleared++
        const { card: _card, cardRevision: _rev, cardSuperseded: _old, ...kept } = tc
        return { ...kept, result: null }
      })
      if (changed) await writeToolCalls(tx, orgId, params.actorId, row, next)
    }
    return cleared
  })
}

/** A request's `cardRef`: absent, well formed, or refused before anything runs. */
export function parseToolCardRef(raw: unknown): ToolCardRef | null | "invalid" {
  if (raw === undefined || raw === null) return null
  if (!isRecord(raw)) return "invalid"
  const { messageId, toolCallId, revision } = raw
  if (typeof messageId !== "string" || !UUID_RE.test(messageId)) return "invalid"
  if (typeof toolCallId !== "string" || !toolCallId) return "invalid"
  if (revision !== undefined && (!Number.isInteger(revision) || (revision as number) < 1)) {
    return "invalid"
  }
  return {
    messageId,
    toolCallId,
    ...(revision !== undefined ? { revision: revision as number } : {}),
  }
}

export type OpenedToolCardRef =
  | { ok: true; ref: ToolCardRef; threadId: string; requiredScopes: readonly string[] }
  | { ok: false; refusal: "not_readable" }
  | { ok: false; refusal: "other_app" }
  | { ok: false; refusal: "not_an_action" }
  | { ok: false; refusal: "changed"; card: ResolvedCard | null; cardRevision: number | null }

/** The call a request makes from a card: the tool of the card's app and the params it sends. */
export interface ToolCardRequest {
  toolName: string
  params: unknown
}

function sameValue(a: unknown, b: string | number): boolean {
  return a === b
}

/** The request sends exactly the params the action was drawn with, nothing more. */
function matchesAction(
  action: ResolvedCardAction,
  request: ToolCardRequest,
  params: Record<string, unknown>,
): boolean {
  if (action.kind !== "tool" || action.tool !== request.toolName) return false
  const keys = Object.keys(params)
  const declared = Object.keys(action.params)
  if (keys.length !== declared.length) return false
  return declared.every((k) => Object.hasOwn(params, k) && sameValue(params[k], action.params[k]))
}

/**
 * An edit sends the ids the card was drawn with, the row it edits (one the card offers an edit
 * on), and exactly one of its fields.
 */
function matchesEdit(
  card: ResolvedCard,
  request: ToolCardRequest,
  params: Record<string, unknown>,
): boolean {
  const edit = card.edit
  if (!edit || edit.tool !== request.toolName) return false
  for (const [k, v] of Object.entries(edit.params)) {
    if (!Object.hasOwn(params, k) || !sameValue(params[k], v)) return false
  }
  const row = params[edit.rowParam]
  if (typeof row !== "string" && typeof row !== "number") return false
  const editable = (card.groups ?? []).some((g) =>
    g.rows.some((r) => r.edit !== undefined && r.id === String(row)),
  )
  if (!editable) return false
  const fields = new Set(edit.fields.map((f) => f.param))
  const rest = Object.keys(params).filter(
    (k) => !Object.hasOwn(edit.params, k) && k !== edit.rowParam,
  )
  return rest.length === 1 && fields.has(rest[0] as string)
}

/**
 * Is this request one of the things the stored card offers: one of its tool actions (top, summary
 * or a row's) with the params it was drawn with, or its edit? A reader of the row may click what
 * the card shows; anything else would rewrite someone's card with a call it never offered.
 */
export function cardOffersRequest(card: ResolvedCard, request: ToolCardRequest): boolean {
  if (!isRecord(request.params)) return false
  const params = request.params
  const offered: ResolvedCardAction[] = [
    ...(card.actions ?? []),
    ...(card.summary?.actions ?? []),
    ...(card.groups ?? []).flatMap((g) => g.rows.flatMap((r) => (r.act ? [r.act] : []))),
  ]
  return (
    offered.some((a) => matchesAction(a, request, params)) || matchesEdit(card, request, params)
  )
}

/** How long a card action holds its card: past it, a stuck holder no longer blocks the card. */
const CARD_CLAIM_TTL_SECONDS = 120
const cardClaimKey = (ref: ToolCardRef) => `tool-card-claim:${ref.messageId}:${ref.toolCallId}`

/**
 * Hold the card for one action, from its revision check to its store, so two clicks on the same
 * revision cannot both run: the token when taken, null while another action holds it.
 */
export async function claimToolCard(ref: ToolCardRef): Promise<string | null> {
  const token = crypto.randomUUID()
  const got = await redis.set(cardClaimKey(ref), token, "EX", CARD_CLAIM_TTL_SECONDS, "NX")
  return got === "OK" ? token : null
}

/** Give the card back, only while this token still holds it. */
export async function releaseToolCard(ref: ToolCardRef, token: string): Promise<void> {
  const releaseLua = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `
  try {
    await redis.eval(releaseLua, 1, cardClaimKey(ref), token)
  } catch (err) {
    log.warn({ err, messageId: ref.messageId }, "card claim not released; it expires")
  }
}

/**
 * The newest live card of a key in a thread, as this reader may read it. Read under the caller's
 * own context, so a card on a row they may not read never comes back.
 */
async function latestLiveCard(
  actor: ActorContext,
  orgId: string,
  threadId: string,
  app: string,
  key: string,
): Promise<{ card: ResolvedCard; cardRevision: number } | null> {
  const rows = await withRlsContext(actor, (tx) =>
    tx
      .select({ metadata: messages.metadata })
      .from(messages)
      .where(
        and(
          eq(messages.threadId, threadId),
          eq(messages.orgId, orgId),
          isNull(messages.deletedAt),
          holdsKey(key),
        ),
      )
      .orderBy(desc(messages.createdAt)),
  )
  for (const row of rows) {
    for (const tc of storedCalls(row.metadata)) {
      if (
        tc.card &&
        tc.card.latestKey === key &&
        !tc.cardSuperseded &&
        appOfStoredToolName(tc.toolName) === app
      ) {
        return { card: tc.card, cardRevision: storedCardRevision(tc) }
      }
    }
  }
  return null
}

/**
 * Check a `cardRef` before its tool runs, under the caller's own context: a thread they cannot
 * read is not there for them, and a call the stored card does not offer is refused. Nothing has
 * run and nothing has changed on any refusal.
 */
export async function openToolCardRef(
  actor: ActorContext,
  orgId: string,
  appName: string,
  ref: ToolCardRef,
  request: ToolCardRequest,
): Promise<OpenedToolCardRef> {
  return openStoredCard(actor, orgId, appName, ref, request)
}

async function openStoredCard(
  actor: ActorContext,
  orgId: string,
  appName: string,
  ref: ToolCardRef,
  request: ToolCardRequest | null,
): Promise<OpenedToolCardRef> {
  const [row] = await withRlsContext(actor, (tx) =>
    tx
      .select({
        threadId: messages.threadId,
        metadata: messages.metadata,
        requiredScopes: messages.requiredScopes,
      })
      .from(messages)
      .where(
        and(eq(messages.id, ref.messageId), eq(messages.orgId, orgId), isNull(messages.deletedAt)),
      )
      .limit(1),
  )
  if (!row) return { ok: false, refusal: "not_readable" }
  const stored = storedCalls(row.metadata).find((tc) => tc.toolCallId === ref.toolCallId)
  if (!stored) return { ok: false, refusal: "not_readable" }
  if (appOfStoredToolName(stored.toolName) !== appName) return { ok: false, refusal: "other_app" }
  // A card an app cleared, or a call that never had one: nothing to act from or replace.
  if (!stored.card && !stored.cardError) {
    return { ok: false, refusal: "changed", card: null, cardRevision: null }
  }
  if (stored.cardSuperseded) {
    const key = stored.card?.latestKey
    const latest = key ? await latestLiveCard(actor, orgId, row.threadId, appName, key) : null
    return {
      ok: false,
      refusal: "changed",
      card: latest?.card ?? null,
      cardRevision: latest?.cardRevision ?? null,
    }
  }
  if (ref.revision !== undefined && ref.revision !== storedCardRevision(stored)) {
    return {
      ok: false,
      refusal: "changed",
      card: stored.card ?? null,
      cardRevision: storedCardRevision(stored),
    }
  }
  if (request && !(stored.card && cardOffersRequest(stored.card, request))) {
    return { ok: false, refusal: "not_an_action" }
  }
  return {
    ok: true,
    ref,
    threadId: row.threadId,
    requiredScopes: Array.isArray(row.requiredScopes) ? (row.requiredScopes as string[]) : [],
  }
}

/** The stored card a tool's own `card_changed` refusal answers with. */
export async function currentToolCard(
  actor: ActorContext,
  orgId: string,
  appName: string,
  ref: ToolCardRef,
): Promise<OpenedToolCardRef> {
  return openStoredCard(actor, orgId, appName, { ...ref, revision: 0 }, null)
}

export interface ReplacedToolCard {
  /** The card to draw. Null: the stored call has none. */
  card: ResolvedCard | null
  cardRevision: number | null
  /** False: the stored card did not change, and `why` says what the reader should know. */
  stored: boolean
  why?: "no_template" | "did_not_fit" | "failed_result" | "wider_than_message" | "gone"
}

/**
 * Whether everyone who may read the row may read what this tool returns. The row's stamp holds
 * what its turn read, and a person's click can reach further than the turn did.
 */
function messageStampCovers(
  orgId: string,
  requiredScopes: readonly string[],
  toolScopes: readonly string[],
): boolean {
  const granted = [...requiredScopes]
  return projectTaintScopesForOrg(toolScopes, orgId).every((scope) => hasScope(scope, granted))
}

/**
 * Overwrite a stored card from the result of the tool a card action just ran, and only the card:
 * the stored result stays as the model saw it, so the history replays byte for byte.
 *
 * The caller checked the revision before the tool ran, while holding the card's claim
 * (`claimToolCard`), so no other card action stored in between. It is not checked again here: by
 * now the effect has happened, so refusing would report a write as not saved. A message deleted
 * since is not written.
 */
export async function replaceToolCard(
  ref: ToolCardRef,
  params: {
    orgId: string
    actorId: string
    appName: string
    toolName: string
    result: unknown
  },
): Promise<ReplacedToolCard> {
  const { orgId, actorId, appName, toolName } = params
  const tool = (() => {
    try {
      return toolRegistry.get([orgId, appName, toolName])
    } catch {
      return undefined
    }
  })()
  const template = tool?.resultCard as CardTemplate | undefined
  const sdkName = `${appName}__${sanitizedToolName(toolName)}`
  const redacted = await redactMailToolResult(orgId, sdkName, params.result)
  const failed = isFailedResult(redacted)
  const fresh = template && !failed ? resolvedOrNull(template, redacted, sdkName) : null

  return withPrivilegedDb(orgId, "tool-card-replace", async (tx) => {
    const [row] = await tx
      .select(ROW_FACTS)
      .from(messages)
      .where(
        and(eq(messages.id, ref.messageId), eq(messages.orgId, orgId), isNull(messages.deletedAt)),
      )
      .limit(1)
      .for("update")
    const calls = storedCalls(row?.metadata)
    const index = calls.findIndex((tc) => tc.toolCallId === ref.toolCallId)
    const stored = calls[index]
    if (!row || !stored) return { card: null, cardRevision: null, stored: false, why: "gone" }
    const keep = (why: ReplacedToolCard["why"]): ReplacedToolCard => ({
      card: stored.card ?? null,
      cardRevision: stored.card ? storedCardRevision(stored) : null,
      stored: false,
      why,
    })
    if (!template) return keep("no_template")
    if (failed) return keep("failed_result")
    if (!fresh) return keep("did_not_fit")
    const stamp = Array.isArray(row.requiredScopes) ? (row.requiredScopes as string[]) : null
    if (!stamp || !messageStampCovers(orgId, stamp, tool?.requiredScopes ?? [])) {
      // The clicker sees their own answer; the row other people read stays as it was.
      return {
        card: fresh,
        cardRevision: stored.card ? storedCardRevision(stored) : null,
        stored: false,
        why: "wider_than_message",
      }
    }
    const cardRevision = storedCardRevision(stored) + 1
    const { cardError: _cleared, ...rest } = stored
    const next = [...calls]
    next[index] = { ...rest, card: fresh, cardRevision }
    await writeToolCalls(tx, orgId, actorId, row, next)
    if (fresh.latestKey) {
      await supersedeOlder(tx, {
        orgId,
        actorId,
        threadId: row.threadId,
        app: appName,
        key: fresh.latestKey,
        newest: { messageId: row.id, upTo: row.createdAt },
      })
    }
    return { card: fresh, cardRevision, stored: true }
  })
}

/** Test access: production code never calls it. */
export const ToolCardStoreTestAccess = {
  /** Swap the resolver for one that fails; pass nothing to restore. */
  setResolver(fn?: typeof resolveToolCard): void {
    if (!isTestEnv()) throw new Error("ToolCardStoreTestAccess is only available in tests")
    resolveCard = fn ?? resolveToolCard
  },
}
