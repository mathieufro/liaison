// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Stripe customers list (/stripe/customers): search over the mirror, the Not linked section where
// a person confirms a company, chips with counts, then the rows with problems first. It reads the
// mirror through the app's own tools; it never calls Stripe. Calm: urgency orders, nothing shouts.
import { app, navigate } from "@liaison/host"
import { type Component, createResource, createSignal, For, Show } from "solid-js"
import {
  buildRows,
  CHIPS,
  type Chip,
  type CustomerItem,
  chipLabel,
  countLabel,
  linkOffer,
  listRequest,
  maskedCard,
  PAGE_SIZE,
  planTotals,
  type Suggestion,
  statusOf,
  whatHappensNext,
} from "./customers-model"
import { CONTROL } from "./HomeStates"
import {
  dashboardShown,
  dashboardUrl,
  formatMoney,
  type HomeLoad,
  type InvoiceItem,
  type MrrResult,
  pageKind,
  type SubItem,
} from "./home-model"
import { tr, uiLocale } from "./i18n"

interface Page {
  items: CustomerItem[]
  nextCursor: string | null
}

const SECONDARY = `${CONTROL} border border-border bg-surface text-text hover:bg-surface-hover`
const PRIMARY = `${CONTROL} border border-transparent bg-accent text-bg hover:bg-accent-hover`

export interface ListData {
  customers: CustomerItem[]
  subs: Record<string, SubItem[]>
  retries: Record<string, string | null>
  more: boolean
  cursor: string | null
}

/** One page of the list: the customers the search and chip name, with their subscriptions and retries. */
export async function loadList(
  query: string,
  chip: Chip,
  cursor?: string | null,
): Promise<ListData> {
  const req = listRequest(query, chip, cursor)
  const page = await app
    .invokeTool<Page>(req.tool, req.args)
    .catch(() => ({ items: [], nextCursor: null }) as Page)
  const subs: Record<string, SubItem[]> = {}
  const retries: Record<string, string | null> = {}
  await Promise.all(
    page.items.map(async (c) => {
      const [s, i] = await Promise.all([
        app
          .invokeTool<{ items?: SubItem[] }>("subscriptions_search", {
            customerId: c.id,
            limit: 10,
          })
          .catch(() => ({ items: [] as SubItem[] })),
        app
          .invokeTool<{ items?: InvoiceItem[] }>("invoices_search", {
            customerId: c.id,
            status: "open",
            limit: 5,
          })
          .catch(() => ({ items: [] as InvoiceItem[] })),
      ])
      subs[c.id] = s.items ?? []
      retries[c.id] = (i.items ?? []).map((x) => x.nextPaymentAttempt).find(Boolean) ?? null
    }),
  )
  return {
    customers: page.items,
    subs,
    retries,
    more: page.nextCursor !== null,
    cursor: page.nextCursor,
  }
}

/** The chips' counts, each from the same filtered read, counting up to one page. */
export async function loadCounts(total: number | undefined): Promise<Record<Chip, string>> {
  const count = async (filter?: string) => {
    const r = await app
      .invokeTool<Page>("customers_search", { ...(filter ? { filter } : {}), limit: 50 })
      .catch(() => ({ items: [], nextCursor: null }) as Page)
    return countLabel(r.items.length, r.nextCursor !== null)
  }
  const [unlinked, past_due, trial, cancelled] = await Promise.all([
    count("unlinked"),
    count("past_due"),
    count("trial"),
    count("cancelled"),
  ])
  const all = total !== undefined ? String(total) : await count()
  return { all, subscriptions: "", unlinked, past_due, trial, cancelled }
}

const CustomerLabel: Component<{ c: CustomerItem }> = (p) => (
  <div class="min-w-0">
    <div class="text-[13.5px] font-medium text-text break-words">
      {p.c.name || p.c.email || p.c.id}
    </div>
    <div class="text-[12px] text-text-tertiary break-all">{p.c.name ? p.c.email : p.c.id}</div>
  </div>
)

