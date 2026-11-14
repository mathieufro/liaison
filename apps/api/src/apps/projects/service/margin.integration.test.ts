// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Margin and cost rates on the real database, with the invoicing app registered from source:
// a project's invoiced amount (hand-laid documents naming the project) minus its time at cost,
// the money half of the budget, rates that apply from a date, who may read any of it, and that
// no answer is ever a figure per person.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import { budgetGet, costRateSet, costRatesList, marginGet } from "~/apps/projects/handlers"
import { projectsAppManifest } from "~/apps/projects/manifest-descriptor"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { toolRegistry } from "~/modules/apps/app-registries"
import { dashboardSourceRefusal } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { forgetOrgApps, primeOrgApps } from "~/modules/apps/org-apps"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { seedContext } from "~/seed/context"
import {
  computeDocuments,
  type InvoicingDocumentSpec,
  seedInvoicingHistory,
} from "~/seed/factories/commerce/invoicing"
import { seedCostRates, seedTaskTime } from "~/seed/factories/projects/time"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { awaitTimeFeatureSync } from "./time-feature"
import { awaitTimeRowWrites } from "./time-rows"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..", "..")
const READ = "projects:projects:read"
const FINANCE = [
  READ,
  "projects:projects:write",
  "projects:money:read",
  "projects:margin:read",
  "projects:cost_rates:write",
]

let orgId = ""
let owner: minimal.Session
const people: minimal.Session[] = []

function actorOf(userId: string, scopes: string[] = ["*"]): UserContext {
  return { actorType: "user", userId, orgId, scopes, dimensionGrants: { "*": ["*"] } }
}

type Handler = (params: unknown, ctx: never) => Promise<unknown>

/** A projects handler run as a person, its ctx the projects bridge, as the core host builds it. */
async function run<T = Record<string, any>>(
  handler: Handler,
  input: unknown,
  opts: { userId?: string; scopes?: string[]; patch?: Record<string, unknown> } = {},
): Promise<T> {
  const a = actorOf(opts.userId ?? owner.userId, opts.scopes ?? FINANCE)
  const out = await withRlsContext(a, async (tx) => {
    const bridge = createRpcBridge(
      "projects",
      a.userId,
      orgId,
      tx,
      projectsAppManifest as never,
      a.scopes,
      "user",
      undefined,
      { origin: "human-ui" } as never,
    )
    return (await handler(input, { ...bridge, ...(opts.patch ?? {}) } as never)) as T
  })
  await awaitTimeRowWrites()
  return out
}

/** A projects bridge method as the owner (setup only). */
async function call<T = Record<string, any>>(method: string, input: unknown): Promise<T> {
  const a = actorOf(owner.userId)
  const out = await withRlsContext(a, async (tx) => {
    const bridge = createRpcBridge(
      "projects",
      a.userId,
      orgId,
      tx,
      { name: "projects" },
      a.scopes,
      "user",
      undefined,
      { origin: "human-ui" } as never,
    )
    return JSON.parse(await bridge[method](JSON.stringify(input))) as T
  })
  await awaitTimeRowWrites()
  return out
}

async function newProject(name: string): Promise<string> {
  const made = await call<{ id: string }>("projects_createProject", { name })
  await call("projects_updateProject", { projectId: made.id, timeBudgets: true })
  await awaitTimeFeatureSync(orgId)
  return made.id
}

async function newTask(projectId: string, title: string, statusLabel = "done"): Promise<string> {
  const t = await call<{ id: string }>("projects_createTask", { projectId, title, statusLabel })
  if (!t.id) throw new Error(`task not created: ${JSON.stringify(t)}`)
  return t.id
}

async function enter(
  person: string,
  rows: Array<{ projectId: string; taskId: string; minutes: number; date: string }>,
) {
  await seedTaskTime(
    seedContext({ orgId, now: new Date() }),
    actorOf(person),
    rows.map((r) => ({ ...r, workDate: r.date })),
  )
}

