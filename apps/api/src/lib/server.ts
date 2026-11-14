// SPDX-License-Identifier: FSL-1.1-ALv2
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join, normalize, resolve, sep } from "node:path"
import {
  DEMO_WORKSPACE_EXPIRED_CODE,
  DEMO_WORKSPACE_EXPIRED_WS_CLOSE,
  ORG_MOVING_CODE,
  ORG_MOVING_WS_CLOSE,
} from "@liaison/shared"
import type { Server, ServerWebSocket, WebSocketHandler } from "bun"
import { and, sql as drizzleSql, eq } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { threadParticipants, users } from "~/db/schema/kernel"
import { broadcastEphemeral } from "~/infra/events/event-bus"
import type { WebSocketManager } from "~/infra/websocket"
import { bounded } from "~/infra/websocket-state/redis"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { parseMailboxStatusFrame } from "~/lib/mailbox-status-frame"
import { rawRequestHostBinding } from "~/lib/org-host"
import { readiness, setDraining } from "~/lib/readiness"
import { redis } from "~/lib/redis"
import { effectiveRequestFromRaw } from "~/lib/request-context"
import { msSinceShutdownBegan, registerShutdownPhase, shutdownBudgets } from "~/lib/shutdown"
import { AFTER_DRAIN_DEADLINE_MS, SHUTDOWN_ORDER } from "~/lib/shutdown-budget"
import { webShellHeaders } from "~/middleware/security-headers"
import { holdOrgRuntime } from "~/modules/apps/app-registries"
import { isOrgEndedAsync, onOrgEnded } from "~/modules/apps/org-apps"
import { watchSession } from "~/modules/auth/session-revocation"
import { announceSetupToken } from "~/modules/auth/setup-token"
import { isWsAuthStillValid } from "~/modules/auth/ws-ticket"
import { ORG_SUSPENDED_CLOSE, orgRefusesNonSessionCredentials } from "~/modules/cloud/suspension"
import { isDemoOrgExpiredNow } from "~/modules/demo/demo-expiry"
import { OPT_OUT_PATH } from "~/modules/mail/opt-out-path"
import { maintenancePage } from "~/modules/maintenance/page"
import {
  orgTransferStateOf,
  orgTransferView,
  refusesSockets,
} from "~/modules/org/transfer-state/state"
import { hasScope } from "~/modules/permissions/permissions"

/**
 * Put the socket peer on the request, and take off anything that arrived
 * wearing its name.
 *
 * DELETE FIRST, ALWAYS. `x-bun-socket-ip` carries the one address a client
 * cannot choose, and everything that trusts it (the demo signup limiter)
 * trusts it for exactly that reason. An inbound copy is a client-supplied
 * string impersonating a server-supplied fact, so it goes before the real
 * value is written, on every request, whatever the proxy configuration says.
 *
 * SET UNCONDITIONALLY, not only at TRUSTED_PROXY_HOPS === 0. A deployment
 * behind a proxy still has a socket peer, and a limiter that must not be
 * forgeable needs it precisely there. `getClientIp` still prefers
 * X-Forwarded-For whenever hops > 0, so no existing caller changes behaviour:
 * this only makes the peer available to a caller that asks for it by name.
 */
export function attachSocketPeer(req: Request, socketIp: string | null | undefined): void {
  req.headers.delete("x-bun-socket-ip")
  if (socketIp) req.headers.set("x-bun-socket-ip", socketIp)
}

export interface WsData {
  userId: string
  orgId: string
  scopes: string[]
  dimensionGrants: Record<string, string[]>
  authorized: boolean
  userName?: string
  authVersion?: number
  permissionVersion?: number
  /** The sign-in session behind the ticket; the socket closes when it ends. */
  sid?: string
  /** Stops watching `sid`, set in `open`, called in `close`. */
  stopSessionWatch?: () => void
  /** Server-side heartbeat timer, set in `open`, cleared in `close`. */
  heartbeat?: ReturnType<typeof setInterval>
  /** The node interval this desktop connection opened (P4), closed in `close`. */
  nodeSession?: { orgId: string; nodeId: string; sessionId: string }
  /** When anything (a message, a pong) last came from the peer (walk D9). */
  lastHeardAt?: number
  /** When a ping last refreshed this connection's presence (throttled, S26). */
  presenceRefreshedAt?: number
  /** Ends the node socket's liveness watch (walk D9), set once a node binds. */
  stopNodeWatch?: () => void
  /** Ends the socket's hold on its org's runtime (the org runtime cap), set in `open`. */
  unholdOrgRuntime?: () => void
  /**
   * Settles once `open` is done: true when the socket was registered with the
   * manager, false when `open` refused it. A client sends its `hello` the
   * moment the socket opens, while `open` may still be awaiting; every frame
   * waits on this first, or the hello's thread membership is written before
   * the connection exists, lost, and the socket never receives a
   * conversation's events.
   */
  opened?: Promise<boolean>
}

// Server-initiated WS heartbeat. Cloudflare drops idle proxied WebSockets at
// ~100s, and the client's own 30s JSON ping stops firing in throttled
// background tabs — so the SERVER must keep the pipe non-idle. Protocol ping
// frames are auto-ponged by browsers (never surfaced to the client's message
// handler), feeding both the proxy's and Bun's idle timers. Must stay well
// under both the ~100s proxy cutoff and WS_IDLE_TIMEOUT_S below.
const WS_HEARTBEAT_INTERVAL_MS = 45_000
// Explicit Bun websocket idleTimeout (seconds; Bun defaults to 120). The
// heartbeat above guarantees traffic every 45s, so a healthy connection never
// trips this; a dead peer is reaped within ~2 minutes.
const WS_IDLE_TIMEOUT_S = 120
// RFC 6455 "Service Restart": every local socket closes with it at shutdown,
// and the client reconnects at once (apps/web/src/primitives/createWebSocket.ts).
const SERVICE_RESTART_CLOSE = 1012
// A ping refreshes presence at most this often per connection (TTL 60 s).
const PRESENCE_REFRESH_MIN_MS = 25_000

