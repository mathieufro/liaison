// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The pure fold of one live agent turn: recorded events in, the snapshot a
 * late-joining view seeds from out. `stream-registry.ts` stores the events
 * (a Redis Stream per turn) and folds them here on every read, so the reducer
 * is the same whichever process recorded or reads the turn.
 *
 * The item model (S28): a turn's live view is an ordered list of items, one
 * reasoning run, one text run or one tool call each. A reasoning or text delta
 * extends the trailing item of its kind, anything else opens a new one. The
 * registry allocates every item id atomically in Redis when the event is
 * recorded (`r<n>` / `t<n>`, or the tool call id), so the fold never invents
 * one: it keys timeline entries by the id each event carries.
 */

import type { CardLabel, ResolvedCard } from "@liaison/shared"

export interface LiveToolCall {
  toolCallId: string
  toolName: string
  args: unknown
  result?: unknown
  status: "running" | "completed" | "error"
  /** A step's one-line summary (a node chat step: the command or file it acts on). */
  summary?: string
  /** What the registry says of the tool, as the stored call keeps it. */
  readOnly?: boolean
  appLabel?: string
  runningLabel?: string
  runningLabelKey?: string
  /** The call's result card, as the stored call keeps it. */
  card?: ResolvedCard
  cardError?: { pill: CardLabel }
}

/** Ordered reasoning/tool interleave (mirrors TurnTimelineEntry) so a late joiner
 *  seeds the in-order thinking/tool layout, not just the flat buckets. Each entry
 *  carries its live item id (S28), the id the turn's frames carry. */
export type LiveTimelineEntry =
  | { kind: "reasoning"; text: string; itemId: string }
  | { kind: "tool"; toolCallId: string; itemId: string }
  | { kind: "text"; text: string; itemId: string }

export type LiveItemKind = "reasoning" | "text" | "tool"

export interface LiveAgentStreamSnapshot {
  threadId: string
  /**
   * WHICH agent is speaking. A room can address several agents in one breath
   * and every one of them takes a turn (spec-agents.md A29/A30), so a thread
   * can carry more than one live run at a time. Null only for a producer that
   * genuinely names no agent.
   */
  agentId: string | null
  /**
   * The message that started this turn, null when the producer names none. A
   * newer request to an agent still answering starts a second turn of the SAME
   * agent in the same thread (on a demo it replaces the first, which stops at
   * its next step): each turn keeps its own entry, and the older one's end
   * never deletes the newer one's.
   */
  turnId: string | null
  /**
   * The PERSON'S message this turn answers: `turnId` for a turn their message
   * started, the earlier ask for the turn an approved call handed back (whose
   * `turnId` is the result row). Null when the producer names no turn. Not part
   * of the key: the turn is still the trigger's.
   */
  askId: string | null
  orgId: string
  state: "streaming"
  content: string
  reasoning: string
  reasoningStreaming: boolean
  toolCalls: LiveToolCall[]
  timeline: LiveTimelineEntry[]
  startedAt: number
  /**
   * When the run was last heard from (an event, or `touchAgentStream`). The
   * stale rule counts from here: a node chat turn can wait ten minutes on one
   * permission prompt and still be running, and its job's heartbeat says so.
   */
  lastSeenAt: number
  /** The `seq` of the last event folded in (0 before any): a client drops a frame at or below it. */
  seq: number
  /**
   * The user whose request started this turn. The replay route exempts them
   * exactly as the chunk gate does (`websocket.ts` `hasStreamChunkAccess`): the
   * turn runs under their own floored effective scope, so it can only read what
   * they can read.
   *
   * PINNED AT `start` and never reassigned. This field hands out an exemption
   * from the replay gate, so who holds it is a property of the turn, fixed when
   * the run begins. Letting a later event claim it would let any producer in
   * the chain grant that exemption to a caller of its choosing. Empty when the
   * `start` event named nobody, which exempts nobody: both real emitters stamp
   * it on `start`, so an empty value means the turn's requester is genuinely
   * unknown, and the fail-closed answer is to exempt no one.
   */
  requesterId: string
  /**
   * The scopes covering the content recorded SO FAR, or null when they cannot
   * be determined.
   *
   * This is the UNION of every content-bearing tag seen, never just the latest
   * one. The snapshot is served as a single blob, so its tag has to cover every
   * chunk already folded into `content`/`reasoning`/`toolCalls`. Keeping only
   * the latest tag would be correct only while producers never narrow, and that
   * is an invariant nothing here can enforce: a producer that emitted a
   * finance-tagged delta and then an untagged one would re-gate the finance
   * text under the empty set and serve it to a reader who cannot read finance.
   * Unioning makes the guarantee a property of this file rather than of its
   * callers, and it can only ever widen what the replay demands of a reader.
   *
   * Null is FAIL CLOSED and sticky (see `scopesUndeterminable`): the snapshot
   * is served as one blob, so content of unknown provenance anywhere in it
   * makes the whole blob unservable. `[]` is never guessed, because it would
   * assert the turn read nothing scoped.
   */
  accumulatedScopes: string[] | null
  /**
   * Set once any content-bearing event arrives untagged, and never cleared: a
   * later tagged chunk cannot vouch for content already recorded without one.
   */
  scopesUndeterminable: boolean
}

