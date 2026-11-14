// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Recurring invoicing's less common situations, shared by the list, the run detail and the
// invoice detail: no schedule yet, loading, a list that cannot load, more rows than one page, a
// Stripe payment with no invoice, and the e-invoice status words with what each one means.
//
// Calm by design: a state is said in words, never with an alarm colour.
import { app, navigate } from "@liaison/host"
import { type Component, createSignal, For, Show } from "solid-js"
import { tr } from "./i18n"
import { Button, ConfirmDialog } from "./kit"

/** Where an invoice stands with the e-invoicing platform: what the document stores. */
export interface EinvoiceFacts {
  einvoice_state: string | null
  collection_state: string | null
  payment_status: string | null
}

/** The seven status words an e-invoice shows, each with what it means. One word per state. */
const WORD = {
  waiting: "Waiting for payment",
  collected: "Collected",
  partly: "Partly collected",
  notNeeded: "Not needed",
  refused: "Refused by the buyer",
  notSent: "Not sent",
  manual: "To report at your platform",
} as const

export const EINVOICE_STATUS_TABLE: ReadonlyArray<{
  key: keyof typeof WORD
  word: string
  means: string
}> = [
  {
    key: "waiting",
    word: WORD.waiting,
    means: "Sent to your e-invoicing platform. The payment is reported once the money is in.",
  },
  {
    key: "collected",
    word: WORD.collected,
    means: "The payment date and the amount per VAT rate went to your e-invoicing platform.",
  },
  {
    key: "partly",
    word: WORD.partly,
    means: "After a part payment or a refund: what really came in was reported.",
  },
  {
    key: "notNeeded",
    word: WORD.notNeeded,
    means:
      "The customer pays the VAT (reverse charge), or you pay it when you invoice, not when paid.",
  },
  {
    key: "refused",
    word: WORD.refused,
    means: "Opens a task for you. It never creates an invoice or credit note by itself.",
  },
  {
    key: "notSent",
    word: WORD.notSent,
    means:
      "The e-invoicing platform did not take it. Liaison tries again, or the invoice says what to fix.",
  },
  {
    key: "manual",
    word: WORD.manual,
    means: "Your platform does not take this report from Liaison, so report the payment there.",
  },
]

const REFUSED = new Set(["refused", "rejected"])
const NOT_SENT = new Set(["failed", "not_in_directory", "routing_mismatch", "send_blocked"])

/**
 * The one status word of an e-invoice, or null for a document that never went to the platform.
 * "Collected" only after the platform accepted the collection report, never from the payment alone.
 */
export function einvoiceStatusWord(f: EinvoiceFacts): string | null {
  const key = einvoiceStatusKey(f)
  return key ? (EINVOICE_STATUS_TABLE.find((r) => r.key === key)?.word ?? null) : null
}

function einvoiceStatusKey(f: EinvoiceFacts): keyof typeof WORD | null {
  if (!f.einvoice_state) return null
  if (REFUSED.has(f.einvoice_state)) return "refused"
  if (NOT_SENT.has(f.einvoice_state) || f.collection_state === "failed") return "notSent"
  if (f.collection_state === "collection_manual") return "manual"
  if (f.collection_state === "not_needed") return "notNeeded"
  if (f.collection_state === "reported")
    return f.payment_status === "partial" ? "partly" : "collected"
  return "waiting"
}

/** What the list says when it cannot load: nothing is lost, runs still happen. */
export const LOAD_ERROR_LINES = {
  title: "Could not load your schedules",
  body: "No invoice is affected. Runs that are due still happen on their own.",
}

/** Rows per page of the list; "Show 50 more" reads the next page. */
export const OVERFLOW_PAGE = 50

/** A Stripe payment with no invoice: the two card actions, each on a gated tool with a confirm. */
export const ORPHAN_ACTIONS: ReadonlyArray<{
  id: string
  tool: string
  label: string
  confirm: string
}> = [
  {
    id: "create",
    tool: "invoice_from_stripe_payment",
    label: "Create the invoice",
    confirm:
      "Create an invoice for this payment? It goes to a person for approval before it gets a number.",
  },
  {
    id: "link",
    tool: "payment_link_to_invoice",
    label: "Link to an invoice",
    confirm:
      "Link this payment to the invoice you picked? Once a person approves, the invoice names this payment; its payment status does not change.",
  },
]

/**
 * The params of an orphan payment's action. "Create the invoice" needs the VAT rate the amount
 * includes (a charge with no Stripe invoice carries none), typed as a percent ("20", "5,5").
 */
export function orphanParams(
  action: string,
  chargeId: string,
  documentId: string | null | undefined,
  vatText: string,
): { params: Record<string, unknown> } | { error: string } {
  if (action === "link") return { params: { chargeId, ...(documentId ? { documentId } : {}) } }
  const t = vatText.trim().replace(",", ".")
  const pct = /^\d{1,2}(\.\d{1,2})?$/.test(t) ? Number(t) : Number.NaN
  if (!Number.isFinite(pct))
    return { error: tr("Type the VAT rate the amount includes, such as 20.") }
  return { params: { chargeId, vatRateBp: Math.round(pct * 100) } }
}

