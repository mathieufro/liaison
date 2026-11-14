// SPDX-License-Identifier: FSL-1.1-ALv2
import { agentSpeakerName, maskWithNote, PERSONAL_AGENT_DISPLAY_NAME } from "@liaison/shared"
import { and, sql as drizzleSql, eq, inArray, isNull } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import { HTTPException } from "hono/http-exception"
import type { RlsClient } from "~/db"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import {
  agentRuns,
  agents,
  messageReactions,
  messages,
  replyThreadFollowers,
  threadParticipants,
  threads,
  users,
} from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"
import { messagePreview, parseMentions } from "~/lib/mentions"
import { captureActingAgentId, currentRunContext } from "~/modules/agent/runtime/run-context"
import { expandWildcardStamp } from "~/modules/agent/scopes/taint-read-scopes"
import { projectMessageMetadataForViewer } from "~/modules/agent/scopes/withheld-capability"
import { applyScopeCeiling } from "~/modules/auth/session-ceiling"
import { deleteMessageAttachments } from "~/modules/files/message-attachments"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { deleteMessageAndWindowDocuments } from "~/modules/search/message-indexer"
import { seatMentionedMembers } from "~/modules/threads/participant"
import { threadAnchorIds } from "~/modules/threads/thread-anchor"
import { assertDisclosureUserIds } from "~/services/security/disclosure-list"
import {
  countHiddenRuns,
  type IdentifiedVisibilityMessage,
  isMessageVisible,
  messageVisibilityFacts,
  viewerHoldsEveryScope,
} from "~/services/security/visibility"

const K = () => drizzleSql.raw(schemaRef("kernel"))

const log = rootLogger.child({ module: "threads-message" })

/** The owner of a message's authoring agent, joined beside the message author. */
const agentOwners = alias(users, "agent_owner")

interface SendMessageParams {
  orgId: string
  userId: string
  threadId: string
  content: string
  authorType?: "user" | "agent" | "system"
  /**
   * Display label for an agent-authored message — "{User}'s agent" or
   * "Routine {name}". Required in practice whenever `authorType === "agent"`;
   * persisted into `metadata.agentAuthorLabel` and surfaced as `authorName`.
   * Agent posts are attributed, never impersonated as the human.
   */
  agentAuthorLabel?: string
  correlationId?: string
  /**
   * A post nobody in the conversation asked for: a routine's run speaking in
   * the conversation it posts to. An agent row's actor is the human whose turn
   * it is, and the actor is never told about their own message, which is right
   * for a reply they are watching arrive and wrong for a routine's summary:
   * nobody is watching. Carried on the event (`data.unprompted`), so the
   * attention translations keep the actor among the readers and the dock pops
   * the conversation. The actor itself stays the human (audit, A11).
   */
  unprompted?: boolean
  /**
   * The row is the END of an agent turn or run: its final answer or summary,
   * not a progress line, a question to another agent or a post it made on the
   * way. Carried on the event (`data.endsTurn`): it is the one agent row that
   * notifies the person the turn worked for (push/fanout-consumer.ts), unless
   * they are looking at that very conversation.
   */
  endsTurn?: boolean
  metadata?: unknown
  /**
   * Scopes a viewer must hold to read this message. An agent turn passes the
   * scopes it accumulated; `[]` is a positive assertion that the message
   * carries no scoped data (a human's own message), never a stand-in for a
   * value nobody computed, so the field is required and checked at runtime.
   */
  requiredScopes: string[]
  /**
   * Share anyway: the room members this message was disclosed to, a snapshot
   * taken when the share ran. Real user ids only; absent or null means no
   * disclosure. Written with the row and carried on its create event, so the
   * live fan-out can include the disclosed members.
   */
  disclosureList?: string[] | null
  /**
   * The agent acting in the turn that produced this message, carried on the
   * create event so the audit row names it (A11). A caller running INSIDE the
   * turn's ALS frame may omit it and the frame is read instead; the agent reply
   * persists outside the frame and a sandbox post has already lost it, so both
   * hand it over explicitly. `null` is a positive "no agent acted", never a
   * stand-in for a value nobody resolved.
   */
  agentId?: string | null
  /**
   * The message this one is nested under (P3b). Null, the default, is the
   * audience asymmetry: a turn a human triggered is flattened to the thread
   * root. An agent only turn passes the message that triggered it, so the
   * exchange nests and the dispatch guards can read hop depth, the root turn
   * and the sibling set off one chain.
   */
  parentMessageId?: string | null
  /**
   * The ROOT of the reply thread this message is posted into (0112). Null is a
   * channel message. UNDEFINED inherits: a message nested under a parent that
   * lives in a reply thread lives in that same reply thread, which is how an
   * agent exchange started inside a reply thread (`agents_ask`, a coordinated
   * answer) stays in it without every writer restating the root.
   */
  replyRootId?: string | null
  /** "Also send to channel" (only meaningful with a reply root). */
  alsoInChannel?: boolean
}

interface EditMessageParams {
  orgId: string
  userId: string
  threadId: string
  messageId: string
  content: string
  /** kernel:threads:admin (or '*') — lets an org admin edit ANY message in the
   *  thread, including another user's agent-authored reply. Mirrors the
   *  messages_update RLS admin override (0027_messages_admin_override.sql). */
  isAdmin?: boolean
}

interface DeleteMessageParams {
  orgId: string
  userId: string
  threadId: string
  messageId: string
  /** See EditMessageParams.isAdmin. */
  isAdmin?: boolean
}

/**
 * Which rows a message list reads. The CHANNEL view (the default) is every
 * channel message plus the replies sent with "also send to channel"; the
 * REPLIES view is one root's replies; MESSAGE is one row by id.
 */
export type MessageListView =
  | { kind: "channel" }
  | { kind: "replies"; rootId: string }
  | { kind: "message"; id: string }

interface ListMessagesParams {
  orgId: string
  userId: string
  threadId: string
  limit: number
  before?: string
  after?: string
  view?: MessageListView
}

/**
 * THE CHANNEL PREDICATE, for raw SQL over `kernel.messages` under alias `m`:
 * a row belongs to the channel view unless it is a reply that was not also
 * sent to the channel. Every channel-level reading (the list, its hidden
 * runs, the thread list's preview and unread count, the push badge, the read
 * mark) applies exactly this, so a reply thread never leaks into one of them.
 */
export const CHANNEL_MESSAGE_PREDICATE = "(m.reply_root_id IS NULL OR m.also_in_channel)"

/**
 * A refusal of a reply-thread or quote write that the caller can correct.
 * `status` and `code` are what the error handler answers with.
 */
export class ReplyThreadError extends Error {
  constructor(
    readonly status: 400 | 404,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "ReplyThreadError"
  }
}

/**
 * The visibility a DERIVED message carries (A1, A2): a reply takes its root's,
 * a quote takes the quoted message's. The scope tag is the UNION, so the
 * derived row is never readable by somebody the source hides from; the
 * disclosure list NARROWS (the intersection when both carry one, the source's
 * when only it does), so a disclosure never reaches further than the source's.
 * `sourceReaders`: people who read the source by holding its scopes, not by its list; one of them
 * on the derived row's own list keeps it (it cannot reach further than the source for them), so
 * an approved reply is not hidden from a member who joined after the root's disclosure.
 */
export function inheritVisibility(
  own: { requiredScopes: string[]; disclosureList: string[] | null },
  source: { requiredScopes: string[] | null; disclosureList: string[] | null },
  sourceReaders: ReadonlySet<string> = new Set(),
): { requiredScopes: string[]; disclosureList: string[] | null } {
  const requiredScopes = [...new Set([...own.requiredScopes, ...(source.requiredScopes ?? [])])]
  let disclosureList: string[] | null
  if (own.disclosureList && source.disclosureList) {
    const allowed = new Set(source.disclosureList)
    disclosureList = own.disclosureList.filter((id) => allowed.has(id) || sourceReaders.has(id))
  } else {
    disclosureList = source.disclosureList ?? own.disclosureList
  }
  return { requiredScopes, disclosureList }
}

function normaliseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

/**
 * Resolves a quote under the SENDER's RLS (A1): the quoted message must be a
 * live message of the same thread the sender can read, and the excerpt must be
 * a whitespace-normalised substring of it (a leading or trailing ellipsis from
 * a client-side cut is allowed). The author's name comes from the row, never
 * from the client. Refusals are 400, whatever the reason, so the route is not
 * an oracle on messages the sender cannot see.
 */
export async function resolveQuote(
  db: Pick<RlsClient, "select">,
  params: { orgId: string; threadId: string; messageId: string; excerpt: string },
): Promise<{
  quote: { messageId: string; excerpt: string; authorName: string; replyRootId: string | null }
  requiredScopes: string[]
  disclosureList: string[] | null
}> {
  const [row] = await db
    .select({
      content: messages.content,
      authorType: messages.authorType,
      metadata: messages.metadata,
      replyRootId: messages.replyRootId,
      requiredScopes: messages.requiredScopes,
      disclosureList: messages.disclosureList,
      userName: users.name,
      agentName: agents.displayName,
      agentKind: agents.kind,
      agentOwnerName: agentOwners.name,
    })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.authorId))
    .leftJoin(agents, and(eq(agents.id, messages.authorAgentId), eq(agents.orgId, messages.orgId)))
    .leftJoin(agentOwners, eq(agentOwners.id, agents.ownerUserId))
    .where(
      and(
        eq(messages.id, params.messageId),
        eq(messages.threadId, params.threadId),
        eq(messages.orgId, params.orgId),
        isNull(messages.deletedAt),
      ),
    )
    .limit(1)
  if (!row) {
    throw new ReplyThreadError(400, "quote_not_found", "The quoted message is not in this thread")
  }
  const excerpt = normaliseWhitespace(params.excerpt)
  const core = excerpt.replace(/^(…|\.\.\.)\s*/, "").replace(/\s*(…|\.\.\.)$/, "")
  if (core.length === 0 || !normaliseWhitespace(row.content).includes(core)) {
    throw new ReplyThreadError(
      400,
      "quote_excerpt_mismatch",
      "The excerpt is not part of the quoted message",
    )
  }
  const authorName =
    row.authorType === "agent"
      ? agentAuthorDisplayName({
          persistedLabel: (row.metadata as { agentAuthorLabel?: string } | null)?.agentAuthorLabel,
          liveAgentName: row.agentName,
          liveAgentKind: row.agentKind,
          liveAgentOwnerName: row.agentOwnerName,
        })
      : (row.userName ?? "Unknown")
  return {
    quote: {
      messageId: params.messageId,
      excerpt,
      authorName,
      replyRootId: row.replyRootId ?? null,
    },
    requiredScopes: row.requiredScopes ?? [],
    disclosureList: row.disclosureList ?? null,
  }
}

