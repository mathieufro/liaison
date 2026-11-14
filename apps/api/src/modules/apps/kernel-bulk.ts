// SPDX-License-Identifier: FSL-1.1-ALv2
import type { ApprovalSummary } from "@liaison/shared"
import { and, eq } from "drizzle-orm"
import { z } from "zod"
import type { RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { users } from "~/db/schema/kernel"
import { manifestRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { registerApprovalSummarizer } from "~/modules/apps/approval-summarizers"
import { registerBulkAgentTools } from "~/modules/apps/bulk-agent-tools"
import {
  companiesManagedBy,
  type HandOverResult,
  handOverCompanies,
  handOverRefusal,
  raiseUnownedRows,
} from "~/modules/contacts/company-unowned"
import { assertMayDeactivate, deactivateUser, UserAuthorityError } from "~/modules/users/service"

const KERNEL_BULK: Record<string, any> = {
  deactivateUsers: {
    label: "Deactivate users",
    underlyingTool: "deactivateUser",
    dispatchMode: "perItem",
    perItemParam: "userId",
    agentTool: "bulkDeactivateUsers",
    // Each person's companies go to the same new manager, or none.
    sharedFields: ["accountsTo"],
    // Admin bulk action: deferred from the hot tool core (discoverable via tool_search).
    deferLoading: true,
  },
}

const ACCOUNTS_TO_DESCRIPTION =
  "Who takes over the companies this person manages: a person's id, or null to leave them without an account manager."

const KERNEL_BULK_TOOLS: Record<string, any> = {
  deactivateUser: {
    requiredScopes: ["kernel:users:admin"],
    writesToTable: "kernel.users",
    params: {
      properties: {
        userId: { type: "string" },
        // No type: a person's id or null; the underlying tool checks it.
        accountsTo: { description: ACCOUNTS_TO_DESCRIPTION },
      },
    },
  },
}

/** kernel:deactivateUser: who loses access. */
export async function summarizeDeactivateUser(
  params: unknown,
  ctx: { tx: RlsClient },
): Promise<ApprovalSummary> {
  const userId = (params as { userId?: unknown } | null)?.userId
  let who = "(no account named)"
  if (typeof userId === "string") {
    const [u] = await ctx.tx
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
    who = u ? (u.name ? `${u.name} (${u.email})` : u.email) : userId
  }
  return {
    kind: "deactivate_user",
    title: `Deactivate ${who}`,
    lines: [
      "This account can no longer sign in, and its open sessions end.",
      "An admin can reactivate it later; nothing it owns is deleted.",
    ],
  }
}

function companiesWord(n: number): string {
  return n === 1 ? "1 company" : `${n} companies`
}

/** The refusal of a deactivation whose companies nobody was named for: the one question. */
function accountsToQuestion(o: { name: string; managed: { name: string }[] }): string {
  const shown = o.managed.slice(0, 5).map((c) => c.name)
  const more =
    o.managed.length > shown.length ? `, and ${o.managed.length - shown.length} more` : ""
  return `${o.name} manages ${companiesWord(o.managed.length)} (${shown.join(", ")}${more}). Say who takes them over: accountsTo with a person's id, or accountsTo null to leave them without an account manager. Nothing was changed.`
}

function deactivatedMessage(name: string, h: HandOverResult | null): string {
  const done = `${name} is deactivated.`
  if (!h) return done
  const parts = [done]
  if (h.moved.length > 0)
    parts.push(
      `${companiesWord(h.moved.length)} moved to ${h.toName ?? "their new account manager"}: ${h.moved.map((c) => c.name).join(", ")}.`,
    )
  if (h.skipped.length > 0) {
    parts.push(
      `${companiesWord(h.skipped.length)} stayed without one: ${h.skipped.map((s) => s.reason).join(" ")}`,
    )
  } else if (h.unowned.length > 0) {
    parts.push(
      `${h.unowned.map((c) => c.name).join(", ")}: no account manager now. Admins see them on Home until someone takes them over.`,
    )
  }
  return parts.join(" ")
}

/**
 * Deactivate a person, answering the question of the companies they manage in the same
 * transaction (`accountsTo`: a person's id, or null for nobody). Someone who manages companies,
 * with `accountsTo` absent, is refused `accounts_to_required` with the count and nothing changes.
 * The tool and the admin route share it, so neither can skip the question.
 */
export async function deactivateWithCompanies(args: {
  orgId: string
  actorId: string
  actorScopes: string[]
  userId: string
  accountsTo?: string | null
}): Promise<
  | { error: { code: string; message: string } }
  | {
      id: string
      message: string
      companies?: {
        movedTo: string | null
        moved: { id: string; name: string }[]
        withoutManager: { id: string; name: string }[]
        skipped: { id: string; name: string; reason: string }[]
      }
    }
> {
  const { orgId, actorId, actorScopes, userId, accountsTo } = args
  if (userId === actorId) {
    return { error: { code: "invalid_params", message: "Cannot deactivate own account" } }
  }
  if (typeof accountsTo === "string") {
    const refused = await handOverRefusal(orgId, userId, accountsTo)
    if (refused) return { error: refused }
  }
  type Outcome =
    | { kind: "accounts_to_required"; name: string; managed: { name: string }[] }
    | { kind: "not_found" }
    | { kind: "done"; id: string; name: string; handOver: HandOverResult | null }
  let outcome: Outcome
  try {
    outcome = await withPrivilegedDb(orgId, "kernel-bulk-deactivate", async (tx) => {
      const [target] = await tx
        .select({ name: users.name, email: users.email })
        .from(users)
        .where(and(eq(users.id, userId), eq(users.orgId, orgId)))
        .limit(1)
      const name = target?.name || target?.email || "This person"
      // Authority first: someone who may not deactivate them learns nothing of their companies.
      await assertMayDeactivate(tx, { targetId: userId, orgId, actorScopes })
      // Nothing changes until the question of their companies is answered.
      const managed = await companiesManagedBy(tx, orgId, userId)
      if (managed.length > 0 && accountsTo === undefined) {
        return { kind: "accounts_to_required" as const, name, managed }
      }
      const result = await deactivateUser(tx, {
        targetId: userId,
        actorId,
        orgId,
        actorScopes,
      })
      if (!result) return { kind: "not_found" as const }
      let handOver: HandOverResult | null = null
      if (managed.length > 0) {
        handOver = await handOverCompanies(tx, {
          orgId,
          actorId,
          fromUserId: userId,
          accountsTo: accountsTo ?? null,
        })
        await raiseUnownedRows(tx, {
          orgId,
          leftUserId: userId,
          actorId,
          companyIds: handOver.unowned.map((c) => c.id),
        })
      }
      return { kind: "done" as const, id: result.id, name, handOver }
    })
  } catch (err) {
    if (err instanceof UserAuthorityError) {
      const code = err.code === "LAST_ADMIN" ? "last_admin" : "forbidden"
      return { error: { code, message: err.message } }
    }
    throw err
  }
  if (outcome.kind === "not_found") {
    return { error: { code: "not_found", message: "User not found" } }
  }
  if (outcome.kind === "accounts_to_required") {
    return { error: { code: "accounts_to_required", message: accountsToQuestion(outcome) } }
  }
  return {
    id: outcome.id,
    message: deactivatedMessage(outcome.name, outcome.handOver),
    ...(outcome.handOver
      ? {
          companies: {
            movedTo: accountsTo ?? null,
            moved: outcome.handOver.moved,
            withoutManager: outcome.handOver.unowned,
            skipped: outcome.handOver.skipped,
          },
        }
      : {}),
  }
}

/**
 * Register kernel-scoped bulk runtime: manifest entries for the kernel "app",
 * and an underlying `deactivateUser` tool that the bulk dispatcher invokes
 * per-item. Idempotent — safe to call multiple times.
 */
export function registerKernelBulkApp(orgId: string): void {
  toolRegistry.set([orgId, "kernel", "deactivateUser"], {
    appName: "kernel",
    name: "deactivateUser",
    deferLoading: true,
    description:
      "Deactivate a user account (admin only). Gated: lands as an approval a person decides.",
    searchKeywords: [
      "désactiver",
      "retirer",
      "départ",
      "disable",
      "utilisateur",
      "collaborateur",
      "remove",
      "deactivate",
      "user",
    ],
    requiredScopes: ["kernel:users:admin"],
    // Who may sign in is a person's decision, as role edits are (kernel:create_role): an agent's
    // call parks for one, whatever the turn read. A person's own click runs at once.
    trustBoundary: "user",
    gated: true,
    approvalImpact: "internal",
    // Sets the target account's status: a kernel.users row.
    writesToTable: "kernel.users",
    params: z.object({
      userId: z.string().uuid(),
      accountsTo: z.string().uuid().nullable().optional().describe(ACCOUNTS_TO_DESCRIPTION),
    }),
    handler: async (params: unknown, ctx: any) => {
      const { userId, accountsTo } = params as { userId: string; accountsTo?: string | null }
      return deactivateWithCompanies({
        orgId: ctx.orgId,
        actorId: ctx.userId,
        actorScopes: Array.isArray(ctx.scopes) ? (ctx.scopes as string[]) : [],
        userId,
        ...(accountsTo !== undefined ? { accountsTo } : {}),
      })
    },
  })

  registerApprovalSummarizer(orgId, "kernel", "deactivateUser", summarizeDeactivateUser)

  const existing = manifestRegistry.get([orgId, "kernel"])
  manifestRegistry.set([orgId, "kernel"], {
    ...(existing ?? { name: "kernel", uiBundleUrl: null }),
    name: "kernel",
    bulk: { ...(existing?.bulk ?? {}), ...KERNEL_BULK },
    uiBundleUrl: existing?.uiBundleUrl ?? null,
  })

  registerBulkAgentTools({
    orgId,
    appName: "kernel",
    bulk: KERNEL_BULK,
    tools: KERNEL_BULK_TOOLS,
    vouched: true,
  })
}
