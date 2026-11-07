// SPDX-License-Identifier: FSL-1.1-ALv2
import { Encrypter } from "age-encryption"
import { z } from "zod"
import { DEFAULT_APP_ORIGINS } from "~/lib/app-origins"
import { envBoolean, parseEnvBoolean } from "~/lib/env-boolean"
import { SHUTDOWN_BUDGET_DEFAULTS } from "~/lib/shutdown-budget"
import {
  RESERVED_MODEL_DEFAULT,
  RESERVED_TOKEN_CEILING_DEFAULT,
} from "~/modules/demo/demo-spend-ceiling"

/**
 * Why a secret is not fit to protect a production deployment, or `null` if it
 * looks like real key material. The shipped `.env.example` carries a readable
 * JWT_SECRET placeholder and an all-zero ENCRYPTION_KEY; an operator who copies
 * it into production would sign tokens, and encrypt stored credentials, with
 * publicly known keys. The check is deliberately shallow (known placeholders,
 * one repeated character, a short unit repeated end to end): it exists to catch
 * "forgot to replace it", not to grade randomness.
 */
export function weakSecretReason(value: string): string | null {
  const lowered = value.toLowerCase()
  if (
    [
      "replace-with",
      "replace_me",
      "replaceme",
      "changeme",
      "change-me",
      "change_me",
      "your-secret",
      "placeholder",
      "example",
      "test-secret",
    ].some((marker) => lowered.includes(marker))
  ) {
    return "is a shipped placeholder"
  }
  if (new Set(value).size === 1) return "is a single repeated character"
  // Periodic end to end ("deadbeef" x 8, "0123456789abcdef" x 4): any period up
  // to half the length. Random key material is never periodic.
  for (let unit = 2; unit <= value.length / 2; unit++) {
    if (value.length % unit === 0 && value === value.slice(0, unit).repeat(value.length / unit)) {
      return "is a short pattern repeated end to end"
    }
  }
  return null
}

/** A plain `major.minor.patch` version (LIAISON_MIN_CLIENT_*). */
const SEMVER = /^\d+\.\d+\.\d+$/

/** LIAISON_TEAM_ENDPOINT's value when sharing with the Liaison team is not available. */
export const LIAISON_TEAM_DISABLED = ""
/** The Liaison team's control plane (LIAISON_TEAM_ENDPOINT's default outside tests). */
export const DEFAULT_LIAISON_TEAM_ENDPOINT =
  "https://hq.liaison.sh/webhooks/8a934d70-a7ef-4f92-b09d-99c455eb3be7/control"

/** OpenRouter model ids from a comma-separated list, deduplicated, in order; null when one is malformed. */
export function parseManagedDefaultModels(value: string): string[] | null {
  const ids = value
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "")
  if (ids.length === 0) return []
  if (!ids.every((id) => /^[a-z0-9][\w.-]*\/[\w.:-]+$/i.test(id))) return null
  return [...new Set(ids)]
}

/** True for `https://host[:port]` exactly: no path, query, fragment or trailing slash. */
export function isBareHttpsOrigin(v: string): boolean {
  try {
    const url = new URL(v)
    return url.protocol === "https:" && url.origin === v
  } catch {
    return false
  }
}

/** Compose passes a variable nobody set as the empty string: read it as unset. */
function unsetIfEmpty(v: unknown): unknown {
  return typeof v === "string" && v.trim() === "" ? undefined : v
}

/** The instance-provided OAuth clients, each a client id and its secret. */
export const INSTANCE_CLIENT_ENV_PAIRS = [
  ["GMAIL_OAUTH_CLIENT_ID", "GMAIL_OAUTH_CLIENT_SECRET"],
  ["GOOGLE_DRIVE_OAUTH_CLIENT_ID", "GOOGLE_DRIVE_OAUTH_CLIENT_SECRET"],
  ["GOOGLE_MARKETING_OAUTH_CLIENT_ID", "GOOGLE_MARKETING_OAUTH_CLIENT_SECRET"],
  ["SHOPIFY_APP_CLIENT_ID", "SHOPIFY_APP_CLIENT_SECRET"],
] as const

export const RELEASE_CHANNELS = ["release", "nightly"] as const
export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number]

