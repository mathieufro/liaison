// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One Stripe customer (/stripe/customers/:id): who it is in Liaison, its subscriptions, the card on file
// (brand, last 4, expiry and nothing more), invoices, payments with what is refundable, refunds waiting,
// and disputes as a read-only line. Refund and Cancel only ask in the discussion on the right; the agent
// prepares it and a person approves. Reads the mirror; never calls Stripe.
import { app, navigate } from "@liaison/host"
import {
  type Component,
  createEffect,
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js"
import {
  type CustomerItem,
  cardExpired,
  discussionAsk,
  disputeLine,
  initials,
  invoiceView,
  linkOffer,
  maskedCard,
  type PaymentItem,
  paymentView,
  type Suggestion,
  shortDate,
  statusOf,
  whatHappensNext,
} from "./customers-model"
import { postToDiscussion } from "./discussion"
import { CONTROL } from "./HomeStates"
import {
  type ApprovalItem,
  type DisputeItem,
  dashboardShown,
  dashboardUrl,
  formatMoney,
  type HomeLoad,
  type InvoiceItem,
  type SubItem,
} from "./home-model"
import { tr, uiLocale } from "./i18n"
import { RefundCard } from "./RefundCards"
import { type RefundApproval, refundsOf } from "./refund-model"

const SECONDARY = `${CONTROL} border border-border bg-surface text-text hover:bg-surface-hover`
const PRIMARY = `${CONTROL} border border-transparent bg-accent text-bg hover:bg-accent-hover disabled:opacity-50`

interface Loaded {
  customer: CustomerItem
  subscriptions: SubItem[]
  suggestion: Suggestion | null
  contactSuggestion: { contactId: string; email: string } | null
  invoices: Array<
    InvoiceItem & {
      number?: string | null
      totalMinor?: number | null
      issuer?: string | null
      liaisonDocumentId?: string | null
      liaisonDocumentNumber?: string | null
    }
  >
  payments: PaymentItem[]
  disputes: DisputeItem[]
  approvals: RefundApproval[]
  load: HomeLoad | null
}

export async function loadCustomer(id: string): Promise<Loaded | null> {
  const got = await app
    .invokeTool<{
      customer: CustomerItem
      subscriptions: SubItem[]
      suggestion: Suggestion | null
      contactSuggestion: { contactId: string; email: string } | null
    }>("customers_get", { id })
    .catch(() => null)
  if (!got?.customer) return null
  const cid = got.customer.id
  const [invoices, payments, disputes, approvals, load] = await Promise.all([
    app
      .invokeTool<{ items?: Loaded["invoices"] }>("invoices_search", { customerId: cid, limit: 20 })
      .then((r) => r.items ?? [])
      .catch(() => []),
    app
      .invokeTool<{ items?: PaymentItem[] }>("payments_search", { customerId: cid, limit: 20 })
      .then((r) => r.items ?? [])
      .catch(() => []),
    app
      .invokeTool<{ items?: DisputeItem[] }>("disputes_list", { customerId: cid, limit: 10 })
      .then((r) => r.items ?? [])
      .catch(() => []),
    app
      .listMyApprovals()
      .then((r) => r as ApprovalItem[])
      .catch(() => [] as ApprovalItem[]),
    app.invokeTool<HomeLoad>("home_load", {}).catch(() => null),
  ])
  return {
    ...got,
    suggestion: got.suggestion ?? null,
    contactSuggestion: got.contactSuggestion ?? null,
    invoices,
    payments,
    disputes,
    approvals: approvals as RefundApproval[],
    load,
  }
}

const Section: Component<{ id: string; title: string; hint?: string; children: any }> = (p) => (
  <section data-testid={`stripe-customer-${p.id}`} class="min-w-0">
    <div class="mb-2 flex flex-wrap items-baseline justify-between gap-2 border-b border-border-subtle pb-2">
      <h2 class="text-[11px] uppercase tracking-wider text-text-tertiary">{p.title}</h2>
      <Show when={p.hint}>
        <span class="text-[12px] text-text-tertiary">{p.hint}</span>
      </Show>
    </div>
    {p.children}
  </section>
)

const Line: Component<{ testid?: string; children: any }> = (p) => (
  <div
    data-testid={p.testid}
    class="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border-subtle py-2 text-[13px] text-text"
  >
    {p.children}
  </div>
)

export const StripeCustomerDetail: Component<{ entityId?: string }> = (props) => {
  const locale = uiLocale()
  const [tick, setTick] = createSignal(0)
  const [data] = createResource(
    () => (props.entityId ? { id: props.entityId, t: tick() } : undefined),
    (k) => loadCustomer(k.id),
  )
  const [note, setNote] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const refresh = () => setTick(tick() + 1)
  let anchor: HTMLDivElement | undefined
  createEffect(() => {
    const row = data()?.customer.rowId
    if (!row || !anchor) return
    const h = app.mountEntityDiscussion(anchor, {
      entityType: "customer",
      entityId: row,
      testId: "stripe-customer-discussion",
    })
    onCleanup(() => h.dispose())
  })
  const ask = async (text: string) => {
    const row = data()?.customer.rowId
    if (!row) throw new Error("no row")
    await postToDiscussion(row, text)
  }
  const request = async (kind: "refund" | "cancel", target?: { id: string; label: string }) => {
    const d = data()
    if (!d) return
    setBusy(true)
    try {
      await ask(discussionAsk(kind, d.customer, target))
      setNote(
        kind === "refund"
          ? tr("Asked in the discussion. The agent prepares the refund for your approval.")
          : tr("Asked in the discussion. The agent prepares the cancellation for your approval."),
      )
    } catch {
      setNote(tr("Nothing was sent. Try again in a moment."))
    } finally {
      setBusy(false)
    }
  }
  const link = async (body: Record<string, unknown>, done: string) => {
    const d = data()
    if (!d) return
    setBusy(true)
    try {
      await app.invokeTool("customer_link", { stripeCustomerId: d.customer.id, ...body })
      setNote(done)
      refresh()
    } catch {
      setNote(tr("Nothing was linked. Try again, or ask the agent."))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Show
      when={data()}
      fallback={
        <div
          data-testid="stripe-customer-loading"
          class="px-6 py-8 text-[13px] text-text-secondary"
        >
          {data.loading
            ? tr("Reading the mirror")
            : tr("This customer is not in the Stripe mirror.")}
        </div>
      }
    >
      {(d) => {
        const c = () => d().customer
        const sub = () => d().subscriptions[0] ?? null
        const st = () => statusOf(sub(), c(), locale)
        const card = () =>
          d().subscriptions.find((s) => s.card)?.card ??
          d().payments.find((p) => p.card)?.card ??
          null
        const held = () => d().load?.connection.overlay === "key_invalid"
        const pending = () => refundsOf(d().approvals, d().payments)
        const offer = () => linkOffer(c(), d().suggestion)
        return (
          <div data-testid="stripe-customer" class="flex min-w-0 flex-col md:flex-row">
            <div class="flex min-w-0 flex-1 flex-col gap-6 px-4 py-6 pb-dock-runway md:px-8">
              <header class="flex min-w-0 flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div class="flex min-w-0 items-center gap-4">
                  <div
                    aria-hidden="true"
                    class="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-surface-active text-[16px] font-semibold text-text"
                  >
                    {initials(c().name, c().email)}
                  </div>
                  <div class="min-w-0">
                    <h1
                      data-testid="stripe-customer-name"
                      class="text-[20px] font-semibold text-text break-words"
                    >
                      {c().name || c().email || c().id}
                    </h1>
                    <div class="text-[12px] text-text-tertiary break-all">
                      <span class="font-mono">{c().id}</span>{" "}
                      <span data-testid="stripe-customer-status" data-tone={st().tone}>
                        {st().label}
                      </span>
                    </div>
                  </div>
                </div>
                <div class="flex flex-wrap gap-2">
                  <button
                    type="button"
                    data-testid="stripe-customer-refund"
                    disabled={busy()}
                    class={SECONDARY}
                    onClick={() => request("refund")}
                  >
                    {tr("Refund")}
                  </button>
                  <button
                    type="button"
                    data-testid="stripe-customer-cancel"
                    disabled={busy()}
                    class={SECONDARY}
                    onClick={() =>
                      request(
                        "cancel",
                        sub() ? { id: sub()!.id, label: sub()!.plan ?? sub()!.id } : undefined,
                      )
                    }
                  >
                    {tr("Cancel subscription")}
                  </button>
                  <Show when={dashboardShown(d().load)}>
                    <button
                      type="button"
                      data-testid="stripe-customer-open"
                      class={SECONDARY}
                      onClick={() =>
                        void app.openExternal(
                          dashboardUrl(d().load?.connection.mode, `/customers/${c().id}`),
                        )
                      }
                    >
                      {tr("Open in Stripe")}
                    </button>
                  </Show>
                </div>
              </header>
              <p class="text-[12px] text-text-tertiary">
                {tr("The agent prepares a refund or cancellation for your approval.")}
              </p>
              <Show when={note()}>
                <p
                  data-testid="stripe-customer-note"
                  class="rounded-md border border-border-subtle bg-surface px-3 py-2 text-[12.5px] text-text-secondary"
                >
                  {note()}
                </p>
              </Show>

              <Section
                id="company"
                title={tr("Company")}
                hint={tr("People, deals and tickets are on the company page")}
              >
                <Show
                  when={c().companyId || c().contactId}
                  fallback={
                    <div
                      data-testid="stripe-customer-unlinked"
                      class="flex flex-col gap-2 py-2 text-[13px] text-text-secondary"
                    >
                      <span>
                        {offer().kind === "suggested"
                          ? (offer() as { suggestion: Suggestion }).suggestion.name +
                            ". " +
                            offer().why
                          : offer().why}
                      </span>
                      <Show when={d().contactSuggestion}>
                        {(cs) => (
                          <span data-testid="stripe-customer-contact-suggestion">
                            {tr(
                              "A contact has this email: {{email}}. It is not verified, so a person confirms it.",
                              { email: cs().email },
                            )}
                          </span>
                        )}
                      </Show>
                      <div class="flex flex-wrap gap-2">
                        <Show when={offer().kind === "suggested"}>
                          <button
                            type="button"
                            data-testid="stripe-customer-link"
                            disabled={busy()}
                            class={PRIMARY}
                            onClick={() =>
                              link(
                                {
                                  companyId: (offer() as { suggestion: Suggestion }).suggestion
                                    .companyId,
                                },
                                tr("Linked by you. Nothing changed in Stripe."),
                              )
                            }
                          >
                            {tr("Link")}
                          </button>
                        </Show>
                        <Show when={d().contactSuggestion}>
                          {(cs) => (
                            <button
                              type="button"
                              data-testid="stripe-customer-link-contact"
                              disabled={busy()}
                              class={SECONDARY}
                              onClick={() =>
                                link(
                                  { contactId: cs().contactId },
                                  tr("Linked by you. Nothing changed in Stripe."),
                                )
                              }
                            >
                              {tr("Link this contact")}
                            </button>
                          )}
                        </Show>
                      </div>
                    </div>
                  }
                >
                  <Line testid="stripe-customer-linked">
                    <span class="min-w-0 break-words">
                      <Show when={c().companyId} fallback={tr("Linked to a contact")}>
                        <a
                          href={`/contacts/companies/${c().companyId}`}
                          class="inline-flex min-h-11 items-center underline-offset-2 hover:underline md:min-h-0"
                          onClick={(e) => {
                            e.preventDefault()
                            navigate(`/contacts/companies/${c().companyId}`)
                          }}
                        >
                          {tr("Open the company")}
                        </a>
                      </Show>
                      <Show when={c().linkedBy}>
                        <span class="ml-2 text-[12px] text-text-tertiary">
                          {c().linkedBy === "person"
                            ? tr("Linked by a person.")
                            : tr("Linked by matching.")}
                        </span>
                      </Show>
                    </span>
                    <button
                      type="button"
                      data-testid="stripe-customer-unlink"
                      disabled={busy()}
                      class={SECONDARY}
                      onClick={() =>
                        link({ unlink: true }, tr("Unlinked. Nothing changed in Stripe."))
                      }
                    >
                      {tr("Unlink")}
                    </button>
                  </Line>
                </Show>
              </Section>

              <Section id="subscriptions" title={tr("Subscriptions")}>
                <For
                  each={d().subscriptions}
                  fallback={
                    <p class="py-2 text-[13px] text-text-secondary">{tr("No subscription.")}</p>
                  }
                >
                  {(s) => (
                    <Line testid={`stripe-customer-sub-${s.id}`}>
                      <span>{s.plan ?? s.id}</span>
                      <span class="text-[12.5px] text-text-secondary">
                        {statusOf(s, c(), locale).label}
                      </span>
                      <span class="font-mono">
                        {s.mrrMinor != null
                          ? formatMoney(s.mrrMinor, s.currency ?? "eur", locale)
                          : ""}
                      </span>
                      <span class="text-[12px] text-text-tertiary">
                        {whatHappensNext(s, null, locale)}
                      </span>
                      <span class="font-mono text-[11.5px] text-text-tertiary break-all">
                        {s.id}
                      </span>
                    </Line>
                  )}
                </For>
              </Section>

              <Section
                id="card"
                title={tr("Payment method")}
                hint={tr("Liaison keeps only the brand, last 4 and expiry")}
              >
                <Line testid="stripe-customer-card-line">
                  <span>{maskedCard(card())}</span>
                  <Show when={cardExpired(card(), new Date())}>
                    <span class="text-[12.5px] text-text-secondary">{tr("Expired")}</span>
                  </Show>
                </Line>
                <p class="py-2 text-[12.5px] text-text-secondary">
                  {tr(
                    "A new card goes on a page hosted by Stripe. No screen or agent here takes a card number.",
                  )}
                </p>
              </Section>

              <Section id="invoices" title={tr("Invoices")}>
                <For
                  each={d().invoices}
                  fallback={
                    <p class="py-2 text-[13px] text-text-secondary">{tr("No invoices.")}</p>
                  }
                >
                  {(i) => {
                    const v = () => invoiceView(i, locale)
                    return (
                      <Line testid={`stripe-customer-invoice-${i.id}`}>
                        <Show
                          when={v().documentId}
                          fallback={<span class="font-mono">{v().number ?? i.id}</span>}
                        >
                          {(doc) => (
                            <a
                              data-testid={`stripe-customer-invoice-document-${i.id}`}
                              href={`/invoicing/document/${doc()}`}
                              class="inline-flex min-h-11 items-center font-mono underline-offset-2 hover:underline md:min-h-0"
                              onClick={(e) => {
                                e.preventDefault()
                                navigate(`/invoicing/document/${doc()}`)
                              }}
                            >
                              {v().number ?? i.id}
                            </a>
                          )}
                        </Show>
                        <span class="text-[12.5px] text-text-secondary">{v().statusLabel}</span>
                        <span class="font-mono">{v().total}</span>
                        <span class="text-[12px] text-text-tertiary">{v().issuedLabel}</span>
                      </Line>
                    )
                  }}
                </For>
              </Section>

              <Section id="payments" title={tr("Payments")} hint={tr("Newest first")}>
                <For
                  each={d().payments}
                  fallback={
                    <p class="py-2 text-[13px] text-text-secondary">{tr("No payments.")}</p>
                  }
                >
                  {(p) => {
                    const v = () => paymentView(p, locale)
                    return (
                      <Line testid={`stripe-customer-payment-${p.id}`}>
                        <span class="text-[12px] text-text-tertiary">
                          {shortDate(p.at, locale)}
                        </span>
                        <span class="font-mono">{v().amount}</span>
                        <span class="text-[12.5px] text-text-secondary">{v().statusLabel}</span>
                        <span class="min-w-0 flex-1 text-[12.5px] text-text-secondary break-words">
                          {v().detail}
                        </span>
                        <Show when={v().refunded}>
                          <span
                            data-testid={`stripe-customer-payment-refunded-${p.id}`}
                            class="text-[12px] text-text-tertiary"
                          >
                            {tr("Refunded {{amount}}", { amount: v().refunded ?? "" })}
                          </span>
                        </Show>
                        <Show when={v().refundable}>
                          {(r) => (
                            <button
                              type="button"
                              data-testid={`stripe-customer-refund-${p.id}`}
                              disabled={busy()}
                              class={SECONDARY}
                              onClick={() => request("refund", { id: p.id, label: r().label })}
                            >
                              {tr("Refund {{amount}}", { amount: r().label })}
                            </button>
                          )}
                        </Show>
                        <span class="font-mono text-[11.5px] text-text-tertiary break-all">
                          {p.id}
                        </span>
                      </Line>
                    )
                  }}
                </For>
              </Section>

              <Show when={pending().length > 0}>
                <Section id="refunds" title={tr("Refunds waiting")}>
                  <div class="flex flex-col gap-3">
                    <For each={pending()}>
                      {(r) => (
                        <RefundCard
                          approval={r.approval}
                          payment={r.payment}
                          held={held()}
                          mode={d().load?.connection.mode}
                          standIn={!dashboardShown(d().load)}
                          onAsk={ask}
                          onChanged={refresh}
                        />
                      )}
                    </For>
                  </div>
                </Section>
              </Show>

              <Section id="disputes" title={tr("Disputes")}>
                <For
                  each={d().disputes}
                  fallback={
                    <p class="py-2 text-[13px] text-text-secondary">{tr("No disputes, ever.")}</p>
                  }
                >
                  {(x) => (
                    <Line testid={`stripe-customer-dispute-${x.id}`}>
                      <span>{disputeLine(x, locale).text}</span>
                      <span class="text-[12px] text-text-tertiary">
                        {tr("Answer it in Stripe")}
                      </span>
                    </Line>
                  )}
                </For>
              </Section>
            </div>
            <aside class="min-w-0 border-t border-border-subtle px-4 py-6 md:w-[22rem] md:shrink-0 md:border-l md:border-t-0">
              <h2 class="mb-3 text-[11px] uppercase tracking-wider text-text-tertiary">
                {tr("Discussion")}
              </h2>
              <div ref={anchor} data-testid="stripe-customer-discussion-mount" />
            </aside>
          </div>
        )
      }}
    </Show>
  )
}
