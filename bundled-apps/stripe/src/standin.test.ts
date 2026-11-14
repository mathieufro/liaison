// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A stand-in install (the demo's card-payments account): what its mark changes
// in this app, and that nothing in this app can set it.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { type ConnectionCtx, runConnectionCheck } from "./connection"
import { MemDb } from "./mem-db.testkit"
import { mockFetch, stripeMockReset } from "./money.testkit"
import { isStandInInstall, STANDIN_HOST, STANDIN_MARKER } from "./standin"
import { homeLoad } from "./sync/home"
import { cardUpdateLink } from "./tools/links"
import { dashboardShown, type HomeLoad } from "./ui/home-model"

const NOW = new Date("2026-11-20T10:00:00Z")
const STANDIN_PORTAL = `https://${STANDIN_HOST}/p/login/maison_arlon`
const STANDIN_INVOICE = `https://${STANDIN_HOST}/i/in_arlon_open`
const REAL_PORTAL = "https://billing.stripe.com/p/login/test_Abc123"
const REAL_INVOICE = "https://invoice.stripe.com/i/acct_x/live_abc"

function seeded(standIn: boolean, hosted: string): MemDb {
  const db = new MemDb()
  db.seed("install_metadata", [
    {
      state: "connected",
      livemode: false,
      permissions: standIn ? { mode: "test", checks: [], [STANDIN_MARKER]: true } : null,
    },
  ])
  db.seed("stripe_invoices", [
    {
      stripe_id: "in_arlon_open",
      customer_id: "cus_arlon",
      status: "open",
      number: "TF-0042",
      hosted_invoice_url: hosted,
      finalized_at: "2026-11-15T00:00:00Z",
    },
  ])
  return db
}

/** The page's reads of a MemDb, with the counts it asks for. */
const counted = (db: MemDb) =>
  ({ findMany: db.findMany.bind(db), count: async () => 0 }) as unknown as Parameters<
    typeof homeLoad
  >[1]["db"]

const ctx = (db: MemDb, portal: unknown = null) => ({
  db,
  fetch: mockFetch,
  config: { get: async () => portal },
  now: () => NOW,
})

