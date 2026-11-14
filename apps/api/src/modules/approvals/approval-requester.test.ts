// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHO ASKED for an approval, on every surface that names it.
//
// A ticket draft the @support routine wrote read "by Avery Shaw": the
// card, the feed row and the agent's pending-approval context all printed
// `requested_by`, the human the call is accountable to (the routine's owner),
// and the agent that actually asked rode alongside as "via Support" at best.
// The rule is now one function (modules/approvals/requester.ts): a role or
// system agent's request is the agent's, a routine's is "Routine {name}", a
// personal agent's is "{Person}'s agent" (attributed, never the person), and
// only no agent at all is the person. Every read below is the real one, over
// real rows.
//
// Rows a routine staged before `agent_id` was written are filled from the
// routine's owner agent by migration 0105, exercised here on a real row.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { readFileSync } from "node:fs"
import type { ApprovalRequester } from "@liaison/shared"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { computeApprovalAttentionItems } from "~/modules/approvals/attention"
import { loadApprovalSummary } from "~/modules/approvals/event-data"
import {
  getApproval,
  listApprovals,
  listPendingApprovalsForEntities,
} from "~/modules/approvals/list"
import { pickApprovalRequester } from "~/modules/approvals/requester"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = crypto.randomUUID()
const USER = crypto.randomUUID()
const THREAD = crypto.randomUUID()
const APPROVAL_THREAD = crypto.randomUUID()
const SUPPORT_AGENT = crypto.randomUUID()
const PERSONAL_AGENT = crypto.randomUUID()
const ROUTINE = crypto.randomUUID()
const PERSONAL_ROUTINE = crypto.randomUUID()
const PERSONAL_ROUTINE_RAISED = crypto.randomUUID()
const AGENT_RAISED = crypto.randomUUID()
const PERSONAL_RAISED = crypto.randomUUID()
const HUMAN_RAISED = crypto.randomUUID()
const ROUTINE_RAISED_LEGACY = crypto.randomUUID()
// Every row references this entity, so the agent-context read finds them all.
const TICKET = crypto.randomUUID()
const tag = crypto.randomUUID().slice(0, 8)

const SCOPES = ["kernel:approvals:read", "kernel:approvals:write", "tickets:approve"]

const actor = (): UserContext => ({
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: SCOPES,
  dimensionGrants: {},
})

async function insertApproval(
  id: string,
  agentId: string | null,
  metadata: Record<string, unknown> = {},
) {
  await sql`
    INSERT INTO kernel.approval_requests (
      id, org_id, handle, status, tool_name, tool_params, summary, current_payload,
      thread_id, originating_thread_id, requested_by, notify_user_ids, expires_at,
      approve_scope, agent_id, metadata
    ) VALUES (
      ${id}, ${ORG}, ${`req-${id.slice(-4)}`}, 'pending',
      'tickets:reply', ${JSON.stringify({ ticketId: TICKET })}::jsonb, ${JSON.stringify({ title: "Re: damaged unit" })}::jsonb,
      '{}'::jsonb, ${APPROVAL_THREAD}, ${THREAD}, ${USER},
      ${sql.array([USER], 2950)}, ${new Date(Date.now() + 7_200_000).toISOString()}::timestamptz,
      'tickets:approve', ${agentId}, ${JSON.stringify(metadata)}::jsonb
    )`
}

