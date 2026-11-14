// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The demo replay: a recorded coding-agent session played on a simulated node
// of a demo org, so the developer scenario shows a live session (stream, tool
// calls, a permission request, a pull request) with no machine behind it.
//
// - The node is `kernel.nodes.simulated` (0193): no credential, only in a demo
//   org, named "Demo laptop (recorded)", device id `demo-replay`. Every
//   node-auth path refuses it, nothing is ever offered to it, the lease sweeps
//   leave its job alone, and presence reports it online without a socket.
// - The session is an ordinary node session (`createSessionForJob`, source
//   `dispatch`) whose job the simulated node holds from the start. Its events
//   come from `recording.json` through `appendReplayEvents`, the one writer
//   that refuses anything but a simulated node of a demo org.
// - Pacing is the recording's, scaled down so the longest path lasts at most
//   90 s. At the permission request the ticker waits for the owner's
//   `permission_decision` command, acks it, appends the decision and the
//   durable `kernel/node_session:replay_step` a guided tour completes on, then
//   plays the rest (Allow) or a short "stopped by you" ending (Deny).
// - The cursor is the session's own event log (already durable): a ticker
//   killed mid-replay continues from the next recorded event on the leader's
//   next boot (resume.ts), never appending one twice. A Redis lock keeps one
//   ticker per session across processes.
// - No process is spawned and nothing leaves the box: the ticker only writes
//   rows, in the API's leader process.
import {
  NODE_SESSION_EVENT_TYPES,
  type NodeSessionEventIn,
  type NodeSessionStatus,
} from "@liaison/shared"
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm"
import { z } from "zod"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import {
  agents,
  nodeJobs,
  nodeSessionCommands,
  nodeSessionEvents,
  nodeSessions,
  nodes,
} from "~/db/schema/kernel"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { demoWorldOf, isDemoOrgId, loadDemoMarker } from "~/modules/demo/demo-org"
import saasRecordingJson from "~/modules/demo/worlds/saas/recording.saas.json"
import {
  type Appended,
  appendReplayEvents,
  createSessionForJob,
  fanOut,
  type NodeSessionRow,
} from "~/modules/node-sessions/store"
import { fireSessionStatus, fireSessionWaiting } from "~/modules/node-sessions/waiting-hook"
import type { NodeRow } from "~/modules/nodes/credentials"
import { notifyNodePresence } from "~/modules/nodes/node-broadcast"
import recordingJson from "./recording.json"

const log = rootLogger.child({ module: "demo-replay" })

/** The simulated node's device id and name (one per visitor). */
export const REPLAY_DEVICE_ID = "demo-replay"
export const REPLAY_NODE_NAME = "Demo laptop (recorded)"
/** The job's `source_ref`: how a replay's job is told apart from any other. */
export const REPLAY_SOURCE_REF = "demo-replay"
/** The longest path of a replay, start to end, at most (pacing is scaled to fit). */
export const REPLAY_MAX_MS = 90_000
/** How long the ticker waits for the owner's decision before it parks (the session stays waiting). */
export const REPLAY_DECISION_WAIT_MS = 30 * 60_000
/** How often the ticker looks for the owner's commands while it waits. */
export const REPLAY_POLL_MS = 1_000
/** The most events a recording may hold. */
export const REPLAY_MAX_EVENTS = 200
/**
 * The tour steps a replay queues: `asked` when the recorded permission request
 * lands on the session (the scenario waits on it instead of on the screen),
 * then `approved` or `denied` when the owner answers it.
 */
export const REPLAY_STEP_ASKED = "asked"
export const REPLAY_STEP_APPROVED = "approved"
export const REPLAY_STEP_DENIED = "denied"

const LOCK_TTL_MS = 120_000
const lockKey = (sessionId: string) => `demo:replay:lock:${sessionId}`

// ── the recording ───────────────────────────────────────────────────────────