/**
 * The runtime half of the mandatory `requiredScopes` field, shared by every
 * kernel message write: a missing or non-string-array value throws instead of
 * falling back to the column default (visible to the whole room).
 */
export function assertExplicitRequiredScopes(
  requiredScopes: unknown,
): asserts requiredScopes is string[] {
  if (!Array.isArray(requiredScopes) || requiredScopes.some((s) => typeof s !== "string")) {
    throw new Error(
      "a kernel message write requires an explicit requiredScopes string array; pass [] only for a message that carries no scoped data",
    )
  }
}

/**
 * Who a message row records as its author agent (A8, A11). An explicit value
 * wins: that emitter either knows the agent or knows there was none. Otherwise
 * the live turn frame answers. An AGENT-authored row must name an agent
 * (0080's trigger) because the front end resolves the speaker from the row and
 * never from a client-side sentinel, so when neither said anything it falls
 * back to the requester's own personal agent: the same agent
 * `resolveActingAgent` picks for a turn this user drove, and the rule the
 * agent_chat collapse backfilled history with. After that comes the org's
 * `@base` system agent, created here if the org has none, so an agent-authored
 * row ALWAYS names a speaker: 0080 refuses the row outright, so an unresolvable
 * agent would cost the reply itself, and a reply is never worth an attribution.
 */
export async function resolveActingAgentIdForWrite(
  db: Pick<RlsClient, "select" | "insert" | "execute">,
  params: {
    orgId: string
    userId: string
    authorType: "user" | "agent" | "system"
    agentId?: string | null
  },
): Promise<string | null> {
  const named = params.agentId !== undefined ? params.agentId : captureActingAgentId()
  if (params.authorType !== "agent") return named
  if (named) return named
  const [personal] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.orgId, params.orgId),
        eq(agents.ownerUserId, params.userId),
        eq(agents.kind, "personal"),
        isNull(agents.archivedAt),
      ),
    )
    .orderBy(agents.createdAt, agents.id)
    .limit(1)
  if (personal) return personal.id
  // Last resort, so a reply is never LOST for want of a name: the org's own
  // built-in agent (`@base`, kind='system', created at bootstrap). A requester
  // with no personal agent is a bootstrap gap, and it must not cost the row.
  const [system] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(eq(agents.orgId, params.orgId), eq(agents.kind, "system"), isNull(agents.archivedAt)),
    )
    .orderBy(agents.createdAt, agents.id)
    .limit(1)
  if (system) return system.id
  // An org old enough to predate the agents migration, or one whose bootstrap
  // never ran, has no `@base` row at all. Creating it here is the only way this
  // function can keep its promise: 0080's trigger is hard, so returning null
  // would not cost the agent's NAME, it would cost the whole message. The
  // insert is the idempotent bootstrap one, so a concurrent turn resolves to
  // the same row rather than a second `@base`.
  // From the CALLER'S transaction (sendMessage's `db` is already an open RLS
  // transaction): on it when its login can elevate, else on the privileged
  // pool, never a second connection from the caller's own pool.
  const { ensureBaseAgentOnTx } = await import("~/modules/agent/directory/base-agent")
  return (await ensureBaseAgentOnTx(db, params.orgId)).id
}

/**
 * WHETHER A PERSISTED LABEL NAMES THE RUN RATHER THAN THE SPEAKER.
 *
 * Two of the labels this product writes are ATTRIBUTIONS of a run: "Routine
 * daily-digest" names the routine whose execution spoke, and "{User}'s agent"
 * names a turn no agent was resolvable for. Both are composed here (see
 * `resolveAgentAuthorLabel` in agent/tools/chat-tools.ts) and neither is a
 * copy of any agent's display name, so both must survive on the row forever.
 *
 * EVERY OTHER persisted label is a copy of the authoring agent's display name
 * taken at write time, which is exactly the thing that goes stale when the
 * agent is renamed.
 */
export function isRunAttributionLabel(label: string): boolean {
  return label.startsWith("Routine ") || label.endsWith("'s agent")
}

/**
 * THE NAME AN AGENT AUTHORED ROW IS SHOWN UNDER, from the row plus the
 * authoring agent's CURRENT display name.
 *
 * The persisted label used to win outright, and it is a snapshot: migration
 * 0100 renamed every default personal agent from "Liaison" to "Personal
 * agent", and the rows written before it went on saying "Liaison", so one DM
 * rendered the same agent under two names depending on when each turn was
 * written. A rename by the owner did the same thing.
 *
 * So the LIVE name wins wherever there is one, and the persisted label is kept
 * for the two cases it is the only truth for: a run attribution (above), and a
 * row whose agent is gone from the org.
 */
export function agentAuthorDisplayName(params: {
  persistedLabel?: string | null
  liveAgentName?: string | null
  /** The authoring agent's kind and, for a personal agent, its owner's name. */
  liveAgentKind?: string | null
  liveAgentOwnerName?: string | null
}): string {
  const label = params.persistedLabel?.trim() ? params.persistedLabel : null
  if (label?.startsWith("Routine ")) return label
  // A personal agent signs as "{Owner}'s agent", whatever its stored name (the
  // generic "Personal agent", copied onto rows written before this rule) says.
  const live =
    params.liveAgentName != null
      ? agentSpeakerName({
          displayName: params.liveAgentName,
          kind: params.liveAgentKind,
          ownerName: params.liveAgentOwnerName,
        })
      : null
  if (live && params.liveAgentKind === "personal") return live
  if (label && isRunAttributionLabel(label)) return label
  return live ?? params.liveAgentName ?? label ?? PERSONAL_AGENT_DISPLAY_NAME
}

/**
 * The repliers under a root, an agent named as its own posts are
 * (`agentSpeakerName`): the SQL adds its kind and owner for that, and neither
 * reaches the payload.
 */
function replyAuthorsOf(
  raw: unknown,
): Array<{ id: string; name: string | null; avatarUrl: string | null }> {
  if (!Array.isArray(raw)) return []
  return raw.map(
    (a: {
      id: string
      name: string | null
      avatarUrl: string | null
      agentKind?: string | null
      ownerName?: string | null
    }) => ({
      id: a.id,
      name: a.agentKind
        ? (agentSpeakerName({ displayName: a.name, kind: a.agentKind, ownerName: a.ownerName }) ??
          a.name)
        : a.name,
      avatarUrl: a.avatarUrl,
    }),
  )
}

/**
 * The name an AGENT-authored row is published under on the EVENT, resolved on
 * the emitting transaction from the `authorAgentId` already on the row, so the
 * socket copy and a refetch answer with the same name (`agentAuthorDisplayName`
 * is the read's own rule, shared).
 *
 * It used to be `agentAuthorLabel ?? <generic>` on every emitter, so an agent
 * reply arrived over the socket labelled generically whoever had spoken and the
 * real name appeared only on the next refetch.
 */
export async function resolveAgentAuthorName(
  db: Pick<RlsClient, "select">,
  params: { orgId: string; authorAgentId: string | null; agentAuthorLabel?: string },
): Promise<string> {
  if (params.agentAuthorLabel && isRunAttributionLabel(params.agentAuthorLabel)) {
    return params.agentAuthorLabel
  }
  if (!params.authorAgentId) {
    return params.agentAuthorLabel ?? PERSONAL_AGENT_DISPLAY_NAME
  }
  const [row] = await db
    .select({ displayName: agents.displayName, kind: agents.kind, ownerName: users.name })
    .from(agents)
    .leftJoin(users, eq(users.id, agents.ownerUserId))
    .where(and(eq(agents.id, params.authorAgentId), eq(agents.orgId, params.orgId)))
    .limit(1)
  return agentAuthorDisplayName({
    persistedLabel: params.agentAuthorLabel,
    liveAgentName: row?.displayName ?? null,
    liveAgentKind: row?.kind ?? null,
    liveAgentOwnerName: row?.ownerName ?? null,
  })
}

/**
 * The metadata a message is stored with. An agent post carries its attributed label, and a post
 * a routine run makes carries the run's id (`routineRunId`, from the run frame): a flow's required
 * outcome counts only its own run's messages (flow-runner.ts), never another run's in the same
 * conversation. The caller's own keys win over the run's id.
 */
export function agentPostMetadata(
  authorType: string,
  agentAuthorLabel: string | null | undefined,
  metadata: unknown,
): Record<string, unknown> | null {
  const base = (metadata as Record<string, unknown> | null | undefined) ?? null
  if (authorType !== "agent") return base
  const routineRunId = currentRunContext()?.routineRunId
  if (!agentAuthorLabel && !routineRunId) return base
  return {
    ...(routineRunId ? { routineRunId } : {}),
    ...(base ?? {}),
    ...(agentAuthorLabel ? { agentAuthorLabel } : {}),
  }
}

