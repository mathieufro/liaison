// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A company's (or a person's) timeline, read at open from each app as the
// reader: mail, tickets, invoices, meetings, deals. Nothing is stored here. The
// route asks every source at once under one deadline; a source that did not
// answer is one notice row with Retry (asking that source alone), and the rest
// shows. The filter menu offers only the sources that returned rows. While the
// route answers there is a static "Reading your apps" line, never a counter.
// A source that only ran out of time is asked once more on its own, quietly,
// a moment after the timeline shows: its rows replace the notice when they come,
// and if it still does not answer the notice simply stays.
import { ChevronDown, CircleX, ListFilter } from "lucide-solid"
import { type Component, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { openEntity } from "~/modules/shell/entity-opener"
import { PopupMenu } from "~/ui/PopupMenu"
import { Skeleton } from "~/ui/Skeleton"

export interface ActivityRow {
  id: string
  at: string
  source: string
  title: string
  who: string | null
  contactId: string | null
  href: { app: string; entityType: string; entityId: string } | null
}

export interface ActivityUnavailable {
  source: string
  label: string
  reason: "timeout" | "error"
}

export interface ActivityPage {
  items: ActivityRow[]
  unavailable: ActivityUnavailable[]
  nextBefore: string | null
  truncatedContacts?: number
  truncatedDeals?: number
}

/** The people each source is asked about (the route's cap). */
export const ACTIVITY_PEOPLE_CAP = 50
const PAGE = 30
/** How long after the timeline shows a source that ran out of time is asked again. */
export const ACTIVITY_REASK_MS = 1000

interface ActivityPanelProps {
  /** The route, e.g. `/contacts/companies/<id>/activity`. */
  path: string
  /** The root data-testid; every part's id is derived from it. */
  testId: string
  /** The section's heading; the filter menu sits on its line. */
  title: string
  /** Shown when no source has any row. */
  emptyText: string
  /** Hands the panel's reload to the page (after a change the timeline shows). */
  ref?: (reload: () => void) => void
}

/** Newest first; on one timestamp by id descending, as the route orders. */
function newestFirst(a: ActivityRow, b: ActivityRow): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

type Bucket = { key: string; label: string }

function bucketOf(at: string, now: Date, t: (k: string) => string, locale: string): Bucket {
  const d = new Date(at)
  if (d.toDateString() === now.toDateString())
    return { key: "today", label: t("contacts.activity.today") }
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) {
    return { key: "month", label: t("contacts.activity.earlierThisMonth") }
  }
  const sameYear = d.getFullYear() === now.getFullYear()
  return {
    key: `${d.getFullYear()}-${d.getMonth()}`,
    label: new Intl.DateTimeFormat(locale, {
      month: "long",
      ...(sameYear ? {} : { year: "numeric" }),
    }).format(d),
  }
}

/**
 * First-page reads in flight, by URL. Two views of one timeline that open
 * together (a page mounted twice as it opens) share one read: each read asks
 * every source, the slow ones included, so a second one at the same moment
 * only doubles their load. A reload asked for after a change never shares.
 */
const firstPageReads = new Map<string, Promise<ActivityPage>>()

function sharedFirstPage(url: string, read: () => Promise<ActivityPage>): Promise<ActivityPage> {
  const pending = firstPageReads.get(url)
  if (pending) return pending
  const started = read().finally(() => {
    if (firstPageReads.get(url) === started) firstPageReads.delete(url)
  })
  firstPageReads.set(url, started)
  return started
}