describe("the requester of an approval is the agent that asked, or the person", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Acting Agent Org', ${`acting-agent-${tag}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${USER}, ${ORG}, ${`aa-${tag}@test.com`}, 'Avery', 'active', 'hash')`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name)
      VALUES (${SUPPORT_AGENT}, ${ORG}, 'role', ${`@aa-support-${tag}`}, 'Support Desk')`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id)
      VALUES (${PERSONAL_AGENT}, ${ORG}, 'personal', ${`@aa-mine-${tag}`}, 'My Assistant', ${USER})`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, ${`aa-room-${tag}`}, 'thread', ${USER})`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${APPROVAL_THREAD}, ${ORG}, ${`aa-approval-${tag}`}, 'approval', ${USER})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${THREAD}, ${USER}, ${ORG})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${APPROVAL_THREAD}, ${USER}, ${ORG})`
    await insertApproval(AGENT_RAISED, SUPPORT_AGENT)
    await insertApproval(PERSONAL_RAISED, PERSONAL_AGENT)
    await insertApproval(HUMAN_RAISED, null)
    // A routine owned by the support agent, and a draft it staged before
    // approval rows recorded their agent.
    await sql`INSERT INTO kernel.routines (id, org_id, owner_user_id, owner_agent_id, name,
        description, prompt, scopes, cron, timezone, created_by_actor_type)
      VALUES (${ROUTINE}, ${ORG}, ${USER}, ${SUPPORT_AGENT}, ${`aa-routine-${tag}`},
        'on message', 'draft replies', ${sql.array(["tickets:read"])}, '0 * * * *', 'UTC', 'user')`
    await insertApproval(ROUTINE_RAISED_LEGACY, null, { originRoutineId: ROUTINE })
    // A routine the person's own agent runs, and a draft it staged.
    await sql`INSERT INTO kernel.routines (id, org_id, owner_user_id, owner_agent_id, name,
        description, prompt, scopes, cron, timezone, created_by_actor_type)
      VALUES (${PERSONAL_ROUTINE}, ${ORG}, ${USER}, ${PERSONAL_AGENT}, 'Sales follow-up',
        'daily', 'draft replies', ${sql.array(["tickets:read"])}, '0 * * * *', 'UTC', 'user')`
    await insertApproval(PERSONAL_ROUTINE_RAISED, PERSONAL_AGENT, {
      originRoutineId: PERSONAL_ROUTINE,
    })
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.routines WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
    await releaseTestLock()
  })

  const SUPPORT: ApprovalRequester = { kind: "agent", id: SUPPORT_AGENT, name: "Support Desk" }
  const PERSON: ApprovalRequester = { kind: "user", id: USER, name: "Avery" }
  const AVERYS_AGENT: ApprovalRequester = {
    kind: "agent",
    id: PERSONAL_AGENT,
    name: "Avery's agent",
  }
  const SALES_ROUTINE: ApprovalRequester = {
    kind: "agent",
    id: PERSONAL_AGENT,
    name: "Routine Sales follow-up",
  }

  it("the detail read names a role agent, the person's agent, and the person only for none", async () => {
    const read = (requestId: string) =>
      withRlsContext(actor(), (tx) => getApproval(tx, { orgId: ORG, userId: USER, requestId }))
    expect((await read(AGENT_RAISED))?.requester).toEqual(SUPPORT)
    expect((await read(PERSONAL_RAISED))?.requester).toEqual(AVERYS_AGENT)
    expect((await read(HUMAN_RAISED))?.requester).toEqual(PERSON)
    // The accountable human stays on the row for authorization, unnamed.
    expect((await read(AGENT_RAISED))?.requestedBy).toEqual({ id: USER })
  })

  it("the list read, the live event payload, the feed and the agent context agree", async () => {
    const rows = await withRlsContext(actor(), (tx) =>
      listApprovals(tx, { orgId: ORG, userId: USER, scopes: SCOPES }),
    )
    expect(rows.find((r) => r.id === AGENT_RAISED)?.requester).toEqual(SUPPORT)
    expect(rows.find((r) => r.id === PERSONAL_RAISED)?.requester).toEqual(AVERYS_AGENT)
    expect(rows.find((r) => r.id === HUMAN_RAISED)?.requester).toEqual(PERSON)

    // The payload every create/update event carries (decide, edit, expiry).
    const event = await withPrivilegedDb(ORG, "test-approval-event", (tx) =>
      loadApprovalSummary(tx, ORG, AGENT_RAISED),
    )
    expect(event.requester).toEqual(SUPPORT)

    const feed = await withRlsContext(actor(), (tx) => computeApprovalAttentionItems(tx, ORG, USER))
    const feedName = (id: string) => feed.find((i) => i.entityId === id)?.metadata?.requesterName
    expect(feedName(AGENT_RAISED)).toBe("Support Desk")
    expect(feedName(PERSONAL_RAISED)).toBe("Avery's agent")
    expect(feedName(HUMAN_RAISED)).toBe("Avery")

    const context = await withRlsContext(actor(), (tx) =>
      listPendingApprovalsForEntities(tx, { orgId: ORG, userId: USER, entityIds: [TICKET] }),
    )
    expect(context.find((p) => p.id === AGENT_RAISED)?.requesterName).toBe("Support Desk")
    expect(context.find((p) => p.id === HUMAN_RAISED)?.requesterName).toBe("Avery")
  })

  it("migration 0105 gives a routine's pre-agent draft its routine's agent", async () => {
    const read = () =>
      withRlsContext(actor(), (tx) =>
        getApproval(tx, { orgId: ORG, userId: USER, requestId: ROUTINE_RAISED_LEGACY }),
      )
    // Before it: a routine the reader cannot see, with no agent, is "Routine", never the person.
    expect((await read())?.requester).toEqual({ kind: "agent", id: ROUTINE, name: "Routine" })
    const migration = readFileSync(
      new URL("../../db/migrations/0105_approval_agent_from_routine_owner.sql", import.meta.url),
      "utf8",
    )
    await sql.unsafe(migration)
    expect((await read())?.requester).toEqual(SUPPORT)
    // Idempotent, and it touched no row that already named its agent.
    await sql.unsafe(migration)
    const [personal] = await sql<{ agent_id: string }[]>`
      SELECT agent_id FROM kernel.approval_requests WHERE id = ${PERSONAL_RAISED}`
    expect(personal.agent_id).toBe(PERSONAL_AGENT)
  })

  it("a routine's request names the routine; one the reader cannot see names its agent", async () => {
    // The live event payload is read privileged: the routine is named.
    const event = await withPrivilegedDb(ORG, "test-approval-event", (tx) =>
      loadApprovalSummary(tx, ORG, PERSONAL_ROUTINE_RAISED),
    )
    expect(event.requester).toEqual(SALES_ROUTINE)
    // Through RLS with the routines read scope, the owner sees it too.
    const withRoutines = await withRlsContext(
      { ...actor(), scopes: [...SCOPES, "kernel:routines:read"] },
      (tx) => getApproval(tx, { orgId: ORG, userId: USER, requestId: PERSONAL_ROUTINE_RAISED }),
    )
    expect(withRoutines?.requester).toEqual(SALES_ROUTINE)
    // Without it the routine stays hidden, and the agent is still named, never the person.
    const hidden = await withRlsContext(actor(), (tx) =>
      getApproval(tx, { orgId: ORG, userId: USER, requestId: PERSONAL_ROUTINE_RAISED }),
    )
    expect(hidden?.requester).toEqual(AVERYS_AGENT)
  })

  it("a draft an MCP client staged with no agent row is the person's agent, never the person", () => {
    const person = { id: USER, name: "Giulia Ferrari" }
    const agentNamed: ApprovalRequester = {
      kind: "agent",
      id: USER,
      name: "Giulia Ferrari's agent",
    }
    expect(pickApprovalRequester(person, null, USER, null, "mcp")).toEqual(agentNamed)
    // The person's own action, in the app, names the person.
    expect(pickApprovalRequester(person, null, USER, null, "human-ui")).toEqual({
      kind: "user",
      id: USER,
      name: "Giulia Ferrari",
    })
  })

  it("a request an app's scheduled job raised names the job, never the member it is filed under", () => {
    const person = { id: USER, name: "Giulia Ferrari" }
    expect(
      pickApprovalRequester(person, null, USER, null, "system", "invoicing:recurring_run_issue"),
    ).toEqual({
      kind: "agent",
      id: USER,
      name: "Scheduled job (Invoicing)",
    })
  })

  it("a routine that ran without an agent, hidden from the reader, is still a routine, never the person", () => {
    const person = { id: USER, name: "Avery Shaw" }
    const hiddenRoutine = { id: PERSONAL_ROUTINE, name: null }
    expect(pickApprovalRequester(person, null, USER, hiddenRoutine)).toEqual({
      kind: "agent",
      id: PERSONAL_ROUTINE,
      name: "Routine",
    })
  })
})
