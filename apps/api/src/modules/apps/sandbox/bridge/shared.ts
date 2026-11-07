// SPDX-License-Identifier: FSL-1.1-ALv2

import type { ActorContext } from "~/db/rls"
import { env } from "~/lib/env"
import { UnsafeOutboundUrlError, validateOutboundUrlNoDns } from "~/lib/outbound-fetch"
import { sandboxTenantKey } from "~/modules/apps/custom-app-name"

/** The id a create_routine running-doc binding directive names in the authored prompt ("MAINTAIN THIS
 *  EXISTING RUNNING DOC … id <UUID>"). Extracted to redirect a routine-tick knowledge_create onto the
 *  bound doc regardless of the (invented) title. The UUID is the FIRST such id in the prompt. */
export const ROUTINE_BOUND_DOC_ID_RE =
  /MAINTAIN THIS EXISTING RUNNING DOC[\s\S]*?\bid\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i

/** Extract the bound running-doc id a create_routine binding directive named in a routine prompt (the
 *  FIRST one), or null. Pure — exported for the regression test that pins the parse the redirect keys on. */
export function extractRoutineBoundDocId(prompt: string | null | undefined): string | null {
  if (!prompt) return null
  return prompt.match(ROUTINE_BOUND_DOC_ID_RE)?.[1] ?? null
}
export const SANDBOX_FETCH_MAX_REDIRECTS = 5

export const ERROR_NOT_FOUND = { code: "not_found", retryable: false }

/**
 * Kernel-managed base columns present on every app entity table (see
 * generateTableDdl `systemCols`: id, org_id, created_at, updated_at). Apps may
 * filter/order by these without redeclaring them in the manifest `fields` block.
 * `orgId` is intentionally excluded — it is kernel-scoped (where.orgId is
 * rejected outright; ordering within a single org is meaningless).
 */
export const BASE_ENTITY_FIELDS = new Set(["id", "createdAt", "updatedAt"])

export function envelopeError(code: string, message: string, retryable = false): string {
  return JSON.stringify({ error: { code, message, retryable } })
}

export function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "string") return value
  return null
}

// jsonb columns can surface EITHER pre-parsed (the default postgres.js path, e.g. host tests) OR as a
// raw JSON STRING (observed for app_mail.messages.from_address/to_addresses in the chaos world DB
// connection). A mapper that only handles the parsed form silently drops the value in the string case
// — which made mail:convertToTicket copy an inbound message with an EMPTY from_email, so the later
// gated tickets:reply preflight failed "ticket has no customer recipient" (sofia-promote, l445). Coerce
// both shapes before reading.
export function coerceJson(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

type SmtpSendStub = (
  connectionName: string,
  identifier: string,
  message: unknown,
) => Promise<{ messageId: string; deliveryState: string }>

/**
 * Transport overrides for the sandbox egress primitives. All null in production.
 *
 * - `fetch`: a fetch-impl the e2e and chaos entrypoints install so external APIs
 *   (Boxtal, Shopify, VIES, Pennylane) answer deterministically.
 * - `smtpSend`: stubs the SMTP send. Real `smtp_send` resolves the connected
 *   account's stored credentials then connects via nodemailer to a real SMTP
 *   host, neither of which works in a chaos world with no real mailbox. When set,
 *   the `smtp_send` bridge primitive routes here instead, so an approved
 *   mail:reply/compose executes deterministically (the agent behaviour, the gated
 *   approval and the send ATTEMPT are all real; only the SMTP TCP is mocked).
 * - `fetchInterceptsHost`: a predicate naming the hosts the installed fetch-impl
 *   actually serves. When set, the sandbox `fetch` primitive calls the override
 *   DIRECTLY for those hosts (bypassing the DNS-pin path that fails on
 *   unreachable third-party sandbox domains) and leaves every other host on the
 *   unchanged production pinned-host path. Unset means "intercept nothing".
 */
export const sandboxEgressOverrides: {
  fetch: typeof fetch | null
  smtpSend: SmtpSendStub | null
  fetchInterceptsHost: ((hostname: string) => boolean) | null
} = { fetch: null, smtpSend: null, fetchInterceptsHost: null }

/**
 * Test access to the sandbox egress overrides, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const SandboxBridgeTestAccess = {
  setFetch(fn: typeof fetch | null): void {
    sandboxEgressOverrides.fetch = fn
  },
  setSmtpSend(fn: SmtpSendStub | null): void {
    sandboxEgressOverrides.smtpSend = fn
  },
  /** Hosts this predicate matches route to the stub fetch above, guards skipped. */
  setFetchInterceptsHost(fn: ((hostname: string) => boolean) | null): void {
    sandboxEgressOverrides.fetchInterceptsHost = fn
  },
}

