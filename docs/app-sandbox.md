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

Each invocation gets a **fresh context** — no state leaks between calls. The handler bundle is re-evaluated every time (no cached module state). The bundle file's text is checked against the file on every load, so an app reinstalled at the same version runs its new code at once, without a restart. A handler bundle that carries an import attribute (`with { ... }` or `assert { ... }` on an import or export, or options passed to `import()`) fails the version's activation check and is never parsed or built by Bun on the server; the check reads the bundle with the TypeScript parser, which runs no code, so text that only mentions `with {` passes, and a bundle that parser cannot read is refused too. Timeout enforcement uses `runtime.setInterruptHandler()` polling against a deadline (default: 5s in production, 60s in development, overridable via `LIAISON_SANDBOX_TIMEOUT_MS` in non-production; production ignores the override).

**Bridge call pattern:** Bridge functions use QuickJS native promises (`ctx.newPromise()`) rather than WASM asyncify. When a handler calls `ctx.db.findMany(...)`, the bridge function creates a QuickJS promise, queues the async host work, and returns the promise handle. The host resolves the promise when the work completes, then `executePendingJobs()` resumes the QuickJS event loop. This works reliably across event loop boundaries — including IPC to worker subprocesses.

**Marshalling:** Complex values cross the WASM boundary via JSON serialization. Bridge return values are marshalled back into QuickJS handles (strings, numbers, booleans natively; objects/arrays via `evalCode("(" + json + ")")`).

### Run limits and the app contract

One table sets what a run of app code may spend, per kind of entry point (tool, preflight, webhook, webhook verifier, job, event, poll, reconcile, search, export, attention, import, before-disconnect hook, builder preview, import transform, PDF template, summarizer, knowledge source sync page): its wall clock, CPU time, heap, outbound calls and bridge calls (`apps/api/src/modules/apps/run-limits.ts`). Both executors read it. In production a tool, webhook or export gets 5 s unless its manifest declares more (up to 120 s), a job 60 s unless it declares its own, an event handler 30 s, a poll or reconcile 60 s, a search 5 s, a summarizer 5 s, a PDF template 30 s, a before-disconnect hook 20 s, a knowledge source sync page 60 s unless its kind declares its own (up to 120 s); every run gets 30 s of CPU on Workers, 32 MB of heap, and at most 10,000 outbound and bridge calls. A single `ctx.fetch` waits 10 s for a read (`LIAISON_SANDBOX_FETCH_TIMEOUT_MS`, up to 120 s) and up to 30 s for a write.

Every bundled app is checked against the wake-up contract (`apps/api/src/modules/apps/contract/`): each entry point its manifest declares runs twice in one reused isolate, on recorded provider answers, under its production limits. It fails when the second run answers differently from the first (state kept in the module between runs), when a run waits in its own timers for more than 2 s, or when a run goes past its limits. A scan of the app's sources also flags every timer, sleep or poll loop that may wait past 2 s inside a run: wait for something later with a job instead. Known failures are listed in `contract/expected-failures.json`, which may only shrink. An entry with no recorded answers that only rejects the empty input it is given passes without being checked: it is counted per app in `contract/trivial-passes.json`, a count that may only shrink too, and an app keeps the contract only once both its list and its count are empty.

**Lanes: interactive and background runs.** Every run takes one of two lanes, from its kind of entry point (`RUN_LANE_OF_KIND` and `runLaneOf` in `run-limits.ts`, the one place it is decided). Interactive runs are the ones a person or an agent waits on: tools, preflights, webhook verifiers, searches, exports, attention computes, before-disconnect hooks, builder previews, PDF templates, summarizers, page routes and provisioning handlers. Background runs are the ones nobody waits on: jobs, event handlers, polls, reconciles, webhook deliveries, imports, import transforms and knowledge source syncs. A tool call that a routine, a job or another background run makes is background too (its site passes `priority: "background"`). Each executor keeps part of its capacity for the interactive lane, so a burst of long background runs (many half-hourly jobs starting together, each waiting on a provider) never makes a tool call wait: the sandbox service's pool (`SANDBOX_POOL_RESERVED_INTERACTIVE`, see the self-hosting sandbox page), the Workers admission (below) and the QuickJS worker pool (`APP_WORKER_POOL_RESERVED_INTERACTIVE`). Within a lane, runs wait their turn first come first served; an interactive run passes waiting background runs. An interactive run waits until its own deadline. A background run of a job or a knowledge source sync that holds no transaction waits on a clock of its own (`LIAISON_SANDBOX_BACKGROUND_QUEUE_MS`, 10 minutes by default; `runQueueBoundMs` in `run-limits.ts`), on every executor (the Workers admission, the sandbox service, which gets it as the run's `queueMs`, and the QuickJS worker pool), and its deadline starts when it starts. Past that bound it fails with `queue_timeout`, having never started, and the job goes back on its queue for later without spending an attempt. A run's timing record (`LIAISON_APP_BRIDGE_TIMINGS_FILE`) says its `lane`, its wait for a Workers admission slot (`admissionMs`) and, on the sandbox service, its wait for a process (`loader.queueMs`).

