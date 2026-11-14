// SPDX-License-Identifier: FSL-1.1-ALv2
import type Redis from "ioredis"
import { INSTANCE_ID } from "~/infra/instance-id"
import { onDeadInstance, onInstanceRecovered } from "~/infra/instance-registry"
import {
  appendToReplayBuffer,
  decodeBufferedFrame,
  REPLAY_BUFFER_MAX_EVENTS,
  replayBufferKey,
  replayTrimmedKey,
} from "~/infra/websocket-replay-buffer"
import { bounded, mailInboxGrantAllows, RedisLiveState } from "~/infra/websocket-state/redis"
import type {
  LiveConn,
  MailAccessAccount,
  MailboxAnswerers,
  MailboxUnlockEntry,
} from "~/infra/websocket-state/types"
import { eventsLogger as log } from "~/lib/logger"
import { projectMessageMetadataForViewer } from "~/modules/agent/scopes/withheld-capability"
import { hasScope } from "~/modules/permissions/permissions"
import { resolveGrantInvalidations } from "~/services/security/grant-invalidation"
import { isMessageVisible } from "~/services/security/visibility"

export { mailInboxGrantAllows } from "~/infra/websocket-state/redis"

const WS_OPEN = 1
const SEQ_KEY = "ws:seq:global"

export interface EventPayload {
  app: string
  entity: string
  action: string
  entityId?: string
  data?: unknown
  orgId?: string
  actorId?: string | null
}

interface WsLike {
  send(data: string): void
  close(code?: number, reason?: string): void
  readyState: number
}

interface ConnectedClient {
  userId: string
  orgId: string
  ws: WsLike
  scopes: string[]
  dimensionGrants: Record<string, string[]>
  /** Last event ID assigned at connection time — used to bound replay requests */
  connectedAtEventId: number
}

/** One of this process's sockets in the manager's local table. */
interface LocalConn extends ConnectedClient {
  /** The socket's id in the cell-wide state (`RedisLiveState`). */
  connId: string
  connectedAt: number
  /** Threads this socket is a participant of (thread-scoped fan-out). */
  threads: Set<string>
}

/** Sockets grouped by one key (an org or a user id), each group in table order. */
type SocketIndex = Map<string, Map<WsLike, LocalConn>>

const NO_SOCKETS: ReadonlyMap<WsLike, LocalConn> = new Map()

function indexSocket(index: SocketIndex, key: string, ws: WsLike, conn: LocalConn): void {
  let group = index.get(key)
  if (!group) {
    group = new Map()
    index.set(key, group)
  }
  group.set(ws, conn)
}

function unindexSocket(index: SocketIndex, key: string, ws: WsLike): void {
  const group = index.get(key)
  if (!group) return
  group.delete(ws)
  if (group.size === 0) index.delete(key)
}

/**
 * The `agent_stream` actions for the requester's own connections only: asking a
 * client to decrypt or search their mailbox, and opening a tab on their screen
 * (its title is a record's own name, which nobody else in the room was shown),
 * and the turn the server took on before its `start` (`accepted`, `withdrawn`:
 * its scopes are not known yet, so only the requester sees it, as the replay
 * route serves it).
 */
const REQUESTER_ONLY_ACTIONS = new Set([
  "mailbox_decrypt_request",
  "mailbox_search_request",
  "open_tab",
  "accepted",
  "withdrawn",
])

// Entities that require thread participant membership filtering
const THREAD_SCOPED_ENTITIES = new Set([
  "message",
  "reaction",
  "typing",
  "agent_stream",
  "participant",
  "reference",
  // `sub_run` updates ride on the parent thread — a participant who can read
  // the thread sees the SubRunCard inline and must receive live status
  // transitions (queued → running → done|failed) over the same WS channel.
  // Without this, the card freezes at its initial state because the receiver-
  // side scope gate (websocket.ts `hasAccess`) rejects `kernel:sub_run` for
  // anyone holding only `kernel:threads:read`.
  "sub_run",
])

// Org-wide entities visible to all authenticated users (no scope check needed).
// `loadtest` is the broadcast emitted by /api/__loadtest/ws-emit — it must
// reach every connected client of the same org regardless of scopes so the
// k6 A2 latency measurement actually collects samples. Endpoint is gated on
// ENABLE_LOAD_TEST_ENDPOINT so this only matters in load-test builds.
// `org_app` is an admin turning an app On/Off or changing who may use it
// (S18–S20): it carries only the app name, status and access mode, and every
// member's shell resyncs its manifest feed on it.
const ORG_WIDE_ENTITIES = new Set(["presence", "credit", "loadtest", "org_app"])
/**
 * `kernel` entities only their `data.ownerUserId` receives (C4, D40, S18): a
 * node session row, its events, (P3, G12) the full-output-ready ping, a node
 * change, and a guided tour's progress frame (modules/tours).
 */
const OWNER_ONLY_NODE_ENTITIES = new Set([
  "node_session",
  "node_session_event",
  "node_session_full_output",
  "node",
  "tour",
])

// Kernel events a grant or revoke queues in the SAME transaction as the grant
// write (permissions/roles.ts). Their fan-out is therefore the first moment at
// which that transaction is known to have committed — see the A2 block in
// `bufferAndBroadcast`. Mirrors the set the permission-refresh subscriber uses
// in `infra/events/event-subscribers.ts`.
const PERMISSION_ENTITIES = new Set([
  "role_assignment",
  "user_scope",
  "user_dimension",
  "role_scope",
  "role_dimension",
])

/**
 * A FILE EVENT NAMES THE SHELF, NEVER THE FILE.
 *
 * `kernel:file` (an upload, an agent copying a file onto a record, a delete)
 * is gated only by `kernel:files:read`, which every member holds, while the
 * file itself is readable only through its PARENT: a ticket under its team
 * and sensitivity dimensions, a thread under membership, a knowledge
 * document under its sharing list, an app's own record under that app's RLS.
 * Those rules differ per parent type and some (sharing lists, membership
 * rows) live only in the database, which this fan-out never reads per
 * connection. So instead of a per-recipient check that would cover some
 * parents and miss others, every `kernel:file` frame is cut down here, before
 * it is buffered or sent, to the ids that say WHICH record's shelf changed.
 * The filename, type, size and storage key never leave the server on the
 * socket; a client that shows that record refetches its files through the
 * files API, where RLS decides what this viewer may see. The full payload
 * still reaches server-side subscribers (audit timeline, app handlers): the
 * cut applies only to what crosses the WebSocket.
 */
const FILE_EVENT_SOCKET_FIELDS = ["id", "app", "entityType", "entityId"] as const

/**
 * A COMPANY EVENT NAMES THE COMPANY, NEVER ITS ROW.
 *
 * `kernel:company` frames carry the company id and, for the delivery check
 * only, its audience (`{orgWide, userIds}`: everyone, or the creator and the
 * people it is shared with, set by `modules/contacts/companies.ts`). The
 * name, domain, sharing lists and counts never cross the socket; a client
 * refetches the company through the API, where RLS decides. The audience is
 * kept in the buffered frame for the replay check and removed per client on
 * the way out (`stripCompanyAudience`).
 */
function projectCompanyEventForSocket(payload: EventPayload): EventPayload {
  const data = payload.data
  const source = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {}
  const kept: Record<string, unknown> = {}
  if (typeof source.id === "string") kept.id = source.id
  if (typeof source.audience === "object" && source.audience !== null) {
    kept.audience = source.audience
  }
  return { ...payload, data: kept }
}

function stripCompanyAudience(payload: EventPayload): EventPayload {
  if (payload.app !== "kernel" || payload.entity !== "company") return payload
  const data = payload.data as Record<string, unknown> | undefined
  if (!data || !("audience" in data)) return payload
  const { audience: _audience, ...rest } = data
  return { ...payload, data: rest }
}

export function projectFileEventForSocket(payload: EventPayload): EventPayload {
  if (payload.app === "kernel" && payload.entity === "company") {
    return projectCompanyEventForSocket(payload)
  }
  if (payload.app !== "kernel" || payload.entity !== "file") return payload
  const data = payload.data
  const source = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {}
  const kept: Record<string, unknown> = {}
  for (const field of FILE_EVENT_SOCKET_FIELDS) {
    const value = source[field]
    if (typeof value === "string") kept[field] = value
  }
  return { ...payload, data: kept }
}

/**
 * What a realtime connection says it is in its hello (S6). Only these three
 * are targets of the desktop `notify` selection; a hello without one (an old
 * client) is never chosen.
 */
export type NotifyClientKind = "desktop_app" | "browser" | "mobile_app"

export function isNotifyClientKind(value: unknown): value is NotifyClientKind {
  return value === "desktop_app" || value === "browser" || value === "mobile_app"
}

/** One live connection as the shared presence registry holds it. */
export interface NotifyPresenceEntry {
  connId: string
  instanceId: string
  kind: NotifyClientKind
  lastActiveAt: number
  /**
   * The device the connection runs on (F1): the desktop app's install id, or
   * the browser's per-profile id shared by its tabs and service worker. Absent
   * for a client from before the field.
   */
  deviceId?: string
  /**
   * The OS notification permission a desktop app reported (A6), in its hello
   * and on change. Only `granted` makes the app a target; absent (a client
   * from before the field) and `not_determined` count as not granted.
   */
  notificationPermission?: NotifyPermission
  /**
   * The node this desktop connection speaks for (P4, A25): set only after the
   * connection's hello presented that node's credential, bound to the same
   * deviceId. Online and job offers read this, never the bare deviceId.
   */
  nodeId?: string
  /**
   * What this connection shows right now (push suppression): the thread or
   * session ids on screen (the active tab and an open dock window), and
   * whether the window is visible AND focused. Reported in the hello, on every
   * change, and with the heartbeat; absent for a client from before the field,
   * which then never suppresses a push.
   */
  viewing?: NotifyViewing
}

/** One connection's on-screen report. */
export interface NotifyViewing {
  threadIds: string[]
  focused: boolean
}

/** The most ids one report may carry (a main tab and a dock window, with room). */
const VIEWING_MAX_IDS = 4

/** A viewing report as a client sends it, validated; anything malformed is none. */
export function readViewing(value: unknown): NotifyViewing | undefined {
  if (!value || typeof value !== "object") return undefined
  const v = value as { threadIds?: unknown; focused?: unknown }
  if (!Array.isArray(v.threadIds) || typeof v.focused !== "boolean") return undefined
  const threadIds = v.threadIds
    .filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 128)
    .slice(0, VIEWING_MAX_IDS)
  return { threadIds, focused: v.focused }
}

export type NotifyPermission = "granted" | "denied" | "not_determined"

export function readNotifyPermission(value: unknown): NotifyPermission | undefined {
  return value === "granted" || value === "denied" || value === "not_determined" ? value : undefined
}

/** What a hello (or a heartbeat) may add to the client kind (F1, A6). */
export interface NotifyClientExtra {
  deviceId?: unknown
  notificationPermission?: unknown
  viewing?: unknown
}

/** A device id as a client sends it: a short opaque string, else none. */
export function readDeviceId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const v = value.trim()
  return v.length > 0 && v.length <= 128 ? v : undefined
}

