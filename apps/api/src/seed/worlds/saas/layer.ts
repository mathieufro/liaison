// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The `saas` world's own layer: it writes the plan (`plan.ts`) after the
// shared support layer, through the product's own services: the companies
// and their account managers, the pipeline's deals in number order with their
// dates, the subtasks under the Arlon expansion, who is away, and the three
// routines. Every write is idempotent: a re-run adopts what is there.
import { and, eq, sql } from "drizzle-orm"
import { setLostReason, writeDealFields } from "~/apps/projects/service/deals"
import { createTask } from "~/apps/projects/service/tasks"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { contactAddresses, routines } from "~/db/schema/kernel"
import { messages } from "~/db/schema/kernel/threads"
import { schemaRef } from "~/db/schema-ref"
import { refreshPersonalAgentCeiling } from "~/modules/agent/directory/personal-agent"
import { MORNING_BRIEF_TEMPLATE_KEY } from "~/modules/agent/routines/kernel-routine-templates"
import { routineTemplateRegistry } from "~/modules/apps/app-registries"
import { awaitOrgApps } from "~/modules/apps/init"
import { setCompanyManager } from "~/modules/contacts/companies"
import { installDemoPaymentsConnection } from "~/modules/demo/worlds/saas/payments/connection"
import { forgetDemoPaymentsOutside } from "~/modules/demo/worlds/saas/payments/overlay"
import { buildSendGuard } from "~/modules/mail/send-guard"
import { addSuppression } from "~/modules/mail/suppressions"
import { SEEDED_METADATA } from "~/modules/notifications/seeded"
import { sendMessage } from "~/modules/threads/message"
import { createThread } from "~/modules/threads/thread"
import { setAway } from "~/modules/users/away"
import { type SeedContext, seedContext } from "~/seed/context"
import { scopeReader, seedRoutine } from "~/seed/factories/agent/routines"
import { type AppCell, upsertAppRow } from "~/seed/factories/app-tables"
import { type ApprovalRequestSeed, seedApprovalRequests } from "~/seed/factories/approvals/requests"
import { type EventSpec, seedTeamCalendar } from "~/seed/factories/calendar/events"
import {
  computeDocuments,
  type InvoicingDocumentSpec,
  type InvoicingParty,
  recurringScheduleRows,
  seedInvoicingHistory,
} from "~/seed/factories/commerce/invoicing"
import { insertUnarmedMail } from "~/seed/factories/mail/conversations"
import { type PaymentsMirrorSpec, seedPaymentsMirror } from "~/seed/factories/payments/mirror"
import { actorFor, asUser, rowsOf } from "~/seed/factories/people/actors"
import { seedCompanies } from "~/seed/factories/people/companies"
import { resolveContacts } from "~/seed/factories/people/contacts"
import { seedPipeline } from "~/seed/factories/projects/deals"
import type { SeedDemoOrgResult } from "~/seed/tiers/demo/seed-org"
import { STORY_TIME_ZONE, storyClock } from "~/seed/worlds/story-clock"
import type { DemoWorldLayerInput } from "../index"
import { SAAS_ROUTINES } from "./agent-native"
import { saasMorningBrief } from "./brief"
import {
  SAAS_AWAY,
  SAAS_BILLING_ADDRESSES,
  SAAS_COMPANY,
  SAAS_CUSTOMERS,
  SAAS_PLANS,
} from "./fiction"
import {
  SAAS_PIPELINE_KEY,
  SAAS_TRANSFER_KEYS,
  type SaasMoneyPlan,
  type SaasPlanResult,
  saasMoneyPlan,
  saasPlan,
} from "./plan"
import {
  SAAS_FOLLOWUPS,
  SAAS_SUPPORT_SPECS,
  SAAS_TICKET_KEYS,
  saasKoraConversation,
} from "./support-specs"
import { SAAS_CHANNEL_TITLES } from "./threads-specs"

type ExecTx = { execute: (q: unknown) => Promise<unknown> }

/** A deal or subtask's idempotency key. */
export const saasDealRef = (key: string) => `demo:saas:deal:${key}`

/** The workspace's owner, or the founder's seat for an org nobody signs into. */
function ownerIdOf(org: SeedDemoOrgResult): string {
  return org.ownerUserId ?? org.adminUserId
}

function userIdOf(org: SeedDemoOrgResult, key: string): string {
  if (key === "owner") return ownerIdOf(org)
  const id = org.peopleByKey[key]?.userId
  if (!id) throw new Error(`saas layer: no person '${key}'`)
  return id
}

/**
 * The personal agent of the person a routine runs as: the signed-in owner's own
 * when the org has one, else the seeded teammate's (an org seeded with no owner
 * runs the owner's routines as its admin, `ownerIdOf`).
 */
function personalAgentOf(org: SeedDemoOrgResult, userId: string) {
  const personal = org.agents.filter((a) => a.kind === "personal")
  if (org.ownerUserId === userId) {
    const own = personal.find((a) => (a as { ownerKey?: string }).ownerKey === undefined)
    if (own) return own
  }
  const person = org.people.find((p) => p.userId === userId)
  return person ? personal.find((a) => a.agentId === person.personalAgentId) : undefined
}

/** A Paris calendar date, `YYYY-MM-DD`. */
function parisDate(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: STORY_TIME_ZONE }).format(at)
}

const KIND_TAGS: Record<string, string[]> = {
  paying: ["customer"],
  trial: ["trial"],
  "cancelled-this-month": ["cancelled"],
  "cancelled-last-month": ["cancelled"],
  transfer: ["customer", "bank-transfer"],
  prospect: ["prospect"],
  past: ["past-customer"],
}

