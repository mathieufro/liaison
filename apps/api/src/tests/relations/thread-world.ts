// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The world of a conversation made from a record: a task or a ticket created by its app's tools,
// a conversation created from it as the threads route does (the creator must see the record), and
// each participant reading the conversation's anchor as its page does (resolveThreadAnchor under
// their own row security). Readers: `owner` made it, `member` is a participant who can read the
// record, `outsider` is a participant who never could.

import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { deleteTask, restoreTask } from "~/apps/projects/service/tasks"
import { extractRows } from "~/db"
import { sql } from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { executeTool } from "~/modules/apps/execute-tool"
import { disableOrgApp } from "~/modules/apps/org-app-admin"
import { listOrgAppStates } from "~/modules/apps/org-apps"
import { createThread } from "~/modules/threads/thread"
import {
  canReadThreadAnchorEntity,
  resolveThreadAnchor,
  threadAnchorRef,
} from "~/modules/threads/thread-anchor"
import * as minimal from "~/seed/tiers/minimal"
import { type ApprovalOrg, ctxOf, projectName } from "./approval-world"
import type { Reading, Sight } from "./classes"

/** The kernel schema as the run names it (a test namespace prefixes it). */
const KD = () => drizzleSql.raw(schemaRef("kernel"))

export type ThreadOrg = ApprovalOrg

const READERS = ["owner", "member", "outsider"] as const
type Reader = (typeof READERS)[number]

const TASK_READ = ["projects:projects:read", "projects:tasks:read"]
const TICKET_READ = ["tickets:tickets:read"]

export class ThreadCase {
  people = {} as Record<Reader, string>
  threadId = ""
  taskId = ""
  ticketId = ""
  survivorId = ""
  newTitle = ""
  private readScopes: string[] = []

  constructor(readonly org: ThreadOrg) {}

  get orgId(): string {
    return this.org.orgId
  }

  roleOf(id: string | null | undefined): string | null {
    if (!id) return null
    if (id === this.taskId) return "task"
    if (id === this.ticketId) return "ticket"
    if (id === this.survivorId) return "survivor"
    return id
  }

  private async tool(toolName: string, params: Record<string, unknown>) {
    const res = await executeTool({ toolName, orgId: this.orgId, actor: this.org.admin, params })
    if (res.blocked) throw new Error(`${toolName} refused: ${JSON.stringify(res)}`)
    return res
  }

  private async people3(scopes: string[]): Promise<void> {
    const tag = randomUUID().slice(0, 6)
    for (const r of READERS)
      this.people[r] = (await minimal.person(this.orgId, { name: `T${tag}${r} Thr` })).id
    for (const r of ["owner", "member"] as const)
      for (const s of scopes) await minimal.grantScope(this.people[r], s)
    this.readScopes = scopes
  }

  private async createFrom(app: string, entityType: string, entityId: string): Promise<void> {
    const owner = await ctxOf(this.orgId, this.people.owner)
    const createdFrom = { app, entityType, entityId }
    const ref = threadAnchorRef(createdFrom, this.orgId)
    if (!ref) throw new Error(`${app}:${entityType} has no page to anchor to`)
    const created = await withRlsContext(owner, async (tx) => {
      if (!(await canReadThreadAnchorEntity(tx, this.orgId, ref)))
        throw new Error("the owner cannot see the record")
      return createThread(tx, {
        orgId: this.orgId,
        userId: this.people.owner,
        participantIds: [this.people.member, this.people.outsider],
        title: `About ${entityType} ${randomUUID().slice(0, 6)}`,
        createdFrom,
        forceCreate: true,
      })
    })
    this.threadId = (created as { id: string }).id
  }

  async buildOnTask(): Promise<this> {
    await this.people3(TASK_READ)
    const title = `Anchor task ${randomUUID().slice(0, 6)}`
    const res = await this.tool("projects:createProject", {
      name: projectName(),
      tasks: [{ title }],
    })
    this.taskId = (res.data as { tasks?: Array<{ id: string }> }).tasks?.[0]?.id ?? ""
    if (!this.taskId) throw new Error(`task not created: ${JSON.stringify(res)}`)
    this.newTitle = `${title} renamed`
    await this.createFrom("projects", "task", this.taskId)
    return this
  }