/**
 * The ceiling Bun enforces on ANY request body before a handler runs, set
 * explicitly rather than inherited from the runtime default (128 MiB in Bun 1.x,
 * which is what this value matches). It must stay above the largest legitimate
 * body: a file-relay upload up to the org file-size limit and a staged ticket
 * attachment. Every public route with a smaller need applies its own, tighter
 * cap (`/api/*` 1 MiB, `/webhooks/*` 10 MiB, the public OAuth routes 64 KiB).
 */
export const MAX_REQUEST_BODY_BYTES = 128 * 1024 * 1024

interface BaseServerOptions {
  port: number
  logPrefix?: string
}

/** The HTTP + WebSocket API (roles `all` and `api`). */
export interface ApiServerOptions extends BaseServerOptions {
  healthOnly?: false
  wsManager: WebSocketManager
  onUpgrade?: (req: Request, server: Server<WsData>) => Promise<WsData | null>
  /** Directory of built web assets to serve. Defaults to apps/api/public when present. */
  publicDir?: string
}

/**
 * A process that serves no API (role `worker`): it answers only `/healthz*`
 * and `/readyz` through the app, and 404s every other path, `/ws` included. No
 * static files, no setup-token announcement. Shutdown is the same.
 */
export interface HealthOnlyServerOptions extends BaseServerOptions {
  healthOnly: true
}

export type CreateServerOptions = ApiServerOptions | HealthOnlyServerOptions

/** The paths a health-only server answers. */
export function isHealthOnlyPath(path: string): boolean {
  return path === "/readyz" || path === "/healthz" || path.startsWith("/healthz/")
}

const API_PREFIXES = [
  "/api/",
  "/healthz",
  "/readyz",
  "/diag",
  "/ws",
  "/webhooks/",
  "/mcp",
  "/.well-known/",
  "/__chaos/",
  // A commercial mail's opt-out link: the API's own server-rendered page, never
  // the web app (which would send the recipient to the sign-in page).
  `${OPT_OUT_PATH}/`,
]

// Mirrors apps/api/src/middleware/maintenance.ts. Kept here so the Bun fetch
// handler can short-circuit before the static-SPA path that runs before Hono.
export function maintenanceFlagActive(): boolean {
  try {
    return existsSync(process.env.MAINTENANCE_FLAG_PATH || "/var/lib/liaison/maintenance")
  } catch {
    return false
  }
}
export function readMaintenanceTargetVersion(): string | undefined {
  try {
    const p = process.env.MAINTENANCE_VERSION_PATH || "/var/lib/liaison/maintenance-version"
    if (!existsSync(p)) return undefined
    return readFileSync(p, "utf8").trim() || undefined
  } catch {
    return undefined
  }
}
export function maintenanceHtml(target: string | undefined): string {
  return maintenancePage(target)
}

function isBackendPath(path: string): boolean {
  if (path === "/healthz" || path === "/readyz" || path === "/diag" || path === "/mcp") return true
  return API_PREFIXES.some((p) => path.startsWith(p))
}

/**
 * CACHE POLICY FOR THE BUNDLED WEB APP. A deploy must reach the browsers that
 * already have the app open, and it used to reach none of them: index.html
 * went out with no validator at all, so a browser could keep its heuristic
 * copy, and with it the previous build's asset names, for as long as it liked.
 *
 * - index.html (and every SPA route that falls back to it): `no-cache`, so it
 *   is revalidated on every load, with a strong ETag so the revalidation is a
 *   304 and costs no body when nothing was deployed.
 * - `/assets/*`: Vite names these by content hash, so a URL never changes
 *   meaning. Immutable for a year.
 * - `build-id.txt`: what an open tab fetches to notice a deploy. `no-store`,
 *   or a cached copy would hide exactly the deploy it is there to show.
 * - everything else (favicon, privacy page, app runtime files): one hour.
 *   These are not content-hashed, so a year would pin a stale copy, but they
 *   change rarely and nothing breaks when one is an hour old; an hour spares
 *   a revalidation on every page view.
 *
 * Only paths that resolved to a file in publicDir pass through here: the
 * caller sends every backend route to Hono first, so no API response is ever
 * given one of these headers.
 */
export const INDEX_CACHE_CONTROL = "no-cache"
export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable"
export const STATIC_CACHE_CONTROL = "public, max-age=3600"
/** The web build's id, written by apps/web's Vite build next to index.html. */
export const WEB_BUILD_ID_FILE = "build-id.txt"
/** The response header that tells the web app which build the server ships. */
export const WEB_BUILD_HEADER = "X-Liaison-Web-Build"

function cacheControlFor(relativePath: string): string {
  if (relativePath.startsWith("assets/")) return IMMUTABLE_CACHE_CONTROL
  if (relativePath === WEB_BUILD_ID_FILE) return "no-store"
  return STATIC_CACHE_CONTROL
}

interface IndexEntry {
  body: Uint8Array
  etag: string
}

const HTML_FILE_RE = /\.html?$/i