export interface AppManifestForBridge {
  name: string
  schema?: Record<string, { fields?: Record<string, any> }>
  events?: { emits?: string[] }
  capabilities?: string[]
  /** I9 — declared scopes used to intersect `grants_setUserScopes` args. */
  scopes?: string[]
  /**
   * Trust posture (T10): the bridge methods that hand back kernel-level
   * primitives (currently `agent_spawn`) refuse to execute unless the manifest
   * sets `trusted: true`. Untrusted apps can still call sandboxed methods
   * (`fetch`, `db`, `emit`, …) but cannot manufacture nested agent runs.
   */
  trusted?: boolean
  connections?: Record<
    string,
    {
      /** "oauth2" (a token) or "credentials" (a field map); decides what `ctx.fetch` auth injects. */
      type?: string
      allowedDomains?: string[]
      credentialFields?: Array<{ name: string; type?: string; readable?: boolean }>
      /**
       * Config keys naming an ENCRYPTED connection secret in `apps.config` — the
       * OAuth client-secret mirror and the kernel-minted webhook secret. The
       * `config_get` bridge derives "which keys to decrypt" from THESE manifest
       * declarations (the stable source always present at the call site), so a
       * gap in the in-memory `connectionConfigRegistry` (process restart, code
       * path that skipped registration) can never cause a stored secret to be
       * handed back as raw ciphertext — which would break webhook HMAC verify.
       */
      clientSecretConfigKey?: string
      webhookSecretConfigKey?: string
      /** Provider-minted secrets the app stores through `config_setSecret`. */
      appSecretConfigKeys?: string[]
    }
  >
  network?: { allowedDomains?: string[]; allowPrivateHostsInTest?: boolean }
  /**
   * Phase 17 B7 — when present, the sandbox `executeTool` bridge translates
   * the in-process `{ data | blocked | error }` envelope into the K4
   * `{ status, result | approval_id | code }` envelope. Apps that pre-date
   * Phase 17 (Mail, Tickets) do not set this, so they observe the legacy
   * shape and their existing handlers continue to work unchanged.
   */
  cross_app_calls?: Array<{ target: string; reason: string }>
}

/** Re-wrap a Drizzle "Failed query: <sql>" error with the postgres cause inlined.
 *  The sandbox worker IPC serializes only `message` (the `.cause` chain is lost
 *  crossing the process boundary), so without this the job/tool log shows the SQL
 *  but not WHY it failed (RLS, timeout, constraint, connection). Same pattern as
 *  db_insert/db_findMany. */
export function withPgCause(err: unknown, label: string): Error {
  const e = err as { message?: string; cause?: { message?: string; code?: string } }
  if (e?.cause?.message) {
    return new Error(
      `${e.message ?? label} — pg: ${e.cause.message}${e.cause.code ? ` (${e.cause.code})` : ""}`,
    )
  }
  return err instanceof Error ? err : new Error(String(err))
}

export function snakeCase(str: string): string {
  return str.replace(/([A-Z])/g, "_$1").toLowerCase()
}

export function matchesDomain(url: string | URL, allowedDomains: string[]): boolean {
  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    return false
  }
  return allowedDomains.some((pattern) => {
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(2)
      return hostname.endsWith(`.${suffix}`) // subdomains only, NOT root domain
    }
    return hostname === pattern
  })
}

function defaultPort(url: URL): string {
  return url.port || (url.protocol === "https:" ? "443" : "80")
}

/**
 * LIAISON_APP_PRIVATE_HOSTS: the operator's comma-separated list of private hosts (`host` or
 * `host:port`, exact names, no wildcards) an app may reach on a private or loopback address and
 * over plain HTTP, for a service on the deployment's own network. Empty by default. The app's own
 * domain allow-list still applies, and link-local and metadata addresses are always refused.
 */
export function isOperatorPrivateAppHost(url: URL): boolean {
  const raw = process.env.LIAISON_APP_PRIVATE_HOSTS ?? ""
  if (!raw.trim()) return false
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "")
  const port = defaultPort(url)
  for (const entry of raw.split(",")) {
    const e = entry.trim().toLowerCase()
    if (!e) continue
    // `[v6]:port`, `[v6]`, `host:port`, `host` (a bare v6 literal has several colons).
    const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(e) ?? /^([^:]+):(\d+)$/.exec(e)
    const entryHost = m ? m[1] : e
    const entryPort = m ? m[2] : undefined
    if (entryHost === host && (entryPort === undefined || entryPort === port)) return true
  }
  return false
}

/** An IP literal as compared: lowercased, no brackets, IPv4-mapped IPv6 unwrapped. */
function normalizeAddress(address: string): string {
  const a = address
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a)
  return mapped ? mapped[1]! : a
}

/**
 * LIAISON_CELL_PUBLIC_ADDRESSES: this server's own public IPv4/IPv6 addresses
 * (comma-separated). Traffic from the host to its own public address can reach
 * any port a container publishes on all interfaces, so an org's custom app may
 * never fetch them.
 */
