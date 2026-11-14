# Testing

## Running Tests

Run suites from the repo root through `bun run <script>`, single files with `bun run scripts/test-run.ts <suite> --file <path>` (`--file` may repeat), and the tests a change needs with `bun run test:gate`. A suite that lists its files by name also runs the files listed in `scripts/test-suites.d/<suite>/*.txt` (one path per line, relative to the suite's cwd): a new test file goes in a file of its own there, so two pull requests never add lines to the same list. `.claude/skills/run-tests/SKILL.md` has the details (namespaces, slots, memory budget, per-directory quirks).

### Scripts (repo root)

| Script | Scope |
|--------|-------|
| `test:gate [--base origin/main] [--dry-run] [--matrix-json <file>]` | The suites and files the current change affects (see below) |
| `test:unit` | Backend unit, sharded over template clones, batches of 8 files per bun process (also runs `test:guards` and `test:root`, the repo-root script tests); see Unit runner below |
| `test:integration` | Backend integration |
| `test:e2e:parallel` | Backend E2E (4 parallel workers) |
| `scripts/test-run.ts cell` | Multi-process scenarios in `apps/api/src/tests/e2e/cell/` plus the cell clients' test: each file boots its own cell of `src/index.ts` processes (`createRoleCell`, typically 2 `api` + 1 `worker`, so about 3 bun servers), one file at a time. The `e2e` suite and the e2e-parallel lanes skip that directory. On a loaded machine run one file at a time with `--file`: a single-file run reserves 2 GiB of memory instead of the whole-suite 8 GiB (`TEST_MEM_RESERVE_MB` overrides either) |
| `test:web` | Frontend Vitest |
| `test:playwright` | Playwright browser E2E |
| `test:full` | All suites in `scripts/test-run.ts`'s `FULL_ORDER`, after one fresh clone of the namespace database: unit, integration, e2e-parallel, cell, web-unit, playwright, security, bundled-ads, bundled-shopify, root |

Test env vars load from the repo-root `.env.test` (gitignored; create it from `.env.test.example`, which says how to fill its two secrets). `scripts/test-run.ts` loads and injects it explicitly, because bun's cwd-based auto-discovery runs with cwd `apps/api` and would otherwise miss the repo-root file. The run namespace's coordinates (below) are set before it and win over it.

### Run namespaces: several checkouts testing at once

Every run of `scripts/test-run.ts` (and `with-test-lock.ts`, `test:gate`) works in a namespace: the checkout's directory name (a worktree's name), or `LIAISON_TEST_NS`. Everything it creates carries it, so two worktrees test at the same time on one docker compose stack without touching each other. One resolver, `packages/test-helpers/src/test-namespace.ts`, hands out every coordinate.

| Resource | Namespaced as |
|---|---|
| Postgres | database `liaison_test_<ns>` (worker schemas `w<N>_*` inside it; unit shards `liaison_test_<ns>_s<N>`) |
| Redis | keys `<ns>:` per run, `<ns>:w<N>:` per e2e worker |
| Meilisearch | indexes `<ns>-` per run, `<ns>-w<N>_` per e2e worker |
| Ports | a 1000-port block leased to the namespace (16000-31999), `base + (N mod 100) * 10` per worker |
| Object store | shared bucket; every key is under a freshly minted org id |

**Template databases.** The migrated schema, with the in-tree apps' manifest schemas applied on top by the app registration itself (`apps/api/src/db/apply-app-schemas.ts`), is built once into `liaison_tpl_<hash of the migrations dir, the migrator, the in-tree app manifests and the registration code>` (under a short build lock, about 3 s), so a test that reads an app's tables gets the manifest's shape whichever files ran before it. `LIAISON_TEST_TEMPLATE_APP_SCHEMAS=0` selects a migrations-only template (its own key) for a run that must see registration start from the migrated shape. A run copies it with `CREATE DATABASE ... TEMPLATE` (about 0.2 s) instead of dropping and replaying every migration. `e2e`, `e2e-parallel` and `playwright` take a fresh copy per run (and `full` once); every other suite reuses the namespace database while it was cloned from the current template. Templates no checkout uses are collected after an hour. A bare `bun test` with no namespace still uses the shared `liaison_test`.

