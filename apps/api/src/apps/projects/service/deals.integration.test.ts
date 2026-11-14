// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Deals in Projects: the outcome a deal takes from its stage, the deal rows a
// pipeline task gets, and what moves, merges, deletes and stage edits do to
// them. Real database, real liaison_rls role.

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import projectsManifest from "~/apps/projects/app.manifest.json"
import {
  armAfterDealOutcomeFailpoint,
  listDeals,
  setDealOutcome,
} from "~/apps/projects/service/deals"
import { moveTask } from "~/apps/projects/service/move-task"
import { deleteStatus, updateStatus } from "~/apps/projects/service/statuses"
import { deriveProjectKey } from "~/apps/projects/service/task-key"
import { deleteTask, mergeTasks, restoreTask } from "~/apps/projects/service/tasks"
import { extractRows, sql } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import { appBridgeManifestRegistry } from "~/modules/apps/app-registries"
import { executeToolCore } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { buildDataSubjectBundle } from "~/modules/export/data-subject-export-tool"
import { MEMBER_SECTIONS, readMemberSections } from "~/modules/export/member-data-subject-bundle"
import * as suppressionsModule from "~/modules/mail/suppressions"
import { seedContext } from "~/seed/context"
import { seedApprovalRequests } from "~/seed/factories/approvals/requests"
import { insertSql, type RowValue } from "~/seed/factories/org/test-rows"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  appendMailMessages,
  ensureMailAccount,
  seedMailConversation,
} from "../../../../test-support/seed/mail"
import {
  type DealWorld,
  dealEvents,
  dealState,
  makeDealWorld,
  makePipeline,
  makeTask,
  makeWorkProject,
  taskStatus,
} from "./__tests__/deal-world"

let w: DealWorld

beforeAll(async () => {
  await acquireTestLock()
  w = await makeDealWorld("deals")
})

afterAll(releaseTestLock)

const run = <T>(fn: (tx: Parameters<Parameters<typeof withRlsContext>[1]>[0]) => Promise<T>) =>
  withRlsContext(w.actor, fn)

const move = (taskId: string, statusId: string, lostReason?: string) =>
  run((tx) => moveTask({ tx, orgId: w.orgId, actor: w.actor, taskId, statusId, lostReason }))

async function errorOf(p: Promise<unknown>): Promise<{ code?: string; message?: string }> {
  try {
    await p
  } catch (err) {
    return err as { code?: string; message?: string }
  }
  throw new Error("expected a refusal")
}

async function setCompanyAndAmount(taskId: string, companyId: string | null, amount?: number) {
  await db.execute(drizzleSql`
    UPDATE app_projects.deals SET company_id = ${companyId}::uuid WHERE task_id = ${taskId}::uuid`)
  if (amount !== undefined) {
    await db.execute(drizzleSql`
      UPDATE app_projects.deal_values SET amount_minor = ${amount}, currency = 'EUR'
      WHERE task_id = ${taskId}::uuid`)
  }
}

describe("closing and reopening", () => {
  it("a move to a closing stage sets outcome, closed at and closed by with the move, and a failure leaves all unchanged", async () => {
    const p = await makePipeline(w, "Close by move")
    const taskId = await makeTask(w, p.projectId, "Verrerie Nord", { statusId: p.stage.Demo })

    const disarm = armAfterDealOutcomeFailpoint(() => {
      throw new Error("fault after the outcome write")
    })
    try {
      const err = await errorOf(move(taskId, p.stage.Won!))
      expect(err.message).toBe("fault after the outcome write")
    } finally {
      disarm()
    }
    expect(await taskStatus(taskId)).toBe(p.stage.Demo!)
    expect(await dealState(taskId)).toMatchObject({
      outcome: "open",
      closed_at: null,
      closed_by: null,
    })
    expect(await dealEvents(w, taskId)).toEqual([])

    await move(taskId, p.stage.Won!)
    const state = await dealState(taskId)
    expect(state).toMatchObject({ outcome: "won", closed_by: w.userId, status_id: p.stage.Won })
    expect(state?.closed_at).not.toBeNull()
    expect(await dealEvents(w, taskId)).toEqual(["closed:won"])
  })

  it("moving back to an open stage clears the outcome and the reason and emits reopened", async () => {
    const p = await makePipeline(w, "Reopen by move")
    const taskId = await makeTask(w, p.projectId, "Basalt", { statusId: p.stage.Proposal })
    await move(taskId, p.stage.Lost!, "Went with a cheaper offer")
    expect(await dealState(taskId)).toMatchObject({
      outcome: "lost",
      lost_reason: "Went with a cheaper offer",
    })
    await move(taskId, p.stage.Qualified!)
    expect(await dealState(taskId)).toMatchObject({
      outcome: "open",
      closed_at: null,
      closed_by: null,
      lost_reason: null,
    })
    expect(await dealEvents(w, taskId)).toEqual(["closed:lost", "reopened"])
  })

  it("a second mark won is a no-op with no second event", async () => {
    const p = await makePipeline(w, "Double click")
    const taskId = await makeTask(w, p.projectId, "Lumen", { statusId: p.stage.Proposal })
    const first = await run((tx) =>
      setDealOutcome({ tx, orgId: w.orgId, actor: w.actor, taskId, outcome: "won" }),
    )
    const closedAt = (await dealState(taskId))?.closed_at
    const second = await run((tx) =>
      setDealOutcome({ tx, orgId: w.orgId, actor: w.actor, taskId, outcome: "won" }),
    )
    expect(first).toMatchObject({ outcome: "won", statusId: p.stage.Won, changed: true })
    expect(second).toMatchObject({ outcome: "won", statusId: p.stage.Won, changed: false })
    expect((await dealState(taskId))?.closed_at).toBe(closedAt!)
    expect(await dealEvents(w, taskId)).toEqual(["closed:won"])

    // Reopening goes back to the stage the deal was closed from.
    const reopened = await run((tx) =>
      setDealOutcome({ tx, orgId: w.orgId, actor: w.actor, taskId, outcome: "open" }),
    )
    expect(reopened).toMatchObject({ outcome: "open", statusId: p.stage.Proposal })
  })

  it("won then lost emits closed, reopened and closed", async () => {
    const p = await makePipeline(w, "Won then lost")
    const taskId = await makeTask(w, p.projectId, "Quartz", { statusId: p.stage.Demo })
    await move(taskId, p.stage.Won!)
    await move(taskId, p.stage.Lost!)
    expect((await dealState(taskId))?.outcome).toBe("lost")
    expect(await dealEvents(w, taskId)).toEqual(["closed:won", "reopened", "closed:lost"])
  })
})

