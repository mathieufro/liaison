// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Kernel-admin agent tools. Governance reads (roles_list / users_list /
// audit_search / approvals_list) and gated writes (invite_user / assign_role).
// Every handler re-resolves effective permissions via `resolveActor` (the
// APPROVER's for an approved call, else the caller's) and runs under
// `withRlsContext` so the actor used for RLS + the escalation guards is a real
// persisted scope set, never a fabricated `["*"]`. The agent can never grant
// beyond the approving human. Attribution follows the same rule: every event
// and audit `actorId` written here is that actor (`actor.userId`), the identity
// whose scopes acted; the requester stays on the approval row.

import type {
  ApprovalEditableField,
  ApprovalLastFailure,
  ApprovalRequestStatus,
  ApprovalSummary,
} from "@liaison/shared"
import { and, eq, isNull } from "drizzle-orm"
import { HTTPException } from "hono/http-exception"
import type { RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import {
  invitations as invitationsTable,
  roles as rolesTable,
  userRoles as userRolesTable,
  users as usersTable,
} from "~/db/schema/kernel"
import { type OrgConfigToolCtx, resolveActor } from "~/modules/agent/tools/org-config-tools"
import { splitToolName } from "~/modules/approvals/event-data"
import { listApprovals } from "~/modules/approvals/list"
import { queryAuditLogPage } from "~/modules/audit/service"
import { getDimensionCatalog } from "~/modules/permissions/dimension-catalog"
import { hasScope } from "~/modules/permissions/permissions"
import {
  assignRole,
  deleteRole,
  getRoleDetail,
  grantScope,
  grantUserDimension,
  grantUserScope,
  listRoles,
  revokeScope,
  revokeUserScope,
  unassignRole,
  updateRole,
} from "~/modules/permissions/roles"
import { getScopeCatalog, type ScopeCatalogEntry } from "~/modules/permissions/scope-catalog"
import type { PermissionMutationContext } from "~/modules/permissions/types"
import { awayOf, readWhoIsAway } from "~/modules/users/away-today"
import { createInvitation } from "~/modules/users/invites"
import { getUserDetail, listUsers } from "~/modules/users/service"

// --- Reads -----------------------------------------------------------------

export async function handleRolesList(
  params: { limit?: number; offset?: number },
  ctx: OrgConfigToolCtx,
): Promise<{ roles: Awaited<ReturnType<typeof listRoles>> }> {
  const actor = await resolveActor(ctx)
  const roles = await withRlsContext(actor, (tx) =>
    listRoles(tx, ctx.orgId, { limit: params.limit, offset: params.offset }),
  )
  return { roles }
}

// Read ONE role's FULL detail — its exact scope STRINGS (not just the count roles_list gives),
// dimension grants, and assigned members. This is the role-side counterpart to describe_user_access
// (which reads a USER's effective scopes): the agent calls it to SEE a role's current scopes before
// editing them with edit_role, or to answer "exactly which scopes does the <role> role grant". Returns
// ROLE_NOT_FOUND (never a fabricated scope list) when the id does not resolve in the caller's org.
export async function handleGetRole(
  params: { roleId: string },
  ctx: OrgConfigToolCtx,
): Promise<
  { role: NonNullable<Awaited<ReturnType<typeof getRoleDetail>>> } | { error: { code: string } }
> {
  const actor = await resolveActor(ctx)
  const role = await withRlsContext(actor, (tx) =>
    getRoleDetail(tx, { orgId: ctx.orgId, roleId: params.roleId }),
  )
  if (!role) return { error: { code: "ROLE_NOT_FOUND" } }
  return { role }
}

export async function handleUsersList(
  params: { limit?: number; offset?: number },
  ctx: OrgConfigToolCtx,
): Promise<{
  users: Array<{
    id: string
    name: string
    email: string
    roles: unknown
    away: { until: string | null } | null
  }>
}> {
  const actor = await resolveActor(ctx)
  const limit = Math.min(params.limit ?? 50, 100)
  const offset = params.offset ?? 0
  const page = Math.floor(offset / limit) + 1
  // Who is away today, as Home reads it, in the same transaction: until when, no source, no reason.
  const { result, away } = await withRlsContext(actor, async (tx) => ({
    result: await listUsers(tx, { orgId: ctx.orgId, page, limit }),
    away: await readWhoIsAway(tx, ctx.orgId),
  }))
  return {
    users: result.rows.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      roles: u.roles,
      away: awayOf(away, u.id),
    })),
  }
}

// Read ONE teammate's RESOLVED effective access: their role memberships, the full set of effective
// scope STRINGS (each tagged with provenance — `fromRoles` for role-inherited, `direct:true` for a
// per-user grant), and any dimension grants. This is the DIAGNOSIS counterpart to the FIX tools
// (grant_user_scope / assign_role): it lets the agent VERIFY exactly which scope a named teammate is
// missing — instead of merely hypothesizing — before granting it. It is the only place that returns a
// specific person's exact scope strings (roles_list gives only per-role COUNTS, never the strings).
// Read-only, RLS-scoped to the caller's org. Returns `null` user → USER_NOT_FOUND so the agent does
// not fabricate a scope set for a person it could not resolve.
//
// `checkScopes` — the DETERMINISTIC SoD-audit lever (founder-day chaos journey S9 root). A who-can-issue-vs-
// who-can-approve audit needs a YES/NO per user for a couple of DECISION scopes (e.g.
// `shopify:refunds:create`, `shopify:approve`), but a power-user's `effectiveScopes` can be 40–60+
// strings, and a long array gets visually summarized/truncated in the agent's view (`…(+34 more)`) —
// so the decision scope may be off-screen and the agent ends up GUESSING (the over-certainty fabrication
// the SoD audit must avoid). When the caller passes `checkScopes: [<scope>, …]`, we compute a
// `scopeChecks` map SERVER-SIDE — for each requested scope, whether this user effectively HOLDS it (via
// the same hierarchical `hasScope` semantics the engine enforces: an exact grant, a `*` wildcard, or a
// covering parent like `shopify:refunds` granting `shopify:refunds:create`), plus the provenance (which
// role(s) / a direct grant) when held. This is an EXACT, untruncatable, decision-grade answer the agent
// reads directly instead of scanning the array — closing the "couldn't read the two decision scopes"
// gap at the source. The full `effectiveScopes` list is still returned (unchanged) for diagnosis; the
// checks are an additive, deterministic projection over it.
interface ScopeCheck {
  held: boolean
  via: "exact" | "wildcard" | "parent" | null
  fromRoles: string[]
  direct: boolean
  /** Held by every active member (kernel or an installed app's every-member scopes). */
  everyMember: boolean
  /** Held through an org MCP server this person may use. */
  mcpAccess: boolean
}

