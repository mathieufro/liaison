// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql as drizzleSql, type SQL } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { extractRows } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { hasScope } from "~/modules/permissions/permissions"

const K = drizzleSql.raw(schemaRef("kernel"))

/**
 * The SQL encoding of `hasScope()` (modules/permissions/permissions.ts), which is the one
 * definition of what a grant covers: `*`; the scope itself; a bare parent (`kpi` covers
 * `kpi:comments:read`); and a TRAILING `:*` wildcard (`kpi:*`, `kpi:comments:*` cover
 * everything under their prefix). A mid-segment `*` (`kpi:*:read`) covers nothing but itself.
 * The trailing-wildcard branch was missing until 2026-09-23, so a `kpi:*` holder was never an
 * eligible approver and, worse, never counted as a reader of a declared taint sink. The
 * parity test in eligible-approvers.test.ts evaluates this predicate in Postgres against
 * `hasScope` over a grid of grants and scopes; change both or neither.
 *
 * The `approval_requests_select` RLS policy inlines this same four-branch predicate
 * (migration 0104, which added the trailing-wildcard branch to 0029's form), so a
 * trailing-wildcard approver who is notified can also SELECT the row. Change the policy
 * with this fragment; authority-rls-parity.test.ts pins the two against hasScope.
 */
export function scopeMatchesFragment(scopeColumnExpr: SQL, requiredExpr: SQL): SQL {
  return drizzleSql`(${scopeColumnExpr} = '*' OR ${scopeColumnExpr} = ${requiredExpr} OR left(${requiredExpr}, length(${scopeColumnExpr}) + 1) = ${scopeColumnExpr} || ':' OR (right(${scopeColumnExpr}, 2) = ':*' AND strpos(left(${scopeColumnExpr}, length(${scopeColumnExpr}) - 1), '*') = 0 AND left(${requiredExpr}, length(${scopeColumnExpr}) - 1) = left(${scopeColumnExpr}, length(${scopeColumnExpr}) - 1)))`
}

/**
 * The scopes every member holds, as a grant-table reader must count them: a real scope check
 * (`loadEffectivePermissions`) adds them to the stored grants, so a reader of the grant tables that
 * leaves them out answers differently from the decide check. The one SQL statement of
 * `everyMemberScopeGrants`, with the app restriction a real check applies to these grants
 * (migration 0261). An external user holds none of them. The SQL function reads the row as its
 * caller, so `approval_requests_select` under liaison_rls already cannot see an external row
 * (users_members_only); this fragment runs on a privileged handle, which that policy does not
 * narrow, so it says so itself.
 */
export function everyMemberScopeFragment(orgId: string, userExpr: SQL, requiredExpr: SQL): SQL {
  return drizzleSql`(${K}.every_member_scope_covers(${orgId}::uuid, ${userExpr}, ${requiredExpr}::text) AND EXISTS (SELECT 1 FROM ${K}.users m WHERE m.id = ${userExpr} AND m.user_type = 'member'))`
}

/**
 * The app whose restriction (S20) decides who may approve: the tool's own app when
 * the caller names it (the `approval_requests_select` policy reads
 * `split_part(tool_name, ':', 1)`, so a manifest `approveScope` from another app
 * does not move the restriction), else the scope's app.
 */
function restrictionApp(requiredScope: string, toolApp: string | undefined): string {
  return toolApp ?? requiredScope.split(":")[0] ?? ""
}

/**
 * Resolve all active users in `orgId` whose effective scopes satisfy `requiredScope`
 * under the same matching semantics as `hasScope()` (see `scopeMatchesFragment`).
 * `toolApp`: the app of the tool being approved, when the scope is a deciding scope;
 * people a restriction of that app keeps out are not approvers.
 *
 * Effective scopes are the stored grants plus the computed every-member ones, so this answers as
 * `hasScope` does over `loadEffectivePermissions`, and nobody that check refuses is an approver.
 * Single SQL round-trip. Caller must run inside a privileged transaction so the
 * UNION across `user_scope_grants` and `role_scope_grants` is not gated by RLS.
 */
export async function eligibleApprovers(
  tx: PrivilegedDb,
  orgId: string,
  requiredScope: string,
  toolApp?: string,
): Promise<string[]> {
  const required = drizzleSql`${requiredScope}`
  const app = restrictionApp(requiredScope, toolApp)
  const result = await tx.execute(drizzleSql`
    SELECT DISTINCT u.id AS user_id
    FROM ${K}.users u
    WHERE u.org_id = ${orgId}::uuid
      AND u.status = 'active'
      AND u.user_type = 'member'
      -- A restricted app's approvals go to the people who keep the app (S20).
      AND NOT ${K}.app_access_denied(${orgId}::uuid, u.id, ${app}::text)
      AND (
        EXISTS (
          SELECT 1 FROM ${K}.user_scope_grants g
          WHERE g.user_id = u.id
            AND g.org_id = ${orgId}::uuid
            AND ${scopeMatchesFragment(drizzleSql`g.scope`, required)}
        )
        OR EXISTS (
          SELECT 1
          FROM ${K}.user_roles ur
          JOIN ${K}.role_scope_grants rsg ON rsg.role_id = ur.role_id
          WHERE ur.user_id = u.id
            AND ur.org_id = ${orgId}::uuid
            AND ${scopeMatchesFragment(drizzleSql`rsg.scope`, required)}
        )
        OR ${everyMemberScopeFragment(orgId, drizzleSql`u.id`, required)}
      )
  `)
  return extractRows<{ user_id: string }>(result).map((r) => r.user_id)
}

