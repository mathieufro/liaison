// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The transaction a portal request runs in: the request login, the verified
// context variables of withRlsContext, no scopes, and the role liaison_portal.
//
// liaison_portal reaches the views of schema `portal` and nothing else (a kernel
// table raises permission denied, it does not return zero rows), so what a client
// can see is the list in portal-role-grants.test.ts rather than a matter of each
// query remembering a filter.
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withAcquireTimeout } from "~/db/acquire-timeout"
import { recordAcquireTimeout, recordPoolAcquireTimeout } from "~/db/pool-diag"
import { grantContextTag, orgContextTag, userContextTag } from "~/db/rls"
import { env } from "~/lib/env"
import { __request_pool_db__ as db } from "./connection"

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

const NO_SCOPES = "__none__"
const NO_ROLES = "__none__"
const NO_DIMENSIONS = "{}"

export type PortalContext = { orgId: string; userId: string }

/** The transaction handle a portal request gets: it reads views, nothing queues on it. */
export type PortalClient = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** The user is not an active external user: no portal transaction runs for them. */
export class PortalContextRefusedError extends Error {
  constructor() {
    super("portal context refused: the user is not an active external user")
    this.name = "PortalContextRefusedError"
  }
}

/**
 * Runs `fn` as the portal role for one external user.
 *
 * Whether the user may is read from `portal.me`, inside the transaction and as
 * the role itself: the view answers only for an active external row. A member, a
 * deactivated client or an unknown id throws PortalContextRefusedError and `fn`
 * never runs.
 */
export async function withPortalContext<T>(
  ctx: PortalContext,
  fn: (tx: PortalClient) => Promise<T>,
): Promise<T> {
  if (!UUID.test(ctx.userId)) throw new PortalContextRefusedError()

  const [orgTag, userTag, scopesTag, dimensionsTag, rolesTag] = await Promise.all([
    orgContextTag(ctx.orgId),
    userContextTag(ctx.userId),
    grantContextTag("scopes", NO_SCOPES),
    grantContextTag("dimensions", NO_DIMENSIONS),
    grantContextTag("roles", NO_ROLES),
  ])
  const setJit = !env.DB_RLS_JIT_ENABLED
  const setTimeout = env.DB_STATEMENT_TIMEOUT_MS > 0

  let signalAcquired!: () => void
  const acquired = new Promise<void>((resolve) => {
    signalAcquired = resolve
  })
  const txPromise = db.transaction(async (tx) => {
    signalAcquired()
    // The shape of withRlsContext's opening statement (db/rls.ts), which says
    // why each line is there. The role switch comes last: rls_ctx.enter() runs
    // before the transaction becomes liaison_portal.
    await tx.execute(drizzleSql`SELECT
      set_config('app.current_user_id', ${ctx.userId}, true),
      set_config('app.current_user_tag', ${userTag}, true),
      set_config('app.current_org_id', ${ctx.orgId}, true),
      set_config('app.current_org_tag', ${orgTag}, true),
      set_config('app.current_scopes', ${NO_SCOPES}, true),
      set_config('app.current_scopes_tag', ${scopesTag}, true),
      set_config('app.current_dimensions', ${NO_DIMENSIONS}, true),
      set_config('app.current_dimensions_tag', ${dimensionsTag}, true),
      set_config('app.current_roles', ${NO_ROLES}, true),
      set_config('app.current_roles_tag', ${rolesTag}, true)
      ${setJit ? drizzleSql`, set_config('jit', 'off', true)` : drizzleSql``}
      ${setTimeout ? drizzleSql`, set_config('statement_timeout', ${String(env.DB_STATEMENT_TIMEOUT_MS)}, true)` : drizzleSql``},
      rls_ctx.enter(),
      set_config('role', 'liaison_portal', true)`)

    const me = extractRows<{ ok: number }>(
      await tx.execute(drizzleSql`SELECT 1 AS ok FROM portal.me`),
    )
    if (me.length !== 1) throw new PortalContextRefusedError()
    return fn(tx)
  })

  await withAcquireTimeout(
    "withPortalContext",
    env.DB_ACQUIRE_TIMEOUT_MS,
    Promise.race([
      acquired,
      txPromise.then(
        () => undefined,
        () => undefined,
      ),
    ]),
    () => {
      recordAcquireTimeout()
      recordPoolAcquireTimeout("request")
    },
  )
  return txPromise
}
