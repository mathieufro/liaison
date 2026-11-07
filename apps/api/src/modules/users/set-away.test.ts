// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Saying you are away, through the real tool dispatch (executeTool: params, scopes, the
// outside-text gate, then the handler) and the one writer behind it.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { autoApprovePolicies } from "~/db/schema/kernel"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import { ApprovalDecisionError, decideApproval } from "~/modules/approvals/decide"
import { executeTool } from "~/modules/apps/execute-tool"
import { seedMcpConnection } from "~/modules/mcp/test-helpers"
import { handleToolCall } from "~/modules/mcp/tool-call"
import {
  AwayRefusal,
  dayLabel,
  endAwayRange,
  pruneAwayRanges,
  readAwayToday,
  resolveAwayDates,
  setAway,
  undoAway,
} from "~/modules/users/away"
import { deactivateUser } from "~/modules/users/service"
import { insertSql } from "~/seed/factories/org/test-rows"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
const todayUtc = () => new Date().toISOString().slice(0, 10)
/** A Monday at least two weeks ahead, so every zone agrees it is in the future. */
function futureMonday(): string {
  let d = addDays(todayUtc(), 14)
  while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) d = addDays(d, 1)
  return d
}

describe("resolveAwayDates: forms read on the server", () => {
  const today = "2026-11-04" // a Wednesday

  it("week form resolves on the server to Monday through Sunday", () => {
    expect(resolveAwayDates({ week: 48 }, today)).toEqual({
      kind: "range",
      startsOn: "2026-11-23",
      endsOn: "2026-11-29",
    })
    // A week of this year that has ended means next year's.
    expect(resolveAwayDates({ week: 2 }, today)).toMatchObject({ startsOn: "2027-01-11" })
    // The current week has not ended: this year's.
    expect(resolveAwayDates({ week: 45 }, today)).toMatchObject({ startsOn: "2026-11-02" })
  })

  it("MM-DD means the next one on or after today", () => {
    expect(resolveAwayDates({ on: "11-04" }, today)).toMatchObject({ startsOn: "2026-11-04" })
    expect(resolveAwayDates({ on: "11-03" }, today)).toMatchObject({ startsOn: "2027-11-03" })
    expect(resolveAwayDates({ from: "12-28", to: "01-03" }, today)).toEqual({
      kind: "range",
      startsOn: "2026-12-28",
      endsOn: "2027-01-03",
    })
  })

  it("a past range is refused with the dates stated", () => {
    const past = () => resolveAwayDates({ from: "2026-10-01", to: "2026-11-03" }, today)
    expect(past).toThrow(AwayRefusal)
    expect(past).toThrow(
      /Thu 1 Oct 2026 to Tue 3 Nov 2026 is already over \(today is Wed 4 Nov 2026\)/,
    )
    // The last day being today is not past.
    expect(resolveAwayDates({ from: "2026-10-01", to: "2026-11-04" }, today)).toMatchObject({
      endsOn: "2026-11-04",
    })
  })

  it("a last day before the first is refused with both dates", () => {
    expect(() => resolveAwayDates({ from: "2026-12-10", to: "2026-12-09" }, today)).toThrow(
      /last day \(Wed 9 Dec 2026\) is before the first \(Thu 10 Dec 2026\)/,
    )
  })

  it("everyWeekday stores one weekly row, from today when no first day is given", () => {
    expect(resolveAwayDates({ everyWeekday: [5, 5] }, today)).toEqual({
      kind: "weekly",
      startsOn: today,
      endsOn: null,
      weekdays: [5],
    })
  })

  it("two forms at once is refused", () => {
    expect(() => resolveAwayDates({ on: "2026-12-01", week: 48 }, today)).toThrow(/exactly one/)
  })

  it("states a date with its weekday", () => {
    expect(dayLabel("2026-12-21")).toBe("Mon 21 Dec 2026")
    expect(dayLabel("2027-01-03")).toBe("Sun 3 Jan 2027")
  })
})

