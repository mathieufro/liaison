// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The factories `/api/_test/seed` runs, by name (`<group>.<factory>`). Each
// entry validates its args and calls one seed engine factory; none writes a
// row itself. Add a factory here when a browser test needs a row the engine
// can make, never a raw insert in the test.
import { randomBytes } from "node:crypto"
import type { z } from "zod"
import { z as zod } from "zod"
import { withRlsContext } from "~/db/rls"
import { createDraft, draftAppName } from "~/modules/app-builder/drafts"
import { DRAFT_TEMPLATES, templateFiles } from "~/modules/app-builder/templates"
import { writeAppConfigKey } from "~/modules/apps/app-config"
import { setDocument } from "~/modules/data-store/service"
import {
  installProvisionedKey,
  mintProvisionedIdentity,
} from "~/modules/liaison-team/provisioned-identity"
import { hasScope } from "~/modules/permissions/permissions"
import type { SeedContext } from "~/seed/context"
import { seedBaseAgent, upsertRoleAgent } from "~/seed/factories/agent/agents"
import { seedOrgSkills } from "~/seed/factories/agent/skills"
import { seedOrgBillingState } from "~/seed/factories/billing/billing"
import { actorFor } from "~/seed/factories/people/actors"
import { resolveContacts } from "~/seed/factories/people/contacts"
import {
  assignRoleTo,
  createRoleWithGrants,
  grantScopesThroughRole,
} from "~/seed/factories/people/scoped-role"
import {
  addUserDimensionValues,
  clearUserDimension,
  setUserDimension,
} from "~/seed/factories/people/user-dimensions"
import { ensureTicketMailboxInbox } from "~/seed/factories/support/inboxes"
import {
  appendTicketMessages,
  closeTickets,
  createOneTicket,
  createTicketApiKey,
  shiftTicketClock,
} from "~/seed/factories/support/ticket"
import { seedReferencingThreads } from "~/seed/factories/threads/referencing"
import { contact, orgAdmin, person, revokeRole, thread } from "~/seed/tiers/minimal"
import {
  alignOwnAgentCeiling,
  replaceRoutineRuns,
  restorePersonScope,
  revokePersonScope,
  seedAgentChat,
  seedPricingCatalog,
  seedSubAgentDefinition,
  setCreditBalance,
} from "./agent"
import { refreshStoredAppAttention } from "./attention"
import { forceCalendarReauth, seedCalendarAccount } from "./calendar"
import { expireApproval, stageGatedApproval } from "./gated-approval"
import { injectInboundMail, injectThreadMessage } from "./inject"
import { appendMailMessages, ensureMailAccount, seedMailConversation, seedMailDraft } from "./mail"
import { ensureMockConnection } from "./mock-connections"
import { seedMonthEndClient } from "./month-end"
import { ensureSecondOrg } from "./second-org"

export interface SeedRouteFactory<A extends z.ZodTypeAny = z.ZodTypeAny> {
  args: A
  /** "none": the factory makes an org and takes no `orgId`. Default: the request names one. */
  org?: "none"
  run: (ctx: SeedContext, args: z.infer<A>, call: { key: string }) => Promise<unknown>
}

function factory<A extends z.ZodTypeAny>(
  args: A,
  run: SeedRouteFactory<A>["run"],
  opts: { org?: "none" } = {},
): SeedRouteFactory<A> {
  return { args, run, ...opts }
}

const uuid = zod.string().uuid()

/** The scopes of `scopes` the person's roles do not grant yet. */
async function missingScopes(ctx: SeedContext, userId: string, scopes: string[]) {
  const held = (await actorFor(ctx, userId)).scopes
  return scopes.filter((s) => !hasScope(s, held))
}

const mailAddress = zod.object({ name: zod.string().optional(), email: zod.string().min(3) })
const mailMessage = zod.object({
  direction: zod.enum(["inbound", "outbound"]),
  from: mailAddress,
  to: zod.array(mailAddress).default([]),
  textBody: zod.string(),
  htmlBody: zod.string().nullish(),
  sentAt: zod.string().datetime().optional(),
  isRead: zod.boolean().optional(),
  sentByUserId: uuid.nullish(),
  rawHeaders: zod.record(zod.string(), zod.string()).optional(),
})