export async function handleDescribeUserAccess(
  params: { userId: string; checkScopes?: string[] },
  ctx: OrgConfigToolCtx,
): Promise<
  | {
      user: { id: string; name: string; email: string; status: string }
      roles: Array<{ id: string; name: string; description: string | null }>
      effectiveScopes: Array<{
        scope: string
        fromRoles: string[]
        direct: boolean
        everyMember: boolean
        mcpAccess: boolean
      }>
      scopeChecks?: Record<string, ScopeCheck>
      deniedApps: string[]
      dimensions: Record<
        string,
        {
          direct: string[]
          inherited: Array<{ roleId: string; roleName: string; values: string[] }>
        }
      >
    }
  | { error: { code: "USER_NOT_FOUND" } }
> {
  const actor = await resolveActor(ctx)
  const detail = await withRlsContext(actor, (tx) =>
    getUserDetail(tx, { orgId: ctx.orgId, userId: params.userId }),
  )
  if (!detail) return { error: { code: "USER_NOT_FOUND" } }

  // DETERMINISTIC per-scope check over the user's full effective scope set (never the truncated view).
  let scopeChecks: Record<string, ScopeCheck> | undefined
  if (params.checkScopes && params.checkScopes.length > 0) {
    const grantedStrings = detail.effectiveScopes.map((s) => s.scope)
    scopeChecks = {}
    for (const required of params.checkScopes) {
      const held = hasScope(required, grantedStrings)
      // Classify HOW it is held + its provenance, so the audit can cite a grounded reason (not a guess).
      const exact = detail.effectiveScopes.find((s) => s.scope === required)
      let via: "exact" | "wildcard" | "parent" | null = null
      let source: (typeof detail.effectiveScopes)[number] | undefined
      if (held) {
        if (exact) {
          via = "exact"
          source = exact
        } else {
          // Held via a covering grant: find the wildcard/parent entry that satisfies it (for provenance).
          source = detail.effectiveScopes.find((s) => hasScope(required, [s.scope]))
          via = source?.scope.includes("*") ? "wildcard" : "parent"
        }
      }
      scopeChecks[required] = {
        held,
        via,
        fromRoles: source?.fromRoles ?? [],
        direct: source?.direct ?? false,
        everyMember: source?.everyMember ?? false,
        mcpAccess: source?.mcpAccess ?? false,
      }
    }
  }

  return {
    user: { id: detail.id, name: detail.name, email: detail.email, status: detail.status },
    roles: detail.roles,
    effectiveScopes: detail.effectiveScopes,
    ...(scopeChecks ? { scopeChecks } : {}),
    deniedApps: detail.deniedApps,
    dimensions: detail.dimensions,
  }
}

export async function handleAuditSearch(
  params: { action?: string; agentId?: string; since?: string; until?: string; limit?: number },
  ctx: OrgConfigToolCtx,
): Promise<{
  entries: Array<{
    action: string
    approverUserId: string | null
    actorId: string | null
    at: string
    entityId: string | null
    app: string | null
  }>
}> {
  const actor = await resolveActor(ctx)
  const page = await withRlsContext(actor, (tx) =>
    queryAuditLogPage(tx, ctx.orgId, {
      // Agent governance reads pass a keyword ('refund'), not the exact internal
      // action string — match as a substring so it cuts through a high-volume log.
      actionContains: params.action,
      // The acting agent, independent of the human who triggered the turn.
      agentId: params.agentId,
      from: params.since,
      to: params.until,
      limit: params.limit ?? 50,
    }),
  )
  // Project the approver (recorded in `metadata.approverUserId` on gated
  // actions) — the whole point of a "who approved X" audit is meaningless if
  // dropped. `metadata` is free-form jsonb; read the key defensively.
  return {
    entries: page.entries.map((e) => {
      const meta = (e.metadata ?? {}) as Record<string, unknown>
      const approver = meta.approverUserId
      return {
        action: e.action,
        approverUserId: typeof approver === "string" ? approver : null,
        actorId: e.actorId,
        at: new Date(e.timestamp).toISOString(),
        entityId: e.entityId,
        app: e.app,
      }
    }),
  }
}

/** Where a pending request with a failed attempt stands, said by the result itself. */
const RETRYABLE_FAILURE_STATE =
  "It was approved and its call was attempted, but the call failed, so it is waiting for a decision again. Approving it again makes the same call."