export async function sendMessage(db: RlsClient, params: SendMessageParams) {
  const {
    orgId,
    userId,
    threadId,
    content: givenContent,
    authorType = "user",
    agentAuthorLabel,
    correlationId,
    unprompted = false,
    endsTurn = false,
    metadata,
    requiredScopes: givenRequiredScopes,
    disclosureList = null,
    agentId,
    parentMessageId = null,
  } = params

  assertExplicitRequiredScopes(givenRequiredScopes)
  // Card numbers and payment keys are masked HERE, before the row, the event,
  // the search index, the live fan-out and the next model request read the
  // text: every one of them reads `content` from this point on.
  const content = maskWithNote(givenContent).text
  // A grant wildcard is never a data scope (scope-taint.ts, rule 10b): whatever a caller hands
  // in (a requester's own grant set, an effective scope), the row is stamped with the read
  // scopes it covers, never with `*`, which only the grant `*` covers.
  const requiredScopes = expandWildcardStamp(givenRequiredScopes, orgId)
  if (disclosureList !== null) assertDisclosureUserIds(disclosureList)

  // WHO ACTED, for the audit trail (A11). An explicit value wins: that emitter
  // either knows the agent or knows there was none. Otherwise the live frame
  // answers, and outside any turn it is null, which is the true answer there:
  // a turn no agent drove must not be filed under one.
  const actingAgentId = agentId !== undefined ? agentId : captureActingAgentId()

  // WHO SPOKE, on the row (A8). Same answer whenever there is one, but an
  // agent-authored row must name SOMEBODY (0080), so this one falls back to the
  // requester's personal agent and then to the org's @base. The audit row above
  // keeps its null: "nobody was resolvable" and "the org's built-in agent
  // spoke" are different claims and only one of them is about attribution.
  const authorAgentId =
    authorType === "agent"
      ? await resolveActingAgentIdForWrite(db, { orgId, userId, authorType, agentId })
      : null

  // Agent posts carry an attributed label in metadata so the read path and the
  // event payload surface "{User}'s agent" / "Routine {name}" — never the human.
  const effectiveMetadata = agentPostMetadata(authorType, agentAuthorLabel, metadata)

  // Verify user is participant
  const [participant] = await db
    .select()
    .from(threadParticipants)
    .where(
      and(
        eq(threadParticipants.threadId, threadId),
        eq(threadParticipants.userId, userId),
        eq(threadParticipants.orgId, orgId),
      ),
    )
    .limit(1)
  if (!participant) return null

  // THE REPLY ROOT (0112). An explicit value wins; undefined inherits the
  // parent's, so an agent exchange nested under a reply stays in that reply
  // thread. Read on the caller's client: a root the writer cannot see is the
  // same answer as a thread they are not in.
  let replyRootId: string | null = params.replyRootId ?? null
  if (params.replyRootId === undefined && parentMessageId) {
    const [parent] = await db
      .select({ replyRootId: messages.replyRootId })
      .from(messages)
      .where(
        and(
          eq(messages.id, parentMessageId),
          eq(messages.threadId, threadId),
          eq(messages.orgId, orgId),
        ),
      )
      .limit(1)
    replyRootId = parent?.replyRootId ?? null
  }
  let root: {
    authorId: string
    authorType: string
    requiredScopes: string[]
    disclosureList: string[] | null
  } | null = null
  if (replyRootId) {
    const [row] = await db
      .select({
        authorId: messages.authorId,
        authorType: messages.authorType,
        replyRootId: messages.replyRootId,
        requiredScopes: messages.requiredScopes,
        disclosureList: messages.disclosureList,
      })
      .from(messages)
      .where(
        and(
          eq(messages.id, replyRootId),
          eq(messages.threadId, threadId),
          eq(messages.orgId, orgId),
        ),
      )
      .limit(1)
    if (!row) return null
    if (row.replyRootId) {
      throw new ReplyThreadError(400, "reply_root_is_reply", "A reply cannot be a thread root")
    }
    root = row
  }
  const alsoInChannel = replyRootId !== null && params.alsoInChannel === true
  // A2: a reply is readable by exactly who can read its root, never more.
  // The tag is a set: a repeated scope asks nothing more of the reader, and
  // the read policy checks every entry, so it is stored once.
  // Who on this reply's own list reads the root by its scopes rather than its list.
  let rootReaders: ReadonlySet<string> = new Set()
  if (root && disclosureList && root.disclosureList) {
    const rootList = root.disclosureList
    const outside = disclosureList.filter((u) => !rootList.includes(u))
    if (outside.length > 0) {
      const { holdsEveryScope, loadOrgMemberGrants } = await import(
        "~/modules/agent/scopes/taint-approval-audience"
      )
      const rootScopes = expandWildcardStamp(root.requiredScopes ?? [], orgId)
      const members = await loadOrgMemberGrants(orgId, { userIds: outside })
      rootReaders = new Set(
        members.filter((m) => holdsEveryScope(m.scopes, rootScopes)).map((m) => m.id),
      )
    }
  }
  const visibility = root
    ? inheritVisibility({ requiredScopes, disclosureList }, root, rootReaders)
    : { requiredScopes: [...new Set(requiredScopes)], disclosureList }
  const hiddenFromChannel = replyRootId !== null && !alsoInChannel

  const mentionsList = parseMentions(content)

  // Wrap mutation + event in transaction for atomicity
  const result = await db.transaction(async (tx) => {
    // NO `RETURNING`: the writer need not be able to read its own row. A row
    // returned by an INSERT must also pass the SELECT policy, and messages_select
    // asks for every scope on `required_scopes`. An agent's post is stamped with
    // what its turn read (scope taint), which can hold a scope the turn's own
    // context lacks: a routine granted `kernel:threads:write` reads its tick
    // prompt back as history, and that projects to `kernel:threads:read`
    // (taint-read-scopes.ts, rule 5.2). With `RETURNING` the post was refused
    // with 42501 although messages_insert admitted it. The INSERT policy still
    // decides who may write, and the stamp still decides who may read; the row
    // the caller gets is the one written, with the id chosen here and the
    // created_at the column default gives it (now(), the transaction's start).
    const row = {
      id: crypto.randomUUID(),
      threadId,
      orgId,
      authorId: userId,
      authorType,
      content,
      mentions: mentionsList.length > 0 ? mentionsList : null,
      metadata: effectiveMetadata as (typeof messages.$inferSelect)["metadata"],
      // A8: the SPEAKING agent, on the row. Null on every non-agent row.
      authorAgentId,
      // P3b: null on a human facing turn, the triggering message on an agent
      // only one.
      parentMessageId,
      replyRootId,
      alsoInChannel,
    }
    await tx.insert(messages).values({
      ...row,
      requiredScopes: visibility.requiredScopes,
      disclosureList: visibility.disclosureList,
    })
    const [clock] = extractRows<{ ms: number | string }>(
      await tx.execute(drizzleSql`SELECT (extract(epoch FROM now()) * 1000)::float8 AS ms`),
    )
    const msg: typeof messages.$inferSelect = {
      ...row,
      requiredScopes: visibility.requiredScopes,
      disclosureList: visibility.disclosureList,
      editedAt: null,
      deletedAt: null,
      externalRef: null,
      createdAt: new Date(Number(clock?.ms)),
    }

    // Bump thread updatedAt, and read the thread type back so the caller can tell
    // a 1:1 agent chat (`agent_chat`) from a shared thread — the former replies
    // to every message, the latter only when the agent is @-mentioned. A reply
    // the channel does not show is not channel activity (A4), so it leaves the
    // room where it sits in the thread list.
    const [threadRow] = hiddenFromChannel
      ? await tx
          .select({ type: threads.type, createdFrom: threads.createdFrom })
          .from(threads)
          .where(eq(threads.id, threadId))
      : await tx
          .update(threads)
          .set({ updatedAt: new Date() })
          .where(eq(threads.id, threadId))
          .returning({ type: threads.type, createdFrom: threads.createdFrom })

    // A person who @-mentions a colleague brings them in: seated here, before
    // the participant list below is read, so the mention's attention row and
    // push point at a thread the colleague can open. Only a PERSON's mention
    // seats anybody. An agent names people in passing (a summary, a hand-off),
    // and its word must never widen who reads a room; and a 1:1 agent chat is
    // the writer's private conversation, where "@Sam" is somebody the agent is
    // being told about, not an invitation.
    if (authorType === "user" && threadRow?.type !== "agent_chat") {
      const mentionedUserIds = mentionsList.flatMap((m) => (m.type === "user" ? [m.id] : []))
      await seatMentionedMembers(tx, {
        orgId,
        threadId,
        actorUserId: userId,
        userIds: mentionedUserIds,
      })
    }

    // FOLLOWERS (S5, A2): the root's author, the replier, and every member
    // mentioned in the reply, AFTER the mention seated them above. The
    // INSERT ... SELECT reads the room's roster, so a mentioned person who is
    // not a member never becomes a follower; the insert policy says the same.
    let followerIds: string[] = []
    if (replyRootId && root) {
      const candidates = new Set<string>()
      if (root.authorType === "user" || root.authorType === "agent") candidates.add(root.authorId)
      if (authorType === "user") candidates.add(userId)
      for (const m of mentionsList) if (m.type === "user") candidates.add(m.id)
      if (candidates.size > 0) {
        await tx.execute(drizzleSql`
          INSERT INTO ${replyThreadFollowers} (root_message_id, thread_id, user_id, org_id)
          SELECT ${replyRootId}::uuid, ${threadId}::uuid, tp.user_id, ${orgId}::uuid
            FROM ${threadParticipants} tp
           WHERE tp.thread_id = ${threadId}
             AND tp.org_id = ${orgId}
             AND tp.user_id IN (${drizzleSql.join(
               [...candidates].map((id) => drizzleSql`${id}::uuid`),
               drizzleSql`, `,
             )})
          ON CONFLICT (root_message_id, user_id) DO NOTHING`)
      }
      // The replier has read everything up to their own reply.
      if (authorType === "user") {
        await tx
          .update(replyThreadFollowers)
          .set({ lastReadAt: msg.createdAt })
          .where(
            and(
              eq(replyThreadFollowers.rootMessageId, replyRootId),
              eq(replyThreadFollowers.userId, userId),
            ),
          )
      }
      const rows = await tx
        .select({ userId: replyThreadFollowers.userId })
        .from(replyThreadFollowers)
        .where(eq(replyThreadFollowers.rootMessageId, replyRootId))
      followerIds = rows.map((r) => r.userId)
    }

    // Get author name for event — agent messages use their attributed label.
    //
    // The three terms, and their order, are the LIST READ's (see the `authorName`
    // mapping in listMessages): the persisted label first ("Routine daily-digest"
    // names the run, not the speaker), then the speaking agent's own display
    // name, and only then the generic fallback for a row that names no agent.
    // The middle term used to be missing here, so a live agent reply arrived
    // labelled generically whoever had spoken, and the real name ("Support Desk")
    // appeared only on the next refetch. Resolved on THIS transaction, from the
    // `authorAgentId` already on the row, so the socket and a refetch can never
    // disagree about who spoke.
    const authorName =
      authorType === "agent"
        ? await resolveAgentAuthorName(tx, { orgId, authorAgentId, agentAuthorLabel })
        : ((await tx.select({ name: users.name }).from(users).where(eq(users.id, userId)))[0]
            ?.name ?? "Unknown")

    // Thread participants — carried on the event so the `thread_reply` attention
    // translation can fan a notification out to everyone in the thread.
    const participantRows = await tx
      .select({ userId: threadParticipants.userId })
      .from(threadParticipants)
      .where(eq(threadParticipants.threadId, threadId))
    const participantIds = participantRows.map((p) => p.userId)

    await tx.queueEvent({
      app: "kernel",
      entity: "message",
      action: "create",
      entityId: msg.id,
      orgId,
      actorId: userId,
      // An agent's own reply is an AGENT action. Without this the audit
      // consumer's `event.actorType ?? "user"` filed every agent reply under the
      // human who triggered it, and A11 could not tell the two apart.
      actorType: authorType === "agent" ? "agent" : authorType === "system" ? "system" : "user",
      agentId: actingAgentId,
      data: {
        id: msg.id,
        threadId,
        authorId: userId,
        authorName,
        authorType,
        // The live frame names the speaker exactly as the list read does, so a
        // message that arrives over the socket is attributed to the same agent
        // a refetch would attribute it to (FX4).
        authorAgentId,
        // The nesting travels with the live frame too, so a message arriving
        // over the socket lands where a refetch would put it.
        parentMessageId: msg.parentMessageId ?? null,
        // S9: which reply thread this belongs to, so a client routes it to
        // the open panel and bumps the root's summary instead of inserting it
        // in the channel list, and the translators notify the followers.
        replyRootId: msg.replyRootId ?? null,
        alsoInChannel: msg.alsoInChannel,
        // Where the thread lives, as flat fields an exact-match binding reads (a
        // guided tour beat tells a task comment by `threadOrigin: "projects:task"`).
        // `threadOrigin` is the thread's `created_from` app and entity type, null
        // for a thread no entity owns.
        threadType: threadRow?.type ?? "thread",
        threadOrigin: threadRow?.createdFrom
          ? `${threadRow.createdFrom.app}:${threadRow.createdFrom.entityType}`
          : null,
        // The entity the thread belongs to (a task's comments), ids only: its
        // notifications name the entity and open on it (threads/thread-anchor.ts).
        threadAnchor: threadAnchorIds(threadRow?.createdFrom),
        // The message @-mentions an agent (a tour's "bring an agent in" beat
        // binds to it): flat, so an exact-match binding reads it.
        mentionsAgent: mentionsList.some((m) => m.type === "agent"),
        ...(msg.replyRootId ? { followerIds } : {}),
        content,
        preview: messagePreview(content),
        participantIds,
        mentions: mentionsList.length > 0 ? mentionsList : null,
        metadata: effectiveMetadata,
        // What a viewer must hold to read this message; the websocket fan-out
        // filters on it the way the messages RLS does on reads.
        requiredScopes: msg.requiredScopes,
        // Members a Share anyway disclosed it to; they see it without the scopes.
        disclosureList: msg.disclosureList ?? null,
        createdAt: msg.createdAt,
        ...(correlationId ? { correlationId } : {}),
        ...(unprompted ? { unprompted: true } : {}),
        ...(endsTurn && authorType !== "user" ? { endsTurn: true } : {}),
      },
    })

    return { msg, authorName, threadType: threadRow?.type ?? "thread" }
  })

  return {
    id: result.msg.id,
    threadId: result.msg.threadId,
    authorId: result.msg.authorId,
    authorName: result.authorName,
    authorAvatarUrl: null,
    authorType: result.msg.authorType,
    authorAgentId: result.msg.authorAgentId ?? null,
    parentMessageId: result.msg.parentMessageId ?? null,
    replyRootId: result.msg.replyRootId ?? null,
    alsoInChannel: result.msg.alsoInChannel,
    content: result.msg.content,
    mentions: result.msg.mentions,
    metadata: result.msg.metadata ?? null,
    reactions: [],
    editedAt: result.msg.editedAt,
    deletedAt: result.msg.deletedAt,
    createdAt: result.msg.createdAt,
    /** Thread type at send time — `agent_chat` marks the 1:1 Liaison thread. */
    threadType: result.threadType,
  }
}