describe("deal rows", () => {
  it("a root task created in a pipeline gets both deal rows and a subtask gets none", async () => {
    const p = await makePipeline(w, "Rows on create")
    const deal = await makeTask(w, p.projectId, "Root deal")
    const sub = await makeTask(w, p.projectId, "Send the quote", { parentTaskId: deal })
    const work = await makeWorkProject(w, "Plain work")
    const chore = await makeTask(w, work.projectId, "A chore")
    expect(await dealState(deal)).toMatchObject({
      outcome: "open",
      has_value: true,
      amount_minor: null,
      status_id: p.stage.Lead,
    })
    expect(await dealState(sub)).toBeNull()
    expect(await dealState(chore)).toBeNull()
  })

  it("a task moved into a pipeline gets empty deal rows", async () => {
    const work = await makeWorkProject(w, "Leads inbox")
    const p = await makePipeline(w, "Into a pipeline")
    const taskId = await makeTask(w, work.projectId, "Lead from a fair")
    await run((tx) =>
      moveTask({ tx, orgId: w.orgId, actor: w.actor, taskId, targetProjectId: p.projectId }),
    )
    expect(await dealState(taskId)).toMatchObject({
      outcome: "open",
      has_value: true,
      amount_minor: null,
      status_id: p.stage.Lead,
    })
  })

  it("a subtask moved to the root of a pipeline gets deal rows", async () => {
    const p = await makePipeline(w, "Promote a subtask")
    const parent = await makeTask(w, p.projectId, "Parent deal")
    const sub = await makeTask(w, p.projectId, "Second site", { parentTaskId: parent })
    expect(await dealState(sub)).toBeNull()
    await run((tx) =>
      moveTask({ tx, orgId: w.orgId, actor: w.actor, taskId: sub, parentTaskId: null }),
    )
    expect(await dealState(sub)).toMatchObject({ outcome: "open", has_value: true })
  })

  it("a deal cannot be moved under another task, and nothing changes", async () => {
    const p = await makePipeline(w, "No nested deals")
    const a = await makeTask(w, p.projectId, "Deal A", { statusId: p.stage.Demo })
    const b = await makeTask(w, p.projectId, "Deal B", { statusId: p.stage.Proposal })
    await setCompanyAndAmount(a, null, 1_000_000)
    await setCompanyAndAmount(b, null, 1_000_000)
    const err = await errorOf(
      run((tx) => moveTask({ tx, orgId: w.orgId, actor: w.actor, taskId: b, parentTaskId: a })),
    )
    expect(err).toMatchObject({ code: "deal_cannot_be_subtask", status: 409 })
    const parent = extractRows<{ parent_task_id: string | null }>(
      await db.execute(
        drizzleSql`SELECT parent_task_id FROM app_projects.tasks WHERE id = ${b}::uuid`,
      ),
    )
    expect(parent[0]?.parent_task_id).toBeNull()
    expect(await dealState(b)).toMatchObject({ outcome: "open", status_id: p.stage.Proposal })
  })

  it("a deal row left on a subtask is not counted by the deal reads", async () => {
    const p = await makePipeline(w, "Root deals only")
    const a = await makeTask(w, p.projectId, "Top deal")
    const sub = await makeTask(w, p.projectId, "Old nested deal")
    // A deal nested before nesting was refused keeps its deal rows.
    await db.execute(drizzleSql`
      UPDATE app_projects.tasks SET parent_task_id = ${a}::uuid WHERE id = ${sub}::uuid`)
    expect(await dealState(sub)).not.toBeNull()
    const deals = await run((tx) => listDeals(tx, w.orgId, { projectId: p.projectId }))
    expect(deals.map((d) => d.taskId)).toEqual([a])
  })

  it("a deal cannot move into a work project", async () => {
    const p = await makePipeline(w, "Stays a deal")
    const work = await makeWorkProject(w, "Work board")
    const taskId = await makeTask(w, p.projectId, "Deal to keep", { statusId: p.stage.Demo })
    const err = await errorOf(
      run((tx) =>
        moveTask({ tx, orgId: w.orgId, actor: w.actor, taskId, targetProjectId: work.projectId }),
      ),
    )
    expect(err).toMatchObject({ code: "deal_needs_pipeline", status: 409 })
    expect(await taskStatus(taskId)).toBe(p.stage.Demo!)
    expect(await dealState(taskId)).toMatchObject({ outcome: "open" })
  })

  it("into another pipeline it keeps its rows", async () => {
    const from = await makePipeline(w, "From pipeline")
    const to = await makePipeline(w, "To pipeline")
    const won = await makeTask(w, from.projectId, "Won deal", { statusId: from.stage.Demo })
    const open = await makeTask(w, from.projectId, "Open deal", { statusId: from.stage.Proposal })
    const company = crypto.randomUUID()
    await setCompanyAndAmount(won, company, 480_000)
    await move(won, from.stage.Won!)
    for (const taskId of [won, open]) {
      await run((tx) =>
        moveTask({ tx, orgId: w.orgId, actor: w.actor, taskId, targetProjectId: to.projectId }),
      )
    }
    expect(await dealState(won)).toMatchObject({
      outcome: "won",
      company_id: company,
      amount_minor: "480000",
      currency: "EUR",
      status_id: to.stage.Won,
    })
    expect(await dealState(open)).toMatchObject({ outcome: "open", status_id: to.stage.Lead })
    expect(await dealEvents(w, won)).toEqual(["closed:won"])
  })

  it("merging two deals keeps the survivor's rows, removes the source's, and refuses two companies", async () => {
    const p = await makePipeline(w, "Merge deals")
    const target = await makeTask(w, p.projectId, "Survivor")
    const source = await makeTask(w, p.projectId, "Duplicate")
    const rival = await makeTask(w, p.projectId, "Other company")
    const company = crypto.randomUUID()
    await setCompanyAndAmount(target, company, 900_000)
    await setCompanyAndAmount(source, company, 100)
    await setCompanyAndAmount(rival, crypto.randomUUID(), 5)

    const err = await errorOf(
      run((tx) =>
        mergeTasks({ tx, orgId: w.orgId, actor: w.actor, sourceId: rival, targetId: target }),
      ),
    )
    expect(err).toMatchObject({ code: "deals_different_company", status: 409 })
    expect(await dealState(rival)).toMatchObject({ amount_minor: "5" })

    await run((tx) =>
      mergeTasks({ tx, orgId: w.orgId, actor: w.actor, sourceId: source, targetId: target }),
    )
    expect(await dealState(source)).toBeNull()
    const survivors = extractRows<{ n: number }>(
      await db.execute(drizzleSql`
        SELECT COUNT(*)::int AS n FROM app_projects.deal_values WHERE task_id = ${source}::uuid`),
    )
    expect(survivors[0]?.n).toBe(0)
    expect(await dealState(target)).toMatchObject({
      company_id: company,
      amount_minor: "900000",
      outcome: "open",
    })
  })

  it("a deal is not merged into a task that is not a deal, and a deal with no company takes the merged one's", async () => {
    const p = await makePipeline(w, "Merge into a chore")
    const work = await makeWorkProject(w, "Chores for merging")
    const deal = await makeTask(w, p.projectId, "Deal with an amount")
    const chore = await makeTask(w, work.projectId, "A plain task")
    const company = crypto.randomUUID()
    await setCompanyAndAmount(deal, company, 250_000)
    const err = await errorOf(
      run((tx) =>
        mergeTasks({ tx, orgId: w.orgId, actor: w.actor, sourceId: deal, targetId: chore }),
      ),
    )
    expect(err).toMatchObject({ code: "deal_merge_target_not_deal", status: 409 })
    expect(await dealState(deal)).toMatchObject({ company_id: company, amount_minor: "250000" })

    const bare = await makeTask(w, p.projectId, "Deal with no company")
    await run((tx) =>
      mergeTasks({ tx, orgId: w.orgId, actor: w.actor, sourceId: deal, targetId: bare }),
    )
    expect(await dealState(deal)).toBeNull()
    expect(await dealState(bare)).toMatchObject({ company_id: company })
  })

  it("a deleted deal leaves the deal reads, and a restore brings back its amount, company and outcome", async () => {
    const p = await makePipeline(w, "Bin and back")
    const taskId = await makeTask(w, p.projectId, "Binned deal", { statusId: p.stage.Proposal })
    const company = crypto.randomUUID()
    await setCompanyAndAmount(taskId, company, 1_740_000)
    await move(taskId, p.stage.Lost!, "Budget frozen")

    const read = () =>
      run((tx) => listDeals(tx, w.orgId, { projectId: p.projectId })).then((rows) =>
        rows.filter((r) => r.taskId === taskId),
      )
    const byCompany = () =>
      run((tx) => listDeals(tx, w.orgId, { companyId: company })).then((rows) => rows.length)
    expect(await read()).toHaveLength(1)

    await run((tx) => deleteTask({ tx, orgId: w.orgId, actor: w.actor, taskId }))
    expect(await read()).toEqual([])
    expect(await byCompany()).toBe(0)
    expect(await run((tx) => listDeals(tx, w.orgId, { taskId }))).toEqual([])

    await run((tx) => restoreTask({ tx, orgId: w.orgId, actor: w.actor, taskId }))
    const [back] = await read()
    expect(back).toMatchObject({
      taskId,
      companyId: company,
      outcome: "lost",
      lostReason: "Budget frozen",
      statusId: p.stage.Lost,
      value: { amountMinor: 1_740_000, currency: "EUR" },
    })
    expect(back?.closedAt).not.toBeNull()
    expect(await byCompany()).toBe(1)
  })
})

