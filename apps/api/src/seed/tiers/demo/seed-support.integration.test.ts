// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `seedDemoSupport` against a REAL database.
//
// Two things are proved here and nothing else is taken on trust:
//
//  1. RE-RUNNABLE. The seeder runs twice and the SECOND run changes no row
//     count in any table it writes and throws nothing. Counts are read out of
//     Postgres, never taken from the seeder's own return value. This is the
//     headline: the demo box re-seeds on every deploy.
//
//  2. READABLE THROUGH THE PRODUCT. Every domain is read back through the same
//     function the app and the agent tools call (`searchTickets`, `getTicket`,
//     `listKnowledgeDocuments`, `computeAttentionItems`, `listProjectTasks`,
//     `listEventsForCaller`, `listContacts`, `findDuplicateClusters`,
//     `listMessages`), not by selecting the rows back. A row the app cannot
//     render is worthless in a demo.
//
// Locally, against the isolated hardening database, never a shared one:
//   DATABASE_URL=postgres://liaison_app:liaison_app@localhost:5432/liaison_hardening_test \
//     bun test src/seed/tiers/demo/seed-support.integration.test.ts --timeout 900000
import { beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { sql } from "drizzle-orm"
import { expandRecurringEvent, listEventsForCaller } from "~/apps/calendar/tools"
import { computeAttentionItems } from "~/apps/knowledge/attention"
import { knowledgeActorFromContext, listKnowledgeDocuments } from "~/apps/knowledge/service"
import { listProjectTasks } from "~/apps/projects/service/tasks"
import { getTicket, searchTickets } from "~/apps/tickets/search"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { findDuplicateClusters, listContacts } from "~/modules/contacts/service"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { listMessages } from "~/modules/threads/message"
import { createOrGetAgentDm } from "~/modules/threads/thread"
import { type SeedDemoOrgResult, seedDemoOrg } from "./seed-org"
import { type SeedDemoSupportResult, seedDemoSupport } from "./seed-support"

// Overridable so a clean-slate run can be proved on a fresh org without
// disturbing the shared hardening database (which other work also uses).
const ORG_SLUG = process.env.DEMO_SUPPORT_TEST_SLUG ?? "demo-support-integration"
const DB_URL = process.env.DATABASE_URL ?? ""

// A FIXED base time makes the whole run reproducible: the offsets are the fixed
// thing in the seeder, so pinning the base pins every instant it derives.
const BASE_TIME = new Date("2026-09-16T09:00:00.000Z")

beforeAll(() => {
  if (DB_URL === "") throw new Error("DATABASE_URL must be set for this test")
  if (/liaison_dev|liaison_test(?!_)/.test(DB_URL)) {
    throw new Error("refusing to seed a shared database: use liaison_hardening_test")
  }
  if (!process.env.LIAISON_APPS_DIR) {
    process.env.LIAISON_APPS_DIR = path.join(
      mkdtempSync(path.join(tmpdir(), "demo-support-")),
      "apps",
    )
  }
})

/** Row counts for every table the support seeder writes, straight from Postgres. */
async function countsFor(orgId: string): Promise<Record<string, number>> {
  return withPrivilegedDb(orgId, "demo-support-test-counts", async (tx) => {
    const one = async (query: ReturnType<typeof sql>): Promise<number> => {
      const result = await tx.execute(query)
      const list = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
      return Number((list[0] as { count?: string | number } | undefined)?.count ?? 0)
    }
    return {
      contacts: await one(
        sql`SELECT count(*) AS count FROM kernel.contacts WHERE org_id = ${orgId}`,
      ),
      tickets: await one(
        sql`SELECT count(*) AS count FROM app_tickets.tickets WHERE org_id = ${orgId}`,
      ),
      ticketMessages: await one(
        sql`SELECT count(*) AS count FROM app_tickets.messages WHERE org_id = ${orgId}`,
      ),
      ticketInboxes: await one(
        sql`SELECT count(*) AS count FROM app_tickets.inboxes WHERE org_id = ${orgId}`,
      ),
      ticketCategories: await one(
        sql`SELECT count(*) AS count FROM app_tickets.categories WHERE org_id = ${orgId}`,
      ),
      ticketCsat: await one(
        sql`SELECT count(*) AS count FROM app_tickets.ticket_csat WHERE org_id = ${orgId}`,
      ),
      mailAccounts: await one(
        sql`SELECT count(*) AS count FROM app_mail.accounts WHERE org_id = ${orgId}`,
      ),
      mailConversations: await one(
        sql`SELECT count(*) AS count FROM app_mail.conversations WHERE org_id = ${orgId}`,
      ),
      mailMessages: await one(
        sql`SELECT count(*) AS count FROM app_mail.messages WHERE org_id = ${orgId}`,
      ),
      knowledgeCollections: await one(
        sql`SELECT count(*) AS count FROM app_knowledge.collections WHERE org_id = ${orgId}`,
      ),
      knowledgeDocuments: await one(
        sql`SELECT count(*) AS count FROM app_knowledge.documents WHERE org_id = ${orgId}`,
      ),
      knowledgeMemberships: await one(
        sql`SELECT count(*) AS count FROM app_knowledge.collection_memberships WHERE org_id = ${orgId}`,
      ),
      projects: await one(
        sql`SELECT count(*) AS count FROM app_projects.projects WHERE org_id = ${orgId}`,
      ),
      tasks: await one(
        sql`SELECT count(*) AS count FROM app_projects.tasks WHERE org_id = ${orgId}`,
      ),
      taskDependencies: await one(
        sql`SELECT count(*) AS count FROM app_projects.task_dependencies d
            JOIN app_projects.tasks t ON t.id = d.task_id WHERE t.org_id = ${orgId}`,
      ),
      calendarAccounts: await one(
        sql`SELECT count(*) AS count FROM app_calendar.accounts WHERE org_id = ${orgId}`,
      ),
      calendars: await one(
        sql`SELECT count(*) AS count FROM app_calendar.calendars WHERE org_id = ${orgId}`,
      ),
      calendarEvents: await one(
        sql`SELECT count(*) AS count FROM app_calendar.events WHERE org_id = ${orgId}`,
      ),
      threads: await one(sql`SELECT count(*) AS count FROM kernel.threads WHERE org_id = ${orgId}`),
      threadMessages: await one(
        sql`SELECT count(*) AS count FROM kernel.messages WHERE org_id = ${orgId}`,
      ),
      approvals: await one(
        sql`SELECT count(*) AS count FROM kernel.approval_requests WHERE org_id = ${orgId}`,
      ),
    }
  })
}

async function userActor(orgId: string, userId: string) {
  const perms = await withPrivilegedDb(orgId, "demo-support-test-perms", (tx) =>
    loadEffectivePermissions(tx, userId, orgId),
  )
  return {
    actorType: "user" as const,
    userId,
    orgId,
    scopes: perms.scopes,
    dimensionGrants: perms.dimensionGrants,
    roles: perms.roles,
  }
}

describe("seedDemoSupport against a real database", () => {
  let org: SeedDemoOrgResult
  let first: SeedDemoSupportResult
  let second: SeedDemoSupportResult
  let countsAfterFirst: Record<string, number>
  let countsAfterSecond: Record<string, number>

  beforeAll(async () => {
    // WITH AN OWNER, deliberately. The owner is the one account a demo org is
    // ever signed into, and the agent DMs the seeder writes hang off them: an
    // org seeded without one has no human seat for a DM and the seeder skips
    // the section, which would make the DM assertions below vacuous.
    org = await seedDemoOrg({
      orgSlug: ORG_SLUG,
      variant: "reserved",
      owner: {
        email: `owner@${ORG_SLUG}.example`,
        name: "Demo Owner",
        password: "Demo-Owner-Integration-9",
      },
    })
    first = await seedDemoSupport(org, { now: BASE_TIME })
    countsAfterFirst = await countsFor(org.orgId)
    second = await seedDemoSupport(org, { now: BASE_TIME })
    countsAfterSecond = await countsFor(org.orgId)
  }, 1_800_000)

  // ── The headline ─────────────────────────────────────────────────────────

  it("is idempotent: a second run changes no row count in any table it writes", () => {
    expect(countsAfterSecond).toEqual(countsAfterFirst)
  })

  it("resolves the same ids on the second run rather than creating twins", () => {
    expect(second.ticketIds.sort()).toEqual(first.ticketIds.sort())
    expect(second.contactIds.sort()).toEqual(first.contactIds.sort())
    expect(second.knowledgeDocumentIds.sort()).toEqual(first.knowledgeDocumentIds.sort())
    expect(second.projectIds.sort()).toEqual(first.projectIds.sort())
    expect(second.taskIds.sort()).toEqual(first.taskIds.sort())
    expect(second.calendarEventIds.sort()).toEqual(first.calendarEventIds.sort())
    expect(second.threadIds.sort()).toEqual(first.threadIds.sort())
    expect(second.mailConversationIds.sort()).toEqual(first.mailConversationIds.sort())
    expect(second.approvalIds.sort()).toEqual(first.approvalIds.sort())
  })

  it("actually wrote a world, so the idempotency check is not comparing two empties", () => {
    expect(countsAfterFirst.tickets).toBeGreaterThanOrEqual(30)
    expect(countsAfterFirst.ticketMessages).toBeGreaterThan(countsAfterFirst.tickets)
    expect(countsAfterFirst.knowledgeDocuments).toBeGreaterThanOrEqual(10)
    expect(countsAfterFirst.projects).toBeGreaterThanOrEqual(3)
    expect(countsAfterFirst.tasks).toBeGreaterThanOrEqual(20)
    expect(countsAfterFirst.taskDependencies).toBeGreaterThan(0)
    expect(countsAfterFirst.calendarEvents).toBeGreaterThanOrEqual(8)
    expect(countsAfterFirst.contacts).toBeGreaterThanOrEqual(26)
    expect(countsAfterFirst.mailConversations).toBeGreaterThanOrEqual(8)
    expect(countsAfterFirst.threadMessages).toBeGreaterThanOrEqual(15)
    expect(countsAfterFirst.approvals).toBeGreaterThanOrEqual(5)
  })

  // ── Readable through the product's own read paths ────────────────────────

  it("serves the ticket queue through the real search path, across the status vocabulary", async () => {
    const result = await withPrivilegedDb(org.orgId, "test-ticket-search", (tx) =>
      searchTickets(tx as never, org.orgId, { limit: 100 } as never),
    )
    const items = (
      result as unknown as {
        items: Array<{ status: string; assignedTo: string | null }>
      }
    ).items
    expect(items.length).toBeGreaterThanOrEqual(25)
    const statuses = new Set(items.map((t) => t.status as string))
    expect(statuses.has("open")).toBe(true)
    expect(statuses.has("awaiting_customer")).toBe(true)
    expect(statuses.has("awaiting_followup")).toBe(true)
    expect(statuses.has("closed")).toBe(true)
    // Several unassigned, most assigned: a queue, not a pile. The read path
    // returns the column as it is stored.
    const assignee = (t: Record<string, unknown>) => t.assigned_to ?? t.assignedTo ?? null
    expect(items.some((t) => assignee(t) === null)).toBe(true)
    expect(items.filter((t) => assignee(t) !== null).length).toBeGreaterThan(5)
  })

  it("closes tickets under distinct reasons and records CSAT responses", async () => {
    const rows = await withPrivilegedDb(org.orgId, "test-ticket-reasons", async (tx) => {
      const reasons = await tx.execute(
        sql`SELECT DISTINCT closed_reason FROM app_tickets.tickets
            WHERE org_id = ${org.orgId} AND closed_reason IS NOT NULL`,
      )
      const csat = await tx.execute(
        sql`SELECT score FROM app_tickets.ticket_csat
            WHERE org_id = ${org.orgId} AND status = 'responded'`,
      )
      const unwrap = (r: unknown) =>
        Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])
      return {
        reasons: unwrap(reasons).map((r) => (r as { closed_reason: string }).closed_reason),
        csatScores: unwrap(csat).map((r) => (r as { score: number }).score),
      }
    })
    expect(new Set(rows.reasons).size).toBeGreaterThanOrEqual(4)
    expect(rows.reasons).toContain("resolved")
    expect(rows.reasons).toContain("spam")
    expect(rows.reasons).toContain("merged")
    expect(rows.csatScores.length).toBeGreaterThanOrEqual(4)
  })

  it("renders a ticket thread with its agent replies and internal notes", async () => {
    const ticketId = await withPrivilegedDb(org.orgId, "test-find-ticket", async (tx) => {
      const r = await tx.execute(
        sql`SELECT id FROM app_tickets.tickets
            WHERE org_id = ${org.orgId} AND external_ref = 'demo:usb-dropout-diagnosis'`,
      )
      const list = Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])
      return (list[0] as { id: string }).id
    })
    const got = await withPrivilegedDb(org.orgId, "test-get-ticket", (tx) =>
      getTicket(tx as never, org.orgId, { ticketId, includeMessages: true } as never),
    )
    // The real read path returns the message columns as they are stored.
    const messages = (
      got as unknown as {
        messages?: { items: Array<{ kind: string; text_body: string | null }> }
      }
    ).messages?.items
    expect(messages).toBeDefined()
    const kinds = (messages as Array<{ kind: string }>).map((m) => m.kind)
    expect(kinds).toContain("inbound")
    expect(kinds).toContain("outbound")
    expect(kinds).toContain("note")
    // The bodies are real prose, not placeholders.
    for (const m of messages as Array<{ text_body: string | null }>) {
      expect((m.text_body ?? "").length).toBeGreaterThan(40)
    }
  })

  it("lists the knowledge base and puts the stale articles in the review queue", async () => {
    const amina = await userActor(org.orgId, org.peopleByKey.amina?.userId as string)
    const docs = await withRlsContext(amina, (tx) =>
      listKnowledgeDocuments(
        tx as never,
        knowledgeActorFromContext({
          orgId: amina.orgId,
          userId: amina.userId,
          scopes: amina.scopes,
          dimensionGrants: amina.dimensionGrants,
          roles: amina.roles ?? [],
        }),
        { limit: 200 },
      ),
    )
    expect(docs.length).toBeGreaterThanOrEqual(10)
    const titles = docs.map((d) => d.title)
    expect(titles).toContain("Warranty policy")
    expect(titles).toContain("Dealer pricing tiers")
    expect(titles).toContain("Tone of voice")

    const staleIds = await withPrivilegedDb(org.orgId, "test-stale-ids", async (tx) => {
      const r = await tx.execute(
        sql`SELECT id FROM app_knowledge.documents
            WHERE org_id = ${org.orgId}
              AND title IN ('Shipping timelines and carrier exceptions', 'When to escalate, and to whom')`,
      )
      const list = Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])
      return list.map((x) => (x as { id: string }).id)
    })
    expect(staleIds.length).toBe(2)

    const queue = await withPrivilegedDb(org.orgId, "test-review-queue", (tx) =>
      computeAttentionItems(tx as never, org.orgId, amina.userId, BASE_TIME),
    )
    expect(queue.length).toBeGreaterThanOrEqual(2)
    const queued = JSON.stringify(queue)
    // Both articles whose review date the seeder put in the PAST have to
    // actually surface in the queue the product renders.
    for (const id of staleIds) expect(queued).toContain(id)
  })

  it("serves each project's task tree, with overdue work and dependencies", async () => {
    const elodie = await userActor(org.orgId, org.adminUserId)
    for (const projectId of first.projectIds) {
      const listed = await withRlsContext(elodie, (tx) =>
        listProjectTasks({ tx: tx as never, orgId: org.orgId, projectId, limit: 100 }),
      )
      expect(listed.items.length).toBeGreaterThan(0)
    }
    // `overdue` is computed by the read path in SQL (past due date, status not
    // terminal), so this asserts what the board would actually render.
    let overdueSeen = 0
    for (const projectId of first.projectIds) {
      const listed = await withRlsContext(elodie, (tx) =>
        listProjectTasks({ tx: tx as never, orgId: org.orgId, projectId, limit: 100 }),
      )
      overdueSeen += listed.items.filter(
        (t) => (t as { overdue?: boolean }).overdue === true,
      ).length
    }
    expect(overdueSeen).toBeGreaterThan(0)
    expect(first.counts.tasksOverdue).toBeGreaterThan(0)
  })

  it("serves the working week through the calendar read path, recurrence expanded", async () => {
    const elodie = await userActor(org.orgId, org.adminUserId)
    const events = await withRlsContext(elodie, (tx) =>
      listEventsForCaller(tx as never, org.orgId, {
        timeMin: new Date(BASE_TIME.getTime() - 7 * 86_400_000).toISOString(),
        timeMax: new Date(BASE_TIME.getTime() + 14 * 86_400_000).toISOString(),
      } as never),
    )
    const titles = events.map((e) => (e as { title?: string }).title)
    expect(titles).toContain("Preamp launch: go or no go")
    expect(titles).toContain("Team offsite")
    const allDay = events.filter((e) => (e as { allDay?: boolean }).allDay === true)
    expect(allDay.length).toBeGreaterThanOrEqual(1)

    // The recurring series is stored as ONE master carrying an RRULE:
    // `list_events` deliberately returns the master and leaves expansion to the
    // product's own expander. What matters for the demo is that the rule is one
    // the expander SUPPORTS: a rule it calls "complex" collapses the whole
    // series to a single occurrence, and the calendar looks empty all week.
    const master = await withPrivilegedDb(org.orgId, "test-standup-master", async (tx) => {
      const r = await tx.execute(
        sql`SELECT id, calendar_id, google_event_id, title, description, location,
                   start, "end", all_day, recurrence, recurring_event_id,
                   original_start_time, status, hangout_link
            FROM app_calendar.events
            WHERE org_id = ${org.orgId} AND title = 'Morning standup'`,
      )
      const list = Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])
      return list[0] as Parameters<typeof expandRecurringEvent>[0]
    })
    expect(master).toBeDefined()
    const occurrences = expandRecurringEvent(
      master,
      [],
      new Date(BASE_TIME.getTime() - 7 * 86_400_000),
      new Date(BASE_TIME.getTime() + 14 * 86_400_000),
    )
    expect(occurrences.length).toBeGreaterThan(3)
  })

  it("serves contacts and finds the deliberate duplicate pairs", async () => {
    const elodie = await userActor(org.orgId, org.adminUserId)
    const listed = await withRlsContext(elodie, (tx) =>
      listContacts(tx as never, { orgId: org.orgId, page: 1, limit: 200, mode: "all" }),
    )
    const rows = (listed as unknown as { rows: Array<{ id: string }> }).rows
    expect(rows.length).toBeGreaterThanOrEqual(26)

    const dupes = await withRlsContext(elodie, (tx) =>
      findDuplicateClusters(tx as never, { orgId: org.orgId }),
    )
    expect(dupes.clusters.length).toBeGreaterThanOrEqual(1)
    const clusteredIds = new Set(
      dupes.clusters.flatMap((c) => c.contacts.map((x) => (x as { id: string }).id)),
    )
    // Every pair the seeder planted has to actually be found by the detector,
    // otherwise the merge flow has nothing to demonstrate.
    const foundPairs = first.duplicateContactPairs.filter(
      ([a, b]) => clusteredIds.has(a) && clusteredIds.has(b),
    )
    expect(foundPairs.length).toBe(first.duplicateContactPairs.length)
  })

  it("records each dealer's and customer's world country as their recipient country", async () => {
    // Mutation caught: no seeded contact had a recipient country, so the send check never knew one.
    const row = await withPrivilegedDb(org.orgId, "demo-support-test-country", async (tx) => {
      const result = await tx.execute(
        sql`SELECT count(*) FILTER (WHERE metadata->>'country' IS NOT NULL)::int AS named,
                   count(*) FILTER (WHERE metadata->>'country' IS NOT NULL
                     AND recipient_country = upper(metadata->>'country'))::int AS recorded
              FROM kernel.contacts WHERE org_id = ${org.orgId}`,
      )
      const list = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
      return list[0] as { named: number; recorded: number } | undefined
    })
    expect(Number(row?.named)).toBeGreaterThanOrEqual(20)
    expect(Number(row?.recorded)).toBe(Number(row?.named))
  })

  it("serves thread history, including a role agent's own turns", async () => {
    const amina = await userActor(org.orgId, org.peopleByKey.amina?.userId as string)
    const threadId = await withPrivilegedDb(org.orgId, "test-find-thread", async (tx) => {
      const r = await tx.execute(
        sql`SELECT id FROM kernel.threads
            WHERE org_id = ${org.orgId} AND title = 'Morning triage with the support desk'`,
      )
      const list = Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])
      return (list[0] as { id: string }).id
    })
    const listed = await withRlsContext(amina, (tx) =>
      listMessages(
        tx as never,
        {
          orgId: org.orgId,
          userId: amina.userId,
          threadId,
          limit: 50,
        } as never,
      ),
    )
    const messages = (listed as { messages: Array<{ authorType: string; content: string }> })
      .messages
    expect(messages.length).toBeGreaterThanOrEqual(4)
    expect(messages.some((m) => m.authorType === "agent")).toBe(true)
    expect(messages.some((m) => m.authorType === "user")).toBe(true)
  })

  it("pins exactly one thread", async () => {
    const pinned = await withPrivilegedDb(org.orgId, "test-pinned", async (tx) => {
      const r = await tx.execute(
        sql`SELECT title FROM kernel.threads WHERE org_id = ${org.orgId} AND is_pinned = true`,
      )
      const list = Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])
      return list.map((x) => (x as { title: string }).title)
    })
    expect(pinned).toEqual(["Preamp launch readiness"])
  })

  it("leaves every demo mailbox unarmed, so its content is readable", async () => {
    const state = await withPrivilegedDb(org.orgId, "test-mail-posture", async (tx) => {
      const r = await tx.execute(
        sql`SELECT a.id, a.owner_type, a.owner_id,
                   app_mail.mailbox_invariant_armed(a.id) AS armed,
                   (SELECT count(*) FROM app_mail.messages m
                     WHERE m.account_id = a.id AND m.text_body IS NOT NULL) AS readable
            FROM app_mail.accounts a WHERE a.org_id = ${org.orgId}`,
      )
      const list = Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])
      return list as Array<{ owner_type: string; armed: boolean; readable: string | number }>
    })
    expect(state.length).toBeGreaterThanOrEqual(4)
    // The shared desk mailbox is org owned, which can NEVER arm by construction.
    expect(state.some((a) => a.owner_type === "org")).toBe(true)
    expect(state.some((a) => a.owner_type === "user")).toBe(true)
    for (const account of state) {
      expect(account.armed).toBe(false)
      expect(Number(account.readable)).toBeGreaterThan(0)
    }
  })

  it("leaves pending and decided approvals of genuinely different kinds", async () => {
    const rows = await withPrivilegedDb(org.orgId, "test-approvals", async (tx) => {
      const r = await tx.execute(
        sql`SELECT status, tool_name, decided_by FROM kernel.approval_requests
            WHERE org_id = ${org.orgId}`,
      )
      const list = Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])
      return list as Array<{ status: string; tool_name: string; decided_by: string | null }>
    })
    const pending = rows.filter((r) => r.status === "pending")
    const decided = rows.filter((r) => r.status !== "pending")
    expect(pending.length).toBeGreaterThanOrEqual(3)
    expect(decided.length).toBeGreaterThanOrEqual(2)
    expect(new Set(rows.map((r) => r.tool_name)).size).toBeGreaterThanOrEqual(4)
    for (const row of decided) expect(row.decided_by).not.toBeNull()
    for (const row of pending) expect(row.decided_by).toBeNull()
  })

  // A reseed notifies nobody: every approval and conversation message the seed
  // writes says it was seeded, which is what the push fanout, the attention
  // translator and the state materializer stay silent on
  // (apps/api/src/modules/notifications/seeded.ts). Before, each reseed sent
  // about eight approval pushes to every phone signed into the org.
  it("marks every approval and conversation message it writes as seeded", async () => {
    const unmarked = await withPrivilegedDb(org.orgId, "test-seeded-marks", async (tx) => {
      const r = await tx.execute(
        sql`SELECT
              (SELECT count(*) FROM kernel.approval_requests
                WHERE org_id = ${org.orgId} AND metadata->>'seeded' IS DISTINCT FROM 'true')
                AS approvals,
              (SELECT count(*) FROM kernel.messages
                WHERE org_id = ${org.orgId} AND metadata->>'seeded' IS DISTINCT FROM 'true')
                AS messages,
              (SELECT count(*) FROM kernel.approval_requests WHERE org_id = ${org.orgId})
                AS total`,
      )
      const list = Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])
      return list[0] as {
        approvals: string | number
        messages: string | number
        total: string | number
      }
    })
    expect(Number(unmarked.total)).toBeGreaterThan(0)
    expect(Number(unmarked.approvals)).toBe(0)
    expect(Number(unmarked.messages)).toBe(0)
  })

  // Home's "Open ticket" follows the payload's ticketId (attention.ts derives
  // openTarget from it); a seeded ticket approval without one sent the
  // reviewer to the agent's working thread.
  it("points every ticket approval at a ticket of the same org", async () => {
    const rows = await withPrivilegedDb(org.orgId, "test-ticket-approvals", async (tx) => {
      const r = await tx.execute(
        sql`SELECT a.handle, a.current_payload->>'ticketId' AS ticket_id, t.subject
            FROM kernel.approval_requests a
            LEFT JOIN app_tickets.tickets t
              ON t.id = (a.current_payload->>'ticketId')::uuid AND t.org_id = a.org_id
            WHERE a.org_id = ${org.orgId} AND a.tool_name LIKE 'tickets:%'
              -- A bulk action spans many tickets and names none (the seed's own
              -- assertTicketApprovalsResolve skips it the same way).
              AND a.tool_name NOT LIKE 'tickets:bulk%'`,
      )
      const list = Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])
      return list as Array<{ handle: string; ticket_id: string | null; subject: string | null }>
    })
    expect(rows.length).toBeGreaterThanOrEqual(1)
    for (const row of rows) {
      expect(row.ticket_id, `${row.handle} carries no ticketId`).toBeString()
      expect(row.subject, `${row.handle} names a ticket that does not exist`).toBeString()
    }
    const reply = rows.find((r) => r.handle === "demo-reply-kestrel-10-replacement")
    expect(reply?.subject).toBe("New Kestrel 10 does not power on at all")
  })

  // Every person a ticket approval notifies reads that ticket through their
  // own RLS: the Kestrel 10 reply is the support queue's, so it notifies the
  // support desk and never the finance desk, which cannot open it.
  it("notifies only people who can open the ticket an approval acts on", async () => {
    const rows = await withPrivilegedDb(org.orgId, "test-ticket-approval-notify", async (tx) => {
      const r = await tx.execute(
        sql`SELECT handle, current_payload->>'ticketId' AS ticket_id,
                   notify_user_ids::text[] AS notify
            FROM kernel.approval_requests
            WHERE org_id = ${org.orgId} AND tool_name LIKE 'tickets:%'
              AND current_payload ? 'ticketId'`,
      )
      const list = Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])
      return list as Array<{ handle: string; ticket_id: string; notify: string[] }>
    })
    expect(rows.length).toBeGreaterThanOrEqual(1)
    const canRead = async (userId: string, ticketId: string): Promise<boolean> => {
      const actor = await userActor(org.orgId, userId)
      return withRlsContext(actor, async (tx) => {
        const r = await tx.execute(
          sql`SELECT id FROM app_tickets.tickets WHERE id = ${ticketId}::uuid`,
        )
        const list = Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])
        return list.length > 0
      })
    }
    for (const row of rows) {
      for (const userId of row.notify) {
        expect(await canRead(userId, row.ticket_id), `${row.handle} notifies ${userId}`).toBe(true)
      }
    }
    const henrik = org.peopleByKey.henrik?.userId as string
    const reply = rows.find((r) => r.handle === "demo-reply-kestrel-10-replacement")
    expect(await canRead(henrik, reply?.ticket_id as string)).toBe(false)
    expect(reply?.notify).not.toContain(henrik)
  })

  // A desk sees its own team's queue. Before desks held their team, every
  // team-tagged ticket was hidden from everyone but the admin and the owner.
  it("lets each desk read its own team's tickets and not another desk's", async () => {
    const byTeam = await withPrivilegedDb(org.orgId, "test-tickets-by-team", async (tx) => {
      const r = await tx.execute(
        sql`SELECT team, array_agg(id::text ORDER BY id) AS ids
            FROM app_tickets.tickets WHERE org_id = ${org.orgId} GROUP BY team`,
      )
      const list = Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])
      return new Map(
        (list as Array<{ team: string; ids: string[] }>).map((row) => [row.team, row.ids]),
      )
    })
    const visibleTo = async (personKey: string): Promise<Set<string>> => {
      const actor = await userActor(org.orgId, org.peopleByKey[personKey]?.userId as string)
      return withRlsContext(actor, async (tx) => {
        const r = await tx.execute(sql`SELECT id::text AS id FROM app_tickets.tickets`)
        const list = Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])
        return new Set((list as Array<{ id: string }>).map((row) => row.id))
      })
    }
    const support = byTeam.get("support") ?? []
    const finance = byTeam.get("finance") ?? []
    const operations = byTeam.get("operations") ?? []
    expect(support.length).toBeGreaterThan(0)
    expect(finance.length).toBeGreaterThan(0)
    expect(operations.length).toBeGreaterThan(0)

    // A support-desk person reads every support ticket, assigned to them or not.
    const lucas = await visibleTo("lucas")
    for (const id of support) expect(lucas.has(id)).toBe(true)
    for (const id of finance) expect(lucas.has(id)).toBe(false)

    // The finance desk reads finance and nothing outside it.
    const henrik = await visibleTo("henrik")
    for (const id of finance) expect(henrik.has(id)).toBe(true)
    for (const id of [...support, ...operations]) expect(henrik.has(id)).toBe(false)

    // Fulfillment is the operations team.
    const margot = await visibleTo("margot")
    for (const id of operations) expect(margot.has(id)).toBe(true)
    for (const id of support) expect(margot.has(id)).toBe(false)
  })

  // ── What a phone tour walks through ──────────────────────────────────────

  it("carries a ticket that reads as a real conversation, seven messages and both sides", async () => {
    const thread = await withPrivilegedDb(org.orgId, "test-long-ticket", async (tx) => {
      const r = await tx.execute(
        sql`SELECT m.kind, m.text_body, m.sent_at
            FROM app_tickets.messages m
            JOIN app_tickets.tickets t ON t.id = m.ticket_id
            WHERE t.org_id = ${org.orgId} AND t.external_ref = 'demo:dealer-repair-chase'
            ORDER BY m.sent_at ASC`,
      )
      const list = Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])
      return list as Array<{ kind: string; text_body: string | null }>
    })
    expect(thread.length).toBeGreaterThanOrEqual(7)
    const kinds = thread.map((m) => m.kind)
    // Not one side talking: inbound, outbound AND an internal note, and the
    // first word is the customer's.
    expect(kinds[0]).toBe("inbound")
    expect(kinds).toContain("outbound")
    expect(kinds).toContain("note")
    expect(kinds.filter((k) => k === "inbound").length).toBeGreaterThanOrEqual(3)
    expect(kinds.filter((k) => k === "outbound").length).toBeGreaterThanOrEqual(3)
    // Paragraphs, not one liners: this is the ticket a tour opens on a phone.
    for (const m of thread) expect((m.text_body ?? "").length).toBeGreaterThan(120)
  })

  it("carries a mail conversation with a full exchange in both directions", async () => {
    const rows = await withPrivilegedDb(org.orgId, "test-long-mail", async (tx) => {
      const r = await tx.execute(
        sql`SELECT c.id, c.message_count,
                   (SELECT count(*) FROM app_mail.messages m WHERE m.conversation_id = c.id) AS stored,
                   (SELECT count(DISTINCT m.direction) FROM app_mail.messages m
                     WHERE m.conversation_id = c.id) AS directions,
                   (SELECT min(length(m.text_body)) FROM app_mail.messages m
                     WHERE m.conversation_id = c.id) AS shortest
            FROM app_mail.conversations c
            WHERE c.org_id = ${org.orgId}
            ORDER BY (SELECT count(*) FROM app_mail.messages m WHERE m.conversation_id = c.id) DESC
            LIMIT 1`,
      )
      const list = Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])
      return list[0] as {
        message_count: number
        stored: string | number
        directions: string | number
        shortest: string | number
      }
    })
    expect(Number(rows.stored)).toBeGreaterThanOrEqual(5)
    // The conversation header has to agree with the messages under it, or the
    // list renders a count the thread does not have.
    expect(Number(rows.message_count)).toBe(Number(rows.stored))
    expect(Number(rows.directions)).toBe(2)
    expect(Number(rows.shortest)).toBeGreaterThan(150)
  })

  it("leaves a pending skill update carrying a whole playbook to read", async () => {
    const rows = await withPrivilegedDb(org.orgId, "test-skill-approval", async (tx) => {
      const r = await tx.execute(
        sql`SELECT status, tool_name, tool_params, current_payload
            FROM kernel.approval_requests
            WHERE org_id = ${org.orgId} AND tool_name = 'kernel:update_skill'`,
      )
      const list = Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])
      return list as Array<{
        status: string
        tool_params: { id?: string; body?: string }
        current_payload: { body?: string }
      }>
    })
    expect(rows.length).toBe(1)
    const row = rows[0] as (typeof rows)[number]
    expect(row.status).toBe("pending")
    // The point of the fixture: a card with a real document on it.
    expect((row.tool_params.body ?? "").length).toBeGreaterThan(2000)
    expect((row.current_payload.body ?? "").length).toBe((row.tool_params.body ?? "").length)
    // The real tool takes the skill's uuid, so the fixture has to as well or
    // the card cannot hydrate the skill it is editing.
    expect(row.tool_params.id).toMatch(/^[0-9a-f-]{36}$/)

    const pending = await withPrivilegedDb(org.orgId, "test-pending-count", async (tx) => {
      const r = await tx.execute(
        sql`SELECT count(*) AS count FROM kernel.approval_requests
            WHERE org_id = ${org.orgId} AND status = 'pending'`,
      )
      const list = Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])
      return Number((list[0] as { count: string | number }).count)
    })
    expect(pending).toBeGreaterThanOrEqual(7)
  })

  it("opens a discoverable channel, described, that the owner has not joined", async () => {
    expect(org.ownerUserId).not.toBeNull()
    const rows = await withPrivilegedDb(org.orgId, "test-discoverable", async (tx) => {
      const r = await tx.execute(
        sql`SELECT t.title, t.topic, t.description,
                   EXISTS (
                     SELECT 1 FROM kernel.thread_participants p
                      WHERE p.thread_id = t.id AND p.user_id = ${org.ownerUserId}::uuid
                   ) AS owner_in
            FROM kernel.threads t
            WHERE t.org_id = ${org.orgId} AND t.discoverable = true`,
      )
      const list = Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])
      return list as Array<{
        title: string
        topic: string | null
        description: string | null
        owner_in: boolean
      }>
    })
    expect(rows.length).toBeGreaterThanOrEqual(1)
    const open = rows.filter((c) => c.owner_in === false)
    // A channel browser with nothing in it is the thing this fixture exists to
    // prevent: a room the owner can SEE and has not joined.
    expect(open.length).toBeGreaterThanOrEqual(1)
    for (const channel of open) {
      expect((channel.topic ?? "").length).toBeGreaterThan(20)
      expect((channel.description ?? "").length).toBeGreaterThan(120)
    }
  })

  it("describes its channels and lets a role agent speak in them", async () => {
    const rows = await withPrivilegedDb(org.orgId, "test-channel-details", async (tx) => {
      const r = await tx.execute(
        sql`SELECT t.title, t.topic, t.description,
                   (SELECT count(*) FROM kernel.messages m
                     WHERE m.thread_id = t.id AND m.author_agent_id IS NOT NULL) AS agent_turns
            FROM kernel.threads t
            WHERE t.org_id = ${org.orgId} AND t.topic IS NOT NULL AND t.description IS NOT NULL`,
      )
      const list = Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])
      return list as Array<{ title: string; agent_turns: string | number }>
    })
    expect(rows.length).toBeGreaterThanOrEqual(3)
    expect(rows.filter((c) => Number(c.agent_turns) > 0).length).toBeGreaterThanOrEqual(2)
  })

  it("gives the owner DM shaped rooms with an agent that answers in them", async () => {
    const ownerUserId = org.ownerUserId as string
    expect(ownerUserId).toBeTruthy()
    const rows = await withPrivilegedDb(org.orgId, "test-agent-dms", async (tx) => {
      const r = await tx.execute(
        // The DM shape, read out of the tables rather than asserted from the
        // seeder: untitled, unpinned, not anchored to an entity, exactly one
        // human seat and exactly one AGENT seat (modules/threads/dm-shape.ts).
        sql`SELECT t.id,
                   (SELECT count(*) FROM kernel.thread_participants p
                     WHERE p.thread_id = t.id AND p.participant_type = 'user') AS humans,
                   (SELECT count(*) FROM kernel.thread_participants p
                     WHERE p.thread_id = t.id AND p.participant_type = 'agent'
                       AND p.agent_id IS NOT NULL) AS agents,
                   (SELECT count(*) FROM kernel.messages m WHERE m.thread_id = t.id) AS total,
                   (SELECT count(*) FROM kernel.messages m
                     WHERE m.thread_id = t.id AND m.author_agent_id IS NOT NULL) AS agent_turns
            FROM kernel.threads t
            WHERE t.org_id = ${org.orgId}
              AND t.title IS NULL AND t.is_pinned = false
              AND t.type = 'agent_chat' AND t.created_from IS NULL
              AND t.created_by = ${ownerUserId}::uuid
              AND EXISTS (
                SELECT 1 FROM kernel.thread_participants p
                 WHERE p.thread_id = t.id AND p.user_id = ${ownerUserId}::uuid
              )`,
      )
      const list = Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])
      return list as Array<{
        humans: string | number
        agents: string | number
        total: string | number
        agent_turns: string | number
      }>
    })
    const dms = rows.filter((t) => Number(t.humans) === 1 && Number(t.agents) === 1)
    expect(dms.length).toBeGreaterThanOrEqual(2)
    for (const dm of dms) {
      // A real exchange, and the agent's half is AUTHORED by the agent.
      expect(Number(dm.total)).toBeGreaterThanOrEqual(4)
      expect(Number(dm.agent_turns)).toBeGreaterThanOrEqual(2)
      expect(Number(dm.agent_turns)).toBeLessThan(Number(dm.total))
    }
  })

  // Direct messages listed two "Support Desk" rows and two "Liaison" rows on
  // the demo box, with nothing to tell them apart. The seeder minted its own
  // untitled `thread` with an agent seat and looked it up by (title IS NULL,
  // created_by, agent seat); the product reads a DM strictly as an
  // `agent_chat` with exactly one human, so the first press of Message made a
  // SECOND conversation. The seeder goes through the product's own
  // find-or-create now, which makes the two agree on the natural key.
  it("leaves exactly one DM per agent, and the product's own find-or-create adopts it", async () => {
    const ownerUserId = org.ownerUserId as string
    const perAgent = await withPrivilegedDb(org.orgId, "test-dm-per-agent", async (tx) => {
      const r = await tx.execute(
        sql`SELECT seat.agent_id, count(*) AS rooms
            FROM kernel.threads t
            JOIN kernel.thread_participants seat
              ON seat.thread_id = t.id AND seat.agent_id IS NOT NULL
            JOIN kernel.thread_participants me
              ON me.thread_id = t.id AND me.user_id = ${ownerUserId}::uuid
            WHERE t.org_id = ${org.orgId} AND t.type = 'agent_chat'
              AND (SELECT count(*) FROM kernel.thread_participants p
                    WHERE p.thread_id = t.id AND p.user_id IS NOT NULL) = 1
            GROUP BY seat.agent_id`,
      )
      const list = Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])
      return list as Array<{ agent_id: string; rooms: string | number }>
    })
    // `first` and `second` are two full seeder runs: after both, still one.
    expect(perAgent.length).toBeGreaterThanOrEqual(2)
    for (const row of perAgent) expect(Number(row.rooms)).toBe(1)

    // And the button the owner presses lands in that same room rather than
    // minting a twin beside it.
    const owner = await userActor(org.orgId, ownerUserId)
    for (const row of perAgent) {
      const dm = await withRlsContext(owner, (tx) =>
        createOrGetAgentDm(tx as never, {
          orgId: org.orgId,
          userId: ownerUserId,
          agentId: row.agent_id,
        }),
      )
      expect(dm?.created).toBe(false)
    }
  })

  it("dates everything relative to the base time, so the world reads as freshly active", async () => {
    expect(first.seededAt).toBe(BASE_TIME.toISOString())
    const spread = await withPrivilegedDb(org.orgId, "test-recency", async (tx) => {
      const r = await tx.execute(
        sql`SELECT
              count(*) FILTER (WHERE created_at > ${BASE_TIME.toISOString()}::timestamptz - interval '6 hours') AS fresh,
              count(*) FILTER (WHERE created_at < ${BASE_TIME.toISOString()}::timestamptz - interval '14 days') AS old
            FROM app_tickets.tickets WHERE org_id = ${org.orgId}`,
      )
      const list = Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])
      return list[0] as { fresh: string | number; old: string | number }
    })
    expect(Number(spread.fresh)).toBeGreaterThan(0)
    expect(Number(spread.old)).toBeGreaterThan(0)
  })
})