export async function handleApprovalsList(
  params: { status?: string; sort?: "oldest" | "newest" },
  ctx: OrgConfigToolCtx,
): Promise<{
  // The AUTHORITATIVE count of the caller's pending decidable queue — the exact
  // length of `approvals`, surfaced as its own field so an agent that fanned out
  // N gated writes can report the REAL number queued by reading `total` here
  // rather than trusting a self-tallied count of its own tool calls (which a weak
  // model over-counts, e.g. counting a sub-run that produced no approval). This
  // list is NOT paginated or truncated — `total === approvals.length` always.
  total: number
  approvals: Array<{
    id: string
    /** The `request-N` label the approval card and feed print. Cite THIS to
     *  the user (it is the reference they can see and search); the uuid `id`
     *  is for tool calls (approval_update_payload, approval_status). */
    handle: string
    app: string
    toolName: string
    summary: unknown
    /** Who asked, by name (modules/approvals/requester.ts): the role or
     *  system agent that raised it, else the person. Never an id: an agent
     *  handed a user id reported the routine's owner as the requester. */
    requester: string
    ageDays: number
    // The fields a human approver may CORRECT on the pending request before
    // deciding it (the tool's editableFields registry) + the request's current
    // payload, so the agent can surface "this NET-30 due date can be edited to
    // NET-60 on the pending request via approval_update_payload" rather than
    // guessing whether terms are editable. Empty list ⇒ nothing is editable.
    editableFields: ApprovalEditableField[]
    currentPayload: unknown
    /** Someone approved it, its call failed, and it came back to the queue. Only
     *  present then. Without it the row read as a request nobody had decided. */
    lastFailure?: ApprovalLastFailure & { state: string }
  }>
  /** Requests decided in the last 24 h that this user may see, newest decision
   *  first, kept apart from the pending queue and never counted in `total`. A
   *  request leaves `approvals` the moment it is decided; without this list a
   *  "was it done?" right after a denial had nothing to answer from. */
  recentlyDecided: Array<{
    id: string
    handle: string
    app: string
    toolName: string
    summary: unknown
    requester: string
    status: ApprovalRequestStatus
    decidedAt: string | null
    /** The decider by name; null when nobody decided (expired). */
    decidedBy: string | null
    reason: string | null
    /** The call's failure, when it was approved and failed. */
    lastFailure?: ApprovalLastFailure
  }>
}> {
  const actor = await resolveActor(ctx)
  // `listApprovals` returns the caller's decidable pending queue (notify-set
  // membership + `<app>:approve` scope), RLS-scoped to the org; the
  // recently-decided read applies the same visibility rule.
  const [rows, decidedRows] = await withRlsContext(actor, async (tx) => [
    await listApprovals(tx, { orgId: ctx.orgId, userId: ctx.userId, scopes: actor.scopes }),
    await listApprovals(tx, {
      orgId: ctx.orgId,
      userId: ctx.userId,
      scopes: actor.scopes,
      recentlyDecided: true,
    }),
  ])
  const now = Date.now()
  const projected = rows.map((r) => ({
    id: r.id,
    handle: r.handle,
    app: splitToolName(r.toolName).appName,
    toolName: r.toolName,
    summary: r.summary,
    requester: r.requester?.name ?? "Unknown",
    ageDays: Math.floor((now - new Date(r.createdAt).getTime()) / 86_400_000),
    editableFields: r.editableFields,
    currentPayload: r.currentPayload,
    ...(r.lastFailure ? { lastFailure: { ...r.lastFailure, state: RETRYABLE_FAILURE_STATE } } : {}),
  }))
  // Oldest-first by default (the "what's been waiting longest" governance ask).
  projected.sort((a, b) =>
    params.sort === "newest" ? a.ageDays - b.ageDays : b.ageDays - a.ageDays,
  )
  const recentlyDecided = decidedRows.map((r) => ({
    id: r.id,
    handle: r.handle,
    app: splitToolName(r.toolName).appName,
    toolName: r.toolName,
    summary: r.summary,
    requester: r.requester?.name ?? "Unknown",
    status: r.status,
    decidedAt: r.decidedAt ?? null,
    decidedBy: r.decidedByName ?? null,
    reason: r.reason ?? null,
    ...(r.lastFailure ? { lastFailure: r.lastFailure } : {}),
  }))
  return { total: projected.length, approvals: projected, recentlyDecided }
}

// --- Gated writes ----------------------------------------------------------

export async function handleInviteUser(
  params: { email: string; roleId?: string; roleName?: string },
  ctx: OrgConfigToolCtx,
): Promise<{ inviteUrl: string } | { error: { code: string; message?: string } }> {
  const actor = await resolveActor(ctx)
  return withRlsContext(actor, async (tx) => {
    const r = await createInvitation(tx, {
      orgId: ctx.orgId,
      email: params.email,
      roleId: params.roleId,
      roleName: params.roleName,
      invitedBy: actor.userId,
      actorScopes: actor.scopes,
      actorDimensionGrants: actor.dimensionGrants,
    })
    if (r === null) {
      // Distinguish "you named/identified no role at all" from "the role you named does not exist"
      // so the agent's retry is grounded — both are real failures, never silently swallowed.
      const ref = params.roleId
        ? `role id ${params.roleId}`
        : params.roleName
          ? `role named "${params.roleName}"`
          : "no role (pass roleName or roleId)"
      return { error: { code: "NOT_FOUND", message: `${ref} not found` } }
    }
    if ("error" in r) return { error: { code: r.error } } // USER_EXISTS | SCOPE_ESCALATION | INVITE_PENDING
    return { inviteUrl: r.inviteUrl }
  })
}

export async function handleAssignRole(
  params: { userId: string; roleId: string },
  ctx: OrgConfigToolCtx,
): Promise<{ assigned: true } | { error: { code: string } }> {
  const actor = await resolveActor(ctx)
  return withRlsContext(actor, async (tx) => {
    const r = await assignRole(tx, {
      orgId: ctx.orgId,
      userId: params.userId,
      roleId: params.roleId,
      actorId: actor.userId,
      requestedBy: ctx.userId,
      actorScopes: actor.scopes as PermissionMutationContext["actorScopes"],
      actorDimensionGrants: actor.dimensionGrants,
    })
    if (r === null) return { error: { code: "NOT_FOUND" } }
    if ("error" in r && r.error) return { error: { code: r.error } } // SCOPE_ESCALATION | DIMENSION_ESCALATION
    // { assigned: true } or { assigned: false } (idempotent re-assign) — both
    // are non-errors; surface success.
    return { assigned: true }
  })
}

// Remove a team member FROM a role they currently hold — the symmetric complement
// to assign_role (which grants a role). Wraps unassignRole under the approver's RLS,
// so the symmetric escalation guard (you cannot unassign a role whose scopes/dimension
// grants you do not yourself hold) runs against the approving human. `removed:false`
// is the idempotent no-op when the member did not hold that role (not an error).
// NOTE: this strips ROLE-inherited scopes; direct per-user scope grants are removed
// via grant_user_scope's `revoke`, and deactivating the account itself is an admin
// Settings action with no agent tool.
export async function handleRemoveRole(
  params: { userId: string; roleId: string },
  ctx: OrgConfigToolCtx,
): Promise<{ removed: boolean } | { error: { code: string } }> {
  const actor = await resolveActor(ctx)
  return withRlsContext(actor, async (tx) => {
    const r = await unassignRole(tx, {
      orgId: ctx.orgId,
      userId: params.userId,
      roleId: params.roleId,
      actorId: actor.userId,
      requestedBy: ctx.userId,
      actorScopes: actor.scopes as PermissionMutationContext["actorScopes"],
      actorDimensionGrants: actor.dimensionGrants,
    })
    if (r && "error" in r && r.error) return { error: { code: r.error } } // SCOPE_ESCALATION | DIMENSION_ESCALATION
    // unassignRole returns the deleted { userId } row, or null when the member did
    // not hold that role (idempotent no-op). Both are non-errors; map to removed.
    return { removed: r !== null && !("error" in r) }
  })
}

// List the org's defined data-partitioning DIMENSIONS (the catalog: key, type, allowed values,
// label, and the Settings page that manages each). Read-only. The agent calls this BEFORE
// grant_dimension_value to confirm a dimension exists — partitioning by an attribute that is NOT
// in this list requires DEFINING it in Settings first (no agent create-dimension tool).
export async function handleListDimensions(
  _params: Record<string, unknown>,
  ctx: OrgConfigToolCtx,
): Promise<{ dimensions: ReturnType<typeof getDimensionCatalog> }> {
  return { dimensions: getDimensionCatalog(ctx.orgId) }
}