async function seedSaasCompanies(
  ctx: SeedContext,
  org: SeedDemoOrgResult,
  actor: UserContext,
  plan: SaasPlanResult,
): Promise<{ companyIds: Record<string, string>; contactIds: Record<string, string> }> {
  const contacts = await resolveContacts(
    ctx,
    actor,
    SAAS_CUSTOMERS.map((c) => ({
      key: `customer:${c.key}`,
      email: c.email,
      name: c.name,
      externalId: { demo: `customer:${c.key}` },
      tags: ["customer"],
    })),
  )
  const contactIds = Object.fromEntries(contacts.map(([key, c]) => [key, c.id]))
  const companyIds = await seedCompanies(
    ctx,
    actor,
    plan.companies.map((c) => ({
      key: c.key,
      name: c.name,
      domain: c.domain,
      tags: KIND_TAGS[c.kind] ?? [],
      contactKeys: c.contactKeys,
    })),
    contactIds,
  )
  // Each person's lawful basis, as a person records it on the contact: a paying
  // company's people are customers, everyone else was met in the course of business.
  const clock = storyClock(ctx.now)
  const paying = new Set(["paying", "transfer"])
  const byBasis = new Map<string, string[]>()
  for (const c of plan.companies) {
    const basis = paying.has(c.kind) ? "customer" : "professional_interest"
    for (const key of c.contactKeys) {
      const id = contactIds[key]
      if (id) byBasis.set(basis, [...(byBasis.get(basis) ?? []), id])
    }
  }
  await withPrivilegedDb(ctx.orgId, "saas-seed-lawful-basis", async (tx) => {
    for (const [basis, ids] of byBasis) {
      await tx.execute(
        sql`UPDATE ${sql.raw(schemaRef("kernel"))}.contacts
            SET lawful_basis = ${basis}, lawful_basis_at = ${clock.d(-30).toISOString()}::timestamptz,
                lawful_basis_source = 'Recorded when the contact was added', is_consumer = false
            WHERE org_id = ${ctx.orgId}::uuid AND id = ANY(${`{${ids.join(",")}}`}::uuid[])
              AND lawful_basis IS NULL`,
      )
    }
  })
  // Account managers, one call per manager.
  const byManager = new Map<string, string[]>()
  for (const c of plan.companies) {
    const id = companyIds[c.key]
    if (!c.manager || !id) continue
    byManager.set(c.manager, [...(byManager.get(c.manager) ?? []), id])
  }
  for (const [manager, ids] of byManager) {
    const result = await asUser(actor, (tx) =>
      setCompanyManager(tx as never, {
        orgId: ctx.orgId,
        userId: actor.userId,
        companyIds: ids,
        ownerUserId: userIdOf(org, manager),
      }),
    )
    if (result.skipped.length > 0) {
      throw new Error(
        `saas layer: account manager ${manager} skipped ${result.skipped.map((s) => `${s.name} (${s.code})`).join(", ")}`,
      )
    }
  }
  return { companyIds, contactIds }
}

async function seedSaasDeals(
  ctx: SeedContext,
  org: SeedDemoOrgResult,
  actor: UserContext,
  plan: SaasPlanResult,
  companyIds: Record<string, string>,
  contactIds: Record<string, string>,
): Promise<Record<string, string>> {
  const { projectId } = await seedPipeline(ctx, actor, {
    people: org.peopleByKey,
    companyIds,
    contactIds,
    spec: { ...SAAS_SUPPORT_SPECS.pipeline, deals: [] },
    externalRefOf: saasDealRef,
  })
  const ids: Record<string, string> = {}
  const closed: Array<{ id: string; at: Date }> = []
  // In number order, so each one lands on its own `SALES-<n>`.
  const rows = [
    ...plan.deals.map((d) => ({ n: d.number, deal: d, sub: null })),
    ...plan.subtasks.map((s) => ({ n: s.number, deal: null, sub: s })),
  ].sort((a, b) => a.n - b.n)
  await asUser(actor, async (tx) => {
    for (const { deal, sub } of rows) {
      const key = (deal ?? sub)?.key as string
      const externalRef = saasDealRef(key)
      const existing = rowsOf<{ id: string }>(
        await (tx as ExecTx).execute(
          sql`SELECT id FROM ${sql.raw(schemaRef("app_projects"))}.tasks
              WHERE org_id = ${ctx.orgId} AND external_ref = ${externalRef} LIMIT 1`,
        ),
      )[0]
      if (existing) {
        ids[key] = existing.id
        continue
      }
      if (sub) {
        const parent = plan.deals.find((d) => d.number === sub.parentNumber)
        const parentId = parent ? ids[parent.key] : undefined
        if (!parentId) throw new Error(`saas layer: no deal ${sub.parentNumber} for ${sub.key}`)
        const task = await createTask({
          tx: tx as never,
          orgId: ctx.orgId,
          actor,
          input: {
            projectId,
            parentTaskId: parentId,
            title: sub.title,
            assigneeId: userIdOf(org, sub.owner),
            dueDate: parisDate(sub.dueAt),
            externalRef,
          } as never,
        })
        ids[key] = task.id
        continue
      }
      const d = deal as NonNullable<typeof deal>
      const task = await createTask({
        tx: tx as never,
        orgId: ctx.orgId,
        actor,
        input: {
          projectId,
          title: d.title,
          statusLabel: d.stage,
          assigneeId: userIdOf(org, d.owner),
          externalRef,
          createdAt: d.createdAt.toISOString(),
        } as never,
      })
      const companyId = companyIds[d.companyKey]
      const contactId = d.contactKey ? contactIds[d.contactKey] : undefined
      await writeDealFields(tx as never, ctx.orgId, actor.scopes, task.id, {
        ...(companyId ? { companyId } : {}),
        ...(contactId ? { contactId } : {}),
        amountMinor: d.amountMinor,
        currency: "EUR",
        ...(d.nextStep ? { nextStep: d.nextStep } : {}),
      })
      if (d.lostReason) await setLostReason(tx as never, ctx.orgId, task.id, d.lostReason)
      if (d.closedAt) closed.push({ id: task.id, at: d.closedAt })
      ids[d.key] = task.id
    }
  })
  // A won or lost deal closed on its story date, not at the moment of the seed.
  if (closed.length > 0) {
    await withPrivilegedDb(ctx.orgId, "saas-seed-deal-close-dates", async (tx) => {
      for (const c of closed) {
        await tx.execute(
          sql`UPDATE ${sql.raw(schemaRef("app_projects"))}.deals SET closed_at = ${c.at.toISOString()}::timestamptz
              WHERE org_id = ${ctx.orgId}::uuid AND task_id = ${c.id}::uuid`,
        )
      }
    })
  }
  ctx.log(
    `deals: ${plan.deals.length} deals and ${plan.subtasks.length} subtasks in ${SAAS_PIPELINE_KEY}`,
  )
  return ids
}

