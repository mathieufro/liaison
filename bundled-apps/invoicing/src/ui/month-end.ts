// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What the month-end panel computes, apart from drawing it: which rows the card covers and their
// total as typed, which rows fold away on a long run, what each viewer may do, and what changed
// since the panel was drawn.
import { AMOUNT_CHECK } from "../recurring/flags"
import { tr } from "./i18n"

/** One row as `recurring_run_get` returns it. */
export interface RunRow {
  item_id: string
  draft_id: string | null
  document_id: string
  state: string
  customer: string | null
  account_manager: string | null
  net_minor: string
  vat_minor: string
  total_minor: string
  currency: string
  number: string | null
  updated_at: string | null
  latest_change: Record<string, unknown> | null
  flags: string[]
  failure: unknown
  /** An address an agent found for a row that has none; a person uses it. Absent when none. */
  fix_suggestion?: Record<string, unknown> | null
}

/** One row of the card's payload: what approving it covers. */
export interface CardItem {
  item_id: string
  document_id: string
  content_hash: string
  total_minor: string
}

export interface Amounts {
  net: bigint
  vat: bigint
  total: bigint
}

/** Above this many rows, rows with nothing to look at fold away. */
export const FOLD_ABOVE = 20

const big = (v: string | null | undefined): bigint => {
  try {
    return BigInt(v ?? "0")
  } catch {
    return 0n
  }
}

export function savedAmounts(row: RunRow): Amounts {
  return { net: big(row.net_minor), vat: big(row.vat_minor), total: big(row.total_minor) }
}

/** A row's amounts: as typed when it is open and changed, else as saved. */
export function rowAmounts(row: RunRow, typed: ReadonlyMap<string, Amounts>): Amounts {
  return typed.get(row.item_id) ?? savedAmounts(row)
}

/** The rows the card covers ("Approve N") and their total, typed values included. */
export function approveSummary(
  rows: RunRow[],
  items: CardItem[],
  typed: ReadonlyMap<string, Amounts>,
): { count: number; net: bigint; vat: bigint; total: bigint; currency: string } {
  const onCard = new Set(items.map((i) => i.item_id))
  let net = 0n
  let vat = 0n
  let total = 0n
  let count = 0
  for (const row of rows) {
    if (!onCard.has(row.item_id)) continue
    const a = rowAmounts(row, typed)
    net += a.net
    vat += a.vat
    total += a.total
    count += 1
  }
  return { count, net, vat, total, currency: rows[0]?.currency ?? "EUR" }
}

const SAME_AS = /^Same as (.+)$/

/** A flag saying the row bills far from the last invoice of its schedule: read before approving. */
export function isAmountCheck(flag: string): boolean {
  return flag.startsWith(AMOUNT_CHECK)
}

/** A row someone may want to read before approving: not ready, changed, flagged. */
export function needsLook(row: RunRow): boolean {
  if (row.state !== "ready") return true
  if (row.latest_change && row.latest_change.event !== "drafted") return true
  return !(row.flags.length > 0 && row.flags.every((f) => SAME_AS.test(f)))
}

/**
 * On a long run, rows with nothing to look at fold under one line ("280 same as October"); they
 * stay in "Approve N" and the total. A search by customer name reaches every row.
 */
export function foldRows(
  rows: RunRow[],
  query: string,
): { shown: RunRow[]; folded: RunRow[]; foldLabel: string | null } {
  const q = query.trim().toLowerCase()
  if (q)
    return {
      shown: rows.filter((r) => (r.customer ?? "").toLowerCase().includes(q)),
      folded: [],
      foldLabel: null,
    }
  if (rows.length <= FOLD_ABOVE) return { shown: rows, folded: [], foldLabel: null }
  const shown = rows.filter(needsLook)
  const folded = rows.filter((r) => !needsLook(r))
  if (folded.length === 0) return { shown, folded, foldLabel: null }
  const month = SAME_AS.exec(folded[0]?.flags[0] ?? "")?.[1] ?? ""
  return { shown, folded, foldLabel: tr("{{n}} same as {{month}}", { n: folded.length, month }) }
}

/** Whether a scope list grants `wanted` (a parent grants its children, `*` grants all). */
export function grants(scopes: readonly string[], wanted: string): boolean {
  const parts = wanted.split(":")
  for (const s of scopes) {
    if (s === "*" || s === wanted) return true
    for (let i = 1; i < parts.length; i++) if (s === parts.slice(0, i).join(":")) return true
  }
  return false
}

export interface Rights {
  /** Edit, add and take out rows. */
  write: boolean
  /** Decide the card. */
  approve: boolean
}

export function rightsOf(scopes: readonly string[], canDecide: boolean): Rights {
  return { write: grants(scopes, "invoicing:documents:write"), approve: canDecide }
}

/** The sentence a waiting row carries, before the Approve button. */
export function waitingSentence(row: RunRow): string | null {
  if (row.state === "needs_fix") {
    return tr(
      "{{customer}} waits for a fix: it stays a draft, uses no number and comes back to you once fixed.",
      {
        customer: row.customer ?? tr("This row"),
      },
    )
  }
  if (row.state === "waiting_reapproval")
    return tr("Changed after approval: it waits for this card, the others issue on time.")
  return null
}

/** When the Number column fills in. */
export function numberCell(row: RunRow, issueOn: string | null): string {
  if (row.number) return row.number
  if (row.state === "left_out") return tr("None, taken out")
  if (row.state === "needs_fix") return tr("None until fixed")
  return issueOn ? tr("On {{day}}", { day: issueOn }) : tr("At issue")
}

