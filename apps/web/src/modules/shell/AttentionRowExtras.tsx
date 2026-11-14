// SPDX-License-Identifier: FSL-1.1-ALv2
// The Home row's decision extras: the send check's line on a mail draft, "Not now" on a
// persisted item, "Ask agent to draft" on an item that needs a reply, "Ask agent to reassign"
// on companies a departure left without an account manager, and Dismiss on a send the check
// stopped. Urgency orders the rows; nothing here adds colour.
import { type ApprovalSendGuard, type AttentionItem, capacityNamedDays } from "@liaison/shared"
import { type Component, createSignal, Show } from "solid-js"
import { cn } from "~/lib/cn"
import { runTool } from "~/lib/run-tool"
import {
  openRecordLabel,
  openStopRecord,
  redraftRecord,
  startRedraft,
  stopRecord,
} from "~/modules/approvals/send-guard-actions"
import { sendGuardLine } from "~/modules/approvals/send-guard-line"
import { userFromToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { attentionStore } from "~/modules/shell/attention-store"
import { markAttentionRead } from "~/modules/shell/entity-opener"
import { SEND_STOPPED_KIND } from "~/modules/shell/home-action-count"
import { openTab } from "~/modules/shell/tab-store"
import { addToast } from "~/modules/shell/toast-store"
import { sendMessage } from "~/modules/threads/message-store"
import { ensurePersonalAgentDm } from "~/modules/threads/personal-dm-store"

/** The send check an approval row carries (attention.ts `metadata.sendGuard`). */
export function rowSendGuard(item: AttentionItem): ApprovalSendGuard | null {
  const g = item.metadata?.sendGuard as ApprovalSendGuard | undefined
  return g && typeof g === "object" && typeof g.state === "string" ? g : null
}

/** A draft the check says can no longer go out as written: shown, never counted. */
export function isStoppedDraft(item: AttentionItem): boolean {
  return item.metadata?.uncounted === true
}

/** A notice that the check stopped a send at the moment it went out. */
export function isStoppedSendNotice(item: AttentionItem): boolean {
  // An app event's kind ("mail:...") rides in `kind` beside the kernel's own kinds.
  const kind: string = item.kind
  return kind === SEND_STOPPED_KIND
}

/**
 * Not now applies to a persisted event of the viewer's own: a computed row has nothing to set
 * aside, and a stopped send is dismissed rather than put off.
 */
export function offersNotNow(item: AttentionItem): boolean {
  // A row passed on from someone away is theirs to set aside, never the stand-in's.
  const passedOn = typeof item.metadata?.forUserId === "string" && item.metadata.forUserId !== ""
  return (
    item.persisted === true &&
    !passedOn &&
    item.action?.type !== "decide_approval" &&
    !isStoppedSendNotice(item)
  )
}

/** Ask for a draft fits an item that waits on a reply or a next step, not a decision or a stop. */
export function offersAskDraft(item: AttentionItem): boolean {
  // "While you were away" reports what was decided; there is nothing to draft.
  const kind: string = item.kind
  return (
    item.action?.type === "open_entity" &&
    !isStoppedSendNotice(item) &&
    kind !== "kernel:away.recap" &&
    kind !== UNOWNED_COMPANIES_KIND
  )
}

/** The row of companies left without an account manager when someone was deactivated. */
export const UNOWNED_COMPANIES_KIND = "kernel:companies.unowned"

/** The companies such a row lists, or null for any other row. */
export function unownedCompanyIds(item: AttentionItem): string[] | null {
  const kind: string = item.kind
  const ids = item.metadata?.companyIds
  if (kind !== UNOWNED_COMPANIES_KIND || !Array.isArray(ids)) return null
  const valid = ids.filter((i): i is string => typeof i === "string")
  return valid.length > 0 ? valid : null
}

/** The send check's line on a mail draft row, the same words the card uses. */
export const GuardLine: Component<{ item: AttentionItem; testId: string }> = (props) => {
  const i18n = useI18n()
  const line = (): string | null => {
    const g = rowSendGuard(props.item)
    if (!g) return null
    if (g.state === "clear") return i18n.t("kernel.homeDecisions.guardClear")
    return sendGuardLine(g, i18n.t, i18n.locale())
  }
  return (
    <Show when={line()}>
      {(text) => (
        <span
          data-testid={`${props.testId}-guard`}
          data-state={rowSendGuard(props.item)?.state}
          class="text-[12px] leading-snug text-text-secondary"
        >
          {text()}
        </span>
      )}
    </Show>
  )
}

const SECONDARY =
  "flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium text-text-secondary transition-colors hover:bg-surface-hover hover:text-text disabled:opacity-50"

/** Buttons sized for the tier: a phone target is at least 44 px tall. */
function buttonClass(compact: boolean, bordered = true): string {
  return cn(
    SECONDARY,
    bordered && "border border-border",
    compact ? "min-h-11 px-3 text-[13px]" : "px-2 py-1 text-[12px]",
  )
}

/** Not now: the item leaves Home until next Monday 00:00 in the viewer's zone. */
export const NotNowButton: Component<{ item: AttentionItem; testId: string; compact: boolean }> = (
  props,
) => {
  const api = useApi()
  const i18n = useI18n()
  const [busy, setBusy] = createSignal(false)
  const run = async (e: MouseEvent): Promise<void> => {
    e.stopPropagation()
    if (busy()) return
    setBusy(true)
    try {
      await api.post("/attention-items/set-aside", { eventId: props.item.id })
      attentionStore.resolveLocally(props.item.id)
      addToast({ message: i18n.t("kernel.homeDecisions.setAside"), type: "success" })
      attentionStore.markStaleAndReload(api)
    } catch {
      addToast({ message: i18n.t("kernel.homeDecisions.setAsideFailed"), type: "error" })
    } finally {
      setBusy(false)
    }
  }
  return (
    <button
      type="button"
      data-testid={`${props.testId}-not-now`}
      disabled={busy()}
      onClick={(e) => void run(e)}
      class={buttonClass(props.compact, props.compact)}
    >
      {i18n.t("kernel.homeDecisions.notNow")}
    </button>
  )
}

/**
 * Ask the agent about a row: a normal turn in the viewer's Personal agent conversation, about
 * this item (the turn reads it as the current view), then that conversation opens.
 */
const AskAgentButton: Component<{
  item: AttentionItem
  testId: string
  compact: boolean
  label: string
  message: string
}> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const [busy, setBusy] = createSignal(false)
  const run = async (e: MouseEvent): Promise<void> => {
    e.stopPropagation()
    const action = props.item.action
    const me = userFromToken()
    if (busy() || action?.type !== "open_entity" || !me) return
    setBusy(true)
    try {
      const threadId = await ensurePersonalAgentDm(api)
      await sendMessage(
        api,
        threadId,
        props.message,
        { id: me.userId, name: me.name ?? "" },
        { currentView: { tabType: action.tabType, entityId: action.entityId } },
      )
      openTab({ type: "thread", entityId: threadId, label: props.label })
    } catch {
      addToast({ message: i18n.t("kernel.homeDecisions.askDraftFailed"), type: "error" })
    } finally {
      setBusy(false)
    }
  }
  return (
    <button
      type="button"
      data-testid={props.testId}
      disabled={busy()}
      onClick={(e) => void run(e)}
      class={buttonClass(props.compact)}
    >
      {props.label}
    </button>
  )
}

