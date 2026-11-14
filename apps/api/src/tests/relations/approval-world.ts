// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The world of the approval, routing and away links, built through the product's own paths: a
// task created and assigned by the projects tools, a request to delete it proposed by an agent turn
// in a conversation (so the kernel parks it, routes it to the task's assignee and notifies the
// deciders), away ranges written by the one away module, people deactivated and scopes revoked as
// an admin does it. Each reader reads the request as Home does (the attention feed under their row
// security) and as its card does (getApproval), and the person away reads their profile's ranges.
//
// Readers, by role: `requester` asked for it and cannot decide it; `person` is the assignee it is
// for; `usual` and `chain` are other deciders; `nextInLine` decides and stands in for `person`;
// `outsider` never could see it (the control for hide and for the positive control).

import { randomUUID } from "node:crypto"
import type { AttentionItem } from "@liaison/shared"
import { deleteTask, restoreTask } from "~/apps/projects/service/tasks"
import { sql } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { computeApprovalAttentionItems } from "~/modules/approvals/attention"
import { decideApproval } from "~/modules/approvals/decide"
import { getApproval } from "~/modules/approvals/list"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { disableOrgApp, enableOrgApp } from "~/modules/apps/org-app-admin"
import { listOrgAppStates } from "~/modules/apps/org-apps"
import { deleteOwnAccount } from "~/modules/auth/account-delete"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { endAwayRange, listAwayRanges, setAway } from "~/modules/users/away"
import { deactivateUser, reactivateUser } from "~/modules/users/service"
import * as minimal from "~/seed/tiers/minimal"
import type { Reading, Sight } from "./classes"

/** The kernel schema as the run names it (a test namespace prefixes it). */
const K = () => sql(schemaRef("kernel"))

export const DECIDE_SCOPE = "projects:approve"
export const ROLES = ["requester", "person", "usual", "chain", "nextInLine", "outsider"] as const
export type Role = (typeof ROLES)[number]

export interface ApprovalOrg {
  orgId: string
  admin: UserContext
  adminId: string
}

export async function approvalOrg(orgId: string): Promise<ApprovalOrg> {
  await ensureAppsForOrg(orgId)
  const adminId = (await minimal.orgAdmin(orgId)).id
  return { orgId, adminId, admin: await ctxOf(orgId, adminId) }
}

export async function ctxOf(orgId: string, userId: string): Promise<UserContext> {
  const perms = await withPrivilegedDb(orgId, "relations-perms", (tx) =>
    loadEffectivePermissions(tx, userId, orgId),
  )
  return {
    actorType: "user",
    userId,
    orgId,
    scopes: perms.scopes,
    dimensionGrants: perms.dimensionGrants,
  }
}

/** A project name of random letters: the key derived from it does not collide with another cell's. */
export function projectName(): string {
  const letters = Array.from({ length: 6 }, () =>
    String.fromCharCode(65 + Math.floor(Math.random() * 26)),
  )
  return `${letters.join("")} project`
}

/** One request and its people. Every cell builds its own, so no cell sees another's events. */
export class ApprovalCase {
  people = {} as Record<Role, string>
  thread = ""
  taskId = ""
  taskTitle = ""
  projectId = ""
  requestId = ""
  rangeId: string | null = null
  ticketId = ""
  survivorId = ""

  constructor(readonly org: ApprovalOrg) {}

  get orgId(): string {
    return this.org.orgId
  }

  roleOf(id: string | null | undefined): string | null {
    if (!id) return null
    for (const r of ROLES) if (this.people[r] === id) return r
    return id
  }

