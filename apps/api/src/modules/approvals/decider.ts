// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Who may decide one approval, on fresh grants: the single answer the decide
 * path and the edit path both read.
 *
 * - The resource owner of a personal-resource approval decides it, with or
 *   without the app's approve scope: it is their own resource.
 * - Anyone else must be in the audience (the notify-set, or any holder of the
 *   deciding scope for a shared-surface draft), hold the row's own deciding
 *   scope and every scope its proposing turn read (taint, rule 8c), and, for a
 *   dimension-constrained row, hold dimension grants covering it (a super-admin
 *   bypasses that last check).
 */
import type { PrivilegedDb } from "~/db"
import { authorityFacts, decidingScope } from "~/modules/approvals/authority"
import { rowTaintMustHold } from "~/modules/approvals/taint-narrow"
import {
  bypassesDimensionConstraint,
  dimensionGrantCovers,
} from "~/modules/permissions/eligible-approvers"
import { hasScope, loadEffectivePermissions } from "~/modules/permissions/permissions"

export interface DeciderRow {
  tool_name: string
  approve_scope: string | null
  resource_owner_id: string | null
  requested_by: string
  notify_user_ids: string[] | null
  metadata: { taintAudienceMustHold?: unknown } | null
  dimension_constraint?: { key: string; values: string[] } | null
}

export async function mayDecideApproval(args: {
  orgId: string
  userId: string
  row: DeciderRow
  /** `isSharedSurfaceApproval(row)`, computed by the caller. */
  sharedSurface: boolean
  /** The privileged transaction the decider's fresh grants are read on. */
  tx: PrivilegedDb
}): Promise<boolean> {
  const { row, userId } = args
  if (row.resource_owner_id === userId) return true
  const inAudience = args.sharedSurface || (row.notify_user_ids ?? []).includes(userId)
  if (!inAudience) return false
  const perms = await loadEffectivePermissions(args.tx, userId, args.orgId)
  if (!hasScope(decidingScope(authorityFacts(row)), perms.scopes)) return false
  if (!rowTaintMustHold(row.metadata).every((scope) => hasScope(scope, perms.scopes))) return false
  const constraint = row.dimension_constraint
  if (
    constraint &&
    !bypassesDimensionConstraint(perms.scopes) &&
    !dimensionGrantCovers(perms.dimensionGrants, constraint.key, constraint.values)
  )
    return false
  return true
}
