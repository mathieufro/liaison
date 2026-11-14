// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Recurring schedules (`/invoicing/recurring`, the sidebar's Schedules row), from
// `recurring_list`, soonest first. Its first line is computed: how many drafts come next, on which
// day, and when they issue. Filters All, Active, Paused; New schedule at the top; three facts
// below. A schedule for a customer who also pays a Stripe subscription only exists with what it
// bills instead, and that text is what its Bills column shows.
import { app, navigate } from "@liaison/host"
import { type Component, createResource, createSignal, For, Show } from "solid-js"
import { contactLabel, loadContact } from "./ContactPicker"
import { tr, uiLocale } from "./i18n"
import { Button, formatMoneyMinor } from "./kit"
import {
  OVERFLOW_PAGE,
  RecurringEmpty,
  RecurringLoadError,
  RecurringLoading,
} from "./RecurringStates"

const TAP = "min-h-11 md:min-h-8"

export interface ListRow {
  id: string
  /** Null once the schedule has ended and its person was deleted. */
  contact_id: string | null
  status: string
  repeats: string
  billing_day: string
  next_issue_on: string | null
  next_draft_on: string | null
  paused_until: string | null
  paid_by?: string
  lines: Array<{
    description: string
    qty: number
    unit_price_minor: number | string
    vat_bp: number
  }>
  bills_other_than_stripe?: string | null
}

export type ListFilter = "all" | "active" | "paused"

/** The people to look up for the rows' names, each once; an ended schedule may have none. */
export function scheduleContactIds(rows: ListRow[]): string[] {
  return [
    ...new Set(
      rows
        .map((r) => r.contact_id)
        .filter((id): id is string => typeof id === "string" && id !== ""),
    ),
  ]
}

const FILTERS: ReadonlyArray<{ value: ListFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
]

const REPEATS: Record<string, string> = { month: "Month", quarter: "Quarter", year: "Year" }
const STATUS: Record<string, string> = {
  draft: "Draft",
  active: "Active",
  paused: "Paused",
  ended: "Ended",
}
const PAID_BY: Record<string, string> = { transfer: "Bank transfer", card_link: "Card link" }

export function filterRows(rows: ListRow[], f: ListFilter): ListRow[] {
  return f === "all" ? rows : rows.filter((r) => r.status === f)
}

/** What the schedule bills: the person's statement when the customer also pays Stripe, else its first line. */
export function billsText(r: ListRow): string {
  const other = r.bills_other_than_stripe?.trim()
  if (other) return other
  const first = r.lines[0]?.description ?? ""
  return first.replace(/,?\s*\{period\}/g, "").trim()
}

/** "Fri 27 Nov": weekday, day, month, in that order whatever the locale's usual order. */
function dayLabel(day: string, locale: string): string {
  // A date-only ISO string parses as UTC midnight, shown here in UTC.
  const d = new Date(day)
  const part = (o: Intl.DateTimeFormatOptions) =>
    d.toLocaleDateString(locale, { ...o, timeZone: "UTC" })
  return `${part({ weekday: "short" })} ${part({ day: "numeric" })} ${part({ month: "short" })}`
}

/** "Soonest first. Next: 7 drafts on Fri 27 Nov, to issue on Mon 30 Nov." from the active schedules. */
export function titleLine(rows: ListRow[], locale = uiLocale()): string {
  const active = rows.filter((r) => r.status === "active" && r.next_draft_on && r.next_issue_on)
  if (active.length === 0) return tr("Soonest first.")
  const first = [...active].sort((a, b) =>
    String(a.next_draft_on).localeCompare(String(b.next_draft_on)),
  )[0] as ListRow
  const n = active.filter((r) => r.next_draft_on === first.next_draft_on).length
  const params = {
    n,
    draft: dayLabel(String(first.next_draft_on), locale),
    issue: dayLabel(String(first.next_issue_on), locale),
  }
  return n === 1
    ? tr("Soonest first. Next: {{n}} draft on {{draft}}, to issue on {{issue}}.", params)
    : tr("Soonest first. Next: {{n}} drafts on {{draft}}, to issue on {{issue}}.", params)
}

function amountOf(r: ListRow): string {
  const net = r.lines.reduce((acc, l) => acc + Number(l.unit_price_minor) * Number(l.qty), 0)
  return `${formatMoneyMinor(Math.round(net), "EUR")} EUR`
}

function everyText(r: ListRow): string {
  const base = tr(REPEATS[r.repeats] ?? r.repeats)
  return r.billing_day === "last" ? `${base}, ${tr("last day")}` : `${base}, ${r.billing_day}`
}

interface Page {
  rows: ListRow[]
  next: string | null
}

async function loadPage(cursor: string | null): Promise<Page> {
  const r = await app.invokeTool<{
    rows?: ListRow[]
    nextCursor?: string | null
    status?: string
    error?: { message?: string }
  }>("recurring_list", {
    limit: OVERFLOW_PAGE,
    ...(cursor ? { cursor } : {}),
  })
  if (!r || r.status === "error" || !Array.isArray(r.rows))
    throw new Error(r?.error?.message ?? "recurring_list failed")
  return { rows: r.rows, next: r.nextCursor ?? null }
}

