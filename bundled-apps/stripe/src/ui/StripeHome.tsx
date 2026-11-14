// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Stripe home (/stripe): what needs a person first, trials about to end, then monthly recurring
// revenue per currency with the rule it is computed by. It reads the mirror through the app's own
// read tools and this app's pending approvals; it never calls Stripe. Calm by design: urgency orders
// the rows and nothing else, so there are no alarm colours and no counters shouting.
import { app } from "@liaison/host"
import { type Component, createResource, createSignal, For, Show } from "solid-js"
import { mrrRuleLines } from "../mrr"
import { shortDate } from "./customers-model"
import { CONTROL, HomeStates, StaleNotice } from "./HomeStates"
import {
  type ApprovalItem,
  type Attention,
  approveState,
  asOfLine,
  buildAttention,
  buildMrrView,
  canReview,
  type DisputeItem,
  dashboardShown,
  dashboardUrl,
  daysLateLabel,
  daysLeftLabel,
  formatMoney,
  type HomeLoad,
  type InvoiceItem,
  inDaysLabel,
  isFrozen,
  type MrrResult,
  type PageKind,
  pageKind,
  type SubItem,
  toggleReview,
  trialsEnding,
} from "./home-model"
import { tr, uiLocale } from "./i18n"

/** The lines of "How MRR is computed": the query's own, from the same constants. */
/** A dispute's deadline, dated as the rest of the page dates ("Nov 14"), never as ISO. */
export function evidenceDueLine(dueBy: string | null, locale: string): string {
  return dueBy
    ? tr("Evidence is due in Stripe by {{date}}.", { date: shortDate(dueBy, locale) })
    : tr("Evidence is due in Stripe.")
}

export function howComputedLines(locale: "en" | "fr"): string[] {
  return mrrRuleLines(locale)
}

interface HomeData {
  load: HomeLoad | null
  kind: PageKind
  now: Date
  pastDue: SubItem[]
  trialing: SubItem[]
  openInvoices: InvoiceItem[]
  disputes: DisputeItem[]
  approvals: ApprovalItem[]
  mrr: MrrResult | null
  names: Record<string, string>
}

const items = async <T,>(tool: string, args: Record<string, unknown>): Promise<T[]> => {
  try {
    const r = await app.invokeTool<{ items?: T[] }>(tool, args)
    return r?.items ?? []
  } catch {
    return []
  }
}

async function loadHome(): Promise<HomeData> {
  const now = new Date()
  let load: HomeLoad | null = null
  try {
    load = await app.invokeTool<HomeLoad>("home_load", {})
  } catch {
    load = null
  }
  const kind = pageKind(load)
  const empty: HomeData = {
    load,
    kind,
    now,
    pastDue: [],
    trialing: [],
    openInvoices: [],
    disputes: [],
    approvals: [],
    mrr: null,
    names: {},
  }
  if (
    !load ||
    kind === "not_connected" ||
    kind === "waiting" ||
    kind === "empty" ||
    kind === "importing"
  )
    return empty
  const [pastDue, trialing, openInvoices, disputes, approvals, mrr] = await Promise.all([
    items<SubItem>("subscriptions_search", { status: "past_due", limit: 50 }),
    items<SubItem>("subscriptions_search", { status: "trialing", limit: 50 }),
    items<InvoiceItem>("invoices_search", { status: "open", limit: 50 }),
    items<DisputeItem>("disputes_list", { status: "needs_response", limit: 50 }),
    app
      .listMyApprovals()
      .then((r) => r as ApprovalItem[])
      .catch(() => [] as ApprovalItem[]),
    app.invokeTool<MrrResult>("mrr_query", {}).catch(() => null),
  ])
  const data: HomeData = { ...empty, pastDue, trialing, openInvoices, disputes, approvals, mrr }
  const shown = buildAttention({ pastDue, openInvoices, disputes, approvals, now })
  const ids = new Set<string>([
    ...shown.failed.map((f) => f.customerId),
    ...trialsEnding(trialing, now).map((t) => t.customerId),
  ])
  const names: Record<string, string> = {}
  await Promise.all(
    [...ids].slice(0, 40).map(async (id) => {
      try {
        const r = await app.invokeTool<{
          customer?: { name?: string | null; email?: string | null }
        }>("customers_get", { id })
        const n = r?.customer?.name || r?.customer?.email
        if (n) names[id] = n
      } catch {
        // The row says the customer's Stripe id instead.
      }
    }),
  )
  return { ...data, names }
}