const recordedEventSchema = z
  .object({
    delayMs: z.number().int().min(0).max(30_000),
    type: z.enum(NODE_SESSION_EVENT_TYPES),
    parentToolUseId: z.string().max(200).optional(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict()

export const recordingSchema = z
  .object({
    version: z.literal(1),
    title: z.string().min(1).max(120),
    prompt: z.string().min(1).max(2000),
    repo: z.string().min(1).max(200),
    model: z.string().min(1).max(100),
    branch: z.string().min(1).max(255),
    events: z.array(recordedEventSchema).min(1),
    denied: z.array(recordedEventSchema).min(1),
  })
  .strict()
  .refine((r) => r.events.length + r.denied.length <= REPLAY_MAX_EVENTS, "too many events")
  .refine(
    (r) => r.events.filter((e) => e.type === "permission_request").length === 1,
    "exactly one permission request",
  )

export type Recording = z.infer<typeof recordingSchema>
export type RecordedEvent = Recording["events"][number]

/** The committed recording, validated once at load: the products world's. */
export const RECORDING: Recording = recordingSchema.parse(recordingJson)

/** The software world's recording: a fix to a customer's reported bug. */
const SAAS_RECORDING: Recording = recordingSchema.parse(saasRecordingJson)

/**
 * The recording the org's world plays: each world's developer scenario has its
 * own. A world without one plays the products world's.
 */
export async function recordingOf(orgId: string): Promise<Recording> {
  return demoWorldOf(await loadDemoMarker(orgId)) === "saas" ? SAAS_RECORDING : RECORDING
}

/** Event types the server (or the replay's decision step) writes; never a recorded one. */
const SERVER_TYPES = new Set(["status", "decision", "command_applied"])

function permissionIndex(recording: Recording): number {
  return recording.events.findIndex((e) => e.type === "permission_request")
}

function permissionRequestId(recording: Recording): string {
  const id = recording.events[permissionIndex(recording)]?.payload.requestId
  return typeof id === "string" ? id : ""
}

const sum = (events: readonly RecordedEvent[]) => events.reduce((n, e) => n + e.delayMs, 0)

/**
 * The factor every recorded delay is multiplied by: 1 when the longest path
 * (Allow, or the events up to the request plus the Deny ending) fits in
 * REPLAY_MAX_MS, less otherwise.
 */
export function pacingFactor(recording: Recording = RECORDING): number {
  const upToRequest = recording.events.slice(0, permissionIndex(recording) + 1)
  const longest = Math.max(sum(recording.events), sum(upToRequest) + sum(recording.denied))
  return longest <= REPLAY_MAX_MS ? 1 : REPLAY_MAX_MS / longest
}

// ── the simulated node ──────────────────────────────────────────────────────

/** A replay was refused (not a demo org, or the device id is a real node's). */
export class ReplayRefusedError extends Error {
  constructor(readonly reason: "not_demo_org" | "device_taken" | "no_agent") {
    super(`demo replay refused: ${reason}`)
    this.name = "ReplayRefusedError"
  }
}

/**
 * The visitor's simulated node, created on first use. Only in a demo org
 * (checked here and, under it, by the 0193 trigger). A real node already
 * bound to the same device id (enabled by hand) is never taken over.
 */
export async function ensureSimulatedNode(orgId: string, ownerUserId: string): Promise<NodeRow> {
  if (!(await isDemoOrgId(orgId))) throw new ReplayRefusedError("not_demo_org")
  return withPrivilegedDb(orgId, "demo-replay:node", async (tx) => {
    await tx
      .insert(nodes)
      .values({
        orgId,
        ownerUserId,
        deviceId: REPLAY_DEVICE_ID,
        name: REPLAY_NODE_NAME,
        os: "macos",
        simulated: true,
        credentialHash: null,
      })
      .onConflictDoNothing({ target: [nodes.ownerUserId, nodes.deviceId] })
    const [row] = await tx
      .select()
      .from(nodes)
      .where(
        and(
          eq(nodes.orgId, orgId),
          eq(nodes.ownerUserId, ownerUserId),
          eq(nodes.deviceId, REPLAY_DEVICE_ID),
        ),
      )
    if (!row?.simulated) throw new ReplayRefusedError("device_taken")
    if (!row.enabled || row.revokedAt) {
      const [back] = await tx
        .update(nodes)
        .set({ enabled: true, revokedAt: null, updatedAt: new Date() })
        .where(and(eq(nodes.id, row.id), eq(nodes.orgId, orgId)))
        .returning()
      return back
    }
    return row
  })
}

/**
 * The visitor's recorded laptop, ready before anything is dispatched to it:
 * the developer scenario's start creates it (demo-seeder.ts,
 * `prepareDemoScenario`), so Sessions lists it and the agent can hand it the
 * request. The owner's open clients learn it is online: it has no socket
 * whose hello would say so, and a Sessions page loaded before it existed
 * would otherwise show "No computer" and read its session as paused, hiding
 * its permission request (walk D25). Refused outside a demo org.
 */
export async function prepareRecordedLaptop(orgId: string, ownerUserId: string): Promise<NodeRow> {
  const node = await ensureSimulatedNode(orgId, ownerUserId)
  await notifyNodePresence({ orgId, ownerUserId, nodeId: node.id, online: true })
  return node
}

/** The agent the replay is dispatched by: @engineering, else the owner's own agent, else the first one. */
async function replayAgentId(orgId: string, ownerUserId: string): Promise<string> {
  const rows = await withPrivilegedDb(orgId, "demo-replay:agent", (tx) =>
    tx
      .select({
        id: agents.id,
        handle: agents.handle,
        kind: agents.kind,
        owner: agents.ownerUserId,
      })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), isNull(agents.archivedAt)))
      .orderBy(asc(agents.createdAt)),
  )
  const pick =
    rows.find((a) => a.handle === "@engineering") ??
    rows.find((a) => a.kind === "personal" && a.owner === ownerUserId) ??
    rows[0]
  if (!pick) throw new ReplayRefusedError("no_agent")
  return pick.id
}

