# Backend Overview

## Runtime & Framework

The API runs on **Bun** with **Hono** as the HTTP framework. The server starts in `src/index.ts`, which initializes the event bus, WebSocket manager, scheduled jobs, and RLS role verification (production only), then calls `Bun.serve()` with the assembled Hono app and a WebSocket upgrade handler.

The Hono app is assembled in `src/app.ts` with this middleware order:

1. **Pino logger** — structured JSON in production, pretty-print in dev. Sensitive fields (`password`, `totpSecret`, `refreshToken`, `authorization`) are redacted automatically.
2. **Security headers** — CSP, X-Frame-Options, etc.
3. **CORS** — configured via `ALLOWED_ORIGINS` env var.
4. **Rate limiter** — 60-second sliding window on all `/api/*` routes, per-IP or per-user. Default 300 req/min, overridable per-org via org settings (synced to Redis immediately).
5. **Auth + scope middleware** — applied selectively per route group (see Security below).
6. **Route handlers** — one Hono instance per resource, mounted via `app.route()`.
7. **Global error handler** — catches `HTTPException` and unexpected errors, returns the standard envelope.

`app.ts` is separate from `index.ts` — app assembly is sync and testable without starting the server.

---

## Database

**PostgreSQL** with **Drizzle ORM** and the **postgres.js** driver.

All kernel tables live in a `kernel` schema (prefixable via `SCHEMA_PREFIX` for multi-tenant isolation). Future apps use `app_<name>` schemas.

### Core Tables & Relationships

```
organizations ─┬─< users ──────────┬─< sessions
               │                    ├─< userRoles >─ roles ─< roleScopeGrants
               │                    │                       ─< roleDimensionGrants
               │                    ├─< userScopeGrants
               │                    ├─< userDimensionGrants
               │                    ├─< passwordResets
               │                    └─< oauthAccounts >─ oauthProviders
               │
               ├─< threads ────────┬─< threadParticipants >─ users
               │                    ├─< messages ──< messageReactions >─ users
               │                    ├─< threadReferences
               │                    └─< userThreadState (composite PK: userId+threadId)
               │
               ├─< contacts
               ├─< invitations
               ├─< apps
               ├─< connectedAccounts ──< users (createdBy)
               ├─< auditLog
               ├─< timelineEntries
               ├─< pendingEvents (transactional outbox)
               └─< deviceFlowRequests
```

**Key design choices:**

- **`users.authVersion`** — integer counter. Bumped on password change, deactivation, or credential rotation. The auth middleware checks it on every request; a mismatch rejects the token, giving instant session invalidation without scanning the sessions table.
- **`users.permissionVersion`** — integer counter. Bumped on permission changes (role/scope/dimension grant modifications). Auth middleware checks this alongside `authVersion`; a mismatch forces token refresh so the client gets updated permissions.
- **`threads.tainted`** — boolean flag for Phase 4, marks threads originating from untrusted sources (agent/webhook).
- **`threads.createdFrom`** — JSONB `{app, entityType, entityId}` linking a thread to its origin entity.
- **`messages.deletedAt`** — soft deletes. Content is preserved for audit but hidden from normal queries.
- **`messages.mentions`** — JSONB array of parsed `@[label](type:id)` references, extracted at write time.
- **`messages.authorType`** — enum: `"user" | "agent" | "system"`.
- **`organizations.settings`** — JSONB bag for tunables: `fileSizeLimitMb`, `importFileSizeLimitMb` (import uploads, default 5120), `auditRetentionDays`, `rateLimitPerMinute`. The storage quota is not a setting: it is an operator cap, below.
- **`organizations.caps`** — the operator's per-org caps `{seats?, mailboxes?, storageGb?, jobsPerHour?}` (`modules/org/caps.ts`), set only with `liaison org caps` or the `limits` section of `liaison config apply`; a missing key is unlimited, the self-hosted default. Seats and mailboxes are counted and added under an org advisory lock (`SEAT_LIMIT_REACHED` / `MAILBOX_LIMIT_REACHED`, 409); storage is enforced by `files/service.ts`; jobs over `jobsPerHour` are delayed to the next hour bucket with room (`infra/jobs/org-job-cap.ts`). The per-UTC-day app caps (`appRunsPerDay`, `appBridgeCallsPerDay`, `appCpuMsPerDay`) are enforced from Redis day counters fed by the run-settled hook (`modules/apps/usage/`), per entry point: tools refused (429), background work held to the next UTC day; `kernel.app_usage_daily` is for reporting.
- **`connectedAccounts`** — kernel-level OAuth2 and credential storage for app connections. Tokens encrypted at rest (AES-256-GCM via `ENCRYPTION_KEY`). Unique constraint on `(orgId, appName, connectionName, identifier)` for active accounts. Supports `oauth2` and `credentials` provider types.

### Row-Level Security (RLS)

Every data-access path wraps queries in an RLS context via `withRequestRls(honoCtx, fn)` or `withRlsContext(actorCtx, fn)`. This:

1. Opens a transaction.
2. Sets `app.current_user_id`, `app.current_org_id`, `app.current_scopes`, `app.current_dimensions`, `app.current_roles` as session-local variables, each with a tag that binds it to the server, and calls `rls_ctx.enter()`, which verifies them once for the transaction. The policies read them through `rls_ctx.org_id()`, `user_id()`, `scopes()`, `dimensions()` and `roles()`, which on the request login return only the verified values, so SQL inside the transaction cannot change its own org, user, scopes, grants or roles.
3. Switches the Postgres role to `liaison_rls` (created with `NOBYPASSRLS` in production).
4. Executes the callback.

Database policies enforce: users only see their own org's data, thread queries filter by participant membership, messages filter by thread participation. **RLS is the enforcement layer** — even if application code has a bug, the database won't return unauthorized rows.

On startup in production, the server verifies the `liaison_rls` role exists and has `NOBYPASSRLS`.

### Privileged Access

For infrastructure operations (event subscribers, scheduled jobs, outbox processing), the backend uses `withPrivilegedDb(orgId, reason, fn)` or `withSystemDb(reason, fn)`. These switch to the `liaison_admin` role (created with `BYPASSRLS`), which can read/write all data. Every privileged call requires a `reason` string for audit tracing.

**Known limit (request login).** The login in `DATABASE_URL` is a member of `liaison_rls`, `liaison_admin` and `liaison_schema_admin`, and the request pool and the privileged pools share it. That is deliberate: an RLS transaction elevates to `liaison_admin` inside itself for the transactional outbox insert (`queueEvent`, on every RLS transaction) and a few kernel bookkeeping writes, and those writes must stay atomic with the caller's transaction. So row isolation does not survive arbitrary SQL running in a request transaction (the `app.current_*` settings are also plain session settings). The containment is that no SQL under user influence runs there: sandbox bridge identifiers are validated and quoted, the database connector runs on its own connections (never this login), and `db/role-elevation-sites.test.ts` pins the files allowed to elevate, so a new elevation site needs a review. Splitting the logins is planned in this order: (1) give `liaison_rls` an INSERT policy on the outbox (`org_id` equal to the transaction's org) so `queueEvent` no longer elevates; (2) rewrite the other in-transaction elevations (base agent creation, sharing bookkeeping, ticket segment codes) as RLS-permitted writes or SECURITY DEFINER functions with pinned `search_path`; (3) move the outbox worker and the `__privileged_db__` importers onto the privileged pool; (4) give the request pool a LOGIN role that is a member of `liaison_rls` only, with the privileged and jobs pools on a separate DSN, falling back to `DATABASE_URL` with a startup warning when that DSN is unset.