/** Who is away from the anchor, and who is next in line. */
async function seedSaasAway(ctx: SeedContext, org: SeedDemoOrgResult): Promise<void> {
  const clock = storyClock(ctx.now)
  const admin = await actorFor(ctx, org.adminUserId)
  for (const away of SAAS_AWAY) {
    // Idempotent: a re-seed leaves a range already recorded as it is.
    const recorded = await withPrivilegedDb(ctx.orgId, "saas-seed-away-read", async (tx) =>
      rowsOf<{ id: string }>(
        await tx.execute(
          sql`SELECT id FROM ${sql.raw(schemaRef("kernel"))}.away_ranges
              WHERE org_id = ${ctx.orgId}::uuid AND user_id = ${userIdOf(org, away.key)}::uuid LIMIT 1`,
        ),
      ),
    )
    if (recorded.length > 0) continue
    await setAway({
      orgId: ctx.orgId,
      actorId: admin.userId,
      actorScopes: admin.scopes,
      userId: userIdOf(org, away.key),
      form: { from: parisDate(clock.d(0)), to: parisDate(clock.d(away.untilDay)) },
      ...(away.nextInLine === "owner" ? { nextInLineId: ownerIdOf(org) } : {}),
      now: ctx.now,
    })
  }
  ctx.log(`away: ${SAAS_AWAY.map((a) => a.key).join(", ")}`)
}

function customerEmail(key: string): string {
  const email = SAAS_CUSTOMERS.find((c) => c.key === key)?.email
  if (!email) throw new Error(`saas layer: no customer '${key}'`)
  return email
}

/** The meetings the named rows hold: Arlon's last one, and Sauvan's pricing call. */
async function seedSaasMeetings(
  ctx: SeedContext,
  org: SeedDemoOrgResult,
  actor: UserContext,
): Promise<void> {
  const clock = storyClock(ctx.now)
  const isoDow = ((d: Date) => {
    const name = new Intl.DateTimeFormat("en-US", {
      timeZone: STORY_TIME_ZONE,
      weekday: "short",
    }).format(d)
    return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(name)
  })(ctx.now)
  const hourOf = (d: Date) =>
    Number(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: STORY_TIME_ZONE,
        hour: "numeric",
        hourCycle: "h23",
      }).format(d),
    )
  // Sauvan's call: two hours after the anchor inside working hours, else the next working day at 10:00.
  const inTwo = clock.h(2)
  const workingNow = isoDow < 5 && hourOf(inTwo) >= 9 && hourOf(inTwo) < 18
  const nextWorkingDay = isoDow >= 4 ? 7 - isoDow : 1
  const events: EventSpec[] = [
    {
      key: "arlon-review",
      title: "Maison Arlon, rollout review",
      day: isoDow - 4,
      startHour: 11,
      durationMinutes: 45,
      // Claire attends, so the meeting is on Maison Arlon's timeline.
      attendees: ["tom", "elodie", customerEmail("claire-vidal")],
    },
    workingNow
      ? {
          key: "sauvan-pricing",
          title: "Sauvan, group pricing",
          day: isoDow,
          startHour: hourOf(inTwo),
          durationMinutes: 30,
          attendees: ["tom"],
        }
      : {
          key: "sauvan-pricing",
          title: "Sauvan, group pricing",
          day: isoDow + nextWorkingDay,
          startHour: 10,
          durationMinutes: 30,
          attendees: ["tom"],
        },
  ]
  await seedTeamCalendar(ctx, actor, {
    accountEmail: `team@${org.world.company.supportEmail.split("@")[1]}`,
    calendarExternalId: "demo-team-calendar",
    calendarName: SAAS_SUPPORT_SPECS.calendarName,
    timezone: org.timezone,
    people: org.peopleByKey,
    events,
  })
}

/** Samir's thread, whose out-of-office names a date from the anchor. */
async function seedSaasMail(ctx: SeedContext, org: SeedDemoOrgResult): Promise<void> {
  const domain = org.world.company.supportEmail.split("@")[1] as string
  await insertUnarmedMail(ctx, {
    domain,
    // The shared mailbox the support layer wrote: adopted, never rewritten.
    mailboxes: [
      { box: "org", ownerUserId: null, email: `support@${domain}`, displayName: org.orgName },
    ],
    conversations: [saasKoraConversation(ctx.now)],
  })
}

/**
 * The morning's follow-ups, as the deal follow-ups routine stages them: each
 * one's send check is the product's own (`buildSendGuard`, pinned when it was
 * staged), so the card reads what the check says now. Hugo's opt-out is then
 * recorded the way a person records one, which withdraws the draft to him.
 */
