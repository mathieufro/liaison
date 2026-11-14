// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A pending refund as a card: what it refunds, to which card, how much of the charge is still
// refundable, and the ways it can go (edited down, already refunded in Stripe, refused). The actions
// that start something new ("Try again", "Issue the credit note for it") say what they do first.
import { app } from "@liaison/host"
import { type Component, createSignal, For, Show } from "solid-js"
import { maskedCard, type PaymentItem } from "./customers-model"
import { CONTROL } from "./HomeStates"
import { dashboardUrl } from "./home-model"
import { tr, uiLocale } from "./i18n"
import { amountText, decideRefund, type RefundApproval, refundCardView } from "./refund-model"

const SECONDARY = `${CONTROL} border border-border bg-surface text-text hover:bg-surface-hover`
const PRIMARY = `${CONTROL} border border-transparent bg-accent text-bg hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50`

export const RefundCard: Component<{
  approval: RefundApproval
  payment: PaymentItem
  held?: boolean
  mode?: string
  /** The demo's stand-in install: no link out to the Stripe dashboard. */
  standIn?: boolean
  /** Posts a request to the customer's discussion (the credit note). */
  onAsk: (text: string) => Promise<void>
  onChanged: () => void
}> = (p) => {
  const locale = uiLocale()
  const [editing, setEditing] = createSignal(false)
  const [asking, setAsking] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [note, setNote] = createSignal<string | null>(null)
  const [amountInput, setAmountInput] = createSignal("")
  const [amountError, setAmountError] = createSignal<string | null>(null)
  const view = () =>
    refundCardView({ ...p.approval, editing: editing() }, p.payment, locale, p.held)
  const currency = () => p.payment.currency ?? "eur"
  const decide = async (decision: "approve" | "deny") => {
    setBusy(true)
    setNote(null)
    try {
      const edit = editing()
        ? {
            text: amountInput(),
            currency: currency(),
            leftMinor: view().remainderMinor,
            currentMinor: view().amountMinor,
          }
        : null
      const refused = await decideRefund(app, p.approval, decision, edit)
      setAmountError(refused?.error ?? null)
      if (refused) return
      setEditing(false)
      p.onChanged()
    } catch {
      setNote(tr("Nothing was decided. It is still waiting."))
    } finally {
      setBusy(false)
    }
  }
  const run = async (id: string) => {
    if (id === "approve") return decide("approve")
    if (id === "reject") return decide("deny")
    if (id === "edit") {
      setAmountInput(amountText(view().amountMinor, currency()))
      setAmountError(null)
      return setEditing(true)
    }
    if (id === "dismiss") return p.onChanged()
    if (id === "open_stripe")
      return void app.openExternal(dashboardUrl(p.mode, `/payments/${p.payment.id}`))
    // Retry and the credit note each start something new, so they ask for a confirm first.
    setAsking(id)
  }
  const confirm = async () => {
    const id = asking()
    const a = view().actions.find((x) => x.id === id)
    if (!a) return
    setBusy(true)
    try {
      if (id === "retry") {
        // The refused refund's own amount (capped at what is left), the figure the confirm names.
        await app.invokeTool("refunds_create", {
          chargeId: p.payment.id,
          amountMinor: String(view().retryMinor),
        })
        setNote(tr("A new refund is waiting for a person's approval."))
      } else {
        await p.onAsk(
          tr(
            "Please issue the credit note for the refund of {{charge}} already made in Stripe, for my approval.",
            { charge: p.payment.id },
          ),
        )
        setNote(tr("Asked in the discussion. The credit note waits for approval."))
      }
      setAsking(null)
      p.onChanged()
    } catch {
      setNote(tr("Nothing was sent. Try again in a moment."))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div
      data-testid={`stripe-refund-card-${p.approval.id}`}
      data-state={view().state}
      class="min-w-0 rounded-lg border border-border-subtle bg-surface px-4 py-3"
    >
      <div class="text-[11px] uppercase tracking-wider text-text-tertiary">
        {tr("Stripe: refund")}
      </div>
      <div class="mt-1 text-[14px] font-medium text-text break-words">{view().title}</div>
      <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12.5px]">
        <dt class="text-text-tertiary">{tr("Payment")}</dt>
        <dd class="font-mono text-text-secondary break-all">{p.payment.id}</dd>
        <dt class="text-text-tertiary">{tr("To")}</dt>
        <dd data-testid={`stripe-refund-card-to-${p.approval.id}`} class="text-text-secondary">
          {maskedCard(p.payment.card)}
        </dd>
        <dt class="text-text-tertiary">{tr("Refundable")}</dt>
        <dd data-testid={`stripe-refund-remainder-${p.approval.id}`} class="text-text-secondary">
          {view().remainder}
        </dd>
      </dl>
      <Show when={view().state === "editing"}>
        <label class="mt-2 flex flex-col gap-1 text-[12px] text-text-tertiary">
          {tr("Amount to refund, VAT included")}
          <input
            type="text"
            inputmode="decimal"
            data-testid={`stripe-refund-amount-${p.approval.id}`}
            class="w-40 rounded-md border border-border bg-bg px-2 py-1 font-mono text-[13px] text-text"
            value={amountInput()}
            onInput={(e) => setAmountInput(e.currentTarget.value)}
          />
        </label>
        <Show when={amountError()}>
          <p
            data-testid={`stripe-refund-amount-error-${p.approval.id}`}
            class="mt-1 text-[12px] text-text-secondary"
          >
            {amountError()}
          </p>
        </Show>
      </Show>
      <p class="mt-2 text-[12px] text-text-tertiary">{view().note}</p>
      <Show when={asking()}>
        <div
          data-testid={`stripe-refund-confirm-${p.approval.id}`}
          class="mt-3 rounded-md border border-border-subtle bg-bg px-3 py-2 text-[12.5px] text-text-secondary"
        >
          {view().actions.find((a) => a.id === asking())?.confirm}
          <div class="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              data-testid={`stripe-refund-confirm-yes-${p.approval.id}`}
              disabled={busy()}
              class={PRIMARY}
              onClick={confirm}
            >
              {tr("Confirm")}
            </button>
            <button type="button" class={SECONDARY} onClick={() => setAsking(null)}>
              {tr("Cancel")}
            </button>
          </div>
        </div>
      </Show>
      <div class="mt-3 flex flex-wrap items-center gap-2">
        <For each={view().actions.filter((a) => !(p.standIn && a.id === "open_stripe"))}>
          {(a) => (
            <button
              type="button"
              data-testid={`stripe-refund-${a.id}-${p.approval.id}`}
              disabled={busy() || (a.id === "approve" && !view().canApprove)}
              class={a.id === "approve" ? PRIMARY : SECONDARY}
              onClick={() => run(a.id)}
            >
              {a.id === "approve" && p.held ? tr("Held") : a.label}
            </button>
          )}
        </For>
      </div>
      <Show when={note()}>
        <p class="mt-2 text-[12px] text-text-tertiary">{note()}</p>
      </Show>
    </div>
  )
}