/**
 * The visibility facts a producer stamps on each recorded event, mirroring what
 * it puts on the matching `agent_stream` broadcast so the replay and the live
 * chunk can never disagree. An absent `accumulatedScopes` means the producer
 * genuinely cannot know the turn's set, which fails closed rather than
 * asserting the empty set.
 */
export interface AgentStreamVisibility {
  requesterId?: string
  /** The agent whose turn this is; the registry keys on it. */
  agentId?: string | null
  /** The message that started the turn; the registry keys on it too. */
  turnId?: string | null
  /** The person's message the turn answers (LiveAgentStreamSnapshot.askId); `turnId` when absent. */
  askId?: string | null
  accumulatedScopes?: string[]
}

/** The most tool calls one snapshot keeps (the latest). */
export const MAX_SNAPSHOT_TOOL_CALLS = 200

/** The actions that fold new content into the snapshot, and therefore the ones
 *  whose scope tag decides what the replay may serve. A non-content action (an
 *  out-of-band mailbox request) never changes what the blob discloses. */
export const CONTENT_BEARING_ACTIONS: ReadonlySet<string> = new Set([
  "reasoning",
  "delta",
  "tool_call",
  "tool_result",
])

export const TERMINAL_ACTIONS: ReadonlySet<string> = new Set(["done", "error", "clear"])

/** A producer's scope tag, or null when it did not send a readable one. */
export function readScopeTag(visibility: AgentStreamVisibility): string[] | null {
  const tag = visibility.accumulatedScopes
  if (!Array.isArray(tag) || tag.some((s) => typeof s !== "string")) return null
  return [...tag]
}

/** Fold one event's scope tag into the snapshot, fail closed and sticky. */
export function noteScopeTag(
  snap: LiveAgentStreamSnapshot,
  action: string,
  tag: string[] | null,
): void {
  if (!CONTENT_BEARING_ACTIONS.has(action)) return
  if (snap.scopesUndeterminable) return
  if (tag === null) {
    snap.scopesUndeterminable = true
    snap.accumulatedScopes = null
    return
  }
  // Union, never overwrite: the content already in the blob was folded in under
  // the earlier tags, so dropping them would re-gate it under a narrower set.
  const merged = new Set(snap.accumulatedScopes ?? [])
  for (const scope of tag) merged.add(scope)
  snap.accumulatedScopes = [...merged]
}

/** One recorded event as the registry stores it. */
export interface TurnEntry {
  seq: number
  action: string
  data: Record<string, unknown>
  /** The producer's scope tag (`readScopeTag`), null when it sent none. */
  scopes: string[] | null
  /** The item the registry allocated, empty for an event without one. */
  itemId: string
  at: number
  /** Set on a checkpoint entry: the folded snapshot through `seq`. */
  checkpoint?: LiveAgentStreamSnapshot
}

/** The identity a turn's snapshot starts from (the registry's meta record). */
export interface TurnIdentity {
  threadId: string
  orgId: string
  agentId: string | null
  turnId: string | null
  askId: string | null
  requesterId: string
  startedAt: number
  lastSeenAt: number
}

/**
 * An empty snapshot for a turn. An accepted turn (no `start` yet) starts with
 * unknown scopes (null), so the replay serves it to its requester alone; a
 * `start` replaces it with its own tag.
 */
export function emptySnapshot(
  id: TurnIdentity,
  accumulatedScopes: string[] | null,
  startedAt = id.startedAt,
): LiveAgentStreamSnapshot {
  return {
    threadId: id.threadId,
    agentId: id.agentId,
    turnId: id.turnId,
    askId: id.askId,
    orgId: id.orgId,
    state: "streaming",
    content: "",
    reasoning: "",
    reasoningStreaming: false,
    toolCalls: [],
    timeline: [],
    startedAt,
    lastSeenAt: id.lastSeenAt,
    seq: 0,
    requesterId: id.requesterId,
    accumulatedScopes,
    scopesUndeterminable: false,
  }
}

