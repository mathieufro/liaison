// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `seedLivelyWorld`: the `lively` tier. The demo world (Resonant Audio Labs)
// with ten people instead of seven, and fourteen days of the desk at work up
// to `now`: channel conversations and chats with agents, a ticket queue that
// moved, routine runs, sub runs, agent turns, the attention that reached each
// person (the newest still unread) and its delivery log, and the change
// history of the tickets. For private boxes (walks, UI checks, screenshots)
// and a self-hosted trial; every person can be given a password there.
//
// Built on the demo tier and the factories only: the activity is a pure plan
// (`activity-plan.ts`), resolved to ids here and written through the domain
// factories. Deterministic (fixed seed, one `now`) and idempotent: a re-run
// adopts what an earlier run wrote. A box that wants the world to read as
// fresh again replaces the org (`replace`) rather than topping it up, because
// adopted rows keep the instants they were first written at.
//
// The analytics warehouse part stays off unless asked for (`warehouse`).
import { and, eq, sql } from "drizzle-orm"
import { z } from "zod"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { users } from "~/db/schema/kernel"
import { routines } from "~/db/schema/kernel/routines"
import { schemaRef } from "~/db/schema-ref"
import { DEMO_COMPANY_NAME } from "~/modules/demo/demo-seeder"
import { runAsSeed } from "~/modules/notifications/seeded"
import { HOUR_MS } from "~/seed/clock"
import { type SeedContext, seedContext } from "~/seed/context"
import { seedRoutineRuns } from "~/seed/factories/agent/routine-runs"
import { seedSubRuns } from "~/seed/factories/agent/sub-runs"
import { type AgentTurnSeed, seedAgentTurns } from "~/seed/factories/agent/turns"
import {
  type AttentionEventSeed,
  type DeliverySeed,
  seedAttentionEvents,
  seedNotificationDeliveries,
} from "~/seed/factories/attention/events"
import { orgSlugOf } from "~/seed/factories/org/org"
import { actorFor } from "~/seed/factories/people/actors"
import { contactIdByEmail } from "~/seed/factories/people/contacts"
import { joinPendingApprovals } from "~/seed/factories/people/membership"
import { writeConversationReadState } from "~/seed/factories/people/read-state"
import { seedTaskLabels } from "~/seed/factories/projects/labels"
import { ensureTicketCategories, ensureTicketInboxes } from "~/seed/factories/support/inboxes"
import { seedTickets, type TicketSpec } from "~/seed/factories/support/tickets"
import { type HistoryMessageSpec, seedThreadHistory } from "~/seed/factories/threads/history"
import { seedAgentDms, seedThreads } from "~/seed/factories/threads/threads"
import { seedTimelineEntries, type TimelineEntrySeed } from "~/seed/factories/timeline/entries"
import { replaceSeededDemoOrg } from "~/seed/tiers/demo/replace-demo-org"
import type { DemoWorld } from "~/seed/world/fiction"
import { LIVELY_WORLD } from "~/seed/world/lively"
import { type SeedDemoWorldResult, seedDemoWorld } from "../demo/seed-demo"
import { BUGS_INBOX, SALES_INBOX, SUPPORT_INBOX, TICKET_CATEGORIES } from "../demo/support-specs"
import { type ActivityPlan, type PlanInput, planActivity } from "./activity-plan"
import { LIVELY_LABEL_GROUPS, LIVELY_TASK_LABELS } from "./label-specs"

/**
 * One of the caller's own people, taking the seat of a person of the lively
 * world: every row the world writes for `seat` (their tickets, messages,
 * approvals, attention) is written for them, as them. A member of the org
 * already at that address keeps their password and roles and is given the
 * seat's role on top (see `SeedDemoOrgOptions.existingOrg`).
 */
export interface LivelySeat {
  /** The world person whose place they take (`LIVELY_WORLD.team[].key`). */
  seat: string
  name: string
  email: string
  jobTitle?: string
  bio?: string
}