**Slots, not a lock.** `LIAISON_TEST_SLOTS` heavy jobs (default 2) hold a machine-wide slot at once: test runs, and also `typecheck`, `check:docs`, Playwright, app and catalog builds (`scripts/lib/machine-slots.ts`). Each test run sizes its workers from its share of the RAM budget. A further job waits its turn in arrival order, and does not start while the 1-minute load average is at or above `LIAISON_SLOT_MAX_LOAD` (default 1.5 times the core count on macOS, no gate elsewhere unless set) while the CPUs are busy: a load over the gate with the CPUs at least `LIAISON_SLOT_MIN_IDLE` percent idle (default 25; macOS counts disk waits in the load) does not hold a job back, and neither does it once the job has waited `LIAISON_SLOT_STARVE_SEC` (default 600, `off` for never) with a slot free, since most of a shared machine's load is other work a waiter can neither cause nor outwait; a new job also waits while macOS reports warn or critical memory pressure (`kern.memorystatus_vm_pressure_level`), while available memory (on macOS free plus cached-file pages, on Linux `MemAvailable`) is below `LIAISON_SLOT_MIN_FREE_MB`, or while swap in use is above `LIAISON_SLOT_MAX_SWAP_MB` (on macOS only under that pressure: swap stays allocated long after it; defaults 1024 and 4096 on macOS, no memory gate elsewhere unless set; `0` or `off` disables either); a job already holding a slot is never paused. A holder that died, or whose pid now belongs to another process, frees its slot, and a run whose preflight fails gives its slot back at once. `bun run slots` shows holders, waiters, the load, available memory, swap and the macOS pressure level. A targeted run (`--file`, one or more) keeps the 2 GiB single-file memory reserve, and on macOS the run's memory guard counts low available memory only under warn or critical pressure. Wrap any other heavy command in `bun run scripts/with-test-lock.ts [--slot-only] -- <cmd>` (`--slot-only` when it needs no test database). A light lane of `LIAISON_LIGHT_SLOTS` (default 2), with its own queue, the memory gate and no load gate, runs short jobs beside the heavy ones: `--slot-only` puts a `tsgo` or Biome command there by itself, and `--light` puts any other job of about a minute that needs no database there. Two runs of the SAME namespace serialize (they would share a database); set `LIAISON_TEST_NS` to run a second one beside the first.

### Unit runner (`scripts/test-unit-parallel.ts`)

The unfiltered `unit` suite spreads its files over `TEST_UNIT_SHARDS` shard databases (`liaison_test_<ns>_s<N>`, fresh template copies). Each shard runs its files in batches of `TEST_UNIT_BATCH` (default 8, `--batch=N`) per bun process, so a batch pays the module-graph import once instead of once per file. A file runs alone in its own process when it calls `mock.module` (bun cannot undo it for later files) or asserts that a process-global registry is empty (`_getGlobalHandlerCount()`). A file that fails inside a batch is rerun alone before it counts; the report lists files that only passed alone (cross-file bleed: fix it or make the file solo). A file still failing then gets one retry, in parallel across freshly recloned shard databases, unless its failure already reproduced alone (failed in a batch, then failed again in its own process): a deterministic failure is not run a third time. The report lists files that only passed on the retry and prints the wall clock split into main pass, alone reruns and retry. `--batch=1` restores one process per file. `TEST_UNIT_TIMINGS=<file>` writes per-file times as JSON. Each process writes to files, not pipes, and a process that adds nothing to them for `TEST_UNIT_SILENCE_MS` (default five per-test timeouts, 300 s) is wedged: `--timeout` cannot fire while its event loop is stopped, so the runner kills it and reports the files it held and its last lines.

Route tests take `acquireTestLock` / `releaseTestLock` from `src/tests/route-test-setup.ts`. Each call empties the kernel tables (the `TRUNCATE ... CASCADE` set) and the file's rate-limit/BullMQ Redis keys. The table reset DELETEs only the non-empty tables of that set, over a superuser connection with `session_replication_role = replica` (no row triggers, no FK checks, as TRUNCATE), about 20 ms instead of 0.5 to 0.9 s; without a superuser connection it falls back to TRUNCATE. `createTestOrg` resets and bootstraps a fresh org. Its app registration runs with `appSchemaDdlReuse` on: an app whose schema already carries the current DDL stamp (same manifest, same registration code, no missing declared column) gets only the new org's rows and in-memory declarations, not its schema DDL again, about 0.9 s per org instead of 2 to 4 s. `src/modules/apps/schema-ddl-reuse-equivalence.test.ts` proves the result matches the full registration row for row; `createTestOrg({ reuseAppSchemaDdl: false })` forces the full DDL. Production never sets the flag. A file that can share one org should still create it in `beforeAll`.

### `test:gate`

`bun run test:gate [--base origin/main]` takes the paths changed since the merge base (plus the working tree and untracked files) through `.claude/test-map.ts`. A changed test file runs alone in the suite that lists it, a unit source file runs its co-located `<name>.test.ts` / `<name>.*.test.ts`, a changed scenario runs alone in e2e-parallel; any other mapped change runs that suite whole, and a path the map does not cover (docs aside) runs the broad set. Database suites run one after another in the namespace, the others in a small pool beside them. It prints what ran, what it skipped and why, and each suite's wall clock; `--dry-run` prints only the plan.

