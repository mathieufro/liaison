// SPDX-License-Identifier: FSL-1.1-ALv2
import { mentionQuerySchema } from "@liaison/shared"
import { type Context, Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { markOwnDependencyDown } from "~/lib/own-dependency-down"
import { withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { PermissionDeniedError } from "~/modules/permissions/errors"
import { isSearchReady } from "~/modules/search/drift"
import { MeiliUnavailableError, mentionSearch } from "~/modules/search/service"
import {
  canReadMemberDirectory,
  listActiveMembers,
  MEMBER_DIRECTORY_MAX_LIMIT,
  MEMBER_DIRECTORY_SCOPES,
} from "~/modules/threads/member-directory"
import { withAway } from "~/modules/users/away-today"

export const mentions = new Hono<AppEnv>()

function searchUnavailable(c: Context<AppEnv>) {
  markOwnDependencyDown(c)
  return c.json({ error: { message: "Search unavailable", code: "SEARCH_UNAVAILABLE" } }, 503)
}

mentions.get("/", zValidator("query", mentionQuerySchema), async (c) => {
  if (!isSearchReady()) return searchUnavailable(c)
  const { q, limit, type } = c.req.valid("query")
  try {
    const result = await mentionSearch({
      orgId: c.get("orgId"),
      userId: c.get("userId"),
      scopes: c.get("scopes"),
      dimensionGrants: c.get("dimensionGrants") ?? {},
      roleIds: c.get("roles") ?? [],
      q,
      limit,
      type,
    })
    // A colleague away today says until when; who is listed does not change.
    const withAwayRows = await withRequestRls(c, (tx) =>
      withAway(tx, c.get("orgId"), result, (r) => r.type === "user"),
    )
    return success(c, withAwayRows)
  } catch (err) {
    if (err instanceof MeiliUnavailableError) return searchUnavailable(c)
    throw err
  }
})

const membersQuerySchema = z.object({
  q: z.string().max(100).default(""),
  limit: z.coerce.number().int().min(1).max(MEMBER_DIRECTORY_MAX_LIMIT).default(50),
})

/**
 * Active human members for a people picker (a ticket's assignee menu), read
 * from the database: it answers while the search index is rebuilding, has no
 * ten-row ceiling, and is filtered by name or email when `q` is set.
 */
mentions.get("/members", zValidator("query", membersQuerySchema), async (c) => {
  if (!canReadMemberDirectory(c.get("scopes"))) {
    throw new PermissionDeniedError({ missingScope: MEMBER_DIRECTORY_SCOPES[0] })
  }
  const { q, limit } = c.req.valid("query")
  const orgId = c.get("orgId")
  const result = await withRequestRls(c, async (tx) => {
    const page = await listActiveMembers(tx, { orgId, q, limit })
    return { ...page, items: await withAway(tx, orgId, page.items) }
  })
  return c.json({ data: result.items, meta: { total: result.total, limit } })
})