export const InvoicingRecurringList: Component<{ entityId?: string }> = () => {
  const [filter, setFilter] = createSignal<ListFilter>("all")
  const [more, setMore] = createSignal<ListRow[]>([])
  const [cursor, setCursor] = createSignal<string | null>(null)
  const [page, { refetch }] = createResource(async () => {
    const p = await loadPage(null)
    setMore([])
    setCursor(p.next)
    return p.rows
  })
  const [names] = createResource(
    () => scheduleContactIds([...(page() ?? []), ...more()]),
    async (ids) => {
      const out: Record<string, string> = {}
      await Promise.all(
        ids.map(async (id) => {
          const c = await loadContact(id)
          if (c) out[id] = contactLabel(c)
        }),
      )
      return out
    },
  )
  const rows = () => [...(page() ?? []), ...more()]
  const showMore = async () => {
    const p = await loadPage(cursor())
    setMore([...more(), ...p.rows])
    setCursor(p.next)
  }

  return (
    <section data-testid="recurring-list" class="flex h-full min-h-0 flex-col">
      <header class="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle px-5 py-3.5">
        <div class="flex min-w-0 flex-col">
          <h1 class="text-[15px] font-semibold text-text">{tr("Recurring schedules")}</h1>
          <span data-testid="recurring-title-line" class="text-[12px] text-text-secondary">
            {titleLine(rows())}
          </span>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label={tr("Status")}
            class="inline-flex items-center gap-0.5 rounded-lg border border-border-subtle bg-surface p-0.5"
          >
            <For each={FILTERS}>
              {(f) => (
                <button
                  type="button"
                  data-testid={`recurring-filter-${f.value}`}
                  aria-pressed={filter() === f.value}
                  onClick={() => setFilter(f.value)}
                  class={`rounded-md px-2.5 text-[12px] font-medium ${TAP} ${filter() === f.value ? "bg-surface-active text-text" : "text-text-secondary hover:text-text"}`}
                >
                  {tr(f.label)}
                </button>
              )}
            </For>
          </div>
          <Button
            variant="primary"
            class={TAP}
            testid="new-schedule"
            onClick={() => navigate("/invoicing/schedule/new")}
          >
            {tr("New schedule")}
          </Button>
        </div>
      </header>
      <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4 text-[12.5px]">
        <Show when={!page.loading || page()} fallback={<RecurringLoading />}>
          <Show when={!page.error} fallback={<RecurringLoadError onRetry={() => refetch()} />}>
            <Show when={rows().length > 0} fallback={<RecurringEmpty />}>
              <ul class="flex flex-col divide-y divide-border-subtle">
                {/* Column names, on a wide screen; on a phone each value says what it is. */}
                <li
                  data-testid="recurring-columns"
                  aria-hidden="true"
                  class="hidden gap-x-3 pb-1.5 text-[11.5px] text-text-tertiary md:grid md:grid-cols-[2fr_2fr_1.3fr_1fr_1fr_1fr_0.8fr]"
                >
                  <span>{tr("Customer")}</span>
                  <span>{tr("Bills")}</span>
                  <span>{tr("Repeats")}</span>
                  <span>{tr("Next invoice")}</span>
                  <span class="text-right">{tr("Excl. VAT")}</span>
                  <span>{tr("Paid by")}</span>
                  <span>{tr("Status")}</span>
                </li>
                <For each={filterRows(rows(), filter())}>
                  {(r) => (
                    <li>
                      <a
                        href={`/invoicing/schedule/${r.id}`}
                        data-testid={`schedule-${r.id}`}
                        onClick={(e) => {
                          e.preventDefault()
                          navigate(`/invoicing/schedule/${r.id}`)
                        }}
                        class={`grid grid-cols-2 gap-x-3 gap-y-0.5 py-2.5 hover:bg-surface-hover md:grid-cols-[2fr_2fr_1.3fr_1fr_1fr_1fr_0.8fr] ${TAP}`}
                      >
                        <span class="min-w-0 break-words font-medium text-text">
                          {(r.contact_id ? names()?.[r.contact_id] : undefined) ?? tr("Customer")}
                        </span>
                        <span
                          data-testid={`schedule-bills-${r.id}`}
                          class="min-w-0 break-words text-text-secondary"
                        >
                          {billsText(r)}
                        </span>
                        <span class="text-text-secondary">{everyText(r)}</span>
                        <span class="tabular-nums text-text">
                          <span class="text-text-tertiary md:hidden">{tr("Next invoice")}: </span>
                          {r.status === "paused" && r.paused_until
                            ? tr("Resumes {{day}}", { day: r.paused_until })
                            : (r.next_issue_on ?? "-")}
                        </span>
                        <span class="tabular-nums text-text md:text-right">
                          {amountOf(r)}
                          <span class="text-text-tertiary md:hidden"> {tr("excl. VAT")}</span>
                        </span>
                        <span class="text-text-secondary">
                          {tr(PAID_BY[r.paid_by ?? "transfer"] ?? "Bank transfer")}
                        </span>
                        <span class="text-text-secondary">{tr(STATUS[r.status] ?? r.status)}</span>
                      </a>
                    </li>
                  )}
                </For>
              </ul>
              <Show when={cursor()}>
                <div class="flex items-center gap-3">
                  <span class="text-text-tertiary">
                    {tr("Showing {{n}} schedules", { n: rows().length })}
                  </span>
                  <Button class={TAP} testid="recurring-show-more" onClick={() => void showMore()}>
                    {tr("Show 50 more")}
                  </Button>
                </div>
              </Show>
            </Show>
          </Show>
        </Show>
        <ul data-testid="recurring-facts" class="flex flex-col gap-1 text-text-secondary">
          <li>
            {tr(
              "A draft has no number. It takes the next number in the series when it issues, so a discarded draft leaves no gap.",
            )}
          </li>
          <li>
            {tr(
              "A schedule cannot bill the same period twice. Amounts come from the schedule, not from an agent.",
            )}
          </li>
          <li>
            {tr(
              "Customers who pay by card through Stripe are not here: their invoices follow Who issues what in the issuer settings.",
            )}
          </li>
        </ul>
      </div>
    </section>
  )
}
