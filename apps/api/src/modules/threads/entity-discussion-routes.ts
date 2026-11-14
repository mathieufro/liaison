// SPDX-License-Identifier: FSL-1.1-ALv2
//
// POST /api/threads/entity-discussion {app, entityType, entityId}: the
// discussion of one record, its thread id, created the first time it is
// opened, with the caller enrolled. Seeing the record under the caller's own
// RLS is what lets someone in: a record they cannot see is a 404 and nothing is
// created; a kind that holds no discussion is a 422 `discussion_not_declared`.
import { Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { requireScope } from "~/middleware/require-scope"
import { DiscussionNotDeclaredError, openEntityDiscussion } from "./entity-discussion"

const IDENT = /^[a-z][a-z0-9_-]*$/i

const openSchema = z.object({
  app: z.string().regex(IDENT).max(64),
  entityType: z.string().regex(IDENT).max(64),
  entityId: z.string().min(1).max(200),
})

export const entityDiscussionRoutes = new Hono<AppEnv>().post(
  "/",
  requireScope("kernel:threads:read"),
  zValidator("json", openSchema),
  async (c) => {
    const ref = c.req.valid("json")
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    try {
      const opened = await withRequestRls(c, (tx) =>
        openEntityDiscussion(tx, { orgId, userId, ref }),
      )
      if (!opened) {
        return c.json(
          {
            error: {
              message: `${ref.app}:${ref.entityType} ${ref.entityId} does not exist or is not visible to you`,
              code: "not_found",
            },
          },
          404,
        )
      }
      return success(c, opened)
    } catch (err) {
      if (err instanceof DiscussionNotDeclaredError) {
        return c.json({ error: { message: err.message, code: err.code } }, 422)
      }
      throw err
    }
  },
)