// index.html is read and hashed once per publicDir, at the first request the
// server answers with it: the image is immutable, so the hash cannot change
// under a running process.
const indexCache = new Map<string, IndexEntry>()

function loadIndex(publicDir: string): IndexEntry | undefined {
  const cached = indexCache.get(publicDir)
  if (cached) return cached
  const indexPath = join(publicDir, "index.html")
  if (!existsSync(indexPath)) return undefined
  let body: Uint8Array
  try {
    body = readFileSync(indexPath)
  } catch {
    return undefined
  }
  const etag = `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`
  const entry = { body, etag }
  indexCache.set(publicDir, entry)
  return entry
}

/** RFC 9110 weak comparison: `*`, or any listed tag equal once `W/` is dropped. */
function ifNoneMatchHits(header: string | null | undefined, etag: string): boolean {
  if (!header) return false
  const bare = etag.replace(/^W\//, "")
  return header.split(",").some((raw) => {
    const tag = raw.trim()
    return tag === "*" || tag.replace(/^W\//, "") === bare
  })
}

/**
 * The build id the bundled web app was built with, read once at startup.
 * Null when no web app is bundled (dev, API-only images) or the file is
 * missing, in which case no response is stamped and the web app never
 * prompts a reload.
 */
export function readWebBuildId(publicDir: string): string | null {
  try {
    const p = join(publicDir, WEB_BUILD_ID_FILE)
    if (!existsSync(p)) return null
    const id = readFileSync(p, "utf8").trim()
    return id === "" ? null : id
  } catch {
    return null
  }
}

/**
 * Stamps a backend response with the web build id. A response whose headers
 * are immutable (a proxied fetch result) is returned untouched: the header is
 * a hint the next response will carry anyway.
 */
export function withWebBuildHeader(res: Response, buildId: string | null): Response {
  if (!buildId) return res
  try {
    res.headers.set(WEB_BUILD_HEADER, buildId)
  } catch {
    // Immutable headers. Skip the hint.
  }
  return res
}

/**
 * Try to serve a static asset from publicDir. Returns the file response on hit,
 * undefined when the path doesn't exist (caller falls back to index.html for SPA
 * routing).
 *
 * The path is resolved against publicDir and normalized to keep traversal
 * attempts (../) from escaping the directory.
 */
/**
 * Whether a resolved path is the root or beneath it. A bare `startsWith(root)`
 * also accepts a SIBLING whose name merely begins with the root's (`public-x`
 * next to `public`).
 */
function isInsideRoot(target: string, root: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)
}

export async function serveStaticAsset(
  publicDir: string,
  pathname: string,
  requestHeaders?: Headers,
): Promise<Response | undefined> {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname.replace(/^\/+/, ""))
  } catch {
    // A malformed percent-escape (scanner noise such as `/%E0%A4%A`) names no
    // file. Letting the URIError escape the fetch handler answered 500 and
    // printed a bare, unstructured "URIError: URI error" line to the logs.
    return undefined
  }
  const target = normalize(join(publicDir, decoded))
  const root = resolve(publicDir)
  if (!isInsideRoot(resolve(target), root)) return undefined
  if (!existsSync(target)) return undefined
  // index.html by name gets the index policy, not the one-hour static one.
  if (resolve(target) === resolve(publicDir, "index.html")) {
    return serveSpaFallback(publicDir, requestHeaders)
  }
  const file = Bun.file(target)
  if (!(await file.exists())) return undefined
  const stat = await file.stat().catch(() => undefined)
  if (stat?.isDirectory()) return undefined
  const relativePath = resolve(target)
    .slice(root.length + 1)
    .split("\\")
    .join("/")
  const isHtml = HTML_FILE_RE.test(relativePath)
  return new Response(file, {
    headers: {
      "cache-control": cacheControlFor(relativePath),
      ...webShellHeaders({ html: isHtml ? await file.text() : null }),
    },
  })
}

export async function serveSpaFallback(
  publicDir: string,
  requestHeaders?: Headers,
): Promise<Response | undefined> {
  const index = loadIndex(publicDir)
  if (!index) return undefined
  const headers = {
    "cache-control": INDEX_CACHE_CONTROL,
    etag: index.etag,
    ...webShellHeaders({ html: index.body }),
  }
  if (ifNoneMatchHits(requestHeaders?.get("if-none-match"), index.etag)) {
    return new Response(null, { status: 304, headers })
  }
  return new Response(index.body, {
    headers: { ...headers, "content-type": "text/html; charset=utf-8" },
  })
}