/**
 * The owner's recorded laptop, when their demo org has one turned on: the
 * computer an agent's `run_on_my_computer` hands work to in a demo workspace
 * (it plays the recording). Null outside a demo org, and before the developer
 * scenario's start created it.
 */
export async function recordedLaptopOf(
  orgId: string,
  ownerUserId: string,
): Promise<NodeRow | null> {
  if (!(await isDemoOrgId(orgId))) return null
  const [row] = await withPrivilegedDb(orgId, "demo-replay:laptop", (tx) =>
    tx
      .select()
      .from(nodes)
      .where(
        and(
          eq(nodes.orgId, orgId),
          eq(nodes.ownerUserId, ownerUserId),
          eq(nodes.deviceId, REPLAY_DEVICE_ID),
          eq(nodes.simulated, true),
          eq(nodes.enabled, true),
          isNull(nodes.revokedAt),
        ),
      )
      .limit(1),
  )
  return row ?? null
}

// ── start ───────────────────────────────────────────────────────────────────

export interface StartedReplay {
  sessionId: string
  jobId: string
  nodeId: string
  /** False when a replay of this owner was already playing (it is returned). */
  created: boolean
}

/**
 * Create the replay's job and session on the owner's simulated node and
 * start its ticker. A replay of the owner that has not ended yet is returned
 * instead of a second one, unless it started before `notBefore`, or the
 * agent dispatched a new one (`dispatch`): that one is ended, stopped, and a
 * new one starts.
 */