### Actor Context

All RLS operations use a discriminated `ActorContext` union:

```typescript
type UserContext = {
  actorType: "user"
  userId: string
  orgId: string
  scopes: string[]
  dimensionGrants: Record<string, string[]>
}

type SystemContext = {
  actorType: "system"
  orgId: string
  purpose: "audit" | "timeline" | "webhook" | "job"
}

type ActorContext = UserContext | SystemContext
```

Services accept `RlsClient` (branded type produced only by `withRlsContext`), never raw `db`, enforcing RLS at the type level. Nested transactions also carry `queueEvent` via recursive wiring.

### Transactional Outbox

Events are never published directly. Instead, service code calls `tx.queueEvent(event)` inside a transaction, which inserts into the `pending_events` table. If the transaction rolls back, the event is discarded — no orphaned events.

The **outbox worker** (`infra/events/outbox-worker.ts`) polls every 1s:
1. Claims up to 100 unclaimed events via `FOR UPDATE SKIP LOCKED`
2. Publishes each to Redis + dispatches to in-process handlers
3. Marks events as processed

Crash recovery: stale claims (>30s) are re-claimed on the next tick. Max 10 retry attempts per event; after that, events are dead-lettered (`failed_at`). Processed events older than 1h are cleaned up every 60 ticks.

---

## API Surface

All responses use the envelope `{ data: T, meta?: {...} }` for success and `{ error: { message, code? } }` for errors.

### Public (no auth)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Status check |
| POST | `/api/auth/register` | Bootstrap (first user) or invite-based |
| POST | `/api/auth/login` | Password auth, returns tokens or TOTP challenge |
| POST | `/api/auth/refresh` | Rotate token pair |
| POST | `/api/auth/logout` | Invalidate session |
| POST | `/api/auth/totp/verify` | Complete TOTP challenge (challenge-token gated) |
| POST | `/api/auth/password-reset/request` | Request reset (email-enumeration safe) |
| POST | `/api/auth/password-reset/confirm` | Consume token, set new password |
| GET | `/api/auth/oauth/providers` | List configured OAuth providers |
| GET | `/api/auth/oauth/:providerId/authorize` | Redirect to OIDC provider |
| GET | `/api/auth/oauth/callback` | OIDC token exchange |
| POST | `/api/auth/device-flow/initiate` | RFC 8628 device code grant |
| GET | `/api/auth/device-flow/poll/:deviceCode` | Client polls for approval |
| GET | `/api/connections/callback` | OAuth callback (state-verified) |
| POST | `/webhooks/:orgId/:appName/:endpointName` | Inbound webhooks (signature-verified) |

### Protected (JWT required)

| Method | Path | Scope | Purpose |
|--------|------|-------|---------|
| GET | `/api/users/me` | kernel | Current user profile |
| PATCH | `/api/users/me` | kernel | Update profile |
| GET | `/api/org` | kernel | Org details |
| PATCH | `/api/org` | kernel:org:admin | Update org settings |
| POST | `/api/threads` | kernel:threads:write | Create thread |
| GET | `/api/threads` | kernel:threads:read | List threads (cursor-paginated) |
| GET/PATCH | `/api/threads/:id` | kernel:threads:read/write | Thread detail / update |
| POST | `/api/threads/:id/messages` | kernel:threads:write | Send message |
| PATCH/DELETE | `.../messages/:id` | kernel:threads:write | Edit/delete message |
| POST/DELETE | `.../reactions` | kernel:threads:write | Add/remove reaction |
| POST/DELETE | `.../participants` | kernel:threads:write | Manage participants |
| POST | `.../references` | kernel:threads:write | Link entity to thread |
| PATCH | `.../state` | kernel:threads:write | Archive/mute/pin |
| PATCH | `.../read` | kernel:threads:write | Mark read |
| POST | `/api/contacts/resolve` | kernel:contacts:write | Upsert contact |
| GET | `/api/contacts` | kernel:contacts:read | List contacts |
| GET | `/api/audit` | kernel:audit:read | Query audit log |
| GET | `/api/timeline/:app/:type/:id` | `{app}:{type}:read` | Entity history |
| GET | `/api/search` | (scope-gated internally) | Unified search (see Search below) |
| GET | `/api/mentions` | kernel:threads:read | Mention autocomplete |
| GET | `/api/references` | kernel:threads:read | Backlink lookup |
| POST | `/api/apps/tools/:name` | (per-tool scope) | Execute app tool |
| GET | `/api/apps/export/:app` | kernel:users:admin | Export app data |
| GET | `/api/apps/manifests` | (authenticated) | Installed manifest-format apps' UI metadata, for frontend bootstrap |
| GET | `/api/connections` | (authenticated) | List connected accounts |
| GET | `/api/connections/:appName` | (authenticated) | List connected accounts for app |
| POST | `/api/connections/:appName/:connectionName/authorize` | (authenticated) | Start OAuth flow |
| POST | `/api/connections/:appName/:connectionName/credentials` | (authenticated) | Store credential connection |
| DELETE | `/api/connections/:id` | (authenticated) | Disconnect account |

### Admin (JWT + admin scope)

| Method | Path | Scope |
|--------|------|-------|
| POST | `/api/admin/invites` | kernel:users:admin |
| POST | `/api/admin/users/:id/deactivate` | kernel:users:admin |
| POST | `/api/admin/users/:id/reactivate` | kernel:users:admin |
| GET/POST/DELETE | `/api/admin/roles` | kernel:users:admin |
| POST/DELETE | `/api/admin/roles/:id/scopes` | kernel:users:admin |
| POST/DELETE | `/api/admin/roles/:id/users` | kernel:users:admin |
| POST | `/api/admin/oauth-providers` | kernel:admin |
| POST | `/api/auth/device-flow/approve/:code` | (authenticated) |
| POST | `/api/auth/device-flow/deny/:code` | (authenticated) |

---

## Search

`GET /api/search` is a MeiliSearch-backed unified search across every entity type registered as searchable, not just threads and users: kernel built-ins (threads, users, contacts, approval requests) plus any entity an installed app declares `searchable` on in its manifest. Results are permission-filtered before they reach the client, using the same scope and dimension grants that gate the underlying entity.