export async function editMessage(db: RlsClient, params: EditMessageParams) {
  const { orgId, userId, threadId, messageId, isAdmin = false } = params
  // Masked before the update and its event, as on a new message.
  const content = maskWithNote(params.content).text

  // Verify user is still a participant — removed participants cannot edit old messages
  const [participant] = await db
    .select({ id: threadParticipants.id })
    .from(threadParticipants)
    .where(
      and(
        eq(threadParticipants.threadId, threadId),
        eq(threadParticipants.userId, userId),
        eq(threadParticipants.orgId, orgId),
      ),
    )
    .limit(1)
  if (!participant) return null

  const mentionsList = parseMentions(content)

  // Author-only, EXCEPT an org admin (kernel:threads:admin) may edit any
  // message in a thread they participate in — added so admins can moderate
  // agent-authored replies too (author_id on an agent message is already the
  // human whose turn triggered it, so this also lets that human keep editing
  // their own agent's reply — no new column needed, see message RLS comment).
  const authorCondition = isAdmin ? undefined : eq(messages.authorId, userId)

  // Wrap mutation + event in transaction for atomicity
  return await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(messages)
      .set({
        content,
        mentions: mentionsList.length > 0 ? mentionsList : null,
        editedAt: new Date(),
      })
      .where(
        and(
          eq(messages.id, messageId),
          eq(messages.threadId, threadId),
          eq(messages.orgId, orgId),
          authorCondition,
          isNull(messages.deletedAt),
        ),
      )
      .returning({
        id: messages.id,
        content: messages.content,
        mentions: messages.mentions,
        editedAt: messages.editedAt,
        createdAt: messages.createdAt,
        // The row's own visibility facts, read in the SAME transaction that
        // writes the event, so the tag can never come from a row that was
        // re-tagged in between. The edit rewrites the body and never these
        // (message-writes-tagged pins that), so they are the tag the message
        // already had: this event carries what the create event carried.
        requiredScopes: messages.requiredScopes,
        disclosureList: messages.disclosureList,
        replyRootId: messages.replyRootId,
        alsoInChannel: messages.alsoInChannel,
      })

    if (!updated) return null

    await tx.update(threads).set({ updatedAt: new Date() }).where(eq(threads.id, threadId))

    // Held back from the returned object: the route serialises that straight to
    // the client, and these two are the visibility metadata, not the message.
    const { requiredScopes, disclosureList, replyRootId, alsoInChannel, ...edited } = updated

    await tx.queueEvent({
      app: "kernel",
      entity: "message",
      action: "update",
      entityId: messageId,
      orgId,
      actorId: userId,
      data: {
        id: messageId,
        threadId,
        content,
        mentions: mentionsList.length > 0 ? mentionsList : null,
        editedAt: edited.editedAt,
        // A16: the reply thread the edited message lives in, so a client
        // patches the open panel's copy rather than looking for it in the
        // channel list.
        replyRootId: replyRootId ?? null,
        alsoInChannel,
        // This event CARRIES THE EDITED CONTENT, so the live fan-out has to be
        // able to filter it exactly as it filters the create event. Untagged it
        // would reach nobody (T23 fails closed) and the edit would silently stop
        // arriving live for the very people entitled to it.
        ...messageVisibilityFacts({ requiredScopes, disclosureList }),
      },
    })

    return edited
  })
}

// Message deletion is author-only, EXCEPT for an org admin (kernel:threads:admin
// or '*'). This is enforced in two layers, kept in sync: (1) the `authorCondition`
// below, and (2) the `messages_delete` / `messages_update` RLS policies in
// db/migrations/0027_messages_admin_override.sql, which OR the same
// kernel:threads:admin / '*' scope check into `author_id = current_user_id`.
// (Originally messages were strictly author-only,
// with no bypass, mirroring the pattern kernel.saved_views already had via
// kernel:saved_views:admin. The bypass was added so admins can moderate/correct
// agent-authored replies too. Note agent messages already carry `author_id` =
// the human user whose turn triggered that agent run — sendMessage always
// inserts the initiating userId as authorId, agent posts are attributed via
// `metadata.agentAuthorLabel` rather than a separate identity — so that human
// can already edit/delete their own agent's messages via the plain author check;
// the admin bypass additionally covers OTHER users' agent-authored messages.)
export async function deleteMessage(db: RlsClient, params: DeleteMessageParams) {
  const { orgId, userId, threadId, messageId, isAdmin = false } = params

  // Verify thread participation
  const [participant] = await db
    .select()
    .from(threadParticipants)
    .where(
      and(
        eq(threadParticipants.threadId, threadId),
        eq(threadParticipants.userId, userId),
        eq(threadParticipants.orgId, orgId),
      ),
    )
    .limit(1)
  if (!participant) return null

  const authorCondition = isAdmin ? undefined : eq(messages.authorId, userId)

  const conditions = [
    eq(messages.id, messageId),
    eq(messages.threadId, threadId),
    eq(messages.orgId, orgId),
    isNull(messages.deletedAt),
    authorCondition,
  ]

  // Wrap mutation + event in transaction for atomicity
  return await db.transaction(async (tx) => {
    const [deleted] = await tx
      .update(messages)
      .set({ deletedAt: new Date() })
      .where(and(...conditions))
      .returning({
        id: messages.id,
        deletedAt: messages.deletedAt,
        // Read BEFORE the row is gone: this is a soft delete, so the row is
        // still here, and RETURNING hands back columns the update never touched.
        // These are therefore the tag the message carried while it was alive.
        requiredScopes: messages.requiredScopes,
        disclosureList: messages.disclosureList,
        replyRootId: messages.replyRootId,
        alsoInChannel: messages.alsoInChannel,
      })

    if (!deleted) return null

    await tx.delete(messageReactions).where(eq(messageReactions.messageId, messageId))

    await tx.update(threads).set({ updatedAt: new Date() }).where(eq(threads.id, threadId))

    // P4m-T23. A human delete removes the message from the transcript index
    // HERE rather than waiting for the post commit outbox consumer, and takes
    // every window document quoting it with it: the windows are keyed by their
    // anchor message, so nothing else ever revisits them and a deleted line
    // would stay searchable inside one for the life of the thread. Then every
    // artefact built from the message is marked stale, so the next
    // consolidation run rebuilds it without the message.
    await deleteMessageAndWindowDocuments(orgId, threadId, messageId)
    await markArtefactsStaleForDeletedMessage({ orgId, threadId, messageId })

    // Held back from the returned object, as in editMessage: the route
    // serialises it to the client.
    const { requiredScopes, disclosureList, replyRootId, alsoInChannel, ...removed } = deleted

    await tx.queueEvent({
      app: "kernel",
      entity: "message",
      action: "delete",
      entityId: messageId,
      orgId,
      actorId: userId,
      data: {
        id: messageId,
        threadId,
        // A16: a deleted reply lowers its root's summary.
        replyRootId: replyRootId ?? null,
        alsoInChannel,
        // Ids only, no body, but it still has to be tagged: untagged the live
        // fan-out drops it for everyone, so the message stays on screen for
        // readers who are entitled to know it is gone.
        ...messageVisibilityFacts({ requiredScopes, disclosureList }),
      },
    })

    // The message's files go with it, in this same transaction: their rows
    // are deleted here, and their objects only after this commits (the queued
    // kernel.file.delete events drive the files-delete-object consumer). A
    // delete that rolls back leaves the message, rows and objects untouched.
    await deleteMessageAttachments(tx, { orgId, actorId: userId, messageIds: [messageId] })

    return removed
  })
}

