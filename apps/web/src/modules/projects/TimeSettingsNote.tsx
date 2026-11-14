// SPDX-License-Identifier: FSL-1.1-ALv2
// What the "Time and budgets" settings section says beside its fields: how many projects use it
// (one sentence, no switch, no list of projects), and for finance a way to ask for cost rates.
// The rate row is not drawn for anyone else.
import { type Component, createResource, Show } from "solid-js"
import { runTool } from "~/lib/run-tool"
import { hasScope } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { dock } from "~/modules/shell/dock-prefill"

export const TimeSettingsNote: Component = () => {
  const api = useApi()
  const i18n = useI18n()
  const [using] = createResource(async () => {
    try {
      const out = await runTool<{ projectsUsing?: number }>(
        api,
        "projects:time_settings_get",
        {},
        { suppressGlobalError: true },
      )
      return typeof out.projectsUsing === "number" ? out.projectsUsing : null
    } catch {
      return null
    }
  })
  return (
    <div class="space-y-2 text-[12.5px] text-text-secondary" data-testid="time-settings-note">
      <Show when={using()}>
        {(n) => (
          <p data-testid="time-settings-note.using">
            {n() === 1
              ? i18n.t("projects.timeSettings.usingOne")
              : i18n.t("projects.timeSettings.using", { count: n() })}
          </p>
        )}
      </Show>
      <Show when={hasScope("projects:cost_rates:write")}>
        <p class="flex flex-wrap items-baseline gap-x-3" data-testid="time-settings-note.rates">
          <span>{i18n.t("projects.timeSettings.costRates")}</span>
          <button
            type="button"
            class="underline-offset-2 hover:text-text hover:underline"
            data-testid="time-settings-note.rates-ask"
            onClick={() => void dock.prefill(i18n.t("projects.timeSettings.costRatesMessage"), api)}
          >
            {i18n.t("projects.timeSettings.costRatesAsk")}
          </button>
        </p>
      </Show>
    </div>
  )
}
