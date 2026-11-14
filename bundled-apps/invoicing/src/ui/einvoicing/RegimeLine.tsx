// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The e-invoicing regime line on a document: the regime in plain words and its one-line reason
// (in the reader's language), plus a calm note when data is still to complete: an issued
// document that went out in warn mode, or a draft the gate would refuse. Every gap carries one
// action. Never an alarm colour: a missing SIREN is work to do, not an emergency.
import { app, navigate } from "@liaison/host"
import { type Component, createResource, For, Show } from "solid-js"
import { tr, uiLocale } from "../i18n"
import { SectionLabel } from "../kit"
import {
  type BlockerAction,
  type BlockerContext,
  blockerAction,
  type ClassifyVerdict,
  type MissingItem,
  missingSummary,
  type Regime,
  type RegimeReason,
} from "./blockers"

const REGIME_LABEL: Record<Regime, string> = {
  e_invoice: "E-invoice",
  e_reporting: "E-reporting",
  out_of_scope: "Out of scope",
  needs_review: "Awaiting a decision",
}

export interface RegimeLineView {
  label: string
  reason: string | null
  /** Data still to complete, in plain words; null when nothing is missing. */
  note: string | null
  /** One action per distinct place a gap is fixed. */
  actions: Array<Extract<BlockerAction, { kind: "open" }>>
  /** Always neutral (calm UI): the regime line never raises an alarm. */
  tone: "neutral"
}

function reasonText(r: RegimeReason): string | null {
  const text = uiLocale().startsWith("fr") ? (r.fr ?? r.en) : (r.en ?? r.fr)
  return text ?? null
}

export function regimeLineView(v: ClassifyVerdict, ctx: BlockerContext): RegimeLineView {
  const reasons = v.reasons ?? []
  const warning = reasons.find((r) => r.code === "gate_warning")
  const main = reasons.find(
    (r) => r.code !== "gate_warning" && r.code !== "buyer_siren_from_identity",
  )
  let missing: MissingItem[] = []
  let note: string | null = null
  if (warning) {
    // Issued in warn mode: the issued document is never rewritten, so its gaps are fixed on the
    // customer's identity, which every later document reads.
    missing = (warning.missing ?? []).map((field) => ({
      field,
      fix_tool: "counterparty_identity_set",
    }))
    note = tr("Issued with e-invoicing data to complete: {{fields}}.", {
      fields: missingSummary(missing),
    })
  } else if (v.would_refuse && v.would_refuse.missing.length > 0) {
    missing = v.would_refuse.missing
    note = tr("Before issuing, complete: {{fields}}.", { fields: missingSummary(missing) })
  }
  const actions: RegimeLineView["actions"] = []
  for (const m of missing) {
    const a = blockerAction(m, { ...ctx, inEditor: false })
    if (a.kind === "open" && !actions.some((x) => x.href === a.href)) actions.push(a)
  }
  return {
    label: v.regime ? tr(REGIME_LABEL[v.regime]) : tr("Not classified yet"),
    reason: main
      ? reasonText(main)
      : v.regime
        ? null
        : tr("It is not yet known whether this invoice goes through the e-invoicing platform."),
    note,
    actions,
    tone: "neutral",
  }
}

async function loadVerdict(documentId: string): Promise<ClassifyVerdict | null> {
  try {
    const r = await app.invokeTool<ClassifyVerdict>("einvoicing_classify", {
      document_id: documentId,
    })
    return r && r.status !== "error" ? r : null
  } catch {
    return null
  }
}

export const RegimeLine: Component<{
  documentId: string
  contactId?: string | null
  originalDocumentId?: string | null
}> = (props) => {
  const [verdict] = createResource(() => props.documentId || null, loadVerdict)
  const view = () => {
    // Read only once settled: a pending read would blank the whole document detail (its Suspense).
    const v = verdict.state === "ready" ? verdict() : undefined
    return v
      ? regimeLineView(v, {
          documentId: props.documentId,
          contactId: props.contactId ?? null,
          originalDocumentId: props.originalDocumentId ?? null,
        })
      : null
  }
  return (
    <Show when={view()}>
      {(lv) => (
        <div data-testid="document-detail-regime-line" class="flex flex-col gap-1.5">
          <SectionLabel>{tr("E-invoicing")}</SectionLabel>
          <div class="flex items-baseline gap-2">
            <span data-testid="document-detail-regime" class="font-medium text-text">
              {lv().label}
            </span>
            <Show when={lv().reason}>
              <span data-testid="document-detail-regime-reason" class="text-text-secondary">
                {lv().reason}
              </span>
            </Show>
          </div>
          <Show when={lv().note}>
            <div
              data-testid="document-detail-regime-note"
              class="flex flex-wrap items-baseline gap-x-3 gap-y-1"
            >
              <span class="text-text-secondary">{lv().note}</span>
              <For each={lv().actions}>
                {(a) => (
                  <a
                    data-testid="document-detail-regime-action"
                    class="cursor-pointer text-accent hover:underline"
                    href={a.href}
                    onClick={(e) => {
                      e.preventDefault()
                      navigate(a.href)
                    }}
                  >
                    {a.label}
                  </a>
                )}
              </For>
            </div>
          </Show>
        </div>
      )}
    </Show>
  )
}