export async function startReplay(
  input: {
    orgId: string
    ownerUserId: string
    /**
     * The agent's dispatch that asked for it (`run_on_my_computer` on the
     * recorded laptop): the job and session belong to that agent and that
     * conversation, so the session card and the finished session's post-back
     * land there.
     */
    dispatch?: { agentId: string; threadId: string; sourceRequiredScopes: string[] }
  },
  opts: ReplayOptions & { launch?: boolean; notBefore?: Date } = {},
): Promise<StartedReplay> {
  const node = await prepareRecordedLaptop(input.orgId, input.ownerUserId)
  const recording = opts.recording ?? (await recordingOf(input.orgId))
  const [live] = await withPrivilegedDb(input.orgId, "demo-replay:live", (tx) =>
    tx
      .select({ sessionId: nodeSessions.id, jobId: nodeJobs.id, row: nodeSessions })
      .from(nodeSessions)
      .innerJoin(nodeJobs, eq(nodeJobs.id, nodeSessions.jobId))
      .where(
        and(
          eq(nodeSessions.orgId, input.orgId),
          eq(nodeSessions.nodeId, node.id),
          eq(nodeJobs.sourceRef, REPLAY_SOURCE_REF),
          isNull(nodeSessions.endedAt),
        ),
      )
      .limit(1),
  )
  if (live && (input.dispatch || (opts.notBefore && live.row.createdAt < opts.notBefore))) {
    // A new dispatch, or an earlier run's replay: the one still playing ends,
    // and its ticker stops at its next step.
    await endReplay(input.orgId, live.row, "stopped")
  } else if (live) {
    if (opts.launch !== false) launchReplay(input.orgId, live.sessionId, opts)
    return { sessionId: live.sessionId, jobId: live.jobId, nodeId: node.id, created: false }
  }

  const agentId = input.dispatch?.agentId ?? (await replayAgentId(input.orgId, input.ownerUserId))
  const now = new Date()
  const created = await withPrivilegedDb(input.orgId, "demo-replay:start", async (tx) => {
    const [job] = await tx
      .insert(nodeJobs)
      .values({
        orgId: input.orgId,
        ownerUserId: input.ownerUserId,
        agentId,
        // From a conversation: the agent's dispatch. Without one, a
        // thread-less job (0162: only app and import jobs may be); its
        // session still says the agent dispatched it.
        threadId: input.dispatch?.threadId ?? null,
        targetNodeId: node.id,
        nodeId: node.id,
        source: input.dispatch ? "dispatch" : "app",
        sourceRef: REPLAY_SOURCE_REF,
        runsOn: "node",
        prompt: recording.prompt,
        sourceRequiredScopes: input.dispatch?.sourceRequiredScopes ?? [],
        status: "running",
        leaseHolder: node.id,
        leaseGeneration: 1,
        claimedAt: now,
        startedAt: now,
        kind: "unattended",
      })
      .returning()
    const session = await createSessionForJob(tx, {
      job,
      source: "dispatch",
      configKind: "owner",
      title: recording.title,
      prompt: recording.prompt,
      repo: recording.repo,
      model: recording.model,
      level: "strict",
      finishWith: "pr",
      sourceThreadId: input.dispatch?.threadId ?? null,
    })
    const [row] = await tx
      .update(nodeSessions)
      .set({ nodeId: node.id, startedAt: now, updatedAt: now })
      .where(and(eq(nodeSessions.id, session.row.id), eq(nodeSessions.orgId, input.orgId)))
      .returning()
    return { job, row, events: session.events }
  })
  await fanOut(created.row, created.events)
  const running = await appendReplayEvents(input.orgId, created.row.id, {
    origin: "server",
    events: [event("status", { status: "running" })],
  })
  await afterAppend(running, "queued")
  if (opts.launch !== false) launchReplay(input.orgId, created.row.id, opts)
  return { sessionId: created.row.id, jobId: created.job.id, nodeId: node.id, created: true }
}

// ── the ticker ──────────────────────────────────────────────────────────────

export interface ReplayClock {
  now(): number
  sleep(ms: number): Promise<void>
}

const realClock: ReplayClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

export interface ReplayOptions {
  clock?: ReplayClock
  pollMs?: number
  decisionWaitMs?: number
  recording?: Recording
}

/** How a ticker run ended: played to the end, parked waiting for the owner, or not run. */
export type ReplayOutcome = "ended" | "parked" | "locked" | "gone"

function event(
  type: NodeSessionEventIn["type"],
  payload: Record<string, unknown>,
): NodeSessionEventIn {
  return { at: new Date().toISOString(), type, payload }
}

function recorded(e: RecordedEvent): NodeSessionEventIn {
  return {
    at: new Date().toISOString(),
    type: e.type,
    payload: e.payload,
    ...(e.parentToolUseId ? { parentToolUseId: e.parentToolUseId } : {}),
  }
}

