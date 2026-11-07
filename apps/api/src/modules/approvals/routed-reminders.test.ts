// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A ROUTED ROW IS NOT LOST. A request routed to one person, or one only a person may sign, that
// is still undecided after a day tells every one of its deciders, once, and stays where it was.
// The sweep reads the same route and the same deciders as Home, so it names nobody who cannot
// already see the row.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql } from "~/db/connection"
import { toolRegistry } from "~/modules/apps/app-registries"
import { insertSql } from "~/seed/factories/org/test-rows"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { runRoutedReminderSweep } from "./routed-reminders"

const SIGNED_ONLY_BY_A_PERSON = "fixture:ship"

let ORG = ""
let THREAD = ""
const people: Record<string, string> = {}

type Waited = "23h59" | "24h01"
const AGE: Record<Waited, string> = {
  "23h59": "now() - INTERVAL '23 hours 59 minutes'",
  "24h01": "now() - INTERVAL '24 hours 1 minute'",
}

async function insertRow(spec: {
  tool?: string
  waited: Waited
  notify: string[]
  routePersonId?: string | null
  resourceOwner?: string | null
  title: string
}): Promise<string> {
  const id = randomUUID()
  await sql.unsafe(
    insertSql("kernel.approval_requests", {
      id,
      org_id: ORG,
      handle: `APR-${id.slice(0, 8)}`,
      thread_id: THREAD,
      originating_thread_id: THREAD,
      tool_name: spec.tool ?? "projects:createTask",
      tool_params: "{}",
      current_payload: JSON.stringify({ title: spec.title }),
      expires_at: { raw: "now() + INTERVAL '3 days'" },
      created_at: { raw: AGE[spec.waited] },
      notify_user_ids: `{${spec.notify.join(",")}}`,
      requested_by: people.ines as string,
      status: "pending",
      summary: JSON.stringify({ title: spec.title }),
      // A routine's request: the requester is not a candidate, so the person on the item is.
      metadata: JSON.stringify({ originRoutineId: randomUUID() }),
      resource_owner_id: spec.resourceOwner ?? null,
      route_person_id: spec.routePersonId ?? null,
    }),
  )
  return id
}

interface Reminder {
  targets: string[]
  summary: string
  link: { tabType: string; entityId: string } | undefined
  marker: { approvalId: string; hours: number } | undefined
}

/** The reminders queued for one request, as the attention pipeline will deliver them. */
async function remindersFor(rowId: string): Promise<Reminder[]> {
  const rows = await sql<
    {
      payload: {
        data: {
          targetUserIds: string[]
          summary: string
          link?: { tabType: string; entityId: string }
          routedReminder?: { approvalId: string; hours: number }
        }
      }
    }[]
  >`
    SELECT payload FROM kernel.pending_events
     WHERE org_id = ${ORG}::uuid
       AND payload->>'entity' = 'agent_notification'
       AND payload->>'entityId' = ${rowId}`
  return rows.map((r) => ({
    targets: [...r.payload.data.targetUserIds].sort(),
    summary: r.payload.data.summary,
    link: r.payload.data.link,
    marker: r.payload.data.routedReminder,
  }))
}

async function rowOf(rowId: string) {
  const [row] = await sql<Record<string, unknown>[]>`
    SELECT * FROM kernel.approval_requests WHERE id = ${rowId}::uuid`
  return row as Record<string, unknown>
}

const sorted = (...ids: (string | undefined)[]) => ids.filter(Boolean).sort() as string[]

