// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `seedDemoSupport` — the support and collaboration half of the public demo's
// domain data, seeded ON TOP of what `seedDemoOrg` returns.
//
// It fills the surfaces a visitor opens first and judges the product by: the
// ticket queue, the shared mailbox, the knowledge base, the project boards, the
// week's calendar, the contact book, the approvals tray and the chat threads.
// Its sibling `seed-commerce.ts` fills the money half (invoicing, shipping,
// accounting, social).
//
// ── THE TWO RULES THAT SHAPE EVERY LINE BELOW ─────────────────────────────
//
// 1. IDEMPOTENT. The demo box re-seeds on every deploy, so a second run must
//    change no row count and throw nothing. Every row carries a DETERMINISTIC
//    id derived from the org id and a stable content key (`ctx.id`, i.e.
//    `demoId`) or is found again by a natural key, so a re-run collides or
//    adopts instead of inserting a twin.
//
// 2. DETERMINISTIC. No `Math.random`, no bare `new Date()`. The caller passes a
//    base time (`now`) and every timestamp is a fixed OFFSET from it. The
//    offsets are the frozen thing, not the instants, so the world always reads
//    as freshly active: a re-seed next month still shows a ticket that landed
//    forty minutes ago and a standup tomorrow morning.
//
// ── HOW EACH DOMAIN IS WRITTEN ────────────────────────────────────────────
// This file is the demo's wiring: the spec tables (the fiction) live in
// `support-specs.ts`, and every write goes through a factory under
// `seed/factories/` that knows nothing of this company. Each factory's header
// says which of its writes are privileged and why.
//
//   contacts   people/contacts   `resolveContact`
//   tickets    support/inboxes, support/tickets   admin ops, `createTicket`, state machine
//   knowledge  knowledge/articles, knowledge/synced-sources (seed-knowledge-sources.ts)
//   projects   projects/projects   `createProject` / `createTask` / `addDependency`
//   calendar   calendar/events   `onAccountConnected` / `runCalendarImport` / `createLocalEvent`
//   mail       mail/conversations   unarmed plaintext mailboxes (the reason is there)
//   threads    threads/threads   `createThread` / `sendMessage` / `createOrGetAgentDm`
//   approvals  approvals/requests   history rows: no host path creates an approval

import { DEMO_NEED_SPECS, DEMO_NEEDS, type DemoNeed, type DemoSeedPart } from "@liaison/shared"
import type { UserContext } from "~/db/rls"
import { SUPPORT_WORLD_CUSTOMER } from "~/modules/demo/world/support-ticket"
import { type SeedClock, seedClock } from "~/seed/clock"
import { type SeedContext, seedContext } from "~/seed/context"
import {
  type ApprovalRequestSeed,
  approvalLookups,
  databaseNow,
  seedApprovalRequests,
  ticketReadableBy,
} from "~/seed/factories/approvals/requests"
import { type EventSpec, seedTeamCalendar } from "~/seed/factories/calendar/events"
import {
  type ArticleSpec,
  type KnowledgeCollectionSpec,
  seedKnowledgeArticles,
} from "~/seed/factories/knowledge/articles"
import { insertUnarmedMail, type MailConversationSpec } from "~/seed/factories/mail/conversations"
import { orgSlugOf } from "~/seed/factories/org/org"
import { actorFor } from "~/seed/factories/people/actors"
import { type CompanySpec, seedCompanies } from "~/seed/factories/people/companies"
import { resolveContacts } from "~/seed/factories/people/contacts"
import { orgUserIdsByEmail } from "~/seed/factories/people/people"
import { type PipelineSpec, seedPipeline } from "~/seed/factories/projects/deals"
import {
  isOverdue,
  type ProjectSpec,
  seedProject,
  seedProjectTask,
} from "~/seed/factories/projects/projects"
import { ensureTicketCategories, ensureTicketInboxes } from "~/seed/factories/support/inboxes"
import {
  seedTickets as seedTicketQueue,
  type TicketSpec,
  ticketIdsByExternalRef,
} from "~/seed/factories/support/tickets"
import {
  type AgentDmSpec,
  seedAgentDms as seedAgentDmRooms,
  seedThreads as seedThreadRooms,
  type ThreadSpec,
  threadIdsByTitle,
} from "~/seed/factories/threads/threads"
import { DEMO_QUOTE_DEALER, DEMO_TEAM } from "~/seed/world/fiction"
import { assertTicketApprovalsResolve } from "./approval-payload"
import { APPROVAL_SPECS, type ApprovalRefs, type ApprovalSpec } from "./approval-specs"
import { commerceDemoId } from "./commerce-ids"
import { COMMERCE_LAYER_APPS } from "./demo-apps"
import { COMPANY_SPECS, dealRef, SALES_PIPELINE } from "./sales-specs"
import { seedKnowledgeSources } from "./seed-knowledge-sources"
import { demoPersonEmail, type SeedDemoOrgResult } from "./seed-org"
import {
  AGENT_DM_SPECS,
  ARTICLE_SPECS,
  BUGS_INBOX,
  CUSTOMER_COMPANIES,
  DEMO_CALENDAR_NAME,
  DEMO_CONTACT_DUPLICATES,
  type DuplicateSpec,
  EVENT_SPECS,
  KNOWLEDGE_COLLECTIONS,
  MAIL_CONVERSATIONS,
  PROJECT_SPECS,
  SALES_INBOX,
  SUPPORT_INBOX,
  THREAD_SPECS,
  TICKET_CATEGORIES,
  TICKET_SPECS,
} from "./support-specs"

