// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The public opt-out link, through the real app: opening it never records
// anything, the page's button records it once however often it is pressed, a
// mail client's one-click unsubscribe records it with no page, and every one of
// the six states renders with its status and heading in English and French,
// no script, no cookie, never the recipient's address, and the sender's legal
// name and postal address under the three states that name the sender.

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Server } from "bun"
import { app } from "~/app"
import { sql } from "~/db"
import { WebSocketManager } from "~/infra/websocket"
import { redis } from "~/lib/redis"
import { createServer, type WsData } from "~/lib/server"
import * as footerModule from "~/modules/mail/commercial-footer"
import { mintOptOutLink } from "~/modules/mail/commercial-footer"
import { hashEmail } from "~/modules/mail/suppressions"
import { insertSql } from "~/seed/factories/org/test-rows"

const ORG = crypto.randomUUID()
const tag = ORG.slice(0, 8)
const RECIPIENT = `lena-${tag}@prospect.example`
const IDENTITY = {
  legalName: "Brume Nord SARL",
  postalAddress: "12 quai des Brumes, 59000 Lille",
}

const pathOf = (url: string) => new URL(url).pathname
const get = (path: string, lang = "en") =>
  app.request(path, {
    headers: { "Accept-Language": lang, "X-Forwarded-For": `10.9.${tag.length}.1` },
  })
const post = (path: string, body = "", lang = "en") =>
  app.request(path, {
    method: "POST",
    headers: {
      "Accept-Language": lang,
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Forwarded-For": `10.9.${tag.length}.1`,
    },
    body,
  })

async function suppressionRows(): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM kernel.suppressions WHERE org_id = ${ORG}`
  return row?.n ?? 0
}

const headingOf = (html: string) => /<h1>([^<]*)<\/h1>/.exec(html)?.[1] ?? ""

beforeAll(async () => {
  await sql.unsafe(
    insertSql("kernel.organizations", {
      id: ORG,
      name: "Brume Nord",
      slug: `opt-out-${tag}`,
      settings: { raw: `'${JSON.stringify({ commercialIdentity: IDENTITY })}'::jsonb` },
    }),
  )
})

afterAll(async () => {
  await sql`DELETE FROM kernel.suppression_links WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.suppressions WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
})

