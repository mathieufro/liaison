// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A company's and a contact's timeline on the real path: each app's activity
// source runs in a read-only run as the caller, under the caller's row security,
// with one deadline for all; the rows merge newest first and page by (time, id).

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { listEventsForCaller } from "~/apps/calendar/tools"
import { __privileged_db__ as db, sql } from "~/db/connection"
import { setPrivilegedContext } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { estimateToolSchemaTokens } from "~/modules/agent/context/context"
import { handleCompanyTimeline } from "~/modules/agent/tools/company-tools"
import { providerInputSchemaOf } from "~/modules/agent/tools/tool-bridge"
import {
  agentInstructionsRegistry,
  initializedOrgRuntimes,
  skillRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"
import * as executeToolModule from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import {
  ACTIVITY_DEADLINE_MS,
  ACTIVITY_DEAL_CAP,
  type ActivityResult,
  AGENT_READ_DEADLINE_MS,
  compareActivity,
  readActivity,
} from "~/modules/contacts/activity"
import * as mailSourceModule from "~/modules/mail/activity-source"
import { writeMailPage } from "~/modules/mail/page-write"
import { seedContext } from "~/seed/context"
import { insertSql, type RowValue } from "~/seed/factories/org/test-rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { seedCalendarAccount } from "../../../test-support/seed/calendar"
import { ensureMailAccount } from "../../../test-support/seed/mail"

const ORG = crypto.randomUUID()
const ADMIN = crypto.randomUUID()
const TOM = crypto.randomUUID() // another member, with a private mailbox
const tag = ORG.slice(0, 8)
const DAY = 86_400_000

function person(userId: string, scopes: string[] = ["*"]): UserContext {
  return { actorType: "user", userId, orgId: ORG, scopes, dimensionGrants: { "*": ["*"] } }
}
const admin = person(ADMIN)

async function insertRow(table: string, cols: Record<string, unknown>): Promise<void> {
  const row: Record<string, RowValue> = {}
  for (const [k, v] of Object.entries(cols)) {
    row[k] = v instanceof Date ? v.toISOString() : (v as RowValue)
  }
  await sql.unsafe(insertSql(table, row))
}

let seq = 0
const next = () => ++seq
const ago = (days: number, ms = 0) => new Date(Date.now() - days * DAY - ms)

async function company(name: string): Promise<string> {
  const id = crypto.randomUUID()
  await insertRow("kernel.companies", {
    id,
    org_id: ORG,
    handle: `@co-${tag}-${next()}`,
    name,
    created_by: ADMIN,
    org_access: "editor",
  })
  return id
}

async function contact(
  companyId: string | null,
  name: string,
  extra: Record<string, unknown> = {},
): Promise<{ id: string; email: string }> {
  const id = crypto.randomUUID()
  const email = `p${next()}-${tag}@client.example`
  await insertRow("kernel.contacts", {
    id,
    org_id: ORG,
    handle: `@p-${tag}-${seq}`,
    name,
    email,
    company_id: companyId,
    org_access: "editor",
    created_by: ADMIN,
    ...extra,
  })
  return { id, email }
}

let orgBox = ""
let tomBox = ""
let calendarId = ""
let calaccess = ""
let pipeline = ""
let stage = ""

async function conversation(accountId: string, contactId: string): Promise<string> {
  const id = crypto.randomUUID()
  await insertRow("app_mail.conversations", {
    id,
    org_id: ORG,
    account_id: accountId,
    owner_type: accountId === tomBox ? "user" : "org",
    owner_id: accountId === tomBox ? TOM : null,
    external_thread_id: `t-${id}`,
    subject: "About the order",
    status: "open",
    contact_id: contactId,
  })
  return id
}

async function message(
  accountId: string,
  conversationId: string,
  at: Date,
  opts: { direction?: "inbound" | "outbound"; subject?: string | null; sealed?: boolean } = {},
): Promise<string> {
  const id = crypto.randomUUID()
  await insertRow("app_mail.messages", {
    id,
    org_id: ORG,
    conversation_id: conversationId,
    account_id: accountId,
    external_message_id: `m-${id}`,
    direction: opts.direction ?? "inbound",
    subject: opts.sealed ? null : (opts.subject ?? "Order question"),
    ...(opts.sealed ? { subject_ciphertext: { raw: "'\\x01'::bytea" } } : {}),
    sent_at: at,
    synced_at: at,
    owner_type: accountId === tomBox ? "user" : "org",
    owner_id: accountId === tomBox ? TOM : null,
  })
  return id
}

async function ticket(contactId: string, at: Date, status = "open"): Promise<string> {
  const id = crypto.randomUUID()
  const n = next()
  await insertRow("app_tickets.tickets", {
    id,
    org_id: ORG,
    handle: `T-${n}`,
    subject: `Ticket ${n}`,
    channel: "email",
    reply_token: `rt-${id}`,
    sla_target_seconds: 86400,
    status,
    contact_id: contactId,
    created_at: at,
    updated_at: at,
  })
  return id
}

async function note(ticketId: string, at: Date): Promise<string> {
  const id = crypto.randomUUID()
  await insertRow("app_tickets.messages", {
    id,
    org_id: ORG,
    ticket_id: ticketId,
    kind: "note",
    text_body: "Called them.",
    sent_at: at,
    created_at: at,
  })
  return id
}

async function deal(companyId: string, contactId: string, at: Date, closedAt?: Date) {
  const task = crypto.randomUUID()
  await insertRow("kernel.threads", {
    id: task,
    org_id: ORG,
    handle: `deal-${task.slice(0, 8)}`,
    created_by: ADMIN,
  })
  await insertRow("app_projects.tasks", {
    id: task,
    org_id: ORG,
    project_id: pipeline,
    status_id: stage,
    title: "Studio fit-out",
    number: next(),
    thread_id: task,
    created_by: ADMIN,
    created_at: at,
    updated_at: at,
  })
  await insertRow("app_projects.deals", {
    task_id: task,
    org_id: ORG,
    company_id: companyId,
    contact_id: contactId,
    outcome: closedAt ? "won" : "open",
    ...(closedAt ? { closed_at: closedAt } : {}),
  })
  return task
}

async function meeting(email: string, at: Date, extra: Record<string, unknown> = {}) {
  const id = crypto.randomUUID()
  await insertRow("app_calendar.events", {
    id,
    org_id: ORG,
    calendar_id: calendarId,
    calaccess,
    google_event_id: `g-${id}`,
    title: "Studio visit",
    status: "confirmed",
    start: { raw: `'${JSON.stringify({ dateTime: at.toISOString() })}'::jsonb` },
    '"end"': {
      raw: `'${JSON.stringify({ dateTime: new Date(at.getTime() + 3_600_000).toISOString() })}'::jsonb`,
    },
    attendees: { raw: `'${JSON.stringify([{ email }])}'::jsonb` },
    ...extra,
  })
  return id
}

/** Every page from the first, by nextBefore, up to `max` pages. */
async function allPages(
  target: { companyId: string } | { contactId: string },
  limit: number,
  max = 10,
  actor: UserContext = admin,
): Promise<{ pages: ActivityResult[]; rows: ActivityResult["items"] }> {
  const pages: ActivityResult[] = []
  let before: string | null = null
  for (let i = 0; i < max; i++) {
    const page = await readActivity({ orgId: ORG, actor, target, before, limit })
    if (!page) throw new Error("not visible")
    pages.push(page)
    if (!page.nextBefore) break
    before = page.nextBefore
  }
  return { pages, rows: pages.flatMap((p) => p.items) }
}

// The real call, kept before any test spies on it.
const realExecute = executeToolModule.executeToolCore

let main = ""
let alice = { id: "", email: "" }
let bob = { id: "", email: "" }
let outsider = { id: "", email: "" }

describe("a company's timeline", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await insertRow("kernel.organizations", { id: ORG, name: "Timeline Org", slug: `tl-${tag}` })
    for (const [id, name] of [
      [ADMIN, "Élodie Vasseur"],
      [TOM, "Tom Keller"],
    ] as const) {
      await insertRow("kernel.users", {
        id,
        org_id: ORG,
        email: `${id.slice(0, 8)}@team.example`,
        name,
        status: "active",
        password_hash: "x",
      })
      await insertRow("kernel.user_scope_grants", { user_id: id, org_id: ORG, scope: "*" })
    }
    await ensureAppsForOrg(ORG)
    const ctx = seedContext({ orgId: ORG, now: new Date() })
    orgBox = (
      await ensureMailAccount(ctx, {
        ownerType: "org",
        userId: ADMIN,
        email: `sales-${tag}@team.example`,
        provider: "imap",
      })
    ).accountId
    tomBox = (
      await ensureMailAccount(ctx, {
        ownerType: "user",
        userId: TOM,
        email: `tom-${tag}@team.example`,
        provider: "imap",
      })
    ).accountId
    calendarId = (
      await seedCalendarAccount(ctx, {
        userId: ADMIN,
        ownerType: "org",
        identifier: `cal-${tag}@team.example`,
        populate: false,
      })
    ).calendarId
    const [cal] = await sql<Array<{ calaccess: string }>>`
      SELECT calaccess FROM app_calendar.calendars WHERE id = ${calendarId}`
    calaccess = cal?.calaccess ?? ""
    pipeline = crypto.randomUUID()
    stage = crypto.randomUUID()
    await insertRow("app_projects.projects", {
      id: pipeline,
      org_id: ORG,
      name: "Sales",
      key: `S${tag.slice(0, 3).toUpperCase()}`,
      owner_id: ADMIN,
      kind: "pipeline",
    })
    await insertRow("app_projects.project_statuses", {
      id: stage,
      org_id: ORG,
      project_id: pipeline,
      label: "Proposal",
      '"order"': 1,
      terminal: false,
    })

    main = await company("Nordlicht Studio")
    alice = await contact(main, "Alice Martin")
    bob = await contact(main, "Bob Durand")
    outsider = await contact(null, "Olga Elsewhere")
    const conv = await conversation(orgBox, alice.id)
    await message(orgBox, conv, ago(5))
    await message(orgBox, conv, ago(4), { direction: "outbound", subject: "Re: Order question" })
    await message(orgBox, conv, ago(3), { sealed: true })
    // A colleague's private mailbox: never on anyone else's timeline.
    const tomConv = await conversation(tomBox, alice.id)
    await message(tomBox, tomConv, ago(2), { subject: "Private chat" })
    const t = await ticket(bob.id, ago(6))
    await note(t, ago(1))
    await deal(main, alice.id, ago(9), ago(7))
    await meeting(alice.email, ago(8))
    // Someone outside the company, with mail of their own.
    const other = await conversation(orgBox, outsider.id)
    await message(orgBox, other, ago(2), { subject: "Not theirs" })
  }, 120_000)

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    skillRegistry.deleteByPrefix([ORG])
    agentInstructionsRegistry.deleteByPrefix([ORG])
    initializedOrgRuntimes.delete(ORG)
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`.catch(() => undefined)
    await releaseTestLock()
  })

  it("rows from every source are merged strictly by time, ties by source then id", async () => {
    // A ticket and a mail on one timestamp.
    const tie = await company("Tie Studio")
    const carla = await contact(tie, "Carla Tie")
    const at = ago(2)
    const conv = await conversation(orgBox, carla.id)
    await message(orgBox, conv, at)
    await ticket(carla.id, at)
    const tied = await readActivity({ orgId: ORG, actor: admin, target: { companyId: tie } })
    expect(tied?.items.map((r) => r.source)).toEqual(["tickets", "mail"])

    const page = await readActivity({ orgId: ORG, actor: admin, target: { companyId: main } })
    if (!page) throw new Error("not visible")
    expect(page.unavailable).toEqual([])
    expect(new Set(page.items.map((r) => r.source))).toEqual(
      new Set(["mail", "tickets", "projects", "calendar"]),
    )
    const sorted = [...page.items].sort(compareActivity)
    expect(page.items.map((r) => r.id)).toEqual(sorted.map((r) => r.id))
    for (const row of page.items) expect(row.id.startsWith(`${row.source}:`)).toBe(true)
    expect(page.items.map((r) => r.title)).toContain("Re: Order question sent to Alice Martin")
  }, 60_000)

  it("another person's private mailbox gives no row and a sealed message reads Message", async () => {
    const page = await readActivity({ orgId: ORG, actor: admin, target: { companyId: main } })
    const titles = page?.items.filter((r) => r.source === "mail").map((r) => r.title) ?? []
    expect(titles).not.toContain("Private chat")
    expect(titles).toContain("Message")
    const own = await readActivity({ orgId: ORG, actor: person(TOM), target: { companyId: main } })
    expect(own?.items.map((r) => r.title)).toContain("Private chat")
  }, 60_000)

  it("a contact's timeline holds only rows involving that contact", async () => {
    const page = await readActivity({ orgId: ORG, actor: admin, target: { contactId: bob.id } })
    if (!page) throw new Error("not visible")
    expect(page.items.length).toBeGreaterThan(0)
    for (const row of page.items)
      expect(row.contactId === bob.id || row.contactId === null).toBe(true)
    expect(page.items.map((r) => r.source)).toEqual(["tickets", "tickets"])
    const other = await readActivity({
      orgId: ORG,
      actor: admin,
      target: { contactId: outsider.id },
    })
    expect(other?.items.map((r) => r.title)).toEqual(["Not theirs"])
  }, 60_000)

  it("a source the caller lacks the scope for is never called and never mentioned", async () => {
    const calls: string[] = []
    const spy = spyOn(executeToolModule, "executeToolCore")
    spy.mockImplementation(async (opts) => {
      calls.push(opts.toolName)
      return realExecute(opts)
    })
    try {
      const mailOnly = person(ADMIN, [
        "kernel:contacts:read",
        "kernel:companies:read",
        "mail:conversations:read",
      ])
      const page = await readActivity({ orgId: ORG, actor: mailOnly, target: { companyId: main } })
      expect(calls).toEqual(["mail:activity_read"])
      expect(new Set(page?.items.map((r) => r.source))).toEqual(new Set(["mail"]))
      expect(page?.unavailable).toEqual([])
    } finally {
      spy.mockRestore()
    }
  }, 60_000)

  it("a source that hangs does not delay the panel's answer past one second and the others' rows return", async () => {
    const spy = spyOn(executeToolModule, "executeToolCore")
    spy.mockImplementation(async (opts) =>
      opts.toolName === "tickets:activity_read" ? new Promise(() => {}) : realExecute(opts),
    )
    try {
      // Warm, so the clock measures the deadline and not a first sandbox start.
      const panel = { orgId: ORG, actor: admin, target: { companyId: main } }
      await readActivity({ ...panel, deadlineMs: ACTIVITY_DEADLINE_MS })
      const started = performance.now()
      const page = await readActivity({ ...panel, deadlineMs: ACTIVITY_DEADLINE_MS })
      expect(performance.now() - started).toBeLessThan(1000)
      expect(page?.unavailable).toEqual([
        { source: "tickets", label: "Tickets", reason: "timeout" },
      ])
      expect(page?.items.some((r) => r.source === "mail")).toBe(true)
      expect(page?.items.some((r) => r.source === "tickets")).toBe(false)
    } finally {
      spy.mockRestore()
    }
  }, 60_000)

  it("an agent's read waits for a source slower than the panel's budget but within a cold first read", async () => {
    const spy = spyOn(executeToolModule, "executeToolCore")
    // Slower than the panel's 800 ms, as a source's first, cold run is on a loaded host.
    const slow = ACTIVITY_DEADLINE_MS + 400
    spy.mockImplementation(async (opts) =>
      opts.toolName === "tickets:activity_read"
        ? new Promise((resolve) => setTimeout(() => resolve(realExecute(opts)), slow))
        : realExecute(opts),
    )
    try {
      expect(AGENT_READ_DEADLINE_MS).toBeGreaterThan(slow)
      // No deadline of its own: the agent tools' read.
      const page = await readActivity({ orgId: ORG, actor: admin, target: { companyId: main } })
      expect(page?.unavailable).toEqual([])
      expect(page?.items.some((r) => r.source === "tickets")).toBe(true)
    } finally {
      spy.mockRestore()
    }
  }, 60_000)

  it("a source that tries to write is reported unavailable and writes nothing", async () => {
    const spy = spyOn(mailSourceModule, "mailActivityRows").mockImplementation(async (db) => {
      await db.execute(
        // A write from inside a source: the read-only run must refuse it.
        (await import("drizzle-orm")).sql`UPDATE kernel.contacts SET name = 'Overwritten'
           WHERE id = ${alice.id}::uuid`,
      )
      return { rows: [] }
    })
    try {
      const page = await readActivity({ orgId: ORG, actor: admin, target: { companyId: main } })
      expect(page?.unavailable).toEqual([{ source: "mail", label: "Mail", reason: "error" }])
    } finally {
      spy.mockRestore()
    }
    const [row] = await sql<Array<{ name: string }>>`
      SELECT name FROM kernel.contacts WHERE id = ${alice.id}`
    expect(row?.name).toBe("Alice Martin")
  }, 60_000)

  it("with more deals than a source is asked about, each source gets the most recent and the answer says how many were left out", async () => {
    const big = await company("Many Deals Dealer")
    const buyer = await contact(big, "Buyer")
    const deals: string[] = []
    for (let i = 0; i < ACTIVITY_DEAL_CAP + 5; i++) deals.push(await deal(big, buyer.id, ago(i)))
    const seen: Array<string[]> = []
    const spy = spyOn(executeToolModule, "executeToolCore")
    spy.mockImplementation(async (opts) => {
      seen.push((opts.params as { dealIds: string[] }).dealIds)
      return realExecute(opts)
    })
    try {
      const page = await readActivity({ orgId: ORG, actor: admin, target: { companyId: big } })
      expect(page?.truncatedDeals).toBe(5)
      expect(seen.length).toBeGreaterThan(0)
      for (const ids of seen) expect(ids).toEqual(deals.slice(0, ACTIVITY_DEAL_CAP))
    } finally {
      spy.mockRestore()
    }
  }, 180_000)

  it("with 60 people each source gets the 50 most recently active and the answer says 10 were left out", async () => {
    const big = await company("Big Dealer")
    const people: string[] = []
    for (let i = 0; i < 60; i++) {
      people.push((await contact(big, `Person ${i}`, { updated_at: ago(i) })).id)
    }
    const seen: Array<string[]> = []
    const spy = spyOn(executeToolModule, "executeToolCore")
    spy.mockImplementation(async (opts) => {
      seen.push((opts.params as { contactIds: string[] }).contactIds)
      return realExecute(opts)
    })
    try {
      const page = await readActivity({ orgId: ORG, actor: admin, target: { companyId: big } })
      expect(page?.truncatedContacts).toBe(10)
      expect(seen.length).toBe(4)
      for (const ids of seen) expect(new Set(ids)).toEqual(new Set(people.slice(0, 50)))
    } finally {
      spy.mockRestore()
    }
  }, 120_000)

  it("three pages of 100 rows have no duplicate and no gap, with 150 rows on one timestamp across a page boundary", async () => {
    const paged = await company("Paged Shop")
    const dana = await contact(paged, "Dana Paged")
    const t = await ticket(dana.id, ago(400))
    const same = ago(10)
    const expected = new Set<string>([`tickets:${t}:opened`])
    for (let i = 0; i < 150; i++) expected.add(`tickets:${await note(t, same)}`)
    for (let i = 0; i < 149; i++) expected.add(`tickets:${await note(t, ago(20 + i))}`)
    for (let i = 0; i < 49; i++) expected.add(`tickets:${await note(t, ago(1, i * 1000))}`)
    const { pages, rows } = await allPages({ companyId: paged }, 100)
    expect(pages.length).toBe(4)
    expect(pages.slice(0, 3).map((p) => p.items.length)).toEqual([100, 100, 100])
    const ids = rows.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(ids)).toEqual(expected)
    expect(ids).toEqual([...rows].sort(compareActivity).map((r) => r.id))
  }, 180_000)

  it("a company whose only meetings are 200 days old shows them by paging", async () => {
    const old = await company("Old Partner")
    const erin = await contact(old, "Erin Old")
    const event = await meeting(erin.email, ago(200))
    const first = await readActivity({ orgId: ORG, actor: admin, target: { companyId: old } })
    expect(first?.items).toEqual([])
    expect(first?.nextBefore).not.toBeNull()
    const { rows, pages } = await allPages({ companyId: old }, 30)
    expect(rows.map((r) => r.id)).toEqual([`calendar:${event}`])
    expect(pages.at(-1)?.nextBefore).toBeNull()
  }, 60_000)

  it("a weekly meeting is expanded into its occurrences on the timeline", async () => {
    const weekly = await company("Weekly Client")
    const fred = await contact(weekly, "Fred Weekly")
    const master = await meeting(fred.email, ago(30), {
      recurrence: { raw: `'["RRULE:FREQ=WEEKLY"]'::jsonb` },
    })
    const page = await readActivity({ orgId: ORG, actor: admin, target: { companyId: weekly } })
    const ids = page?.items.filter((r) => r.source === "calendar").map((r) => r.id) ?? []
    expect(ids.length).toBeGreaterThanOrEqual(4)
    expect(ids.length).toBeLessThanOrEqual(5)
    for (const id of ids) expect(id.startsWith(`calendar:${master}@`)).toBe(true)
  }, 60_000)

  it("list events filters by one attendee or a list of 50", async () => {
    const gina = await contact(null, "Gina Attendee")
    const hugo = await contact(null, "Hugo Attendee")
    const g = await meeting(gina.email, ago(3))
    const h = await meeting(hugo.email, ago(3))
    const window = { timeMin: ago(5).toISOString(), timeMax: ago(1).toISOString() }
    const ids = async (attendee: string | string[]) =>
      (
        await withRlsContext(admin, (tx) =>
          listEventsForCaller(tx as never, ORG, { ...window, attendee }),
        )
      ).map((e) => e.eventId)
    expect(await ids([gina.email.toUpperCase()])).toEqual([g])
    const fifty = [
      ...Array.from({ length: 48 }, (_, i) => `nobody${i}@else.example`),
      gina.email,
      hugo.email,
    ]
    expect(new Set(await ids(fifty))).toEqual(new Set([g, h]))
  }, 60_000)

  it("an unknown source is ignored", async () => {
    const page = await readActivity({
      orgId: ORG,
      actor: admin,
      target: { companyId: main },
      source: "nonexistent",
    })
    expect(page).toEqual({ items: [], unavailable: [], nextBefore: null })
  }, 60_000)

  it("a company the caller cannot see is not found", async () => {
    const page = await readActivity({
      orgId: ORG,
      actor: admin,
      target: { companyId: crypto.randomUUID() },
    })
    expect(page).toBeNull()
  }, 60_000)

  it("the agent's timeline equals the route under its actor, and the tool marks the turn as reading outside text", async () => {
    const route = await readActivity({ orgId: ORG, actor: admin, target: { companyId: main } })
    const tool = (await handleCompanyTimeline(
      { companyId: main },
      {
        orgId: ORG,
        userId: ADMIN,
        scopes: ["*"],
        dimensionGrants: { "*": ["*"] },
        db: null as never,
      },
    )) as ActivityResult
    expect(tool.items).toEqual(route?.items ?? [])
    expect(tool.unavailable).toEqual(route?.unavailable ?? [])
    expect(toolRegistry.get([ORG, "kernel", "company_timeline"])?.taintSource).toBe(true)
  }, 60_000)

  it("the timeline tool's schema the model reads stays within 220 tokens", () => {
    const def = toolRegistry.get([ORG, "kernel", "company_timeline"])
    if (!def) throw new Error("no company_timeline")
    const tokens = estimateToolSchemaTokens("kernel__company_timeline", {
      description: def.description,
      inputSchema: providerInputSchemaOf(def.params),
    })
    console.log(`company_timeline schema: ${tokens} tokens`)
    expect(tokens).toBeLessThanOrEqual(220)
  })

  it("mail a person sends to a known contact is on that contact's and company's timeline", async () => {
    const studio = await company("Sent To Studio")
    const claudine = await contact(studio, "Claudine Sent")
    const unknown = `nobody-${tag}@elsewhere.example`
    const sent = (to: string) => {
      const id = `<sent-${tag}-${next()}@team.example>`
      return {
        externalMessageId: id,
        externalProviderId: id,
        externalThreadId: id,
        from: { email: `sales-${tag}@team.example` },
        to: [to],
        cc: [],
        bcc: [],
        subject: "Preamp pair delivery",
        textBody: "They ship on Monday.",
        htmlBody: null,
        snippet: "They ship on Monday.",
        isRead: true,
        isStarred: false,
        labels: ["SENT"],
        direction: "outbound",
        sentAt: ago(0, 60_000).toISOString(),
        headers: {},
        sentByUserId: ADMIN,
      }
    }
    const toClaudine = sent(`Claudine Sent <${claudine.email.toUpperCase()}>`)
    const toNobody = sent(unknown)
    await db.transaction(async (tx) => {
      await tx.execute(drizzleSql`SET LOCAL ROLE liaison_admin`)
      await setPrivilegedContext(tx as never, ORG)
      await writeMailPage(
        {
          tx: tx as never,
          schemaName: schemaRef("app_mail"),
          orgId: ORG,
          actorId: ADMIN,
          queueEvents: async () => {},
        } as never,
        { accountId: orgBox, origin: "sent", messages: [toClaudine, toNobody] },
      )
    })
    const linked = await sql<Array<{ thread: string; contact_id: string | null }>>`
      SELECT external_thread_id AS thread, contact_id::text AS contact_id FROM app_mail.conversations
       WHERE org_id = ${ORG} AND external_thread_id IN (${toClaudine.externalThreadId}, ${toNobody.externalThreadId})`
    expect(Object.fromEntries(linked.map((r) => [r.thread, r.contact_id]))).toEqual({
      [toClaudine.externalThreadId]: claudine.id,
      [toNobody.externalThreadId]: null,
    })
    for (const target of [{ contactId: claudine.id }, { companyId: studio }]) {
      const page = await readActivity({ orgId: ORG, actor: admin, target })
      const mail = page?.items.filter((r) => r.source === "mail") ?? []
      expect(mail.map((r) => [r.title, r.contactId])).toEqual([
        ["Preamp pair delivery sent to Claudine Sent", claudine.id],
      ])
    }
    // Sending creates no contact for an address nobody has recorded.
    const created = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM kernel.contacts WHERE org_id = ${ORG} AND lower(email) = ${unknown}`
    expect(created[0]?.n).toBe(0)
  }, 60_000)

  it("ten calls change no row count in the org", async () => {
    const counts = async () =>
      sql<Array<{ t: string; n: number }>>`
        SELECT 'contacts' AS t, count(*)::int AS n FROM kernel.contacts WHERE org_id = ${ORG}
        UNION ALL SELECT 'audit', count(*)::int FROM kernel.audit_log WHERE org_id = ${ORG}
        UNION ALL SELECT 'timeline', count(*)::int FROM kernel.timeline_entries WHERE org_id = ${ORG}
        UNION ALL SELECT 'approvals', count(*)::int FROM kernel.approval_requests WHERE org_id = ${ORG}
        UNION ALL SELECT 'messages', count(*)::int FROM app_mail.messages WHERE org_id = ${ORG}
        UNION ALL SELECT 'tickets', count(*)::int FROM app_tickets.messages WHERE org_id = ${ORG}
        UNION ALL SELECT 'events', count(*)::int FROM app_calendar.events WHERE org_id = ${ORG}
        UNION ALL SELECT 'tasks', count(*)::int FROM app_projects.tasks WHERE org_id = ${ORG}`
    const before = await counts()
    for (let i = 0; i < 10; i++) {
      await readActivity({ orgId: ORG, actor: admin, target: { companyId: main } })
    }
    expect(await counts()).toEqual(before)
  }, 120_000)
})