export const envSchema = z
  .object({
    PORT: z.coerce.number().default(3000),
    DATABASE_URL: z.string().default("postgres://localhost:5432/liaison"),
    // The request login's password. Set, the pools that serve request
    // transactions (withRlsContext) connect as `liaison_request`, a login that
    // is a member of liaison_rls only: from a request transaction no role with
    // BYPASSRLS, no table owner and no policy owner can be reached. DATABASE_URL
    // stays the privileged login (withPrivilegedDb, withSystemDb,
    // withSchemaAdmin, the outbox worker); the request URL is DATABASE_URL with
    // the user and password swapped, so host and database always match. The
    // migration step sets this password on the role (db/migrate.ts). Unset
    // (empty reads as unset), every pool shares DATABASE_URL, the older shape.
    DATABASE_REQUEST_PASSWORD: z.preprocess(
      (v) => (typeof v === "string" && v === "" ? undefined : v),
      z.string().min(1).optional(),
    ),
    REDIS_URL: z.string().default("redis://localhost:6379"),
    JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
    ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-f]{64}$/i, "ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)"),
    // Pino level. Unset: "info" in production, "debug" otherwise (lib/logger.ts).
    // Debug in production writes a line per job and per database transaction:
    // hundreds of lines a second on a busy job host, for no operator's use.
    LOG_LEVEL: z.string().optional(),
    // Pino level of a `liaison` CLI run. Unset: "warn", so a command's output is
    // not preceded by the server's startup lines (lib/logger.ts).
    LIAISON_CLI_LOG_LEVEL: z.string().optional(),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    BASE_URL: z.string().url().default("http://localhost:3000"),
    // One host per org: an http(s) URL holding `{slug}` once, in its host, with no
    // path and no trailing slash (`https://{slug}.example.com`). Set, every absolute
    // link the server builds for an org (mails, connect links, guides, file links)
    // uses the org's host (lib/org-public-url.ts). Unset, those links use BASE_URL.
    LIAISON_ORG_HOST_TEMPLATE: z.preprocess(
      unsetIfEmpty,
      z
        .string()
        .refine((v) => {
          if (v.split("{slug}").length !== 2) return false
          try {
            const url = new URL(v.replace("{slug}", "slug"))
            return (
              /^https?:$/.test(url.protocol) &&
              url.hostname.includes("slug") &&
              `${url.protocol}//${url.host}` === v.replace("{slug}", "slug")
            )
          } catch {
            return false
          }
        }, "an http(s) origin with {slug} once in its host, no path or trailing slash")
        .optional(),
    ),
    // The managed edition's payment frame: the https origin (no path, no
    // trailing slash) of the page that takes card details for the Billing page,
    // embedded in an iframe. It feeds the frame-src of the CSP and the origin a
    // message from the frame must come from. Required when
    // LIAISON_EDITION=managed (the server refuses to start without it,
    // lib/managed-boot.ts); unused otherwise.
    LIAISON_PAY_FRAME_ORIGIN: z.preprocess(
      unsetIfEmpty,
      z
        .string()
        .refine(isBareHttpsOrigin, "an https origin with no path or trailing slash")
        .optional(),
    ),
    // The managed edition's default models: comma-separated OpenRouter model ids
    // (`deepseek/deepseek-v4.1-flash`) that a new org gets enabled when its
    // control plane creates it (POST /api/cloud/orgs), the first one as Auto, so
    // the org's first chat has a model. Admins add or remove models afterwards.
    // Required when LIAISON_EDITION=managed (lib/managed-boot.ts); unused
    // otherwise.
    LIAISON_MANAGED_DEFAULT_MODELS: z.preprocess(
      unsetIfEmpty,
      z
        .string()
        .refine((v) => parseManagedDefaultModels(v) !== null, "comma-separated vendor/model ids")
        .optional(),
    ),
    // One host every OAuth provider redirects to: an http(s) origin with no path or
    // trailing slash (`https://auth.example.com`). Set, the redirect_uri of sign-in
    // and connector flows is `<this>/api/auth/oauth/callback` and
    // `<this>/api/connections/callback` (one exact URI to register per provider),
    // and the OAuth `state` starts with the org's slug and a dot, so whatever
    // serves this host can send the browser on to the org's own host, where the
    // flow completes. Setup guides show these URIs. Unset, both use BASE_URL and
    // the state is a bare random token.
    LIAISON_OAUTH_REDIRECT_BASE: z.preprocess(
      unsetIfEmpty,
      z
        .string()
        .refine((v) => {
          try {
            const url = new URL(v)
            return /^https?:$/.test(url.protocol) && `${url.protocol}//${url.host}` === v
          } catch {
            return false
          }
        }, "an http(s) origin, no path or trailing slash")
        .optional(),
    ),
    ALLOWED_ORIGINS: z.string().default("http://localhost:5173"),
    // The wrapped desktop and mobile shells' own origins (lib/app-origins.ts).
    // Separate from ALLOWED_ORIGINS because these are the SHELLS' fixed
    // schemes, identical on every deployment, while ALLOWED_ORIGINS names this
    // deployment's web app. Set it empty to refuse the apps outright.
    LIAISON_APP_ORIGINS: z.string().default(DEFAULT_APP_ORIGINS),
    TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
    // The oldest desktop app version this server supports, published at
    // GET /api/client-policy; an older desktop shows an update notice. Keep it
    // covering at least the last three desktop releases and the last 90 days.
    LIAISON_MIN_CLIENT_DESKTOP: z.preprocess(
      unsetIfEmpty,
      z.string().regex(SEMVER, "must be major.minor.patch").default("0.1.33"),
    ),
    // The oldest iOS app version this server supports (`1.0.<build>`),
    // published at GET /api/client-policy.
    LIAISON_MIN_CLIENT_IOS: z.preprocess(
      unsetIfEmpty,
      z.string().regex(SEMVER, "must be major.minor.patch").default("1.0.34"),
    ),
    // The oldest Android app version this server supports, published at
    // GET /api/client-policy. 0.0.0 sets no minimum.
    LIAISON_MIN_CLIENT_ANDROID: z.preprocess(
      unsetIfEmpty,
      z.string().regex(SEMVER, "must be major.minor.patch").default("0.0.0"),
    ),
    // Extra networks (comma-separated CIDRs) whose direct connections may carry
    // X-Forwarded-For, beyond loopback and the private ranges that are always
    // trusted (lib/request-context.ts). Only needed when a proxy reaches the app
    // from a public address, e.g. a CDN connecting straight to the app port.
    TRUSTED_PROXY_CIDRS: z.string().default(""),
    // How the request's host and client address are read when an edge proxy
    // sits in front (lib/request-context.ts `effectiveRequest`). Unset: the Host
    // header and X-Forwarded-For per TRUSTED_PROXY_HOPS, as always. `direct`: the
    // edge preserves the Host, and the client address is CF-Connecting-IP when
    // the connection comes from a tunnel connector on loopback. `signed`: the
    // edge rewrites the host and passes the original host and client address in
    // signed `x-liaison-*` headers (LIAISON_EDGE_SECRET); unsigned or stale ones
    // are ignored.
    LIAISON_EDGE_MODE: z.preprocess(unsetIfEmpty, z.enum(["direct", "signed"]).optional()),
    // The secret the edge signs `x-liaison-host` / `x-liaison-client-ip` with
    // (LIAISON_EDGE_MODE=signed). At least 32 characters.
    LIAISON_EDGE_SECRET: z.preprocess(unsetIfEmpty, z.string().min(32).optional()),
    DEVICE_FLOW_CLIENTS: z
      .string()
      .default("")
      .transform((s) =>
        s
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      ),
    // Accept /api/auth/device-flow/initiate requests that declare no scopes. Off
    // by default: an unscoped device session is a full session as whoever
    // approves it. Turn on only for a first-party client that needs everything;
    // the approver must then confirm "full access" explicitly.
    DEVICE_FLOW_ALLOW_UNSCOPED: envBoolean(false),
    EXPOSE_REFRESH_TOKEN_IN_BODY: envBoolean(false),
    // Bind an app-connection / MCP-server OAuth flow to the browser that started it
    // (HttpOnly state cookie checked at the callback). The desktop and mobile apps
    // bind their app connections to themselves instead (connections/shell-connect.ts).
    OAUTH_CONNECT_BROWSER_BINDING: envBoolean(true),
    // Accept the static `?token=` Gmail push fallback (no OIDC). For a local mock only:
    // the process refuses to boot with this on when BASE_URL is not a loopback address.
    ALLOW_INSECURE_PUSH: envBoolean(false),
    // Minimum time a password-reset / magic-link REQUEST takes to answer, so a real
    // account and an unknown address cannot be told apart by response time.
    AUTH_ENUMERATION_FLOOR_MS: z.coerce.number().int().min(0).default(400),
    EXPOSE_ERROR_DETAIL: envBoolean(false),
    // Highest guardrail level a node run started by an EVENT (an inbound mail, a ticket, a customer
    // note in its prompt) may use, however high the agent's profile sets it. Such a run reads text
    // the outside world wrote and nobody is watching: it stays in the strict sandbox. Raise it only
    // when event-driven node routines legitimately need more (strict | standard | open).
    NODE_EVENT_RUN_MAX_LEVEL: z.enum(["strict", "standard", "open"]).default("strict"),
    // Pre-auth per-IP ceiling (requests/minute). One web-app page load is 26-40 API
    // calls and a whole office shares one egress address, so 300 put a handful of
    // colleagues navigating at once into a shared 429. 1200 is the per-IP floor; the
    // real containment of a single runaway client is RATE_LIMIT_PER_USER below.
    RATE_LIMIT_DEFAULT: z.coerce.number().int().default(1200),
    // Post-auth per-user ceiling (requests/minute), bucketed `user:<orgId>:<userId>`.
    // Applies to anything the auth middleware resolves to an acting user, including
    // an MCP connection token, so one runaway client cannot spend the IP budget the
    // rest of the office shares. Unauthenticated traffic is covered by the IP limiter.
    RATE_LIMIT_PER_USER: z.coerce.number().int().default(600),
    // Global per-request timeout (ms) for /api/* except the long-lived agent-chat stream.
    // 30s is the production ceiling; the chaos profile raises it (a CPU-contended box can make
    // an approved gated write — out-of-process sandbox + a live upstream API call — exceed 30s,
    // which would 504 a correct-but-slow write). Production behaviour is unchanged (default 30s).
    REQUEST_TIMEOUT_MS: z.coerce.number().int().default(30_000),
    // postgres.js connect_timeout (seconds). 10s is the production default; the chaos profile
    // raises it so a connect under heavy CPU contention waits rather than failing CONNECT_TIMEOUT.
    DB_CONNECT_TIMEOUT: z.coerce.number().int().default(10),
    // Max time (ms) to WAIT FOR A FREE POOL SLOT before a privileged DB transaction fails fast.
    // postgres.js (3.4.9) queues pool-slot acquisition with NO timeout (connect_timeout only bounds
    // NEW-socket establishment, not waiting for an in-use connection to free). A gated approved handler
    // runs inside an RLS transaction (connection A) and then nests a privileged token lookup
    // (connection B) -- so each in-flight gated Shopify handler holds 2 slots; concurrent handlers can
    // exhaust the pool and the nested acquisition then waits UNBOUNDED, hitting the 300s sandbox
    // ceiling ("App execution timed out"). Bounding the wait converts that hang into a fast, retryable
    // failure (chaos retries on a fresh world). 25s keeps it well under the 300s sandbox ceiling while
    // tolerating brief CPU-contended bursts. 0 disables the bound (legacy unbounded behaviour).
    DB_ACQUIRE_TIMEOUT_MS: z.coerce.number().int().min(0).default(25_000),
    // Per-statement ceiling (ms) applied INSIDE withRlsContext's transaction via
    // `SET LOCAL statement_timeout` -- the main-pool analogue of DB_ACQUIRE_TIMEOUT_MS.
    // U4.16 root cause: a sandboxed tool handler (e.g. tickets:search at 4,730-ticket
    // corpus scale) can issue a slow query that outlives executeInSandbox's own
    // wall-clock timeout. executeInSandbox gives up and rejects, but without a
    // server-side statement_timeout the ORIGINAL query keeps running on that
    // connection's socket -- postgres.js can only send ROLLBACK after the in-flight
    // statement finishes, so the connection is NOT returned to the pool until then
    // (in the worst case, a lock wait, never). Enough concurrent timeouts exhaust
    // DB_POOL_MAX and wedge every tool/job that needs a DB connection (observed live:
    // "privileged db pool-slot acquire timed out -- pool exhausted" cascading across
    // slaCheck/imap-incremental-sync/followupCheck/etc, cleared only by a full
    // `compose restart app`). Killing the statement server-side lets the transaction
    // actually roll back and the connection return to the pool -- the real "reclaim".
    // 10s matches the existing apps/database read-transport's DEFAULT_STATEMENT_TIMEOUT_MS
    // precedent; comfortably above the 5s production sandbox ceiling (so a normal
    // timeout still surfaces as "App execution timed out" first) but far below the
    // acquire-timeout, so a genuinely stuck query is killed well before it can exhaust
    // the pool. 0 disables (legacy unbounded behaviour).
    DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).default(10_000),
    // U4.16 finding 2 root cause (measured, not guessed): withRlsContext's RLS
    // policies (app_tickets.tickets/messages -- jsonb dimension checks +
    // string_to_array/unnest scope checks, evaluated per-row) compound with
    // tickets:search's free-text ILIKE/EXISTS predicates into a query plan
    // large enough that Postgres's JIT compiler engages -- and JIT COMPILE TIME
    // dominates wall-clock, not row processing. Measured directly against the
    // U4.16 realistic-scale fixture (5,000 tickets / 30,000 messages, RLS role
    // active): the identical plan took 1,478ms with JIT on vs 10ms with JIT off
    // -- a ~148x difference, entirely compile overhead (EXPLAIN's own JIT block
    // reported ~1,450ms of that as Generation/Inlining/Optimization/Emission).
    // This fires on EVERY query inside the RLS transaction, and tickets:search
    // issues up to 3 per call (the always-on COUNT(*), the precise AND page,
    // and the OR recall-widening fallback) -- so a multi-term query could pay
    // the ~1.5s JIT tax three times, well past the 5s production sandbox
    // ceiling once real load/concurrency is added. JIT is tuned for large
    // analytical scans; these are short, bounded (LIMIT ≤100), latency-
    // sensitive OLTP reads -- JIT is a pure loss here, not a tradeoff. Default
    // off; set to true to restore Postgres's default per-connection jit GUC
    // (whatever postgresql.conf configures) if a future workload benefits.
    DB_RLS_JIT_ENABLED: envBoolean(false),
    // Gates load-test-only routes AND disables WS upgrade rate limiting so
    // single-IP k6 runs can open thousands of short-lived sockets. Off in
    // production builds — turn on only via deploy/docker-compose.loadtest.yml.
    ENABLE_LOAD_TEST_ENDPOINT: envBoolean(false),
    // The production-safe load harness (lib/load-harness.ts): a box secret of at
    // least 32 characters. Unset (the default) means no harness at all: a
    // harness-signed request answers 404 and the org flag
    // `settings.loadHarness` does nothing. Set, a demo start signed with this
    // key makes a synthetic visitor workspace (a `@load.invalid` address) whose
    // mail, pushes and verification codes are counted in the effect sink
    // instead of sent, and whose agent turns run on the scripted load model.
    // For load and stress boxes only; never set on a real deployment. Refused
    // together with ENABLE_LOAD_TEST_ENDPOINT, and in production without
    // LIAISON_DEMO_MODE.
    LOAD_HARNESS_KEY: z.preprocess(unsetIfEmpty, z.string().min(32).optional()),
    // Mounts the QA/dev seed-harness routes (/api/_test/*: the seed engine factories,
    // app install-for-test, scope grants) outside NODE_ENV=test, so the qa/
    // browser harness running against `bun run dev` can provision a second org
    // and install bundled apps. These routes create orgs + install apps with
    // BYPASSRLS seeding logic — never expose them in production. `bun run dev`
    // turns this on automatically; the production guard below refuses to boot
    // with it set. Off by default everywhere else.
    ENABLE_QA_SEED_ROUTES: envBoolean(false),
    // A11: the push matrix's QA inject route (/api/qa/notifications). Demo
    // only: a non-demo production instance refuses to boot with it on.
    LIAISON_QA_ROUTES: envBoolean(false),
    // LIAISON_DEMO_MODE turns this box into the PUBLIC DEMO instance. It is a
    // product posture, not a test harness, and shares no code path with
    // ENABLE_QA_SEED_ROUTES / /api/_test/*: nothing it mounts bypasses RLS,
    // creates a user with arbitrary scopes or installs an arbitrary app.
    //
    // What it turns on, all of it narrow and all of it visible in app.ts:
    //   - POST /api/demo/orgs, the public self-serve visitor-org signup
    //     (IP rate limited ahead of the global limiter, brute-force guarded).
    //   - The outbound lockdown for orgs marked `settings.demo`: no customer
    //     mail through the sandbox SMTP bridge, no real connector credentials,
    //     system mail pinned to the console provider.
    //   - Zero platform spend: a demo org holds no credit and does NOT fall
    //     back to the deployment's own model key, so a visitor's agents run on
    //     the key they paste or not at all. The one reserved App Review org is
    //     the exception, and it carries a hard token ceiling.
    //
    // Deliberately NOT fatal in production (the demo instance IS a production
    // deployment) and deliberately independent of NODE_ENV. Off by default, and
    // when it is off none of the above exists: the routes are not mounted.
    LIAISON_DEMO_MODE: envBoolean(false),
    // One-time secret the FIRST registration of a fresh instance must present
    // (see modules/auth/setup-token.ts). Unset: a value derived from JWT_SECRET
    // is printed in the app log at boot until the instance is bootstrapped.
    // Setting it also turns the requirement on outside production.
    LIAISON_SETUP_TOKEN: z.string().optional(),
    // LIAISON_DEMO_SHOPIFY_FIXTURES answers a DEMO MARKED org's Shopify calls
    // from the demo fixtures on a box that is NOT the public demo instance.
    //
    // It exists for the private QA staging box, which runs the product exactly
    // as it ships (demo mode OFF, no public signup route, no egress lockdown,
    // no spend posture) and is filled with the demo world so a tester can walk
    // it. Without this, a demo marked org on such a box has a Shopify
    // connection carrying the inert sentinel token and a shop domain that
    // resolves to nothing, so every Shopify screen is empty and the box cannot
    // be validated at all.
    //
    // It is the NARROWEST thing that fixes that: it widens gate one of
    // `maybeDemoShopifyResponse` and nothing else. Gate two is untouched, so an
    // org with no demo marker is still never intercepted, on any box, whatever
    // this is set to. Turning it on can only ever make traffic MORE contained:
    // a demo marked org's `*.myshopify.com` call is answered from fixtures
    // instead of being put on the wire with a sentinel token.
    //
    // Off by default, and off on the public demo box too, where
    // LIAISON_DEMO_MODE already opens the same door.
    LIAISON_DEMO_SHOPIFY_FIXTURES: envBoolean(false),
    // LIAISON_DEMO_WAREHOUSE opts this deployment into the demo seed's
    // warehouse part: the read-only analytics schema behind the `database`
    // connector, built by the deploy-time seed and connected to every demo org.
    // It needs LIAISON_DEMO_WAREHOUSE_DATABASE_URL (the warehouse's own login)
    // and, where the warehouse is built, MIGRATION_DATABASE_URL.
    //
    // Off by default, and never inferred from those variables: a deployment
    // without the warehouse seeds every other part and says the warehouse is
    // off; a deployment with it on and the warehouse failing gets a failed
    // seed, not a quietly thinner one. Leave it off on load and test boxes.
    LIAISON_DEMO_WAREHOUSE: envBoolean(false),
    // The knobs below are read ONLY when LIAISON_DEMO_MODE is on. They are
    // plain env so the demo box can be retuned without a release.
    //
    // How long a self-serve visitor org lives before it is considered expired
    // (the marker's `expiresAt`). Reaping is a separate, later concern: this
    // value is what a reaper reads.
    LIAISON_DEMO_VISITOR_TTL_HOURS: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 30)
      .default(72),
    // How long a visitor org lives once it has completed a real outside
    // connection (an MCP server reaching connected, an app account connected by
    // OAuth or credentials): its `expiresAt` moves to max(current, now + this).
    // The demo's own seeded connections do not count (demo-connected-ttl.ts).
    LIAISON_DEMO_CONNECTED_TTL_HOURS: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 30)
      .default(168),
    // Self-serve demo signups allowed per socket peer per hour. Spent only by a
    // request that is about to create an org (a returning visitor adopting the
    // workspace they own spends the cheap per-peer budget instead), and checked
    // before anything is created, so a signup flood never reaches org creation.
    LIAISON_DEMO_SIGNUPS_PER_IP_PER_HOUR: z.coerce.number().int().min(1).max(100).default(3),
    // Self-serve demo signups allowed across ALL peers per hour. The per-peer
    // limit alone scales with the number of addresses an attacker has; this is
    // the box-wide ceiling on how fast visitor orgs (each a full seed) can be
    // created. Over it, signup answers 429 until the window rolls.
    LIAISON_DEMO_SIGNUPS_PER_HOUR: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.coerce.number().int().min(1).max(10000).default(60),
    ),
    // Cap on visitor workspaces alive at once (live plus expired-not-yet-
    // collected). At the cap, new signups answer 503 until the reaper frees room.
    LIAISON_DEMO_MAX_VISITOR_ORGS: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.coerce.number().int().min(1).max(100000).default(500),
    ),
    // The load harness's own lane (LOAD_HARNESS_KEY boxes only): signed
    // synthetic starts per hour, box-wide, counted apart from visitors' and
    // applied to their signups, code sends and verifications alike. A load run
    // spends this, never the visitor ceilings above, so it cannot lock real
    // visitors out.
    LIAISON_DEMO_SYNTHETIC_PER_HOUR: z.preprocess(
      unsetIfEmpty,
      z.coerce.number().int().min(1).max(100000).default(60),
    ),
    // Cap on the load harness's synthetic workspaces alive at once, counted
    // apart from LIAISON_DEMO_MAX_VISITOR_ORGS. At the cap, a signed start
    // answers 503; visitors' signups are unaffected.
    LIAISON_DEMO_SYNTHETIC_MAX_ORGS: z.preprocess(
      unsetIfEmpty,
      z.coerce.number().int().min(1).max(100000).default(500),
    ),
    // Warm pool of pre-seeded visitor workspaces (demo-pool.ts). A background
    // job keeps this many fully seeded orgs ready, seeding them one at a time,
    // and a signup takes the oldest instead of seeding behind its response. 0
    // turns the pool off: every signup creates and seeds its own org.
    LIAISON_DEMO_POOL_SIZE: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.coerce.number().int().min(0).max(100).default(5),
    ),
    // How many demo workspaces may be SEEDED at once on this box, across every
    // API process (a Redis-backed gate, demo-seed-gate.ts). Shared by the warm
    // pool's refill and by signups that found the pool empty; a visitor beyond
    // the limit waits in a first-come queue with their workspace showing as
    // still filling in, and the refill only takes a slot when no visitor waits.
    LIAISON_DEMO_SEED_CONCURRENCY: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.coerce.number().int().min(1).max(32).default(2),
    ),
    // The ONE demo org that spends real money: `variant: "reserved"`, the org
    // handed to Apple's Beta App Review, which cannot be asked to paste a key.
    // Every other demo org runs on its own BYOK key or not at all, so this is
    // the only ceiling on the box. Denominated per rolling day (the window is a
    // constant in demo-spend.ts): a lifetime total would lock App Review out
    // permanently the first time a reviewer spent it. Low on purpose: the
    // default is derived from Google's published price and the ECB rate so the
    // worst case stays at or under 1 EUR a day, with the sources and the
    // arithmetic in modules/demo/demo-spend-ceiling.ts. Raise it only past a
    // re-derivation there.
    // Empty reads as unset, which is how compose passes a variable nobody set.
    LIAISON_DEMO_RESERVED_TOKEN_CEILING: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.coerce.number().int().min(1).default(RESERVED_TOKEN_CEILING_DEFAULT),
    ),
    // The ONE model id every paid model call of the reserved org runs on,
    // whatever its agents, threads or routines ask for (applied in
    // `resolveModelForPreCheck`). Must be a row of the model catalog: an id the
    // catalog lacks refuses the turn rather than falling back to anything
    // dearer. The ceiling above is priced for a Flash-Lite model; naming a
    // dearer one here needs the ceiling re-derived too.
    // Empty reads as unset, which is how compose passes a variable nobody set.
    LIAISON_DEMO_RESERVED_MODEL: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().trim().min(1).default(RESERVED_MODEL_DEFAULT),
    ),
    // The reserved org's password, handed to Apple in App Store Connect. NEVER
    // a constant in the repo, and never generated either: `reservedOwner()`
    // REFUSES to seed the reserved App Review org while this is unset. It used
    // to generate one and print it at WARN, which could not work, because
    // `password` is a redact path on this process's logger, so the one line an
    // operator was told to read printed "[Redacted]" and the account Apple signs
    // in with held a secret nobody had.
    LIAISON_DEMO_REVIEWER_PASSWORD: z.string().default(""),
    // ── Tailored demo: visitor spend, verification and anti-abuse ──────────
    // Read ONLY when LIAISON_DEMO_MODE is on; plain env so the box can be
    // retuned without a release. Money is EUR (converted to integer micro-EUR
    // where it is spent); token and count caps are per visitor email unless
    // named otherwise. Empty reads as unset everywhere, which is how compose
    // passes a variable nobody set.
    //
    // The ONE model a verified visitor's agents run on when they use this
    // box's key (a model key: `openrouter/<OpenRouter id>`). Never read from
    // org settings. A visitor's own key runs its own models instead.
    LIAISON_DEMO_VISITOR_MODEL: z.preprocess(
      unsetIfEmpty,
      z.string().trim().min(1).default("openrouter/deepseek/deepseek-v4.1-flash-1017"),
    ),
    // Spend budgets: per verified email (lifetime), per client network (per
    // UTC day), box-wide per UTC day and per rolling hour.
    LIAISON_DEMO_BUDGET_PER_EMAIL_EUR: z.preprocess(
      unsetIfEmpty,
      z.coerce.number().positive().default(0.2),
    ),
    LIAISON_DEMO_BUDGET_PER_NETWORK_EUR: z.preprocess(
      unsetIfEmpty,
      z.coerce.number().positive().default(0.6),
    ),
    LIAISON_DEMO_BOX_DAILY_EUR: z.preprocess(
      unsetIfEmpty,
      z.coerce.number().positive().default(20),
    ),
    LIAISON_DEMO_BOX_HOURLY_EUR: z.preprocess(
      unsetIfEmpty,
      z.coerce.number().positive().default(2.5),
    ),
    // The owner alert: mailed once per UTC day when box spend crosses this
    // ratio of the daily budget (and when an hour reaches its cap). Without an
    // alert address, visitor spend on the box key stays off.
    LIAISON_DEMO_ALERT_RATIO: z.preprocess(
      unsetIfEmpty,
      z.coerce.number().gt(0).max(1).default(0.8),
    ),
    LIAISON_DEMO_ALERT_EMAIL: z.preprocess(unsetIfEmpty, z.string().trim().email().optional()),
    // Email verifications: box-wide per hour, per registrable domain per day,
    // per client network per hour and per day.
    LIAISON_DEMO_VERIFIED_PER_HOUR: z.preprocess(
      unsetIfEmpty,
      z.coerce.number().int().min(1).default(12),
    ),
    LIAISON_DEMO_DOMAIN_VERIFIED_PER_DAY: z.preprocess(
      unsetIfEmpty,
      z.coerce.number().int().min(1).default(3),
    ),
    LIAISON_DEMO_NETWORK_VERIFIED_PER_HOUR: z.preprocess(
      unsetIfEmpty,
      z.coerce.number().int().min(1).default(2),
    ),
    LIAISON_DEMO_NETWORK_VERIFIED_PER_DAY: z.preprocess(
      unsetIfEmpty,
      z.coerce.number().int().min(1).default(4),
    ),
    // Agent turns: concurrent box-wide and per email (subruns and routine runs
    // count as turns). No per-minute cap: the spend budget is the limit.
    LIAISON_DEMO_BOX_CONCURRENT_TURNS: z.preprocess(
      unsetIfEmpty,
      z.coerce.number().int().min(1).default(8),
    ),
    LIAISON_DEMO_EMAIL_CONCURRENT_TURNS: z.preprocess(
      unsetIfEmpty,
      z.coerce.number().int().min(1).default(2),
    ),
    // Per-step caps for a visitor turn on the pinned model; the last step of
    // a turn answers with tools off (turn-input-budget.ts). A chat turn
    // searches or loads an app, reads, writes and answers; a routine run reads
    // more before it acts (the sales routine: its trigger, the sender's site,
    // the CRM, a brief, the reply draft), so it has its own, larger limit.
    // Measured on the pinned model (live runs, 2026-10-24): six steps left the
    // sales routine without its reply draft.
    LIAISON_DEMO_STEPS_PER_TURN: z.preprocess(
      unsetIfEmpty,
      z.coerce.number().int().min(1).default(8),
    ),
    LIAISON_DEMO_ROUTINE_STEPS_PER_TURN: z.preprocess(
      unsetIfEmpty,
      z.coerce.number().int().min(1).default(12),
    ),
    // Output tokens of one visitor step, reasoning tokens included (the pinned
    // model runs at reasoning effort low). A step's output is held at this cap
    // before it runs (demo-spend-ceiling.ts, ONE STEP); its input is not capped.
    LIAISON_DEMO_STEP_OUTPUT_TOKENS: z.preprocess(
      unsetIfEmpty,
      z.coerce.number().int().min(1).default(16000),
    ),
    // web_search on the box key: per turn, and per email per UTC day.
    LIAISON_DEMO_WEB_SEARCH_PER_TURN: z.preprocess(
      unsetIfEmpty,
      z.coerce.number().int().min(0).default(2),
    ),
    LIAISON_DEMO_WEB_SEARCH_PER_EMAIL_PER_DAY: z.preprocess(
      unsetIfEmpty,
      z.coerce.number().int().min(0).default(15),
    ),
    // Verification codes: sends per client IP per hour, box-wide per hour and
    // per org (lifetime); a code's lifetime and its wrong-guess allowance.
    LIAISON_DEMO_CODE_SENDS_PER_IP_HOUR: z.preprocess(
      unsetIfEmpty,
      z.coerce.number().int().min(1).default(3),
    ),
    LIAISON_DEMO_CODE_SENDS_PER_HOUR: z.preprocess(
      unsetIfEmpty,
      z.coerce.number().int().min(1).default(60),
    ),
    LIAISON_DEMO_CODE_SENDS_PER_ORG: z.preprocess(
      unsetIfEmpty,
      z.coerce.number().int().min(1).default(3),
    ),
    LIAISON_DEMO_CODE_TTL_MINUTES: z.preprocess(
      unsetIfEmpty,
      z.coerce.number().int().min(1).max(60).default(10),
    ),
    LIAISON_DEMO_CODE_ATTEMPTS: z.preprocess(
      unsetIfEmpty,
      z.coerce.number().int().min(1).max(20).default(5),
    ),
    // The reverse proxy in front of this box OVERWRITES X-Forwarded-For with
    // the client address it saw (it never appends). Only then may the demo
    // limits read the client from that header, and only when the socket peer
    // is loopback or private. Off: the socket peer is the client.
    LIAISON_DEMO_EDGE_OVERWRITES_XFF: envBoolean(false),
    // The next-steps dialog's links: have it set up (a contact page, which gets
    // topic, from, email and scenarios as query parameters, or a mailto: link
    // used as is) and deploy it yourself. Each option is hidden when its link
    // is unset: a guessed default is a dead link the day that page moves.
    LIAISON_DEMO_BOOKING_URL: z.preprocess(unsetIfEmpty, z.string().trim().url().optional()),
    LIAISON_DEMO_SELF_HOST_URL: z.preprocess(unsetIfEmpty, z.string().trim().url().optional()),
    // Demo system mail (verification codes, owner alerts), its own channel.
    // CAPTURE keeps those mails in process for tests and local runs; it is
    // never valid in production.
    LIAISON_DEMO_MAIL_RESEND_API_KEY: z.preprocess(unsetIfEmpty, z.string().trim().optional()),
    LIAISON_DEMO_MAIL_CAPTURE: envBoolean(false),
    // Cloudflare Turnstile for the demo's public forms. Without the secret,
    // demo signup refuses (fails closed); the site key goes to the browser.
    TURNSTILE_SITE_KEY: z.preprocess(unsetIfEmpty, z.string().trim().optional()),
    TURNSTILE_SECRET_KEY: z.preprocess(unsetIfEmpty, z.string().trim().optional()),
    // ── end tailored demo ───────────────────────────────────────────────────
    // OpenRouter upstream hosts (comma-separated, as OpenRouter names them in a
    // response's `provider`, any case) that no OpenRouter chat request may be
    // routed to: they are removed from `provider.order`, added to
    // `provider.ignore`, and a conversation pinned to one moves to another host
    // (modules/agent/providers/openrouter-provider-pin.ts). The default host
    // answered the first user message of a multi-turn conversation instead of
    // the latest one. Empty: no host is excluded. This is the INSTANCE DEFAULT:
    // an org that sets its own list on the AI models page
    // (`settings.ai.models.blockedHosts`) uses that instead.
    LIAISON_OPENROUTER_IGNORE_HOSTS: z.string().default("OpenInference"),
    // Longest web_search query, in characters. Agent web reads run without an approval; the
    // LIAISON_WEB_* limits bound what one can carry out (agent/tools/web-read-guardrails.ts).
    LIAISON_WEB_SEARCH_MAX_QUERY_CHARS: z.preprocess(
      unsetIfEmpty,
      z.coerce.number().int().min(20).default(200),
    ),
    // Longest web_fetch URL, in characters.
    LIAISON_WEB_FETCH_MAX_URL_CHARS: z.preprocess(
      unsetIfEmpty,
      z.coerce.number().int().min(64).default(512),
    ),
    // Longest query string (after "?") of a web_fetch URL, in characters.
    LIAISON_WEB_FETCH_MAX_QUERY_CHARS: z.preprocess(
      unsetIfEmpty,
      z.coerce.number().int().min(0).default(150),
    ),
    // Web reads (searches and fetches together) in one agent turn.
    LIAISON_WEB_READS_PER_TURN: z.preprocess(
      unsetIfEmpty,
      z.coerce.number().int().min(1).default(20),
    ),
    // Web reads in a row in one turn, with no other tool call in between.
    LIAISON_WEB_READS_CONSECUTIVE: z.preprocess(
      unsetIfEmpty,
      z.coerce.number().int().min(1).default(12),
    ),
    // Distinct hosts one turn may web_fetch.
    LIAISON_WEB_FETCH_HOSTS_PER_TURN: z.preprocess(
      unsetIfEmpty,
      z.coerce.number().int().min(1).default(10),
    ),
    // Web reads per conversation in any rolling hour, across turns.
    LIAISON_WEB_READS_PER_THREAD_HOUR: z.preprocess(
      unsetIfEmpty,
      z.coerce.number().int().min(1).default(60),
    ),
    // The instance's privacy policy, linked from the one-line notice under the
    // demo signup button (and published on the public branding read). Optional:
    // unset or empty, the notice is shown without a link.
    LIAISON_PRIVACY_URL: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().trim().url().optional(),
    ),
    // The public demo the first-run conversation offers to a new workspace's
    // administrator ("see it working first"), shown once in its first card.
    // Unset or empty: the public demo. `off` turns the offer off (an
    // air-gapped install, or a deployment that runs its own demo nowhere).
    LIAISON_DEMO_URL: z.preprocess(
      unsetIfEmpty,
      z
        .union([
          z.literal("off"),
          z
            .string()
            .trim()
            .url()
            .refine((v) => /^https?:\/\//i.test(v), "an http(s) URL, or off"),
        ])
        .default("https://demo.liaison.sh"),
    ),
    // The first-run conversation: the first administrator to sign in to a new
    // workspace (not a demo, no message written yet) gets a "Set up your space"
    // card from their agent. Unset: on, except under NODE_ENV=test, where every
    // test org would get one; a test that needs it turns it on.
    LIAISON_SETUP_KICKOFF: z
      .union([z.string(), z.boolean()])
      .optional()
      .transform((value, ctx) => {
        if (value === undefined || typeof value === "boolean") return value
        if (value.trim() === "") return undefined
        const parsed = parseEnvBoolean(value)
        if (parsed === undefined) {
          ctx.addIssue({
            code: "custom",
            message: `expected a boolean (true/false, 1/0, yes/no), got "${value}"`,
          })
          return z.NEVER
        }
        return parsed
      }),
    // A workspace older than this many days never gets the first-run card,
    // whatever it holds: an org that runs on mail and tickets alone writes no
    // chat message, and a deploy must not greet it as new.
    LIAISON_SETUP_KICKOFF_ORG_MAX_AGE_DAYS: z.preprocess(
      unsetIfEmpty,
      z.coerce.number().int().min(0).default(14),
    ),
    // In-app bug reports (POST /api/bug-reports) file a ticket into this inbox
    // (UUID). Unset/empty → the org's default-for-create inbox. A bad id falls
    // back to the default inbox at request time (logged), never drops a report.
    BUG_REPORT_INBOX_ID: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
    // Without SMTP or Resend, mail goes to the log. Only its recipient and
    // subject, unless this is set: then the body too, which holds sign-in
    // codes, magic links, invite and reset links. For a local trial without a
    // mail server (deploy/quickstart.sh sets it); never for an instance other
    // people sign in to.
    LIAISON_CONSOLE_EMAIL_BODIES: envBoolean(false),
    // Operator-only, for an incident: 0 switches off the send check on staged mail,
    // except the opt-out check. Off nowhere by default, logged at error on boot.
    MAIL_SEND_GUARD_ENFORCE: envBoolean(true),
    // Email (SMTP) — optional. When SMTP_HOST is absent, emails are logged to console.
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().default(587),
    SMTP_USER: z.string().default(""),
    SMTP_PASS: z.string().default(""),
    SMTP_SECURE: envBoolean(false),
    EMAIL_FROM: z.string().default("Liaison <noreply@liaison.app>"),
    // Sender for SYSTEM mail only (sign-in links, invites, security codes,
    // digests): the team's own Liaison mail, which should not wear the name of
    // the customer-facing EMAIL_FROM (e.g. "Acme Support"). Empty → EMAIL_FROM.
    SYSTEM_EMAIL_FROM: z.string().default(""),
    // Pool sizes (db/connection.ts, planned by db/pool-plan.ts; operator page
    // docs/self-hosting/pools.md). Each one set wins over the plan; unset (or
    // empty, as compose passes `${VAR:-}`) = planned from DB_CELL_MAX_CONNECTIONS,
    // or the legacy default (20) without a budget.
    // The request pool (the main pool when the logins are not split).
    DB_POOL_MAX: z.preprocess(unsetIfEmpty, z.coerce.number().int().min(1).optional()),
    // Size of the DEDICATED privileged-operations connection pool (withPrivilegedDb /
    // withSystemDb / withSchemaAdmin). Privileged ops run on their OWN pool so a gated handler
    // holding its outer RLS connection can NEVER deadlock against the nested privileged read it
    // performs (org-owned connection token lookup) — the two never compete for the same pool.
    DB_PRIVILEGED_POOL_MAX: z.preprocess(unsetIfEmpty, z.coerce.number().int().min(1).optional()),
    // Size of the DEDICATED background-jobs connection pool (BullMQ job handlers,
    // webhook retries, event-subscription handlers). Background handlers may hold their
    // RLS transaction across the whole handler run — including sandboxed network I/O
    // lasting 30–300s — so on a shared pool they starve interactive traffic (MCP tool
    // calls, HTTP requests) into DbAcquireTimeoutError. Separate pool = background
    // saturation degrades background work only.
    DB_JOBS_POOL_MAX: z.preprocess(unsetIfEmpty, z.coerce.number().int().min(1).optional()),
    // Size of the privileged-jobs pool (privileged transactions of background work,
    // split logins only). Unset: planned, or DB_JOBS_POOL_MAX when only that is set.
    DB_PRIVILEGED_JOBS_POOL_MAX: z.preprocess(
      unsetIfEmpty,
      z.coerce.number().int().min(1).optional(),
    ),
    // THE CONNECTION BUDGET: connections Liaison may open on the database endpoint
    // it connects to (Postgres max_connections, or a pooler's client limit). Set,
    // every pool is planned from it per role, and a process whose topology cannot
    // fit refuses to boot. Unset = the legacy pool sizes, nothing refuses.
    DB_CELL_MAX_CONNECTIONS: z.preprocess(unsetIfEmpty, z.coerce.number().int().min(1).optional()),
    // Connections of the budget kept outside the plan: superuser slots, psql,
    // monitoring.
    DB_CELL_RESERVED: z.preprocess(unsetIfEmpty, z.coerce.number().int().min(0).default(15)),
    // What DATABASE_URL points at: `direct` (Postgres; the boot reads its
    // max_connections and applies the same rule) or `pooler` (PgBouncer and
    // the like; no server check, the boot logs each login's sum instead).
    DB_CELL_ENDPOINT: z.preprocess(unsetIfEmpty, z.enum(["direct", "pooler"]).default("direct")),
    // Two releases side by side above the budget refuse the boot too, instead of
    // the warning.
    DB_CELL_STRICT: envBoolean(false),
    // Replicas of the `api` and `worker` services in this deployment (a rolling
    // deploy runs two releases of them side by side): the pool plan budgets the
    // whole topology. Unset: 2 api, 1 worker.
    LIAISON_API_REPLICAS: z.preprocess(unsetIfEmpty, z.coerce.number().int().min(0).optional()),
    LIAISON_WORKER_REPLICAS: z.preprocess(unsetIfEmpty, z.coerce.number().int().min(0).optional()),
    // Test only (refused in production): every cron fan-out scheduler fires
    // every this many ms instead of on its manifest pattern
    // (infra/jobs/fanout-runtime.ts), so a test sees many epochs in seconds.
    LIAISON_TEST_FANOUT_EVERY_MS: z.coerce.number().int().min(100).optional(),
    // Test only (refused in production): the first fan-out tick that adds its
    // per-org jobs exits the process right after the add, before its markers,
    // as a crash there would (one shot, armed per app by a Redis key).
    LIAISON_TEST_FANOUT_EXIT_AFTER_ADD: envBoolean(false),
    // Test only (refused in production): "deduplication" makes fan-out jobs use
    // a BullMQ deduplication id in place of their job id, the variant that runs
    // an epoch twice after a crash; a test proves the difference with it.
    LIAISON_TEST_FANOUT_ID_MODE: z.enum(["job-id", "deduplication"]).optional(),
    // Per-workspace fairness on job queues (infra/jobs/fairness.ts): workspaces
    // take turns on each queue, and while another workspace has work waiting,
    // one cannot hold more than half the cell's slots of a queue. "off" is the
    // operator escape: jobs run in plain queue order, as before.
    JOB_ORG_FAIRNESS: z.enum(["on", "off"]).default("on"),
    // Kernel queue-class worker slots, per class: "agent=8,bulk=2". Unset
    // classes keep their defaults (infra/jobs/queue-classes.ts).
    JOB_QUEUE_CONCURRENCY: z.string().optional(),
    // Enqueue backpressure (infra/jobs/backpressure.ts). Redis `used_memory /
    // maxmemory` at which bulk enqueues are refused (SOFT) and every enqueue is
    // refused (HARD), and the per-queue backlog (waiting + prioritized +
    // delayed) at which a queue refuses new jobs. Redis runs `noeviction`, so
    // past 100 % it refuses every write, sessions included: failing the enqueue
    // loudly first keeps the rest of the platform writable.
    JOB_REDIS_MEMORY_SOFT_RATIO: z.coerce.number().min(0.1).max(1).default(0.75),
    JOB_REDIS_MEMORY_HARD_RATIO: z.coerce.number().min(0.1).max(1).default(0.9),
    JOB_QUEUE_MAX_DEPTH: z.coerce.number().int().min(100).default(200_000),
    // Durable outbox consumers run as a pipeline over each batch
    // (infra/events/durable-consumers.ts); this bounds the consumer calls in
    // flight at once, so a batch cannot flood the database pools.
    OUTBOX_CONSUMER_PARALLELISM: z.coerce.number().int().min(1).max(32).default(4),
    // Outbox poll interval override (ms). Read directly from process.env by
    // infra/events/outbox-worker.ts (resolveOutboxPollIntervalMs), which
    // defaults to 1000 in production and 25 under NODE_ENV=test; declared here
    // only so it is documented and validated.
    OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(10).max(60_000).optional(),
    // AI provider API keys — optional. Used as fallback when orgs don't configure BYOK.
    LIAISON_ANTHROPIC_API_KEY: z.string().optional(),
    // P4c-T28: Anthropic cache breakpoint lifetime — "1h" (default) or "5m".
    // The default aligns with cold-resume.ts's WARM_WINDOW_MS so a thread
    // resumed inside the warm window still hits the provider's cache; "5m"
    // opts back into the short, cheaper-to-write entry. Read directly from
    // process.env in context.ts (not this cached singleton) so it can be
    // flipped per test without a process restart — declared here only so it
    // is documented and validated by the schema.
    LIAISON_ANTHROPIC_CACHE_TTL: z.string().optional(),
    OPENAI_API_KEY: z.string().optional(),
    GOOGLE_API_KEY: z.string().optional(),
    MISTRAL_API_KEY: z.string().optional(),
    // Mobile push credentials (S17). All optional: an instance with no mobile
    // build configured must boot, and the push sender is a loud no-op rather
    // than a crash when a half is missing. APNs needs all four; FCM needs both.
    APNS_KEY_PATH: z.string().optional(),
    APNS_KEY_ID: z.string().optional(),
    APNS_TEAM_ID: z.string().optional(),
    APNS_BUNDLE_ID: z.string().optional(),
    FCM_SERVICE_ACCOUNT_PATH: z.string().optional(),
    FCM_PROJECT_ID: z.string().optional(),
    // Web Push (VAPID) for the browser computer channel (A6). All optional:
    // without them the browser rule is skipped, never a crash.
    VAPID_PUBLIC_KEY: z.string().optional(),
    VAPID_PRIVATE_KEY: z.string().optional(),
    VAPID_SUBJECT: z.string().optional(),
    // How a new personal mailbox is encrypted at rest when its owner has not
    // chosen. `managed`: encrypted with a per-mailbox key the server holds, so
    // the owner and the owner's agent read it with no mailbox password.
    // `private`: zero-access, sealed to a key only the owner's browser holds
    // (mailbox password + passkey). A default, not a lock: people may still
    // pick the other mode for themselves. Unset: decided once, on first use,
    // and stored: `private` when anyone on the deployment had set up a private
    // mailbox by then, else `managed`, so an upgraded zero-access deployment
    // keeps behaving exactly as before.
    MAILBOX_ENCRYPTION_DEFAULT: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.enum(["managed", "private"]).optional(),
    ),
    // `false` LOCKS personal mailboxes to private (zero-access): no mailbox is
    // ever made transparent, nobody can pick transparent, and the default
    // above is private whatever it says. Default `true`.
    MAILBOX_ENCRYPTION_ALLOW_MANAGED: envBoolean(true),
    // Org deletion (`liaison org delete`, modules/org/delete): before an org is
    // deleted, its legal records (the rows of issued invoices and credit notes
    // and their lines, their PDFs, legal originals, e-invoicing transmissions,
    // its audit log; never drafts or quotes) are written to one archive
    // encrypted to this age recipient (a public key, `age1...`) and stored at
    // `legal-archives/<org id>/`. The server can write such an archive but never
    // read it: the matching identity stays with the operator. Unset: a deletion
    // refuses unless `--no-legal-archive` waives the archive. Checked at boot.
    LEGAL_ARCHIVE_RECIPIENT: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z
        .string()
        .trim()
        .refine((v) => {
          try {
            new Encrypter().addRecipient(v)
            return true
          } catch {
            return false
          }
        }, "an age recipient (age1...)")
        .optional(),
    ),
    // How long a legal-retention archive is kept, in years (default 10); a daily
    // job deletes it after that.
    LEGAL_ARCHIVE_RETENTION_YEARS: z.coerce.number().int().min(1).max(100).default(10),
    // Deployment-scoped Gmail OAuth credentials for the Mail app.
    GMAIL_OAUTH_CLIENT_ID: z.string().optional(),
    GMAIL_OAUTH_CLIENT_SECRET: z.string().optional(),
    // Deployment-scoped Google OAuth credentials for passwordless "Sign in with
    // Google" LOGIN (distinct from GMAIL_OAUTH_* which is the Mail app's Gmail
    // integration). When both are set, a first-party Google login provider is
    // auto-seeded for every org at boot (invited-users-only). Empty → no button.
    GOOGLE_OAUTH_CLIENT_ID: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
    GOOGLE_OAUTH_CLIENT_SECRET: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.string().optional(),
    ),
    // Instance-provided OAuth clients: one client the instance brings for every
    // workspace, so nobody creates one. A workspace's own client always wins
    // (modules/apps/connections/oauth-client.ts). GMAIL_OAUTH_* above is the one
    // for Gmail (Mail, Tickets) and Google Calendar. Each pair is both or neither.
    // Google Drive.
    GOOGLE_DRIVE_OAUTH_CLIENT_ID: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.string().optional(),
    ),
    GOOGLE_DRIVE_OAUTH_CLIENT_SECRET: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.string().optional(),
    ),
    // The instance's Google clients (GMAIL_OAUTH_* and GOOGLE_DRIVE_OAUTH_*) passed
    // Google's verification for restricted scopes (Gmail, Drive). Set, a personal
    // Gmail account consents to them directly. Unset (default), Google refuses
    // them for personal Gmail accounts, and a Google Workspace admin marks them
    // Trusted for the domain first (the Trusted guide of kernel__google_setup).
    GOOGLE_OAUTH_RESTRICTED_SCOPES_VERIFIED: envBoolean(false),
    // The Google Workspace domains (comma-separated) the instance's Google clients
    // are Internal to: the consent screen's audience is Internal and the Cloud
    // project belongs to that Workspace. An address there connects with no Trusted
    // marking (an internal, domain-owned app needs none and no verification).
    GOOGLE_OAUTH_INTERNAL_DOMAINS: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.string().optional(),
    ),
    // The Google Picker, where a person chooses the Drive files Liaison can see when
    // their Drive is connected with `drive.file` only (a personal Google account on
    // an unverified instance client). An API key of the Drive client's Google Cloud
    // project with the Google Picker API on, and that project's number (the Picker's
    // app id). Unset, the picker is hidden and admins are told to set both.
    GOOGLE_PICKER_API_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
    GOOGLE_CLOUD_PROJECT_NUMBER: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z
        .string()
        .regex(/^\d{3,20}$/)
        .optional(),
    ),
    // Google Ads, Merchant Center and YouTube (the Ads and Social apps).
    GOOGLE_MARKETING_OAUTH_CLIENT_ID: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.string().optional(),
    ),
    GOOGLE_MARKETING_OAUTH_CLIENT_SECRET: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.string().optional(),
    ),
    // A Shopify app for every workspace's store: used for OAuth and, as Shopify
    // signs webhooks with the app's secret, for webhook HMAC verification. Its
    // redirect URL is ${BASE_URL}/api/connections/callback; webhook subscriptions
    // stay per workspace. Distribute it as a custom app (custom distribution).
    // An app listed on the Shopify App Store (public distribution) must answer
    // Shopify's mandatory compliance webhooks (customers/data_request,
    // customers/redact, shop/redact), which Liaison does not implement yet.
    SHOPIFY_APP_CLIENT_ID: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
    SHOPIFY_APP_CLIENT_SECRET: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.string().optional(),
    ),
    // A Cloud Pub/Sub topic Gmail push publishes to for every workspace
    // (projects/<project>/topics/<topic>). Set: Tickets watches Gmail with it and
    // the setup guide drops its Pub/Sub step. Unset: poll-only.
    GMAIL_PUBSUB_TOPIC: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
    // The OIDC audience of the instance topic's push subscription: the https URL
    // it posts to. The Mail and Tickets apps verify Gmail push tokens against it
    // when a workspace set none of its own. In the managed edition the subscription
    // posts to this server's /webhooks/_cell/gmail-push and the server refuses to
    // start with GMAIL_PUBSUB_TOPIC but without this and GMAIL_PUSH_SERVICE_ACCOUNT.
    GMAIL_PUSH_AUDIENCE: z.preprocess(unsetIfEmpty, z.string().url().optional()),
    // The service account the push subscription signs its OIDC tokens as
    // (--push-auth-service-account); checked with GMAIL_PUSH_AUDIENCE.
    GMAIL_PUSH_SERVICE_ACCOUNT: z.preprocess(unsetIfEmpty, z.string().email().optional()),
    // Managed edition: the app secret of the Meta app every workspace's Facebook
    // connection uses. It verifies deliveries to this server's /webhooks/_cell/meta
    // (X-Hub-Signature-256), which reach each workspace by Page id. Unset: no
    // server-level Meta callback.
    META_APP_SECRET: z.preprocess(unsetIfEmpty, z.string().optional()),
    // Managed edition: the app id of that same Meta app. With META_APP_SECRET it
    // is the OAuth client of every workspace's Facebook connection (and of
    // Instagram through Facebook login) when the workspace has no Meta app of
    // its own. Unset: each workspace brings its own.
    META_APP_ID: z.preprocess(unsetIfEmpty, z.string().optional()),
    // This server's own public IPv4/IPv6 addresses, comma-separated. An
    // organization's custom app (managed edition) can never fetch them: traffic
    // from the host to its own public address can reach any port published on
    // all interfaces. Unset: only its host names
    // (BASE_URL, ALLOWED_ORIGINS, the org host template) are refused that way.
    LIAISON_CELL_PUBLIC_ADDRESSES: z.preprocess(unsetIfEmpty, z.string().optional()),
    // A throwaway test server. Only then may an org transfer agent inject a
    // fault (`liaison org transfer agent --fail-at`): elsewhere the CLI and the
    // agent refuse it. Never set on a server that holds real organizations.
    LIAISON_TEST_CELL: envBoolean(false),
    // The instance edition (lib/edition.ts). `managed` turns on the managed
    // edition and makes the server refuse to boot without the settings it needs
    // (lib/managed-boot.ts). Unset = self-hosted (a server that sets the legacy
    // control-plane pair below without it refuses to start).
    LIAISON_EDITION: z.preprocess(unsetIfEmpty, z.enum(["self_hosted", "managed"]).optional()),
    // Control-plane integration. Both must be set or unset.
    // The pair no longer switches the managed edition on: set alone, without
    // LIAISON_EDITION, the server refuses to start (lib/managed-boot.ts).
    // No kernel-enforced minimum on the key; operators are advised to use
    // `openssl rand -hex 32` (documented in deploy/.env.example).
    // Empty strings (compose ${VAR:-} defaults) are treated as unset.
    CONTROL_PLANE_URL: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),
    CONTROL_PLANE_API_KEY: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.string().min(1).optional(),
    ),
    // Quiet hours by default (notification etiquette rule 8): until a person
    // sets their own work hours, phone and computer stay silent from 20:00 to
    // 08:00 on weekdays and all weekend. `off` keeps people without hours
    // notified at any time. Off under NODE_ENV=test, so tests do not depend on
    // the wall clock; tests of the rule set it on the router context.
    NOTIFICATIONS_DEFAULT_QUIET_HOURS: z
      .enum(["on", "off"])
      .default(process.env.NODE_ENV === "test" ? "off" : "on"),
    // Where this server sends what an admin chose to share with the Liaison team
    // (registration, a daily heartbeat, forwarded bug reports): the base URL of
    // the control plane's endpoints, one path segment per message type. Nothing
    // is sent until an admin turns sharing on (Settings > System). Empty string
    // = sharing is not available on this server. Unset = the Liaison team's own
    // endpoint (empty under NODE_ENV=test, so no test reaches it).
    LIAISON_TEAM_ENDPOINT: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? LIAISON_TEAM_DISABLED : v),
      z
        .union([z.literal(LIAISON_TEAM_DISABLED), z.string().url()])
        .default(
          process.env.NODE_ENV === "test" ? LIAISON_TEAM_DISABLED : DEFAULT_LIAISON_TEAM_ENDPOINT,
        ),
    ),
    // For the Liaison team's own demo server only; leave off. When on, the demo
    // box (LIAISON_DEMO_MODE, registered with the Liaison team) also sends each
    // new demo lead (not those who opted out) through the outbox, and later
    // changes to it (confirmed address, opt-out, scenarios played). Off by
    // default: registering never sends leads.
    LIAISON_TEAM_FORWARD_DEMO_LEADS: envBoolean(false),
    // Test only (honoured only under NODE_ENV=test): drain the Liaison team
    // outbox every this many ms instead of every minute, for process-level e2e.
    LIAISON_TEAM_OUTBOX_INTERVAL_MS: z.preprocess(
      unsetIfEmpty,
      z.coerce.number().int().positive().optional(),
    ),
    // Patroni leader gate (HA active/standby). URL of the LOCAL node's Patroni
    // REST /leader (e.g. http://host.docker.internal:8008/leader). When set, the
    // jobs (BullMQ workers) of this node run ONLY while this node is the Patroni
    // leader, so a warm standby that comes up during a failover doesn't
    // double-fire customer emails/webhooks. Singletons (outbox drain and other
    // once-per-cluster loops) run only in the process that holds the Redis
    // leader lease AND sits on the Patroni leader. UNSET (default) = gate off,
    // this node counts as the Patroni leader. See infra/leadership.ts. Empty
    // strings (compose ${VAR:-} defaults) = unset.
    SINGLETON_LEADER_URL: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.string().url().optional(),
    ),
    // What this process serves. `all` (default) = one container does everything:
    // HTTP + WebSocket API, BullMQ job workers and the singletons (outbox drain),
    // as a single-container self-host runs. `api` = HTTP + WebSocket only, no job
    // workers, never the singleton leader. `worker` = BullMQ job workers and the
    // singletons (behind the leader lease), with a health-only HTTP server.
    // Any other value refuses boot. The CLI ignores it.
    LIAISON_ROLE: z.enum(["all", "api", "worker"]).default("all"),
    // How long a serving process may spend, before /readyz answers 200,
    // registering the apps of the orgs with a live socket in the cell (the
    // orgs a deploy's reconnecting sockets bring it first). Past it the
    // process turns ready and the rest register on demand. 0 skips it.
    LIAISON_READY_WARM_MS: z.coerce.number().int().min(0).default(30_000),
    // Minutes after which an org nothing has touched in this process (no
    // request, job or event) has its in-memory setup released; its next touch
    // sets it up again (in memory only: its rows are set up already). Default
    // 60, so a process's memory follows the orgs used in the last hour, not
    // every org it ever served; 0 keeps every org set up for the process's life.
    LIAISON_ORG_RUNTIME_IDLE_MINUTES: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.coerce.number().int().min(0).default(60),
    ),
    // At most this many orgs set up in memory in one process. Past it, the
    // least recently touched org with no live work in the process (no request,
    // socket, job, event or agent turn, and not moving) is released as an idle
    // one is, and set up again at its next touch. Default 2000 (about 0.35 MB
    // per org, so about 700 MB at the cap); 0 sets no cap.
    LIAISON_ORG_RUNTIME_MAX_ORGS: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.coerce.number().int().min(0).default(2000),
    ),
    // The shutdown budgets (lib/shutdown.ts), in ms from the SIGTERM. Keep the
    // container's stop grace period above the hard deadline below, or the
    // runtime kills the process mid-drain.
    // How long the listener keeps accepting connections after /readyz turned
    // 503, so the edge sees it first (its 1 s probe marks the process down).
    // Default 2000.
    SHUTDOWN_EDGE_GRACE_MS: z.coerce
      .number()
      .int()
      .min(0)
      .default(SHUTDOWN_BUDGET_DEFAULTS.edgeGraceMs),
    // How long in-flight HTTP requests (not streams) may run before they are cut.
    // Default 20000.
    SHUTDOWN_HTTP_DRAIN_MS: z.coerce
      .number()
      .int()
      .min(0)
      .default(SHUTDOWN_BUDGET_DEFAULTS.httpDrainMs),
    // How long running agent turns may run on before the process stops.
    // Default 20000.
    SHUTDOWN_TURN_DRAIN_MS: z.coerce
      .number()
      .int()
      .min(0)
      .default(SHUTDOWN_BUDGET_DEFAULTS.turnDrainMs),
    // A turn still running at SHUTDOWN_TURN_DRAIN_MS stops at its next step
    // boundary and resumes on another process; this is how long it gets to
    // reach that boundary before its model call is cut (its running tools
    // still finish, 2 s more). A longer settle lengthens the derived hard
    // deadline. Default 2500.
    SHUTDOWN_TURN_SETTLE_MS: z.coerce
      .number()
      .int()
      .min(0)
      .default(SHUTDOWN_BUDGET_DEFAULTS.turnSettleMs),
    // How long running jobs may run on; the rest go back to their queue.
    // Default 20000.
    SHUTDOWN_JOB_DRAIN_MS: z.coerce
      .number()
      .int()
      .min(0)
      .default(SHUTDOWN_BUDGET_DEFAULTS.jobDrainMs),
    // When the process exits whatever is still running, in ms from the SIGTERM.
    // Unset = what the budgets above need (the longest drain with its extras +
    // 28 s of closing phases + 5 s slack): 58000 with the defaults. The process
    // logs it at boot ("Shutdown budgets"). The container's stop grace period
    // must be at least 5 s above it (65 s for the defaults; Docker's own
    // default is 10 s). Set, every drain is clamped to fit under it.
    SHUTDOWN_HARD_DEADLINE_MS: z.coerce.number().int().positive().optional(),
    // Redis leader lease that elects the one process running the singletons:
    // how long a held lease lives without renewal (a crashed holder is replaced
    // within about this long).
    LEADER_LEASE_TTL_MS: z.coerce.number().int().positive().default(15_000),
    // How often the leader-lease holder renews it. Keep it well under the TTL.
    LEADER_LEASE_RENEW_MS: z.coerce.number().int().positive().default(5_000),
    // How often a process without the leader lease tries to take it.
    LEADER_LEASE_POLL_MS: z.coerce.number().int().positive().default(1_000),
    // Instance liveness (infra/instance-registry.ts): every process writes a
    // heartbeat record that lives this long without renewal. Entries a process
    // owns in Redis (sockets, stream slots, live turns) are ignored once its
    // record is gone, so a killed process drops out within about this long.
    LIVE_INSTANCE_TTL_MS: z.coerce.number().int().positive().default(30_000),
    // How often each process renews its heartbeat record. Keep it well under the TTL.
    LIVE_INSTANCE_HEARTBEAT_MS: z.coerce.number().int().positive().default(10_000),
    // How often the leader removes the entries of processes whose heartbeat is gone.
    LIVE_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
    // The internal listener every process starts, separate from PORT and never
    // published: another process forwards a mailbox answer here when this one
    // minted the request. 0 (default) takes any free port. It must be reachable
    // from the other processes of the deployment (same host or compose network).
    LIAISON_INTERNAL_PORT: z.coerce.number().int().min(0).max(65535).default(0),
    // The name the other processes reach this one by on that port. Unset: the
    // hostname (inside compose, the container's, which the network resolves);
    // a hostname that does not resolve locally falls back to 127.0.0.1.
    LIAISON_INTERNAL_HOST: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
    // The address the internal listener binds. Unset: the address
    // LIAISON_INTERNAL_HOST (or the hostname) resolves to here, so the listener
    // is never on every interface by default. Set 0.0.0.0 only when the
    // advertised address is not on this machine (NAT), with the port firewalled.
    LIAISON_INTERNAL_BIND: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
    // How long a finished agent turn's live event stream stays readable in Redis
    // (seconds), so a view that reconnects late still sees how the turn ended.
    AGENT_TURN_STREAM_TTL_S: z.coerce.number().int().positive().default(600),
    // Concurrent agent chat streams one user may run across all API processes.
    // Unset: 2, or effectively unlimited under NODE_ENV=test or the load-test flag.
    AGENT_MAX_CONCURRENT_STREAMS: z.coerce.number().int().positive().optional(),
    // How much raw conversation history (tokens) an agent replays before it
    // summarizes the older part into a checkpoint: the instance default, which
    // an org's own setting (Settings > AI models) overrides. Clamped to what a
    // model's window can hold beside the prompt and the answer. Higher keeps
    // more word for word and resets the prompt cache less often; each call
    // carries more tokens (mostly cached).
    AGENT_HISTORY_BUDGET_TOKENS: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.coerce.number().int().min(32_000).default(256_000),
    ),
    // How long (seconds) a provider is assumed to keep a prompt cache warm
    // after the last request, for upstream hosts with no measured lifetime.
    // An idle thread's history is summarized just before this runs out, while
    // reading it is still cheap. Conservative on purpose: too short only
    // summarizes a little early.
    AGENT_PROMPT_CACHE_TTL_S: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.coerce.number().int().min(60).default(300),
    ),
    // Runtime app install (`.liaisonapp`). Production requires signed packages
    // by default; set to "false" for local dev. `LIAISON_TRUSTED_APP_PUBLISHERS`
    // is the cosign certificate-identity regex used to verify signatures.
    LIAISON_REQUIRE_APP_SIGNATURE: z.string().default("true"),
    LIAISON_TRUSTED_APP_PUBLISHERS: z.string().default(""),
    LIAISON_APPS_DIR: z.string().optional(),
    // Remote app registry: the https URL of an `index.json` of store listings and
    // package URLs (modules/apps/catalog-sources.ts), shown in the App store beside the
    // image's baked catalog. Unset = baked catalog only.
    LIAISON_APP_REGISTRY_URL: z.string().optional(),
    // Comma-separated extensions (no dots, e.g. "exe,pkg,dmg") to SUBTRACT from
    // the file-attachment executable/script denylist (`modules/files/attach.ts`
    // `BLOCKED_EXTENSIONS`/`BLOCKED_MIME_TYPES`), for files staff authored only
    // (a member's upload, an operator import). A file from outside (an inbound
    // attachment, an integration import, a copy of either, the in-app agent's
    // own upload) keeps the full denylist.
    LIAISON_ATTACHMENT_ALLOW_EXTENSIONS: z.string().optional(),
    // Installed apps are instance-wide, but `kernel:apps:admin` is org-scoped.
    // On a multi-tenant instance (demo mode, managed edition) runtime app
    // management (install, upgrade, uninstall, interface approval) is confined to
    // the instance operator's org: this id when set, otherwise the instance's
    // first org (modules/apps/operator-org.ts). Unused on a single-org self-host.
    // Org ids are compared as strings, so the id is kept in the database's own lowercase.
    LIAISON_OPERATOR_ORG_ID: z.preprocess(
      (v) => (v === "" ? undefined : typeof v === "string" ? v.toLowerCase() : v),
      z.string().uuid().optional(),
    ),
    // BYOK encryption key — 32 bytes expressed as 64 hex chars
    BYOK_ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-f]{64}$/i, "BYOK_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)")
      .optional(),
    // Bearer token guarding GET /diag (monitoring watchdog, ops/monitor/ in the monorepo).
    // Empty default allowed in non-production; the production guard below rejects empty.
    MONITOR_TOKEN: z.string().default(""),
    // Phase 10: MeiliSearch
    MEILISEARCH_HOST: z.string().default("http://localhost:7700"),
    MEILISEARCH_API_KEY: z.string().default(""),
    MEILI_INDEX_PREFIX: z.string().default(""),
    // Phase 10: Object storage (S3-compatible)
    OBJECT_STORAGE_ENDPOINT: z.string().default("http://localhost:9000"),
    OBJECT_STORAGE_REGION: z.string().default("us-east-1"),
    OBJECT_STORAGE_BUCKET: z.string().default("liaison-dev"),
    OBJECT_STORAGE_ACCESS_KEY: z.string().default("liaison"),
    OBJECT_STORAGE_SECRET_KEY: z.string().default("liaison-dev-secret"),
    OBJECT_STORAGE_FORCE_PATH_STYLE: envBoolean(true),
    // How the S3 client authenticates. "keys" (default): OBJECT_STORAGE_ACCESS_KEY
    // and OBJECT_STORAGE_SECRET_KEY, as for SeaweedFS or any S3-compatible store.
    // "aws-default": the AWS SDK's default credential chain (environment, then
    // the EC2 instance role through IMDS), for Amazon S3 from a host with a role,
    // so no long-lived key sits in .env. The two key variables are then ignored.
    OBJECT_STORAGE_AUTH: z.enum(["keys", "aws-default"]).default("keys"),
    OBJECT_STORAGE_PUBLIC_URL: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.string().optional(),
    ),
    // Whether browsers can reach the object store (Amazon S3, R2, a SeaweedFS with
    // a public https host). On: uploads PUT straight to a presigned URL and
    // downloads fetch a short-lived presigned GET, so the bytes never cross the
    // API; the bucket then needs a CORS rule for the app origins, and the
    // presigned host (the endpoint, or OBJECT_STORAGE_PUBLIC_URL when set) is
    // added to the CSP. Off (default): every byte goes through the API relay,
    // which is the only path for a store on a private network (self-hosted
    // SeaweedFS). Decided in one place: infra/storage/delivery.ts.
    OBJECT_STORAGE_BROWSER_DIRECT: envBoolean(false),
    // Phase 10: Resend (transactional email)
    RESEND_API_KEY: z.string().default(""),
    // System/auth email channel (sign-in codes, magic links, password resets,
    // 2FA, team invites, attention digest). When set, these sends go through
    // Resend to REAL inboxes even if the DEFAULT provider is a sink (e.g.
    // staging → Mailpit). Empty → auth/team mail follows the default provider.
    // See infra/email.ts getSystemEmailProvider(). Customer-facing app mail is
    // never on this channel, so it stays in the sink.
    SYSTEM_RESEND_API_KEY: z.string().default(""),
    // Phase 14: release version injected at build time. Used by /healthz and
    // System settings. "dev" when running locally without an image build.
    LIAISON_VERSION: z.string().default("dev"),
    // The update channel Settings > System compares the running version against
    // (modules/admin/version-check.ts). It picks nothing by itself: the image an
    // instance runs is LIAISON_IMAGE. docs/admin/upgrades.md explains both.
    LIAISON_RELEASE_CHANNEL: z.preprocess(
      unsetIfEmpty,
      z.enum(RELEASE_CHANNELS).default("release"),
    ),
    // Step-scoped parallel approval bundling. Off by default. When on, every
    // gated approval created within one agent step shares the same bundle_id;
    // the bundle is reactively discovered at execute time, not pre-declared.
    PARALLEL_APPROVAL_BUNDLING: envBoolean(false),
    // Override the GitHub API base URL for the admin version-check route.
    // Defaults to the canonical https://api.github.com. Useful in environments
    // where GitHub is not reachable directly (air-gapped, corporate proxy, tests).
    GITHUB_API_BASE: z
      .string()
      .url()
      .default("https://api.github.com")
      .transform((v) => v.replace(/\/+$/, "")),
  })
  .superRefine((env, ctx) => {
    if (env.LIAISON_EDGE_MODE === "signed" && !env.LIAISON_EDGE_SECRET) {
      ctx.addIssue({
        code: "custom",
        path: ["LIAISON_EDGE_SECRET"],
        message: "LIAISON_EDGE_SECRET is required with LIAISON_EDGE_MODE=signed",
      })
    }
    if (env.NODE_ENV === "production") {
      for (const name of ["JWT_SECRET", "ENCRYPTION_KEY", "BYOK_ENCRYPTION_KEY"] as const) {
        const value = env[name]
        if (!value) continue // BYOK_ENCRYPTION_KEY presence is enforced at boot below
        const reason = weakSecretReason(value)
        if (reason) {
          ctx.addIssue({
            code: "custom",
            path: [name],
            message: `${name} ${reason}; generate a real one (openssl rand -hex 32) before running in production`,
          })
        }
      }
    }
    // An instance-provided OAuth client is a pair: one half alone would read as "no
    // client" and silently send every workspace to create its own.
    for (const [id, secret] of INSTANCE_CLIENT_ENV_PAIRS) {
      if (Boolean(env[id]) !== Boolean(env[secret])) {
        ctx.addIssue({
          code: "custom",
          path: [env[id] ? secret : id],
          message: `${id} and ${secret} must be set together (an instance-provided OAuth client), or both left unset`,
        })
      }
    }
    if (env.NODE_ENV === "production" && env.MEILISEARCH_HOST && !env.MEILISEARCH_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["MEILISEARCH_API_KEY"],
        message: "MEILISEARCH_API_KEY required in production",
      })
    }
  })

