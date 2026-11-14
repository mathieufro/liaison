// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The small Stripe card every panel draws from a PanelModel, and the loader each panel shares.
import { app, navigate } from "@liaison/host"
import { type Component, createResource, Show } from "solid-js"
import { CONTROL } from "./HomeStates"
import { tr, uiLocale } from "./i18n"
import { type PanelKind, type PanelModel, type PanelRead, panelModel } from "./panels-model"

const SECONDARY = `${CONTROL} border border-border bg-surface text-text hover:bg-surface-hover`

export async function readPanel(args: Record<string, unknown>): Promise<PanelRead | null> {
  try {
    const r = await app.invokeTool<PanelRead & { error?: unknown }>("customers_get", args)
    // A refusal that says "not found" is an empty panel; any other refusal hides it.
    const code = (r as { error?: { code?: string } } | null)?.error?.code
    if (code === "customer_not_found") return {}
    return r && !r.error ? r : null
  } catch (err) {
    // The tool refuses an unlinked record with its own code; any other refusal (no scope) hides the panel.
    const e = err as { code?: string; error?: { code?: string }; message?: string }
    const said = `${e?.code ?? ""} ${e?.error?.code ?? ""} ${e?.message ?? ""}`
    return said.includes("customer_not_found") ? {} : null
  }
}

export const StripePanelBody: Component<{ kind: PanelKind; model: PanelModel; testid: string }> = (
  p,
) => {
  const m = () => p.model
  return (
    <Show when={m().kind !== "hidden"}>
      <section
        data-testid={p.testid}
        class="flex min-w-0 flex-col gap-2 rounded-lg border border-border-subtle bg-surface px-4 py-3 text-[12.5px]"
      >
        <Show when={m().kind === "empty"}>
          <div class="flex flex-wrap items-center justify-between gap-2 text-text-secondary">
            <span>{(m() as { text: string }).text}</span>
            <button
              type="button"
              data-testid={`${p.testid}-link`}
              class={SECONDARY}
              onClick={() => navigate("/stripe/customers")}
            >
              {tr("Link a customer")}
            </button>
          </div>
        </Show>
        <Show when={m().kind === "card" ? (m() as Extract<PanelModel, { kind: "card" }>) : null}>
          {(c) => (
            <>
              <div class="flex flex-wrap items-center gap-2">
                <span class="text-[11px] uppercase tracking-wider text-text-tertiary">
                  {tr("Stripe")}
                </span>
                <Show when={c().pastDueLabel}>
                  <span
                    data-testid={`${p.testid}-past-due`}
                    class="rounded-full border border-border px-2 py-0.5 text-[11.5px] text-text"
                  >
                    {tr("Past due")}
                  </span>
                </Show>
                <span class="ml-auto font-mono text-[11.5px] text-text-tertiary break-all">
                  {c().customerId}
                </span>
              </div>
              <div class="text-[13.5px] font-medium text-text">{c().plan}</div>
              <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                <Show when={c().amount}>
                  <dt class="text-text-tertiary">{tr("Amount")}</dt>
                  <dd class="text-text-secondary">{c().amount}</dd>
                </Show>
                <dt class="text-text-tertiary">{tr("Status")}</dt>
                <dd class="text-text-secondary">{c().pastDueLabel ?? c().status}</dd>
                <dt class="text-text-tertiary">{tr("Card")}</dt>
                <dd class="text-text-secondary">
                  {c().card}
                  {c().cardExpired ? `, ${tr("Expired")}` : ""}
                </dd>
                <Show when={c().unpaid}>
                  <dt class="text-text-tertiary">{tr("Unpaid")}</dt>
                  <dd class="text-text-secondary">{c().unpaid}</dd>
                </Show>
              </dl>
              <Show when={c().updated}>
                <div class="text-[11.5px] text-text-tertiary">{c().updated}</div>
              </Show>
              <div>
                <button
                  type="button"
                  data-testid={`${p.testid}-open`}
                  class={SECONDARY}
                  onClick={() => navigate(`/stripe/customers/${c().rowId ?? c().customerId}`)}
                >
                  {tr("Open customer")}
                </button>
              </div>
            </>
          )}
        </Show>
      </section>
    </Show>
  )
}

/** Loads one panel's record and draws it, or nothing. */
export const useStripePanel = (
  kind: PanelKind,
  args: () => Record<string, unknown> | undefined,
) => {
  const [read] = createResource(args, readPanel)
  return () =>
    read.state === "ready" || read.state === "errored"
      ? panelModel(kind, read() ?? null, uiLocale())
      : ({ kind: "hidden" } as PanelModel)
}