- **Registration**: kernel built-ins are hardcoded; app-declared entities register through the manifest's `entities.<name>.searchable` flag, which feeds a shared indexing pipeline (document builder, per-entity schema) so an app author does not hand-roll search integration.
- **External federation**: some sources (for example, an app's own remote data) participate via an external bridge that dispatches into the app's sandboxed search handler and paginates results with an opaque per-section cursor, so federated sections page independently of the local-index results.
- **Availability**: when MeiliSearch is unreachable, `/api/search` returns `503` with `code: "SEARCH_UNAVAILABLE"` rather than silently degrading.
- **Operational tooling**: a reindex worker and a settings-drift detector keep the Meili index schema in sync with the registered entities; drift is checked at startup and search is marked not-ready until the index is confirmed consistent.

---

## Security

### Authentication

**Token pair strategy:**
- **Access token** — short-lived JWT (15 min), carried in `Authorization: Bearer` header, stored in memory on the client.
- **Refresh token** — long-lived (30 days), stored as an HttpOnly/SameSite=Strict/Secure cookie: `__Host-liaison_rt` (path `/`) in production, so a sibling subdomain cannot plant one, and `liaison_rt` (path `/api/auth`) over development http. Optionally exposed in response body via `EXPOSE_REFRESH_TOKEN_IN_BODY` for non-browser clients.
- Refresh rotates both tokens and spends the old refresh hash in the sessions table. The spent row is kept 24 h, linked to its successor and its family (every session from one sign-in, migration 0224). A spent token presented again is judged by its successor (`refreshSession` in `modules/auth/auth.ts`): under 30 s after the successor was issued it is a concurrent refresh (409 `REFRESH_RACE`); within 3 minutes of the rotation, from the same User-Agent, with the successor never used (no request authenticated with its access token, whose `sid` claim the auth middleware stamps in `sessions.used_at`, and no refresh of it), the response was lost and the successor is replaced by a new one in the same family; anything else is reuse: that token's family is revoked (401), and only that family. The user's other sign-ins (other devices, other browsers) are families of their own and keep their sessions; the security event `refresh_token_reuse` is logged at warn with the family and the number of rows revoked.

**Auth cache:** In-memory `Map<userId, { authVersion, permissionVersion, expiresAt }>` with 15s TTL, swept every 60s. On cache hit, the middleware skips DB queries. On version mismatch (authVersion or permissionVersion changed), the cache entry is evicted and the token is rejected — forcing the client to refresh.

**TOTP** — optional per-user. Login returns a challenge token instead of access/refresh if TOTP is enabled; the client must complete `/totp/verify` to get real tokens.

**OAuth/OIDC** — configurable per-org. Supports auto-provisioning new users on first OAuth login.

**Device flow** — RFC 8628 for headless/CLI clients. Device codes expire (checked every 5 min by a scheduled job).

### Password Security

- **Argon2id** hashing (19 MB memory, 2 iterations).
- Tokens (invite, password-reset, refresh) are generated with 32 bytes of cryptographic randomness and SHA-256 hashed before storage.
- **AES-256-GCM** encryption for secrets at rest (TOTP secrets, OAuth client secrets, connected account tokens/credentials) using the `ENCRYPTION_KEY` env var.

### Brute Force Protection

Dual-axis throttling on login:
- **Per-IP**: 20 attempts before blocking all logins from that IP.
- **Per-email**: 5 attempts, only enforced when the requesting IP already has 3+ failures (prevents account lockout attacks by random IPs).
- A blocked key stays blocked until its 1-hour TTL expires, and that remaining TTL is reported as the honest lockout duration. The exponential backoff formula (capped at 15 minutes) survives only as a fallback for a key without a TTL, which should not happen in normal operation.

### Authorization: Scopes & Dimensions

**Scopes** are hierarchical capability strings: `app:resource:action`. Granting `kernel:users` implicitly grants `kernel:users:admin` (prefix match). Scopes come from roles and direct user grants, merged at auth time. Commas are forbidden in scope values (RLS policies parse scopes via `string_to_array(..., ',')`).

**Dimensions** are attribute-based filters (e.g., `region: ["us", "eu"]`). They're used by the app framework for row-level field masking (Path B filtering) — a user with `region: ["us"]` only sees data tagged for that region.

Both are loaded fresh on every request from the database (not cached in the JWT), so permission changes take effect immediately (within the auth cache TTL).

### App Sandbox Security

App handler code runs inside a QuickJS WASM sandbox with no access to the host file system, network, or Bun/Node APIs. All capabilities are mediated through the RPC bridge, which enforces:

- **Entity/field validation** — DB operations are checked against the app's manifest declarations. Queries against undeclared entities or fields are rejected.
- **Event validation** — `emit()` calls are checked against `declaredEmits`. Undeclared events are rejected before reaching the outbox.
- **Network allowlisting** — `fetch()` validates target domains against `manifest.network.allowedDomains` and per-connection `allowedDomains`. Unlisted domains are blocked before any network call.
- **Connection scoping** — `connections_getToken` and `connections_getAccounts` only return accounts for connections declared in the requesting app's manifest.
- **Memory/timeout limits** — 8MB per runtime slot (sufficient for business logic; typical usage 50KB–2MB), execution timeout via interrupt handler (5s in production, not overridable; 60s default in development/test, overridable via `LIAISON_SANDBOX_TIMEOUT_MS`), 256KB stack size limit.

The sandbox + RPC bridge + RLS form three defense layers: even if app code is malicious, it cannot escape WASM isolation, bypass manifest validation, or read data outside its RLS scope.

### Middleware Composition

Pattern: mount auth first, then scope/rate-limit, then routes:

```typescript
app.use("/api/org", authMw, orgLimiter)
app.use("/api/org", requireScope({ GET: "kernel", PATCH: "kernel:org:admin" }))
app.route("/api/org", org)
```

`requireScope` accepts a string (single scope for all methods) or an object (`{ GET: "kernel", PATCH: "kernel:org:admin", "*": "kernel" }`) with per-method scopes and a fallback. Unlisted methods are denied by default.

### Rate Limiting

Sliding window (Redis sorted set), 60-second window. Identifier: authenticated user ID or client IP. Returns 429 with a `Retry-After` computed from when the oldest request in the window expires, rather than a fixed value. Limit is configurable per-org and synced to Redis on org settings update.

---

## Real-Time: WebSocket

WebSocket endpoint at `/ws`, using Bun's native WebSocket support.

**Connection flow:**
1. Client calls `POST /api/auth/ws-ticket` with its access token.
2. Server stores a single-use ticket in Redis (30s TTL).
3. Client connects to `/ws?ticket=<ticket>`.
4. Server validates and consumes the ticket on upgrade, populating `WsData` (userId, orgId, scopes, dimensions).

**Message types:**
- `hello` — client sends after connect; server loads thread membership, sends presence sync.
- `ping`/`pong` — heartbeat for presence.
- `typing` — typing indicator, throttled at 4s per user+thread.
- `status` — set online/away.

**Server-to-client** — the event bus fans out all events to connected WebSocket clients. Thread events are scoped to thread participants.

**Rate limiting (per-connection):** 120 msg/60s message rate, 5s hello cooldown, 4s typing throttle per user+thread.

**Auth revalidation:** Throttled to once per 60s per user.

**Permission change handling:** When role/scope/dimension grants change, the event subscriber closes affected users' WebSocket connections with code 4010, forcing re-authentication with updated permissions.

**Live state across processes** (`infra/websocket-state/redis.ts`). Each process keeps its own sockets in a local table for fan-out, and writes a copy of each connection to Redis under its instance id. Who is online, which users of an org are online, and whether any live socket holds mail access are read from Redis, so they cover every process. A user goes online with their first socket anywhere and offline with their last (`lib/server.ts`). The per-user agent stream cap is counted the same way (`modules/agent/stream-slots.ts`, `AGENT_MAX_CONCURRENT_STREAMS`, default 2).

Every process writes a heartbeat record (`infra/instance-registry.ts`, `LIVE_INSTANCE_TTL_MS` 30 s, renewed every `LIVE_INSTANCE_HEARTBEAT_MS` 10 s). An entry counts only while its instance has a record, so a killed process drops out when its record expires. The leader sweeps dead instances every `LIVE_SWEEP_INTERVAL_MS` (10 s) and runs the `onDeadInstance` hooks, which delete their entries. A process whose record lapsed and comes back runs its `onInstanceRecovered` hooks, which rewrite its entries from its local tables.

Every live-state Redis call is bounded (1 s). Without an answer, each read fails in a fixed direction:

- mail access: nobody holds it (closed);
- mailbox unlock: locked;
- agent stream cap: the stream is allowed (open), with a warning log;
- online/offline on connect and close, and the presence map: decided from this process's own sockets.

Typing throttles and auth revalidation timing stay per process.

**Live agent turns** (`modules/agent/runtime/stream-registry.ts`). Every `agent_stream` frame of a turn is appended to that turn's Redis Stream, by one Lua script that also gives the frame its `seq` (the turn's frame counter) and its item id (`r<n>` for reasoning, `t<n>` for text, the tool call id for a tool call). Two processes producing frames for one turn therefore agree on both. The broadcast frame carries `seq` and `itemId`. `GET /api/agent/stream-state/:threadId` folds the stream into a snapshot and returns it with the last `seq` it covers, so a view that opens or reconnects on any process seeds from it and drops live frames at or below that `seq` (snapshot + tail). A registry that does not answer serves no run: the view seeds nothing and follows the live frames.

