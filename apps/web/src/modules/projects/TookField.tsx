// SPDX-License-Identifier: FSL-1.1-ALv2
// Took: what the person spent on a task, in their own words, in the meta row. Enter or leaving
// the field saves; unreadable text stays in the field and saves nothing; no dialog, no timer.
// The field holds only the viewer's own entry, read through `task_time_get`. "N h so far" is the
// task's total from the task itself, with no one's part named. On a project with dated hours a date says which day the entry is for.
import { parseDuration } from "@liaison/shared"
import { type Component, createEffect, createResource, createSignal, on, Show } from "solid-js"
import type { ApiClient } from "~/lib/api-client"
import { useI18n } from "~/modules/i18n/i18n-context"
import { formatMinutes, readTaskTime, saveTook } from "~/modules/projects/time-budgets"

export const TookField: Component<{
  api: ApiClient
  taskId: string
  datedHours: boolean
  /** Without the task-write scope (or on an archived project) the field only reads. */
  editable: boolean
  /** The task's total (everyone's, with no one's part named), from the task itself. */
  totalMinutes: number
  onOff: () => void
  /** The task's total changed (the new total): the budget reads it again. */
  onChanged?: (totalMinutes: number) => void
}> = (props) => {
  const i18n = useI18n()
  const [day, setDay] = createSignal("")
  const [text, setText] = createSignal("")
  const [error, setError] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)

  const [time, { refetch }] = createResource(
    () => props.taskId,
    async (id) => {
      const out = await readTaskTime(props.api, id)
      if (out.kind === "off") {
        props.onOff()
        return null
      }
      return out.kind === "ok" ? out.data : null
    },
  )

  const entry = () => {
    const mine = time()?.mine ?? []
    if (props.datedHours && day()) return mine.find((m) => m.date === day()) ?? null
    return props.datedHours ? null : (mine[0] ?? null)
  }
  const shown = () => (entry() ? formatMinutes(entry()!.minutes) : "")
  createEffect(
    on(
      () => [time(), day()] as const,
      () => {
        setText(shown())
        setError(null)
      },
    ),
  )

  const commit = async (): Promise<void> => {
    if (busy() || !props.editable) return
    const typed = text().trim()
    if (typed === shown()) return
    if (typed === "") {
      if (!entry()) return
      return save(null)
    }
    if (parseDuration(typed) === null) {
      setError(i18n.t("projects.time.unreadable"))
      return
    }
    return save(typed)
  }

  const save = async (value: string | null): Promise<void> => {
    setBusy(true)
    const out = await saveTook(
      props.api,
      props.taskId,
      value,
      props.datedHours && day() ? day() : undefined,
    )
    setBusy(false)
    if (out.kind === "ok") {
      setError(null)
      await refetch()
      props.onChanged?.(out.data.totalMinutes)
    } else if (out.kind === "off") props.onOff()
    else setError(out.message)
  }

  return (
    <span class="inline-flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="task-took">
      <label class="inline-flex items-center gap-1.5 text-[12.5px] text-text-tertiary">
        <span>{i18n.t("projects.time.took")}</span>
        <Show
          when={props.editable}
          fallback={
            <span data-testid="task-took-value" class="text-text-secondary">
              {shown() || i18n.t("projects.time.tookNone")}
            </span>
          }
        >
          <input
            type="text"
            data-testid="task-took-input"
            value={text()}
            placeholder={i18n.t("projects.time.tookPlaceholder")}
            title={error() ?? i18n.t("projects.time.tookHint")}
            aria-invalid={error() ? "true" : undefined}
            onInput={(e) => {
              setText(e.currentTarget.value)
              setError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                void commit()
              }
            }}
            onBlur={() => void commit()}
            class="w-24 rounded-sm border border-border bg-bg px-1.5 py-0.5 text-[12.5px] text-text outline-none focus:border-accent-muted"
          />
        </Show>
      </label>
      <Show when={props.datedHours && props.editable}>
        <input
          type="date"
          data-testid="task-took-date"
          value={day()}
          aria-label={i18n.t("projects.time.tookDate")}
          onInput={(e) => setDay(e.currentTarget.value)}
          class="rounded-sm border border-border bg-bg px-1.5 py-0.5 text-[12px] text-text-secondary outline-none focus:border-accent-muted"
        />
      </Show>
      <Show when={props.totalMinutes > 0}>
        <span data-testid="task-took-total" class="text-[12px] text-text-tertiary">
          {i18n.t("projects.time.tookSoFar", { time: formatMinutes(props.totalMinutes) })}
        </span>
      </Show>
      <Show when={entry()?.enteredVia === "mcp"}>
        <span data-testid="task-took-mcp" class="text-[11.5px] text-text-tertiary">
          {i18n.t("projects.time.tookViaMcp")}
        </span>
      </Show>
      <Show when={entry()?.changedBy}>
        <span data-testid="task-took-changed" class="text-[11.5px] text-text-tertiary">
          {entry()?.changedBy}
        </span>
      </Show>
      <Show when={error()}>
        <span data-testid="task-took-error" class="text-[11.5px] text-text-tertiary">
          {error()}
        </span>
      </Show>
    </span>
  )
}
