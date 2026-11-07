// SPDX-License-Identifier: FSL-1.1-ALv2

import {
  type CardLabel,
  type MessageQuote,
  PERSONAL_AGENT_DISPLAY_NAME,
  type ResolvedCard,
} from "@liaison/shared"
import { createSignal } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { getAppTabAction } from "~/framework/app-registry"
import { subscribeResync } from "~/framework/resync"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { userFromToken } from "~/modules/auth/auth-store"
import { runMessageAsLocalTurn } from "~/modules/desktop/desktop-store"
import { tNow } from "~/modules/i18n/i18n-context"
import { openTab } from "~/modules/shell/tab-store"
import { getAgentDisplay } from "~/modules/threads/agent-directory"
import { localizeAgentNotice } from "~/modules/threads/agent-notice"
import { currentClientSurface } from "~/modules/threads/client-surface"
import { localRuntimeAgentFor, requireLocalSession } from "~/modules/threads/local-runtime-send"
import { retryLostSend } from "~/modules/threads/send-retry"
import { handleTypingEvent } from "~/modules/threads/thread-store"

export interface ToolCallState {
  toolCallId: string
  toolName: string
  args?: any
  result?: any
  status: "pending" | "running" | "completed" | "error"
  /** A step's one-line summary, when its producer gives one (a node chat step). */
  summary?: string
  /** The registry's facts on an app tool, on the live `tool_call` frame and the stored call. */
  readOnly?: boolean
  appLabel?: string
  runningLabel?: string
  runningLabelKey?: string
  /** The result's card, resolved by the server when the call returned (never rebuilt here). */
  card?: ResolvedCard
  /** A failed call of a tool that declares a card: the error card is drawn under this pill. */
  cardError?: { pill: CardLabel }
  /** Absent means 1. Each replace from a card action adds one. */
  cardRevision?: number
  /** A newer card with the same key lives in this thread: this one draws collapsed. */
  cardSuperseded?: true
}

/**
 * One entry in an agent turn's chronological timeline: a run of reasoning text, a
 * run of answer text, or a tool call, in the exact order the model emitted them. Lets the UI render a
 * tool call at the point in the thinking where it was invoked instead of dumping
 * every call after the whole thinking block. Tool entries carry only the id — the
 * full call lives once in `toolCalls`, joined on by the renderer.
 */
export type TurnTimelineEntry =
  | { kind: "reasoning"; text: string; itemId?: string }
  | { kind: "tool"; toolCallId: string; itemId?: string }
  | { kind: "text"; text: string; itemId?: string }

export interface SubRunMetadata {
  runId: string
  hiddenThreadId: string
  agentType: string
  label: string
  status: "queued" | "running" | "done" | "failed" | "cancelled"
  summary: string | null
  usage: {
    promptTokens: number
    completionTokens: number
    creditCost: string
  }
}

export interface MessageMetadata {
  /** An agent's reply: the message that started the turn it answers (the
   *  `turnId` its live frames carried), so the reply ends that turn's block. */
  turnId?: string
  /** An agent's reply: the PERSON'S message it answers. The same as `turnId`
   *  except on the turn an approved call handed back, whose trigger is the
   *  result row; absent on replies saved before it was recorded. Rendered as
   *  `data-turn-id` (`askId ?? turnId`). */
  askId?: string
  type?:
    | "compaction_summary"
    | "approval-created"
    | "approval-decision"
    | "approval-error"
    /** An approved call's output handed back to the agent (the result rides in
     *  `result`, for the agent's transcript). Rendered as a muted line. */
    | "approval-result"
    /** A membership EVENT, not a post: somebody (or a mention) added a
     *  participant. Rendered as a muted centered line with no author and no
     *  avatar, in the reader's language, from the fields below. */
    | "participant-added"
  /** `participant-added` only: who did the adding, who was added, and whether
   *  the newcomer is an agent or a person. */
  actorName?: string
  participantName?: string
  participantKind?: "agent" | "user"
  /** P4 node routing line (a system row): the request went to someone's node
   *  (`nodeQueued`), or was refused there in words (`nodeRefusal`). */
  nodeJobId?: string
  nodeQueued?: boolean
  nodeRefusal?: string
  /** A turn the server refused before it ran (a demo's spend gate): the row
   *  says why, in the reader's words, and is the one place the refusal shows. */
  demoRefusal?: string
  /** Any turn the server refused before it ran (no model for Auto, no usage
   *  left, a demo's spend gate): the row is the one place the refusal shows
   *  (turn-refusal.ts). */
  turnRefusal?: boolean
  /** A refused turn whose way out is Billing (unpaid renewal, no credits left). */
  billingRefusal?: string
  /** D22: a node answer posted back to the asking thread. The job thread it
   *  came from, and the node owner, the one reader who can open it. */
  nodeResultThreadId?: string
  nodeOwnerUserId?: string
  nodeAnswerWithheld?: boolean
  /** A routine's report posted in the conversation it was asked in (0166): the
   *  routine, its output thread (the full run), and its owner, the one reader
   *  sure to be seated there. */
  routineReport?: {
    routineId: string
    routineName: string
    outputThreadId: string
    ownerUserId: string
  }
  /** An approval a routine's run asked for, in the conversation the routine
   *  posts to: the row is drawn as that request's live card. */
  routineApproval?: {
    requestId: string
    handle: string
    toolName: string
    routineId: string
    routineName: string
    outputThreadId: string
  }
  /** The "Routine <name> is running" line of a run, settled when it ends. */
  routineRun?: {
    routineId: string
    routineName: string
    outputThreadId: string
    ownerUserId: string
    runKey: string
    /** `waiting_approval`: the run paused on a gated call and resumes once it is decided. */
    status: "running" | "waiting_approval" | "succeeded" | "failed"
    /** A follow-up run that ended with drafts still waiting for a person: how many. */
    draftsWaiting?: number
  }
  /** §1.4.5 — discriminator for sub-agent dispatch cards. When `"sub_run"`,
   *  the renderer dispatches to `SubRunCard` and `subRun` carries the live state. */
  kind?: "sub_run"
  subRun?: SubRunMetadata
  modelId?: string
  toolCalls?: ToolCallState[]
  stepCount?: number
  usage?: { promptTokens: number; completionTokens: number; reasoningTokens?: number }
  finishReason?: string
  /** Persisted reasoning/thinking text (full or summary) for the thinking block. */
  reasoning?: string
  /** Chronological interleave of reasoning runs and tool calls (see TurnTimelineEntry).
   *  Absent on messages persisted before this shipped — the renderer then falls back
   *  to the flat reasoning-then-tools layout. */
  timeline?: TurnTimelineEntry[]
  /** The reasoning level this turn ran at ("low" | "medium" | "high"); absent when off. */
  reasoningLevel?: string
  /** Attributed display label for an agent-authored message — "{User}'s agent" / "Routine {name}". */
  agentAuthorLabel?: string
  /** Approval linkage — present on system "approval-created" messages so the
   *  approval thread can render the live ApprovalCard inline at this position
   *  (the same way agent-chat tool-call rows embed the card). `requestId` is the
   *  approval request UUID; `requestHandle` is its URL-safe handle (older
   *  messages predating `requestId` are resolved by handle). */
  requestId?: string
  requestHandle?: string
  /** `approval-result` only: the approved call's output, as the agent reads it. Never rendered. */
  result?: string
  /** `approval-result` of an approved request_secret: the card it filed, drawn under the line. */
  secretRequestId?: string
  /** `already_posted`: the same card was already in the conversation, so none is drawn again. */
  secretCard?: "posted" | "already_posted"
  /** `approval-created` only: who asked, by the requester rule (a role or
   *  system agent's request is the agent's, never its human's). Absent on
   *  greetings written before it was stamped. */
  requesterKind?: "agent" | "user"
  requesterName?: string
  /** `approval-decision` only: which lifecycle transition this notice reports.
   *  Expiry stamps the handle above too, so the line can name its approval
   *  rather than repeat one sentence once per expired request. */
  decision?: "expired" | "denied" | "reverted" | "approved" | "edited" | "withdrawn" | "cancelled"
  /** `approval-decision` only: the person who decided it. Absent on a notice
   *  nobody decided (an expiry, a cancellation), which is exactly the notice
   *  that renders as a muted system line rather than a decision row. */
  actorId?: string
  /** What the room floor made this turn leave out, for the requester only. The
   *  server projects it per viewer on both the read path and the socket, so a
   *  copy that carries it is a copy meant for this reader. */
  withheld?: {
    requesterId?: string
    turnId?: string
    items?: Array<{ label: string; nonDisclosable?: boolean; scopeTainted?: boolean }>
  }
  /** The excerpt this message quotes, as the server resolved and stored it:
   *  the quoted author comes from the row, never from the client. */
  quote?: MessageQuote
}

export interface AgentStreamError {
  message: string
  code?: string
}

export interface AgentStreamState {
  state: "idle" | "streaming" | "complete" | "error"
  content: string
  /** Live reasoning/thinking text accumulated from agent_stream:reasoning deltas. */
  reasoning: string
  /** True while reasoning deltas are arriving; flips off once the answer begins. */
  reasoningStreaming: boolean
  toolCalls: ToolCallState[]
  /** Ordered reasoning/tool interleave built live from the WS event order. */
  timeline: TurnTimelineEntry[]
  error: AgentStreamError | null
  /** Epoch ms of the last stream frame for this turn, 0 while idle. A running
   *  turn that stops producing frames is what the Stuck label keys off. */
  lastActivityAt: number
  /** The reply thread this turn answers in (A7), null for a channel turn. A
   *  turn started in a reply thread streams into that thread's panel, never
   *  into the channel list. */
  replyRootId?: string | null
  /** The message that started this turn (`turnId` on its frames), null when the
   *  producer names none. Two turns of ONE agent can overlap in a conversation
   *  (a newer request replaces a running one): each frame, and the reply the
   *  turn persists, says which turn it is, so one turn's end never ends the
   *  other's live block. */
  turnId?: string | null
  /** The PERSON'S message this turn answers (`askId` on its frames): `turnId`,
   *  except on the turn an approved call handed back. Rendered as
   *  `data-turn-id` (`askId ?? turnId`); never a key. */
  askId?: string | null
  /** The `seq` of the last frame of this turn drawn here (S28), 0 before any
   *  or from a server that sends none. A frame at or below it is a repeat. */
  lastSeq?: number
  /** Replies of this turn's agent that landed without naming the turn (the
   *  outbox's copy, written before the reply's metadata): stored, but not
   *  drawn while this block is the turn's view, so the answer never shows
   *  twice. The copy that names the turn ends the block and draws the row. */
  heldReplyIds?: string[]
}

export interface MessageAttachment {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  thumbnailKey?: string | null
  thumbnailUrl?: string | null
  disposition?: "inline" | "attachment"
  contentId?: string | null
  ordinal?: number
}

export interface Message {
  id: string
  threadId: string
  authorId: string
  authorName: string
  authorAvatarUrl: string | null
  authorType: string
  /** The `kernel.agents` id of the authoring agent, null for a human or
   *  system author (and for agent messages predating the column). */
  authorAgentId: string | null
  /** The message this one is nested under (P3b). Null is the audience
   *  asymmetry: a human facing turn is flattened to the thread root, an agent
   *  to agent exchange nests under the message that triggered it. Optional, so
   *  a row built before this shipped (and every test fixture) reads as flat. */
  parentMessageId?: string | null
  content: string | null
  mentions: any[] | null
  metadata?: MessageMetadata | null
  reactions: Array<{
    emoji: string
    count: number
    users: Array<{ id: string; name: string }>
    reacted: boolean
  }>
  attachments?: MessageAttachment[]
  editedAt: string | null
  deletedAt: string | null
  createdAt: string
  pending?: boolean
  /** The reply thread this message lives in (S1), null or absent on a channel
   *  message. A reply is never a root. */
  replyRootId?: string | null
  /** A reply the author also sent to the channel ("Also send to channel"). */
  alsoInChannel?: boolean
  /** The reply summary a root shows (S3): zero or absent on every other row. */
  replyCount?: number
  lastReplyAt?: string | null
  /** Up to three repliers, most recent first. */
  replyAuthors?: ReplyAuthor[]
}

export interface ReplyAuthor {
  id: string
  name: string | null
  avatarUrl: string | null
}

interface ThreadMessages {
  ids: string[]
  byId: Record<string, Message>
}

/**
 * One gap of messages this viewer may not read, as the server describes it:
 * where it sits (the visible message it follows, or the top of the page when
 * null) and how many rows it spans. Nothing else: not an id, not a scope, not
 * an author. The client renders the count and nothing more.
 */
export interface HiddenRun {
  afterMessageId: string | null
  count: number
}

/**
 * One reply thread as the panel shows it: its root and its replies, oldest
 * first, keyed by the ROOT's id. Separate from the channel list on purpose: a
 * reply is not a channel message unless it was also sent there (S3), so it
 * never enters `threads[...]` on its own.
 */
export interface ReplyThreadCache {
  threadId: string
  root: Message | null
  ids: string[]
  byId: Record<string, Message>
  /** Older replies exist beyond the loaded window. */
  hasMore: boolean
  loading: boolean
  loadingMore: boolean
  error: string | null
}

interface MessageStoreState {
  threads: Record<string, ThreadMessages>
  replies: Record<string, ReplyThreadCache>
  hiddenRuns: Record<string, HiddenRun[]>
  agentStreams: Record<string, AgentStreamState>
  loading: Record<string, boolean>
  hasMore: Record<string, boolean>
  loadingMore: Record<string, boolean>
  error: Record<string, string | null>
}

const IDLE_AGENT_STREAM: AgentStreamState = {
  state: "idle",
  content: "",
  reasoning: "",
  reasoningStreaming: false,
  toolCalls: [],
  timeline: [],
  error: null,
  lastActivityAt: 0,
}

function createIdleAgentStream(): AgentStreamState {
  return { ...IDLE_AGENT_STREAM, toolCalls: [], timeline: [] }
}

const [messageStore, setMessageStore] = createStore<MessageStoreState>({
  threads: {},
  replies: {},
  hiddenRuns: {},
  agentStreams: {},
  loading: {},
  hasMore: {},
  loadingMore: {},
  error: {},
})

export { messageStore }

// --- Public accessors ---

export function getMessage(threadId: string, messageId: string): Message | undefined {
  return messageStore.threads[threadId]?.byId[messageId]
}

export function getMessages(threadId: string): Message[] {
  const tm = messageStore.threads[threadId]
  if (!tm) return []
  return tm.ids.map((id) => tm.byId[id]).filter(Boolean)
}

