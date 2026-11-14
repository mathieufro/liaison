// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A company page's parts follow the reader's access. The apps' own manifests
// put Money (invoicing), Support (tickets) and Work (projects) on the kernel's
// `company_detail` slot; the slot list a reader gets holds only what their
// scopes read. On a company tab and in its discussion, the agent gets the
// company's open deals from projects' context provider, with amounts only for
// a reader with deal access.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { sql } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { type UserContext, withRlsContext } from "~/db/rls"
import { estimateTokens } from "~/modules/agent/context/compaction"
import {
  CONTEXT_PROVIDER_MAX_BYTES,
  loadContextProviderBlocks,
} from "~/modules/agent/context/context-providers"
import * as executeTool from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import type { Scope } from "~/modules/permissions/types"
import { registerAppSlots } from "~/modules/slots/registry"
import { slotsRoutes } from "~/modules/slots/routes"
import { insertSql } from "~/seed/factories/org/test-rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import invoicingManifest from "../../../../../bundled-apps/invoicing/app.manifest.json"
import {
  type DealWorld,
  makeDealWorld,
  makePipeline,
  makeTask,
} from "../../apps/projects/service/__tests__/deal-world"

const DEALS_READ = [
  "projects:projects:read",
  "projects:tasks:read",
  "kernel:companies:read",
  "kernel:contacts:read",
]
const DEAL_ACCESS = [...DEALS_READ, "projects:deals:read"]
const FENCE = /<external-content source="untrusted">\n([\s\S]*?)\n<\/external-content>/

let w: DealWorld
let lumen = ""
let quiet = ""

async function company(name: string): Promise<string> {
  const id = crypto.randomUUID()
  await sql.unsafe(
    insertSql("kernel.companies", {
      id,
      org_id: w.orgId,
      handle: `@part-${name.toLowerCase()}-${id.slice(0, 6)}`,
      name,
      created_by: w.userId,
      org_access: "editor",
    }),
  )
  return id
}

async function deal(projectId: string, statusId: string, companyId: string, amountMinor: number) {
  const taskId = await makeTask(w, projectId, `Deal ${amountMinor}`, { statusId })
  await db.execute(drizzleSql`
    UPDATE app_projects.deals SET company_id = ${companyId}::uuid WHERE task_id = ${taskId}::uuid`)
  await db.execute(drizzleSql`
    UPDATE app_projects.deal_values SET amount_minor = ${amountMinor}, currency = 'EUR'
     WHERE task_id = ${taskId}::uuid`)
  return taskId
}

function reader(scopes: string[]): UserContext {
  return { ...w.actor, scopes }
}

function slotsAs(scopes: string[]) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("orgId", w.orgId)
    c.set("userId", w.userId)
    c.set("scopes", scopes as Scope[])
    await next()
  })
  app.route("/api/v1/slots", slotsRoutes)
  return app
}

async function companyPanels(scopes: string[]): Promise<Array<{ app: string; group?: string }>> {
  const res = await slotsAs(scopes).request("/api/v1/slots/company_detail")
  expect(res.status).toBe(200)
  const body = (await res.json()) as { data: { panels: Array<{ app: string; group?: string }> } }
  return body.data.panels
}

const providerLines = (scopes: string[], over: Record<string, unknown>) =>
  loadContextProviderBlocks({ orgId: w.orgId, actor: reader(scopes), grants: scopes, ...over })

async function contact(companyId: string, name: string): Promise<string> {
  const id = crypto.randomUUID()
  await sql.unsafe(
    insertSql("kernel.contacts", {
      id,
      org_id: w.orgId,
      handle: `@part-p-${id.slice(0, 8)}`,
      name,
      email: `${id.slice(0, 8)}@client.example`,
      company_id: companyId,
      created_by: w.userId,
      org_access: "editor",
    }),
  )
  return id
}