  async buildOnTicket(): Promise<this> {
    await this.people3(TICKET_READ)
    const one = await this.tool("tickets:create", {
      subject: `Anchor ticket ${randomUUID().slice(0, 6)}`,
      channel: "manual",
    })
    const two = await this.tool("tickets:create", {
      subject: `Surviving ticket ${randomUUID().slice(0, 6)}`,
      channel: "manual",
    })
    this.ticketId = (one.data as { ticketId?: string }).ticketId ?? ""
    this.survivorId = (two.data as { ticketId?: string }).ticketId ?? ""
    if (!this.ticketId || !this.survivorId) throw new Error("tickets not created")
    await this.createFrom("tickets", "ticket", this.ticketId)
    return this
  }

  async renameTask(): Promise<void> {
    await this.tool("projects:update", { taskId: this.taskId, title: this.newTitle })
  }

  async taskTitleNow(): Promise<string | null> {
    const [row] =
      (await sql`SELECT title FROM app_projects.tasks WHERE id = ${this.taskId}::uuid`) as Array<{
        title: string
      }>
    return row?.title ?? null
  }

  async moveTask(): Promise<void> {
    const other = await this.tool("projects:createProject", { name: projectName() })
    const projectId =
      (other.data as { projectId?: string; id?: string }).projectId ??
      (other.data as { id?: string }).id
    if (!projectId) throw new Error(`project not created: ${JSON.stringify(other)}`)
    await this.tool("projects:move", { taskId: this.taskId, projectId })
  }

  async taskRow(): Promise<{ projectId: string; archived: boolean; updatedAt: string }> {
    const [row] = (await sql`
      SELECT project_id, archived_at IS NOT NULL AS archived, updated_at::text AS updated_at
      FROM app_projects.tasks WHERE id = ${this.taskId}::uuid`) as Array<{
      project_id: string
      archived: boolean
      updated_at: string
    }>
    if (!row) throw new Error("task row gone")
    return { projectId: row.project_id, archived: row.archived, updatedAt: row.updated_at }
  }

  async binAndRestoreTask(): Promise<void> {
    await withRlsContext(this.org.admin, (tx) =>
      deleteTask({ tx, orgId: this.orgId, actor: this.org.admin, taskId: this.taskId }),
    )
    await withRlsContext(this.org.admin, (tx) =>
      restoreTask({ tx, orgId: this.orgId, actor: this.org.admin, taskId: this.taskId }),
    )
  }

  async switchProjectsOff(): Promise<void> {
    await disableOrgApp(this.orgId, "projects", { actorId: this.org.adminId, actorType: "user" })
  }

  async projectsStatus(): Promise<string | null> {
    return (await listOrgAppStates(this.orgId)).find((s) => s.app === "projects")?.status ?? null
  }

  async revokeMemberRead(): Promise<void> {
    for (const s of this.readScopes) await minimal.revokeScope(this.people.member, s)
  }

  async memberCanReadTasks(): Promise<boolean> {
    const ctx = await ctxOf(this.orgId, this.people.member)
    return this.readScopes.some((s) => ctx.scopes.includes(s))
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

  async read(): Promise<Reading> {
    const out: Reading = {}
    for (const r of READERS) out[r] = await this.sightOf(r)
    return out
  }

  private async sightOf(who: Reader): Promise<Sight> {
    const ctx = await ctxOf(this.orgId, this.people[who])
    const anchor = await withRlsContext(ctx, async (tx) => {
      const [row] = extractRows<{ created_from: unknown }>(
        await tx.execute(
          drizzleSql`SELECT created_from FROM ${KD()}.threads WHERE id = ${this.threadId}::uuid`,
        ),
      )
      const ref = threadAnchorRef(row?.created_from, this.orgId)
      return ref ? resolveThreadAnchor(tx, this.orgId, ref) : null
    })
    if (!anchor?.label) return { visible: false }
    return {
      visible: true,
      label: anchor.label,
      points: this.roleOf(anchor.entityId),
      state: anchor.state ?? null,
    }
  }
}