/** Fold one content event into the snapshot (no `start`, no terminal, no checkpoint). */
export function applyEntry(snap: LiveAgentStreamSnapshot, entry: TurnEntry): void {
  const { action, data, itemId } = entry
  snap.seq = Math.max(snap.seq, entry.seq)
  noteScopeTag(snap, action, entry.scopes)
  switch (action) {
    case "reasoning": {
      const delta = typeof data.delta === "string" ? data.delta : ""
      snap.reasoning += delta
      snap.reasoningStreaming = true
      const last = snap.timeline[snap.timeline.length - 1]
      if (last?.kind === "reasoning" && last.itemId === itemId) last.text += delta
      else snap.timeline.push({ kind: "reasoning", text: delta, itemId })
      return
    }
    case "delta": {
      const delta = typeof data.delta === "string" ? data.delta : ""
      snap.content += delta
      snap.reasoningStreaming = false
      const last = snap.timeline[snap.timeline.length - 1]
      if (last?.kind === "text" && last.itemId === itemId) last.text += delta
      else if (delta) snap.timeline.push({ kind: "text", text: delta, itemId })
      return
    }
    case "tool_call": {
      const toolCallId = String(data.toolCallId ?? "")
      // One call recorded once (a producer that re-sends a step), and a
      // bounded snapshot: a very long turn keeps its latest steps.
      if (snap.toolCalls.some((t) => t.toolCallId === toolCallId)) return
      if (snap.toolCalls.length >= MAX_SNAPSHOT_TOOL_CALLS) {
        const dropped = snap.toolCalls.shift()
        snap.timeline = snap.timeline.filter(
          (e) => e.kind !== "tool" || e.toolCallId !== dropped?.toolCallId,
        )
      }
      snap.toolCalls.push({
        toolCallId,
        toolName: String(data.toolName ?? ""),
        args: data.args,
        status: "running",
        ...(typeof data.summary === "string" && data.summary ? { summary: data.summary } : {}),
        ...(typeof data.readOnly === "boolean" ? { readOnly: data.readOnly } : {}),
        ...(typeof data.appLabel === "string" ? { appLabel: data.appLabel } : {}),
        ...(typeof data.runningLabel === "string" ? { runningLabel: data.runningLabel } : {}),
        ...(typeof data.runningLabelKey === "string"
          ? { runningLabelKey: data.runningLabelKey }
          : {}),
      })
      snap.timeline.push({ kind: "tool", toolCallId, itemId: itemId || toolCallId })
      return
    }
    case "tool_result": {
      const call = snap.toolCalls.find((t) => t.toolCallId === data.toolCallId)
      if (call) {
        call.result = data.result
        call.status =
          typeof data.result === "object" && data.result !== null && "error" in data.result
            ? "error"
            : "completed"
        if (data.card) call.card = data.card as ResolvedCard
        if (data.cardError) call.cardError = data.cardError as { pill: CardLabel }
      }
      return
    }
  }
}

/**
 * Fold a turn's recorded entries (stream order) into its snapshot.
 *
 * The base is the newest checkpoint when there is one (it carries the fold
 * through its `seq`, the requester pin and the scope tag), else an accepted
 * turn's empty snapshot. Entries at or below the base's `seq` are already in
 * it: a checkpoint is appended at the stream's tail, after any entries other
 * producers added while it was being written, so those are applied after it by
 * `seq`. A `start` resets the turn.
 */
export function foldTurn(id: TurnIdentity, entries: TurnEntry[]): LiveAgentStreamSnapshot {
  let snap = emptySnapshot(id, null)
  let base = 0
  for (const e of entries) {
    if (e.checkpoint && e.seq >= base) {
      base = e.seq
      snap = cloneSnapshot(e.checkpoint)
    }
  }
  for (const e of entries) {
    if (e.checkpoint || e.seq <= base) continue
    if (e.action === "start") {
      snap = emptySnapshot(id, e.scopes, e.at)
      snap.seq = e.seq
      continue
    }
    if (TERMINAL_ACTIONS.has(e.action)) {
      snap.seq = Math.max(snap.seq, e.seq)
      continue
    }
    applyEntry(snap, e)
  }
  snap.lastSeenAt = Math.max(snap.lastSeenAt, id.lastSeenAt)
  return snap
}

function cloneSnapshot(s: LiveAgentStreamSnapshot): LiveAgentStreamSnapshot {
  return {
    ...s,
    toolCalls: s.toolCalls.map((t) => ({ ...t })),
    timeline: s.timeline.map((e) => ({ ...e })),
    accumulatedScopes: s.accumulatedScopes ? [...s.accumulatedScopes] : null,
  }
}