describe("routed reminders: a routed row is not lost", () => {
  const rows: Record<string, string> = {}

  beforeAll(async () => {
    await acquireTestLock()
    ORG = (await createTestOrg()).id
    for (const name of ["ines", "tom", "sara", "owner", "lea"]) {
      people[name] = (await minimal.person(ORG, { name: `Fixture ${name}` })).id
    }
    for (const name of ["ines", "tom", "sara", "owner"]) {
      await minimal.grantScope(people[name] as string, "projects:approve")
      await minimal.grantScope(people[name] as string, "fixture:approve")
    }
    THREAD = await minimal.thread(ORG, people.ines as string, { title: "Reminder fixtures" })
    toolRegistry.set([ORG, "fixture", "ship"], {
      appName: "fixture",
      name: "ship",
      description: "A shipment only a person may sign",
      requiredScopes: ["fixture:write"],
      gated: true,
      noAutoApprove: true,
      handler: async () => ({ ok: true }),
    } as never)

    const deciders = sorted(people.ines, people.tom, people.sara)
    // `lea` is on the notify set but holds no deciding scope: not a decider.
    const withLea = sorted(...deciders, people.lea)
    rows.onItemLate = await insertRow({
      waited: "24h01",
      notify: withLea,
      routePersonId: people.tom as string,
      title: "On the item, a day and a minute",
    })
    rows.onItemEarly = await insertRow({
      waited: "23h59",
      notify: deciders,
      routePersonId: people.tom as string,
      title: "On the item, a minute short of a day",
    })
    rows.usual = await insertRow({
      waited: "24h01",
      notify: deciders,
      title: "Usual deciders, nothing marks it",
    })
    rows.noAutoApprove = await insertRow({
      tool: SIGNED_ONLY_BY_A_PERSON,
      waited: "24h01",
      notify: deciders,
      title: "Only a person may sign",
    })
    rows.ownerPrivate = await insertRow({
      tool: SIGNED_ONLY_BY_A_PERSON,
      waited: "24h01",
      notify: sorted(people.owner, people.tom),
      resourceOwner: people.owner as string,
      title: "Private to its owner",
    })
  }, 180_000)

  afterAll(async () => {
    await releaseTestLock()
  })

  it("an on_item row without noAutoApprove, person not away, notifies every decider once at 24 h 01, none at 23 h 59, none on the second sweep", async () => {
    const first = await runRoutedReminderSweep({ orgId: ORG })
    expect(first.notified).toBeGreaterThan(0)

    const late = await remindersFor(rows.onItemLate as string)
    expect(late).toHaveLength(1)
    // The deciders of the row: the notify set that holds its scope, never `lea`.
    expect(late[0]?.targets).toEqual(sorted(people.ines, people.tom, people.sara))
    expect(await remindersFor(rows.onItemEarly as string)).toHaveLength(0)

    await runRoutedReminderSweep({ orgId: ORG })
    expect(await remindersFor(rows.onItemLate as string)).toHaveLength(1)
  })

  it("a noAutoApprove row the same", async () => {
    const reminders = await remindersFor(rows.noAutoApprove as string)
    expect(reminders).toHaveLength(1)
    expect(reminders[0]?.targets).toEqual(sorted(people.ines, people.tom, people.sara))
    await runRoutedReminderSweep({ orgId: ORG })
    expect(await remindersFor(rows.noAutoApprove as string)).toHaveLength(1)
  })

  it("a usual row without noAutoApprove none", async () => {
    expect(await remindersFor(rows.usual as string)).toHaveLength(0)
  })

  it("an owner's private row reminds the owner alone, never the people it was not for", async () => {
    const reminders = await remindersFor(rows.ownerPrivate as string)
    expect(reminders).toHaveLength(1)
    expect(reminders[0]?.targets).toEqual([people.owner as string])
  })

  it("a reminder says what waits and for how long, and nothing the deciders cannot already read", async () => {
    const [reminder] = await remindersFor(rows.onItemLate as string)
    expect(reminder?.summary).toContain("On the item, a day and a minute")
    expect(reminder?.summary).toContain("24 hours")
  })

  it("a reminder opens the request's own conversation and carries the marker the row is translated from", async () => {
    const [reminder] = await remindersFor(rows.onItemLate as string)
    expect(reminder?.link).toEqual({ tabType: "thread", entityId: THREAD })
    expect(reminder?.marker).toEqual({ approvalId: rows.onItemLate as string, hours: 24 })
  })

  it("the row's placement does not change", async () => {
    const before = await rowOf(rows.onItemEarly as string)
    // A row that has not been reminded keeps every column; one that was keeps all but the marker.
    await runRoutedReminderSweep({ orgId: ORG })
    expect(await rowOf(rows.onItemEarly as string)).toEqual(before)

    const reminded = await rowOf(rows.onItemLate as string)
    expect((reminded.metadata as Record<string, unknown>).routedReminderAt).toBeString()
    expect(reminded.status).toBe("pending")
    expect(reminded.route_person_id).toBe(people.tom as string)
    expect(reminded.notify_user_ids).toEqual(
      expect.arrayContaining(sorted(people.ines, people.tom, people.sara, people.lea)),
    )
  })

  it("two workers sweeping at once send it once", async () => {
    const id = await insertRow({
      waited: "24h01",
      notify: sorted(people.ines, people.tom, people.sara),
      routePersonId: people.sara as string,
      title: "Swept by two workers",
    })
    await Promise.all([
      runRoutedReminderSweep({ orgId: ORG }),
      runRoutedReminderSweep({ orgId: ORG }),
    ])
    expect(await remindersFor(id)).toHaveLength(1)
  })
})