/** Fan out an append and fire the session hooks, as a node batch's ingest does. */
async function afterAppend(appended: Appended, from: NodeSessionStatus): Promise<void> {
  await fanOut(appended.row, appended.events)
  if (appended.becameWaiting) void fireSessionWaiting(appended.row, appended.becameWaiting)
  if (from !== appended.row.status) {
    void fireSessionStatus(appended.row, {
      from,
      to: appended.row.status,
      cause: "node",
      ...(appended.becameWaiting ? { becameWaiting: appended.becameWaiting } : {}),
    })
  }
}

interface Position {
  row: NodeSessionRow
  /** Recorded events already appended (server-written ones left out). */
  played: number
  decision: "allow" | "deny" | null
}

async function loadPosition(
  orgId: string,
  sessionId: string,
  requestId: string,
): Promise<Position | null> {
  return withPrivilegedDb(orgId, "demo-replay:position", async (tx) => {
    const [row] = await tx
      .select()
      .from(nodeSessions)
      .where(and(eq(nodeSessions.id, sessionId), eq(nodeSessions.orgId, orgId)))
    if (!row) return null
    const events = await tx
      .select({ type: nodeSessionEvents.type, payload: nodeSessionEvents.payload })
      .from(nodeSessionEvents)
      .where(eq(nodeSessionEvents.sessionId, sessionId))
      .orderBy(asc(nodeSessionEvents.seq))
    let played = 0
    let decision: Position["decision"] = null
    for (const e of events) {
      if (!SERVER_TYPES.has(e.type)) played++
      else if (e.type === "decision" && e.payload.requestId === requestId) {
        const outcome = e.payload.outcome
        decision = outcome === "allow" || outcome === "allow_session" ? "allow" : "deny"
      }
    }
    return { row, played, decision }
  })
}

interface PendingCommand {
  id: string
  type: string
  payload: Record<string, unknown>
}

async function unackedCommands(orgId: string, sessionId: string): Promise<PendingCommand[]> {
  return withPrivilegedDb(orgId, "demo-replay:commands", (tx) =>
    tx
      .select({
        id: nodeSessionCommands.id,
        type: nodeSessionCommands.type,
        payload: nodeSessionCommands.payload,
      })
      .from(nodeSessionCommands)
      .where(and(eq(nodeSessionCommands.sessionId, sessionId), isNull(nodeSessionCommands.ackedAt)))
      .orderBy(asc(nodeSessionCommands.seq)),
  )
}

/** End the replay's session and its job: done (played through) or stopped. */
async function endReplay(
  orgId: string,
  row: NodeSessionRow,
  to: "done" | "stopped",
  extra: {
    events?: NodeSessionEventIn[]
    acks?: Array<{ commandId: string; outcome: "applied" | "noop" }>
  } = {},
): Promise<void> {
  const ended = await appendReplayEvents(orgId, row.id, {
    origin: "server",
    events: [
      ...(extra.events ?? []),
      event(
        "status",
        to === "done" ? { status: "done" } : { status: "stopped", reason: "stopped_by_owner" },
      ),
    ],
    ...(extra.acks ? { acks: extra.acks } : {}),
    ended: true,
  })
  if (row.jobId) {
    await withPrivilegedDb(orgId, "demo-replay:job-end", (tx) =>
      tx
        .update(nodeJobs)
        .set({
          status: to === "done" ? "done" : "cancelled",
          leaseHolder: null,
          leaseExpiresAt: null,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(nodeJobs.id, row.jobId as string), eq(nodeJobs.orgId, orgId))),
    )
  }
  await afterAppend(ended, row.status)
}

/**
 * Commands the owner sent meanwhile, other than the decision: Stop and Mark
 * done end the replay (true); anything else is acked `noop` (a recording
 * cannot take a message).
 */
async function applyOtherCommands(
  orgId: string,
  row: NodeSessionRow,
  commands: PendingCommand[],
): Promise<boolean> {
  const ending = commands.find((c) => c.type === "stop" || c.type === "mark_done")
  const others = commands.filter((c) => c.type !== "permission_decision" && c !== ending)
  if (ending) {
    await endReplay(orgId, row, "stopped", {
      events: [
        event("command_applied", { commandId: ending.id, type: ending.type, outcome: "applied" }),
      ],
      acks: [{ commandId: ending.id, outcome: "applied" }],
    })
    return true
  }
  if (others.length > 0) {
    const appended = await appendReplayEvents(orgId, row.id, {
      origin: "node",
      events: others.map((c) =>
        event("command_applied", { commandId: c.id, type: c.type, outcome: "noop" }),
      ),
      acks: others.map((c) => ({ commandId: c.id, outcome: "noop" as const })),
    })
    await afterAppend(appended, row.status)
  }
  return false
}