async function seedSaasFollowups(
  ctx: SeedContext,
  org: SeedDemoOrgResult,
  dealIds: Record<string, string>,
  contactIds: Record<string, string>,
): Promise<void> {
  const clock = storyClock(ctx.now)
  const ownerId = ownerIdOf(org)
  const agentId = org.agentsByHandle["@sales"]?.agentId
  if (!agentId) throw new Error("saas layer: no @sales agent for the follow-ups")
  const [thread] = await withPrivilegedDb(ctx.orgId, "saas-seed-followup-thread", async (tx) =>
    rowsOf<{ id: string }>(
      await tx.execute(
        sql`SELECT id FROM ${sql.raw(schemaRef("kernel"))}.threads
            WHERE org_id = ${ctx.orgId}::uuid AND title = ${SAAS_CHANNEL_TITLES.pipeline} LIMIT 1`,
      ),
    ),
  )
  if (!thread) throw new Error("saas layer: no Pipeline channel for the follow-ups")
  const rows: ApprovalRequestSeed[] = []
  for (const f of SAAS_FOLLOWUPS) {
    const dealId = dealIds[f.dealKey]
    const contactId = contactIds[f.contactKey]
    const email = SAAS_CUSTOMERS.find((c) => `customer:${c.key}` === f.contactKey)?.email
    if (!dealId || !contactId || !email) {
      throw new Error(`saas layer: follow-up ${f.key} names no deal, contact or address`)
    }
    const stagedAt = clock.h(-f.hoursAgo)
    const refs = [{ kind: "projects:deal", id: dealId }]
    const built = await buildSendGuard({
      orgId: ctx.orgId,
      toolName: "mail:compose",
      followUpRun: true,
      followUp: { refs },
      recipients: [email],
      contactIds: [contactId],
      agentStaged: true,
      now: stagedAt,
      timeZone: org.timezone,
    })
    if (!("sendGuard" in built)) {
      throw new Error(`saas layer: follow-up ${f.key} not staged: ${JSON.stringify(built)}`)
    }
    rows.push({
      id: ctx.id("approval", f.key),
      handle: `demo-${f.key}`,
      threadId: thread.id,
      toolName: "mail:compose",
      payload: {
        accountId: ctx.id("mail-account", "org"),
        to: [email],
        subject: f.subject,
        textBody: f.body,
        followUp: { refs },
        sendGuard: built.sendGuard,
        ...(built.guardKey ? { guardKey: built.guardKey } : {}),
      },
      requestedBy: ownerId,
      agentId,
      notifyUserIds: [ownerId],
      status: "pending",
      createdAt: stagedAt,
    })
  }
  await seedApprovalRequests(ctx, rows)
  // The opt-out arrives after the draft: recording it withdraws the draft, as it does live.
  for (const f of SAAS_FOLLOWUPS.filter((x) => x.optOutAfter)) {
    const email = SAAS_CUSTOMERS.find((c) => `customer:${c.key}` === f.contactKey)?.email as string
    await addSuppression(null, {
      orgId: ctx.orgId,
      email,
      reason: "reply",
      source: "Asked by reply to stop receiving sales mail",
      createdBy: ownerId,
      actorType: "user",
    })
  }
  ctx.log(`follow-ups: ${rows.length} drafts staged with their send check`)
}

/**
 * The Morning brief as its routine last wrote it, so Home's brief card has the
 * day's brief: the routine's output thread (made the way the routine worker
 * makes it, the owner its admin) and the brief posted there by the owner's
 * agent. A re-run that finds the brief adopts it.
 */
async function seedSaasMorningBrief(
  ctx: SeedContext,
  routineId: string,
  ownerUserId: string,
  agent: { agentId: string; displayName: string },
): Promise<void> {
  const owner = await actorFor(ctx, ownerUserId)
  const [routine] = await withPrivilegedDb(ctx.orgId, "saas-brief:routine", (tx) =>
    tx
      .select({ outputThreadId: routines.outputThreadId })
      .from(routines)
      .where(and(eq(routines.orgId, ctx.orgId), eq(routines.id, routineId))),
  )
  let threadId = routine?.outputThreadId ?? null
  if (!threadId) {
    threadId = await asUser(owner, async (tx) => {
      const created = await createThread(
        tx as never,
        {
          orgId: ctx.orgId,
          userId: ownerUserId,
          participantIds: [],
          title: "Morning brief",
          type: "routine",
          forceCreate: true,
        } as never,
      )
      return created.id as string
    })
    const outputThreadId = threadId
    await withPrivilegedDb(ctx.orgId, "saas-brief:link", (tx) =>
      tx
        .update(routines)
        .set({ outputThreadId, lastRunAt: storyClock(ctx.now).h(-1) })
        .where(and(eq(routines.orgId, ctx.orgId), eq(routines.id, routineId))),
    )
  }
  const briefThreadId = threadId
  const [written] = await withPrivilegedDb(ctx.orgId, "saas-brief:count", (tx) =>
    tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.orgId, ctx.orgId),
          eq(messages.threadId, briefThreadId),
          eq(messages.authorType, "agent"),
        ),
      )
      .limit(1),
  )
  if (written) return
  await asUser(owner, (tx) =>
    sendMessage(
      tx as never,
      {
        orgId: ctx.orgId,
        userId: ownerUserId,
        threadId: briefThreadId,
        content: saasMorningBrief(ctx.now),
        authorType: "agent",
        agentId: agent.agentId,
        agentAuthorLabel: agent.displayName,
        requiredScopes: [],
        metadata: { ...SEEDED_METADATA, seededAt: storyClock(ctx.now).h(-1).toISOString() },
      } as never,
    ),
  )
  ctx.log("routines: the morning brief written to its thread")
}

/** The three routines, on, each from its product template. */
async function seedSaasRoutines(ctx: SeedContext, org: SeedDemoOrgResult): Promise<string[]> {
  // The templates live in the org's app registries, filled on first touch.
  await awaitOrgApps(ctx.orgId)
  const scopesOf = scopeReader(ctx)
  const ids: string[] = []
  for (const spec of SAAS_ROUTINES) {
    const tpl = routineTemplateRegistry.get([
      ctx.orgId,
      spec.template.appName,
      spec.template.templateKey,
    ])
    // An app's routine exists only where that app is on for the org.
    if (spec.template.appName !== "kernel" && !org.appsByName[spec.template.appName]?.enabled) {
      ctx.log(`routines: '${spec.name}' left out, the ${spec.template.appName} app is not on`)
      continue
    }
    if (!tpl) {
      throw new Error(
        `saas layer: routine template ${spec.template.appName}/${spec.template.templateKey} is not registered for this org`,
      )
    }
    const ownerUserId = userIdOf(org, spec.ownerKey)
    const agent =
      spec.ownerHandle === "personal"
        ? personalAgentOf(org, ownerUserId)
        : org.agentsByHandle[spec.ownerHandle]
    if (!agent) throw new Error(`saas layer: no agent ${spec.ownerHandle} for '${spec.name}'`)
    ids.push(
      await seedRoutine(ctx, {
        createdByUserId: org.adminUserId,
        ownerScopes: await scopesOf(ownerUserId),
        enabled: true,
        routine: {
          name: spec.name,
          description: tpl.description,
          kind: "recurring",
          cron: spec.cron,
          timezone: org.timezone,
          ownerUserId,
          ownerAgentId: agent.agentId,
          scopes: [...tpl.scopes],
          prompt: tpl.promptTemplate,
          template: spec.template,
          followUp: tpl.followUp === true,
        },
      }),
    )
    if (spec.template.templateKey === MORNING_BRIEF_TEMPLATE_KEY) {
      await seedSaasMorningBrief(ctx, ids[ids.length - 1] as string, ownerUserId, agent)
    }
  }
  ctx.log(`routines: ${ids.length} seeded on`)
  return ids
}