/** The `notify` realtime frame (S5). Connection-addressed, never buffered or replayed. */
export interface NotifyFrame {
  type: "notify"
  notifyId: string
  /** The notification's identity (S1): receipts and the delivery log are keyed on it. */
  notificationId: string
  group: string
  title: string
  body: string
  route: string
  urgent: boolean
  /**
   * The conversation the notification is about (the OS notification tag): a
   * newer notification with the same tag replaces the older one, so a
   * conversation shows one notification, its latest.
   */
  tag?: string
}

/** Heartbeat TTL of a presence entry: the client refreshes it every 30 s. */
export const NOTIFY_PRESENCE_TTL_SECONDS = 60
const notifyConnKey = (connId: string) => `ws:notify-conn:${connId}`
const notifyUserKey = (orgId: string, userId: string) => `ws:notify-presence:${orgId}:${userId}`
/** Pub/sub channel of one API instance: frames for connections it holds. */
export const notifyChannel = (instanceId: string) => `ws:notify:${instanceId}`

/**
 * The `node_job_offer` frame (P4, spec-node.md protocol): a job the node may
 * claim. Connection-addressed like `notify`, never buffered or replayed: a
 * node that misses one finds the job again on reconnect or in its backlog.
 */
export interface NodeJobOfferFrame {
  type: "node_job_offer"
  jobId: string
  /** The job's agent, so the node can tell whose job it is without a queue scan (L24). */
  agentId: string
}

/**
 * The `node_session_command` frame (P3, C5): the owner sent a command to a
 * session this node runs; the node pulls its unacked commands. Carries no
 * command, so a dropped or duplicated wake changes nothing.
 */
export interface NodeSessionCommandFrame {
  type: "node_session_command"
  sessionId: string
}

/**
 * The `node_session_full_output` frame (P3, S7, R26): the owner asked for the
 * full output of a cut tool result; the node uploads its spill file.
 */
export interface NodeSessionFullOutputFrame {
  type: "node_session_full_output"
  sessionId: string
  toolUseId: string
}

/**
 * The `node_folder_request` frame: the owner (any client, or an approved
 * agent tool) asked this node about its folders; the node pulls the request
 * and answers it (modules/nodes/folder-requests.ts). Carries no request.
 */
export interface NodeFolderRequestFrame {
  type: "node_folder_request"
  requestId: string
}

/**
 * The `node_import_request` frame (S40): the owner asked this node for its
 * importable Claude Code sessions, or to check one before an import; the node
 * pulls the request and answers it (modules/nodes/import-requests.ts).
 */
export interface NodeImportRequestFrame {
  type: "node_import_request"
  requestId: string
}

/** Every connection-addressed frame the presence registry carries. */
export type ConnectionFrame =
  | NotifyFrame
  | NodeJobOfferFrame
  | NodeSessionCommandFrame
  | NodeSessionFullOutputFrame
  | NodeFolderRequestFrame
  | NodeImportRequestFrame

/**
 * Live presence entries of one user in one org, read straight from Redis, so
 * a process that holds no sockets (a job worker) can ask too. Prunes expired
 * ids from the user's set.
 */
export async function readNotifyPresence(
  redis: Redis,
  orgId: string,
  userId: string,
): Promise<NotifyPresenceEntry[]> {
  const userKey = notifyUserKey(orgId, userId)
  const ids = await redis.smembers(userKey)
  if (ids.length === 0) return []
  const raws = await redis.mget(...ids.map(notifyConnKey))
  const out: NotifyPresenceEntry[] = []
  const stale: string[] = []
  raws.forEach((raw, i) => {
    if (!raw) {
      stale.push(ids[i] as string)
      return
    }
    try {
      const e = JSON.parse(raw) as NotifyPresenceEntry
      if (isNotifyClientKind(e.kind)) out.push(e)
    } catch {
      stale.push(ids[i] as string)
    }
  })
  if (stale.length > 0) await redis.srem(userKey, ...stale)
  return out
}

/** Whether one connection's presence entry is still live (its TTL not run out). */
export async function isNotifyConnLive(redis: Redis, connId: string): Promise<boolean> {
  return (await redis.exists(notifyConnKey(connId))) === 1
}

/**
 * Address one frame to presence entries from a process that may hold none of
 * the sockets: each entry's own instance channel delivers it. Returns how many
 * entries were published to.
 */
export async function publishConnectionFrame(
  redis: Redis,
  targets: NotifyPresenceEntry[],
  frame: ConnectionFrame,
): Promise<number> {
  const msg = JSON.stringify(frame)
  const byInstance = new Map<string, string[]>()
  for (const t of targets) {
    const list = byInstance.get(t.instanceId) ?? []
    list.push(t.connId)
    byInstance.set(t.instanceId, list)
  }
  let sent = 0
  for (const [instanceId, connIds] of byInstance) {
    try {
      await redis.publish(notifyChannel(instanceId), JSON.stringify({ connIds, msg }))
      sent += connIds.length
    } catch (err) {
      log.warn({ err, instanceId }, "connection frame publish failed")
    }
  }
  return sent
}

/**
 * S6 + A6 selection, pure: every desktop app whose reported OS permission is
 * `granted`; if none, the one browser connection the user touched last; a
 * mobile app never (push covers the phone). Web Push, the third rule, is not a
 * connection and is the emitter's business.
 */
export function selectNotifyTargets(entries: NotifyPresenceEntry[]): NotifyPresenceEntry[] {
  const apps = entries.filter(
    (e) => e.kind === "desktop_app" && e.notificationPermission === "granted",
  )
  if (apps.length > 0) return apps
  let best: NotifyPresenceEntry | undefined
  for (const e of entries) {
    if (e.kind !== "browser") continue
    if (!best || e.lastActiveAt > best.lastActiveAt) best = e
  }
  return best ? [best] : []
}

interface LocalNotifyConn {
  connId: string
  userId: string
  orgId: string
  kind: NotifyClientKind
  lastActiveAt: number
  deviceId?: string
  notificationPermission?: NotifyPermission
  nodeId?: string
  viewing?: NotifyViewing
}

export class WebSocketManager {
  private redis: Redis
  private readonly redisTimeoutMs: number
  private PRESENCE_TTL = 60
  private static readonly AUTH_REVALIDATION_INTERVAL_MS = 60_000
  private static readonly TYPING_THROTTLE_MS = 4_000

  // Per-connection message rate limiting (process-local; per spec, not in state)
  private static readonly MSG_RATE_LIMIT = 120
  private static readonly MSG_RATE_WINDOW_MS = 60_000
  private static readonly HELLO_COOLDOWN_MS = 5_000
  private rateBuckets = new Map<WsLike, { count: number; resetAt: number }>()
  private helloCooldowns = new Map<WsLike, number>()
  // Per-process throttles: typing-throttle entries map to setTimeout handles,
  // and auth revalidation is decided per process for its own sockets.
  private localTypingTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private localAuthCheckTimes = new Map<string, number>()

  /**
   * This process's own sockets: refs, meta, thread membership. Fan-out needs
   * the refs synchronously, so this table is the only source for local
   * delivery; it is not a backend.
   */
  private sockets = new Map<WsLike, LocalConn>()
  /**
   * The same sockets by org and by user, kept next to `sockets`, so a fan-out
   * or a membership check walks one org's or one user's sockets, not all of
   * this process's.
   */
  private socketsByOrg: SocketIndex = new Map()
  private socketsByUser: SocketIndex = new Map()

  private orgSockets(orgId: string): ReadonlyMap<WsLike, LocalConn> {
    return this.socketsByOrg.get(orgId) ?? NO_SOCKETS
  }

  private userSockets(userId: string): ReadonlyMap<WsLike, LocalConn> {
    return this.socketsByUser.get(userId) ?? NO_SOCKETS
  }

  /**
   * The cell's answers (S5): is a user online anywhere, which users of an org
   * are, does any live socket hold mail access. Written best-effort from the
   * local table on every change; reads are bounded.
   */
  readonly live: RedisLiveState

  /** The Redis client this manager writes with (the desktop emitter's claim uses it too). */
  get redisClient(): Redis {
    return this.redis
  }

  /** This process's identity in the presence registry and its pub/sub channel. */
  readonly instanceId: string
  private notifyConns = new Map<WsLike, LocalNotifyConn>()
  private notifyConnsById = new Map<string, WsLike>()
  private notifySub: Redis | null = null

  /**
   * `live` defaults to a `RedisLiveState` on `redis` under this instance id
   * (`INSTANCE_ID` unless given) and the client's own key prefix
   * (`REDIS_PREFIX` for the shared client): its scripts build instance keys in
   * Lua and must prepend it.
   */
  constructor(
    redis: Redis,
    live?: RedisLiveState,
    opts: { instanceId?: string; redisTimeoutMs?: number } = {},
  ) {
    this.redis = redis
    this.instanceId = opts.instanceId ?? INSTANCE_ID
    this.redisTimeoutMs = opts.redisTimeoutMs ?? 1_000
    this.live = live ?? new RedisLiveState(redis, this.instanceId, redis.options?.keyPrefix ?? "")
  }

  private liveConn(c: LocalConn): LiveConn {
    return {
      connId: c.connId,
      instanceId: this.instanceId,
      userId: c.userId,
      orgId: c.orgId,
      scopes: c.scopes,
      dimensionGrants: c.dimensionGrants,
      connectedAt: c.connectedAt,
    }
  }

  /** Whether this process holds another socket of the user in the org. */
  private hasLocalSocket(orgId: string, userId: string, except?: WsLike): boolean {
    for (const [ws, c] of this.userSockets(userId)) {
      if (ws !== except && c.orgId === orgId) return true
    }
    return false
  }

  // ── Desktop notify: presence registry + connection-addressed send (S5, S6) ──

  /**
   * Record the client kind a connection announced in its hello, in the shared
   * registry (TTL 60 s, refreshed by the heartbeat). A missing or unknown kind
   * leaves the connection out: it is never a `notify` target.
   */
  async registerNotifyClient(
    ws: WsLike,
    kind: unknown,
    lastActiveAt?: unknown,
    extra: NotifyClientExtra = {},
  ): Promise<NotifyPresenceEntry | null> {
    if (!isNotifyClientKind(kind)) return null
    const meta = this.sockets.get(ws)
    if (!meta) return null
    const existing = this.notifyConns.get(ws)
    const deviceId = readDeviceId(extra.deviceId)
    const permission = readNotifyPermission(extra.notificationPermission)
    const viewing = readViewing(extra.viewing)
    const conn: LocalNotifyConn = {
      connId: existing?.connId ?? `${this.instanceId}:${crypto.randomUUID()}`,
      userId: meta.userId,
      orgId: meta.orgId,
      kind,
      lastActiveAt: clampActivity(lastActiveAt),
      ...(deviceId ? { deviceId } : {}),
      ...(permission ? { notificationPermission: permission } : {}),
      ...(viewing ? { viewing } : {}),
      // A repeated hello keeps the node binding its first one proved.
      ...(existing?.nodeId && existing.deviceId === deviceId ? { nodeId: existing.nodeId } : {}),
    }
    this.notifyConns.set(ws, conn)
    this.notifyConnsById.set(conn.connId, ws)
    return this.writeNotifyPresence(conn)
  }

