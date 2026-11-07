// SPDX-License-Identifier: FSL-1.1-ALv2
//
// AsyncLocalStorage frame for the currently-executing agent run (chat or
// sub-run). Audit-log inserts, approval inserts, and any other call-site
// that needs to stamp `runId` / `parentRunId` into `metadata` jsonb consult
// this store rather than threading the values through every function
// signature.
//
// The frame is set in two places:
//   - `subrun-worker.ts` wraps each sub-run's body in `runContextStore.run(...)`.
//   - (future) `agent-service.ts` will wrap `runAgentChat` similarly when
//     parent runs gain stable ids.
//
// Reads are `runContextStore.getStore()` — returns `undefined` outside any
// agent run, in which case callers fall back to their existing path.

import { AsyncLocalStorage } from "node:async_hooks"
import type { RunTokenAccount, SubRunTokenLimit } from "~/modules/agent/runtime/run-token-limit"
import type { ClipLedger } from "~/modules/agent/runtime/stale-result-clipper"
import type { TurnEffectKeys } from "~/modules/agent/runtime/tool-effect-key"
import type { TurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"

/**
 * The turn-scoped mailbox decrypt budget (blueprint Task 9.2, amendment A22).
 *
 * ONE balance per turn, drawn down by every decrypt request. A per-request wait
 * multiplied by the per-turn request cap would exceed the turn budget itself, so
 * the balance, not the individual wait, is what bounds a locked mailbox's cost.
 */
export interface MailboxTurnState {
  /** Milliseconds of waiting this turn may still spend on mail decryption. */
  remainingWaitMs: number
  /** Decrypt requests already made in this turn. */
  requests: number
  /** Messages the client has released to this turn. Reported, never enforced
   *  here: the enforcing caps live in the browser, where the key is. */
  releasedMessages: number
}

/** A running turn's handle on its durable record (RunContext.turnRecord). */
export interface TurnRecordHandle {
  turnId: string
  orgId: string
  /** The process that owns the turn (INSTANCE_ID). */
  runner: string
  effectKeys: TurnEffectKeys
  /** Set once a journal write answered "fenced": another process owns the turn. */
  fenced: boolean
  /** The signal tools get: trips on everything but a drain handoff. */
  toolSignal?: AbortSignal
}

/** A loaded tool as the model is told about it in the conversation. */
export interface LoadedToolSchema {
  name: string
  description: string
  parameters: unknown
}

/** What a routine turn that met its owner's locked private mailbox records. */
export interface RoutineMailboxWaitSignal {
  /** True once a read needed the owner's private mailbox and nobody could answer it. */
  needed: boolean
  /** The private mailboxes (mail account ids) the reads touched, when known. */
  accountIds: string[]
}

/** One message the owner's browser opened for a Run now (subject and bodies only). */
export interface MailboxHandoffItem {
  messageId: string
  subject?: string | null
  textBody?: string | null
  htmlBody?: string | null
}

/**
 * The mail the owner's browser opened at Run now for THAT run
 * (routine-mailbox-wait.ts): the message(s) that started it. Held in memory on
 * the run's frame only, for the run's lifetime, and emptied when the run ends.
 * Never written anywhere. Its presence also marks the run as a Run now, so a
 * further private read with no browser to answer gets the named
 * "needs your open Liaison window" result.
 */
export interface MailboxHandoff {
  items: Map<string, MailboxHandoffItem>
}

export interface RunContext {
  runId: string
  parentRunId: string | null
  rootRunId: string
  nestingDepth: number
  /**
   * True when the run that owns this ALS frame is background work (a sub-agent
   * run, or a chat invoked by the routine-worker / a job-driven re-invocation)
   * rather than a live foreground user request. Tool dispatch derived from this
   * frame (tool-bridge.executeWrapper) tags the worker-pool exec "background" so
   * it cannot starve foreground tool calls. Undefined/false ⇒ interactive.
   */
  background?: boolean
  /**
   * Set when the run that owns this ALS frame is a routine tick. Routine-only
   * kernel tools (`watch_state`, `web_watch`) derive their `routineId` from this
   * and are filtered out of the tool set for any run that lacks it (interactive
   * chat, sub-runs). Undefined ⇒ not a routine tick.
   */
  routineId?: string
  /** On a routine tick: this routine follows up, so its mail runs the send check as a follow-up. */
  routineFollowUp?: boolean
  /**
   * On a routine tick (and the agent turn it starts for that same routine):
   * the person whose SERVER-MANAGED mailbox the tick may read, its owner, set
   * only when the routine and this run of it are the owner's own doing
   * (routine-mailbox-trust.ts). Absent: a server-side mailbox read is locked.
   */
  routineMailboxReaderUserId?: string
  /**
   * On a routine tick whose owner may read their own mailbox (above): the
   * signal a read of the owner's LOCKED PRIVATE mailbox leaves, so the worker
   * parks the run for the owner's Run now instead of ending it
   * (routine-mailbox-wait.ts). Shared BY REFERENCE between the tick frame and
   * the turn of that tick. Absent: nothing parks.
   */
  routineMailboxWait?: RoutineMailboxWaitSignal
  /** On a Run now of a waiting run: the mail its owner's browser opened for it (above). */
  mailboxHandoff?: MailboxHandoff
  /**
   * True when the person started this turn from a restricted (device-flow)
   * session (modules/auth/session-ceiling.ts). A tool whose REST counterpart
   * refuses such a session (`assertUnrestrictedSession`) refuses here too.
   */
  sessionRestricted?: boolean
  /**
   * True when the call came over the MCP gateway (an agent-bound connection:
   * a device-grant client, a script, the desktop's agent connection), not
   * from a turn the person started in Liaison. Nothing proves a person is
   * behind such a call, so tools that act only on the person's own live
   * request (the notification settings changes, steering a session on their
   * computer) refuse it. With the turn credential (`gatewayTurn`, S59) the
   * session tools read, stop and change settings as in the cloud, while send,
   * answer and an autonomy change park (D37). Set by mcp/tool-call.ts on the
   * frame it builds.
   */
  mcpGateway?: boolean
  /**
   * The gateway proved this call answers that person's message in a claimed
   * conversation (S59, D37): the desktop's local turn presented the turn
   * credential minted for that message (agent/local-sessions/turn-credential.ts)
   * on the person's own desktop agent connection. NOT a human-typed turn: the
   * local CLI's own reads (files, web pages, tool output) never reach server
   * taint, so `humanTurn` stays unset and every `requiresHumanTurn` tool still
   * parks. Set only by mcp/tool-call.ts, alongside `mcpGateway`. Never copied
   * by a spawn (`captureSpawnParentFrame`) nor into an `agents_ask` callee's
   * frame: those start from their own frame.
   */
  gatewayTurn?: { threadId: string; messageId: string }
  /**
   * True when an AGENT, not a person, started this turn: an `agents_ask`
   * question (or any coordinated hand off, `TurnCoordination`). Tools that act
   * only on a person's live request (the notification settings tools) refuse
   * here. Undefined => a turn started by a human message.
   */
  coordinated?: boolean
  /**
   * Who handed this coordinated turn over. "agent": a colleague's
   * `agents_ask`. "external-app": a PERSON asking from an external MCP client
   * (an ask with no calling agent). Read only to word a refusal truthfully:
   * telling a person their own question came "from another agent" is false,
   * and it sent the agent looking for that agent. Undefined when not coordinated.
   */
  coordinatedBy?: "agent" | "external-app"
  /**
   * True ONLY on the frame of a foreground chat turn a person typed in the app. Absent on a routine
   * tick, a background / job-driven re-invocation, a sub-run, an agent-to-agent ask, a restricted
   * session's message and the MCP gateway's frame. Tools that run code on the person's machine park for approval unless it is set
   * (`isHumanTypedTurn`, scopes/taint.ts). Set at the one place a person's message starts a turn.
   */
  humanTurn?: boolean
  /**
   * A demo visitor's turn (box key or the visitor's own key): its tool results
   * reach the model at the visitor limits (result-truncation.ts).
   */
  visitorTurn?: boolean
  /**
   * Mutable set of deferred-tool SDK names the model has unlocked in THIS run
   * (seeded from the thread's persisted discoveries). The `tool_search` kernel
   * handler adds every usable match it returns; the agent loop's `prepareStep`
   * reads it to expand `activeTools` on the next step. Absent for callers that
   * bypass discovery (sub-agent allowlists, the MCP gateway's own flow).
   */
  discoveredTools?: Set<string>
  /**
   * How many tool searches this run has made (tool-search.ts). On a demo
   * visitor's turn, past TOOL_SEARCH_LIMIT_PER_TURN a search unlocks nothing
   * more: a weak model looped on tool_search until its turn ran out.
   */
  toolSearchCount?: number
  /**
   * The SDK names of every tool this run's tool set holds (deferred ones
   * included), after its scope, hidden-app and allowlist filters. tool_search
   * tells the agent a name is ALREADY LOADED only when it is in here. Absent
   * outside a chat turn's frame.
   */
  turnToolNames?: ReadonlySet<string>
  /**
   * The thread's fixed tool list (providers/fixed-tool-list.ts) and what a
   * tool loaded outside it looks like to the model. A loaded tool not in
   * `listed` is called through `kernel__call_tool`; tool_search says so.
   * Absent when the turn sends every loaded tool (no fixed list).
   */
  fixedToolList?: {
    /** The tools the provider is shown, for the whole thread. */
    listed: ReadonlySet<string>
    /** True when the turn holds `name` loaded (callable now). */
    isLoaded: (name: string) => boolean
    /** A loaded tool's description and parameters (JSON Schema), as the provider would see them. */
    describe: (name: string) => LoadedToolSchema | null
    /** Checks `args` against a loaded tool's input schema. */
    validate: (name: string, args: unknown) => Promise<{ ok: true } | { ok: false; error: string }>
    /**
     * Records that the model asked for these loaded tools (a search naming
     * them, a call): one loaded by name only (guide-notes.ts,
     * renderIndexedToolsBlock) gets its schema in the next note.
     */
    requestSchemas?: (names: readonly string[]) => void
  }
  /**
   * Adds to this run's tool set the named tools that were registered after the
   * set was built, and returns which of `names` the run can call now. A
   * connected MCP server whose tool list was not stored yet gets it from the
   * dial tool_search makes (`ensureOrgToolLists`), mid-turn: without this, the
   * tools tool_search reported as loaded were callable only from the next
   * turn. Absent outside a loop that owns its tool set (the MCP gateway).
   */
  admitTools?: (names: readonly string[]) => ReadonlySet<string>
  /**
   * Lazily-created record of failing tool calls in THIS run, keyed by
   * toolName + serialized args, holding the STEPS each one failed in. Lets the
   * tool bridge detect a model stuck re-issuing the exact same failing call
   * and escalate the error wording (weak models otherwise loop until
   * maxSteps). Parallel siblings of one step are one decision, so a step
   * counts once.
   */
  toolFailureCounts?: Map<string, Set<string>>
  /**
   * The kernel tools whose full result rule the conversation this run sends
   * already holds (kernel-result-hints.ts): their later results carry a short
   * marker. Absent: every result carries the full rule.
   */
  resultHintsShown?: Set<string>
  /**
   * The run's clip ledger (stale-result-clipper.ts): which tool results the
   * run clipped, and which it keeps whole. Absent outside a run that clips.
   */
  clipLedger?: ClipLedger
  /**
   * The pages this run fetched (web-fetch-repeat.ts), by URL, mode and query:
   * the content and the call that brought it. Created on the first fetch.
   */
  fetchedPages?: Map<string, { content: string; toolCallId: string }>
  /**
   * Lazily-created record of NON-RETRYABLE (`details.retryable === false`)
   * tool failures in THIS run, keyed by toolName alone (args vary while the
   * cause — a config/state error like a missing issuer profile — does not),
   * holding the STEPS the tool failed in. Once a tool has failed in
   * terminal-failure-limit distinct steps the bridge refuses further calls to
   * it for the rest of the run instead of executing them, breaking the
   * crash-loop-with-varied-args pattern that burns full-context steps.
   */
  toolTerminalFailures?: Map<string, Set<string>>
  /**
   * The nonce the CLIENT minted when the user submitted this turn, forwarded by
   * `POST /api/agent/chat`. Its absence is meaningful: a turn with no nonce was
   * not started by a browser that can answer a decrypt request, so the mailbox
   * read path takes the locked branch without asking anyone.
   */
  mailboxTurnNonce?: string
  /** Lazily created on this turn's first mailbox decrypt request. */
  mailbox?: MailboxTurnState
  /**
   * The `kernel.agents` row this turn is acting as; absent for a
   * pre-agents-migration or agent-less caller, in which case `buildToolSet`
   * falls back to today's actor-scope-only behavior unchanged.
   */
  agentId?: string
  /**
   * The acting agent's `scopeCeiling` at the start of the turn; paired with
   * `agentId`, both present or both absent.
   */
  agentCeiling?: string[]
  /**
   * This turn's D2 effective scope, computed once via
   * `computeEffectiveScopeForTurn` before the tool catalog is built; when
   * present it, not `actorScopes` alone, is the scope set `buildToolSet`
   * filters against.
   */
  effectiveScope?: string[]
  /**
   * Ceiling scopes this turn's room floor withheld, as raw scope strings. The
   * names are private to the requester: they never go into a room message, a
   * room event or the model context, and reach the requester's card only as
   * `describeWithheldCapabilities` category labels.
   */
  withheld?: string[]
  /**
   * True when this run may READ but not WRITE. Set by the Share anyway rerun
   * (spec-security.md D4), which re-answers a withheld turn and must not repeat
   * the side effects the original turn already had. Undefined ⇒ an ordinary
   * run, which may write.
   *
   * This is a property of the RUN, and the write boundaries are what enforce it:
   * `buildToolSet` admits only `readOnly` tools into the catalog and the tool
   * bridge refuses a write that reaches it anyway, but both of those read the
   * tool's own APP-SUPPLIED marker, so neither can be the only layer. The
   * boundaries that check this mark instead are the sandbox bridge's write RPCs
   * and `executeToolCore`. Across a hop that loses the frame, they read it
   * through `captureReadOnlyRun`, never from the tool declaration.
   */
  readOnlyTools?: boolean
  /**
   * Unions the declared scopes of every tool this turn calls; the tool
   * bridge records each call before the tool runs. Absent for callers that
   * never build one (the MCP gateway), which then record nothing.
   */
  turnScopeAccumulator?: TurnScopeAccumulator
  /**
   * The message that triggered THIS turn (P3b). A question `agents_ask` posts
   * hangs under it, which is what makes the ask chain exactly one link deep per
   * hop: a turn triggered by a question nests its own question under that same
   * question, and the guard reads the hop depth straight off the chain.
   */
  turnMessageId?: string
  /**
   * The PERSON'S message this turn ultimately answers. For a turn a person's
   * message started it is `turnMessageId`; for the turn an approved call hands
   * back (approval-result-turn.ts) it is the ask of the turn that raised the
   * approval, carried on the approval row (`metadata.askId`), so a chain of
   * approvals keeps the root ask. A gated call records it on its approval, and
   * the answer the turn saves carries it, which is what lets a view find "the
   * answer to this question" however many approvals came in between.
   */
  askId?: string
  /**
   * The reply thread this turn answers in (0112, A7): the root of the reply
   * thread and the thread it lives in. A write made from inside the frame
   * about THIS thread (a gated tool's approval card) lands in that reply
   * thread. Scoped to the thread on purpose: a tool posting into ANOTHER
   * thread is not answering here. Absent for a channel turn.
   */
  replyRoot?: { threadId: string; rootMessageId: string }
  /**
   * True while this turn has an `agents_ask` waiting for its answer. One
   * outstanding ask per turn: a model that fans five asks out and waits on all
   * of them is the cost blow up this slice exists to rule out. Mutated on the
   * live frame, so it is false again the moment the ask returns.
   */
  agentAskInFlight?: boolean
  /**
   * Set by the tool bridge the first time a tool call is refused by scope
   * taint (`E_SCOPE_TAINT_BLOCKED`). It is what the requester's withheld card
   * reads to decide that "Share anyway" must not be offered: a rerun of this
   * turn hits the same refusal, so the offer would cost a model call to
   * produce the identical answer. Absent means no call was refused that way.
   */
  scopeTaintRefused?: boolean
  /**
   * The tool calls of THIS turn that marked its thread as having read outside text while they ran
   * (the tool bridge records them, scopes/taint.ts `watchTaintMarks`). Stored on each call's
   * persisted metadata as `tainted`, which is what a later turn replaying the call is judged by.
   * Absent for a run that persists no tool calls of its own.
   */
  taintedToolCallIds?: Set<string>
  /**
   * The durable turn record this run journals into (turn-ledger.ts, S10).
   * Present for every turn `runAgentChat` runs; absent for sub-runs, the MCP
   * gateway and tests that build a frame by hand. The tool bridge runs every
   * write tool of such a turn through the effect ledger keyed by `effectKeys`
   * (tool-effect-key.ts), and hands tools `toolSignal`, which a drain handoff
   * does not trip (a tool already running finishes; only the model call is
   * cut), while a user cancel or a timeout still does.
   */
  turnRecord?: TurnRecordHandle
  /**
   * The routine run's token account (S17, A34): its budget, its hard limit and
   * the tokens spent so far. Shared BY REFERENCE with every turn started inside
   * the run (the tick's own turn, an `agents_ask` callee's turn), so a sub-run's
   * tokens count toward the parent's limit. Absent when the routine sets
   * neither field, and for every run that is not a routine tick.
   */
  tokenAccount?: RunTokenAccount
  /**
   * The routine RUN this turn belongs to: the tick's own id, kept by every turn
   * of the run, its resumes included. A gated call records it on its approval,
   * which is how the run knows what it waits for (routine-run-resume.ts).
   * Inherited like `tokenAccount`. Absent for every run that is not a routine's.
   */
  routineRunId?: string
}

export const runContextStore = new AsyncLocalStorage<RunContext>()

/**
 * What a turn started inside a run takes from the frame it was started in: the run's token account
 * (by reference) and the routine run it belongs to. Every other field is the turn's own. One place, so a field the run owns cannot be dropped by one turn path.
 */
export function inheritedRunFields(
  frame: RunContext | undefined,
): Pick<RunContext, "tokenAccount" | "routineRunId"> {
  return {
    ...(frame?.tokenAccount ? { tokenAccount: frame.tokenAccount } : {}),
    ...(frame?.routineRunId ? { routineRunId: frame.routineRunId } : {}),
  }
}

/**
 * Whether a person is behind this turn: one they typed in Liaison, or the
 * desktop's local turn answering their message (gateway turn credential).
 * Never a routine tick, a background or coordinated turn, or an MCP call that
 * proves no person. Recorded on an approval at hold time
 * (`metadata.originHasPerson`) because the approved re-entry runs outside the
 * frame.
 */
export function runHasPerson(frame: RunContext): boolean {
  if (frame.routineId || frame.background || frame.coordinated) return false
  return frame.humanTurn === true || frame.gatewayTurn !== undefined
}

export function currentRunContext(): RunContext | undefined {
  return runContextStore.getStore()
}

/**
 * The turn's accumulated scopes as they stood when the tool call now running
 * was admitted, before that call recorded its own. Set by the tool bridge
 * around each invocation under a frame that carries an accumulator; a spawn
 * reads it as the parent's taint to hand to the child.
 */
const toolCallScopesBeforeStore = new AsyncLocalStorage<string[]>()

export function runWithToolCallScopesBefore<T>(scopesBefore: string[], fn: () => T): T {
  return toolCallScopesBeforeStore.run(scopesBefore, fn)
}

export function currentToolCallScopesBefore(): string[] | undefined {
  return toolCallScopesBeforeStore.getStore()
}

/**
 * Is the run that owns the CURRENT frame read-only (spec-security.md D4)?
 *
 * Captured where the frame is still live, exactly as `captureSpawnParentFrame`
 * is, and for the same reason: a sandboxed app's bridge callbacks run in a
 * worker-pool hop where `currentRunContext()` is undefined, so a write attempted
 * there would look like a write from no run at all. The bridge captures this at
 * construction (host side, in frame) and every write RPC consults the capture.
 *
 * No frame means no agent run, which is not a read-only run: a human request,
 * a job or a webhook may write.
 */
export function captureReadOnlyRun(): boolean {
  return currentRunContext()?.readOnlyTools === true
}

/**
 * The agent acting in the CURRENT turn, for an emitter that wants to stamp the
 * identity onto the event it is about to queue (A11).
 *
 * Null outside any frame, which is the true answer there: a human request, a
 * job or a webhook has no acting agent. A caller that has already crossed a hop
 * losing the frame must use the captured `SpawnParentFrame.agentId` instead,
 * and a caller whose frame was never opened around it (the agent reply, which
 * plumbs the frame into `buildToolSet` rather than wrapping itself in it) is
 * handed the id explicitly. Never guessed: unknown reads as no agent.
 *
 * "Capture" here means READ WHILE THE FRAME IS STILL LIVE, the same sense as
 * `captureReadOnlyRun` above. It is exactly `currentRunContext()?.agentId`:
 * nothing is stashed and nothing is carried across a hop. So calling it where
 * the frame is already live and passing the result on buys EXPLICITNESS, never
 * a different value than the emitter's own frame read would have produced
 * (`stampActingAgentId`, db/queue-event.ts). Where that distinction matters is
 * the opposite case: a positive `null` from a human path, which outranks the
 * frame.
 */
export function captureActingAgentId(): string | null {
  return currentRunContext()?.agentId ?? null
}

/**
 * What a spawn takes from the calling turn's frame. `taintScopes` is undefined
 * when the frame carries no accumulator: the parent's taint is unknown there.
 */
export interface SpawnParentFrame {
  effectiveScope?: string[]
  taintScopes?: string[]
  /**
   * The acting agent of the turn this frame was captured from, so a write made
   * after a hop that loses the frame can still record WHICH agent acted (A11).
   * Undefined when no agent was resolvable for the turn.
   */
  agentId?: string
  /**
   * The calling run's hard token limit and shared counter id (S17, A34), so a
   * job-queue sub-run spawned from it counts toward the same limit. Absent when
   * the run has no hard limit.
   */
  tokenLimit?: SubRunTokenLimit
  /**
   * The run that owns the frame: its id, root and nesting depth. A spawn made
   * after a hop that loses the frame (a trusted app's `ctx.agent.spawn`) nests
   * its child one level below THIS run, so a depth-2 sub-run cannot reach a
   * fresh depth-0 chain through an app tool (MAX_NESTING_DEPTH).
   */
  run?: { runId: string; rootRunId: string; nestingDepth: number }
  /**
   * The message the captured turn answers (`RunContext.turnMessageId`), so an
   * event queued after a hop that loses the frame still says which request
   * caused it (a guided tour's `causedBy` binding reads it). Undefined when the
   * frame names none.
   */
  turnMessageId?: string
}

/**
 * The current frame's spawn view, or null outside any frame. Captured where the
 * frame is live, so a spawn made after a hop that loses it (a sandbox bridge
 * callback) still sees the calling turn.
 *
 * By default the taint is the snapshot from before the running tool call
 * recorded its own scope: the kernel spawn_agent path, whose own
 * `kernel:agents:spawn` scope is not a data read. `includeCallingTool` takes the
 * accumulator as it stands now, after that record: a sandbox bridge uses it,
 * because the app tool that spawns has itself read what its scope covers.
 */
export function captureSpawnParentFrame(
  opts: { includeCallingTool?: boolean } = {},
): SpawnParentFrame | null {
  const frame = currentRunContext()
  if (!frame) return null
  const accumulator = frame.turnScopeAccumulator
  let taintScopes: string[] | undefined
  if (accumulator) {
    taintScopes = opts.includeCallingTool
      ? accumulator.snapshot()
      : (currentToolCallScopesBefore() ?? accumulator.snapshot())
  }
  const account = frame.tokenAccount
  return {
    effectiveScope: frame.effectiveScope,
    taintScopes,
    agentId: frame.agentId,
    run: { runId: frame.runId, rootRunId: frame.rootRunId, nestingDepth: frame.nestingDepth },
    ...(frame.turnMessageId ? { turnMessageId: frame.turnMessageId } : {}),
    ...(account?.hardTokenLimit != null
      ? { tokenLimit: { accountId: account.id, hardTokenLimit: account.hardTokenLimit } }
      : {}),
  }
}