### The `gate` workflow: heavy lanes on hosted runners

`.github/workflows/gate.yml` runs the heavy lanes of a change on GitHub-hosted runners, started by hand: `gh workflow run gate.yml --ref main -f ref=<commit> -f base=<base>`. Its `plan` job takes the paths changed between the merge base of `base` and `ref` through the same planner as `test:gate` (`--dry-run --matrix-json <file>`) and keeps the lanes in `GATE_LANES` (`scripts/test-gate.ts`): every suite the test map names except the four per-PR CI runs (`PR_CI_SUITES`: unit, web-unit, root, guards): integration, integration-extra, integration-mocked, security, e2e-parallel, demo-seed, Playwright, cell, api-guards, shared, workspace-packages, worker-env, unsplit-logins, the bundled apps' suites and UIs, bundled-freeze, desktop-ui and mobile. The desktop shell's own suite needs a Mac (`NOT_HOSTED_SUITES`, with the reason): the plan prints it as not run on hosted runners, and it is run by hand with `bun run test:desktop`. `scripts/test-gate.test.ts` fails when the map names a suite that is in none of the lists. Each lane is split over runners with `scripts/test-run.ts <suite> --shard <i>/<n>`, which deals the suite's files round robin over their sorted list (a one-shard lane, the vitest suites, runs whole). Playwright's files are dealt by measured time instead, longest first to the shard with the least so far, from the per-file seconds in `scripts/lib/playwright-timings.json` (a file it does not know counts as the median); refresh the table from a run's reports with `bun run scripts/playwright-timings.ts <junit.xml|output.log>...` when the shards drift apart. No lane needs a provider key. The job timeouts add up to 60 minutes; the `report` job writes one table (lane, shard, result, minutes) as the run's summary, and a failing shard keeps its logs and Playwright reports as an artifact.

### The `ci` workflow and the merge queue

`.github/workflows/ci.yml` runs on every pull request, on every merge group of `main`'s merge queue and on every push to `main`. Its `static` job (lint, typecheck, the `check:*` guards, the root and guards suites, the tour suites) runs every time. The api unit suite and the web unit suite run on a pull request only when `.claude/test-map.ts` attributes one of its changed files to `unit` or `web-unit` (`bun run scripts/ci-scope.ts tests --base origin/main` prints the decision). Hosted runners are the scarce resource, so a pull request runs them in as few jobs as possible: the api unit suite in one `unit` job, the web unit suite as a step of `static`. The relation cells (the `relations` suite) run as a step of that `unit` job when the map attributes a changed file to them, and on every merge group. A path the map does not cover, other than plain docs, and a change to a `package.json`, the lockfile, a tsconfig, the Biome config, a workflow or the map itself run both. A merge group runs everything, split for wall clock (`unit` over three jobs with `TEST_UNIT_PART`, `web-unit` over two vitest shards): it is the full gate, on the exact tree `main` gets. A push to `main` runs `static` only, since its merge group already tested that tree. The `checks` job, the one branch protection requires, passes only when every job that had to run passed, so a skipped test job never leaves a required check pending.

`bun run pr:land <number> [--wait]` (`scripts/pr-land.ts`) checks the pull request (open, not a draft, against `main`, no conflict, every check green, the required ones reported) and adds it to the merge queue, pinned to the head commit it checked. The queue tests it on top of `main` and the pull requests ahead of it, squash-merges it when the merge group passes and removes it when it fails. With `--wait`, it waits for the checks, then for the merge or the removal, and prints the failing merge-group run's log on a removal.

### Soak tests (`*.soak.test.ts`)

A soak test proves a path at production scale: `apps/api/src/modules/imports/transforms/execute.soak.test.ts` runs a 2 GiB zipped CSV through the upload transform and checks the sandbox heap bound, and `apps/api/src/modules/imports/uploads/uploads.soak.test.ts` sends a 2 GiB file to the object store as a multipart import upload. Each takes minutes and writes its fixture (about 2 GiB) to `$TMPDIR`, deleting it afterwards. They skip unless `LIAISON_SOAK=1`, and no suite or gate runs them: the unit runner and `test:gate` leave `*.soak.test.ts` out. Run one by hand under the lock, from `apps/api`:

```
LIAISON_SOAK=1 timeout 1500 bun run ../../scripts/with-test-lock.ts -- bun test --timeout 1800000 src/modules/imports/transforms/execute.soak.test.ts
```