/**
 * One top level message with the agent to agent exchange nested under it.
 *
 * Grouping lives HERE rather than in the list component so the collapsed count
 * and the expansion state have one owner: two components asking the same
 * question would answer it differently the moment one of them re-renders.
 */
export interface NestedMessage {
  msg: Message
  /** 1 for a direct child, 2 for its child, and so on. */
  depth: number
}

export interface MessageGroup {
  msg: Message
  nested: NestedMessage[]
}

/** Replies that always render at the top level (W2-D8): the person reads them. */
const TOP_LEVEL_REPLY_KINDS: ReadonlySet<string> = new Set(["node_session_result"])

function isTopLevelReply(msg: Message): boolean {
  const kind = (msg.metadata as { kind?: unknown } | null | undefined)?.kind
  return typeof kind === "string" && TOP_LEVEL_REPLY_KINDS.has(kind)
}

/** Levels the ancestor walk reads before it gives up, so a parent cycle in the
 *  loaded window terminates instead of hanging the list. */
const MAX_NESTING_WALK = 32

/**
 * The thread as it renders: top level messages in order, each carrying its
 * nested children. A child whose parent is not in the loaded window is promoted
 * to the top level rather than dropped, because a message nobody can see is
 * worse than one shown flat.
 */
export function getGroupedMessages(threadId: string): MessageGroup[] {
  // A reply a live block still draws is not drawn twice (S28 handover).
  const held = heldLiveReplyIds(threadId)
  const msgs =
    held.size === 0 ? getMessages(threadId) : getMessages(threadId).filter((m) => !held.has(m.id))
  const byMessageId = new Map(msgs.map((m) => [m.id, m]))
  const groups: MessageGroup[] = []
  const groupByRootId = new Map<string, MessageGroup>()
  // The chain the server writes is TWO levels deep already (a human turn, the
  // question under it, the answer under the question), and an ask chain can be
  // deeper still. So the ancestor walk is a walk, not a single parent read: a
  // descendant is collected under the TOP LEVEL ancestor, at its own depth, and
  // one collapsed line covers the whole exchange.
  const ancestorOf = (msg: Message): { rootId: string; depth: number } => {
    // W2-D8: a finished computer session's post-back (S60) is written for the
    // person: it is a row of the conversation, never folded under "between
    // agents" with the card it answers.
    if (isTopLevelReply(msg)) return { rootId: msg.id, depth: 0 }
    let current = msg
    let depth = 0
    const seen = new Set<string>([msg.id])
    while (depth < MAX_NESTING_WALK) {
      const parentId = current.parentMessageId ?? null
      if (!parentId || seen.has(parentId)) break
      const parent = byMessageId.get(parentId)
      // A parent outside the loaded window promotes this message to the top
      // level: a message nobody can see is worse than one shown flat.
      if (!parent) break
      seen.add(parentId)
      current = parent
      depth++
    }
    return { rootId: current.id, depth }
  }
  for (const msg of msgs) {
    if (ancestorOf(msg).depth > 0) continue
    const group: MessageGroup = { msg, nested: [] }
    groupByRootId.set(msg.id, group)
    groups.push(group)
  }
  for (const msg of msgs) {
    const { rootId, depth } = ancestorOf(msg)
    if (depth === 0) continue
    groupByRootId.get(rootId)?.nested.push({ msg, depth })
  }
  return groups
}

/** The replies held back while the live block of their turn draws them. */
function heldLiveReplyIds(threadId: string): Set<string> {
  const prefix = `${threadId}::`
  const held = new Set<string>()
  for (const [key, stream] of Object.entries(messageStore.agentStreams)) {
    if (!key.startsWith(prefix) || stream.state === "idle") continue
    for (const id of stream.heldReplyIds ?? []) held.add(id)
  }
  return held
}

/** Which nested exchanges this viewer has opened. Per session, per message. */
const [expandedNesting, setExpandedNesting] = createSignal<Record<string, boolean>>({})

export function isNestedExpanded(messageId: string): boolean {
  return expandedNesting()[messageId] === true
}

export function toggleNestedExpanded(messageId: string): void {
  setExpandedNesting((prev) => ({ ...prev, [messageId]: !prev[messageId] }))
}

const NO_HIDDEN_RUNS: HiddenRun[] = []

/** What the last messages read reported about gaps in this thread. */
export function getHiddenRuns(threadId: string): HiddenRun[] {
  return messageStore.hiddenRuns[threadId] ?? NO_HIDDEN_RUNS
}

export function setHiddenRuns(threadId: string, runs: HiddenRun[]): void {
  setMessageStore("hiddenRuns", threadId, runs)
}

/** Reads the gap descriptions off a messages-list envelope's meta. Absent
 *  means the server said nothing about gaps, which is not the same as "no
 *  gaps": the previous answer is kept rather than being replaced with a false
 *  all-clear. An EMPTY list is an all-clear and does replace it. */
function applyHiddenRuns(threadId: string, meta: any): void {
  const runs = meta?.hiddenRuns
  if (!Array.isArray(runs)) return
  setHiddenRuns(
    threadId,
    runs
      .filter((r: any) => typeof r?.count === "number" && r.count > 0)
      .map((r: any) => ({ afterMessageId: r.afterMessageId ?? null, count: r.count })),
  )
}

/**
 * The `visibility:invalidate` frame. The server sends it when what this user
 * may read in a thread has changed (a disclosure, a scope grant, a share): it
 * carries the affected thread ids and nothing else, because the client is not
 * told what changed, only that its copy is stale. Every named thread is
 * refetched; a frame that names none is a no-op, never a blanket reload.
 */
export async function handleVisibilityInvalidate(
  frame: { threadIds?: unknown },
  refetch: (threadId: string) => Promise<void>,
): Promise<void> {
  const ids = Array.isArray(frame?.threadIds) ? frame.threadIds : []
  for (const id of ids) {
    if (typeof id !== "string" || id.length === 0) continue
    await refetch(id)
  }
}

/** The refetch `handleVisibilityInvalidate` uses in the app: drop this
 *  thread's cached page and read it again, hidden runs included. */
export async function refetchThreadMessages(threadId: string): Promise<void> {
  const api = _messageApi
  if (!api) return
  if (!messageStore.threads[threadId]) return
  await loadMessages(api, threadId)
}

/**
 * The live stream key: a thread AND an agent.
 *
 * A message that names two agents gives BOTH a turn (spec-agents.md A29/A30)
 * and the two runs overlap. Keyed on the thread alone, the second agent's
 * `start` reset the slot the first was streaming into and the first's `done`
 * marked the second complete, so the room drew one live turn and the other
 * agent showed nothing at all.
 */
export function agentStreamKey(threadId: string, agentId?: string | null): string {
  return `${threadId}::${agentId ?? ""}`
}

/**
 * The key of a turn a newer turn of the SAME agent replaced while it still
 * ran: it keeps streaming under its own key, and its block stays in the
 * conversation, until its reply lands.
 *
 * A newer request to an agent that is still answering starts a second turn
 * (on a demo the older one then stops at its next step and says it was
 * replaced). Keyed on the agent alone, the newer `start` wiped the older
 * turn's live block, and the older turn's reply and `done` then ended the
 * NEWER one's: the conversation showed no agent turn at all while the agent
 * was answering.
 */
function replacedTurnKey(threadId: string, agentId: string | null, turnId: string): string {
  return `${agentStreamKey(threadId, agentId)}#${turnId}`
}

/** The agent a stream key names (its suffix after the thread, without a replaced turn's id). */
function agentOfStreamKey(key: string, prefix: string): string | null {
  const rest = key.slice(prefix.length)
  const hash = rest.indexOf("#")
  const agentId = hash >= 0 ? rest.slice(0, hash) : rest
  return agentId === "" ? null : agentId
}

/**
 * One agent's live stream in a thread. With no agent named it answers with the
 * thread's first non-idle run, which is what a caller that knows only a thread
 * can be given.
 */
export function getAgentStream(threadId: string, agentId?: string | null): AgentStreamState {
  if (agentId !== undefined) {
    return messageStore.agentStreams[agentStreamKey(threadId, agentId)] ?? IDLE_AGENT_STREAM
  }
  const live = getLiveAgentStreams(threadId).filter((run) => !run.replaced)
  return (
    live[0]?.stream ??
    messageStore.agentStreams[agentStreamKey(threadId, null)] ??
    IDLE_AGENT_STREAM
  )
}

/**
 * The CHANNEL's run: the oldest live run that is not answering in a reply
 * thread (A7). A reply turn's state (working, failed) belongs to its root's
 * panel; read through `getAgentStream` it drew "Failed …" under the channel
 * list for a turn the channel never saw start.
 */
export function getChannelAgentStream(threadId: string): AgentStreamState {
  return (
    getLiveAgentStreams(threadId).find((run) => !run.stream.replyRootId && !run.replaced)?.stream ??
    IDLE_AGENT_STREAM
  )
}

/**
 * Every run in this thread that is not idle, oldest key first. `replaced`: a
 * turn a newer turn of the same agent replaced, still running until its reply
 * lands (`replacedTurnKey`).
 */
export function getLiveAgentStreams(
  threadId: string,
): Array<{ agentId: string | null; stream: AgentStreamState; replaced?: true }> {
  const prefix = `${threadId}::`
  const out: Array<{ agentId: string | null; stream: AgentStreamState; replaced?: true }> = []
  for (const [key, stream] of Object.entries(messageStore.agentStreams)) {
    if (!key.startsWith(prefix)) continue
    if (stream.state === "idle") continue
    const agentId = agentOfStreamKey(key, prefix)
    out.push(key.includes("#") ? { agentId, stream, replaced: true } : { agentId, stream })
  }
  // A replaced turn first: it started before the turn that replaced it.
  return out.sort(
    (a, b) =>
      Number(b.replaced === true) - Number(a.replaced === true) ||
      a.stream.lastActivityAt - b.stream.lastActivityAt,
  )
}

// --- Internal helpers ---

/** The two prefixes this app mints for a message that exists only in the
 *  browser: `pending-` from `sendMessage` here, `optimistic-msg-` from the
 *  agent panel's own send. Both are rows the server has never seen, so a
 *  refetch that does not cover them must keep them rather than drop them:
 *  matching only one prefix silently deleted the other kind mid-send. */
export function isClientMessageId(id: string): boolean {
  return id.startsWith("pending-") || id.startsWith("optimistic-")
}

function ensureThread(s: MessageStoreState, threadId: string): ThreadMessages {
  if (!s.threads[threadId]) {
    s.threads[threadId] = { ids: [], byId: {} }
  }
  return s.threads[threadId]
}

/**
 * The turns whose end this client has seen (a terminal frame, or the reply
 * naming the turn), as `replacedTurnKey`s, and a count of every end seen per
 * conversation. A stream-state snapshot is read over HTTP while the socket
 * keeps delivering frames: a snapshot read just before a turn ended can come
 * back after that turn's reply and `done`, and seeding it then brought the
 * finished answer back as a live block that nothing would ever end (a typing
 * cursor under the answer, then "Stuck", and a guided step waiting on it).
 */
const endedTurns = new Set<string>()
const turnEndsSeen: Record<string, number> = {}

function noteTurnEnded(threadId: string, agentId: string | null, turnId: unknown): void {
  turnEndsSeen[threadId] = (turnEndsSeen[threadId] ?? 0) + 1
  if (typeof turnId === "string" && turnId) {
    endedTurns.add(replacedTurnKey(threadId, agentId, turnId))
  }
}

/** True when the conversation's loaded page holds the reply that ended this turn. */
function replyLoadedForTurn(
  s: MessageStoreState,
  threadId: string,
  agentId: string | null,
  turnId: string,
): boolean {
  const t = s.threads[threadId]
  if (!t) return false
  return t.ids.some((id) => {
    const m = t.byId[id]
    return (
      m?.authorType === "agent" &&
      (m.authorAgentId ?? null) === agentId &&
      m.metadata?.turnId === turnId
    )
  })
}

/**
 * A page of messages brought the reply of a turn still drawn live (its end was
 * missed: a socket that dropped the frame, a snapshot seeded across it): the
 * turn is over, so its live block ends. Only a block naming that very turn.
 */
function endTurnsAnsweredInPage(s: MessageStoreState, threadId: string, page: Message[]): void {
  const prefix = `${threadId}::`
  for (const m of page) {
    const turnId = m.authorType === "agent" ? m.metadata?.turnId : undefined
    if (typeof turnId !== "string" || !turnId) continue
    const agentId = m.authorAgentId ?? null
    endedTurns.add(replacedTurnKey(threadId, agentId, turnId))
    for (const [key, stream] of Object.entries(s.agentStreams)) {
      if (!key.startsWith(prefix) || stream.turnId !== turnId) continue
      if (agentOfStreamKey(key, prefix) !== agentId) continue
      if (key.includes("#")) delete s.agentStreams[key]
      else s.agentStreams[key] = createIdleAgentStream()
    }
  }
}

function ensureAgentStream(
  s: MessageStoreState,
  threadId: string,
  agentId?: string | null,
): AgentStreamState {
  const key = agentStreamKey(threadId, agentId)
  if (!s.agentStreams[key]) {
    s.agentStreams[key] = createIdleAgentStream()
  }
  return s.agentStreams[key]
}

// --- Reply threads (S9, A16) ---

function ensureReplyCache(
  s: MessageStoreState,
  threadId: string,
  rootId: string,
): ReplyThreadCache {
  if (!s.replies[rootId]) {
    s.replies[rootId] = {
      threadId,
      root: null,
      ids: [],
      byId: {},
      hasMore: false,
      loading: false,
      loadingMore: false,
      error: null,
    }
  }
  return s.replies[rootId]
}

/**
 * Every copy of one message this client holds: the channel list's, the reply
 * panel's copy of a root, and the reply thread's copy of a reply (a reply also
 * sent to the channel lives in both lists). An edit, a delete or a reaction
 * applies to all of them, or the panel and the channel disagree about the
 * same message.
 */
function messageCopies(s: MessageStoreState, threadId: string, messageId: string): Message[] {
  const out: Message[] = []
  const inChannel = s.threads[threadId]?.byId[messageId]
  if (inChannel) out.push(inChannel)
  for (const cache of Object.values(s.replies)) {
    if (!cache || cache.threadId !== threadId) continue
    if (cache.root?.id === messageId) out.push(cache.root)
    const reply = cache.byId[messageId]
    if (reply) out.push(reply)
  }
  return out
}

