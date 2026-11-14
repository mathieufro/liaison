// SPDX-License-Identifier: FSL-1.1-ALv2
// The "Time and budgets" switch of the project edit form (and of New project): one row, off by
// default, with one line saying what off does. A project turned on reads "On since <date>, turned
// on by <name>" and, under the switch, takes its plan: dated hours, how it is billed, a rate and
// who bills it. The plan fields start from the plan the server holds, read back once; the form
// sends only what the person changed. Nothing here is an organisation switch.
import { type Component, createSignal, For, onMount, Show } from "solid-js"
import type { ApiClient } from "~/lib/api-client"
import { hasScope } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { fetchAssignableMembers } from "~/modules/members/assignable-members"
import type { ProjectDetail } from "~/modules/projects/project-store"
import {
  budgetFor,
  readPlan,
  savePlan,
  saveRate,
  type TimeOutcome,
  type TimePlanPatch,
  type TimePlanRead,
} from "~/modules/projects/time-budgets"

const BASES = ["hourly", "daily", "fixed", "retainer", "none"] as const
type Basis = (typeof BASES)[number]

export interface TimePlanDraft {
  /** The plan as the server holds it, once read (null before, or when it could not be read). */
  loaded: () => TimePlanRead | null
  dated: () => boolean
  basis: () => Basis | ""
  rate: () => string
  biller: () => string
  setDated: (v: boolean) => void
  setBasis: (v: Basis | "") => void
  setRate: (v: string) => void
  setBiller: (v: string) => void
  /** Save what changed; the first refusal comes back as a sentence. */
  apply: (api: ApiClient, projectId: string) => Promise<string | null>
}

const rateText = (rate: number | null | undefined): string =>
  rate === null || rate === undefined ? "" : String(rate)

/**
 * The plan fields of a project using time and budgets. They start from the plan the server
 * holds (read back once), so the form shows the real basis, rate and biller; until that read
 * answers they read "keep as is", and only what the person changed is sent.
 */
export function createTimePlanDraft(project: ProjectDetail, api?: ApiClient): TimePlanDraft {
  const known = budgetFor(project.id)
  const [loaded, setLoaded] = createSignal<TimePlanRead | null>(null)
  const datedBefore = () =>
    loaded()?.datedHours ?? (known?.status === "ready" ? known.data.datedHours : false)
  const [dated, setDated] = createSignal(datedBefore())
  const [basis, setBasis] = createSignal<Basis | "">("")
  const [rate, setRate] = createSignal("")
  const [biller, setBiller] = createSignal("")
  if (api && project.timeBudgets === true) {
    void readPlan(api, project.id).then((out) => {
      if (out.kind !== "ok") return
      setLoaded(out.data)
      setDated(out.data.datedHours)
      setBasis(out.data.basis)
      setRate(rateText(out.data.rate))
      setBiller(out.data.billerId ?? "")
    })
  }
  const apply = async (api: ApiClient, projectId: string): Promise<string | null> => {
    const before = loaded()
    const patch: TimePlanPatch = {}
    if (dated() !== datedBefore()) patch.datedHours = dated()
    if (basis() && basis() !== (before?.basis ?? "")) patch.basis = basis() as Basis
    if (before ? biller() !== (before.billerId ?? "") : biller() !== "") {
      patch.billerId = biller() || null
    }
    const failed = <T,>(out: TimeOutcome<T>): string | null =>
      out.kind === "error" ? out.message : out.kind === "off" ? "off" : null
    if (Object.keys(patch).length > 0) {
      const msg = failed(await savePlan(api, projectId, patch))
      if (msg) return msg
    }
    const typedRate = rate().trim().replace(",", ".")
    if (typedRate !== "" && typedRate !== rateText(before?.rate)) {
      const n = Number(typedRate)
      if (!Number.isFinite(n) || n < 0) return "invalid-rate"
      const msg = failed(await saveRate(api, projectId, n))
      if (msg) return msg
    }
    return null
  }
  return { loaded, dated, basis, rate, biller, setDated, setBasis, setRate, setBiller, apply }
}