// ── Public surface ─────────────────────────────────────────────────────────

/**
 * What a world's support and collaboration layer writes: the contact book's
 * extras, the ticket queue, the project boards, the calendar, the mailboxes,
 * the companies and their pipeline, and the decided approvals. Pure data, one
 * per world pack (`seed/worlds`); the `products` world's is `PRODUCTS_SUPPORT_SPECS`.
 */
export interface DemoSupportSpecs {
  /** The company each world customer works for, by customer key. */
  customerCompanies: Readonly<Record<string, string>>
  /** The deliberate duplicate contacts, a merge queue's work. */
  contactDuplicates: readonly DuplicateSpec[]
  inboxes: { support: string; sales: string; bugs: string }
  ticketCategories: readonly string[]
  tickets: readonly TicketSpec[]
  ticketMerges: ReadonlyArray<{ target: string; source: string; note: string }>
  projects: readonly ProjectSpec[]
  calendarName: string
  events: readonly EventSpec[]
  mail: readonly MailConversationSpec[]
  /** The conversation the Mail tour opens, kept in a short backlog. */
  mailTourConversation: string | null
  companies: readonly CompanySpec[]
  pipeline: PipelineSpec
  approvals: readonly ApprovalSpec[]
  /**
   * The rows only the `products` world's scenarios use: its synced knowledge
   * sources, the scenario prospect, support customer and quote dealer, and the
   * visitor's projects task.
   */
  productScenarios: boolean
}

/** A world's knowledge base, written as its author (a person key of the world). */
export interface DemoKnowledgeSpecs {
  authorKey: string
  collections: readonly KnowledgeCollectionSpec[]
  articles: readonly ArticleSpec[]
}

/** A world's team conversations and the owner's agent DMs. */
export interface DemoThreadSpecs {
  threads: readonly ThreadSpec[]
  agentDms: readonly AgentDmSpec[]
}

/** The specs `seedDemoSupport` writes: one world pack's support, knowledge and threads. */
export interface DemoSupportWorld {
  support: DemoSupportSpecs
  knowledge: DemoKnowledgeSpecs
  threads: DemoThreadSpecs
}

export interface SeedDemoSupportOptions {
  /** The instant the seeded world is "now" relative to. */
  now: Date
  /** The world pack's specs. Defaults to the `products` world's (`PRODUCTS_SUPPORT_WORLD`). */
  specs?: DemoSupportWorld
  log?: (msg: string) => void
  /**
   * A tailored seed (a visitor's picks, `demoSeedPlan`): only these optional
   * parts are written (`tickets`, `projects`, `mail`, `prospect-routine`), the
   * visitor gets their own scenario task, and approvals keep to the tools of
   * `installedApps`. Absent: the whole world, exactly as before.
   */
  tailored?: {
    parts: ReadonlySet<DemoSeedPart>
    installedApps: ReadonlySet<string>
    /**
     * The visitor picked several needs: each app seeds a short backlog
     * (`SHORT_BACKLOG` items, plus what a seeded approval names) rather than
     * its whole history, so the workspace does not open on a wall of work.
     */
    shortBacklog?: boolean
  }
}

export interface SeedDemoSupportResult {
  orgId: string
  /** The base instant every offset was computed from. */
  seededAt: string
  ticketIds: string[]
  ticketInboxIds: string[]
  ticketCategoryIds: string[]
  mailAccountIds: string[]
  mailConversationIds: string[]
  knowledgeCollectionIds: string[]
  knowledgeDocumentIds: string[]
  projectIds: string[]
  taskIds: string[]
  calendarEventIds: string[]
  contactIds: string[]
  /** The deliberate duplicate pairs, as [primaryId, duplicateId]. */
  duplicateContactPairs: Array<[string, string]>
  approvalIds: string[]
  threadIds: string[]
  /** What the run ended up with, per domain. Equal on a re-run. */
  counts: Record<string, number>
}

// ── 1. Contacts ────────────────────────────────────────────────────────────
//
// The dealer network and the end-customer base from `world.ts`. The duplicate
// pairs at the end are deliberate. `kernel.contacts` is UNIQUE on
// (org_id, email), so a duplicate is the same person under a second address,
// which is what a real merge queue is full of. `findDuplicateClusters`
// clusters on folded name plus a corroborating signal, so matching name and
// company with a different local part is exactly what it is built to catch.

async function seedContacts(
  ctx: SeedContext,
  org: SeedDemoOrgResult,
  actor: UserContext,
  specs: DemoSupportSpecs,
): Promise<{
  contactIds: string[]
  byKey: Record<string, string>
  pairs: Array<[string, string]>
}> {
  const resolved = await resolveContacts(ctx, actor, [
    ...org.world.dealers.map((dealer) => ({
      key: `dealer:${dealer.key}`,
      email: `orders@${dealer.key}.dealer.example`,
      name: dealer.name,
      company: dealer.name,
      externalId: { demo: `dealer:${dealer.key}` },
      tags: dealer.isVip ? ["dealer", "vip"] : ["dealer"],
      recipientCountry: dealer.country,
      metadata: {
        country: dealer.country,
        ...(dealer.vat ? { vat: dealer.vat } : {}),
        relationship: "dealer",
      },
    })),
    ...org.world.customers.map((customer) => {
      const company = specs.customerCompanies[customer.key]
      return {
        key: `customer:${customer.key}`,
        email: customer.email,
        name: customer.name,
        ...(company ? { company } : {}),
        externalId: { demo: `customer:${customer.key}` },
        tags: customer.isVip ? ["customer", "vip"] : ["customer"],
        recipientCountry: customer.country,
        metadata: { country: customer.country, relationship: "direct" },
      }
    }),
    ...specs.contactDuplicates.map((dup) => ({
      key: `duplicate:${dup.ofKey}`,
      email: dup.email,
      name: dup.name,
      company: dup.company,
      externalId: { demo: `duplicate:${dup.ofKey}` },
      tags: ["customer"],
      metadata: { relationship: "direct" },
    })),
  ])
  const byKey = Object.fromEntries(resolved.map(([key, c]) => [key, c.id]))
  const contactIds = resolved.map(([, c]) => c.id)
  const pairs = specs.contactDuplicates.map(
    (d) =>
      [byKey[`customer:${d.ofKey}`] as string, byKey[`duplicate:${d.ofKey}`] as string] as [
        string,
        string,
      ],
  )
  ctx.log(`contacts: ${contactIds.length} resolved, ${pairs.length} deliberate duplicate pairs`)
  return { contactIds, byKey, pairs }
}