/** Ask agent to draft what an item that waits on a reply or a next step needs. */
export const AskDraftButton: Component<{
  item: AttentionItem
  testId: string
  compact: boolean
}> = (props) => {
  const i18n = useI18n()
  return (
    <AskAgentButton
      item={props.item}
      testId={`${props.testId}-ask-draft`}
      compact={props.compact}
      label={i18n.t("kernel.homeDecisions.askDraft")}
      message={i18n.t("kernel.homeDecisions.askDraftMessage", { summary: props.item.summary })}
    />
  )
}

/**
 * Ask agent to reassign the companies a departure left without an account manager: the turn
 * gets the row's line and the companies' ids, which the agent gives to someone in one call.
 */
export const AskReassignButton: Component<{
  item: AttentionItem
  testId: string
  compact: boolean
}> = (props) => {
  const i18n = useI18n()
  return (
    <Show when={unownedCompanyIds(props.item)}>
      {(ids) => (
        <AskAgentButton
          item={props.item}
          testId={`${props.testId}-ask-reassign`}
          compact={props.compact}
          label={i18n.t("kernel.homeDecisions.askReassign")}
          message={i18n.t("kernel.homeDecisions.askReassignMessage", {
            summary: props.item.summary,
            companyIds: ids().join(", "),
          })}
        />
      )}
    </Show>
  )
}

