// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The decision toast: what an Approve or Reject is doing, from the click to
 * the end, named by the item it decides ("Approving in 4s · ticket-10889").
 *
 * One decision is one toast: its countdown with Undo, then "Approving…" while
 * it is carried out, then "Approved" for a moment. Several decisions group
 * into one toast that lists each with its own countdown and Undo, says how
 * many are waiting, in progress and done, and offers Undo all. A decision that
 * fails leaves the toast at once: the surface that decided shows why and puts
 * the item back (decision-queue.ts).
 */
import { type Component, createSignal, For, onCleanup, Show } from "solid-js"
import { cn } from "~/lib/cn"
import {
  type DecisionToastItem,
  decisionToastItems,
  undoDecision,
} from "~/modules/approvals/decision-queue"
import { useI18n } from "~/modules/i18n/i18n-context"

type T = ReturnType<typeof useI18n>["t"]

/** A clock for the countdowns: it moves only while one is on screen. */
function useNow(active: () => boolean): () => number {
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => {
    if (active()) setNow(Date.now())
  }, 250)
  onCleanup(() => clearInterval(timer))
  return now
}

function statusLine(item: DecisionToastItem, now: number, t: T): string {
  // An access request is granted or denied, never approved or rejected: the
  // toast keeps the verbs its row offered (Grant / Deny).
  const verbs =
    item.kind === "scope-request"
      ? { yes: "granting", no: "denying", yesDone: "granted", noDone: "denied" }
      : item.label?.verb === "dismiss"
        ? { yes: "approving", no: "dismissing", yesDone: "approved", noDone: "dismissed" }
        : { yes: "approving", no: "rejecting", yesDone: "approved", noDone: "rejected" }
  const approve = item.decision === "approve"
  if (item.phase === "queued") {
    // The clock may lag a just-queued decision by a tick: never count above the window.
    const elapsed = Math.max(0, now - item.queuedAt)
    const seconds = Math.max(1, Math.ceil((item.windowMs - elapsed) / 1000))
    return t(`kernel.decisionToast.${approve ? verbs.yes : verbs.no}In`, { seconds })
  }
  if (item.phase === "sending") {
    return t(`kernel.decisionToast.${approve ? verbs.yes : verbs.no}`)
  }
  return t(`kernel.decisionToast.${approve ? verbs.yesDone : verbs.noDone}`)
}

const PhaseIcon: Component<{ phase: DecisionToastItem["phase"] }> = (props) => (
  <Show when={props.phase !== "queued"}>
    <Show
      when={props.phase === "done"}
      fallback={
        <span
          class="size-3.5 shrink-0 animate-spin rounded-full border-2 border-border border-t-text-secondary"
          aria-hidden="true"
          data-testid="decision-toast-spinner"
        />
      }
    >
      <svg
        class="size-3.5 shrink-0 text-success"
        viewBox="0 0 16 16"
        aria-hidden="true"
        data-testid="decision-toast-done"
      >
        <path
          d="M3 8.5l3 3 7-7"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </Show>
  </Show>
)

/** The bar that empties over the Undo window, from where it stands now. */
const Countdown: Component<{ item: DecisionToastItem; now: number; class?: string }> = (props) => {
  const left = () =>
    Math.max(0, Math.min(1, 1 - Math.max(0, props.now - props.item.queuedAt) / props.item.windowMs))
  return (
    <div class={cn("pointer-events-none h-[3px] w-full bg-hover", props.class)} aria-hidden="true">
      <div
        class="h-full bg-accent transition-[width] duration-200 ease-linear"
        style={{ width: `${(left() * 100).toFixed(1)}%` }}
        data-testid="decision-toast-countdown"
      />
    </div>
  )
}

const UndoButton: Component<{ item: DecisionToastItem; compact?: boolean }> = (props) => {
  const i18n = useI18n()
  return (
    <button
      type="button"
      class={cn(
        "shrink-0 rounded border border-border font-medium text-accent transition-colors hover:bg-hover",
        props.compact ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-xs",
      )}
      onClick={() => undoDecision(props.item.kind, props.item.id)}
      data-testid="decision-toast-undo"
    >
      {i18n.t("kernel.decisionToast.undo")}
    </button>
  )
}

/** A sequence's steps, when the decision is one: two or more names. */
function sequenceSteps(item: DecisionToastItem): string[] {
  const steps = item.label?.steps
  return Array.isArray(steps) && steps.length > 1 ? steps : []
}

/** "3 steps" beside a sequence's title: one decision, several actions. */
const StepCount: Component<{ item: DecisionToastItem }> = (props) => {
  const i18n = useI18n()
  return (
    <Show when={sequenceSteps(props.item).length > 0}>
      <span
        class="ml-1.5 shrink-0 font-mono text-[11px] font-normal text-text-tertiary"
        data-testid="decision-toast-step-count"
      >
        {i18n.t("kernel.decisionToast.sequenceSteps", { count: sequenceSteps(props.item).length })}
      </span>
    </Show>
  )
}

/** Every step of a sequence, in the order they run, each by its own name. */
const StepList: Component<{ item: DecisionToastItem }> = (props) => {
  const i18n = useI18n()
  return (
    <Show when={sequenceSteps(props.item).length > 0}>
      <ol
        class="mt-0.5 flex flex-col gap-0.5 border-border border-l-2 pl-2 text-text-secondary text-xs"
        aria-label={i18n.t("kernel.approvalsUi.stepSequence")}
        data-testid="decision-toast-steps"
      >
        <For each={sequenceSteps(props.item)}>
          {(step, i) => (
            <li class="truncate" data-testid={`decision-toast-step-${i() + 1}`}>
              <span class="font-mono text-[11px] text-text-tertiary">{i() + 1}.</span> {step}
            </li>
          )}
        </For>
      </ol>
    </Show>
  )
}