const NotLinked: Component<{ rows: CustomerItem[]; onLinked: () => void }> = (p) => {
  const [busy, setBusy] = createSignal<string | null>(null)
  const [done, setDone] = createSignal<Record<string, string>>({})
  const [suggest] = createResource(
    () => p.rows,
    async (rows) => {
      const out: Record<string, Suggestion | null> = {}
      await Promise.all(
        rows.map(async (c) => {
          const r = await app
            .invokeTool<{ suggestion?: Suggestion | null }>("customers_get", { id: c.id })
            .catch(() => ({}) as { suggestion?: Suggestion | null })
          out[c.id] = r.suggestion ?? null
        }),
      )
      return out
    },
  )
  const link = async (c: CustomerItem, companyId: string) => {
    setBusy(c.id)
    try {
      await app.invokeTool("customer_link", { stripeCustomerId: c.id, companyId })
      setDone({ ...done(), [c.id]: tr("Linked by you. Nothing changed in Stripe.") })
      p.onLinked()
    } catch {
      setDone({ ...done(), [c.id]: tr("Nothing was linked. Try again, or ask the agent.") })
    } finally {
      setBusy(null)
    }
  }
  return (
    <section
      data-testid="stripe-unlinked"
      class="min-w-0 rounded-lg border border-border-subtle bg-surface"
    >
      <h2 class="flex items-baseline justify-between px-4 py-3 text-[11px] uppercase tracking-wider text-text-tertiary">
        <span>{tr("Not yet linked to a company in Contacts")}</span>
        <span>{p.rows.length}</span>
      </h2>
      <For each={p.rows}>
        {(c) => {
          const offer = () => linkOffer(c, suggest()?.[c.id] ?? null)
          return (
            <div
              data-testid={`stripe-unlinked-${c.id}`}
              class="flex min-w-0 flex-col gap-2 border-t border-border-subtle px-4 py-3 md:flex-row md:items-center md:gap-4"
            >
              <div class="min-w-0 md:w-1/3">
                <CustomerLabel c={c} />
              </div>
              <div class="min-w-0 flex-1 text-[12.5px] text-text-secondary break-words">
                <Show
                  when={done()[c.id]}
                  fallback={
                    <Show
                      when={offer().kind === "suggested" ? offer() : null}
                      fallback={<span>{offer().why}</span>}
                    >
                      {(o) => {
                        const s = () => (o() as { suggestion: Suggestion }).suggestion
                        return (
                          <>
                            <span class="text-text">{s().name}</span>
                            <span class="block text-text-tertiary">{o().why}</span>
                          </>
                        )
                      }}
                    </Show>
                  }
                >
                  <span data-testid={`stripe-unlinked-note-${c.id}`}>{done()[c.id]}</span>
                </Show>
              </div>
              <Show when={!done()[c.id]}>
                <div class="flex flex-wrap gap-2">
                  <Show when={offer().kind === "suggested"}>
                    <button
                      type="button"
                      data-testid={`stripe-link-${c.id}`}
                      disabled={busy() === c.id}
                      class={PRIMARY}
                      onClick={() =>
                        link(c, (offer() as { suggestion: Suggestion }).suggestion.companyId)
                      }
                    >
                      {tr("Link")}
                    </button>
                  </Show>
                  <button
                    type="button"
                    data-testid={`stripe-link-other-${c.id}`}
                    class={SECONDARY}
                    onClick={() => navigate(`/stripe/customers/${c.rowId ?? c.id}`)}
                  >
                    {tr("Another company")}
                  </button>
                  <Show when={offer().kind === "none"}>
                    <button
                      type="button"
                      data-testid={`stripe-create-company-${c.id}`}
                      class={SECONDARY}
                      onClick={() =>
                        navigate(`/contacts/companies/new?name=${encodeURIComponent(c.name ?? "")}`)
                      }
                    >
                      {tr("Create company")}
                    </button>
                    <button
                      type="button"
                      data-testid={`stripe-ask-agent-${c.id}`}
                      class={SECONDARY}
                      onClick={() => navigate(`/stripe/customers/${c.rowId ?? c.id}`)}
                    >
                      {tr("Ask the agent")}
                    </button>
                  </Show>
                </div>
              </Show>
            </div>
          )
        }}
      </For>
    </section>
  )
}