  /**
   * Bind a registered desktop connection to the node whose credential its
   * hello presented (P4). Returns the refreshed entry, or null when the
   * connection is not a registered desktop app.
   */
  async markNodeConnection(ws: WsLike, nodeId: string): Promise<NotifyPresenceEntry | null> {
    const conn = this.notifyConns.get(ws)
    if (conn?.kind !== "desktop_app") return null
    conn.nodeId = nodeId
    return this.writeNotifyPresence(conn)
  }

  /**
   * The client heartbeat (`{type:"presence", lastActiveAt, viewing}`), also
   * sent at once when what the window shows or its focus changes: refresh TTL,
   * activity and the on-screen report.
   */
  async touchNotifyPresence(
    ws: WsLike,
    lastActiveAt?: unknown,
    extra: Pick<NotifyClientExtra, "notificationPermission" | "viewing"> = {},
  ): Promise<void> {
    const conn = this.notifyConns.get(ws)
    if (!conn) return
    conn.lastActiveAt = clampActivity(lastActiveAt, conn.lastActiveAt)
    // A6: the permission is re-reported on change; a heartbeat without it
    // keeps the last one.
    const permission = readNotifyPermission(extra.notificationPermission)
    if (permission) conn.notificationPermission = permission
    // A report replaces the last one and a heartbeat without the field keeps
    // it, but a MALFORMED report clears it: an on-screen claim the server
    // cannot read must not keep holding pushes back (fail open).
    if (extra.viewing !== undefined) {
      const viewing = readViewing(extra.viewing)
      if (viewing) conn.viewing = viewing
      else delete conn.viewing
    }
    await this.writeNotifyPresence(conn)
  }

  private async writeNotifyPresence(conn: LocalNotifyConn): Promise<NotifyPresenceEntry> {
    const entry: NotifyPresenceEntry = {
      connId: conn.connId,
      instanceId: this.instanceId,
      kind: conn.kind,
      lastActiveAt: conn.lastActiveAt,
      ...(conn.deviceId ? { deviceId: conn.deviceId } : {}),
      ...(conn.notificationPermission
        ? { notificationPermission: conn.notificationPermission }
        : {}),
      ...(conn.nodeId ? { nodeId: conn.nodeId } : {}),
      ...(conn.viewing ? { viewing: conn.viewing } : {}),
    }
    const userKey = notifyUserKey(conn.orgId, conn.userId)
    await this.redis
      .multi()
      .set(notifyConnKey(conn.connId), JSON.stringify(entry), "EX", NOTIFY_PRESENCE_TTL_SECONDS)
      .sadd(userKey, conn.connId)
      .expire(userKey, NOTIFY_PRESENCE_TTL_SECONDS * 2)
      .exec()
    return entry
  }

  private unregisterNotifyClient(ws: WsLike): void {
    const conn = this.notifyConns.get(ws)
    if (!conn) return
    this.notifyConns.delete(ws)
    this.notifyConnsById.delete(conn.connId)
    void this.redis
      .multi()
      .del(notifyConnKey(conn.connId))
      .srem(notifyUserKey(conn.orgId, conn.userId), conn.connId)
      .exec()
      .catch((err: unknown) => log.warn({ err }, "notify presence cleanup failed"))
  }

  /** Live entries of one user in one org, across every instance. Prunes expired ones. */
  async listNotifyPresence(orgId: string, userId: string): Promise<NotifyPresenceEntry[]> {
    return readNotifyPresence(this.redis, orgId, userId)
  }

  /**
   * Send one `notify` frame to the chosen connections: this instance's own
   * sockets directly, the others' through their pub/sub channel. No replay id,
   * no buffer write: a reconnect replays none. Returns how many were addressed.
   */
  async sendNotify(targets: NotifyPresenceEntry[], frame: NotifyFrame): Promise<number> {
    return (await this.sendNotifyEach(targets, frame)).filter(Boolean).length
  }

  /**
   * `sendNotify`, answering per target (same order): true when the frame was
   * written to this instance's socket or published to the owning instance.
   */
  async sendNotifyEach(targets: NotifyPresenceEntry[], frame: ConnectionFrame): Promise<boolean[]> {
    const msg = JSON.stringify(frame)
    const out = targets.map(() => false)
    const remote = new Map<string, number[]>()
    targets.forEach((t, i) => {
      if (t.instanceId === this.instanceId) {
        out[i] = this.deliverNotifyLocal(t.connId, msg)
      } else {
        const list = remote.get(t.instanceId) ?? []
        list.push(i)
        remote.set(t.instanceId, list)
      }
    })
    for (const [instanceId, indexes] of remote) {
      const connIds = indexes.map((i) => (targets[i] as NotifyPresenceEntry).connId)
      try {
        await this.redis.publish(notifyChannel(instanceId), JSON.stringify({ connIds, msg }))
        for (const i of indexes) out[i] = true
      } catch (err) {
        log.warn({ err, instanceId }, "notify publish failed")
      }
    }
    return out
  }

  private deliverNotifyLocal(connId: string, msg: string): boolean {
    const ws = this.notifyConnsById.get(connId)
    if (!ws || ws.readyState !== WS_OPEN) return false
    try {
      ws.send(msg)
      return true
    } catch (err) {
      log.warn({ err, connId }, "Failed to send notify")
      return false
    }
  }

  /** Listen on this instance's notify channel with a dedicated subscriber connection. */
  async startNotifyDelivery(sub: Redis): Promise<void> {
    if (this.notifySub) return
    this.notifySub = sub
    sub.on("message", (channel: string, raw: string) => {
      if (channel !== notifyChannel(this.instanceId)) return
      try {
        const { connIds, msg } = JSON.parse(raw) as { connIds: string[]; msg: string }
        for (const id of connIds) this.deliverNotifyLocal(id, msg)
      } catch (err) {
        log.warn({ err }, "Invalid notify delivery message")
      }
    })
    await sub.subscribe(notifyChannel(this.instanceId))
  }

  async stopNotifyDelivery(): Promise<void> {
    const sub = this.notifySub
    this.notifySub = null
    if (!sub) return
    try {
      await sub.unsubscribe(notifyChannel(this.instanceId))
    } catch {
      // The connection is going away anyway.
    }
  }

  /** Returns false if the connection exceeded its message rate limit. Caller should close the socket. */
  checkMessageRate(ws: WsLike): boolean {
    const now = Date.now()
    const bucket = this.rateBuckets.get(ws) ?? {
      count: 0,
      resetAt: now + WebSocketManager.MSG_RATE_WINDOW_MS,
    }
    if (now > bucket.resetAt) {
      bucket.count = 0
      bucket.resetAt = now + WebSocketManager.MSG_RATE_WINDOW_MS
    }
    bucket.count++
    this.rateBuckets.set(ws, bucket)
    return bucket.count <= WebSocketManager.MSG_RATE_LIMIT
  }

  /** Returns false if a hello was sent too recently on this connection. */
  checkHelloCooldown(ws: WsLike): boolean {
    const now = Date.now()
    const last = this.helloCooldowns.get(ws) ?? 0
    if (now - last < WebSocketManager.HELLO_COOLDOWN_MS) return false
    this.helloCooldowns.set(ws, now)
    return true
  }

  /** Returns true if the typing event should be broadcast (not throttled). */
  checkTypingThrottle(userId: string, threadId: string): boolean {
    const key = `${userId}:${threadId}`
    if (this.localTypingTimers.has(key)) return false
    const handle = setTimeout(() => {
      this.localTypingTimers.delete(key)
    }, WebSocketManager.TYPING_THROTTLE_MS)
    this.localTypingTimers.set(key, handle)
    return true
  }

  /**
   * Record a socket. The local table changes synchronously; the cell copy is
   * written after, and `wasOnline` (the user already had a live socket in the
   * org, here or on another instance) is decided atomically with that write.
   * Never rejects: without an answer from Redis it falls back to this
   * process's own sockets.
   */
  /**
   * Close every socket this process holds (a shutdown, lib/shutdown.ts):
   * 1012 "restart" tells clients to reconnect at once, to another process.
   * Each close runs the usual close handler. Returns how many were closed.
   */
  closeAllLocal(code: number, reason: string): number {
    const all = new Set<WsLike>([...this.sockets.keys(), ...this.notifyConns.keys()])
    for (const ws of all) {
      try {
        ws.close(code, reason)
      } catch (err) {
        log.warn({ err }, "WS close at shutdown failed")
      }
    }
    if (all.size > 0) log.info({ count: all.size, code }, "Closed local WebSockets for shutdown")
    return all.size
  }

  addConnection(
    userId: string,
    ws: WsLike,
    scopes: string[],
    orgId: string,
    dimensionGrants: Record<string, string[]> = {},
    connectedAtEventId = 0,
  ): Promise<{ wasOnline: boolean }> {
    const localWasOnline = this.hasLocalSocket(orgId, userId, ws)
    const conn: LocalConn = {
      userId,
      orgId,
      ws,
      scopes,
      dimensionGrants,
      connectedAtEventId,
      connId: crypto.randomUUID(),
      connectedAt: Date.now(),
      threads: new Set(),
    }
    const prev = this.sockets.get(ws)
    if (prev) {
      unindexSocket(this.socketsByOrg, prev.orgId, ws)
      unindexSocket(this.socketsByUser, prev.userId, ws)
    }
    this.sockets.set(ws, conn)
    indexSocket(this.socketsByOrg, orgId, ws, conn)
    indexSocket(this.socketsByUser, userId, ws, conn)
    log.debug({ userId, orgId, total: this.sockets.size }, "WS client connected")
    return this.live.addConnection(this.liveConn(conn)).then(
      ({ wasOnline }) => ({ wasOnline: wasOnline || localWasOnline }),
      (err: unknown) => {
        log.warn({ err }, "ws live state write failed: addConnection")
        return { wasOnline: localWasOnline }
      },
    )
  }

  /**
   * Replace a socket's scopes and grants (a revalidation that keeps the socket
   * open), locally and in the cell copy that mail access reads.
   */
  updateConnectionGrants(
    ws: WsLike,
    scopes: string[],
    dimensionGrants: Record<string, string[]>,
  ): void {
    const conn = this.sockets.get(ws)
    if (!conn) return
    conn.scopes = scopes
    conn.dimensionGrants = dimensionGrants
    this.live
      .updateConnection(this.liveConn(conn))
      .catch((err: unknown) => log.warn({ err }, "ws live state write failed: updateConnection"))
  }

  /**
   * Forget a socket. `userStillOnline` says whether the user keeps a live
   * socket in the org anywhere in the cell, decided atomically with the
   * removal; without an answer from Redis it falls back to this process's own
   * sockets. Never rejects.
   */
  removeConnection(ws: WsLike): Promise<{ userStillOnline: boolean }> {
    const meta = this.sockets.get(ws)
    this.sockets.delete(ws)
    this.rateBuckets.delete(ws)
    this.helloCooldowns.delete(ws)
    this.unregisterNotifyClient(ws)
    if (!meta) return Promise.resolve({ userStillOnline: false })
    unindexSocket(this.socketsByOrg, meta.orgId, ws)
    unindexSocket(this.socketsByUser, meta.userId, ws)
    // Clean up the auth-revalidation throttle if this was the user's last local connection.
    if (this.userSockets(meta.userId).size === 0) this.localAuthCheckTimes.delete(meta.userId)
    log.debug({ userId: meta.userId, total: this.sockets.size }, "WS client disconnected")
    const localStillOnline = this.hasLocalSocket(meta.orgId, meta.userId)
    // A closed connection vouches for nothing, whatever it last asserted.
    this.live
      .setMailboxUnlock(meta.userId, this.unlockMember(meta.connId), null)
      .catch((err: unknown) =>
        log.warn({ err }, "ws live state write failed: mailbox unlock withdrawal"),
      )
    return this.live.removeConnection(this.liveConn(meta)).then(
      ({ userStillOnline }) => ({ userStillOnline: userStillOnline || localStillOnline }),
      (err: unknown) => {
        log.warn({ err }, "ws live state write failed: removeConnection")
        return { userStillOnline: localStillOnline }
      },
    )
  }