// List the org's full SCOPE CATALOG — every grantable permission (kernel + every installed app),
// each as {scope, app, description}. Read-only. This is the universe of permissions the agent can
// reason over when mapping a natural-language access request ("she runs customer success") to a
// concrete scope set for create_role / grant_user_scope. Optional `app` narrows to one app's scopes
// so a big catalog stays legible. The catalog is org-scoped (never reveals another org's app scopes).
export async function handleListScopes(
  params: { app?: string },
  ctx: OrgConfigToolCtx,
): Promise<{ scopes: ScopeCatalogEntry[] }> {
  const all = getScopeCatalog(ctx.orgId)
  return { scopes: params.app ? all.filter((s) => s.app === params.app) : all }
}

// Grant a user one or more VALUES for an existing data-partitioning dimension (e.g.
// territory=US). Wraps grantUserDimension under the approver's RLS, so the escalation guard
// (you cannot grant a value you don't hold) runs against the approver. Defining a NEW dimension
// is NOT possible here — dimensions are declared in the app manifest / admin dimension-catalog;
// an unknown dimension returns INVALID_DIMENSION so the agent learns to route the definition to
// Settings rather than fabricating one.
export async function handleGrantDimensionValue(
  params: { userId: string; dimension: string; values: string[] },
  ctx: OrgConfigToolCtx,
): Promise<{ granted: true } | { error: { code: string; message?: string } }> {
  const actor = await resolveActor(ctx)
  try {
    return await withRlsContext(actor, async (tx) => {
      const r = await grantUserDimension(tx, {
        orgId: ctx.orgId,
        userId: params.userId,
        dimension: params.dimension,
        values: params.values,
        actorId: actor.userId,
        requestedBy: ctx.userId,
        actorScopes: actor.scopes as PermissionMutationContext["actorScopes"],
        actorDimensionGrants: actor.dimensionGrants,
      })
      if (r === null) return { error: { code: "USER_NOT_FOUND" } }
      return { granted: true as const }
    })
  } catch (e) {
    if (e instanceof HTTPException) {
      // 403 = dimension-escalation (granting a value you don't hold); 400 = unknown dimension,
      // wildcard, or an invalid value for the dimension's type.
      const code = e.status === 403 ? "DIMENSION_ESCALATION" : "INVALID_DIMENSION"
      return { error: { code, message: e.message } }
    }
    throw e
  }
}

// --- Gated-tool approval summarizers ---------------------------------------

async function roleName(tx: RlsClient, roleId: string): Promise<string> {
  const [r] = await tx
    .select({ name: rolesTable.name })
    .from(rolesTable)
    .where(eq(rolesTable.id, roleId))
    .limit(1)
  return r?.name ?? roleId
}

export async function summarizeInviteUser(
  params: unknown,
  ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  const p = params as { email?: string; roleId?: string; roleName?: string }
  // Prefer the resolved DB name when an id is given; otherwise show the role NAME the agent named
  // (the role may not exist yet — it is being created in the same flow — so we cannot look it up).
  const name = p.roleId ? await roleName(ctx.tx, p.roleId) : (p.roleName ?? "(no role)")
  return {
    kind: "invite_user",
    title: `Invite ${p.email ?? ""} as ${name}`,
    lines: [`A new team member will be invited by email and granted the "${name}" role.`],
  }
}

export async function summarizeAssignRole(
  params: unknown,
  ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  const p = params as { userId?: string; roleId?: string }
  const name = p.roleId ? await roleName(ctx.tx, p.roleId) : "(no role)"
  let userEmail = p.userId ?? ""
  if (p.userId) {
    const [u] = await ctx.tx
      .select({ email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.id, p.userId))
      .limit(1)
    if (u) userEmail = u.email
  }
  return {
    kind: "assign_role",
    title: `Assign ${userEmail} to ${name}`,
    lines: [`Grants this member every scope the "${name}" role holds.`],
  }
}

export async function summarizeRemoveRole(
  params: unknown,
  ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  const p = params as { userId?: string; roleId?: string }
  const name = p.roleId ? await roleName(ctx.tx, p.roleId) : "(no role)"
  let userEmail = p.userId ?? ""
  if (p.userId) {
    const [u] = await ctx.tx
      .select({ email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.id, p.userId))
      .limit(1)
    if (u) userEmail = u.email
  }
  return {
    kind: "remove_user_from_role",
    title: `Remove ${userEmail} from ${name}`,
    lines: [
      `Strips every scope this member inherited from the "${name}" role.`,
      `This does NOT deactivate their account — closing the account is an admin action in Settings > Members.`,
    ],
  }
}

export async function summarizeGrantDimensionValue(
  params: unknown,
  ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  const p = params as { userId?: string; dimension?: string; values?: string[] }
  let userEmail = p.userId ?? ""
  if (p.userId) {
    const [u] = await ctx.tx
      .select({ email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.id, p.userId))
      .limit(1)
    if (u) userEmail = u.email
  }
  const vals = (p.values ?? []).join(", ")
  return {
    kind: "grant_dimension_value",
    title: `Grant ${userEmail}: ${p.dimension ?? "(dimension)"} = ${vals}`,
    lines: [
      `Sets this member's "${p.dimension ?? ""}" dimension to: ${vals}.`,
      `Data rows outside these values become silently invisible to them (row-level dimension filtering) — this restricts, not expands, what they can see.`,
    ],
  }
}

export async function summarizeCreateRole(
  params: unknown,
  _ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  const p = params as { name?: string; description?: string; scopes?: string[] }
  const scopes = p.scopes ?? []
  return {
    kind: "create_role",
    title: `Create role "${p.name ?? ""}"${
      scopes.length ? ` (${scopes.length} scope${scopes.length === 1 ? "" : "s"})` : ""
    }`,
    lines: [
      p.description ? p.description : `A new org role "${p.name ?? ""}" will be created.`,
      scopes.length
        ? `Grants exactly these scopes — and nothing else:`
        : `Grants NO scopes (an empty role that authorizes nothing).`,
      ...scopes.map((s) => `• ${s}`),
      `Anyone later assigned this role inherits every scope listed above.`,
    ],
  }
}

// --- Per-user granular scope grant/revoke (gated) --------------------------
//
// Direct user-level scope edits — the granular complement to assign_role (whole
// preset bundle). Wraps grantUserScope / revokeUserScope under the approver's
// RLS, so the symmetric-authorization guard (you cannot grant a scope you do not
// hold) runs against the approving human. Use for fine-tuning one person's
// permissions ("give July refunds:create on top of her CS role") without minting
// a new role. Granting a scope already held — or revoking one not directly
// granted — is an idempotent no-op (revoke does NOT strip scopes inherited from a
// role; remove the role for that).
export async function handleSetUserScope(
  params: { userId: string; grant?: string[]; revoke?: string[] },
  ctx: OrgConfigToolCtx,
): Promise<
  { granted: string[]; revoked: string[] } | { error: { code: string; message?: string } }
