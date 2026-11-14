// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The e-invoicing transmission panel on a document: where the document stands with the
// e-invoicing platform (awaiting approval, being checked, sent, the buyer's platform statuses
// with their official codes, booked), the status history (states inferred from the platform's
// words are marked), and the actions that fit: send (only for an eligible e-invoice; the
// confirmation shows the registry identity the send will bind next to the Liaison contact) and
// refresh. Calm by design: pending states are neutral; only a refusal is called out, in words.
import { app } from "@liaison/host"
import { type Component, createResource, createSignal, For, Show } from "solid-js"
import { tr } from "../i18n"
import { Button, ConfirmDialog, SectionLabel } from "../kit"

export interface LifecycleEntry {
  raw: string | null
  mapped: string | null
  code: number | null
  provider_ts: string | null
  observed_at: string
  source: string
  reason_text?: string | null
  ignored?: string
}

export interface TransmissionRow {
  id: string
  action: "send_einvoice" | "book_sale"
  /** Send attempts are appended; a retry after a terminal failure is attempt n+1. */
  attempt?: number
  state: string
  provider_app: string
  provider_ref: string | null
  lifecycle_state: string | null
  lifecycle_code: number | null
  lifecycle_reason: string | null
  lifecycle_log: LifecycleEntry[]
  approval_method: string | null
  last_error: { code?: string; message?: string } | null
}

export interface SendPreview {
  binding: {
    document_id: string
    legal_original_sha256: string
    buyer_siren: string
    routing_address: string
    attempt?: number
  }
  registry_name: string | null
  registry_city: string | null
  contact_name: string | null
  name_mismatch: boolean
}

export interface TransmissionData {
  status: string
  regime: string | null
  einvoice_state: string | null
  send_approval_id: string | null
  provider_app: string | null
  send_enabled: boolean
  send_preview: SendPreview | null
  send_blocked: string | null
  transmissions: TransmissionRow[]
}

const LIFECYCLE_LABEL: Record<string, string> = {
  imported: "Deposited with the platform",
  deposited: "Deposited",
  sent: "Sent to the buyer's platform",
  accepted: "Taken in charge by the buyer",
  approved: "Approved by the buyer",
  in_dispute: "In dispute",
  refused: "Refused by the buyer",
  rejected: "Rejected by the platform",
  partially_collected: "Partially paid",
  collected: "Paid",
}

/** Rows of the status mapping that are inferred from the platform's words, not documented. */
const INFERRED = new Set([
  "deposited",
  "sent",
  "accepted",
  "approved",
  "in_dispute",
  "partially_collected",
])

const TERMINAL_SEND_STATES = new Set(["failed", "not_in_directory", "routing_mismatch"])

const STATE_LABEL: Record<string, string> = {
  awaiting_send_approval: "Awaiting approval to send",
  send_blocked: "Cannot be sent yet",
  prepared: "Approved, queued for the e-invoicing platform",
  imported: "Deposited, being checked by the platform",
  validation_pending: "Deposited, being checked by the platform",
  send_requested: "Sending to the buyer's platform",
  sent: "Sent",
  failed: "Not sent",
  not_in_directory: "Buyer not reachable on the e-invoicing network",
  routing_mismatch: "Routing address not listed for this buyer",
  booking_prepared: "Approved, queued for booking",
  booked: "Booked in the platform's ledger",
  booking_failed: "Not booked",
}

export interface PanelView {
  visible: boolean
  status: string | null
  /** Only a refusal / rejection / failure is worded as needing attention (never a colour alarm). */
  attention: string | null
  timeline: Array<{
    label: string
    code: number | null
    inferred: boolean
    at: string
    reason: string | null
  }>
  canSend: boolean
  canRefresh: boolean
  blocked: string | null
  confirmBody: string | null
}

