// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Agent tools over the apps hidden from a person's sidebar (0293):
 * `sidebar_apps_get`, `sidebar_apps_set`.
 *
 * - Self by default: no `userId` means the turn's human user, read and written
 *   under that user's RLS (their own preference, like `notifications_set`).
 * - Another person: only for a caller holding `kernel:users:admin`, and only a
 *   member of the caller's organization (else NOT_FOUND, never another org's
 *   row). user_preferences RLS is self-only, so that path runs privileged
 *   after the org check, as the admin route does.
 * - `sidebar_apps_set` takes a delta (`hide`, `show`), so the agent cannot wipe
 *   a list by accident, and answers what it changed.
 * - A change runs only in a live turn a person started (not a routine, a
 *   background run, another agent's question or an agent-bound MCP gateway).
 * - Hiding is a display preference: no scope, role or RLS rule moves, and a
 *   hidden app still opens from search, the command palette and links. Not
 *   approval-gated for that reason.
 * - After a change, the person's open apps re-apply the list (a read-state
 *   frame queued on the transaction, delivered once it commits).
 */
import { HIDDEN_SIDEBAR_APPS_MAX, hiddenSidebarAppIdSchema } from "@liaison/shared"
import { and, eq } from "drizzle-orm"
import { z } from "zod"
import type { RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { users } from "~/db/schema/kernel"
import { currentRunContext } from "~/modules/agent/runtime/run-context"
import { hasScope } from "~/modules/permissions/permissions"
import { queueReadState } from "~/modules/threads/read-state-broadcast"
import { getHiddenSidebarApps, updateHiddenSidebarApps } from "./preferences-service"

export interface SidebarToolContext {
  userId: string
  orgId: string
  db: RlsClient
  actorType: "user" | "agent" | "mcp"
  originRoutineId?: string
  /** The actor's effective scopes (the tool bridge injects them). */
  scopes?: string[]
}

type ToolError = { error: { code: string; message: string } }

const ADMIN_SCOPE = "kernel:users:admin"
const SETTINGS_PATH = "Settings > Sidebar"

const idList = z.array(hiddenSidebarAppIdSchema).max(HIDDEN_SIDEBAR_APPS_MAX)

export const sidebarAppsGetParams = z.object({
  userId: z
    .string()
    .uuid()
    .optional()
    .describe("A member of the organization (needs kernel:users:admin). Omit for the user asking."),
})

export const sidebarAppsSetParams = z
  .object({
    userId: z
      .string()
      .uuid()
      .optional()
      .describe(
        "A member of the organization (needs kernel:users:admin). Omit for the user asking.",
      ),
    hide: idList.optional().describe("Sidebar entry ids to hide, e.g. sessions, monitoring."),
    show: idList.optional().describe("Sidebar entry ids to show again."),
  })
  .refine((p) => (p.hide?.length ?? 0) + (p.show?.length ?? 0) > 0, {
    message: "Give at least one id in hide or show",
  })

/**
 * Null when a change may run. A change runs only in a live agent turn a person
 * started; a read runs wherever the person is the caller.
 */
function refuseChangeOutsideLiveTurn(ctx: SidebarToolContext): ToolError | null {
  const frame = currentRunContext()
  const outside =
    Boolean(ctx.originRoutineId || frame?.routineId) ||
    !frame ||
    Boolean(frame.mcpGateway) ||
    Boolean(frame.coordinated) ||
    Boolean(frame.background) ||
    frame.nestingDepth > 0
  if (!outside) return null
  return {
    error: {
      code: "E_INTERACTIVE_ONLY",
      message: `The sidebar can only be changed in the person's live conversation with you. They can change it in ${SETTINGS_PATH}. Say it in the language of the person's message, in plain words, without naming a tool.`,
    },
  }
}

/** Who the call is about, or the refusal. Self needs nothing more. */
async function resolveTarget(
  ctx: SidebarToolContext,
  userId: string | undefined,
): Promise<{ targetId: string; self: boolean } | ToolError> {
  if (!userId || userId === ctx.userId) return { targetId: ctx.userId, self: true }
  if (!hasScope(ADMIN_SCOPE, ctx.scopes ?? [])) {
    return {
      error: {
        code: "FORBIDDEN",
        message: `Setting another person's sidebar needs ${ADMIN_SCOPE}. Only the person themself, or an admin, can change it.`,
      },
    }
  }
  const found = await withPrivilegedDb(ctx.orgId, "agent-sidebar-apps-target", (tx) =>
    tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.orgId, ctx.orgId), eq(users.userType, "member")))
      .limit(1),
  )
  if (found.length === 0) {
    return { error: { code: "NOT_FOUND", message: "No member of this organization has that id." } }
  }
  return { targetId: userId, self: false }
}

