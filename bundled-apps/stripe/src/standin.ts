// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A STAND-IN install: the demo's card-payments account, answered by the host
// from the org's own mirror instead of Stripe. The demo seeder marks it with one
// field in `install_metadata.permissions`; nothing in this app sets it (no
// tool, no route, no job), and the key check keeps it as it found it.
//
// What the mark changes, and nothing else:
//   - `card_update_link` accepts the stand-in's own host for the portal login
//     and hosted invoice links (a real install accepts Stripe's hosts only);
//   - `home_load` reports it, and the pages render no link out to the Stripe
//     dashboard, which does not know the stand-in's customers.

/** The `permissions` field that marks a stand-in install (the host's seeder writes the same name). */
export const STANDIN_MARKER = "demoStandIn"

/** The host of a stand-in install's customer-facing links. */
export const STANDIN_HOST = "billing.payments-standin.example"

export const STANDIN_PORTAL_LOGIN =
  /^https:\/\/billing\.payments-standin\.example\/p\/login\/[A-Za-z0-9_-]+$/
export const STANDIN_HOSTED_INVOICE =
  /^https:\/\/billing\.payments-standin\.example\/i\/[A-Za-z0-9_-]+$/

function parsed(v: unknown): unknown {
  if (typeof v !== "string") return v
  try {
    return JSON.parse(v)
  } catch {
    return null
  }
}

/** Is this install row a stand-in install? */
export function isStandInInstall(install: { permissions?: unknown } | null | undefined): boolean {
  const p = parsed(install?.permissions)
  return !!p && typeof p === "object" && (p as Record<string, unknown>)[STANDIN_MARKER] === true
}

/** The marker of the current install, read from the app's own table. */
export async function readStandIn(db: {
  findMany(entity: string, opts?: { limit?: number }): Promise<unknown[]>
}): Promise<boolean> {
  const rows = (await db.findMany("install_metadata", { limit: 1 })) as Array<{
    permissions?: unknown
  }>
  return isStandInInstall(rows[0])
}