> {
  const actor = await resolveActor(ctx)
  const grant = params.grant ?? []
  const revoke = params.revoke ?? []
  // Shared with the stage-time preflight (setUserScopePreflight) so the two can never drift.
  const noOp = setUserScopeNoOpRefusal(params)
  if (noOp) return { error: noOp }
  try {
    return await withRlsContext(actor, async (tx) => {
      const target = await tx
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(eq(usersTable.id, params.userId))
        .limit(1)
      if (target.length === 0) return { error: { code: "USER_NOT_FOUND" } }
      for (const scope of grant) {
        await grantUserScope(tx, {
          orgId: ctx.orgId,
          userId: params.userId,
          scope,
          actorId: actor.userId,
          requestedBy: ctx.userId,
          actorScopes: actor.scopes as PermissionMutationContext["actorScopes"],
          actorDimensionGrants: actor.dimensionGrants,
        })
      }
      for (const scope of revoke) {
        await revokeUserScope(tx, {
          orgId: ctx.orgId,
          userId: params.userId,
          scope,
          actorId: actor.userId,
          requestedBy: ctx.userId,
          actorScopes: actor.scopes as PermissionMutationContext["actorScopes"],
          actorDimensionGrants: actor.dimensionGrants,
        })
      }
      return { granted: grant, revoked: revoke }
    })
  } catch (e) {
    if (e instanceof HTTPException) {
      // 403 = scope-escalation (granting a scope you don't hold yourself).
      const code = e.status === 403 ? "SCOPE_ESCALATION" : "INVALID_SCOPE"
      return { error: { code, message: e.message } }
    }
    throw e
  }
}

export async function summarizeSetUserScope(
  params: unknown,
  ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  const p = params as { userId?: string; grant?: string[]; revoke?: string[] }
  let userEmail = p.userId ?? ""
  if (p.userId) {
    const [u] = await ctx.tx
      .select({ email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.id, p.userId))
      .limit(1)
    if (u) userEmail = u.email
  }
  const grant = p.grant ?? []
  const revoke = p.revoke ?? []
  const parts: string[] = []
  if (grant.length) parts.push(`+${grant.length}`)
  if (revoke.length) parts.push(`-${revoke.length}`)
  return {
    kind: "grant_user_scope",
    title: `Edit ${userEmail}'s scopes (${parts.join(" ") || "no change"})`,
    lines: [
      ...(grant.length
        ? [`GRANT these scopes directly to this member:`, ...grant.map((s) => `• +${s}`)]
        : []),
      ...(revoke.length
        ? [`REVOKE these directly-granted scopes:`, ...revoke.map((s) => `• −${s}`)]
        : []),
      `Direct user grants stack on top of role-inherited scopes; a revoke only removes a DIRECT grant, never a scope the member holds via a role.`,
    ],
  }
}

// --- Edit an EXISTING role (rename / re-describe / add + remove scopes) (gated) ---
//
// The role-level complement to grant_user_scope (which edits ONE person). Wraps
// updateRole + grantScope/revokeScope under the approver's RLS inside a single
// transaction (withRlsContext), so the escalation guard (you cannot grant/revoke
// a scope you do not hold yourself) runs against the approving human and a
// mid-batch escalation rolls back the whole edit — no partial application. This
// is the tool that "strengthens" a role: e.g. add every `<app>:approve` scope to
// an existing role so its members can approve gated actions across apps.
//
// Renaming a system-managed role is refused by updateRole (it would orphan the
// row on the next app sync); scope + description edits on such roles are allowed.
export async function handleEditRole(
  params: {
    roleId: string
    name?: string
    description?: string
    grantScopes?: string[]
    revokeScopes?: string[]
  },
  ctx: OrgConfigToolCtx,
): Promise<
  | { roleId: string; name: string; description: string | null; scopes: string[] }
  | { error: { code: string; message?: string } }
> {
  const actor = await resolveActor(ctx)
  const grant = params.grantScopes ?? []
  const revoke = params.revokeScopes ?? []
  const editsMeta = params.name !== undefined || params.description !== undefined
  // Shared with the stage-time preflight (editRolePreflight) so the two can never drift.
  const noOp = editRoleNoOpRefusal(params)
  if (noOp) return { error: noOp }
  try {
    return await withRlsContext(actor, async (tx) => {
      // Resolve the role in the caller's org first, so a bad id is a clean
      // ROLE_NOT_FOUND rather than a silent no-op after partial work.
      const existing = await getRoleDetail(tx, { orgId: ctx.orgId, roleId: params.roleId })
      if (!existing) return { error: { code: "ROLE_NOT_FOUND" } }

      if (editsMeta) {
        const updated = await updateRole(tx, {
          roleId: params.roleId,
          orgId: ctx.orgId,
          name: params.name,
          description: params.description,
          actorId: actor.userId,
          requestedBy: ctx.userId,
          actorScopes: actor.scopes as PermissionMutationContext["actorScopes"],
          actorDimensionGrants: actor.dimensionGrants,
        })
        if (updated === null) return { error: { code: "ROLE_NOT_FOUND" } }
      }
      for (const scope of grant) {
        await grantScope(tx, {
          roleId: params.roleId,
          orgId: ctx.orgId,
          scope,
          actorId: actor.userId,
          requestedBy: ctx.userId,
          actorScopes: actor.scopes as PermissionMutationContext["actorScopes"],
          actorDimensionGrants: actor.dimensionGrants,
        })
      }
      for (const scope of revoke) {
        await revokeScope(tx, {
          roleId: params.roleId,
          orgId: ctx.orgId,
          scope,
          actorId: actor.userId,
          requestedBy: ctx.userId,
          actorScopes: actor.scopes as PermissionMutationContext["actorScopes"],
          actorDimensionGrants: actor.dimensionGrants,
        })
      }
      const after = await getRoleDetail(tx, { orgId: ctx.orgId, roleId: params.roleId })
      if (!after) return { error: { code: "ROLE_NOT_FOUND" } }
      return {
        roleId: params.roleId,
        name: after.name,
        description: after.description,
        scopes: after.scopes.map((s) => s.scope),
      }
    })
  } catch (e) {
    if (e instanceof HTTPException) {
      // 403 = scope-escalation (granting/revoking a scope the actor does not hold);
      // 400 = a refused edit (renaming a system-managed role).
      const code = e.status === 403 ? "SCOPE_ESCALATION" : "INVALID_EDIT"
      return { error: { code, message: e.message } }
    }
    // Unique-violation when a rename collides with an existing role name.
    const pgCode =
      (e as { code?: string; cause?: { code?: string } })?.code ??
      (e as { cause?: { code?: string } })?.cause?.code
    if (pgCode === "23505") return { error: { code: "ROLE_NAME_TAKEN" } }
    throw e
  }
}