function loadEnv() {
  const result = envSchema.safeParse(process.env)

  if (!result.success) {
    console.error("Invalid environment configuration:", result.error.message)
    // Under the CLI a missing or invalid environment is a configuration error
    // (exit 2), told apart from a runtime failure (exit 1).
    process.exit(process.env.LIAISON_CLI === "1" ? 2 : 1)
  }

  return result.data
}

export const env = loadEnv()

// Guard against misconfiguration: debug flags must not be enabled in production
if (env.NODE_ENV === "production" && env.EXPOSE_REFRESH_TOKEN_IN_BODY) {
  console.error("FATAL: EXPOSE_REFRESH_TOKEN_IN_BODY must not be enabled in production")
  process.exit(1)
}
if (env.NODE_ENV === "production" && env.EXPOSE_ERROR_DETAIL) {
  console.error("FATAL: EXPOSE_ERROR_DETAIL must not be enabled in production")
  process.exit(1)
}
// The cron fan-out's test seams change when and how scheduled work runs.
for (const name of [
  "LIAISON_TEST_FANOUT_EVERY_MS",
  "LIAISON_TEST_FANOUT_EXIT_AFTER_ADD",
  "LIAISON_TEST_FANOUT_ID_MODE",
] as const) {
  const value = env[name]
  if (env.NODE_ENV === "production" && value !== undefined && value !== false) {
    console.error(`FATAL: ${name} is a test seam and must not be set in production`)
    process.exit(1)
  }
}
// ENABLE_LOAD_TEST_ENDPOINT exposes unauthenticated load-test routes AND disables
// WebSocket-upgrade rate limiting. Left on in production it silently removes a
// DoS protection, so refuse to boot rather than serve traffic in that posture.
if (env.NODE_ENV === "production" && env.ENABLE_LOAD_TEST_ENDPOINT) {
  console.error(
    "FATAL: ENABLE_LOAD_TEST_ENDPOINT must not be enabled in production (it disables rate limiting and exposes load-test-only routes)",
  )
  process.exit(1)
}
// One load posture per box: the harness key keeps every limit and refuses to
// let an effect leave a flagged org; ENABLE_LOAD_TEST_ENDPOINT removes limits.
// Both at once would mean a harness box with its DoS protection off.
if (env.LOAD_HARNESS_KEY && env.ENABLE_LOAD_TEST_ENDPOINT) {
  console.error(
    "FATAL: LOAD_HARNESS_KEY and ENABLE_LOAD_TEST_ENDPOINT are mutually exclusive (one load posture per box)",
  )
  process.exit(1)
}
// A load org's effects are kept on the box by two layers: the sink (kernel
// mail, push, Web Push, demo codes) and the demo egress lockdown (everything an
// app sends). The harness only ever runs inside the demo door, so a production
// box with the key and without demo mode is refused rather than trusted.
if (env.NODE_ENV === "production" && env.LOAD_HARNESS_KEY && !env.LIAISON_DEMO_MODE) {
  console.error("FATAL: LOAD_HARNESS_KEY is for a demo box only (LIAISON_DEMO_MODE)")
  process.exit(1)
}
if (env.NODE_ENV === "production" && !env.BYOK_ENCRYPTION_KEY) {
  console.error("FATAL: BYOK_ENCRYPTION_KEY is required in production")
  process.exit(1)
}
// A static URL token is not a credential worth trusting on a reachable instance:
// the flag exists for a local mock of Gmail push and must not be left on anywhere
// the instance is publicly addressed.
if (env.ALLOW_INSECURE_PUSH) {
  const host = new URL(env.BASE_URL).hostname
  const loopback =
    host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]"
  if (!loopback) {
    console.error(
      "FATAL: ALLOW_INSECURE_PUSH must not be enabled when BASE_URL is not a loopback address",
    )
    process.exit(1)
  }
}
// Guards GET /diag (the monitoring watchdog's bearer-token auth). Same guard strength as
// the sibling hub service's assertMonitorTokenConfigured, Liaison's inline idiom.
if (env.NODE_ENV === "production" && !env.MONITOR_TOKEN) {
  console.error("FATAL: MONITOR_TOKEN required in production")
  process.exit(1)
}
// ENABLE_QA_SEED_ROUTES mounts org-creation + app-install seed routes that run
// with BYPASSRLS. In production that is a tenant-provisioning/RCE-shaped hole,
// so refuse to boot rather than serve traffic with it on.
if (env.NODE_ENV === "production" && env.ENABLE_QA_SEED_ROUTES) {
  console.error(
    "FATAL: ENABLE_QA_SEED_ROUTES must not be enabled in production (it exposes org-creation + app-install seed routes that bypass RLS)",
  )
  process.exit(1)
}
// LIAISON_QA_ROUTES mounts a route that raises notifications for any member of
// the caller's org: a QA harness for the demo, never a production feature.
if (env.NODE_ENV === "production" && env.LIAISON_QA_ROUTES && !env.LIAISON_DEMO_MODE) {
  console.error("FATAL: LIAISON_QA_ROUTES is for the demo instance only (LIAISON_DEMO_MODE)")
  process.exit(1)
}
// BASE_URL drives ALL MCP OAuth discovery + the WWW-Authenticate challenge.
// Left at the localhost default in production, every Claude client is pointed
// at the wrong origin and the entire OAuth/device flow silently breaks.
if (env.NODE_ENV === "production" && env.BASE_URL === "http://localhost:3000") {
  console.error(
    "FATAL: BASE_URL must be set to the instance's public URL in production (MCP OAuth discovery + WWW-Authenticate depend on it)",
  )
  process.exit(1)
}