/** Issued documents of the invoicing app, laid by the seed factory with the project they bill. */
async function invoices(projectId: string, docs: InvoicingDocumentSpec[]): Promise<void> {
  const ctx = seedContext({ orgId, now: NOW })
  const parties = new Map([[CLIENT.key, CLIENT]])
  await seedInvoicingHistory(ctx, {
    issuer: ISSUER,
    hsCodes: [],
    relationships: [],
    documents: computeDocuments(ctx, {
      // A credit note reaches the project through the invoice it corrects.
      documents: docs.map((d) => (d.correctsKey ? d : { ...d, billingProjectId: projectId })),
      parties,
      skus: new Map(),
    }),
    contactIdsByPartyKey: {},
  })
}

const NOW = new Date("2026-11-02T10:00:00.000Z")
const CLIENT = {
  key: "delorme",
  name: "Maison Delorme",
  email: "billing@delorme.example",
  country: "FR",
  vatId: "FR40303265045",
  address: "4 rue des Lilas, 69001 Lyon",
}
const ISSUER = {
  key: "studio",
  legalName: "Studio Issuer SAS",
  country: "FR",
  vatId: "FR60902000009",
  address: "2 rue Test, 75001 Paris",
  iban: "FR7630006000011234567890189",
  swiftBic: "AGRIFRPP",
  bankName: "Banque Test",
  defaultCurrency: "EUR",
  prefixes: { invoice: "F", quote: "D", proforma: "P", po: "BC", creditNote: "A" },
  shopifyShopId: null,
  invoiceApprovalThresholdMinor: "0",
  poApprovalThresholdMinor: "0",
  timezone: "Europe/Paris",
}

function doc(
  key: string,
  type: "invoice" | "credit_note",
  minor: number,
  issuedDaysAgo: number | null,
  over: Partial<InvoicingDocumentSpec> = {},
): InvoicingDocumentSpec {
  return {
    key,
    type,
    status: issuedDaysAgo === null ? "draft" : "issued",
    paymentStatus: "unpaid",
    party: CLIENT.key,
    lines: [
      { description: "Studio work", unitPriceMinor: minor, quantity: 1, lineKind: "software" },
    ],
    issuedDaysAgo,
    ...over,
  }
}

function invoicingDescriptor(): Record<string, unknown> {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "bundled-apps", "invoicing", "app.manifest.json"), "utf8"),
  ) as Record<string, unknown>
  return {
    ...manifest,
    trusted: false,
    _format: "manifest",
    _bundlePath: join(
      REPO_ROOT,
      "bundled-apps",
      "invoicing",
      String(manifest.version),
      "bundle.js",
    ),
  }
}

const hours = (h: number) => h * 60
let portal = ""

beforeAll(async () => {
  await acquireTestLock()
  process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
  orgId = (await createTestOrg()).id
  await db.execute(
    drizzleSql`UPDATE kernel.organizations SET timezone = 'UTC' WHERE id = ${orgId}::uuid`,
  )
  owner = await minimal.adminSession(orgId)
  for (let i = 0; i < 4; i++) people.push(await minimal.session(orgId, { role: "member" }))
  await ensureAppsForOrg(orgId)
  await initSandboxPool()
  await initWorkerPool()
  await registerApps([invoicingDescriptor() as never], orgId)
  await primeOrgApps(orgId, 0)

  // Four people's rates, from the start of the year.
  const rates = [60, 48, 62, 55]
  for (const [i, p] of people.entries()) {
    const set = await run(costRateSet, {
      userId: p.userId,
      rate: rates[i],
      from: "2026-01-01",
      currency: "EUR",
    })
    expect((set as { error?: unknown }).error).toBeUndefined()
  }

  // A fixed-price project of 46 closed tasks; time on 41 of them, 346 h in all:
  // 46 h, 40 h, 102 h and 158 h by the four people.
  portal = await newProject("Maison Delorme portal")
  await call("projects_billingTermsSet", { projectId: portal, fixedPrice: 64000, currency: "EUR" })
  const tasks: string[] = []
  for (let i = 0; i < 46; i++) tasks.push(await newTask(portal, `Step ${i + 1}`))
  const shares: Array<[number, number, number]> = [
    // person, first task, task count
    [0, 0, 5],
    [1, 5, 5],
    [2, 10, 10],
    [3, 20, 21],
  ]
  const totals = [46, 40, 102, 158]
  for (const [p, first, count] of shares) {
    // Whole hours per row, so each row's cost is whole cents at every rate.
    const total = hours(totals[p]!)
    const each = hours(Math.floor(totals[p]! / count))
    await enter(
      people[p]!.userId,
      Array.from({ length: count }, (_, k) => ({
        projectId: portal,
        taskId: tasks[first + k]!,
        minutes: k === count - 1 ? total - each * (count - 1) : each,
        date: "2026-05-04",
      })),
    )
  }

  // Invoiced 44,800 excl. VAT: a paid advance, two invoices and a credit note on the second
  // (the credit note names the invoice it corrects, not the project); a draft counts for nothing.
  await invoices(portal, [
    doc("advance", "invoice", 1_280_000, 200, { status: "paid", paymentStatus: "paid" }),
    doc("discovery", "invoice", 2_000_000, 160),
    doc("design", "invoice", 1_400_000, 120),
    doc("design-credit", "credit_note", 200_000, 110, { correctsKey: "design" }),
    doc("beta", "invoice", 900_000, null),
  ])
}, 600_000)