describe("the opt-out link", () => {
  it("opening the link five times suppresses nothing; one post adds one row; a second post keeps one row and shows the same page", async () => {
    const path = pathOf((await mintOptOutLink(ORG, RECIPIENT)).url)
    for (let i = 0; i < 5; i++) {
      const res = await get(path)
      expect(res.status).toBe(200)
      await res.text()
    }
    expect(await suppressionRows()).toBe(0)
    const first = await post(path)
    const firstHtml = await first.text()
    expect(first.status).toBe(200)
    expect(await suppressionRows()).toBe(1)
    const second = await post(path)
    expect(second.status).toBe(200)
    expect(await second.text()).toBe(firstHtml)
    expect(await suppressionRows()).toBe(1)
    const [row] = await sql<{ reason: string; email_hash: string }[]>`
      SELECT reason, email_hash FROM kernel.suppressions WHERE org_id = ${ORG}`
    expect(row).toEqual({ reason: "link", email_hash: hashEmail(ORG, RECIPIENT) })
  })

  it("a mail client's one-click unsubscribe records the opt-out and answers with no page", async () => {
    const other = `paul-${tag}@prospect.example`
    const path = pathOf((await mintOptOutLink(ORG, other)).url)
    const res = await post(path, "List-Unsubscribe=One-Click")
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("")
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.suppressions
       WHERE org_id = ${ORG} AND email_hash = ${hashEmail(ORG, other)}`
    expect(row?.n).toBe(1)
  })

  it("each of the six states has its status, heading in en and fr, no script, no cookie, no address in the page, and the legal name and address in the footer", async () => {
    const fresh = async () =>
      pathOf((await mintOptOutLink(ORG, `s-${crypto.randomUUID()}@prospect.example`)).url)
    const footer = `${IDENTITY.legalName}, ${IDENTITY.postalAddress}`
    type Case = {
      state: string
      status: number
      en: string
      fr: string
      footer: boolean
      run: (lang: string) => Response | Promise<Response>
    }
    const confirmPath = await fresh()
    const donePath = await fresh()
    const alreadyPath = await fresh()
    await post(alreadyPath)
    const cases: Case[] = [
      {
        state: "confirm",
        status: 200,
        en: `Stop commercial messages from ${IDENTITY.legalName}?`,
        fr: `Ne plus recevoir de messages commerciaux de ${IDENTITY.legalName} ?`,
        footer: true,
        run: (lang) => get(confirmPath, lang),
      },
      {
        state: "done",
        status: 200,
        en: `Done. You will not get commercial messages from ${IDENTITY.legalName}.`,
        fr: `C'est fait. Vous ne recevrez plus de messages commerciaux de ${IDENTITY.legalName}.`,
        footer: true,
        run: (lang) => post(donePath, "", lang),
      },
      {
        state: "already",
        status: 200,
        en: `You already opted out of commercial messages from ${IDENTITY.legalName}.`,
        fr: `Vous êtes déjà désinscrit des messages commerciaux de ${IDENTITY.legalName}.`,
        footer: true,
        run: (lang) => get(alreadyPath, lang),
      },
      {
        state: "invalid",
        status: 404,
        en: "This link is not valid.",
        fr: "Ce lien n'est pas valide.",
        footer: false,
        run: (lang) => get("/public/opt-out/not-a-token", lang),
      },
      {
        state: "unavailable",
        status: 503,
        en: "This page is not available right now.",
        fr: "Cette page n'est pas disponible pour le moment.",
        footer: false,
        run: async (lang) => {
          const down = spyOn(footerModule, "resolveOptOutToken").mockImplementation(async () => {
            throw new Error("database down")
          })
          try {
            return await get(confirmPath, lang)
          } finally {
            down.mockRestore()
          }
        },
      },
      {
        state: "too_many",
        status: 429,
        en: "Too many attempts.",
        fr: "Trop de tentatives.",
        footer: false,
        run: async (lang) => {
          const before = process.env.RATE_LIMIT_FORCE_ENABLED
          process.env.RATE_LIMIT_FORCE_ENABLED = "1"
          const ip = `10.77.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`
          try {
            let last: Response | null = null
            for (let i = 0; i < 40; i++) {
              last = await app.request(confirmPath, {
                headers: { "Accept-Language": lang, "X-Forwarded-For": ip },
              })
              if (last.status === 429) return last
              await last.text()
            }
            return last as Response
          } finally {
            if (before === undefined) delete process.env.RATE_LIMIT_FORCE_ENABLED
            else process.env.RATE_LIMIT_FORCE_ENABLED = before
            await redis.del(`ratelimit:public:opt-out:${ip}`).catch(() => 0)
          }
        },
      },
    ]
    for (const c of cases) {
      for (const lang of ["en", "fr"] as const) {
        const res = await c.run(lang === "fr" ? "fr-FR,fr;q=0.9" : "en-GB,en;q=0.8")
        const html = await res.text()
        expect({ state: c.state, lang, status: res.status }).toEqual({
          state: c.state,
          lang,
          status: c.status,
        })
        expect(headingOf(html).replace(/&#39;/g, "'")).toBe(lang === "fr" ? c.fr : c.en)
        expect(html).not.toContain("<script")
        expect(res.headers.get("set-cookie")).toBeNull()
        expect(res.headers.get("referrer-policy")).toBe("no-referrer")
        expect(res.headers.get("x-robots-tag")).toContain("noindex")
        expect(html).not.toContain("@prospect.example")
        expect(html.includes(`<footer>${footer}</footer>`)).toBe(c.footer)
      }
    }
  })
})

describe("the opt-out link behind the server that also serves the web app", () => {
  // In production one server answers both the web app and the API: a GET the
  // static handler took for a web route would show the app's sign-in page.
  let server: Server<WsData>
  let base: string
  let publicDir: string

  beforeAll(async () => {
    publicDir = mkdtempSync(join(tmpdir(), "liaison-optout-spa-"))
    writeFileSync(
      join(publicDir, "index.html"),
      "<!doctype html><html><body><script>app</script>SPA</body></html>",
    )
    server = await createServer(app, { port: 0, publicDir, wsManager: new WebSocketManager(redis) })
    base = `http://127.0.0.1:${server.port}`
  })

  afterAll(() => {
    server.stop(true)
    rmSync(publicDir, { recursive: true, force: true })
  })

  it("a GET of the link the mail footer carries reaches the opt-out page, not the web app", async () => {
    const path = pathOf((await mintOptOutLink(ORG, `ines-${tag}@prospect.example`)).url)
    const before = await suppressionRows()
    const res = await fetch(`${base}${path}`, {
      headers: { "Accept-Language": "en", "X-Forwarded-For": `10.9.${tag.length}.2` },
    })
    const html = await res.text()
    expect(res.status).toBe(200)
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow")
    expect(html).not.toContain("SPA")
    expect(html).not.toContain("<script")
    expect(res.headers.get("set-cookie")).toBeNull()
    // Opening the link records nothing.
    expect(await suppressionRows()).toBe(before)
  })

  it("a GET of an unknown well-formed token answers the page's Invalid state, not the web app", async () => {
    const res = await fetch(`${base}/public/opt-out/${"A".repeat(43)}`, {
      headers: { "Accept-Language": "en", "X-Forwarded-For": `10.9.${tag.length}.3` },
    })
    const html = await res.text()
    expect(res.status).toBe(404)
    expect(html).not.toContain("SPA")
    expect(html).not.toContain("<script")
  })
})