// ── 2. Tickets ─────────────────────────────────────────────────────────────

/** A demo ticket's idempotency key. */
const ticketRef = (key: string) => `demo:${key}`

async function seedTickets(
  ctx: SeedContext,
  org: SeedDemoOrgResult,
  contactsByKey: Record<string, string>,
  world: DemoSupportSpecs,
  specs: readonly TicketSpec[],
): Promise<{
  ticketIds: string[]
  inboxIds: string[]
  categoryIds: string[]
  byKey: Record<string, string>
}> {
  const inboxes = await ensureTicketInboxes(
    ctx,
    org.adminUserId,
    [
      { name: world.inboxes.support, team: "support" },
      { name: world.inboxes.sales, team: "sales" },
      { name: world.inboxes.bugs, team: "support" },
    ],
    {
      fromDisplayName: org.world.company.name,
      replyFromEmail: org.world.company.supportEmail,
      slaPromisePhrase: "within one working day",
    },
  )
  ctx.log(`tickets: ${Object.keys(inboxes).length} inboxes ready`)
  const categories = await ensureTicketCategories(ctx, org.adminUserId, world.ticketCategories)

  const byKey = await seedTicketQueue(ctx, {
    adminUserId: org.adminUserId,
    people: org.peopleByKey,
    contactOf: (key) => {
      const [kind, rest] = key.split(":") as [string, string]
      if (kind === "dealer") {
        const dealer = org.world.dealers.find((d) => d.key === rest)
        if (!dealer) throw new Error(`demo support seed: unknown dealer '${rest}'`)
        return { email: `orders@${dealer.key}.dealer.example`, name: dealer.name }
      }
      const customer = org.world.customers.find((c) => c.key === rest)
      if (!customer) throw new Error(`demo support seed: unknown customer '${rest}'`)
      return { email: customer.email, name: customer.name }
    },
    contactIds: contactsByKey,
    categoryIds: categories,
    inboxIdOf: (spec) =>
      inboxes[
        spec.channel === "api"
          ? world.inboxes.bugs
          : spec.team === "sales"
            ? world.inboxes.sales
            : world.inboxes.support
      ] ?? null,
    supportEmail: org.world.company.supportEmail,
    specs,
    externalRefOf: ticketRef,
    merges: world.ticketMerges,
  })

  ctx.log(`tickets: ${Object.keys(byKey).length} tickets across the queue`)
  return {
    ticketIds: Object.values(byKey),
    inboxIds: Object.values(inboxes),
    categoryIds: Object.values(categories),
    byKey,
  }
}

// ── 3. Knowledge ───────────────────────────────────────────────────────────
//
// Three articles carry a `reviewDueAt` in the past, one of the conditions
// `computeAttentionItems` selects on, so the review queue a visitor opens has
// genuine work in it rather than being empty.

async function seedKnowledge(
  ctx: SeedContext,
  org: SeedDemoOrgResult,
  actors: Record<string, UserContext>,
  specs: DemoKnowledgeSpecs,
): Promise<{ collectionIds: string[]; documentIds: string[]; staleCount: number }> {
  const adminActor = actors[specs.authorKey]
  if (!adminActor) throw new Error("demo support seed: no admin actor for knowledge")
  const seeded = await seedKnowledgeArticles(ctx, adminActor, {
    people: org.peopleByKey,
    collections: specs.collections,
    articles: specs.articles,
  })
  ctx.log(
    `knowledge: ${seeded.collectionIds.length} collections, ${seeded.documentIds.length} articles ` +
      `(${seeded.staleCount} past their review date)`,
  )
  return seeded
}

// ── 4. Projects ────────────────────────────────────────────────────────────

/** The projects every seeded world holds: an app tour that asks for a new one must name another. */
export const SEEDED_PROJECT_NAMES: readonly string[] = PROJECT_SPECS.map((p) => p.name)

/** A demo task's idempotency key. */
const taskRef = (key: string) => `demo:task:${key}`