/**
 * Load a message's attachments and broadcast them to the thread as a
 * `message:update` carrying an `attachments` array.
 *
 * Attachments are staged on an upload session and only reparented onto the
 * message AFTER it is persisted, so the `message:create` event (queued inside
 * the insert transaction) can never carry them. The SENDER's client patches
 * them in from the POST response; every OTHER participant received a create
 * event with no attachments and, with nothing to correct it, showed the
 * message bare until a reload re-fetched it through `listMessages`. This is
 * that correction: one update event, emitted once the reparent has committed.
 *
 * Returns the attachment payloads so the caller can reuse them for its own HTTP
 * response instead of re-querying.
 */
export async function publishMessageAttachments(
  db: RlsClient,
  params: { orgId: string; userId: string; threadId: string; messageId: string },
): Promise<Array<Record<string, unknown>>> {
  const { orgId, userId, threadId, messageId } = params
  const k = drizzleSql.raw(schemaRef("kernel"))

  const rows = extractRows<{
    id: string
    filename: string
    mime_type: string
    size_bytes: number | string
    thumbnail_key: string | null
    disposition: string
    content_id: string | null
    ordinal: number
    created_at: Date | string
  }>(
    await db.execute(drizzleSql`
      SELECT id::text AS id, filename, mime_type, size_bytes, thumbnail_key,
             disposition, content_id, ordinal, created_at
      FROM ${k}.files
      WHERE app = 'kernel' AND entity_type = 'message' AND entity_id = ${messageId}
      ORDER BY ordinal ASC, created_at ASC, id ASC
    `),
  )

  const attachments = rows.map((r) => ({
    id: r.id,
    filename: r.filename,
    mimeType: r.mime_type,
    sizeBytes: Number(r.size_bytes),
    thumbnailKey: r.thumbnail_key,
    disposition: r.disposition,
    contentId: r.content_id,
    ordinal: r.ordinal,
    createdAt: r.created_at,
  }))

  if (attachments.length === 0) return attachments

  // The row's own visibility facts and reply routing ride on the frame. The
  // websocket fan-out fails closed on a kernel `message` frame with no
  // `requiredScopes` array (T23), so an untagged update reached NOBODY: every
  // other participant, and the sender's other devices, kept seeing the message
  // without its files until a reload. The routing lets a client that holds the
  // reply panel file an early update against the right list.
  const [facts] = await db
    .select({
      requiredScopes: messages.requiredScopes,
      disclosureList: messages.disclosureList,
      replyRootId: messages.replyRootId,
      alsoInChannel: messages.alsoInChannel,
    })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1)

  await db.transaction(async (tx) => {
    await tx.queueEvent({
      app: "kernel",
      entity: "message",
      action: "update",
      entityId: messageId,
      orgId,
      actorId: userId,
      data: {
        id: messageId,
        threadId,
        attachments,
        replyRootId: facts?.replyRootId ?? null,
        alsoInChannel: facts?.alsoInChannel === true,
        // No row read (RLS hid it) yields no keys: the frame stays untagged and
        // the fan-out withholds it, never a guessed `[]`.
        ...messageVisibilityFacts(facts ?? {}),
      },
    })
  })

  return attachments
}

/** The caller's session scopes, as the RLS context was given them (fails closed). */
async function sessionScopes(db: RlsClient): Promise<string[]> {
  const [gucRow] = extractRows<{ scopes: string | null }>(
    await db.execute(drizzleSql`SELECT rls_ctx.scopes() AS scopes`),
  )
  const raw = gucRow?.scopes ?? ""
  return raw === "" || raw === "__none__" ? [] : raw.split(",")
}