export interface SeedLivelyOptions {
  /** The org's slug. Required unless `existingOrg` names the org. */
  orgSlug?: string
  /**
   * Seed into an org that exists already (a QA harness's, a trial's) instead
   * of one of its own: never marked as a demo org, its settings untouched, a
   * member in a seat adopted there (`SeedDemoOrgOptions.existingOrg`).
   */
  existingOrg?: { orgId: string; adminUserId: string }
  /** The caller's own people in the world's seats (the roster overlay). */
  people?: readonly LivelySeat[]
  orgName?: string
  /** Every person's password (private boxes only; refused on a public demo box). */
  personaPassword?: string
  /** Delete an earlier demo org under this slug first, so the world is fresh. */
  replace?: boolean
  /** Seed the analytics warehouse part. Off unless asked for. */
  warehouse?: boolean
  /** Leave out the shop, invoices, carrier and books (`SeedDemoWorldOptions.withoutCommerce`). */
  withoutCommerce?: boolean
  /** The instant the fourteen days end at. Defaults to the moment of the call. */
  baseTime?: Date
  log?: (msg: string) => void
}

/** Rows the activity wrote, by domain (ids, so a test reads them back). */
export interface LivelyActivity {
  channels: string[]
  messages: string[]
  agentTurns: string[]
  tickets: string[]
  timelineEntries: string[]
  routineRuns: string[]
  subRuns: string[]
  attentionEvents: string[]
  notificationDeliveries: string[]
  /** Demo tasks holding a task label (the board's Labels filter has groups to offer). */
  labelledTasks: string[]
}

export interface SeedLivelyResult {
  world: SeedDemoWorldResult
  /** Null when the world failed and no activity was written. */
  activity: LivelyActivity | null
  replaced: boolean
  complete: boolean
}

const ticketRef = (key: string) => `lively:${key}`

/** Delete the demo org under `slug` before a fresh lively seed (`replaceSeededDemoOrg`). */
export function replaceLivelyOrg(slug: string, log: (msg: string) => void): Promise<boolean> {
  return replaceSeededDemoOrg(slug, log, { who: "seedLivelyWorld", tier: "lively" })
}

/**
 * The lively world with the caller's people in their seats. Throws on a seat
 * the world does not have, a seat taken twice, or one address given twice.
 */
export function livelyWorldWith(people: readonly LivelySeat[]): {
  world: DemoWorld
  personEmails: Record<string, string>
} {
  const seats = new Set(LIVELY_WORLD.team.map((p) => p.key))
  const taken = new Set<string>()
  const emails = new Set<string>()
  const personEmails: Record<string, string> = {}
  for (const p of people) {
    if (!seats.has(p.seat)) {
      throw new Error(
        `seedLivelyWorld: the world has no seat '${p.seat}' (${[...seats].join(", ")})`,
      )
    }
    if (taken.has(p.seat)) throw new Error(`seedLivelyWorld: seat '${p.seat}' given twice`)
    const email = p.email.trim().toLowerCase()
    if (email === "" || emails.has(email)) {
      throw new Error(`seedLivelyWorld: address '${p.email}' is empty or given twice`)
    }
    taken.add(p.seat)
    emails.add(email)
    personEmails[p.seat] = email
  }
  const bySeat = new Map(people.map((p) => [p.seat, p]))
  const team = LIVELY_WORLD.team.map((person) => {
    const p = bySeat.get(person.key)
    if (!p) return person
    return {
      ...person,
      name: p.name,
      email: personEmails[person.key] as string,
      jobTitle: p.jobTitle ?? person.jobTitle,
      bio: p.bio ?? person.bio,
    }
  })
  return { world: { ...LIVELY_WORLD, team }, personEmails }
}