export async function summarizeEditRole(
  params: unknown,
  ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  const p = params as {
    roleId?: string
    name?: string
    description?: string
    grantScopes?: string[]
    revokeScopes?: string[]
  }
  const currentName = p.roleId ? await roleName(ctx.tx, p.roleId) : "(role)"
  const grant = p.grantScopes ?? []
  const revoke = p.revokeScopes ?? []
  const parts: string[] = []
  if (p.name !== undefined) parts.push("rename")
  if (p.description !== undefined) parts.push("re-describe")
  if (grant.length) parts.push(`+${grant.length} scope${grant.length === 1 ? "" : "s"}`)
  if (revoke.length) parts.push(`-${revoke.length} scope${revoke.length === 1 ? "" : "s"}`)
  return {
    kind: "edit_role",
    title: `Edit role "${currentName}" (${parts.join(", ") || "no change"})`,
    lines: [
      ...(p.name !== undefined ? [`Rename to "${p.name}".`] : []),
      ...(p.description !== undefined ? [`Set description: ${p.description}`] : []),
      ...(grant.length ? [`GRANT these scopes to the role:`, ...grant.map((s) => `• +${s}`)] : []),
      ...(revoke.length
        ? [`REVOKE these scopes from the role:`, ...revoke.map((s) => `• −${s}`)]
        : []),
      `Every current and future member of this role inherits the resulting scope set.`,
    ],
  }
}

// Delete an org role OUTRIGHT — the destructive complement to create_role, and a different
// operation from remove_user_from_role: that one detaches ONE member and leaves the role
// standing, this erases the role definition itself. It therefore only ever applies to a role
// nobody holds, which is what makes it safe: deleting a role can never silently strip a live
// member's access, because a role with members is refused.
//
// Three guards, in the order a caller meets them:
//  1. ROLE_SYSTEM_MANAGED — a system-managed role is re-materialized BY NAME by the app
//     runtime, which is exactly why edit_role already refuses to RENAME one. Deleting the row
//     would hand back a success the runtime quietly undoes, so it is refused rather than faked.
//  2. ROLE_IN_USE — members still hold it. Checked here from the same read that fetched the
//     role, so the common path returns a clean code; `deleteRole` re-checks inside its own
//     transaction (TOCTOU-safe) and the catch below maps that race to the same code.
//  3. SCOPE_ESCALATION — the symmetric escalation guard that grantScope / assignRole /
//     unassignRole each get from their PermissionMutationContext. `deleteRole` takes no such
//     context, so the guard is applied HERE, against the APPROVING human's re-resolved scopes:
//     you may not delete a role granting scopes you do not yourself hold. Without it a
//     tickets-only admin could erase the `admin` role definition.
export async function handleDeleteRole(
  params: { roleId: string },
  ctx: OrgConfigToolCtx,
): Promise<
  { deleted: true; roleId: string; name: string } | { error: { code: string; message?: string } }
> {
  const actor = await resolveActor(ctx)
  try {
    return await withRlsContext(actor, async (tx) => {
      const detail = await getRoleDetail(tx, { orgId: ctx.orgId, roleId: params.roleId })
      if (!detail) return { error: { code: "ROLE_NOT_FOUND" } }

      const [row] = await tx
        .select({ systemManaged: rolesTable.systemManaged })
        .from(rolesTable)
        .where(and(eq(rolesTable.id, params.roleId), eq(rolesTable.orgId, ctx.orgId)))
        .limit(1)
      if (row?.systemManaged) {
        return {
          error: {
            code: "ROLE_SYSTEM_MANAGED",
            message: `Cannot delete the system-managed role "${detail.name}" — the app runtime re-creates it by name. Edit its scopes instead.`,
          },
        }
      }

      if (detail.members.length > 0) {
        return {
          error: {
            code: "ROLE_IN_USE",
            message: `"${detail.name}" is still held by ${detail.members.length} member${
              detail.members.length === 1 ? "" : "s"
            }. Remove each one with kernel__remove_user_from_role first.`,
          },
        }
      }

      const overReach = detail.scopes
        .map((s) => s.scope)
        .filter(
          (scope) => !hasScope(scope, actor.scopes as PermissionMutationContext["actorScopes"]),
        )
      if (overReach.length > 0) {
        return {
          error: {
            code: "SCOPE_ESCALATION",
            message: `Cannot delete a role that grants scopes you do not hold: ${overReach.join(", ")}`,
          },
        }
      }

      const deleted = await deleteRole(tx, {
        roleId: params.roleId,
        orgId: ctx.orgId,
        actorId: actor.userId,
        requestedBy: ctx.userId,
        actorScopes: actor.scopes as PermissionMutationContext["actorScopes"],
        actorDimensionGrants: actor.dimensionGrants,
      })
      if (!deleted) return { error: { code: "ROLE_NOT_FOUND" } }
      return { deleted: true as const, roleId: deleted.id, name: detail.name }
    })
  } catch (e) {
    // deleteRole throws a bare Error (not an HTTPException) when a member still holds the
    // role. Guard 2 above already returns ROLE_IN_USE on the common path; this only catches
    // the race where someone is assigned between that read and the delete transaction.
    if (e instanceof Error && e.message.includes("active user assignments")) {
      return { error: { code: "ROLE_IN_USE", message: e.message } }
    }
    throw e
  }
}

export async function summarizeDeleteRole(
  params: unknown,
  ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  const p = params as { roleId?: string }
  const name = p.roleId ? await roleName(ctx.tx, p.roleId) : "(role)"
  const detail = p.roleId
    ? await getRoleDetail(ctx.tx, { orgId: ctx.orgId, roleId: p.roleId })
    : null
  const scopes = detail?.scopes.map((s) => s.scope) ?? []
  return {
    kind: "delete_role",
    title: `Delete role "${name}"`,
    lines: [
      `PERMANENTLY deletes the role definition "${name}". This cannot be undone.`,
      scopes.length
        ? `The role currently grants ${scopes.length} scope${
            scopes.length === 1 ? "" : "s"
          }, which stop existing as a grantable set:`
        : `The role grants no scopes.`,
      ...scopes.map((s) => `• ${s}`),
      `No member loses access: a role that is still held cannot be deleted.`,
      `Re-creating it later means re-granting every scope above by hand.`,
    ],
  }
}