export async function listMessages(db: RlsClient, params: ListMessagesParams) {
  const { orgId, userId, threadId, limit, before, after } = params
  const view = params.view ?? { kind: "channel" }

  // Verify user is participant. T12 exception: hidden sub-run threads
  // (`threads.type = 'subrun'`) are readable by anyone who participates in
  // the chain's root thread — the operator who owns the parent conversation
  // can drill into any sub-run it spawned without becoming a participant of
  // the synthetic hidden thread (those threads have no participant rows).
  const [participant] = await db
    .select()
    .from(threadParticipants)
    .where(
      and(
        eq(threadParticipants.threadId, threadId),
        eq(threadParticipants.userId, userId),
        eq(threadParticipants.orgId, orgId),
      ),
    )
    .limit(1)
  // Set when access was granted via the sub-run drill-down rule below rather than
  // direct participation: the viewer's own grants. The message/attachment read
  // queries are themselves gated by the participant-only `messages_select` RLS
  // policy, which a non-participant operator does not satisfy for a hidden sub-run
  // thread — so when we authorize via the root-thread rule we must also run the
  // reads PRIVILEGED, otherwise they return empty (the same dead-feature symptom,
  // one layer down). The privileged read also skips that policy's visibility half,
  // so it is applied in code with these grants.
  let viewerGrants: string[] | null = null
  if (!participant) {
    // The sub-run drill-down lookups must run PRIVILEGED. The thread / agent_runs /
    // thread_participants SELECT policies are all participant-gated on the *row's*
    // thread (see 0000_initial.sql), and a hidden sub-run thread has no participant
    // rows — so under the caller's RLS context every one of these reads finds
    // nothing and the feature is dead (404 for every drill-down). We instead read
    // under the privileged (BYPASSRLS) role and ENFORCE authorization in code:
    //   1. the thread exists, belongs to the caller's org, and is type='subrun';
    //   2. the caller participates in the chain's ROOT surface thread.
    // Org scoping is enforced by the explicit `orgId` predicate on every query
    // (the privileged role bypasses RLS, so the predicate is the boundary). On any
    // failure we return null → the route renders 404, never 403, so the existence
    // of a sub-run thread is not leaked across orgs or to non-participants.
    const authorized = await withPrivilegedDb(
      orgId,
      "threads.listMessages:subrun-drilldown",
      async (ptx) => {
        const [thread] = await ptx
          .select({ type: threads.type })
          .from(threads)
          .where(and(eq(threads.id, threadId), eq(threads.orgId, orgId)))
          .limit(1)
        if (!thread || thread.type !== "subrun") return false

        const [run] = await ptx
          .select({ rootRunId: agentRuns.rootRunId })
          .from(agentRuns)
          .where(and(eq(agentRuns.threadId, threadId), eq(agentRuns.orgId, orgId)))
          .limit(1)
        if (!run) return false

        const [rootRun] = await ptx
          .select({ threadId: agentRuns.threadId, parentThreadId: agentRuns.parentThreadId })
          .from(agentRuns)
          .where(and(eq(agentRuns.id, run.rootRunId), eq(agentRuns.orgId, orgId)))
          .limit(1)
        if (!rootRun) return false

        // The chain's surface: the root run's own thread, or, for a root a chat turn spawned
        // (its own thread is the hidden one), the conversation that turn ran in.
        const surfaces = [rootRun.threadId, rootRun.parentThreadId].filter(
          (t): t is string => typeof t === "string",
        )
        const [rootParticipant] = await ptx
          .select({ id: threadParticipants.id })
          .from(threadParticipants)
          .where(
            and(
              inArray(threadParticipants.threadId, surfaces),
              eq(threadParticipants.userId, userId),
              eq(threadParticipants.orgId, orgId),
            ),
          )
          .limit(1)
        if (!rootParticipant) return null
        // Live grants narrowed by the session's own scopes (the RLS GUC): a
        // restricted (device-flow) session never reads past its ceiling here.
        return applyScopeCeiling(
          (await loadEffectivePermissions(ptx, userId, orgId)).scopes,
          await sessionScopes(db),
        )
      },
    )
    if (!authorized) return null
    viewerGrants = authorized
  }

  // The app-level mirror below is fed EXACTLY what the RLS policy was fed: the
  // same `app.current_scopes` GUC, not a second lookup that could disagree with
  // it (an agent turn runs with narrowed scopes, so its stored grants are wider
  // than its RLS context, and re-deriving them here would make the mirror more
  // permissive than the policy it mirrors). The GUC maps "no grants" to the
  // `__none__` sentinel, and an absent context to the empty string; both mean
  // the viewer holds nothing, which fails closed.
  let mirrorGrants: string[]
  if (viewerGrants !== null) {
    mirrorGrants = viewerGrants
  } else {
    const [gucRow] = extractRows<{ scopes: string | null }>(
      await db.execute(drizzleSql`SELECT rls_ctx.scopes() AS scopes`),
    )
    const rawScopes = gucRow?.scopes ?? ""
    mirrorGrants = rawScopes === "" || rawScopes === "__none__" ? [] : rawScopes.split(",")
  }
  const viewer = { userId, grants: mirrorGrants }

  // The read queries below run via `reader.execute()`. For a direct participant
  // that is the caller's RLS-scoped client (the `messages_select` policy is the
  // authorization). For the sub-run drill-down — where we already proved org +
  // root-thread participation in code above — the participant-gated RLS policy
  // would wrongly return empty, so we route the reads through a privileged
  // (BYPASSRLS) transaction. Either way org scoping is preserved: every query
  // filters on `org_id = ${orgId}` / `thread_id = ${threadId}`.
  const readBody = async (reader: Pick<RlsClient, "execute">) => {
    // Complex query with json_agg for reactions — kept as raw SQL.
    const k = drizzleSql.raw(schemaRef("kernel"))
    let cursorClause = drizzleSql``
    let orderDir = drizzleSql`DESC`
    // WHICH ROWS (0112). The channel view leaves out every reply that was not
    // also sent to the channel; the replies view is one root's replies.
    const viewClause =
      view.kind === "replies"
        ? drizzleSql`AND m.reply_root_id = ${view.rootId}`
        : view.kind === "message"
          ? drizzleSql`AND m.id = ${view.id}`
          : drizzleSql`AND ${drizzleSql.raw(CHANNEL_MESSAGE_PREDICATE)}`

    if (before) {
      // Validate cursor — must exist in this thread (prevents silent empty results on bad cursor)
      const [cursorMsg] = extractRows(
        await reader.execute(
          drizzleSql`SELECT id FROM ${k}.messages WHERE id = ${before} AND thread_id = ${threadId} AND org_id = ${orgId} LIMIT 1`,
        ),
      )
      if (!cursorMsg) throw new HTTPException(400, { message: "Invalid cursor" })
      // Composite cursor (created_at, id) to handle messages with identical timestamps
      cursorClause = drizzleSql`AND (m.created_at, m.id) < ((SELECT created_at FROM ${k}.messages WHERE id = ${before} AND thread_id = ${threadId}), ${before}::uuid)`
    } else if (after) {
      const [cursorMsg] = extractRows(
        await reader.execute(
          drizzleSql`SELECT id FROM ${k}.messages WHERE id = ${after} AND thread_id = ${threadId} AND org_id = ${orgId} LIMIT 1`,
        ),
      )
      if (!cursorMsg) throw new HTTPException(400, { message: "Invalid cursor" })
      cursorClause = drizzleSql`AND (m.created_at, m.id) > ((SELECT created_at FROM ${k}.messages WHERE id = ${after} AND thread_id = ${threadId}), ${after}::uuid)`
      orderDir = drizzleSql`ASC`
    }

    const query = drizzleSql`
    SELECT m.id, m.thread_id, m.author_id, m.author_type, m.author_agent_id,
           m.parent_message_id, m.reply_root_id, m.also_in_channel,
           CASE WHEN m.deleted_at IS NOT NULL THEN NULL ELSE m.content END AS content,
           CASE WHEN m.deleted_at IS NOT NULL THEN NULL ELSE m.mentions END AS mentions,
           CASE WHEN m.deleted_at IS NOT NULL THEN NULL ELSE m.metadata END AS metadata,
           m.edited_at, m.deleted_at, m.created_at,
           m.required_scopes, m.disclosure_list,
           u.name AS author_name, u.avatar_url AS author_avatar_url,
           ag.display_name AS author_agent_name,
           ag.kind::text AS author_agent_kind, ago.name AS author_agent_owner_name,
           (
             SELECT json_agg(json_build_object(
               'emoji', sub.emoji,
               'count', sub.cnt,
               'users', sub.users,
               'reacted', sub.reacted
             ))
             FROM (
               SELECT mr.emoji,
                      COUNT(*)::int AS cnt,
                      json_agg(json_build_object('id', mr.user_id, 'name', ru.name)) AS users,
                      bool_or(mr.user_id = ${userId}) AS reacted
               FROM ${k}.message_reactions mr
               JOIN ${k}.users ru ON ru.id = mr.user_id
               WHERE mr.message_id = m.id
               GROUP BY mr.emoji
             ) sub
           ) AS reactions,
           -- THE REPLY SUMMARY under a root (S3): read on the same client as
           -- the page, so under RLS it counts only replies this viewer may read.
           -- A reply is a user's or an agent's: a system line in the thread
           -- (an agent's seat line) is not one.
           (
             SELECT COUNT(*)::int FROM ${k}.messages r
             WHERE r.reply_root_id = m.id AND r.thread_id = m.thread_id AND r.deleted_at IS NULL
               AND r.author_type IN ('user', 'agent')
           ) AS reply_count,
           (
             SELECT MAX(r.created_at) FROM ${k}.messages r
             WHERE r.reply_root_id = m.id AND r.thread_id = m.thread_id AND r.deleted_at IS NULL
               AND r.author_type IN ('user', 'agent')
           ) AS last_reply_at,
           (
             SELECT json_agg(json_build_object('id', ra.id, 'name', ra.name, 'avatarUrl', ra.avatar_url,
                                               'agentKind', ra.agent_kind, 'ownerName', ra.owner_name)
                             ORDER BY ra.last_at DESC)
             FROM (
               -- One entry per replier, most recent first. An agent reply is
               -- the AGENT's, not the requester's who is its author_id.
               SELECT CASE WHEN r.author_type = 'agent' AND r.author_agent_id IS NOT NULL
                           THEN r.author_agent_id ELSE r.author_id END AS id,
                      MAX(CASE WHEN r.author_type = 'agent' AND r.author_agent_id IS NOT NULL
                               THEN rag.display_name ELSE ru.name END) AS name,
                      MAX(CASE WHEN r.author_type = 'agent' AND r.author_agent_id IS NOT NULL
                               THEN NULL ELSE ru.avatar_url END) AS avatar_url,
                      MAX(CASE WHEN r.author_type = 'agent' AND r.author_agent_id IS NOT NULL
                               THEN rag.kind::text END) AS agent_kind,
                      MAX(CASE WHEN r.author_type = 'agent' AND r.author_agent_id IS NOT NULL
                               THEN rao.name END) AS owner_name,
                      MAX(r.created_at) AS last_at
               FROM ${k}.messages r
               LEFT JOIN ${k}.users ru ON ru.id = r.author_id
               LEFT JOIN ${k}.agents rag ON rag.id = r.author_agent_id AND rag.org_id = r.org_id
               LEFT JOIN ${k}.users rao ON rao.id = rag.owner_user_id
               WHERE r.reply_root_id = m.id AND r.thread_id = m.thread_id
                 AND r.deleted_at IS NULL AND r.author_type IN ('user', 'agent')
               GROUP BY 1
               ORDER BY MAX(r.created_at) DESC
               LIMIT 3
             ) ra
           ) AS reply_authors
    FROM ${k}.messages m
    JOIN ${k}.users u ON u.id = m.author_id
    LEFT JOIN ${k}.agents ag ON ag.id = m.author_agent_id AND ag.org_id = m.org_id
    LEFT JOIN ${k}.users ago ON ago.id = ag.owner_user_id
    WHERE m.thread_id = ${threadId} AND m.org_id = ${orgId}
    ${viewClause}
    ${cursorClause}
    ORDER BY m.created_at ${orderDir}, m.id ${orderDir}
    LIMIT ${limit + 1}
  `

    const result = await reader.execute(query)
    const rows = extractRows(result)

    const hasMore = rows.length > limit
    const trimmed = hasMore ? rows.slice(0, limit) : rows

    // The cursor is derived AFTER the visibility filter below, from the rows
    // this viewer actually got. `hasMore` stays on the pre-filter rows.

    // If we queried ASC (for "after"), reverse to get DESC order for client
    const orderedRows = after ? [...trimmed].reverse() : trimmed
    // ONE visibility filter for both paths, so no row is ever filtered twice.
    // Direct participant: the messages SELECT policy (P2b-T08) already removed
    // every row this viewer cannot see, so this pass is belt and suspenders and
    // must never drop anything. If it ever does, the policy is misconfigured:
    // the row is dropped anyway and the miss is logged. The log line carries
    // ids and scopes, never content.
    // Sub-run drill-down (FX1): that read is privileged and skips the policy
    // entirely, so here the same predicate is the REAL gate, unchanged.
    const drilldownGrants = viewerGrants
    const messageRows = orderedRows.filter((r: any) => {
      if (
        isMessageVisible(
          { requiredScopes: r.required_scopes, disclosureList: r.disclosure_list },
          viewer,
        )
      ) {
        return true
      }
      if (drilldownGrants === null) {
        log.error(
          { orgId, threadId, userId, messageId: r.id, requiredScopes: r.required_scopes },
          "messages_select returned a row the viewer cannot see: dropped by the app level mirror",
        )
      }
      return false
    })

    // A cursor handed back to the client must be a row the client can SEE. On
    // the sub-run drill-down the page is read privileged and the filter above
    // is the REAL gate, so taking the continuation point from the pre-filter
    // rows echoed a hidden message's id. In DESC order (no cursor, or `before`)
    // the continuation point is the OLDEST row of the page, i.e. the last
    // visible one; for an `after` page `orderedRows` was reversed, so it is the
    // first. When every row on the page is hidden there is no visible
    // continuation point and the cursor is null while `hasMore` stays true: the
    // client pages on from the oldest row it already holds, which is what
    // apps/web does (message-store loads older with `before=<its own oldest>`).
    const cursorRow = hasMore
      ? after
        ? messageRows[0]
        : messageRows[messageRows.length - 1]
      : null

    const toVisibilityRow = (r: any): IdentifiedVisibilityMessage => ({
      id: r.id,
      requiredScopes: r.required_scopes,
      disclosureList: r.disclosure_list,
    })

    // Where this viewer's hidden messages sit (P2b-T12). The drill-down already
    // holds the whole page unfiltered. On the participant path RLS removed those
    // rows before they reached us, so the window is re-read privileged, bounded
    // by the page's own oldest and newest VISIBLE rows: a run therefore
    // describes a gap strictly INSIDE the page the caller got, always anchored
    // to a message the caller can see, and a run lying entirely outside that
    // window is reported by whichever page surrounds it. Only positions and
    // counts leave here, never a hidden message's id, scopes or content. The
    // mirror is not a gate on this read: on the two degenerate inputs where it
    // is looser than the policy it would undercount a run, never reveal a row.
    // The window JOINs kernel.users exactly as the page query above does, so it
    // counts only rows the page could actually show. `messages.author_id` has
    // no FK to `users`, so an author row really can be gone; such a message
    // reaches NOBODY, and counting it here would both mis-describe the page the
    // caller got and advertise a scoped message the product never renders.
    //
    // A RUN AT AN END OF THE THREAD. Clamping both ends of that window to the
    // page's oldest and newest VISIBLE rows dropped every hidden message sitting
    // past them, and "the surrounding page reports it" only holds for a gap with
    // a page on both sides. The newest end has none: an agent's scoped answer is
    // the last row in the thread, so the everyday case, a DM whose final turn
    // the viewer may not read, reported no run at all and the marker could never
    // render. So each end of the window is clamped only when there IS a further
    // page beyond it, and left open when this page reaches that end of the
    // thread. `hasMore` is computed on the rows the READ returned, i.e. rows
    // this viewer can see, which is exactly the question being asked: "is there
    // another page to report that run instead".
    //   - newest end: a `before` cursor means newer rows exist by construction;
    //     an `after` page has newer rows only while `hasMore`; a first page (no
    //     cursor) starts at the newest row of the thread.
    //   - oldest end: an `after` page starts at its cursor, a row the caller
    //     already holds; a DESC page has older rows only while `hasMore`.
    // An open end anchors its run at the thread's edge: `afterMessageId` null
    // for a leading run, exactly as countHiddenRuns already reports it. Nothing
    // new escapes: a run is still a count plus the id of a visible message.
    let runSource: IdentifiedVisibilityMessage[] = []
    if (drilldownGrants !== null) {
      runSource = [...orderedRows].reverse().map(toVisibilityRow)
    } else {
      const openNewest = before ? false : after ? !hasMore : true
      const openOldest = after ? false : !hasMore
      const newestId = messageRows.length > 0 ? messageRows[0].id : null
      const oldestId = messageRows.length > 0 ? messageRows[messageRows.length - 1].id : null
      // A page with no visible row at all is left exactly as it was: it has no
      // anchor to clamp a closed end to, and reading an unbounded window for it
      // would scan the whole thread to report a run against nothing the viewer
      // can see. Such a page renders no marker, as before.
      const readable = messageRows.length > 0
      if (readable) {
        const lowerBound =
          openOldest || oldestId === null
            ? drizzleSql``
            : drizzleSql`AND (m.created_at, m.id) >= ((SELECT created_at FROM ${k}.messages WHERE id = ${oldestId}), ${oldestId}::uuid)`
        const upperBound =
          openNewest || newestId === null
            ? drizzleSql``
            : drizzleSql`AND (m.created_at, m.id) <= ((SELECT created_at FROM ${k}.messages WHERE id = ${newestId}), ${newestId}::uuid)`
        runSource = extractRows<{
          id: string
          required_scopes: string[]
          disclosure_list: string[] | null
        }>(
          await withPrivilegedDb(orgId, "threads.listMessages:hidden-runs", (ptx) =>
            ptx.execute(drizzleSql`
            SELECT m.id, m.required_scopes, m.disclosure_list
            FROM ${k}.messages m
            JOIN ${k}.users u ON u.id = m.author_id
            WHERE m.thread_id = ${threadId} AND m.org_id = ${orgId}
              ${viewClause}
              ${lowerBound}
              ${upperBound}
            ORDER BY m.created_at ASC, m.id ASC`),
          ),
        ).map(toVisibilityRow)
      }
    }
    const hiddenRuns = countHiddenRuns(runSource, viewer)

    // Fetch attachments parented to kernel:message for all returned ids in a single query.
    // A deleted message shows no attachments, whatever rows may remain for it.
    const ids: string[] = messageRows.filter((r: any) => r.deleted_at == null).map((r: any) => r.id)
    const attachmentRows =
      ids.length === 0
        ? []
        : extractRows<{
            id: string
            entity_id: string
            filename: string
            mime_type: string
            size_bytes: number | string
            storage_key: string
            thumbnail_key: string | null
            disposition: string
            content_id: string | null
            ordinal: number
            created_at: Date | string
          }>(
            await reader.execute(drizzleSql`
            SELECT id::text AS id, entity_id, filename, mime_type, size_bytes,
                   storage_key, thumbnail_key, disposition, content_id, ordinal, created_at
            FROM ${k}.files
            WHERE app = 'kernel' AND entity_type = 'message'
              AND entity_id IN (${drizzleSql.join(
                ids.map((id) => drizzleSql`${id}`),
                drizzleSql`, `,
              )})
            ORDER BY ordinal ASC, created_at ASC, id ASC
          `),
          )

    const attachmentsByMessage = new Map<string, Array<Record<string, unknown>>>()
    for (const row of attachmentRows) {
      const list = attachmentsByMessage.get(row.entity_id) ?? []
      list.push({
        id: row.id,
        filename: row.filename,
        mimeType: row.mime_type,
        sizeBytes: Number(row.size_bytes),
        thumbnailKey: row.thumbnail_key,
        disposition: row.disposition,
        contentId: row.content_id,
        ordinal: row.ordinal,
        createdAt: row.created_at,
      })
      attachmentsByMessage.set(row.entity_id, list)
    }

    return {
      messages: messageRows.map((r: any) => ({
        id: r.id,
        threadId: r.thread_id,
        authorId: r.author_id,
        // The SPEAKING agent (A8), straight off the row. Without it the read
        // side could only fall back to the persisted label, and an agent the
        // member had named by handle came back as the generic agent label.
        authorAgentId: r.author_agent_id ?? null,
        // P3b: the message this one is nested under. Null on every human facing
        // turn, which is every row written before the column existed.
        parentMessageId: r.parent_message_id ?? null,
        // 0112: the reply thread this row lives in (null on a channel
        // message), and whether it was also sent to the channel.
        replyRootId: r.reply_root_id ?? null,
        alsoInChannel: r.also_in_channel === true,
        // The reply summary a root shows (S3); zero on every other row.
        replyCount: r.reply_count ?? 0,
        lastReplyAt: r.last_reply_at ?? null,
        replyAuthors: replyAuthorsOf(r.reply_authors),
        // The AUTHORING AGENT'S CURRENT NAME, so a rename reaches every turn
        // that agent ever wrote. The persisted label is kept only where it is
        // the only truth: a run attribution ("Routine daily-digest" names the
        // run, not the speaker) and a row whose agent is gone.
        authorName:
          r.author_type === "agent"
            ? agentAuthorDisplayName({
                persistedLabel: (r.metadata as { agentAuthorLabel?: string } | null)
                  ?.agentAuthorLabel,
                liveAgentName: r.author_agent_name,
                liveAgentKind: r.author_agent_kind,
                liveAgentOwnerName: r.author_agent_owner_name,
              })
            : r.author_name,
        authorAvatarUrl: r.author_avatar_url,
        authorType: r.author_type,
        content: r.content,
        mentions: r.mentions,
        // The withheld block on an agent reply belongs to the ONE member whose
        // turn withheld: the row is shared into the room, so this read is what
        // keeps the card per user (P4b-D1).
        metadata: projectMessageMetadataForViewer(r.metadata ?? null, userId),
        // WHY A REPLY IS HIDDEN TO THE REST OF THE ROOM. The row's scope tag
        // was projected to nobody, so the one member who can act on it (the
        // requester, an admin) had no way to see what the turn was tagged with
        // and no way to explain the gap to anyone. Projected ONLY to a viewer
        // who holds every scope on the row: a DISCLOSED viewer reads the
        // message without holding its scopes, and handing them the names would
        // be the enumeration A14 closes. Absent, never empty, for everyone
        // else: `[]` would say "this row carries no scoped data".
        ...(viewerHoldsEveryScope({ requiredScopes: r.required_scopes }, viewer)
          ? { requiredScopes: (r.required_scopes ?? []) as string[] }
          : {}),
        reactions: r.reactions ?? [],
        attachments: attachmentsByMessage.get(r.id) ?? [],
        editedAt: r.edited_at,
        deletedAt: r.deleted_at,
        createdAt: r.created_at,
      })),
      cursor: cursorRow?.id ?? null,
      hasMore,
      // `hasMore` is still derived from the rows the DATABASE returned, BEFORE
      // the visibility filter, so paging stays honest: a page shortened by a
      // hidden row keeps hasMore true, and a caller must never read a short
      // page as the end of the thread (T14 pins this). The cursor is the one
      // half that moved to the filtered rows, because it is the only half that
      // travels back to the client as a message id.
      hiddenRuns,
    }
  }

  // Direct participant → read under RLS (the policy is the authorization). Sub-run
  // drill-down → read privileged (authorization was already enforced in code above).
  return viewerGrants !== null
    ? await withPrivilegedDb(orgId, "threads.listMessages:subrun-read", (ptx) =>
        readBody(ptx as unknown as Pick<RlsClient, "execute">),
      )
    : await readBody(db)
}

