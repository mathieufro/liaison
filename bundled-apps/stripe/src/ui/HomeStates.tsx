// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Stripe page when the connection is not simply healthy: the card that says what is going on and
// the next step, the import's progress per resource, and the notice that figures are as of a time.
// Quiet on purpose: one muted card, a checklist, one primary action. No alarm colour.
import { app, navigate } from "@liaison/host"
import { type Component, createSignal, For, Show } from "solid-js"
import {
  type CardAction,
  dashboardShown,
  dashboardUrl,
  type HomeLoad,
  importingView,
  type PageKind,
  staleNotice,
  stateCard,
} from "./home-model"
import { tr, uiLocale } from "./i18n"

export const CONTROL =
  "inline-flex min-h-11 items-center justify-center rounded-md px-3 text-[12.5px] font-medium md:min-h-8"
const PRIMARY = `${CONTROL} border border-transparent bg-accent text-bg hover:bg-accent-hover`
const SECONDARY = `${CONTROL} border border-border bg-surface text-text hover:bg-surface-hover`

const RESOURCE_LABEL: Record<string, string> = {
  customers: "Customers",
  subscriptions: "Subscriptions",
  invoices: "Invoices",
  payments: "Payments",
  charges: "Payments",
  refunds: "Refunds",
  disputes: "Disputes",
}

/** The card actions that open the Stripe dashboard: absent on the demo's stand-in install. */
const DASHBOARD_ACTIONS: ReadonlySet<string> = new Set(["stripe", "stripe_keys", "stripe_webhooks"])

function actionHref(id: CardAction["id"], load: HomeLoad | null): string | null {
  // The demo's stand-in has no Stripe dashboard to send anybody to.
  if (!dashboardShown(load)) return null
  const mode = load?.connection.mode
  if (id === "stripe") return dashboardUrl(mode)
  if (id === "stripe_keys") return dashboardUrl(mode, "/apikeys")
  if (id === "stripe_webhooks") return dashboardUrl(mode, "/webhooks")
  return null
}

export const HomeStates: Component<{
  load: HomeLoad | null
  kind: PageKind
  now: Date
  onChecked: () => void
}> = (props) => {
  const locale = uiLocale()
  const [busy, setBusy] = createSignal(false)
  const [note, setNote] = createSignal<string | null>(null)
  const card = () => stateCard(props.load, locale, props.now)

  const run = async (id: CardAction["id"]) => {
    if (id === "settings") return navigate("/settings/apps/stripe?open=stripe")
    if (id !== "check") return
    setBusy(true)
    setNote(null)
    try {
      const r = await app.invokeTool<{ summary?: string }>("connection_check", {})
      setNote(r?.summary ?? tr("The key was checked."))
    } catch (e) {
      setNote(e instanceof Error ? e.message : tr("The check did not run. Nothing changed."))
    } finally {
      setBusy(false)
      props.onChecked()
    }
  }

  return (
    <Show when={card()}>
      {(c) => (
        <section
          data-testid="stripe-state-card"
          data-state={c().kind}
          class="min-w-0 rounded-lg border border-border-subtle bg-surface p-4"
        >
          <h2
            data-testid="stripe-state-title"
            class="text-[14px] font-semibold text-text break-words"
          >
            {c().title}
          </h2>
          <p class="mt-1 text-[12.5px] text-text-secondary break-words">{c().body}</p>
          <Show when={c().kind === "importing"}>
            <ImportProgress load={props.load} />
          </Show>
          <Show when={c().kind !== "importing"}>
            <ul
              data-testid="stripe-state-steps"
              class="mt-3 flex list-disc flex-col gap-1.5 pl-5 text-[12.5px] text-text-secondary"
            >
              <For each={c().steps}>{(s) => <li class="break-words">{s}</li>}</For>
            </ul>
          </Show>
          <Show when={c().note}>
            <p
              data-testid="stripe-state-note"
              class="mt-3 text-[12px] text-text-tertiary break-words"
            >
              {c().note}
            </p>
          </Show>
          <div class="mt-4 flex flex-wrap gap-2">
            <For
              each={c().actions.filter(
                (a) => dashboardShown(props.load) || !DASHBOARD_ACTIONS.has(a.id),
              )}
            >
              {(a) => {
                const href = actionHref(a.id, props.load)
                return href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid={`stripe-state-action-${a.id}`}
                    class={a.primary ? PRIMARY : SECONDARY}
                  >
                    {a.label}
                  </a>
                ) : (
                  <button
                    type="button"
                    data-testid={`stripe-state-action-${a.id}`}
                    disabled={busy()}
                    onClick={() => run(a.id)}
                    class={`${a.primary ? PRIMARY : SECONDARY} disabled:opacity-50`}
                  >
                    {a.label}
                  </button>
                )
              }}
            </For>
          </div>
          <Show when={note()}>
            <p
              data-testid="stripe-state-check-note"
              class="mt-3 text-[12px] text-text-tertiary break-words"
            >
              {note()}
            </p>
          </Show>
        </section>
      )}
    </Show>
  )
}

export const ImportProgress: Component<{ load: HomeLoad | null }> = (props) => {
  const view = () =>
    importingView(
      props.load?.sync ?? { importing: true, partial: true, missing: [], resources: [] },
    )
  return (
    <div data-testid="stripe-import-progress" class="mt-3 flex flex-col gap-2">
      <For each={view().rows}>
        {(r) => (
          <div
            data-testid={`stripe-import-row-${r.resource}`}
            class="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)_auto] items-center gap-3 text-[12.5px]"
          >
            <span class="truncate text-text-secondary">
              {tr(RESOURCE_LABEL[r.resource] ?? "Other")}
            </span>
            <span
              class="h-1.5 overflow-hidden rounded-full bg-surface-active"
              role="progressbar"
              aria-valuenow={r.percent}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <span
                class="block h-full rounded-full bg-accent"
                style={{ width: `${r.percent}%` }}
              />
            </span>
            <span class="font-mono text-[11.5px] text-text-tertiary">
              {r.total !== null
                ? tr("{{done}} of {{total}}", { done: r.done, total: r.total })
                : r.status === "pending"
                  ? tr("next")
                  : String(r.done)}
            </span>
          </div>
        )}
      </For>
      <p data-testid="stripe-import-mrr-line" class="text-[12px] text-text-tertiary">
        {view().mrrLine}
      </p>
    </div>
  )
}

/** The line above rows and figures that are not being refreshed. */
export const StaleNotice: Component<{ load: HomeLoad }> = (props) => (
  <p data-testid="stripe-stale-notice" class="text-[12px] text-text-tertiary break-words">
    {staleNotice(props.load, uiLocale())}
  </p>
)