/** The slug to seed: the one given, or the existing org's own. */
async function livelySlug(opts: SeedLivelyOptions): Promise<string> {
  if (opts.existingOrg) {
    if (opts.replace === true) {
      throw new Error("seedLivelyWorld: --replace deletes the org; refused for an existing org")
    }
    const slug = await orgSlugOf(opts.existingOrg.orgId)
    if (slug === "") throw new Error(`seedLivelyWorld: no org ${opts.existingOrg.orgId}`)
    if (opts.orgSlug && opts.orgSlug !== slug) {
      throw new Error(
        `seedLivelyWorld: org ${opts.existingOrg.orgId} is '${slug}', not '${opts.orgSlug}'`,
      )
    }
    return slug
  }
  if (!opts.orgSlug) throw new Error("seedLivelyWorld: an org slug or an existing org is required")
  return opts.orgSlug
}

export function seedLivelyWorld(opts: SeedLivelyOptions): Promise<SeedLivelyResult> {
  return runAsSeed(() => seedLivelyLayers(opts))
}

async function seedLivelyLayers(opts: SeedLivelyOptions): Promise<SeedLivelyResult> {
  const log = opts.log ?? (() => {})
  const baseTime = opts.baseTime ?? new Date(Date.now())
  // Validated before any write: a bad overlay leaves the org as it was.
  const overlay = livelyWorldWith(opts.people ?? [])
  const orgSlug = await livelySlug(opts)
  const replaced = opts.replace === true ? await replaceLivelyOrg(orgSlug, log) : false

  const world = await seedDemoWorld({
    orgSlug,
    orgName: opts.orgName ?? DEMO_COMPANY_NAME,
    variant: "visitor",
    world: overlay.world,
    personEmails: overlay.personEmails,
    ...(opts.existingOrg ? { existingOrg: opts.existingOrg } : {}),
    personaPassword: opts.personaPassword,
    warehouse: opts.warehouse === true,
    ...(opts.withoutCommerce === true ? { withoutCommerce: true } : {}),
    baseTime,
    log,
  })
  if (!world.complete) return { world, activity: null, replaced, complete: false }

  const ctx = seedContext({ orgId: world.orgId, now: baseTime, log })
  const activity = await seedLivelyActivity(ctx, world)
  return { world, activity, replaced, complete: true }
}

/** What a routine's schedule makes of it in the plan. */
function cadenceOf(row: { kind: string; cron: string | null }): "daily" | "weekly" | "event" {
  if (row.kind === "event") return "event"
  const dow = row.cron?.trim().split(/\s+/)[4] ?? "*"
  return dow === "*" || dow.includes("-") ? "daily" : "weekly"
}

