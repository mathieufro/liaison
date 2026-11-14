// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A pipeline's board as each reader sees it: sums per currency only with deal
// access, Won and Lost limited to this month in the org's time zone, open
// stages sorted by quiet, and quiet only for a reader who can read mail. Real
// database, real liaison_rls role, mail rows stored as a sync stores them.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { dealBoard, listDeals } from "~/apps/projects/service/deals"
import { moveTask } from "~/apps/projects/service/move-task"
import { sql } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { type UserContext, withRlsContext } from "~/db/rls"
import { seedContext } from "~/seed/context"
import { insertSql } from "~/seed/factories/org/test-rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  appendMailMessages,
  ensureMailAccount,
  seedMailConversation,
} from "../../../../test-support/seed/mail"
import { type DealWorld, makeDealWorld, makePipeline, makeTask } from "./__tests__/deal-world"

const DAY = 86_400_000
let w: DealWorld
let mailbox = ""
let seq = 0

const READ_ONLY = ["projects:projects:read", "projects:tasks:read"]
const MAIL = ["mail:conversations:read"]

function reader(scopes: string[]): UserContext {
  return { ...w.actor, scopes }
}

const board = (as: UserContext, projectId: string, now = new Date()) =>
  withRlsContext(as, (tx) => dealBoard(tx, w.orgId, as.scopes, projectId, now))

async function company(name: string): Promise<string> {
  const id = crypto.randomUUID()
  seq += 1
  await sql.unsafe(
    insertSql("kernel.companies", {
      id,
      org_id: w.orgId,
      handle: `@board-co-${seq}-${id.slice(0, 6)}`,
      name,
      created_by: w.userId,
      org_access: "editor",
    }),
  )
  return id
}

async function contact(companyId: string | null): Promise<{ id: string; email: string }> {
  const id = crypto.randomUUID()
  seq += 1
  const email = `buyer${seq}-${id.slice(0, 6)}@client.example`
  await sql.unsafe(
    insertSql("kernel.contacts", {
      id,
      org_id: w.orgId,
      handle: `@board-person-${seq}-${id.slice(0, 6)}`,
      name: `Buyer ${seq}`,
      email,
      created_by: w.userId,
      org_access: "editor",
      company_id: companyId,
    }),
  )
  return { id, email }
}

async function setDeal(
  taskId: string,
  fields: { companyId?: string; amount?: number; currency?: string },
) {
  if (fields.companyId) {
    await db.execute(drizzleSql`
      UPDATE app_projects.deals SET company_id = ${fields.companyId}::uuid WHERE task_id = ${taskId}::uuid`)
  }
  if (fields.amount !== undefined) {
    await db.execute(drizzleSql`
      UPDATE app_projects.deal_values SET amount_minor = ${fields.amount}, currency = ${fields.currency ?? "EUR"}
      WHERE task_id = ${taskId}::uuid`)
  }
}

/** Close a deal by a move, then pin the instant it closed. */
async function closeAt(taskId: string, statusId: string, at: string) {
  await withRlsContext(w.actor, (tx) =>
    moveTask({ tx, orgId: w.orgId, actor: w.actor, taskId, statusId }),
  )
  await db.execute(drizzleSql`
    UPDATE app_projects.deals SET closed_at = ${at}::timestamptz WHERE task_id = ${taskId}::uuid`)
}

async function createdDaysAgo(taskId: string, days: number) {
  await db.execute(drizzleSql`
    UPDATE app_projects.tasks SET created_at = now() - make_interval(days => ${days})
    WHERE id = ${taskId}::uuid`)
}

/** One inbound mail from `from`, sent `daysAgo` days ago. */
async function inbound(from: string, daysAgo: number, rawHeaders?: Record<string, string>) {
  const ctx = seedContext({ orgId: w.orgId, now: new Date() })
  const { conversationId } = await seedMailConversation(ctx, {
    accountId: mailbox,
    subject: "About the proposal",
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
        from: { email: from },
        to: [{ email: "sales@seller.example" }],
        textBody: "Thanks, we will look at it.",
        sentAt: new Date(Date.now() - daysAgo * DAY).toISOString(),
        ...(rawHeaders ? { rawHeaders } : {}),
      },
    ],
    updateConversation: false,
    announce: false,
  })
}