const NOTE =
  "Hidden apps keep every access: they still open from search, the command palette and links."

export async function handleSidebarAppsGet(
  params: z.infer<typeof sidebarAppsGetParams>,
  ctx: SidebarToolContext,
) {
  const target = await resolveTarget(ctx, params.userId)
  if ("error" in target) return target
  const hidden = target.self
    ? await getHiddenSidebarApps(ctx.userId, { rlsTx: ctx.db })
    : await withPrivilegedDb(ctx.orgId, "agent-sidebar-apps-read", (tx) =>
        getHiddenSidebarApps(target.targetId, { rlsTx: tx }),
      )
  return { userId: target.targetId, hidden, note: NOTE }
}

export async function handleSidebarAppsSet(
  params: z.infer<typeof sidebarAppsSetParams>,
  ctx: SidebarToolContext,
) {
  const refusal = refuseChangeOutsideLiveTurn(ctx)
  if (refusal) return refusal
  const target = await resolveTarget(ctx, params.userId)
  if ("error" in target) return target
  const hide = [...new Set(params.hide ?? [])]
  const show = new Set(params.show ?? [])
  const both = hide.filter((id) => show.has(id))
  if (both.length > 0) {
    return {
      error: {
        code: "INVALID_INPUT",
        message: `An id cannot be in both hide and show: ${both.join(", ")}.`,
      },
    }
  }

  const apply = async (tx: Pick<RlsClient, "execute">) => {
    const before = await getHiddenSidebarApps(target.targetId, { rlsTx: tx })
    const next = [
      ...before.filter((id) => !show.has(id)),
      ...hide.filter((id) => !before.includes(id)),
    ]
    if (next.length > HIDDEN_SIDEBAR_APPS_MAX) {
      return {
        error: {
          code: "TOO_MANY",
          message: `At most ${HIDDEN_SIDEBAR_APPS_MAX} apps can be hidden.`,
        },
      } as const
    }
    const hidden = hide.filter((id) => !before.includes(id))
    const shown = before.filter((id) => show.has(id))
    if (hidden.length === 0 && shown.length === 0) {
      return { before, after: before, hidden, shown }
    }
    const row = await updateHiddenSidebarApps(target.targetId, ctx.orgId, next, { rlsTx: tx })
    return { before, after: row.hiddenSidebarApps, hidden, shown }
  }

  const result = target.self
    ? await (async () => {
        const r = await apply(ctx.db)
        if (!("error" in r) && r.after !== r.before) {
          await queueReadState(ctx.db, ctx.orgId, target.targetId, {
            kind: "hidden_sidebar_apps",
            hiddenSidebarApps: r.after,
          })
        }
        return r
      })()
    : await withPrivilegedDb(ctx.orgId, "agent-sidebar-apps-set", async (tx) => {
        const r = await apply(tx)
        if (!("error" in r) && r.after !== r.before) {
          await queueReadState(tx, ctx.orgId, target.targetId, {
            kind: "hidden_sidebar_apps",
            hiddenSidebarApps: r.after,
          })
        }
        return r
      })
  if ("error" in result) return result
  return {
    userId: target.targetId,
    hidden: result.after,
    changed: { hidden: result.hidden, shown: result.shown },
    note: NOTE,
  }
}