/** The `saas` layer: everything of the plan the shared layers do not write. */
export async function seedSaasLayer(input: DemoWorldLayerInput): Promise<void> {
  const { org, baseTime, log } = input
  const ctx = seedContext({ orgId: org.orgId, now: baseTime, log })
  const plan = saasPlan(baseTime)
  const actor = await actorFor(ctx, ownerIdOf(org))
  const { companyIds, contactIds } = await seedSaasCompanies(ctx, org, actor, plan)
  const dealIds = await seedSaasDeals(ctx, org, actor, plan, companyIds, contactIds)
  await seedSaasAway(ctx, org)
  await seedSaasMeetings(ctx, org, actor)
  await seedSaasMail(ctx, org)
  await seedSaasFollowups(ctx, org, dealIds, contactIds)
  await seedSaasRoutines(ctx, org)
  await seedSaasMoney(ctx, org, actor, plan, companyIds, contactIds)
}

// ── Money ────────────────────────────────────────────────────────────────────

/** The payments app and the invoicing app, by the ids they are installed under. */
const PAYMENTS_APP = "stripe"
const INVOICING_APP = "invoicing"

/** The issuer profile's key: the company that invoices. */
const ISSUER_KEY = "saas-issuer"

/**
 * The money of the workspace, in the order the apps would have written it:
 * the card-payments connection (the demo stand-in), the issuer and who issues
 * what, the year's invoices with their numbers, the schedules billed by
 * transfer, the card mirror linked to the invoices it paid, and the two
 * decisions waiting on Home (Maison Arlon's card reminder, Café Ombre's refund).
 */