/**
 * ONE REPLY THREAD (S4): its root and its replies, oldest first, paged like
 * the channel list (the newest page first, `before` for older, `after` for
 * newer). Both reads run on the caller's client, so under RLS a root the
 * caller cannot see is `null` (the route's 404), never an empty page. A
 * deleted root still comes back, content withheld, so its replies stay
 * readable under "message deleted".
 */
export async function listReplies(
  db: RlsClient,
  params: {
    orgId: string
    userId: string
    threadId: string
    rootId: string
    limit: number
    before?: string
    after?: string
  },
) {
  const { orgId, userId, threadId, rootId } = params
  const [rootRow] = await db
    .select({ replyRootId: messages.replyRootId })
    .from(messages)
    .where(and(eq(messages.id, rootId), eq(messages.threadId, threadId), eq(messages.orgId, orgId)))
    .limit(1)
  if (!rootRow) return null
  if (rootRow.replyRootId) {
    throw new ReplyThreadError(400, "not_a_root", "That message is a reply, not a thread root")
  }
  const rootPage = await listMessages(db, {
    orgId,
    userId,
    threadId,
    limit: 1,
    view: { kind: "message", id: rootId },
  })
  const root = rootPage?.messages[0]
  if (!root) return null
  const page = await listMessages(db, {
    orgId,
    userId,
    threadId,
    limit: params.limit,
    before: params.before,
    after: params.after,
    view: { kind: "replies", rootId },
  })
  if (!page) return null
  return {
    root,
    // The list read answers newest first; a reply thread reads top down.
    replies: [...page.messages].reverse(),
    cursor: page.cursor,
    hasMore: page.hasMore,
    hiddenRuns: page.hiddenRuns,
  }
}

/**
 * THE REPLY THREADS THIS USER FOLLOWS (S7), unread first, then by last reply,
 * newest first. One read under the caller's RLS: the messages policy drops a
 * root the caller may no longer read, and the membership join drops every
 * thread of a channel the caller has left (A2). A row whose replies were all
 * deleted has nothing to show and is left out.
 */
