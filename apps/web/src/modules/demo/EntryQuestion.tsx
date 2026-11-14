// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "Which looks most like your company?" above the needs picker on the demo door.
//
// One question on the page the visitor is already on, never a step of its own:
// an answer lights up the tiles below (`presetNeeds`), which stay the
// visitor's to change, and no answer leaves the page as it always was. Pressing
// the chosen answer again takes it back. `other` carries a short free text,
// which is untrusted: it stays in this field's value and is sent as JSON, and
// the server caps and flattens it (`demoEntrySchema`).
import {
  DEMO_ENTRIES,
  DEMO_ENTRY_TEXT_MAX,
  DEMO_WORLD_NEEDS,
  type DemoEntryId,
  type DemoNeed,
  type DemoWorldId,
  demoWorldOfEntry,
  presetNeeds,
} from "@liaison/shared"
import { type Component, createUniqueId, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Input } from "~/ui/Input"

/**
 * The picks after the answer changes, among `worlds` (the worlds the
 * deployment runs). An entry with needs sets them. `other` or no answer has
 * none to set: it takes back the previous entry's picks when the visitor left
 * them untouched, and otherwise keeps what they picked by hand. A hand pick the
 * next answer's world does not show is dropped, so a pick never outlives its
 * tile.
 */
export function needsAfterEntry(
  current: readonly DemoNeed[],
  previous: DemoEntryId | null,
  next: DemoEntryId | null,
  worlds: readonly DemoWorldId[],
): DemoNeed[] {
  const preset = presetNeeds(next, worlds)
  if (preset.length > 0) return preset
  const before = presetNeeds(previous, worlds)
  const untouched =
    before.length > 0 &&
    before.length === current.length &&
    before.every((need, i) => need === current[i])
  if (untouched) return []
  const shown = DEMO_WORLD_NEEDS[demoWorldOfEntry(next, worlds)]
  return current.filter((need) => shown.includes(need))
}

export interface EntryQuestionProps {
  /** The worlds the deployment runs, for what an answer preselects. */
  worlds: readonly DemoWorldId[]
  value: DemoEntryId | null
  onChange: (next: DemoEntryId | null) => void
  text: string
  onTextChange: (next: string) => void
}

export const EntryQuestion: Component<EntryQuestionProps> = (props) => {
  const i18n = useI18n()
  const headingId = createUniqueId()

  return (
    <div data-testid="demo-entry-question" class="flex flex-col gap-2.5">
      <h1 id={headingId} class="text-2xl font-semibold leading-tight text-text sm:text-3xl">
        {i18n.t("kernel.demo.entryQuestion")}
      </h1>
      <fieldset aria-labelledby={headingId} class="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        <For each={DEMO_ENTRIES}>
          {(entry) => {
            const chosen = () => props.value === entry
            return (
              <button
                type="button"
                data-testid={`demo-entry-${entry}`}
                aria-pressed={chosen()}
                onClick={() => props.onChange(chosen() ? null : entry)}
                class={`min-h-10 rounded-lg border px-3 py-2 text-left text-[13.5px] leading-snug text-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                  chosen()
                    ? "border-text bg-surface-active font-medium"
                    : "border-border bg-bg hover:border-border-strong"
                }`}
              >
                {i18n.t(`kernel.demo.entryOptions.${entry}`)}
              </button>
            )
          }}
        </For>
      </fieldset>
      <Show when={props.value === "other"}>
        <div class="sm:max-w-[420px]">
          <Input
            label={i18n.t("kernel.demo.entryOtherLabel")}
            value={props.text}
            maxLength={DEMO_ENTRY_TEXT_MAX}
            name="company"
            autocomplete="off"
            data-testid="demo-entry-other-text"
            onInput={(e) => props.onTextChange(e.currentTarget.value)}
          />
        </div>
      </Show>
      <Show when={presetNeeds(props.value, props.worlds).length > 0}>
        <p
          data-testid="demo-entry-preselected"
          role="status"
          class="text-[13px] text-text-secondary"
        >
          {i18n.t("kernel.demo.entryPreselected")}
        </p>
      </Show>
    </div>
  )
}
