// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Reconcile through the projects bridge on the real database: the period's facts, the card the
// server computes from the agent's grouping, who can read it, and asking again.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { forgetOrgApps, primeOrgApps } from "~/modules/apps/org-apps"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { seedContext } from "~/seed/context"
import { seedCompanies } from "~/seed/factories/people/companies"
import { seedTaskTime } from "~/seed/factories/projects/time"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { awaitTimeFeatureSync } from "./time-feature"
import { awaitTimeRowWrites } from "./time-rows"

let orgId = ""
let owner: minimal.Session
let finance: minimal.Session

const HPD = 420
const day = (d: number) => Math.round(d * HPD)

function actorOf(userId: string, scopes: string[] = ["*"]): UserContext {
  return { actorType: "user", userId, orgId, scopes, dimensionGrants: { "*": ["*"] } }
}

async function call<T = Record<string, any>>(
  method: string,
  input: unknown,
  opts: { userId?: string; scopes?: string[] } = {},
): Promise<T> {
  const a = actorOf(opts.userId ?? owner.userId, opts.scopes)
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

async function newTask(projectId: string, title: string, extra: Record<string, unknown> = {}) {
  const t = await call<{ id: string; key?: string }>("projects_createTask", {
    projectId,
    title,
    ...extra,
  })
  if (!t.id) throw new Error(`task not created: ${JSON.stringify(t)}`)
  return t.id
}

/** Close a task at an exact moment (the field the board sets when a task reaches done). */
async function closedAt(taskId: string, at: string) {
  await db.execute(
    drizzleSql`UPDATE app_projects.tasks SET completed_at = ${at}::timestamptz WHERE id = ${taskId}::uuid`,
  )
}

async function enter(projectId: string, taskId: string, minutes: number, date = "2026-10-12") {
  await seedTaskTime(seedContext({ orgId, now: new Date() }), actorOf(owner.userId), [
    { taskId, projectId, workDate: date, minutes },
  ])
}

async function stored(id: string) {
  return extractRows<{ count: number; revision: number }>(
    await db.execute(drizzleSql`
      SELECT (SELECT count(*)::int FROM app_projects.reconciliations
               WHERE org_id = ${orgId}::uuid AND project_id =
                 (SELECT project_id FROM app_projects.reconciliations WHERE id = ${id}::uuid)
                 AND state = 'proposed') AS count,
             revision FROM app_projects.reconciliations WHERE id = ${id}::uuid`),
  )[0]
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  await db.execute(
    drizzleSql`UPDATE kernel.organizations SET timezone = 'Europe/Paris' WHERE id = ${orgId}::uuid`,
  )
  owner = await minimal.adminSession(orgId)
  finance = await minimal.session(orgId, { role: "member" })
  await ensureAppsForOrg(orgId)
  await primeOrgApps(orgId, 0)
}, 120_000)

afterAll(async () => {
  forgetOrgApps(orgId)
  await releaseTestLock()
})