describe("set_away", () => {
  let orgId: string
  let elodie: minimal.Session
  let tom: minimal.Session
  let sara: minimal.Session
  let lead: minimal.Session
  let admin: minimal.Session
  let gone: minimal.Session
  let external: string
  let agentId: string
  let threadId: string
  let leadThreadId: string

  const OWN_SCOPES = ["kernel:threads:read", "kernel:approve"]
  const LEAD_SCOPES = ["kernel:threads:read", "kernel:users:admin"]

  const actor = (s: minimal.Session, scopes: string[]): UserContext => ({
    actorType: "user",
    userId: s.userId,
    orgId: s.orgId,
    scopes,
    dimensionGrants: {},
  })

  function turn(extra: Partial<RunContext> = {}): RunContext {
    const runId = crypto.randomUUID()
    return {
      runId,
      parentRunId: null,
      rootRunId: runId,
      nestingDepth: 0,
      agentId,
      agentCeiling: ["*"],
      effectiveScope: ["*"],
      turnScopeAccumulator: createTurnScopeAccumulator(),
      humanTurn: true,
      ...extra,
    }
  }

  async function setAwayAs(
    s: minimal.Session,
    scopes: string[],
    params: Record<string, unknown>,
    frame: RunContext = turn(),
    thread: string = s.userId === lead.userId ? leadThreadId : threadId,
  ): Promise<any> {
    const res = await runContextStore.run(frame, () =>
      executeTool({
        toolName: "kernel:set_away",
        orgId,
        actor: actor(s, scopes),
        origin: "in-app-agent",
        params,
        threadId: thread,
      }),
    )
    return res.data ?? res
  }

  const ranges = (userId: string) =>
    sql<Array<Record<string, any>>>`
      SELECT id, starts_on::text AS starts_on, ends_on::text AS ends_on, weekdays, source, set_by,
             next_in_line_id, ended_early_on::text AS ended_early_on
      FROM kernel.away_ranges WHERE user_id = ${userId} ORDER BY created_at`

  const approvals = () =>
    sql<
      Array<{
        id: string
        resource_owner_id: string | null
        requested_by: string
        notify_user_ids: string[] | null
      }>
    >`
      SELECT id, resource_owner_id, requested_by, notify_user_ids FROM kernel.approval_requests
      WHERE org_id = ${orgId} AND tool_name = 'kernel:set_away'`

  const decide = (requestId: string, s: minimal.Session, scopes: string[]) =>
    decideApproval({
      orgId,
      requestId,
      actor: actor(s, scopes),
      decision: "deny",
    }).then(
      () => null,
      (err: unknown) => err,
    )

  const insert = async (
    table: string,
    rows: Parameters<typeof insertSql>[1],
    returning?: string,
  ): Promise<Array<{ id: string }>> =>
    (await sql.unsafe(insertSql(table, rows, returning ? { returning } : {}))) as unknown as Array<{
      id: string
    }>

  const range = (userId: string, from: string, to: string, nextInLineId: string | null) => ({
    org_id: orgId,
    user_id: userId,
    starts_on: from,
    ends_on: to,
    next_in_line_id: nextInLineId,
    source: "said",
    set_by: userId,
  })

  async function cleanup() {
    await sql`DELETE FROM kernel.away_ranges WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.auto_approve_policies WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.routines WHERE org_id = ${orgId}`
    await sql`UPDATE kernel.user_preferences SET next_in_line_id = NULL
              WHERE user_id IN (SELECT id FROM kernel.users WHERE org_id = ${orgId})`
    await sql`UPDATE kernel.threads SET tainted = false WHERE org_id = ${orgId}`
  }

  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    orgId = org.id
    elodie = await minimal.session(orgId)
    tom = await minimal.session(orgId)
    sara = await minimal.session(orgId)
    lead = await minimal.session(orgId)
    admin = await minimal.adminSession(orgId)
    gone = await minimal.session(orgId)
    await sql`UPDATE kernel.users SET status = 'deactivated' WHERE id = ${gone.userId}`
    external = crypto.randomUUID()
    await insert("kernel.users", {
      id: external,
      org_id: orgId,
      email: `client-${external.slice(0, 8)}@example.com`,
      name: "Client",
      user_type: "external",
      company_id: crypto.randomUUID(),
    })
    await sql`UPDATE kernel.users SET name = 'Élodie Renard' WHERE id = ${elodie.userId}`
    await sql`UPDATE kernel.users SET name = 'Tom Reyes' WHERE id = ${tom.userId}`
    await sql`UPDATE kernel.users SET name = 'Sara Benali' WHERE id = ${sara.userId}`
    await sql`UPDATE kernel.users SET name = 'Nadia Lead' WHERE id = ${lead.userId}`
    const [agent] = await insert(
      "kernel.agents",
      {
        org_id: orgId,
        kind: "personal",
        handle: `@aw-${crypto.randomUUID().slice(0, 8)}`,
        display_name: "Olive",
        scope_ceiling: { raw: `'["*"]'::jsonb` },
        owner_user_id: elodie.userId,
      },
      "id",
    )
    agentId = agent?.id as string
    await registerKernelAgentTools(orgId)
    threadId = await minimal.thread(orgId, elodie.userId)
    leadThreadId = await minimal.thread(orgId, lead.userId)
  })

  beforeEach(cleanup)

  afterAll(async () => {
    if (orgId) {
      await cleanup()
      await sql`DELETE FROM kernel.threads WHERE id IN (${threadId}, ${leadThreadId})`
      await sql`DELETE FROM kernel.agents WHERE id = ${agentId}`
    }
    await releaseTestLock()
  })

  it("untainted own runs and states dates with weekdays", async () => {
    const from = futureMonday()
    const to = addDays(from, 4)
    const res = await setAwayAs(elodie, OWN_SCOPES, { from, to, nextInLineId: tom.userId })
    expect(res).toMatchObject({ ok: true, action: "set", nextInLine: { name: "Tom Reyes" } })
    expect(res.resolved.days).toHaveLength(5)
    expect(res.resolved.days[0]).toBe(dayLabel(from))
    expect(res.resolved.days[0]).toMatch(/^Mon /)
    expect(res.resolved.days[4]).toMatch(/^Fri /)
    expect(res.message).toContain(`away from ${dayLabel(from)} to ${dayLabel(to)}`)
    expect(res.message).toContain("Next in line: Tom Reyes.")
    // What did not happen is said too.
    expect(res.message).toContain("No approval was moved or rewritten")
    const [row] = await ranges(elodie.userId)
    expect(row).toMatchObject({
      starts_on: from,
      ends_on: to,
      source: "said",
      set_by: elodie.userId,
    })
    expect(await approvals()).toHaveLength(0)
  })

  it("tainted own parks to the requester", async () => {
    await sql`UPDATE kernel.threads SET tainted = true WHERE id = ${threadId}`
    const res = await setAwayAs(elodie, OWN_SCOPES, { on: futureMonday() })
    expect(res).toMatchObject({ blocked: { reason: "taint_escalation" } })
    const [row] = await approvals()
    expect(row?.resource_owner_id).toBe(elodie.userId)
    // No range exists before Approve.
    expect(await ranges(elodie.userId)).toHaveLength(0)
  })

  it("routine own parks to its author", async () => {
    const res = await setAwayAs(
      elodie,
      OWN_SCOPES,
      { on: futureMonday() },
      turn({ routineId: crypto.randomUUID(), humanTurn: false }),
    )
    expect(res).toMatchObject({ blocked: { reason: "taint_escalation" } })
    const [row] = await approvals()
    expect(row).toMatchObject({ resource_owner_id: elodie.userId, requested_by: elodie.userId })
    expect(await ranges(elodie.userId)).toHaveLength(0)
  })

  it("untainted other with the scope runs, Home line present, End early works", async () => {
    const from = futureMonday()
    const res = await setAwayAs(lead, LEAD_SCOPES, {
      userId: elodie.userId,
      week: Number(isoWeek(from)),
      weekYear: Number(from.slice(0, 4)),
    })
    expect(res).toMatchObject({ ok: true, action: "set", for: { name: "Élodie Renard" } })
    expect(res.resolved.days[0]).toBe(dayLabel(from))
    expect(res.message).toContain("Élodie Renard gets a Home line")
    const [row] = await ranges(elodie.userId)
    expect(row).toMatchObject({ source: "lead", set_by: lead.userId })
    // The Home line for the person named: who set it and the dates, no reason.
    const events = await sql<Array<{ payload: any }>>`
      SELECT payload FROM kernel.pending_events
      WHERE org_id = ${orgId} AND payload->>'entityId' = ${row?.id as string}`
    expect(events).toHaveLength(1)
    expect(events[0]?.payload.data).toMatchObject({
      targetUserIds: [elodie.userId],
      awayNamed: { rangeId: row?.id, setBy: lead.userId },
    })
    expect(events[0]?.payload.data.summary).toBe(
      `Nadia Lead marked you away from ${dayLabel(from)} to ${dayLabel(addDays(from, 6))}`,
    )
    expect(await approvals()).toHaveLength(0)
    // End early, from the person's own profile: a range that has not started is removed.
    const ended = await endAwayRange(orgId, elodie.userId, row?.id as string)
    expect(ended.ended).toBe(true)
    expect(await ranges(elodie.userId)).toHaveLength(0)
  })

  it("tainted other parks to the requester, not in the named person's feed", async () => {
    await sql`UPDATE kernel.threads SET tainted = true WHERE id = ${leadThreadId}`
    const res = await setAwayAs(lead, LEAD_SCOPES, { userId: elodie.userId, on: futureMonday() })
    expect(res).toMatchObject({ blocked: { reason: "taint_escalation" } })
    const [row] = await approvals()
    expect(row?.resource_owner_id).toBe(lead.userId)
    expect(row?.notify_user_ids ?? []).not.toContain(elodie.userId)
    // The person named cannot decide or even see it.
    const refused = await decide(row?.id as string, elodie, ["*"])
    expect(refused).toBeInstanceOf(ApprovalDecisionError)
    expect((refused as ApprovalDecisionError).status).toBe(404)
    expect(await ranges(elodie.userId)).toHaveLength(0)
  })

  it("other without the scope not_allowed", async () => {
    const res = await setAwayAs(
      tom,
      OWN_SCOPES,
      { userId: elodie.userId, on: futureMonday() },
      turn(),
      threadId,
    )
    expect(res).toMatchObject({ ok: false, code: "not_allowed" })
    expect(res.message).toContain("Nothing was recorded")
    expect(await approvals()).toHaveLength(0)
    expect(await ranges(elodie.userId)).toHaveLength(0)
    // Refused before any gate on a tainted turn too: no approval left behind.
    await sql`UPDATE kernel.threads SET tainted = true WHERE id = ${threadId}`
    const tainted = await setAwayAs(
      tom,
      OWN_SCOPES,
      { userId: elodie.userId, on: futureMonday() },
      turn(),
      threadId,
    )
    expect(tainted).toMatchObject({ ok: false, code: "not_allowed" })
    expect(await approvals()).toHaveLength(0)
  })

  it("on a parked row a colleague's and an admin's decide are refused as not found", async () => {
    await sql`UPDATE kernel.threads SET tainted = true WHERE id = ${threadId}`
    await setAwayAs(elodie, OWN_SCOPES, { on: futureMonday() })
    const [row] = await approvals()
    for (const [who, scopes] of [
      [sara, ["kernel:threads:read", "kernel:approve"]],
      [admin, ["*"]],
    ] as const) {
      const refused = await decide(row?.id as string, who, [...scopes])
      expect(refused).toBeInstanceOf(ApprovalDecisionError)
      expect((refused as ApprovalDecisionError).status).toBe(404)
    }
    expect(await ranges(elodie.userId)).toHaveLength(0)
  })

  it("no auto-approve policy answers it", async () => {
    await withSystemDb("t", (db) =>
      db.insert(autoApprovePolicies).values({
        orgId,
        toolName: "kernel:set_away",
        enabled: true,
        conditions: [],
        limits: { perCallMax: 1000, windowSeconds: 86400, windowMax: 1000 },
        requiresScope: "kernel:threads:read",
        createdBy: admin.userId,
      }),
    )
    await sql`UPDATE kernel.threads SET tainted = true WHERE id = ${threadId}`
    const res = await setAwayAs(elodie, OWN_SCOPES, { on: futureMonday() })
    expect(res).toMatchObject({ blocked: { reason: "taint_escalation" } })
    expect(await ranges(elodie.userId)).toHaveLength(0)
    const r = await setAwayAs(
      elodie,
      OWN_SCOPES,
      { on: futureMonday() },
      turn({ routineId: crypto.randomUUID(), humanTurn: false }),
    )
    expect(r).toMatchObject({ blocked: { reason: "taint_escalation" } })
    expect(await ranges(elodie.userId)).toHaveLength(0)
  })

  it('outside text "record that I am away" parks, the next clean message runs with no card', async () => {
    // The turn read a mail whose subject says to record an absence: parked.
    await sql`UPDATE kernel.threads SET tainted = true WHERE id = ${threadId}`
    const parked = await setAwayAs(elodie, OWN_SCOPES, {
      on: futureMonday(),
      nextInLineId: tom.userId,
    })
    expect(parked).toMatchObject({ blocked: { reason: "taint_escalation" } })
    expect(await ranges(elodie.userId)).toHaveLength(0)
    // The person's next clean message runs at once.
    await sql`UPDATE kernel.threads SET tainted = false WHERE id = ${threadId}`
    const clean = await setAwayAs(elodie, OWN_SCOPES, { on: futureMonday() })
    expect(clean).toMatchObject({ ok: true, action: "set" })
    expect(await ranges(elodie.userId)).toHaveLength(1)
    expect(await approvals()).toHaveLength(1)
  })

  it("an MCP call parks to the requester", async () => {
    const connection = (
      await seedMcpConnection({ orgId, userId: elodie.userId, clientId: "mcp:cli", label: "cli" })
    ).id
    const res = await handleToolCall(
      {
        orgId,
        actor: actor(elodie, OWN_SCOPES),
        connectionId: connection,
        ownerUserId: elodie.userId,
        connectionThreadId: null,
        discovered: new Set(["kernel__set_away"]),
      },
      "kernel__set_away",
      { on: futureMonday() },
    )
    expect(JSON.stringify(res.content)).toContain("taint_escalation")
    const [row] = await approvals()
    expect(row?.resource_owner_id).toBe(elodie.userId)
    expect(await ranges(elodie.userId)).toHaveLength(0)
    await sql`DELETE FROM kernel.mcp_connections WHERE id = ${connection}`
  })

  it("a turn that read scoped records but no outside text still runs at once", async () => {
    const acc = createTurnScopeAccumulator()
    acc.recordInjected(["tickets:tickets:read"])
    const res = await setAwayAs(
      elodie,
      OWN_SCOPES,
      { on: futureMonday() },
      turn({ turnScopeAccumulator: acc }),
    )
    expect(res).toMatchObject({ ok: true, action: "set" })
    expect(await ranges(elodie.userId)).toHaveLength(1)
    expect(await approvals()).toHaveLength(0)
  })

  it("deactivating a person deletes their ranges at once", async () => {
    const leaving = await minimal.session(orgId)
    await setAway({ orgId, actorId: leaving.userId, actorScopes: [], form: { on: futureMonday() } })
    expect(await ranges(leaving.userId)).toHaveLength(1)
    await withPrivilegedDb(orgId, "t", (tx) =>
      deactivateUser(tx, {
        targetId: leaving.userId,
        actorId: admin.userId,
        orgId,
        actorScopes: ["*"],
      }),
    )
    expect(await ranges(leaving.userId)).toHaveLength(0)
  })

  it("the profile saves at once, lists the range, offers colleagues with who is away, and undoes", async () => {
    const req = (path: string, method: string, body?: unknown) =>
      app.request(`/api/user/preferences/away${path}`, {
        method,
        headers: { Authorization: `Bearer ${elodie.bearer}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    const from = futureMonday()
    await setAway({ orgId, actorId: tom.userId, actorScopes: [], form: { on: todayUtc() } })
    const saved = await req("", "POST", { from, to: addDays(from, 2), nextInLineId: tom.userId })
    expect(saved.status).toBe(200)
    const body = ((await saved.json()) as { data: { id: string; message: string } }).data
    expect(body.message).toContain(dayLabel(from))
    const listed = ((await (await req("", "GET")).json()) as { data: any }).data
    expect(listed.ranges.map((r: { id: string }) => r.id)).toEqual([body.id])
    const tomChoice = listed.people.find((p: { id: string }) => p.id === tom.userId)
    expect(tomChoice.awayUntil).toBe(todayUtc())
    expect(
      listed.people.some((p: { id: string }) => p.id === elodie.userId || p.id === external),
    ).toBe(false)
    const bad = await req("", "POST", { from, to: addDays(from, 1), nextInLineId: elodie.userId })
    expect(bad.status).toBe(400)
    expect((await bad.json()) as unknown).toMatchObject({ error: { code: "bad_next_in_line" } })
    expect((await req(`/${body.id}`, "DELETE")).status).toBe(200)
    expect(await ranges(elodie.userId)).toHaveLength(0)
  })

  it("everyWeekday [5]: one row, result from, everyWeekday, next 3 dates", async () => {
    const res = await setAwayAs(elodie, OWN_SCOPES, { everyWeekday: [5] })
    expect(res.resolved.everyWeekday).toEqual(["Fri"])
    expect(res.resolved.to).toBeNull()
    expect(res.resolved.next).toHaveLength(3)
    for (const d of res.resolved.next) expect(d).toMatch(/^Fri /)
    expect(res.resolved).not.toHaveProperty("days")
    const rows = await ranges(elodie.userId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ weekdays: [5], ends_on: null })
  })

  it("no dates with nextInLineId sets the default", async () => {
    const res = await setAwayAs(elodie, OWN_SCOPES, { nextInLineId: sara.userId })
    expect(res).toMatchObject({ ok: true, action: "default", nextInLine: { name: "Sara Benali" } })
    expect(res.message).toContain("No away dates were recorded")
    expect(await ranges(elodie.userId)).toHaveLength(0)
    const [pref] = await sql<{ next_in_line_id: string }[]>`
      SELECT next_in_line_id FROM kernel.user_preferences WHERE user_id = ${elodie.userId}`
    expect(pref?.next_in_line_id).toBe(sara.userId)
    // A range naming nobody then states the standing one.
    const set = await setAwayAs(elodie, OWN_SCOPES, { on: futureMonday() })
    expect(set).toMatchObject({ nextInLine: { name: "Sara Benali" }, nextInLineIsDefault: true })
  })

  it("end names what ended, also on a recurring row off its day", async () => {
    // A weekly range that started a week ago, on a weekday that is not today.
    const today = todayUtc()
    const otherDay = ((new Date(`${today}T12:00:00Z`).getUTCDay() + 2) % 7) + 1
    await setAway({
      orgId,
      actorId: elodie.userId,
      actorScopes: OWN_SCOPES,
      form: { everyWeekday: [otherDay] },
    })
    await sql`UPDATE kernel.away_ranges SET starts_on = starts_on - 7 WHERE user_id = ${elodie.userId}`
    const res = await setAwayAs(elodie, OWN_SCOPES, { end: true })
    expect(res).toMatchObject({ ok: true, action: "end" })
    expect(res.ended).toHaveLength(1)
    expect(res.message).toMatch(/^Ended every /)
    const [row] = await ranges(elodie.userId)
    expect(row?.ended_early_on).not.toBeNull()
    // Nothing running: says so, changes nothing.
    const again = await setAwayAs(elodie, OWN_SCOPES, { end: true })
    expect(again.ended).toHaveLength(0)
    expect(again.message).toContain("nothing was ended")
  })

  it("bad_next_in_line for inactive, external, self", async () => {
    for (const id of [gone.userId, external, elodie.userId]) {
      const res = await setAwayAs(elodie, OWN_SCOPES, { on: futureMonday(), nextInLineId: id })
      expect(res).toMatchObject({ ok: false, code: "bad_next_in_line" })
      expect(res.message).toContain("Nothing was recorded")
    }
    expect(await ranges(elodie.userId)).toHaveLength(0)
    expect(await approvals()).toHaveLength(0)
  })

  it("a past range is refused with the dates stated, nothing recorded", async () => {
    const res = await setAwayAs(elodie, OWN_SCOPES, {
      from: addDays(todayUtc(), -20),
      to: addDays(todayUtc(), -10),
    })
    expect(res).toMatchObject({ ok: false, code: "past_dates" })
    expect(res.message).toContain(dayLabel(addDays(todayUtc(), -10)))
    expect(await ranges(elodie.userId)).toHaveLength(0)
  })

  it("cannotDecide lists by plain label with who gets them instead", async () => {
    const grant = (userId: string) => ({
      org_id: orgId,
      user_id: userId,
      scope: "kernel:approve",
    })
    await insert("kernel.user_scope_grants", [grant(elodie.userId), grant(sara.userId)])
    try {
      const res = await setAwayAs(elodie, OWN_SCOPES, {
        on: futureMonday(),
        nextInLineId: tom.userId,
      })
      const line = res.cannotDecide.find(
        (c: { label: string }) => c.label === "Skills, routines and roles approvals",
      )
      expect(line).toBeDefined()
      expect(line.goesTo).toContain("Sara Benali")
      expect(line.goesTo).not.toContain("Tom Reyes")
      expect(line.goesTo).not.toContain("Élodie Renard")
      expect(res.message).toContain("Tom Reyes cannot approve")
      // Granting Tom the scope takes the line away.
      await insert("kernel.user_scope_grants", grant(tom.userId))
      const after = await setAwayAs(elodie, OWN_SCOPES, {
        on: addDays(futureMonday(), 7),
        nextInLineId: tom.userId,
      })
      expect(
        after.cannotDecide.find(
          (c: { label: string }) => c.label === "Skills, routines and roles approvals",
        ),
      ).toBeUndefined()
    } finally {
      await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${orgId} AND scope = 'kernel:approve'`
    }
  })

  it("set_away for the owner of an owner-approved routine returns staysWithYou naming it", async () => {
    const routine = (name: string, approver: string) => ({
      org_id: orgId,
      owner_user_id: elodie.userId,
      name,
      description: "d",
      prompt: "p",
      scopes: { raw: "ARRAY['kernel:threads:read']" },
      approver,
      enabled: true,
      cron: "0 9 * * *",
      timezone: "UTC",
      created_by_actor_type: "user",
    })
    await insert("kernel.routines", [
      routine("Morning invoices", "owner"),
      routine("Shared digest", "default"),
    ])
    const res = await setAwayAs(elodie, OWN_SCOPES, { on: futureMonday() })
    expect(res.staysWithYou).toEqual(["Morning invoices"])
    expect(res.message).toContain("stay with you only, even while away: Morning invoices")
  })

  it("set_away then a snapshot of all approval_requests columns equals before", async () => {
    const [req] = await insert(
      "kernel.approval_requests",
      {
        org_id: orgId,
        thread_id: threadId,
        originating_thread_id: threadId,
        current_payload: "{}",
        summary: JSON.stringify({ title: "Reply" }),
        expires_at: { raw: "now() + INTERVAL '3 days'" },
        handle: `APR-${crypto.randomUUID().slice(0, 8)}`,
        tool_name: "tickets:reply",
        tool_params: { raw: "'{}'::jsonb" },
        requested_by: sara.userId,
        status: "pending",
        notify_user_ids: { raw: `ARRAY['${elodie.userId}', '${tom.userId}']::uuid[]` },
        route_person_id: elodie.userId,
      },
      "id",
    )
    const snapshot = () =>
      sql`SELECT * FROM kernel.approval_requests WHERE id = ${req?.id as string}`
    const before = JSON.stringify(await snapshot())
    await setAwayAs(elodie, OWN_SCOPES, { on: addDays(todayUtc(), 1), nextInLineId: tom.userId })
    await setAwayAs(elodie, OWN_SCOPES, { end: true })
    expect(JSON.stringify(await snapshot())).toBe(before)
  })

  it("a colleague reads active rows' dates and next in line; a null one gives the standing default", async () => {
    const today = todayUtc()
    await insert("kernel.away_ranges", [
      range(elodie.userId, addDays(today, -2), addDays(today, 3), tom.userId),
      range(sara.userId, addDays(today, -1), addDays(today, 2), null),
    ])
    await setAwayAs(sara, OWN_SCOPES, { nextInLineId: tom.userId }, turn(), threadId)
    const away = await readAwayToday(orgId, [elodie.userId, sara.userId, tom.userId])
    expect(away.get(elodie.userId)?.nextInLineId).toBe(tom.userId)
    expect(away.get(elodie.userId)?.until).toBeTruthy()
    expect(away.get(sara.userId)?.nextInLineId).toBe(tom.userId)
    expect(away.has(tom.userId)).toBe(false)
  })

  it("undo takes back a range just saved, and only its author can", async () => {
    const res = await setAwayAs(elodie, OWN_SCOPES, { on: futureMonday() })
    expect((await undoAway(orgId, tom.userId, res.id)).undone).toBe(false)
    expect((await undoAway(orgId, elodie.userId, res.id)).undone).toBe(true)
    expect(await ranges(elodie.userId)).toHaveLength(0)
  })

  it("the daily prune deletes a range 90 days after its last day, not the day before", async () => {
    const today = todayUtc()
    await insert("kernel.away_ranges", [
      range(elodie.userId, addDays(today, -100), addDays(today, -91), null),
      range(elodie.userId, addDays(today, -100), addDays(today, -90), null),
    ])
    await pruneAwayRanges()
    const left = await ranges(elodie.userId)
    expect(left.map((r) => r.ends_on)).toEqual([addDays(today, -90)])
  })
})

function isoWeek(date: string): number {
  const d = new Date(`${date}T00:00:00Z`)
  const day = d.getUTCDay() === 0 ? 7 : d.getUTCDay()
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
}