const GROUP_HEAD =
  "mb-2 flex items-baseline justify-between gap-3 text-[11px] uppercase tracking-wider text-text-tertiary"
const ROW =
  "flex min-w-0 flex-col gap-2 rounded-lg border border-border-subtle bg-surface px-4 py-3 sm:flex-row sm:items-center sm:gap-4"

const Row: Component<{
  testid: string
  title: string
  detail?: string | null
  side?: string | null
  children?: any
}> = (p) => (
  <div data-testid={p.testid} class={ROW}>
    <div class="min-w-0 flex-1">
      <div class="text-[13.5px] font-medium text-text break-words">{p.title}</div>
      <Show when={p.detail}>
        <div class="mt-0.5 text-[12.5px] text-text-secondary break-words">{p.detail}</div>
      </Show>
    </div>
    <div class="flex flex-wrap items-center gap-2 sm:justify-end">
      {p.children}
      <Show when={p.side}>
        <span class="font-mono text-[11.5px] text-text-tertiary whitespace-nowrap">{p.side}</span>
      </Show>
    </div>
  </div>
)

const AttentionApproval: Component<{ item: ApprovalItem; kind: PageKind; onDone: () => void }> = (
  p,
) => {
  const [busy, setBusy] = createSignal(false)
  const [note, setNote] = createSignal<string | null>(null)
  const state = () => approveState(p.kind)
  const decide = async (decision: "approve" | "deny") => {
    setBusy(true)
    setNote(null)
    try {
      await app.decideApproval(p.item.id, decision, p.item.payloadHash)
      p.onDone()
    } catch {
      // Cancelled in the host's own dialog, or refused: it stays pending.
      setNote(tr("Nothing was decided. It is still waiting."))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div
      data-testid={`stripe-approval-${p.item.id}`}
      class="min-w-0 rounded-lg border border-border-subtle bg-bg px-4 py-3"
    >
      <div class="text-[13px] font-medium text-text break-words">
        {p.item.summary?.title ?? p.item.toolName}
      </div>
      <Show when={p.item.summary?.subtitle}>
        <div class="text-[12px] text-text-tertiary break-words">{p.item.summary?.subtitle}</div>
      </Show>
      <ul class="mt-2 flex flex-col gap-1 text-[12.5px] text-text-secondary">
        <For each={p.item.summary?.lines ?? []}>{(l) => <li class="break-words">{l}</li>}</For>
      </ul>
      <div class="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid={`stripe-approval-approve-${p.item.id}`}
          disabled={!state().enabled || busy()}
          onClick={() => decide("approve")}
          class={`${CONTROL} border border-transparent bg-accent text-bg hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50`}
        >
          {state().label}
        </button>
        <button
          type="button"
          data-testid={`stripe-approval-deny-${p.item.id}`}
          disabled={busy()}
          onClick={() => decide("deny")}
          class={`${CONTROL} border border-border bg-surface text-text hover:bg-surface-hover disabled:opacity-50`}
        >
          {tr("Deny")}
        </button>
        <Show when={state().hint}>
          <span
            data-testid={`stripe-approval-hint-${p.item.id}`}
            class="text-[12px] text-text-tertiary"
          >
            {state().hint}
          </span>
        </Show>
      </div>
      <Show when={note()}>
        <p class="mt-2 text-[12px] text-text-tertiary">{note()}</p>
      </Show>
    </div>
  )
}

const AttentionSection: Component<{
  data: HomeData
  attention: Attention
  names: Record<string, string>
}> = (p) => {
  const locale = uiLocale()
  const [open, setOpen] = createSignal<string | null>(null)
  const frozen = () => isFrozen(p.data.kind)
  const nameOf = (id: string) => p.names[id] ?? id
  const retryMrr = () =>
    Object.entries(p.attention.retrying.mrrByCurrency)
      .map(([cur, minor]) => formatMoney(minor, cur, locale))
      .join(", ")
  return (
    <section data-testid="stripe-attention" class="flex min-w-0 flex-col gap-5">
      <h2
        data-testid="stripe-attention-title"
        class="text-[11px] uppercase tracking-wider text-text-tertiary"
      >
        {tr("Needs attention ({{n}})", { n: p.attention.count })}
      </h2>
      <Show when={p.attention.count === 0 && p.attention.retrying.count === 0}>
        <div
          data-testid="stripe-attention-empty"
          class="rounded-lg border border-border-subtle bg-surface px-4 py-4 text-center text-[12.5px] text-text-secondary"
        >
          {tr(
            "No failed payments, disputes, refund requests or trials ending. Your agents will bring the next one here.",
          )}
        </div>
      </Show>

      <Show when={p.attention.failed.length > 0 || p.attention.retrying.count > 0}>
        <div data-testid="stripe-group-failed" class="flex flex-col gap-2">
          <div class={GROUP_HEAD}>
            <span>{tr("Failed payments")}</span>
            <span class="font-mono normal-case tracking-normal">
              {tr("{{n}} to look at", { n: p.attention.failed.length })}
            </span>
          </div>
          <For each={p.attention.failed}>
            {(f) => (
              <Row
                testid={`stripe-failed-${f.subscriptionId}`}
                title={`${nameOf(f.customerId)}${f.plan ? `: ${f.plan}` : ""}, ${tr("{{amount}} per month", { amount: formatMoney(f.mrrMinor, f.currency, locale) })}`}
                detail={[
                  f.card?.last4
                    ? tr("Card ending {{last4}}.", { last4: f.card.last4 })
                    : tr("No card on file."),
                  f.amountDueMinor !== null
                    ? tr("{{amount}} is unpaid.", {
                        amount: formatMoney(f.amountDueMinor, f.currency, locale),
                      })
                    : null,
                ]
                  .filter(Boolean)
                  .join(" ")}
                side={daysLateLabel(f.daysLate)}
              />
            )}
          </For>
          <Show when={p.attention.retrying.count > 0}>
            <div
              data-testid="stripe-retries-line"
              class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-border-subtle px-4 py-2.5 text-[12.5px] text-text-secondary"
            >
              <span>
                {p.attention.retrying.count === 1
                  ? tr("Stripe is trying 1 more card again by itself. Nothing to do yet.")
                  : tr("Stripe is trying {{n}} more cards again by itself. Nothing to do yet.", {
                      n: p.attention.retrying.count,
                    })}
              </span>
              <span class="font-mono text-[11.5px] text-text-tertiary">
                {tr("{{amount}} of MRR", { amount: retryMrr() })}
              </span>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={p.attention.requests.length > 0}>
        <div data-testid="stripe-group-requests" class="flex flex-col gap-2">
          <div class={GROUP_HEAD}>
            <span>{tr("Requests waiting for you")}</span>
            <span class="font-mono normal-case tracking-normal">{p.attention.requests.length}</span>
          </div>
          <For each={p.attention.requests}>
            {(r) => (
              <>
                <Row
                  testid={`stripe-request-${r.id}`}
                  title={r.summary?.title ?? r.toolName ?? r.id}
                  detail={r.summary?.subtitle ?? null}
                  side={frozen() ? tr("Waits for the key") : tr("Waiting for your approval")}
                >
                  <button
                    type="button"
                    data-testid={`stripe-review-${r.id}`}
                    aria-expanded={open() === r.id}
                    onClick={() => setOpen(toggleReview(p.attention, open(), r.id))}
                    class={`${CONTROL} border border-border bg-surface text-text hover:bg-surface-hover`}
                  >
                    {tr("Review")}
                  </button>
                </Row>
                <Show when={open() === r.id && canReview(p.attention, r.id)}>
                  <AttentionApproval item={r} kind={p.data.kind} onDone={() => setOpen(null)} />
                </Show>
              </>
            )}
          </For>
        </div>
      </Show>

      <Show when={p.attention.disputes.length > 0}>
        <div data-testid="stripe-group-disputes" class="flex flex-col gap-2">
          <div class={GROUP_HEAD}>
            <span>{tr("Disputes")}</span>
            <span class="font-mono normal-case tracking-normal">{p.attention.disputes.length}</span>
          </div>
          <For each={p.attention.disputes}>
            {(d) => {
              const days = () =>
                d.evidenceDueBy
                  ? Math.max(
                      0,
                      Math.ceil((Date.parse(d.evidenceDueBy) - p.data.now.getTime()) / 86_400_000),
                    )
                  : null
              return (
                <Row
                  testid={`stripe-dispute-${d.id}`}
                  title={tr("Disputed {{amount}}", {
                    amount: formatMoney(d.amountMinor ?? 0, d.currency ?? "eur", locale),
                  })}
                  detail={evidenceDueLine(d.evidenceDueBy, locale)}
                  side={days() === null ? null : daysLeftLabel(days() ?? 0)}
                >
                  <Show when={dashboardShown(p.data.load)}>
                    <a
                      href={dashboardUrl(
                        p.data.load?.connection.mode,
                        `/disputes/${encodeURIComponent(d.id)}`,
                      )}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-testid={`stripe-dispute-open-${d.id}`}
                      class={`${CONTROL} border border-border bg-surface text-text hover:bg-surface-hover`}
                    >
                      {tr("Open in Stripe")}
                    </a>
                  </Show>
                </Row>
              )
            }}
          </For>
        </div>
      </Show>
    </section>
  )
}

const TrialsSection: Component<{ data: HomeData; names: Record<string, string> }> = (p) => {
  const rows = () => trialsEnding(p.data.trialing, p.data.now)
  const locale = uiLocale()
  return (
    <Show when={rows().length > 0}>
      <section data-testid="stripe-trials" class="flex flex-col gap-2">
        <div class={GROUP_HEAD}>
          <span>{tr("Trials ending")}</span>
          <span class="font-mono normal-case tracking-normal">
            {tr("{{n}} within 7 days", { n: rows().length })}
          </span>
        </div>
        <For each={rows()}>
          {(t) => (
            <Row
              testid={`stripe-trial-${t.subscriptionId}`}
              title={`${p.names[t.customerId] ?? t.customerId}${t.plan ? `: ${t.plan}` : ""}`}
              detail={
                `${tr("Ends {{date}}.", { date: new Intl.DateTimeFormat(locale.startsWith("fr") ? "fr-FR" : "en", { day: "numeric", month: "short" }).format(new Date(t.endsAt)) })} ` +
                (t.cardOnFile
                  ? tr("Card on file, it starts on its own.")
                  : tr("No card on file. It stops unless someone adds one."))
              }
              side={inDaysLabel(t.days)}
            />
          )}
        </For>
      </section>
    </Show>
  )
}

const MrrSection: Component<{ data: HomeData }> = (p) => {
  const locale = uiLocale()
  const [how, setHow] = createSignal(false)
  const view = () => buildMrrView(p.data.mrr, locale)
  const asOf = () =>
    isFrozen(p.data.kind) || p.data.kind === "stalled"
      ? asOfLine(p.data.mrr?.asOf ?? p.data.load?.connection.lastEventAt, locale)
      : ""
  return (
    <Show when={view()}>
      {(v) => (
        <section
          data-testid="stripe-mrr"
          class="min-w-0 rounded-lg border border-border-subtle bg-surface p-4"
        >
          <h2 class="text-[11px] uppercase tracking-wider text-text-tertiary">
            {tr("Monthly recurring revenue")}
          </h2>
          <For each={v().lines}>
            {(l) => (
              <div
                data-testid={`stripe-mrr-line-${l.currency.toLowerCase()}`}
                class="mt-3 flex min-w-0 flex-col gap-1 border-t border-border-subtle pt-3 first:mt-2 first:border-t-0 first:pt-0"
              >
                <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span
                    data-testid={`stripe-mrr-total-${l.currency.toLowerCase()}`}
                    class="font-mono text-[22px] font-semibold text-text"
                  >
                    {l.total}
                  </span>
                  <span class="text-[12.5px] text-text-secondary">
                    {tr("{{change}} since {{date}}, from {{start}}", {
                      change: l.change,
                      date: l.monthStart,
                      start: l.start,
                    })}
                  </span>
                </div>
                <div class="text-[12.5px] text-text-secondary break-words">
                  {tr("{{n}} paying", { n: l.paying })}
                  <Show
                    when={l.plans.length > 0}
                  >{`: ${l.plans.map((x) => `${x.count} ${x.plan}`).join(", ")}`}</Show>
                </div>
                <Show when={l.movements.length > 0}>
                  <div
                    data-testid={`stripe-mrr-movements-${l.currency.toLowerCase()}`}
                    class="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11.5px] text-text-tertiary"
                  >
                    <For each={l.movements}>{(m) => <span>{`${m.amount} ${m.label}`}</span>}</For>
                  </div>
                </Show>
                <Show when={l.pastDue}>
                  <div class="text-[12px] text-text-tertiary">
                    {tr("{{amount}} of it is past due.", { amount: l.pastDue ?? "" })}
                  </div>
                </Show>
              </div>
            )}
          </For>
          <p data-testid="stripe-mrr-rule" class="mt-3 text-[12px] text-text-tertiary">
            {v().ruleLine}
          </p>
          <Show when={v().incomplete}>
            <p data-testid="stripe-mrr-incomplete" class="mt-1 text-[12px] text-text-tertiary">
              {v().incomplete}
            </p>
          </Show>
          <Show when={asOf()}>
            <p data-testid="stripe-mrr-asof" class="mt-1 text-[12px] text-text-tertiary">
              {tr("As of {{time}}. Not updating.", { time: asOf() })}
            </p>
          </Show>
          <div class="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="stripe-mrr-how-toggle"
              aria-expanded={how()}
              onClick={() => setHow(!how())}
              class={`${CONTROL} border border-border bg-surface text-text hover:bg-surface-hover`}
            >
              {tr("How MRR is computed")}
            </button>
          </div>
          <Show when={how()}>
            <ul
              data-testid="stripe-mrr-how"
              class="mt-3 flex list-disc flex-col gap-1.5 pl-5 text-[12.5px] text-text-secondary"
            >
              <For each={howComputedLines(locale.startsWith("fr") ? "fr" : "en")}>
                {(l) => <li class="break-words">{l}</li>}
              </For>
            </ul>
          </Show>
        </section>
      )}
    </Show>
  )
}

export const StripeHome: Component<{ entityId?: string }> = () => {
  const [data, { refetch }] = createResource(loadHome)
  const locale = uiLocale()
  return (
    <div data-testid="stripe-home" class="flex min-w-0 flex-col gap-5 p-4 pb-dock-runway md:p-5">
      <Show
        when={data()}
        fallback={
          <div data-testid="stripe-home-loading" class="text-[12.5px] text-text-tertiary">
            {tr("Loading Stripe")}
          </div>
        }
      >
        {(d) => {
          const attention = () =>
            buildAttention({
              pastDue: d().pastDue,
              openInvoices: d().openInvoices,
              disputes: d().disputes,
              approvals: d().approvals,
              now: d().now,
            })
          const mode = () => d().load?.connection.mode
          const last = () => asOfLine(d().load?.connection.lastEventAt, locale)
          const showBody = () =>
            ["home", "stalled", "partial", "revoked", "other_account"].includes(d().kind)
          return (
            <>
              <header class="flex flex-wrap items-start justify-between gap-3">
                <div class="min-w-0">
                  <h1 data-testid="stripe-home-title" class="text-[15px] font-semibold text-text">
                    {tr("Stripe")}
                  </h1>
                  <p
                    data-testid="stripe-home-subtitle"
                    class="mt-0.5 text-[12.5px] text-text-secondary break-words"
                  >
                    {d().load && d().kind !== "not_connected"
                      ? [
                          mode() === "live" ? tr("Live account.") : tr("Test mode."),
                          last()
                            ? tr("Last update from Stripe at {{time}}.", { time: last() })
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" ")
                      : tr("Not connected.")}
                  </p>
                </div>
                <Show when={dashboardShown(d().load)}>
                  <a
                    href={dashboardUrl(mode())}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="stripe-open-stripe"
                    class={`${CONTROL} border border-border bg-surface text-text hover:bg-surface-hover`}
                  >
                    {tr("Open Stripe")}
                  </a>
                </Show>
              </header>
              <HomeStates
                load={d().load}
                kind={d().kind}
                now={d().now}
                onChecked={() => refetch()}
              />
              <Show when={d().load && isFrozen(d().kind)}>
                <StaleNotice load={d().load as HomeLoad} />
              </Show>
              <Show when={showBody()}>
                <AttentionSection data={d()} attention={attention()} names={d().names} />
                <TrialsSection data={d()} names={d().names} />
                <MrrSection data={d()} />
              </Show>
            </>
          )
        }}
      </Show>
    </div>
  )
}
