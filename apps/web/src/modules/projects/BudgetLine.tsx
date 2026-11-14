// SPDX-License-Identifier: FSL-1.1-ALv2
// The project's budget in one plain line under the header, in the words the server wrote. Only
// on a project using time and budgets. A partial figure carries its coverage in the same
// sentence; nothing turns red when time runs over.
import { type Component, Match, Switch } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import type { BudgetState } from "~/modules/projects/time-budgets"
import { Button } from "~/ui/Button"

export const BudgetLine: Component<{
  state: BudgetState | undefined
  panelOpen: boolean
  onTogglePanel: () => void
  onRetry: () => void
}> = (props) => {
  const i18n = useI18n()
  return (
    <div
      data-testid="budget-line"
      data-state={props.state?.status ?? "loading"}
      class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-6 pb-2 text-[12.5px] text-text-secondary max-sm:px-4"
    >
      <Switch>
        <Match when={props.state?.status === "ready" && props.state}>
          {(s) => (
            <>
              <span data-testid="budget-line.text">
                {(s() as Extract<BudgetState, { status: "ready" }>).data.line}
              </span>
              <button
                type="button"
                data-testid="budget-line.toggle"
                aria-expanded={props.panelOpen}
                onClick={props.onTogglePanel}
                class="text-[12px] text-text-tertiary underline-offset-2 transition-colors hover:text-text-secondary hover:underline"
              >
                {props.panelOpen
                  ? i18n.t("projects.time.budgetHideDetails")
                  : i18n.t("projects.time.budgetDetails")}
              </button>
            </>
          )}
        </Match>
        <Match when={props.state?.status === "error"}>
          <span data-testid="budget-line.error">{i18n.t("projects.time.budgetError")}</span>
          <Button variant="ghost" size="sm" onClick={props.onRetry}>
            <span data-testid="budget-line.retry">{i18n.t("kernel.common.retry2")}</span>
          </Button>
        </Match>
        <Match when={true}>
          <span data-testid="budget-line.loading" class="text-text-tertiary" aria-busy="true">
            {i18n.t("projects.time.budgetLoading")}
          </span>
        </Match>
      </Switch>
    </div>
  )
}
