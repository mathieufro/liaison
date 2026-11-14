// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Fictional web pages the software world's agents can fetch, answered in
// process before any network (`world/web-fetch-fixture.ts` consults this map):
// the trends page the chat scenario's question points to, and a prospect's
// site in the sales scenario. Hosts are reserved `.example` names the demo
// invented, and every page says so.

const PAGE = (site: string, title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body><header><h1>${site}</h1><p>A fictional site, made for this demo.</p></header>` +
  `<main>${body}</main></body></html>`

/** The chat scenario's source. */
export const SAAS_TRENDS_HOST = "hospitality-trends.example"
export const SAAS_TRENDS_URL = `https://${SAAS_TRENDS_HOST}/seasonal-staffing`

/** The sales scenario's prospect. */
const SAAS_PROSPECT_SITE_HOST = "residence-olympe.example"

const TRENDS_SITE = "Hospitality Trends (fictional)"
const PROSPECT_SITE = "Résidence Olympe"

/** Fixed pages by host, then path. */
export const SAAS_FIXTURE_PAGES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  [SAAS_TRENDS_HOST]: {
    "/seasonal-staffing": PAGE(
      TRENDS_SITE,
      "How hotels plan seasonal staffing",
      "<h2>How hotels plan seasonal staffing</h2>" +
        "<p>Hotels on the coast raise their headcount by about a third between June and " +
        "September. Most plan the summer rota in March, publish it six weeks ahead and expect " +
        "to change a fifth of it before the season ends.</p>" +
        "<h2>What managers ask of their tools</h2>" +
        "<ul><li>Copy last summer's rota as a starting point.</li>" +
        "<li>Import seasonal staff from a spreadsheet.</li>" +
        "<li>See who has worked too many days in a row before publishing.</li>" +
        "<li>Let staff swap shifts, with the manager approving.</li></ul>",
    ),
    "/": PAGE(TRENDS_SITE, "Hospitality Trends", "<p>Articles on staffing in hotels.</p>"),
  },
  [SAAS_PROSPECT_SITE_HOST]: {
    "/": PAGE(
      PROSPECT_SITE,
      PROSPECT_SITE,
      "<h2>Eleven hotels on the Atlantic coast</h2>" +
        "<p>Résidence Olympe runs 11 independent hotels between La Rochelle and Biarritz, " +
        "about 240 staff in high season. Family owned since 2009.</p>" +
        "<h2>News</h2><p>Spring: the group moves its planning to one shared system before the " +
        "summer season.</p>",
    ),
    "/about": PAGE(
      PROSPECT_SITE,
      "About Résidence Olympe",
      "<p>Each hotel keeps its own manager; operations are run from La Rochelle by Hélène " +
        "Marchand.</p>",
    ),
  },
}
