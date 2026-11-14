// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Fictional web pages a demo org's agents can fetch (a prospect's company
// site in the sales scenario), answered in process before any network.
//
// Only hosts under a reserved `.example` name the demo world invented are
// answered, and only for a demo org: every other host, and every host for a
// regular org, gets `null` and the fetch goes ahead as usual.
import { isDemoOrgId } from "~/modules/demo/demo-org"
import { SAAS_FIXTURE_PAGES } from "~/modules/demo/worlds/saas/web-fixture"

export interface DemoWebFetchFixture {
  status: number
  body: string
  contentType: string
}

/** The sales scenario's prospect (sales-email.ts). */
export const PROSPECT_SITE_HOST = "northwind-acoustics.example"

const PAGE = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body><header><h1>Northwind Acoustics</h1><p>Rental and studio fit-out, Lisbon and Porto</p></header>` +
  `<main>${body}</main><footer><p>Northwind Acoustics, Rua do Exemplo 12, Lisbon. ` +
  `Contact: hello@northwind-acoustics.example</p></footer></body></html>`

/** The prospect's site, by path. Fixed content, fictional company. */
const PROSPECT_PAGES: Readonly<Record<string, string>> = {
  "/": PAGE(
    "Northwind Acoustics",
    "<h2>Studios and rental desk</h2>" +
      "<p>Northwind Acoustics rents field recorders, microphones and preamps to film crews, " +
      "podcasters and theatres, and fits out small recording studios. Founded in 2016, 18 " +
      "people, two sites (Lisbon and Porto).</p>" +
      "<h2>News</h2><p>Spring 2027: two new studios open in Porto. We are re-equipping the " +
      "rental desk with 40 portable recorders.</p>" +
      '<p><a href="/about">About us</a> · <a href="/team">Team</a></p>',
  ),
  "/about": PAGE(
    "About Northwind Acoustics",
    "<h2>About</h2><p>Independent rental house serving Portuguese and Spanish productions. " +
      "We buy through dealers or direct, on 30-day terms, and standardise on one recorder " +
      "model per kit so crews can swap units.</p>",
  ),
  "/team": PAGE(
    "Team",
    "<h2>Team</h2><ul><li>Inês Duarte, head of the rental desk (purchasing)</li>" +
      "<li>Rui Matos, studio engineer</li><li>Carla Nunes, finance</li></ul>",
  ),
}

function hostOf(url: string): { host: string; path: string } | null {
  try {
    const u = new URL(url)
    if (u.protocol !== "https:" && u.protocol !== "http:") return null
    return { host: u.hostname.toLowerCase(), path: u.pathname.replace(/\/+$/, "") || "/" }
  } catch {
    return null
  }
}

/**
 * The fixture page for `url` when `orgId` is a demo org and the host is one of
 * the demo's fictional sites, else `null` (the fetch goes ahead as usual).
 */
export async function demoWebFetchFixture(
  orgId: string,
  url: string,
): Promise<DemoWebFetchFixture | null> {
  const target = hostOf(url)
  if (!target) return null
  const host = target.host.replace(/^www\./, "")
  const saasPages = SAAS_FIXTURE_PAGES[host]
  if (host !== PROSPECT_SITE_HOST && !saasPages) return null
  if (!(await isDemoOrgId(orgId))) return null
  const page = (saasPages ?? PROSPECT_PAGES)[target.path]
  return page
    ? { status: 200, body: page, contentType: "text/html; charset=utf-8" }
    : {
        status: 404,
        body: PAGE("Not found", "<p>Page not found.</p>"),
        contentType: "text/html; charset=utf-8",
      }
}