/** Dedicated encryption key — must be distinct from JWT_SECRET. */
export const encryptionKey = env.ENCRYPTION_KEY

/**
 * Whether the QA/dev seed-harness routes (`/api/_test/*`) should be mounted and
 * served. True under `NODE_ENV=test` (Playwright workers) or when
 * `ENABLE_QA_SEED_ROUTES` is set (the qa/ browser harness against `bun run dev`).
 * Used both at mount time (app.ts) and inside each seed route's guard.
 *
 * SECURITY NOTE — the production refuse-to-boot guard above only fires for
 * `NODE_ENV === "production" && ENABLE_QA_SEED_ROUTES`. It does NOT cover the
 * `NODE_ENV === "test"` arm: a prod container mistakenly started with
 * `NODE_ENV=test` would mount these BYPASSRLS routes ungated. We deliberately do
 * NOT throw on the test arm — `NODE_ENV=test` is the legitimate, load-bearing
 * signal for the whole unit/integration/Playwright suite, and there is no clean
 * code-level signal that distinguishes "real deployment misconfigured to test"
 * from "a genuine test run". Throwing here would make the test suite refuse to
 * boot. Instead we emit a loud startup WARN whenever the seed routes are live, so
 * the posture is observable in any process's logs (a prod operator who sees this
 * line in a deployed container knows the routes are exposed). The canonical hard
 * guard remains the operator running prod with `NODE_ENV=production`, which the
 * env validator enforces for the env-flag arm.
 */
