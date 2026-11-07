// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "Away until <date>" on a list of people: users_search, users_list, the assignee and @mention
// pickers. Read as Home reads it (`readAwayWorld`, the caller's transaction): active ranges of
// colleagues, the standing next in line included, and only until when. No source, no reason.
// Who is listed never changes.

import type { RlsClient } from "~/db"
import { appsLogger as log } from "~/lib/logger"
import { type AwayWorld, readAwayWorld } from "~/modules/approvals/route-world"

/** What a list says of one person: until when they are away, or null when they are not. */
export function awayOf(world: AwayWorld, userId: string): { until: string | null } | null {
  const a = world.away(userId)
  return a ? { until: a.until } : null
}

/**
 * Who is away today, read in a savepoint of the caller's transaction: a failed read (logged by
 * the away read, as "nobody away") must not abort the list it decorates.
 */
export async function readWhoIsAway(tx: RlsClient, orgId: string): Promise<AwayWorld> {
  try {
    return await tx.transaction((sp) => readAwayWorld(sp as unknown as RlsClient, orgId))
  } catch (err) {
    // Unreadable means nobody is shown away; the list itself still answers.
    log.warn({ err, orgId }, "could not read who is away for a list of people")
    return { away: () => null, people: new Set(), standingFor: () => [] }
  }
}

/** `rows` with `away` on each person row (`isPerson` picks them; every row by default). */
export async function withAway<T extends object>(
  tx: RlsClient,
  orgId: string,
  rows: readonly T[],
  isPerson: (row: T) => boolean = () => true,
): Promise<Array<T & { away?: { until: string | null } | null }>> {
  if (!rows.some(isPerson)) return [...rows]
  const world = await readWhoIsAway(tx, orgId)
  return rows.map((r) =>
    isPerson(r) ? { ...r, away: awayOf(world, String((r as { id?: unknown }).id)) } : r,
  )
}
