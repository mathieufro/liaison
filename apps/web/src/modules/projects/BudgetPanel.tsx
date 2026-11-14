// SPDX-License-Identifier: FSL-1.1-ALv2
// The project's budget panel: Time, Money, what is not in these numbers, and the dated hours
// switch, and an ask box that fills the chat's composer. A right rail over the board on a wide workspace (a rail, not a split pane: the board
// keeps its width) and a block under the budget line on a narrow one. Never a figure for a
// person, never red when over, no gauge. Every partial figure sits beside its coverage line;
// without the money scope the panel shows hours only.
import { type Component, createSignal, For, Match, Show, Switch } from "solid-js"
import type { ApiClient } from "~/lib/api-client"
import { hasScope } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import {
  type BudgetData,
  type BudgetState,
  formatMinutes,
  savePlan,
} from "~/modules/projects/time-budgets"
import { dock } from "~/modules/shell/dock-prefill"
import { openTab } from "~/modules/shell/tab-store"
import { DISCUSSION_RAIL_BOTTOM_PAD } from "~/modules/threads/discussion-rail"
import { Button } from "~/ui/Button"

const Row: Component<{ testid: string; label: string; value: string; note?: string }> = (p) => (
  <div data-testid={p.testid} class="flex flex-wrap items-baseline gap-x-2 text-[12.5px]">
    <dt class="w-16 shrink-0 text-text-tertiary">{p.label}</dt>
    <dd class="text-text">{p.value}</dd>
    <Show when={p.note}>
      <dd class="text-[11.5px] text-text-tertiary">{p.note}</dd>
    </Show>
  </div>
)