export const qaSeedRoutesEnabled = env.NODE_ENV === "test" || env.ENABLE_QA_SEED_ROUTES
if (qaSeedRoutesEnabled) {
  // Loud, structured, single startup line — observable in container logs. console
  // is used (not the logger) because lib/logger imports this module; importing it
  // here would create a cycle. Suppressed under NODE_ENV=test to keep the test
  // suite's output clean (the test arm is the expected, benign case).
  if (env.NODE_ENV !== "test") {
    console.warn(
      "WARN: QA seed-harness routes (/api/_test/*) are ENABLED — these create orgs + install apps with BYPASSRLS. " +
        "This must NEVER be the case in a production deployment. Cause: " +
        (env.ENABLE_QA_SEED_ROUTES
          ? "ENABLE_QA_SEED_ROUTES is set."
          : `NODE_ENV is "${env.NODE_ENV}".`),
    )
  }
}

/**
 * Whether this process is the public demo instance. Read through
 * `isDemoModeEnabled()` (modules/demo/demo-mode.ts) everywhere except the mount
 * decision in app.ts, which reads `env.LIAISON_DEMO_MODE` directly because a
 * route that is not mounted cannot be reached by any later override.
 */
if (env.LIAISON_DEMO_MODE) {
  // Loud single startup line, same idiom as the seed-route warning above:
  // `console` rather than the logger, which imports this module. NOT suppressed
  // under NODE_ENV=test — demo mode is never the expected posture for a test
  // run, so seeing this line in a suite's output is itself the signal.
  console.warn(
    "WARN: LIAISON_DEMO_MODE is ENABLED. This box is a PUBLIC DEMO instance: " +
      "POST /api/demo/orgs creates a throwaway org for any caller, orgs marked as demo " +
      "cannot send customer mail or store real connector credentials, system mail is refused, " +
      "and a demo org runs agents on its own pasted key only: the deployment's model key is " +
      "not reachable from one. Never set this on a deployment holding real tenants.",
  )
  if (env.LIAISON_DEMO_REVIEWER_PASSWORD.trim() === "") {
    console.warn(
      "WARN: LIAISON_DEMO_REVIEWER_PASSWORD is unset. The reserved App Review org will REFUSE " +
        "to seed, and the nightly demo reset will skip it rather than clear it. Set it to the " +
        "password you will type into App Store Connect, then seed again.",
    )
  }
}