Memory is bounded: every 500 frames the turn is folded into a checkpoint entry and the stream is trimmed up to it (`XTRIM MINID`). A finished turn leaves the thread's live index but its stream stays readable for `AGENT_TURN_STREAM_TTL_S` (600 s). Readers ignore turns whose owner instance has no heartbeat, or that were not heard from for 660 s; the leader's sweep takes a dead instance's turns off the index and tells listeners the run stopped. Turn changes reach every process on the `agent:live:changes` channel.

**Live runs** (`modules/agent/scopes/live-runs.ts`). The runs going on each thread are kept per instance in Redis, so the untrusted-content mark is cleared at the start of a turn only when no other run is live on that thread on any process. The read is bounded (1 s) and fails closed: another run is assumed live and the mark stays.

**Credit balance updates** go through `broadcastEphemeral`, so every process sends them to its own sockets (a `worker` has none).

**The internal listener** (`modules/agent/mailbox-plaintext/mailbox-forward.ts`). A mailbox decrypt request waits in the process that minted it. An answer that reaches another process is forwarded over a direct HTTP call to the minting process's internal listener, never through Redis. Every process starts that listener on `LIAISON_INTERNAL_PORT` (0: any free port) and publishes its URL (`LIAISON_INTERNAL_HOST`, default the hostname) in its heartbeat record. It binds the address that name resolves to (`LIAISON_INTERNAL_BIND` overrides), never every interface by default. It serves one route, `/internal/mailbox-answer`; the public app never mounts it. The call is signed with HMAC-SHA256 under a key derived from `JWT_SECRET` with HKDF, over the path, timestamp, target instance and the hash of the raw body. The receiver reads at most 2 MiB and checks the signature before it parses the body. It refuses more than 30 s of clock skew, a replayed signature and a signature made for another instance, then re-runs the user and turn-nonce checks. An owner that is dead or unreachable answers 409 `WRONG_INSTANCE`.

**Retried writes** (`lib/idempotency.ts`). `withIdempotency(key, contentHash, …)` claims a Redis key (NX, 60 s while pending, 24 h once the write committed). A duplicate waits for the first request and gets its stored result; the same key with another payload is refused with 422. Redis failing lets the write through without dedup. A message post with a `correlationId` uses it (`idem:msg:<org>:<thread>:<user>:<correlationId>`), so a retried post is applied once on any process, and another person's post with the same id is their own message.

---

## Event System

Every mutation publishes an `AppEvent` through the transactional outbox:

```typescript
{
  app: string           // "kernel" or app name
  entity: string        // entity type (e.g. "thread", "message")
  action: string        // verb (e.g. "create", "update", "delete")
  entityId?: string
  data?: unknown
  actorId?: string | null
  actorType?: "user" | "agent" | "system" | "mcp"
  orgId: string
  timestamp?: string
  ephemeral?: boolean
  metadata?: unknown
}
```

**Delivery:**
1. **Outbox worker** claims events from `pending_events`, publishes to Redis + dispatches to in-process handlers.
2. **Local handlers** — every stored (non-ephemeral) event fans out to a mix of durable, at-least-once consumers and best-effort in-process subscribers:
   - **Timeline** (durable) — generates a `timelineEntries` row (skipped for ephemeral events and events without `entityId`). Runs in system RLS context (purpose: "timeline").
   - **Audit** (durable) — writes to `auditLog` (skipped for ephemeral events). Strips message content (stores only metadata + contentLength). Runs in system RLS context (purpose: "audit"). A best-effort fallback subscriber covers events that bypass the outbox.
   - **WebSocket fan-out** (durable for stored events) — broadcasts to connected clients in the org. Thread events scoped by participant membership. Buffers non-ephemeral events in Redis for reconnect replay. Ephemeral and remote events are broadcast by a separate best-effort subscriber.
   - **Permission refresh** (best-effort) — closes WebSocket connections for affected users on permission changes (user deactivation, role/scope modifications), forcing re-auth.
   - Other best-effort subscribers cover MCP catalog/resource-update notifications and thumbnail generation.
3. **Cross-process** — Redis Pub/Sub replicates events to other server instances. Process-local dedup via `_msgId` tracking (max 50k entries) prevents double-dispatch. Every handler declares a delivery class (`onEvent(fn, { delivery })`, `subscribeToEvent(..., { delivery })`):
   - `once` runs only in the process that published the event (the outbox drain, or a direct publisher). A peer's remote copy skips it. Use it for anything that writes: rows, jobs, outside calls. App event subscriptions, event routines and the thumbnail enqueue are `once`.
   - `per-replica` runs in every process, on the publisher's copy and each peer's. Use it for process-local state: caches, projected tools, this process's sockets. The broadcast of ephemeral and remote events to this process's sockets, and the permission-refresh socket close, are `per-replica`.
   - A process with a `per-replica` `onEvent` handler holds one pattern subscription on every events channel, so it receives every event and filters locally. A message that arrives on both the pattern and an explicit channel subscription is deduped by `_msgId`.
4. **Per-channel** — apps can subscribe to specific `app:entity:action` patterns.

Events must be declared in advance (`declaredEmits` map). Publishing an undeclared event is rejected. Bounded concurrency: max 50 concurrent handler dispatches.

**Ephemeral events** (e.g., `typing:start`, `presence:update`) bypass the outbox entirely — published directly via `broadcastEphemeral()` to Redis + in-process handlers. They skip audit/timeline persistence.

---

## Approvals

Gated tool calls (single-step or multi-step compound bundles) can require a human sign-off before executing. Beyond the base gating declared per-tool, an org can layer on its own approval policies:

- **Approval policies**: org-configurable rules that can escalate an approval requirement, turning a non-gated call into a gated one, or raising the minimum distinct-approver count (N-eyes) above the tool's built-in default. Policies can only tighten, never loosen, the built-in gating. Managed through policy get/set tooling.
- **Editing a pending draft**: an approver (or the requester) can edit specific fields of a pending approval's payload before deciding. Each editable field can declare which derived fields it `invalidates`, so editing it blanks those derived fields and a stale pre-edit version can never be sent alongside the edited one. For example, editing a draft's text body invalidates its pre-rendered HTML body, forcing it to re-render from the edited text.
- **N-eyes reset on edit**: when a bundle requires multiple distinct approvers and one has already signed off, editing the payload clears the recorded approvals. A sign-off applies to the content that was reviewed, so every approver must re-review the edited version before it can execute.

---

## App Framework

Apps are discovered from the filesystem at startup: in-tree apps under `apps/api/src/apps/<name>/` and runtime-installed `.liaisonapp` packages under an install root (default `/var/lib/liaison/apps`, overridable via `LIAISON_APPS_DIR`). Installed apps are signature-verified by default (`LIAISON_REQUIRE_APP_SIGNATURE`, on unless explicitly disabled). Two formats coexist:

- **Legacy `defineApp()` format** — apps use direct function handlers in TypeScript. Handlers run in-process with a typed `AppContext`.
- **Manifest format** — apps are declared as JSON manifests (validated with AJV/JSON Schema) with bundled JS handler files. Handlers reference `{ bundlePath, exportName }` and execute inside the QuickJS WASM sandbox. The `@liaison/app-sdk` package (`defineHandlers`, `AppContext` type, schema builder `s`) provides the authoring API for manifest apps.

Each app can declare:

- **Tools** — callable via `POST /api/apps/tools/:toolName`, with per-tool scope requirements and optional `gated`, `trustBoundary` flags.
- **Exports** — downloadable via `GET /api/apps/export/:appName`, with dimension-based filtering.
- **Webhooks** — inbound endpoints at `/webhooks/:orgId/:appName/:endpointName`, verified by HMAC signature with replay detection.
- **Jobs** — BullMQ queues per app (`app-{name}`), with scheduled and on-demand jobs. Concurrency: 5 per queue, 3 retries default. Kernel jobs run with `withPrivilegedDb()`, app jobs run with RLS context. A manifest `schedule` is one scheduler per (app, job) on `kernel-cron` (`app-cron-fanout:<app>:<job>`, `infra/jobs/fanout-runtime.ts`); each tick enqueues one job per workspace with the app on, spread over min(80 % of the interval, 5 min), with an id naming the workspace and the fire time, so runs are one per workspace per tick.
- **Events** — declared emits and subscriptions.
- **Connections** — OAuth2 and credential connections to external services, declared in the manifest with provider type, OAuth URLs, scopes, and allowed domains. Token storage is handled by the kernel `connected_accounts` table.
- **Timeline declarations** — define what timeline entries look like for the app's entities.
- **Entities** — `labelField`, `handlePrefix`, `searchable` flag.
- **Views, slots, contributions** — UI extension points.

Each app gets its own Postgres schema (`app_<name>`) and its tool/export handlers run within an RLS context.

### Core apps (server code)

A core app's handlers are server code, not a sandboxed bundle. Its `apps/<name>/handlers.ts` is an ordinary module: every handler its manifest names (tools, preflights, jobs, event handlers, webhooks and their verifiers, the export, the attention provider) is a named export `(params, ctx, ...extra)`. The app is listed in `CORE_APP_MODULES` (`apps/api/src/modules/apps/core/registry.ts`) under its name and the module path its descriptor declares as `_bundlePath`; `runApp` then imports the module and calls the export in the API process (`core/run-core.ts`). No sandbox, ctx shim or bundle transform is involved, whatever the call site.

`ctx` is a `CoreCtx<Methods>` (`core/ctx.ts`): the run's bridge, called directly, so a core handler and a sandboxed app share one implementation of every host method, with the same actor, scopes and transaction. `ctx.approval` is the approval a re-entry runs under. Work that must land together runs in `ctx.transaction(fn)`: one database transaction, committed or rolled back as a whole (a run that already holds one runs `fn` on it). Core apps declare no `atomic` flag; that flag is for sandboxed runs only. A core run keeps a sandboxed run's deadline: once it times out or is cancelled (and once it has returned), every `ctx` call throws an "interrupted" error, so a handler still running stops at its next host call.

Moving another core app means: turn its `handlers.ts` into a module with named exports and a typed `CoreCtx` interface of the methods it uses, add its row to `CORE_APP_MODULES`, and replace any `atomic` tool with `ctx.transaction`. The registry test (`core/run-core.test.ts`) checks that every handler the manifest names is an export.

### Sandbox Execution (Manifest Apps)

Every app that is not core (`modules/apps/core/registry.ts`) runs sandboxed through `runApp`, whoever published it: Workers in Cloud, the sandbox service (workerd) self-hosted, and QuickJS compiled to WebAssembly (`quickjs-emscripten`) while `LIAISON_APP_RUNTIME=quickjs`. No manifest field changes it: a manifest carrying `trusted` is refused. On QuickJS an app runs in the worker subprocess pool; the in-process pool takes only a site's own pure function on an empty bridge (an approval summarizer, a PDF template).

**In-process pool:** each slot owns its own QuickJS WASM module instance rather than sharing one across the pool, so if a runtime abort ever occurs, it poisons only that one slot instead of hanging every execution in the process. The pool pre-warms 4 slots by default and grows to a hard ceiling of 12 (acquiring a slot waits up to 15s when saturated), 8MB memory limit per slot.

**Worker subprocess pool:** Each worker is a separate OS process running its own QuickJS WASM module. If a worker crashes (OOM, WASM trap), only that worker dies — the pool spawns a replacement automatically. Bridge calls are proxied to the main process over IPC.

Both paths use the same bridge pattern: bridge functions return QuickJS native promises; the host resolves them when async work completes (DB query, event emission, network fetch). Each invocation gets a fresh context — no state leaks between calls. Timeout enforcement via interrupt handler: 5s in production (not overridable), 60s by default in development/test (overridable via `LIAISON_SANDBOX_TIMEOUT_MS`).