  getConnectionCount(): number {
    return this.sockets.size
  }

  /**
   * Close every socket this process holds for one org (its deletion started):
   * 4010 sends the client to refresh its session, which then answers 410.
   * Returns how many were closed.
   */
  closeConnectionsForOrg(orgId: string, code = 4010, reason = "session_invalidated"): number {
    const open = [...this.orgSockets(orgId).keys()]
    for (const ws of open) {
      try {
        ws.close(code, reason)
      } catch (err) {
        log.warn({ err, orgId }, "Failed to close WS of a deleted org")
      }
    }
    if (open.length > 0)
      log.info({ orgId, count: open.length }, "Closed WebSockets of a deleted org")
    return open.length
  }

  /** Close all WebSocket connections for a specific user, triggering client-side token refresh + reconnect */
  closeConnectionsForUser(userId: string, code = 4010, reason = "permissions_changed"): void {
    for (const [ws] of this.userSockets(userId)) {
      if (ws.readyState === WS_OPEN) {
        try {
          ws.close(code, reason)
        } catch (err) {
          log.warn({ err, userId }, "Failed to close WS for permission refresh")
        }
      }
    }
  }

  /**
   * A2 reactive visibility: tell ONE user, in ONE org, that their effective
   * scope changed so their open thread views re-fetch instead of trusting a
   * cached message list.
   *
   * The frame carries only thread ids that user already participates in (or
   * none at all) and never any message content. Delivery is org-scoped first
   * (`listOrgConnections`, the same lookup the event fan-out uses) and then
   * narrowed to that user's own sockets, so it reaches every open connection
   * that user has IN THAT ORG and no other connection at all.
   *
   * The org half is load bearing, not decoration: one person can belong to
   * several orgs and keep a tab open in each, and each tab holds its own
   * socket with its own orgId. Matching on the user id alone delivered org A's
   * thread ids onto that person's org B socket. Nothing readable crosses (the
   * ids only trigger a refetch, which RLS then answers in the org B session's
   * own scope), but a cross-org signal is still a cross-org signal.
   *
   * A user with no open connection in that org is a no-op: they re-hydrate over
   * REST on their next connect. A wedged socket is logged and skipped, never
   * thrown, so a delivery failure cannot break the grant mutation that
   * triggered it.
   */
  emitVisibilityInvalidate(orgId: string, userId: string, threadIds: string[]): void {
    const msg = JSON.stringify({ type: "visibility:invalidate", threadIds })
    for (const [ws, client] of this.userSockets(userId)) {
      if (client.orgId !== orgId || ws.readyState !== WS_OPEN) continue
      try {
        ws.send(msg)
      } catch (err) {
        log.warn({ err, orgId, userId }, "Failed to send visibility:invalidate")
      }
    }
  }

  /**
   * Check if a user's authVersion has changed since WS connect, and close
   * all their connections if so. Throttled to once per 60s per user.
   * Returns true if revalidation was performed and connections were closed.
   */
  shouldRevalidateAuth(userId: string): boolean {
    const now = Date.now()
    const lastCheck = this.localAuthCheckTimes.get(userId)
    if (lastCheck && now - lastCheck < WebSocketManager.AUTH_REVALIDATION_INTERVAL_MS) {
      return false // Not due yet (per-process throttle; each replica revalidates its own conns)
    }
    this.localAuthCheckTimes.set(userId, now)
    return true
  }

  // Thread membership management (per-connection to support multi-tab/device)
  setThreadMembership(ws: WsLike, threadIds: Set<string>): void {
    const conn = this.sockets.get(ws)
    if (!conn) return
    conn.threads = new Set(threadIds)
  }

  addThreadMember(userId: string, threadId: string): void {
    for (const conn of this.userSockets(userId).values()) conn.threads.add(threadId)
  }

  removeThreadMember(userId: string, threadId: string): void {
    for (const conn of this.userSockets(userId).values()) conn.threads.delete(threadId)
  }

  getThreadMembershipForUser(userId: string): Set<string> | undefined {
    const merged = new Set<string>()
    let found = false
    for (const conn of this.userSockets(userId).values()) {
      if (conn.threads.size > 0) {
        found = true
        for (const t of conn.threads) merged.add(t)
      }
    }
    return found ? merged : undefined
  }

  private candidateConnections(orgId?: string): Array<[WsLike, ConnectedClient]> {
    return [...(orgId ? this.orgSockets(orgId) : this.sockets)]
  }

  // Broadcast without buffering — for ephemeral events
  async broadcast(event: EventPayload): Promise<void> {
    const payload = projectFileEventForSocket(event)
    const msg = JSON.stringify({ type: "event", payload })

    for (const [, client] of this.candidateConnections(payload.orgId)) {
      if (client.ws.readyState !== WS_OPEN) continue
      if (!this.hasAccess(client.scopes, payload.app, payload.entity)) continue
      if (!this.hasThreadAccess(client.userId, payload)) continue
      if (!this.hasScopeVisibilityAccess(client, payload)) continue
      if (!this.hasKernelConnectedAccountAccess(client, payload)) continue
      if (!this.hasMailAccountAccess(client, payload)) continue
      if (!this.hasApprovalRequestAccess(client, payload)) continue
      if (!this.hasNotificationRecipientAccess(client, payload)) continue
      if (!this.hasOwnReadStateAccess(client, payload)) continue
      if (!this.hasOwnNodeSessionAccess(client, payload)) continue
      if (!this.hasPersonalRoutineAccess(client, payload)) continue
      if (!this.hasCompanyAudienceAccess(client, payload)) continue
      if (!this.hasDashboardVisibilityAccess(client, payload)) continue
      if (!this.wantsNodeSessionEvent(client, payload)) continue
      if (!this.hasDimensionAccess(client.dimensionGrants, payload)) continue
      const out = stripCompanyAudience(
        this.projectWithheldMetadata(client, this.redactSubRunSummary(client, payload)),
      )
      try {
        client.ws.send(out === payload ? msg : JSON.stringify({ type: "event", payload: out }))
      } catch (err) {
        log.warn({ err, userId: client.userId }, "Failed to send WS event")
      }
    }
  }

  // Buffer to Redis + broadcast — for stored events
  async bufferAndBroadcast(
    event: EventPayload,
    presetEventId?: number,
    // Tri-state on purpose:
    //  - `undefined` (argument omitted) → legacy/direct in-process caller. There is
    //    exactly one writer, so assign a local replay id here and buffer it.
    //  - `true`/`false` (explicit) → event-bus fan-out delivery (one call per
    //    replica for the same logical event). The replay id MUST come from
    //    `presetEventId`, assigned once at publish time by the single writer; the
    //    boolean only decides whether THIS replica writes the buffer (the
    //    originator buffers, remotes are broadcast-only).
    shouldBuffer?: boolean,
  ): Promise<void> {
    // Cut before the replay buffer write too, so a replayed frame is the same
    // id-only frame (see `projectFileEventForSocket`).
    const payload = projectFileEventForSocket(event)
    const fromFanout = shouldBuffer !== undefined
    const seqKey = payload.orgId ? `ws:seq:${payload.orgId}` : SEQ_KEY
    // The replay id is normally assigned once at publish time (single-writer) and
    // passed in here, so every replica broadcasts the same id and only the
    // originator writes the buffer (`shouldBuffer`).
    //
    // Cross-replica invariant: in the fan-out path, a missing preset id means the
    // publish-time INCR failed. We must NOT fall back to a per-replica INCR — every
    // replica would independently INCR and assign a DIVERGENT id to the same
    // logical event (and re-write the buffer with inconsistent sequence numbers).
    // Instead, treat this delivery as non-replayable: broadcast without an eventId
    // (the client will not advance its replay cursor) and skip buffering entirely.
    // This keeps every replica's view of the event consistent (all id-less).
    //
    // Legacy/direct callers (not fan-out) omit `shouldBuffer` and keep the previous
    // single-process behaviour: assign a local id and buffer here. There is exactly
    // one writer in that path, so no divergence is possible.
    let eventId: number | undefined
    if (presetEventId !== undefined) {
      eventId = presetEventId
    } else if (!fromFanout) {
      eventId = await this.redis.incr(seqKey)
    }
    // The replay `eventId` is also the at-least-once dedup key (B23a): the outbox
    // is at-least-once, so a crash between publish and `processed_at` re-delivers
    // this same logical event. Including the stable `eventId` in the broadcast
    // frame lets clients drop a frame they already applied — the client advances
    // its replay cursor by `msg.eventId` and re-requests only `lastEventId+1` on
    // reconnect, so any `eventId <= lastEventId` is recognised as a duplicate.
    //
    // Omit `eventId` when there is no replay id so the client treats the event as
    // non-replayable (see createWebSocket: it only advances the cursor when
    // `msg.eventId` is present).
    const msg = JSON.stringify(
      eventId !== undefined ? { type: "event", eventId, payload } : { type: "event", payload },
    )

    // Only buffer when this delivery owns a replay id. Direct callers always do;
    // fan-out callers buffer only when they are the originator AND have a preset id.
    // Without an id the event is non-replayable, so there is nothing meaningful to
    // write into the score-ordered buffer.
    const shouldWriteBuffer = fromFanout ? shouldBuffer === true : true
    if (shouldWriteBuffer && eventId !== undefined) {
      // Bounded by size and age (websocket-replay-buffer.ts): a busy org's
      // buffer no longer grows without limit behind an ever-refreshed TTL.
      await appendToReplayBuffer(this.redis, payload.orgId, eventId, msg)
    }

    // A2 reactive visibility, delivery side. The grant write and this delivery
    // are separated by the transactional outbox, this repo's after-commit hook:
    // a `pending_events` row becomes visible to the outbox worker only once the
    // producing transaction committed, and the durable `ws-fanout` consumer then
    // calls this method with the permission event that same transaction queued.
    // Draining here is therefore strictly after that commit — delivering before
    // it would let a client re-fetch, still read the old visibility and cache it.
    //
    // Everything the delivery needs is on the event (`data.targetUserId` for a
    // per-user grant, `data.roleId` for a role-level one) and in the database,
    // so no state is carried from the grant call and ANY process can serve the
    // event: one published by another process arrives here over Redis and still
    // invalidates the users THIS process has connected. Resolution is narrowed
    // to those users, and each payload carries only that user's own thread ids,
    // delivered on that user's own sockets in the event's own org.
    if (payload.orgId && payload.app === "kernel" && PERMISSION_ENTITIES.has(payload.entity)) {
      const connectedUserIds = new Set(
        this.candidateConnections(payload.orgId).map(([, c]) => c.userId),
      )
      // One invalidation per affected user, not one per connection:
      // `emitVisibilityInvalidate` fans that single one out to all of that
      // user's own sockets in the event's own org, which is the only org whose
      // grants this event changed.
      for (const invalidation of await resolveGrantInvalidations(payload, connectedUserIds)) {
        this.emitVisibilityInvalidate(payload.orgId, invalidation.userId, invalidation.threadIds)
      }
    }

    for (const [, client] of this.candidateConnections(payload.orgId)) {
      if (client.ws.readyState !== WS_OPEN) continue
      if (!this.hasAccess(client.scopes, payload.app, payload.entity)) continue
      if (!this.hasThreadAccess(client.userId, payload)) continue
      if (!this.hasScopeVisibilityAccess(client, payload)) continue
      if (!this.hasKernelConnectedAccountAccess(client, payload)) continue
      if (!this.hasMailAccountAccess(client, payload)) continue
      if (!this.hasApprovalRequestAccess(client, payload)) continue
      if (!this.hasNotificationRecipientAccess(client, payload)) continue
      if (!this.hasOwnReadStateAccess(client, payload)) continue
      if (!this.hasOwnNodeSessionAccess(client, payload)) continue
      if (!this.hasPersonalRoutineAccess(client, payload)) continue
      if (!this.hasCompanyAudienceAccess(client, payload)) continue
      if (!this.hasDashboardVisibilityAccess(client, payload)) continue
      if (!this.wantsNodeSessionEvent(client, payload)) continue
      if (!this.hasDimensionAccess(client.dimensionGrants, payload)) continue
      const out = stripCompanyAudience(
        this.projectWithheldMetadata(client, this.redactSubRunSummary(client, payload)),
      )
      const clientMsg =
        out === payload
          ? msg
          : JSON.stringify(
              eventId !== undefined
                ? { type: "event", eventId, payload: out }
                : { type: "event", payload: out },
            )
      try {
        client.ws.send(clientMsg)
      } catch (err) {
        log.warn({ err, userId: client.userId }, "Failed to send buffered WS event")
      }
    }
  }

