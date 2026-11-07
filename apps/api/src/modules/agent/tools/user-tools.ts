// SPDX-License-Identifier: FSL-1.1-ALv2
import { and, eq, ilike, or, sql } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { users } from "~/db/schema/kernel"
import { awayOf, readWhoIsAway } from "~/modules/users/away-today"

interface UserToolContext {
  userId: string
  orgId: string
  db: RlsClient
}

/**
 * `users_search` — resolve a TEAM member (a colleague in the same org) by name or email to their
 * user id. The agent needs this to ROUTE work to a teammate: `tickets:assign` (and the gated send
 * tools' assignee fields) take a user UUID, and there is otherwise no way to turn "Liam" into an id.
 * This is the team-directory analog of `contacts_search` (which is for EXTERNAL people / customers).
 *
 * RLS-scoped to the caller's org (the `users` SELECT policy is org-scoped) and gated by
 * `kernel:users:read` (granted in the BASE persona bundle), so any agent user can resolve colleagues
 * for assignment/@mention without admin rights. Only ACTIVE users are returned — a deactivated or
 * suspended account is not a valid assignee. Returns the same lightweight shape as `contacts_search`.
 * Each row says `away: { until }` for someone away today, the last day of their current run of
 * away days, read as Home reads it; no source and no reason. Who is returned does not change.
 */
export async function handleUsersSearch(
  params: { query?: string; limit?: number },
  ctx: UserToolContext,
) {
  const limit = Math.min(params.limit ?? 20, 50)
  const q = params.query?.trim()
  const filters = [eq(users.orgId, ctx.orgId), eq(users.status, "active")]
  if (q) {
    const like = `%${q}%`
    // name OR email substring — `or(...)` is never undefined with two args, but the non-null
    // assertion keeps the `SQL | undefined` return off the `and(...)` arg list for the typechecker.
    filters.push(or(ilike(users.name, like), ilike(users.email, like))!)
  }
  const rows = await ctx.db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      _total: sql<number>`count(*) over()::int`,
    })
    .from(users)
    .where(and(...filters))
    .orderBy(users.name)
    .limit(limit)

  const away = await readWhoIsAway(ctx.db, ctx.orgId)
  return {
    items: rows.map(({ _total, ...rest }) => ({ ...rest, away: awayOf(away, rest.id) })),
    totalCount: rows[0]?._total ?? 0,
  }
}