async function ticket(contactId: string, status: string, subject: string): Promise<string> {
  const id = crypto.randomUUID()
  await sql.unsafe(
    insertSql("app_tickets.tickets", {
      id,
      org_id: w.orgId,
      handle: `T-${id.slice(0, 6)}`,
      subject,
      channel: "email",
      reply_token: `rt-${id}`,
      sla_target_seconds: 86400,
      status,
      contact_id: contactId,
    }),
  )
  return id
}

async function call(tool: string, scopes: string[], params: Record<string, unknown>) {
  const envelope = await executeTool.executeToolCore({
    toolName: tool,
    orgId: w.orgId,
    actor: reader(scopes),
    params,
    origin: "in-app-agent",
  })
  if (!("data" in envelope)) throw new Error(`${tool}: ${JSON.stringify(envelope)}`)
  return envelope.data as Record<string, unknown>
}

const body = (block: string | undefined): string => FENCE.exec(block ?? "")?.[1] ?? ""

beforeAll(async () => {
  await acquireTestLock()
  w = await makeDealWorld("company-parts")
  await ensureAppsForOrg(w.orgId)
  // Invoicing ships as a catalog package: its manifest's slots go through the same registry.
  registerAppSlots(
    w.orgId,
    "invoicing",
    invoicingManifest.slots as Record<string, unknown>,
    undefined,
  )
  lumen = await company("Lumen")
  quiet = await company("Quiet")
  const p = await makePipeline(w, "Sales")
  await deal(p.projectId, p.stage.Proposal as string, lumen, 1_200_000)
  await deal(p.projectId, p.stage.Proposal as string, lumen, 300_000)
  await deal(p.projectId, p.stage.Demo as string, lumen, 50_000)
}, 180_000)

afterAll(releaseTestLock)