  async handleHello(
    ws: WsLike,
    userId: string,
    lastEventId: number,
    scopes: string[],
    orgId: string,
    dimensionGrants: Record<string, string[]> = {},
  ): Promise<void> {
    if (lastEventId < 0) return

    // Replay is strictly org-scoped (B23b). Without an orgId we cannot pick the
    // correct per-org buffer — and must NOT fall back to a global, org-unscoped
    // buffer, which could replay another org's events. Every authorized WS
    // connection carries a real orgId (see WsData), so a missing/empty one here
    // means an un-upgraded or malformed caller: force a resync and replay nothing.
    if (!orgId) {
      ws.send(JSON.stringify({ type: "sync" }))
      return
    }

    // A fresh connection (lastEventId=0) starts "from now" and gets NO replay — the
    // client hydrates current state via REST and applies live deltas going forward.
    // Replaying the entire org buffer on every fresh connect / page-load is incorrect
    // (the contract is presence-only) and a needless flood. The abuse guard below
    // never fires for 0 on a sub-1000-event buffer, so the zero case short-circuits.
    if (lastEventId === 0) return

    // Prevent replay abuse: a client cannot request events older than ~1000 before it
    // connected. A legitimate reconnect uses the lastEventId from its previous session.
    const client = this.sockets.get(ws)
    if (client && client.connectedAtEventId > 0 && lastEventId < client.connectedAtEventId - 1000) {
      ws.send(JSON.stringify({ type: "sync" }))
      return
    }

    // orgId is guaranteed non-empty past the guard above — always use the
    // per-org buffer; there is no global org-unscoped fallback (B23b).
    const bufferKey = replayBufferKey(orgId)
    const seqKey = `ws:seq:${orgId}`
    const bufferExists = await this.redis.exists(bufferKey)

    if (!bufferExists) {
      // A cursor (lastEventId>0, past the 0 short-circuit) with no surviving buffer
      // → force a resync.
      ws.send(JSON.stringify({ type: "sync" }))
      return
    }

    // Out-of-range cursor (beyond the newest buffered event) → force a resync rather
    // than silently replaying an empty range and treating a bogus/future-dated cursor
    // as "caught up". Guarded on maxBufferedId>0 so a present buffer with an unknown
    // seq still falls through to the normal range query.
    const maxBufferedId = Number((await this.redis.get(seqKey)) ?? "0")
    if (maxBufferedId > 0 && lastEventId > maxBufferedId) {
      ws.send(JSON.stringify({ type: "sync" }))
      return
    }

    // The buffer is trimmed by size and age: a cursor older than the highest
    // trimmed id would silently miss what was dropped, so it resyncs instead.
    const trimmedThrough = Number((await this.redis.get(replayTrimmedKey(orgId))) ?? "0")
    if (trimmedThrough > 0 && lastEventId < trimmedThrough) {
      ws.send(JSON.stringify({ type: "sync" }))
      return
    }

    const events = await this.redis.zrangebyscore(bufferKey, lastEventId + 1, "+inf")

    // Cap replay to prevent clients from flooding the server on reconnect. The
    // buffer itself holds at most REPLAY_BUFFER_MAX_EVENTS, so this is a guard.
    if (events.length > REPLAY_BUFFER_MAX_EVENTS) {
      ws.send(JSON.stringify({ type: "sync" }))
      return
    }

    let sent = 0
    for (const member of events) {
      try {
        const decoded = decodeBufferedFrame(member)
        const raw = JSON.parse(decoded)
        // A frame buffered before the file-event cut still carries the full
        // file metadata: cut it on the way out as well.
        const parsed =
          raw?.payload?.app === "kernel" &&
          (raw.payload.entity === "file" || raw.payload.entity === "company")
            ? { ...raw, payload: projectFileEventForSocket(raw.payload) }
            : raw
        const event = parsed === raw ? decoded : JSON.stringify(parsed)
        if (parsed.payload?.orgId && parsed.payload.orgId !== orgId) continue

        // Dynamic membership update during replay — fixes race where participant:add
        // arrives between membership load and replay start
        if (parsed.payload?.entity === "participant" && parsed.payload?.action === "add") {
          const evtData = parsed.payload.data as { userId?: string; threadId?: string } | undefined
          const conn = this.sockets.get(ws)
          if (evtData?.userId === userId && evtData?.threadId && conn) {
            conn.threads.add(evtData.threadId)
          }
        }
        // Also handle participant:remove during replay
        if (parsed.payload?.entity === "participant" && parsed.payload?.action === "remove") {
          const evtData = parsed.payload.data as { userId?: string; threadId?: string } | undefined
          const conn = this.sockets.get(ws)
          if (evtData?.userId === userId && evtData?.threadId) {
            conn?.threads.delete(evtData.threadId)
          }
        }

        if (parsed.payload && this.hasAccess(scopes, parsed.payload.app, parsed.payload.entity)) {
          const replayClient: ConnectedClient = {
            userId,
            orgId,
            ws,
            scopes,
            dimensionGrants,
            connectedAtEventId: 0,
          }
          if (
            this.hasThreadAccess(userId, parsed.payload) &&
            this.hasScopeVisibilityAccess(replayClient, parsed.payload) &&
            this.hasKernelConnectedAccountAccess(replayClient, parsed.payload) &&
            this.hasMailAccountAccess(replayClient, parsed.payload) &&
            this.hasApprovalRequestAccess(replayClient, parsed.payload) &&
            this.hasNotificationRecipientAccess(replayClient, parsed.payload) &&
            this.hasOwnReadStateAccess(replayClient, parsed.payload) &&
            this.hasOwnNodeSessionAccess(replayClient, parsed.payload) &&
            this.hasPersonalRoutineAccess(replayClient, parsed.payload) &&
            this.hasCompanyAudienceAccess(replayClient, parsed.payload) &&
            this.hasDashboardVisibilityAccess(replayClient, parsed.payload) &&
            this.hasDimensionAccess(dimensionGrants, parsed.payload)
          ) {
            // The buffer holds the unredacted frame, so replay redacts per member too.
            const out = stripCompanyAudience(this.redactSubRunSummary(replayClient, parsed.payload))
            ws.send(out === parsed.payload ? event : JSON.stringify({ ...parsed, payload: out }))
            sent++
          }
        }
      } catch (err) {
        log.warn({ err }, "Failed to parse buffered event")
      }
    }

    log.debug({ userId, lastEventId, replayed: sent }, "Hello replay complete")
  }