const Figures: Component<{ data: BudgetData }> = (props) => {
  const i18n = useI18n()
  const d = () => props.data
  return (
    <>
      <section data-testid="budget-panel.time" class="flex flex-col gap-1.5">
        <h3 class="text-[11px] font-medium uppercase tracking-[0.04em] text-text-tertiary">
          {i18n.t("projects.time.panelTime")}
        </h3>
        <dl class="flex flex-col gap-1">
          <Show when={d().timebox !== undefined}>
            <Row
              testid="budget-panel.planned"
              label={i18n.t("projects.time.planned")}
              value={formatMinutes(d().timebox as number)}
            />
          </Show>
          <Row
            testid="budget-panel.real"
            label={i18n.t("projects.time.real")}
            value={formatMinutes(d().real)}
            note={d().partial ? i18n.t("projects.time.partial") : undefined}
          />
          <Show when={d().left !== undefined}>
            <Row
              testid="budget-panel.left"
              label={
                (d().left as number) < 0
                  ? i18n.t("projects.time.over")
                  : i18n.t("projects.time.left")
              }
              value={formatMinutes(Math.abs(d().left as number))}
              note={d().partial ? i18n.t("projects.time.partial") : undefined}
            />
          </Show>
        </dl>
        <Show when={d().partial}>
          <p data-testid="budget-panel.coverage" class="text-[12px] text-text-secondary">
            {i18n.t("projects.time.coverage", {
              with: d().coverage.withEntries,
              total: d().coverage.total,
            })}
          </p>
        </Show>
        <Show when={d().timebox === undefined}>
          <p data-testid="budget-panel.no-timebox" class="text-[12px] text-text-tertiary">
            {i18n.t("projects.time.noTimebox")}
          </p>
        </Show>
      </section>
      <Show when={d().milestones.length > 0}>
        <section data-testid="budget-panel.milestones" class="flex flex-col gap-1.5">
          <h3 class="text-[11px] font-medium uppercase tracking-[0.04em] text-text-tertiary">
            {i18n.t("projects.time.milestones")}
          </h3>
          <ul class="flex flex-col gap-1">
            <For each={d().milestones}>
              {(m) => (
                <li
                  data-testid="budget-panel.milestone"
                  class="flex items-baseline justify-between gap-2 text-[12.5px]"
                >
                  <span class="min-w-0 truncate text-text-secondary">{m.name}</span>
                  <span class="shrink-0 text-text-tertiary">
                    {formatMinutes(m.realMinutes)}
                    {m.plannedMinutes !== undefined ? ` / ${formatMinutes(m.plannedMinutes)}` : ""}
                  </span>
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>
      <section data-testid="budget-panel.money" class="flex flex-col gap-1.5">
        <h3 class="text-[11px] font-medium uppercase tracking-[0.04em] text-text-tertiary">
          {i18n.t("projects.time.panelMoney")}
        </h3>
        <Switch>
          <Match when={d().state === "hours-only"}>
            <p data-testid="budget-panel.hours-only" class="text-[12px] text-text-tertiary">
              {i18n.t("projects.time.hoursOnly")}
            </p>
          </Match>
          <Match when={d().money}>
            {(m) => {
              const out = m()
              return (
                <dl>
                  {"rate" in out ? (
                    <Row
                      testid="budget-panel.rate"
                      label={i18n.t("projects.time.budgetRate")}
                      value={i18n.t(
                        out.per === "hour"
                          ? "projects.time.ratePerHour"
                          : "projects.time.ratePerDay",
                        { amount: i18n.fmtCurrency(out.rate, out.currency ?? "EUR") },
                      )}
                    />
                  ) : (
                    <Row
                      testid="budget-panel.price"
                      label={i18n.t("projects.time.price")}
                      value={i18n.fmtCurrency(out.price, out.currency ?? "EUR")}
                    />
                  )}
                </dl>
              )
            }}
          </Match>
          <Match when={true}>
            <p class="text-[12px] text-text-tertiary">{i18n.t("projects.time.noPrice")}</p>
          </Match>
        </Switch>
      </section>
      <Show when={d().notInNumbers.length > 0}>
        <section data-testid="budget-panel.not-in" class="flex flex-col gap-1.5">
          <h3 class="text-[11px] font-medium uppercase tracking-[0.04em] text-text-tertiary">
            {i18n.t("projects.time.notIn")}
          </h3>
          <ul class="flex flex-col gap-1 text-[12px] text-text-secondary">
            <For each={d().notInNumbers}>{(n) => <li>{n.text}</li>}</For>
          </ul>
        </section>
      </Show>
    </>
  )
}

/**
 * The ask box: a question about this budget goes to the person's own agent. It only fills the
 * chat's composer (`dock.prefill`) and opens the conversation; the person sends it themselves.
 */
const AskBox: Component<{ projectName: string }> = (props) => {
  const i18n = useI18n()
  const [text, setText] = createSignal("")
  const ask = (question: string): void => {
    const q = question.trim()
    if (!q) return
    void dock
      .prefill(i18n.t("projects.time.askAbout", { project: props.projectName, question: q }))
      .then(() => setText(""))
      .catch(() => {})
  }
  const suggestions = () => [i18n.t("projects.time.askFits"), i18n.t("projects.time.askCheck")]
  return (
    <section data-testid="budget-ask" class="flex flex-col gap-2">
      <div class="flex flex-wrap gap-1.5">
        <For each={suggestions()}>
          {(label, i) => (
            <button
              type="button"
              data-testid={`budget-ask.suggest-${i()}`}
              onClick={() => ask(label)}
              class="rounded-sm border border-border-subtle px-2 py-0.5 text-[12px] text-text-secondary transition-colors hover:bg-surface-hover/50 hover:text-text"
            >
              {label}
            </button>
          )}
        </For>
      </div>
      <form
        class="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault()
          ask(text())
        }}
      >
        <input
          type="text"
          data-testid="budget-ask.input"
          value={text()}
          aria-label={i18n.t("projects.time.askLabel")}
          placeholder={i18n.t("projects.time.askPlaceholder")}
          onInput={(e) => setText(e.currentTarget.value)}
          class="min-w-0 flex-1 rounded-sm border border-border bg-bg px-2 py-1 text-[12.5px] text-text outline-none focus:border-accent-muted"
        />
        <Button type="submit" variant="outline" size="sm">
          <span data-testid="budget-ask.submit">{i18n.t("projects.time.askButton")}</span>
        </Button>
      </form>
    </section>
  )
}

