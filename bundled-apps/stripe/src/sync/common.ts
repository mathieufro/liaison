// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What every sync job shares: the resources it reads, the db and ctx slices it
// uses, a time budget, a pace, and the one way a `sync_state` row moves.
//
// BOUNDED. A job run stops on its own before its deadline (`Budget`), well inside
// the manifest's `timeoutMs`, and leaves its place in `sync_state`; the next tick
// carries on from there.
//
// TWO PROCESSES. Two runs of the same job for the same org may overlap (a slow
// tick and the next one, two workers). Neither takes a lock: every mirror write
// is the compare-and-swap of mirror.ts, and every move of a `sync_state` row is a
// compare-and-swap on the value the run read (`advanceState`). The run that loses
// a swap stops; the one that won carries on. Nothing is counted twice and no
// cursor goes backwards.
import type { StripeHttpCtx } from "../http"
import {
  customerRow,
  disputeRow,
  invoiceRow,
  type MaskTally,
  type MirrorEntity,
  paymentRow,
  refundRow,
  subscriptionRow,
} from "../mirror"

type Obj = Record<string, unknown>

/** The slice of the app's db bridge the sync jobs use. */
export interface SyncDb {
  findMany(
    entity: string,
    opts?: {
      where?: Record<string, unknown>
      limit?: number
      orderBy?: Record<string, "asc" | "desc">
    },
  ): Promise<unknown[]>
  insert(entity: string, data: Record<string, unknown>): Promise<{ id: string }>
  update(entity: string, id: string, data: Record<string, unknown>): Promise<void>
  updateMany(
    entity: string,
    opts: { where: Record<string, unknown>; data: Record<string, unknown> },
  ): Promise<{ count: number }>
  delete(entity: string, id: string): Promise<void>
}

export interface SyncCtx extends StripeHttpCtx {
  db: SyncDb
  emit(event: { entity: string; action: string; entityId?: string; data?: unknown }): Promise<void>
}

/** Test seams: the clock and the run's working time. */
export interface SyncOptions {
  now?: () => Date
  /** How long one run may work before it stops and leaves its place (ms). */
  budgetMs?: number
}

/** One Stripe list the mirror is built from. */
export interface SyncResource {
  resource: string
  entity: MirrorEntity
  list: string
  byId: string
  row: (obj: Obj, tally: MaskTally) => Obj
  /** Extra list parameters: subscriptions are listed in every status. */
  params?: Record<string, string | string[]>
}

/** In the order the first import reads them: customers first, so later rows find their customer. */
export const RESOURCES: readonly SyncResource[] = [
  {
    resource: "customers",
    entity: "stripe_customers",
    list: "/v1/customers",
    byId: "/v1/customers/",
    row: customerRow,
  },
  {
    resource: "subscriptions",
    entity: "stripe_subscriptions",
    list: "/v1/subscriptions",
    byId: "/v1/subscriptions/",
    row: subscriptionRow,
    params: { status: "all", expand: ["data.discounts", "data.default_payment_method"] },
  },
  {
    resource: "invoices",
    entity: "stripe_invoices",
    list: "/v1/invoices",
    byId: "/v1/invoices/",
    row: invoiceRow,
  },
  {
    resource: "charges",
    entity: "stripe_payments",
    list: "/v1/charges",
    byId: "/v1/charges/",
    row: paymentRow,
  },
  {
    resource: "refunds",
    entity: "stripe_refunds",
    list: "/v1/refunds",
    byId: "/v1/refunds/",
    row: refundRow,
  },
  {
    resource: "disputes",
    entity: "stripe_disputes",
    list: "/v1/disputes",
    byId: "/v1/disputes/",
    row: disputeRow,
  },
]

/** A list page: Stripe's largest. */
export const PAGE_SIZE = 100
/** One run's working time; the jobs' `timeoutMs` leaves room above it. */
export const DEFAULT_BUDGET_MS = 45_000

export class Budget {
  private readonly end: number
  constructor(
    private readonly now: () => Date,
    ms: number,
  ) {
    this.end = now().getTime() + ms
  }
  get spent(): boolean {
    return this.now().getTime() >= this.end
  }
}

export interface SyncStateRow {
  id: string
  resource: string
  cursor: string | null
  done_count: number
  total_count: number | null
  status: string
  catchup_due: boolean
  last_error_code: string | null
  updated: unknown
}

export async function readSyncState(db: SyncDb, resource: string): Promise<SyncStateRow | null> {
  const rows = (await db.findMany("sync_state", {
    where: { resource },
    limit: 1,
  })) as SyncStateRow[]
  return rows[0] ?? null
}

/** Every resource row (the per-resource import rows; nothing else lives in `sync_state`). */
export async function readAllSyncState(db: SyncDb): Promise<SyncStateRow[]> {
  const rows = (await db.findMany("sync_state", { limit: 50 })) as SyncStateRow[]
  const known = new Set(RESOURCES.map((r) => r.resource))
  return rows.filter((r) => known.has(r.resource))
}

/** The row for `resource`, created `pending` when missing (a concurrent creator wins and is read back). */
export async function ensureSyncState(
  db: SyncDb,
  resource: string,
  now: Date,
): Promise<SyncStateRow> {
  const existing = await readSyncState(db, resource)
  if (existing) return existing
  try {
    await db.insert("sync_state", {
      resource,
      status: "pending",
      done_count: 0,
      catchup_due: false,
      updated: now.toISOString(),
    })
  } catch {
    // Another run created it first.
  }
  const row = await readSyncState(db, resource)
  if (!row) throw new Error(`sync_state ${resource}: the row could not be created`)
  return row
}

/**
 * Move a `sync_state` row from the state this run read to `data`, only if nobody
 * moved it in between (same cursor, same count). False: another run did; stop.
 */
export async function advanceState(
  db: SyncDb,
  seen: SyncStateRow,
  data: Partial<Omit<SyncStateRow, "id" | "resource">>,
  now: Date,
): Promise<boolean> {
  const { count } = await db.updateMany("sync_state", {
    where: {
      resource: seen.resource,
      cursor: seen.cursor ?? null,
      done_count: seen.done_count,
      status: seen.status,
    },
    data: { ...data, updated: now.toISOString() },
  })
  return count > 0
}

/** A Stripe list page. */
export interface ListPage {
  data: Obj[]
  has_more: boolean
}

export function asPage(body: unknown): ListPage {
  const b = (body ?? {}) as { data?: unknown; has_more?: unknown }
  return {
    data: Array.isArray(b.data) ? (b.data as Obj[]).filter((o) => o && typeof o === "object") : [],
    has_more: b.has_more === true,
  }
}