**The Workers admission.** On the Workers loader and the sandbox service alike, at most 16 top-level runs of one organization are in flight at once, and its background runs hold at most 12 of them, so 4 are always left for its interactive runs. Runs whose bridge holds a database transaction open (atomic tools, primary webhook deliveries, jobs and event handlers in a transaction) are capped across the server at `APP_WORKER_POOL_MAX` less `APP_WORKER_POOL_RESERVED_INTERACTIVE`, and background ones at that less `APP_WORKER_POOL_RESERVED_INTERACTIVE` again (at least 1). Nested runs (a tool calling another app's tool) never wait: their caller holds its slot (`apps/api/src/modules/apps/workers/admission.ts`).

The recorded answers are fixtures, one per entry point, in `contract/fixtures/<app>/`. They are recorded once against the provider's sandbox account and only replayed in CI, which makes no live call. `contract/recorder.ts` runs an entry point in the same isolate on a live bridge and records every call with its answer. It then replaces secrets and personal values (given literals such as the store domain and token, email addresses, IP addresses, phone fields, credential-named values) with stand-ins, the same stand-in everywhere it appears. Last, it replays the scrubbed fixture twice, and writes it only when no replay asks for a call the fixture does not hold. A webhook verifier records and replays on the bridge it gets in production. Shopify's recorder (`apps/api/test-support/contract/record-shopify.recorder.ts`, run by path, never in a suite) walks a plan of every entry point against a development store with realistic inputs. Read what a recorder writes before you commit it: the repository is public.

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
                                → opts.auth: add the connection's credential (host-side)
                                → native fetch(url)         → external HTTP, credential redacted from the answer
```

**Available bridge methods (non-exhaustive; see `rpc-bridge.ts` for the authoritative list):**

The bridge surface is large and grows as apps need new host capabilities. Core categories:

| Category | Methods |
|----------|---------|
| Identity | `getUserId()`, `getOrgId()` |
| Database | `db_findMany` (equality `where`, plus `{ col: { in: [...] } }` for a set lookup, up to 1000 values), `db_findOne`, `db_insert`, `db_update`, `db_updateMany`, `db_delete`, `db_count`, `db_insertNow` / `db_updateNow` (committed at once, see "Commit an intent row before an outside call"), and `db_batch` (writes that commit together, see "Commit several writes together") |
| Events | `emit(event)` — declared emits only |
| Jobs | `jobs_enqueue(name, payload, opts)` (`ctx.jobs.enqueue`; `enqueueJob` is its flat name), `timers_wakeIn(seconds, name, payload, opts)` (`ctx.timers.wakeIn`), `steps_get`, `steps_reset` and the hidden `_steps_begin` / `_steps_save` behind `ctx.steps.run` |
| Contacts | `resolveContact(params)` (not the mail app: its host page write `mail_writePage` resolves senders under the mailbox's ownership, see `modules/mail/page-write.ts` and `sender-contacts.ts`; on a read-only run it only looks a contact up, returning it unchanged or null, and `clear` is refused) |
| Network | `fetch(url, opts)` — domain allowlist enforced. `opts.auth` (`{connection, identifier?, account?, scheme: "header:<Name>" \| "query:<param>" \| "bearer" \| "basic", fields?, grant?, exchange?}`) has the host add the connection's credential, only to that connection's own hosts, and redact it from the answer; `opts.configSecrets` (`{placeholder: configKey}`) has the host write a declared config secret exactly where the manifest's `secrets` places it (see below), else `secret_placement_refused` |
| Data store | `store_get`, `store_set`, `store_update`, `store_delete`, `store_query`, `store_count` (`ctx.store.*`, the calling app's collections; the writes are refused on a read-only run) |
| Connections | `connections_getToken(connName, identifier?)` (QuickJS only; refused on Workers and workerd), `connections_getAccounts(connName)`, `connections_describe(connName)` (owner, connected by, health, token expiry, whether a refresh token is stored; no secrets), `connections_getCredentials`, `connections_getSettings(connName, identifier?)` (the fields marked `readable`, and which fields are empty; no secrets), `connections_disconnect` |
| SQL connections | `sql_query(connName, request)`, `sql_reads(connName)`, `sql_schema(connName, request)`, `sql_probe(connName, request)` (`ctx.sql.*`: a database the platform holds the connection to, see "Query a database"; read-only, no secrets) |
| API connections | `api_listOperations`, `api_read`, `api_write`, `api_writeValidate`, `api_adapterGet`, `api_adapterVersions`, `api_adapterReference`, `api_adapterTest`, `api_connections`, `api_validate`, `api_adapterPlan`, `api_adapterPut`, `api_adapterRestore`, `api_adapterDelete`, `api_customer`, `api_verify` (`ctx.api.*`: the HTTP APIs the platform holds the connection to, each account an adapter document, for an app whose credentials connection declares an `api` block with its read, write and admin scopes; every call is checked against them and returns answers, never a credential; the writes are refused on a read-only run) |
| Accounts | `accounts_list(connName, opts)`, `accounts_setMetadata(accountId, patch)` (`ctx.accounts.*`: the app's own accounts, the organization's and the caller's own; `setMetadata` is refused on a read-only run) |
| Directory | `kernel_findOne(entity, id)`, `kernel_findByIds(entity, ids)` (`ctx.kernel.*`: a user's directory fields or a contact of the caller's organization, up to 200 ids), `kernel_caller(scopes)`, `kernel_roles()`, `kernel_findUsersByEmail(emails)` |
| Logging | `log_info`, `log_warn`, `log_error`, `log_debug` (`ctx.logger.*`; `console.*` lines arrive here too, see "Console output") |
| Config | `config_get(key)`, `config_has(key)`, `crypto_hmacSha256Base64ForConfig(key, data)`, `crypto_verifyHmacForConfig(key, data, signature, "base64" \| "hex")` (sign or verify with a declared config secret, which stays on the host) |

Which apps run on the Workers executor: once `LIAISON_APP_LOADER_URL`, `LIAISON_APP_LOADER_CELL_ID` and `LIAISON_APP_LOADER_KEY` are set, every installed sandboxed app, with no list to keep. Every `.liaisonapp` carries its Worker module, `worker.js`, beside `bundle.js`; the install records its sha256 (a catalog app's must match the sha256 the image's catalog pins, an app builder app's the one its publish approved, or the install is refused) and keeps its bytes. A version installed from a package without `worker.js` (built before packages carried one) runs on the local sandbox, with a warning on each run. The loader fetches a module from `GET /api/app-bridge/bundles/<sha256>` when it has no copy, signed with the server's loader key for that direction and path; the server answers only for a module an installed, enabled app version names, and hashes the bytes again before they leave.

Every process role uses the Workers executor: `api`, `worker` (jobs, scheduled runs, webhooks) and `all`. A run's `ctx.*` calls come back to the public address (`LIAISON_APP_BRIDGE_BASE_URL`, else `BASE_URL`), so they can reach any API process. The run id names the process that started the run. A process that receives a call for another process's run checks the run token first (the token is signed for its run, so a wrong one is refused there), then forwards the call to that process over the internal listener (see [Let processes reach each other](self-hosting/docker.md#let-processes-reach-each-other)). The answer is the same as if the call had reached the right process. If that process is gone, the call fails with 410 `run_owner_gone`.

**When the loader fails.** A Workers run that fails is sorted by who is at fault:

| The loader answered | What happens |
|---|---|
| No answer (network error), an answer with no error kind (for example Cloudflare's own 503 page), `auth`, `loader_internal` | A fault of the loader. The run is tried once more after a short random wait, but only if it made no `ctx.*` call yet and at least twice the failed attempt's time is left of its deadline (for a webhook, its delivery budget). It also counts toward the process's breaker. If the last try still meets a loader fault and no try made a `ctx.*` call, the run runs once more on the local sandbox and answers from there (`fallback: "loader_fault"`); after any `ctx.*` call it never does, since what the app did may already have happened. |
| `load` (the module failed before its handler started: it threw while loading, or lacks the export the run named), `bundle_missing`, `bundle_fetch_failed` | A fault of this app's module. No retry. For the next 10 minutes this organization's version of this app runs on the local sandbox. Other organizations, and other versions, stay on Workers. |
| `limit`, `handler`, `timeout` | The run's own outcome, as on the local sandbox. Nothing else changes. |

The breaker is per process: 5 loader faults within 60 seconds open it, and for 60 seconds every app of every organization runs on the local sandbox. Then one run is let through as a test; if the loader answers it, Workers is used again, otherwise the breaker opens for another 60 seconds. Every app has both builds, so a run that falls back gives the same answer. The choice is made once per run, before its bridge is built (a Workers run gets a bridge that hands back no secret, the local sandbox its usual one), and the run's timing line says why it fell back (`fallback: "breaker"`, `"app"` or `"loader_fault"`).

**Where a fallback runs.** Every fallback above runs on the server's own sandbox service (workerd, built from the same loader code, `packages/app-loader`; see [The app sandbox service](self-hosting/sandbox.md)), at `LIAISON_SANDBOX_URL`, which the compose file sets to its `sandbox` service by default: the same Worker module, a bridge that hands back no secret, the same loader id and key. Their timing line then says `executor: "workerd"` beside the `fallback` reason. A run on that service never falls back further, and its faults neither open the loader's breaker nor take an app off Workers. Only a server started without any `LIAISON_SANDBOX_URL` (outside the compose file) still falls back to the local QuickJS sandbox, in this release only.

**A self-hosted server.** Without a loader, every sandboxed app runs on that service (`executor: "workerd"`): the compose file starts it and sets `LIAISON_SANDBOX_URL` by default. A version installed without a Worker module (its package was built before Worker modules were packaged) is never moved to the local sandbox behind your back: at start the server gives it the `worker.js` of its own stored package when that package has one, and otherwise refuses its runs with `app_worker_module_missing` until it is reinstalled or republished from a package built by this release (`LIAISON_APP_RUNTIME=quickjs` runs every app on the local sandbox meanwhile, this release only). The start log lists such versions, and `/healthz` counts the active ones in `appsWithoutWorkerModule`. While the service can reach more than the app's bridge port (the host firewall step is missing), it refuses every run with `sandbox_network_open`, and `/healthz` reports `sandbox: network_open`.

**Code with no installed version.** An app-builder preview, an import transform and a PDF template run where an installed app would (the loader, else the sandbox service), with the limits of their kind. The platform gives each its own Worker module, built with the same builder as a package's `worker.js`: a draft's preview uses the `worker.js` its build made, a transform's module is built when it is saved (a transform that does not build is refused at the save), a template's when its app version is installed, and any of them on its first remote run otherwise. A module is built once per organization and source, kept in the database, and pruned after 30 days without a run. Such a module is an ES module, so the code runs in strict mode, and an isolate may serve several calls of one transform: keep what a call needs in `state`, never in a global. `LIAISON_APP_RUNTIME=quickjs` puts every app back on the local sandbox, whatever else is set: the way back while a server moves over, for this release only.

**One door.** Every place that runs app code (tools, preflights, webhooks, jobs, events, polls, search, attention, exports, import kinds and transforms, PDF templates, approval summaries, previews) goes through one function that picks the executor, so these settings apply to all of them at once.

**Console output.** `console.log`, `info`, `warn`, `error` and `debug` work on both executors (the local sandbox used to have no `console`). On Workers, a run keeps at most 200 lines and 64 KiB (a line is cut at 4 KiB), uncaught errors included. Each line goes to the server's log, at most 600 lines per process per minute and 512 bytes per line. For an organization's custom app, the lines also go to its logs (the builder's Logs view), marked `source: "console"`, with the same access tags as its `ctx.logger` lines. A line logged while other runs of the same app shared the Worker cannot be tied to one run: it goes to the server's log only, and a note in the app's logs says how many were left out.

**Usage and daily limits.** Every app run is counted per organization, app, UTC day and executor in `kernel.app_usage_daily`: runs, calls back to the server (Workers runs only), wall time, and CPU time: on Workers the loader's measure, pulled from its `GET /usage?day=` every hour; on the server's sandbox service (`workerd`) the CPU time the service measured for each run, added as the run ends; empty on the local sandbox. A retried Workers run counts once. Whoever runs the server can cap an organization's app runs, app calls and app CPU per UTC day (`appRunsPerDay`, `appBridgeCallsPerDay`, `appCpuMsPerDay`; see [Limit an organization](provisioning-cli.md#limit-an-organization)). The calls cap counts Workers runs only: a run on the local sandbox, including one moved back to it after loader failures, is limited by the runs cap, not the calls cap. Past a limit a tool answers `APP_RUNS_LIMIT_REACHED` (or the calls or CPU code) with 429 and the limit and the count reached in `error.details` (`{limit, used}`); webhooks, events and the app's jobs run after midnight UTC, nothing is dropped; a run started from inside another run is counted but never refused. On a managed server the cell sends each organization's daily totals to the control plane in an `apps.usage` message.

An app that runs on the Workers or workerd executor never receives a secret: there `connections_getToken`, `connections_getCredentials` and `config_get` of a declared secret key fail with `secret_not_available_on_workers`. The same holds for every run of an organization's custom app on any executor, the local sandbox included (its webhook verifier too). Use `fetch` auth (bearer, basic, a named header, a query parameter, a token exchange, an OAuth account's token refreshed host-side, or the connection's own OAuth client by `grant: "client_credentials"`), `configSecrets`, `connections_getSettings` for the readable fields, the by-key crypto calls, and a tool's `revealsSecrets` for a minted webhook secret an operator must copy; all work on every executor. Every bundled app is held to this by `contract/secret-free.contract.test.ts`.

**Where a config secret may go (`secrets`).** `configSecrets` writes a secret only where the manifest's `secrets` map declares it: `{"<configKey>": {"hosts": [...], "in": "header:<Name>" | "query:<param>" | "body:<json.path>"}}`. The key must be a secret one of the app's connections declares, each host one of that connection's `allowedDomains`. At the call the host checks, for every entry and before reading any secret: the URL's host is in `hosts` (every redirect hop too), and the placeholder is the whole value of that header, query parameter or JSON body path (the body must parse as JSON) and appears nowhere else, in no other header, field, key or the URL. Anything else, and any key with no entry, fails with `secret_placement_refused` (403) and nothing is sent. Connection credentials (`fetch` auth) need no entry: they go only in a request header to a host of their own connection, and a custom app's connection must name its `allowedDomains`.
| Files | `files_importAttachment`, `files_listAttachments`, `files_getAttachmentBytes`, `files_attachToParent`, `files_reparent`, `files_analyzeDocument` (capability `files.analyzeDocument`: reads one of the app's own PDFs or images with the workspace's media analysis model, answering the app's prompt; credits apply, and an admin can turn the `apps` media surface off) |
| Bulk data | `bulk_fetchToBlob`, `bulk_iterateJsonl_next`, `bulk_deleteBlob` — streaming helpers for large payloads |
| Approvals | `approval_recordStarted`, `approval_recordEffectLanded`, `approval_recordSucceeded`, `approval_recordFailedNoEffect`, `approval_recordAmbiguous` |
| Agents | `agent_run`, `agent_spawn`, `agent_awaitRun` (`agent_spawn` and `agent_awaitRun` need the `agent.spawn` capability: declared in the manifest, listed on the install screen and granted by the admin who installs the app; no app gets it from who published it, and an organization's custom app may not declare it) |
| Cross-app tools | `executeTool` — one app calling another app's declared tool |
| Discussions | `threads_deleteEntityDiscussion({entityType, entityId})` — after deleting one of the app's own records that declares a discussion, removes that discussion (an empty shell stays where an approval was asked in it). Refused with `discussion_not_declared` for a type without one, and with `entity_still_exists` while the record still reads in the handler's transaction or still exists for people the caller cannot see it for. `threads_pruneEntityDiscussion({entityType, entityId})` — after a record's sharing narrows, takes everyone but the caller out of its discussion; whoever still sees the record is seated again when they open it |

A tool reached through `executeTool` runs with the target app's own access plus the calling app's. So it can read a file the calling app stored on one of its own records (with `files_importAttachment`) and handed over by id, for example as `attachments` to `tickets:addNote`, and nothing the calling app cannot read. The target app copies such a file onto its own record under its own write access, not the caller's. A file copied by a webhook or job, which has no user, records no uploader.

A file an app stores with `files_importAttachment` or `ctx.pdf.render` counts toward the organization's storage limit. When the call acts for a person or an agent and the organization is at its limit, it fails with `STORAGE_QUOTA_EXCEEDED` and nothing is stored. A call the server runs on its own (a webhook, a sync job, with no agent acting), and a file stored on a record of an `immutable` table with `retentionYears` (a legal record), is stored anyway and counted. The host decides this from its own view of the call and from the installed manifest; the app cannot pass a flag for it.

A PDF template that `ctx.pdf.render` runs is a nested run of the app run that asked for it: on the sandbox service it takes a process kept for nested runs, so a render never waits behind its own caller, however many of that app's runs are waiting on renders at once.

Individual apps can also register their own bridge methods through the bridge extension registry (`bridge-extensions.ts`), which is how per-app surfaces like the calendar, SMTP, IMAP, PDF, and messaging bridges are added without growing the core bridge file. The Mail app's IMAP methods are `imap_fetch` (INBOX or Sent, with the INBOX membership and flag read-back) and `imap_writeBack` (read, star, archive and trash on the server, a batch of up to 15 conversations in one session); `imap_writeBack`, like `smtp_send`, is refused to a read-only execution. After an `smtp_send` from an IMAP mailbox, the host files a copy in its Sent folder (`imap-mailbox.ts`). A built-in app's TypeScript descriptor can also carry `_registerHostTools(orgId)`: host-side tools registered under the app at each registration and removed with it, for a tool a manifest cannot declare (an approval decided by a scope other than `<app>:approve`, as the API connector's adapter save and restore are). An installed `.liaisonapp` cannot use it.

### Performance Characteristics

| Metric | Value | Notes |
|--------|-------|-------|
| Warm invocation | ~0.4ms | Pre-warmed slot, trivial handler. Production hot path |
| Cold start | ~78ms | WASM module compilation. Happens once at boot |
| Context reset | ~0.38ms | dispose + newContext FFI. Runs on every release |
| Memory (per slot) | ~20MB | Each slot owns its own WASM module instance; not shared |

Real-world tool calls are dominated by bridge operations (DB queries, HTTP), not sandbox overhead. A DB-backed tool typically takes 2-10ms total, of which ~0.4ms is sandbox framing.

Every run, on whichever executor ran it, is counted when it ends: per app and lane (`interactive`, `background`, `nested`), its time, its wait for a sandbox slot, its bridge time and, for a failed run, its error kind (`timeout`, `queue_timeout`, `cancelled`, `tenant_busy`, `memory`, `sandbox`, `handler`, or the loader's kind on Workers). An operator reads these numbers in `/diag` `appRuns` ([Watch app runs](self-hosting/docker.md#watch-app-runs)), so a slow or failing app shows up there before its users report it.

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

**Declared and granted.** Declaring a domain is not enough: the install records the domains an admin consented to, and `fetch()`, a file import from a URL, a bulk download and a connection's credential reach a host only when the manifest declares it and the install granted it. An install from a URL lists every domain for consent, and an upgrade lists the domains the running version was not granted (`newDomains` in the upgrade preview; the apply takes them as `grantedDomains`). The image's own catalog apps and packages signed by a trusted publisher are granted every domain they declare, at install and at every upgrade, so an organization created later reaches them too. An app installed before domains were granted keeps every domain it declares. A connection whose hosts were all revoked sends its credential nowhere. The instance operator (for an instance app) or the organization's admin (for its own app) revokes or allows a domain in **Settings › App store** under **Outbound access**, or with `POST /api/apps/<app>/outbound` (`{"revoke": [...]}` or `{"grant": [...]}`); the change holds from the app's next run, within a few seconds on every server process. A revoke on a catalog app or a trusted publisher's package lasts until its next upgrade, which grants every domain the new version declares again: to keep such an app off a host, turn the app off. The image and link hosts an app's screens declare (`network.imageHosts`, `network.linkHosts`) are outbound domains like the others: they are listed for consent, and a framed screen shows images from, and opens links to, only the granted ones.

Every target must be public and use HTTPS: a hostname that resolves to a private, loopback, link-local or metadata address is refused, checked against the address actually connected to and again on every redirect.

**Private services on the deployment's own network.** A self-hoster whose app talks to a service next to Liaison (a container on the same compose network, a host on the private LAN) lists it in `LIAISON_APP_PRIVATE_HOSTS`: comma-separated exact hosts, `host` or `host:port` (for example `kpi-service:8787`). Empty by default. A listed host may be reached over plain HTTP and may resolve to a private or loopback address; the app's manifest must still list it in `allowedDomains`, link-local and metadata addresses stay refused, and a redirect to a host not on the list gets the public-HTTPS rule again. List only services you run and trust: every installed app whose manifest names the host can reach it.

**A fake Shopify on a test box.** `LIAISON_TEST_SHOPIFY_ADMIN_URL` sends the Shopify app's Admin API requests (`https://<store>.myshopify.com/admin/...`) to a fake at one address, with the store's token and the store in an `X-Liaison-Shop-Domain` header. Another app that works with Shopify through the Shopify app's tools, such as invoicing (an order import, a quote's draft order), reaches the fake the same way, since those tools run as the Shopify app. The host changes the destination after the app's own checks, so the app's `allowedDomains` stay as they are: an app that names the fake's address itself is refused. The request follows no redirect and reaches only that address, which must resolve to a private or loopback address. It works only on a box with `LIAISON_PRIVATE_DEMO_BOX=true` and a loopback `BASE_URL`, never on the managed edition; set anywhere else, the server refuses to start ([Docker](self-hosting/docker.md)).

**An organization's custom app.** It is one tenant's code on a server shared with others, so on top of the rules above: `LIAISON_APP_PRIVATE_HOSTS` never applies to it, and it never reaches the server itself, neither by name (the host of `BASE_URL`, of each `ALLOWED_ORIGINS` entry, and every organization host of `LIAISON_ORG_HOST_TEMPLATE`) nor by address (`LIAISON_CELL_PUBLIC_ADDRESSES`: the server's own public IPv4 and IPv6 addresses, comma-separated; traffic from a host to its own public address skips the cloud firewall). The address check runs on the address actually connected to and on every redirect, so a name that resolves to the server is refused too. Keep services off `0.0.0.0` on the host all the same.

### Token Security

OAuth access/refresh tokens and credential secrets are encrypted at rest with `ENCRYPTION_KEY`. The host decrypts them only to add them to a request (`fetch` auth); the Workers and workerd executors refuse every call that would return one to app code (`connections_getToken`, `connections_getCredentials`), and only the legacy QuickJS executor still answers it. Tokens never appear in API responses — the client-facing DTO (`ConnectedAccountDto`) explicitly excludes all encrypted fields.

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

- Tokens checked for expiry each time the host reads one (a `fetch` that names the connection)
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

### App screens on an origin of their own

Set `LIAISON_APP_FRAME_ORIGIN_TEMPLATE` (`https://{app}--{org}.example-usercontent.com`) and a browser tab frames each outside app from a host of its own, `<app>--<org slug>` on that domain, instead of the opaque frame. The app then has a real origin, one per app and organization, so its own `localStorage` works; it still has no network (`connect-src 'none'`), no session and no API, and reaches Liaison only through the frame protocol.

- **Use a domain of its own.** The template must start its host with the one label `{app}--{org}`. The managed edition refuses to boot when the frame domain is the registrable domain of `BASE_URL` or of `LIAISON_ORG_HOST_TEMPLATE`, or without `LIAISON_ORG_HOST_TEMPLATE`; a self-hosted server boots and logs a warning instead. Every edition refuses templates that can name the same host as the org template or `BASE_URL`.
- **What the frame host serves.** Only `GET /frame/<version>?t=<token>`: the frame document of that app for that organization. Everything else on that host (`/`, `/api/*`, `/api/auth/*`, `/assets/*`, webhooks, the socket) answers 404, and no cookie is read or set there. The token is minted by the app list for the signed-in organization, names the frame host, the app, the version and the page's origin, and is refused on any other host. The document carries `frame-ancestors <the organization's page>`, no `X-Frame-Options`, and `sandbox allow-scripts allow-forms allow-same-origin`; the iframe gets `allow-same-origin` only for such a frame, never for the opaque one. The page posts to the frame's exact origin and hears only it; the frame posts to the page origin its server wrote into the document and drops any other message (`apps/api/src/modules/apps/app-frame-host-route.ts`, `apps/api/src/lib/app-frame-host.ts`).
- **Images.** A framed screen shows images only from the hosts its manifest lists in `network.imageHosts` (https).
- **Names.** An app name never holds `--` (the manifest refuses it). An organization whose slug holds `--`, or a label longer than 63 characters, keeps the opaque frame for that app, with a warning in the log.
- **First-party apps.** `LIAISON_FRAMED_APPS` (comma-separated, for example `shopify,boxtal`) frames those first-party apps on their own origin too, while the template is set. In the desktop and mobile apps such an app runs in the shell's frame.
- **Not framed this way.** App builder drafts stay in the opaque frame.

### Host calls a framed screen makes

A framed screen reaches only its own `/api/apps/<app>/...` routes through `fetch`. For the rest it calls `@liaison/host` (host API 1.5), and the page answers each call for that app only:

| Call | What the host does |
|---|---|
| `getContext()` | Organization and person: ids, names, locale. Never a token. |
| `app.openFile(fileId, filename)` | Fetches the file and opens it (the desktop viewer, a browser tab or a download). Only a file id this frame saw in its own tool results or prints, or a file attached to one of its own records. No bytes go back to the frame. |
| `app.listDocumentTemplates(entity)`, `app.printDocuments({ entity, id, templateIds, merge })` | The organization's templates and prints for one of the app's own record types. |
| `app.listMyApprovals()` | Pending approvals of the app's own tools that the person may decide. |
| `app.decideApproval(id, decision, payloadHash)` | The host shows its own confirmation dialog, checks the approval belongs to one of the app's tools, and keeps the payload fingerprint the app showed. The app's button only asks. |
| `app.editApproval(id, fields)` | Changes a pending approval of one of the app's own tools; the server accepts only the fields that tool declares editable and returns the new payload fingerprint, which a later `decideApproval` must use. |
| `app.openExternal(url)` | Opens an `https` page in a new tab, with no opener and no referrer, only on a host the manifest declares (fetch domains, connection domains, `network.imageHosts`, `network.linkHosts`) and never the Liaison page's own origin. |
| `app.openRecord(app, entity, id)`, `app.openApprovals()` | Opens another app's record in its own tab (what it shows is up to the person's access), or the approvals queue. |
| `app.tabLabel(label)` | Names the page's tab after the record it shows, from a function the host re-reads when it changes; empty keeps the app's own label. A host before 1.5 ignores it. |

In the page (a first-party app that is not framed) the same calls work; file opening, approval decisions and outside links then keep their direct path (`packages/host-sdk/src/index.ts`, `apps/web/src/framework/host-app-calls.ts`).

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
| `db` | `DbClient` | `findMany`, `findOne`, `insert`, `update`, `updateMany`, `delete`, `count`, `insertNow`, `updateNow`, `batch` |
| `emit(event)` | `Promise<void>` | Emit declared event |
| `enqueueJob(name, payload, opts?)` | `Promise<void>` | Same call as `jobs.enqueue` |
| `jobs.enqueue(name, payload?, { delay?, jobId? })` | `Promise<void>` | Run a declared job now, or after `delay` ms (at most 15 min) |
| `timers.wakeIn(seconds, name, payload?, { jobId? })` | `Promise<void>` | Run a declared job in `seconds` (up to 30 days) |
| `steps.run(name, { budgetMs? }, chunk)` | `Promise<StepRunResult>` | Resumable work in bounded chunks across runs (below) |
| `resolveContact(params)` | `Promise<unknown>` | Contact lookup |
| `connections` | `Record<string, ConnectionClient>` | `getAccounts()`, `getSettings()` (readable fields); the token goes through `fetch` auth |
| `fetch(url, opts?)` | `Promise<Response>` | Domain-restricted HTTP |
| `logger` | `Logger` | Structured logging (`info`, `warn`, `error`, `debug`) |

| `store` | `StoreClient` | The app's own JSON documents: `get`, `set`, `update`, `delete`, `query`, `count` (below) |

**`s` (Schema builder):** Utility for declaring entity field types in manifests.

### Keep data in the app store (`ctx.store`)

`ctx.store` keeps JSON documents for the organization, in named collections, keyed by an id. It needs no table in the manifest and works the same on every executor (in-process, the worker pool and Workers).

```typescript
const doc = await ctx.store.set("orders", "1001", { total: 42, status: "paid" })
await ctx.store.update("orders", "1001", { status: "shipped" }, { ifVersion: doc.version })
const page = await ctx.store.query("orders", {
  where: { status: "shipped", total: { gte: 10 } },
  orderBy: { field: "total", dir: "desc" },
  limit: 50,
})
const shipped = await ctx.store.count("orders", { status: "shipped" })
await ctx.store.delete("orders", "1001")
```

- A collection name matches `^[a-z][a-z0-9_]{0,62}$`, an id is at most 200 characters, a document is a JSON object of at most 256 KiB, and a collection holds at most 100,000 documents.
- `get` answers `null` for a missing document. `update` merges the patch into the top level of the document.
- `query` filters on top-level fields (a value, `{ in: [...] }`, or `gt`/`gte`/`lt`/`lte`), sorts on a top-level field, `doc_id` or `updated_at`, returns at most 200 documents a page (default 50) as `{ items: [{ id, data, version, updatedAt }], nextCursor }`, and takes `nextCursor` back as `cursor` for the next page.
- `set`, `update` and `delete` take `{ ifVersion }`: the version you last read, or `0` for "must not exist yet". Another version rejects with `code: "version_conflict"` (status 409). Other refusals: `not_found` (404), `doc_too_large` (413), `collection_full` (409), `invalid_*` (400), and `query_timeout` (408) for a query on unindexed fields that ran past 2 s (filter with equality or `in`, or sort by `updated_at`).
- The collections are the calling app's own. An app cannot name another app, so it never reaches another app's documents, even in a collection of the same name.
- On a read-only run (a rerun that may only read), `set`, `update` and `delete` are refused; `get`, `query` and `count` still answer.

To let anything else read a collection (the agent's data tools, dashboard blocks, search), declare it in the manifest:

```json
"store": {
  "collections": {
    "orders": {
      "readScope": "myapp:orders:read",
      "searchable": { "labelField": "title", "fields": ["title", "customer"] },
      "agentReadable": true
    }
  }
}
```

`readScope` must be one of the app's own scopes (in `scopes` or a tool's `requiredScopes`); a reader needs it. `agentReadable` defaults to `false`. A collection that is not declared stays reachable by its own app only.

### Hash, sign and draw random values (`crypto`)

Use WebCrypto, the global `crypto`, for hashes, HMACs and random values. Workers have it natively. The local sandbox (in-process and the worker pool) gives the same calls, computed by the server:

| Call | What |
|---|---|
| `crypto.subtle.digest(alg, data)` | SHA-1, SHA-256, SHA-384 or SHA-512 |
| `crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash }, extractable, usages)` | An HMAC key (`usages`: `"sign"`, `"verify"`) |
| `crypto.subtle.sign("HMAC", key, data)` / `crypto.subtle.verify("HMAC", key, signature, data)` | HMAC with that key's hash |
| `crypto.subtle.exportKey("raw", key)` | The bytes of a key imported with `extractable: true` |
| `crypto.getRandomValues(array)` / `crypto.randomUUID()` | Random bytes (at most 65,536 per call) and a random v4 UUID |

The local sandbox has no typed arrays (`Uint8Array`, `ArrayBuffer` and the rest are removed: they would allocate outside the run's heap limit). There, bytes are plain arrays of numbers from 0 to 255: `crypto.subtle` takes them where WebCrypto takes a `Uint8Array` and answers them where it answers an `ArrayBuffer`. To write one piece of code for every executor, convert through `@liaison/app-sdk/bytes`:

```ts
import { bytesToHex, digestHex, utf8Bytes } from "@liaison/app-sdk/bytes"