  hasAccess(scopes: string[], app: string, entity?: string): boolean {
    // Org-wide entities (e.g., presence) are visible to any authenticated user
    if (entity && ORG_WIDE_ENTITIES.has(entity)) return true

    // Malformed payload guard: a missing `app` cannot be matched against any
    // scope. Deny rather than fall through to the default resolver, whose
    // `app.startsWith(...)` would throw on `undefined` and reject the entire
    // fan-out — in the durable outbox path that throw makes the worker retry the
    // same event forever, surfacing as an error-rate spike. An app-less event is
    // not deliverable to a scoped client, so denying is both safe and correct.
    if (!app) return false

    // Explicit per-event mapping for kernel approval_request events. Read access
    // requires the read scope or any parent-prefix; write-only sub-scopes do not
    // satisfy the resource gate.
    // The reader's own read marks. No scope gates them: the per-user filter
    // (`hasOwnReadStateAccess`) already limits each frame to its owner, and
    // the frame carries ids and a count, nothing a scope protects.
    if (app === "kernel" && entity === "read_state") return true

    // A node session and its events, and a node change (S18): no scope gates
    // them, the owner filter (`hasOwnNodeSessionAccess`) limits each frame to
    // the owner.
    if (app === "kernel" && entity !== undefined && OWNER_ONLY_NODE_ENTITIES.has(entity)) {
      return true
    }

    if (app === "kernel" && entity === "approval_request") {
      return hasScope("kernel:approvals:read", scopes)
    }

    // An agent's notification to named people (a node chat's permission
    // prompt, a routine alert): no scope gates it, the recipient filter
    // (`hasNotificationRecipientAccess`) limits each frame to the people it
    // names. Without this no member received it (no scope reads
    // `agent_notification`), so an open chat never heard of a new prompt.
    if (app === "kernel" && entity === "agent_notification") return true

    // A security signal (modules/security/security-events.ts): its summary names
    // an account and what happened to it, for the org's administrators only.
    if (app === "kernel" && entity === "security_event") {
      return hasScope("kernel:org:admin", scopes)
    }

    // A mail provider switch flipped (modules/mail/provider-settings.ts): the
    // frame carries the provider id and whether it is on, what Settings > Mail
    // shows every reader of the mailbox list.
    if (app === "mail" && entity === "provider") {
      return hasScope("mail:accounts:read", scopes)
    }

    // A secret card's state changed (modules/secret-requests). The frame carries
    // the request id and its status only; the card that shows it re-reads the
    // row, which RLS holds to the conversation's participants.
    if (app === "kernel" && entity === "secret_request") {
      return hasScope("kernel:threads:read", scopes)
    }

    // An import run changed or progressed (modules/imports/runs.ts). The frame
    // carries the run id and status only; a reader re-reads the run, which RLS
    // gives to holders of kernel:imports:read.
    if (app === "kernel" && entity === "import_run") {
      return hasScope("kernel:imports:read", scopes)
    }

    // A company frame rides on the companies read scope (the default resolver
    // would want `kernel:company[s]`, and "companies" is no plain plural).
    // Who among those readers gets it is `hasCompanyAudienceAccess`.
    if (app === "kernel" && entity === "company") {
      return hasScope("kernel:companies:read", scopes)
    }

    // `knowledge:synced_source` events (create / update / archive). The RLS
    // policy on `app_knowledge.synced_sources` requires
    // `knowledge:documents:read` for SELECT (with an additional owner filter
    // for personal sources), so the WS-side gate uses the same scope. The
    // event payload itself carries no sensitive content — the doc-view's
    // store handler is what reacts to a remote archive — but we still scope
    // by the readable scope to keep the access surface aligned with RLS.
    if (app === "knowledge" && entity === "synced_source") {
      return (
        hasScope("knowledge:documents:read", scopes) ||
        hasScope("knowledge:documents:admin", scopes)
      )
    }

    // F2 — tickets sub-entities. The default resolver below expects a scope of
    // the form `tickets:<entity>[s]`, so a granularly-scoped support agent
    // holding only `tickets:tickets:read` would be denied these frames even
    // though they are the very ticket updates it is allowed to see. Mirror the
    // approval_request/knowledge special cases, but gate each sub-entity on the
    // read scope of the resource it actually belongs to:
    //   - message / note / sla ride on the parent ticket -> tickets:tickets:read
    //     (these ALSO carry the parent ticket's tickets:team /
    //     tickets:sensitivity dimension values so hasDimensionAccess enforces
    //     the same team/sensitivity isolation RLS applies to the ticket body).
    //   - inbox / category are their own resources -> their own read scopes
    //     (payloads are IDs, non-leaking, but the gate mirrors each resource's
    //     read scope).
    if (app === "tickets" && (entity === "message" || entity === "note" || entity === "sla")) {
      return hasScope("tickets:tickets:read", scopes)
    }
    if (app === "tickets" && entity === "inbox") {
      return hasScope("tickets:inboxes:read", scopes)
    }
    if (app === "tickets" && entity === "category") {
      return hasScope("tickets:categories:read", scopes)
    }

    // Projects status metadata rides on project read. The default resolver
    // below expects a `projects:project_status[s]` scope which no real grant
    // carries, so members holding only projects:projects:read or
    // projects:tasks:* would never receive project_status frames even though
    // statuses are visible to anyone who can read the project (a status row
    // is label/color/order — nothing beyond what project read exposes).
    if (app === "projects" && entity === "project_status") {
      return hasScope("projects:projects:read", scopes) || hasScope("projects:tasks:read", scopes)
    }

    // Task rows (and their checklist items) are readable iff RLS on
    // `app_projects.tasks` lets the reader see them, and that predicate is
    // `projects:projects:read`. A tasks-only grant reads no task row, so it
    // gets no task frame either.
    if (app === "projects" && (entity === "task" || entity === "task_checklist_item")) {
      return hasScope("projects:projects:read", scopes)
    }

    // The task label catalog rides on project read: the labels_select
    // RLS policy gates rows on exactly projects:projects:read, and a label
    // frame carries only ids, names and order (nothing labels.list does not
    // return to the same reader). Without this branch the default resolver
    // wants a `projects:label[s]` scope no real grant carries, so members
    // would never refetch the catalog.
    if (app === "projects" && entity === "label") {
      return hasScope("projects:projects:read", scopes)
    }

    return scopes.some((s) => {
      if (s === "*") return true
      if (s === app) return true
      // Parent scope grants access to child events
      if (app.startsWith(`${s}:`)) return true
      // Scope is under this app — check entity alignment
      if (!s.startsWith(`${app}:`)) return false
      if (!entity) return false // No entity info: deny (events must have explicit entity)
      const parts = s.split(":")
      // Trailing wildcard, `hasScope` semantics: `<app>:*` covers every
      // resource of the app. A mid-segment wildcard (`<app>:*:read`) never
      // matches, as in `hasScope`.
      const wildcardIdx = parts.indexOf("*")
      if (wildcardIdx !== -1 && wildcardIdx !== parts.length - 1) return false
      if (parts.length === 2 && parts[1] === "*") return true
      const resource = parts[1]
      // Direct entity match with plural tolerance
      if (resource === entity || resource === `${entity}s`) return true
      // Thread and thread sub-entities (message, reaction, etc.) need "threads" scope
      if ((entity === "thread" || THREAD_SCOPED_ENTITIES.has(entity)) && resource === "threads")
        return true
      return false
    })
  }

  /** Per-user filter for approval_request events: client must be in `data.notifyUserIds`.
   *  Used alongside the resource-access check in `hasAccess`. */
  /**
   * A sub_run update's summary quotes the child's output. It reaches a member
   * only when they can see the card (`isMessageVisible` over the update's
   * requiredScopes and disclosureList, with the member's own grants); anyone
   * else gets the same update without the summary text. An update that carries
   * no requiredScopes array gives nobody the summary (fail closed).
   */
  private redactSubRunSummary(
    client: { userId: string; scopes: string[] },
    payload: EventPayload,
  ): EventPayload {
    if (payload.app !== "kernel" || payload.entity !== "sub_run") return payload
    const data = payload.data as Record<string, unknown> | undefined
    if (!data || data.summary === undefined || data.summary === null) return payload
    const visible = isMessageVisible(
      {
        requiredScopes: data.requiredScopes as string[],
        disclosureList: Array.isArray(data.disclosureList)
          ? (data.disclosureList as string[])
          : null,
      },
      { userId: client.userId, grants: client.scopes },
    )
    return visible ? payload : { ...payload, data: { ...data, summary: null } }
  }

  /**
   * THE WITHHELD BLOCK IS THE REQUESTER'S ALONE, live as well as stored.
   *
   * The end of turn copy of an agent reply carries the withheld set so the
   * card draws the moment the turn lands rather than on the next open. The
   * room gets the same event, so every connection's copy goes through the same
   * projection the read path uses: the requester keeps the block (minus any
   * raw scope name a legacy row carries), everyone else gets the metadata with
   * the key removed entirely.
   */
  private projectWithheldMetadata(client: { userId: string }, payload: EventPayload): EventPayload {
    if (payload.app !== "kernel" || payload.entity !== "message") return payload
    const data = payload.data as Record<string, unknown> | undefined
    const metadata = data?.metadata
    if (typeof metadata !== "object" || metadata === null) return payload
    if (!("withheld" in (metadata as Record<string, unknown>))) return payload
    const projected = projectMessageMetadataForViewer(metadata, client.userId)
    if (projected === metadata) return payload
    return { ...payload, data: { ...data, metadata: projected } }
  }

  /**
   * A read mark is the reader's own business: `kernel:read_state` reaches the
   * sockets of `data.forUserId` and nobody else's, never the other members of
   * the thread (that would be a read receipt nobody opted into). A frame
   * without a `forUserId` reaches no one (fail closed).
   */
  private hasOwnReadStateAccess(client: { userId: string }, payload: EventPayload): boolean {
    if (payload.app !== "kernel" || payload.entity !== "read_state") return true
    const data = payload.data as { forUserId?: unknown } | undefined
    return typeof data?.forUserId === "string" && data.forUserId === client.userId
  }

  /**
   * A node session runs on its owner's computer and is the owner's alone
   * (C4, D40): `kernel:node_session` and `kernel:node_session_event` reach the
   * sockets of `data.ownerUserId` and nobody else's, not even an org admin
   * holding `*`. A frame without an owner reaches no one (fail closed). The
   * same rule covers `kernel:node` (a node change, S18).
   */
  /**
   * A new routine (`kernel/routine:create`) names its owner, its creator and
   * its template: a personal one reaches only those two, as reading the
   * routine itself does. Only a frame that says `visibility: "shared"` goes
   * to every routines reader; one that says nothing is personal (fail closed).
   */
  /**
   * A company shared with nobody is its creator's and its grantees' business:
   * its frame reaches only the users its audience names, not another member
   * and not an admin holding `*` (sharing has no admin bypass). A company
   * shared through a role reaches its role holders on their next read, not
   * live. A frame without an audience reaches no one (fail closed).
   */
  private hasCompanyAudienceAccess(client: { userId: string }, payload: EventPayload): boolean {
    if (payload.app !== "kernel" || payload.entity !== "company") return true
    const audience = (payload.data as { audience?: unknown } | undefined)?.audience as
      | { orgWide?: unknown; userIds?: unknown }
      | undefined
    if (!audience || typeof audience !== "object") return false
    if (audience.orgWide === true) return true
    return Array.isArray(audience.userIds) && audience.userIds.includes(client.userId)
  }

  private hasPersonalRoutineAccess(client: { userId: string }, payload: EventPayload): boolean {
    if (payload.app !== "kernel" || payload.entity !== "routine" || payload.action !== "create") {
      return true
    }
    const data = payload.data as
      | { visibility?: unknown; ownerUserId?: unknown; createdByUserId?: unknown }
      | undefined
    if (data?.visibility === "shared") return true
    return data?.ownerUserId === client.userId || data?.createdByUserId === client.userId
  }

  /**
   * A `kernel:dashboard` frame (modules/dashboards/service.ts) follows the row's
   * SELECT policy: a dashboard the whole org sees (`orgWide`) reaches every reader;
   * any other reaches the people in `userIds` (its owner, the people and the role
   * members it is shared with, and those who saw it before the change). `wasOrgWide`
   * still reaches the readers who saw it, so their list drops it. The frame carries
   * ids and access, never a title. A frame of the previous release (no `orgWide`)
   * follows `visibility` as before. A frame naming nobody reaches no one (fail closed).
   */
  private hasDashboardVisibilityAccess(client: { userId: string }, payload: EventPayload): boolean {
    if (
      payload.app === "kernel" &&
      (payload.entity === "dashboard_table" || payload.entity === "dashboard_table_row")
    ) {
      return hasDashboardTableAudience(client.userId, payload.data)
    }
    if (payload.app !== "kernel" || payload.entity !== "dashboard") return true
    const data = payload.data as
      | {
          visibility?: unknown
          previousVisibility?: unknown
          ownerUserId?: unknown
          orgWide?: unknown
          wasOrgWide?: unknown
          userIds?: unknown
        }
      | undefined
    if (typeof data?.orgWide === "boolean") {
      if (data.orgWide || data.wasOrgWide === true) return true
      if (Array.isArray(data.userIds) && data.userIds.includes(client.userId)) return true
      return typeof data.ownerUserId === "string" && data.ownerUserId === client.userId
    }
    if (data?.visibility === "org" || data?.previousVisibility === "org") return true
    return typeof data?.ownerUserId === "string" && data.ownerUserId === client.userId
  }

  private hasOwnNodeSessionAccess(client: { userId: string }, payload: EventPayload): boolean {
    if (payload.app !== "kernel") return true
    if (!OWNER_ONLY_NODE_ENTITIES.has(payload.entity)) return true
    const data = payload.data as { ownerUserId?: unknown } | undefined
    return typeof data?.ownerUserId === "string" && data.ownerUserId === client.userId
  }

  /** S53 (D29): sockets whose hello said they read a session's main thread only. */
  private readonly topOnlyNodeSessionSockets = new WeakSet<object>()