describe("a stand-in install", () => {
  it("a card link in a stand-in install points at the stand-in host", async () => {
    stripeMockReset()
    const portal = await cardUpdateLink(
      { customerId: "cus_arlon" },
      ctx(seeded(true, STANDIN_INVOICE), STANDIN_PORTAL),
    )
    expect(portal).toMatchObject({ url: STANDIN_PORTAL, kind: "portal_login" })
    const hosted = await cardUpdateLink(
      { customerId: "cus_arlon" },
      ctx(seeded(true, STANDIN_INVOICE)),
    )
    expect(hosted).toMatchObject({
      url: STANDIN_INVOICE,
      kind: "hosted_invoice",
      invoiceId: "in_arlon_open",
    })
    // Even a stand-in install never hands out the processor's real hosts it holds no account on.
    const real = await cardUpdateLink(
      { customerId: "cus_arlon" },
      ctx(seeded(true, REAL_INVOICE), REAL_PORTAL),
    )
    expect(real).toMatchObject({ url: null, kind: null })
  })

  it("a real install refuses any other host", async () => {
    stripeMockReset()
    const standInLinks = await cardUpdateLink(
      { customerId: "cus_arlon" },
      ctx(seeded(false, STANDIN_INVOICE), STANDIN_PORTAL),
    )
    expect(standInLinks).toMatchObject({ url: null, kind: null })
    const foreign = await cardUpdateLink(
      { customerId: "cus_arlon" },
      ctx(
        seeded(false, "https://pay.attacker.example/i/x"),
        "https://pay.attacker.example/p/login/x",
      ),
    )
    expect(foreign).toMatchObject({ url: null, kind: null })
    const real = await cardUpdateLink(
      { customerId: "cus_arlon" },
      ctx(seeded(false, REAL_INVOICE), REAL_PORTAL),
    )
    expect(real).toMatchObject({ url: REAL_PORTAL, kind: "portal_login" })
  })

  it("no route or tool sets the stand-in marker, and the key check keeps it without ever adding it", async () => {
    // Only the reader and the key check (which carries over what it found) name the mark.
    const src = join(import.meta.dir)
    const files: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name))
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$|\.testkit\.ts$/.test(e.name))
          files.push(join(dir, e.name))
      }
    }
    walk(src)
    walk(join(src, ".."))
    const naming = files
      .filter((f) => !f.includes("node_modules"))
      .filter((f) => {
        const text = readFileSync(f, "utf8")
        return text.includes(STANDIN_MARKER) || /\bSTANDIN_MARKER\b/.test(text)
      })
      .map((f) => f.slice(src.length - 3))
    expect([...new Set(naming)].sort()).toEqual(["src/connection.ts", "src/standin.ts"])
    const manifest = readFileSync(join(src, "..", "app.manifest.json"), "utf8")
    expect(manifest).not.toContain(STANDIN_MARKER)

    const answer = async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ object: "list", data: [{ id: "x_1", livemode: false }] }),
    })
    const run = async (permissions: unknown) => {
      const rows: Array<Record<string, unknown>> = [{ id: "i1", state: "connected", permissions }]
      const db: ConnectionCtx["db"] = {
        findMany: async (entity) => (entity === "install_metadata" ? rows : []),
        insert: async () => ({ id: "x" }),
        update: async (_e, _id, data) => {
          Object.assign(rows[0] as Record<string, unknown>, data)
        },
      }
      await runConnectionCheck({ fetch: answer, db }, { now: NOW })
      return rows[0]
    }
    expect(isStandInInstall(await run({ mode: "test", checks: [], [STANDIN_MARKER]: true }))).toBe(
      true,
    )
    expect(isStandInInstall(await run({ mode: "test", checks: [] }))).toBe(false)
    expect(isStandInInstall(await run(null))).toBe(false)
  })

  it("the host's demo seeder writes the same marker and the same host", () => {
    const host = readFileSync(
      join(
        import.meta.dir,
        "..",
        "..",
        "..",
        "apps",
        "api",
        "src",
        "modules",
        "demo",
        "worlds",
        "saas",
        "payments",
        "sentinel.ts",
      ),
      "utf8",
    )
    expect(host).toContain(`PAYMENTS_STANDIN_MARKER = "${STANDIN_MARKER}"`)
    expect(host).toContain(`PAYMENTS_STANDIN_HOST = "${STANDIN_HOST}"`)
  })

  it("the dashboard buttons are absent in a stand-in install", async () => {
    const db = new MemDb()
    db.seed("install_metadata", [
      { state: "connected", livemode: false, permissions: { checks: [], [STANDIN_MARKER]: true } },
    ])
    const load = (await homeLoad({}, { db: counted(db) })) as unknown as HomeLoad
    expect(load.connection.standIn).toBe(true)
    expect(dashboardShown(load)).toBe(false)
    const real = new MemDb()
    real.seed("install_metadata", [{ state: "connected", livemode: false, permissions: null }])
    expect(dashboardShown((await homeLoad({}, { db: counted(real) })) as unknown as HomeLoad)).toBe(
      true,
    )

    // Every link out to the dashboard sits under the stand-in guard.
    const ui = join(import.meta.dir, "ui")
    const testids = [
      ["CustomerDetail.tsx", 'data-testid="stripe-customer-open"'],
      ["CustomersList.tsx", 'data-testid="stripe-open-dashboard"'],
      ["StripeHome.tsx", 'data-testid="stripe-open-stripe"'],
      ["StripeHome.tsx", "data-testid={`stripe-dispute-open-"],
      ["StripeSidebar.tsx", 'data-testid="stripe-sidebar-dashboard"'],
    ] as const
    for (const [file, id] of testids) {
      const lines = readFileSync(join(ui, file), "utf8").split("\n")
      const at = lines.findIndex((l) => l.includes(id))
      expect({ file, id, found: at >= 0 }).toEqual({ file, id, found: true })
      const before = lines.slice(Math.max(0, at - 10), at).join("\n")
      expect({ file, id, guarded: /dashboardShown|standIn\(\)/.test(before) }).toEqual({
        file,
        id,
        guarded: true,
      })
    }
    const states = readFileSync(join(ui, "HomeStates.tsx"), "utf8")
    expect(states).toContain("dashboardShown(props.load) || !DASHBOARD_ACTIONS.has(a.id)")
    const refunds = readFileSync(join(ui, "RefundCards.tsx"), "utf8")
    expect(refunds).toContain('!(p.standIn && a.id === "open_stripe")')
  })
})