  /** People, a task assigned to `person` (or to nobody), and the request to delete it. */
  async build(
    opts: {
      assigned?: boolean
      away?: boolean
      people?: Record<Role, string>
      title?: string
    } = {},
  ): Promise<this> {
    const tag = randomUUID().slice(0, 6)
    if (opts.people) this.people = { ...opts.people }
    else {
      for (const r of ROLES) {
        this.people[r] = (await minimal.person(this.orgId, { name: `R${tag}${r} Rel` })).id
      }
      for (const r of ["person", "usual", "chain", "nextInLine"] as const) {
        await minimal.grantScope(this.people[r], DECIDE_SCOPE)
      }
      for (const scope of ["projects:projects:read", "projects:tasks:read", "projects:tasks:write"])
        await minimal.grantScope(this.people.requester, scope)
    }
    this.thread = await minimal.thread(this.orgId, this.people.requester, {
      title: `Relations ${tag}`,
    })
    this.taskTitle = opts.title ?? `Relation task ${tag}`
    const project = await this.tool("projects:createProject", {
      name: projectName(),
      tasks: [{ title: this.taskTitle }],
    })
    const data = project.data as { projectId?: string; id?: string; tasks?: Array<{ id: string }> }
    this.taskId = data.tasks?.[0]?.id ?? ""
    this.projectId = (await this.taskProject()) ?? ""
    if (!this.taskId || !this.projectId)
      throw new Error(`task not created: ${JSON.stringify(project)}`)
    if (opts.assigned !== false) {
      const res = await this.tool("projects:update", {
        taskId: this.taskId,
        assigneeId: this.people.person,
      })
      if (res.blocked) throw new Error(`assign refused: ${JSON.stringify(res)}`)
    }
    if (opts.away) this.rangeId = await this.goAway("person", "nextInLine")
    this.requestId = await this.propose()
    return this
  }

  async tool(toolName: string, params: Record<string, unknown>) {
    return executeTool({ toolName, orgId: this.orgId, actor: this.org.admin, params })
  }

  /** Deleting the task as a person does from its page (the bin), not through the gated tool. */
  async binTask(): Promise<void> {
    await withRlsContext(this.org.admin, (tx) =>
      deleteTask({ tx, orgId: this.orgId, actor: this.org.admin, taskId: this.taskId }),
    )
  }

  async unbinTask(): Promise<void> {
    await withRlsContext(this.org.admin, (tx) =>
      restoreTask({ tx, orgId: this.orgId, actor: this.org.admin, taskId: this.taskId }),
    )
  }

  async taskState(): Promise<{ archived: boolean; updatedAt: string }> {
    const [row] = (await sql`
      SELECT archived_at IS NOT NULL AS archived, updated_at::text AS updated_at
      FROM app_projects.tasks WHERE id = ${this.taskId}::uuid`) as Array<{
      archived: boolean
      updated_at: string
    }>
    if (!row) throw new Error("task row gone")
    return { archived: row.archived, updatedAt: row.updated_at }
  }

  async setApp(app: string, on: boolean): Promise<void> {
    const actor = { actorId: this.org.adminId, actorType: "user" as const }
    if (on) await enableOrgApp(this.orgId, app, actor)
    else await disableOrgApp(this.orgId, app, actor)
  }

  async appStatus(app: string): Promise<string | null> {
    return (await listOrgAppStates(this.orgId)).find((s) => s.app === app)?.status ?? null
  }

  async taskProject(): Promise<string | null> {
    const [row] = (await sql`
      SELECT project_id FROM app_projects.tasks WHERE id = ${this.taskId}::uuid`) as Array<{
      project_id: string
    }>
    return row?.project_id ?? null
  }

  /** The requester's agent proposes deleting the task: the kernel parks it as a pending request. */
  async propose(): Promise<string> {
    const actor = await ctxOf(this.orgId, this.people.requester)
    await executeTool({
      toolName: "projects:delete",
      orgId: this.orgId,
      actor,
      threadId: this.thread,
      params: { taskId: this.taskId },
      origin: "in-app-agent",
    })
    const [row] = (await sql`
      SELECT id FROM ${K()}.approval_requests
      WHERE org_id = ${this.orgId} AND tool_name = 'projects:delete' AND status = 'pending'
        AND tool_params->>'taskId' = ${this.taskId}
      ORDER BY created_at DESC LIMIT 1`) as Array<{ id: string }>
    if (!row) throw new Error("the delete was not parked as a pending request")
    return row.id
  }