/**
 * Back to 5 days: on the row that says a colleague set the person's days per week, the person
 * sets it back themselves, in one press. It writes their own count and nothing else.
 */
export const BackToFiveDaysButton: Component<{
  item: AttentionItem
  testId: string
  compact: boolean
}> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const [busy, setBusy] = createSignal(false)
  const run = async (e: MouseEvent): Promise<void> => {
    e.stopPropagation()
    if (busy()) return
    setBusy(true)
    try {
      await runTool(
        api,
        "projects:time_settings_set",
        { daysPerWeek: 5 },
        { suppressGlobalError: true },
      )
      attentionStore.resolveLocally(props.item.id)
      attentionStore.markStaleAndReload(api)
    } catch {
      addToast({ message: i18n.t("kernel.homeDecisions.backToFiveDaysFailed"), type: "error" })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Show when={capacityNamedDays(props.item) !== null}>
      <button
        type="button"
        data-testid={`${props.testId}-back-to-five`}
        disabled={busy()}
        onClick={(e) => void run(e)}
        class={buttonClass(props.compact)}
      >
        {i18n.t("kernel.homeDecisions.backToFiveDays")}
      </button>
    </Show>
  )
}

/**
 * Dismiss: a stopped send's notice is read; a draft the check stopped is put away through its
 * own decision (`onDismiss`). Nothing is sent either way.
 */
export const DismissButton: Component<{
  item: AttentionItem
  testId: string
  compact: boolean
  onDismiss?: () => void
}> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  return (
    <button
      type="button"
      data-testid={`${props.testId}-dismiss`}
      onClick={(e) => {
        e.stopPropagation()
        if (props.onDismiss) props.onDismiss()
        else markAttentionRead(api, props.item.app, props.item.entity, props.item.entityId)
      }}
      class={buttonClass(props.compact)}
    >
      {i18n.t("kernel.homeDecisions.dismiss")}
    </button>
  )
}

/**
 * A stopped draft's ways forward, the same as on its card: a new reply from the message that
 * stopped it (primary) and where that message sits. Shown only when the viewer can open it.
 */
export const StoppedDraftActions: Component<{
  item: AttentionItem
  testId: string
  compact: boolean
}> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const [busy, setBusy] = createSignal(false)
  const guard = () => rowSendGuard(props.item)
  return (
    <>
      <Show when={redraftRecord(guard())}>
        <button
          type="button"
          data-testid={`${props.testId}-redraft`}
          disabled={busy()}
          onClick={(e) => {
            e.stopPropagation()
            const g = guard()
            if (!g || busy()) return
            setBusy(true)
            void startRedraft(api, g, props.item.summary, i18n.t).finally(() => setBusy(false))
          }}
          class={cn(
            "flex shrink-0 items-center justify-center rounded-md border border-accent-border bg-accent-glow font-medium text-accent transition-colors hover:bg-accent-wash disabled:opacity-50",
            props.compact ? "min-h-11 px-3 text-[13px]" : "px-2 py-1 text-[12px]",
          )}
        >
          {i18n.t("kernel.approvalsUi.sendGuard.redraft")}
        </button>
      </Show>
      <Show when={stopRecord(guard())}>
        {(record) => (
          <button
            type="button"
            data-testid={`${props.testId}-open-record`}
            onClick={(e) => {
              e.stopPropagation()
              openStopRecord(api, record(), openRecordLabel(record(), i18n.t))
            }}
            class={buttonClass(props.compact)}
          >
            {openRecordLabel(record(), i18n.t)}
          </button>
        )}
      </Show>
    </>
  )
}
