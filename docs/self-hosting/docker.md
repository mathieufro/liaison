---
title: Run Liaison with Docker
description: Start the Liaison Docker Compose stack, know its services and volumes, set the main environment variables, and check its health and logs.
---

Liaison ships as one app image plus PostgreSQL, Redis, MeiliSearch and a SeaweedFS object store, all defined in `deploy/docker-compose.yml`. This page shows you how to start that stack, configure it and check it. For TLS, DNS and the full production path, see the [production runbook](../runbooks/production-bootstrap.md).

## What you need

- Docker with Docker Compose v2, and `openssl`.
- gVisor (`runsc`) registered with Docker, for the app sandbox service: [Install gVisor](sandbox.md#install-gvisor). The quickstart runs the sandbox without it on a laptop for a local trial.
- At least 2 vCPU and 4 GB of memory, plus swap. The service limits are sized for a 4 vCPU, 8 GB host; the sandbox service's cap is a ceiling its processes reach only when many apps run at once ([Size it](sandbox.md#size-it)).

## Start the stack

1. Clone the repository and run the quickstart:

   ```bash
   git clone https://github.com/liaison-sh/liaison.git
   cd liaison
   ./deploy/quickstart.sh
   ```

   On the first run it creates `deploy/.env` from `deploy/.env.example` and fills in every required secret. It pulls `ghcr.io/liaison-sh/liaison:latest` if it can, otherwise builds the image from `apps/api/Dockerfile`, starts the stack and waits until `/healthz` reports every dependency ok.
2. Open the URL it prints and register with the one-time setup token it shows. See [Install Liaison](../getting-started/install.md).

| Flag | What it does |
|---|---|
| `--port <n>` | Publish the app on this host port instead of 3000 |
| `--pull` | Force pulling the published image |
| `--build` | Force a local build from `apps/api/Dockerfile` |
| `--project <name>` | Docker Compose project name (default `liaison`) |
| `--down` | Stop the stack and keep the data |
| `-h`, `--help` | Show the help |

To run Compose yourself, name the project and file: `docker compose -p liaison -f deploy/docker-compose.yml <command>`.

## Know the services

| Service | Image | Role | Memory limit |
|---|---|---|---|
| `app` | `ghcr.io/liaison-sh/liaison` (tag from `LIAISON_IMAGE`) | API, web app, MCP, background jobs | 3 GB |
| `postgres` | `postgres:17-alpine` | Database | 2 GB |
| `redis` | `redis:7-alpine` | Pub-sub, rate limits, job queues | 512 MB (Redis heap capped at 384 MB) |
| `meilisearch` | `getmeili/meilisearch:v1.10` | Search | 1.5 GB |
| `objectstore` | `chrislusf/seaweedfs:4.48` | S3-compatible file storage | 1 GB |
| `objectstore-init` | SeaweedFS | Creates the bucket once, then exits | |
| `data-init` | `busybox` | Prepares the app's data directory, then exits | |
| `sandbox` | the app's image | Runs the sandboxed apps (workerd under gVisor), on its own network: [The app sandbox service](sandbox.md) | 2 GB |

All services share an internal network, and only the app publishes a port: `${APP_BIND}:${APP_PORT}`, which defaults to `127.0.0.1:3000`: it speaks plain HTTP and is meant to sit behind a TLS reverse proxy on the same host. Set `APP_BIND=0.0.0.0` only when the proxy runs on another host on a trusted network.

You can point Liaison at Amazon S3, Cloudflare R2 or any S3-compatible endpoint instead of SeaweedFS. See the [production runbook](../runbooks/production-bootstrap.md).

## Know where the data lives

| Volume or folder | Holds |
|---|---|
| `postgres_data` | The database |
| `redis_data` | Redis data (append-only file) |
| `meili_data` | The search index, rebuildable from the database |
| `objectstore_data` | Files |
| `deploy/data` | Installed app packages and push key files, mounted at `/var/lib/liaison` |
| `deploy/setup` | Config and knowledge files for the setup playbook, mounted read-only at `/setup` |

`./deploy/quickstart.sh --down` keeps the volumes. `docker compose -p liaison -f deploy/docker-compose.yml down -v` deletes them, and all your data with them. To back up, see [Back up and restore](../admin/backups.md).

## Set the environment

`deploy/.env` configures the stack. The quickstart fills the secrets; you set the rest.

### Required

| Variable | What it is |
|---|---|
| `JWT_SECRET` | Signs access tokens, file links and MCP tokens |
| `ENCRYPTION_KEY` | Encrypts stored secrets. Exactly 64 hex characters (32 bytes) |
| `BYOK_ENCRYPTION_KEY` | Encrypts organizations' own model keys |
| `MEILISEARCH_MASTER_KEY` | MeiliSearch master key |
| `MONITOR_TOKEN` | Bearer token that unlocks the detailed `/healthz` |
| `POSTGRES_PASSWORD` | The privileged database role, used for migrations only |
| `LIAISON_APP_PASSWORD` | The runtime database role, subject to row-level security |
| `LIAISON_READONLY_PASSWORD` | The read-only role used by the database connector |
| `OBJECT_STORE_ADMIN_ACCESS_KEY`, `OBJECT_STORE_ADMIN_SECRET_KEY` | Object store admin, used only to create the bucket |
| `OBJECT_STORAGE_ACCESS_KEY`, `OBJECT_STORAGE_SECRET_KEY` | The app's own object store credentials, limited to the bucket |
| `BASE_URL`, `ALLOWED_ORIGINS` | The URL people reach Liaison at |
| `DEVICE_FLOW_CLIENTS` | Allowed device-flow client IDs. Keep `mcp-cli`. The desktop app is allowed whenever this is set |

### Version

The channels are explained in [Upgrade Liaison](../admin/upgrades.md#choose-a-channel). `./deploy/quickstart.sh --channel nightly` sets both of these for you.

| Variable | Default | What it does |
|---|---|---|
| `LIAISON_IMAGE` | The compose file's pinned tag | The image the stack runs: the app, the [sandbox service](sandbox.md) and the rolling processes all use it. For a private registry (ECR, ...), set it here rather than overriding `image:` on one service |
| `LIAISON_RELEASE_CHANNEL` | `release` | `release` or `nightly`: what **Settings › System** compares the running version against |
| `LIAISON_ALLOW_OLDER_IMAGE` | `false` | Emergency only, not supported: start an image older than the database's schema instead of refusing |

### Network

| Variable | Default | What it does |
|---|---|---|
| `APP_PORT` | `3000` | Host port |
| `APP_BIND` | `127.0.0.1` | Interface the port is published on |
| `TRUSTED_PROXY_HOPS` | `1` | Reverse-proxy hops in front of the app. Must be at least 1 behind a proxy, or rate limits see one client |
| `TRUSTED_PROXY_CIDRS` | empty | Extra networks allowed to send `X-Forwarded-For` |
| `LIAISON_EDGE_MODE` | empty | Only behind an edge that serves one host per workspace. `direct`: the edge keeps the Host, and the client address is `CF-Connecting-IP` from a tunnel connector on the same machine. `signed`: the edge sends the host and client address in signed `x-liaison-*` headers |
| `LIAISON_EDGE_SECRET` | empty | The secret those headers are signed with (`signed` mode, at least 32 characters) |

### Email

Sign-in is passwordless, so people cannot sign in without working mail.

| Variable | Default | What it does |
|---|---|---|
| `SMTP_HOST` | empty | Mail server. Empty: emails are logged, not sent |
| `SMTP_PORT` | `587` | 587 uses STARTTLS. For 465, also set `SMTP_SECURE=true` |
| `SMTP_USER`, `SMTP_PASS` | empty | Credentials |
| `SMTP_SECURE` | `false` | Implicit TLS |
| `RESEND_API_KEY` | empty | Send through Resend instead. Takes precedence over SMTP |
| `SYSTEM_RESEND_API_KEY` | empty | A separate Resend key for sign-in codes and invites. Empty: `RESEND_API_KEY` |
| `EMAIL_FROM` | `Liaison <noreply@liaison.example.com>` | Sender address |
| `SYSTEM_EMAIL_FROM` | empty | Sender of sign-in links, invites and security codes. Empty: `EMAIL_FROM` |
| `LIAISON_CONSOLE_EMAIL_BODIES` | empty | Also log email bodies (codes, links). The quickstart turns it on. Leave it off on any instance others use |
| `LIAISON_SETUP_TOKEN` | empty | The first registration's one-time token. Empty: the app derives one and prints it in its log |

Send from an address on a domain you own, and authorize your mail provider for that domain with SPF, DKIM and DMARC records (your provider gives the exact records). Mail from a domain that is not yours, or not authenticated, is rejected or lands in spam, and then nobody can sign in.

### Commercial mail and the opt-out link

A commercial mail that an agent drafts or you write to a prospect carries a link to stop commercial messages and the `List-Unsubscribe` headers (see [Opt-outs](../sales/opt-outs.md)). The link is built on `BASE_URL`, so the address must be reachable from the recipient's side: a recipient who cannot open it cannot opt out. Both mailbox paths carry the headers, with `List-Unsubscribe-Post: List-Unsubscribe=One-Click`: a Gmail mailbox and an IMAP/SMTP mailbox. No mailbox path sends a commercial mail without them. Set the organization's legal name and postal address in **Settings > Organization > Commercial identity** first: until both are set, no commercial mail goes.

### Mail encryption

How personal mailboxes are encrypted at rest. See [Mail encryption](../security.md#mail-encryption). Set these in `deploy/.env`; compose passes both to the app.

| Variable | Default | What it does |
|---|---|---|
| `MAILBOX_ENCRYPTION_DEFAULT` | empty | `managed` (transparent) or `private` (zero-access) for people who have not chosen. A default, not a lock: people can still pick the other mode, and with **Allow private mailboxes** off, new mailboxes are transparent whatever it says. Empty: decided once, the first time it is needed, and kept: private if anyone had set up a private mailbox by then, transparent otherwise |
| `MAILBOX_ENCRYPTION_ALLOW_MANAGED` | `true` | `false` locks every personal mailbox to private: nobody can pick transparent, no mailbox is moved to transparent, and the default above is private. Set it where mail must stay zero-access. Mailboxes that are already transparent stay so until their owners make them private |

### Public demo

Only read when `LIAISON_DEMO_MODE` is on.

| Variable | Default | What it does |
|---|---|---|
| `LIAISON_DEMO_POOL_SIZE` | `5` | Workspaces kept filled in and ready for visitors. `0` turns the pool off. See [Run a demo instance for many visitors](../getting-started/demo.md#run-a-demo-instance-for-many-visitors) |
| `LIAISON_DEMO_SEED_CONCURRENCY` | `2` | Workspaces filled in at once. Visitors beyond it wait in line |
| `LIAISON_DEMO_STEP_OUTPUT_TOKENS` | `16000` | What one step of a visitor's agent may write on the instance's key. What a step reads is not capped |
| `LIAISON_DEMO_WAREHOUSE` | `false` | `true` seeds the company's read-only warehouse into demo workspaces. Needs `LIAISON_DEMO_WAREHOUSE_DATABASE_URL`, the warehouse's own login; without it every seed fails |
| `LIAISON_PRIVATE_DEMO_BOX` | `false` | `true` declares a demo-mode box private: a test box reached only through a tunnel, with no visitors. There `liaison seed` may replace its own demo org (`--replace`) and give the seeded people passwords (`--passwords`), which a public demo refuses. It counts only when `BASE_URL` is a loopback address (`localhost`, `127.x.x.x`, `::1`): a box with a public hostname stays public whatever this says. Never set it on a demo visitors use |
| `LIAISON_TEST_SHOPIFY_ADMIN_URL` | unset | Test boxes only. Sends the Shopify app's Admin API requests (connecting, disconnecting, jobs, reads), with the store's token, to a fake Shopify at this address instead of the store. It must be one bare address on the box itself: a loopback address, a one-word service name or `host.docker.internal`. It works only on a box with `LIAISON_PRIVATE_DEMO_BOX=true` and a loopback `BASE_URL`, never on the managed edition; set anywhere else, the server refuses to start. Never set it on a real instance |

### Agent web reads

Agents search and fetch the web without an approval. These limits bound what one search or fetch can carry out of your organization; a call over a limit is refused with the reason. See [Limits on reading the web](../agents/approvals.md#limits-on-reading-the-web).

| Variable | Default | What it does |
|---|---|---|
| `LIAISON_WEB_SEARCH_MAX_QUERY_CHARS` | `200` | Longest search query |
| `LIAISON_WEB_FETCH_MAX_URL_CHARS` | `512` | Longest fetched address |
| `LIAISON_WEB_FETCH_MAX_QUERY_CHARS` | `150` | Longest query string of a fetched address |
| `LIAISON_WEB_READS_PER_TURN` | `20` | Searches and fetches in one agent turn |
| `LIAISON_WEB_READS_CONSECUTIVE` | `12` | Searches and fetches in a row, with no other tool between |
| `LIAISON_WEB_FETCH_HOSTS_PER_TURN` | `10` | Different sites fetched in one turn |
| `LIAISON_WEB_READS_PER_THREAD_HOUR` | `60` | Searches and fetches per conversation in any hour |

### Tool search model

When an agent looks for a tool, it ranks the tools it may use by words. With meaning turned on, it also ranks them by meaning, so "Marc left, cut his access" finds the tool that deactivates a user. A small embedding model, Snowflake arctic-embed-m-v2.0 (Apache-2.0), runs on the CPU in one embedding process per host, the `embedder` service. Every `app`, `api` and `worker` process of the host asks it over a local Unix socket. It has no network port, and no text leaves the server.

Meaning is off by default on a self-hosted server. The managed edition has it on by default.

Turn it on:

1. In `deploy/.env`, set `LIAISON_TOOL_MEANING=on` and `COMPOSE_PROFILES=meaning`.
2. Run `docker compose up -d`. It starts the `embedder` service and restarts the processes that read the new setting.

What to expect:

- The embedding process uses about 1.1 GB of memory (up to 1.4 GB while it loads), once for the host, however many `api` processes run. Its cap is 2 GB. The other processes use no more memory for it.
- At its first start it fetches the model's files (about 330 MB) into `LIAISON_MODEL_CACHE_DIR`, at one pinned revision, and checks each file against its pinned SHA-256 before using it. It opens its socket once the model is loaded.
- Each process computes one vector per tool in the background after its first search, about 15 to 45 seconds.
- Until then, and whenever the embedding process is not running, is loading or answers slower than `LIAISON_EMBEDDER_DEADLINE_MS`, the search ranks by words alone. The process that searched logs one line when the embedding process stops answering, and one when it answers again.
- A rolling deploy (`deploy/rolling-deploy.sh`) adds the profiles in `COMPOSE_PROFILES` to its own and starts the `embedder` service when it is not running. It never restarts it: restart it on its own with `docker compose restart embedder`.
- With no outside network, copy the files of `Snowflake/snowflake-arctic-embed-m-v2.0` at the pinned revision into `LIAISON_MODEL_CACHE_DIR`; they are checked the same way.

Outside Docker, start the embedding process with `bun run embedder` from `apps/api`, with the same environment as the server.

| Variable | Default | What it does |
|---|---|---|
| `LIAISON_TOOL_MEANING` | unset: `off` self-hosted, `on` managed | `on` also ranks tools by meaning, through the `embedder` service; `off` ranks by words alone and asks no embedding process |
| `LIAISON_MODEL_CACHE_DIR` | `/var/lib/liaison/models` (host `./data/models`) | Where the model's files are fetched, checked and read |
| `LIAISON_EMBEDDER_SOCKET` | `/var/lib/liaison/run/embedder.sock` (host `./data/run`) | The embedding process's Unix socket. Outside Docker, unset: `liaison/embedder.sock` under `XDG_RUNTIME_DIR`, else under the temporary folder |
| `LIAISON_EMBEDDER_DEADLINE_MS` | `150` | How long a search waits for the embedding process before it ranks by words alone |

### Model keys

These are platform fallbacks for organizations that have not added their own key. Leave them all empty if every organization brings its own.

| Variable | Provider |
|---|---|
| `OPENROUTER_API_KEY` | OpenRouter |
| `LIAISON_ANTHROPIC_API_KEY` | Anthropic |
| `OPENAI_API_KEY` | OpenAI |
| `GOOGLE_API_KEY` | Google (also used for media analysis when an org has no Google key) |
| `MISTRAL_API_KEY` | Mistral |
| `EXA_API_KEY` | Exa web search for the agents |

`LIAISON_OPENROUTER_IGNORE_HOSTS` (default `OpenInference`) is the instance default list of OpenRouter upstream hosts, comma-separated as OpenRouter names them, that no OpenRouter request is sent to. The default host answered the first message of a multi-turn conversation instead of the latest one. Set it empty to allow every host. An organization that sets its own **Blocked hosts** list on the **Models** page uses that list instead (see [Choose models](../agents/models.md)).

### Integrations, push and storage

All optional. Compose passes each of them to the app from `deploy/.env`.

| Variable | What it does |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | Sign in with Google. Its redirect URI is `<BASE_URL>/api/auth/oauth/callback` |
| `GMAIL_OAUTH_CLIENT_*`, `GOOGLE_DRIVE_OAUTH_CLIENT_*`, `GOOGLE_MARKETING_OAUTH_CLIENT_*`, `SHOPIFY_APP_CLIENT_*` | OAuth clients the server provides to every organization (redirect URI `<BASE_URL>/api/connections/callback`). See [Connect apps](../connecting-apps.md) |
| `GOOGLE_OAUTH_RESTRICTED_SCOPES_VERIFIED` | `true` once Google verified the instance Google clients for restricted scopes |
| `GOOGLE_OAUTH_INTERNAL_DOMAINS` | The Google Workspace domains (comma-separated) whose own Cloud project holds the instance Google clients with the consent screen's audience set to **Internal**: addresses there connect without a Trusted mark |
| `GMAIL_PUBSUB_TOPIC` | A Pub/Sub topic Gmail push publishes to for every organization |
| `GMAIL_PUSH_AUDIENCE`, `GMAIL_PUSH_SERVICE_ACCOUNT` | That topic's push subscription: the https URL it posts to (its OIDC audience) and the service account it signs as. Mail and Tickets check push tokens with them when an organization set none of its own |
| `GOOGLE_PICKER_API_KEY`, `GOOGLE_CLOUD_PROJECT_NUMBER` | The Google Picker, to choose Drive files one by one |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Browser push. See [Notifications](../notifications.md) |
| `APNS_*`, `FCM_PROJECT_ID`, `FCM_SERVICE_ACCOUNT_PATH` | Phone push. See [Notifications](../notifications.md) |
| `OBJECT_STORAGE_ENDPOINT`, `OBJECT_STORAGE_REGION`, `OBJECT_STORAGE_FORCE_PATH_STYLE`, `OBJECT_STORAGE_AUTH` | An external S3 store (Amazon S3, Cloudflare R2) instead of the bundled one |
| `OBJECT_STORAGE_BROWSER_DIRECT`, `OBJECT_STORAGE_PUBLIC_URL` | Browsers upload to and download from that store directly |
| `RATE_LIMIT_DEFAULT`, `RATE_LIMIT_PER_USER` | Requests per minute per IP, and per signed-in person |
| `NOTIFICATIONS_DEFAULT_QUIET_HOURS` | `on` (default): people who never set work hours get quiet hours from 20:00 to 08:00 on weekdays and all weekend. `off`: they are notified at any time. See [Notifications](../notifications.md) |
| `LIAISON_TEAM_ENDPOINT` | Where this server shares what an admin opts into with the Liaison team. Unset: the team's endpoint; empty: sharing is not available. See [Share with the Liaison team](liaison-team.md) |
| `CONTROL_PLANE_URL`, `CONTROL_PLANE_API_KEY` | Both or neither. They do not make the server managed: set without `LIAISON_EDITION`, the server runs self-hosted and logs a warning saying what to set |
| `LIAISON_REQUIRE_APP_SIGNATURE`, `LIAISON_TRUSTED_APP_PUBLISHERS` | Runtime app installs: signatures are required by default, and the trusted publisher is one cosign certificate-identity regex matched against the whole identity. The image ships cosign; verifying needs outbound HTTPS to Sigstore (`tuf-repo-cdn.sigstore.dev`) |
| `LIAISON_CUSTOM_APPS` | `on`: organisations may install their own app by URL and build one with the agent ([Build an app with your agent](../agents/build-an-app.md)). Unset: off on a self-hosted server (on in the managed edition). Apps you install for the whole server, and apps already installed, are not affected |
| `LIAISON_APP_LOADER_URL`, `LIAISON_APP_LOADER_CELL_ID`, `LIAISON_APP_LOADER_KEY`, `LIAISON_APP_BRIDGE_BASE_URL`, `LIAISON_APP_BRIDGE_TIMINGS_FILE` | With the three loader variables set, run every installed sandboxed app on a remote V8 isolate loader instead of the server's sandbox service, as the Worker module (`worker.js`) its package carried; their `ctx.*` calls come back over HTTPS to `/api/app-bridge`, and the loader fetches a module from `/api/app-bridge/bundles/<sha256>` with a signed request. All empty by default: every app runs on the sandbox service. A run the loader cannot take goes to the sandbox service |
| `LIAISON_SANDBOX_URL`, `LIAISON_SANDBOX_BRIDGE_URL`, `LIAISON_APP_BRIDGE_PORT`, `LIAISON_APP_RUNTIME` | The app sandbox service (workerd under gVisor, the `sandbox` compose service, started with the stack): every sandboxed app runs there; `LIAISON_SANDBOX_URL` defaults to `http://sandbox:8790`. Install gVisor before you start or upgrade; firewall, sizing and the upgrade steps: [The app sandbox service](sandbox.md). Its pool sizes itself from `LIAISON_SANDBOX_MEM_LIMIT` (2g) and `LIAISON_SANDBOX_CPUS` (2.0), the container's limits, and keeps a third of it (`SANDBOX_POOL_RESERVED_INTERACTIVE`, 2 with the defaults) for interactive runs, so long background jobs never hold every process; `SANDBOX_POOL_SIZE` and the reserves set in `.env` win ([Size it](sandbox.md#size-it)). `LIAISON_SANDBOX_ALLOW_OPEN_NETWORK=1` lets it run apps without the firewall step (a development stack only). `LIAISON_APP_RUNTIME=quickjs` puts every app back on the local QuickJS sandbox (this release only; the next one removes it) |
| `LIAISON_APP_FRAME_ORIGIN_TEMPLATE`, `LIAISON_FRAMED_APPS` | In a browser tab, frame each outside app's screens (and the first-party apps listed in `LIAISON_FRAMED_APPS`, for example `shopify,boxtal`) on an origin of their own, `https://{app}--{org}.<a domain of its own>`, instead of the opaque frame. Point a wildcard DNS name and certificate for that domain at the server. Empty by default: outside apps run in the opaque frame ([App screens on an origin of their own](../app-sandbox.md#app-screens-on-an-origin-of-their-own)) |

For every variable, see the [environment reference](../reference/env.md).

## Check health

```bash
curl http://127.0.0.1:3000/healthz
```

From the host itself, or with `Authorization: Bearer <MONITOR_TOKEN>`, the answer includes `version`, `migrationHead`, `schemaBaseline` and `dependencies` (`db`, `redis`, `meilisearch`, `objectStorage`, and `sandbox` when the [app sandbox service](sandbox.md) is configured), each `ok` when healthy. From anywhere else, it answers only `{"status":"ok"}`. The app container's own health check fails when any dependency is not `ok`, except `sandbox: network_open`: the sandbox service can reach more than the app's bridge port (the host firewall step is not installed), so it refuses every app run until the step is in ([The service checks it too](sandbox.md#the-service-checks-it-too)); the stack still starts, so the step can be installed. Admins see the same detail in **Settings › System**.

When apps run on the [app sandbox service](sandbox.md) or a loader, the detail also counts `appsWithoutWorkerModule`: active app versions installed from a package with no Worker module, whose runs are refused (`app_worker_module_missing`) until you reinstall them. It is not a dependency: the process stays healthy.

To know whether a process should receive traffic, ask `/readyz`:

```bash
curl http://127.0.0.1:3000/readyz
```

It answers 200 once the process has finished booting and is not shutting down, and 503 before that and while it drains. A process that serves the API counts as booted only after it has set up the organizations whose people have the app open (a live WebSocket on any process), for up to `LIAISON_READY_WARM_MS` (30 s, `0` skips it): during a deploy those people reconnect to it first, and they would otherwise wait while their organization is set up. A process sets up no other organization when it starts, so its start time stays the same however many organizations the instance holds: each one is set up the first time something needs it (a request, a job, an event). A process forgets a deleted organization within 5 minutes; it also forgets one nothing has used for `LIAISON_ORG_RUNTIME_IDLE_MINUTES` minutes (default `60`, `0` never), so its memory follows the organizations used recently rather than every one it ever served, and sets it up again at its next use. It also keeps at most `LIAISON_ORG_RUNTIME_MAX_ORGS` organizations set up (default `2000`, about 0.35 MB each; `0` no cap): past it, it forgets the least recently used one that nothing is using right now (no request, open socket, job, event or agent turn, and not being moved), and sets it up again at its next use. The setup step (`migrate`, and the start of each container) applies the files policy and search settings from the installed apps. The body is the same either way: `status` (`starting`, `ready` or `draining`), `role`, `instanceId` (this process, this boot) and `leader` (whether it runs the singletons right now). It needs no token and checks no dependency, so a load balancer can poll it every second. `/healthz` does not change.

### Watch app runs

Every app run (a tool call, an attention compute, a job, an event, a webhook) is counted as it ends, always, in a fixed amount of memory. `GET /diag` (with `MONITOR_TOKEN`) shows it under `appRuns`, for the last 15 minutes and the last 24 hours, for this process (`process`) and for every process of the instance through Redis (`cell`, `null` when Redis did not answer in time):

- per lane, the one the run ran in (`interactive`: someone waits on it, such as a tool call; `background`: jobs, events, webhooks, syncs; `nested`: a run another run started) and per app: runs, the p50, p95 and p99 time, the wait for a sandbox slot (`queueP95Ms`: the Workers admission's wait plus the sandbox service's lane queue, when the executor reports them), the share of time spent in bridge calls, the error and timeout rates, and the errors by kind (`timeout`, `queue_timeout`, `cancelled`, `tenant_busy`, `handler`, ...);
- the slowest runs (app, entry, lane, time, error kind), never their arguments or data;
- per sandbox pool held by the process, how many seconds it was saturated (every slot busy and a run waiting) and how full it was on average.

`appRuns.alerts` lists the checks that fail, judged on the instance view. A watchdog that reads `/diag` can page on it without knowing the thresholds:

| Check | Fires when (last 15 minutes) | Severity | Setting |
|---|---|---|---|
| `interactive_timeouts` | at least 10 interactive runs timed out, and at least 2 % of them | critical | `LIAISON_APP_HEALTH_TIMEOUTS_MIN`, `LIAISON_APP_HEALTH_TIMEOUT_RATE` |
| `interactive_queue` | interactive runs waited more than 2000 ms (p95) for a sandbox slot, over 20 runs at least | warning | `LIAISON_APP_HEALTH_QUEUE_P95_MS` |
| `pool_saturated` | a sandbox pool stayed saturated 60 s without a break, or 120 s in all | warning | `LIAISON_APP_HEALTH_SATURATED_S` |
| `interactive_p95` | the interactive p95 is twice its 24-hour p95 and 1 s above it, over 30 runs | warning | `LIAISON_APP_HEALTH_P95_REGRESSION` |

A check that starts to fail also writes one warning to the log, never an error. Admins see their own organization's app runs at `GET /api/admin/app-health`; the instance operator's admins see the whole instance and the checks there.

## Run several processes

One container with the default `LIAISON_ROLE=all` runs everything, as before. To split the work, run the same image more than once, each with its own `LIAISON_ROLE`, all on the same Postgres and Redis.

### Choose a role for each process

`LIAISON_ROLE` says what a process runs:

| Value | Runs |
|---|---|
| `all` (default) | Everything in one container: the HTTP and WebSocket API, the background jobs and the singletons. This is the single-container setup above. |
| `api` | The HTTP and WebSocket API only. No background jobs, never the singletons. |
| `worker` | The background jobs and the singletons. Its HTTP server answers only `/healthz` and `/readyz`; every other path is a 404. |

Any other value stops the process at start. Send traffic to a process only once its `/readyz` answers 200. Use `/healthz` for liveness and the dependency checks.

### Know which process runs the singletons

Several `worker` (or `all`) processes run background jobs at once. Some work must run in one process only: the singletons. They are the outbox drain (it delivers the queued events), the move of jobs off the old shared job queue, a sweep of computer leases when a process starts leading and, on a demo instance, the replay resume and the model price check. Only the process that holds the leader lease in Redis runs them. Its `/readyz` answers `"leader": true`.

The lease is one Redis key with a time to live:

| Variable | Default | What it sets |
|---|---|---|
| `LEADER_LEASE_TTL_MS` | `15000` | How long the lease lives without a renew. A crashed holder is replaced within about this long. |
| `LEADER_LEASE_RENEW_MS` | `5000` | How often the holder renews it. Keep it well under the TTL. |
| `LEADER_LEASE_POLL_MS` | `1000` | How often a process without the lease tries to take it. |

A holder that cannot renew stops leading on its own before the key can expire, so two processes never lead at once. When it stops leading, it first lets the singletons finish their work in flight (the outbox finishes its current batch), then releases the key.

### Run on a Patroni cluster

On an active/standby pair with Patroni, set `SINGLETON_LEADER_URL` to the local node's Patroni `/leader` URL, for example `http://host.docker.internal:8008/leader`. Each process then asks its own Patroni every 5 seconds:

- Background jobs run on a node only while its Patroni is the leader. A standby node keeps its jobs paused.
- The singletons run only in the lease holder on the Patroni leader node. A process on a Patroni replica does not take the lease and runs no singleton.
- An answer that does not come within 2 seconds, or any error, counts as "not the leader".
- When a node loses Patroni leadership, its singletons stop at once, and it releases the lease at its next renew.

Unset (the default), the gate is off: every node counts as the Patroni leader.

### Know what to expect

- In role `all`, after a crash, the restarted container resumes the outbox within one lease TTL (15 seconds by default): the old lease must expire first.
- A Redis outage pauses the singletons: the holder cannot renew, so it stops leading. Events wait in the database and are delivered once a process holds the lease again.
- An `api` process never leads.
- Adding `worker` processes, and splitting `api` from `worker`, are supported.
- Several processes can serve the API (`all` or `api`) behind one load balancer. They share all live state (see below), and the web, desktop and phone apps notice a dropped connection within about 10 seconds, reconnect and reload what is open.
- If a process that serves the API dies in the middle of an agent turn, that turn stops there: it is not picked up by another process.

### Run several api processes

Several `api` processes on the same Redis already share this:

- **Who is online.** Each process writes its open WebSocket connections to Redis. A person counts as online while they have a connection on any process. Closing one tab is not a departure while another tab stays open, on any process.
- **The agent stream limit.** The number of agent chats one person can run at once is counted across all processes. It is 2 by default. Set `AGENT_MAX_CONCURRENT_STREAMS` to change it.
- **Events.** Work that writes, such as an app's event handler, a routine started by an event or a thumbnail, runs once per event, in the process that published the event. Work that serves the process's own connections runs in every process.
- **Event routines.** A routine created, changed, paused or deleted on one process takes effect on every process.
- **Live agent turns.** A running turn can be followed from any process. Each turn's events go to a Redis stream, numbered in order. A page that opens or reconnects mid-turn reads the turn so far, then follows the next events. A finished turn's stream stays readable for `AGENT_TURN_STREAM_TTL_S` seconds (600 by default), so a late view still sees how it ended. That stream holds the agent's streamed text, including what it writes about a mail it decrypted (the same text that is saved with the message when the turn ends), so keep Redis on a private network with no published port.
- **Live runs.** When a new turn starts, the mark for text from outside your company is reset only if no other run is going on that conversation, on any process.
- **Credit balance.** A balance change reaches every open page, on any process.
- **Retried messages.** A message sent twice with the same `correlationId`, for example after a network drop, is posted once. The second send gets the message already posted.
- **Mailbox answers.** See [Let processes reach each other](#let-processes-reach-each-other).

Each process proves it is alive with a heartbeat record in Redis:

| Variable | Default | What it sets |
|---|---|---|
| `LIVE_INSTANCE_TTL_MS` | `30000` | How long the record lives without a renew. A killed process drops out within about this long: its connections and stream slots stop counting. |
| `LIVE_INSTANCE_HEARTBEAT_MS` | `10000` | How often each process renews its record. Keep it well under the TTL. |
| `LIVE_SWEEP_INTERVAL_MS` | `10000` | How often the leader deletes the entries of processes whose record is gone. |

A process whose record lapsed, for example during a short Redis outage, writes its entries again when its record comes back.

When Redis does not answer within about a second:

- Mailbox access counts as absent: a personal mailbox reads as locked to the agent, and no one online counts as holding access to a mailbox.
- The agent stream limit is not checked: the chat starts.
- Who is online is read from the process's own connections only.

When the live turn registry does not answer, a page that opens mid-turn shows nothing for that turn and follows the next events.

### Let processes reach each other

An agent that reads a personal mailbox asks the browser to decrypt the mail. The answer can reach any process, but only the process that asked can use it. The process that receives it forwards it to that process over a direct HTTP call. Decrypted mail never goes through Redis.

The same holds for an app run on the Workers executor: its `ctx.*` calls come back to the public address and can reach any API process, but only the process that started the run (an `api` or a `worker`) holds it. A process that receives such a call forwards it to that process.

The call goes to an internal listener that every process starts, separate from `PORT`. It serves these two routes, signed with a key derived from `JWT_SECRET`, so every process needs the same `JWT_SECRET`.

| Variable | Default | What it sets |
|---|---|---|
| `LIAISON_INTERNAL_PORT` | `0` | The port of the internal listener. `0` takes any free port. |
| `LIAISON_INTERNAL_HOST` | the hostname | The name other processes reach this one by. Unset, it is the container's hostname. If that name does not resolve, `127.0.0.1` is used. |
| `LIAISON_INTERNAL_BIND` | the address of `LIAISON_INTERNAL_HOST` | The address the listener binds. Unset, it is the address the advertised name resolves to on this machine, never every interface. |

The listener reads at most 2 MiB per mailbox answer and 8 MiB plus 64 KiB per app call, and checks the signature before it reads the content. An app call is forwarded only with a valid run token, and each process forwards at most 2,000 app calls per client address every 10 seconds.

Every app container must reach every other app container on its internal port:

- In one compose network, nothing to do: the containers reach each other by hostname, and each listener binds only its address on that network.
- On separate hosts, set `LIAISON_INTERNAL_PORT` to a fixed port, set `LIAISON_INTERNAL_HOST` to an address on the private network, and open that port on the private network only. Never publish it.
- If that address is not on the container itself (a port mapped through Docker on each host), the listener cannot bind it and the process stops at start. Set `LIAISON_INTERNAL_BIND=0.0.0.0` and firewall the port so only the other app hosts reach it.

A process that cannot reach the one that asked refuses the answer (`WRONG_INSTANCE`).

## Read the logs

```bash
docker compose -p liaison -f deploy/docker-compose.yml logs -f app
docker compose -p liaison -f deploy/docker-compose.yml logs --since 10m app
```

Every service logs with Docker's `json-file` driver, rotated at 100 MB, five files kept.

## Know what happens at start

The app container runs the database migrations, reinstalls every enabled first-party catalog app from the image, then starts the server. Several containers starting at once apply each migration once: the migration step holds a lease in the database. Set `LIAISON_MIGRATE_ON_START=false` to skip the migration step, and run it on its own with `docker compose -p liaison -f deploy/docker-compose.yml run --rm app migrate`. It waits for Postgres, Redis, MeiliSearch and the object store to be healthy and for the bucket and data directory to be ready. A failed migration stops it before it serves traffic. To move to a new release, see [Upgrade Liaison](../admin/upgrades.md).

## Restart or upgrade without dropping work

When Docker stops the app container (a restart, `docker compose up -d` with a new image, `docker compose down`), it sends SIGTERM and waits `stop_grace_period` before it kills the process. The app uses that time to finish what it started:

1. `/readyz` answers 503 at once, so a load balancer stops sending new requests. Until the edge grace below has passed, the load balancer may not have seen that yet, so the process still serves what reaches it: a direct agent chat request starts its turn here, and that turn finishes or moves to another process like any other. A message posted in a thread is handed to a running process as a job. After the grace, a direct agent chat request that still arrives (on a connection kept open) gets a 503 with `Retry-After: 1` and nothing saved, and the client sends it again once.
2. Two seconds later (`SHUTDOWN_EDGE_GRACE_MS`) the server stops accepting connections and closes its WebSockets with code 1012. The web app reconnects within a quarter of a second, to whichever process answers.
3. Requests already running finish (`SHUTDOWN_HTTP_DRAIN_MS`, 20 s), every response says `Connection: close`. Running agent turns finish (`SHUTDOWN_TURN_DRAIN_MS`, 20 s), and running jobs finish (`SHUTDOWN_JOB_DRAIN_MS`, 20 s). A job still running at its budget is stopped and goes back to its queue without losing a retry, so another process (or this one after the restart) runs it again. An agent turn still running at its budget is asked to stop at the end of the step it is in; 3 s later its model call is cut and its running tools get 1.5 s more. The turn is then handed off: another process claims it and carries it on from its last complete step, with the one reply written there. A process that dies without draining leaves its turns to the resume sweep (every 10 s, on the leader): a turn whose heartbeat is 30 s old and whose process is gone is taken over the same way. A write tool call of a turn runs at most once, through the effect ledger (`kernel.effect_ledger`).
4. The outbox, the pools and the connections close, and the process exits with code 0.

The process exits by itself at `SHUTDOWN_HARD_DEADLINE_MS`. Unset, it is computed from the budgets: 58 s with the defaults. The app logs the numbers it uses at boot, in a `Shutdown budgets` line (`hardDeadlineMs`). If the process is so stuck that even that deadline cannot run (its main thread is blocked), a watchdog kills it 3 s later and logs a fatal `shutdown watchdog` line first, still inside the 5 s margin below.

### Set the stop grace period

The container's stop grace period must be at least the hard deadline + 5 s, or the runtime kills the process in the middle of its drain and the work it was finishing is lost. With the default budgets that is 65 s. Docker's own default is only 10 s, so set it wherever the container is stopped:

- Docker Compose: `stop_grace_period: 65s` on the app service (the shipped compose file sets it).
- `docker run --stop-timeout 65 ...`, and `docker stop -t 65 <container>` or `docker restart -t 65 <container>` by hand.
- Kubernetes: `terminationGracePeriodSeconds: 65` in the pod spec.

If you raise a budget, read the new `hardDeadlineMs` from the boot log and raise the grace period with it. If your orchestrator's grace period is fixed, set `SHUTDOWN_HARD_DEADLINE_MS` 5 s under it instead: every drain is then shortened to fit.

With a single app container, a restart still leaves a gap: between the old process stopping and the new one being ready, requests fail and clients wait to reconnect. To deploy with no gap, see [Deploy without downtime](#deploy-without-downtime).

## Deploy without downtime

A rolling deploy starts the new release beside the old one, waits until it is ready, and only then drains the old processes. Nothing is stopped or cut: requests, agent turns and jobs are at most delayed.

### Switch to the rolling services

The compose file has a `rolling` profile with three services built on the same image and settings as `app`:

- `api`: `LIAISON_ROLE=api`, HTTP and WebSockets. Its port is a host port range, `API_PORT_RANGE` (`3001-3004` by default), so old and new processes can run at once.
- `worker`: `LIAISON_ROLE=worker`, jobs and singletons, no public port.
- `migrate`: runs the migrations and the catalog apps once, then exits.

The [sandbox service](sandbox.md) is not one of them: `deploy/rolling-deploy.sh` recreates it on the new image once the new processes are ready, and starts it when none runs yet.

`api` and `worker` never migrate on start, and they give agent turns and jobs 10 minutes to finish when they stop (`SHUTDOWN_TURN_DRAIN_MS` and `SHUTDOWN_JOB_DRAIN_MS` at 600000, hard deadline 638 s, `stop_grace_period: 11m`). When they stop, `/readyz` answers 503 at once and the listener stays open 5 more seconds (`SHUTDOWN_EDGE_GRACE_MS` at 5000), so the edge has stopped choosing them before their connections close.

During a deploy both releases run side by side for up to those 10 minutes. Size the host's memory for it: each Liaison container may use up to its `mem_limit` of 3 GB, so with the defaults the overlap holds six of them (2 old and 2 new `api`, 1 old and 1 new `worker`), up to 18 GB, seven on the first switch from `app`, on top of about 5 GB for Postgres, Redis, search and object storage. On a smaller host lower `API_REPLICAS`, `WORKER_REPLICAS` or `mem_limit`.

### Database connections

Old and new processes hold their connections at once, and `migrate` connects while the old ones still do, so the pools must fit Postgres `max_connections`. The `api` and `worker` services plan their pools from one budget, `DB_CELL_MAX_CONNECTIONS`, which compose sets from `POSTGRES_MAX_CONNECTIONS` (200 by default; the Postgres default of 100 is too low), and from `API_REPLICAS` and `WORKER_REPLICAS`. With the defaults an `api` process opens 26 connections and the `worker` 34, so two releases side by side need 172, which is what the budget leaves after 15 for admin tools and 13 for `migrate`. A topology whose one release cannot fit refuses to boot. See [Database connections](pools.md) for the plan, the boot checks and the settings. `scripts/compose-db-connection-budget.test.ts` checks the compose defaults.

### Put an edge in front that holds requests

Copy `deploy/Caddyfile.rolling.example` to your Caddy configuration and set your domain. It lists the `app` port and every port of the range (keep the list in step with `API_PORT_RANGE`), checks each one's `/readyz` every second, and sends traffic only to ready processes. When a request cannot reach a process (none is ready, or a connection to the chosen one is refused), it holds the request and retries for up to 60 seconds instead of answering 502. A request that already reached a process is never sent again, a `GET` included (`lb_retry_match` matches nothing), so a one-time link is never used twice. A stopping process finishes the requests it has; if a process crashes mid-request, the client gets a 502 and retries itself. It writes a JSON access log.

Point the edge at this configuration before your first rolling deploy. Once the first deploy has stopped `app`, remove port 3000 from it.

### Run a deploy

```bash
LIAISON_IMAGE=<new image> deploy/rolling-deploy.sh
```

The script:

1. Refuses to start while another deploy is running (exit code 1), or while the old processes of the previous deploy are still draining (exit code 75). Try again once they are gone. If that drain was itself stopped (a dropped SSH session with `--wait-drain`, a reboot), it starts the drain again first. If a deploy was killed before its switch, the next run rolls that deploy's new processes back while its old ones still run, then deploys.
2. Runs the migrations and the catalog apps once, in the `migrate` service of the new image. If a migration fails, or a first-party app does not install, it stops here: no process was started or stopped. An app fails to install when the image carries other files under a version that is already installed; raise the app's version and build again.
3. Starts the new `api` and `worker` processes beside the old ones (`API_REPLICAS`, 2 by default, and `WORKER_REPLICAS`, 1, from the environment or `deploy/.env`; the processes budget their pools for the same numbers). It never recreates a running container and never touches Postgres, Redis, search or object storage. It refuses before migrating if old and new `api` processes do not fit in `API_PORT_RANGE`.
4. Waits until every new process is healthy (`READY_TIMEOUT_S`, 300 s). If one exits or never gets ready, it rolls back: it stops and removes the new processes, the old ones keep serving, and it exits 1. When the [app sandbox service](sandbox.md) runs, it is then recreated on the new image (it refuses runs of another release).
5. Waits 2 seconds for the edge to see the new processes, then stops the old ones with the full drain budget and removes them. This drain runs in the background and logs to `deploy/.rolling/drain.log`. Pass `--wait-drain` to wait for it.

The first rolling deploy on a host that runs the single `app` container treats `app` as old: it is stopped only once the new processes are ready. From then on, deploy only with the script: a plain `docker compose up -d` starts `app` again on port 3000, with the default image and migrations on start. The next deploy drains it as an old process and says so.

Ctrl-C, a stop signal or a dropped SSH session stop the script cleanly: before the switch it rolls back the processes it started, after it the old ones keep draining, and the lock is released. A rollback gives each new process its full drain budget, so it can take a while: run the script under `nohup`, `tmux` or `systemd-run`. The lock in `deploy/.rolling/lock` records the deploy's process; a lock left by a deploy that no longer runs is taken over with a message.

To change Postgres, Redis, search or object storage, pass `--infra`. The script then brings those services up first, which may recreate them. That deploy is not zero-downtime.

### Know what two releases share

Both releases load app files from the same install directory. So:

- A version directory of an installed app is written once and never changed. An app is unpacked into a temporary directory, then moved into place. Installing a package with different files under a version that is already installed is refused: publish the change as a new version.
- An older release never moves an app back to an older version. When the active version is newer than the one in its image, it keeps the newer one, runs its own image's version in its own process, and logs `app_version_ahead`. It keeps that version when the new release activates an app version, and after a rolled-back deploy.
- Old versions are removed after an upgrade, except the active one, the one before it, and any version a running process still uses. Each process lists the versions it uses in Redis; when that list cannot be read, nothing is removed.
- An app upgrade's data check compares the new version with the running one. When the running version's files are not on this host, it uses the data schema recorded when that version was installed.
- An app's scheduled job is one scheduler per app and job, shared by every workspace (the cron fan-out). Both releases run its ticks, and each workspace still gets one run per tick. To roll back to a release from before the fan-out, deploy the previous image everywhere first, then remove the fan-out schedulers it cannot run:

  ```bash
  bun apps/api/scripts/cron-fanout-rollback.ts           # report only
  bun apps/api/scripts/cron-fanout-rollback.ts --apply
  ```

### Keep one workspace from filling the job queues

Workspaces take turns on the job queues. While another workspace has work waiting, one workspace runs on at most half of a queue's worker slots, counted across every job host; alone, it may use them all. Jobs over that share wait in the queue and spend no retry. This is on by default. To turn it off, set `JOB_ORG_FAIRNESS=off` on every `all` and `worker` process and restart them.

`GET /diag` (with `MONITOR_TOKEN`) shows it under `jobs.fairness`: per queue, how many jobs were admitted, denied (each denial parks its job) and promoted since the counters began, how many are parked now (`parkedNow`), how many workspaces hold running jobs (`busyOrgs`, a count), the p95 wait over the last 5 minutes (`waitP95Ms`), and `degraded` when Redis did not answer the check in time and jobs ran unchecked. `jobs.fanout` counts the scheduled app jobs per app and job (`byJob`).

### Check that a deploy only delayed work

```bash
DEPLOY_COUNTERS_DB_URL=<database URL> bun scripts/deploy-counters.ts --since <deploy start> --edge-log <Caddy access log> --app-log <app JSON log>
```

It counts, from the deploy start to now (or `--until`): the edge's 5xx answers, the agent turns the deploy cut (a turn whose process stopped or died and that could not be carried on, or one not finished after 15 minutes), and the effects the effect ledger saw twice (`effect_duplicate` log lines). Each source is optional. It exits 1 when any count is not 0. `--app-log -` reads the app log from standard input, for example from `docker logs`. The database URL comes from the environment only, so it stays out of the process list. A turn records why it did not finish (`failure_reason`): one that failed on its own, a model error for example, or whose caller left is not counted, so the counters also work under real traffic.

## Use signed first-party apps

When you build the image (`apps/api/Dockerfile`), each first-party app in
`bundled-apps/` comes from one of two places:

- **The signed release artifact**, when Liaison published one for exactly this
  app, version and source (same source digest) and its signed statement
  verifies with the app-signing keys in the source. The build downloads it from
  `https://downloads.liaison.sh/apps/` and keeps the statement, so the desktop
  app can verify the app's interface and run it in its main page.
- **A local build**, unsigned, in every other case: no app-signing key listed
  yet, a version not published yet, an app you changed (a fork), the download
  host unreachable, or a statement that does not verify. The app works the
  same; the desktop app runs its interface in the sandbox frame.

The build reads the list of signed releases,
`https://downloads.liaison.sh/apps/index.json`, with a Dockerfile `ADD`, so
Docker checks it on every build: when a new signed release is published, the
next build of the same source rebuilds the app catalog and takes it, with no
cache flag. Once that list is in, a download that fails never fails the build:
it prints one line per app saying which source it used and why. The list itself
must be reachable, though; when it is not, build with
`--build-arg LIAISON_APP_INDEX_URL=`.

To build every first-party app locally, unsigned, with no request to
`downloads.liaison.sh` at all (an offline builder), pass
`--build-arg LIAISON_APP_INDEX_URL=` (an empty value). To
take the artifacts from your own HTTP mirror, pass its index URL instead, for
example `--build-arg LIAISON_APP_INDEX_URL=https://mirror.example/apps/index.json`;
the artifacts are read from the same directory, with the same layout.

To build without network access to `downloads.liaison.sh`, mirror the artifacts
into the build context and point the build at them:

1. Copy `apps/index.json` and the `apps/<name>/<version>/` directories you need
   into a directory inside the repository, for example `app-artifacts/`, keeping
   the same layout (`app-artifacts/index.json`,
   `app-artifacts/boxtal/0.15.3/statement.json`, ...).
2. Build with the mirror:

   ```bash
   docker build -f apps/api/Dockerfile \
     --build-arg LIAISON_APP_INDEX_URL= \
     --build-arg LIAISON_APP_ARTIFACTS_DIR=/app/app-artifacts .
   ```

With `LIAISON_APP_ARTIFACTS_DIR` set the build reads only the mirror, including
its `index.json`. Running `bun run scripts/build-app-catalog.ts` outside Docker
honours the same variable, and takes `--no-artifacts` to build every app
locally.

## Know that outside effects run once

A job handed back during a restart, or run again after a worker died, does not
send its mail, push or deposit twice: each outside effect is claimed in the
effect ledger (`kernel.effect_ledger`) before it happens, and a second run
replays the stored answer. An effect a dead worker may or may not have
completed is recorded as unknown and is never sent again blindly. Every job and
what guards its effect is listed in
[Outside effects during a deploy](../runbooks/deploy-effects.md).

## Leave the load harness off

`LOAD_HARNESS_KEY` turns on the load harness, which stress runs use to drive a
box with synthetic visitors. Set it only on a box you load-test, never on a
real deployment. Unset (the default), the harness does not exist: a request
signed for it gets a 404, and no organization is treated as a load
organization.
With it set, a demo start signed with the key creates a synthetic workspace on
a `@load.invalid` address. Such a workspace sends nothing off the box: its
mail, pushes and verification codes are counted instead of sent, and its agent
turns use a fixed scripted model instead of a model provider. Signed starts
have their own limits, apart from visitors': `LIAISON_DEMO_SYNTHETIC_PER_HOUR`
(signups, codes and verifications per hour, default 60) and
`LIAISON_DEMO_SYNTHETIC_MAX_ORGS` (synthetic workspaces at once, default 500).
A load run never spends the visitor limits, so it cannot lock real visitors
out, and visitors keep every limit of their own. A signed start takes a
workspace from the warm pool exactly like a visitor, so a load run measures the
pool. The key must be at least 32 characters, it cannot be set together with
`ENABLE_LOAD_TEST_ENDPOINT`, and in production it is accepted only on a demo
box (`LIAISON_DEMO_MODE`): a production process with the key and without demo
mode refuses to start.

Two more signed routes serve job stress runs, for load workspaces only.
`POST /api/demo/harness/flood` queues up to 20 000 synthetic jobs for one load
workspace, each holding a worker slot for at most 2 s; a workspace may have at
most 50 000 waiting (jobs that left their queue without running stay counted
until a flood carries `reset: true`, which forgets them). `POST /api/demo/harness/fanout-report` reports, for a set
of load workspaces and a time window, whether every scheduled app job ran once
per workspace and schedule time (missed, doubled or skipped runs), how evenly
the runs spread, the number of job schedulers, and each workspace's job wait (read over the last 120 minutes of the window
at most; the report says which span, `waitsWindow`). A job handed back at a
shutdown is not counted twice when it reruns.
The window and the workspaces travel in the signed body, never the query.

## Test deploys under load

On a box with the load harness on, `bun run load-test` can run deploys while
synthetic workspaces use the box, and check that the deploys only delayed
work. You need [k6](https://k6.io) on the machine that drives the run, and the
box's key in `LOAD_HARNESS_KEY`.

### Seed load workspaces

`bun run load-test --deploys N --orgs 10` seeds its own workspaces before the
traffic starts. Each workspace is made through the signed demo start, from the
warm pool when it has one, and verified with the code the box kept instead of
mailing it. The run writes them to `--out <dir>/orgs.json`, which holds each
workspace's sessions, so keep it private; a later run reuses them with
`--orgs-file`. The same `--seed` within the hour returns the same workspaces.

Busy orgs that only fill the box (many tenants, search and list scale) need no
sessions: seed them inside the app container with
`liaison seed --tier load --orgs 50` (add `--volume` for thousands of threads,
contacts, tickets and projects each). They are marked as synthetic demo
workspaces with an expiry (`--ttl-hours`, default 6), so the demo reaper
deletes them.

### Run deploys under load

```bash
LOAD_HARNESS_KEY=<key> bun run load-test --deploys 10 --box https://<box> \
  --deploy-cmd "<command that runs one deploy>" --orgs 10 \
  --edge-log-cmd "<command that prints the edge's JSON access log>"
```

It seeds the workspaces (or reuses `--orgs-file orgs.json`), starts the
traffic, runs the deploy command 10 times, waits, and stops the traffic. Every
workspace loads pages, writes through the API, holds a live connection and asks
its agent a question every few seconds. The agent turns use the scripted load
model, so each one has a known reply.

The run passes when all of these are 0: answers with a 5xx, requests cut
without an answer, turns that did not end with exactly their reply, failed
deploys, and, when their sources are given, the edge's 5xx
(`--edge-log` or `--edge-log-cmd`), duplicate effects in the app log
(`--app-log-cmd`), stored turns cut or with a wrong reply
(`DEPLOY_COUNTERS_DB_URL`), and effects the box counted twice for a load
workspace. It also reports the delay during the deploys (median, 95th
percentile and longest, for requests, turns and reconnections) next to the same
outside the deploys, and the errors by type. The report is in
`--out <dir>/report.json`, the summary in `summary.txt`, and the run exits 1
when it does not pass. `bun run load-test --deploys 1 --help` lists every flag.

A counter is never read as clean when it was not measured. Each counter in
`report.json` is `measured`, `not_measured` or `failed`, with its reason, and
the summary prints `NOT MEASURED: <counter> (<reason>)`. The run also exits 1
when a source you asked for gave nothing (an empty log, a log in another
format, a failed read of the box), when fewer deploys ran than asked, when the
traffic generator exited early or with an error, or on any 401, 429, signup or
verify error. A deploy command, a log command and a request to the box each
have a time limit (`--deploy-timeout`, `--log-timeout`, `--fetch-timeout`;
30 min, 5 min, 30 s), and the traffic generator is killed `--k6-grace` (2 min)
after the driver asks it to stop.

### Run a launch scenario

```bash
LOAD_HARNESS_KEY=<key> bun run load-test --launch --box https://<box> \
  --levels 300,1000 --ramp 5m --hold 10m --walk 5m
```

Synthetic visitors sign up through the signed demo start, verify, then browse
and ask their agent for `--walk`. `--levels` holds that many active workspaces
in turn; `--arrival-rate <per minute>` makes them arrive at a rate instead.
`--deploys N` runs deploys during it too. The report adds the share of signups
the warm pool served and the time to a ready workspace. A start the box answers
"being prepared" (202) is asked again with the same signup key, as the browser
does; the report counts those answers as `202_preparing`. The box's own limits
for synthetic workspaces (`LIAISON_DEMO_SYNTHETIC_PER_HOUR`,
`LIAISON_DEMO_SYNTHETIC_MAX_ORGS`) still apply: raise them on the box for a
large run.