async function seedProjects(
  ctx: SeedContext,
  org: SeedDemoOrgResult,
  actors: Record<string, UserContext>,
  specs: readonly ProjectSpec[],
): Promise<{ projectIds: string[]; taskIds: string[]; overdueCount: number }> {
  const projectIds: string[] = []
  const taskIds: string[] = []
  // Counted from the SPEC: this describes the world the seeder guarantees, not
  // how much of it this particular run inserted, so a re-run reports the same.
  let overdueCount = 0
  for (const spec of specs) {
    const owner = actors[spec.owner]
    if (!owner) throw new Error(`demo support seed: no actor for '${spec.owner}'`)
    const seeded = await seedProject(ctx, owner, {
      people: org.peopleByKey,
      spec,
      externalRefOf: taskRef,
    })
    projectIds.push(seeded.projectId)
    taskIds.push(...seeded.taskIds)
    overdueCount += spec.tasks.filter(isOverdue).length
  }
  ctx.log(
    `projects: ${projectIds.length} projects, ${taskIds.length} tasks, ${overdueCount} overdue`,
  )
  return { projectIds, taskIds, overdueCount }
}

/** The visitor's own task in a tailored seed with projects (the projects scenario's). */
export const SCENARIO_TASK = {
  externalRef: "demo:task:trade-show-demo",
  title: "Prepare the trade-show demo",
  description:
    "Four demo units charged and on the launch firmware, the booth kit packed, and the demo script rehearsed once.",
  project: "PREAMP",
} as const

/**
 * The scenario task, assigned to the org's owner (the visitor): the projects
 * scenario's teammate comments on it. Null when the org has no owner.
 */
async function seedScenarioTask(
  ctx: SeedContext,
  org: SeedDemoOrgResult,
  actors: Record<string, UserContext>,
): Promise<string | null> {
  const assignee = org.ownerUserId
  const spec = PROJECT_SPECS.find((p) => p.key === SCENARIO_TASK.project)
  const creator = spec ? actors[spec.owner] : undefined
  if (!assignee || !spec || !creator) return null
  const taskId = await seedProjectTask(ctx, creator, {
    projectKey: spec.key,
    externalRef: SCENARIO_TASK.externalRef,
    title: SCENARIO_TASK.title,
    description: SCENARIO_TASK.description,
    statusLabel: "todo",
    assigneeId: assignee,
    priority: "high",
    dueInDays: 5,
  })
  if (taskId) ctx.log(`projects: the visitor's scenario task '${SCENARIO_TASK.title}' is ready`)
  return taskId
}

/** The sales scenario's prospect, as a contact the prospect routine's filter names. */
export const SCENARIO_PROSPECT = {
  email: "ines.duarte@northwind-acoustics.example",
  name: "Inês Duarte",
  company: "Northwind Acoustics",
} as const

async function seedProspectContact(ctx: SeedContext, actor: UserContext): Promise<void> {
  await resolveContacts(ctx, actor, [
    {
      key: "prospect",
      email: SCENARIO_PROSPECT.email,
      name: SCENARIO_PROSPECT.name,
      company: SCENARIO_PROSPECT.company,
      externalId: { demo: "prospect:northwind-acoustics" },
      tags: ["prospect"],
    },
  ])
  ctx.log(`contacts: the sales scenario's prospect ${SCENARIO_PROSPECT.name} is ready`)
}

/**
 * The support scenario's customer (the live ticket's sender), as a known
 * contact: the first-look routine finds her on its first lookup instead of
 * searching for her again under every spelling. Only a contact: adding her to
 * the world's customers would reshuffle the store's generated orders.
 */
async function seedSupportCustomerContact(ctx: SeedContext, actor: UserContext): Promise<void> {
  await resolveContacts(ctx, actor, [
    {
      key: "support-customer",
      email: SUPPORT_WORLD_CUSTOMER.email,
      name: SUPPORT_WORLD_CUSTOMER.name,
      externalId: { demo: "customer:lena-hart" },
      tags: ["customer"],
    },
  ])
  ctx.log(`contacts: the support scenario's customer ${SUPPORT_WORLD_CUSTOMER.name} is ready`)
}

/**
 * The school the seeded dealer quote is for, as a contact linked to its demo
 * store customer: the quote's draft order is then made for that customer, whose
 * record carries the email Invoicing needs. Only a contact, like the support
 * customer above: adding the school to the world's dealers would reshuffle the
 * store's generated orders.
 */
async function seedQuoteDealerContact(ctx: SeedContext, actor: UserContext): Promise<void> {
  await resolveContacts(ctx, actor, [
    {
      key: "quote-dealer",
      email: DEMO_QUOTE_DEALER.email,
      name: DEMO_QUOTE_DEALER.name,
      company: DEMO_QUOTE_DEALER.name,
      externalId: {
        demo: `dealer:${DEMO_QUOTE_DEALER.key}`,
        shopify: `gid://shopify/Customer/${DEMO_QUOTE_DEALER.shopifyCustomerId}`,
      },
      tags: ["dealer"],
      recipientCountry: DEMO_QUOTE_DEALER.country,
      metadata: { country: DEMO_QUOTE_DEALER.country, relationship: "dealer" },
    },
  ])
  ctx.log(`contacts: the dealer quote's customer ${DEMO_QUOTE_DEALER.name} is ready`)
}

/** An approval whose tool belongs to an app the tailored seed installed. */
function approvalToolInstalled(spec: ApprovalSpec, installedApps: ReadonlySet<string>): boolean {
  const app = spec.toolName.split(":")[0] ?? ""
  return app === "kernel" || installedApps.has(app)
}

/**
 * The conversation the Mail tour opens: the newest one waiting on an answer
 * (the customer's question is its last message), which no seeded routine
 * replies to. A visitor's seed leaves it, and only it, unread (walk D49).
 */
export const MAIL_TOUR_CONVERSATION = "org-acme-volume-quote"

/** How many items each app seeds when a visitor picked several needs. */
export const SHORT_BACKLOG = 6