async function seedSaasMoney(
  ctx: SeedContext,
  org: SeedDemoOrgResult,
  actor: UserContext,
  plan: SaasPlanResult,
  companyIds: Record<string, string>,
  contactIds: Record<string, string>,
): Promise<void> {
  const money = saasMoneyPlan(ctx.now)
  const clock = storyClock(ctx.now)
  const companyOf = (key: string) => {
    const c = plan.companies.find((x) => x.key === key)
    if (!c) throw new Error(`saas layer: no company '${key}'`)
    return c
  }
  // A re-seed starts from the mirror alone: what a visitor's play left outside is gone.
  await forgetDemoPaymentsOutside(ctx.orgId)
  await installDemoPaymentsConnection({ orgId: ctx.orgId, createdByUserId: org.adminUserId })

  // The people invoices go to at the companies billed by transfer: their accounts desk.
  const billing = await resolveContacts(
    ctx,
    actor,
    // Every company billed by transfer has one, so the recurring list reads "<Company> accounts".
    SAAS_TRANSFER_KEYS.map((key) => {
      const c = companyOf(key)
      return {
        key: `billing:${key}`,
        email: `compta@${c.domain}`,
        name: `${c.name} accounts`,
        externalId: { demo: `billing:${key}` },
        tags: ["customer"],
      }
    }),
  )
  const contactOfCompany: Record<string, string> = {}
  for (const [key, c] of billing) contactOfCompany[key.replace(/^billing:/, "")] = c.id
  // Each accounts desk's billing address: a schedule's draft takes its address from its
  // contact, so a transfer customer with none could never be issued.
  await withPrivilegedDb(ctx.orgId, "saas-seed-billing-addresses", async (tx) => {
    for (const [key, c] of billing) {
      const company = companyOf(key.replace(/^billing:/, ""))
      const a = SAAS_BILLING_ADDRESSES[company.name]
      if (!a) throw new Error(`saas layer: no billing address for ${company.name}`)
      await tx
        .insert(contactAddresses)
        .values({
          id: ctx.id("contact-address", key),
          orgId: ctx.orgId,
          contactId: c.id,
          role: "billing",
          name: `${company.name} accounts`,
          company: company.name,
          street1: a.street1,
          postalCode: a.postalCode,
          city: a.city,
          countryIso2: a.countryIso2,
          origin: "import",
          createdAt: sec(clock.d(-300)),
          updatedAt: sec(clock.d(-300)),
        })
        .onConflictDoNothing()
    }
  })
  for (const c of plan.companies) {
    if (contactOfCompany[c.key]) continue
    const first = c.contactKeys[0]
    const id = first ? contactIds[first] : undefined
    if (id) contactOfCompany[c.key] = id
  }

  // The issued invoices of the year, priced and numbered by the plan.
  const parties = new Map<string, InvoicingParty>()
  for (const inv of money.invoices) {
    if (parties.has(inv.companyKey)) continue
    const c = companyOf(inv.companyKey)
    const dutch = c.name === "Stadshotel Noord BV"
    parties.set(c.key, {
      key: c.key,
      name: c.name,
      email: emailOfCompany(c.key, c.domain, c.contactKeys),
      country: dutch ? "NL" : "FR",
      // A Dutch business with its VAT number: reverse charge.
      vatId: dutch ? "NL000000000B00" : null,
      address: dutch ? `${c.name}, Amsterdam, Netherlands` : `${c.name}, France`,
    })
  }
  // An invoice a card charge collects names the processor's invoice, charge and customer, as an
  // invoice issued for the processor's does.
  const collectedBy = new Map(
    money.charges
      .filter((c) => c.invoiceKey !== null)
      .map((c) => [
        c.invoiceKey as string,
        {
          [`${PAYMENTS_APP}_invoice_id`]: c.invoiceId,
          [`${PAYMENTS_APP}_charge_id`]: c.chargeId,
          [`${PAYMENTS_APP}_customer_id`]: c.customerId,
          ...(c.subscriptionId ? { [`${PAYMENTS_APP}_subscription_id`]: c.subscriptionId } : {}),
        },
      ]),
  )
  const specs: InvoicingDocumentSpec[] = money.invoices.map((inv) => ({
    key: inv.key,
    ...(collectedBy.has(inv.key) ? { externalRefs: collectedBy.get(inv.key) } : {}),
    type: "invoice",
    status: inv.paidAt ? "paid" : "issued",
    paymentStatus: inv.paidAt ? "paid" : "unpaid",
    party: inv.companyKey,
    lines: [
      {
        description: inv.description,
        unitPriceMinor: inv.unitMinor,
        quantity: inv.quantity,
        lineKind: "software",
      },
    ],
    issuedDaysAgo: (ctx.now.getTime() - inv.issuedAt.getTime()) / 86_400_000,
    termsDays: 30,
  }))
  const byKey = new Map(money.invoices.map((i) => [i.key, i]))
  const documents = computeDocuments(ctx, { documents: specs, parties, skus: new Map() }).map(
    (d) => {
      // The plan's instants and numbers: per year on the company's calendar, in date order.
      const inv = byKey.get(d.spec.key)
      if (!inv) throw new Error(`saas layer: no planned invoice ${d.spec.key}`)
      return {
        ...d,
        issuedAt: inv.issuedAt,
        dueAt: new Date(inv.issuedAt.getTime() + 30 * 86_400_000),
        paidAt: inv.paidAt,
        number: inv.number,
        numberInt: inv.numberInt,
        yearOfIssue: inv.year,
      }
    },
  )
  const { issuerProfileId: issuerId } = await seedInvoicingHistory(ctx, {
    issuer: {
      key: ISSUER_KEY,
      legalName: SAAS_COMPANY.legalName ?? SAAS_COMPANY.name,
      country: SAAS_COMPANY.country ?? "FR",
      vatId: SAAS_COMPANY.vat ?? null,
      address: `${SAAS_COMPANY.addressLine1}, ${SAAS_COMPANY.postalCode} ${SAAS_COMPANY.city}`,
      iban: SAAS_COMPANY.iban ?? "",
      swiftBic: SAAS_COMPANY.swiftBic ?? "",
      bankName: SAAS_COMPANY.bankName ?? "",
      defaultCurrency: "EUR",
      prefixes: {
        invoice: "F-{YYYY}-",
        quote: "Q-{YYYY}-",
        proforma: "PRO-{YYYY}-",
        po: "PO-{YYYY}-",
        creditNote: "CN-{YYYY}-",
      },
      shopifyShopId: null,
      invoiceApprovalThresholdMinor: "0",
      poApprovalThresholdMinor: "0",
      timezone: STORY_TIME_ZONE,
    },
    hsCodes: [],
    relationships: Object.entries(contactOfCompany)
      .filter(([key]) => parties.has(key))
      .map(([key, contactId]) => ({ key, contactId, relationship: "customer" as const })),
    documents,
    contactIdsByPartyKey: contactOfCompany,
  })
  const documentId = (key: string) => ctx.id("document", key)

  await withPrivilegedDb(ctx.orgId, "saas-seed-invoicing", async (tx) => {
    // Each card invoice's document names the processor's invoice it was issued for, as
    // the card stream issues them (`external_ref`): a later paid event finds it.
    const linked = new Map<string, string>()
    for (const c of money.charges) if (c.invoiceKey) linked.set(c.invoiceKey, c.invoiceId)
    for (const [key, invoiceId] of linked) {
      await tx.execute(
        sql`UPDATE ${sql.raw(schemaRef(`app_${INVOICING_APP}`))}.documents
            SET external_ref = ${`${PAYMENTS_APP}:${invoiceId}`}
            WHERE org_id = ${ctx.orgId}::uuid AND id = ${documentId(key)}::uuid
              AND external_ref IS NULL`,
      )
    }
    // Who issues what: card subscriptions are invoiced by Liaison, the processor only collects.
    await upsertAppRow(tx as never, INVOICING_APP, `${PAYMENTS_APP}_streams`, {
      id: ctx.id("issuer-stream", ISSUER_KEY),
      org_id: ctx.orgId,
      issuer_profile_id: issuerId,
      [`${PAYMENTS_APP}_account_ref`]: null,
      [`${PAYMENTS_APP}_connected`]: true,
      issuer: "liaison",
      decided_by: ownerIdOf(org),
      decided_at: money.connectedAt.toISOString(),
      emails_confirmed_by: ownerIdOf(org),
      emails_confirmed_at: money.connectedAt.toISOString(),
    })
    // The ten schedules billed by transfer, none of them run yet this month.
    const rows = recurringScheduleRows(
      ctx,
      issuerId,
      money.schedules.map((s) => ({
        key: s.key,
        contactId: contactOfCompany[s.companyKey] as string,
        companyId: companyIds[s.companyKey] ?? null,
        repeats: s.repeats,
        billingDay: s.billingDay,
        status: s.status,
        lines: [
          {
            description: s.description,
            qty: s.quantity,
            unitPriceMinor: s.unitMinor,
            vatBp: s.vatBp,
          },
        ],
        nextIssueOn: s.nextIssueOn,
        nextDraftOn: s.nextDraftOn,
        pausedUntil: s.pausedUntil,
      })),
    )
    for (const [i, row] of rows.entries()) {
      const s = money.schedules[i] as SaasMoneyPlan["schedules"][number]
      if (!row.contact_id) throw new Error(`saas layer: schedule ${s.key} has no customer`)
      const extra: Record<string, AppCell> = {
        last_document_id: s.lastInvoiceKey ? documentId(s.lastInvoiceKey) : null,
        external_ref: `demo:saas:schedule:${s.key}`,
      }
      await upsertAppRow(tx as never, INVOICING_APP, "recurring_schedules", { ...row, ...extra })
    }
  })

  // The card mirror.
  await seedPaymentsMirror(
    ctx,
    saasPaymentsMirrorSpec(money, plan, {
      companyIds,
      contactIds,
      documentId,
      nextAttempt: sec(clock.d(1)),
    }),
  )
  await seedSaasMoneyDecisions(ctx, org, money, contactIds)
  ctx.log(
    `money: ${money.subscriptions.length} card subscriptions, ${money.invoices.length} invoices, ${money.schedules.length} schedules`,
  )
}

