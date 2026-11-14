// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What starting a software-world scenario writes into the visitor's
// workspace, once and idempotently: the support routine that drafts a reply to
// the new ticket, the visitor's own task in the product project, the sales
// routine (left off: the scenario's beat switches it on). Each is written
// through the same factories the seed uses, as the people the pack names, and
// none of it approves or sends anything. The scenarios that need nothing
// brought in (chat, knowledge, developers, money) write nothing here.
import { and, sql as drizzleSql, eq } from "drizzle-orm"
import { createTask } from "~/apps/projects/service/tasks"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { users } from "~/db/schema/kernel"
import { agents } from "~/db/schema/kernel/agents"
import { seedContext } from "~/seed/context"
import { agentDmWith, personalAgentOf } from "~/seed/factories/agent/presence"
import { enableEventRoutine, scopeReader, seedRoutine } from "~/seed/factories/agent/routines"
import { actorFor, asUser } from "~/seed/factories/people/actors"
import { SAAS_PROJECTS_TASK_REF, SAAS_PROJECTS_TASK_TITLE } from "./projects-comment"
import {
  PROSPECT_SCENARIO_ROUTINE_NAME,
  prospectRoutinePrompt,
  SAAS_SUPPORT_ROUTINE_NAME,
  SUPPORT_ROUTINE_PROMPT,
} from "./scenario-routines"

const PRODUCT_PROJECT_NAME = "Product"

type Need = "support" | "projects" | "chat" | "sales" | "money" | "dev" | "knowledge" | string

/** A teammate of the org's own world, by name: members only, never a client's account. */
async function userIdByName(orgId: string, name: string): Promise<string> {
  const [row] = await withPrivilegedDb(orgId, "demo-saas-start:user", (tx) =>
    tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.orgId, orgId), eq(users.userType, "member"), eq(users.name, name)))
      .limit(1),
  )
  if (!row) throw new Error(`demo world: no teammate named ${name} in this org`)
  return row.id
}

async function agentIdByName(orgId: string, displayName: string): Promise<string> {
  const [row] = await withPrivilegedDb(orgId, "demo-saas-start:agent", (tx) =>
    tx
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), eq(agents.displayName, displayName)))
      .limit(1),
  )
  if (!row) throw new Error(`demo world: no ${displayName} agent in this org`)
  return row.id
}

/** The support routine: it drafts a reply to every new ticket, switched on at start. */
async function startSupport(orgId: string, ownerUserId: string): Promise<void> {
  const ctx = seedContext({ orgId, now: new Date() })
  const lead = await userIdByName(orgId, "Inès Caron")
  const routineId = await seedRoutine(ctx, {
    createdByUserId: ownerUserId,
    ownerScopes: await scopeReader(ctx)(lead),
    routine: {
      name: SAAS_SUPPORT_ROUTINE_NAME,
      description:
        "The moment a ticket is opened: read it and the customer's history, leave a note for the team and draft the reply for a person to approve.",
      kind: "event",
      event: "tickets:ticket:create",
      eventFilter: null,
      reportThreadId: null,
      ownerUserId: lead,
      ownerAgentId: await agentIdByName(orgId, "Support Desk"),
      scopes: [
        "tickets:tickets:read",
        "tickets:tickets:write",
        "tickets:tickets:reply",
        "tickets:inboxes:read",
        "knowledge:documents:read",
        "kernel:contacts:read",
      ],
      prompt: SUPPORT_ROUTINE_PROMPT,
    },
  })
  await enableEventRoutine(orgId, routineId)
}

/** The visitor's own task in the product project, for the developer's comment to land on. */
async function startProjects(orgId: string, ownerUserId: string): Promise<void> {
  const project = extractRows<{ id: string }>(
    await withPrivilegedDb(orgId, "demo-saas-start:project", (tx) =>
      tx.execute(
        drizzleSql`SELECT id::text AS id FROM app_projects.projects
          WHERE org_id = ${orgId}::uuid AND name = ${PRODUCT_PROJECT_NAME} LIMIT 1`,
      ),
    ),
  )[0]
  if (!project) throw new Error("demo world: the product project is not seeded")
  const ctx = seedContext({ orgId, now: new Date() })
  const actor = await actorFor(ctx, ownerUserId)
  await asUser(actor, async (tx) => {
    const existing = extractRows<{ id: string }>(
      await tx.execute(
        drizzleSql`SELECT id::text AS id FROM app_projects.tasks
          WHERE org_id = ${orgId}::uuid AND external_ref = ${SAAS_PROJECTS_TASK_REF} LIMIT 1`,
      ),
    )[0]
    if (existing) return
    await createTask({
      tx: tx as never,
      orgId,
      actor,
      input: {
        projectId: project.id,
        title: SAAS_PROJECTS_TASK_TITLE,
        description:
          "Customers moving from spreadsheets send one CSV file per venue: read it, check every row and show a preview before anything is saved.",
        assigneeId: ownerUserId,
        externalRef: SAAS_PROJECTS_TASK_REF,
      } as never,
    })
  })
}

/** The sales routine, off: the scenario's own beat switches it on. */
async function startSales(orgId: string, ownerUserId: string): Promise<void> {
  const ctx = seedContext({ orgId, now: new Date() })
  const agentId = await personalAgentOf(ctx, ownerUserId)
  if (!agentId) throw new Error("demo world: the owner has no personal agent")
  const profile = extractRows<{ id: string }>(
    await withPrivilegedDb(orgId, "demo-saas-start:issuer", (tx) =>
      tx.execute(
        drizzleSql`SELECT id::text AS id FROM app_invoicing.issuer_profiles
          WHERE org_id = ${orgId}::uuid ORDER BY created_at LIMIT 1`,
      ),
    ),
  )[0]
  if (!profile) throw new Error("demo world: no issuer profile to quote from")
  await seedRoutine(ctx, {
    createdByUserId: ownerUserId,
    ownerScopes: await scopeReader(ctx)(ownerUserId),
    routine: {
      name: PROSPECT_SCENARIO_ROUTINE_NAME,
      description:
        "When a hotel group asks for a quote: check Liaison, read up on a new group, then prepare its company and contact, a quote and the reply as one request I approve once.",
      kind: "event",
      event: "mail:message:create",
      eventFilter: null,
      reportThreadId: await agentDmWith(ctx, ownerUserId, agentId),
      ownerUserId,
      ownerAgentId: agentId,
      scopes: [
        "mail:conversations:read",
        "mail:conversations:write",
        "mail:accounts:read",
        "kernel:contacts:read",
        "kernel:contacts:write",
        "kernel:companies:read",
        "kernel:companies:write",
        "invoicing:documents:write",
        "invoicing:documents:read",
        "invoicing:settings:read",
        "projects:tasks:write",
        "projects:projects:read",
        "kernel:threads:write",
        "kernel:agent:web",
      ],
      prompt: prospectRoutinePrompt(profile.id),
    },
  })
}

/**
 * Write what the scenario of `need` brings into the software world's
 * workspace. Returns no approval ids: none of these scenarios seeds one.
 */
export async function saasScenarioStart(
  orgId: string,
  need: Need,
  ownerUserId: string,
): Promise<string[]> {
  if (need === "support") await startSupport(orgId, ownerUserId)
  else if (need === "projects") await startProjects(orgId, ownerUserId)
  else if (need === "sales") await startSales(orgId, ownerUserId)
  return []
}