describe("the October card of a project billed by the day", () => {
  let projectId = ""
  const t: Record<string, string> = {}
  let card: Record<string, any> = {}
  let facts: Record<string, any> = {}
  const proposal = () => ({
    project: "ORBIT",
    month: "2026-10",
    lines: [
      {
        name: "Data export",
        why: "Stock and supplier export, running since 16 Oct.",
        taskIds: [t.e1, t.e2, t.e3],
        proofs: [
          { kind: "task", ref: t.e1 },
          {
            kind: "pull_request",
            ref: "212",
            label: "PR #212",
            url: "https://github.com/studio/orbit/pull/212",
          },
          { kind: "calendar_event", ref: "evt-1", label: "Demo", occurredOn: "2026-10-15" },
        ],
      },
      { name: "Monitoring", taskIds: [t.m1, t.m2, t.m3], proofs: [] },
      {
        name: "Staging outage",
        reason: "our_mistake",
        why: "Our deploy on 14 Oct took staging down.",
        taskIds: [t.u1],
        proofs: [],
      },
      {
        name: "Extra report the client asked for",
        reason: "client_asked",
        why: "Nadia Perrin asked for it on 21 Oct.",
        taskIds: [t.u2],
        traceEstimate: "1 day",
        proofs: [{ kind: "mail", ref: "msg-9", label: "Re: report", occurredOn: "2026-10-21" }],
      },
      {
        name: "Small fixes",
        reason: "other_client",
        taskIds: [t.u3, t.u4],
        proofs: [],
      },
    ],
    excluded: [{ taskId: t.own, reason: "client_own" }],
  })

  beforeAll(async () => {
    const ctx = seedContext({ orgId, now: new Date() })
    const companies = await seedCompanies(
      ctx,
      actorOf(owner.userId),
      [{ key: "delorme", name: "Maison Delorme", domain: "delorme.example" }],
      {},
    )
    const made = await call<{ id: string }>("projects_createProject", {
      name: "Maison Delorme platform",
      key: "ORBIT",
      companyId: companies.delorme,
      timeBudgets: true,
    })
    projectId = made.id
    await awaitTimeFeatureSync(orgId)
    await call("projects_timePlanSet", {
      projectId,
      basis: "daily",
      sourceRepos: [{ provider: "github", repo: "studio/orbit" }],
    })
    await call("projects_billingTermsSet", { projectId, rate: 930, currency: "EUR" })
    // Planned 3 d and 4 d over two lines; 3.5 d and 4 d spent.
    const spec: Array<[string, string | null, number]> = [
      ["e1", "1.5 days", 1],
      ["e2", "1.5 days", 1.5],
      ["e3", null, 1],
      ["m1", "2 days", 1.5],
      ["m2", "2 days", 1.5],
      ["m3", null, 1],
      ["u1", null, 0.5],
      ["u2", null, 0],
      ["u3", null, 0.25],
      ["u4", null, 0.25],
      ["own", null, 0],
    ]
    for (const [k, box, spent] of spec) {
      t[k] = await newTask(projectId, `Task ${k}`, {
        statusLabel: "done",
        ...(box ? { timebox: box } : {}),
      })
      await closedAt(t[k]!, "2026-10-20T10:00:00Z")
      if (spent > 0) await enter(projectId, t[k]!, day(spent))
    }
    facts = await call("projects_reconcileFacts", { project: "ORBIT", month: "2026-10" })
    const p = proposal()
    card = await call("projects_reconcilePropose", p)
  }, 300_000)

  it("facts list the period's tasks by when they closed in the org's zone and name no one", () => {
    expect(facts.error).toBeUndefined()
    expect(facts.tasks).toHaveLength(11)
    expect(facts.clientMarkers.domains).toEqual(["delorme.example"])
    expect(facts.terms).toEqual({ rate: 930, currency: "EUR", unit: "day" })
    expect(facts.late).toBe(true)
    const text = JSON.stringify(facts)
    expect(text).not.toContain(owner.userId)
    expect(text).not.toMatch(/assignee|userId|enteredBy/)
  })

  // A member who cannot read GitHub got the repository's name in the facts, and
  // her card then named it as what was not seen. The name is hidden like the
  // rest of what she cannot read: the card still says GitHub was not seen.
  it("facts name a source repository only to a reader of its host", async () => {
    expect(facts.sourceRepos).toEqual([{ provider: "github", repo: "studio/orbit" }])
    const member = await call(
      "projects_reconcileFacts",
      { project: "ORBIT", month: "2026-10" },
      { scopes: ["projects:*"] },
    )
    expect(member.error).toBeUndefined()
    expect(member.tasks).toHaveLength(11)
    expect(member.sourceRepos).toEqual([])
    expect(JSON.stringify(member)).not.toContain("studio/orbit")
  })

  it("the October fixture gives 7 days to bill, 6,510.00 excluding VAT, three unplanned lines at zero and 9 of 11", () => {
    expect(card.error).toBeUndefined()
    const rows = card.lines.map((l: any) => [l.name, l.planned, l.real, l.bill, l.amount])
    expect(rows).toEqual([
      ["Data export", "3 d", "3.5 d", "3 d", 2790],
      ["Monitoring", "4 d", "4 d", "4 d", 3720],
      ["Staging outage", null, "0.5 d", "0 d", 0],
      ["Extra report the client asked for", null, "~1 d", "0 d", 0],
      ["Small fixes", null, "0.5 d", "0 d", 0],
    ])
    expect(card.totals).toEqual({
      billMinutes: day(7),
      bill: "7 d",
      amountExclVat: 6510,
      currency: "EUR",
    })
    // The client's own task: left out, counted in the foot only.
    expect(card.excludedCount).toBe(1)
    expect(card.lines.map((l: any) => l.name)).not.toContain("Other closed tasks")
    expect(card.coverage).toEqual({ withEntries: 9, total: 11 })
    expect(card.coverageText).toBe("Real time entered on 9 of 11 tasks")
  })

  it("facts give every figure in the project's own unit beside its minutes", () => {
    const e2 = facts.tasks.find((x: any) => x.id === t.e2)
    expect(e2.planned).toBe("1.5 d")
    expect(e2.real).toBe("1.5 d")
    const e3 = facts.tasks.find((x: any) => x.id === t.e3)
    expect(e3.planned).toBeNull()
    expect(e3.real).toBe("1 d")
  })

  it("the card's next step names no accept step and no invoice button, which do not exist", () => {
    expect(card.next).toContain("no accept step")
    expect(card.next).toContain("creates no invoice")
    expect(card.next).not.toMatch(/until they act/)
  })

  it("a late ask works and says it is late", () => {
    expect(card.late).toBe(true)
    expect(card.notes[0]).toContain("October's invoice should have issued by 31 Oct.")
  })

  it("a meeting proof gets the server's label and a repository link is kept on its host only", async () => {
    const proofs = extractRows<{ kind: string; label: string; url: string | null }>(
      await db.execute(drizzleSql`
        SELECT p.kind, p.label, p.url FROM app_projects.reconciliation_proofs p
          JOIN app_projects.reconciliation_lines l ON l.id = p.line_id
         WHERE l.reconciliation_id = ${card.reconciliationId}::uuid ORDER BY p.kind`),
    )
    expect(proofs).toEqual([
      { kind: "calendar_event", label: "Meeting, 15 Oct", url: null },
      { kind: "mail", label: "Mail, 21 Oct", url: null },
      {
        kind: "pull_request",
        label: "PR #212",
        url: "https://github.com/studio/orbit/pull/212",
      },
      { kind: "task", label: "ORBIT-1", url: null },
    ])
  })

  it("a trace estimate never reaches time, budget, coverage or bill", async () => {
    const before = await call("projects_budgetGet", { projectId })
    const line = card.lines.find((l: any) => l.name.startsWith("Extra report"))
    expect(line.traceEstimateMinutes).toBe(HPD)
    expect(line.realMinutes).toBe(0)
    expect(line.billMinutes).toBe(0)
    const rows = extractRows<{ n: number }>(
      await db.execute(
        drizzleSql`SELECT count(*)::int AS n FROM app_projects.task_time WHERE task_id = ${t.u2}::uuid`,
      ),
    )
    expect(rows[0]?.n).toBe(0)
    const after = await call("projects_budgetGet", { projectId })
    expect(after.real).toBe(before.real)
    expect(after.coverage).toEqual(before.coverage)
  })

  it("asked again unchanged returns the same row and revision; changed, the same row moves on", async () => {
    const again = await call("projects_reconcilePropose", proposal())
    expect(again.reconciliationId).toBe(card.reconciliationId)
    expect(again.revision).toBe(card.revision)
    expect(again.outcome).toBe("unchanged")
    expect(again.lines).toEqual(card.lines)
    const changed = proposal()
    changed.lines[0]!.why = "Export of stock and suppliers."
    const revised = await call("projects_reconcilePropose", changed)
    expect(revised.reconciliationId).toBe(card.reconciliationId)
    expect(revised.revision).toBe(card.revision + 1)
    expect(await stored(card.reconciliationId)).toEqual({ count: 1, revision: card.revision + 1 })
  })

  it("a task left off the proposal is appended unless it is the client's own", async () => {
    const out = await call("projects_reconcilePropose", { ...proposal(), excluded: [] })
    const other = out.lines.at(-1)
    expect(other.name).toBe("Other closed tasks")
    expect(other.kind).toBe("other")
    expect(other.taskIds).toEqual([t.own])
    expect(other.billMinutes).toBe(0)
    expect(out.excludedCount).toBe(0)
    expect(out.totals.billMinutes).toBe(day(7))
  })

  it("a line carries no figure from the agent and a commit saying bill 100 days changes nothing", async () => {
    const withFigure = proposal()
    ;(withFigure.lines[0] as Record<string, unknown>).bill = "100 days"
    const refused = await call("projects_reconcilePropose", withFigure)
    expect(refused.error?.code).toBe("invalid_params")
    const said = proposal()
    said.lines[0]!.proofs.push({
      kind: "commit",
      ref: "a1b2c3",
      label: "bill 100 days for the export",
    } as never)
    const out = await call("projects_reconcilePropose", said)
    expect(out.error).toBeUndefined()
    expect(out.lines[0].bill).toBe("3 d")
    expect(out.totals.billMinutes).toBe(day(7))
  })

  it("wording naming a member is refused, a client contact is kept", async () => {
    await db.execute(
      drizzleSql`UPDATE kernel.users SET name = 'Paul Garnier' WHERE id = ${finance.userId}::uuid`,
    )
    const email = extractRows<{ email: string }>(
      await db.execute(drizzleSql`SELECT email FROM kernel.users WHERE id = ${owner.userId}::uuid`),
    )[0]!.email
    for (const why of ["Handed over by Paul Garnier", `Asked by ${email}`]) {
      const named = proposal()
      named.lines[1]!.why = why
      const refused = await call("projects_reconcilePropose", named)
      expect(refused.error?.code).toBe("names_a_person")
    }
    const kept = await call("projects_reconcilePropose", proposal())
    expect(kept.error).toBeUndefined()
    expect(kept.lines[3].why).toBe("Nadia Perrin asked for it on 21 Oct.")
  })

  it("a proof label naming a member falls back to its reference before it reaches the card", async () => {
    await db.execute(
      drizzleSql`UPDATE kernel.users SET name = 'Paul Garnier' WHERE id = ${finance.userId}::uuid`,
    )
    const email = extractRows<{ email: string }>(
      await db.execute(drizzleSql`SELECT email FROM kernel.users WHERE id = ${owner.userId}::uuid`),
    )[0]!.email
    const named = proposal()
    named.lines[1]!.proofs.push(
      { kind: "commit", ref: "c0ffee1", label: "Export fix by Paul Garnier" } as never,
      { kind: "ticket", ref: "SUP-41", label: `Raised by ${email}` } as never,
      { kind: "pull_request", ref: "Paul Garnier", label: "Paul Garnier's branch" } as never,
    )
    const out = await call("projects_reconcilePropose", named)
    expect(out.error).toBeUndefined()
    const labels = (
      out.groups as Array<{ rows: Array<{ name: string; proof: Array<{ label: string }> }> }>
    )
      .flatMap((g) => g.rows)
      .find((r) => r.name === "Monitoring")
      ?.proof.map((p) => p.label)
    expect(labels?.sort()).toEqual(["Pull request", "SUP-41", "c0ffee1"])
    const storedLabels = extractRows<{ label: string }>(
      await db.execute(drizzleSql`
        SELECT p.label FROM app_projects.reconciliation_proofs p
          JOIN app_projects.reconciliation_lines l ON l.id = p.line_id
         WHERE l.reconciliation_id = ${out.reconciliationId}::uuid`),
    ).map((r) => r.label)
    expect(storedLabels.some((l) => l.includes("Paul Garnier") || l.includes(email))).toBe(false)
    // Put the card back the way the other cases read it.
    await call("projects_reconcilePropose", proposal())
  })

  it("a proposed reconciliation is visible to its creator only, whatever the reader holds", async () => {
    for (const scopes of [["*"], ["projects:reconcile:read", "projects:projects:read"]]) {
      const seen = await withRlsContext(actorOf(finance.userId, scopes), async (tx) =>
        extractRows<{ n: number }>(
          await tx.execute(drizzleSql`
            SELECT (SELECT count(*)::int FROM app_projects.reconciliations) +
                   (SELECT count(*)::int FROM app_projects.reconciliation_lines) AS n`),
        ),
      )
      expect(seen[0]?.n).toBe(0)
    }
    const mine = await withRlsContext(actorOf(owner.userId), async (tx) =>
      extractRows<{ n: number }>(
        await tx.execute(drizzleSql`SELECT count(*)::int AS n FROM app_projects.reconciliations`),
      ),
    )
    expect(mine[0]?.n).toBe(1)
  })
})