export const TimeBudgetsSwitch: Component<{
  api: ApiClient
  /** Set when editing a saved project; absent on New project. */
  project?: ProjectDetail
  on: boolean
  onChange: (on: boolean) => void
  plan?: TimePlanDraft
  idPrefix: string
}> = (props) => {
  const i18n = useI18n()
  const savedOn = () => props.project?.timeBudgets === true
  const since = () => {
    const p = props.project
    if (!savedOn() || !p?.timeBudgetsChangedAt) return null
    return {
      date: i18n.fmtDate(new Date(p.timeBudgetsChangedAt), { dateStyle: "medium" }),
      name: p.timeBudgetsChangedBy?.name ?? "",
    }
  }
  const [members, setMembers] = createSignal<Array<{ id: string; name: string }>>([])
  onMount(() => {
    if (!props.plan || !savedOn() || !props.api.getEnvelope) return
    fetchAssignableMembers(props.api, "")
      .then((r) => setMembers(r.items))
      .catch(() => {})
  })
  const canRate = () => hasScope("projects:money:write")
  // The current biller stays choosable even when the member list does not hold them.
  const billerOptions = (plan: TimePlanDraft) => {
    const held = plan.loaded()
    const list = members()
    if (!held?.billerId || list.some((m) => m.id === held.billerId)) return list
    return [{ id: held.billerId, name: held.billerName ?? held.billerId }, ...list]
  }

  return (
    <div data-testid={`${props.idPrefix}.time-budgets`} class="flex flex-col gap-1.5">
      <label class="flex items-center gap-2 text-[12.5px] font-medium text-text-secondary">
        <input
          type="checkbox"
          data-testid={`${props.idPrefix}.time-budgets-switch`}
          checked={props.on}
          onChange={(e) => props.onChange(e.currentTarget.checked)}
        />
        {i18n.t("projects.time.switchLabel")}
      </label>
      <Show when={since()}>
        {(s) => (
          <p
            data-testid={`${props.idPrefix}.time-budgets-since`}
            class="text-[11.5px] text-text-tertiary"
          >
            {i18n.t("projects.time.switchSince", { date: s().date, name: s().name })}
          </p>
        )}
      </Show>
      <p class="text-[11.5px] text-text-tertiary">{i18n.t("projects.time.switchHelp")}</p>
      <Show when={props.on && savedOn() && props.plan}>
        {(plan) => (
          <div
            data-testid={`${props.idPrefix}.time-plan`}
            class="mt-1 flex flex-col gap-2 border-l border-border-subtle pl-3"
          >
            <label class="flex items-center gap-2 text-[12.5px] text-text-secondary">
              <input
                type="checkbox"
                data-testid={`${props.idPrefix}.time-plan-dated`}
                checked={plan().dated()}
                onChange={(e) => plan().setDated(e.currentTarget.checked)}
              />
              {i18n.t("projects.time.datedHours")}
            </label>
            <label class="flex flex-col gap-1 text-[12px] text-text-secondary">
              {i18n.t("projects.time.basis")}
              <select
                data-testid={`${props.idPrefix}.time-plan-basis`}
                value={plan().basis()}
                onChange={(e) => plan().setBasis(e.currentTarget.value as Basis | "")}
                class="rounded-sm border border-border bg-bg px-2 py-1 text-[12.5px] text-text"
              >
                <Show when={!plan().loaded()}>
                  <option value="">{i18n.t("projects.time.keepAsIs")}</option>
                </Show>
                <For each={BASES}>
                  {(b) => <option value={b}>{i18n.t(`projects.time.basisOption.${b}`)}</option>}
                </For>
              </select>
            </label>
            <Show when={canRate()}>
              <label class="flex flex-col gap-1 text-[12px] text-text-secondary">
                {i18n.t("projects.time.rate")}
                <input
                  type="text"
                  inputmode="decimal"
                  data-testid={`${props.idPrefix}.time-plan-rate`}
                  value={plan().rate()}
                  placeholder={i18n.t("projects.time.keepAsIs")}
                  onInput={(e) => plan().setRate(e.currentTarget.value)}
                  class="w-32 rounded-sm border border-border bg-bg px-2 py-1 text-[12.5px] text-text"
                />
              </label>
            </Show>
            <label class="flex flex-col gap-1 text-[12px] text-text-secondary">
              {i18n.t("projects.time.biller")}
              <select
                data-testid={`${props.idPrefix}.time-plan-biller`}
                value={plan().biller()}
                onChange={(e) => plan().setBiller(e.currentTarget.value)}
                class="rounded-sm border border-border bg-bg px-2 py-1 text-[12.5px] text-text"
              >
                <option value="">
                  {plan().loaded()
                    ? i18n.t("projects.time.billerNone")
                    : i18n.t("projects.time.keepAsIs")}
                </option>
                <For each={billerOptions(plan())}>
                  {(m) => (
                    <option value={m.id} selected={m.id === plan().biller()}>
                      {m.name}
                    </option>
                  )}
                </For>
              </select>
            </label>
          </div>
        )}
      </Show>
    </div>
  )
}
