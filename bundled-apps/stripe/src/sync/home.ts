// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `home_load` (hidden from the agent): what the Stripe page shows first. The
// connection and its state, the import's progress per resource, the rows per
// table, and the counts that need a person. No figure is given while the first
// import runs or a permission is missing (`sync.partial`): the page says so.
import { decodeState } from "../connection"
import { isStandInInstall } from "../standin"
import { readInstall, type StateDb, syncProgress } from "../states"

export interface HomeDb extends StateDb {
  count(entity: string, opts?: { where?: Record<string, unknown> }): Promise<number>
}

const TABLES = [
  ["customers", "stripe_customers"],
  ["subscriptions", "stripe_subscriptions"],
  ["invoices", "stripe_invoices"],
  ["payments", "stripe_payments"],
  ["refunds", "stripe_refunds"],
  ["disputes", "stripe_disputes"],
] as const

export async function homeLoad(_params: Record<string, never>, ctx: { db: HomeDb }) {
  const install = await readInstall(ctx.db)
  const sync = await syncProgress(ctx.db)
  if (!install) {
    return {
      connection: { state: "not_connected", base: "not_connected", overlay: null },
      sync,
      counts: null,
      attention: null,
      mrr: null,
      summary:
        "Stripe is not connected. Next step: an admin connects it in Settings, Apps, Stripe.",
    }
  }
  const state = decodeState(install.state)
  const counts: Record<string, number> = {}
  for (const [name, entity] of TABLES) counts[name] = await ctx.db.count(entity)
  const attention = {
    failed: await ctx.db.count("stripe_payments", { where: { status: "failed" } }),
    retries: await ctx.db.count("stripe_invoices", { where: { status: "open" } }),
    refunds: 0,
    disputes: await ctx.db.count("stripe_disputes", { where: { status: "needs_response" } }),
    trials: await ctx.db.count("stripe_subscriptions", { where: { status: "trialing" } }),
  }
  const at = (v: unknown) =>
    v instanceof Date ? v.toISOString() : typeof v === "string" ? v : null
  return {
    connection: {
      state: String(install.state),
      base: state.base,
      overlay: state.overlay,
      mode: install.livemode === true ? "live" : "test",
      lastEventAt: at(install.last_event_at),
      lastEventType: typeof install.last_event_type === "string" ? install.last_event_type : null,
      connectedAt: at(install.connected_at),
      // The demo's stand-in: the pages render no link out to the Stripe dashboard.
      standIn: isStandInInstall(install),
    },
    sync,
    counts,
    attention,
    // Filled by the MRR reader; never a number while the mirror is partial.
    mrr: null,
    summary: sync.importing
      ? `Importing from Stripe: ${sync.resources.map((r) => `${r.resource} ${r.done}`).join(", ")}. Figures show once every resource is read.`
      : sync.missing.length > 0
        ? `The key may not read ${sync.missing.join(", ")}; figures that need them are not shown. Next step: give the key Read on them and run the key check.`
        : `Stripe is ${String(install.state)}.`,
  }
}