describe("pipelines and their stages", () => {
  it("a new pipeline has six stages with one won and one lost", async () => {
    const p = await makePipeline(w, "Northwind sales")
    const rows = extractRows<{
      label: string
      terminal: boolean
      deal_outcome: string | null
    }>(
      await db.execute(drizzleSql`
        SELECT label, terminal, deal_outcome FROM app_projects.project_statuses
        WHERE project_id = ${p.projectId}::uuid ORDER BY "order"`),
    )
    expect(rows).toEqual([
      { label: "Lead", terminal: false, deal_outcome: null },
      { label: "Qualified", terminal: false, deal_outcome: null },
      { label: "Demo", terminal: false, deal_outcome: null },
      { label: "Proposal", terminal: false, deal_outcome: null },
      { label: "Won", terminal: true, deal_outcome: "won" },
      { label: "Lost", terminal: true, deal_outcome: "lost" },
    ])
    const [project] = extractRows<{ kind: string; key: string }>(
      await db.execute(drizzleSql`
        SELECT kind, key FROM app_projects.projects WHERE id = ${p.projectId}::uuid`),
    )
    expect(project).toEqual({ kind: "pipeline", key: deriveProjectKey("Northwind sales") })
  })

  it("the last won stage cannot be deleted", async () => {
    const p = await makePipeline(w, "Keep closing stages")
    const del = (statusId: string) =>
      run((tx) =>
        deleteStatus({ tx, orgId: w.orgId, actor: w.actor, projectId: p.projectId, statusId }),
      )
    const won = await errorOf(del(p.stage.Won!))
    expect(won).toMatchObject({ code: "last_closing_stage", status: 409 })
    const lost = await errorOf(del(p.stage.Lost!))
    expect(lost).toMatchObject({ code: "last_closing_stage" })
    // Nor can it stop closing deals by losing its terminal flag.
    const flip = await errorOf(
      run((tx) =>
        updateStatus({
          tx,
          orgId: w.orgId,
          actor: w.actor,
          projectId: p.projectId,
          statusId: p.stage.Won!,
          patch: { terminal: false },
        }),
      ),
    )
    expect(flip).toMatchObject({ code: "last_closing_stage" })
    // An open stage still deletes as before.
    await del(p.stage.Demo!)
  })

  it("a stage that stops being terminal stops closing deals and its deals reopen", async () => {
    const p = await makePipeline(w, "Second won stage")
    // A second won stage, so the first may stop closing.
    await db.execute(
      drizzleSql.raw(
        insertSql("app_projects.project_statuses", {
          org_id: w.orgId,
          project_id: p.projectId,
          label: "Won (renewal)",
          // A reserved word, quoted as a column name.
          '"order"': 9,
          terminal: true,
          deal_outcome: "won",
        }),
      ),
    )
    const taskId = await makeTask(w, p.projectId, "Renewal", { statusId: p.stage.Demo })
    await move(taskId, p.stage.Won!)
    await run((tx) =>
      updateStatus({
        tx,
        orgId: w.orgId,
        actor: w.actor,
        projectId: p.projectId,
        statusId: p.stage.Won!,
        patch: { terminal: false },
      }),
    )
    const [stage] = extractRows<{ deal_outcome: string | null }>(
      await db.execute(drizzleSql`
        SELECT deal_outcome FROM app_projects.project_statuses WHERE id = ${p.stage.Won!}::uuid`),
    )
    expect(stage?.deal_outcome).toBeNull()
    expect((await dealState(taskId))?.outcome).toBe("open")
    expect(await dealEvents(w, taskId)).toEqual(["closed:won", "reopened"])
  })
})