/** The registry's facts a live `tool_call` frame carries, as the stored call keeps them. */
function toolCallPresentation(data: any): Partial<ToolCallState> {
  return {
    ...(typeof data.readOnly === "boolean" ? { readOnly: data.readOnly } : {}),
    ...(typeof data.appLabel === "string" && data.appLabel ? { appLabel: data.appLabel } : {}),
    ...(typeof data.runningLabel === "string" && data.runningLabel
      ? { runningLabel: data.runningLabel }
      : {}),
    ...(typeof data.runningLabelKey === "string" && data.runningLabelKey
      ? { runningLabelKey: data.runningLabelKey }
      : {}),
  }
}

/**
 * The stored message that holds a tool call, or null while its turn still streams (the reply is
 * written when the turn ends). A card action names this message as its `cardRef`.
 */
export function findToolCallMessage(
  toolCallId: string,
): { messageId: string; threadId: string } | null {
  const holds = (m: Message | undefined) =>
    !!m?.metadata?.toolCalls?.some((tc) => tc.toolCallId === toolCallId)
  for (const [threadId, list] of Object.entries(messageStore.threads)) {
    for (const id of list?.ids ?? []) {
      if (holds(list.byId[id])) return { messageId: id, threadId }
    }
  }
  for (const cache of Object.values(messageStore.replies)) {
    if (!cache) continue
    if (cache.root && holds(cache.root)) {
      return { messageId: cache.root.id, threadId: cache.threadId }
    }
    for (const reply of Object.values(cache.byId)) {
      if (holds(reply)) return { messageId: reply.id, threadId: cache.threadId }
    }
  }
  return null
}

/** Nothing came after this message in its conversation (or its reply thread): it is the newest. */
export function isNewestMessage(threadId: string, messageId: string): boolean {
  const ids = messageStore.threads[threadId]?.ids
  if (ids?.includes(messageId)) return ids[ids.length - 1] === messageId
  for (const cache of Object.values(messageStore.replies)) {
    if (!cache || cache.threadId !== threadId) continue
    if (cache.root?.id === messageId) return cache.ids.length === 0
    if (cache.ids.includes(messageId)) return cache.ids[cache.ids.length - 1] === messageId
  }
  return false
}

/** Draw the card a card action's answer carries on every copy of its message. */
export function replaceStoredToolCard(
  threadId: string,
  messageId: string,
  toolCallId: string,
  card: ResolvedCard,
  cardRevision: number | null | undefined,
): void {
  setMessageStore(
    produce((s) => {
      for (const msg of messageCopies(s, threadId, messageId)) {
        const tc = msg.metadata?.toolCalls?.find((entry) => entry.toolCallId === toolCallId)
        if (!tc) continue
        tc.card = card
        if (typeof cardRevision === "number") tc.cardRevision = cardRevision
      }
    }),
  )
}

/** Reads the first copy of a message outside a store update. */
function findMessageCopy(threadId: string, messageId: string): Message | undefined {
  const inChannel = messageStore.threads[threadId]?.byId[messageId]
  if (inChannel) return inChannel
  for (const cache of Object.values(messageStore.replies)) {
    if (!cache || cache.threadId !== threadId) continue
    if (cache.root?.id === messageId) return cache.root
    const reply = cache.byId[messageId]
    if (reply) return reply
  }
  return undefined
}

/** A replier as the root's summary names them: an agent reply is the AGENT's,
 *  not the requester's who is its author id (the server's rule). */
function replyAuthorOf(m: Message): ReplyAuthor {
  const isAgent = m.authorType === "agent" && !!m.authorAgentId
  return {
    id: isAgent ? (m.authorAgentId as string) : m.authorId,
    name: m.authorName ?? null,
    avatarUrl: isAgent ? null : (m.authorAvatarUrl ?? null),
  }
}

/** A reply is a user's or an agent's (the server's rule). A system line in a
 *  reply thread, such as an agent's seat line, lives there but is no reply:
 *  it neither counts, nor dates the thread, nor names a replier. */
function countsAsReply(m: Pick<Message, "authorType">): boolean {
  return m.authorType === "user" || m.authorType === "agent"
}

/** Reply ids already added to (or taken out of) their root's summary, so a
 *  replayed socket frame, or the POST answer racing its own frame, counts once. */
const countedReplyIds = new Set<string>()
const uncountedReplyIds = new Set<string>()

/**
 * When every reply of a root is loaded, its summary is recomputed exactly from
 * them (count of live replies, newest reply time, three most recent repliers).
 * Answers false when the cache does not hold the whole thread, in which case
 * the caller moves the summary by one.
 */
function recomputeRootSummary(s: MessageStoreState, threadId: string, rootId: string): boolean {
  const cache = s.replies[rootId]
  if (!cache || cache.hasMore || cache.loading) return false
  const live = cache.ids
    .map((id) => cache.byId[id])
    .filter((m): m is Message => !!m && !m.deletedAt && !m.pending && countsAsReply(m))
  let lastReplyAt: string | null = null
  for (const m of live) if (!lastReplyAt || m.createdAt > lastReplyAt) lastReplyAt = m.createdAt
  const authors: ReplyAuthor[] = []
  for (const m of [...live].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))) {
    const author = replyAuthorOf(m)
    if (authors.some((a) => a.id === author.id)) continue
    authors.push(author)
    if (authors.length === 3) break
  }
  for (const root of messageCopies(s, threadId, rootId)) {
    root.replyCount = live.length
    root.lastReplyAt = lastReplyAt
    root.replyAuthors = authors
  }
  return true
}

function countReply(s: MessageStoreState, threadId: string, rootId: string, reply: Message): void {
  if (countedReplyIds.has(reply.id)) return
  countedReplyIds.add(reply.id)
  if (!countsAsReply(reply)) return
  if (recomputeRootSummary(s, threadId, rootId)) return
  const author = replyAuthorOf(reply)
  for (const root of messageCopies(s, threadId, rootId)) {
    root.replyCount = (root.replyCount ?? 0) + 1
    if (!root.lastReplyAt || reply.createdAt > root.lastReplyAt) root.lastReplyAt = reply.createdAt
    root.replyAuthors = [
      author,
      ...(root.replyAuthors ?? []).filter((a) => a.id !== author.id),
    ].slice(0, 3)
  }
}

function uncountReply(
  s: MessageStoreState,
  threadId: string,
  rootId: string,
  replyId: string,
): void {
  if (uncountedReplyIds.has(replyId)) return
  uncountedReplyIds.add(replyId)
  // A system line was never counted, so its delete takes nothing off. Unknown
  // to this client (no copy held) reads as a reply, as before.
  const known = s.replies[rootId]?.byId[replyId] ?? s.threads[threadId]?.byId[replyId]
  if (known && !countsAsReply(known)) return
  if (recomputeRootSummary(s, threadId, rootId)) return
  for (const root of messageCopies(s, threadId, rootId)) {
    root.replyCount = Math.max(0, (root.replyCount ?? 0) - 1)
  }
}

/** True when this client holds a copy of the message and it is deleted
 *  (a quote block says its source is gone). Unknown is not deleted. */
export function isMessageDeleted(threadId: string, messageId: string): boolean {
  return !!findMessageCopy(threadId, messageId)?.deletedAt
}

/** One reply thread's replies, oldest first. */
export function getReplies(rootId: string): Message[] {
  const cache = messageStore.replies[rootId]
  if (!cache) return []
  return cache.ids.map((id) => cache.byId[id]).filter(Boolean)
}

/** The panel's copy of a root: the reply thread's, else the channel list's. */
export function getReplyRoot(rootId: string, threadId?: string): Message | undefined {
  const cached = messageStore.replies[rootId]?.root
  if (cached) return cached
  return threadId ? messageStore.threads[threadId]?.byId[rootId] : undefined
}

export function getReplyThread(rootId: string): ReplyThreadCache | undefined {
  return messageStore.replies[rootId]
}

function mergeReplyPage(cache: ReplyThreadCache, replies: Message[], mode: "replace" | "older") {
  if (mode === "older") {
    const newIds: string[] = []
    for (const m of replies) {
      if (!cache.byId[m.id]) newIds.push(m.id)
      cache.byId[m.id] = m
    }
    cache.ids = [...newIds, ...cache.ids]
    return
  }
  const nextIds: string[] = []
  const seen = new Set<string>()
  for (const m of replies) {
    const prev = cache.byId[m.id]
    if (prev) Object.assign(prev, m)
    else cache.byId[m.id] = m
    nextIds.push(m.id)
    seen.add(m.id)
  }
  // Older pages already loaded stay; sends not echoed yet stay at the end.
  const fetchedOldest = nextIds[0]
  const boundary = fetchedOldest ? cache.ids.indexOf(fetchedOldest) : -1
  const keptPrefix = boundary > 0 ? cache.ids.slice(0, boundary) : []
  const pendingTail = cache.ids.filter(
    (id) => !seen.has(id) && !keptPrefix.includes(id) && isClientMessageId(id),
  )
  cache.ids = [...keptPrefix, ...nextIds, ...pendingTail]
  for (const id of Object.keys(cache.byId)) {
    if (!cache.ids.includes(id)) delete cache.byId[id]
  }
}

type RepliesApi = {
  get: (path: string) => Promise<any>
  getEnvelope?: (path: string) => Promise<{ data: any; meta?: Record<string, unknown> }>
}

async function fetchReplyPage(
  api: RepliesApi,
  path: string,
): Promise<{ root: Message | null; replies: Message[]; hasMore: boolean | null }> {
  const envelope = api.getEnvelope ? await api.getEnvelope(path) : null
  const data = envelope ? envelope.data : await api.get(path)
  const hasMore = typeof envelope?.meta?.hasMore === "boolean" ? envelope.meta.hasMore : null
  return {
    root: (data?.root as Message | undefined) ?? null,
    replies: Array.isArray(data?.replies) ? (data.replies as Message[]) : [],
    hasMore,
  }
}

const REPLY_PAGE = 50

/** Loads (or refreshes) one reply thread: its root and newest page of replies. */
export async function loadReplies(
  api: RepliesApi,
  threadId: string,
  rootId: string,
): Promise<void> {
  _repliesApi = api
  setMessageStore(
    produce((s) => {
      const cache = ensureReplyCache(s, threadId, rootId)
      cache.loading = cache.ids.length === 0 && !cache.root
      cache.error = null
    }),
  )
  try {
    const page = await fetchReplyPage(
      api,
      `/threads/${threadId}/messages/${rootId}/replies?limit=${REPLY_PAGE}`,
    )
    setMessageStore(
      produce((s) => {
        const cache = ensureReplyCache(s, threadId, rootId)
        if (page.root) {
          if (cache.root) Object.assign(cache.root, page.root)
          else cache.root = page.root
        }
        mergeReplyPage(cache, page.replies, "replace")
        cache.hasMore = page.hasMore ?? page.replies.length >= REPLY_PAGE
        cache.loading = false
        for (const id of cache.ids) {
          if (!isClientMessageId(id)) countedReplyIds.add(id)
        }
      }),
    )
  } catch (err) {
    setMessageStore(
      produce((s) => {
        const cache = ensureReplyCache(s, threadId, rootId)
        cache.loading = false
        cache.error = err instanceof Error ? err.message : "Failed to load replies"
      }),
    )
  }
}

/** Loads the page of replies older than the oldest one loaded. */
export async function loadOlderReplies(
  api: RepliesApi,
  threadId: string,
  rootId: string,
): Promise<void> {
  const cache = messageStore.replies[rootId]
  const oldest = cache?.ids.find((id) => !isClientMessageId(id))
  if (!cache || !oldest || cache.loadingMore || !cache.hasMore) return
  setMessageStore("replies", rootId, "loadingMore", true)
  try {
    const page = await fetchReplyPage(
      api,
      `/threads/${threadId}/messages/${rootId}/replies?limit=${REPLY_PAGE}&before=${oldest}`,
    )
    setMessageStore(
      produce((s) => {
        const c = ensureReplyCache(s, threadId, rootId)
        mergeReplyPage(c, page.replies, "older")
        c.hasMore = page.hasMore ?? page.replies.length >= REPLY_PAGE
        for (const m of page.replies) countedReplyIds.add(m.id)
      }),
    )
  } catch {
    // Transient: scrolling up again retries.
  } finally {
    if (messageStore.replies[rootId]) setMessageStore("replies", rootId, "loadingMore", false)
  }
}

let _repliesApi: RepliesApi | null = null

// --- Mutations ---

// Last API client seen by a load — captured so the module-level resync
// subscription can refetch loaded threads without a component context.
let _messageApi: { get: (path: string) => Promise<any> } | null = null

// Per-thread generation counter. Bumped whenever evictThreadMessages() runs
// for that thread. loadMessages() captures the generation at call time and
// drops its write-back if the counter moved before the request resolved —
// otherwise an in-flight load that resolves AFTER eviction silently
// re-creates the thread entry, undoing the eviction (mirrors the requestId
// guard in MailMessageRenderer's blob-url fix).
const _threadEpoch: Record<string, number> = {}

function currentEpoch(threadId: string): number {
  return _threadEpoch[threadId] ?? 0
}