`SOAK_BYTES` (transform) and `SOAK_UPLOAD_BYTES` (upload) shrink the fixture for a quicker run.

## Test data: the seed engine

Every test, the dev server, the demo and private boxes get their data from one seed engine, `apps/api/src/seed/`. It writes through the services the product's own routes call, as the person who acts, so a row a service would refuse is refused in a test too. Every instant is an offset from one `now` and every id is a pure function of its inputs (`seed-determinism.test.ts` fails on a bare `Date.now()`, `new Date()` or `Math.random` under `seed/`).

### Tiers

| Tier | What it seeds | Who uses it |
|---|---|---|
| `minimal` (`seed/tiers/minimal.ts`) | Nothing by itself: one row per call on an org the test already has (`person`, `session`, `adminSession`, `thread`, `contact`, `grantScope`, `revokeScope`, `assignRole`, `revokeRole`, `secondOrg`). People sign in with `MINIMAL_PASSWORD` | Unit and integration tests: `import * as minimal from "~/seed/tiers/minimal"` |
| `standard` (`seed/tiers/standard/`) | The QA world in the org of an existing admin: four teammates, fourteen channels and chats, contacts, knowledge, agent-app content and memory, tickets, the admin's home feed, approvals in every resting state, saved views and mail | Playwright lanes and `bun run dev` |
| `demo` (`seed/tiers/demo/`) | The Resonant Audio Labs demo world: seven people, agents, tickets, mail, knowledge, projects, invoices, shipments, routines | Demo signup and warm pool |
| `lively` (`seed/tiers/lively/`) | The demo world with ten people and fourteen days of activity up to now | Private boxes (walks, UI checks, screenshots) and self-hosted trials |
| `load` (`seed/tiers/load/`) | `--orgs` disposable busy orgs, marked synthetic with an expiry; `--volume` adds thousands of rows each | Load runs |