// ---------------------------------------------------------------------------
// The deal tools, through the projects bridge as an agent's call reaches it
// ---------------------------------------------------------------------------

const DEAL_SCOPES = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
  "projects:deals:read",
  "projects:deals:write",
  "mail:conversations:read",
]
const NO_DEAL_ACCESS = DEAL_SCOPES.filter((s) => !s.startsWith("projects:deals"))
const DAY_MS = 86_400_000
let rowSeq = 0

async function call<T = Record<string, unknown>>(
  method: string,
  input: Record<string, unknown>,
  scopes: string[] = DEAL_SCOPES,
): Promise<T> {
  const actor = { ...w.actor, scopes }
  return withRlsContext(actor, async (tx) => {
    const bridge = createRpcBridge("projects", w.userId, w.orgId, tx, { name: "projects" }, scopes)
    return JSON.parse(await bridge[method](JSON.stringify(input))) as T
  })
}

async function newCompany(name: string, extra: Record<string, RowValue> = {}): Promise<string> {
  const id = crypto.randomUUID()
  rowSeq += 1
  await sql.unsafe(
    insertSql("kernel.companies", {
      id,
      org_id: w.orgId,
      handle: `@deal-co-${rowSeq}-${id.slice(0, 6)}`,
      name,
      created_by: w.userId,
      org_access: "editor",
      ...extra,
    }),
  )
  return id
}