const SingleToast: Component<{ item: DecisionToastItem; now: number }> = (props) => {
  const i18n = useI18n()
  return (
    <div
      class="relative w-[380px] max-w-full overflow-hidden rounded-md border border-border bg-elevated text-sm text-text shadow-popover"
      data-testid="decision-toast"
      data-phase={props.item.phase}
    >
      <div class="flex items-center gap-3 px-4 py-3">
        <PhaseIcon phase={props.item.phase} />
        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
          <span class="text-text-tertiary text-xs" data-testid="decision-toast-status">
            {statusLine(props.item, props.now, i18n.t)}
          </span>
          <span class="flex min-w-0 items-baseline">
            <span class="truncate font-medium" data-testid="decision-toast-title">
              {props.item.label?.title}
            </span>
            <StepCount item={props.item} />
          </span>
          <Show when={props.item.label?.detail}>
            {(detail) => <span class="truncate text-text-secondary text-xs">{detail()}</span>}
          </Show>
          <StepList item={props.item} />
        </div>
        <Show when={props.item.phase === "queued"}>
          <UndoButton item={props.item} />
        </Show>
      </div>
      <Show when={props.item.phase === "queued"}>
        <Countdown item={props.item} now={props.now} class="absolute bottom-0 left-0" />
      </Show>
    </div>
  )
}

const GroupToast: Component<{ items: readonly DecisionToastItem[]; now: number }> = (props) => {
  const i18n = useI18n()
  const [collapsed, setCollapsed] = createSignal(false)
  const count = (phase: DecisionToastItem["phase"]) =>
    props.items.filter((i) => i.phase === phase).length
  const summary = () =>
    [
      count("queued") ? i18n.t("kernel.decisionToast.waiting", { count: count("queued") }) : null,
      count("sending")
        ? i18n.t("kernel.decisionToast.inProgress", { count: count("sending") })
        : null,
      count("done") ? i18n.t("kernel.decisionToast.done", { count: count("done") }) : null,
    ]
      .filter((s): s is string => s !== null)
      .join(" · ")
  const undoAll = () => {
    for (const item of props.items) if (item.phase === "queued") undoDecision(item.kind, item.id)
  }
  return (
    <div
      class="w-[380px] max-w-full overflow-hidden rounded-md border border-border bg-elevated text-sm text-text shadow-popover"
      data-testid="decision-toast-group"
    >
      <div class="flex items-center gap-2 border-border border-b px-4 py-2.5">
        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
          <span class="font-medium" data-testid="decision-toast-group-title">
            {i18n.t("kernel.decisionToast.decisions", { count: props.items.length })}
          </span>
          <span class="text-text-tertiary text-xs" data-testid="decision-toast-group-summary">
            {summary()}
          </span>
        </div>
        <Show when={count("queued") > 0}>
          <button
            type="button"
            class="shrink-0 rounded border border-border px-2 py-1 font-medium text-accent text-xs transition-colors hover:bg-hover"
            onClick={undoAll}
            data-testid="decision-toast-undo-all"
          >
            {i18n.t("kernel.decisionToast.undoAll")}
          </button>
        </Show>
        <button
          type="button"
          class="flex size-7 shrink-0 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-hover hover:text-text"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed()}
          aria-label={i18n.t(
            collapsed() ? "kernel.decisionToast.show" : "kernel.decisionToast.hide",
          )}
          data-testid="decision-toast-group-toggle"
        >
          <svg
            class={cn("size-3.5 transition-transform", collapsed() && "rotate-180")}
            viewBox="0 0 14 14"
            aria-hidden="true"
          >
            <path
              d="M3 5l4 4 4-4"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </div>
      <Show when={!collapsed()}>
        <div class="flex max-h-72 flex-col overflow-y-auto">
          <For each={props.items}>
            {(item) => (
              <div
                class="flex flex-col border-border border-b last:border-b-0"
                data-testid="decision-toast-row"
                data-phase={item.phase}
              >
                <div class="flex items-center gap-2.5 px-4 py-2">
                  <PhaseIcon phase={item.phase} />
                  <div class="flex min-w-0 flex-1 flex-col">
                    <span class="flex min-w-0 items-baseline">
                      <span class="truncate font-medium text-[13px]">{item.label?.title}</span>
                      <StepCount item={item} />
                    </span>
                    <StepList item={item} />
                    <span class="text-text-tertiary text-xs">
                      {statusLine(item, props.now, i18n.t)}
                    </span>
                  </div>
                  <Show when={item.phase === "queued"}>
                    <UndoButton item={item} compact />
                  </Show>
                </div>
                <Show when={item.phase === "queued"}>
                  <Countdown item={item} now={props.now} />
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

/**
 * Rendered first in the toast stack (Toast.tsx), so it sits with the other toasts.
 * A fixed width (the whole row on a phone): a long title truncates instead of
 * stretching the toast across Home, and the toast keeps its size from one
 * phase to the next.
 */
export const DecisionToasts: Component = () => {
  const items = decisionToastItems
  const now = useNow(() => items().some((i) => i.phase === "queued"))
  return (
    <Show when={items().length > 0}>
      <Show
        when={items().length > 1}
        fallback={<SingleToast item={items()[0] as DecisionToastItem} now={now()} />}
      >
        <GroupToast items={items()} now={now()} />
      </Show>
    </Show>
  )
}