  /**
   * A ticket and the one it will merge into, and the requester's agent proposing to close the
   * first: the kernel parks the close as a pending request, which becomes the request read. A close
   * with no message needs no mailbox, and a merge cancels it as it cancels a pending reply.
   */
  async onTicket(): Promise<this> {
    for (const scope of ["tickets:tickets:read", "tickets:tickets:close"])
      await minimal.grantScope(this.people.requester, scope)
    await minimal.grantScope(this.people.usual, "tickets:approve")
    const ids: string[] = []
    for (const subject of ["Merged ticket", "Surviving ticket"]) {
      const res = await this.tool("tickets:create", {
        subject: `${subject} ${randomUUID().slice(0, 6)}`,
        channel: "manual",
      })
      ids.push((res.data as { ticketId?: string }).ticketId ?? "")
    }
    const [ticketId = "", survivorId = ""] = ids
    if (!ticketId || !survivorId) throw new Error("tickets not created")
    this.ticketId = ticketId
    this.survivorId = survivorId
    await executeTool({
      toolName: "tickets:close",
      orgId: this.orgId,
      actor: await ctxOf(this.orgId, this.people.requester),
      threadId: this.thread,
      params: { ticketId },
      origin: "in-app-agent",
    })
    const [row] = (await sql`
      SELECT id FROM ${K()}.approval_requests
      WHERE org_id = ${this.orgId} AND tool_name = 'tickets:close' AND status = 'pending'
        AND tool_params->>'ticketId' = ${ticketId}
      ORDER BY created_at DESC LIMIT 1`) as Array<{ id: string }>
    if (!row) throw new Error("the close was not parked as a pending request")
    this.requestId = row.id
    return this
  }

  async mergeTicket(): Promise<void> {
    await this.tool("tickets:merge", {
      targetTicketId: this.survivorId,
      sourceTicketIds: [this.ticketId],
    })
  }

  async mergedInto(id: string): Promise<string | null> {
    const [row] = (await sql`
      SELECT merged_into_ticket_id FROM app_tickets.tickets WHERE id = ${id}::uuid`) as Array<{
      merged_into_ticket_id: string | null
    }>
    return row?.merged_into_ticket_id ?? null
  }

