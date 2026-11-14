// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one-click next steps an agent offered under its reply (`suggest_next_steps`). They are drawn
// from the tool's result, which the server checked: a prompt chip's words are exactly its label,
// and a conversation holding outside text gets none. A prompt chip sends its label as the person's
// own message; an open chip opens the tab the server resolved. Chips live only under the newest
// message: once anything is said after it, by a chip or typed, they are gone, after a reload too.
import { type Component, createSignal, For, Show } from "solid-js"
import { getAppTabAction } from "~/framework/app-registry"
import { userFromToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useOptionalApi } from "~/modules/shell/ApiContext"
import { openTab } from "~/modules/shell/tab-store"
import {
  findToolCallMessage,
  isNewestMessage,
  sendMessage,
  type ToolCallState,
} from "~/modules/threads/message-store"

const MAX_CHIPS = 4

type Step =
  | { label: string; kind: "prompt" }
  | {
      label: string
      kind: "open"
      app: string
      tab?: { type: string; entityId: string; routePath?: string }
    }

export function isSuggestStepsTool(name: string): boolean {
  return name === "kernel__suggest_next_steps" || name === "kernel:suggest_next_steps"
}

function stepsOf(toolCall: ToolCallState): Step[] {
  if (!isSuggestStepsTool(toolCall.toolName) || toolCall.status !== "completed") return []
  const result = toolCall.result as { ok?: unknown; steps?: unknown } | null | undefined
  if (result?.ok !== true || !Array.isArray(result.steps)) return []
  return (result.steps as Step[]).filter(
    (s) =>
      s &&
      typeof s.label === "string" &&
      s.label.length > 0 &&
      (s.kind === "prompt" || (s.kind === "open" && typeof s.app === "string")),
  )
}

const CHIP =
  "rounded-full border border-border px-2.5 py-1 text-xs text-text-secondary hover:bg-surface-hover disabled:pointer-events-none disabled:opacity-50"

export const SuggestionChips: Component<{ toolCalls: ToolCallState[] }> = (props) => {
  const i18n = useI18n()
  const api = useOptionalApi()
  const [sending, setSending] = createSignal(false)
  const [sent, setSent] = createSignal(false)
  const [notice, setNotice] = createSignal<string | null>(null)

  const call = () => [...props.toolCalls].reverse().find((tc) => stepsOf(tc).length > 0)
  const where = () => {
    const tc = call()
    return tc ? findToolCallMessage(tc.toolCallId) : null
  }
  const steps = () => {
    const tc = call()
    const at = where()
    if (!tc || !at || sent() || !isNewestMessage(at.threadId, at.messageId)) return []
    return stepsOf(tc)
      .filter((s) => s.kind === "prompt" || s.tab || getAppTabAction(s.app))
      .slice(0, MAX_CHIPS)
  }

  async function choose(step: Step) {
    if (step.kind === "open") {
      if (step.tab) {
        openTab({
          type: step.tab.type,
          entityId: step.tab.entityId,
          label: step.label,
          ...(step.tab.routePath ? { routePath: step.tab.routePath } : {}),
        })
        return
      }
      const action = getAppTabAction(step.app)
      if (action) openTab({ type: action.type, entityId: action.entityId, label: action.label })
      return
    }
    const at = where()
    const user = userFromToken()
    if (!api || !at || !user || sending()) return
    setSending(true)
    setNotice(null)
    try {
      await sendMessage(api, at.threadId, step.label, { id: user.userId, name: user.name })
      setSent(true)
    } catch {
      setNotice(i18n.t("kernel.toolCard.suggestionNotSent"))
    } finally {
      setSending(false)
    }
  }

  return (
    <Show when={steps().length > 0}>
      <div
        data-testid="suggestion-chips"
        role="group"
        aria-label={i18n.t("kernel.toolCard.suggestions")}
        class="flex flex-wrap gap-1.5 pt-1"
      >
        <For each={steps()}>
          {(step) => (
            <button
              type="button"
              data-testid={step.kind === "open" ? "suggestion-open" : "suggestion-prompt"}
              class={CHIP}
              disabled={sending()}
              onClick={() => void choose(step)}
            >
              {step.label}
            </button>
          )}
        </For>
        <Show when={notice()}>
          {(text) => <span class="text-xs text-text-tertiary">{text()}</span>}
        </Show>
      </div>
    </Show>
  )
}