export function cellOwnAddresses(): Set<string> {
  const raw = env.LIAISON_CELL_PUBLIC_ADDRESSES ?? ""
  return new Set(
    raw
      .split(",")
      .map((a) => normalizeAddress(a))
      .filter((a) => a.length > 0),
  )
}

/** The host names of this server itself: its base URL, its web origins, its org hosts. */
function cellOwnHostSuffixes(): { exact: Set<string>; suffixes: string[] } {
  const exact = new Set<string>()
  const suffixes: string[] = []
  const add = (u: string | undefined) => {
    if (!u) return
    try {
      exact.add(new URL(u).hostname.toLowerCase())
    } catch {
      // not a URL: ignored
    }
  }
  add(env.BASE_URL)
  for (const o of (env.ALLOWED_ORIGINS ?? "").split(",")) add(o.trim())
  const template = env.LIAISON_ORG_HOST_TEMPLATE
  if (template) {
    const host = /^[a-z]+:\/\/([^/:]+)/i.exec(template)?.[1]?.toLowerCase() ?? ""
    const suffix = host.startsWith("{slug}.") ? host.slice("{slug}.".length) : ""
    if (suffix) {
      exact.add(suffix)
      suffixes.push(`.${suffix}`)
    }
  }
  return { exact, suffixes }
}

/** Whether `hostname` names this server (its own origins or an org host on it). */
export function isCellOwnHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "")
  const { exact, suffixes } = cellOwnHostSuffixes()
  if (exact.has(h) || suffixes.some((s) => h.endsWith(s))) return true
  return cellOwnAddresses().has(normalizeAddress(h))
}

const CELL_SELF_REFUSAL = "Outbound URL must not point to this server's own address"

/**
 * The per-hop policy every sandbox `fetchWithPinnedHost` call spreads in. An
 * instance app reaches the operator's private hosts (LIAISON_APP_PRIVATE_HOSTS);
 * an org's custom app never does, and never reaches this server's own public
 * addresses (LIAISON_CELL_PUBLIC_ADDRESSES), even through DNS or a redirect.
 */
export function sandboxEgressPolicy(appName: string): {
  privateAllowedFor: (url: URL) => boolean
  refuseAddress?: (address: string, url: URL) => string | null
} {
  if (!sandboxTenantKey(appName)) return { privateAllowedFor: isOperatorPrivateAppHost }
  return {
    privateAllowedFor: () => false,
    refuseAddress: (address, url) =>
      cellOwnAddresses().has(normalizeAddress(address)) || isCellOwnHost(url.hostname)
        ? CELL_SELF_REFUSAL
        : null,
  }
}

export function validateSandboxFetchUrl(
  url: string | URL,
  allowedDomains: string[],
  allowPrivateHostsInTest: boolean,
  appName: string,
): URL {
  const parsed = new URL(url)
  if (!matchesDomain(parsed, allowedDomains)) {
    throw new Error(`Domain not in allowlist: ${parsed.hostname}`)
  }
  const custom = sandboxTenantKey(appName) !== undefined
  // An org's custom app: never this server itself, by name or literal address.
  if (custom && isCellOwnHost(parsed.hostname)) throw new Error(CELL_SELF_REFUSAL)

  try {
    // DNS resolution + private-net check happens inside fetchWithPinnedHost
    // (single lookup, pinned at connect time). This call only validates
    // scheme + literal-IP private ranges. The operator's private hosts are
    // for instance apps only, never an org's custom app.
    if (!custom && isOperatorPrivateAppHost(parsed)) {
      return validateOutboundUrlNoDns(parsed, { requireHttps: false, allowPrivate: true })
    }
    return validateOutboundUrlNoDns(parsed, { requireHttps: true, allowPrivateHostsInTest })
  } catch (err) {
    if (err instanceof UnsafeOutboundUrlError) {
      throw new Error(err.message)
    }
    throw err
  }
}

/**
 * The Knowledge actor a bridge method reads and writes as: the calling person's
 * org, id, scopes, dimension grants and ROLES. Every Knowledge bridge method
 * builds its actor here, so a document shared with a role the person holds is
 * readable on every path (search, get, find by title, update) alike; a path
 * that dropped the roles found a document in search and then could not open it.
 */
export function bridgeKnowledgeActorInput(ctx: {
  orgId: string
  userId: string
  callerScopes: string[] | undefined
  inheritedActor: ActorContext
}): {
  orgId: string
  userId: string
  scopes: string[]
  dimensionGrants: Record<string, string[]>
  roles: string[]
} {
  const person = ctx.inheritedActor.actorType === "user" ? ctx.inheritedActor : null
  return {
    orgId: ctx.orgId,
    userId: ctx.userId,
    scopes: ctx.callerScopes ?? [],
    dimensionGrants: person?.dimensionGrants ?? {},
    roles: person?.roles ?? [],
  }
}