async function triggerMailSyncOnConnect(data: WsData) {
  try {
    const inboxGrants = data.dimensionGrants?.["mail:inbox"] ?? []
    const grantList = inboxGrants.filter((grant: string) => /^[0-9a-f-]{36}$/i.test(grant))
    const canSyncAllOrgAccounts =
      inboxGrants.includes("*") && hasScope("mail:accounts:admin", data.scopes)

    const accounts = await withPrivilegedDb(data.orgId, "ws-mail-sync", async (tx) => {
      if (canSyncAllOrgAccounts) {
        return extractRows(
          await tx.execute(drizzleSql`
          SELECT id, provider, sync_status, last_sync_at
          FROM app_mail.accounts
          WHERE org_id = ${data.orgId}
            AND sync_status = 'active'
            AND ((owner_type = 'user' AND owner_id = ${data.userId}) OR owner_type = 'org')
        `),
        )
      }

      if (grantList.length > 0) {
        const grantValues = drizzleSql.join(
          grantList.map((grant) => drizzleSql`${grant}::uuid`),
          drizzleSql.raw(", "),
        )
        return extractRows(
          await tx.execute(drizzleSql`
          SELECT id, provider, sync_status, last_sync_at
          FROM app_mail.accounts
          WHERE org_id = ${data.orgId}
            AND sync_status = 'active'
            AND (
              (owner_type = 'user' AND owner_id = ${data.userId})
              OR (owner_type = 'org' AND id IN (${grantValues}))
            )
        `),
        )
      }

      return extractRows(
        await tx.execute(drizzleSql`
        SELECT id, provider, sync_status, last_sync_at
        FROM app_mail.accounts
        WHERE org_id = ${data.orgId}
          AND sync_status = 'active'
          AND owner_type = 'user'
          AND owner_id = ${data.userId}
      `),
      )
    })

    if (accounts.length > 0) {
      const { triggerMailSyncForUser } = await import("~/infra/mail-presence-sync")
      const { enqueueAppJob } = await import("~/infra/jobs/jobs")
      await triggerMailSyncForUser(data.orgId, data.userId, accounts as any, enqueueAppJob)
    }
  } catch {
    // Non-critical — do not block websocket open
  }
}

type FetchApp = { fetch: (req: Request) => Response | Promise<Response> }

/**
 * Has the socket's org been deleted or its deletion started? A state that cannot
 * be read keeps the socket (a transient database error must not close every
 * socket); the org-ended listener and the next frame try again.
 */
async function orgEndedForSocket(orgId: string): Promise<boolean> {
  try {
    return await isOrgEndedAsync(orgId)
  } catch (err) {
    rootLogger.warn({ err, orgId }, "WS org state check failed; keeping the socket")
    return false
  }
}

/** The org refuses sockets now (moving); unreadable refuses too (the client retries). */
async function orgMovingForSocket(orgId: string): Promise<boolean> {
  try {
    const record = await orgTransferStateOf(orgId)
    return record !== null && refusesSockets(record.state)
  } catch (err) {
    rootLogger.warn({ err, orgId }, "WS org move state unreadable; refusing the socket")
    return true
  }
}

export function createServer(app: FetchApp, options: ApiServerOptions): Promise<Server<WsData>>
export function createServer(
  app: FetchApp,
  options: HealthOnlyServerOptions,
): Promise<Server<undefined>>
export async function createServer(
  app: FetchApp,
  options: CreateServerOptions,
): Promise<Server<WsData> | Server<undefined>> {
  if (options.healthOnly) {
    const { port, logPrefix = "Health server" } = options
    const drain = createHttpDrain()
    const server = Bun.serve({
      fetch: (req) =>
        drain.track(() => {
          const path = new URL(req.url).pathname
          if (!isHealthOnlyPath(path)) return new Response("Not Found", { status: 404 })
          return app.fetch(req)
        }),
      port,
    })
    rootLogger.info({ port: server.port }, `${logPrefix} listening`)
    registerListenerShutdownPhases(server, drain)
    return server
  }
  return createApiServer(app, options)
}