/** The card mirror of the money plan, in the payments factory's terms. Pure. */
export function saasPaymentsMirrorSpec(
  money: SaasMoneyPlan,
  plan: SaasPlanResult,
  ids: {
    companyIds: Record<string, string>
    contactIds: Record<string, string>
    documentId: (invoiceKey: string) => string
    /** When a failed charge is tried again: the next day. */
    nextAttempt: Date
  },
): PaymentsMirrorSpec {
  const subsByKey = new Map(money.subscriptions.map((s) => [s.companyKey, s]))
  return {
    currency: "eur",
    customers: money.subscriptions.map((s) => {
      const c = companyOf(plan, s.companyKey)
      const contact = c.contactKeys[0]
      return {
        id: s.customerId,
        email: s.email,
        name: c.name,
        createdAt: s.customerSince,
        delinquent: s.status === "past_due",
        companyId: ids.companyIds[c.key] ?? null,
        contactId: contact ? (ids.contactIds[contact] ?? null) : null,
      }
    }),
    subscriptions: money.subscriptions.map((s) => ({
      id: s.subscriptionId,
      customerId: s.customerId,
      status: s.status,
      planName: SAAS_PLANS[s.plan].name,
      unitMinor: (s.billing === "year" ? 12 : 1) * SAAS_PLANS[s.plan].monthlyMinor,
      interval: s.billing,
      taxPercent: 20,
      periodStart: s.periodStart,
      periodEnd: s.periodEnd,
      trialEnd: s.trialEnd,
      canceledAt: s.canceledAt,
      pastDueSince: s.pastDueSince,
      startedAt: s.customerSince,
      card: s.card,
    })),
    invoices: money.charges.map((c) => ({
      id: c.invoiceId,
      customerId: c.customerId,
      subscriptionId: c.subscriptionId,
      status: c.invoiceStatus,
      netMinor: c.netMinor,
      taxMinor: c.taxMinor,
      periodStart: c.periodStart,
      periodEnd: c.periodEnd,
      finalizedAt: c.at,
      paidAt: c.invoiceStatus === "paid" ? c.at : null,
      nextPaymentAttempt: c.invoiceStatus === "open" ? ids.nextAttempt : null,
      billingReason:
        subsByKey.get(customerKeyOf(money, c.customerId))?.customerSince.getTime() ===
        c.at.getTime()
          ? "subscription_create"
          : "subscription_cycle",
      documentId: c.invoiceKey ? ids.documentId(c.invoiceKey) : null,
      documentNumber: c.invoiceKey
        ? (money.invoices.find((i) => i.key === c.invoiceKey)?.number ?? null)
        : null,
    })),
    payments: money.charges.map((c) => ({
      id: c.chargeId,
      invoiceId: c.invoiceId,
      customerId: c.customerId,
      amountMinor: c.netMinor + c.taxMinor,
      status: c.chargeStatus,
      failureCode: c.failureCode,
      failureMessage:
        c.failureCode === "expired_card"
          ? "Your card has expired."
          : c.failureCode
            ? "Your card was declined."
            : null,
      card: c.card,
      at: c.at,
      disputed: c.disputed,
    })),
    disputes: [
      {
        id: money.dispute.disputeId,
        paymentId: money.dispute.chargeId,
        amountMinor: money.dispute.amountMinor,
        reason: money.dispute.reason,
        status: money.dispute.status,
        at: money.dispute.at,
        evidenceDueBy: money.dispute.evidenceDueBy,
      },
    ],
    movements: money.movements,
    install: {
      accountId: "acct_1WorldDemoAccount",
      accountName: SAAS_COMPANY.name,
      connectedAt: money.connectedAt,
      lastEventAt: money.lastEventAt,
      lastEventType: "invoice.paid",
    },
    syncedAt: money.syncedAt,
  }
}

function companyOf(plan: SaasPlanResult, key: string) {
  const c = plan.companies.find((x) => x.key === key)
  if (!c) throw new Error(`saas layer: no company '${key}'`)
  return c
}

function customerKeyOf(money: SaasMoneyPlan, customerId: string): string {
  return money.subscriptions.find((s) => s.customerId === customerId)?.companyKey ?? ""
}

function emailOfCompany(key: string, domain: string, contactKeys: readonly string[]): string {
  if (SAAS_TRANSFER_KEYS.includes(key)) return `compta@${domain}`
  const first = contactKeys[0]?.replace(/^customer:/, "")
  const named = first ? SAAS_CUSTOMERS.find((c) => c.key === first)?.email : undefined
  return named ?? `billing@${domain}`
}

/**
 * The two money decisions on the owner's Home: the card reminder to Maison
 * Arlon, staged by the failed payments routine for its account manager (away,
 * the owner next in line), and the refund to Café Ombre, asked by the support
 * lead's agent from the ticket.
 */