/**
 * Test-env detection used by `setXForTest` seams. `Bun.env.NODE_ENV` does NOT
 * reflect `.env.test` because Bun's runtime doesn't auto-override `.env`'s
 * `NODE_ENV`. The reliable signals are: explicit `NODE_ENV=test` /
 * `BUN_ENV=test`, or the test runner argv (`bun test foo.test.ts`). Lifted
 * into a single helper so each seam doesn't redefine it.
 */
export function isTestEnv(): boolean {
  return (
    process.env.NODE_ENV === "test" ||
    process.env.BUN_ENV === "test" ||
    Bun.argv.some((a) => a.endsWith(".test.ts") || a.endsWith(".test.tsx") || a === "test")
  )
}

/**
 * Test-only: a spawned e2e server whose provider keys are placeholders (set so
 * a stubbed agent passes its availability pre-check) must make no outbound
 * model call of its own. With `LIAISON_OFFLINE_SIDE_CALLS=1`, the platform's
 * side calls stand down: chat titles use the heuristic, message search runs
 * keyword-only. Never honoured outside a test environment.
 */
export function offlineSideCalls(): boolean {
  return isTestEnv() && process.env.LIAISON_OFFLINE_SIDE_CALLS === "1"
}

/**
 * BYOK encryption key. Production MUST have a dedicated key (enforced above);
 * dev + test fall back to ENCRYPTION_KEY when no BYOK_ENCRYPTION_KEY is set so
 * tests don't need NODE_ENV=test propagated through every spawn path.
 */