async function setTimeZone(tz: string) {
  await db.execute(
    drizzleSql`UPDATE kernel.organizations SET timezone = ${tz} WHERE id = ${w.orgId}::uuid`,
  )
}

beforeAll(async () => {
  await acquireTestLock()
  w = await makeDealWorld("deal-board")
  w.actor = { ...w.actor, scopes: [...w.actor.scopes, ...MAIL] }
  const ctx = seedContext({ orgId: w.orgId, now: new Date() })
  mailbox = (
    await ensureMailAccount(ctx, {
      ownerType: "user",
      userId: w.userId,
      email: `sales-${crypto.randomUUID().slice(0, 6)}@seller.example`,
      provider: "imap",
    })
  ).accountId
})

afterAll(releaseTestLock)

describe("column totals", () => {
  it("column totals per currency appear only for a reader with deal access", async () => {
    const p = await makePipeline(w, "Totals")
    const a = await makeTask(w, p.projectId, "Lumen", { statusId: p.stage.Proposal })
    const b = await makeTask(w, p.projectId, "Basalt", { statusId: p.stage.Proposal })
    await setDeal(a, { amount: 120_000 })
    await setDeal(b, { amount: 30_000 })

    const full = await board(w.actor, p.projectId)
    const proposal = full.columns.find((c) => c.label === "Proposal")!
    expect(proposal.sums).toEqual([{ currency: "EUR", sum_minor: 150_000 }])
    expect(proposal.deals.map((d) => d.amount?.amountMinor).sort()).toEqual([120_000, 30_000])

    const blind = await board(reader([...READ_ONLY, ...MAIL]), p.projectId)
    const text = JSON.stringify(blind)
    expect(text).not.toContain("sum_minor")
    expect(text).not.toContain('"amount"')
    expect(text).not.toContain('"sums"')
    expect(blind.columns.find((c) => c.label === "Proposal")!.count).toBe(2)
  })

  it("two currencies in a column give two sums", async () => {
    const p = await makePipeline(w, "Two currencies")
    const a = await makeTask(w, p.projectId, "Verrerie Nord", { statusId: p.stage.Demo })
    const b = await makeTask(w, p.projectId, "Harbour Tools", { statusId: p.stage.Demo })
    const c = await makeTask(w, p.projectId, "Kestrel", { statusId: p.stage.Demo })
    await setDeal(a, { amount: 10_000, currency: "EUR" })
    await setDeal(b, { amount: 25_000, currency: "USD" })
    await setDeal(c, { amount: 5_000, currency: "EUR" })
    const demo = (await board(w.actor, p.projectId)).columns.find((col) => col.label === "Demo")!
    expect(demo.sums).toEqual([
      { currency: "EUR", sum_minor: 15_000 },
      { currency: "USD", sum_minor: 25_000 },
    ])
  })
})