  /**
   * S53 (D29): `"top"` stops a subagent's `kernel:node_session_event` frames
   * (those with `parentToolUseId`) reaching this socket; anything else (an
   * installed client that sends nothing) keeps every event.
   */
  setNodeSessionScope(ws: WsLike, scope: unknown): void {
    if (scope === "top") this.topOnlyNodeSessionSockets.add(ws)
    else this.topOnlyNodeSessionSockets.delete(ws)
  }

  private wantsNodeSessionEvent(client: { ws: WsLike }, payload: EventPayload): boolean {
    if (payload.app !== "kernel" || payload.entity !== "node_session_event") return true
    const data = payload.data as { parentToolUseId?: unknown } | undefined
    if (typeof data?.parentToolUseId !== "string") return true
    return !this.topOnlyNodeSessionSockets.has(client.ws)
  }

  /**
   * `kernel:agent_notification` reaches the people it names (`data.targetUserIds`,
   * the same list its attention row is filed for) and nobody else, not even an
   * org admin holding `*`: its summary is addressed to them. A frame naming
   * nobody reaches no one (fail closed).
   */
  private hasNotificationRecipientAccess(
    client: { userId: string },
    payload: EventPayload,
  ): boolean {
    if (payload.app !== "kernel" || payload.entity !== "agent_notification") return true
    const data = payload.data as { targetUserIds?: unknown } | undefined
    return Array.isArray(data?.targetUserIds) && data.targetUserIds.includes(client.userId)
  }

  private hasApprovalRequestAccess(client: ConnectedClient, payload: EventPayload): boolean {
    if (payload.app !== "kernel" || payload.entity !== "approval_request") return true
    const data = payload.data as { notifyUserIds?: string[] } | undefined
    if (!Array.isArray(data?.notifyUserIds)) return false
    return data.notifyUserIds.includes(client.userId)
  }

  // Presence management. The socket path awaits these, so each Redis command
  // is bounded (`redisTimeoutMs`) and none rejects (P2-3).

  /** Write a presence status. Without an answer from Redis the write is skipped and logged. */
  async setPresence(
    orgId: string,
    userId: string,
    status: "online" | "away" | "offline",
  ): Promise<void> {
    try {
      await bounded(
        this.redis.set(`presence:${orgId}:${userId}`, status, "EX", this.PRESENCE_TTL),
        this.redisTimeoutMs,
        "setPresence",
      )
    } catch (err) {
      log.warn({ err, orgId, userId, status }, "presence write skipped: Redis unanswered")
    }
  }

  /**
   * Tell the org's sockets, on every replica, that a user's status changed.
   * Without an answer from Redis the frame is dropped and logged: presence is
   * advisory, and the next hello's `presence_sync` corrects it.
   */
  async announcePresence(
    orgId: string,
    userId: string,
    status: "online" | "away" | "offline",
  ): Promise<void> {
    try {
      const { broadcastEphemeral } = await import("~/infra/events/event-bus")
      await bounded(
        broadcastEphemeral({
          app: "kernel",
          entity: "presence",
          action: "update",
          orgId,
          actorId: userId,
          data: { userId, status },
        }),
        this.redisTimeoutMs,
        "presence broadcast",
      )
    } catch (err) {
      log.warn({ err, orgId, userId, status }, "presence broadcast dropped: Redis unanswered")
    }
  }

  /**
   * The org's current event sequence, which bounds how far back a socket's
   * hello may ask to replay. Without an answer from Redis it is 0: the socket
   * proceeds without a replay cursor (no bound on its replay request), logged.
   */
  async currentEventSeq(orgId: string): Promise<number> {
    try {
      const raw = await bounded(this.redis.get(`ws:seq:${orgId}`), this.redisTimeoutMs, "ws:seq")
      return Number(raw) || 0
    } catch (err) {
      log.warn({ err, orgId }, "ws open: event sequence unanswered, no replay cursor")
      return 0
    }
  }

  /**
   * Record one connection's mailbox-unlock assertion (blueprint Task 9.4). Each
   * connection holds its own, and the user reads unlocked while any one of them
   * says so: a client that opens locked never masks another that is unlocked.
   * `connection` defaults to one shared slot, for callers that have no socket.
   */
  async setMailboxUnlock(
    userId: string,
    entry: MailboxUnlockEntry,
    connection = "default",
  ): Promise<void> {
    await this.live.setMailboxUnlock(userId, connection, entry)
  }

  /** The assertion a status frame on `ws` makes, recorded for that connection only. */
  async setSocketMailboxUnlock(ws: WsLike, entry: MailboxUnlockEntry): Promise<void> {
    const meta = this.sockets.get(ws)
    if (!meta) return
    await this.live.setMailboxUnlock(meta.userId, this.unlockMember(meta.connId), entry)
  }

  /** The user's unlocked live connections that can still answer a request of `turnNonce`. */
  async getMailboxAnswerers(userId: string, turnNonce: string): Promise<MailboxAnswerers> {
    return await this.live.getMailboxAnswerers(userId, turnNonce)
  }

  private unlockMember(connId: string): string {
    return `${this.instanceId}|${connId}`
  }

  /** The live assertion, or undefined when there is none (which reads as locked). */
  async getMailboxUnlock(userId: string): Promise<MailboxUnlockEntry | undefined> {
    return await this.live.getMailboxUnlock(userId)
  }

  async refreshPresence(orgId: string, userId: string): Promise<void> {
    try {
      await bounded(
        this.redis.expire(`presence:${orgId}:${userId}`, this.PRESENCE_TTL),
        this.redisTimeoutMs,
        "refreshPresence",
      )
    } catch (err) {
      log.warn({ err, orgId, userId }, "presence refresh skipped: Redis unanswered")
    }
  }

  /** The stored status, or null when there is none or Redis does not answer (logged). */
  async getPresence(orgId: string, userId: string): Promise<string | null> {
    try {
      return await bounded(
        this.redis.get(`presence:${orgId}:${userId}`),
        this.redisTimeoutMs,
        "getPresence",
      )
    } catch (err) {
      log.warn({ err, orgId, userId }, "presence read unanswered: reading none")
      return null
    }
  }

  /**
   * Whether any live socket in the cell may read this account's mail. This
   * process's own sockets answer first; otherwise the cell state does, and an
   * unanswered read fails closed (false).
   */
  async hasOnlineUserWithMailAccess(orgId: string, account: MailAccessAccount): Promise<boolean> {
    for (const client of this.orgSockets(orgId).values()) {
      if (client.ws.readyState !== WS_OPEN) continue
      if (account.ownerType === "user") {
        if (account.ownerId && client.userId === account.ownerId) return true
        continue
      }
      if (mailInboxGrantAllows(client.dimensionGrants, account.id)) return true
    }
    return this.live.hasOnlineUserWithMailAccess(orgId, account)
  }

  /**
   * Leader sweep hook: delete a dead instance's sockets from the cell state,
   * then mark offline, and tell each org, every user it left with no live socket.
   */
  async cleanupDeadInstance(deadId: string): Promise<void> {
    const left = await this.live.cleanupInstance(deadId)
    if (left.length === 0) return
    for (const { orgId, userId } of left) {
      await this.setPresence(orgId, userId, "offline")
      await this.announcePresence(orgId, userId, "offline")
    }
    log.info({ deadInstanceId: deadId, usersOffline: left.length }, "ws: dead instance swept")
  }

  /**
   * This instance's heartbeat record came back after a lapse (P2-1): the
   * sweep may have deleted its sockets, so rewrite them from the local table,
   * and put back online any of its users the sweep marked offline.
   */
  async republishOwnConnections(): Promise<void> {
    await this.live.republish([...this.sockets.values()].map((c) => this.liveConn(c)))
    const users = new Map<string, { orgId: string; userId: string }>()
    for (const c of this.sockets.values()) users.set(`${c.orgId}\n${c.userId}`, c)
    for (const { orgId, userId } of users.values()) {
      const status = await this.getPresence(orgId, userId)
      if (status === "online" || status === "away") continue
      await this.setPresence(orgId, userId, "online")
      await this.announcePresence(orgId, userId, "online")
    }
  }

  // In-memory presence cache to avoid hammering Redis on reconnect storms
  private presenceCache = new Map<string, { map: Record<string, string>; expiry: number }>()
  private static readonly MAX_PRESENCE_CACHE_SIZE = 500
  // Per-org ceiling on presence holders scanned out of Redis, distinct from
  // MAX_PRESENCE_CACHE_SIZE above (which bounds how many ORGS are cached at once).
  // Sized for 1000 concurrent human sessions (the figure the previous value of
  // 1000 assumed on its own) plus one personal agent per human and the 5 named
  // role agents, which is 2005, with headroom to 2100. Public so the sizing is a
  // named constant a test can read rather than a literal buried in the scan loop.
  static readonly MAX_PRESENCE_KEYS = 2100