  async goAway(who: Role, nextInLine: Role | null): Promise<string> {
    const today = new Date().toISOString().slice(0, 10)
    const to = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10)
    const res = await setAway({
      orgId: this.orgId,
      actorId: this.people[who],
      actorScopes: [],
      form: { from: today, to },
      ...(nextInLine ? { nextInLineId: this.people[nextInLine] } : {}),
    })
    if (!res.ok || res.action !== "set") throw new Error(`away not set: ${JSON.stringify(res)}`)
    return res.id
  }

  async endAway(who: Role, rangeId: string): Promise<void> {
    const res = await endAwayRange(this.orgId, this.people[who], rangeId)
    if (!res.ended) throw new Error(`range not ended: ${res.message}`)
  }

  async deactivate(who: Role): Promise<void> {
    await withPrivilegedDb(this.orgId, "relations-deactivate", (tx) =>
      deactivateUser(tx, {
        targetId: this.people[who],
        actorId: this.org.adminId,
        orgId: this.orgId,
        actorScopes: this.org.admin.scopes,
      }),
    )
  }

  async reactivate(who: Role): Promise<void> {
    await withPrivilegedDb(this.orgId, "relations-reactivate", (tx) =>
      reactivateUser(tx, {
        targetId: this.people[who],
        actorId: this.org.adminId,
        orgId: this.orgId,
        actorScopes: this.org.admin.scopes,
      }),
    )
  }

  /** The person deletes their own account, as the account page does once the step-up passed. */
  async deleteAccount(who: Role): Promise<void> {
    await deleteOwnAccount(this.orgId, this.people[who])
  }

  async decide(who: Role, decision: "approve" | "deny"): Promise<void> {
    await decideApproval({
      orgId: this.orgId,
      requestId: this.requestId,
      actor: await ctxOf(this.orgId, this.people[who]),
      decision,
    })
  }

  // ── facts the events check on their own object ────────────────────────────

  async userStatus(who: Role): Promise<string | null> {
    const [row] =
      (await sql`SELECT status FROM ${K()}.users WHERE id = ${this.people[who]}`) as Array<{
        status: string
      }>
    return row?.status ?? null
  }

  async holds(who: Role, scope: string): Promise<boolean> {
    return (await ctxOf(this.orgId, this.people[who])).scopes.includes(scope)
  }

  async runningRanges(who: Role): Promise<number> {
    const listed = await listAwayRanges(this.orgId, this.people[who])
    return listed.ranges.filter((r) => r.runningToday).length
  }

  async requestRow(): Promise<{ status: string; route_person_id: string | null; title: string }> {
    const [row] = (await sql`
      SELECT status, route_person_id, summary->>'title' AS title
      FROM ${K()}.approval_requests WHERE id = ${this.requestId}`) as Array<{
      status: string
      route_person_id: string | null
      title: string
    }>
    if (!row) throw new Error("request row gone")
    return row
  }

  async versions(who: Role): Promise<{ auth: number; permission: number }> {
    const [row] = (await sql`
      SELECT auth_version, permission_version FROM ${K()}.users WHERE id = ${this.people[who]}`) as Array<{
      auth_version: number
      permission_version: number
    }>
    return { auth: row?.auth_version ?? 0, permission: row?.permission_version ?? 0 }
  }

  async requestRows(): Promise<number> {
    const [row] = (await sql`
      SELECT count(*)::int AS n FROM ${K()}.approval_requests
      WHERE org_id = ${this.orgId} AND tool_params->>'taskId' = ${this.taskId}`) as Array<{
      n: number
    }>
    return row?.n ?? 0
  }

  // ── reading ───────────────────────────────────────────────────────────────

  /** What every reader sees of the request, through Home and the request's card. */
  async read(requestId = this.requestId): Promise<Reading> {
    const out: Reading = {}
    for (const r of ROLES) out[r] = await this.sightOf(r, requestId)
    out.profile = await this.profileSight()
    return out
  }

  async sightOf(who: Role, requestId: string): Promise<Sight> {
    const userId = this.people[who]
    const status = await this.userStatus(who)
    if (status !== "active") return { visible: false }
    const ctx = await ctxOf(this.orgId, userId)
    const { item, card } = await withRlsContext(ctx, async (tx) => {
      const feed: AttentionItem[] = await computeApprovalAttentionItems(tx, this.orgId, userId)
      const card = await getApproval(tx, { orgId: this.orgId, userId, requestId })
      return { item: feed.find((i) => i.entityId === requestId) ?? null, card }
    })
    const meta = (item?.metadata ?? {}) as Record<string, unknown>
    const route = meta.route as
      | {
          to: string
          userId?: string
          standIn?: string | null
          blockedStandIn?: string | null
          awayUntil?: string | null
        }
      | undefined
    const decided = card && card.status !== "pending" ? card.status : null
    let state: string | null = decided
    if (!state && item && route) {
      if (route.to === "usual") state = "usual"
      else if (route.to === "person")
        state = route.blockedStandIn ? "blocked" : route.awayUntil ? "away" : "here"
      else state = route.to
    }
    const placement = (meta.placement as string | undefined) ?? null
    return {
      visible: Boolean(item) || Boolean(card),
      points: route?.to === "person" ? this.roleOf(route.userId) : null,
      label: item?.summary ?? card?.summary?.title ?? null,
      state,
      placement,
      forPerson: placement === "standing_in" ? this.roleOf(route?.userId) : null,
    }
  }

  /** The away person's own profile: their running range and whom it names. */
  async profileSight(): Promise<Sight> {
    if ((await this.userStatus("person")) !== "active") return { visible: false }
    const listed = await listAwayRanges(this.orgId, this.people.person)
    const running = listed.ranges.find((r) => r.runningToday)
    if (!running) return { visible: false }
    return {
      visible: true,
      points: this.roleOf(running.nextInLine?.id ?? null),
      state: running.nextInLine && !running.nextInLine.active ? "left" : null,
    }
  }
}