export async function loadMessages(
  api: {
    get: (path: string, init?: { userInitiated?: boolean }) => Promise<any>
    getEnvelope?: (
      path: string,
      init?: { userInitiated?: boolean },
    ) => Promise<{ data: any; meta?: Record<string, unknown> }>
  },
  threadId: string,
  options?: {
    /** A person pressed Try again: let through the client rate limit cool-down,
     *  which is otherwise the reason the button would do nothing. */
    userInitiated?: boolean
  },
): Promise<void> {
  _messageApi = api
  const epoch = currentEpoch(threadId)
  // Only surface the loading state on the INITIAL load. Background refetches
  // (resync bumps, WS reconnects — frequent during an agent turn that updates
  // skills) must not flip the list into "Loading messages..." while the user
  // is reading streamed output.
  const isInitialLoad = !messageStore.threads[threadId]
  // What the list held when the request left. The page answers for THAT
  // moment, so a row that landed while it was on the wire (a socket
  // `message:create`, a send that settled to its real id) is newer than the
  // page, not deleted from it, and the merge below must keep it.
  const idsAtRequest = new Set(messageStore.threads[threadId]?.ids ?? [])
  if (isInitialLoad) setMessageStore("loading", threadId, true)
  setMessageStore("error", threadId, null)
  try {
    // `get` unwraps the envelope and throws `meta` away, and `meta.hiddenRuns`
    // is the only place the server says WHERE this reader's gaps are, so the
    // page is read as an envelope whenever the client can.
    const path = `/threads/${threadId}/messages?limit=50`
    const init = options?.userInitiated ? { userInitiated: true } : undefined
    const envelope = api.getEnvelope ? await api.getEnvelope(path, init) : null
    const res = envelope ? envelope.data : await api.get(path, init)
    if (currentEpoch(threadId) !== epoch) return // evicted mid-flight — drop the write-back
    applyHiddenRuns(threadId, envelope?.meta)
    const msgs = res?.data ?? res?.messages ?? res
    const arr: Message[] = Array.isArray(msgs) ? msgs : []
    // API returns DESC (newest first) — reverse to ASC for display (oldest first, newest at bottom)
    const ordered = [...arr].reverse()
    // Merge into the existing thread entry instead of swapping in a fresh
    // { ids, byId } object. Replacing the object breaks identity for EVERY
    // message row, so a background refetch re-rendered the whole list (heavy
    // markdown rows -> a visible blank flash, repeated on each resync during
    // an agent turn). Same pattern as tickets' upsertTicket.
    setMessageStore(
      "threads",
      produce((threads) => {
        const existing = threads[threadId]
        if (!existing) {
          const byId: Record<string, Message> = {}
          const ids: string[] = []
          for (const m of ordered) {
            byId[m.id] = m
            ids.push(m.id)
          }
          threads[threadId] = { ids, byId }
          for (const id of ids) {
            const m = threads[threadId]!.byId[id]!
            if (m.metadata?.subRun) applyPendingSubRunUpdateIfMatch(m)
          }
          return
        }
        const nextIds: string[] = []
        const seen = new Set<string>()
        for (const m of ordered) {
          const prev = existing.byId[m.id]
          if (prev) Object.assign(prev, m)
          else existing.byId[m.id] = m
          // A sub_run card a fetch brings in takes the update that beat it here.
          if (m.metadata?.subRun) applyPendingSubRunUpdateIfMatch(existing.byId[m.id]!)
          nextIds.push(m.id)
          seen.add(m.id)
        }
        // Preserve messages the page no longer covers ONLY if they are older
        // pages already loaded (ids before the fetched window), optimistic
        // sends not yet echoed, or rows that ARRIVED while the request was in
        // flight — never resurrect server-deleted rows from the fetched window
        // itself (those were in the list when the request left).
        //
        // The third case is the phone's "my message is in the list preview but
        // not in the conversation": a page read before a message existed
        // landed after that message's socket frame (or after its own send
        // settled), and the merge used to delete the row. The thread list kept
        // it as its preview, and the conversation, whose cache is reused on
        // the next open, never showed it.
        const fetchedOldest = nextIds[0]
        const boundary = fetchedOldest ? existing.ids.indexOf(fetchedOldest) : -1
        const keptPrefix = boundary > 0 ? existing.ids.slice(0, boundary) : []
        const tail = existing.ids.filter(
          (id) =>
            !seen.has(id) &&
            !keptPrefix.includes(id) &&
            (isClientMessageId(id) || !idsAtRequest.has(id)),
        )
        const merged = [...keptPrefix, ...nextIds, ...tail]
        if (merged.join("\n") !== existing.ids.join("\n")) existing.ids = merged
        for (const id of Object.keys(existing.byId)) {
          if (!merged.includes(id)) delete existing.byId[id]
        }
      }),
    )
    setMessageStore(produce((s) => endTurnsAnsweredInPage(s, threadId, ordered)))
    // API client unwraps the envelope (strips meta), so infer hasMore from page size
    setMessageStore("hasMore", threadId, arr.length >= 50)
  } catch (err) {
    if (currentEpoch(threadId) !== epoch) return // evicted mid-flight — drop the write-back
    setMessageStore(
      "error",
      threadId,
      err instanceof Error ? err.message : "Failed to load messages",
    )
  } finally {
    if (currentEpoch(threadId) === epoch) {
      setMessageStore("loading", threadId, false)
    }
  }
}

// --- Reconcile with the thread list ---
// The thread list and the conversation are two records fed by the same socket
// frames, and either can be refreshed without the other: pull-to-refresh, a
// resync or a self-heal reload rewrites the list's `lastMessage`, while an
// open conversation's cached page is reused as is. When the list knows of a
// message NEWER than the newest one the conversation holds, the conversation
// missed it and is read again. Once per list stamp per thread, so a preview
// the page can never contain (a reply the list counts and the channel does
// not) costs one read, never a loop.
const _reconciledListStamp: Record<string, string> = {}

function newestLoadedAt(threadId: string): string | null {
  const t = messageStore.threads[threadId]
  if (!t) return null
  let newest: string | null = null
  for (const id of t.ids) {
    const m = t.byId[id]
    if (!m || m.pending || isClientMessageId(id)) continue
    if (newest === null || Date.parse(m.createdAt) > Date.parse(newest)) newest = m.createdAt
  }
  return newest
}

/** True when the list's newest message postdates everything this thread's
 *  loaded page holds. A thread that is not loaded is not "behind": its first
 *  open reads it anyway. */
export function isThreadBehindList(
  threadId: string,
  listLastAt: string | null | undefined,
): boolean {
  if (!listLastAt || !messageStore.threads[threadId]) return false
  const listMs = Date.parse(listLastAt)
  if (Number.isNaN(listMs)) return false
  const newest = newestLoadedAt(threadId)
  return newest === null || listMs > Date.parse(newest)
}

/** Read the conversation again when the list is ahead of it (see above). */
export function reconcileThreadWithList(
  api: Parameters<typeof loadMessages>[0],
  threadId: string,
  listLastAt: string | null | undefined,
): void {
  if (!listLastAt || messageStore.loading[threadId]) return
  if (!isThreadBehindList(threadId, listLastAt)) return
  if (_reconciledListStamp[threadId] === listLastAt) return
  _reconciledListStamp[threadId] = listLastAt
  void loadMessages(api, threadId)
}

// --- Resync subscription ---
// On a resync bump, refetch every thread whose messages are currently loaded,
// in place (loadMessages swaps the messages object atomically, so the open
// thread keeps rendering old messages until the fresh page lands — no wipe).
let _messageResyncSubscribed = false

export function subscribeMessageResync(): void {
  if (_messageResyncSubscribed) return
  _messageResyncSubscribed = true
  subscribeResync(() => {
    // A resync (WS `sync`, or a reconnect) is the session saying it is worth
    // asking again, so the remembered load failures are cleared with it: a
    // thread whose first load failed is not in `threads` and would otherwise
    // never be refetched, and ThreadView deliberately stops asking while an
    // error stands.
    setMessageStore(
      produce((s) => {
        for (const key of Object.keys(s.error)) s.error[key] = null
      }),
    )
    const api = _messageApi
    if (!api) return
    for (const threadId of Object.keys(messageStore.threads)) {
      // The frames missed include a turn's start: the server's record of the
      // turns it runs draws them live again, after the page (whose replies end
      // the turns already over).
      void loadMessages(api, threadId).then(() =>
        seedAgentStreamState(api, threadId, { replace: true }),
      )
    }
    // An open reply thread missed the same frames the channel did.
    const repliesApi = _repliesApi
    if (!repliesApi) return
    for (const [rootId, cache] of Object.entries(messageStore.replies)) {
      if (cache) void loadReplies(repliesApi, cache.threadId, rootId)
    }
  })
}

/**
 * Drop a thread's per-entity payload (messages + agent stream) — called when
 * the last open tab for that thread closes (tab-store's onTabClosed wiring).
 * The sidebar/list surfaces (thread-store) are a separate record and are
 * NEVER touched here — only this per-entity detail data is evicted.
 */
export function evictThreadMessages(threadId: string): void {
  _threadEpoch[threadId] = currentEpoch(threadId) + 1
  delete _reconciledListStamp[threadId]
  setMessageStore(
    produce((s) => {
      delete s.threads[threadId]
      for (const [rootId, cache] of Object.entries(s.replies)) {
        if (cache?.threadId === threadId) delete s.replies[rootId]
      }
      for (const key of Object.keys(s.agentStreams)) {
        if (key.startsWith(`${threadId}::`)) delete s.agentStreams[key]
      }
      delete s.loading[threadId]
      delete s.hasMore[threadId]
      delete s.loadingMore[threadId]
      delete s.error[threadId]
    }),
  )
}

export async function loadMoreMessages(
  api: { get: (path: string) => Promise<any> },
  threadId: string,
): Promise<void> {
  const tm = messageStore.threads[threadId]
  if (!tm?.ids.length || messageStore.loadingMore[threadId]) return

  // Array is ASC — oldest message is first
  const oldestId = tm.ids[0]
  if (!oldestId) return

  const epoch = currentEpoch(threadId)
  setMessageStore("loadingMore", threadId, true)
  try {
    const res = await api.get(`/threads/${threadId}/messages?limit=50&before=${oldestId}`)
    if (currentEpoch(threadId) !== epoch) return // evicted mid-flight — drop the write-back
    const older = res.data ?? res.messages ?? res
    const olderArr: Message[] = Array.isArray(older) ? older : []
    if (olderArr.length > 0) {
      setMessageStore(
        produce((s) => {
          const t = ensureThread(s, threadId)
          // API returns DESC — reverse to ASC before prepending
          const reversed = [...olderArr].reverse()
          const newIds: string[] = []
          for (const m of reversed) {
            if (!t.byId[m.id]) {
              newIds.push(m.id)
            }
            t.byId[m.id] = m
          }
          t.ids = [...newIds, ...t.ids]
        }),
      )
    }
    setMessageStore("hasMore", threadId, olderArr.length >= 50)
  } catch {
    // loadMore failures are transient — user can retry by scrolling up again
  } finally {
    if (currentEpoch(threadId) === epoch) {
      setMessageStore("loadingMore", threadId, false)
    }
  }
}

/** A quote the composer carries: what the reader selected, mapped onto the
 *  source's stored text (quote-excerpt.ts), and who wrote the source. */
export interface QuoteDraft {
  messageId: string
  excerpt: string
  authorName: string
  /** The source's reply root, when the source is a reply. */
  replyRootId?: string | null
}

export async function sendMessage(
  api: { post: (path: string, body: unknown) => Promise<any> },
  threadId: string,
  content: string,
  currentUser: { id: string; name: string },
  opts: {
    attachmentSessionId?: string
    /** The app the user is actually looking at, same shape the agent panel
     *  sends (`/agent/chat`): the turn reads tabType + entityId. */
    currentView?: { tabType: string; entityId: string }
    /** Client-minted mailbox turn nonce. Its presence is what lets the turn ask
     *  this browser to decrypt the user's mail; absent is the locked path. */
    turnNonce?: string
    /** Post into this root's reply thread instead of the channel (S2). */
    replyRootId?: string
    /** Quote an excerpt of another message of this thread (S13). */
    quote?: QuoteDraft
  } = {},
): Promise<void> {
  const replyRootId = opts.replyRootId ?? null
  // Optimistic insert: into the reply thread for a reply (never the channel
  // list, which gets an "also sent" reply from its own echo), else the channel.
  const tempId = `pending-${Date.now()}`
  const target = (s: MessageStoreState): ThreadMessages =>
    replyRootId ? ensureReplyCache(s, threadId, replyRootId) : ensureThread(s, threadId)
  const existingTarget = (s: MessageStoreState): ThreadMessages | undefined =>
    replyRootId ? s.replies[replyRootId] : s.threads[threadId]
  setMessageStore(
    produce((s) => {
      const t = target(s)
      const msg: Message = {
        id: tempId,
        threadId,
        authorId: currentUser.id,
        authorName: currentUser.name,
        authorAvatarUrl: null,
        authorType: "user",
        authorAgentId: null,
        parentMessageId: null,
        content,
        mentions: null,
        metadata: opts.quote
          ? {
              quote: {
                messageId: opts.quote.messageId,
                excerpt: opts.quote.excerpt,
                authorName: opts.quote.authorName,
                replyRootId: opts.quote.replyRootId ?? null,
              },
            }
          : null,
        reactions: [],
        editedAt: null,
        deletedAt: null,
        createdAt: new Date().toISOString(),
        pending: true,
        replyRootId,
      }
      t.byId[tempId] = msg
      t.ids.push(tempId)
    }),
  )

  try {
    // THIS CONVERSATION'S TURNS RUN ON THIS MACHINE: the local session has to
    // be running before the message exists on the server, or the server, which
    // holds no claim yet, answers it with its own agent (local-runtime-send.ts).
    // A session that cannot be had throws here, and nothing is posted.
    const localAgentId = localRuntimeAgentFor(threadId, currentUser.id)
    if (localAgentId) await requireLocalSession(threadId, localAgentId)
    // Absent fields are OMITTED rather than sent as `undefined`: a `turnNonce`
    // key with no value would read as a nonce this browser has forgotten.
    // A send whose answer a blip lost goes once more, same body (send-retry.ts).
    const body = {
      content,
      correlationId: tempId,
      ...(opts.attachmentSessionId ? { attachmentSessionId: opts.attachmentSessionId } : {}),
      ...(opts.currentView ? { currentView: opts.currentView } : {}),
      ...(opts.turnNonce ? { turnNonce: opts.turnNonce } : {}),
      ...(replyRootId ? { replyRootId } : {}),
      // The server resolves the author and checks the excerpt itself (A1):
      // only the source and the excerpt travel.
      ...(opts.quote
        ? { quote: { messageId: opts.quote.messageId, excerpt: opts.quote.excerpt } }
        : {}),
      // The server never starts this agent's turn for a message that says it
      // runs here, whether or not a claim is live when it lands.
      ...(localAgentId ? { localAgentId } : {}),
      // Where this page runs, so a server turn gives the right steps to
      // computer mode when a task needs the person's computer.
      clientSurface: currentClientSurface(),
    }
    const res = await retryLostSend(() => api.post(`/threads/${threadId}/messages`, body))
    const msg = res.data ?? res
    setMessageStore(
      produce((s) => {
        const t = existingTarget(s)
        if (!t) return
        // If WS already delivered the real message, remove the pending one
        // and copy attachments from the API response onto the WS-inserted
        // record — the WS event payload doesn't include them.
        if (t.byId[msg.id]) {
          delete t.byId[tempId]
          t.ids = t.ids.filter((id) => id !== tempId)
          if ((msg as { attachments?: unknown[] }).attachments) {
            t.byId[msg.id].attachments = (msg as { attachments?: unknown[] })
              .attachments as Message["attachments"]
          }
        } else {
          // Replace pending with real. A reload that landed while the POST was
          // in flight may already have dropped the pending id from `ids`; the
          // real row still has to arrive, so it is appended rather than lost.
          delete t.byId[tempId]
          t.byId[msg.id] = { ...msg, pending: false }
          const idx = t.ids.indexOf(tempId)
          if (idx >= 0) t.ids[idx] = msg.id
          else if (!t.ids.includes(msg.id)) t.ids.push(msg.id)
        }
        if (replyRootId) {
          // "Also sent" shows in the channel as well, whichever of this answer
          // and its socket echo lands first.
          const channel = s.threads[threadId]
          if (msg.alsoInChannel === true && channel && !channel.byId[msg.id]) {
            channel.byId[msg.id] = { ...msg, pending: false }
            channel.ids.push(msg.id)
          }
          const stored = t.byId[msg.id]
          if (stored) countReply(s, threadId, replyRootId, stored)
        }
      }),
    )
    // The SENDER'S own message, handed to the shell on the path that usually
    // wins the race with the socket (A32). Without it a desktop holding a
    // local claim never heard about the messages the person at that machine
    // was typing.
    runMessageAsLocalTurn({
      threadId,
      messageId: msg.id,
      authorKind: (msg as { authorType?: string }).authorType ?? "user",
      text:
        typeof (msg as { content?: unknown }).content === "string"
          ? (msg as { content: string }).content
          : content,
    })
  } catch (err) {
    // Remove pending message on failure, then rethrow so the caller can tell
    // the user: a silently vanishing message reads as "it didn't work".
    setMessageStore(
      produce((s) => {
        const t = existingTarget(s)
        if (!t) return
        delete t.byId[tempId]
        t.ids = t.ids.filter((id) => id !== tempId)
      }),
    )
    throw err
  }
}