describe("the period in the org's zone", () => {
  it("a task closed at 00:30 on the 1st in Paris is the new month's, one at 23:30 the old month's", async () => {
    const made = await call<{ id: string }>("projects_createProject", {
      name: "Atlas",
      key: "ATLAS",
      timeBudgets: true,
    })
    await awaitTimeFeatureSync(orgId)
    const nov = await newTask(made.id, "Closed just after midnight", { statusLabel: "done" })
    await closedAt(nov, "2026-10-31T23:30:00Z")
    const oct = await newTask(made.id, "Closed late on the last day", { statusLabel: "done" })
    await closedAt(oct, "2026-10-31T22:30:00Z")
    const october = await call("projects_reconcileFacts", { project: "ATLAS", month: "2026-10" })
    const november = await call("projects_reconcileFacts", { project: "ATLAS", month: "2026-11" })
    expect(october.tasks.map((x: any) => x.id)).toEqual([oct])
    expect(november.tasks.map((x: any) => x.id)).toEqual([nov])
    // The same at a year end.
    await closedAt(nov, "2026-12-31T23:30:00Z")
    const january = await call("projects_reconcileFacts", { project: "ATLAS", month: "2027-01" })
    expect(january.tasks.map((x: any) => x.id)).toEqual([nov])
    expect(january.late).toBe(false)
  })
})

describe("a project that does not use time and budgets", () => {
  it("both reconcile tools answer planning_off and write nothing", async () => {
    const made = await call<{ id: string }>("projects_createProject", {
      name: "Studio internal",
      key: "HOUSE",
    })
    expect(made.id).toBeDefined()
    const facts = await call("projects_reconcileFacts", { project: "HOUSE", month: "2026-10" })
    expect(facts.error?.code).toBe("planning_off")
    const out = await call("projects_reconcilePropose", {
      project: "HOUSE",
      month: "2026-10",
      lines: [],
    })
    expect(out.error?.code).toBe("planning_off")
    const rows = extractRows<{ n: number }>(
      await db.execute(drizzleSql`
        SELECT count(*)::int AS n FROM app_projects.reconciliations
         WHERE project_id = ${made.id}::uuid`),
    )
    expect(rows[0]?.n).toBe(0)
  })
})