/** The tickets and mail conversations a seeded approval's payload names, by spec key. */
function approvalReferences(approvals: readonly ApprovalSpec[]): {
  tickets: Set<string>
  mail: Set<string>
} {
  const tickets = new Set<string>()
  const mail = new Set<string>()
  for (const spec of approvals) {
    if (spec.ticketKey) tickets.add(spec.ticketKey)
    spec.payload({
      ticket: (key) => {
        tickets.add(key)
        return key
      },
      skill: (name) => name,
      mailAccount: (box) => box,
      mailConversation: (key) => {
        mail.add(key)
        return key
      },
      contact: (email) => email,
      commerce: (_kind, key) => key,
      placeholder: (_kind, key) => key,
      at: () => new Date(0).toISOString(),
    })
  }
  return { tickets, mail }
}

/**
 * A short backlog of `all`: the `SHORT_BACKLOG` most recent items, and every
 * item a seeded approval names (its card must open onto it), in their
 * original order.
 */
function shortBacklogOf<T extends { key: string }>(
  all: readonly T[],
  ageHours: (item: T) => number,
  named: ReadonlySet<string>,
): T[] {
  const recent = new Set(
    [...all]
      .sort((a, b) => ageHours(a) - ageHours(b))
      .slice(0, SHORT_BACKLOG)
      .map((item) => item.key),
  )
  return all.filter((item) => recent.has(item.key) || named.has(item.key))
}

/**
 * The need whose scenario a seeded approval belongs to: the one that installs
 * its tool's app. Null for a kernel tool, which no scenario is about.
 */
export function approvalScenarioNeed(spec: Pick<ApprovalSpec, "toolName">): DemoNeed | null {
  const app = spec.toolName.split(":")[0] ?? ""
  for (const need of DEMO_NEEDS) {
    const apps: readonly string[] =
      need === "commerce"
        ? [...DEMO_NEED_SPECS[need].apps, ...COMMERCE_LAYER_APPS]
        : DEMO_NEED_SPECS[need].apps
    if (apps.includes(app)) return need
  }
  return null
}

// ── 5. Calendar ────────────────────────────────────────────────────────────

async function seedCalendar(
  ctx: SeedContext,
  org: SeedDemoOrgResult,
  adminActor: UserContext,
  specs: DemoSupportSpecs,
): Promise<{ eventIds: string[]; calendarId: string }> {
  const seeded = await seedTeamCalendar(ctx, adminActor, {
    accountEmail: `team@${org.world.company.supportEmail.split("@")[1]}`,
    calendarExternalId: "demo-team-calendar",
    calendarName: specs.calendarName,
    timezone: org.timezone,
    people: org.peopleByKey,
    events: specs.events,
  })
  ctx.log(`calendar: ${seeded.eventIds.length} events on the shared team calendar`)
  return seeded
}

// ── 6. Mail ────────────────────────────────────────────────────────────────

async function seedMail(
  ctx: SeedContext,
  org: SeedDemoOrgResult,
  conversations: readonly MailConversationSpec[],
  all: readonly MailConversationSpec[],
): Promise<{ accountIds: string[]; conversationIds: string[] }> {
  const domain = org.world.company.supportEmail.split("@")[1] as string
  // Every mailbox of the whole world, even when a short backlog seeds fewer
  // conversations: the accounts are part of the workspace either way.
  const boxes = ["org", ...new Set(all.filter((c) => c.box !== "org").map((c) => c.box))]
  const mailboxes = boxes.map((box) => {
    if (box === "org") {
      return {
        box,
        ownerUserId: null,
        email: `support@${domain}`,
        displayName: `${org.world.company.name} support`,
      }
    }
    const person = org.peopleByKey[box]
    if (!person) throw new Error(`demo support seed: no person for mailbox '${box}'`)
    return { box, ownerUserId: person.userId, email: person.email, displayName: person.name }
  })
  const seeded = await insertUnarmedMail(ctx, { domain, mailboxes, conversations })
  ctx.log(
    `mail: ${seeded.accountIds.length} mailboxes, ${seeded.conversationIds.length} conversations`,
  )
  return seeded
}

// ── 7. Threads, channels and the owner's agent DMs ─────────────────────────

async function seedThreads(
  ctx: SeedContext,
  org: SeedDemoOrgResult,
  actors: Record<string, UserContext>,
  specs: readonly ThreadSpec[],
): Promise<{ threadIds: string[]; byKey: Record<string, string> }> {
  const byKey = await seedThreadRooms(ctx, {
    actors,
    people: org.peopleByKey,
    agentsByHandle: org.agentsByHandle,
    specs,
  })
  const channels = specs.filter((t) => t.topic !== undefined).length
  ctx.log(
    `threads: ${Object.keys(byKey).length} conversations, one pinned, ` +
      `${channels} described channels`,
  )
  return { threadIds: Object.values(byKey), byKey }
}

/**
 * The owner's one to one rooms: one with their own personal assistant and one
 * with a role agent. Skipped entirely when the org has no owner (the reset
 * probe seeds one that way): the human seat is the owner, and there is no
 * honest stand-in for them.
 */
async function seedAgentDms(
  ctx: SeedContext,
  org: SeedDemoOrgResult,
  specs: readonly AgentDmSpec[],
): Promise<string[]> {
  if (!org.ownerUserId) {
    ctx.log("agent dms: this org has no owner, so there is nobody to hold the human seat")
    return []
  }
  const owner = await actorFor(ctx, org.ownerUserId)
  const threadIds = await seedAgentDmRooms(ctx, owner, {
    agentsByHandle: org.agentsByHandle,
    specs,
  })
  ctx.log(`agent dms: ${threadIds.length} one to one conversations for the owner`)
  return threadIds
}