async function newContact(companyId: string | null): Promise<{ id: string; email: string }> {
  const id = crypto.randomUUID()
  rowSeq += 1
  const email = `deal-person${rowSeq}-${id.slice(0, 6)}@client.example`
  await sql.unsafe(
    insertSql("kernel.contacts", {
      id,
      org_id: w.orgId,
      handle: `@deal-person-${rowSeq}-${id.slice(0, 6)}`,
      name: `Person ${rowSeq}`,
      email,
      created_by: w.userId,
      org_access: "editor",
      company_id: companyId,
    }),
  )
  return { id, email }
}

let mailAccount = ""
async function inboundFrom(email: string, daysAgo: number) {
  const ctx = seedContext({ orgId: w.orgId, now: new Date() })
  if (!mailAccount) {
    mailAccount = (
      await ensureMailAccount(ctx, {
        ownerType: "user",
        userId: w.userId,
        email: `deals-${crypto.randomUUID().slice(0, 6)}@seller.example`,
        provider: "imap",
      })
    ).accountId
  }
  const { conversationId } = await seedMailConversation(ctx, {
    accountId: mailAccount,
    subject: "Our proposal",
    status: "open",
    labels: [],
    isRead: false,
    isStarred: false,
    messageCount: 1,
    messages: [],
  })
  await appendMailMessages(ctx, {
    conversationId,
    messages: [
      {
        direction: "inbound",
        from: { email },
        to: [{ email: "sales@seller.example" }],
        textBody: "We are reading it.",
        sentAt: new Date(Date.now() - daysAgo * DAY_MS).toISOString(),
      },
    ],
    updateConversation: false,
    announce: false,
  })
}

const taskCount = async (projectId: string) =>
  Number(
    extractRows<{ n: string }>(
      await db.execute(drizzleSql`
        SELECT COUNT(*)::text AS n FROM app_projects.tasks WHERE project_id = ${projectId}::uuid`),
    )[0]?.n ?? 0,
  )

describe("creating a deal", () => {
  it("creating a task in a pipeline with a company and an amount makes the task and both rows at once; deal fields on a work project are refused", async () => {
    const p = await makePipeline(w, "Create with fields")
    const co = await newCompany("Lumen")
    const person = await newContact(co)
    const created = await call<{ id: string; deal: Record<string, unknown> }>(
      "projects_createTask",
      {
        projectId: p.projectId,
        title: "Team annual",
        companyId: co,
        contactId: person.id,
        amountMinor: 480_000,
        currency: "eur",
      },
    )
    expect(await dealState(created.id)).toMatchObject({
      outcome: "open",
      company_id: co,
      has_value: true,
      amount_minor: "480000",
      currency: "EUR",
    })

    const work = await makeWorkProject(w, "Plain work")
    const refused = await call<{ error?: { code: string; message: string } }>(
      "projects_createTask",
      { projectId: work.projectId, title: "Not a deal", companyId: co },
    )
    expect(refused.error?.code).toBe("not_a_pipeline")
    expect(refused.error?.message).toContain("Nothing was created")
    expect(await taskCount(work.projectId)).toBe(0)

    // An amount without deal access leaves no task behind either.
    const before = await taskCount(p.projectId)
    const noAccess = await call<{ error?: { code: string } }>(
      "projects_createTask",
      { projectId: p.projectId, title: "Priced", amountMinor: 1_000, currency: "EUR" },
      NO_DEAL_ACCESS,
    )
    expect(noAccess.error?.code).toBe("deal_access_needed")
    expect(await taskCount(p.projectId)).toBe(before)
  })
})

