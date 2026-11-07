// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Host binding: with LIAISON_ORG_HOST_TEMPLATE set (`https://{slug}.example.com`)
// each org is served on its own host, and a credential of org A is refused on
// any host that does not map to A. The request's host comes from the edge seam
// (lib/request-context.ts `effectiveRequest`).
//
// A host is one of:
// - `unbound`: the template is unset. Nothing is bound; behaviour is unchanged.
// - `org`: the host matches the template with a slug that can be an org's.
// - `non-org`: anything else (the cell's own `cell-<n>` names, a tunnel host,
//   loopback, a bare IP, no host at all). It serves only NON_ORG_HOST_PATHS.

import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { env } from "~/lib/env"
import { effectiveRequest, effectiveRequestFromRaw } from "~/lib/request-context"

export type HostBinding =
  | { kind: "unbound" }
  | { kind: "org"; slug: string; origin: string }
  | { kind: "non-org" }

const SLUG_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
/** Labels a cell answers to for itself (its own name, its origin name): never an org. */
const CELL_LABEL = /^cell-[a-z0-9]+(?:-origin)?$/

let parsedFor: string | undefined
let parsed: { re: RegExp; scheme: string } | null = null

function templateMatcher(): { re: RegExp; scheme: string } | null {
  const template = env.LIAISON_ORG_HOST_TEMPLATE
  if (!template) return null
  if (parsedFor !== template) {
    const url = new URL(template.replace("{slug}", "slug-placeholder"))
    const hostTemplate = template.slice(`${url.protocol}//`.length).toLowerCase()
    const [before, after] = hostTemplate.split("{slug}") as [string, string]
    const quote = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    parsed = {
      re: new RegExp(`^${quote(before)}(${SLUG_LABEL})${quote(after)}$`),
      scheme: url.protocol,
    }
    parsedFor = template
  }
  return parsed
}

/** Whether orgs are bound to their hosts on this deployment. */
export function hostBindingEnabled(): boolean {
  return Boolean(env.LIAISON_ORG_HOST_TEMPLATE)
}

/** What a host (as the edge reported it) is under the template. */
export function hostBindingOf(host: string | null): HostBinding {
  const matcher = templateMatcher()
  if (!matcher) return { kind: "unbound" }
  if (!host) return { kind: "non-org" }
  const m = matcher.re.exec(host.toLowerCase())
  const slug = m?.[1]
  if (!slug || CELL_LABEL.test(slug)) return { kind: "non-org" }
  return { kind: "org", slug, origin: `${matcher.scheme}//${host.toLowerCase()}` }
}

/** The binding of a request's effective host. */
export function requestHostBinding(c: Context): HostBinding {
  return hostBindingOf(effectiveRequest(c).host)
}

/** The binding of a raw request's effective host (the WebSocket upgrade). */
export function rawRequestHostBinding(req: Request, socketIp: string | null): HostBinding {
  return hostBindingOf(effectiveRequestFromRaw(req, socketIp).host)
}

// slug → org id, briefly cached: every bound request needs it. Only hits are
// kept: a miss cached here would keep an org created a moment later (on this
// process or any other) unknown on its own host, refusing every credential
// right at its first sign-in. A slug's org id never changes while the org
// lives; the purge forgets its slug here (other processes keep the old id for
// at most SLUG_CACHE_MS, refusing a new org of that slug meanwhile, never
// admitting a wrong one: the deleted org's credentials are gone).
const SLUG_CACHE_MS = 30_000
const slugCache = new Map<string, { orgId: string; at: number }>()

/** The id of the org with this slug, or null. */
export async function orgIdForSlug(slug: string): Promise<string | null> {
  const hit = slugCache.get(slug)
  if (hit && Date.now() - hit.at < SLUG_CACHE_MS) return hit.orgId
  const [{ withSystemDb }, { organizations }, { eq }] = await Promise.all([
    import("~/db/privileged"),
    import("~/db/schema/kernel"),
    import("drizzle-orm"),
  ])
  const [row] = await withSystemDb("org-host-slug", (db) =>
    db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, slug))
      .limit(1),
  )
  if (!row) return null
  if (slugCache.size > 10_000) slugCache.clear()
  slugCache.set(slug, { orgId: row.id, at: Date.now() })
  return row.id
}

/** Forget one slug's cached org id (the org was deleted). */
export function forgetOrgHostSlug(slug: string): void {
  slugCache.delete(slug)
}

/** Forget cached slug lookups (tests; a renamed org). */
export function forgetOrgHostCache(): void {
  slugCache.clear()
}

/** Whether a credential of `orgId` may be used under this binding. */
export async function bindingAllowsOrg(binding: HostBinding, orgId: string): Promise<boolean> {
  if (binding.kind === "unbound") return true
  if (binding.kind === "non-org") return false
  return (await orgIdForSlug(binding.slug)) === orgId
}

/** Whether a credential of `orgId` may be used on this request's host. */
export function hostAllowsOrg(c: Context, orgId: string): Promise<boolean> {
  return bindingAllowsOrg(requestHostBinding(c), orgId)
}

/** 401 unless a credential of `orgId` may be used on this request's host. */
export async function assertHostAllowsOrg(c: Context, orgId: string): Promise<void> {
  if (!(await hostAllowsOrg(c, orgId))) {
    throw new HTTPException(401, { message: "Unauthorized" })
  }
}

/**
 * The org slug a sign-in on this request names. Bound: the host's slug, and a
 * body slug that disagrees is a 400. Unbound: the body's slug, as before.
 * On a non-org host no sign-in can name an org: 404.
 */
export function signInOrgSlug(c: Context, bodySlug: string | undefined): string | undefined {
  const binding = requestHostBinding(c)
  if (binding.kind === "unbound") return bodySlug
  if (binding.kind === "non-org") throw new HTTPException(404, { message: "Not found" })
  if (bodySlug !== undefined && bodySlug !== "" && bodySlug.toLowerCase() !== binding.slug) {
    throw new HTTPException(400, { message: "This workspace is served on its own address" })
  }
  return binding.slug
}

/**
 * What a non-org host serves: the signed control API, health, diagnostics,
 * inbound webhooks and the Workers app bridge (its run token is its only
 * credential, and one bridge serves every org of the cell). Everything else is
 * 404 there.
 */
export function isNonOrgHostPath(path: string): boolean {
  return (
    path === "/healthz" ||
    path === "/readyz" ||
    path === "/diag" ||
    path.startsWith("/diag/") ||
    path === "/api/cloud" ||
    path.startsWith("/api/cloud/") ||
    path.startsWith("/webhooks/") ||
    path.startsWith("/api/app-bridge/")
  )
}

/**
 * The CORS answer under host binding: exactly the request's own org origin, or
 * one of `extra` (the wrapped shells' fixed origins, which no tenant controls).
 * Never another tenant's host, never a pattern.
 */
export function boundCorsOrigin(c: Context, origin: string, extra: string[]): string | null {
  const binding = requestHostBinding(c)
  if (binding.kind === "org" && origin === binding.origin) return origin
  return extra.includes(origin) ? origin : null
}

/**
 * Whether a request's Origin may present a refresh token here: under host
 * binding, only the own org origin, a shell origin, or no Origin at all (a
 * non-browser client, which holds no cookie).
 */
export function refreshOriginAllowed(c: Context, extra: string[]): boolean {
  const binding = requestHostBinding(c)
  if (binding.kind === "unbound") return true
  if (binding.kind === "non-org") return false
  const origin = c.req.header("origin")
  if (origin === undefined) return true
  return origin === binding.origin || extra.includes(origin)
}