// ── 8. Approvals ───────────────────────────────────────────────────────────
//
// The specs, and the payload each one carries, live in `approval-specs.ts`:
// pure, so a test holds every payload to the real schema of the tool it
// targets. Each payload is built from the ids this seed actually wrote.

// Refused at load, not at the first "Open ticket" that goes nowhere.
assertTicketApprovalsResolve(APPROVAL_SPECS, TICKET_SPECS)

/** The `products` world's support, knowledge and threads: today's Resonant Audio Labs. */
export const PRODUCTS_SUPPORT_WORLD: DemoSupportWorld = {
  support: {
    customerCompanies: CUSTOMER_COMPANIES,
    contactDuplicates: DEMO_CONTACT_DUPLICATES,
    inboxes: { support: SUPPORT_INBOX, sales: SALES_INBOX, bugs: BUGS_INBOX },
    ticketCategories: TICKET_CATEGORIES,
    tickets: TICKET_SPECS,
    // The customer wrote twice about the same delayed parcel.
    ticketMerges: [
      {
        target: "merge-target-delay",
        source: "merge-source-delay",
        note: "Same parcel, same customer. Merged so the chase happens once.",
      },
    ],
    projects: PROJECT_SPECS,
    calendarName: DEMO_CALENDAR_NAME,
    events: EVENT_SPECS,
    mail: MAIL_CONVERSATIONS,
    mailTourConversation: MAIL_TOUR_CONVERSATION,
    companies: COMPANY_SPECS,
    pipeline: SALES_PIPELINE,
    approvals: APPROVAL_SPECS,
    productScenarios: true,
  },
  knowledge: {
    authorKey: "elodie",
    collections: KNOWLEDGE_COLLECTIONS,
    articles: ARTICLE_SPECS,
  },
  threads: { threads: THREAD_SPECS, agentDms: AGENT_DM_SPECS },
}

/**
 * Who a ticket approval may notify. A notification is an invitation to
 * decide; one that lands on a person the ticket is hidden from (another
 * team's queue) is a card they can read and a ticket they cannot. `keep` is
 * the spec's list minus those people; `dropped` is EVERY seeded person who
 * cannot open the ticket, so a row an earlier seed wrote is cleaned too. An
 * approval that names no ticket notifies as written.
 */
async function notifyKeysWhoCanSee(
  spec: ApprovalSpec,
  ticketId: string | undefined,
  actors: Record<string, UserContext>,
): Promise<{ keep: string[]; dropped: string[] }> {
  if (!ticketId) return { keep: spec.notify, dropped: [] }
  const dropped: string[] = []
  for (const [key, actor] of Object.entries(actors)) {
    if (!(await ticketReadableBy(actor, ticketId))) dropped.push(key)
  }
  const keep = spec.notify.filter((key) => key in actors && !dropped.includes(key))
  return { keep, dropped }
}

async function seedApprovals(
  ctx: SeedContext,
  peopleByKey: Record<string, { userId: string } | undefined>,
  threadsByKey: Record<string, string>,
  ticketsByKey: Record<string, string>,
  actors: Record<string, UserContext>,
  approvals: readonly ApprovalSpec[],
  /** A tailored seed keeps only the approvals whose tool's app is installed. */
  keep?: (spec: ApprovalSpec) => boolean,
): Promise<string[]> {
  const { orgId } = ctx
  const clock: SeedClock = seedClock(ctx.now)
  const specs = keep ? approvals.filter(keep) : approvals
  // Resolved first: each check is a read under that person's own RLS context.
  const notifyByKey: Record<string, { keep: string[]; dropped: string[] }> = {}
  for (const spec of specs) {
    const ticketId = spec.ticketKey ? ticketsByKey[spec.ticketKey] : undefined
    notifyByKey[spec.key] = await notifyKeysWhoCanSee(spec, ticketId, actors)
  }
  // The ids a payload may name. Skills are resolved by name (the skills layer
  // runs after this one, so the first ever run falls back to a stable id the
  // card still renders), contacts by email from what the contacts layer wrote,
  // and every other row by the same deterministic id its own layer writes it
  // under.
  const { skillIdByName, contactIdByEmail } = await approvalLookups(ctx)
  const refsFor = (spec: ApprovalSpec): ApprovalRefs => ({
    ticket: (key) => {
      const ticketId = ticketsByKey[key]
      if (!ticketId) throw new Error(`approval ${spec.key}: ticket ${key} was not seeded`)
      return ticketId
    },
    skill: (name) => skillIdByName.get(name) ?? ctx.id("skill", name),
    mailAccount: (box) => ctx.id("mail-account", box),
    mailConversation: (key) => ctx.id("mail-conversation", key),
    contact: (email) => {
      const contactId = contactIdByEmail.get(email.toLowerCase())
      if (!contactId) throw new Error(`approval ${spec.key}: contact ${email} was not seeded`)
      return contactId
    },
    commerce: (kind, key) => commerceDemoId(orgId, kind, key),
    placeholder: (kind, key) => ctx.id(`approval-${kind}`, key),
    at: (hours) => clock.hoursAfter(hours).toISOString(),
  })
  const toIds = (keys: string[]): string[] =>
    keys.map((key) => peopleByKey[key]?.userId).filter((v): v is string => Boolean(v))

  const rows: ApprovalRequestSeed[] = []
  for (const spec of specs) {
    const threadId = threadsByKey[spec.thread]
    if (!threadId) continue
    const requestedBy = peopleByKey[spec.requestedBy]?.userId
    if (!requestedBy) continue
    const notify = notifyByKey[spec.key] ?? { keep: spec.notify, dropped: [] }
    if (spec.ticketKey && !ticketsByKey[spec.ticketKey]) {
      throw new Error(`approval ${spec.key}: ticket ${spec.ticketKey} was not seeded`)
    }
    rows.push({
      id: ctx.id("approval", spec.key),
      handle: `demo-${spec.key}`,
      threadId,
      toolName: spec.toolName,
      payload: spec.payload(refsFor(spec)),
      // The kernel's default lifetime from when it was staged.
      notifyUserIds: toIds(notify.keep),
      droppedUserIds: toIds(notify.dropped),
      requestedBy,
      // Raised from the conversation, not proposed by an agent's turn.
      agentId: null,
      status: spec.status,
      reason: spec.reason ?? null,
      decidedBy: (spec.decidedBy ? peopleByKey[spec.decidedBy]?.userId : null) ?? null,
      decidedAt: spec.status === "pending" ? null : clock.hoursBefore(spec.hoursAgo - 1),
      createdAt: clock.hoursBefore(spec.hoursAgo),
    })
  }
  const approvalIds = await seedApprovalRequests(ctx, rows)
  const pending = specs.filter((s) => s.status === "pending").length
  ctx.log(`approvals: ${approvalIds.length} requests, ${pending} still waiting on a decision`)
  return approvalIds
}