export async function listFollowedReplies(
  db: RlsClient,
  params: { orgId: string; userId: string; limit?: number },
) {
  const { orgId, userId } = params
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 100)
  const k = drizzleSql.raw(schemaRef("kernel"))
  const rows = extractRows<{
    root_id: string
    thread_id: string
    author_id: string
    author_type: string
    author_agent_id: string | null
    content: string | null
    created_at: Date | string
    deleted_at: Date | string | null
    agent_label: string | null
    author_name: string | null
    author_avatar_url: string | null
    agent_name: string | null
    agent_kind: string | null
    agent_owner_name: string | null
    channel_name: string | null
    reply_count: number
    last_reply_at: Date | string
    unread_count: number
  }>(
    await db.execute(drizzleSql`
      SELECT f.root_message_id AS root_id, f.thread_id,
             m.author_id, m.author_type, m.author_agent_id,
             CASE WHEN m.deleted_at IS NULL THEN m.content END AS content,
             m.created_at, m.deleted_at,
             m.metadata->>'agentAuthorLabel' AS agent_label,
             u.name AS author_name, u.avatar_url AS author_avatar_url,
             ag.display_name AS agent_name,
             ag.kind::text AS agent_kind, ago.name AS agent_owner_name,
             COALESCE(t.title, (
               SELECT string_agg(ou.name, ', ' ORDER BY ou.name)
               FROM ${k}.thread_participants otp
               JOIN ${k}.users ou ON ou.id = otp.user_id
               WHERE otp.thread_id = t.id AND otp.user_id <> ${userId}
             )) AS channel_name,
             stats.reply_count, stats.last_reply_at, stats.unread_count
      FROM ${k}.reply_thread_followers f
      JOIN ${k}.messages m ON m.id = f.root_message_id AND m.thread_id = f.thread_id
      JOIN ${k}.thread_participants tp
        ON tp.thread_id = f.thread_id AND tp.user_id = f.user_id AND tp.org_id = f.org_id
      JOIN ${k}.threads t ON t.id = f.thread_id
      LEFT JOIN ${k}.users u ON u.id = m.author_id
      LEFT JOIN ${k}.agents ag ON ag.id = m.author_agent_id AND ag.org_id = m.org_id
      LEFT JOIN ${k}.users ago ON ago.id = ag.owner_user_id
      CROSS JOIN LATERAL (
        SELECT COUNT(*)::int AS reply_count,
               MAX(r.created_at) AS last_reply_at,
               (COUNT(*) FILTER (
                 WHERE r.created_at > COALESCE(f.last_read_at, '-infinity'::timestamptz)
                   AND NOT (r.author_id = ${userId} AND r.author_type = 'user')
               ))::int AS unread_count
        FROM ${k}.messages r
        WHERE r.reply_root_id = f.root_message_id AND r.thread_id = f.thread_id
          AND r.deleted_at IS NULL
          -- Replies only: a system line (an agent's seat line) neither counts,
          -- nor dates the thread, nor reads as unread.
          AND r.author_type IN ('user', 'agent')
      ) stats
      WHERE f.org_id = ${orgId} AND f.user_id = ${userId} AND stats.reply_count > 0
      ORDER BY (stats.unread_count > 0) DESC, stats.last_reply_at DESC, f.root_message_id
      LIMIT ${limit}
    `),
  )
  return rows.map((r) => ({
    rootMessage: {
      id: r.root_id,
      threadId: r.thread_id,
      authorId: r.author_id,
      authorName:
        r.author_type === "agent"
          ? agentAuthorDisplayName({
              persistedLabel: r.agent_label,
              liveAgentName: r.agent_name,
              liveAgentKind: r.agent_kind,
              liveAgentOwnerName: r.agent_owner_name,
            })
          : r.author_name,
      authorAvatarUrl: r.author_type === "agent" ? null : r.author_avatar_url,
      authorType: r.author_type,
      authorAgentId: r.author_agent_id,
      content: r.content,
      createdAt: r.created_at,
      deletedAt: r.deleted_at,
    },
    channel: { id: r.thread_id, name: r.channel_name },
    replyCount: r.reply_count,
    lastReplyAt: r.last_reply_at,
    unreadCount: r.unread_count,
  }))
}

/**
 * Moves the caller's read mark on one reply thread to now (S7). `null` when
 * the root is not a message the caller can read (the route's 404). Reading a
 * thread one does not follow is not an error and records nothing.
 */
export async function markRepliesRead(
  db: RlsClient,
  params: { orgId: string; userId: string; threadId: string; rootId: string },
): Promise<{ ok: true; following: boolean } | null> {
  const [root] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.id, params.rootId),
        eq(messages.threadId, params.threadId),
        eq(messages.orgId, params.orgId),
        isNull(messages.replyRootId),
      ),
    )
    .limit(1)
  if (!root) return null
  const updated = await db
    .update(replyThreadFollowers)
    .set({ lastReadAt: new Date() })
    .where(
      and(
        eq(replyThreadFollowers.rootMessageId, params.rootId),
        eq(replyThreadFollowers.userId, params.userId),
        eq(replyThreadFollowers.orgId, params.orgId),
      ),
    )
    .returning({ userId: replyThreadFollowers.userId })
  // The followup notification for this root is read with it (THR-08). Keyed
  // on the root (`thread_followup` targets `reply_thread`), so the reader's
  // followups on other roots stay unread.
  const k = drizzleSql.raw(schemaRef("kernel"))
  await db.execute(drizzleSql`
    UPDATE ${k}.attention_events
       SET read_at = now()
     WHERE org_id = ${params.orgId}
       AND user_id = ${params.userId}
       AND app = 'kernel'
       AND entity_type = 'reply_thread'
       AND entity_id = ${params.rootId}
       AND read_at IS NULL`)
  return { ok: true, following: updated.length > 0 }
}

/**
 * The line a room sees when a mention pulls an agent in: the SAME join line a
 * room gets when a person is added, "{adder} added {agent}", carrying the
 * agent's display name rather than its handle. It is an EVENT, not a post by
 * the person who mentioned: `metadata.type` marks it `participant-added` so
 * every surface renders it as a muted system line with no author and no
 * avatar, and the stored `content` stays a readable English fallback for
 * anything that reads rows rather than metadata (search, agent context).
 * Written by the SAME transaction as the seat itself, so neither can exist
 * without the other.
 */
export async function postAgentAutoAddSystemMessage(
  db: RlsClient,
  params: {
    orgId: string
    threadId: string
    /** Whose message triggered the auto-add: the row's author_id. */
    actorUserId: string
    adderName: string
    /** The agent's DISPLAY name. A room reads names, not handles. */
    agentName: string
    /** The reply thread the mention was made in: the line is told there. */
    replyRootId?: string | null
  },
) {
  return postThreadSystemMessage(db, {
    replyRootId: params.replyRootId ?? null,
    orgId: params.orgId,
    threadId: params.threadId,
    actorUserId: params.actorUserId,
    authorName: params.adderName,
    content: `${params.adderName} added ${params.agentName}`,
    metadata: {
      type: "participant-added",
      participantKind: "agent",
      actorName: params.adderName,
      participantName: params.agentName,
    },
  })
}

/**
 * ONE writer for every system line a room is told (the auto-add line above, a
 * dispatch refusal). Row plus `message:create` event, so a line written while
 * the room is open reaches it live rather than only on the next reload.
 */
export async function postThreadSystemMessage(
  db: RlsClient,
  params: {
    orgId: string
    threadId: string
    /** Whose message triggered the line: the row's author_id. */
    actorUserId: string
    /** Who the room sees the line attributed to. */
    authorName: string
    content: string
    /** Structured shape of the event, so a surface can render the line in the
     *  reader's language instead of echoing the stored English sentence. */
    metadata?: Record<string, unknown>
    /**
     * The reply thread the line belongs in (A7): a dispatch refused inside a
     * reply thread is told there, not in the channel. The line then carries
     * its root's scope tag, like every reply (A2).
     */
    replyRootId?: string | null
  },
) {
  const content = maskWithNote(params.content).text
  const metadata = params.metadata ?? null
  const replyRootId = params.replyRootId ?? null
  let requiredScopes: string[] = []
  let disclosureList: string[] | null = null
  if (replyRootId) {
    const [root] = await db
      .select({ requiredScopes: messages.requiredScopes, disclosureList: messages.disclosureList })
      .from(messages)
      .where(and(eq(messages.id, replyRootId), eq(messages.threadId, params.threadId)))
      .limit(1)
    if (root)
      ({ requiredScopes, disclosureList } = inheritVisibility(
        { requiredScopes, disclosureList },
        root,
      ))
  }
  const [msg] = await db
    .insert(messages)
    .values({
      threadId: params.threadId,
      orgId: params.orgId,
      authorId: params.actorUserId,
      authorType: "system",
      content,
      ...(metadata ? { metadata } : {}),
      // Membership is not scoped data: everyone in the room may read who joined.
      requiredScopes,
      disclosureList,
      replyRootId,
    })
    .returning({ id: messages.id, createdAt: messages.createdAt })

  // The room is WATCHING when this is written: the mention that seated the
  // agent came from the composer of an open channel. Every other message write
  // queues its own `message:create`, and this one did not, so the line reached
  // only readers who reloaded the thread afterwards. Same transaction as the
  // row and the seat, so the three still cannot exist apart.
  const participantRows = await db
    .select({ userId: threadParticipants.userId })
    .from(threadParticipants)
    .where(eq(threadParticipants.threadId, params.threadId))
  await db.queueEvent({
    app: "kernel",
    entity: "message",
    action: "create",
    entityId: msg.id,
    orgId: params.orgId,
    actorId: params.actorUserId,
    actorType: "system",
    data: {
      id: msg.id,
      threadId: params.threadId,
      authorId: params.actorUserId,
      authorName: params.authorName,
      authorType: "system",
      authorAgentId: null,
      parentMessageId: null,
      replyRootId,
      alsoInChannel: false,
      content,
      preview: messagePreview(content),
      participantIds: participantRows.map((p) => p.userId),
      mentions: null,
      metadata,
      requiredScopes,
      disclosureList,
      createdAt: msg.createdAt,
    },
  })
  return { id: msg.id, content, createdAt: msg.createdAt }
}

/**
 * Mark every checkpoint and every episode built from a now deleted message as
 * stale (P4m-T23, spec-memory.md "Scope and privacy rules"). A checkpoint is
 * covered when its summarized region ends at or after the deleted message; an
 * episode when the message falls inside its recorded range.
 *
 * Privileged, because the artefacts belong to AGENTS and the human deleting
 * the message owns neither: the rows are not readable or writable under that
 * human's RLS context, and refusing to mark them would leave a summary quoting
 * a deleted message for the life of the thread. Nothing is read back into the
 * request, only two UPDATEs of a boolean-shaped timestamp.
 */
async function markArtefactsStaleForDeletedMessage(params: {
  orgId: string
  threadId: string
  messageId: string
}): Promise<void> {
  const { orgId, threadId, messageId } = params
  try {
    await withPrivilegedDb(orgId, "message-delete-mark-stale", async (tx) => {
      await tx.execute(drizzleSql`
        UPDATE ${K()}.agent_thread_checkpoints c
           SET stale_at = now()
         WHERE c.org_id = ${orgId}
           AND c.thread_id = ${threadId}
           AND EXISTS (
             SELECT 1 FROM ${K()}.messages upto, ${K()}.messages gone
              WHERE upto.id = c.upto_message_id
                AND gone.id = ${messageId}
                AND (upto.created_at, upto.id) >= (gone.created_at, gone.id)
           )`)
      await tx.execute(drizzleSql`
        UPDATE ${K()}.agent_memory m
           SET stale_at = now()
         WHERE m.org_id = ${orgId}
           AND m.type = 'episode'
           AND m.source_thread_id = ${threadId}
           AND EXISTS (
             SELECT 1 FROM ${K()}.messages gone, ${K()}.messages f, ${K()}.messages t
              WHERE gone.id = ${messageId}
                AND f.id = m.episode_from_message_id
                AND t.id = m.episode_to_message_id
                AND (gone.created_at, gone.id) >= (f.created_at, f.id)
                AND (gone.created_at, gone.id) <= (t.created_at, t.id)
           )`)
    })
  } catch (err) {
    log.error(
      { err, orgId, threadId, messageId },
      "Could not mark checkpoints and episodes stale for a deleted message",
    )
  }
}