export const BudgetPanel: Component<{
  api: ApiClient
  projectId: string
  state: BudgetState | undefined
  /** A right rail (wide workspace) or a block under the line. */
  rail: boolean
  archived: boolean
  onClose: () => void
  /** The plan changed: read the budget again. */
  onPlanChanged: () => void
  onOff: () => void
}> = (props) => {
  const i18n = useI18n()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const canPlan = () => !props.archived && hasScope("projects:projects:write")

  const setDated = async (on: boolean): Promise<void> => {
    if (busy()) return
    setBusy(true)
    setError(null)
    const out = await savePlan(props.api, props.projectId, { datedHours: on })
    setBusy(false)
    if (out.kind === "ok") props.onPlanChanged()
    else if (out.kind === "off") props.onOff()
    else setError(out.message)
  }

  return (
    <aside
      data-testid="budget-panel"
      data-layout={props.rail ? "rail" : "block"}
      aria-label={i18n.t("projects.time.panelTitle")}
      class={
        props.rail
          ? "absolute inset-y-0 right-0 z-10 flex w-[300px] flex-col gap-4 overflow-y-auto border-l border-border-subtle bg-bg px-4 pt-3"
          : "mx-6 mb-3 flex flex-col gap-4 rounded-md border border-border-subtle bg-surface px-4 py-3 max-sm:mx-4"
      }
      style={props.rail ? { "padding-bottom": DISCUSSION_RAIL_BOTTOM_PAD } : undefined}
    >
      <div class="flex items-center justify-between gap-2">
        <h2 class="text-[12.5px] font-medium text-text">{i18n.t("projects.time.panelTitle")}</h2>
        <Button variant="ghost" size="sm" onClick={props.onClose}>
          <span data-testid="budget-panel.close">{i18n.t("projects.time.panelClose")}</span>
        </Button>
      </div>
      <Switch>
        <Match when={props.state?.status === "ready" && props.state}>
          {(s) => (
            <>
              <Figures data={(s() as Extract<BudgetState, { status: "ready" }>).data} />
              <section data-testid="budget-panel.dated" class="flex flex-col gap-1">
                <label class="flex items-center gap-2 text-[12.5px] text-text-secondary">
                  <input
                    type="checkbox"
                    data-testid="budget-panel.dated-switch"
                    checked={(s() as Extract<BudgetState, { status: "ready" }>).data.datedHours}
                    disabled={!canPlan() || busy()}
                    onChange={(e) => void setDated(e.currentTarget.checked)}
                  />
                  {i18n.t("projects.time.datedHours")}
                </label>
                <p class="text-[11.5px] text-text-tertiary">{i18n.t("projects.time.datedHelp")}</p>
                <Show
                  when={
                    (s() as Extract<BudgetState, { status: "ready" }>).data.datedHours &&
                    hasScope("projects:dated_sheet:read")
                  }
                >
                  <button
                    type="button"
                    data-testid="budget-panel.open-sheet"
                    class="self-start text-[12px] text-text-secondary underline-offset-2 hover:text-text hover:underline"
                    onClick={() =>
                      openTab({
                        type: "projects:timesheet",
                        entityId: props.projectId,
                        label: i18n.t("projects.timesheet.tab"),
                        preview: false,
                      })
                    }
                  >
                    {i18n.t("projects.time.openSheet")}
                  </button>
                </Show>
                <Show when={error()}>
                  <p data-testid="budget-panel.error" class="text-[12px] text-text-tertiary">
                    {error()}
                  </p>
                </Show>
              </section>
              <AskBox
                projectName={(s() as Extract<BudgetState, { status: "ready" }>).data.projectName}
              />
            </>
          )}
        </Match>
        <Match when={props.state?.status === "error"}>
          <p data-testid="budget-panel.load-error" class="text-[12px] text-text-secondary">
            {i18n.t("projects.time.budgetError")}
          </p>
        </Match>
        <Match when={true}>
          <p data-testid="budget-panel.loading" class="text-[12px] text-text-tertiary">
            {i18n.t("projects.time.budgetLoading")}
          </p>
        </Match>
      </Switch>
    </aside>
  )
}