async function createApiServer(app: FetchApp, options: ApiServerOptions) {
  const { wsManager, port, onUpgrade, logPrefix = "Server" } = options
  // An org whose deletion starts: close its sockets in this process (every
  // process learns it from the org-apps invalidation, or its TTL reload).
  onOrgEnded((orgId) => {
    wsManager.closeConnectionsForOrg(orgId)
  })
  // An org moving to another instance (modules/org/transfer-state/): once it
  // is frozen, incoming or moved its sockets close with ORG_MOVING_WS_CLOSE
  // and the client reconnects every few seconds (to wherever the org is then
  // served). Every process applies it from its own view of the moving orgs.
  orgTransferView.onChange((orgId, record) => {
    if (record && refusesSockets(record.state)) {
      wsManager.closeConnectionsForOrg(orgId, ORG_MOVING_WS_CLOSE, ORG_MOVING_CODE)
    }
  })
  const publicDir =
    options.publicDir ??
    (process.env.LIAISON_PUBLIC_DIR || resolve(new URL("../../public", import.meta.url).pathname))
  const publicDirAvailable = existsSync(publicDir)
  // Read once: the image is immutable, so the bundled web build cannot change
  // under a running process.
  const webBuildId = publicDirAvailable ? readWebBuildId(publicDir) : null

  async function handle(req: Request, server: Server<WsData>): Promise<Response | undefined> {
    const url = new URL(req.url)

    // An app frame host (lib/app-frame-host.ts) opens no socket and serves no web
    // app: its one document comes from the app's frame-host gate (app.ts).
    const frameHost =
      rawRequestHostBinding(req, server.requestIP(req)?.address ?? null).kind === "app-frame"

    // WebSocket upgrade
    if (url.pathname === "/ws" && frameHost) {
      return new Response("Not found", { status: 404 })
    }
    if (url.pathname === "/ws") {
      // Rate limit WS upgrades: max 30 per minute per IP.
      // Test runs intentionally create many short-lived browser sessions and reconnects.
      // The k6 load profile (A2) also opens thousands of short-lived sockets
      // from a single bridge IP and must not be capped at 30/min — gate the
      // limiter on the same env var that exposes /api/__loadtest/* so the
      // production image stays protected.
      if (env.NODE_ENV !== "test" && !env.ENABLE_LOAD_TEST_ENDPOINT) {
        const socketAddr = server.requestIP?.(req)?.address ?? null
        const ip = effectiveRequestFromRaw(req, socketAddr).clientIp
        const wsRateKey = `ws:rate:${ip}`
        // Bounded: when Redis does not answer, the limiter fails open (the
        // ticket check that follows needs Redis anyway) and says so.
        const count = await bounded(redis.incr(wsRateKey), 1_000, "ws:rate").catch((err) => {
          rootLogger.warn({ err, ip }, "WS upgrade rate limit unavailable; allowing the upgrade")
          return 0
        })
        if (count === 1) {
          await bounded(redis.expire(wsRateKey, 60), 1_000, "ws:rate expire").catch((err) =>
            rootLogger.warn({ err, ip }, "WS upgrade rate-limit expiry not set"),
          )
        }
        if (count > 30) {
          return new Response("Too Many Requests", { status: 429 })
        }
      }

      const emptyWsData: WsData = {
        userId: "",
        orgId: "",
        scopes: [],
        dimensionGrants: {},
        authorized: false,
      }
      let payload: WsData | null = null

      if (onUpgrade) {
        payload = await onUpgrade(req, server)
      } else {
        payload = emptyWsData
      }

      const upgraded = server.upgrade(req, {
        data: payload || emptyWsData,
      })
      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 400 })
      }
      return undefined
    }

    // Attach the socket peer so Hono middleware can use it (the Bun server
    // object is not available inside Hono). See attachSocketPeer.
    attachSocketPeer(req, server.requestIP(req)?.address)

    // Maintenance gate runs BEFORE static SPA serving so /, /settings, and
    // every other SPA route returns the 503 maintenance page during an
    // upgrade — not the stale bundled web app. /healthz and /diag stay reachable
    // (the monitoring watchdog must still get diagnostics during an upgrade — C3).
    if (
      url.pathname !== "/healthz" &&
      url.pathname !== "/readyz" &&
      url.pathname !== "/diag" &&
      maintenanceFlagActive()
    ) {
      const target = readMaintenanceTargetVersion()
      return new Response(maintenanceHtml(target), {
        status: 503,
        headers: { "content-type": "text/html; charset=utf-8", "Retry-After": "30" },
      })
    }

    // Static SPA serving — only when a public dir has been bundled in
    // (production image) and the path is NOT a backend route. HEAD answers as
    // GET does (RFC 9110 9.3.2; Bun.serve drops the body of a HEAD answer and
    // keeps its Content-Length). Uptime monitors probe `/` with HEAD, and it
    // used to fall through to the API router's 404. A host that names no org
    // (lib/org-host.ts: the cell's own names, a tunnel host, an IP) serves no
    // web app: those requests go to the app, whose non-org host gate answers
    // 404 for everything outside its short allowlist.
    if (
      publicDirAvailable &&
      (req.method === "GET" || req.method === "HEAD") &&
      !isBackendPath(url.pathname) &&
      !frameHost &&
      rawRequestHostBinding(req, server.requestIP(req)?.address ?? null).kind !== "non-org"
    ) {
      const asset = await serveStaticAsset(publicDir, url.pathname, req.headers)
      if (asset) return asset
      const fallback = await serveSpaFallback(publicDir, req.headers)
      if (fallback) return fallback
    }

    return withWebBuildHeader(await app.fetch(req), webBuildId)
  }

  /**
   * Opens an authorized socket: refuses it (closing it, false) or registers it
   * with the manager, then marks the user online. `onRegistered` runs as soon
   * as the manager holds the connection.
   */
  async function openSocket(
    ws: ServerWebSocket<WsData>,
    onRegistered: () => void,
  ): Promise<boolean> {
    const data = ws.data
    if (!data.authorized) {
      ws.close(4001, "Unauthorized")
      return false
    }
    // A moving org opens no socket: the client retries every few seconds.
    if (await orgMovingForSocket(data.orgId)) {
      data.authorized = false
      ws.close(ORG_MOVING_WS_CLOSE, ORG_MOVING_CODE)
      return false
    }
    // A ticket minted just before the org's deletion started opens nothing.
    if (await orgEndedForSocket(data.orgId)) {
      data.authorized = false
      ws.close(4010, "session_invalidated")
      return false
    }
    // The session behind the ticket ended (here or on another process):
    // close at once, as a revalidation failure does.
    if (data.sid) {
      let closed = false
      data.stopSessionWatch = watchSession(data.sid, () => {
        closed = true
        try {
          ws.close(4010, "session_invalidated")
        } catch {
          // Already closing.
        }
      })
      if (closed) {
        // Never added: the close handler must not touch presence for it.
        data.authorized = false
        return false
      }
    }
    data.lastHeardAt = Date.now()
    // An open socket keeps its org set up in this process (the runtime cap).
    data.unholdOrgRuntime = holdOrgRuntime(data.orgId)
    // Server-side heartbeat (see WS_HEARTBEAT_INTERVAL_MS above).
    data.heartbeat = setInterval(() => {
      try {
        ws.ping()
      } catch {
        // Socket already torn down — close() clears the interval.
      }
    }, WS_HEARTBEAT_INTERVAL_MS)
    // Fetch current event sequence so handleHello can bound replay
    // requests (bounded; 0, no cursor, when Redis does not answer).
    const currentSeq = await wsManager.currentEventSeq(data.orgId)
    // `wasOnline`: the user already had a live socket in the org, on this
    // replica or another. Only the first socket is an arrival (S5).
    const { wasOnline } = await wsManager.addConnection(
      data.userId,
      ws as any,
      data.scopes,
      data.orgId,
      data.dimensionGrants,
      currentSeq,
    )
    // Registered: frames (the hello first) may be served from here on.
    onRegistered()
    // Presence writes and the broadcast are bounded and never reject (P2-3).
    if (!wasOnline) await wsManager.setPresence(data.orgId, data.userId, "online")
    await triggerMailSyncOnConnect(data)
    if (!wasOnline) await wsManager.announcePresence(data.orgId, data.userId, "online")
    return true
  }

  const websocketHandlers: WebSocketHandler<WsData> = {
    idleTimeout: WS_IDLE_TIMEOUT_S,
    async open(ws) {
      const data = ws.data
      // Frames wait on this (see `WsData.opened`); every way out settles it.
      let settleOpen: (registered: boolean) => void = () => {}
      data.opened = new Promise<boolean>((resolve) => {
        settleOpen = resolve
      })
      try {
        settleOpen(await openSocket(ws, () => settleOpen(true)))
      } catch (err) {
        settleOpen(false)
        throw err
      }
    },
    pong(ws) {
      ws.data.lastHeardAt = Date.now()
    },
    async message(ws, message) {
      ws.data.lastHeardAt = Date.now()
      if (!ws.data.authorized) return
      // A frame sent while `open` still awaits is served once the socket is
      // registered (or dropped when `open` refused it).
      if (ws.data.opened && !(await ws.data.opened)) return
      if (!ws.data.authorized) return

      if (!wsManager.checkMessageRate(ws as any)) {
        ws.close(4029, "rate_limited")
        return
      }

      const raw = String(message)
      if (raw.length > 16_384) {
        ws.close(4008, "message_too_large")
        return
      }
      // The org's deletion started (or finished) while this socket was open:
      // serve no frame (no presence or typing write after the purge), close.
      if (await orgEndedForSocket(ws.data.orgId)) {
        ws.close(4010, "session_invalidated")
        return
      }

      try {
        const data = JSON.parse(raw)
        const conn = ws.data

        if (data.type === "hello") {
          if (!wsManager.checkHelloCooldown(ws as any)) return

          // Populate thread membership BEFORE replay
          const { memberRows, userName } = await withPrivilegedDb(
            conn.orgId,
            "ws-hello-membership",
            async (tx) => {
              const members = await tx
                .select({ threadId: threadParticipants.threadId })
                .from(threadParticipants)
                .where(
                  and(
                    eq(threadParticipants.userId, conn.userId),
                    eq(threadParticipants.orgId, conn.orgId),
                  ),
                )
              const [userRow] = await tx
                .select({ name: users.name })
                .from(users)
                .where(eq(users.id, conn.userId))
              return { memberRows: members, userName: userRow?.name }
            },
          )
          wsManager.setThreadMembership(ws as any, new Set(memberRows.map((r) => r.threadId)))
          // S53 (D29): a client reading sessions' main threads only.
          wsManager.setNodeSessionScope(ws as any, data.nodeSessionEvents)

          // Set userName for typing events
          if (userName) ws.data.userName = userName

          const lastEventId =
            typeof data.lastEventId === "number" && Number.isFinite(data.lastEventId)
              ? Math.max(0, data.lastEventId)
              : 0
          await wsManager.handleHello(
            ws as any,
            conn.userId,
            lastEventId,
            conn.scopes,
            conn.orgId,
            conn.dimensionGrants,
          )

          // S6: the client kind decides whether this connection can be a
          // desktop `notify` target; registered in the shared presence
          // registry (TTL 60 s, refreshed by the `presence` heartbeat).
          const notifyEntry = await wsManager.registerNotifyClient(
            ws as any,
            data.clientKind,
            data.lastActiveAt,
            {
              deviceId: data.deviceId,
              notificationPermission: data.notificationPermission,
              viewing: data.viewing,
            },
          )
          // P4 (A25, F11, F12, A23): a desktop connection whose hello
          // presents a node credential for the deviceId it announced is that
          // node: its interval opens and it becomes the node's live presence.
          if (notifyEntry?.kind === "desktop_app" && notifyEntry.deviceId && !ws.data.nodeSession) {
            try {
              const { onNodeConnectionHello } = await import("~/modules/nodes/hooks")
              const opened = await onNodeConnectionHello({
                orgId: conn.orgId,
                userId: conn.userId,
                deviceId: notifyEntry.deviceId,
                connId: notifyEntry.connId,
                nodeCredential:
                  typeof data.nodeCredential === "string" ? data.nodeCredential : undefined,
                bindConnection: (nodeId) => wsManager.markNodeConnection(ws as any, nodeId),
              })
              if (opened) {
                ws.data.nodeSession = { orgId: conn.orgId, ...opened }
                // Walk D9: a node that vanished without a close is cut
                // within seconds, and its close pauses its sessions.
                if (!ws.data.stopNodeWatch) {
                  const { watchNodeLink } = await import("~/modules/nodes/link-liveness")
                  ws.data.stopNodeWatch = watchNodeLink(ws, () => ws.data.lastHeardAt ?? Date.now())
                }
              }
            } catch (err) {
              rootLogger.warn({ err, userId: conn.userId }, "node session open failed")
            }
          }
          // A5: a desktop app that (re)connects with permission catches up
          // on the computer items of the last 15 minutes nobody receipted.
          if (notifyEntry?.kind === "desktop_app") {
            const { replayMissedDesktopNotifications } = await import(
              "~/modules/notifications/desktop-emitter"
            )
            await replayMissedDesktopNotifications(wsManager, notifyEntry, conn.orgId, conn.userId)
          }

          // Send presence_sync
          const presenceMap = await wsManager.getPresenceMap(conn.orgId)
          ws.send(JSON.stringify({ type: "presence_sync", users: presenceMap }))
        } else if (data.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }))
          // The client pings every 5 s to notice a dead socket (S26); the
          // presence TTL needs a refresh far less often, so a ping stays a
          // pong and nothing else most of the time.
          const now = Date.now()
          if (now - (ws.data.presenceRefreshedAt ?? 0) >= PRESENCE_REFRESH_MIN_MS) {
            ws.data.presenceRefreshedAt = now
            await wsManager.refreshPresence(conn.orgId, conn.userId)
          }
          // Periodic auth revalidation: close sockets after auth or permission changes
          if (wsManager.shouldRevalidateAuth(conn.userId)) {
            try {
              const isValid = await isWsAuthStillValid({
                userId: conn.userId,
                orgId: conn.orgId,
                authVersion: conn.authVersion,
                permissionVersion: conn.permissionVersion,
              })
              if (!isValid) {
                // An expired demo workspace says so, so the client leaves it
                // for the demo door instead of refreshing a dead session.
                if (await isDemoOrgExpiredNow(conn.orgId)) {
                  ws.close(DEMO_WORKSPACE_EXPIRED_WS_CLOSE, DEMO_WORKSPACE_EXPIRED_CODE)
                } else if (await orgRefusesNonSessionCredentials(conn.orgId)) {
                  // A managed org suspended or closed for billing: the client
                  // shows the suspended page instead of refreshing.
                  ws.close(ORG_SUSPENDED_CLOSE.code, ORG_SUSPENDED_CLOSE.reason)
                } else {
                  ws.close(4010, "session_invalidated")
                }
                return
              }
            } catch (err) {
              // Don't close connection on transient DB errors — will retry on next ping
              rootLogger.warn({ err, userId: conn.userId }, "WS auth revalidation check failed")
            }
          }
        } else if (data.type === "presence") {
          // Client heartbeat, every 30 s: keeps this connection's notify
          // presence alive and carries when the user last touched it.
          await wsManager.touchNotifyPresence(ws as any, data.lastActiveAt, {
            notificationPermission: data.notificationPermission,
            viewing: data.viewing,
          })
          if (conn.nodeSession) {
            const { touchNode } = await import("~/modules/nodes/presence")
            await touchNode(conn.nodeSession.orgId, conn.nodeSession.nodeId).catch(() => {})
          }
        } else if (data.type === "typing") {
          const threadId = data.threadId
          if (!threadId) return
          if (!hasScope("kernel:threads:write", conn.scopes)) return
          const memberThreads = wsManager.getThreadMembershipForUser(conn.userId)
          if (!memberThreads?.has(threadId)) return

          // Throttle: only broadcast if no typing event sent in last 4s for this user+thread
          if (!wsManager.checkTypingThrottle(conn.userId, threadId)) return

          // Typing is activity in that thread: a push for it is held back
          // while the user is there (notifications/thread-activity.ts).
          const { recordThreadInteraction } = await import(
            "~/modules/notifications/thread-activity"
          )
          await recordThreadInteraction(conn.orgId, conn.userId, threadId)

          // Bounded: a typing hint is dropped, never awaited forever (P2-3).
          await bounded(
            broadcastEphemeral({
              app: "kernel",
              entity: "typing",
              action: "start",
              orgId: conn.orgId,
              actorId: conn.userId,
              data: { threadId, userId: conn.userId, userName: conn.userName ?? "Unknown" },
            }),
            1_000,
            "typing broadcast",
          ).catch((err) => rootLogger.warn({ err, threadId }, "Typing broadcast dropped"))
        } else if (data.type === "status" && data.scope === "mailbox") {
          // Mailbox unlock assertion (blueprint Task 9.4). A malformed frame
          // is ignored, never fatal: the client is asserting something the
          // server cannot verify, so the only sane failure mode is "no
          // assertion", which reads as locked.
          const entry = parseMailboxStatusFrame(data)
          if (entry) await wsManager.setSocketMailboxUnlock(ws, entry)
        } else if (data.type === "status") {
          const status = data.status
          if (status !== "online" && status !== "away") return
          const prevStatus = await wsManager.getPresence(conn.orgId, conn.userId)
          await wsManager.setPresence(conn.orgId, conn.userId, status)
          if (prevStatus !== status) {
            await wsManager.announcePresence(conn.orgId, conn.userId, status)
          }
        }
      } catch (err) {
        rootLogger.warn({ err }, "Invalid WS message")
      }
    },
    async close(ws, code) {
      const data = ws.data
      // 1012: this process is restarting (lib/shutdown.ts); the client is
      // already reconnecting to another one.
      const restarting = code === SERVICE_RESTART_CLOSE
      if (data.heartbeat) {
        clearInterval(data.heartbeat)
        data.heartbeat = undefined
      }
      data.stopNodeWatch?.()
      data.stopNodeWatch = undefined
      data.stopSessionWatch?.()
      data.stopSessionWatch = undefined
      data.unholdOrgRuntime?.()
      data.unholdOrgRuntime = undefined
      // Decided atomically with the removal, across the cell; without an
      // answer from Redis, from this replica's own sockets (P2-3).
      const { userStillOnline } = await wsManager.removeConnection(ws as any)
      if (data.nodeSession) {
        const session = data.nodeSession
        data.nodeSession = undefined
        const { closeNodeSession } = await import("~/modules/nodes/presence")
        await closeNodeSession(session.orgId, session.sessionId).catch((err: unknown) =>
          rootLogger.warn({ err }, "node session close failed"),
        )
        // P3 (D36): the node's last connection gone, its sessions are paused,
        // unless it is back within the grace (a page reload, walk D10).
        const { onNodeConnectionClosed, nodeCloseGraceMs } = await import(
          "~/modules/node-sessions/lifecycle"
        )
        void onNodeConnectionClosed({
          ...session,
          userId: data.userId,
          graceMs: nodeCloseGraceMs(code),
        })
      }
      // Closing one of a user's tabs is no departure while another stays open,
      // nor is a restart: the user is back on another process within a
      // second, and the leader sweep covers one who never returns.
      // A deleted org's user writes no presence (the purge removed it).
      if (
        data.authorized &&
        !userStillOnline &&
        !restarting &&
        !(await orgEndedForSocket(data.orgId))
      ) {
        await wsManager.setPresence(data.orgId, data.userId, "offline")
        await wsManager.announcePresence(data.orgId, data.userId, "offline")
      }
    },
  }

  const drain = createHttpDrain()
  const server = Bun.serve<WsData>({
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    fetch: (req, server) =>
      new URL(req.url).pathname === "/ws"
        ? handle(req, server)
        : drain.track(() => handle(req, server)),
    websocket: websocketHandlers,
    port,
    // Prevent Bun's default 10-second idle timeout from killing long-running
    // SSE streams (agent chat). 255 seconds is the maximum Bun accepts; the
    // SSE layer emits keep-alive comments every ~15 s to keep the transport
    // alive within this window.
    idleTimeout: 255,
  })

  rootLogger.info({ port: server.port }, `${logPrefix} listening`)
  await announceSetupToken()

  registerListenerShutdownPhases(server, drain, {
    onListenerStopped: () => wsManager.closeAllLocal(SERVICE_RESTART_CLOSE, "restart"),
  })

  return server
}

