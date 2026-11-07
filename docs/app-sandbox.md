# App Sandbox Architecture

> **Building an app?** This document covers the sandbox runtime internals. If
> you want to *write* a Liaison app, start with
> [`docs/app-development.md`](app-development.md) — the end-to-end developer
> guide (scaffold → develop → freeze → install). Come back here when you need to
> understand how the runtime isolates your handlers.

The app sandbox provides secure, isolated execution for app code — both backend handlers (tools, events, jobs, webhooks) and frontend UI panels. App code runs in a constrained environment with no direct access to the host process, database, or file system. All capabilities are mediated through typed bridges.

---

## Backend: QuickJS WASM Sandbox

App handler code runs inside **QuickJS** compiled to WebAssembly via `quickjs-emscripten`. This provides process-level isolation — app code cannot access Node/Bun APIs, file system, network, or shared memory.

### Pool Architecture

```
Process startup
  └─ initSandboxPool()
       └─ N pre-warmed slots (default: 4, max: 12)
            Each slot = 1 WASM module + 1 Runtime + 1 Context
```

**Files:** `modules/apps/sandbox/pool.ts`

Each slot owns its own WASM module instance, not a module shared across the pool. This is a deliberate isolation choice: destroying a timed-out runtime that still has live GC objects (in-flight bridge promises) trips a QuickJS assertion and emscripten-aborts the module, and an aborted module wedges every subsequent execution in the process until restart. Per-slot modules contain an abort to the one slot; the rest of the pool keeps serving. Each slot's runtime carries an 8MB memory limit and a context. The pool pre-warms slots at startup and grows on demand up to `maxSize`, a hard concurrency ceiling kept comfortably below the database pool size (every running sandbox execution can hold one RLS transaction).

| Operation | What happens |
|-----------|-------------|
| `acquire()` | Pop from available stack, create a new slot if below the ceiling, or queue with a bounded wait if at the ceiling |
| `release(slot)` | Dispose context, create fresh context on same runtime, push back |
| `destroy(slot)` | Drop all references (no native runtime dispose, to avoid a WASM abort), schedule async replacement slot |

At the ceiling (default max 12), `acquire()` queues the caller with a bounded wait (default 15s) and fails fast if no slot frees up in time, rather than spawning overflow slots beyond the ceiling.

### Execution Flow

**Files:** `modules/apps/sandbox/executor.ts`

```
HTTP request / event / job
  → executeTool() or sandbox dispatch wrapper
    → pool.acquire()
    → inject ONE host dispatcher bound to this call's bridge (async methods return QuickJS promises)
    → build __ctx from a constant shim + this call's method names (data, not code)
    → evalCode(bundleSource)                      ← parse + compile handler bundle
    → evalCode(handler(params, __ctx))             ← start handler (sync return)
    → if result is a QuickJS promise:
        → resolvePromise() awaits bridge calls     ← host resolves bridge promises via IPC or direct call
        → executePendingJobs() resumes QuickJS     ← handler continues after each bridge call
    → dump result from QuickJS → JS
    → pool.release()
```

Each invocation gets a **fresh context** — no state leaks between calls. The handler bundle is re-evaluated every time (no cached module state). The bundle file's text is checked against the file on every load, so an app reinstalled at the same version runs its new code at once, without a restart. For a trusted app's attention provider the bundle evaluated is the part the provider needs, tree-shaken once per bundle version (`modules/apps/sandbox/bundle-shake.ts`): source text derived from the bundle alone, never evaluated state. Timeout enforcement uses `runtime.setInterruptHandler()` polling against a deadline (default: 5s in production, 60s in development, overridable via `LIAISON_SANDBOX_TIMEOUT_MS` in non-production; production ignores the override).

**Bridge call pattern:** Bridge functions use QuickJS native promises (`ctx.newPromise()`) rather than WASM asyncify. When a handler calls `ctx.db.findMany(...)`, the bridge function creates a QuickJS promise, queues the async host work, and returns the promise handle. The host resolves the promise when the work completes, then `executePendingJobs()` resumes the QuickJS event loop. This works reliably across event loop boundaries — including IPC to worker subprocesses.

**Marshalling:** Complex values cross the WASM boundary via JSON serialization. Bridge return values are marshalled back into QuickJS handles (strings, numbers, booleans natively; objects/arrays via `evalCode("(" + json + ")")`).

### RPC Bridge

**Files:** `modules/apps/sandbox/rpc-bridge.ts`

The bridge is the **only** interface between sandbox code and the host. It exposes a constrained set of operations, each validated against the app's manifest declarations.

```
Sandbox code (QuickJS)          Bridge (host)              System
─────────────────────           ─────────────              ──────
ctx.db.findMany("items", opts)  → validate entity in manifest
                                → validate field types
                                → txDb.select(...)          → PostgreSQL (RLS-enforced)
                                → return rows

ctx.emit({ entity, action })    → validate against manifest.events.emits
                                → tx.queueEvent(...)        → outbox table

ctx.fetch(url, opts)            → validate domain against allowlist
                                → native fetch(url)         → external HTTP

ctx.connections.getToken(conn)  → look up encrypted token   → decrypt + return
```

**Available bridge methods (non-exhaustive; see `rpc-bridge.ts` for the authoritative list):**