// --- Stage-time preflights for the gated kernel-admin writes ----------------
//
// WHY: a gated call must NOT be parked for a human when the data it needs is
// missing. Without these, the approver clicks approve and the handler comes back
// with USER_NOT_FOUND / ROLE_NOT_FOUND / INVALID_DIMENSION: an error only the
// AGENT could have fixed, discovered after a human already spent a decision on
// it. Every one of these preflights is read-only and side-effect free, so the
// agent is corrected in-loop and no approval is created.
//
// DELIBERATELY NOT PREFLIGHTED: SCOPE_ESCALATION / DIMENSION_ESCALATION /
// "cannot grant a scope you do not hold". Those are decided against the
// APPROVING human's own scopes at execution time, by design (the agent must
// never grant beyond the approver). A preflight runs as the REQUESTER, so
// answering them here would answer the authorization question for the wrong
// identity. They stay exactly where they are.

/** A stage-time refusal in the tool's own error shape, or null when the call carries
 *  everything it needs and may be parked for a human. */
export type StagingRefusal = { code: string; message?: string } | null

/** Wrap a {@link StagingRefusal} in the shape `execute-tool.ts` reads back from a preflight. */
function preflightResult(refusal: StagingRefusal): unknown {
  return refusal ? { error: refusal } : { ok: true }
}

/** Existence-only, org-scoped role probe. Privileged on purpose: a preflight must never
 *  refuse on VISIBILITY (that is the approver's RLS decision at execution), only on a row
 *  that is genuinely absent from the org. */
async function roleExistsInOrg(orgId: string, roleId: string): Promise<boolean> {
  return withPrivilegedDb(orgId, "admin-preflight-role", async (tx) => {
    const [r] = await tx
      .select({ id: rolesTable.id })
      .from(rolesTable)
      .where(and(eq(rolesTable.id, roleId), eq(rolesTable.orgId, orgId)))
      .limit(1)
    return Boolean(r)
  })
}

/** Existence-only, org-scoped user probe. See {@link roleExistsInOrg} on why it is privileged. */
async function userExistsInOrg(orgId: string, userId: string): Promise<boolean> {
  return withPrivilegedDb(orgId, "admin-preflight-user", async (tx) => {
    const [u] = await tx
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(eq(usersTable.id, userId), eq(usersTable.orgId, orgId)))
      .limit(1)
    return Boolean(u)
  })
}

/** Shared NO_OP guard for grant_user_scope: called by BOTH the preflight and
 *  {@link handleSetUserScope}, so the two can never drift. */
export function setUserScopeNoOpRefusal(params: {
  grant?: string[]
  revoke?: string[]
}): StagingRefusal {
  const grant = params.grant ?? []
  const revoke = params.revoke ?? []
  if (grant.length === 0 && revoke.length === 0) {
    return { code: "NO_OP", message: "pass at least one scope to grant or revoke" }
  }
  return null
}

/** Shared NO_OP guard for edit_role: called by BOTH the preflight and {@link handleEditRole}. */
export function editRoleNoOpRefusal(params: {
  name?: string
  description?: string
  grantScopes?: string[]
  revokeScopes?: string[]
}): StagingRefusal {
  const editsMeta = params.name !== undefined || params.description !== undefined
  if (
    !editsMeta &&
    (params.grantScopes?.length ?? 0) === 0 &&
    (params.revokeScopes?.length ?? 0) === 0
  ) {
    return {
      code: "NO_OP",
      message: "pass at least one of name, description, grantScopes, or revokeScopes",
    }
  }
  return null
}

/** Shared dimension-catalog validation for grant_dimension_value: the dimension must be a
 *  REAL entry of the org's catalog (the same catalog `list_dimensions` shows the agent) and,
 *  for an enum dimension, every value must be one it declares. Pure and in-memory. */
export function grantDimensionValueCatalogRefusal(
  orgId: string,
  params: { dimension: string; values: string[] },
): StagingRefusal {
  if (params.dimension === "*") {
    return { code: "INVALID_DIMENSION", message: "Wildcard dimension cannot be granted via API" }
  }
  const catalog = getDimensionCatalog(orgId)
  const def = catalog.find(
    (d) => d.key === params.dimension || d.key.slice(d.key.indexOf(":") + 1) === params.dimension,
  )
  if (!def) {
    return { code: "INVALID_DIMENSION", message: `Unknown dimension: ${params.dimension}` }
  }
  if (def.type === "enum" && def.values) {
    const invalid = params.values.filter((v) => v !== "*" && !def.values?.includes(v))
    if (invalid.length > 0) {
      return {
        code: "INVALID_DIMENSION",
        message: `Invalid values for enum dimension: ${invalid.join(", ")}`,
      }
    }
  }
  return null
}

/** invite_user stage-time validation.
 *
 *  CAREFUL, BY DESIGN: a `roleName` is NOT resolved here. The onboarding flow raises
 *  create_role and invite_user in the SAME turn, so the named role does not exist until
 *  its sibling approval runs: refusing an unresolvable name would break the one thing
 *  roleName exists for. Only a `roleId` uuid (which the agent must have read from
 *  roles_list, so it is knowable NOW) is resolved, plus the two email clashes. */
export async function inviteUserStagingRefusal(
  params: { email: string; roleId?: string; roleName?: string },
  ctx: OrgConfigToolCtx,
): Promise<StagingRefusal> {
  if (params.roleId && !(await roleExistsInOrg(ctx.orgId, params.roleId))) {
    return { code: "NOT_FOUND", message: `role id ${params.roleId} not found` }
  }
  const normalizedEmail = params.email.toLowerCase()
  return withPrivilegedDb(ctx.orgId, "admin-preflight-invite", async (tx) => {
    const [existing] = await tx
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(eq(usersTable.email, normalizedEmail), eq(usersTable.orgId, ctx.orgId)))
      .limit(1)
    if (existing) return { code: "USER_EXISTS" }
    const [pending] = await tx
      .select({ id: invitationsTable.id })
      .from(invitationsTable)
      .where(
        and(
          eq(invitationsTable.orgId, ctx.orgId),
          eq(invitationsTable.email, normalizedEmail),
          isNull(invitationsTable.acceptedAt),
        ),
      )
      .limit(1)
    if (pending) return { code: "INVITE_PENDING" }
    return null
  })
}

export async function inviteUserPreflight(
  params: { email: string; roleId?: string; roleName?: string },
  ctx: OrgConfigToolCtx,
): Promise<unknown> {
  return preflightResult(await inviteUserStagingRefusal(params, ctx))
}