export async function editMessage(
  api: { patch: (path: string, body?: unknown) => Promise<any> },
  threadId: string,
  messageId: string,
  content: string,
): Promise<void> {
  const original = findMessageCopy(threadId, messageId)
  if (!original) return
  const prevContent = original.content
  const prevEditedAt = original.editedAt
  // Record the optimistic timestamp so the rollback guard can detect a
  // concurrent server update that landed while the PATCH was in-flight.
  const optimisticEditedAt = new Date().toISOString()

  setMessageStore(
    produce((s) => {
      for (const msg of messageCopies(s, threadId, messageId)) {
        msg.content = content
        msg.editedAt = optimisticEditedAt
      }
    }),
  )

  try {
    await api.patch(`/threads/${threadId}/messages/${messageId}`, { content })
  } catch {
    setMessageStore(
      produce((s) => {
        for (const msg of messageCopies(s, threadId, messageId)) {
          // Only roll back if the message hasn't been touched by a concurrent
          // server event since our optimistic write. A partial WS "update" may
          // deliver authoritative content WITHOUT advancing editedAt (the m140
          // partial-update path only sets fields present in the payload), so an
          // editedAt-only guard would clobber server content. Require BOTH the
          // optimistic editedAt AND the optimistic content to still be in place
          // before reverting.
          if (msg.editedAt === optimisticEditedAt && msg.content === content) {
            msg.content = prevContent
            msg.editedAt = prevEditedAt
          }
        }
      }),
    )
  }
}

export async function deleteMessage(
  api: { delete: (path: string) => Promise<any> },
  threadId: string,
  messageId: string,
): Promise<void> {
  const original = findMessageCopy(threadId, messageId)
  if (!original) return
  const prevContent = original.content
  const prevDeletedAt = original.deletedAt
  const replyRootId = original.replyRootId ?? null
  const optimisticDeletedAt = new Date().toISOString()

  setMessageStore(
    produce((s) => {
      for (const msg of messageCopies(s, threadId, messageId)) {
        msg.content = null
        msg.deletedAt = optimisticDeletedAt
      }
      if (replyRootId) uncountReply(s, threadId, replyRootId, messageId)
    }),
  )

  try {
    await api.delete(`/threads/${threadId}/messages/${messageId}`)
  } catch {
    setMessageStore(
      produce((s) => {
        let restored = false
        for (const msg of messageCopies(s, threadId, messageId)) {
          // Guard: don't rollback if a server update (e.g. WS delete event with
          // authoritative timestamp) has already advanced deletedAt.
          if (msg.deletedAt === optimisticDeletedAt) {
            msg.content = prevContent
            msg.deletedAt = prevDeletedAt
            restored = true
          }
        }
        if (restored && replyRootId && uncountedReplyIds.delete(messageId)) {
          const restoredReply = messageCopies(s, threadId, messageId)[0]
          countedReplyIds.delete(messageId)
          if (restoredReply) countReply(s, threadId, replyRootId, restoredReply)
        }
      }),
    )
  }
}

type ReactionUser = { id: string; name: string }

function applyReactionAdd(msg: Message, emoji: string, user: ReactionUser, isCurrent: boolean) {
  const existing = msg.reactions.find((r) => r.emoji === emoji)
  if (existing) {
    // Deduplicate on replay: skip if user already in the reaction group
    if (!existing.users.some((u) => u.id === user.id)) {
      existing.count++
      existing.users.push({ id: user.id, name: user.name })
      if (isCurrent) existing.reacted = true
    }
  } else {
    msg.reactions.push({
      emoji,
      count: 1,
      users: [{ id: user.id, name: user.name }],
      reacted: isCurrent,
    })
  }
}

function applyReactionRemove(msg: Message, emoji: string, userId: string, isCurrent: boolean) {
  const existing = msg.reactions.find((r) => r.emoji === emoji)
  if (!existing) return
  // Deduplicate on replay, as an add does: a remove for someone this reaction
  // no longer counts is already applied. The viewer's own removal is applied
  // optimistically, and its WS echo used to take a SECOND person off the
  // count: removing your 👌 next to one other person's erased theirs from view.
  // Someone not named is still counted while the server left names out.
  const listed = existing.users.some((u) => u.id === userId)
  const unnamedMayInclude = isCurrent ? existing.reacted : existing.users.length < existing.count
  if (!listed && !unnamedMayInclude) return
  existing.count--
  existing.users = existing.users.filter((u) => u.id !== userId)
  if (isCurrent) existing.reacted = false
  if (existing.count <= 0) {
    msg.reactions = msg.reactions.filter((r) => r.emoji !== emoji)
  }
}

/** Whether the viewer has reacted with `emoji` on a loaded copy of the
 *  message; undefined when no copy is loaded (the caller cannot tell). */
function viewerReacted(threadId: string, messageId: string, emoji: string): boolean | undefined {
  const copies = messageCopies(messageStore, threadId, messageId)
  if (copies.length === 0) return undefined
  return copies.some((m) => m.reactions.some((r) => r.emoji === emoji && r.reacted))
}

export async function addReaction(
  api: { post: (path: string, body: unknown) => Promise<any> },
  threadId: string,
  messageId: string,
  emoji: string,
  currentUser?: { id: string; name: string },
): Promise<void> {
  // Idempotent: a reaction the viewer already has is not added again. A
  // repeated add (one gesture delivered twice) must never become a toggle.
  if (currentUser && viewerReacted(threadId, messageId, emoji) === true) return
  // Optimistic: apply immediately, on every copy (channel and reply panel)
  if (currentUser) {
    setMessageStore(
      produce((s) => {
        for (const msg of messageCopies(s, threadId, messageId)) {
          applyReactionAdd(msg, emoji, currentUser, true)
        }
      }),
    )
  }
  try {
    await api.post(`/threads/${threadId}/messages/${messageId}/reactions`, { emoji })
  } catch {
    // Rollback on failure
    if (currentUser) {
      setMessageStore(
        produce((s) => {
          for (const msg of messageCopies(s, threadId, messageId)) {
            applyReactionRemove(msg, emoji, currentUser.id, true)
          }
        }),
      )
    }
  }
}