async function seedLivelyActivity(
  ctx: SeedContext,
  world: SeedDemoWorldResult,
): Promise<LivelyActivity> {
  const { org } = world
  const at = (hoursAgo: number) => new Date(ctx.now.getTime() - hoursAgo * HOUR_MS)

  const actors: Record<string, UserContext> = {}
  for (const person of org.people) actors[person.key] = await actorFor(ctx, person.userId)
  const actorOf = (key: string): UserContext => {
    const a = actors[key]
    if (!a) throw new Error(`lively: no person '${key}'`)
    return a
  }

  const routineRows = await withPrivilegedDb(ctx.orgId, "seed-lively:routines", (tx) =>
    tx
      .select({
        id: routines.id,
        name: routines.name,
        kind: routines.kind,
        cron: routines.cron,
        ownerAgentId: routines.ownerAgentId,
        outputThreadId: routines.outputThreadId,
      })
      .from(routines)
      .where(and(eq(routines.orgId, ctx.orgId), sql`${routines.sourceKind} <> 'system'`)),
  )

  const roleAgents = Object.values(org.agentsByHandle).filter((a) => a.kind === "role")
  const planInput: PlanInput = {
    people: org.people.map((p) => ({ key: p.key, role: p.role })),
    contactKeys: [
      ...org.world.customers.map((c) => `customer:${c.key}`),
      ...org.world.dealers.map((d) => `dealer:${d.key}`),
    ],
    products: org.world.catalog.filter((s) => s.tier === "flagship").map((s) => s.title),
    routines: routineRows.map((r) => ({ name: r.name, cadence: cadenceOf(r) })),
    subAgentTypes: world.agentNative?.subAgentTypes ?? [],
    roleAgents: roleAgents.map((a) => a.handle),
    nowHourUtc: ctx.now.getUTCHours() + ctx.now.getUTCMinutes() / 60,
  }
  const plan: ActivityPlan = planActivity(planInput)

  // ── Rooms: the channels (everyone in), and each person's chat with their agent
  const everyone = org.people.map((p) => p.key)
  const channelIds = await seedThreads(ctx, {
    actors,
    people: org.peopleByKey,
    agentsByHandle: org.agentsByHandle,
    specs: plan.channels.map((c) => ({
      key: c.key,
      title: c.title,
      creator: c.creator,
      participants: everyone,
      discoverable: true,
      topic: c.topic,
      messages: [],
    })),
  })
  const dmIds: Record<string, string> = {}
  for (const person of org.people) {
    const [id] = await seedAgentDms(ctx, actorOf(person.key), {
      agentsByHandle: org.agentsByHandle,
      specs: [{ key: `lively:${person.key}`, agent: "personal", messages: [] }],
    })
    if (id) dmIds[person.key] = id
  }
  ctx.log(
    `lively: ${Object.keys(channelIds).length} channels, ${Object.keys(dmIds).length} agent chats`,
  )

  // ── Messages, in time order, each placed at its instant ─────────────────
  const ordered = [...plan.messages].sort((a, b) => b.hoursAgo - a.hoursAgo)
  const roomOf = (room: string) =>
    room.startsWith("dm:") ? dmIds[room.slice(3)] : channelIds[room]
  const historySpecs: HistoryMessageSpec[] = []
  for (const m of ordered) {
    const threadId = roomOf(m.room)
    if (!threadId) continue
    const channel = plan.channels.find((c) => c.key === m.room)
    if (m.author === "agent") {
      const personKey = m.room.slice(3)
      const person = org.peopleByKey[personKey]
      if (!person) continue
      const agent = org.agents.find((a) => a.agentId === person.personalAgentId)
      historySpecs.push({
        key: `lively:${m.key}`,
        threadId,
        actor: actorOf(personKey),
        agent: { agentId: person.personalAgentId, displayName: agent?.displayName ?? "Liaison" },
        body: m.body,
        at: at(m.hoursAgo),
      })
    } else if (m.author.startsWith("@")) {
      const agent = org.agentsByHandle[m.author]
      if (!agent || !channel) continue
      historySpecs.push({
        key: `lively:${m.key}`,
        threadId,
        actor: actorOf(channel.creator),
        agent: { agentId: agent.agentId, displayName: agent.displayName },
        body: m.body,
        at: at(m.hoursAgo),
      })
    } else {
      historySpecs.push({
        key: `lively:${m.key}`,
        threadId,
        actor: actorOf(m.author),
        body: m.body,
        at: at(m.hoursAgo),
      })
    }
  }
  const written = await seedThreadHistory(ctx, historySpecs)
  ctx.log(`lively: ${written.length} messages over ${ACTIVITY_LABEL}`)

  // ── Agent turns: one per agent message, answering the ask before it ─────
  const turns: AgentTurnSeed[] = []
  const lastAskByThread = new Map<string, string>()
  for (let i = 0; i < written.length; i++) {
    const msg = written[i]
    const spec = historySpecs[i]
    if (!msg || !spec) continue
    if (!spec.agent) {
      lastAskByThread.set(msg.threadId, msg.messageId)
      continue
    }
    const isDm = Object.values(dmIds).includes(msg.threadId)
    turns.push({
      key: msg.key,
      threadId: msg.threadId,
      agentId: spec.agent.agentId,
      origin: isDm ? "chat" : "thread",
      userMessageId: isDm ? (lastAskByThread.get(msg.threadId) ?? null) : null,
      agentMessageId: msg.messageId,
      startedAt: new Date(msg.at.getTime() - 40_000),
      finishedAt: msg.at,
      steps: 2 + (msg.messageId.charCodeAt(0) % 5),
    })
  }

  // ── Routine runs (and their turns, in the routine's output room) ────────
  const routineByName = new Map(routineRows.map((r) => [r.name, r]))
  const runPlans = plan.routineRuns.filter((r) => routineByName.has(r.routine))
  const runIds = await seedRoutineRuns(
    ctx,
    runPlans.map((r) => ({
      key: r.key,
      routineId: (routineByName.get(r.routine) as { id: string }).id,
      startedAt: at(r.hoursAgo),
      durationMs: r.durationMs,
      status: r.status,
      trigger: r.trigger,
      ...(r.status === "failed"
        ? { error: "A tool call timed out; the next run picks the work up again." }
        : {}),
    })),
  )
  runPlans.forEach((r, i) => {
    const routine = routineByName.get(r.routine)
    if (!routine?.outputThreadId || !routine.ownerAgentId) return
    const startedAt = at(r.hoursAgo)
    turns.push({
      key: `routine:${r.key}`,
      threadId: routine.outputThreadId,
      agentId: routine.ownerAgentId,
      origin: "routine",
      runId: runIds[i] ?? null,
      startedAt,
      finishedAt: new Date(startedAt.getTime() + r.durationMs),
      steps: 4,
      failed: r.status === "failed",
    })
  })

  // ── Sub runs, spawned from each person's chat with their agent ──────────
  const subPlans = plan.subRuns.filter((s) => dmIds[s.person])
  const subRunIds = await seedSubRuns(
    ctx,
    subPlans.map((s) => {
      const person = org.peopleByKey[s.person] as (typeof org.people)[number]
      return {
        key: s.key,
        parentThreadId: dmIds[s.person] as string,
        agentId: person.personalAgentId,
        requester: actorOf(s.person),
        subagentType: s.subagentType,
        prompt: s.prompt,
        summary: s.summary,
        startedAt: at(s.hoursAgo + s.durationMs / HOUR_MS),
        durationMs: s.durationMs,
        failed: s.failed,
        promptTokens: 6_000 + (s.durationMs % 9_000),
        completionTokens: 400 + (s.durationMs % 1_200),
      }
    }),
  )
  subPlans.forEach((s, i) => {
    const person = org.peopleByKey[s.person]
    const runId = subRunIds[i]
    if (!person || !runId) return
    const startedAt = at(s.hoursAgo + s.durationMs / HOUR_MS)
    turns.push({
      key: `subrun:${s.key}`,
      threadId: ctx.id("sub-run-thread", s.key),
      agentId: person.personalAgentId,
      origin: "subrun",
      runId,
      startedAt,
      finishedAt: at(s.hoursAgo),
      steps: 6,
      failed: s.failed,
    })
  })
  const turnIds = await seedAgentTurns(ctx, turns)

  // ── Tickets: the queue that moved this fortnight ────────────────────────
  const admin = org.adminUserId
  const inboxes = await ensureTicketInboxes(
    ctx,
    admin,
    [
      { name: SUPPORT_INBOX, team: "support" },
      { name: SALES_INBOX, team: "sales" },
      { name: BUGS_INBOX, team: "support" },
    ],
    {
      fromDisplayName: org.world.company.name,
      replyFromEmail: org.world.company.supportEmail,
      slaPromisePhrase: "within one working day",
    },
  )
  const categories = await ensureTicketCategories(ctx, admin, TICKET_CATEGORIES)
  const contactOf = (key: string): { email: string; name: string } => {
    const [kind, rest] = key.split(":") as [string, string]
    if (kind === "dealer") {
      const dealer = org.world.dealers.find((d) => d.key === rest)
      if (!dealer) throw new Error(`lively: unknown dealer '${rest}'`)
      return { email: `orders@${dealer.key}.dealer.example`, name: dealer.name }
    }
    const customer = org.world.customers.find((c) => c.key === rest)
    if (!customer) throw new Error(`lively: unknown customer '${rest}'`)
    return { email: customer.email, name: customer.name }
  }
  const contactIds: Record<string, string> = {}
  for (const key of new Set(plan.tickets.map((t) => t.contactKey))) {
    const id = await contactIdByEmail(ctx, contactOf(key).email)
    if (id) contactIds[key] = id
  }
  const ticketSpecs: TicketSpec[] = plan.tickets.map((t) => ({
    key: t.key,
    subject: t.subject,
    contactKey: t.contactKey,
    category: t.category,
    team: t.team,
    audience: t.contactKey.startsWith("dealer:") ? "b2b" : "b2c",
    priority: t.priority,
    status: t.status,
    ...(t.status === "closed" ? { closedReason: "resolved" as const } : {}),
    ...(t.assignee ? { assignee: t.assignee } : {}),
    channel: "email",
    createdHoursAgo: t.createdHoursAgo,
    body: t.body,
    followups: t.replies.map((r) => ({
      kind: r.kind,
      ...(r.kind === "inbound" ? {} : { author: t.assignee ?? "amina" }),
      hoursAfter: r.hoursAfter,
      body: r.body,
    })),
  }))
  const ticketIdsByKey = await seedTickets(ctx, {
    adminUserId: admin,
    people: org.peopleByKey,
    contactOf,
    contactIds,
    categoryIds: categories,
    inboxIdOf: (spec) => inboxes[spec.team === "sales" ? SALES_INBOX : SUPPORT_INBOX] ?? null,
    supportEmail: org.world.company.supportEmail,
    specs: ticketSpecs,
    externalRefOf: ticketRef,
  })
  // `createTicket` stamps the row's `updated_at` with the real clock; the
  // queue sorts on it, so it follows the ticket's own last activity.
  await withPrivilegedDb(ctx.orgId, "seed-lively:ticket-updated-at", (tx) =>
    tx.execute(sql`
      UPDATE ${sql.raw(schemaRef("app_tickets"))}.tickets
      SET updated_at = coalesce(last_message_at, created_at)
      WHERE org_id = ${ctx.orgId}::uuid AND external_ref LIKE 'lively:%'`),
  )

  // ── The tickets' change history ──────────────────────────────────────────
  const timeline: TimelineEntrySeed[] = []
  const opsLead = org.people.find((p) => p.role === "ops_lead")
  for (const t of plan.tickets) {
    const id = ticketIdsByKey[t.key]
    if (!id) continue
    const created = at(t.createdHoursAgo)
    timeline.push({
      key: `${t.key}:created`,
      app: "tickets",
      entityType: "ticket",
      entityId: id,
      actorId: null,
      actorType: "system",
      at: created,
      action: "created",
    })
    if (t.assignee) {
      const who = org.peopleByKey[t.assignee]
      timeline.push({
        key: `${t.key}:assigned`,
        app: "tickets",
        entityType: "ticket",
        entityId: id,
        actorId: opsLead?.userId ?? admin,
        actorType: "user",
        at: new Date(created.getTime() + Math.min(0.2, t.createdHoursAgo / 4) * HOUR_MS),
        action: "field_changed",
        field: "assignedTo",
        before: null,
        after: who?.name ?? t.assignee,
      })
    }
    if (t.status !== "open") {
      const last = t.replies.at(-1)?.hoursAfter ?? t.createdHoursAgo / 2
      timeline.push({
        key: `${t.key}:status`,
        app: "tickets",
        entityType: "ticket",
        entityId: id,
        actorId: t.assignee ? (org.peopleByKey[t.assignee]?.userId ?? admin) : admin,
        actorType: "user",
        at: new Date(created.getTime() + last * HOUR_MS),
        action: "field_changed",
        field: "status",
        before: "open",
        after: t.status,
      })
    }
  }
  const timelineIds = await seedTimelineEntries(ctx, timeline)

  // ── Attention and its delivery log ──────────────────────────────────────
  const attention: AttentionEventSeed[] = []
  for (const a of plan.attention) {
    const person = org.peopleByKey[a.person]
    const actor = org.peopleByKey[a.actor]
    if (!person) continue
    const occurredAt = at(a.hoursAgo)
    const readAt = a.read ? new Date(occurredAt.getTime() + 0.5 * HOUR_MS) : null
    if (a.kind === "agent_notification") {
      const ticketId = ticketIdsByKey[a.target]
      if (!ticketId) continue
      attention.push({
        key: a.key,
        userId: person.userId,
        app: "kernel",
        entityType: "agent_notification",
        entityId: ctx.id("agent-notification", a.key),
        kind: a.kind,
        urgency: 50,
        summary: a.summary,
        actorId: null,
        actorType: "agent",
        metadata: { link: { tabType: "tickets:ticket", entityId: ticketId } },
        occurredAt,
        readAt: readAt && readAt > ctx.now ? ctx.now : readAt,
      })
      continue
    }
    const threadId = channelIds[a.target]
    if (!threadId) continue
    attention.push({
      key: a.key,
      userId: person.userId,
      app: "kernel",
      entityType: "thread",
      entityId: threadId,
      kind: a.kind,
      urgency: a.kind === "mention" ? 60 : 30,
      summary: a.kind === "mention" ? `${actor?.name ?? "A teammate"} mentioned you` : a.summary,
      actorId: actor?.userId ?? null,
      actorType: "user",
      metadata: null,
      occurredAt,
      readAt: readAt && readAt > ctx.now ? ctx.now : readAt,
    })
  }
  const attentionIds = await seedAttentionEvents(ctx, attention)
  const deliveries: DeliverySeed[] = []
  attention.forEach((a, i) => {
    const notificationId = attentionIds[i] as string
    deliveries.push({
      key: `${a.key}:in_app`,
      userId: a.userId,
      notificationId,
      channel: "in_app",
      surface: "browser_tab",
      result: "accepted",
      attemptedAt: new Date(a.occurredAt.getTime() + 1_000),
    })
    if (a.urgency >= 50) {
      deliveries.push({
        key: `${a.key}:push`,
        userId: a.userId,
        notificationId,
        channel: "push",
        surface: i % 3 === 0 ? null : "ios",
        result: i % 3 === 0 ? "no_device" : "accepted",
        attemptedAt: new Date(a.occurredAt.getTime() + 2_000),
      })
    }
  })
  const deliveryIds = await seedNotificationDeliveries(ctx, deliveries)

  // ── Task labels: the founder sets up the org's label groups ─────────────
  const labelFounder = org.people.find((p) => p.role === "founder_admin")
  const labelAdmin = labelFounder ? actorOf(labelFounder.key) : null
  const labels = labelAdmin
    ? await seedTaskLabels(ctx, labelAdmin, {
        groups: [...LIVELY_LABEL_GROUPS],
        tasks: [...LIVELY_TASK_LABELS],
      })
    : { labelIds: [], labelledTaskIds: [] }

  // ── Read state: every room read but each person's newest few ────────────
  // The founder runs the org: every pending approval notifies her too. (She
  // is not seated in the others' chats with their agents: those are theirs.)
  const founder = org.people.find((p) => p.role === "founder_admin")
  if (founder) await joinPendingApprovals(ctx.orgId, founder.userId)
  for (const person of org.people) {
    await writeConversationReadState(ctx.orgId, person.userId, 3)
  }

  const activity: LivelyActivity = {
    channels: Object.values(channelIds),
    messages: written.map((m) => m.messageId),
    agentTurns: turnIds,
    tickets: Object.values(ticketIdsByKey),
    timelineEntries: timelineIds,
    routineRuns: runIds,
    subRuns: subRunIds,
    attentionEvents: attentionIds,
    notificationDeliveries: deliveryIds,
    labelledTasks: labels.labelledTaskIds,
  }
  ctx.log(
    `lively: ${Object.entries(activity)
      .map(([k, v]) => `${v.length} ${k}`)
      .join(", ")}`,
  )
  return activity
}