export const byokEncryptionKey =
  env.BYOK_ENCRYPTION_KEY ?? (env.NODE_ENV !== "production" ? env.ENCRYPTION_KEY : "")

/**
 * Validate the control-plane env matrix at startup.
 *
 * Modes:
 *   - both unset → self_hosted
 *   - both set   → "managed" (kept for the env matrix check only: the edition
 *                  comes from LIAISON_EDITION alone, lib/edition.ts)
 *   - exactly one set → half-configured: fatal in production, warning in dev/test
 *
 * Strings are normalised: whitespace-only is treated as unset.
 */
export function validateControlPlaneEnv(
  e: { NODE_ENV: string; CONTROL_PLANE_URL?: string; CONTROL_PLANE_API_KEY?: string },
  io: { warn?: (m: string) => void } = { warn: console.warn },
): { mode: "self_hosted" | "managed" } {
  const url = !!e.CONTROL_PLANE_URL?.trim()
  const key = !!e.CONTROL_PLANE_API_KEY?.trim()
  if (url && key) return { mode: "managed" }
  if (!url && !key) return { mode: "self_hosted" }
  const missing = url ? "CONTROL_PLANE_API_KEY" : "CONTROL_PLANE_URL"
  const msg = `Half-configured control plane: ${missing} is required when its counterpart is set.`
  if (e.NODE_ENV === "production") throw new Error(msg)
  io.warn?.(msg)
  return { mode: "self_hosted" }
}
