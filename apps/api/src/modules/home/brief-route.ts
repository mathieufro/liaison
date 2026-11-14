// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * GET /api/home/brief: Home's "Today's brief" card. The newest agent message in
 * the output thread of the caller's OWN morning-brief routine (the kernel
 * template), read under the caller's RLS. Nothing is stored for it: the routine
 * and its thread are the record. `null` when the caller has no such routine, or
 * it has not written yet: Home then shows "No brief set up" with Set up.
 * Another person's brief is never read: the routine is matched on the caller as
 * owner, and the thread is read under the caller's own access.
 */
import { and, desc, eq, isNull } from "drizzle-orm"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { messages, routines } from "~/db/schema/kernel"
import { withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { MORNING_BRIEF_TEMPLATE_KEY } from "~/modules/agent/routines/kernel-routine-templates"

export interface HomeBrief {
  routineId: string
  routineName: string
  /** Null until the routine has written its first brief. */
  message: { id: string; threadId: string; text: string; at: string } | null
}

export const homeBriefRoutes = new Hono<AppEnv>()

homeBriefRoutes.get("/brief", async (c) => {
  const orgId = c.get("orgId")
  const userId = c.get("userId")
  const brief = await withRequestRls(c, async (tx): Promise<HomeBrief | null> => {
    const [routine] = await tx
      .select({ id: routines.id, name: routines.name, outputThreadId: routines.outputThreadId })
      .from(routines)
      .where(
        and(
          eq(routines.orgId, orgId),
          eq(routines.ownerUserId, userId),
          eq(routines.templateKey, MORNING_BRIEF_TEMPLATE_KEY),
        ),
      )
      .orderBy(desc(routines.lastRunAt))
      .limit(1)
    if (!routine) return null
    if (!routine.outputThreadId) {
      return { routineId: routine.id, routineName: routine.name, message: null }
    }
    const [latest] = await tx
      .select({
        id: messages.id,
        threadId: messages.threadId,
        content: messages.content,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(
        and(
          eq(messages.orgId, orgId),
          eq(messages.threadId, routine.outputThreadId),
          eq(messages.authorType, "agent"),
          isNull(messages.deletedAt),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(1)
    return {
      routineId: routine.id,
      routineName: routine.name,
      message: latest
        ? {
            id: latest.id,
            threadId: latest.threadId,
            text: latest.content,
            at: latest.createdAt.toISOString(),
          }
        : null,
    }
  })
  return success(c, brief)
})