export const ActivityPanel: Component<ActivityPanelProps> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [rows, setRows] = createSignal<ActivityRow[]>([])
  const [unavailable, setUnavailable] = createSignal<ActivityUnavailable[]>([])
  const [nextBefore, setNextBefore] = createSignal<string | null>(null)
  const [truncatedContacts, setTruncatedContacts] = createSignal(0)
  const [truncatedDeals, setTruncatedDeals] = createSignal(0)
  const [status, setStatus] = createSignal<"loading" | "ready" | "error">("loading")
  const [loadingMore, setLoadingMore] = createSignal(false)
  const [retrying, setRetrying] = createSignal<string | null>(null)
  const [filter, setFilter] = createSignal<string | null>(null)
  const [filterMenuOpen, setFilterMenuOpen] = createSignal(false)
  let seq = 0
  let reaskTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(reaskTimer))

  const tid = (part?: string) => (part ? `${props.testId}.${part}` : props.testId)
  const url = (params: Record<string, string>) =>
    `${props.path}?${new URLSearchParams({ limit: String(PAGE), ...params }).toString()}`

  async function load(opts: { shared?: boolean } = {}): Promise<void> {
    const mine = ++seq
    setStatus("loading")
    try {
      const first = url({})
      const page = opts.shared
        ? await sharedFirstPage(first, () => api.get<ActivityPage>(first))
        : await api.get<ActivityPage>(first)
      if (mine !== seq) return
      setRows([...(page?.items ?? [])].sort(newestFirst))
      setUnavailable(page?.unavailable ?? [])
      setNextBefore(page?.nextBefore ?? null)
      setTruncatedContacts(page?.truncatedContacts ?? 0)
      setTruncatedDeals(page?.truncatedDeals ?? 0)
      setStatus("ready")
      reaskTimedOut(mine)
    } catch {
      if (mine === seq) setStatus("error")
    }
  }

  async function loadOlder(): Promise<void> {
    const before = nextBefore()
    if (!before || loadingMore()) return
    setLoadingMore(true)
    try {
      const page = await api.get<ActivityPage>(url({ before }))
      const known = new Set(rows().map((r) => r.id))
      setRows([...rows(), ...(page?.items ?? []).filter((r) => !known.has(r.id))].sort(newestFirst))
      setNextBefore(page?.nextBefore ?? null)
      // A source that failed on an older page is named too; one that answered is not.
      const answered = new Set((page?.items ?? []).map((r) => r.source))
      const merged = new Map(unavailable().map((u) => [u.source, u]))
      for (const u of page?.unavailable ?? []) merged.set(u.source, u)
      for (const s of answered) merged.delete(s)
      setUnavailable([...merged.values()])
    } catch {
      // The rows shown stay; the button stays to try again.
    } finally {
      setLoadingMore(false)
    }
  }

  /**
   * Once per load, a moment after it shows: ask each source that ran out of time again, on its
   * own and quietly (no busy button, no error if it fails again).
   */
  function reaskTimedOut(load: number): void {
    clearTimeout(reaskTimer)
    const late = unavailable()
      .filter((u) => u.reason === "timeout")
      .map((u) => u.source)
    if (late.length === 0) return
    reaskTimer = setTimeout(() => {
      if (load !== seq) return
      for (const source of late) {
        if (retrying() === source) continue
        if (!unavailable().some((u) => u.source === source)) continue
        void retry(source, { quiet: true, load })
      }
    }, ACTIVITY_REASK_MS)
  }

  /** Ask one source again; its rows join the ones shown, down to the oldest already shown. */
  async function retry(
    source: string,
    opts: { quiet?: boolean; load?: number } = {},
  ): Promise<void> {
    if (!opts.quiet) setRetrying(source)
    try {
      const page = await api.get<ActivityPage>(url({ source }))
      // A reload since the quiet ask started owns the timeline now.
      if (opts.load !== undefined && opts.load !== seq) return
      const failed = (page?.unavailable ?? []).find((u) => u.source === source)
      if (failed) {
        setUnavailable(unavailable().map((u) => (u.source === source ? failed : u)))
        return
      }
      const shown = rows()
      const oldest = nextBefore() ? shown[shown.length - 1] : undefined
      const known = new Set(shown.map((r) => r.id))
      const fresh = (page?.items ?? []).filter(
        (r) => !known.has(r.id) && (!oldest || newestFirst(r, oldest) <= 0),
      )
      setRows([...shown, ...fresh].sort(newestFirst))
      setUnavailable(unavailable().filter((u) => u.source !== source))
    } catch {
      // Still down: the notice stays as it was.
    } finally {
      if (!opts.quiet) setRetrying(null)
    }
  }

  onMount(() => {
    props.ref?.(() => void load())
    void load({ shared: true })
  })

  const sourceLabel = (key: string): string => {
    const known = i18n.t(`contacts.activity.sources.${key}`)
    if (known && known !== `contacts.activity.sources.${key}`) return known
    return unavailable().find((u) => u.source === key)?.label ?? key
  }

  // Only sources that returned rows can be filtered on.
  const sources = createMemo(() => [...new Set(rows().map((r) => r.source))].sort())
  const shown = createMemo(() => {
    const f = filter()
    return f && sources().includes(f) ? rows().filter((r) => r.source === f) : rows()
  })
  const groups = createMemo(() => {
    const now = new Date()
    const out: Array<{ bucket: Bucket; rows: ActivityRow[] }> = []
    for (const row of shown()) {
      const bucket = bucketOf(row.at, now, i18n.t, i18n.locale())
      const last = out[out.length - 1]
      if (last && last.bucket.key === bucket.key) last.rows.push(row)
      else out.push({ bucket, rows: [row] })
    }
    return out
  })

  const when = (at: string): string => {
    const d = new Date(at)
    const today = d.toDateString() === new Date().toDateString()
    return new Intl.DateTimeFormat(
      i18n.locale(),
      today
        ? { hour: "2-digit", minute: "2-digit" }
        : { weekday: "short", day: "numeric", month: "short" },
    ).format(d)
  }

  return (
    <div data-testid={tid()} class="flex flex-col">
      <div class="flex min-h-8 items-center justify-between gap-3 border-b border-border-subtle pb-1">
        <h2 class="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-text-tertiary">
          {props.title}
        </h2>
        <Show when={sources().length > 0}>
          <PopupMenu open={filterMenuOpen()} onOpenChange={setFilterMenuOpen}>
            <PopupMenu.Trigger
              aria-label={i18n.t("contacts.activity.filter")}
              class="flex min-h-8 items-center gap-1 rounded-md px-1.5 text-[12px] text-text-secondary hover:bg-surface-hover hover:text-text"
            >
              <span data-testid={tid("filter")} class="flex items-center gap-1">
                <ListFilter size={12} />
                {filter()
                  ? sourceLabel(filter() as string)
                  : i18n.t("contacts.activity.allActivity")}
                <ChevronDown size={12} />
              </span>
            </PopupMenu.Trigger>
            <PopupMenu.Content aria-label={i18n.t("contacts.activity.filter")} class="min-w-40">
              <PopupMenu.Item data-testid={tid("filter-all")} onSelect={() => setFilter(null)}>
                <span>{i18n.t("contacts.activity.allActivity")}</span>
              </PopupMenu.Item>
              <For each={sources()}>
                {(key) => (
                  <PopupMenu.Item
                    data-testid={tid(`filter-${key}`)}
                    onSelect={() => setFilter(key)}
                  >
                    <span>{sourceLabel(key)}</span>
                  </PopupMenu.Item>
                )}
              </For>
            </PopupMenu.Content>
          </PopupMenu>
        </Show>
      </div>

      <Show when={status() === "loading"}>
        <div data-testid={tid("loading")} class="space-y-2 py-3">
          <p class="text-[12.5px] text-text-tertiary">{i18n.t("contacts.activity.reading")}</p>
          <Skeleton class="h-3 w-3/4" />
          <Skeleton class="h-3 w-2/3" />
          <Skeleton class="h-3 w-3/5" />
        </div>
      </Show>

      <Show when={status() === "error"}>
        <div
          data-testid={tid("error")}
          class="flex items-center justify-between gap-3 py-3 text-[12.5px] text-text-tertiary"
        >
          <span>{i18n.t("contacts.activity.error")}</span>
          <button
            type="button"
            data-testid={tid("error-retry")}
            class="min-h-8 rounded-md border border-border px-2.5 text-text-secondary hover:bg-surface-hover hover:text-text"
            onClick={() => void load()}
          >
            {i18n.t("contacts.activity.retry")}
          </button>
        </div>
      </Show>

      <Show when={status() === "ready"}>
        <For each={unavailable()}>
          {(u) => (
            <div
              data-testid={tid(`unavailable-${u.source}`)}
              class="mt-3 flex items-center gap-3 rounded-md border border-border-subtle px-3 py-2.5 text-[12.5px] text-text-secondary"
            >
              <CircleX size={14} class="shrink-0 text-text-tertiary" />
              <span class="min-w-0 flex-1">
                {i18n.t("contacts.activity.unavailable", { source: u.label })}
              </span>
              <button
                type="button"
                data-testid={tid(`retry-${u.source}`)}
                disabled={retrying() === u.source}
                class="min-h-8 shrink-0 rounded-md border border-border px-2.5 text-text-secondary hover:bg-surface-hover hover:text-text disabled:opacity-60"
                onClick={() => void retry(u.source)}
              >
                {i18n.t("contacts.activity.retry")}
              </button>
            </div>
          )}
        </For>

        <Show when={truncatedContacts() > 0}>
          <p data-testid={tid("truncated-people")} class="mt-3 text-[12px] text-text-tertiary">
            {i18n.t("contacts.activity.truncatedContacts", { count: ACTIVITY_PEOPLE_CAP })}
          </p>
        </Show>
        <Show when={truncatedDeals() > 0}>
          <p data-testid={tid("truncated-deals")} class="mt-1 text-[12px] text-text-tertiary">
            {i18n.t("contacts.activity.truncatedDeals", { count: truncatedDeals() })}
          </p>
        </Show>

        <Show
          when={shown().length > 0}
          fallback={
            <Show when={unavailable().length === 0}>
              <p data-testid={tid("empty")} class="py-3 text-[12.5px] text-text-tertiary">
                {props.emptyText}
              </p>
            </Show>
          }
        >
          <For each={groups()}>
            {(group) => (
              <div class="mt-4">
                <p class="flex items-center gap-3 text-[12px] text-text-tertiary">
                  {group.bucket.label}
                  <span class="h-px flex-1 bg-border-subtle" />
                </p>
                <ul class="mt-1">
                  <For each={group.rows}>
                    {(row) => (
                      <li>
                        <button
                          type="button"
                          data-testid={tid(`row-${row.id}`)}
                          data-source={row.source}
                          disabled={!row.href}
                          class="flex min-h-9 w-full items-baseline gap-3 rounded px-1 py-1.5 text-left text-[13px] enabled:hover:bg-surface-hover"
                          onClick={() => {
                            const h = row.href
                            if (h) void openEntity(api, h.app, h.entityType, h.entityId, row.title)
                          }}
                        >
                          <span class="w-24 shrink-0 font-mono text-[12px] text-text-tertiary">
                            {when(row.at)}
                          </span>
                          <span class="shrink-0 rounded-full border border-border-subtle px-2 text-[11px] text-text-secondary">
                            {sourceLabel(row.source)}
                          </span>
                          <span class="min-w-0 flex-1 text-text">
                            {row.title}
                            <Show when={row.who}>
                              <span class="ml-2 text-text-tertiary">{row.who}</span>
                            </Show>
                          </span>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </div>
            )}
          </For>
        </Show>

        <Show when={nextBefore()}>
          <button
            type="button"
            data-testid={tid("older")}
            disabled={loadingMore()}
            class="mt-4 min-h-8 self-start rounded-md border border-border px-2.5 text-[12px] text-text-secondary hover:bg-surface-hover hover:text-text disabled:opacity-60"
            onClick={() => void loadOlder()}
          >
            {i18n.t("contacts.activity.showOlder")}
          </button>
        </Show>
      </Show>
    </div>
  )
}

export default ActivityPanel