/**
 * SCOPE-level bypass for a dimension constraint (single source of truth). A user
 * whose scopes contain `*`, `kernel`, or cover `kernel:approvals:admin` (hasScope
 * semantics) is NEVER filtered out by a dimension constraint — a super-admin must
 * not be lockable out of an approval. Ordinary `<x>:approve` holders WITHOUT a
 * matching dimension grant DO get filtered (that is the point of the feature).
 */
export function bypassesDimensionConstraint(scopes: string[]): boolean {
  return (
    hasScope("*", scopes) ||
    hasScope("kernel", scopes) ||
    hasScope("kernel:approvals:admin", scopes)
  )
}

/**
 * A dimension grant map (`dimensionGrants[key]` -> granted values) COVERS the
 * constraint's values when it includes `"*"` (all values) or every required
 * value. Empty/absent grant never covers a non-empty constraint.
 */
export function dimensionGrantCovers(
  grants: Record<string, string[]> | undefined,
  key: string,
  values: string[],
): boolean {
  const granted = grants?.[key] ?? []
  if (granted.includes("*")) return true
  return values.every((v) => granted.includes(v))
}

/**
 * Like {@link eligibleApprovers}, but additionally filters the audience by a
 * dimension constraint: a user is kept only when they hold `requiredScope` AND
 * either bypass (scope-level super-admin, see {@link bypassesDimensionConstraint})
 * OR their effective dimension grants on `constraint.key` include `"*"` or ALL of
 * `constraint.values`. The scope is judged as in {@link eligibleApprovers}. Effective grants union user_dimension_grants +
 * role_dimension_grants (mirroring loadEffectivePermissions). Single SQL
 * round-trip; caller runs inside a privileged transaction.
 */
export async function eligibleApproversWithDimension(
  tx: PrivilegedDb,
  orgId: string,
  requiredScope: string,
  constraint: { key: string; values: string[] },
  toolApp?: string,
): Promise<string[]> {
  const required = drizzleSql`${requiredScope}`
  const app = restrictionApp(requiredScope, toolApp)
  // Bind the required constraint values as a text[] for the `<@` (contained-by)
  // check. Build an explicit ARRAY[...] of bound params so a single-element list
  // is never mis-serialized as a bare scalar by the driver.
  const constraintValues = drizzleSql`ARRAY[${drizzleSql.join(
    constraint.values.map((v) => drizzleSql`${v}`),
    drizzleSql`, `,
  )}]::text[]`
  const result = await tx.execute(drizzleSql`
    SELECT DISTINCT u.id AS user_id
    FROM ${K}.users u
    WHERE u.org_id = ${orgId}::uuid
      AND u.status = 'active'
      AND u.user_type = 'member'
      -- A restricted app's approvals go to the people who keep the app (S20).
      AND NOT ${K}.app_access_denied(${orgId}::uuid, u.id, ${app}::text)
      AND (
        EXISTS (
          SELECT 1 FROM ${K}.user_scope_grants g
          WHERE g.user_id = u.id
            AND g.org_id = ${orgId}::uuid
            AND ${scopeMatchesFragment(drizzleSql`g.scope`, required)}
        )
        OR EXISTS (
          SELECT 1
          FROM ${K}.user_roles ur
          JOIN ${K}.role_scope_grants rsg ON rsg.role_id = ur.role_id
          WHERE ur.user_id = u.id
            AND ur.org_id = ${orgId}::uuid
            AND ${scopeMatchesFragment(drizzleSql`rsg.scope`, required)}
        )
        OR ${everyMemberScopeFragment(orgId, drizzleSql`u.id`, required)}
      )
      AND (
        -- Scope-level super-admin bypass: '*' / 'kernel' / a scope covering
        -- 'kernel:approvals:admin' is never filtered by the dimension constraint.
        EXISTS (
          SELECT 1
          FROM (VALUES ('*'), ('kernel'), ('kernel:approvals:admin')) AS b(scope)
          WHERE EXISTS (
            SELECT 1 FROM ${K}.user_scope_grants g
            WHERE g.user_id = u.id AND g.org_id = ${orgId}::uuid
              AND ${scopeMatchesFragment(drizzleSql`g.scope`, drizzleSql`b.scope`)}
          )
          OR EXISTS (
            SELECT 1
            FROM ${K}.user_roles ur
            JOIN ${K}.role_scope_grants rsg ON rsg.role_id = ur.role_id
            WHERE ur.user_id = u.id AND ur.org_id = ${orgId}::uuid
              AND ${scopeMatchesFragment(drizzleSql`rsg.scope`, drizzleSql`b.scope`)}
          )
        )
        -- Or the user's effective dimension grants on the constraint key cover it:
        -- '*' grants all values, else every required value must be granted. The
        -- inner CTE flattens the user's union of user_dimension_grants +
        -- role_dimension_grants for the constraint key into one text[] of values.
        OR EXISTS (
          WITH effective_vals AS (
            SELECT COALESCE(array_agg(DISTINCT v), ARRAY[]::text[]) AS vals
            FROM (
              SELECT jsonb_array_elements_text(udg.dimension_values) AS v
              FROM ${K}.user_dimension_grants udg
              WHERE udg.user_id = u.id AND udg.org_id = ${orgId}::uuid
                AND udg.dimension_key = ${constraint.key}
              UNION ALL
              SELECT jsonb_array_elements_text(rdg.dimension_values) AS v
              FROM ${K}.user_roles ur
              JOIN ${K}.role_dimension_grants rdg ON rdg.role_id = ur.role_id
              WHERE ur.user_id = u.id AND ur.org_id = ${orgId}::uuid
                AND rdg.dimension_key = ${constraint.key}
            ) flat
          )
          SELECT 1 FROM effective_vals
          WHERE '*' = ANY(vals)
            OR ${constraintValues} <@ vals
        )
      )
  `)
  return extractRows<{ user_id: string }>(result).map((r) => r.user_id)
}