`standard`, `demo`, `lively` and `load` run from the CLI: `liaison seed --tier <tier>` (from `apps/api`: `bun run src/cli/index.ts seed --tier <tier>`). Every flag is in the [CLI reference](reference/cli.md#seed) and [Provision from a config file](provisioning-cli.md). Outside the runtime image, `demo`, `lively` and `load` read the catalog apps from the checkout's `app-catalog/` (`bun run scripts/build-app-catalog.ts`) and unpack them into `.liaison-apps/apps`, unless `LIAISON_APP_CATALOG_DIR` and `LIAISON_APPS_DIR` say otherwise; with no catalog, a seed that writes the shop and invoices (all but `lively --no-commerce`) stops and names the variable.

### The standard world's people

The admin is Elodie Vasseur, `admin@test.com` / `12345678`. Her teammates are Amina Cherif, Lucas Pereira, Tobias Braun and Margot Dufour, at `<first name>@resonantaudiolabs.example` with the password `QaPass1!` (`seed/world/qa.ts`). The world is not idempotent: a second run into the same org is refused, so a lane or a dev reset starts from an org with only its admin. `--now <instant>` fixes the base time; `--only agent-app` puts the agent-app part (skills, routines, agent chats, past runs) back in an org it already seeded. It prints the seeded ids as one JSON line on stdout.

### Factories

Tiers are built from domain factories in `seed/factories/<domain>/` (`agent`, `approvals`, `attention`, `calendar`, `commerce`, `knowledge`, `mail`, `org`, `people`, `projects`, `support`, `threads`, `timeline`). Each takes a `SeedContext` (`seed/context.ts`: the org, the one `now`, the deterministic id of a row by kind and key). A test that needs a row a tier does not give calls a factory, or `minimal`, never a raw insert.

### Rows from inside a browser or api e2e test: `POST /api/_test/seed`

A Playwright test or an api e2e scenario runs in another process from the server under test, so it asks that server for rows: `POST /api/_test/seed` with `{ "factory": "<group>.<name>", "orgId": "<uuid>", "args": { ... } }` runs one named factory there. The names are in `apps/api/test-support/seed/factories.ts` (`tickets.ticket`, `mail.conversation`, `roles.grantScopes`, `org.second`, `pricing.catalog`, ...); `orgId` is required except for a factory that makes an org. It answers `200 { data }`, `400` for an unknown factory or invalid args, `422` when the factory refused. Each call's `now` is the request's wall clock.

The route exists only when `qaSeedRoutesEnabled` is on (`NODE_ENV=test`, or `ENABLE_QA_SEED_ROUTES`, which the env validator refuses in production), and `apps/api/test-support/` is not in the production image. Call it through `seedFactory` (`apps/web/src/tests/e2e/helpers/seed.ts` in Playwright, `apps/api/src/tests/e2e/helpers/seed-factory.ts` in api e2e). A factory a test needs and the registry lacks is added to `factories.ts`, calling an engine factory.

### How each suite gets its data

- **Unit and integration:** `createTestOrg` (`src/tests/route-test-setup.ts`) gives a fresh org; `minimal` and the factories add what the test needs.
- **api e2e:** each lane bootstraps an org and its admin and snapshots it; `setupScenario({ populate })` adds `TestWorld`'s synthetic users and threads (`@liaison/test-helpers`), and `seedFactory` adds domain rows.
- **Playwright:** each lane seeds the `standard` world once (`seedStandardWorld`, `packages/test-helpers/src/standard-world.ts`, which runs `liaison seed --tier standard --admin admin@test.com` beside the lane's server and signs every person in), installs the apps that ship only as catalog apps (API connector, GitLab, Google Drive) as the admin through the App store's install route, from a catalog global-setup stages from their builds (`apps/web/src/tests/e2e/lane-catalog.ts`), then every spec file starts from its snapshot (Playwright lanes, below).

The raw-insert ratchet (`bun run check:raw-insert`, baseline `scripts/raw-insert-baseline.json`) lists, one path per line, the test files that still carry an `INSERT INTO` a kernel or app table. It fails when a file not on the list gains one, and when a listed file no longer has one: after removing raw inserts, drop their lines with `bun run check:raw-insert --write`. A list rather than a count, so two pull requests that each clean a file remove different lines and merge without a conflict.

### Dev seeding

`bun run dev` seeds the dev database when it has no threads yet. To reseed by hand: `bun run db:reset && bun run seed --yes` (`scripts/seed-qa.ts`). It creates the admin through the running server, runs the `standard` tier, then adds dev-only extras (model pricing, credits, agent chats, a second org when the seed routes are mounted).

## Backend Tests (`bun:test`)

- Test Hono routes using `app.request()` — no HTTP server needed
- Integration tests hit real PostgreSQL (transaction rollback for cleanup)
- Unit test services by mocking the `db` module
- Test files: `*.test.ts`, co-located or in `tests/` mirroring `src/`

## Frontend Tests (Vitest + `@solidjs/testing-library`)

- Wrap components in a function: `render(() => <Comp />)` — required for SolidJS reactive ownership
- Use `screen.getByText`, `screen.getByRole` — avoid test IDs unless necessary
- Test files: co-located as `ComponentName.test.tsx`

## E2E Infrastructure

**Packages:**
- `@liaison/test-helpers` — runner-agnostic DB/Redis/HTTP/auth/WS/port/worker-env utilities, the `standard` world (`seedStandardWorld`) and `TestWorld`, the lane attach handle

**Convention:** never test against an empty database. A Playwright file starts from the `standard` world; an api e2e scenario adds what it reads with `setupScenario({ populate })` and `seedFactory` (see Test data: the seed engine).

**Worker isolation:** `SCHEMA_PREFIX` (e.g. `w0_`), `REDIS_PREFIX` (e.g. `<ns>:w0:`) and `MEILI_INDEX_PREFIX` (e.g. `<ns>-w0_`) isolate parallel workers inside a run; the run namespace isolates runs from each other. `createWorkerEnv()` provisions schemas, allocates ports from the namespace's block, spawns isolated servers; under `test:e2e:parallel` it attaches to the slot's shared lane server instead (see Multi-Worker Architecture).

**BullMQ note:** BullMQ rejects ioredis `keyPrefix`. The server uses a dedicated `redisBullMQ` connection without `keyPrefix`, and sets BullMQ's own `prefix` option (e.g. `w0:bull`) for queue isolation.

## Agent-driven scenarios

Most agent scenarios script the model (the scripted provider, `LIAISON_MODEL_PROVIDER=scripted`, or `AGENT_STREAM_STUB`): the agent loop, tool bridge, approvals and persistence are real, only the token source is not. They run in the default suite.

**Live-model scenarios are opt-in.** A scenario that drives a **real LLM provider** (no mocks, no record-replay) spends money on every run, so it runs only with `LIAISON_E2E_LIVE_LLM=1`: `scripts/test-run.ts` then hands the `e2e` / `e2e-parallel` run (test processes and the API servers they boot) the machine's real provider keys. Without it those suites get the same fixed placeholder keys as every other suite (`apps/api/src/tests/test-env-defaults.ts`), and the live cases skip through `describeLive` / `itLive` (`apps/api/src/tests/e2e/helpers/live-llm.ts`). Gate a live case on that flag, never on "is a key set": the default run carries a placeholder key. Example: `LIAISON_E2E_LIVE_LLM=1 bun run scripts/test-run.ts e2e-parallel --file apps/api/src/tests/e2e/agent-runtime.scenario.test.ts`.

The live agent-runtime scenarios use `claude-haiku-4-5` because cheaper models hallucinate tool parameters too often. Each scenario:

1. Seeds a thread + workspace state (tickets, mail conversations, etc.).
2. Sends a natural-language prompt to `/api/agent/chat` and consumes the SSE stream.
3. Asserts the right `tool-call` events fire AND that the downstream DB state changes (or, for gated tools, that an approval row is created).

**Coverage matrix (illustrative, not exhaustive):** many more agent-driven scenario files exist under `apps/api/src/tests/e2e/`, including other `agent-*.scenario.test.ts` files plus scenarios like `compound-approval-agent.scenario.test.ts`, `media-analysis-agent.scenario.test.ts`, `projects-agent-runtime.scenario.test.ts`, and `sub-agent-smoke.scenario.test.ts`. The two below show the pattern:

| Test file | Surface | What it proves |
|---|---|---|
| `agent-runtime.scenario.test.ts` | Generic agent runtime — streaming, tool calls, persistence, scope filtering, credit deduction | The runtime itself works |
| `agent-tickets.scenario.test.ts` | Tickets app tools driven by the agent | `tickets__search`, `tickets__get`, `tickets__reply` (gated → approval row), `tickets__assign` (auto-executes), and a multi-tool fan-out (search → reply for each open ticket) |

**Provider-unavailable guard.** Inside a live run, a scenario whose provider is down short-circuits with `isProviderUnavailable(events)` and `return` rather than failing. It is not the gate: the default run skips the live cases before they reach a provider.

**Adding a new agent surface test.** Mirror the `agent-tickets.scenario.test.ts` shape:
- Seed app-specific state through `seedFactory` (`POST /api/_test/seed`), not via `populate`.
- Use `consumeSse(url, "/api/agent/chat", token, { threadId, content, modelId: TOOL_MODEL })`.
- Assert tool-call events by `toolName?.includes(...)` (provider name-mangling: tickets:reply → tickets__reply).
- Pair every assertion of "agent called the tool" with a DB assertion of the resulting effect (approval row, status change, etc.) — the LLM doesn't always hit every tool, but the side effect is the binding contract.

## General Rules

- No mocking the database in integration tests — test against real PostgreSQL to catch RLS/migration issues
- Test the permission engine exhaustively: scope resolution, dimension filtering, role inheritance
- App contract tests: validate every `defineApp()` export against the contract schema

## Log Output

All test runs write to `logs/` at the repo root. Each run creates a dated, slug-named folder:

```
logs/
  2026-04-04_14-30-25_unit/
    output.log                    # full stdout+stderr from the test runner
  2026-04-04_14-35-10_e2e-parallel/
    output.log                    # orchestrator output (summary + failures)
    worker-0-stdout.log           # server pino logs for worker 0
    worker-0-stderr.log
    worker-1-stdout.log
    ...
```

The `test-run.ts` script creates the run folder, sets `LOG_DIR` in the environment, and pipes all output to `output.log`. Worker env teardown (`worker-env.ts`) writes per-worker server logs into the same `LOG_DIR`.

## Multi-Worker Architecture

Parallel E2E tests (`test:e2e:parallel`) use a pool of **lanes**, one per parallel slot, each with one API server that its files share:

1. **Discovery** — `test-e2e-parallel.ts` globs `*.scenario.test.ts` in `apps/api/src/tests/e2e/`; files named on the command line narrow the run to those
2. **Lanes** — up to N slots (`TEST_E2E_WORKERS`, from the memory budget). Slot `i` creates lane `i` on its first file (`packages/test-helpers/src/e2e-lane.ts`):
   - clones the `w{i}_*` schemas, spawns `bun test-support/index.e2e.ts` once, registers the admin (`admin@e2e.test`, which creates the org and lets the server register its apps)
   - snapshots that post-boot state (`worker-snapshot.ts`: every non-empty table into `snap_w{i}`, sequences, the lane's non-BullMQ Redis keys)
3. **Files** — each file runs in its own `bun test --timeout <BUN_TEST_TIMEOUT_MS, default 60000>` process (bun ignores bunfig's `[test] timeout`) with `LIAISON_E2E_LANE` set. `setupScenario()` → `createWorkerEnv()` attaches instead of booting: the lane resets the database, the lane's Redis keys and its search documents to the snapshot and drops the server's in-process caches (`POST /api/_test/lane/reset`), about 1 s; `TestWorld.create` then signs the admin in instead of registering. A file sees exactly what a fresh worker showed it: one org, one admin, the default apps.
4. **Server restarts** (still no schema clone) — when the file's `serverEnv` differs from what the server runs with, when the previous file installed an app at runtime (the registration lives in the process), when the server died, and when a file calls `env.restart()` (it goes through the lane's stop/start, `between` included)
5. **Own server** — a file whose source contains the marker `e2e-own-server` (or calls `setupScenario({ ownServer: true })`) gets its own schemas and server the old way, under a private worker id above the lanes'; marker files run after the slot's lane closed. `LIAISON_E2E_SHARED_SERVER=0` runs every file that way.
6. **In-process files** — a file that imports `~/tests/route-test-setup` (agent-memory, durable-runtime, market-intel, ...) runs the API inside its own test process against the namespace database's unprefixed schemas, which all such files share. They run one after another on slot 0, with no lane, before that slot's lane files.
7. **Settled start** — `setupScenario()` returns once the outbox has processed every event the setup queued (bounded, 90 s; the setup line prints the wait), so a scenario's bounded waits never sit behind the setup's backlog.
8. **Ready gate** — event driven: the `E2E server listening` log line, then `{"ready":true}` (app registration complete), read off the server's output as it arrives
9. **Teardown** — a lane file only closes its clients; the lane kills its server, drops `w{i}_*` and `snap_w{i}`, flushes its Redis keys when the slot is done

The runner prints each file's wall clock, the `[setupScenario]` line (env / world / populate seconds) and the suite's wall clock, and writes each file's output to `<file>.log` in the run's log folder.

**Same org id across a lane.** Every file of a lane gets the same org and admin ids (restored from the snapshot). Database, Redis and search are reset; the object store is not, so objects an earlier file put under `orgs/<orgId>/` are still there. A scenario that walks that prefix takes the `e2e-own-server` marker (`file-orphan-gc`). So does `search-drift` (restart-time drift recovery, flaky as a lane's later file), and `search-unified`'s Meili-outage case asks for its own server (`setupScenario({ ownServer: true })`) because it deletes the live index. A file that never calls `setupScenario` runs with the in-process files (it seeds the shared unprefixed schemas itself). BullMQ queues are not reset either: jobs a file left behind run against the reset data.

| Resource | Isolation | Example |
|----------|-----------|---------|
| DB schemas | `SCHEMA_PREFIX=w{id}_` in `liaison_test_<ns>` | `w0_kernel`, `w2_app_test` |
| Redis keys | `REDIS_PREFIX=<ns>:w{id}:` | `a:w1:sessions`, `a:w3:bull:jobs` |
| Meili index | `MEILI_INDEX_PREFIX=<ns>-w{id}_` | `a-w0_liaison_search` |
| HTTP port | namespace block `+ (id mod 100) * 10` | 18000, 18010, 18020, 18030 |
| Logs | `lane-{id}-stdout.log`, `lane-{id}-stderr.log` (own-server files: `worker-{id}-*.log`) | server output |

## Playwright lanes

The Playwright suite shares its stacks the same way (`apps/web/src/tests/e2e/pw-lanes.ts`):

1. **Web build** — global setup builds the web app once (`vite build` into `apps/web/dist-e2e`, about 20 s). The lanes' API servers serve it (`LIAISON_PUBLIC_DIR`) exactly as production does: one origin for the page, the API and the websocket, and the production security headers on the shell. No Vite dev server runs, so no lane pays a cold compile. A lane hands its API port out as both `ports[0]` and `ports[1]` (the port scenarios navigate to).
2. **Registry** — global setup also starts a small registry in the runner process. A worker asks it for the lane of its `parallelIndex`; the first ask creates the lane, every later one (the next worker of that slot, after a failing test made Playwright replace the worker) gets the running lane.
3. **Lane** — `createE2eLane` with the Playwright server env (mock URLs on the lane's ports [2..5]), the QA admin (`admin@test.com`) and a `seed`: the standard seed tier, run as `liaison seed --tier standard --admin admin@test.com` beside the lane's server (`seedStandardWorld` in `packages/test-helpers/src/standard-world.ts`), then a sign-in per person. After the seed's outbox and search tasks drain, the lane snapshots the data, the Redis keys and the search documents. The runner owns all of it, so a worker dying costs nothing but the worker.
4. **Worker** — starts the in-process mocks (Drive, MCP, MCP OAuth, GitLab) on the lane's ports and builds `env` / `world` / `qa` over the lane (`qa` is the seed's result; tokens are refreshed before every test).
5. **Per-file reset** — before the first test of each spec file, and before the first `beforeAll` of a file that has one, the lane goes back to its snapshot (`resetLane`: database, Redis, search documents, server caches; a server restart when the previous file installed an app). A file always starts from the seeded QA world.
6. **Timing** — every fixture phase prints a `[pw-timing]` line (lane, reset, world, login) and every lane its `[pw-lane N]` boot line, so a slow run says where its time went.

`LIAISON_PW_SHARED_STACK=0` makes every worker boot its own stack the old way (API plus a Vite dev server, which sends no CSP). Fixtures built with `createProfiledE2ETest` (a server env decided per file) still boot their own.

**CSP.** Because the page comes from the API, the browser enforces the production Content-Security-Policy. The `_cspGuard` fixture (`fixtures/test.ts`) fails a test on any CSP violation the browser reports (console or page error), in any page of any context the test opens.

**Provider keys.** The Playwright stack runs with the fixed placeholder provider keys (`playwright.config.ts`), so a scripted agent turn passes the "is a key configured?" gate and nothing reaches a real provider. Journeys that drive a real model are gated on `PLAYWRIGHT_LIVE_LLM=1` (`helpers/live-llm.ts`), which also hands the stack the real keys.

### Visual baselines

Screenshot baselines are per platform: `<spec>-snapshots/<name>-<platform>.png` (`snapshotPathTemplate` in `playwright.config.ts`). Two sets are committed: `darwin` (a Mac) and `linux` (the gate workflow's runner image, ubuntu-24.04, pinned in `gate.yml`). Off CI, a screenshot assertion with no baseline for the current platform skips its test with the reason (`expect` in `fixtures/test.ts`), after every assertion before it has run. On CI (`CI` set) nothing is skipped and `updateSnapshots` is `none`: a missing baseline fails the test, so the gate never passes a screenshot it did not compare.

The `linux` set is made on the CI runners themselves, by the gate workflow with `update_snapshots` on. It runs only the Playwright lane, with `PW_UPDATE_SNAPSHOTS=missing`, and keeps every new image as the `linux-goldens-<shard>` artifact of the run:

```
gh workflow run gate.yml --ref <branch> -f ref=<branch> -f base=<root commit> -f update_snapshots=true
gh run download <run id> -p 'linux-goldens-*' -D <dir>   # then copy into apps/web/src/tests/e2e, review, commit
```

The darwin set is made on a Mac, from `apps/web/`, one visual spec at a time; review every image before committing it:

```
PW_UPDATE_SNAPSHOTS=missing bun run ../../scripts/with-test-lock.ts -- bunx --bun playwright test <spec>
```

`missing` writes only the images that do not exist yet and never touches the other platform's; `all` rewrites every baseline of the spec and belongs only to a deliberate UI change, which then needs both sets: the darwin images on a Mac and the linux ones from a gate run.

## LLM Guide

- **Never `tail` or `head` test output.** Always capture the full output so error messages, stack traces, and failure context are visible. Truncated output hides the information you need most.
- **Full test logs are in `logs/`.** Each run creates a folder like `logs/2026-04-04_14-30-25_unit/`. Read `output.log` for test runner output, and `worker-*` files for per-worker server logs.

## Mocking Google Drive in E2E tests

Scenarios that seed Drive content run against a per-worker mock Drive HTTP server (`apps/api/src/tests/e2e/helpers/mock-drive.ts`). The Google Drive app itself (`bundled-apps/google-drive`) is tested against a fake Drive behind `ctx.fetch` (`bun run scripts/test-run.ts bundled-google-drive`), and its contract fixtures are recorded against a fake Drive reached through the live bridge (`apps/api/scripts/contract/record-google-drive.ts`).

- The mock server's base URL reaches the API process as `DRIVE_API_BASE_URL`. The Playwright fixture (`apps/web/src/tests/e2e/fixtures/test.ts`) allocates a third deterministic port per worker, boots the mock server on it, and injects `DRIVE_API_BASE_URL` + `ENCRYPTION_KEY` into the API process via `serverEnv` before `createWorkerEnv` returns.
- Scenarios access the mock via `env.mockDrive` — `addFixture`, `resetFixtures`, `resetRequestLog`, `requestLog`. Each scenario seeds its own fixtures in `beforeEach`.
- Drive `connected_accounts` rows are seeded via `seedDriveConnection` in `apps/web/src/tests/e2e/helpers/knowledge-seed.ts`, which uses `env.encryptionKey` so encryptor↔decryptor parity with the API process is guaranteed.

Teardown order in the env fixture is API → Vite → mock-Drive to avoid `ECONNREFUSED` retry storms from `drive-rest.ts`'s retry logic.