/** Keep (or take) the session's ticker lock; false when another process holds it. */
async function holdLock(sessionId: string, token: string): Promise<boolean> {
  const key = lockKey(sessionId)
  const got = await redis.set(key, token, "PX", LOCK_TTL_MS, "NX")
  if (got === "OK") return true
  if ((await redis.get(key)) !== token) return false
  await redis.pexpire(key, LOCK_TTL_MS)
  return true
}

async function releaseLock(sessionId: string, token: string): Promise<void> {
  const key = lockKey(sessionId)
  if ((await redis.get(key)) === token) await redis.del(key)
}

/**
 * Play one replay session from where its event log stands to its end, or to
 * the permission request when no decision comes within the wait. Never runs
 * twice at once for a session (Redis lock). Throws only on a store refusal.
 */
export async function runReplay(
  orgId: string,
  sessionId: string,
  opts: ReplayOptions = {},
): Promise<ReplayOutcome> {
  const clock = opts.clock ?? realClock
  const recording = opts.recording ?? (await recordingOf(orgId))
  const pollMs = opts.pollMs ?? REPLAY_POLL_MS
  const waitMs = opts.decisionWaitMs ?? REPLAY_DECISION_WAIT_MS
  const factor = pacingFactor(recording)
  const permAt = permissionIndex(recording)
  const requestId = permissionRequestId(recording)
  const token = crypto.randomUUID()
  if (!(await holdLock(sessionId, token))) return "locked"
  try {
    for (;;) {
      const pos = await loadPosition(orgId, sessionId, requestId)
      if (!pos) return "gone"
      const { row } = pos
      if (row.endedAt || ["done", "stopped", "failed", "needs_you"].includes(row.status)) {
        return "ended"
      }
      if (!(await holdLock(sessionId, token))) return "locked"

      const pending = await unackedCommands(orgId, sessionId)
      if (await applyOtherCommands(orgId, row, pending)) return "ended"

      // Before the request: the next recorded event, at its pace. The request
      // itself also queues the `asked` step a guided tour waits on.
      if (pos.played <= permAt) {
        const next = recording.events[pos.played]
        await clock.sleep(Math.round(next.delayMs * factor))
        const appended = await appendReplayEvents(orgId, sessionId, {
          origin: "node",
          events: [recorded(next)],
          ...(pos.played === permAt
            ? { replayStep: { step: REPLAY_STEP_ASKED, actorId: row.ownerUserId } }
            : {}),
        })
        await afterAppend(appended, row.status)
        continue
      }

      // At the request: wait for the owner's decision.
      if (pos.decision === null) {
        const decided = await waitForDecision(orgId, row, requestId, { clock, pollMs, waitMs })
        if (decided === "parked") return "parked"
        if (decided === "ended") return "ended"
        continue
      }

      // After it: the rest of the recording (Allow) or the Deny ending.
      const branch =
        pos.decision === "allow" ? recording.events.slice(permAt + 1) : recording.denied
      const index = pos.played - (permAt + 1)
      if (index >= branch.length) {
        await endReplay(orgId, row, pos.decision === "allow" ? "done" : "stopped")
        return "ended"
      }
      const next = branch[index]
      await clock.sleep(Math.round(next.delayMs * factor))
      const appended = await appendReplayEvents(orgId, sessionId, {
        origin: "node",
        events: [recorded(next)],
      })
      await afterAppend(appended, row.status)
    }
  } finally {
    await releaseLock(sessionId, token).catch(() => undefined)
  }
}