/** assign_role stage-time validation: both sides of the assignment must exist in the org.
 *  The role's scope/dimension escalation guard stays at execution (approver identity). */
export async function assignRoleStagingRefusal(
  params: { userId: string; roleId: string },
  ctx: OrgConfigToolCtx,
): Promise<StagingRefusal> {
  if (!(await roleExistsInOrg(ctx.orgId, params.roleId))) {
    return { code: "NOT_FOUND", message: `role id ${params.roleId} not found` }
  }
  if (!(await userExistsInOrg(ctx.orgId, params.userId))) {
    return { code: "NOT_FOUND", message: `user id ${params.userId} not found` }
  }
  return null
}

export async function assignRolePreflight(
  params: { userId: string; roleId: string },
  ctx: OrgConfigToolCtx,
): Promise<unknown> {
  return preflightResult(await assignRoleStagingRefusal(params, ctx))
}

/** remove_user_from_role stage-time validation. Removing a role the member does not HOLD
 *  stays an idempotent no-op (removed:false) at execution, unchanged: this only refuses a
 *  user id or role id that names nothing in the org, which no approval can ever act on. */
export async function removeUserFromRolePreflight(
  params: { userId: string; roleId: string },
  ctx: OrgConfigToolCtx,
): Promise<unknown> {
  return preflightResult(await assignRoleStagingRefusal(params, ctx))
}

/** grant_user_scope stage-time validation: something to do, and a real target member. */
export async function setUserScopeStagingRefusal(
  params: { userId: string; grant?: string[]; revoke?: string[] },
  ctx: OrgConfigToolCtx,
): Promise<StagingRefusal> {
  const noOp = setUserScopeNoOpRefusal(params)
  if (noOp) return noOp
  if (!(await userExistsInOrg(ctx.orgId, params.userId))) return { code: "USER_NOT_FOUND" }
  return null
}

export async function setUserScopePreflight(
  params: { userId: string; grant?: string[]; revoke?: string[] },
  ctx: OrgConfigToolCtx,
): Promise<unknown> {
  return preflightResult(await setUserScopeStagingRefusal(params, ctx))
}

/** edit_role stage-time validation: something to do, a real role, and a rename that the
 *  role will actually accept (a system-managed role is re-materialized BY NAME by the app
 *  runtime, so renaming one is refused at execution with INVALID_EDIT). */
export async function editRoleStagingRefusal(
  params: {
    roleId: string
    name?: string
    description?: string
    grantScopes?: string[]
    revokeScopes?: string[]
  },
  ctx: OrgConfigToolCtx,
): Promise<StagingRefusal> {
  const noOp = editRoleNoOpRefusal(params)
  if (noOp) return noOp
  const role = await withPrivilegedDb(ctx.orgId, "admin-preflight-edit-role", async (tx) => {
    const [r] = await tx
      .select({ name: rolesTable.name, systemManaged: rolesTable.systemManaged })
      .from(rolesTable)
      .where(and(eq(rolesTable.id, params.roleId), eq(rolesTable.orgId, ctx.orgId)))
      .limit(1)
    return r
  })
  if (!role) return { code: "ROLE_NOT_FOUND" }
  if (params.name !== undefined && params.name !== role.name && role.systemManaged) {
    return { code: "INVALID_EDIT", message: "Cannot rename a system-managed role" }
  }
  return null
}

export async function editRolePreflight(
  params: {
    roleId: string
    name?: string
    description?: string
    grantScopes?: string[]
    revokeScopes?: string[]
  },
  ctx: OrgConfigToolCtx,
): Promise<unknown> {
  return preflightResult(await editRoleStagingRefusal(params, ctx))
}

/** delete_role stage-time validation. Everything the REQUESTER can already know is refused
 *  here so no human ever spends a decision on a delete that cannot land: a role id naming
 *  nothing, a system-managed role the runtime would re-create, and a role members still hold
 *  (the agent can see the members via get_role and must detach them first). SCOPE_ESCALATION
 *  is deliberately NOT preflighted — like every other write in this file it is decided against
 *  the APPROVING human's scopes at execution, not the requester's. */
export async function deleteRoleStagingRefusal(
  params: { roleId: string },
  ctx: OrgConfigToolCtx,
): Promise<StagingRefusal> {
  const role = await withPrivilegedDb(ctx.orgId, "admin-preflight-delete-role", async (tx) => {
    const [r] = await tx
      .select({ name: rolesTable.name, systemManaged: rolesTable.systemManaged })
      .from(rolesTable)
      .where(and(eq(rolesTable.id, params.roleId), eq(rolesTable.orgId, ctx.orgId)))
      .limit(1)
    if (!r) return null
    const held = await tx
      .select({ userId: userRolesTable.userId })
      .from(userRolesTable)
      .where(and(eq(userRolesTable.roleId, params.roleId), eq(userRolesTable.orgId, ctx.orgId)))
      .limit(1)
    return { ...r, held: held.length > 0 }
  })
  if (!role) return { code: "ROLE_NOT_FOUND" }
  if (role.systemManaged) {
    return {
      code: "ROLE_SYSTEM_MANAGED",
      message: `Cannot delete the system-managed role "${role.name}" — the app runtime re-creates it by name.`,
    }
  }
  if (role.held) {
    return {
      code: "ROLE_IN_USE",
      message: `"${role.name}" is still held by at least one member. Remove each with kernel__remove_user_from_role first.`,
    }
  }
  return null
}

export async function deleteRolePreflight(
  params: { roleId: string },
  ctx: OrgConfigToolCtx,
): Promise<unknown> {
  return preflightResult(await deleteRoleStagingRefusal(params, ctx))
}

/** grant_dimension_value stage-time validation. Catalog checks run BEFORE the user probe so
 *  the precedence matches the execution path (grantUserDimension validates the dimension
 *  before it looks the target member up). DIMENSION_ESCALATION stays at execution. */
export async function grantDimensionValueStagingRefusal(
  params: { userId: string; dimension: string; values: string[] },
  ctx: OrgConfigToolCtx,
): Promise<StagingRefusal> {
  const catalog = grantDimensionValueCatalogRefusal(ctx.orgId, params)
  if (catalog) return catalog
  if (!(await userExistsInOrg(ctx.orgId, params.userId))) return { code: "USER_NOT_FOUND" }
  return null
}

export async function grantDimensionValuePreflight(
  params: { userId: string; dimension: string; values: string[] },
  ctx: OrgConfigToolCtx,
): Promise<unknown> {
  return preflightResult(await grantDimensionValueStagingRefusal(params, ctx))
}