afterAll(async () => {
  forgetOrgApps(orgId)
  await shutdownWorkerPool()
  await shutdownSandboxPool()
  await releaseTestLock()
})

describe("margin", () => {
  it("a fixed-price project invoiced 44,800 with 19,694 of cost reads 25,106, partial", async () => {
    const out = await run(marginGet, { projectId: portal })
    expect(out.error).toBeUndefined()
    expect(out.invoiced).toBe(44800)
    expect(out.cost).toBe(19694)
    expect(out.margin).toBe(25106)
    expect(out.currency).toBe("EUR")
    expect(out.takenMinutes).toBe(hours(346))
    expect(out.partial).toBe(true)
    expect(out.coverage).toEqual({ withEntries: 41, total: 46 })
    expect(out.marginText).toBe("€25,106.00")
    expect(out.how).toBe(
      "Invoices linked to the project, excluding VAT and net of credit notes, minus each hour taken at the cost rate on that day.",
    )
    expect(out.leftOut).toHaveLength(4)
    expect(out.ratesMissing).toBeUndefined()
  })

  it("the budget's money half reads 64,000 price, 44,800 invoiced and 19,200 left to invoice", async () => {
    const out = await run(budgetGet, { projectId: portal })
    expect(out.error).toBeUndefined()
    expect(out.money).toEqual({
      price: 64000,
      currency: "EUR",
      invoiced: 44800,
      leftToInvoice: 19200,
    })
    expect(out.totals.map((t: { k: string }) => t.k)).toEqual([
      "Real",
      "Price",
      "Invoiced",
      "Left to invoice",
    ])
  })

  it("when invoices cannot be read margin says so and never shows cost alone", async () => {
    const out = await run(
      marginGet,
      { projectId: portal },
      {
        patch: {
          executeTool: async () =>
            JSON.stringify({ status: "error", error: { code: "timeout", message: "slow" } }),
        },
      },
    )
    expect(out.error.code).toBe("invoices_unreadable")
    expect(out.error.message).toStartWith("I cannot read invoices right now")
    expect(JSON.stringify(out)).not.toMatch(/19,?694|cost":|346/)
  })

  it("time with no cost rate costs nothing, is counted, and names no one", async () => {
    const projectId = await newProject("Maison Lune")
    const task = await newTask(projectId, "Audit")
    const stranger = await minimal.session(orgId, { role: "member" })
    await enter(stranger.userId, [
      { projectId, taskId: task, minutes: hours(3), date: "2026-06-01" },
    ])
    const out = await run(marginGet, { projectId })
    expect(out.cost).toBe(0)
    expect(out.ratesMissing.minutes).toBe(hours(3))
    expect(out.ratesMissing.text).toBe(
      "3 h taken have no cost rate on their day, so they cost nothing here.",
    )
    expect(JSON.stringify(out)).not.toContain(stranger.userId)
  })
})

describe("cost rates", () => {
  it("a later rate leaves earlier cost unchanged, tested the day before and on the day", async () => {
    const projectId = await newProject("Maison Orbit")
    const task = await newTask(projectId, "Build")
    const sofia = people[3]!.userId
    await enter(sofia, [
      { projectId, taskId: task, minutes: hours(2), date: "2026-09-30" },
      { projectId, taskId: task, minutes: hours(2), date: "2026-10-01" },
    ])
    const before = await run(marginGet, { projectId })
    expect(before.cost).toBe(220)
    const set = await run(costRateSet, {
      userId: sofia,
      rate: 70,
      from: "2026-10-01",
      currency: "EUR",
    })
    expect(set.from).toBe("2026-10-01")
    expect(set.rate).toBe(70)
    expect(set.message).toContain("Hours before 2026-10-01 keep the rate they had.")
    // The day before: September's hour keeps 55; on the day: October's costs 70.
    expect((await run(marginGet, { projectId, month: "2026-09" })).cost).toBe(110)
    expect((await run(marginGet, { projectId, month: "2026-10" })).cost).toBe(140)
    expect((await run(marginGet, { projectId })).cost).toBe(250)
    const list = await run(costRatesList, {})
    const hers = list.rates.filter((r: { userId: string }) => r.userId === sofia)
    expect(hers.map((r: { rate: number; from: string }) => [r.rate, r.from])).toEqual([
      [55, "2026-01-01"],
      [70, "2026-10-01"],
    ])
  })
})

describe("currencies", () => {
  /** What invoicing answers for a project, as its cross-app call returns it. */
  const invoicedAs = (currency: string, documents: number) => ({
    patch: {
      executeTool: async () =>
        JSON.stringify({
          status: "completed",
          result: {
            invoicedExcl: 50_000,
            paidExcl: 0,
            currency,
            documents: Array.from({ length: documents }, (_, i) => ({ id: `d${i}` })),
            message: "",
          },
        }),
    },
  })

  it("time costed in two currencies makes margin refuse with mixed_currencies", async () => {
    const projectId = await newProject("Maison Duo")
    const task = await newTask(projectId, "Build")
    const [inEuros, inDollars] = [
      await minimal.session(orgId, { role: "member" }),
      await minimal.session(orgId, { role: "member" }),
    ]
    expect(
      (
        await run(costRateSet, {
          userId: inEuros!.userId,
          rate: 50,
          from: "2026-01-01",
          currency: "EUR",
        })
      ).error,
    ).toBeUndefined()
    expect(
      (
        await run(costRateSet, {
          userId: inDollars!.userId,
          rate: 80,
          from: "2026-01-01",
          currency: "usd",
        })
      ).error,
    ).toBeUndefined()
    await enter(inEuros!.userId, [
      { projectId, taskId: task, minutes: hours(2), date: "2026-06-02" },
    ])
    await enter(inDollars!.userId, [
      { projectId, taskId: task, minutes: hours(2), date: "2026-06-02" },
    ])
    const out = await run(marginGet, { projectId })
    expect(out.error.code).toBe("mixed_currencies")
    expect(out.error.message).toContain("EUR and USD")
    expect(JSON.stringify(out)).not.toMatch(/"cost"|"margin"/)
  })

  it("time at a rate with no currency beside a USD rate is refused on a USD-invoiced project", async () => {
    const projectId = await newProject("Mixed labels")
    const task = await newTask(projectId, "Build")
    const [unlabelled, inDollars] = [
      await minimal.session(orgId, { role: "member" }),
      await minimal.session(orgId, { role: "member" }),
    ]
    // A rate written before a currency was required.
    await seedCostRates(
      seedContext({ orgId, now: new Date() }),
      actorOf(owner.userId, ["projects:cost_rates:write"]),
      [
        {
          userId: unlabelled!.userId,
          rateMinor: 5000,
          currency: null,
          effectiveFrom: "2026-01-01",
        },
      ],
    )
    expect(
      (
        await run(costRateSet, {
          userId: inDollars!.userId,
          rate: 80,
          from: "2026-01-01",
          currency: "USD",
        })
      ).error,
    ).toBeUndefined()
    for (const p of [unlabelled!, inDollars!])
      await enter(p.userId, [{ projectId, taskId: task, minutes: hours(2), date: "2026-06-02" }])
    const out = await run(marginGet, { projectId }, invoicedAs("USD", 1))
    expect(out.error.code).toBe("mixed_currencies")
    expect(out.error.message).toContain("no currency")
    expect(JSON.stringify(out)).not.toMatch(/"cost"|"margin"/)
  })

  it("a new rate needs its currency, and a rate already set on that day keeps its own", async () => {
    const someone = await minimal.session(orgId, { role: "member" })
    const missing = await run(costRateSet, { userId: someone.userId, rate: 60, from: "2026-03-01" })
    expect(missing.error.code).toBe("currency_required")
    expect(missing.error.details.next).toContain("currency")
    const list = await run(costRatesList, {})
    expect(list.rates.some((r: { userId: string }) => r.userId === someone.userId)).toBe(false)
    await run(costRateSet, {
      userId: someone.userId,
      rate: 60,
      from: "2026-03-01",
      currency: "GBP",
    })
    const again = await run(costRateSet, { userId: someone.userId, rate: 65, from: "2026-03-01" })
    expect(again.error).toBeUndefined()
    expect(again.currency).toBe("GBP")
  })

  it("stored currencies are trimmed and upper-cased, and one that is not ISO 4217 is cleared", async () => {
    const odd = await newProject("Odd price")
    const spaced = await newProject("Spaced price")
    await call("projects_billingTermsSet", { projectId: odd, fixedPrice: 1000, currency: "EUR" })
    await call("projects_billingTermsSet", { projectId: spaced, fixedPrice: 1000, currency: "EUR" })
    const someone = await minimal.session(orgId, { role: "member" })
    await run(costRateSet, {
      userId: someone.userId,
      rate: 60,
      from: "2026-02-01",
      currency: "USD",
    })
    await db.execute(drizzleSql`
      UPDATE app_projects.project_billing_terms
         SET currency = CASE project_id WHEN ${odd}::uuid THEN ' eu' ELSE 'usd' END
       WHERE project_id IN (${odd}::uuid, ${spaced}::uuid)`)
    await db.execute(drizzleSql`
      UPDATE app_projects.cost_rates SET currency = ' US'
       WHERE org_id = ${orgId}::uuid AND user_id = ${someone.userId}::uuid`)
    // The forward migration's own statements, run again over these rows.
    const file = readFileSync(
      join(REPO_ROOT, "apps/api/src/db/migrations/0327_projects_currency_labels.sql"),
      "utf8",
    )
    const updates = file
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.startsWith("UPDATE"))
    expect(updates).toHaveLength(6)
    for (const u of updates) await db.execute(drizzleSql.raw(u))
    const terms = extractRows<{ project_id: string; currency: string | null }>(
      await db.execute(drizzleSql`
        SELECT project_id::text AS project_id, currency FROM app_projects.project_billing_terms
         WHERE project_id IN (${odd}::uuid, ${spaced}::uuid)`),
    )
    expect(Object.fromEntries(terms.map((t) => [t.project_id, t.currency]))).toEqual({
      [odd]: null,
      [spaced]: "USD",
    })
    const rate = extractRows<{ currency: string | null }>(
      await db.execute(drizzleSql`
        SELECT currency FROM app_projects.cost_rates
         WHERE org_id = ${orgId}::uuid AND user_id = ${someone.userId}::uuid`),
    )
    expect(rate.map((r) => r.currency)).toEqual([null])
    // A price left with no currency asks for it again rather than subtracting.
    const out = await run(budgetGet, { projectId: odd }, invoicedAs("EUR", 2))
    expect(out.money.leftToInvoice).toBeUndefined()
    expect(out.money.invoicedUnavailable.code).toBe("currency_missing")
    expect(out.money.invoicedUnavailable.next).toContain("billing_terms_set")
  })

  it("an invoicing refusal that retrying cannot help is passed on as it is", async () => {
    const refusal = {
      patch: {
        executeTool: async () =>
          JSON.stringify({
            status: "completed",
            result: {
              error: {
                code: "too_many_documents",
                message: "Too many documents to sum. Nothing was read.",
                retryable: false,
              },
            },
          }),
      },
    }
    const margin = await run(marginGet, { projectId: portal }, refusal)
    expect(margin.error.code).toBe("too_many_documents")
    expect(margin.error.retryable).toBe(false)
    const budget = await run(budgetGet, { projectId: portal }, refusal)
    expect(budget.money.invoicedUnavailable.code).toBe("too_many_documents")
  })

  it("a rate's currency must be an ISO 4217 code", async () => {
    const out = await run(costRateSet, {
      userId: people[0]!.userId,
      rate: 60,
      from: "2026-12-01",
      currency: "e",
    })
    expect(out.error.code).toBe("invalid_currency")
  })

  it("a price in one currency and invoices in another leave left to invoice out", async () => {
    const projectId = await newProject("Maison Sterling")
    await call("projects_billingTermsSet", { projectId, fixedPrice: 1000, currency: "GBP" })
    const out = await run(budgetGet, { projectId }, invoicedAs("EUR", 2))
    expect(out.money.price).toBe(1000)
    expect(out.money.leftToInvoice).toBeUndefined()
    expect(out.money.invoicedUnavailable.code).toBe("mixed_currencies")
    expect(out.totals.map((t: { k: string }) => t.k)).not.toContain("Left to invoice")
  })

  it("a priced project with no linked invoice says so instead of showing nothing invoiced", async () => {
    const projectId = await newProject("Maison Neuve")
    await call("projects_billingTermsSet", { projectId, fixedPrice: 2000, currency: "EUR" })
    const out = await run(budgetGet, { projectId })
    expect(out.money.invoiced).toBeUndefined()
    expect(out.money.leftToInvoice).toBeUndefined()
    expect(out.money.invoicedUnavailable).toStartWith("No issued invoice is linked to this project")
  })
})