/**
 * Counts the HTTP requests whose handler has not returned yet. A stream (SSE)
 * counts until its Response is returned, then has its own phase; a WebSocket
 * upgrade is never counted (its sockets close at the edge phase). While the
 * process drains, every response says `Connection: close`, so the edge does
 * not reuse a keep-alive connection into the stopped listener.
 */
export function createHttpDrain() {
  let inFlight = 0
  const idleWaiters = new Set<() => void>()
  const settle = () => {
    if (inFlight > 0) return
    for (const wake of idleWaiters) wake()
    idleWaiters.clear()
  }
  return {
    inFlight: () => inFlight,
    async track<R extends Response | undefined>(run: () => R | Promise<R>): Promise<R> {
      inFlight++
      try {
        const res = await run()
        if (res && readiness().status === "draining") return withConnectionClose(res) as R
        return res
      } finally {
        inFlight--
        settle()
      }
    },
    /** Resolves when no request is in flight, or after `ms`. */
    waitIdle(ms: number): Promise<void> {
      if (inFlight === 0) return Promise.resolve()
      return new Promise((resolve) => {
        const timer = setTimeout(done, Math.max(0, ms))
        function done() {
          clearTimeout(timer)
          idleWaiters.delete(done)
          resolve()
        }
        idleWaiters.add(done)
      })
    },
  }
}