// ── The entry point ────────────────────────────────────────────────────────

/**
 * Seed the support and collaboration half of the demo world onto an org that
 * `seedDemoOrg` has already created (and stamped as a demo org).
 *
 * Idempotent: a second call changes no row count and throws nothing. Every
 * section either resolves the row it made last time by a natural key (a ticket's
 * `externalRef`, a project's `key`, a task's `externalRef`, a contact's email, a
 * document or thread title) or collides on a deterministic primary key.
 */
export async function seedDemoSupport(
  org: SeedDemoOrgResult,
  opts: SeedDemoSupportOptions,
): Promise<SeedDemoSupportResult> {
  const log = opts.log ?? (() => {})
  const ctx = seedContext({ orgId: org.orgId, now: opts.now, log })
  const world = opts.specs ?? PRODUCTS_SUPPORT_WORLD
  const specs = world.support

  const adminActor = await actorFor(ctx, org.adminUserId)
  const actors: Record<string, UserContext> = {}
  for (const person of org.people) {
    actors[person.key] = await actorFor(ctx, person.userId)
  }

  // Always: people's contacts, knowledge, calendar, threads and agent DMs. A
  // tailored seed writes each optional part only for a need that asks for it.
  const tailored = opts.tailored
  const wants = (part: DemoSeedPart) => !tailored || tailored.parts.has(part)
  const contacts = await seedContacts(ctx, org, adminActor, specs)
  // Companies come after the address book they group; their deals need the
  // projects app, so a tailored seed without it keeps the companies only.
  const companyIds = await seedCompanies(ctx, adminActor, specs.companies, contacts.byKey)
  if (wants("projects")) {
    await seedPipeline(ctx, adminActor, {
      people: org.peopleByKey,
      companyIds,
      contactIds: contacts.byKey,
      spec: specs.pipeline,
      externalRefOf: dealRef,
    })
  }
  // Several needs picked: each app seeds a short backlog, not its whole history.
  const short = tailored?.shortBacklog === true ? approvalReferences(specs.approvals) : null
  const tickets = wants("tickets")
    ? await seedTickets(
        ctx,
        org,
        contacts.byKey,
        specs,
        short
          ? shortBacklogOf(specs.tickets, (t) => t.createdHoursAgo, short.tickets)
          : specs.tickets,
      )
    : { ticketIds: [], inboxIds: [], categoryIds: [], byKey: {} }
  const knowledge = await seedKnowledge(ctx, org, actors, world.knowledge)
  // The synced sources (manuals from GitLab, finance from Google Drive) and the
  // playbook written in Liaison, with their sharing: every visitor's world.
  if (specs.productScenarios) {
    const founder = actors.elodie
    if (!founder) throw new Error("demo support seed: no founder for the knowledge sources")
    const sources = await seedKnowledgeSources(org, founder, opts.now, log)
    knowledge.collectionIds.push(...sources.collectionIds)
    knowledge.documentIds.push(...sources.documentIds)
  }
  const projects = wants("projects")
    ? await seedProjects(ctx, org, actors, specs.projects)
    : { projectIds: [], taskIds: [], overdueCount: 0 }
  if (specs.productScenarios && tailored?.parts.has("scenario-task")) {
    const scenarioTask = await seedScenarioTask(ctx, org, actors)
    if (scenarioTask) projects.taskIds.push(scenarioTask)
  }
  const calendar = await seedCalendar(ctx, org, adminActor, specs)
  const mail = wants("mail")
    ? await seedMail(
        ctx,
        org,
        short
          ? shortBacklogOf(
              specs.mail,
              (c) => (c.messages[c.messages.length - 1] as { hoursAgo: number }).hoursAgo,
              // The Mail tour's conversation is always there.
              new Set([
                ...short.mail,
                ...(specs.mailTourConversation ? [specs.mailTourConversation] : []),
              ]),
            )
          : specs.mail,
        specs.mail,
      )
    : { accountIds: [], conversationIds: [] }
  if (specs.productScenarios) {
    if (tailored?.parts.has("prospect-routine")) await seedProspectContact(ctx, adminActor)
    await seedSupportCustomerContact(ctx, adminActor)
    await seedQuoteDealerContact(ctx, adminActor)
  }
  const threads = await seedThreads(ctx, org, actors, world.threads.threads)
  const dmThreadIds = await seedAgentDms(ctx, org, world.threads.agentDms)
  // A visitor's workspace opens with nothing waiting on them: a scenario's
  // pending approvals are written when that scenario starts
  // (`seedScenarioApprovals`), and the decided ones are history.
  const approvalIds = await seedApprovals(
    ctx,
    org.peopleByKey,
    threads.byKey,
    tickets.byKey,
    actors,
    specs.approvals,
    tailored
      ? (spec) => spec.status !== "pending" && approvalToolInstalled(spec, tailored.installedApps)
      : undefined,
  )

  return {
    orgId: org.orgId,
    seededAt: opts.now.toISOString(),
    ticketIds: tickets.ticketIds,
    ticketInboxIds: tickets.inboxIds,
    ticketCategoryIds: tickets.categoryIds,
    mailAccountIds: mail.accountIds,
    mailConversationIds: mail.conversationIds,
    knowledgeCollectionIds: knowledge.collectionIds,
    knowledgeDocumentIds: knowledge.documentIds,
    projectIds: projects.projectIds,
    taskIds: projects.taskIds,
    calendarEventIds: calendar.eventIds,
    contactIds: contacts.contactIds,
    duplicateContactPairs: contacts.pairs,
    approvalIds,
    threadIds: [...threads.threadIds, ...dmThreadIds],
    counts: {
      contacts: contacts.contactIds.length,
      tickets: tickets.ticketIds.length,
      ticketInboxes: tickets.inboxIds.length,
      ticketCategories: tickets.categoryIds.length,
      knowledgeCollections: knowledge.collectionIds.length,
      knowledgeDocuments: knowledge.documentIds.length,
      knowledgeStale: knowledge.staleCount,
      projects: projects.projectIds.length,
      tasks: projects.taskIds.length,
      tasksOverdue: projects.overdueCount,
      calendarEvents: calendar.eventIds.length,
      mailAccounts: mail.accountIds.length,
      mailConversations: mail.conversationIds.length,
      threads: threads.threadIds.length + dmThreadIds.length,
      agentDms: dmThreadIds.length,
      approvals: approvalIds.length,
    },
  }
}