export const RecurringEmpty: Component = () => (
  <div
    data-testid="recurring-empty"
    class="flex flex-col items-start gap-2 rounded-md border border-border-subtle px-4 py-5 text-[12.5px]"
  >
    <div class="text-[13px] font-medium text-text">{tr("No recurring schedules")}</div>
    <div class="text-text-secondary">
      {tr(
        "Use one for a customer you bill on a rhythm outside Stripe. Customers paying by card are already invoiced from Stripe.",
      )}
    </div>
    <Button testid="recurring-empty-new" onClick={() => navigate("/invoicing/schedule/new")}>
      {tr("New schedule")}
    </Button>
  </div>
)

export const RecurringLoading: Component = () => (
  <div data-testid="recurring-loading" class="flex flex-col gap-2" aria-busy="true">
    <For each={[0, 1, 2, 3]}>{() => <div class="h-9 rounded-md bg-surface-hover" />}</For>
  </div>
)

export const RecurringLoadError: Component<{ onRetry: () => void }> = (p) => (
  <div
    data-testid="recurring-load-error"
    class="flex flex-col items-start gap-2 rounded-md border border-border-subtle px-4 py-4 text-[12.5px]"
  >
    <div class="font-medium text-text">{tr(LOAD_ERROR_LINES.title)}</div>
    <div class="text-text-secondary">{tr(LOAD_ERROR_LINES.body)}</div>
    <Button testid="recurring-load-retry" onClick={p.onRetry}>
      {tr("Retry")}
    </Button>
  </div>
)

/** The status list: every word an e-invoice can show, with what it means. */
export const EinvoiceStatusList: Component = () => (
  <dl data-testid="einvoice-status-list" class="flex flex-col gap-2 text-[12.5px]">
    <For each={EINVOICE_STATUS_TABLE}>
      {(row) => (
        <div class="flex flex-col gap-0.5">
          <dt class="font-medium text-text">{tr(row.word)}</dt>
          <dd class="text-text-secondary">{tr(row.means)}</dd>
        </div>
      )}
    </For>
  </dl>
)

/** A run nobody decided by its last day: it waits, nothing issues by itself. */
export const LastDayNote: Component<{ lastDay: string }> = (p) => (
  <p data-testid="recurring-last-day" class="text-[12.5px] text-text-secondary">
    {tr(
      "Nobody approved this run by {{day}}. Nothing issues by itself: it stays at the top of Home until someone decides.",
      { day: p.lastDay },
    )}
  </p>
)

/** A Stripe payment no invoice explains, with its two actions; each asks before it runs. */
export const OrphanPaymentCard: Component<{
  chargeId: string
  amount: string
  documentId?: string | null
}> = (p) => {
  const [asking, setAsking] = createSignal<(typeof ORPHAN_ACTIONS)[number] | null>(null)
  const [note, setNote] = createSignal<string | null>(null)
  const [vat, setVat] = createSignal("20")
  const run = async (a: (typeof ORPHAN_ACTIONS)[number]) => {
    setAsking(null)
    const built = orphanParams(a.id, p.chargeId, p.documentId, vat())
    if ("error" in built) return setNote(built.error)
    try {
      const r = await app.invokeTool<{ status?: string; error?: { message?: string } }>(
        a.tool,
        built.params,
      )
      setNote(
        r?.status === "error"
          ? (r.error?.message ?? tr("Nothing was changed."))
          : tr("Sent for approval."),
      )
    } catch (e) {
      setNote(e instanceof Error ? e.message : tr("Nothing was changed."))
    }
  }
  return (
    <div
      data-testid="recurring-orphan-payment"
      class="flex flex-col gap-2 rounded-md border border-border-subtle px-4 py-3 text-[12.5px]"
    >
      <div class="text-text">
        {tr("A Stripe payment of {{amount}} has no matching invoice.", { amount: p.amount })}
      </div>
      <label class="flex items-center gap-2 text-text-secondary">
        {tr("VAT included in the amount, %")}
        <input
          type="text"
          inputmode="decimal"
          data-testid="recurring-orphan-vat"
          class="w-16 rounded-md border border-border bg-bg px-2 py-1 font-mono text-[12.5px] text-text"
          value={vat()}
          onInput={(e) => setVat(e.currentTarget.value)}
        />
      </label>
      <div class="flex flex-wrap gap-2">
        <For each={ORPHAN_ACTIONS}>
          {(a) => (
            <Button testid={`recurring-orphan-${a.id}`} onClick={() => setAsking(a)}>
              {tr(a.label)}
            </Button>
          )}
        </For>
      </div>
      <Show when={note()}>{(n) => <div class="text-text-secondary">{n()}</div>}</Show>
      <ConfirmDialog
        open={asking() !== null}
        title={tr(asking()?.label ?? "")}
        body={tr(asking()?.confirm ?? "")}
        confirmLabel={tr(asking()?.label ?? "")}
        onConfirm={() => {
          const a = asking()
          if (a) void run(a)
        }}
        onCancel={() => setAsking(null)}
      />
    </div>
  )
}

/** The states, gathered for the tabs that show them. */
export const RecurringStates = {
  Empty: RecurringEmpty,
  Loading: RecurringLoading,
  LoadError: RecurringLoadError,
  StatusList: EinvoiceStatusList,
  LastDay: LastDayNote,
  OrphanPayment: OrphanPaymentCard,
}