**Context hardening:** Every context has `ArrayBuffer`, `SharedArrayBuffer`, `DataView`, and all typed array constructors removed before app code runs — these bypass QuickJS memory tracking and could OOM the host via WASM linear memory. Then `globalThis.crypto` is installed: the WebCrypto subset apps share with Workers (digests, HMAC, random values), computed by the host with bytes as arrays of numbers (`apps/api/src/modules/apps/sandbox/webcrypto-shim.ts`; [Hash, sign and draw random values](app-sandbox.md#hash-sign-and-draw-random-values-crypto)).

The **RPC bridge** is the only interface between sandbox code and the host:

| Category | Methods |
|----------|---------|
| Identity | `getUserId()`, `getOrgId()` |
| Database | `db_findMany`, `db_findOne`, `db_insert`, `db_update`, `db_updateMany`, `db_delete`, `db_count` |
| Events | `emit(event)` — declared emits only |
| Jobs | `enqueueJob(name, payload)` |
| Contacts | `resolveContact(params)` |
| Network | `fetch(url, opts)` — domain allowlist enforced |
| Connections | `connections_getToken(connName, identifier?)`, `connections_getAccounts(connName)` |
| Logging | `log_info`, `log_warn`, `log_error`, `log_debug` |

All DB operations run through the RLS-scoped transaction. Entity names, field names, and event types are validated against the app's manifest declarations at the bridge level.

For full sandbox architecture details (pool lifecycle, worker crash recovery, tiering model, performance characteristics, frontend iframe bridge), see `docs/app-sandbox.md`.

### App Context (Legacy Apps)

Legacy apps receive an `AppContext` directly in-process:

```typescript
interface AppContext {
  userId: string
  orgId: string
  db: RlsClient          // RLS-enforced transaction
  emit: (event) => void  // Validates app + declaredEmits, queues into outbox
  enqueueJob: (name, payload) => void
  resolveContact: (params) => Contact
  logger: pino.Logger
}
```

Manifest apps receive the same capabilities through the RPC bridge — the sandbox executor constructs the bridge from the same underlying services (RLS transaction, outbox, job queue, contact resolver).

**Registries** — in-memory Maps populated at startup via `initAppsForOrg()`: `toolRegistry`, `webhookHandlers`, `dimensionDefRegistry`, `timelineDeclarations`, `viewRegistry`, `slotRegistry`, `entityRegistry`, `exportRegistry`, `skillRegistry`, `manifestRegistry`, `connectionConfigRegistry`, `declaredEmits`.

---

## Infrastructure Dependencies

| Service | Library | Purpose |
|---------|---------|---------|
| PostgreSQL | postgres.js + Drizzle | Primary data store, RLS enforcement |
| Redis | ioredis | Rate limiting, brute-force tracking, event pub/sub, WS tickets, presence, event replay buffer, live agent turns, idempotency keys |
| Redis (BullMQ) | bullmq | Job queues with retry, scheduled jobs |
| MeiliSearch | meilisearch | Unified search across threads, contacts, and app-registered entities; a required API key is enforced in production |
| S3-compatible object storage | (S3 client) | File and attachment storage; SeaweedFS in development |

Three Redis connections are maintained: main (with key prefix for test isolation), BullMQ (no key prefix, uses BullMQ's own prefix), and Pub/Sub (dedicated subscriber).

---

## Scaling constraints

A process runs one role (`LIAISON_ROLE`, `lib/process-role.ts`): `all` (default, everything in one container), `api` (HTTP + WebSocket only) or `worker` (BullMQ workers and the singletons, health-only server). See [Run several processes](self-hosting/docker.md#run-several-processes).

- **Jobs:** every `all` or `worker` process runs BullMQ workers. With `SINGLETON_LEADER_URL` set, they run only on the Patroni leader node.
- **Singletons** (outbox drain, legacy queue move, node-lease sweep, demo loops) run only in the process holding the Redis leader lease (`infra/leader-lease.ts`, `infra/leadership.ts`), and only on the Patroni leader node when that gate is on. `isLeader()` fails closed; an `api` process never leads.
- **App registries** are in-memory per process, filled on the first touch of each org (`awaitOrgApps`); boot sets up no org, so its time does not grow with the org count. Event dispatch of `once` handlers and the OAuth callback ensure their org too; a registry lookup that misses for an org not set up throws outside production and logs `org_registry_read_before_setup` in production (`modules/apps/org-registry-guard.ts`, counted in `/diag` `orgSetup`). PDF templates are instance-wide, loaded per app on a render miss; routine schedulers are re-created by the leader on lease acquire; MCP connections are projected per org at its first touch, and projected again in every process that already did when the leader's env bootstrap writes an env-managed connection (its `mcp_manager:connection` event); a serving process fills those of the orgs with a live WebSocket in the cell before `/readyz` answers 200, within `LIAISON_READY_WARM_MS` (`modules/apps/ready-warm.ts`); the persistent setup writes are skipped while the org's setup stamp matches (`modules/apps/setup-stamp.ts`). The kernel's own tools are built once per process and replayed into each org (`registerKernelAgentTools`, `captureRegistrationTemplate` in `modules/apps/registries.ts`), so every org shares their definitions. A process releases the runtime of an org whose row is gone every 5 minutes, and, with `LIAISON_ORG_RUNTIME_IDLE_MINUTES` set, of an org nothing touched for that long, and past `LIAISON_ORG_RUNTIME_MAX_ORGS` set-up orgs (default 2000) of the least recently touched org that no request, socket, job, event or agent turn holds and that is not moving; its next touch sets it up again (`modules/apps/org-runtime-release.ts`).
- **Sandbox pools** (QuickJS in-process and the worker subprocess pool) are per process and scale naturally.
- **Scheduled app jobs fan out** (`infra/jobs/fanout.ts`, `infra/jobs/fanout-runtime.ts`): one scheduler per (app, job), however many workspaces. A tick lists the workspaces whose app is on (`active` or no row; `error` once an hour; `disabled` and `removed` never) and adds one job per workspace with the BullMQ id `fo.<app>.<job>.<org>.<epoch>`, so a tick run twice (a retry, a killed worker, two processes) adds each job once. A marker per job lets a re-run skip what it already added, and a workspace whose previous job has not started yet gets no second one. The state materializer's minute tick fans out the same way (`attention-state-email-materialize-org`), but only to the workspaces whose state changed since the last tick (the outbox worker marks each batch's workspaces in one Redis sorted set) plus, once every 10 minutes on a minute fixed by its id, every other workspace (`modules/attention/org-changes.ts`): an idle workspace costs one run in ten, an item an event causes still goes out the next minute, and one that only time causes (an expiry) within 10 minutes. Job hosts only add schedulers at boot and re-add them every 10 min; an app's activation or uninstall syncs its own, and the leader's reconcile removes those of apps that are gone. Job hosts add a scheduler only when it is missing or changed (an upsert replaces a tick that already fired). The leader's reconcile removes only the schedulers of an app with no active version that is not in-tree, never a job it does not know (it may run an older release). The per-org schedulers of earlier releases are removed by a leader sweep; a tick of one that fired becomes the fan-out job of its org and fire time, so the fan-out tick of that epoch adds nothing more (`legacy_tick_converted` in the `jobs:metrics` Redis hash).
- **Rolling back past the fan-out:** a release from before it has no handler for the fan-out ticks. After the previous image runs everywhere, run `bun apps/api/scripts/cron-fanout-rollback.ts` (report) then `--apply`: it removes the `app-cron-fanout:*` schedulers and the queued fan-out kernel jobs from `kernel-cron`. The previous release re-creates its own per-org schedulers as it sets each workspace up.
- **Fair job queues** (`infra/jobs/fairness.ts`): on the kernel class queues and every app queue, workspaces take turns. A job is queued behind the jobs other workspaces already have waiting, so one workspace's thousand jobs do not hold back another's one. While another workspace has a job waiting, one workspace runs on at most half the queue's worker slots across all job hosts (each host publishes its slots in its instance record); a workspace alone may use them all. A job over that cap goes back to the queue as delayed, without spending an attempt, and starts again when one of its workspace's jobs ends. A sub-agent run that its parent job waits on passes the cap (up to twice it), so a sub-agent chain cannot wait on itself. `kernel-bulk` has one slot per host, so the cap does little there. When Redis cannot answer the gate within 250 ms, jobs run ungated and `/diag` reports the queue `degraded`. A job that ran ungated (that way, or on a job host of an older release) no longer counts as waiting, so it cannot keep a lone workspace capped; a job host of an older release, which publishes no slots, counts with the default slots. `JOB_ORG_FAIRNESS=off` turns the gate off. `/diag` lists per queue the admitted, denied and promoted counts since the counters began, the jobs parked now, the number of busy workspaces and the p95 wait over the last 5 minutes, and the cron fan-out's counters per app and job.

- **Live state** (sockets, presence, mail access, the agent stream cap) lives in Redis per instance, with a heartbeat, a leader sweep of dead instances and recovery after a lapse. See [Live state across processes](#real-time-websocket).
- **Event handlers** declare `once` or `per-replica` (see [Event System](#event-system)).
- **Event routines** stay subscribed in every process (`infra/jobs/event-routine-subscriber.ts`). The process that changes a routine announces it on a Redis channel after its transaction commits, and every process re-reads the row. Since an announce can be lost, every process also resyncs from the table when its subscriber reconnects, when it takes the leader lease, and every 60 s.

- **Live agent turns, live runs, credit updates and mailbox answers** work across processes (see [Live state across processes](#real-time-websocket)): turns in Redis Streams, mailbox answers over the signed internal listener.

- **Migrations run once, as their own step.** The image's `migrate` command (or the start of a container, unless `LIAISON_MIGRATE_ON_START=false`) applies pending migrations under a lease row in `drizzle.liaison_migration_lock` (`apps/api/src/db/migrate.ts`): 60 s, renewed every 10 s on its own connection, polled every 1 s by a waiting runner. A renewal or release that does not answer within 10 s counts as failed: two failed renewals in a row stop the runner. On a direct Postgres connection the migration connection also holds a session advisory lock, so a runner that lost its lease while still migrating blocks the next one; through PgBouncer that lock is skipped. SIGTERM or SIGINT to the migrate step releases the lease before it exits. The boot catalog reconcile takes the same lease.

### Changing the schema without downtime

During a deploy the previous release runs against the new schema, so release N's code must run on release N+1's schema:

- Expand, migrate the code, contract. A column, table, enum value or jsonb key is removed only after a release that no longer reads or writes it.
- Code that reads an enum, a `state` value or a jsonb shape tolerates values it does not know: it skips them or treats them as opaque, and never throws.
- The previous image's running processes stay schema-compatible, because a contract only follows a release that stopped using the object.
- Starting an image older than the schema is refused (`apps/api/src/db/schema-guard.ts`, in the migration step and in the entrypoint): migrations only go forward. `LIAISON_ALLOW_OLDER_IMAGE=true` is the unsupported emergency override.

`bun run check:migration-safety` (CI) refuses a new migration that breaks this, unless the file says why it is safe:

| Statement | Passes with |
|---|---|
| `DROP COLUMN` (with or without the word `COLUMN`), `DROP TABLE`, `RENAME`, `SET SCHEMA`, `ALTER COLUMN ... TYPE`, `SET NOT NULL`, `ADD COLUMN ... NOT NULL` without a default on an existing table | `-- contract: <reason>, unused since <PR or release>` anywhere in the file |
| `DROP INDEX`, `DROP CONSTRAINT`, `DROP FUNCTION`, `DROP POLICY`, `DROP TRIGGER`, `DROP TYPE`, `DROP SCHEMA`, `DROP VIEW`, `DROP SEQUENCE`, `DROP DOMAIN`, `DROP EXTENSION`, `TRUNCATE`, `ALTER TYPE`, `ALTER DOMAIN`, `REVOKE` (except on objects the file creates), `CREATE OR REPLACE FUNCTION` of an existing function; on an existing table: `CREATE`/`ALTER POLICY`, `CREATE [OR REPLACE] TRIGGER`, `ENABLE`/`DISABLE`/`FORCE`/`NO FORCE ROW LEVEL SECURITY`, and a constraint added with `ADD CONSTRAINT`, `ADD EXCLUDE` or inline in `ADD COLUMN` (`REFERENCES`, `CHECK`), `NOT VALID` included | the file's `-- contract:` line, or `-- expand-safe: <why the previous release's code satisfies it>` right above the statement |
| A `DO` block, an `EXECUTE`, a function body that runs DDL | `-- reviewed-dynamic: <reason>` right above the statement |
| Any `ALTER TABLE` on an existing table | a non-zero `SET LOCAL lock_timeout` earlier in the file (also in a `-- contract:` file) |
| `CREATE INDEX`, or `ADD ... PRIMARY KEY` / `UNIQUE` (inline in `ADD COLUMN` too), on an existing table | a non-zero `SET LOCAL lock_timeout` earlier in the file and `-- index-build: <table> <rows> <measured ms>` above it; a build over 10 000 ms also needs `-- maintenance-deploy: <reason>` |

The migrator applies every pending file in one transaction, so `CREATE INDEX CONCURRENTLY` is refused, and an index build on an existing table holds writes to that table while it runs. The guard reads the drizzle journal (`meta/_journal.json`), the list the migrator runs: migrations up to the journal entry in `scripts/migration-safety-baseline.json` predate the guard and are not checked, and a `.sql` file the journal does not list, or a journal entry with no file or off the `NNNN_name` form, fails. Annotations count only as real comments: one inside a function body or a string exempts nothing.

- **Shutdown** is one sequence (`lib/shutdown.ts`). SIGTERM or SIGINT starts it; modules register named phases. At t0 readiness goes draining, and approvals and job fetches are refused; agent chat turns are still taken until the edge grace has passed (the edge may still route here), then refused with 503 `RESTARTING` (`refusesNewWork`). At t0 + `SHUTDOWN_EDGE_GRACE_MS` the listener stops and local WebSockets close with 1012. Then the HTTP, approval, turn and job drains run together under their own budgets; a job past its budget is aborted (`ctx.signal`) and moved back to its queue without spending an attempt; a job whose handler ignores the abort keeps its lock until the Postgres pool has closed, then goes back to wait just before Redis closes, so it never runs on two processes at once. Then, one group at a time: the event flush, the outbox, the search rebuild lock, the sandbox and transform pools, the instance heartbeat, the internal listener, the database pool, that job hand-back, and the Redis connections. Each pool closes only once boot has finished or parked at its next step. Every phase logs one `shutdown_phase` line (`phase`, `ms`, `outcome`). The process exits 0 at the latest at `SHUTDOWN_HARD_DEADLINE_MS`. A signal during boot halts boot at its next step. A message posted to a draining process becomes an `agent-turn-dispatch` job, so a live process starts its turn.

- **Clients recover from a network blip.** The web app (and the desktop and phone apps around it) notices a dead connection within about 10 seconds, reconnects, and reloads every open view (`apps/web/src/primitives/createWebSocket.ts`, `apps/web/src/framework/resync.ts`). Reads time out and retry; a lost message send is sent once more with the same `correlationId`. So several processes can serve the API. A turn whose process dies or drains past its budget is resumed by another process from its last complete step (`modules/agent/runtime/turn-resume.ts`): its record and journal (`kernel.agent_turns`, `kernel.agent_turn_events`) say who runs it, a claim fences the old runner, and a write tool call is keyed in the effect ledger (`lib/effect-once.ts`) so the resumed step never repeats it.

---

## Portability

The backend has minimal coupling to its runtime:

- **Bun-specific surface**: `Bun.serve()` for HTTP + WebSocket, and `bun:test` for tests. The Hono app itself is framework-agnostic. Password hashing already goes through the `argon2` npm package, not a Bun-specific API.
- **Database**: standard PostgreSQL with RLS. Drizzle generates plain SQL migrations. Requires only the `pg_trgm` contrib extension (bundled with standard Postgres, created automatically by migrations).
- **Redis**: standard Redis commands + Lua scripts for atomics. No Redis modules.
- **Config**: all external configuration is via environment variables, validated with Zod at startup. See Configuration Reference below.
- **Backing services**: application process state lives in Postgres and Redis, but runtime-installed apps live on the local filesystem (the install root, default `/var/lib/liaison/apps`), and MeiliSearch plus S3-compatible object storage are additional stateful dependencies. Horizontal scaling requires shared Postgres, Redis, MeiliSearch, and object storage, plus a shared or replicated installed-apps directory.

To port to a different runtime (e.g., Node.js), you'd replace `Bun.serve()` with a Node HTTP server and switch `bun:test` to Vitest. The rest (Hono, Drizzle, ioredis, BullMQ, argon2) works unchanged on any JavaScript runtime.

---

## Configuration Reference

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `JWT_SECRET` | Yes | — | Min 32 characters |
| `ENCRYPTION_KEY` | Yes | — | Exactly 64 hex chars (32 bytes). Used for TOTP secrets, OAuth client secrets, and connected account tokens |
| `BYOK_ENCRYPTION_KEY` | Yes in production | — | 64 hex chars (32 bytes). Falls back to `ENCRYPTION_KEY` outside production; fatal at startup if unset in production |
| `MONITOR_TOKEN` | Yes in production | "" | Bearer token guarding the `/diag` monitoring endpoint; fatal at startup if unset in production |
| `MEILISEARCH_API_KEY` | Yes in production | "" | Fatal at startup if unset in production while `MEILISEARCH_HOST` is set |
| `DATABASE_URL` | No | `postgres://localhost:5432/liaison` | |
| `REDIS_URL` | No | `redis://localhost:6379` | |
| `PORT` | No | 3000 | |
| `NODE_ENV` | No | development | development/production/test |
| `BASE_URL` | Must be non-default in production | `http://localhost:3000` | Drives MCP OAuth discovery and the `WWW-Authenticate` challenge; fatal at startup if left at the default in production |
| `ALLOWED_ORIGINS` | No | `http://localhost:5173` | Comma-separated |
| `TRUSTED_PROXY_HOPS` | No | 0 | 0 = direct (socket IP); set to 1+ behind reverse proxy |
| `LOG_LEVEL` | No | info in production, debug otherwise | Pino levels |
| `DEVICE_FLOW_CLIENTS` | Must be non-empty in production | "" | Comma-separated client IDs |
| `EXPOSE_REFRESH_TOKEN_IN_BODY` | No | false | For non-browser clients (must be false in production) |
| `EXPOSE_ERROR_DETAIL` | No | false | Stack traces in error responses (must be false in production) |
| `RATE_LIMIT_DEFAULT` | No | 1200 | Pre-auth requests per minute, per client IP |
| `RATE_LIMIT_PER_USER` | No | 600 | Post-auth requests per minute, per acting user (`user:<orgId>:<userId>`) |
| `DB_POOL_MAX` | No | — | Connection pool max size |
| `LIAISON_APPS_DIR` | No | `/var/lib/liaison/apps` | Runtime install root for `.liaisonapp` packages |
| `LIAISON_REQUIRE_APP_SIGNATURE` | No | true | Require a valid signature on installed apps |
| `MEILISEARCH_HOST` | No | `http://localhost:7700` | |
| `MEILI_INDEX_PREFIX` | No | "" | Index name prefix, for multi-instance isolation |
| `OBJECT_STORAGE_ENDPOINT` | No | `http://localhost:9000` | S3-compatible endpoint; SeaweedFS in development |
| `OBJECT_STORAGE_REGION` | No | `us-east-1` | |
| `OBJECT_STORAGE_BUCKET` | No | `liaison-dev` | |
| `OBJECT_STORAGE_ACCESS_KEY` | No | `liaison` | |
| `OBJECT_STORAGE_SECRET_KEY` | No | `liaison-dev-secret` | |
| `OBJECT_STORAGE_FORCE_PATH_STYLE` | No | true | |
| `OBJECT_STORAGE_PUBLIC_URL` | No | — | Public URL for serving stored files, when different from the endpoint |
| `OBJECT_STORAGE_BROWSER_DIRECT` | No | false | Browsers reach the store (S3, R2): uploads PUT to presigned URLs and downloads fetch presigned GETs, bypassing the API; needs a bucket CORS rule (the only browser-side requirement: the web page itself has no CSP). Off: every byte goes through the API relay (private SeaweedFS). See `docs/runbooks/production-bootstrap.md` |
| `RESEND_API_KEY` | No | "" | Transactional email via the Resend API; when absent, falls back to SMTP or console logging |
| `SMTP_HOST` | No | — | When absent (and no `RESEND_API_KEY`), emails log to console |
| `SMTP_PORT` | No | 587 | 587 (STARTTLS) or 465 (implicit TLS) |
| `SMTP_USER` | No | "" | |
| `SMTP_PASS` | No | "" | |
| `SMTP_SECURE` | No | false | true for port 465 |
| `EMAIL_FROM` | No | `Liaison <noreply@liaison.app>` | |
| `SYSTEM_EMAIL_FROM` | No | (empty = `EMAIL_FROM`) | Sender of system mail: sign-in links, invites, security codes, digests |

## Knowledge (Phase 11)

Knowledge is a first-party app for local documents, curated source links, and federated search across remote sources.

- **Local Knowledge documents** live in `app_knowledge.documents`, are indexed by MeiliSearch through the existing permission-filter pipeline, and use participant + dimension (`team`, `sensitivity`) RLS. Personal-scoped documents require `owner_user_id = current_setting('app.user_id')`; organization-scoped documents require scope + dimension grants.
- **Remote sources** participate in a Knowledge-specific federated search service (`apps/knowledge/federated-search.ts`), not the generic `modules/search` fanout. Each source adapter implements `KnowledgeSourceAdapter` and is registered via `apps/knowledge/source-registry.ts`. A catalog app syncs its folders through its manifest's `knowledgeSources` instead (Google Drive: `bundled-apps/google-drive/src/knowledge.ts`).
- **Lazy retrieval**: agent tools (`knowledge_search`, `knowledge_get`) never bulk-ingest remote content. Drive defaults to the `drive.file` OAuth scope, `remote_search` policy, and **zero remote cache** (`cachedBytes`, `cachedChunks`, `cachedDays` all 0). The cache invariant is asserted via `GET /api/knowledge/sources/:source` telemetry.
- **Attachments** attach only to local Knowledge documents — file parents are wired through the manifest's `entities.document.fileParent` block; linked source identities do not get Liaison attachments.
- **Agent tools** use lazy retrieval and return remote content as `untrusted: true` citation blocks to mitigate prompt injection. When `knowledge_search` returns zero authorized hits or `knowledge_get` resolves to an unavailable target, a deduped `knowledge_review` attention item with `reason: "agent_requested"` is emitted for curator review.
- **Observability**: `knowledgeLogger` emits one structured log per source per query with `{ orgId, source, state, durationMs, hitCount }`. Query text and body content are intentionally omitted.