/**
 * Write the pending approvals of one scenario, when the visitor starts it: the
 * seeded requests whose tool belongs to the app that scenario is about
 * (`approvalScenarioNeed`). A visitor's workspace opens with none waiting, so
 * the approvals queue holds at most the scenario in progress's. Idempotent:
 * a replayed scenario rewrites the same rows (deterministic ids), and a
 * request the visitor already decided keeps its decision.
 *
 * Only reached for a demo org: its caller (`seedScenarioStart`) is the demo
 * scenario start, on the org the demo tier seeded. Reads back what the signup
 * seed wrote (the people by their address in this org, the conversations by
 * title, the tickets by their seed reference); a request whose conversation or
 * ticket is not there is skipped. Its time is the database's clock when no
 * `now` is given: the moment the visitor started the scenario.
 */
export async function seedScenarioApprovals(
  orgId: string,
  need: DemoNeed,
  opts: { now?: Date; log?: (msg: string) => void } = {},
): Promise<string[]> {
  const specs = APPROVAL_SPECS.filter(
    (spec) => spec.status === "pending" && approvalScenarioNeed(spec) === need,
  )
  if (specs.length === 0) return []
  const ctx = seedContext({ orgId, now: opts.now ?? (await databaseNow(orgId)), log: opts.log })
  const slug = await orgSlugOf(orgId)
  const userByEmail = await orgUserIdsByEmail(orgId)
  const peopleByKey: Record<string, { userId: string }> = {}
  for (const person of DEMO_TEAM) {
    const userId = userByEmail.get(demoPersonEmail(slug, person.key).toLowerCase())
    if (userId) peopleByKey[person.key] = { userId }
  }
  const threadByTitle = await threadIdsByTitle(
    ctx,
    THREAD_SPECS.map((t) => t.title),
  )
  const threadsByKey: Record<string, string> = {}
  for (const spec of THREAD_SPECS) {
    const id = threadByTitle.get(spec.title)
    if (id) threadsByKey[spec.key] = id
  }
  const ticketByRef = await ticketIdsByExternalRef(
    ctx,
    specs.flatMap((spec) => (spec.ticketKey ? [ticketRef(spec.ticketKey)] : [])),
  )
  const ticketsByKey: Record<string, string> = {}
  for (const spec of specs) {
    const id = spec.ticketKey ? ticketByRef.get(ticketRef(spec.ticketKey)) : undefined
    if (spec.ticketKey && id) ticketsByKey[spec.ticketKey] = id
  }
  const actors: Record<string, UserContext> = {}
  for (const [key, person] of Object.entries(peopleByKey)) {
    actors[key] = await actorFor(ctx, person.userId)
  }
  const writable = new Set(
    specs
      .filter(
        (spec) => threadsByKey[spec.thread] && (!spec.ticketKey || ticketsByKey[spec.ticketKey]),
      )
      .map((spec) => spec.key),
  )
  return seedApprovals(
    ctx,
    peopleByKey,
    threadsByKey,
    ticketsByKey,
    actors,
    APPROVAL_SPECS,
    (spec) => writable.has(spec.key),
  )
}