/** Who made a row's latest change, in words; never a person for their agent. */
export function changedBy(
  change: Record<string, unknown> | null,
  names: ReadonlyMap<string, string>,
): string | null {
  if (!change || change.event === "drafted") return null
  const person =
    typeof change.actor_user_id === "string"
      ? (names.get(change.actor_user_id) ?? tr("a teammate"))
      : null
  if (typeof change.routine_id === "string") return tr("Changed by a routine")
  if (typeof change.agent_id === "string")
    return tr("Changed by {{name}}'s agent", { name: person ?? tr("a teammate") })
  if (person) return tr("Changed by {{name}}", { name: person })
  return null
}

export interface RunChange {
  item_id: string
  customer: string
  kind: "changed" | "added" | "removed"
  who: string | null
  before: bigint
  after: bigint
}

/**
 * What changed between the card the panel drew and the card now: rows whose hash moved, rows that
 * joined, rows that left; with who made each row's latest change, and both totals.
 */
export function runChanges(
  shown: CardItem[],
  now: CardItem[],
  rows: RunRow[],
  names: ReadonlyMap<string, string>,
): { changes: RunChange[]; before: bigint; after: bigint } {
  const was = new Map(shown.map((i) => [i.item_id, i]))
  const is = new Map(now.map((i) => [i.item_id, i]))
  const byItem = new Map(rows.map((r) => [r.item_id, r]))
  const changes: RunChange[] = []
  const name = (id: string) => byItem.get(id)?.customer ?? tr("A row")
  const who = (id: string) => changedBy(byItem.get(id)?.latest_change ?? null, names)
  for (const item of now) {
    const old = was.get(item.item_id)
    if (!old)
      changes.push({
        item_id: item.item_id,
        customer: name(item.item_id),
        kind: "added",
        who: who(item.item_id),
        before: 0n,
        after: big(item.total_minor),
      })
    else if (old.content_hash !== item.content_hash)
      changes.push({
        item_id: item.item_id,
        customer: name(item.item_id),
        kind: "changed",
        who: who(item.item_id),
        before: big(old.total_minor),
        after: big(item.total_minor),
      })
  }
  for (const item of shown) {
    if (!is.has(item.item_id))
      changes.push({
        item_id: item.item_id,
        customer: name(item.item_id),
        kind: "removed",
        who: who(item.item_id),
        before: big(item.total_minor),
        after: 0n,
      })
  }
  const sum = (items: CardItem[]) => items.reduce((t, i) => t + big(i.total_minor), 0n)
  return { changes, before: sum(shown), after: sum(now) }
}

/** The address fields a row's fix may set (`drafts_update` patch keys). */
const ADDRESS_FIELDS = [
  "counterparty_address",
  "billing_line1",
  "billing_postcode",
  "billing_city",
  "billing_country_code",
] as const

/** The address an agent found for a row, as a patch and as one line to read; null when none. */
export function suggestedAddress(
  row: RunRow,
): { patch: Record<string, string>; text: string } | null {
  const found = row.fix_suggestion
  if (!found || typeof found !== "object") return null
  const patch: Record<string, string> = {}
  for (const k of ADDRESS_FIELDS) {
    const v = found[k]
    if (typeof v === "string" && v.trim()) patch[k] = v.trim()
  }
  const keys = Object.keys(patch)
  if (keys.length === 0) return null
  const text =
    patch.counterparty_address ??
    [
      patch.billing_line1,
      [patch.billing_postcode, patch.billing_city].filter(Boolean).join(" "),
      patch.billing_country_code,
    ]
      .filter(Boolean)
      .join(", ")
  return { patch, text }
}

/** One schedule as `recurring_list` returns it, the part "Add an invoice someone forgot" reads. */
export interface ScheduleOption {
  id: string
  /** Null once the schedule has ended and its person was deleted. */
  contact_id: string | null
  lines: Array<{
    description: string
    qty: number | string
    unit_price_minor: number | string
    vat_bp?: number
    line_kind?: string
  }>
}

/** The `drafts_create` lines for a schedule's invoice of one period, `{period}` filled as the draft job fills it. */
export function scheduleItems(s: ScheduleOption, period: string): Array<Record<string, unknown>> {
  return s.lines.map((l, i) => ({
    position: i + 1,
    description: String(l.description).split("{period}").join(period),
    quantity: String(l.qty),
    unit_price_minor: String(l.unit_price_minor),
    ...(typeof l.vat_bp === "number" ? { tax_rate_bp_override: l.vat_bp } : {}),
    ...(l.line_kind ? { line_kind: l.line_kind } : {}),
  }))
}

/** Schedules whose customer has no row in the run yet, by name (the run refuses a true duplicate itself). */
export function missingSchedules<T extends { name: string }>(options: T[], rows: RunRow[]): T[] {
  const billed = new Set(rows.map((r) => (r.customer ?? "").trim().toLowerCase()).filter(Boolean))
  return options.filter((o) => !billed.has(o.name.trim().toLowerCase()))
}

/** A row the draft job held for want of an address (`recurring/item-state.ts`, `NO_ADDRESS`). */
export function lacksAddress(row: RunRow): boolean {
  return (
    row.state === "needs_fix" &&
    (row.flags.includes("No billing address") || suggestedAddress(row) !== null)
  )
}