const hash = await digestHex("SHA-256", "someone@example.com") // lower-case hex
const key = await crypto.subtle.importKey("raw", utf8Bytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
const signature = bytesToHex(await crypto.subtle.sign("HMAC", key, utf8Bytes(body)))
```

Other algorithms and other `crypto.subtle` methods (`encrypt`, `deriveKey`, `generateKey` and the rest) reject with `NotSupportedError` on the local sandbox. To sign or verify with a secret held in the app's configuration, keep using `ctx.crypto_hmacSha256Base64ForConfig` and `ctx.crypto_verifyHmacForConfig`: the secret never reaches the app.

### Long work: come back later (`ctx.steps`, `ctx.timers`, `ctx.jobs`)

A run is short and bounded: a job has `timeoutMs` (60 s unless the manifest says otherwise), a tool less. Never sleep or poll in a loop inside a run to wait for something, and never loop over a whole backlog in one run. Do one bounded piece of work, save where you are, and let a later run carry on.

**Work in chunks with `ctx.steps.run`.** Inside a job handler:

```typescript
export async function backfill(params, ctx) {
  return ctx.steps.run("backfill", { budgetMs: 20_000 }, async (cursor) => {
    const page = await listOrders(ctx, cursor)        // one page from the provider
    await saveOrders(ctx, page.orders)                // safe to run twice for the same page
    return { done: page.next === null, cursor: page.next }
  })
}
```

- The step's cursor is kept in the app data store (collection `liaison_steps`, one document per step name). A run calls `chunk(cursor)` again and again, saving the cursor after each chunk, until `budgetMs` has passed (default half the job's `timeoutMs`, at most 80% of it). It then enqueues the same job with the same payload, and that run continues from the saved cursor.
- `chunk` returns `{ done, cursor?, wakeIn? }`. `done: true` finishes the step: later runs of it do nothing until `ctx.steps.reset(name)`. `wakeIn: <seconds>` ends the run and continues that much later: use it when a provider says "not ready yet" (a report being built, a bulk export).
- `run` answers `{ state, cursor, chunks }`: `done`, `scheduled` (a later run continues) or `skipped` (another run holds the step, or this run was an old continuation; nothing ran).
- Two runs never run a chunk of the same step at the same time. If a run dies in the middle of a chunk (killed at its timeout, the process stopped), the chunk runs again from the last saved cursor once the run's claim runs out (the job's timeout plus 10 s). Write each chunk so that running it twice for the same cursor does no harm.
- A chunk that throws gives the claim back, keeps the cursor and fails the run; the job's retry starts that chunk again.
- Only in a job handler that is not `atomic`: the cursor commits on its own, never with the run's transaction. Start the work from a tool or a webhook with `ctx.jobs.enqueue`. Declare the job `onDemand: true` in the manifest, or call `steps.run` from a scheduled job.
- `ctx.steps.get(name)` returns `{ cursor, done, running, updatedAt }` for a status view, `ctx.steps.reset(name)` starts the step over.

**Wake up later with `ctx.timers.wakeIn(seconds, name, payload, { jobId })`.** Runs the job `name` in `seconds` (0 to 30 days). A wait past 15 minutes is kept: the job waits 15 minutes at a time until it is due. With `jobId`, a second timer of the same id is dropped while the first is pending; the woken job may arm the same id again.

**Enqueue a job with `ctx.jobs.enqueue(name, payload, { delay, jobId })`.** `delay` is in milliseconds, at most 15 minutes (a longer one is cut to 15 minutes: use `timers.wakeIn`). `jobId` drops a second enqueue of that id while the first waits or runs. Both ids are scoped to your organization. The job runs as the person whose run enqueued it, or as the app.

### Event handlers and webhooks commit each call on its own

An event handler (`events.subscribes`) and a webhook delivery (`webhooks`) of a sandboxed app hold no database transaction across their run. Each `ctx` call opens its own short transaction and commits it before it returns, so no connection or row lock is held while the handler calls a provider.

So what a handler wrote before it failed stays written:

- A failed event handler is run once more. A failed webhook delivery goes back to the inbox and is replayed with its backoff, and the provider may deliver it again too.
- Write the handler so that running it again over its own earlier writes does the right thing: dedup on the provider's delivery or event id, upsert instead of insert, check the state before you change it.
- Several writes that must land together go in one call that takes them together, or in a job with `ctx.steps`.
- A delivery ledger row ("processing") written before the work must not block the replay if the run dies before it marks the row: give it an age after which it counts as failed.

A few bundled handlers still rely on one transaction for their whole run (they issue a numbered document, or claim a delivery first). They keep it until they are split, and are listed with the reason in `apps/api/src/modules/apps/contract/run-wide-tx.allowlist.json`. That list only shrinks; a new handler is never added to it. Core apps keep one transaction per handler run.

(`apps/api/src/modules/apps/run-wide-tx.ts`, `apps/api/src/modules/apps/runtime.ts`,
`apps/api/src/modules/webhooks/handler-run.ts`.)

### Query a database (`ctx.sql`)

An app that reads an organization's database declares a SQL connection: a `credentials` connection with an `sql` block. The organization stores either a Postgres or Redshift DSN (`connectionString`, with optional `dialect` and `statementTimeoutMs`) or a db-gate (`gateUrl` and `gateToken`). The server holds the connection pool and the credentials. App code names the connection and gets rows back, on every executor.

```json
"connections": {
  "warehouse": {
    "type": "credentials",
    "allowedDomains": [],
    "credentialFields": [{ "name": "connectionString", "type": "password", "label": "DSN" }],
    "sql": { "rawQuery": { "scope": "my-app:query:read" } }
  }
}
```

```typescript
const out = await ctx.sql.query("warehouse", { sql: "SELECT id, total FROM orders WHERE id = $1", params: [id] })
if ("error" in out) return out             // { error: { code, message } }
return out.rows                            // { rows, truncated, durationMs }
```

- `sql.catalog: "instance"` gives the connection the deployment's read catalog (`LIAISON_DATABASE_ADAPTER_PATH` or `LIAISON_DATABASE_ADAPTER`): `ctx.sql.query(name, { read, params })` runs a named read and `ctx.sql.reads(name)` lists them, with `domains`: the access tier each catalog domain declares (a domain absent from it is internal). The catalog is the deployment's, never the app's.
- `sql.rawQuery.scope` allows a read-only `SELECT` of the app's own (`{ sql, params }`, `params` bind `$1`, `$2`, ...; a db-gate takes none). The person the run acts for must hold the scope. A deployment turns raw queries off with `LIAISON_DATABASE_ALLOW_RAW_QUERY=false`.
- `sql.modes` (`["direct"]` or `["gate"]`) limits the credential modes the connection takes.
- Every call runs in a read-only transaction, with a statement timeout set on the database (`timeoutMs`, default 10 s, at most 120 s) and cancelled there past it. It returns at most `maxRows` rows (default 500, at most 2000) and says `truncated` when more matched.
- The credentials never reach the run: a failure is answered as `{ error: { code, message } }`, with no DSN or token in it (`not_connected`, `forbidden`, `unknown_read`, `invalid_params`, `statement_timeout`, `config_error`, ...). Every call writes an audit line (`sql.query`, `sql.schema`, `sql.probe`, `sql.reads`) with a hash of the SQL, never the SQL.
- The account used is the organization's, never a member's personal one. The pool is per organization, connection and account. It is opened on first use, replaced when the credentials change, and closed when the account is disconnected, after 10 minutes unused, or past `LIAISON_SQL_POOLS_MAX` pools (32) per server process.
- The `liaison-self` catalog reads this instance's own database through a login that bypasses row-level security. Its reads always take the caller's organization as `orgId`, whatever the app sends, and a read over tickets, knowledge, mail or the audit log needs that app's read scope. Raw SQL over it is refused outside the instance operator's organization.
- `ctx.sql.schema(name, { table? })` lists readable tables and columns (secret columns removed; it needs `sql.schema.scope` when the connection names one, else the raw-query scope when it has one). `ctx.sql.probe(name)` reports write grants and catalog reads a gate is missing.

### Read your own accounts (`ctx.accounts`)

`ctx.accounts.list(connection, { identifier?, includeInactive? })` returns the app's accounts of one declared connection: the organization's and the caller's own, never another member's, another app's or another organization's, and never a token. Each has its `metadata` and `canManage`. `ctx.accounts.setMetadata(accountId, patch)` merges keys into an account's metadata (`null` removes a key, at most 32 KiB). A personal account is its owner's to change. The organization's account needs the connection's admin scope (`adminScope`, default `<app>:accounts:admin`), or a run of the app itself (a job). Every change is audited. The keys the platform keeps on an account (`grantedOAuthScopes`, `pickedItems`, `sharedDrives`, `tokenExpiry`) are refused for every caller.

`ctx.kernel.findByIds("users", ids)` returns the directory fields of up to 200 users of the caller's organization in one call, as `ctx.kernel.findOne` does for one.

For access rules of your own (who may see which of your reports or records), three more directory reads of the caller's organization:

- `ctx.kernel.caller(scopes?)` says who the run acts for: `{ kind: "system" }` for a job or a setup step, or `{ kind: "person", userId, roleIds }`. `holds` answers, for each scope you name (at most 20), whether the person holds it through their own grants or the call's. The system holds every scope. It never lists the person's other grants.
- `ctx.kernel.roles()` lists the organization's roles, id and name.
- `ctx.kernel.findUsersByEmail(emails)` returns the directory fields of the organization's people with one of these emails (case-insensitive, up to 200), for example to resolve the people a provisioning config names.

### Commit an intent row before an outside call (`ctx.db.insertNow`)

Some runs share one transaction from start to end: an approved gated call (the approval claim, the handler and the "approved" mark), and a tool declared `atomic: true` (which may not call outside the database at all: every outside call fails with `atomic_run_egress_refused`). If the sandbox stops such a handler ("App execution timed out"), every write it made rolls back. A row written with `ctx.db.insert` just before a call you cannot undo (buying a label, charging a card) is lost with it, and the outside effect has no local record.

`ctx.db.insertNow(entity, data)` and `ctx.db.updateNow(entity, id, data)` make the same write as `insert` and `update`, in a new transaction of their own that commits before they return:

```typescript
const intent = await ctx.db.insertNow("purchases", { order_ref: ref, state: "in_flight" })
const bought = await provider.buy(ref)                  // cannot be undone
await ctx.db.updateNow("purchases", intent.id, { state: "done", provider_id: bought.id })
```

- The checks are the ones `insert` and `update` make: only the app's own declared tables and fields (no other app's tables, no kernel table, no `org_id`), the run's organization and RLS actor.
- They are refused on a read-only run, and in a run that shares its caller's transaction (an `atomic` job, a core app's webhook); use `insert` and `update` there.
- In a run whose bridge calls each commit on their own already (an ordinary tool call, an event handler or a webhook delivery of a sandboxed app), they behave like `insert` and `update`.
- The run's own transaction sees the committed row and can keep updating it. Do not commit-now a row the run already changed with a plain write: the second transaction waits for the run's lock, and gives up after 5 seconds with a lock timeout error.
- Give the intent row a state that says the outside call has started, and a sweep that finds rows still in that state after a while and settles them: ask the provider what happened, or show them to a person with what to check. Boxtal's label reservation works this way (`bundled-apps/boxtal/src/link-store.ts`, `reconcile-tracking.ts`).
- The effect ledger (`ctx.effects`, `@liaison/app-sdk/effects`) also commits its claim at once, and is the tool for "do this outside call once". An intent row is for a record the app itself has to list and act on later.

### Commit several writes together (`ctx.db.batch`)

A sandboxed event handler, webhook delivery, job or ordinary tool call holds no transaction across its run: each bridge call commits on its own. Writes that must land as one go in a single `ctx.db.batch` call, which runs them in order and commits all of them or none:

```typescript
const done = await ctx.db.batch({
  sequence: {
    key: `myapp:invoice:${year}`,
    format: { prefix: `INV-${year}-`, pad: 4 },
    unique: { entity: "invoices", field: "number_int", where: { year } },
  },
  ops: [
    { insert: "invoices", as: "invoice", data: { year, number: { $seq: "formatted" }, number_int: { $seq: "value" } } },
    { insert: "invoice_lines", data: { invoice_id: { $ref: "invoice" }, label: "Service" } },
    { delete: "drafts", id: draftId },
  ],
})
// done.sequence = { value: 1, formatted: "INV-2026-0001" }, done.rows.invoice = the inserted row
```

- Ops are `insert` (with an optional `as` name), `update`, `delete` and `updateMany`, each with the checks of its single-call twin: the app's own declared tables and fields, the run's organization and RLS actor, refused on a read-only run. At most 500 ops.
- `sequence` allocates the next value of one of the app's sequences inside the same commit (the `sequences.allocate` capability): a batch that fails consumes no value, and batches running at the same time never get the same one, so a numbering built on it has no gap and no duplicate. `unique` names a column that may already hold values written another way (an import): the allocator steps past them.
- Placeholders anywhere in an op's `data`, or as its `id`: `{ $seq: "value" }`, `{ $seq: "formatted" }` (the prefix and the value padded to `pad`) and `{ $ref: "<as>" }` (the id of an earlier insert).
- `sequences` (instead of `sequence`) allocates several named sequences in the same commit, for two numbered records that must land together (a credit note and the invoice that replaces the one it reverses): `sequences: { credit: {...}, invoice: {...} }`, referenced as `{ $seq: "credit.formatted" }` or `{ $seq: "invoice.value" }`, and answered in `done.sequences`. Either every record is numbered and written, or none is and no value is used.
- An `update` may also `append` items to json array fields and `merge` keys into json object fields: they apply to the row as it is when the batch commits, so a log entry or a reference another writer added between your read and the batch is kept (`{ update: "invoices", id, append: { log: [entry] }, merge: { refs: { shipment: id } } }`).
- An `update`, `delete` or `updateMany` may carry `expect: { minRows?, maxRows? }`, a guard on the number of rows the op matched (at least one bound; `{ minRows: 1 }` means the row must exist, `{ minRows: 1, maxRows: 1 }` exactly one). When the count falls outside it, nothing in the batch commits, sequence values included (they are rows of the same savepoint, so no number is used), and the call rejects with an Error whose `code` is `"precondition_failed"` and `status` 409, its message naming the op: `ctx.db.batch: precondition_failed at ops[1] (update subscriptions): expected at least 1 row, matched 0`. `batchPreconditionFailure(err)` from `@liaison/app-sdk` reads it as `{ op, kind, entity, matched }` (null for any other error). A mirror row that must find its record and the ledger entry it implies commit together this way, or not at all. An `insert` takes no guard: it writes one row or fails. The same holds on every executor.
- What comes after the batch (a render, a mail) is a separate step: make it safe to run again, since a run that dies after the batch leaves the batch's rows committed. The invoicing app numbers its legal documents this way (`bundled-apps/invoicing/src/issue.ts`).

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

When an app connects, the server tells it the address to register its
provider webhooks on (`kernelPublicBaseUrl` in the `connected_account:create`
event, and again on a reconnect, a reconcile and before a disconnect). On a
server where each organization has its own host (`LIAISON_ORG_HOST_TEMPLATE`)
it is that organization's host, so deliveries keep reaching the organization
when it moves to another server. Otherwise it is `BASE_URL`.

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

### Handler Dispatch

Tools have two handler formats and two execution paths:

```typescript
// Legacy (direct function — kernel apps): runs in-process, no sandbox
handler: (params, ctx) => Promise<result>

// Manifest (sandboxed — bundled apps): runs in QuickJS sandbox
handler: { bundlePath: string, exportName: string, core?: boolean }
```

There are two kinds of app, and the platform decides which an app is: no manifest field does.

| Kind | Which apps | Where it runs |
|------|-----------|---------------|
| core | tickets, mail, contacts, calendar, knowledge, projects, mcp-manager (`modules/apps/core/registry.ts`) | Server code: its handlers are imported modules, called in-process with a typed host ctx |
| app | every other app: bundled, catalog, sideloaded, custom | Sandboxed through `runApp`: Workers in Cloud, the sandbox service (workerd) self-hosted, QuickJS while `LIAISON_APP_RUNTIME=quickjs` |

A manifest that carries `trusted` (true or false) is refused. Being a first-party catalog app vouches for an app's declarations (`readOnly`, its taint sinks, triggers), never for where or how it runs.

Event subscribers, job handlers, and webhook handlers follow the same pattern — manifest-format handlers are wrapped in sandbox dispatch functions that call `executeInSandbox()`.

An app's event subscription runs once per event, in the process that published the event, however many server processes run. Other processes do not run it again for their copy of the event.

An app's cross-app or system event handler, its approval poll and reconcile, its search, its knowledge source sync and its knowledge items run as the app, under row-level security, first-party or not: a scope check in the database (allocating a task number, say) reads the app's own scopes plus the scopes its manifest declares (`scopes`, granted at install), and refuses a scope the app does not declare. Only a core app's handlers (server code) may use a privileged database handle.

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

**Each organization's share.** The executions of one organization's custom apps (tools, webhooks, event handlers, jobs, every other handler; the app name's organization key decides) hold at most 2 workers at once. Up to 8 more wait their turn for up to 5 s, and past that the call is refused with `SandboxTenantBusyError` (429 `custom_app_busy`, `Retry-After: 5`). A nested call (a custom app's tool calling another tool) is not counted again: its caller already holds the share. Catalog, in-tree and instance apps keep the rules above. A custom app's webhook also has a budget of 120 deliveries a minute per organization and app, checked before its `verify` runs (429 `custom_app_rate_limited`). The pool's `tenantStats()` shows each organization's executions in flight and waiting.

**Its bulk downloads.** `ctx.bulk.fetchToBlob` of a custom app writes to its own directory (`custom--<org>--<app>` under `BULK_BLOB_DIR`), limited to 256 MiB per app and 4 GiB for all custom apps on the server together; a download not written or read for an hour is deleted by a sweep, and the organization's deletion removes them all.

**The operator's kill switch.** `PUT /api/cloud/orgs/:id/custom-apps/:name/state` (signed by the control plane, `{orgId, name, disabled, reason?}`) disables one organization's custom app: its rows, files and data stay, `apps_installed.disabled_at` makes the tenant boundary refuse it on every dispatch path (its own organization included), its schedulers and registrations go, and its owner can neither upgrade nor uninstall it (409 `custom_app_disabled`). `disabled: false` enables it again. Both are written to the organization's audit log (`app.custom.disabled`, `app.custom.enabled`) with the reason.

**Where its interface runs.** A custom app is never first-party, so its `ui.js` is served as text and runs only in the sandboxed frame (opaque origin, `connect-src 'none'`, no session, no storage, no cookies), reaching Liaison through the frame protocol for its own calls, like any outside app.

### Import transform pool

Import transforms (agent- or admin-written scripts that turn an export into
import records) run on the app loader or the sandbox service when one is set
(their own Worker module, see "Code with no installed version" above), else on
their own `SandboxWorkerPool`, never the app pool: 2
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

A `ctx.fetch` that runs past its timeout ("Fetch timed out after <n>ms") is not
hidden either: the caller gets `upstream_timeout` (HTTP 504, retryable) with a
message that the upstream service was slow, that a read can be retried, and that
a change may already have been applied, so it is checked before a retry.

The default deadline of a `ctx.fetch` is 10 seconds (`LIAISON_SANDBOX_FETCH_TIMEOUT_MS`).
Its `timeoutMs` option can shorten it for any call. A write (`POST`, `PUT`, `PATCH`,
`DELETE`) can also ask for up to 30 seconds, because a write that runs past the deadline
on our side is often still applied upstream. A multipart upload can ask for up to 120
seconds. The tool's own `timeoutMs` still bounds the whole call
(`apps/api/src/modules/apps/sandbox/bridge/egress.ts`).

### Share a provider's rate limit across runs (`limits`, `ctx.limiter`)

A provider limits how hard one account may call it: so many calls at once, or so
many per second. Declare that limit on the connection in the manifest, and every
`ctx.fetch` that names the connection (`auth: { connection }`) keeps to it, across
every run, process and executor (QuickJS or Workers). Do not keep your own counter
or semaphore in module state: it is per process, and a Workers isolate does not
share it.

```json
"connections": {
  "shop": {
    "type": "oauth2",
    "limits": { "concurrency": 4, "perSecond": 2, "burst": 40 }
  }
}
```

- `concurrency`: calls to one account in flight at once (1 to 1000).
- `perSecond`: calls started per second, on average; `burst`: how many may start at
  once when there is room (default: `perSecond` rounded up). Give `concurrency`,
  `perSecond` or both.
- The limit is per account: the organization, the app, the connection and the
  `identifier` the call names (none: the connection's default account).
- A call waits for its turn before it goes out, at most 2 seconds in a tool and 20
  seconds in a job. Past that it fails with `provider_rate_limited` (status 429), which
  the caller can retry later.
- When the provider answers a limited connection's call with 429 or 503 and a
  `Retry-After` header, every call to that account waits that long (at most 60
  seconds).
- A provider that reports its throttle in the response body (a GraphQL cost):
  call `await ctx.limiter.pause("shop", ms)` (or `pause("shop", ms, identifier)`),
  and every call to that account waits `ms`, at most 60 seconds. It answers the pause
  in force. Only for a connection that declares `limits`.
- When the limiter cannot reach its store, calls go out without a limit (the
  provider's own 429 still applies) and the server logs it.

(`apps/api/src/modules/apps/connection-limiter.ts`,
`apps/api/src/modules/apps/run-limits.ts` `connectionLimiterLimits`.)

### Unknown outcomes of approved writes

An approved tool with an outside effect records its progress with the approval
protocol (`approval_recordStarted` before the call, `approval_recordEffectLanded` as
soon as the provider accepts it, then `approval_recordSucceeded`, or
`approval_recordFailedNoEffect` when the provider refuses it). When the run ends
between `started` and an outcome, for example on a timeout, the approval waits at
`approving` with an unknown outcome.

Declare `reconcileHandler` on the tool in the manifest to settle these cases. It names
a handler export that reads the provider and answers whether the effect happened. It
gets `{ approval_request_id, payload, external_ref }` and returns
`{ outcome: "executed" | "not_executed" | "unknown", ref?, reason? }`. It must never
perform the effect itself. The approvals reaper calls it a minute after an
execution is settled as unknown, or after the 10-minute grace window for a run that
never recorded an outcome:

- `executed`: the approval is approved, with `ref` as its result.
- `not_executed`: the approval goes back to pending, so a person can approve it again.
- `unknown`: nothing changes; the approval stays for a person to decide.

A `reconcileHandler`, like a `pollHandler` (an approved tool's output that is not
ready yet), runs with no transaction held for its whole run: each `ctx` call opens and
commits its own, so it may call the provider. The reaper and the poll job record the
answer afterwards, in one write that only applies if nobody settled the approval in
between.

(`apps/api/src/modules/approvals/approving-reaper.ts`,
`apps/api/src/modules/approvals/reconcile-outcome.ts`,
`apps/api/src/modules/approvals/poll-output.ts`.)

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