describe("closing a deal", () => {
  it("closing a deal through the deal update needs the same right as moving it to a closing stage, and an amount still needs deal access", async () => {
    expect(projectsManifest.tools.deals_update.requiredScopes).toEqual(
      projectsManifest.tools.move.requiredScopes,
    )
    const p = await makePipeline(w, "Close without deal access")
    const taskId = await makeTask(w, p.projectId, "Harbour renewal", {
      statusId: p.stage.Proposal,
    })
    const won = await call<{ error?: { code: string } }>(
      "projects_dealsUpdate",
      { taskId, outcome: "won" },
      NO_DEAL_ACCESS,
    )
    expect(won.error).toBeUndefined()
    expect(await dealState(taskId)).toMatchObject({ outcome: "won", status_id: p.stage.Won })
    const amount = await call<{ error?: { code: string } }>(
      "projects_dealsUpdate",
      { taskId, amountMinor: 500_000, currency: "EUR" },
      NO_DEAL_ACCESS,
    )
    expect(amount.error?.code).toBe("deal_access_needed")
    expect(await dealState(taskId)).toMatchObject({ amount_minor: null })
  })
})

describe("the reason of a lost deal", () => {
  it("a reason given after the move to Lost is saved, changed and cleared without moving the deal again", async () => {
    const p = await makePipeline(w, "Reason after the move")
    const taskId = await makeTask(w, p.projectId, "Quarry renewal", { statusId: p.stage.Proposal })
    await move(taskId, p.stage.Lost!)
    expect(await dealState(taskId)).toMatchObject({ outcome: "lost", lost_reason: null })
    const saved = await call<{ message: string; error?: unknown }>("projects_dealsUpdate", {
      taskId,
      outcome: "lost",
      reason: "  Went with a cheaper rota tool ",
    })
    expect(saved.error).toBeUndefined()
    expect(saved.message).toContain("The reason it was lost is now: Went with a cheaper rota tool.")
    expect(await dealState(taskId)).toMatchObject({
      outcome: "lost",
      status_id: p.stage.Lost,
      lost_reason: "Went with a cheaper rota tool",
    })
    await call("projects_dealsUpdate", { taskId, outcome: "lost", reason: null })
    expect(await dealState(taskId)).toMatchObject({ outcome: "lost", lost_reason: null })
    // One close, no reopen: the reason never moved the deal.
    expect(await dealEvents(w, taskId)).toEqual(["closed:lost"])
  })

  it("a reason for a deal that is not lost is not saved", async () => {
    const p = await makePipeline(w, "Reason on a won deal")
    const taskId = await makeTask(w, p.projectId, "Slate renewal", { statusId: p.stage.Proposal })
    await move(taskId, p.stage.Won!)
    const res = await call<{ message: string }>("projects_dealsUpdate", {
      taskId,
      outcome: "won",
      reason: "Should not stick",
    })
    expect(res.message).toContain("The reason was not saved")
    expect(await dealState(taskId)).toMatchObject({ outcome: "won", lost_reason: null })
  })
})

describe("deal rollup", () => {
  it("the rollup sums per currency and is absent without deal access", async () => {
    const p = await makePipeline(w, "Rollup")
    const mk = async (
      title: string,
      stage: string,
      amount: number,
      currency: string,
      prob: number,
    ) => {
      const id = await makeTask(w, p.projectId, title, { statusId: p.stage[stage] })
      await db.execute(drizzleSql`
        UPDATE app_projects.deal_values SET amount_minor = ${amount}, currency = ${currency},
               probability = ${prob}
        WHERE task_id = ${id}::uuid`)
      return id
    }
    await mk("Lumen", "Proposal", 100_000, "EUR", 50)
    await mk("Basalt", "Proposal", 40_000, "EUR", 25)
    await mk("Harbour", "Proposal", 70_000, "USD", 100)
    await mk("Kestrel", "Lead", 10_000, "EUR", 10)

    const r = await call<{
      groups: Array<{
        label: string
        count: number
        sumByCurrency: unknown
        weightedByCurrency: unknown
      }>
    }>("projects_dealsRollup", { projectId: p.projectId, groupBy: "stage", weighted: true })
    const proposal = r.groups.find((g) => g.label === "Proposal")!
    expect(proposal.count).toBe(3)
    expect(proposal.sumByCurrency).toEqual([
      { currency: "EUR", sum_minor: 140_000 },
      { currency: "USD", sum_minor: 70_000 },
    ])
    expect(proposal.weightedByCurrency).toEqual([
      { currency: "EUR", sum_minor: 60_000 },
      { currency: "USD", sum_minor: 70_000 },
    ])

    expect(projectsManifest.tools.deals_rollup.requiredScopes).toEqual(["projects:deals:read"])
    const blind = await call<{ error?: { code: string } }>(
      "projects_dealsRollup",
      { projectId: p.projectId, groupBy: "stage" },
      NO_DEAL_ACCESS,
    )
    expect(blind.error?.code).toBe("forbidden")
  })
})