The bridge surface is large and grows as apps need new host capabilities. Core categories:

| Category | Methods |
|----------|---------|
| Identity | `getUserId()`, `getOrgId()` |
| Database | `db_findMany` (equality `where`, plus `{ col: { in: [...] } }` for a set lookup, up to 1000 values), `db_findOne`, `db_insert`, `db_update`, `db_updateMany`, `db_delete`, `db_count` |
| Events | `emit(event)` — declared emits only |
| Jobs | `enqueueJob(name, payload)` |
| Contacts | `resolveContact(params)` (not the mail app: its host page write `mail_writePage` resolves senders under the mailbox's ownership, see `modules/mail/page-write.ts` and `sender-contacts.ts`) |
| Network | `fetch(url, opts)` — domain allowlist enforced |
| Connections | `connections_getToken(connName, identifier?)`, `connections_getAccounts(connName)`, `connections_describe(connName)` (owner, connected by, health, token expiry, whether a refresh token is stored; no secrets), `connections_getCredentials`, `connections_disconnect` |
| Logging | `log_info`, `log_warn`, `log_error`, `log_debug` |
| Config | `config_get(key)` |
| Files | `files_importAttachment`, `files_listAttachments`, `files_getAttachmentBytes`, `files_attachToParent`, `files_reparent`, `files_analyzeDocument` (capability `files.analyzeDocument`: reads one of the app's own PDFs or images with the workspace's media analysis model, answering the app's prompt; credits apply, and an admin can turn the `apps` media surface off) |
| Bulk data | `bulk_fetchToBlob`, `bulk_iterateJsonl_next`, `bulk_deleteBlob` — streaming helpers for large payloads |
| Approvals | `approval_recordStarted`, `approval_recordEffectLanded`, `approval_recordSucceeded`, `approval_recordFailedNoEffect`, `approval_recordAmbiguous` |
| Agents | `agent_run`, `agent_spawn`, `agent_awaitRun` |
| Cross-app tools | `executeTool` — one app calling another app's declared tool |
| Discussions | `threads_deleteEntityDiscussion({entityType, entityId})` — after deleting one of the app's own records that declares a discussion, removes that discussion (an empty shell stays where an approval was asked in it). Refused with `discussion_not_declared` for a type without one, and with `entity_still_exists` while the record still reads in the handler's transaction or still exists for people the caller cannot see it for. `threads_pruneEntityDiscussion({entityType, entityId})` — after a record's sharing narrows, takes everyone but the caller out of its discussion; whoever still sees the record is seated again when they open it |

A tool reached through `executeTool` runs with the target app's own access plus the calling app's. So it can read a file the calling app stored on one of its own records (with `files_importAttachment`) and handed over by id, for example as `attachments` to `tickets:addNote`, and nothing the calling app cannot read. The target app copies such a file onto its own record under its own write access, not the caller's. A file copied by a webhook or job, which has no user, records no uploader.

A file an app stores with `files_importAttachment` or `ctx.pdf.render` counts toward the organization's storage limit. When the call acts for a person or an agent and the organization is at its limit, it fails with `STORAGE_QUOTA_EXCEEDED` and nothing is stored. A call the server runs on its own (a webhook, a sync job, with no agent acting), and a file stored on a record of an `immutable` table with `retentionYears` (a legal record), is stored anyway and counted. The host decides this from its own view of the call and from the installed manifest; the app cannot pass a flag for it.

Individual apps can also register their own bridge methods through the bridge extension registry (`bridge-extensions.ts`), which is how per-app surfaces like the calendar, SMTP, IMAP, PDF, and messaging bridges are added without growing the core bridge file. The Mail app's IMAP methods are `imap_fetch` (INBOX or Sent, with the INBOX membership and flag read-back) and `imap_writeBack` (read, star, archive and trash on the server, a batch of up to 15 conversations in one session); `imap_writeBack`, like `smtp_send`, is refused to a read-only execution. After an `smtp_send` from an IMAP mailbox, the host files a copy in its Sent folder (`imap-mailbox.ts`). A built-in app's TypeScript descriptor can also carry `_registerHostTools(orgId)`: host-side tools registered under the app at each registration and removed with it, for a tool a manifest cannot declare (an approval decided by a scope other than `<app>:approve`, as the API connector's adapter save and restore are). An installed `.liaisonapp` cannot use it.

### Performance Characteristics

| Metric | Value | Notes |
|--------|-------|-------|
| Warm invocation | ~0.4ms | Pre-warmed slot, trivial handler. Production hot path |
| Cold start | ~78ms | WASM module compilation. Happens once at boot |
| Context reset | ~0.38ms | dispose + newContext FFI. Runs on every release |
| Memory (per slot) | ~20MB | Each slot owns its own WASM module instance; not shared |

Real-world tool calls are dominated by bridge operations (DB queries, HTTP), not sandbox overhead. A DB-backed tool typically takes 2-10ms total, of which ~0.4ms is sandbox framing.

---

## Security Model

### Trust Boundaries

```
                    ┌─────────────────────────────┐
                    │        App Sandbox           │
                    │    (QuickJS WASM, 8MB cap)    │
                    │                              │
                    │   No FS, no network, no Bun  │
                    │   Only __ctx bridge methods  │
                    └──────────┬───────────────────┘
                               │ RPC bridge
                    ┌──────────▼───────────────────┐
                    │      Bridge Validation        │
                    │                              │
                    │  Entity in manifest?          │
                    │  Fields match declared types? │
                    │  Event in declared emits?     │
                    │  Domain in allowlist?         │
                    │  Connection declared?         │
                    └──────────┬───────────────────┘
                               │
                    ┌──────────▼───────────────────┐
                    │      RLS / Kernel Layer       │
                    │                              │
                    │  org_id enforced per query    │
                    │  Dimension-based row filter   │
                    │  App schema isolation         │
                    └──────────────────────────────┘
```

### Tool Execution Guards

Enforced in `execute-tool.ts`, in this order:

1. **Trust boundary** — `internal` (system only), `agent` (agent/system), `user` (all). Architectural restriction, not prompt-based.
2. **Scope check** — Actor must hold the tool's declared scope (`app:resource:action`). Hierarchical: `app:resource` grants all child actions.
3. **Taint escalation** — If a thread is tainted (a `taintSource` tool was previously called) and the current tool has a `trustBoundary`, execution is blocked. Creates an approval request; human must approve.
4. **Gated check** — Tools marked `gated: true` always require human approval before execution.
5. **Parameter validation** — AJV (manifest) or Zod (legacy) schema validation.
6. **Output validation** — Result checked against declared return schema.
7. **Response filtering** — Dimension grants filter result rows before returning.

### Database Isolation

Each app gets its own PostgreSQL schema (`app_<name>`). All queries from sandbox code run through the RLS-scoped transaction (`liaison_rls` role). RLS policies enforce:

- `org_id = rls_ctx.org_id()` (the transaction's org, which SQL inside it cannot change) on every operation
- Dimension-based row filtering when declared in the app schema

Apps cannot query other apps' tables or the kernel schema through the bridge.

### Network Isolation

Sandbox `fetch()` validates the target domain against a combined allowlist:
- `manifest.network.allowedDomains` — global list
- `manifest.connections[connName].allowedDomains` — per-connection list

Subdomain matching: `*.example.com` accepts `api.example.com` but not `example.com` itself. Requests to unlisted domains are rejected before any network call is made.

Every target must be public and use HTTPS: a hostname that resolves to a private, loopback, link-local or metadata address is refused, checked against the address actually connected to and again on every redirect.

**Private services on the deployment's own network.** A self-hoster whose app talks to a service next to Liaison (a container on the same compose network, a host on the private LAN) lists it in `LIAISON_APP_PRIVATE_HOSTS`: comma-separated exact hosts, `host` or `host:port` (for example `kpi-service:8787`). Empty by default. A listed host may be reached over plain HTTP and may resolve to a private or loopback address; the app's manifest must still list it in `allowedDomains`, link-local and metadata addresses stay refused, and a redirect to a host not on the list gets the public-HTTPS rule again. List only services you run and trust: every installed app whose manifest names the host can reach it.

**An organization's custom app (managed edition).** It is one tenant's code on a server shared with others, so on top of the rules above: `LIAISON_APP_PRIVATE_HOSTS` never applies to it, and it never reaches the server itself, neither by name (the host of `BASE_URL`, of each `ALLOWED_ORIGINS` entry, and every organization host of `LIAISON_ORG_HOST_TEMPLATE`) nor by address (`LIAISON_CELL_PUBLIC_ADDRESSES`: the server's own public IPv4 and IPv6 addresses, comma-separated; traffic from a host to its own public address skips the cloud firewall). The address check runs on the address actually connected to and on every redirect, so a name that resolves to the server is refused too. Keep services off `0.0.0.0` on the host all the same.

### Token Security

OAuth access/refresh tokens and credential secrets are encrypted at rest with `ENCRYPTION_KEY`. The bridge returns decrypted tokens to sandbox code on demand (`connections_getToken`). Tokens never appear in API responses — the client-facing DTO (`ConnectedAccountDto`) explicitly excludes all encrypted fields.

---

## Connected Accounts

**Files:** `modules/apps/connections/service.ts`, `modules/apps/connections/routes.ts`

Apps declare connections in their manifest with provider type (`oauth2` or `credentials`), OAuth URLs, scopes, and allowed domains.

### OAuth Flow

```
Frontend                    API                          Provider
────────                    ───                          ────────
POST /connections/:app/:conn/authorize
                            → Generate PKCE verifier + S256 challenge
                            → Store state in Redis (15min TTL)
                            ← { redirectUrl }
redirect to provider ──────────────────────────────────→ /oauth/authorize
                            ← callback with code + state
GET /connections/callback
                            → Validate state (Redis, single-use)
                            → Exchange code + PKCE verifier for tokens
                            → Encrypt tokens, store in DB
                            ← redirect to app
```

### Credential Connections

```
POST /connections/:app/:conn/credentials
  → Validate fields against manifest connection config
  → Encrypt credentials
  → Store in connected_accounts table
```

### Token Lifecycle

- Tokens checked for expiry on each `getToken()` call
- Refresh window: 2 minutes before expiry by default; connections may configure a wider `refreshWindowMs` (for example, long-lived tokens like Instagram's 60-day tokens)
- On refresh: exchange refresh token, update encrypted storage
- Failed refresh: mark account status `"error"` with message

---

## Frontend: Panel Hosting

### Architecture (Three Layers)

```
Layer 1: app-registry.ts    Pure registry. Stores tab types, panels, commands,
                             keybindings, activity bar, slots, contributions.
                             Zero domain imports.

Layer 2: define-app.ts      App contract. registerApp() / unregisterApp().
                             registerAppFromManifest() for manifest-format apps.
                             Tracks registered primitives for teardown.

Layer 3: bootstrap.ts       Leaf module. Registers kernel apps (home, thread,
                             settings). Imports domain stores. Called once at
                             startup. Nothing imports from it.
```

Import rule: Layer N imports only from layers < N.

### Panel Rendering

Apps register panels via `registerPanel(id, { component })`. The Shell renders the active panel:

```tsx
<Show when={activePanel().type === "app-panel"}>
  <Dynamic
    component={getPanel(namespaceRegistryKey(appName, panelType))?.component}
    context={activePanel().context}
  />
</Show>
```

Panels receive a `context` prop for app-specific state. When no app panel is active, the right rail is closed: conversation lives in the chat dock, never in a panel.

### Trust Tiers (Not Yet Implemented)

Frontend apps will be classified by trust tier, determining their rendering strategy:

| Tier | Rendering | Use case |
|------|-----------|----------|
| **Kernel** | Direct SolidJS components, same process | Built-in kernel modules |
| **Trusted** | Direct components, registered via manifest | First-party apps (Mail, Contacts) |
| **Sandboxed** | iframe with postMessage bridge | Third-party / user-installed apps |

The iframe bridge (`@liaison/app-ui`) provides a constrained API:

```typescript
// Inside iframe
const bridge = createIframeBridge(channel)
bridge.openTab("ticket", "ticket-123", "Bug Report")
bridge.showToast("Saved!", "success")
bridge.closeTab()
```

Communication uses structured `postMessage` with request/response correlation and origin validation. The iframe has no access to the parent DOM, stores, or API client.

### The record a framed page has open

`app.trackOpenRecord(entityType, id)` works in a frame too: it sends the frame call `setOpenRecord` to the page, which keeps it for the tab that frame sits in and drops it when the frame goes away. A frame can only name an entity of its own app.

### Interface trust today

In the desktop app the page also holds the shell's bridge (local sessions, files, the node), so no server-delivered `ui.js` runs there on the server's word. A first-party app the server lists as `signed: true` (`/api/apps/manifests`) runs in the page only after the desktop shell verified it (see [Signed first-party artifacts](app-package-format.md#signed-first-party-artifacts)): the shell fetches `ui.js`, `statement.json`, `statement.sig` and `manifest.json` from the bound server itself, checks them in Rust against the keys compiled into it, and serves the bytes it checked on its own `liaison-app:` scheme by sha256 (`apps/desktop/src-tauri/src/verified_apps.rs`), the only script source the window's policy adds; the page imports that URL and registers the app from the signed manifest, and runs the app framed when the API's manifest disagrees with it (`apps/web/src/framework/verified-app.ts`). Any refusal or load failure also runs the app framed. Every other installed app's interface, and every app in the mobile app, runs in a sandboxed iframe on the shell's own `liaison-frame:` scheme (`sandbox="allow-scripts allow-forms"`, an opaque origin, no shell bridge, no network of its own). The page fetches the bundle and hands it to the frame, and the frame reaches Liaison only through `@liaison/host` calls the page answers for that app (`fetch` on kernel paths, its own tools, connection flows, in-app navigation, entity changes, toasts; `createIframeBridge` toasts and `openTab` are honoured too). Its icons show a neutral glyph, and it cannot register entity previews or app hooks, mount another app's slot, open files natively or read the token (`apps/web/src/framework/isolated-app.tsx`). A call to a method the page does not offer is answered with an `unsupported` error, so the frame's promise rejects instead of waiting forever. In-app navigation from a frame reaches only the app's own routes (`/<app>` and below), the detail pages of its own entities (`/detail/<app>/...`), its settings page (`/settings/apps/<app>`, which a bare `/settings/apps` also opens) and `/settings/connectors`; any other path, including one a manifest declares as a tab pattern outside the app's own prefix, is refused. The page navigates to the parsed path, never the frame's raw string, and keeps a query or hash only under `/<app>`. A frame never leaves its document for an in-app route: a plain left click (no modifier key) on a link whose `href` starts with `/` (no `target`, no `download`, not already handled by the app) becomes that `navigate` call, and so does the app's own `history.pushState` or `replaceState` to such a path; external links are left alone. The frame's own `location` is its document's, never the page's, so the page sends the frame its path and query on init and on every route change (the `path` message, host API 1.1), and fires `popstate` in the frame; an app reads the page's path with `currentPath()` from `@liaison/host` (which reads the window's location in the page), and re-reads it on `popstate`, to mark its active row or take state from the route. Each view of a framed app is its own frame with its own copy of the app's modules, so state one view hands another travels in the route (a query or an entity id), never in a module-level signal. An app can never be named after a Liaison page route (`login`, `auth`, `settings`, ...; the list is `RESERVED_WEB_ROUTE_SEGMENTS` in `@liaison/shared`), so "its own routes" never include a page that acts on load.

In a browser tab the page holds the signed-in user's session, so the same rule holds there: a first-party app's `ui.js` (the app list marks it `firstParty: true`) is a module the web client imports into its own origin, and every other app's interface runs in the same sandboxed frame as in the shells. The server serves the frame document beside the app's bundle, `GET /api/apps/<name>/<version>/frame` (the active version of a vouched-for app that is not first-party, against the same token as its `ui.js`; 404 otherwise): the shells' frame runtime inlined under a fresh nonce, its policy as a response header (scripts only from that runtime and the bundle the page hands it, `connect-src 'none'`, no frame, no form, `frame-ancestors 'self'`, `sandbox allow-scripts allow-forms`). An outside app's `ui.js` itself is served as `text/plain` (under `nosniff`), so this origin never runs it as a script: the page reads its text and hands it to the frame. A frame that navigates away from its document (a second load) is torn down at once, and the page posts nothing more to it. A frame mounted after its URL token has nearly expired asks the app list for fresh URLs first. The iframe is `sandbox="allow-scripts allow-forms"`, never `allow-same-origin`: an opaque origin with no session cookie, no storage and no API of its own, reaching Liaison only through the frame protocol (`apps/web/src/framework/isolated-app.tsx`, `apps/api/src/modules/apps/app-frame.ts`).

An installed app's interface is listed and served only when someone accountable vouched for those exact bytes:

- **first-party**: the install is the image's own catalog artifact, byte for byte;
- **publisher-signed**: the package carried a cosign bundle that verified against the operator's `LIAISON_TRUSTED_APP_PUBLISHERS`;
- **admin-approved**: an admin ticked "this app's interface runs inside Liaison with full access to your session" at install or upgrade, or later in Settings > Apps (recorded on the install row and on the audit timeline; a new version needs a new approval).

Otherwise the app still installs and its backend still runs in the sandbox, but its interface is neither listed nor served. A non-first-party bundle is fetched with a short-lived token bound to the app and version, handed out by the authenticated app list.

A first-party app the image took from the signed release (see [signed first-party artifacts](app-package-format.md#signed-first-party-artifacts)) also has its statement served beside the bundle, `GET /api/apps/<name>/<version>/statement.json` and `.../statement.sig`, under the same checks as `ui.js` and only for a first-party install; the app list marks it `signed: true`. Every other app answers 404 there.

An app from outside Liaison (anything but the image's own catalog artifact) cannot pass for Liaison or a first-party app. Install refuses it when a label the shell shows for it (name, display name, rail entry, tabs, panels, contributions, slot panels, settings section titles) reads as a Liaison page or a first-party app, compared by a confusable skeleton (case, spacing, punctuation, accents, invisible characters and Cyrillic, Greek or digit look-alikes aside); when a catalog key it names (`labelKey`, `titleKey`, ...) is not its own (`apps.<name>.`, or the `kernel.appSettings.<name>.` and nav keys the catalog holds for an app of that name); and when its `author` or `listing.publisher` claims Liaison or a first-party publisher. The App store shows any other app's publisher as self-declared.

Capabilities (`messages.post`, `grants.setUserScopes`, ...) and other apps' tools an app may call (`cross_app_calls`, and the legacy `dependencies.tools`) are part of the admin's grant like scopes: the install dialog lists them, every declared one must be granted, the runtime keeps only what was granted, and an upgrade that adds one asks again. Database triggers are accepted only from first-party or publisher-signed packages, and their bodies are statically reviewed.

### Frontend SDK

**Package:** `@liaison/app-ui`

| Export | Purpose |
|--------|---------|
| `createDirectBridge(shell)` | For trusted components — direct store access |
| `createIframeBridge(channel)` | For sandboxed components — postMessage protocol |
| `AppUIContext` type | `openTab`, `closeTab`, `showToast` |

---

## Backend SDK

**Package:** `@liaison/app-sdk`

Provides typed helpers for writing app handlers:

```typescript
import { defineHandlers, s } from "@liaison/app-sdk"

export const { listItems, createItem } = defineHandlers({
  listItems: async (params, ctx) => {
    return ctx.db.findMany("items", { limit: 50 })
  },
  createItem: async (params, ctx) => {
    const item = await ctx.db.insert("items", params)
    await ctx.emit({ entity: "items", action: "created", entityId: item.id })
    return item
  },
})
```

**`ctx` (AppContext):**

| Property | Type | Description |
|----------|------|-------------|
| `userId` | `string` | Current actor |
| `orgId` | `string` | Current organization |
| `db` | `DbClient` | `findMany`, `findOne`, `insert`, `update`, `updateMany`, `delete`, `count` |
| `emit(event)` | `Promise<void>` | Emit declared event |
| `enqueueJob(name, payload)` | `Promise<void>` | Dispatch async job |
| `resolveContact(params)` | `Promise<unknown>` | Contact lookup |
| `connections` | `Record<string, ConnectionClient>` | `getToken()`, `getAccounts()` |
| `fetch(url, opts?)` | `Promise<Response>` | Domain-restricted HTTP |
| `logger` | `Logger` | Structured logging (`info`, `warn`, `error`, `debug`) |

**`s` (Schema builder):** Utility for declaring entity field types in manifests.

---

## App Registration & Lifecycle

**Files:** `modules/apps/runtime.ts`, `modules/apps/app-registries.ts`

### Registration Flow

```
Server startup / ensureAppsForOrg(orgId)
  → Load app descriptors (in-tree + manifest-format)
  → resolveAppOrder() by dependencies
  → For each app:
      1. Validate manifest/descriptor
      2. Transaction: if the app schema already carries the current DDL stamp,
         write only this org's rows (kernel.apps, settings defaults, roles);
         otherwise take the schema's advisory lock (serializes concurrent DDL),
         create/update the app schema, tables, RLS policies, and stamp it
      3. Post-transaction: populate in-memory registries
         (tools, events, jobs, webhooks, views, panels, connections)
```

The DDL stamp (a comment on the app schema) is a digest of everything the
schema DDL is derived from: the manifest (schema, entities, RLS mode, roles,
settings), the install's trust flags, the registration code, the runtime roles
that exist, the schema's shareable tables and the applied migrations. A restart with no app, code or migration
change therefore takes no DDL lock on the app tables every org shares, and an
upgrade runs the DDL once, for the first org that registers the new version.
That DDL gives up a table lock it cannot take within 500 ms and retries (also
after a deadlock), so readers never queue behind it; a server's last attempt
waits for its locks. A schema object changed by hand is repaired at the next
stamp change, except a dropped table or column, which the probe detects.

### Set up an org on first use

Each process keeps its own registries, so each process sets up an org's apps
the first time it needs them. A process sets up no org when it starts, so its
start time does not grow with the number of orgs.

Anything that touches an org this process has not set up yet sets it up first
and waits for it. That covers an authenticated request, an MCP request, a
WebSocket connection, a background job, the outbox, an event handler that
writes, an OAuth sign-in callback, the attention state refresh and a search
reindex. A process sets up at most half its privileged database pool's size
in orgs at once (5 on an api's pool of 10, never more than 8); only an app
registration that has to change the app's schema (the DDL above) waits for the
others, so after an upgrade every org but the first writes its rows beside the
others' setups. An
unknown or deleted org id is skipped. When the outbox cannot set an org up, that
org's events stay in the queue, unprocessed, and are tried again after a
growing delay; other orgs' events go on.

An inbound webhook (`/webhooks/<orgId>/...`) sets up its org too, once the
lookup finds that the org exists. The first webhook for an org a process has
not set up yet therefore waits for that setup. If the setup fails, the error is
logged and the webhook route answers as it would anyway.

### Skip setup writes when nothing changed

An org's setup has two halves:

- the in-memory registries, filled in every process;
- the org's rows (`kernel.apps`, settings defaults, roles), followed by the
  setup hook that adds the default saved views.

The second half runs only when the org's setup stamp is stale. The stamp
(`kernel.organizations.app_setup_stamp`) is a hash of:

- the build, `LIAISON_VERSION`;
- every app the org gets, with its version.

The Google sign-in provider (from `GOOGLE_OAUTH_CLIENT_ID` and
`GOOGLE_OAUTH_CLIENT_SECRET`) is not part of the stamp. It is checked at every
first setup of the org in a process, whatever the stamp, and written only when
the stored provider differs. A rotated client secret, or a provider an
administrator deleted or edited, is restored at the next process start.

A role an app's manifest declares, deleted by an administrator, comes back
only when the stamp changes: a new `LIAISON_VERSION` or a new version of one of
the org's apps. This is intended. While the stamp matches, setup writes no
roles.

A setup also writes when one of the org's apps is in error, or when an app's
`kernel.apps` row is not at the expected version. The stamp is written only
after every app registered and the setup hooks ran. A failed app leaves it
unwritten, so the next setup tries again.

When `LIAISON_VERSION` is unset (`dev`), the build part changes at every process
start: each restart re-runs the writes once per org, as before the stamp
existed. To keep the stamp across restarts, build the image with
`--build-arg LIAISON_VERSION=<build id>`.

One org's writes are serial across processes, under that org's `org-setup`
advisory lock. A process that finds a stale stamp takes the lock, reads the
stamp again, and skips the writes when another process has just set the org up.
Different orgs set up side by side, so after an upgrade the first requests of
many orgs do not wait on each other.

### Registry System

All registries are in-memory, keyed by `[orgId, appName, ...]`. Each process fills its own, org by org, the first time it needs the org (see "Set up an org on first use" above).

| Registry | Key | Stores |
|----------|-----|--------|
| `toolRegistry` | `[orgId, app, tool]` | Handler (fn or manifest ref), scope, params, trust boundary |
| `webhookHandlers` | `[orgId, app, endpoint]` | Handler + verification function |
| `connectionConfigRegistry` | `[orgId, app, conn]` | OAuth config, credential fields |
| `dimensionDefRegistry` | `[orgId, app, dim]` | Dimension type + values |
| `entityRegistry` | `[orgId, app, entity]` | Card display metadata |
| `manifestRegistry` | `[orgId, app]` | Frontend manifest for panel/tab registration |
| `declaredEmits` | `orgId:app` → Set | Allowed event keys |
| `contributionRegistry` | `[orgId, slot]` | Cross-app slot contributions |

### Handler Dispatch

Tools have two handler formats and two execution paths:

```typescript
// Legacy (direct function — kernel apps): runs in-process, no sandbox
handler: (params, ctx) => Promise<result>

// Manifest (sandboxed — bundled apps): runs in QuickJS sandbox
handler: { bundlePath: string, exportName: string, trusted?: boolean }
```

The `trusted` flag determines which sandbox path is used:

| Trust level | Execution path | Isolation | Bridge calls |
|-------------|---------------|-----------|-------------|
| `trusted: true` (default) | In-process QuickJS pool | WASM-level (same process) | Direct — host functions called in-process |
| `trusted: false` | Worker subprocess pool | OS process-level | IPC-proxied — full RPC bridge via IPC round-trip |

Event subscribers, job handlers, and webhook handlers follow the same pattern — manifest-format handlers are wrapped in sandbox dispatch functions that call `executeInSandbox()`.

An app's event subscription runs once per event, in the process that published the event, however many server processes run. Other processes do not run it again for their copy of the event.

A trusted app's cross-app or system event handler, and its approval poll, run with privileged database access. They act as the app: a scope check in the database (allocating a task number, say) reads the scopes the app's manifest declares (`scopes`), and refuses a scope the app does not declare. An app nobody vouched for runs the same handlers under its own row-level security instead.

---

## Process Isolation: Worker Subprocess Pool

**Files:** `modules/apps/sandbox/sandbox-worker.ts`, `modules/apps/sandbox/worker-pool.ts`

For untrusted (third-party / user-created) apps, handler execution runs in separate OS processes. If a worker crashes (OOM, WASM trap, C-level bug in QuickJS), only that worker dies — the main process and all other workers continue unaffected.

### Architecture

```
Main Process (HTTP, WS, events — never runs untrusted app code)
  │
  ├─ Worker 0 (separate PID, long-lived)
  │    └─ QuickJS WASM module (loaded once)
  │    └─ Communicates via Bun IPC (JSON round-tripped for safety)
  │
  ├─ Worker 1
  │    └─ same
  │
  └─ Worker N (spawned on demand up to maxSize)
       └─ same
```

### Execution flow

1. Main process calls `workerPool.execute({ bundleSource, exportName, params, bridge })`
2. Pool picks a free worker (or spawns one, or queues the request)
3. Worker receives `execute` message via IPC, creates a fresh QuickJS runtime+context
4. Worker evaluates the handler bundle, calls the export function
5. Worker sends `result` message back to main process
6. Pool resolves the caller's promise with the result
7. On crash: pool detects the exit, rejects the pending request, spawns a replacement

### Bridge calls over IPC

Both the in-process and worker subprocess paths use the same bridge pattern: QuickJS native promises (`ctx.newPromise()`) resolved by the host. Bridge functions return a QuickJS promise handle immediately; the host resolves it when the async work completes (DB query, event emission, network fetch); `executePendingJobs()` resumes the QuickJS handler.

For in-process execution, bridge functions are called directly. For worker subprocesses, bridge calls are proxied over IPC:

```
Worker: handler calls ctx.db.findMany("items")
  → bridge function creates QuickJS promise
  → sends IPC: { type: "bridge_call", callId, method: "db_findMany", args: ["items"] }
  → main process calls the real bridge function (DB query via RLS)
  → sends IPC: { type: "bridge_result", callId, data: [...] }
  → worker resolves QuickJS promise with the result
  → executePendingJobs() resumes the handler
```

All bridge methods work identically in both paths — DB, events, jobs, contacts, network, connections, logging.

### Pool configuration

```typescript
const pool = new SandboxWorkerPool({
  size: 4,       // Pre-spawned workers (default: 4)
  maxSize: 8,    // Max workers including overflow (default: 8)
  memoryLimitBytes: 8 * 1024 * 1024,  // Per-runtime QuickJS limit (default: 8MB)
  timeoutMs: 5000,                     // Per-invocation timeout (default: 5s in production, 60s otherwise)
})
```

Background work (jobs, webhooks, event handlers) may hold at most `maxSize` minus the workers reserved for interactive calls (`APP_WORKER_POOL_RESERVED_INTERACTIVE`, default 1). Within that, one app's jobs hold at most half of it (rounded up), so a flood of slow jobs of one app, such as many mailbox syncs waiting on slow mail servers, leaves the rest to other apps' background work. A job runs within its manifest `timeoutMs` (60 s when unset), not the 5 s default of a tool call.

**Each organization's share (managed edition).** The executions of one organization's custom apps (tools, webhooks, event handlers, jobs, every other handler; the app name's organization key decides) hold at most 2 workers at once. Up to 8 more wait their turn for up to 5 s, and past that the call is refused with `SandboxTenantBusyError` (429 `custom_app_busy`, `Retry-After: 5`). A nested call (a custom app's tool calling another tool) is not counted again: its caller already holds the share. Catalog, in-tree and instance apps keep the rules above. A custom app's webhook also has a budget of 120 deliveries a minute per organization and app, checked before its `verify` runs (429 `custom_app_rate_limited`). The pool's `tenantStats()` shows each organization's executions in flight and waiting.

**Its bulk downloads (managed edition).** `ctx.bulk.fetchToBlob` of a custom app writes to its own directory (`custom--<org>--<app>` under `BULK_BLOB_DIR`), limited to 256 MiB per app and 4 GiB for all custom apps on the server together; a download not written or read for an hour is deleted by a sweep, and the organization's deletion removes them all.

**The operator's kill switch.** `PUT /api/cloud/orgs/:id/custom-apps/:name/state` (signed by the control plane, `{orgId, name, disabled, reason?}`) disables one organization's custom app: its rows, files and data stay, `apps_installed.disabled_at` makes the tenant boundary refuse it on every dispatch path (its own organization included), its schedulers and registrations go, and its owner can neither upgrade nor uninstall it (409 `custom_app_disabled`). `disabled: false` enables it again. Both are written to the organization's audit log (`app.custom.disabled`, `app.custom.enabled`) with the reason.

**Where its interface runs.** A custom app is never first-party, so its `ui.js` is served as text and runs only in the sandboxed frame (opaque origin, `connect-src 'none'`, no session, no storage, no cookies), reaching Liaison through the frame protocol for its own calls, like any outside app.

### Import transform pool

Import transforms (agent- or admin-written scripts that turn an export into
import records) run on their own `SandboxWorkerPool`, never the app pool: 2
workers by default (`LIAISON_TRANSFORM_POOL_SIZE`, at most 8), a 32 MiB heap,
background priority only, and a per-call budget of 30 s
(`LIAISON_TRANSFORM_CALL_BUDGET_MS`, capped at 120 s). A transform's `ctx` has
four host methods (`emitRecords`, `declareFile`, `downloadToFile`, `apiGet`)
and none of the app bridge methods. An execution can ask the worker for its
QuickJS heap high-water mark (`onHeapReport`); the import engine uses it to
check each batch against the heap limit.

### Crash recovery

| Scenario | Behavior |
|----------|----------|
| Handler throws | Worker sends error, stays alive for next request |
| QuickJS OOM | Worker sends error (may survive or abort depending on gc state) |
| WASM trap (abort) | Worker process exits, pool spawns replacement, caller gets error |
| Worker unresponsive | Pool kills worker after `timeoutMs + 2s` grace, spawns replacement |
| All workers busy | Requests queued, processed as workers become free |

In production, an untrusted handler's own error message stays hidden from the
caller ("Tool execution failed"), with one exception: when the failure follows
an upstream error answer (its last `ctx.fetch` got a 4xx or 5xx) and the handler
threw its own error (a connector client's typed error, a plain `Error` with a
sentence, anything but a runtime crash such as `TypeError` or `SyntaxError`),
the caller gets that message, so the agent can tell the user the upstream's
reason and the fix. It is sanitized first: tokens, keys, emails and long hex
strings are masked, URLs lose their credentials and query strings, and it is
cut at 800 characters (`sanitizeAppUpstreamMessage`). A runtime crash after an
upstream error answer instead names the connection whose credentials or token
the handler last read, and the host and HTTP status of its last `ctx.fetch`,
never the path, query or body: a connection whose base URL went stale shows up
as, for example, "Tool execution failed after the connection 'erp/erp' (main)
called erp.example.com, which answered HTTP 404". A warn log line names the
same in both cases (`apps/api/src/modules/apps/sandbox/upstream-trace.ts`).

### Tiering model (Phase 14+)

With process-level workers, hard resource limits can be enforced per trust tier:

| Tier | Memory limit | Timeout | Pool allocation |
|------|-------------|---------|-----------------|
| Kernel / first-party | 8MB (in-process) | 5s | In-process pool (no subprocess overhead) |
| Verified apps | 16MB | 10s | Shared worker pool |
| Community apps | 8MB | 3s | Shared pool, lowest priority |

Per-invocation memory profiling is available via `runtime.computeMemoryUsage()` — called after each handler execution for usage dashboards, tier enforcement, and abuse detection.

---

## Context Hardening

Every QuickJS context (both in-process and worker) is hardened before app code runs:

1. **TypedArray removal** — `ArrayBuffer`, `SharedArrayBuffer`, `DataView`, and all typed array constructors (`Uint8Array`, `Float64Array`, etc.) are deleted from `globalThis`. These bypass QuickJS's malloc tracking and allocate directly in WASM linear memory, which could OOM the host process.

2. **Memory limit** — `runtime.setMemoryLimit(8MB)` enforces a ceiling on QuickJS's own allocator. Strings, objects, and arrays are tracked. An OOM produces a catchable `InternalError`, not a process crash.

3. **Stack size limit** — `runtime.setMaxStackSize(256KB)` prevents infinite recursion from exhausting the WASM call stack.

4. **Interrupt handler** — polls `Date.now()` against a deadline. Infinite loops are terminated with a catchable `InternalError`.

App handlers have full access to standard JS (objects, arrays, strings, JSON, Math, Date, RegExp, Promises) — only the unsafe allocation primitives are removed.

---

## Horizontal Scaling Considerations

Liaison can run as several processes on one Postgres and Redis, each with a
role (`LIAISON_ROLE`: `all`, `api` or `worker`). See
[Run several processes](self-hosting/docker.md#run-several-processes).

| Component | Today |
|-----------|-------|
| In-process sandbox pool | One per process |
| Worker subprocess pool | One pool manager per process |
| App registries | In-memory, per process, filled on first use of each org |
| Outbox worker | Drains only in the process holding the Redis leader lease |
| WebSocket manager | Each process holds its own sockets; presence, connections and stream limits are shared in Redis, so several API processes work |

Both sandbox pool types scale naturally: each process keeps its own pools.