describe("a company page's parts by the reader's access", () => {
  it("the company's panel list follows the reader's scopes", async () => {
    const all = await companyPanels([
      ...DEAL_ACCESS,
      "tickets:tickets:read",
      "invoicing:documents:read",
    ])
    expect(all.map((p) => [p.app, p.group])).toEqual([
      ["invoicing", "money"],
      ["tickets", "support"],
      ["projects", "work"],
    ])
    const noMoney = await companyPanels([...DEALS_READ, "tickets:tickets:read"])
    expect(noMoney.map((p) => p.group)).toEqual(["support", "work"])
    expect(JSON.stringify(noMoney)).not.toContain("invoicing")
    expect(await companyPanels(["kernel:companies:read"])).toEqual([])
  })

  it("on a company tab and in its discussion the agent gets the open deals lines; without deal access no amount", async () => {
    const onTab = await providerLines(DEAL_ACCESS, {
      currentView: { tabType: "contacts:company-detail", entityId: lumen },
    })
    const inDiscussion = await providerLines(DEAL_ACCESS, {
      createdFrom: { app: "kernel", entityType: "company", entityId: lumen },
    })
    for (const blocks of [onTab, inDiscussion]) {
      expect(body(blocks?.block).split("\n")).toEqual([
        "3 open deals.",
        expect.stringMatching(/^Proposal: \S+-\d+, \S+-\d+, EUR 15000$/),
        expect.stringMatching(/^Demo: \S+-\d+, EUR 500$/),
      ])
      expect(blocks?.scopes).toContain("projects:projects:read")
    }
    const blind = await providerLines(DEALS_READ, {
      currentView: { tabType: "contacts:company-detail", entityId: lumen },
    })
    const text = body(blind?.block)
    expect(text.split("\n")[0]).toBe("3 open deals, amounts need deal access.")
    expect(text).not.toContain("EUR")
    // A company with no open deal adds nothing to the turn.
    expect(
      await providerLines(DEAL_ACCESS, {
        currentView: { tabType: "contacts:company-detail", entityId: quiet },
      }),
    ).toBeNull()
  })

  it("the provider's lines stay within six lines and about 80 tokens with deals in many stages", async () => {
    const p = await makePipeline(w, "Wide")
    const wide = await company("Wide")
    for (const stage of Object.values(p.stage)) {
      for (const n of [1, 2, 3, 4]) await deal(p.projectId, stage, wide, n * 123_456_789)
    }
    const blocks = await providerLines(DEAL_ACCESS, {
      currentView: { tabType: "contacts:company-detail", entityId: wide },
    })
    const text = body(blocks?.block)
    const lines = text.split("\n")
    expect(lines.length).toBeLessThanOrEqual(6)
    expect(estimateTokens(text)).toBeLessThanOrEqual(80)
    expect(new TextEncoder().encode(text).byteLength).toBeLessThan(CONTEXT_PROVIDER_MAX_BYTES)
    console.info(
      `company_context worst case: ${lines.length} lines, ${estimateTokens(text)} tokens`,
    )
  })

  it("the Support and Work sections read only this company's open tickets, and its projects with their open tasks, deals left out", async () => {
    const ana = await contact(lumen, "Ana Buyer")
    const elsewhere = await contact(quiet, "Quiet Buyer")
    const open = await ticket(ana, "open", "Lamp flickers")
    await ticket(ana, "closed", "Old question")
    await ticket(elsewhere, "open", "Not this company")
    const support = await call("tickets:company_tickets", [...DEALS_READ, "tickets:tickets:read"], {
      companyId: lumen,
    })
    expect((support.items as Array<{ id: string }>).map((t) => t.id)).toEqual([open])
    expect(support.message).toBe("1 open ticket from this company's people.")

    const project = await withRlsContext(w.actor, async (tx) => {
      const { createProject } = await import("~/apps/projects/service/create-project")
      return createProject({ tx, orgId: w.orgId, actor: w.actor, input: { name: "Lumen rollout" } })
    })
    // The project's Client field (its own route) sets this column.
    await db.execute(drizzleSql`
      UPDATE app_projects.projects SET company_id = ${lumen}::uuid WHERE id = ${project.id}::uuid`)
    await withRlsContext(w.actor, async (tx) => {
      const { createProject } = await import("~/apps/projects/service/create-project")
      return createProject({ tx, orgId: w.orgId, actor: w.actor, input: { name: "Unrelated" } })
    })
    const openTask = await makeTask(w, project.id, "Install the lamps")
    const done = project.statuses.find((s) => s.terminal)?.id as string
    await makeTask(w, project.id, "Kick-off call", { statusId: done })
    // A pipeline whose Client field names the company is still deals, not work.
    const sales = await makePipeline(w, "Lumen sales")
    await db.execute(drizzleSql`
      UPDATE app_projects.projects SET company_id = ${lumen}::uuid WHERE id = ${sales.projectId}::uuid`)
    await deal(sales.projectId, sales.stage.Proposal as string, lumen, 90_000)
    const work = await call("projects:company_work", DEAL_ACCESS, { companyId: lumen })
    const projects = work.projects as Array<{ id: string; tasks: Array<{ id: string }> }>
    expect(projects.map((p) => p.id)).toEqual([project.id])
    expect(projects[0]?.tasks.map((t) => t.id)).toEqual([openTask])
    expect(work.deals).toBeUndefined()
    expect(work.message).toBe("1 project with 1 open task for this company.")
  })

  it("a provider's failure leaves the page's other panels", async () => {
    const real = executeTool.executeToolCore
    const spy = spyOn(executeTool, "executeToolCore").mockImplementation((opts) =>
      opts.toolName === "projects:company_context"
        ? Promise.reject(new Error("provider down"))
        : real(opts),
    )
    try {
      const blocks = await providerLines(DEAL_ACCESS, {
        currentView: { tabType: "contacts:company-detail", entityId: lumen },
      })
      expect(blocks).toBeNull()
      const panels = await companyPanels([
        ...DEAL_ACCESS,
        "tickets:tickets:read",
        "invoicing:documents:read",
      ])
      expect(panels.map((p) => p.group)).toEqual(["money", "support", "work"])
    } finally {
      spy.mockRestore()
    }
    // The page itself still reads.
    const seen = await withRlsContext(reader(DEAL_ACCESS), (tx) =>
      tx.execute(drizzleSql`SELECT id FROM kernel.companies WHERE id = ${lumen}::uuid`),
    )
    expect(seen).toBeTruthy()
  })
})
