// SPDX-License-Identifier: FSL-1.1-ALv2
// A task's Timebox: one chip in the meta row. Click, type a size ("3 days", "20 h"), Enter or
// leave the field to save; no dialog, no timer. Unreadable text stays in the field with the one
// sentence that says how to write it, and nothing is saved.
import { parseDuration } from "@liaison/shared"
import { type Component, createSignal, Show } from "solid-js"
import type { ApiClient } from "~/lib/api-client"
import { useI18n } from "~/modules/i18n/i18n-context"
import { formatMinutes, saveTimebox } from "~/modules/projects/time-budgets"

export const TimeboxChip: Component<{
  api: ApiClient
  taskId: string
  minutes: number | null
  disabled: boolean
  onSaved: (minutes: number | null) => void
  /** The server said the project does not use time and budgets. */
  onOff: () => void
}> = (props) => {
  const i18n = useI18n()
  const [editing, setEditing] = createSignal(false)
  const [text, setText] = createSignal("")
  const [error, setError] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)

  const start = () => {
    if (props.disabled) return
    setText(props.minutes ? formatMinutes(props.minutes) : "")
    setError(null)
    setEditing(true)
  }

  const commit = async (): Promise<void> => {
    if (busy()) return
    const typed = text().trim()
    if (typed === "") {
      setEditing(false)
      if (props.minutes === null) return
      await save(null)
      return
    }
    if (parseDuration(typed) === null) {
      setError(i18n.t("projects.time.unreadable"))
      return
    }
    if (props.minutes !== null && parseDuration(typed) === props.minutes) {
      setEditing(false)
      return
    }
    await save(typed)
  }

  const save = async (value: string | null): Promise<void> => {
    setBusy(true)
    const out = await saveTimebox(props.api, props.taskId, value)
    setBusy(false)
    if (out.kind === "ok") {
      setEditing(false)
      props.onSaved(out.data.timeboxMinutes)
    } else if (out.kind === "off") {
      setEditing(false)
      props.onOff()
    } else {
      setEditing(true)
      setError(out.message)
    }
  }

  return (
    <span class="inline-flex flex-wrap items-center gap-x-2" data-testid="task-timebox">
      <Show
        when={editing()}
        fallback={
          <button
            type="button"
            data-testid="task-timebox-chip"
            data-state={props.minutes === null ? "no-timebox" : "set"}
            disabled={props.disabled}
            onClick={start}
            aria-label={i18n.t("projects.time.timebox")}
            class={
              props.minutes !== null
                ? "inline-flex items-center gap-1.5 rounded-sm border border-border px-1.5 py-0.5 text-[12px] text-text-secondary transition-colors hover:bg-surface-hover/50 hover:text-text disabled:opacity-50"
                : "inline-flex items-center gap-1 rounded-sm border border-transparent px-1.5 py-0.5 text-[12.5px] text-text-tertiary transition-colors hover:border-border-subtle hover:bg-surface-hover/50 hover:text-text-secondary disabled:opacity-50"
            }
          >
            {props.minutes !== null
              ? i18n.t("projects.time.timeboxSet", { time: formatMinutes(props.minutes) })
              : i18n.t("projects.time.timeboxNone")}
          </button>
        }
      >
        <input
          type="text"
          data-testid="task-timebox-input"
          autofocus
          ref={(el) => queueMicrotask(() => el.focus())}
          value={text()}
          placeholder={i18n.t("projects.time.timeboxPlaceholder")}
          aria-label={i18n.t("projects.time.timebox")}
          title={error() ?? undefined}
          aria-invalid={error() ? "true" : undefined}
          onInput={(e) => {
            setText(e.currentTarget.value)
            setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              void commit()
            } else if (e.key === "Escape") setEditing(false)
          }}
          onBlur={() => void commit()}
          class="w-28 rounded-sm border border-border bg-bg px-1.5 py-0.5 text-[12.5px] text-text outline-none focus:border-accent-muted"
        />
        <Show when={error()}>
          <span data-testid="task-timebox-error" class="text-[11.5px] text-text-tertiary">
            {error()}
          </span>
        </Show>
      </Show>
    </span>
  )
}