describe("follow-up candidates", () => {
  it("follow-up candidates give the exact skip reason for each case without calling a model", async () => {
    const p = await makePipeline(w, "Follow-ups")
    const deal = async (
      title: string,
      inboundDaysAgo: number | null,
      withPerson = true,
      owner: string | null = w.userId,
    ) => {
      const id = await makeTask(w, p.projectId, title, { statusId: p.stage.Proposal })
      await db.execute(drizzleSql`
        UPDATE app_projects.tasks SET created_at = now() - interval '60 days',
               assignee_id = ${owner}::uuid WHERE id = ${id}::uuid`)
      if (!withPerson) return { id, email: "" }
      const co = await newCompany(`Company ${title}`)
      const person = await newContact(co)
      await db.execute(drizzleSql`
        UPDATE app_projects.deals SET company_id = ${co}::uuid WHERE task_id = ${id}::uuid`)
      if (inboundDaysAgo !== null) await inboundFrom(person.email, inboundDaysAgo)
      return { id, email: person.email, contactId: person.id }
    }
    const ready = await deal("Ready", 10)
    const notQuiet = await deal("Answered two days ago", 2)
    const noContact = await deal("Nobody named", null, false)
    const optedOut = await deal("Opted out", 12)
    const drafted = await deal("Draft waiting", 15)
    const noOwner = await deal("Nobody owns it", 11, true, null)
    const basis: Record<string, string> = {}
    for (const code of ["no_basis", "consumer", "consumer_unknown", "country_needs_consent"]) {
      const d = await deal(`Basis ${code}`, 20)
      basis[d.contactId!] = code
      basis[d.id] = code
    }

    const threadId = await minimal.thread(w.orgId, w.userId)
    await seedApprovalRequests(seedContext({ orgId: w.orgId, now: new Date() }), [
      {
        id: crypto.randomUUID(),
        handle: `followup-${crypto.randomUUID().slice(0, 8)}`,
        threadId,
        toolName: "mail:compose",
        payload: {
          to: [drafted.email],
          subject: "Checking in",
          body: "Any news on the proposal?",
          sendGuard: { refs: [{ kind: "projects:deal", id: drafted.id }] },
        },
        requestedBy: w.userId,
        agentId: null,
        notifyUserIds: [],
        status: "pending",
        createdAt: new Date(),
      },
    ])

    const optedSpy = spyOn(suppressionsModule, "suppressedAmong").mockImplementation(
      async (_org, emails) => emails.filter((e) => e === optedOut.email),
    )
    const basisSpy = spyOn(suppressionsModule, "lawfulBasisProblem").mockImplementation(
      async (_org, contactIds) => {
        const code = basis[contactIds[0] ?? ""]
        return code ? { code, label: code, who: "someone" } : null
      },
    )
    try {
      const r = await call<{
        items: Array<{
          taskId: string
          skip: string | null
          quietDays: number | null
          accountId: string | null
          address: string | null
        }>
      }>("projects_dealsFollowupCandidates", { quietDays: 7, projectId: p.projectId })
      const skip = (id: string) => r.items.find((i) => i.taskId === id)?.skip
      expect(skip(ready.id)).toBeNull()
      expect(r.items.find((i) => i.taskId === ready.id)?.quietDays).toBe(10)
      expect(skip(notQuiet.id)).toBe("not_quiet")
      expect(skip(noContact.id)).toBe("no_contact")
      expect(skip(optedOut.id)).toBe("opted_out")
      expect(skip(drafted.id)).toBe("draft_waiting")
      // Drafted from the deal owner's own mailbox, or not at all.
      expect(r.items.find((i) => i.taskId === ready.id)).toMatchObject({
        accountId: mailAccount,
        address: ready.email,
      })
      expect(skip(noOwner.id)).toBe("no_sender")
      for (const [id, code] of Object.entries(basis)) {
        if (r.items.some((i) => i.taskId === id)) expect(skip(id)).toBe(code)
      }

      // A caller who cannot read mail gets no quiet, so nothing is drafted.
      const blind = await call<{ items: Array<{ taskId: string; skip: string | null }> }>(
        "projects_dealsFollowupCandidates",
        { quietDays: 7, projectId: p.projectId },
        DEAL_SCOPES.filter((s) => !s.startsWith("mail:")),
      )
      expect(blind.items.find((i) => i.taskId === ready.id)?.skip).toBe("mail_not_visible")
      expect(blind.items.find((i) => i.taskId === noContact.id)?.skip).toBe("no_contact")
    } finally {
      optedSpy.mockRestore()
      basisSpy.mockRestore()
    }
  })
})

