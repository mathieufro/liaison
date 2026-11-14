// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The connection's state as the sync jobs and the money actions read it.
//
// IMPORTING. The first import is in progress while any resource's row in
// `sync_state` is `pending` or `running`. Meanwhile:
//   - no figure is given: `syncProgress` answers `partial: true` and the MRR
//     reader shows no number;
//   - no typed `stripe/*` event leaves the app (they are what invoicing's issuing
//     paths and this app's routines listen to). A delivery whose events were held
//     is marked `held` in the ledger and played again through the same dispatch
//     once the import is done (backfill.ts), so nothing is lost; only the
//     connection's own state and the card-number notice go out at once.
//
// HELD MONEY ACTIONS. While Stripe refuses the key (`key_invalid`) or the account
// could not be confirmed (`different_account`), a money action changes nothing
// and says why. Waiting approvals are left as they are: approving one later,
// with the key fixed, works; approving it now refuses with this reason.
import { refuseTool, type ToolRefusal } from "@liaison/app-sdk/errors"
import {
  type ConnectionEvent,
  type ConnectionState,
  decodeState,
  encodeState,
  transition,
} from "./connection"

type Obj = Record<string, unknown>

export interface StateDb {
  findMany(
    entity: string,
    opts?: { where?: Record<string, unknown>; limit?: number },
  ): Promise<unknown[]>
  update(entity: string, id: string, data: Record<string, unknown>): Promise<void>
}

export interface StateCtx {
  db: StateDb
  emit(event: { entity: string; action: string; entityId?: string; data?: unknown }): Promise<void>
}

export interface Install {
  id: string
  state: unknown
  livemode: unknown
  account_id?: unknown
  connected_at?: unknown
  last_event_at?: unknown
  last_event_type?: unknown
  webhook_confirmed_at?: unknown
  permissions?: unknown
}

export async function readInstall(db: StateDb): Promise<Install | null> {
  const rows = (await db.findMany("install_metadata", { limit: 1 })) as Install[]
  return rows[0] ?? null
}

/** Move the connection's state; announces `connection:state_changed` when the text changed. */
export async function moveState(
  ctx: StateCtx,
  install: Install,
  events: ConnectionEvent[],
  extra: Obj = {},
): Promise<ConnectionState> {
  const before = decodeState(install.state)
  let next = before
  for (const e of events) next = transition(next, e)
  const from = encodeState(before)
  const to = encodeState(next)
  if (to === from && Object.keys(extra).length === 0) return next
  await ctx.db.update("install_metadata", install.id, { ...extra, state: to })
  install.state = to
  if (to !== from) {
    await ctx.emit({
      entity: "connection",
      action: "state_changed",
      entityId: install.id,
      data: { from, to },
    })
  }
  return next
}

/** Overlays under which no job reads or writes Stripe data until a person acts. */
export function blockedOverlay(install: Install): "key_invalid" | "different_account" | null {
  const { overlay } = decodeState(install.state)
  return overlay === "key_invalid" || overlay === "different_account" ? overlay : null
}

export interface ResourceProgress {
  resource: string
  status: string
  done: number
  total: number | null
  error: string | null
}

export interface SyncProgress {
  importing: boolean
  /** True while a figure built from the mirror would be incomplete. */
  partial: boolean
  resources: ResourceProgress[]
  /** Resources the key may not read (403), by name. */
  missing: string[]
}

const IMPORTING = new Set(["pending", "running"])

export async function syncProgress(db: Pick<StateDb, "findMany">): Promise<SyncProgress> {
  const rows = (await db.findMany("sync_state", { limit: 50 })) as Obj[]
  // The movement log keeps its place in two rows of its own (`mrr_*`); they are not an import.
  const resources: ResourceProgress[] = rows
    .filter((r) => !String(r.resource).startsWith("mrr_"))
    .map((r) => ({
      resource: String(r.resource),
      status: String(r.status),
      done: Number(r.done_count) || 0,
      total: typeof r.total_count === "number" ? r.total_count : null,
      error: typeof r.last_error_code === "string" ? r.last_error_code : null,
    }))
  const importing = resources.some((r) => IMPORTING.has(r.status))
  const missing = resources
    .filter((r) => r.status === "failed" && r.error === "permission_missing")
    .map((r) => r.resource)
  return { importing, partial: importing || missing.length > 0, resources, missing }
}

export async function importInProgress(db: StateDb): Promise<boolean> {
  return (await syncProgress(db)).importing
}

/** Events that leave the app while importing: the connection's state and the card-number notice. */
const PASS_WHILE_IMPORTING = new Set(["connection:state_changed", "card_number:masked"])

/** The ledger status of a delivery whose typed events were held during the import. */
export const HELD = "held"

/**
 * Run one delivery; while the first import is in progress its typed events are
 * held and the delivery is marked `held`, to be played again after the import.
 */
export async function holdWhileImporting<C extends StateCtx & { fetch: unknown }, R>(
  payload: unknown,
  ctx: C,
  run: (ctx: C) => Promise<R>,
): Promise<R> {
  if (!(await importInProgress(ctx.db))) return run(ctx)
  let held = false
  const wrapped = Object.assign(Object.create(Object.getPrototypeOf(ctx) ?? null), ctx, {
    emit: async (e: Parameters<StateCtx["emit"]>[0]) => {
      if (PASS_WHILE_IMPORTING.has(`${e.entity}:${e.action}`)) return ctx.emit(e)
      held = true
    },
  }) as C
  const result = await run(wrapped)
  const eventId = (payload as { id?: unknown } | null)?.id
  if (held && typeof eventId === "string") {
    const rows = (await ctx.db.findMany("webhook_deliveries", {
      where: { event_id: eventId },
      limit: 1,
    })) as Obj[]
    const row = rows[0]
    if (row && row.status === "processed")
      await ctx.db.update("webhook_deliveries", String(row.id), { status: HELD })
  }
  return result
}

const HOLD_TEXT: Record<"key_invalid" | "different_account", string> = {
  key_invalid:
    "Stripe refuses the saved key (401), so nothing was sent to Stripe and nothing changed. The request stays waiting. Next step: an admin saves a working restricted key in the Stripe card, then approve again.",
  different_account:
    "Stripe answers for another account than the one Liaison is connected to, so nothing was sent to Stripe and nothing changed. The request stays waiting. Next step: an admin runs the Stripe key check and saves the key of the connected account, then approve again.",
}

/** A money action's refusal while the connection cannot act, or null when it can. */
export async function moneyActionHold(db: StateDb): Promise<ToolRefusal | null> {
  const install = await readInstall(db)
  if (!install) {
    return refuseTool(
      "not_connected",
      "Stripe is not connected, so nothing was sent to Stripe and nothing changed. Next step: an admin connects Stripe in Settings, Apps, Stripe.",
    )
  }
  const blocked = blockedOverlay(install)
  return blocked ? refuseTool(blocked, HOLD_TEXT[blocked]) : null
}
