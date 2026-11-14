// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The public opt-out link (`/public/opt-out/:token`). GET only shows the page
 * and never changes anything (mail scanners open links). A POST from the page's
 * button, or a mail client's one-click unsubscribe (RFC 8058, body
 * `List-Unsubscribe=One-Click`), records the opt-out as the system, with
 * reason `link`: once, however often it is repeated. The org and the address
 * fingerprint come from the link's row; no address is ever known here.
 *
 * Mounted behind the public surface body cap and per-IP budget (app.ts); a
 * refusal of either renders this page's Too many or Unavailable state.
 */
import { Hono, type MiddlewareHandler } from "hono"
import type { AppEnv } from "~/app"
import { cspHash, localeFromAcceptLanguage } from "~/lib/html-page"
import { rootLogger } from "~/lib/logger"
import { readCommercialIdentity, resolveOptOutToken } from "~/modules/mail/commercial-footer"
import {
  OPT_OUT_STATUS,
  OPT_OUT_STYLE,
  type OptOutState,
  renderOptOutPage,
} from "~/modules/mail/opt-out-page"
import { addSuppressionHash, isSuppressedHash } from "~/modules/mail/suppressions"

const log = rootLogger.child({ module: "opt-out" })

export { OPT_OUT_PATH } from "~/modules/mail/opt-out-path"

function langOf(header: string | undefined): "en" | "fr" {
  return localeFromAcceptLanguage(header).startsWith("fr") ? "fr" : "en"
}

function pageHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": [
      "default-src 'none'",
      `style-src 'sha256-${cspHash(OPT_OUT_STYLE)}'`,
      "img-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  }
}

function page(
  state: OptOutState,
  req: { header: (name: string) => string | undefined; path: string },
  identity?: { legalName: string; postalAddress: string } | null,
): Response {
  const html = renderOptOutPage({
    state,
    lang: langOf(req.header("accept-language")),
    identity: identity ?? null,
    path: req.path,
  })
  return new Response(html, { status: OPT_OUT_STATUS[state], headers: pageHeaders() })
}

/**
 * In front of the rate limit: its 429 and its fail-closed 503 become this
 * page's Too many and Unavailable states instead of a JSON error.
 */
export const optOutRefusalPage: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next()
  const status = c.res.status
  if ((status === 429 || status === 503) && !c.res.headers.get("x-opt-out-page")) {
    const retryAfter = c.res.headers.get("Retry-After")
    const res = page(status === 429 ? "too_many" : "unavailable", {
      header: (n) => c.req.header(n),
      path: c.req.path,
    })
    if (retryAfter) res.headers.set("Retry-After", retryAfter)
    c.res = undefined
    c.res = res
  }
}

function isOneClick(body: string): boolean {
  return new URLSearchParams(body).get("List-Unsubscribe") === "One-Click"
}

export const optOutRoutes = new Hono<AppEnv>()
  .get("/:token", async (c) => {
    const req = { header: (n: string) => c.req.header(n), path: c.req.path }
    try {
      const link = await resolveOptOutToken(c.req.param("token"))
      if (!link) return page("invalid", req)
      const identity = await readCommercialIdentity(link.orgId)
      const already = await isSuppressedHash(link.orgId, link.emailHash)
      return page(already ? "already" : "confirm", req, identity)
    } catch (err) {
      log.error({ err }, "opt-out page could not be read")
      return marked(page("unavailable", req))
    }
  })
  .post("/:token", async (c) => {
    const req = { header: (n: string) => c.req.header(n), path: c.req.path }
    const oneClick = isOneClick(await c.req.text().catch(() => ""))
    try {
      const link = await resolveOptOutToken(c.req.param("token"))
      if (!link) return oneClick ? new Response(null, { status: 404 }) : page("invalid", req)
      await addSuppressionHash(null, {
        orgId: link.orgId,
        emailHash: link.emailHash,
        reason: "link",
        source: null,
        createdBy: null,
        actorType: "system",
      })
      if (oneClick)
        return new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } })
      return page("done", req, await readCommercialIdentity(link.orgId))
    } catch (err) {
      log.error({ err }, "opt-out could not be recorded")
      return oneClick
        ? marked(new Response(null, { status: 503 }))
        : marked(page("unavailable", req))
    }
  })

/** A response this route rendered itself, which the refusal wrapper leaves alone. */
function marked(res: Response): Response {
  res.headers.set("x-opt-out-page", "1")
  return res
}