async function waitForDecision(
  orgId: string,
  row: NodeSessionRow,
  requestId: string,
  t: { clock: ReplayClock; pollMs: number; waitMs: number },
): Promise<"decided" | "parked" | "ended"> {
  const until = t.clock.now() + t.waitMs
  while (t.clock.now() < until) {
    const pending = await unackedCommands(orgId, row.id)
    if (await applyOtherCommands(orgId, row, pending)) return "ended"
    const decision = pending.find(
      (c) => c.type === "permission_decision" && c.payload.requestId === requestId,
    )
    if (decision) {
      const allow = decision.payload.allow === true
      const appended = await appendReplayEvents(orgId, row.id, {
        origin: "node",
        events: [
          event("command_applied", {
            commandId: decision.id,
            type: "permission_decision",
            outcome: "applied",
          }),
          event("decision", { requestId, outcome: allow ? "allow" : "deny", by: "owner" }),
        ],
        acks: [{ commandId: decision.id, outcome: "applied" }],
        replayStep: {
          step: allow ? REPLAY_STEP_APPROVED : REPLAY_STEP_DENIED,
          actorId: row.ownerUserId,
        },
      })
      await afterAppend(appended, row.status)
      return "decided"
    }
    await t.clock.sleep(t.pollMs)
  }
  return "parked"
}

// ── in-process launch and resume ────────────────────────────────────────────

const running = new Map<string, Promise<ReplayOutcome>>()

/**
 * How many times a resumed replay waits out a lock before giving up. A ticker
 * that is still alive renews its lock at every event, so this only bounds the
 * waiting on a replay another process really is playing (each wait is at most
 * LOCK_TTL_MS); a replay that ends meanwhile stops the waiting at once.
 */
export const RESUME_LOCK_RETRIES = 10

/**
 * Start a session's ticker in the background (once per session in this process). Never throws.
 *
 * `retryWhileLocked` (the boot resume): a lock found taken is waited out and
 * the ticker tried again, up to that many times. A process stopped mid-replay
 * (a deploy replacing it) cannot release its lock, which then stays for up to
 * LOCK_TTL_MS after the new leader's resume has looked: without the retry that
 * replay never moves again.
 */
export function launchReplay(
  orgId: string,
  sessionId: string,
  opts: ReplayOptions & { retryWhileLocked?: number } = {},
): void {
  if (running.has(sessionId)) return
  const { retryWhileLocked = 0, ...replayOpts } = opts
  const run = (async (): Promise<ReplayOutcome> => {
    for (let attempt = 0; ; attempt++) {
      const outcome = await runReplay(orgId, sessionId, replayOpts)
      if (outcome !== "locked" || attempt >= retryWhileLocked) return outcome
      // Wall time, not the replay's pacing clock: the wait is on a Redis TTL.
      const left = await redis.pttl(lockKey(sessionId))
      await new Promise((resolve) => setTimeout(resolve, Math.max(left, 0) + 500))
    }
  })()
    .catch((err) => {
      log.error({ err, orgId, sessionId }, "demo replay failed")
      return "gone" as const
    })
    .finally(() => running.delete(sessionId))
  running.set(sessionId, run)
}

/** The ticker promise of a session launched in this process (tests wait on it). */
export function replayInFlight(sessionId: string): Promise<ReplayOutcome> | undefined {
  return running.get(sessionId)
}

/**
 * Every replay that has not ended, on any demo org: its ticker continues from
 * its event log. Returns how many were launched.
 */
export async function resumeRunningReplays(opts: ReplayOptions = {}): Promise<number> {
  const rows = await withSystemDb("demo-replay:resume", (db) =>
    db
      .select({ orgId: nodeSessions.orgId, sessionId: nodeSessions.id })
      .from(nodeSessions)
      .innerJoin(nodes, eq(nodes.id, nodeSessions.nodeId))
      .innerJoin(nodeJobs, eq(nodeJobs.id, nodeSessions.jobId))
      .where(
        and(
          eq(nodes.simulated, true),
          eq(nodeJobs.sourceRef, REPLAY_SOURCE_REF),
          inArray(nodeSessions.status, ["queued", "running", "waiting", "paused"]),
          isNull(nodeSessions.endedAt),
        ),
      )
      .limit(500),
  )
  for (const r of rows)
    launchReplay(r.orgId, r.sessionId, { ...opts, retryWhileLocked: RESUME_LOCK_RETRIES })
  return rows.length
}