describe("won and lost this month", () => {
  it("won and lost show only this month in the org's timezone", async () => {
    // 00:30 on 1 November in each zone; one deal closed 15 minutes before
    // midnight there (October), one 10 minutes after (November). In UTC both
    // closed on 31 October, so a board read in UTC would swap them.
    const cases = [
      {
        tz: "Europe/Paris",
        now: "2026-10-31T23:30:00Z",
        october: "2026-10-31T22:45:00Z",
        november: "2026-10-31T23:10:00Z",
      },
      {
        tz: "Pacific/Auckland",
        now: "2026-10-31T11:30:00Z",
        october: "2026-10-31T10:45:00Z",
        november: "2026-10-31T11:10:00Z",
      },
    ]
    for (const c of cases) {
      await setTimeZone(c.tz)
      const p = await makePipeline(w, `Month ${c.tz}`)
      const lastMonth = await makeTask(w, p.projectId, "Closed in October", {
        statusId: p.stage.Proposal,
      })
      const thisMonth = await makeTask(w, p.projectId, "Closed in November", {
        statusId: p.stage.Proposal,
      })
      const lostThisMonth = await makeTask(w, p.projectId, "Lost in November", {
        statusId: p.stage.Proposal,
      })
      await closeAt(lastMonth, p.stage.Won!, c.october)
      await closeAt(thisMonth, p.stage.Won!, c.november)
      await closeAt(lostThisMonth, p.stage.Lost!, c.november)

      const b = await board(w.actor, p.projectId, new Date(c.now))
      expect(b.timeZone).toBe(c.tz)
      expect(b.closedMonth).toBe("2026-11")
      expect(b.columns.find((col) => col.label === "Won")!.deals.map((d) => d.taskId)).toEqual([
        thisMonth,
      ])
      expect(b.columns.find((col) => col.label === "Lost")!.deals.map((d) => d.taskId)).toEqual([
        lostThisMonth,
      ])

      // A minute before midnight there it is still October: the other one shows.
      const before = await board(
        w.actor,
        p.projectId,
        new Date(new Date(c.october).getTime() + 5 * 60_000),
      )
      expect(before.closedMonth).toBe("2026-10")
      expect(before.columns.find((col) => col.label === "Won")!.deals.map((d) => d.taskId)).toEqual(
        [lastMonth],
      )

      // Off the board, still found by a search.
      const found = await withRlsContext(w.actor, (tx) =>
        listDeals(tx, w.orgId, { taskId: lastMonth }),
      )
      expect(found.map((d) => d.outcome)).toEqual(["won"])
    }
    await setTimeZone("UTC")
  })
})

describe("quiet", () => {
  it("open columns put the quietest deal first and unknown quiet last", async () => {
    const p = await makePipeline(w, "Quiet order")
    const mk = async (title: string) => {
      const id = await makeTask(w, p.projectId, title, { statusId: p.stage.Lead })
      await createdDaysAgo(id, 40)
      return id
    }
    const ten = await mk("Quiet ten days")
    const three = await mk("Quiet three days")
    const autoReplied = await mk("Real reply nine days ago, auto-reply yesterday")
    const nobody = await mk("No company and no contact")

    for (const [taskId, days] of [
      [ten, 10],
      [three, 3],
      [autoReplied, 9],
    ] as const) {
      const co = await company(`Company of ${taskId.slice(0, 6)}`)
      const person = await contact(co)
      await setDeal(taskId, { companyId: co })
      await inbound(person.email, days)
      if (taskId === autoReplied) {
        await inbound(person.email, 1, { "auto-submitted": "auto-replied" })
      }
    }

    const lead = (await board(w.actor, p.projectId)).columns.find((c) => c.label === "Lead")!
    expect(lead.deals.map((d) => [d.taskId, d.quietDays])).toEqual([
      [ten, 10],
      [autoReplied, 9],
      [three, 3],
      [nobody, null],
    ])
  })

  it("a reader without mail access gets no quiet value and no quiet line", async () => {
    const p = await makePipeline(w, "No mail access")
    const id = await makeTask(w, p.projectId, "Quiet for her, not for him", {
      statusId: p.stage.Lead,
    })
    const co = await company("Orchard Lane")
    const person = await contact(co)
    await setDeal(id, { companyId: co })
    await inbound(person.email, 6)

    const withMail = await board(w.actor, p.projectId)
    expect(withMail.columns.find((c) => c.label === "Lead")!.deals[0]!.quietDays).toBe(6)

    const without = await board(reader(READ_ONLY), p.projectId)
    const cards = without.columns.flatMap((c) => c.deals)
    expect(cards.map((d) => d.quietDays)).toEqual([null])
  })
})