export function transmissionPanelView(d: TransmissionData | null): PanelView {
  const empty: PanelView = {
    visible: false,
    status: null,
    attention: null,
    timeline: [],
    canSend: false,
    canRefresh: false,
    blocked: null,
    confirmBody: null,
  }
  if (!d || d.status !== "ok") return empty
  const sends = d.transmissions
    .filter((t) => t.action === "send_einvoice")
    .sort((a, b) => (a.attempt ?? 1) - (b.attempt ?? 1))
  const send = sends[sends.length - 1] ?? null
  const failedForGood = Boolean(send && TERMINAL_SEND_STATES.has(send.state))
  const book = d.transmissions.find((t) => t.action === "book_sale") ?? null
  const tx = send ?? book
  if (d.regime !== "e_invoice" && !tx) return empty
  let status: string | null = null
  let attention: string | null = null
  if (send?.lifecycle_state) {
    const code = send.lifecycle_code ? ` (${send.lifecycle_code})` : ""
    status = `${tr(LIFECYCLE_LABEL[send.lifecycle_state] ?? send.lifecycle_state)}${code}`
    if (send.lifecycle_state === "refused" || send.lifecycle_state === "rejected") {
      attention = tr(
        "The buyer's platform gave this reason: {{reason}}. Decide whether to issue a credit note; nothing is done automatically.",
        {
          reason: send.lifecycle_reason ?? tr("no reason given"),
        },
      )
    }
  } else if (tx) {
    status = tr(STATE_LABEL[tx.state] ?? tx.state)
    if (
      tx.state === "failed" ||
      tx.state === "not_in_directory" ||
      tx.state === "routing_mismatch"
    ) {
      attention = tx.last_error?.message ?? null
    }
  } else if (d.einvoice_state) {
    status = tr(STATE_LABEL[d.einvoice_state] ?? d.einvoice_state)
  } else {
    status = tr("Not sent yet")
  }
  const timeline = (send?.lifecycle_log ?? [])
    .filter((e) => !e.ignored && e.mapped)
    .map((e) => ({
      label: tr(LIFECYCLE_LABEL[e.mapped as string] ?? (e.mapped as string)),
      code: e.code,
      inferred: INFERRED.has(e.mapped as string),
      at: (e.provider_ts ?? e.observed_at).slice(0, 16).replace("T", " "),
      reason: e.reason_text ?? null,
    }))
  const p = d.send_preview
  // After a terminal failure a person may send again (a new attempt under their own decision).
  const canSend = Boolean(
    d.regime === "e_invoice" && (!send || failedForGood) && p && d.provider_app,
  )
  const confirmBody = p
    ? [
        tr("Registry name: {{name}}", { name: p.registry_name ?? "-" }),
        tr("Liaison contact: {{name}}", { name: p.contact_name ?? "-" }),
        ...(p.name_mismatch
          ? [tr("The names differ: check it is the same company before sending.")]
          : []),
        tr("SIREN: {{siren}}", { siren: p.binding.buyer_siren }),
        tr("Registered office: {{city}}", { city: p.registry_city ?? "-" }),
        tr("Routing address: {{address}}", { address: p.binding.routing_address }),
        tr("Sending transmits the Factur-X to the buyer's platform. It cannot be undone."),
      ].join("\n")
    : null
  return {
    visible: true,
    status,
    attention,
    timeline,
    canSend,
    canRefresh: Boolean(send?.provider_ref),
    blocked: (!send || failedForGood) && d.regime === "e_invoice" ? d.send_blocked : null,
    confirmBody,
  }
}

async function load(documentId: string): Promise<TransmissionData | null> {
  try {
    return await app.invokeTool<TransmissionData>("einvoice_transmission_get", {
      document_id: documentId,
    })
  } catch {
    return null
  }
}

export const TransmissionPanel: Component<{ documentId: string }> = (props) => {
  const [data, { refetch }] = createResource(() => props.documentId || null, load)
  const [confirming, setConfirming] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  // Read only once settled (latest while refreshing): a pending read would blank the whole
  // document detail, which renders this panel under its Suspense.
  const settled = () =>
    data.state === "ready" || data.state === "refreshing" ? data.latest : undefined
  const view = () => transmissionPanelView(settled() ?? null)

  const send = async () => {
    const p = settled()?.send_preview
    if (!p) return
    setBusy(true)
    try {
      // An approver's own click is the approval; anyone else's asks a person to approve it.
      await app.invokeTool("einvoice_send", { ...p.binding })
    } finally {
      setBusy(false)
      setConfirming(false)
      refetch()
    }
  }
  const refresh = async () => {
    setBusy(true)
    try {
      await app.invokeTool("einvoice_status_refresh", { document_id: props.documentId })
    } finally {
      setBusy(false)
      refetch()
    }
  }

  return (
    <Show when={view().visible}>
      <div data-testid="document-detail-einvoice-panel" class="flex flex-col gap-1.5">
        <SectionLabel>{tr("E-invoicing platform")}</SectionLabel>
        <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span data-testid="einvoice-panel-status" class="font-medium text-text">
            {view().status}
          </span>
          <Show when={view().canSend}>
            <Button
              testid="einvoice-panel-send"
              disabled={busy()}
              onClick={() => setConfirming(true)}
            >
              {tr("Send through the e-invoicing platform")}
            </Button>
          </Show>
          <Show when={view().canRefresh}>
            <Button
              testid="einvoice-panel-refresh"
              variant="ghost"
              disabled={busy()}
              onClick={refresh}
            >
              {tr("Refresh status")}
            </Button>
          </Show>
        </div>
        <Show when={view().attention}>
          <div data-testid="einvoice-panel-attention" class="text-text-secondary">
            {view().attention}
          </div>
        </Show>
        <Show when={view().blocked}>
          <div data-testid="einvoice-panel-blocked" class="text-text-secondary">
            {view().blocked}
          </div>
        </Show>
        <Show when={view().timeline.length > 0}>
          <ol
            data-testid="einvoice-panel-timeline"
            class="flex flex-col gap-0.5 text-text-secondary"
          >
            <For each={view().timeline}>
              {(e) => (
                <li data-testid="einvoice-panel-timeline-entry">
                  <span class="font-mono text-text-tertiary">{e.at}</span> {e.label}
                  <Show when={e.code}> ({e.code})</Show>
                  <Show when={e.inferred}>
                    <span class="text-text-tertiary"> · {tr("inferred")}</span>
                  </Show>
                  <Show when={e.reason}>: {e.reason}</Show>
                </li>
              )}
            </For>
          </ol>
        </Show>
        <ConfirmDialog
          open={confirming()}
          title={tr("Send this e-invoice?")}
          body={view().confirmBody ?? undefined}
          confirmLabel={tr("Send")}
          busy={busy()}
          onConfirm={send}
          onCancel={() => setConfirming(false)}
          testid="einvoice-panel-confirm"
        />
      </div>
    </Show>
  )
}