export async function removeReaction(
  api: { delete: (path: string) => Promise<any> },
  threadId: string,
  messageId: string,
  emoji: string,
  currentUser?: { id: string; name: string },
): Promise<void> {
  // Idempotent: a reaction the viewer does not have is not removed. The
  // server would refuse it anyway; the optimistic update would not.
  if (currentUser && viewerReacted(threadId, messageId, emoji) === false) return
  // Optimistic: remove immediately
  let rolledBackReaction: { count: number; users: Array<{ id: string; name: string }> } | null =
    null
  if (currentUser) {
    setMessageStore(
      produce((s) => {
        for (const msg of messageCopies(s, threadId, messageId)) {
          const existing = msg.reactions.find((r) => r.emoji === emoji)
          if (existing) {
            rolledBackReaction ??= { count: existing.count, users: [...existing.users] }
            existing.count--
            existing.users = existing.users.filter((u) => u.id !== currentUser.id)
            existing.reacted = false
            if (existing.count <= 0) {
              msg.reactions = msg.reactions.filter((r) => r.emoji !== emoji)
            }
          }
        }
      }),
    )
  }
  try {
    const res = await api.delete(
      `/threads/${threadId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
    )
    // Backend returns { removed: false } when the reaction doesn't belong to this user
    if (res?.removed === false) {
      throw new Error("not removed")
    }
  } catch {
    // Rollback on failure or rejection
    if (currentUser && rolledBackReaction) {
      const rb: { count: number; users: Array<{ id: string; name: string }> } = rolledBackReaction
      setMessageStore(
        produce((s) => {
          for (const msg of messageCopies(s, threadId, messageId)) {
            const existing = msg.reactions.find((r) => r.emoji === emoji)
            if (existing) {
              existing.count = rb.count
              existing.users = [...rb.users]
              existing.reacted = true
            } else {
              msg.reactions.push({
                emoji,
                count: rb.count,
                users: [...rb.users],
                reacted: true,
              })
            }
          }
        }),
      )
    }
  }
}

/**
 * The stored copy's metadata with the fields an incoming `message:create` copy
 * adds, or null when it adds none. A message can arrive twice: the outbox
 * `message:create` is queued at INSERT, before the metadata is written, so it
 * carries at most the agent's label, and the low-latency broadcast carries
 * the full metadata (a turn's toolCalls/timeline/reasoning/usage/withheld, a
 * post's `kind` and `sessionId`, a routine report's mark). Whichever lands
 * second adds what the first lacked; a copy that adds nothing changes
 * nothing (never downgrades). Any key, not a list of turn keys: a post-back's `kind` and
 * `sessionId` are what its row is found by (a guided step's anchor), and a
 * list once left them to a refetch.
 */
function withMissingMetadata(
  incoming: MessageMetadata,
  existing: MessageMetadata | null | undefined,
): MessageMetadata | null {
  // Merged only when the incoming copy adds a field; then its own non-null
  // fields win (the fuller copy of a turn's tool calls), and the stored ones it
  // lacks stay.
  const kept = Object.fromEntries(Object.entries(existing ?? {}).filter(([, v]) => v != null))
  const given = Object.fromEntries(Object.entries(incoming).filter(([, v]) => v != null))
  const adds = Object.keys(given).some((k) => kept[k] == null)
  return adds ? { ...kept, ...given } : null
}

/** An agent message names the agent that wrote it. The server's own
 *  `authorName` wins; failing that the agent directory resolves
 *  `authorAgentId`; the generic personal-agent label remains only for an agent
 *  message that carries no agent id at all (a system-authored turn, or a row
 *  predating the column). */
function resolveAuthorName(data: any): string {
  if (data.authorName) return data.authorName
  if (data.authorType !== "agent") return tNow("kernel.threadsUi.unknownAuthor")
  return getAgentDisplay(data.authorAgentId)?.name ?? PERSONAL_AGENT_DISPLAY_NAME
}

function resolveAuthorAvatarUrl(data: any): string | null {
  if (data.authorAvatarUrl) return data.authorAvatarUrl
  if (data.authorType !== "agent") return null
  return getAgentDisplay(data.authorAgentId)?.avatarUrl ?? null
}

/**
 * Attachments arriving on a `message:update` before their `message:create`,
 * keyed by message id. Drained by the create handler (and by `resetMessageStore`).
 */
const pendingAttachmentUpdates = new Map<string, Message["attachments"]>()

/** Number of buffered attachment updates — for testing (leak assertions). */
export function _pendingAttachmentUpdatesSize(): number {
  return pendingAttachmentUpdates.size
}

/**
 * Applies one `message:create` frame to one list (the channel's, or a reply
 * thread's): upgrade a copy already there, replace the pending send it
 * echoes, or append it. Answers the stored message.
 */
function applyCreate(
  t: ThreadMessages,
  threadId: string,
  data: any,
  bufferedAttachments: Message["attachments"] | undefined,
): Message {
  // Already present by real ID — but a completed agent turn emits TWO
  // `message:create` events for the same message: the transactional-outbox
  // one (queued at INSERT, before metadata is written, so `metadata` is
  // null) and the finalize ephemeral broadcast (carrying the full
  // toolCalls/timeline/reasoning). Whichever loses the race must not leave
  // the message metadata-less: upgrade in place with every field the incoming
  // payload carries that the stored copy lacks (never downgrade).
  if (t.byId[data.id]) {
    const existing = t.byId[data.id]
    const incoming = data.metadata as MessageMetadata | null | undefined
    const merged = incoming ? withMissingMetadata(incoming, existing.metadata) : null
    if (merged) existing.metadata = merged
    if (bufferedAttachments) existing.attachments = bufferedAttachments
    // A sub_run card a thread fetch already placed still takes the status
    // update that raced ahead of this create.
    if (existing.metadata?.subRun) applyPendingSubRunUpdateIfMatch(existing)
    return existing
  }
  // Replace pending message by correlation ID (or fall back to content match)
  const pendingId = data.correlationId
    ? t.ids.find((id) => t.byId[id]?.pending && id === data.correlationId)
    : t.ids.find((id) => {
        const m = t.byId[id]
        return m?.pending && m.authorId === data.authorId && m.content === data.content
      })
  // Preserve optimistic attachments on the pending message — the kernel
  // event is queued before the reparent UPDATE runs, so the WS payload
  // doesn't include attachments. The API response that filled in the
  // optimistic record DOES carry them.
  const inheritedAttachments = pendingId ? t.byId[pendingId]?.attachments : undefined
  const realMsg: Message = {
    id: data.id,
    threadId,
    authorId: data.authorId,
    authorName: resolveAuthorName(data),
    authorAvatarUrl: resolveAuthorAvatarUrl(data),
    authorType: data.authorType ?? "user",
    authorAgentId: data.authorAgentId ?? null,
    parentMessageId: data.parentMessageId ?? null,
    content: data.content,
    mentions: data.mentions ?? null,
    metadata: data.metadata ?? null,
    reactions: [],
    attachments: data.attachments ?? inheritedAttachments,
    editedAt: null,
    deletedAt: null,
    createdAt: data.createdAt,
    replyRootId: data.replyRootId ?? null,
    alsoInChannel: data.alsoInChannel === true,
  }
  if (pendingId) {
    delete t.byId[pendingId]
    const idx = t.ids.indexOf(pendingId)
    if (idx >= 0) t.ids[idx] = data.id
    t.byId[data.id] = realMsg
  } else {
    t.byId[data.id] = realMsg
    t.ids.push(data.id)
  }
  // If this is a sub_run card, replay any buffered status update that
  // raced ahead of `message:create` (ephemeral broadcasts beat the
  // outbox; without this, the card freezes at its initial `queued`).
  if (realMsg.metadata?.subRun) {
    applyPendingSubRunUpdateIfMatch(t.byId[data.id])
  }
  // Replay an attachments update that raced ahead of this create.
  if (bufferedAttachments) t.byId[data.id].attachments = bufferedAttachments
  return t.byId[data.id]
}

/**
 * An agent's reply landed: end the live block of the turn it answers. The reply
 * names its turn (`metadata.turnId`, on the live copy the turn broadcasts at its
 * end); a copy that names none (the outbox's, written before the metadata)
 * ends only a block that names no turn either, or one whose turn already ended.
 * A newer turn of the same agent still running keeps its block.
 */
function endLandedTurn(
  s: MessageStoreState,
  threadId: string,
  agentId: string | null,
  turnId: unknown,
  messageId?: string,
  content?: unknown,
  carriesTimeline = false,
): void {
  const key = agentStreamKey(threadId, agentId)
  const current = s.agentStreams[key]
  noteTurnEnded(threadId, agentId, turnId)
  if (typeof turnId === "string" && turnId) {
    delete s.agentStreams[replacedTurnKey(threadId, agentId, turnId)]
    if (current?.turnId && current.turnId !== turnId) return
    s.agentStreams[key] = createIdleAgentStream()
    return
  }
  // A copy carrying the turn's timeline is the full reply even unnamed: its
  // row replaces the live view whole.
  if (current?.turnId && current.state === "streaming" && !carriesTimeline) {
    // The outbox's copy of this turn's reply, written before its metadata:
    // the live block stays the turn's only view until the copy naming the
    // turn lands, so the answer is not drawn twice meanwhile (S28, path 5).
    if (messageId && sameAnswer(current.content, content)) {
      const held = current.heldReplyIds ?? []
      if (!held.includes(messageId)) current.heldReplyIds = [...held, messageId]
    }
    return
  }
  s.agentStreams[key] = createIdleAgentStream()
}

/**
 * Whether an unnamed reply is the live block's own answer. The outbox's copy
 * carries no marker of the turn (only the row: id, author, content, no turn
 * metadata), so the text decides: whitespace aside, one within the other and
 * nearly as long (a tail frame still on the wire is tolerated). A short live
 * text that merely opens another message of the agent does not hide it.
 */
const SAME_ANSWER_MIN_RATIO = 0.9

function sameAnswer(live: string, reply: unknown): boolean {
  if (typeof reply !== "string") return false
  const squash = (value: string) => value.replace(/\s+/g, "")
  const a = squash(live)
  const b = squash(reply)
  if (a.length === 0 || b.length === 0) return false
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a]
  return longer.includes(shorter) && shorter.length >= longer.length * SAME_ANSWER_MIN_RATIO
}

export function handleWsMessageEvent(action: string, data: any): void {
  const threadId = data.threadId
  if (!threadId) return
  const replyRootId: string | null = typeof data.replyRootId === "string" ? data.replyRootId : null

  if (action === "create") {
    setMessageStore(
      produce((s) => {
        if (data.authorType === "agent") {
          // The run that just landed, not every run in the room: the other
          // agent this message mentioned may still be streaming, and so may a
          // newer turn of this one (`replacedTurnKey`).
          endLandedTurn(
            s,
            threadId,
            data.authorAgentId ?? null,
            data.metadata?.turnId,
            typeof data.id === "string" ? data.id : undefined,
            data.content,
            Array.isArray(data.metadata?.timeline) && data.metadata.timeline.length > 0,
          )
        }
        const buffered = pendingAttachmentUpdates.get(data.id)
        let stored: Message | null = null
        // S9: a reply goes to its reply thread (when this client holds it) and
        // into the channel list ONLY when it was also sent to the channel.
        if (replyRootId) {
          const cache = s.replies[replyRootId]
          if (cache) stored = applyCreate(cache, threadId, data, buffered)
        }
        const inChannel = !replyRootId || data.alsoInChannel === true
        const t = s.threads[threadId]
        if (inChannel && t) stored = applyCreate(t, threadId, data, buffered) ?? stored
        if (stored && buffered) pendingAttachmentUpdates.delete(data.id)
        if (replyRootId) {
          countReply(
            s,
            threadId,
            replyRootId,
            stored ?? {
              id: data.id,
              threadId,
              authorId: data.authorId,
              authorName: resolveAuthorName(data),
              authorAvatarUrl: resolveAuthorAvatarUrl(data),
              authorType: data.authorType ?? "user",
              authorAgentId: data.authorAgentId ?? null,
              content: data.content,
              mentions: null,
              reactions: [],
              editedAt: null,
              deletedAt: null,
              createdAt: data.createdAt,
            },
          )
        }
      }),
    )
    // THE DESKTOP SHELL'S INPUT (A32). A shell holding a local claim on this
    // conversation runs the agent's turn on the user's own machine, so it has
    // to see the message that would have started that turn on the server.
    // `runMessageAsLocalTurn` is what makes this safe to call from both this
    // path and the send path: it asks for one message exactly once.
    runMessageAsLocalTurn({
      threadId,
      messageId: data.id,
      authorKind: data.authorType ?? "user",
      text: typeof data.content === "string" ? data.content : "",
    })
  } else if (action === "update") {
    setMessageStore(
      produce((s) => {
        const copies = messageCopies(s, threadId, data.id)
        if (copies.length === 0) {
          // The attachments update can outrun its own `message:create` (the
          // create rides the transactional outbox, this one is queued after the
          // reparent commits). Buffer it and replay when the create lands,
          // rather than dropping the only event that carries the files. Only
          // for a list already loaded here: a buffer entry for a thread this
          // client never opens would never be drained.
          const listLoaded = replyRootId ? !!s.replies[replyRootId] : !!s.threads[threadId]
          if ((listLoaded || s.threads[threadId]) && data.attachments !== undefined) {
            pendingAttachmentUpdates.set(data.id, data.attachments as Message["attachments"])
          }
          return
        }
        for (const msg of copies) {
          // Only overwrite fields that are explicitly present in the event payload
          // so that a partial WS update (e.g. metadata-only) does not clobber
          // content or editedAt with undefined.
          if (data.content !== undefined) msg.content = data.content
          if (data.mentions !== undefined) msg.mentions = data.mentions ?? null
          if (data.editedAt !== undefined) msg.editedAt = data.editedAt
          // A routine's "is running" line settles in place (routine-report.ts).
          if (data.metadata !== undefined) msg.metadata = data.metadata ?? null
          // A card replaced from a card action (or superseded by a newer one) arrives as the
          // row's calls alone: the rest of its metadata stays as this copy holds it.
          if (Array.isArray(data.toolCalls)) {
            msg.metadata = { ...(msg.metadata ?? {}), toolCalls: data.toolCalls }
          }
          // Attachments are reparented onto the message AFTER it is inserted, so
          // `message:create` never carries them: this update is how every client
          // other than the sender learns the message has files.
          if (data.attachments !== undefined) msg.attachments = data.attachments ?? []
        }
        if (data.attachments !== undefined) pendingAttachmentUpdates.delete(data.id)
      }),
    )
  } else if (action === "delete") {
    setMessageStore(
      produce((s) => {
        const copies = messageCopies(s, threadId, data.id)
        for (const msg of copies) {
          msg.content = null
          msg.reactions = []
          // C-4 fix: use server timestamp, fall back to client clock
          msg.deletedAt = data.deletedAt ?? new Date().toISOString()
        }
        // A deleted reply leaves its root's summary (the count excludes it).
        const root = replyRootId ?? copies.find((m) => m.replyRootId)?.replyRootId ?? null
        if (root) uncountReply(s, threadId, root, data.id)
      }),
    )
  }
}

/** Seed the live agent-stream block for a thread that may have an IN-FLIGHT
 *  run started before this view was listening — the promoted-agent-chat case,
 *  a teammate opening the thread, or a fresh page load mid-run. Fetches the
 *  server's stream-state snapshot and, when a run is active and no local
 *  stream exists yet, installs it so the thinking block, tool calls and the
 *  "working" indicator appear immediately; the ongoing WS deltas then append
 *  on top. A no-op when the local stream is already live (the WS feed is
 *  fresher than the snapshot). */
export async function seedAgentStreamState(
  api: { get: (path: string) => Promise<any> },
  threadId: string,
  options: {
    /** Resume (a reconnect, a gap): a snapshot newer than the block's last
     *  frame replaces it whatever its state, rather than only seeding an idle
     *  one (S28). An older or equal snapshot is skipped. */
    replace?: boolean
  } = {},
): Promise<void> {
  try {
    // An end the socket delivers while the snapshot is on the wire makes the
    // snapshot older than what this client already knows: it seeds nothing.
    const endsBefore = turnEndsSeen[threadId] ?? 0
    const res = await api.get(`/agent/stream-state/${threadId}`)
    const snap = res?.data ?? res
    if (!snap?.active) return
    if ((turnEndsSeen[threadId] ?? 0) !== endsBefore) return
    // EVERY run the server is serving, not one: a room that named two agents
    // has two in flight, and seeding only the newest left the other blank until
    // it finished. An older server that answers without `streams` still seeds
    // its single flat run.
    const runs: Array<Record<string, unknown>> = Array.isArray(snap.streams)
      ? (snap.streams as Array<Record<string, unknown>>)
      : [snap as Record<string, unknown>]
    let seededAny = false
    runs.forEach((run, index) => {
      const agentId = typeof run.agentId === "string" ? run.agentId : null
      const turnId = typeof run.turnId === "string" && run.turnId ? run.turnId : null
      const askId = typeof run.askId === "string" && run.askId ? run.askId : null
      // A newer run of the same agent (the server lists them oldest first)
      // replaced this one while it still runs: it keeps a block of its own.
      const replaced =
        turnId !== null &&
        runs
          .slice(index + 1)
          .some((later) => (typeof later.agentId === "string" ? later.agentId : null) === agentId)
      const key = replaced
        ? replacedTurnKey(threadId, agentId, turnId)
        : agentStreamKey(threadId, agentId)
      const snapSeq = typeof run.seq === "number" && run.seq > 0 ? run.seq : null
      const block = messageStore.agentStreams[key]
      if (block && block.state !== "idle") {
        // A block already live is fresher than a snapshot, unless the
        // snapshot is newer than what it drew: then it replaces the block
        // whole, never merged item by item.
        if (!options.replace || snapSeq === null) return
        if (turnId !== null && block.turnId && block.turnId !== turnId) return
        if (snapSeq <= (block.lastSeq ?? 0)) return
      }
      // A turn already over (its end seen here, or its reply in the loaded
      // page after a reload) is history, not a live run.
      if (
        turnId !== null &&
        (endedTurns.has(replacedTurnKey(threadId, agentId, turnId)) ||
          replyLoadedForTurn(messageStore, threadId, agentId, turnId))
      ) {
        return
      }
      setMessageStore("agentStreams", key, {
        state: "streaming",
        content: (run.content as string) ?? "",
        reasoning: (run.reasoning as string) ?? "",
        reasoningStreaming: Boolean(run.reasoningStreaming),
        toolCalls: Array.isArray(run.toolCalls) ? (run.toolCalls as never[]) : [],
        timeline: Array.isArray(run.timeline) ? (run.timeline as never[]) : [],
        error: null,
        lastActivityAt: Date.now(),
        replyRootId: block?.replyRootId ?? null,
        turnId,
        askId,
        lastSeq: snapSeq ?? 0,
        heldReplyIds: block?.heldReplyIds ?? [],
      })
      seededAny = true
      // Frames that arrived while the snapshot was on the wire: the ones it
      // folded in are dropped, the ones after it are drawn after it.
      drainPending(pendingKey(threadId, agentId, turnId))
    })
    if (!seededAny) return
    // The "Liaison is working" dots ride the ephemeral typing channel, which a
    // late joiner missed too — flip them on; the run's typing:stop clears them.
    handleTypingEvent({ type: "typing:start", threadId, userId: "", authorType: "agent" })
  } catch {
    // Best-effort seeding; the WS feed covers everything from this point on.
  }
}

/** A live block with no frame for this long is checked against the server. */
export const AGENT_STREAM_RECHECK_QUIET_MS = 15_000

/**
 * Ask the server whether the live blocks this client draws in a conversation
 * are still running, and end the ones it no longer runs. The socket is not a
 * guaranteed channel (a dropped frame, a reconnect, a snapshot seeded across
 * the turn's end): without this a block whose end never arrived stayed
 * "working" forever, and everything that waits on the agent (the Stuck label,
 * a guided step) waited with it. Only a block quiet for
 * `AGENT_STREAM_RECHECK_QUIET_MS` is cleared, and never one that received a
 * frame while the question was on the wire: a turn the server runs in another
 * process (a routine) is not in its live registry, and a block still streaming
 * is its own proof.
 */
export async function reconcileAgentStreamsWithServer(
  api: { get: (path: string) => Promise<any> },
  threadId: string,
): Promise<void> {
  const askedAt = Date.now()
  let snap: any
  try {
    const res = await api.get(`/agent/stream-state/${threadId}`)
    snap = res?.data ?? res
  } catch {
    return
  }
  if (!snap || typeof snap !== "object") return
  const runs: Array<Record<string, unknown>> = !snap.active
    ? []
    : Array.isArray(snap.streams)
      ? (snap.streams as Array<Record<string, unknown>>)
      : [snap as Record<string, unknown>]
  const prefix = `${threadId}::`
  setMessageStore(
    produce((s) => {
      for (const [key, stream] of Object.entries(s.agentStreams)) {
        if (!key.startsWith(prefix) || stream.state !== "streaming") continue
        if (stream.lastActivityAt > askedAt - AGENT_STREAM_RECHECK_QUIET_MS) continue
        const agentId = agentOfStreamKey(key, prefix)
        const running = runs.some((run) => {
          const runAgent = typeof run.agentId === "string" ? run.agentId : null
          if (runAgent !== agentId) return false
          const runTurn = typeof run.turnId === "string" && run.turnId ? run.turnId : null
          return !stream.turnId || !runTurn || runTurn === stream.turnId
        })
        if (running) continue
        noteTurnEnded(threadId, agentId, stream.turnId)
        if (key.includes("#")) delete s.agentStreams[key]
        else s.agentStreams[key] = createIdleAgentStream()
      }
    }),
  )
}

// --- Mailbox turn scopes held across an agent turn ---
//
// A mailbox turn nonce is standing permission for the server to ask THIS
// browser to decrypt mail for THIS turn. The POST that starts the turn settles
// long before the turn does (the api dispatches the agent run fire and forget
// after responding), so releasing the scope when the POST settles shut the door
// on every decrypt request the turn had not made yet. The scope instead stays
// open until the thread's agent stream says the turn ended.

/** Same inactivity bound the agent panel's stream watchdog uses: above the
 *  server's per-turn cap, so it only fires when no terminal frame ever came. */
const TURN_SCOPE_INACTIVITY_MS = 70_000

interface HeldTurnScope {
  release: () => void
  timer: ReturnType<typeof setTimeout>
  timeoutMs: number
}

const heldTurnScopes = new Map<string, HeldTurnScope[]>()

function releaseHeldScope(threadId: string, scope: HeldTurnScope): void {
  const held = heldTurnScopes.get(threadId)
  if (!held) return
  const idx = held.indexOf(scope)
  if (idx < 0) return
  held.splice(idx, 1)
  if (held.length === 0) heldTurnScopes.delete(threadId)
  clearTimeout(scope.timer)
  scope.release()
}

/**
 * Hold a turn scope open until the agent's turn for `threadId` ends, as seen by
 * the thread's own `agent_stream` frames (`done`, `error` or `clear`). Any other
 * frame for that thread re-arms the inactivity timer, so a turn that streams for
 * minutes keeps its scope while a turn that goes silent releases it. The
 * returned function releases the scope early (unmount, send failure); every
 * path releases exactly once.
 */
export function holdTurnScopeUntilAgentTurnEnds(
  threadId: string,
  release: () => void,
  opts: { timeoutMs?: number } = {},
): () => void {
  const timeoutMs = opts.timeoutMs ?? TURN_SCOPE_INACTIVITY_MS
  const scope: HeldTurnScope = {
    release,
    timeoutMs,
    timer: setTimeout(() => releaseHeldScope(threadId, scope), timeoutMs),
  }
  const held = heldTurnScopes.get(threadId)
  if (held) held.push(scope)
  else heldTurnScopes.set(threadId, [scope])
  return () => releaseHeldScope(threadId, scope)
}

function notifyHeldTurnScopes(threadId: string, action: string): void {
  const held = heldTurnScopes.get(threadId)
  if (!held || held.length === 0) return
  // `clear` is not the end of one turn, it is the stream being wiped for the
  // thread, so nothing is left to hold a scope for.
  if (action === "clear") {
    for (const scope of [...held]) releaseHeldScope(threadId, scope)
    return
  }
  // A terminal frame ends ONE turn, so it releases ONE scope. The frames carry
  // no turn or message id (`done` carries only `finishReason`, `error` only a
  // message), so the scopes on a thread are matched FIFO: the api dispatches a
  // thread's turns in send order, so the oldest held scope is the one whose
  // turn just ended. Releasing all of them let a second send made while turn 1
  // was still streaming lose its mailbox decrypt permission before its own turn
  // ever dispatched. The scopes left behind keep their own inactivity timers,
  // so none of them can outlive its turn by more than that bound.
  if (action === "done" || action === "error") {
    const oldest = held[0]
    if (oldest) releaseHeldScope(threadId, oldest)
  }
  for (const scope of held) {
    clearTimeout(scope.timer)
    scope.timer = setTimeout(() => releaseHeldScope(threadId, scope), scope.timeoutMs)
  }
}

/** Session teardown: a scope outliving the session is permission nobody owns.
 *  Called from `resetMessageStore`, which is the session teardown hook. */
function releaseAllHeldTurnScopes(): void {
  for (const [threadId, held] of [...heldTurnScopes]) {
    for (const scope of [...held]) releaseHeldScope(threadId, scope)
  }
  heldTurnScopes.clear()
}

// --- Live turn order (S28) ---
//
// Every frame of a turn carries its turn's `seq` (one counter per turn, one
// step per frame) and its item. Frames can still reach this client out of
// order (two server processes publish one turn; a publish retry lets a later
// frame overtake), twice (a frame already folded into the snapshot this view
// seeded from) or not at all (a dropped socket). So a block applies frames in
// `seq` order only: a repeat is dropped, an early frame waits in `pending` for
// the frames before it, and a gap still open after `AGENT_STREAM_GAP_WAIT_MS`
// asks the server for the turn's snapshot and goes on from there. A frame
// without `seq` (an older server) is applied as it arrives, as before.

/** How long a frame waits for the frames before it before the turn is reseeded. */
export const AGENT_STREAM_GAP_WAIT_MS = 500
/** Reseeds of one turn are at least this far apart: a viewer whose chunks are
 *  withheld sees gaps the snapshot cannot fill, and must not loop on them. */
export const AGENT_STREAM_RESEED_MIN_INTERVAL_MS = 1_000

interface PendingFrames {
  threadId: string
  frames: Map<number, { action: string; data: any }>
  timer: ReturnType<typeof setTimeout> | null
  reseeding: boolean
  lastReseedAt: number
}

/** Early frames per turn, keyed by `pendingKey`. Not reactive: never drawn. */
const pendingFrames = new Map<string, PendingFrames>()

function pendingKey(threadId: string, agentId: string | null, turnId: string | null): string {
  return turnId ? replacedTurnKey(threadId, agentId, turnId) : agentStreamKey(threadId, agentId)
}

function frameSeq(data: any): number | null {
  return typeof data?.seq === "number" && Number.isFinite(data.seq) && data.seq > 0
    ? data.seq
    : null
}

function frameTurn(data: any): { agentId: string | null; turnId: string | null } {
  return {
    agentId: typeof data.agentId === "string" ? data.agentId : null,
    turnId: typeof data.turnId === "string" && data.turnId ? data.turnId : null,
  }
}

/**
 * The `seq` a frame of this turn follows: the block's last drawn frame, 0 when
 * no block draws the turn yet, null when the frame would be dropped anyway (a
 * turn whose reply already landed, or whose end this client saw). A late frame
 * of an ended turn must not open a fresh block: it would wait out the gap and
 * then draw a fragment as "working" under the saved reply.
 */
function lastSeqFor(
  threadId: string,
  agentId: string | null,
  turnId: string | null,
): number | null {
  const current = messageStore.agentStreams[agentStreamKey(threadId, agentId)]
  let block = current
  if (turnId && current?.turnId !== turnId) {
    block = messageStore.agentStreams[replacedTurnKey(threadId, agentId, turnId)]
    if (!block && current?.turnId) return null
  }
  if (!block || block.state === "idle") {
    if (
      turnId &&
      (endedTurns.has(replacedTurnKey(threadId, agentId, turnId)) ||
        replyLoadedForTurn(messageStore, threadId, agentId, turnId))
    ) {
      return null
    }
    return 0
  }
  return block.lastSeq ?? 0
}

function dropPending(key: string): void {
  const pending = pendingFrames.get(key)
  if (!pending) return
  if (pending.timer) clearTimeout(pending.timer)
  pendingFrames.delete(key)
}

/** Apply the waiting frames that now follow the block, in order. */
function drainPending(key: string): void {
  const pending = pendingFrames.get(key)
  if (!pending) return
  for (;;) {
    const sample = pending.frames.values().next().value
    if (!sample) break
    const { agentId, turnId } = frameTurn(sample.data)
    const last = lastSeqFor(pending.threadId, agentId, turnId)
    if (last === null) {
      pending.frames.clear()
      break
    }
    for (const seq of [...pending.frames.keys()]) if (seq <= last) pending.frames.delete(seq)
    const next = pending.frames.get(last + 1)
    if (!next) break
    pending.frames.delete(last + 1)
    applyAgentStreamFrame(next.action, next.data)
  }
  if (pending.frames.size === 0 && !pending.reseeding) dropPending(key)
}

/** Apply every waiting frame in `seq` order, across the gaps nothing can fill. */
function flushPending(key: string, below = Number.POSITIVE_INFINITY): void {
  const pending = pendingFrames.get(key)
  if (!pending) return
  for (const seq of [...pending.frames.keys()].sort((a, b) => a - b)) {
    if (seq >= below) break
    const frame = pending.frames.get(seq)
    pending.frames.delete(seq)
    if (!frame) continue
    const { agentId, turnId } = frameTurn(frame.data)
    const last = lastSeqFor(pending.threadId, agentId, turnId)
    if (last === null || seq <= last) continue
    applyAgentStreamFrame(frame.action, frame.data)
  }
  if (pending.frames.size === 0 && !pending.reseeding) dropPending(key)
}

function armGapTimer(key: string, delayMs: number): void {
  const pending = pendingFrames.get(key)
  if (!pending || pending.timer) return
  pending.timer = setTimeout(() => {
    pending.timer = null
    void closeGap(key)
  }, delayMs)
}

/** A gap outlived its wait: reseed the turn from the server, then go on. */
async function closeGap(key: string): Promise<void> {
  const pending = pendingFrames.get(key)
  if (!pending || pending.reseeding) return
  drainPending(key)
  if (pending.frames.size === 0) return
  const sinceLast = Date.now() - pending.lastReseedAt
  if (sinceLast < AGENT_STREAM_RESEED_MIN_INTERVAL_MS) {
    armGapTimer(key, AGENT_STREAM_RESEED_MIN_INTERVAL_MS - sinceLast)
    return
  }
  const api = _messageApi
  if (api) {
    pending.reseeding = true
    pending.lastReseedAt = Date.now()
    try {
      await seedAgentStreamState(api, pending.threadId, { replace: true })
    } finally {
      pending.reseeding = false
    }
  }
  // What the snapshot did not cover (it was withheld, or the turn ended) is
  // drawn in order across the gap rather than held forever.
  if (pendingFrames.get(key) === pending) flushPending(key)
}

export function handleWsAgentStreamEvent(action: string, data: any): void {
  if (action === "open_tab") {
    applyOpenTabFrame(data)
    return
  }
  const threadId = data.threadId
  if (!threadId) return
  notifyHeldTurnScopes(threadId, action)
  const seq = frameSeq(data)
  const { agentId, turnId } = frameTurn(data)
  const key = pendingKey(threadId, agentId, turnId)
  if (action === "start" && seq !== null) {
    // A `start` this block already drew past (a late copy) restarts nothing.
    if (turnId) {
      const block = messageStore.agentStreams[agentStreamKey(threadId, agentId)]
      if (block && block.state !== "idle" && block.turnId === turnId && seq <= (block.lastSeq ?? 0))
        return
    }
    applyAgentStreamFrame(action, data)
    // Frames of this turn that overtook its start follow it now: the ones at
    // or below its seq are dropped, the rest drawn in order.
    drainPending(key)
    return
  }
  if (action === "start" || action === "clear") {
    dropPending(key)
    applyAgentStreamFrame(action, data)
    return
  }
  if (action === "resume") {
    rewindAgentStream(key, threadId, agentId, turnId, data)
    return
  }
  if (seq === null) {
    applyAgentStreamFrame(action, data)
    return
  }
  const last = lastSeqFor(threadId, agentId, turnId)
  if (last === null) return
  if (seq <= last) return
  if (action === "done" || action === "error") {
    // The end of the turn: what waited for a gap is drawn first, in order.
    flushPending(key, seq)
    dropPending(key)
    applyAgentStreamFrame(action, data)
    return
  }
  if (seq === last + 1) {
    applyAgentStreamFrame(action, data)
    drainPending(key)
    return
  }
  let pending = pendingFrames.get(key)
  if (!pending) {
    pending = { threadId, frames: new Map(), timer: null, reseeding: false, lastReseedAt: 0 }
    pendingFrames.set(key, pending)
  }
  pending.frames.set(seq, { action, data })
  armGapTimer(key, AGENT_STREAM_GAP_WAIT_MS)
}

/**
 * A turn another process took over (its runner died or handed it off, S10 /
 * M1). The new runner re-issues the step that was cut, so what this block drew
 * past the last complete step (`rewindToSeq`) would show twice. The block
 * forgets those frames: its last seq goes back to the boundary, so every frame
 * of the resumed run waits as a gap, and the server's snapshot (which no longer
 * holds the cut step's frames) replaces the block; the frames past the snapshot
 * then follow in order.
 */
function rewindAgentStream(
  key: string,
  threadId: string,
  agentId: string | null,
  turnId: string | null,
  data: any,
): void {
  dropPending(key)
  const rewindTo =
    typeof data.rewindToSeq === "number" && data.rewindToSeq >= 0 ? data.rewindToSeq : 0
  const blockKey = agentStreamKey(threadId, agentId)
  const block = messageStore.agentStreams[blockKey]
  if (block && block.state !== "idle" && (!turnId || !block.turnId || block.turnId === turnId)) {
    setMessageStore("agentStreams", blockKey, "lastSeq", Math.min(block.lastSeq ?? 0, rewindTo))
  }
  const api = _messageApi
  if (!api) return
  void seedAgentStreamState(api, threadId, { replace: true }).finally(() => {
    if (pendingFrames.has(key)) flushPending(key)
  })
}

/**
 * Extend a reasoning or text run. A frame naming its item (S28) appends to that
 * item, or opens it at the tail; one without coalesces into the trailing entry
 * of its kind, and anything between runs starts a fresh one, as before.
 */
function appendRun(
  stream: AgentStreamState,
  kind: "reasoning" | "text",
  delta: string,
  itemId: string | null,
): void {
  if (itemId) {
    const entry = stream.timeline.find((e) => e.itemId === itemId)
    if (entry && entry.kind === kind) entry.text += delta
    else stream.timeline.push({ kind, text: delta, itemId })
    return
  }
  const last = stream.timeline[stream.timeline.length - 1]
  if (last?.kind === kind) last.text += delta
  else stream.timeline.push({ kind, text: delta })
}

/** Apply one frame to the block of its turn. */
function applyAgentStreamFrame(action: string, data: any): void {
  const threadId: string = data.threadId
  const seq = frameSeq(data)
  const itemId: string | null = typeof data.itemId === "string" && data.itemId ? data.itemId : null

  // WHICH agent's run this frame belongs to. A room that named two agents has
  // two live runs and they interleave; without the key the second `start`
  // reset the first's slot and the first `done` completed the second.
  const streamAgentId: string | null = typeof data.agentId === "string" ? data.agentId : null
  const turnId: string | null = typeof data.turnId === "string" && data.turnId ? data.turnId : null
  const askId: string | null = typeof data.askId === "string" && data.askId ? data.askId : null
  const currentKey = agentStreamKey(threadId, streamAgentId)
  if (action === "done" || action === "error" || action === "clear") {
    noteTurnEnded(threadId, streamAgentId, turnId)
  }
  setMessageStore(
    produce((s) => {
      // WHICH turn: a newer turn of this agent may have replaced the one this
      // frame belongs to while it still runs (`replacedTurnKey`).
      let key = currentKey
      const current = s.agentStreams[currentKey]
      if (action === "start") {
        if (
          turnId &&
          current?.turnId &&
          current.turnId !== turnId &&
          current.state === "streaming"
        ) {
          // The running turn keeps its block under its own key until its reply lands.
          s.agentStreams[replacedTurnKey(threadId, streamAgentId, current.turnId)] = current
        }
      } else if (turnId && current?.turnId !== turnId) {
        const replacedKey = replacedTurnKey(threadId, streamAgentId, turnId)
        if (s.agentStreams[replacedKey]) {
          if (action === "done" || action === "error" || action === "clear") {
            // Its reply is written before its end: the conversation shows it now.
            delete s.agentStreams[replacedKey]
            return
          }
          key = replacedKey
        } else if (current?.turnId) {
          // A frame of another turn no block holds (its reply already landed).
          return
        }
      }
      const stream =
        key === currentKey ? ensureAgentStream(s, threadId, streamAgentId) : s.agentStreams[key]!
      if (action !== "clear") stream.lastActivityAt = Date.now()
      if (seq !== null && action !== "start") stream.lastSeq = Math.max(stream.lastSeq ?? 0, seq)
      // A7: a turn started in a reply thread streams into that thread's panel.
      const streamRootId: string | null =
        typeof data.replyRootId === "string" ? data.replyRootId : null
      if (streamRootId) stream.replyRootId = streamRootId

      switch (action) {
        case "start":
          s.agentStreams[key] = {
            state: "streaming",
            content: "",
            reasoning: "",
            reasoningStreaming: false,
            toolCalls: [],
            timeline: [],
            error: null,
            lastActivityAt: Date.now(),
            replyRootId: streamRootId,
            turnId,
            askId,
            lastSeq: seq ?? 0,
          }
          return

        case "reasoning": {
          if (typeof data.delta !== "string" || data.delta.length === 0) return
          stream.state = "streaming"
          stream.reasoningStreaming = true
          stream.reasoning += data.delta
          appendRun(stream, "reasoning", data.delta, itemId)
          return
        }

        case "delta":
          if (typeof data.delta !== "string" || data.delta.length === 0) return
          stream.state = "streaming"
          // The answer has started — collapse the live thinking block.
          stream.reasoningStreaming = false
          stream.content += data.delta
          appendRun(stream, "text", data.delta, itemId)
          return

        case "tool_call":
          stream.state = "streaming"
          // A re-sent call of an item already drawn keeps its place (S28).
          if (
            itemId &&
            (stream.timeline.some((entry) => entry.itemId === itemId) ||
              stream.toolCalls.some((entry) => entry.toolCallId === data.toolCallId))
          ) {
            return
          }
          stream.toolCalls.push({
            toolCallId: data.toolCallId,
            toolName: data.toolName,
            args: data.args,
            status: "running",
            ...(typeof data.summary === "string" && data.summary ? { summary: data.summary } : {}),
            ...toolCallPresentation(data),
          })
          stream.timeline.push(
            itemId
              ? { kind: "tool", toolCallId: data.toolCallId, itemId }
              : { kind: "tool", toolCallId: data.toolCallId },
          )
          return

        case "tool_result": {
          const isError = data.result?.error != null
          const toolCall = stream.toolCalls.find((entry) => entry.toolCallId === data.toolCallId)
          if (toolCall) {
            toolCall.result = data.result
            toolCall.status = isError ? "error" : "completed"
            if (data.card && typeof data.card === "object") toolCall.card = data.card
            if (data.cardError && typeof data.cardError === "object") {
              toolCall.cardError = data.cardError
            }
          }
          return
        }

        case "done":
          stream.reasoningStreaming = false
          if (stream.state !== "idle") stream.state = "complete"
          return

        case "error":
          stream.reasoningStreaming = false
          stream.state = "error"
          stream.error = {
            message:
              typeof data.message === "string"
                ? localizeAgentNotice(data.message, tNow)
                : tNow("kernel.threadsUi.agentStreamFailed"),
            code: data.code,
          }
          return

        case "clear":
          s.agentStreams[key] = createIdleAgentStream()
      }
    }),
  )

  applyOpenAppEffect(action, data)
}

/** The agent's `open_app`, by the name it has on the wire or its bare one. */
function isOpenAppTool(name: unknown): boolean {
  return name === "kernel__open_app" || name === "open_app"
}

/** It moves one screen: that of the person who asked, and only while they are looking at it. */
function mayMoveMyScreen(data: any): boolean {
  if ((data?.requesterId ?? null) !== (userFromToken()?.userId ?? null)) return false
  return typeof document === "undefined" || !document.hidden
}

/**
 * `open_app` with only an app: it rides the agent_stream `tool_call` frame, which every reader of
 * the thread receives, and opens that app by the name the web app resolves (an unknown one is a
 * harmless no-op). The server names the requester on the frame, and nobody for a routine's run.
 * Done outside the store `produce` so the tab-store mutation isn't nested inside the update.
 */
function applyOpenAppEffect(action: string, data: any): void {
  if (action !== "tool_call" || !isOpenAppTool(data?.toolName)) return
  if (!mayMoveMyScreen(data)) return
  const args = data.args
  if (args?.view || args?.id) return
  const tabAction = typeof args?.app === "string" ? getAppTabAction(args.app) : null
  if (tabAction) {
    openTab({
      type: tabAction.type,
      entityId: tabAction.entityId,
      label: tabAction.label,
    })
  }
}

/**
 * `open_app` with a view or an id: the server read the record, and sends this frame to the
 * requester's connections alone once it may open. A refused call sends none. The title is the
 * record's own name, which is why it comes here and not in the tool's result.
 */
function applyOpenTabFrame(data: any): void {
  if (!mayMoveMyScreen(data)) return
  const tab = data?.tab
  if (typeof tab?.type !== "string" || typeof tab.entityId !== "string") return
  openTab({
    type: tab.type,
    entityId: tab.entityId,
    label: typeof data.label === "string" ? data.label : tab.entityId,
    ...(typeof tab.routePath === "string" ? { routePath: tab.routePath } : {}),
  })
}

export function handleWsReactionEvent(action: string, data: any, currentUserId?: string): void {
  const threadId = data.threadId
  if (!threadId) return
  setMessageStore(
    produce((s) => {
      // Every copy: a reaction on a root shows in the panel too, and one on a
      // reply that was also sent to the channel shows in both lists (A16).
      const isCurrentUser = !!currentUserId && data.userId === currentUserId
      for (const msg of messageCopies(s, threadId, data.messageId)) {
        if (action === "add") {
          applyReactionAdd(
            msg,
            data.emoji,
            { id: data.userId, name: data.userName ?? "" },
            isCurrentUser,
          )
        } else if (action === "remove") {
          applyReactionRemove(msg, data.emoji, data.userId, isCurrentUser)
        }
      }
    }),
  )
}

const PENDING_TTL_MS = 30_000

/** Remove pending messages older than TTL. Called on WS reconnect or periodically. */
export function cleanupPendingMessages(): void {
  const cutoff = Date.now() - PENDING_TTL_MS
  setMessageStore(
    produce((s) => {
      for (const threadId of Object.keys(s.threads)) {
        const t = s.threads[threadId]
        if (!t) continue
        const staleIds = t.ids.filter((id) => {
          const m = t.byId[id]
          return m?.pending && new Date(m.createdAt).getTime() <= cutoff
        })
        for (const id of staleIds) {
          delete t.byId[id]
        }
        if (staleIds.length > 0) {
          t.ids = t.ids.filter((id) => !staleIds.includes(id))
        }
      }
    }),
  )
}

/** Insert an optimistic message (e.g. from agent panel before WS delivery). */
export function addOptimisticMessage(threadId: string, msg: Omit<Message, "pending">): void {
  setMessageStore(
    produce((s) => {
      const t = ensureThread(s, threadId)
      if (t.byId[msg.id]) return
      t.byId[msg.id] = { ...msg, pending: true }
      t.ids.push(msg.id)
    }),
  )
}

/** Reset store to empty state. Called on logout to prevent cross-session data leaks. */
export function resetMessageStore(): void {
  // reconcile, NOT `setMessageStore("threads", {})` — setting a store path to
  // a plain object MERGES it (an empty object is a no-op), so the old form
  // never actually cleared anything and stale threads leaked across sessions.
  setMessageStore(
    reconcile({
      threads: {},
      replies: {},
      hiddenRuns: {},
      agentStreams: {},
      loading: {},
      hasMore: {},
      loadingMore: {},
      error: {},
    }),
  )
  pendingSubRunUpdates.clear()
  pendingAttachmentUpdates.clear()
  endedTurns.clear()
  for (const key of [...pendingFrames.keys()]) dropPending(key)
  for (const key of Object.keys(turnEndsSeen)) delete turnEndsSeen[key]
  for (const key of Object.keys(_reconciledListStamp)) delete _reconciledListStamp[key]
  countedReplyIds.clear()
  uncountedReplyIds.clear()
  _repliesApi = null
  releaseAllHeldTurnScopes()
}
onSessionTeardown(resetMessageStore)

/** Set loadingMore flag — for testing */
export function _setLoadingMore(threadId: string, value: boolean): void {
  setMessageStore("loadingMore", threadId, value)
}

/**
 * Sub-run card expanded/collapsed state — keyed by parent message id. Lives in
 * a separate store so toggling a card doesn't churn the (much larger) message
 * store and so the state survives WS-driven `metadata.subRun` patches.
 */
const [subRunExpanded, setSubRunExpanded] = createStore<Record<string, boolean>>({})

export type { subRunExpanded }

export function toggleSubRunExpanded(messageId: string): void {
  setSubRunExpanded(messageId, (prev) => !prev)
}

export function isSubRunExpanded(messageId: string): boolean {
  return !!subRunExpanded[messageId]
}

/**
 * §1.4.5 — handle a `kernel:sub_run:update` ephemeral WS event. The worker
 * emits `{runId, parentRunId, parentThreadId, status, summary?, usage?, error?}`
 * on every state transition (`queued → running → done | failed`). We locate
 * the parent thread's `sub_run` card message by matching `metadata.subRun.runId`
 * and patch `status`, `summary`, `usage` in place.
 *
 * Race fallback: `sub_run:update` is published ephemerally (no outbox), while
 * the parent thread's sub_run card `message:create` event rides the outbox.
 * Under load the update can land BEFORE the card message arrives — without
 * the buffer below, that early update gets dropped silently and the card
 * freezes at its initial `queued` state forever. We retain pending updates
 * per `runId` and replay them when the card lands via `handleWsMessageEvent`.
 */
interface PendingSubRunUpdate {
  status: SubRunMetadata["status"]
  summary?: string | null
  usage?: SubRunMetadata["usage"]
}
const pendingSubRunUpdates = new Map<string, PendingSubRunUpdate>()
/** Most runs whose latest update waits for its card: oldest dropped first. */
export const MAX_PENDING_SUB_RUN_UPDATES = 200

const SUB_RUN_STATUS_RANK: Record<SubRunMetadata["status"], number> = {
  queued: 0,
  running: 1,
  done: 2,
  failed: 2,
  cancelled: 2,
}

function bufferSubRunUpdate(runId: string, update: PendingSubRunUpdate): void {
  pendingSubRunUpdates.delete(runId)
  pendingSubRunUpdates.set(runId, update)
  while (pendingSubRunUpdates.size > MAX_PENDING_SUB_RUN_UPDATES) {
    const oldest = pendingSubRunUpdates.keys().next().value
    if (oldest === undefined) break
    pendingSubRunUpdates.delete(oldest)
  }
}

const TERMINAL_SUB_RUN_STATUSES: ReadonlySet<SubRunMetadata["status"]> = new Set([
  "done",
  "failed",
  "cancelled",
])

function applyPendingSubRunUpdateIfMatch(msg: Message): void {
  const sub = msg.metadata?.subRun
  if (!sub) return
  const pending = pendingSubRunUpdates.get(sub.runId)
  if (!pending) return
  pendingSubRunUpdates.delete(sub.runId)
  // A card loaded from the server can already be further along than the
  // buffered frame (the row records each transition): never step it back.
  if (SUB_RUN_STATUS_RANK[pending.status] < SUB_RUN_STATUS_RANK[sub.status]) return
  sub.status = pending.status
  if (pending.summary !== undefined) sub.summary = pending.summary
  if (pending.usage) sub.usage = pending.usage
}

/** Number of buffered pending sub-run updates — for testing (leak assertions). */
export function _pendingSubRunUpdatesSize(): number {
  return pendingSubRunUpdates.size
}

export function handleWsSubRunUpdate(data: {
  runId: string
  parentRunId?: string | null
  parentThreadId?: string | null
  status: SubRunMetadata["status"]
  summary?: string | null
  usage?: {
    promptTokens: number
    completionTokens: number
    creditCost: string
  }
  error?: { code: string; message: string }
}): void {
  let matched = false
  setMessageStore(
    produce((s) => {
      const threadIds = data.parentThreadId ? [data.parentThreadId] : Object.keys(s.threads)
      for (const threadId of threadIds) {
        const t = s.threads[threadId]
        if (!t) continue
        for (const msgId of t.ids) {
          const msg = t.byId[msgId]
          if (!msg) continue
          const sub = msg.metadata?.subRun
          if (!sub || sub.runId !== data.runId) continue
          sub.status = data.status
          if (data.summary !== undefined) sub.summary = data.summary
          if (data.usage) sub.usage = data.usage
          matched = true
          return
        }
      }
    }),
  )
  if (!matched) {
    // Card message hasn't landed yet (its message:create, or the thread fetch
    // that carries it, comes later): keep the latest update keyed on runId,
    // terminal ones included, and replay it when the card lands. A dropped
    // terminal update left a card that landed after it at its last live state
    // for good. Bounded: the oldest runs fall out first.
    bufferSubRunUpdate(data.runId, {
      status: data.status,
      summary: data.summary,
      usage: data.usage,
    })
  } else if (TERMINAL_SUB_RUN_STATUSES.has(data.status)) {
    // The card matched and is now in a terminal state — no further updates
    // for this runId will ever be applied, so drop any stale pending entry.
    pendingSubRunUpdates.delete(data.runId)
  }
}

/** Reset the sub-run expanded state — wired into session teardown. */
function resetSubRunExpanded(): void {
  setSubRunExpanded({})
}
onSessionTeardown(resetSubRunExpanded)

/** Load messages directly into store — for testing */
export function loadMessagesIntoStore(threadId: string, msgs: Message[]): void {
  const byId: Record<string, Message> = {}
  const ids: string[] = []
  for (const m of msgs) {
    byId[m.id] = m
    ids.push(m.id)
  }
  setMessageStore("threads", threadId, { ids, byId })
}