export type HttpDrain = ReturnType<typeof createHttpDrain>

function withConnectionClose(res: Response): Response {
  try {
    res.headers.set("connection", "close")
    return res
  } catch {
    // Immutable headers (a proxied fetch response): copy them.
    const headers = new Headers(res.headers)
    headers.set("connection", "close")
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  }
}

/**
 * The listener's shutdown phases (lib/shutdown.ts), the same for an API and a
 * health-only server:
 *   t0      /readyz answers 503 (the edge stops routing here);
 *   edge    the listener stops: no new connection, in-flight ones continue;
 *   drain   wait until no request is in flight, up to SHUTDOWN_HTTP_DRAIN_MS
 *           from t0;
 *   close   after every drain (turn streams included), cut what is left.
 */
function registerListenerShutdownPhases(
  server: { port?: number; stop(closeActiveConnections?: boolean): Promise<void> },
  drain: HttpDrain,
  opts: { onListenerStopped?: () => void } = {},
): void {
  registerShutdownPhase({
    name: "readiness",
    at: "t0",
    run: () => setDraining(true),
  })
  registerShutdownPhase({
    name: `listener:${server.port}`,
    at: "edge",
    run: () => {
      void server.stop(false)
      // After the stop, so a client reconnecting at once dials a closed port
      // and the edge retries it on a ready process.
      opts.onListenerStopped?.()
    },
  })
  const { httpDrainMs } = shutdownBudgets()
  registerShutdownPhase({
    name: `http-drain:${server.port}`,
    at: "after-drain",
    order: SHUTDOWN_ORDER.drain,
    deadlineMs: httpDrainMs + 1_000,
    run: async () => {
      await drain.waitIdle(shutdownBudgets().httpDrainMs - msSinceShutdownBegan())
      if (drain.inFlight() > 0) {
        rootLogger.warn(
          { inFlight: drain.inFlight() },
          "HTTP drain budget spent with requests in flight",
        )
      }
    },
  })
  registerShutdownPhase({
    name: `listener-close:${server.port}`,
    at: "after-drain",
    order: SHUTDOWN_ORDER.listenerClose,
    deadlineMs: AFTER_DRAIN_DEADLINE_MS.listenerClose,
    run: () => {
      void server.stop(true)
    },
  })
}