describe("who reads margin and cost", () => {
  it("margin needs its scope and is absent otherwise", async () => {
    const tools = (projectsAppManifest as { tools: Record<string, { requiredScopes: string[] }> })
      .tools
    expect(tools.margin_get?.requiredScopes).toEqual(["projects:margin:read"])
    expect(tools.cost_rates_list?.requiredScopes).toEqual(["projects:margin:read"])
    expect(tools.cost_rate_set?.requiredScopes).toEqual([
      "projects:cost_rates:write",
      "projects:margin:read",
    ])
    // The member and lead roles do not hold it, so the tools are not in their catalog.
    const roles = (projectsAppManifest as { roles: Record<string, { scopes: string[] }> }).roles
    for (const role of ["member", "lead"]) {
      expect(roles[role]?.scopes ?? []).not.toContain("projects:margin:read")
    }
    // A caller without the exact scope, an admin's wildcard included, reads nothing.
    for (const scopes of [[READ, "projects:money:read"], ["*"]]) {
      const out = await run(marginGet, { projectId: portal }, { scopes })
      expect(out.error.code).toBe("finance_only")
      expect(JSON.stringify(out)).not.toMatch(/25,?106|19,?694|44,?800/)
      const rates = await run(costRatesList, {}, { scopes })
      expect(rates.error.code).toBe("finance_only")
    }
  })

  it("margin has no person parameter or breakdown", async () => {
    const tools = (
      projectsAppManifest as {
        tools: Record<string, { params: { properties: Record<string, unknown> } }>
      }
    ).tools
    expect(Object.keys(tools.margin_get?.params.properties ?? {}).sort()).toEqual([
      "month",
      "projectId",
      "projectName",
    ])
    const out = await run(marginGet, { projectId: portal })
    const text = JSON.stringify(out)
    for (const p of people) expect(text).not.toContain(p.userId)
    expect(text).not.toMatch(/userId|"user"|person/i)
    // The cost function answers one number for the project.
    const fn = extractRows<{ rettype: string; retset: boolean }>(
      await db.execute(drizzleSql`
        SELECT format_type(prorettype, NULL) AS rettype, proretset AS retset
          FROM pg_proc WHERE oid = 'app_projects.project_time_cost(uuid, date, date)'::regprocedure`),
    )[0]
    expect(fn).toEqual({ rettype: "bigint", retset: false })
  })

  it("margin and cost rates stay off dashboards", () => {
    for (const name of ["margin_get", "cost_rates_list"]) {
      const tool = toolRegistry.get([orgId, "projects", name])
      expect(tool).toBeTruthy()
      expect(dashboardSourceRefusal(tool!)).toBe("it runs only in a DM with the agent")
    }
  })
})