export const SEED_FACTORIES: Record<string, SeedRouteFactory> = {
  /**
   * Another org with a loginable admin, through the provisioning CLI's org and
   * admin provisioners (the instance's first org came from its one
   * registration). Adopted by the admin's email on a repeat call. `withData`
   * adds the admin's own thread and a contact, a positive control for an
   * isolation check.
   */
  "org.second": factory(
    zod.object({
      orgName: zod.string().min(1).default("Second Org"),
      adminEmail: zod.string().email(),
      adminPassword: zod.string().min(8),
      adminName: zod.string().min(1).default("Org B Admin"),
      withData: zod.boolean().default(false),
    }),
    async (_ctx, a, call) => {
      const org = await ensureSecondOrg({ ...a, slugKey: call.key })
      if (!a.withData) return { ...org, threadId: null, contactId: null }
      if (!org.created) return org
      const threadId = await thread(org.orgId, org.adminUserId, {
        title: `${a.orgName} private thread`,
      })
      const contactId = await contact(
        org.orgId,
        `contact-${call.key.slice(0, 8)}@second-org.test`,
        {
          name: `${a.orgName} contact`,
        },
      )
      return { ...org, threadId, contactId }
    },
    { org: "none" },
  ),

  /**
   * A connected account with placeholder credentials (test builds only), for an
   * app connection a test needs without the provider's OAuth round trip.
   */
  "connections.mock": factory(
    zod.object({
      appName: zod.string().min(1),
      connectionName: zod.string().min(1),
      ownerType: zod.enum(["user", "org"]),
      userId: uuid,
      identifier: zod.string().min(1),
      displayName: zod.string().min(1),
      /** The account's metadata, e.g. an org Drive connection's `sharedDrives`. */
      metadata: zod.record(zod.string(), zod.unknown()).optional(),
      kind: zod.discriminatedUnion("type", [
        zod.object({
          type: zod.literal("oauth2"),
          providerAccountId: zod.string().optional(),
          /** The access token sealed on the row (default a placeholder). */
          accessToken: zod.string().min(1).optional(),
          /** The refresh token sealed on the row (default a placeholder). */
          refreshToken: zod.string().min(1).optional(),
        }),
        zod.object({
          type: zod.literal("credentials"),
          credentials: zod.record(zod.string(), zod.string()),
        }),
      ]),
    }),
    (ctx, a) => ensureMockConnection(ctx.orgId, a),
  ),

  /**
   * A pending approval through the kernel's gate: the requester's agent makes
   * the gated call in a conversation (a new one titled `title` unless
   * `threadId`), the gate parks it, notifies and announces it, and the agent's
   * message keeps the blocked call (the inline card). `approverUserIds` get the
   * deciding scope through a role first.
   */
  "approvals.gated": factory(
    zod.object({
      requesterUserId: uuid,
      toolName: zod.string().min(1).default("test:gatedEcho"),
      params: zod
        .record(zod.string(), zod.unknown())
        .default({ message: "Please approve this response." }),
      threadId: uuid.nullish(),
      title: zod.string().min(1).default("Approval request"),
      participantUserIds: zod.array(uuid).default([]),
      approverUserIds: zod.array(uuid).default([]),
      approveScope: zod.string().min(1).optional(),
      toolCallMessage: zod.boolean().default(true),
      mention: zod.boolean().default(false),
    }),
    async (ctx, a, call) => {
      const admin = await orgAdmin(ctx.orgId)
      return stageGatedApproval(ctx, { ...a, key: call.key, adminUserId: admin.id })
    },
  ),

  /** The kernel's expiry job run on a pending approval now (its live update included). */
  "approvals.expire": factory(zod.object({ approvalRequestId: uuid }), (ctx, a) =>
    expireApproval(ctx, a.approvalRequestId),
  ),

  /** An org-shared skill on the org's base agent, created by its admin; its id. */
  "skills.org": factory(
    zod.object({
      name: zod.string().min(1),
      description: zod.string().min(1).max(100).default("seeded org skill"),
      body: zod.string().min(1),
      domain: zod.string().min(1).default("general"),
    }),
    async (ctx, a) => {
      const [admin, base] = await Promise.all([orgAdmin(ctx.orgId), seedBaseAgent(ctx.orgId)])
      const byName = await seedOrgSkills(ctx, {
        createdByUserId: admin.id,
        skills: [{ ...a, ownerAgentId: base.agentId, requiredScopes: [], keywords: [], apps: [] }],
      })
      return { id: byName[a.name] }
    },
  ),

  /** A mailbox at `email` on its own (placeholder) connection, personal or the org's. */
  "mail.account": factory(
    zod.object({
      ownerType: zod.enum(["user", "org"]),
      userId: uuid,
      email: zod.string().min(3),
      provider: zod.enum(["gmail", "imap"]).default("gmail"),
    }),
    (ctx, a) => ensureMailAccount(ctx, a),
  ),

  /** A conversation on a mailbox with its messages (unarmed plaintext), optionally linked to a new thread. */
  "mail.conversation": factory(
    zod.object({
      accountId: uuid,
      subject: zod.string().min(1),
      status: zod.enum(["open", "archived", "trashed"]).default("open"),
      labels: zod.array(zod.string()).default([]),
      isRead: zod.boolean().default(false),
      isStarred: zod.boolean().default(false),
      snippet: zod.string().optional(),
      contactId: uuid.nullish(),
      assignedTo: uuid.nullish(),
      linkThreadTitle: zod.string().min(1).optional(),
      linkThreadBy: uuid.optional(),
      lastMessageAt: zod.string().datetime().optional(),
      messageCount: zod.number().int().min(0).optional(),
      messages: zod.array(mailMessage).default([]),
    }),
    (ctx, a) => seedMailConversation(ctx, a),
  ),

  /** More messages on a conversation; `announce` sends them live through the outbox. */
  "mail.messages": factory(
    zod.object({
      conversationId: uuid,
      messages: zod.array(mailMessage).min(1),
      updateConversation: zod.boolean().default(true),
      announce: zod.boolean().default(false),
    }),
    (ctx, a) => appendMailMessages(ctx, a),
  ),

  /** A draft on a mailbox: a reply on a conversation, or a new message. */
  "mail.draft": factory(
    zod.object({
      accountId: uuid,
      userId: uuid,
      conversationId: uuid.nullish(),
      replyToMessageId: uuid.nullish(),
      to: zod.array(zod.object({ email: zod.string().min(3) })).default([]),
      subject: zod.string().default(""),
      htmlBody: zod.string().default(""),
      textBody: zod.string().default(""),
    }),
    (ctx, a) => seedMailDraft(ctx, a),
  ),

  /**
   * A synthetic inbound email through the real tickets matcher (no Gmail
   * round trip); the matcher's outcome. `inboxId` defaults to the org's oldest inbox.
   */
  "mail.injectInbound": factory(
    zod.object({
      fromEmail: zod.string().min(3),
      fromName: zod.string().optional(),
      subject: zod.string().min(1),
      textBody: zod.string().min(1),
      messageId: zod.string().min(1),
      inboxId: uuid.optional(),
    }),
    (ctx, a) => injectInboundMail(ctx, a),
  ),

  /**
   * A Google Calendar connected by `userId` (org-wide or theirs), one calendar
   * imported and, unless `populate: false`, three events synced in, all
   * through the real sync engine.
   */
  "calendar.account": factory(
    zod.object({
      userId: uuid,
      ownerType: zod.enum(["org", "user"]),
      ownerId: uuid.nullish(),
      identifier: zod.string().min(3),
      populate: zod.boolean().default(true),
    }),
    (ctx, a) => seedCalendarAccount(ctx, a),
  ),

  /** A calendar account put in `reauth-required`, the state a failed token refresh leaves. */
  "calendar.forceReauth": factory(zod.object({ accountId: uuid }), (ctx, a) =>
    forceCalendarReauth(ctx, a.accountId),
  ),

  /**
   * One message on a thread with the author type and metadata given as is
   * (the product's post strips both), e.g. a sub-run card; its id.
   */
  "threads.injectMessage": factory(
    zod.object({
      threadId: uuid,
      authorId: uuid,
      content: zod.string().min(1),
      authorType: zod.enum(["user", "agent", "system"]).default("agent"),
      metadata: zod.record(zod.string(), zod.unknown()).optional(),
      /** The speaking agent of an `agent` message (default: the org's base agent). */
      authorAgentId: uuid.optional(),
      /** `runtime`: the agent the reply path would name (the author's own, else the org's). */
      speaker: zod.enum(["base", "runtime"]).optional(),
      requiredScopes: zod.array(zod.string()).optional(),
      createdAt: zod.string().datetime().optional(),
    }),
    (ctx, a) => injectThreadMessage(ctx, a),
  ),

  /** An unattended persona action step's acknowledgement (the chaos persona executor). */
  "persona.step": factory(
    zod.object({ persona: zod.string().optional(), step: zod.string().optional() }).passthrough(),
    async (_ctx, a) => ({ ok: true, persona: a.persona ?? null, step: a.step ?? null }),
    { org: "none" },
  ),

  /** The message list a verify step of an unattended persona reads (empty: nothing to verify against). */
  "persona.messages": factory(zod.object({}).passthrough(), async () => ({ messages: [] }), {
    org: "none",
  }),

  /** A person in the org who holds no role (invited as a member, the role then taken away). */
  "people.roleless": factory(
    zod.object({ name: zod.string().min(1), email: zod.string().email() }),
    async (ctx, a) => {
      const p = await person(ctx.orgId, { name: a.name, email: a.email })
      await revokeRole(p.id, "member")
      return { id: p.id, name: a.name, email: p.email }
    },
  ),

  /** Set the person's own grant of one dimension to these values. */
  "people.grantDimension": factory(
    zod.object({
      userId: uuid,
      dimension: zod.string().min(1),
      values: zod.array(zod.string()),
      /** Keep the values they already had (default: exactly `values`). */
      merge: zod.boolean().default(false),
    }),
    async (ctx, { merge, ...a }) => {
      const admin = await orgAdmin(ctx.orgId)
      const write = merge ? addUserDimensionValues : setUserDimension
      await write(ctx.orgId, { adminUserId: admin.id, ...a })
      return { granted: true }
    },
  ),

  /** Take the person's own grant of one dimension away. */
  "people.revokeDimension": factory(
    zod.object({ userId: uuid, dimension: zod.string().min(1) }),
    async (ctx, a) => {
      const admin = await orgAdmin(ctx.orgId)
      await clearUserDimension(ctx.orgId, { adminUserId: admin.id, ...a })
      return { revoked: true }
    },
  ),

  /** A new role with exactly these scopes and dimension grants. */
  "roles.create": factory(
    zod.object({
      name: zod.string().min(1),
      scopes: zod.array(zod.string().min(1)).default([]),
      dimensions: zod.record(zod.string(), zod.array(zod.string())).default({}),
    }),
    async (ctx, a) => {
      const admin = await orgAdmin(ctx.orgId)
      return createRoleWithGrants(ctx.orgId, { adminUserId: admin.id, ...a })
    },
  ),

  /** Give a person a role (the role editor's assignment, as the org's admin). */
  "roles.assign": factory(zod.object({ roleId: uuid, userId: uuid }), async (ctx, a) => {
    const admin = await orgAdmin(ctx.orgId)
    await assignRoleTo(ctx.orgId, { adminUserId: admin.id, ...a })
    return { assigned: true }
  }),

  /** Threads the person starts that reference an entity (what a backlinks panel lists). */
  "threads.referencing": factory(
    zod.object({
      userId: uuid,
      app: zod.string().min(1),
      entityType: zod.string().min(1),
      entityId: zod.string().min(1),
      count: zod.number().int().min(1).max(50),
      titlePrefix: zod.string().min(1).optional(),
    }),
    (ctx, a, call) =>
      seedReferencingThreads(ctx, {
        ...a,
        titlePrefix: a.titlePrefix ?? `ref-${call.key.slice(0, 6)}`,
      }),
  ),

  /** A role carrying exactly these scopes and dimension grants, assigned to the person. */
  "roles.grantScopes": factory(
    zod.object({
      userId: uuid,
      scopes: zod.array(zod.string().min(1)).min(1),
      dimensions: zod.record(zod.string(), zod.array(zod.string())).default({}),
      name: zod.string().min(1).optional(),
      /**
       * Grant only the scopes the person does not hold yet (`*` holds them
       * all): nothing missing, no role and no permission-version bump, so the
       * person's current token stays valid.
       */
      onlyMissing: zod.boolean().default(false),
    }),
    async (ctx, a, call) => {
      const scopes = a.onlyMissing ? await missingScopes(ctx, a.userId, a.scopes) : a.scopes
      if (scopes.length === 0 && Object.keys(a.dimensions).length === 0) return { roleId: null }
      const admin = await orgAdmin(ctx.orgId)
      return grantScopesThroughRole(ctx.orgId, {
        adminUserId: admin.id,
        userId: a.userId,
        name: a.name ?? `seeded-${call.key.slice(0, 8)}`,
        scopes,
        dimensions: a.dimensions,
      })
    },
  ),

  /** The model pricing catalog as the server seeds it at boot, and the bootstrap USD to EUR rate. */
  "pricing.catalog": factory(zod.object({}), () => seedPricingCatalog(), { org: "none" }),

  /**
   * A registered liaison team identity, as `liaison team identity mint` then
   * `install --key-file` leave it: the managed edition refuses to boot without
   * one (lib/managed-boot.ts). The key is random; nothing delivers with it.
   */
  "liaisonTeam.identity": factory(
    zod.object({}),
    async () => {
      const minted = await mintProvisionedIdentity({ force: true })
      await installProvisionedKey(randomBytes(32).toString("hex"))
      return { instanceId: minted.instanceId }
    },
    { org: "none" },
  ),

  /** The org's credit balance set to exactly these amounts (credit service: monthly reset, top up or refund). */
  "credits.balance": factory(
    zod.object({
      included: zod
        .string()
        .regex(/^\d+(\.\d+)?$/)
        .default("50.00000000"),
      purchased: zod
        .string()
        .regex(/^\d+(\.\d+)?$/)
        .default("50.00000000"),
    }),
    (ctx, a, call) => setCreditBalance(ctx, { ...a, key: call.key }),
  ),

  /**
   * The billing state a managed cell holds after a control plane push, for a
   * scenario that needs a managed org with a plan. A repeat call is a newer
   * push: it replaces the plan, status, period end and included credits.
   */
  "billing.state": factory(
    zod.object({
      plan: zod.enum(["preview", "base", "pro"]),
      status: zod.enum(["active", "past_due", "suspended", "closed"]).default("active"),
      periodEnd: zod.string().datetime().default("2099-01-01T00:00:00.000Z"),
      includedCredits: zod.number().nonnegative().default(10000),
    }),
    async (ctx, a) => {
      await seedOrgBillingState(
        ctx.orgId,
        {
          plan: a.plan,
          status: a.status,
          periodEnd: new Date(a.periodEnd),
          includedCredits: a.includedCredits,
        },
        { onConflict: "replace" },
      )
      return { plan: a.plan, status: a.status }
    },
  ),

  /** Take a scope from a person through the role editor (their roles and direct grant); what to restore. */
  "roles.revokeScope": factory(zod.object({ userId: uuid, scope: zod.string().min(1) }), (ctx, a) =>
    revokePersonScope(ctx, a),
  ),

  /** Give back what `roles.revokeScope` took. */
  "roles.restoreScope": factory(
    zod.object({
      userId: uuid,
      scope: zod.string().min(1),
      roleIds: zod.array(uuid),
      direct: zod.boolean(),
    }),
    (ctx, a) => restorePersonScope(ctx, a),
  ),

  /** Recompute the person's own agent's ceiling from their grants (the product's recompute). */
  "agents.alignOwnCeiling": factory(zod.object({ userId: uuid }), (ctx, a) =>
    alignOwnAgentCeiling(ctx, a.userId),
  ),

  /** A conversation the person starts with `participantUserIds` in it; its id. */
  "threads.conversation": factory(
    zod.object({
      userId: uuid,
      title: zod.string().min(1).default("Conversation"),
      participantUserIds: zod.array(uuid).default([]),
    }),
    async (ctx, a) => ({
      threadId: await thread(ctx.orgId, a.userId, {
        title: a.title,
        participantIds: a.participantUserIds.filter((id) => id !== a.userId),
      }),
    }),
  ),

  /** A new agent conversation the person starts; its id. */
  "threads.agentChat": factory(zod.object({ userId: uuid }), (ctx, a) =>
    seedAgentChat(ctx, a.userId),
  ),

  /** A shared role agent under `handle` (created, or rewritten when it exists), as `POST /api/agents` writes it. */
  "agents.role": factory(
    zod.object({
      handle: zod.string().regex(/^@[a-z0-9-]+$/),
      displayName: zod.string().min(1),
      purpose: zod.string().default(""),
      systemPrompt: zod.string().default(""),
      scopes: zod.array(zod.string().min(1)).default([]),
    }),
    (ctx, a) => upsertRoleAgent(ctx.orgId, { ...a, toolAllowlist: null, modelPreference: null }),
  ),

  /** A delegate role (`createSubAgentDefinition`), app-owned when `appName` names an app. */
  "subAgents.definition": factory(
    zod.object({
      appName: zod.string().min(1).optional(),
      agentType: zod.string().min(1),
      whenToUse: zod.string().min(1),
      scopeCeiling: zod.array(zod.string().min(1)),
      toolAllowlist: zod.array(zod.string()).optional(),
      toolDenylist: zod.array(zod.string()).optional(),
      skills: zod.array(zod.string()).optional(),
      mcpServers: zod.array(zod.string()).optional(),
      systemPrompt: zod.string().min(1),
      defaultMaxSteps: zod.number().int().positive().optional(),
      defaultTimeoutMs: zod.number().int().positive().optional(),
      defaultSchemaRetryBudget: zod.number().int().min(0).optional(),
    }),
    (ctx, a) => seedSubAgentDefinition(ctx, a),
  ),

  /** A routine's run history made exactly these runs (the run factory; none clears it), the world's runs dropped. */
  "routines.runs": factory(
    zod.object({
      routineName: zod.string().min(1),
      runs: zod
        .array(
          zod.object({
            startedAt: zod.string().datetime().nullable(),
            ranAt: zod.string().datetime().optional(),
            durationMs: zod.number().int().min(0),
            status: zod.enum(["succeeded", "failed", "skipped_overlap"]),
            trigger: zod.enum(["schedule", "event", "manual"]).nullable(),
            triggerLabel: zod.string().nullish(),
            error: zod.string().nullish(),
            turnsAdded: zod.number().int().min(0).nullable().optional(),
          }),
        )
        .default([]),
    }),
    (ctx, a, call) =>
      replaceRoutineRuns(ctx, {
        routineName: a.routineName,
        key: call.key,
        runs: a.runs.map((r) => ({
          ...r,
          startedAt: r.startedAt ? new Date(r.startedAt) : null,
          ranAt: r.ranAt ? new Date(r.ranAt) : undefined,
        })),
      }),
  ),

  /**
   * A contact of the org, through the contacts service the resolve route calls
   * (deduped on email), as `createdBy` (default: the org's admin).
   */
  "people.contact": factory(
    zod.object({
      email: zod.string().min(3),
      name: zod.string().min(1),
      company: zod.string().min(1).optional(),
      createdBy: uuid.optional(),
    }),
    async (ctx, a, call) => {
      const actor = await actorFor(ctx, a.createdBy ?? (await orgAdmin(ctx.orgId)).id)
      const [entry] = await resolveContacts(ctx, actor, [
        {
          key: call.key,
          email: a.email,
          name: a.name,
          ...(a.company ? { company: a.company } : {}),
        },
      ])
      if (!entry) throw new Error(`contact ${a.email} was not resolved`)
      return { id: entry[1].id }
    },
  ),

  /**
   * One document of the app data store (`kernel.app_documents`), through the
   * store service under the author's RLS context (the org admin by default), so
   * the size, count and version rules apply as for any write.
   */
  appDocument: factory(
    zod.object({
      app: zod.string().min(1),
      collection: zod.string().min(1),
      id: zod.string().min(1),
      data: zod.record(zod.string(), zod.unknown()),
      createdBy: uuid.optional(),
    }),
    async (ctx, a) => {
      const actor = await actorFor(ctx, a.createdBy ?? (await orgAdmin(ctx.orgId)).id)
      const doc = await withRlsContext(actor, (tx) =>
        setDocument(
          tx,
          { orgId: ctx.orgId, app: a.app, userId: actor.userId },
          a.collection,
          a.id,
          a.data,
        ),
      )
      return { id: doc.id, version: doc.version }
    },
  ),

  /**
   * An app builder draft from one of its templates, through the drafts service
   * the agent's apps_build_create calls, as `createdBy` (default: the org's admin).
   */
  "apps.builderDraft": factory(
    zod.object({
      baseName: zod.string().min(2),
      title: zod.string().min(1),
      template: zod.enum(DRAFT_TEMPLATES).optional(),
      createdBy: uuid.optional(),
    }),
    async (ctx, a) => {
      const actor = await actorFor(ctx, a.createdBy ?? (await orgAdmin(ctx.orgId)).id)
      const appName = draftAppName(ctx.orgId, a.baseName)
      const { draft, version } = await withRlsContext(actor, (tx) =>
        createDraft(
          tx,
          { orgId: ctx.orgId, userId: actor.userId },
          {
            baseName: a.baseName,
            title: a.title,
            files: templateFiles(a.template ?? "store-crud", appName, a.title),
          },
        ),
      )
      return { id: draft.id, appName, n: version.n }
    },
  ),

  /**
   * One key of an app's org config (`kernel.apps.config`), through the writer
   * `liaison config apply` and the admin config route use, as the system.
   */
  "apps.configKey": factory(
    zod.object({ appName: zod.string().min(1), key: zod.string().min(1), value: zod.unknown() }),
    (ctx, a) =>
      writeAppConfigKey({
        orgId: ctx.orgId,
        appName: a.appName,
        key: a.key,
        value: a.value ?? null,
        actorId: null,
        actorType: "system",
        source: "config-apply",
      }),
  ),

  /** A mailbox inbox at an address, on `connectedAccountId` (default a placeholder account). */
  "tickets.inbox": factory(
    zod.object({
      name: zod.string().min(1),
      emailAddress: zod.string().min(3),
      isDefault: zod.boolean().optional(),
      /** With `isDefault`: take the flag over from the org's current default. */
      replaceDefault: zod.boolean().optional(),
      /** Who makes it the default in an org with no admin of its own (default: the org's admin). */
      actingUserId: uuid.optional(),
      key: zod.string().optional(),
      connectedAccountId: uuid.optional(),
      defaultTeam: zod.string().min(1).nullish(),
      defaultSensitivity: zod.enum(["internal", "confidential", "restricted"]).optional(),
      fromDisplayName: zod.string().min(1).nullish(),
    }),
    async (ctx, a, call) =>
      ensureTicketMailboxInbox(ctx, {
        key: a.key ?? call.key,
        name: a.name,
        emailAddress: a.emailAddress,
        connectedAccountId: a.connectedAccountId,
        defaultTeam: a.defaultTeam,
        defaultSensitivity: a.defaultSensitivity,
        fromDisplayName: a.fromDisplayName,
        ...(a.isDefault
          ? {
              isDefault: {
                adminUserId: a.actingUserId ?? (await orgAdmin(ctx.orgId)).id,
                replace: a.replaceDefault === true,
              },
            }
          : {}),
      }),
  ),

  /**
   * A customer's ticket, with their first message unless `withInboundMessage: false`;
   * `createdMinutesAgo` backdates it with its SLA clock, `firstResponseMinutesAgo`
   * marks it answered, `followup` snoozes it (an `at` in the past: a snooze come due).
   * `actingUserId`: who the services act for in an org with no admin of its own
   * (default: the org's admin).
   */
  "tickets.ticket": factory(
    zod.object({
      sensitivity: zod.enum(["internal", "confidential", "restricted"]).optional(),
      followup: zod.object({ at: zod.string().datetime(), reason: zod.string().min(1) }).optional(),
      actingUserId: uuid.optional(),
      subject: zod.string(),
      status: zod.enum(["open", "awaiting_customer", "awaiting_followup", "closed"]).optional(),
      priority: zod.enum(["low", "normal", "high", "urgent"]).optional(),
      closedReason: zod.enum(["resolved", "merged", "spam", "duplicate", "no_response"]).optional(),
      sourceInboxId: uuid.nullish(),
      contactId: uuid.nullish(),
      externalRef: zod.string().nullish(),
      mergedIntoTicketId: uuid.nullish(),
      withInboundMessage: zod.boolean().optional(),
      team: zod.string().min(1).nullish(),
      assignedTo: uuid.nullish(),
      createdMinutesAgo: zod.number().min(0).optional(),
      firstResponseMinutesAgo: zod.number().min(0).optional(),
    }),
    async (ctx, { actingUserId, ...a }, call) => {
      const adminUserId = actingUserId ?? (await orgAdmin(ctx.orgId)).id
      return createOneTicket(ctx, { ...a, key: call.key, adminUserId })
    },
  ),

  /**
   * Time passing on a ticket (history): its SLA deadline or its follow-up time
   * set to this many seconds from now, negative for the past.
   */
  "tickets.clock": factory(
    zod.object({
      ticketId: uuid,
      slaDeadlineInSeconds: zod.number().optional(),
      followupInSeconds: zod.number().optional(),
    }),
    (ctx, a) => shiftTicketClock(ctx, a),
  ),

  /** Later messages on a ticket (history), oldest first. */
  "tickets.messages": factory(
    zod.object({
      ticketId: uuid,
      actingUserId: uuid.optional(),
      messages: zod
        .array(
          zod.object({
            kind: zod.enum(["inbound", "outbound", "note"]),
            textBody: zod.string(),
            htmlBody: zod.string().nullish(),
            fromEmail: zod.string().nullish(),
            fromName: zod.string().nullish(),
            subject: zod.string().nullish(),
            sentAtOffsetSeconds: zod.number().optional(),
          }),
        )
        .min(1),
    }),
    async (ctx, a, call) => {
      const adminUserId = a.actingUserId ?? (await orgAdmin(ctx.orgId)).id
      return appendTicketMessages(ctx, {
        key: call.key,
        ticketId: a.ticketId,
        adminUserId,
        messages: a.messages,
      })
    },
  ),

  /**
   * Recompute the org's stored app attention lists now (every app provider, or
   * `apps`), stored before the call returns: what the attention minute tick
   * queues, run in place, for a test that reads the feed right after seeding.
   */
  "attention.refresh": factory(
    zod.object({ apps: zod.array(zod.string().min(1)).optional() }),
    (ctx, a) => refreshStoredAppAttention(ctx.orgId, a.apps),
  ),

  /** Close these tickets through the state machine (those a person's feed shows, say). */
  "tickets.close": factory(
    zod.object({
      ticketIds: zod.array(uuid).min(1),
      closedReason: zod.enum(["resolved", "spam", "duplicate", "no_response"]).default("resolved"),
    }),
    async (ctx, a) => {
      const admin = await orgAdmin(ctx.orgId)
      return closeTickets(ctx, { adminUserId: admin.id, ...a })
    },
  ),

  /** A tickets API key, created by `createdBy` (default: the org's admin). */
  "tickets.apiKey": factory(
    zod.object({
      label: zod.string().min(1),
      createdBy: uuid.optional(),
      inboxId: uuid.nullish(),
      allowedOrigins: zod.array(zod.string().min(1)).optional(),
      revoked: zod.boolean().optional(),
    }),
    async (ctx, { createdBy, ...a }) => {
      const userId = createdBy ?? (await orgAdmin(ctx.orgId)).id
      return createTicketApiKey(ctx, { userId, ...a })
    },
  ),

  /** One subscription customer of an issuer: its contact and billing address, a paid invoice and the active monthly schedule continuing it. */
  "invoicing.monthEndClient": factory(
    zod.object({
      issuerId: uuid,
      previousDocumentId: uuid,
      scheduleKey: zod.string().min(1),
      name: zod.string().min(1),
      street: zod.string().min(1),
      postalCode: zod.string().min(1),
      city: zod.string().min(1),
      email: zod.string().min(3),
      priceMinor: zod.number().int().positive(),
      taxRateBp: zod.number().int().min(0),
      nextIssueOn: zod.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      nextDraftOn: zod.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      createdBy: zod.string().min(1),
    }),
    (ctx, a) => seedMonthEndClient(ctx, a),
  ),
}