const ACTIVITY_LABEL = "fourteen days"

/** The `--people` file: the caller's people in the world's seats. */
const livelySeatsSchema = z.array(
  z
    .object({
      seat: z.string().min(1),
      name: z.string().min(1),
      email: z.string().email(),
      jobTitle: z.string().min(1).optional(),
      bio: z.string().min(1).optional(),
    })
    .strict(),
)

// ── CLI ────────────────────────────────────────────────────────────────────
//
//   liaison seed --tier lively --slug walk [--name <org name>]
//       [--passwords <pw> | --passwords-env <VAR>] [--replace] [--warehouse]
//   liaison seed --tier lively --admin <email> [--people <file.json>] [...]
//
// `--admin` seeds the org of that admin (an org that exists already) instead
// of one under `--slug`; `--people` reads a JSON array of `LivelySeat`s, the
// caller's own people in the world's seats.
// `--passwords-env` reads the password from the named environment variable, so
// it never appears in a process list. Exit 0 seeded in full, 1 failed.

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`)
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1]
  const inline = argv.find((a) => a.startsWith(`--${name}=`))
  return inline ? inline.slice(name.length + 3) : undefined
}

export async function runSeedLivelyCli(
  argv: readonly string[],
): Promise<{ exitCode: 0 | 1 | 2; result?: SeedLivelyResult }> {
  const slug = flag(argv, "slug")
  const adminEmail = flag(argv, "admin")
  if (!slug && !adminEmail) {
    console.error("[lively-seed] --slug or --admin is required")
    return { exitCode: 2 }
  }
  let existingOrg: SeedLivelyOptions["existingOrg"]
  if (adminEmail) {
    const rows = await withSystemDb("seed-lively:admin", (tx) =>
      tx
        .select({ id: users.id, orgId: users.orgId })
        .from(users)
        .where(eq(users.email, adminEmail.toLowerCase())),
    )
    if (rows.length !== 1) {
      console.error(
        `[lively-seed] --admin ${adminEmail}: ${rows.length === 0 ? "no such account" : `an account in ${rows.length} orgs`}`,
      )
      return { exitCode: 2 }
    }
    const [row] = rows as [(typeof rows)[number]]
    existingOrg = { orgId: row.orgId, adminUserId: row.id }
  }
  let people: LivelySeat[] | undefined
  const peopleFile = flag(argv, "people")
  if (peopleFile) {
    const parsed = livelySeatsSchema.safeParse(JSON.parse(await Bun.file(peopleFile).text()))
    if (!parsed.success) {
      console.error(`[lively-seed] --people ${peopleFile}: ${parsed.error.message}`)
      return { exitCode: 2 }
    }
    people = parsed.data
  }
  const envName = flag(argv, "passwords-env")
  const password = envName ? process.env[envName] : flag(argv, "passwords")
  if (envName && !password) {
    console.error(`[lively-seed] --passwords-env names ${envName}, which is not set`)
    return { exitCode: 2 }
  }
  const started = performance.now()
  const result = await seedLivelyWorld({
    ...(slug ? { orgSlug: slug } : {}),
    ...(existingOrg ? { existingOrg } : {}),
    ...(people ? { people } : {}),
    orgName: flag(argv, "name"),
    personaPassword: password,
    replace: argv.includes("--replace"),
    warehouse: argv.includes("--warehouse"),
    withoutCommerce: argv.includes("--no-commerce"),
    log: (msg) => console.log(`[lively-seed] ${msg}`),
  })
  const seconds = ((performance.now() - started) / 1000).toFixed(1)
  if (!result.complete) {
    console.error(
      `[lively-seed] FAILED: ${result.world.failures.map((f) => `${f.layer}: ${f.message}`).join("; ")}`,
    )
    return { exitCode: 1, result }
  }
  const seeded = result.world.org.people
  console.log(
    `[lively-seed] org ${result.world.orgSlug} (${result.world.orgId}) seeded in full in ${seconds}s; ` +
      `admin ${seeded.find((p) => p.role === "founder_admin")?.email ?? "none"}`,
  )
  return { exitCode: 0, result }
}