  async getPresenceMap(orgId: string): Promise<Record<string, string>> {
    const cached = this.presenceCache.get(orgId)
    if (cached && Date.now() < cached.expiry) {
      return cached.map
    }

    const cap = WebSocketManager.MAX_PRESENCE_KEYS
    // Who is online is who holds a live socket anywhere in the cell; the
    // status keys only say online or away. Without an answer from Redis the
    // map falls back to this process's own sockets.
    let users: string[]
    try {
      users = await this.live.onlineUsers(orgId, cap)
    } catch (err) {
      log.warn({ err, orgId }, "presence map: live state unanswered, using local sockets")
      users = [...new Set([...this.orgSockets(orgId).values()].map((c) => c.userId))]
    }
    if (users.length > cap) users.length = cap
    const result: Record<string, string> = {}
    let statuses: Array<string | null> = []
    if (users.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        statuses = await Promise.race([
          this.redis.mget(...users.map((u) => `presence:${orgId}:${u}`)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("presence status read timed out")), 1_000)
          }),
        ])
      } catch (err) {
        log.warn({ err, orgId }, "presence map: status read failed, reading everyone online")
      } finally {
        clearTimeout(timer)
      }
    }
    users.forEach((userId, i) => {
      result[userId] = statuses[i] === "away" ? "away" : "online"
    })

    // Evict expired entries and enforce max size to prevent unbounded growth
    if (this.presenceCache.size >= WebSocketManager.MAX_PRESENCE_CACHE_SIZE) {
      const now = Date.now()
      for (const [key, entry] of this.presenceCache) {
        if (now >= entry.expiry) this.presenceCache.delete(key)
      }
      // If still over limit after expiry sweep, evict oldest entries
      if (this.presenceCache.size >= WebSocketManager.MAX_PRESENCE_CACHE_SIZE) {
        const toDelete = this.presenceCache.size - WebSocketManager.MAX_PRESENCE_CACHE_SIZE + 1
        let deleted = 0
        for (const key of this.presenceCache.keys()) {
          if (deleted >= toDelete) break
          this.presenceCache.delete(key)
          deleted++
        }
      }
    }
    this.presenceCache.set(orgId, { map: result, expiry: Date.now() + 5000 })
    return result
  }

  // Check if user is a member of a specific thread
  private checkThreadMembership(userId: string, threadId?: string): boolean {
    if (!threadId) return true
    for (const client of this.userSockets(userId).values()) {
      if (client.threads.has(threadId)) return true
    }
    // Default deny when membership not loaded
    return false
  }

  // Dimension-based filtering: check that the event's dimension values match the client's grants.
  // Iterates over the user's grant keys (known restricted dimensions), not data fields.
  // This avoids false-denying on non-dimension data fields (name, title, etc.) while
  // correctly enforcing dimension restrictions on fields the user is restricted on.
  // Only the global wildcard {"*": ["*"]} means unrestricted.
  // Users with no dimension grants at all (empty {}) are unrestricted.
  private hasDimensionAccess(
    dimensionGrants: Record<string, string[]>,
    payload: EventPayload,
  ): boolean {
    const data = payload.data as Record<string, unknown> | undefined
    if (!data) return true

    // Users with no dimension grants at all are unrestricted (no dimension restrictions configured)
    const grantKeys = Object.keys(dimensionGrants)
    if (grantKeys.length === 0) return true

    // Global wildcard {"*": ["*"]} means unrestricted access to all dimensions
    const globalGrant = dimensionGrants["*"]
    const hasGlobalWildcard = globalGrant?.includes("*") ?? false
    if (hasGlobalWildcard) return true

    // Check each dimension the user has grants for against the event data.
    // If the event data contains a field matching a grant key, the value must match.
    for (const [dimKey, allowedValues] of Object.entries(dimensionGrants)) {
      if (dimKey === "*") continue // Already handled above

      const dataValue = data[dimKey]
      if (dataValue === undefined) continue // Event doesn't contain this dimension field

      // Only check string/array dimension values
      if (typeof dataValue !== "string" && !Array.isArray(dataValue)) continue

      // Key-specific wildcard
      if (allowedValues.includes("*")) continue

      // Empty grant array for this key = deny
      if (allowedValues.length === 0) return false

      // Check if the event's value matches the allowed values
      if (typeof dataValue === "string" && !allowedValues.includes(dataValue)) return false
      if (Array.isArray(dataValue) && !dataValue.some((v) => allowedValues.includes(String(v))))
        return false
    }

    return true
  }

  // Thread-scoped event filtering
  private hasThreadAccess(userId: string, payload: EventPayload): boolean {
    // Non-kernel events bypass thread check
    if (payload.app !== "kernel") return true

    // Presence events are org-wide
    if (payload.entity === "presence") return true

    // thread:create events — check participantIds in data
    if (payload.entity === "thread" && payload.action === "create") {
      const data = payload.data as { participantIds?: string[] } | undefined
      return data?.participantIds?.includes(userId) ?? false
    }

    // thread:update events — extract threadId from data.id (not data.threadId)
    if (payload.entity === "thread" && payload.action === "update") {
      const data = payload.data as { id?: string } | undefined
      return this.checkThreadMembership(userId, data?.id)
    }

    // Thread-scoped entities require membership check
    if (THREAD_SCOPED_ENTITIES.has(payload.entity)) {
      // `sub_run` events carry the parent thread under `parentThreadId` (the
      // hidden subrun thread is internal — receiving access flows through the
      // PARENT thread's membership). All other thread-scoped entities use the
      // canonical `threadId` field.
      const data = payload.data as { threadId?: string; parentThreadId?: string } | undefined
      const tid =
        payload.entity === "sub_run" ? (data?.parentThreadId ?? data?.threadId) : data?.threadId
      return this.checkThreadMembership(userId, tid)
    }

    // Non-thread kernel events pass through
    return true
  }

  private hasKernelConnectedAccountAccess(client: ConnectedClient, payload: EventPayload): boolean {
    if (payload.app !== "kernel" || payload.entity !== "connected_account") return true

    const data = payload.data as Record<string, unknown> | undefined
    if (data?.ownerType !== "user") return true

    return data.ownerId === client.userId
  }

  private hasMailAccountAccess(client: ConnectedClient, payload: EventPayload): boolean {
    if (payload.app !== "mail") return true
    if (
      payload.entity !== "conversation" &&
      payload.entity !== "message" &&
      payload.entity !== "account"
    ) {
      return true
    }

    const data = payload.data as Record<string, unknown> | undefined
    if (!data) return true

    const accountId =
      typeof data._inboxAccountId === "string"
        ? data._inboxAccountId
        : typeof data.accountId === "string"
          ? data.accountId
          : undefined
    if (!accountId) return true

    const ownerType = typeof data._mailOwnerType === "string" ? data._mailOwnerType : undefined
    const ownerId = typeof data._mailOwnerId === "string" ? data._mailOwnerId : null
    if (ownerType === "user") return ownerId === client.userId

    return mailInboxGrantAllows(client.dimensionGrants, accountId)
  }

  /**
   * A2 reactive visibility, second pass. `hasThreadAccess` already reduced the
   * fan-out to the room's members; this reduces it again to the members who
   * could read the message through RLS, so nothing is ever pushed live that a
   * refetch would hide. The predicate is `isMessageVisible`, the same one the
   * read path and the SELECT policy mirror, so the three can never drift.
   *
   * Evaluated per connection with that connection's OWN cached grants
   * (`client.scopes`, captured at connect and refreshed by the reconnect a
   * permission change forces), never the sender's and never a database read:
   * this runs for every connection of every event.
   *
   * Only kernel `message` and `agent_stream` frames are scope-tagged; the
   * streaming half is `hasStreamChunkAccess` below. `mail` and `tickets` emit their own
   * `message` entities with their own gates (`hasMailAccountAccess`,
   * dimensions) and no requiredScopes, so they are left alone rather than
   * failed closed.
   *
   * Fails closed: a kernel message frame carrying no requiredScopes array is
   * delivered to nobody. An untagged producer therefore loses live delivery
   * (the client still reads the message on its next fetch, where RLS decides)
   * rather than leaking it to the whole room.
   */
  private hasScopeVisibilityAccess(client: ConnectedClient, payload: EventPayload): boolean {
    if (payload.app !== "kernel") return true
    if (payload.entity === "agent_stream") return this.hasStreamChunkAccess(client, payload)
    if (payload.entity !== "message") return true
    const data = payload.data as Record<string, unknown> | undefined
    return isMessageVisible(
      {
        requiredScopes: data?.requiredScopes as string[],
        disclosureList: Array.isArray(data?.disclosureList)
          ? (data.disclosureList as string[])
          : null,
      },
      { userId: client.userId, grants: client.scopes },
    )
  }

  /**
   * A2 reactive visibility for a turn that is still running. A finished message
   * has one final scope set; a STREAMING turn does not, because its set grows
   * as each tool call is recorded into the run frame's scope accumulator. So a
   * chunk is gated on `data.accumulatedScopes`, the set accumulated SO FAR at
   * the moment that chunk was emitted, re-evaluated for every chunk and never
   * once at stream start.
   *
   * The set only ever grows, which is what makes per-chunk evaluation the whole
   * mechanism rather than an optimisation:
   *
   * - a connection that GAINS the scope mid-turn does not receive the turn's
   *   earlier chunks. Chunks are ephemeral (`broadcast`, never buffered, so
   *   never replayed on hello), each one is decided when it is emitted, and
   *   nothing here re-sends a past chunk. A grant forces a reconnect, so the
   *   wider grants apply from the next chunk on. Retroactive delivery would
   *   hand over content that was correctly withheld while it was scoped.
   * - a connection that LOSES visibility mid-turn stops receiving further
   *   chunks, by the same rule read the other way. That happens either because
   *   a revoke narrowed its cached `client.scopes` (again through the forced
   *   reconnect) or, with no permission change at all, because the turn
   *   accumulated a scope the connection does not hold. Chunks already
   *   delivered are not recalled: they were emitted while the turn's set was
   *   genuinely narrower.
   *
   * FAIL CLOSED ON AN UNKNOWN SET. A chunk carrying no readable
   * `accumulatedScopes` array is not emitted to the room. A2 forbids emitting
   * an untagged chunk of a turn that will end up scope-tagged, and at the
   * moment of the chunk nothing knows whether this turn is that turn. Guessing
   * `[]` would assert that the turn has read nothing, which is exactly the
   * claim that cannot be made, and would publish the stream to the whole room.
   * Losing a live chunk is recoverable: the reply is persisted through
   * `sendMessage` and read on the next fetch, where RLS decides.
   *
   * THE REQUESTER IS EXEMPT. `payload.actorId` is the user whose request
   * started the turn (every `agent_stream` producer stamps it). They always see
   * their own turn stream, including while the set is unknown: the turn runs
   * under their own floored effective scope, so it can only read what they can
   * read, and a user watching their own agent think must not have it go dark.
   * This exemption is the STREAM's alone and deliberately does not extend to
   * the persisted message, whose filter and fail-closed default are untouched.
   *
   * Scope coverage is `isMessageVisible`, so a `*`, `<prefix>:*` or parent
   * grant covers an accumulated scope exactly as it does for the finished
   * message. A chunk carries no disclosure list: disclosure is a property of a
   * persisted message, and inventing one here could only widen.
   */
  private hasStreamChunkAccess(client: ConnectedClient, payload: EventPayload): boolean {
    if (payload.actorId && payload.actorId === client.userId) return true
    // A mailbox request carries the turn's nonce and the request's answer
    // token, which let a client answer it, and an opened tab carries a record's
    // name. They go to the requester's own connections and nobody else's,
    // whatever scopes they hold.
    if (REQUESTER_ONLY_ACTIONS.has(payload.action)) return false
    const data = payload.data as Record<string, unknown> | undefined
    const accumulated = data?.accumulatedScopes
    if (!Array.isArray(accumulated) || accumulated.some((s) => typeof s !== "string")) return false
    return isMessageVisible(
      { requiredScopes: accumulated as string[], disclosureList: null },
      { userId: client.userId, grants: client.scopes },
    )
  }
}

/** A client-reported activity time, in ms: finite, never in the future. */
function clampActivity(value: unknown, fallback = Date.now()): number {
  const now = Date.now()
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback
  return Math.min(value, now)
}

// Singleton accessor — follows the same pattern as getEmailProvider()
let _wsManager: WebSocketManager | null = null

/**
 * Install the process's manager and register the instance-liveness hooks
 * (A12) on the process's current instance registry: the leader's sweep cleans
 * a dead instance's sockets, and a recovered instance rewrites its own. Both
 * resolve the manager installed when they fire. Registration is by name, so
 * every install re-registers idempotently, and a registry replaced since the
 * last install (a test reset) gets them too.
 */
export function setWsManager(manager: WebSocketManager): void {
  _wsManager = manager
  onDeadInstance("ws-connections", async (deadId) => {
    await _wsManager?.cleanupDeadInstance(deadId)
  })
  onInstanceRecovered("ws-connections", async () => {
    await _wsManager?.republishOwnConnections()
  })
}

export function getWsManager(): WebSocketManager | null {
  return _wsManager
}

/**
 * A `kernel:dashboard_table` / `kernel:dashboard_table_row` frame (modules/dashboards/tables)
 * follows the table's SELECT policy: `audience.orgWide` reaches every reader, else only the people
 * in `audience.userIds`. Fail closed: a frame without an audience reaches no one.
 */
export function hasDashboardTableAudience(userId: string, data: unknown): boolean {
  const audience = (data as { audience?: { orgWide?: unknown; userIds?: unknown } } | undefined)
    ?.audience
  if (!audience || typeof audience !== "object") return false
  if (audience.orgWide === true) return true
  return Array.isArray(audience.userIds) && audience.userIds.includes(userId)
}