describe("deal send state", () => {
  it("the deal send state stops a closed or deleted deal and passes an open one", async () => {
    await ensureAppsForOrg(w.orgId, {})
    expect(
      appBridgeManifestRegistry.get([w.orgId, "projects"])?.sendGuardProviders?.["projects:deal"],
    ).toMatchObject({ tool: "deal_send_state" })

    const ask = async (id: string) => {
      const envelope = await executeToolCore({
        toolName: "projects:deal_send_state",
        orgId: w.orgId,
        actor: { actorType: "system", orgId: w.orgId, purpose: "job", scopes: ["projects:*"] },
        params: { ref: { kind: "projects:deal", id } },
        origin: "system",
      })
      return "data" in envelope ? envelope.data : envelope
    }
    const p = await makePipeline(w, "Send state")
    const open = await makeTask(w, p.projectId, "Still open", { statusId: p.stage.Demo })
    const won = await makeTask(w, p.projectId, "Signed", { statusId: p.stage.Demo })
    const gone = await makeTask(w, p.projectId, "Deleted", { statusId: p.stage.Demo })
    await move(won, p.stage.Won!)
    await run((tx) => deleteTask({ tx, orgId: w.orgId, actor: w.actor, taskId: gone }))

    expect(await ask(open)).toEqual({ stop: false })
    expect(await ask(won)).toEqual({ stop: true, code: "deal_closed", label: "Signed is closed" })
    expect(await ask(gone)).toMatchObject({ stop: true, code: "deal_deleted" })
    expect(await ask(crypto.randomUUID())).toMatchObject({ stop: true, code: "deal_deleted" })
  })
})

describe("exports", () => {
  it("a member's bundle lists the deals they own or closed", async () => {
    const p = await makePipeline(w, "Member deals")
    const owned = await makeTask(w, p.projectId, "Owned by the member", { statusId: p.stage.Lead })
    const closed = await makeTask(w, p.projectId, "Closed by the member", {
      statusId: p.stage.Demo,
    })
    const other = await makeTask(w, p.projectId, "Someone else's", { statusId: p.stage.Lead })
    await db.execute(drizzleSql`
      UPDATE app_projects.tasks SET assignee_id = ${w.userId}::uuid WHERE id = ${owned}::uuid`)
    await move(closed, p.stage.Lost!)
    const section = MEMBER_SECTIONS.find((s) => s.key === "deals")!
    const out = await run((tx) =>
      readMemberSections(tx, { orgId: w.orgId, subjectUserId: w.userId }, [section]),
    )
    const rows = out.deals!.rows as Array<{
      task_id: string
      owner: boolean
      closed_by_member: boolean
    }>
    const mine = rows.filter((r) => [owned, closed, other].includes(r.task_id))
    expect(mine.map((r) => [r.task_id, r.owner, r.closed_by_member]).sort()).toEqual(
      [
        [owned, true, false],
        [closed, false, true],
      ].sort(),
    )
  })

  it("a contact's export lists the deals naming them, with no amount without deal access", async () => {
    const p = await makePipeline(w, "Contact deals")
    const person = await newContact(null)
    const id = await makeTask(w, p.projectId, "Named deal", { statusId: p.stage.Proposal })
    await db.execute(drizzleSql`
      UPDATE app_projects.deals SET contact_id = ${person.id}::uuid WHERE task_id = ${id}::uuid`)
    await db.execute(drizzleSql`
      UPDATE app_projects.deal_values SET amount_minor = 9900, currency = 'EUR' WHERE task_id = ${id}::uuid`)
    const exportAs = (scopes: string[]) =>
      withRlsContext({ ...w.actor, scopes }, async (tx) =>
        buildDataSubjectBundle(person.id, { orgId: w.orgId, userId: w.userId, db: tx, scopes }),
      )
    const full = await exportAs(DEAL_SCOPES)
    if ("error" in full) throw new Error(full.error.message)
    expect(full.records.deals).toEqual([
      {
        taskId: id,
        title: "Named deal",
        stage: "Proposal",
        outcome: "open",
        closedAt: null,
        amount: { amountMinor: 9900, currency: "EUR" },
      },
    ])
    const blind = await exportAs(NO_DEAL_ACCESS)
    if ("error" in blind) throw new Error(blind.error.message)
    expect(blind.records.deals).toEqual([
      { taskId: id, title: "Named deal", stage: "Proposal", outcome: "open", closedAt: null },
    ])
  })
})