export const StripeCustomersList: Component = () => {
  const locale = uiLocale()
  const [query, setQuery] = createSignal("")
  const [chip, setChip] = createSignal<Chip>("all")
  const [tick, setTick] = createSignal(0)
  const [home] = createResource(() => app.invokeTool<HomeLoad>("home_load", {}).catch(() => null))
  const [mrr] = createResource(() => app.invokeTool<MrrResult>("mrr_query", {}).catch(() => null))
  const [counts] = createResource(
    () => tick(),
    () => loadCounts(home()?.counts?.customers),
  )
  const [data] = createResource(
    () => ({ q: query(), c: chip(), t: tick() }),
    (k) => loadList(k.q, k.c),
  )
  const [unlinked] = createResource(
    () => tick(),
    () =>
      app
        .invokeTool<Page>("customers_search", { filter: "unlinked", limit: 10 })
        .then((r) => r.items)
        .catch(() => [] as CustomerItem[]),
  )
  const rows = () =>
    buildRows(data()?.customers ?? [], data()?.subs ?? {}, chip() === "subscriptions")
  const totals = () => (chip() === "subscriptions" ? planTotals(mrr() ?? null, locale) : [])
  const failed = () => data.error !== undefined
  // Before Stripe is connected nothing was read: say so, never counts of 0 that look fresh.
  const notConnected = () => {
    const h = home()
    return h != null && pageKind(h) === "not_connected"
  }
  return (
    <div data-testid="stripe-customers" class="flex min-w-0 flex-col gap-5 px-4 py-6 md:px-8">
      <header class="flex flex-wrap items-center justify-between gap-3">
        <h1 class="text-[18px] font-semibold text-text">
          {tr("Customers")}{" "}
          <span class="text-[13px] font-normal text-text-tertiary">
            {home()?.counts?.customers ?? ""}
          </span>
        </h1>
        <Show when={dashboardShown(home())}>
          <button
            type="button"
            data-testid="stripe-open-dashboard"
            class={SECONDARY}
            onClick={() =>
              void app.openExternal(dashboardUrl(home()?.connection.mode, "/customers"))
            }
          >
            {tr("Open in Stripe")}
          </button>
        </Show>
      </header>
      <Show
        when={!notConnected()}
        fallback={
          <div
            data-testid="stripe-customers-not-connected"
            class="flex flex-col items-start gap-3 rounded-lg border border-border-subtle bg-surface px-4 py-4 text-[12.5px] text-text-secondary"
          >
            <span class="font-medium text-text">{tr("Stripe is not connected")}</span>
            <span>
              {tr(
                "No customer has been read from Stripe yet. They show here once Stripe is connected.",
              )}
            </span>
            <button
              type="button"
              data-testid="stripe-customers-connect"
              class={SECONDARY}
              onClick={() => navigate("/settings/apps/stripe?open=stripe")}
            >
              {tr("Connect Stripe")}
            </button>
          </div>
        }
      >
        <input
          type="search"
          data-testid="stripe-customers-search"
          class="min-h-11 w-full rounded-lg border border-border-subtle bg-surface px-3 text-[13px] text-text placeholder:text-text-tertiary md:min-h-9"
          placeholder={tr("Search by name, email or Stripe ID, or ask the agent")}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        <Show when={failed()}>
          <div
            data-testid="stripe-customers-error"
            class="rounded-lg border border-border-subtle bg-surface px-4 py-3 text-[12.5px] text-text-secondary"
          >
            {tr("The customers could not be read just now. What was loaded stays below.")}
          </div>
        </Show>
        <Show when={(unlinked() ?? []).length > 0}>
          <NotLinked rows={unlinked() ?? []} onLinked={() => setTick(tick() + 1)} />
        </Show>
        <section class="min-w-0 rounded-lg border border-border-subtle bg-surface">
          <div class="flex flex-wrap items-center gap-2 px-4 py-3">
            <For each={CHIPS}>
              {(c) => (
                <button
                  type="button"
                  data-testid={`stripe-chip-${c}`}
                  aria-pressed={chip() === c}
                  class={`${CONTROL} border border-border-subtle ${chip() === c ? "bg-surface-active text-text" : "text-text-secondary hover:bg-surface-hover"}`}
                  onClick={() => setChip(c)}
                >
                  {chipLabel(c)}{" "}
                  <span class="ml-1.5 text-text-tertiary">{counts()?.[c] ?? ""}</span>
                </button>
              )}
            </For>
            <span class="ml-auto text-[12px] text-text-tertiary">
              {tr("Sorted: problems first, then by name")}
            </span>
          </div>
          <Show when={totals().length > 0}>
            <div
              data-testid="stripe-plan-totals"
              class="flex flex-col gap-1 border-t border-border-subtle px-4 py-3 text-[12.5px] text-text-secondary"
            >
              <For each={totals()}>
                {(t) => (
                  <div
                    data-testid={`stripe-plan-totals-${t.currency}`}
                    class="flex flex-wrap gap-x-4 gap-y-1"
                  >
                    <For each={t.plans}>
                      {(pl) => <span>{`${pl.plan}: ${pl.count}, ${pl.amount}`}</span>}
                    </For>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <Show
            when={rows().length > 0}
            fallback={
              <div
                data-testid="stripe-customers-empty"
                class="border-t border-border-subtle px-4 py-6 text-center text-[12.5px] text-text-secondary"
              >
                {data.loading ? tr("Reading the mirror") : tr("No customer matches.")}
              </div>
            }
          >
            <For each={rows()}>
              {(r) => {
                const st = () => statusOf(r.sub, r.customer, locale)
                return (
                  <a
                    href={`/stripe/customers/${r.customer.rowId ?? r.customer.id}`}
                    data-testid={`stripe-customer-row-${r.customer.id}`}
                    class="flex min-h-11 min-w-0 flex-col gap-1 border-t border-border-subtle px-4 py-3 hover:bg-surface-hover md:grid md:grid-cols-[1.4fr_1fr_0.8fr_1.2fr_0.7fr_1fr] md:items-center md:gap-3"
                    onClick={(e) => {
                      e.preventDefault()
                      navigate(`/stripe/customers/${r.customer.rowId ?? r.customer.id}`)
                    }}
                  >
                    <CustomerLabel c={r.customer} />
                    <span class="text-[12.5px] text-text-secondary">
                      {r.customer.companyId ? tr("Linked") : tr("Not linked")}
                    </span>
                    <span class="text-[12.5px] text-text-secondary">{r.sub?.plan ?? ""}</span>
                    <span
                      data-testid={`stripe-customer-status-${r.customer.id}`}
                      data-tone={st().tone}
                      class="text-[12.5px] text-text"
                    >
                      {st().label}
                    </span>
                    <span class="font-mono text-[12.5px] text-text">
                      {r.sub?.mrrMinor != null
                        ? formatMoney(r.sub.mrrMinor, r.sub.currency ?? "eur", locale)
                        : ""}
                    </span>
                    <span class="text-[12px] text-text-tertiary break-words">
                      {whatHappensNext(r.sub, data()?.retries[r.customer.id] ?? null, locale) ||
                        maskedCard(r.sub?.card)}
                    </span>
                  </a>
                )
              }}
            </For>
          </Show>
          <div class="flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle px-4 py-3 text-[12px] text-text-tertiary">
            <span>
              {tr("Showing {{n}}. Search narrows it, or ask the agent for a list.", {
                n: Math.min(rows().length, PAGE_SIZE),
              })}
            </span>
            <span>
              {tr(
                "Customers billed outside Stripe are not here. Cards show brand, last 4 and expiry only.",
              )}
            </span>
          </div>
        </section>
      </Show>
    </div>
  )
}