async function seedSaasMoneyDecisions(
  ctx: SeedContext,
  org: SeedDemoOrgResult,
  money: SaasMoneyPlan,
  contactIds: Record<string, string>,
): Promise<void> {
  const clock = storyClock(ctx.now)
  const ownerId = ownerIdOf(org)
  const threadOf = async (title: string) => {
    const [row] = await withPrivilegedDb(ctx.orgId, "saas-seed-money-thread", async (tx) =>
      rowsOf<{ id: string }>(
        await tx.execute(
          sql`SELECT id FROM ${sql.raw(schemaRef("kernel"))}.threads
              WHERE org_id = ${ctx.orgId}::uuid AND title = ${title} LIMIT 1`,
        ),
      ),
    )
    if (!row) throw new Error(`saas layer: no '${title}' channel for the money decisions`)
    return row.id
  }
  const ticketId = await withPrivilegedDb(ctx.orgId, "saas-seed-money-ticket", async (tx) =>
    rowsOf<{ id: string }>(
      await tx.execute(
        sql`SELECT id FROM ${sql.raw(schemaRef("app_tickets"))}.tickets
            WHERE org_id = ${ctx.orgId}::uuid AND external_ref = ${`demo:${SAAS_TICKET_KEYS.ombreCharge}`}
            LIMIT 1`,
      ),
    ),
  )
  const finance = org.agentsByHandle["@finance"]?.agentId
  const inesAgent =
    org.agents.find(
      (a) => a.kind === "personal" && (a as { ownerKey?: string }).ownerKey === "ines",
    )?.agentId ?? org.agentsByHandle["@support"]?.agentId
  if (!finance || !inesAgent) throw new Error("saas layer: no agent for the money decisions")
  const arlonOpen = money.charges.find((c) => c.invoiceKey === "arlon-current")
  const ombreCharge = money.charges.find((c) => c.invoiceKey === "ombre-after-cancel")
  const ombreInvoice = money.invoices.find((i) => i.key === "ombre-after-cancel")
  if (!arlonOpen || !ombreCharge || !ombreInvoice) {
    throw new Error("saas layer: the money decisions name no charge")
  }
  const claire = SAAS_CUSTOMERS.find((c) => c.key === "claire-vidal")?.email as string
  const elodie = userIdOf(org, "elodie")
  const ines = userIdOf(org, "ines")
  const arlonId = ctx.id("approval", "arlon-card-reminder")
  // The reminder's send check is the product's own, pinned when the routine
  // staged it: the invoice it is about is asked again at the moment it would
  // leave, so once that invoice is paid it never goes.
  const reminderRefs = [{ kind: `${PAYMENTS_APP}:invoice`, id: arlonOpen.invoiceId }]
  const claireContact = contactIds["customer:claire-vidal"]
  const reminderGuard = await buildSendGuard({
    orgId: ctx.orgId,
    toolName: "mail:compose",
    followUpRun: true,
    followUp: { refs: reminderRefs, classification: "service" },
    recipients: [claire],
    contactIds: claireContact ? [claireContact] : [],
    agentStaged: true,
    now: sec(clock.h(-1)),
    timeZone: org.timezone,
  })
  if (!("sendGuard" in reminderGuard)) {
    throw new Error(`saas layer: the card reminder not staged: ${JSON.stringify(reminderGuard)}`)
  }
  await seedApprovalRequests(ctx, [
    {
      id: arlonId,
      handle: "demo-arlon-card-reminder",
      threadId: await threadOf(SAAS_CHANNEL_TITLES.handover),
      toolName: "mail:compose",
      payload: {
        accountId: ctx.id("mail-account", "org"),
        to: [claire],
        subject: "Your card for the Group plan needs updating",
        textBody: `Hello Claire,\n\nThe payment for your Group plan did not go through: the Visa ending 4242 on file has expired. You can add a new card on the secure page linked below. Your rotas keep running while you do.\n\nThank you,\n${SAAS_COMPANY.name}`,
        followUp: { refs: reminderRefs, classification: "service" },
        sendGuard: reminderGuard.sendGuard,
        ...(reminderGuard.guardKey ? { guardKey: reminderGuard.guardKey } : {}),
      },
      requestedBy: userIdOf(org, "sara"),
      agentId: finance,
      notifyUserIds: [elodie, ownerId],
      status: "pending",
      createdAt: sec(clock.h(-1)),
    },
    {
      id: ctx.id("approval", "ombre-refund"),
      handle: "demo-ombre-refund",
      threadId: await threadOf(SAAS_CHANNEL_TITLES.handover),
      toolName: `${PAYMENTS_APP}:refunds_create`,
      payload: {
        chargeId: ombreCharge.chargeId,
        reason: `Charged two days after the cancellation; invoice ${ombreInvoice.number}`,
        ...(ticketId[0] ? { ticketId: ticketId[0].id } : {}),
      },
      requestedBy: ines,
      agentId: inesAgent,
      notifyUserIds: [ownerId],
      status: "pending",
      createdAt: sec(clock.h(-16)),
    },
  ])
  // The reminder is for Maison Arlon's account manager: the person it routes to. She
  // approves reminders to the customers she manages, so it waits on her, and while
  // she is away, on the owner next in line.
  await withPrivilegedDb(ctx.orgId, "saas-seed-money-route", async (tx) => {
    await tx.execute(
      sql`INSERT INTO ${sql.raw(schemaRef("kernel"))}.user_scope_grants (user_id, org_id, scope)
          SELECT ${elodie}::uuid, ${ctx.orgId}::uuid, 'mail:approve'
          WHERE NOT EXISTS (
            SELECT 1 FROM ${sql.raw(schemaRef("kernel"))}.user_scope_grants
            WHERE org_id = ${ctx.orgId}::uuid AND user_id = ${elodie}::uuid AND scope = 'mail:approve'
          )`,
    )
    await tx.execute(
      sql`UPDATE ${sql.raw(schemaRef("kernel"))}.approval_requests
          SET route_person_id = ${elodie}::uuid
          WHERE org_id = ${ctx.orgId}::uuid AND id = ${arlonId}::uuid`,
    )
    // A grant widens the person's agent as granting does in the product, so the
    // first seed ends where a re-seed of the same org would.
    await refreshPersonalAgentCeiling(tx, { orgId: ctx.orgId, userId: elodie })
  })
}

const sec = (d: Date) => new Date(Math.floor(d.getTime() / 1000) * 1000)
