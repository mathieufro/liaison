// SPDX-License-Identifier: FSL-1.1-ALv2
// AttentionRow — the single attention surface row.
//
// Three regions:
//   1. Left rail (40px) — kind icon in `text-tertiary`. On row hover, a 2px
//      accent rail slides in along the left edge; the icon brightens.
//   2. Body (flex-1, never narrower than ~300px) — the title, wrapping to two
//      lines rather than truncating; for an approval, the summarizer's own
//      lines saying WHAT changes ("Label -> Idea"), then who/what it reaches,
//      then a quiet meta line (action, request handle, requester, age).
//   3. Actions — the metric ("24h left") and the buttons, right-aligned; on a
//      narrow row they wrap under the body instead of squeezing the title.
//
// The previous layout gave the title whatever was left after a chip, the
// metric and three buttons had taken their fixed widths — in a 720px column
// that was ~15 characters ("Update status ...", "Invoicin..."), and the one
// thing a reviewer needs (what the change IS) was not on the row at all.
//
// Approval rows handle the inline approve / reject flow inside the action
// region, replacing the open-button when the user clicks Reject.

import {
  type AttentionItem,
  humanizeRefTokens,
  parseThreadAnchor,
  type ThreadAnchor,
  threadAnchorMessageRoute,
  threadAnchorRoute,
  threadAnchorTitle,
} from "@liaison/shared"
import { Check, X } from "lucide-solid"
import { type Component, createEffect, createSignal, For, Match, Show, Switch } from "solid-js"
import { ApiError } from "~/lib/api-error"
import { isPendingSubtitle, readableSummaryLines } from "~/lib/approval-summary-lines"
import AccessRequestRow, { accessRequestOf } from "~/modules/admin-scope-requests/AccessRequestRow"
import { routineMailboxWaitOf } from "~/modules/agent/RoutineMailboxWaitRow"
import RoutineMailboxWaitsRow from "~/modules/agent/RoutineMailboxWaitsRow"
import ApprovalCard, { shortApprovalId } from "~/modules/approvals/ApprovalCard"
import {
  approvalActionLabel,
  approvalRowTitle,
  localizeApprovalText,
} from "~/modules/approvals/approval-copy"
import { notePayloadSeen, reviewedPayloadHash } from "~/modules/approvals/approvals-store"
import {
  decideErrorToast,
  handlerCause,
  localizedApprovalSubtitle,
} from "~/modules/approvals/decide-error"
import {
  isDecisionInFlight,
  isDecisionNotSent,
  isDecisionUndone,
  queueDecision,
} from "~/modules/approvals/decision-queue"
import { SummaryLineText } from "~/modules/approvals/SummaryLineText"
import { openExternal } from "~/modules/desktop/external-links"
import { useI18n } from "~/modules/i18n/i18n-context"
import { isMailSendTool } from "~/modules/mailbox/approval-mail-fulfilment"
import { nodePermissionPromptOf } from "~/modules/nodes/NodePermissionCard"
import { openNotificationRoute } from "~/modules/notifications/open-route"
import { useApi } from "~/modules/shell/ApiContext"
import { AppPill, appIdOfTool } from "~/modules/shell/AppPill"
import {
  AskDraftButton,
  AskReassignButton,
  BackToFiveDaysButton,
  DismissButton,
  GuardLine,
  isStoppedDraft,
  isStoppedSendNotice,
  NotNowButton,
  offersAskDraft,
  offersNotNow,
  rowSendGuard,
  StoppedDraftActions,
} from "~/modules/shell/AttentionRowExtras"
import { clearApprovalFocus, focusedApproval } from "~/modules/shell/approval-focus"
import {
  formatMetaLine,
  formatRelativeTime,
  getKindIcon,
  getMetric,
  kernelAttentionTitle,
  type MetricTone,
  rowLocaleFrom,
  sessionNoticeWords,
} from "~/modules/shell/attention-row-format"
import { attentionStore } from "~/modules/shell/attention-store"
import { markAttentionRead, openAttentionLink, openEntity } from "~/modules/shell/entity-opener"
import { AwayRecapLines, RouteWhyLine } from "~/modules/shell/route-line"
import { shellTier } from "~/modules/shell/shell-tier"
import { addToast } from "~/modules/shell/toast-store"
import { openReplyPanel } from "~/modules/threads/reply-panel-store"

interface AttentionRowProps {
  item: AttentionItem
}

const TONE_TEXT: Record<MetricTone, string> = {
  warning: "text-warning",
  tertiary: "text-text-tertiary",
  secondary: "text-text-secondary",
}

/** The app part of an action label ("Workspace: update skill" → "Workspace"), for the phone
 *  row's pill. A label with no app part is kept whole. */
export function shortActionLabel(label: string): string {
  const i = label.indexOf(": ")
  return i > 0 ? label.slice(0, i) : label
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value)
    return protocol === "http:" || protocol === "https:"
  } catch {
    return false
  }
}

const AttentionRowBody: Component<AttentionRowProps> = (props) => {
  const api = useApi()
  // The version of an approval this row first showed: what an approve from it is bound to.
  if (props.item.action?.type === "decide_approval") {
    notePayloadSeen(props.item.action.approvalId, props.item.action.payloadHash)
  }
  const i18n = useI18n()
  const rowLocale = () => rowLocaleFrom(i18n)
  // The phone tier gets a genuinely compact row. The desktop row's 40px icon
  // rail plus its `min-w-[300px]` body cannot share a 390px line, so the kind
  // glyph wrapped onto a line of its OWN above the title, the metric and the
  // three action buttons each took another line, and one approval filled half
  // the screen. Same data, one title line plus one meta line plus one action
  // row. Desktop and tablet keep the layout above unchanged.
  const compact = (): boolean => shellTier() === "phone"
  const [submitting, setSubmitting] = createSignal(false)
  const [showRejectInput, setShowRejectInput] = createSignal(false)
  const [rejectReason, setRejectReason] = createSignal("")
  // Approval rows expand in place to the FULL ApprovalCard (exact payload,
  // editable fields, deny-with-reason, origin links). An operator must be able
  // to see precisely what they are approving without leaving the feed.
  const [expanded, setExpanded] = createSignal(false)
  let rowEl: HTMLLIElement | undefined

  // Defensive: a malformed provider item without `action` must not crash the
  // whole feed (the kernel drops those now, but stale caches may linger).
  const isApproval = (): boolean => props.item.action?.type === "decide_approval"
  // Some approvals must be decided FROM THE RECORD, not from a feed row: a
  // customer-facing ticket reply cannot be judged without the conversation in
  // front of you. Declared per tool (`decideInContext`) and carried on the
  // attention metadata, so this row offers only a way into the ticket. This is
  // a deliberate-review affordance, not a security boundary -- the decide
  // endpoint is unchanged.
  const decideInContext = (): boolean => props.item.metadata?.decideInContext === true
  /** The record a decide-in-context approval acts on (backend-resolved). */
  const openTarget = (): { app: string; entity: string; entityId: string } | null => {
    const t = props.item.metadata?.openTarget as
      | { app?: unknown; entity?: unknown; entityId?: unknown }
      | undefined
    return t &&
      typeof t.app === "string" &&
      typeof t.entity === "string" &&
      typeof t.entityId === "string"
      ? { app: t.app, entity: t.entity, entityId: t.entityId }
      : null
  }
  /** Where the approval's item lives (`metadata.openLink`, the summary's first
   *  in-app link): the ticket, the mail thread, the invoice. A row decided
   *  inline still offers "Open" so the reviewer can read the record first. */
  const openLink = (): { app: string; entity: string; entityId: string } | null => {
    if (!isApproval() || decideInContext()) return null
    const l = props.item.metadata?.openLink as
      | { app?: unknown; entity?: unknown; entityId?: unknown }
      | undefined
    return l &&
      typeof l.app === "string" &&
      typeof l.entity === "string" &&
      typeof l.entityId === "string"
      ? { app: l.app, entity: l.entity, entityId: l.entityId }
      : null
  }
  const openLinked = (): void => {
    const l = openLink()
    if (!l) return
    void openEntity(api, l.app, l.entity, l.entityId, props.item.summary)
  }
  // A WEDGED approval (`metadata.wedged`, status `approving`) was already
  // approved; its execution never reported back. It is not a decision any
  // more, so the row offers no Approve/Reject (the walk showed both on a
  // 77-day-old RGPD delete) and no countdown: Details opens the card, which
  // explains the state and offers the close-out.
  const wedged = (): boolean => isApproval() && props.item.metadata?.wedged === true
  // A draft the send check stopped can no longer go out as written: Dismiss only.
  const stoppedDraft = (): boolean => isApproval() && isStoppedDraft(props.item)
  // A draft held by an auto-reply: the viewer's decision, made on its card (Keep holding, Send
  // now, Discard), never by an inline Approve. The row opens that card in place.
  const heldDraft = (): boolean => isApproval() && rowSendGuard(props.item)?.state === "held"
  const hasInlineActions = (): boolean =>
    isApproval() && !decideInContext() && !wedged() && !stoppedDraft() && !heldDraft()
  // The cause of the last approve that ran and failed with no effect (the
  // request is back at pending). Set from this row's own failed decide so the
  // banner shows at once, and read from the feed item (`metadata.lastFailure`,
  // the same record the expanded card reads) so it survives the toast and any
  // reload. Without it a row decided from the feed went back to looking like a
  // fresh request the moment the toast faded.
  const [localFailure, setLocalFailure] = createSignal<string | null>(null)
  const lastFailureMessage = (): string | null => {
    if (!isApproval()) return null
    if (wedged()) {
      const reason = props.item.metadata?.failureReason
      return typeof reason === "string" && reason.length > 0 ? reason : null
    }
    const local = localFailure()
    if (local) return local
    const f = props.item.metadata?.lastFailure as { message?: unknown } | undefined
    return f && typeof f.message === "string" && f.message.length > 0 ? f.message : null
  }
  // A decision this device stored too long ago was dropped at boot, unsent (decision-queue.ts).
  const NotSentLine = (): ReturnType<Component> => (
    <Show when={approvalId() !== null && isDecisionNotSent("approval", approvalId() as string)}>
      <div data-testid={`${testId()}-not-sent`} class="text-[12px] text-text-secondary">
        {i18n.t("kernel.decisionToast.notSent")}
      </div>
    </Show>
  )
  const LastFailureBanner = (): ReturnType<Component> => (
    <Show when={!expanded() ? lastFailureMessage() : null}>
      {(message) => (
        <div
          data-testid={`${testId()}-last-failure`}
          class="rounded border border-error-border/60 bg-error-glow px-2 py-1.5 text-[12px] text-error"
        >
          {i18n.t("kernel.approvalsUi.lastAttemptFailed")} {message()}
        </div>
      )}
    </Show>
  )
  // The requester's decision notification has no in-app detail view to open
  // (the scope-request inbox is admin-only), so it's informational-only:
  // not clickable, no Open button, and no approve/deny.
  const isScopeRequestDecided = (): boolean => props.item.kind === "scope_request_decided"
  // A stopped draft's Open only toggled its card, beside Details: its row offers the card's own
  // ways forward instead (StoppedDraftActions).
  const isNavigable = (): boolean =>
    (!hasInlineActions() &&
      !isScopeRequestDecided() &&
      !wedged() &&
      !stoppedDraft() &&
      !heldDraft()) ||
    (isApproval() && decideInContext())

  // Gated-action chip data (approval rows). `actionLabel` is the humanized
  // tool action ("Tickets: reply"); `approvalImpact` is the manifest's blast
  // radius. Missing impact reads as external (fail-safe, matches backend).
  const copyCtx = () => ({ t: i18n.t, locale: i18n.locale() })
  /** The tool the row is named after: a bundle head's outcome step, else the gated tool. */
  const namedToolName = (): unknown =>
    props.item.metadata?.outcomeToolName ?? props.item.metadata?.toolName
  const actionLabel = (): string | null => {
    // A declared pill names the row: a send-guard provider's for the mail's record ("Billing:
    // payment reminder"), else the tool's own (attention.ts).
    const pill = props.item.metadata?.pill as { label?: unknown; labelKey?: unknown } | undefined
    if (pill && typeof pill.label === "string" && pill.label.length > 0) {
      if (typeof pill.labelKey === "string") {
        const said = i18n.t(pill.labelKey)
        if (said !== pill.labelKey) return said
      }
      return pill.label
    }
    const v = props.item.metadata?.actionLabel
    const tool = namedToolName()
    return approvalActionLabel(
      typeof tool === "string" ? tool : null,
      typeof v === "string" && v !== "" ? v : null,
      copyCtx(),
    )
  }
  /** The app the gated action belongs to: the pill's colour. */
  const actionAppId = (): string | null => {
    const tool = namedToolName()
    return appIdOfTool(typeof tool === "string" ? tool : null)
  }
  /** The row's title in the reader's language (approvals are stored in English). */
  const title = (): string =>
    isApproval()
      ? approvalRowTitle(props.item, copyCtx())
      : // A kernel row's summary is a fixed English template (a reply row
        // quotes the message, whose failure line the runtime writes in English).
        kernelAttentionTitle(props.item, i18n.t)
  const approvalImpact = (): "external" | "internal" =>
    props.item.metadata?.approvalImpact === "internal" ? "internal" : "external"

  // "request-42": the handle from metadata (attention.ts), what an agent or a
  // colleague cites. The uuid prefix used to print next to it ("request-78 ·
  // d58b9985") and read as noise on every row; it stays reachable on hover
  // (title) and in the expanded card. Older cached items without a handle
  // fall back to the prefix so the row still has a citable reference.
  const approvalRef = (): string | null => {
    if (!isApproval()) return null
    // A held or stopped draft is the viewer's to read, not to cite: no request handle on it.
    const guardState = rowSendGuard(props.item)?.state
    if (guardState === "held" || stoppedDraft()) return null
    const h = props.item.metadata?.requestHandle
    return typeof h === "string" && h.length > 0 ? h : shortApprovalId(props.item.entityId)
  }
  /** The summarizer's WHAT-changes lines ("Label -> Idea"), when carried. */
  const summaryLines = (): string[] => {
    const v = props.item.metadata?.summaryLines
    return Array.isArray(v)
      ? readableSummaryLines(v.filter((l): l is string => typeof l === "string"))
          .slice(0, 3)
          .map((line) => localizeApprovalText(line, copyCtx()))
      : []
  }
  const requesterName = (): string | null => {
    const v = props.item.metadata?.requesterName
    return typeof v === "string" && v.length > 0 ? v : null
  }
  /** A sequence's steps, in the order they run, each by its own name: what
   *  approving the row brings about, step by step (attention.ts). */
  const bundleSequence = (): string[] => {
    const v = props.item.metadata?.bundleSequence
    if (!Array.isArray(v)) return []
    return v
      .map((step) =>
        step && typeof step === "object" && typeof (step as { title?: unknown }).title === "string"
          ? (step as { title: string }).title
          : null,
      )
      .filter((t): t is string => t !== null && t.length > 0)
      .map((t) => localizeApprovalText(t, copyCtx()))
  }
  const bundleSteps = (): number | null => {
    const v = props.item.metadata?.bundleSteps
    return typeof v === "number" && v > 1 ? v : null
  }
  const approvalId = (): string | null =>
    props.item.action?.type === "decide_approval" ? props.item.action.approvalId : null
  // Hidden for the whole decision, not only its Undo window: the decision
  // toast shows it being carried out, and the row comes back only when it
  // failed (decision-queue.ts).
  const rowDecisionInFlight = (): boolean => {
    const id = approvalId()
    return id !== null && isDecisionInFlight("approval", id)
  }

  /** The click ends a text selection made in this row (the person is copying
   *  text out of it): it neither opens nor folds the row. */
  const endsTextSelection = (): boolean => {
    const sel = typeof window === "undefined" ? null : window.getSelection()
    if (!sel || sel.isCollapsed || sel.toString().trim() === "") return false
    const node = sel.anchorNode ?? sel.focusNode
    return !!node && !!rowEl && rowEl.contains(node)
  }

  const handleClick = (): void => {
    if (endsTextSelection()) return
    if (isApproval() && decideInContext()) {
      // Go to the RECORD the approval acts on (metadata.openTarget), never the
      // approval entity: that resolved to the agent's working thread, which is
      // exactly the wrong place to judge a customer reply (reported 2026-08-06).
      const t = openTarget()
      void openEntity(
        api,
        t?.app ?? props.item.app,
        t?.entity ?? props.item.entity,
        t?.entityId ?? props.item.entityId,
        props.item.summary,
        {
          markAttentionRead: true,
        },
      )
      return
    }
    if (isApproval()) {
      setExpanded((v) => !v)
      return
    }
    if (!isNavigable()) return
    // A message in an entity's thread (a task comment) opens the ENTITY, with
    // the message brought into view in its discussion, never the bare thread.
    const a = anchor()
    const anchoredThread =
      props.item.entity === "thread"
        ? props.item.entityId
        : (props.item.metadata?.threadId as string | undefined)
    const anchoredMessage = props.item.metadata?.messageId
    // An entity whose app is switched off has no page: the row opens the thread itself.
    if (
      a &&
      a.state !== "gone" &&
      typeof anchoredThread === "string" &&
      anchoredThread.length > 0
    ) {
      void openNotificationRoute(
        typeof anchoredMessage === "string" && anchoredMessage.length > 0
          ? threadAnchorMessageRoute(a, anchoredThread, anchoredMessage)
          : threadAnchorRoute(a),
        api,
      )
      markAttentionRead(api, props.item.app, props.item.entity, props.item.entityId)
      return
    }
    const action = props.item.action
    // A17 / S6: a row about a message in a reply thread (a followup, a
    // mention in a reply) opens its channel with the reply panel on the root.
    const replyRootId = props.item.metadata?.replyRootId
    // A followup row is keyed on its reply thread's ROOT (entity
    // `reply_thread`), one row per followed root; it carries its channel in
    // `metadata.threadId`. Open that channel with the panel on the root, and
    // read this row alone: the channel's own rows are not read by it.
    const channelId = props.item.metadata?.threadId
    if (
      props.item.app === "kernel" &&
      props.item.entity === "reply_thread" &&
      typeof channelId === "string" &&
      channelId.length > 0
    ) {
      const messageId = props.item.metadata?.messageId
      openReplyPanel(channelId, props.item.entityId, {
        focusMessageId: typeof messageId === "string" ? messageId : null,
      })
      void openEntity(api, "kernel", "thread", channelId, props.item.summary)
      markAttentionRead(api, "kernel", "reply_thread", props.item.entityId)
      return
    }
    if (
      props.item.app === "kernel" &&
      props.item.entity === "thread" &&
      typeof replyRootId === "string" &&
      replyRootId.length > 0
    ) {
      const messageId = props.item.metadata?.messageId
      openReplyPanel(props.item.entityId, replyRootId, {
        focusMessageId: typeof messageId === "string" ? messageId : null,
      })
    }
    // A new-email item covering a burst links only its LATEST conversation; the
    // burst as a whole is read from the inbox (the mail:new_email opener).
    const mailBurst =
      props.item.app === "mail" &&
      props.item.entity === "new_email" &&
      typeof props.item.metadata?.count === "number" &&
      props.item.metadata.count > 1
    const link = props.item.metadata?.link as { tabType?: unknown } | undefined
    if (
      action?.type === "open_entity" &&
      !mailBurst &&
      typeof link?.tabType === "string" &&
      action.tabType === link.tabType
    ) {
      // The item names its destination (metadata.link): open THAT, and clear the
      // item by its own key (the link's id is not the item's entity id).
      void openAttentionLink(api, action.tabType, action.entityId, props.item.summary)
      markAttentionRead(api, props.item.app, props.item.entity, props.item.entityId)
      return
    }
    if (action?.type === "open_entity" && mailBurst) {
      void openEntity(api, "mail", "new_email", props.item.entityId, props.item.summary, {
        markAttentionRead: true,
      })
      return
    }
    if (action?.type === "open_entity") {
      // Items that know their exact destination sub-route carry it in
      // metadata.settingsRoute (e.g. connection-health items resolve the
      // app-specific reconnect page server-side).
      const settingsRoute = props.item.metadata?.settingsRoute
      void openEntity(api, props.item.app, props.item.entity, action.entityId, props.item.summary, {
        markAttentionRead: true,
        ...(typeof settingsRoute === "string" ? { routePath: settingsRoute } : {}),
      })
    } else if (action?.type === "open_url") {
      // Entity with no in-app view (e.g. a Shopify order, which opens the Shopify
      // admin directly). The URL is resolved server-side, so open it synchronously
      // from the click handler — an async gap here would trip the popup blocker.
      // Only http(s): a cached or hand-written item must never run javascript:,
      // data: or file: URLs from a click.
      if (isHttpUrl(action.url)) void openExternal(action.url)
      markAttentionRead(api, props.item.app, props.item.entity, props.item.entityId)
    }
  }

  const decide = async (decision: "approve" | "deny", reason?: string): Promise<void> => {
    if (submitting()) return
    const target: { kind: "approval"; id: string } | null =
      props.item.action?.type === "decide_approval"
        ? { kind: "approval", id: props.item.action.approvalId }
        : null
    if (!target) return
    setSubmitting(true)
    setLocalFailure(null)
    try {
      // An approve is bound to the payload the person first saw (this row's fingerprint when it
      // first appeared, or the card's), never to a later version a feed reload brought in: an edit
      // made since is refused by the server and has to be read first.
      const payloadHash =
        decision === "approve" && props.item.action?.type === "decide_approval"
          ? (reviewedPayloadHash(props.item.action.approvalId) ?? props.item.action.payloadHash)
          : undefined
      // Behind the Undo window: the row hides now and the decision is sent
      // when the window ends (decision-queue.ts).
      await queueDecision(
        api,
        target.kind,
        target.id,
        {
          decision,
          ...(reason ? { reason } : {}),
          ...(payloadHash ? { payloadHash } : {}),
        },
        {
          label: {
            title: title(),
            detail: actionLabel(),
            // A sequence is one decision over every step: the toast says so.
            steps:
              bundleSequence().length > 1
                ? bundleSequence().map((t) => humanizeRefTokens(t))
                : null,
            // A stopped draft's Dismiss is a deny that reads as Dismissing.
            ...(decision === "deny" && stoppedDraft() ? { verb: "dismiss" as const } : {}),
          },
        },
      )
      // The decision is committed: the row goes now, the reload confirms.
      attentionStore.resolveLocally(props.item.id)
      attentionStore.markStaleAndReload(api)
    } catch (err) {
      // Undone inside its window: nothing was sent, the row is back as it was.
      if (isDecisionUndone(err)) {
        setSubmitting(false)
        return
      }
      // This used to be a bare `catch {}`: a rejected decide reset the button
      // and said NOTHING, so Approve read as a dead control and the same
      // request got clicked over and over (prod, 2026-08-04 -- Boxtal refused
      // shipment creation with InvalidPaymentException and the operator never
      // saw it). The row is not the card, so there is nowhere to render an
      // inline cause; a toast carrying the upstream reason is the whole point.
      addToast(
        err instanceof ApiError
          ? decideErrorToast(err, i18n.t).toast
          : { message: i18n.t("kernel.shellUi.couldnTReachServer"), type: "error" },
      )
      // A TERMINAL failure means this row is describing an approval that is
      // already gone: 409 (someone else decided it) and 404 (it no longer
      // exists) are both resolved states, not retryable ones. Only the SUCCESS
      // path used to reload the feed, so the row stayed put under a toast that
      // said it was already decided, and the operator pressed Approve on it
      // again, and again (prod, ticket-10197 / ticket-10200: two "Stalled:
      // Knowledge: update" rows that could not be cleared). Reload so the dead
      // row disappears — the toast explains why it vanished.
      if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
        attentionStore.markStaleAndReload(api)
      }
      // The handler ran and failed with no effect: the request is pending again
      // and the row stays (no reload: it is still live). Its cause stays on the
      // row once the toast fades; the next feed load carries it as
      // `metadata.lastFailure` (see lastFailureMessage).
      if (err instanceof ApiError && err.status === 422 && err.code === "handler_failed") {
        setLocalFailure(handlerCause(err) ?? err.message)
      }
      setSubmitting(false)
    }
  }

  // A mail send from an end-to-end encrypted mailbox can only be approved with
  // its draft decrypted in this browser, which the card does and a bare
  // decision cannot: the server refused every such Approve from Home with 409
  // `mailbox_fulfilment_required` (Fabrikam, 2026-10-01). So the row opens the
  // card with the press carried over, and the card approves.
  const [approveOnOpen, setApproveOnOpen] = createSignal(false)
  const onApprove = (e: MouseEvent): void => {
    e.stopPropagation()
    const tool = props.item.metadata?.toolName
    if (isMailSendTool(typeof tool === "string" ? tool : null) && approvalId()) {
      setApproveOnOpen(true)
      setExpanded(true)
      return
    }
    void decide("approve")
  }
  const onRejectStart = (e: MouseEvent): void => {
    e.stopPropagation()
    setShowRejectInput(true)
  }
  const onRejectSubmit = (e: MouseEvent): void => {
    e.stopPropagation()
    void decide("deny", rejectReason().trim() || undefined)
  }

  /** The acted-on record's id (`ticket-B2B-123`), when the summary set one. */
  const recordRef = (): string | null => {
    const v = props.item.metadata?.ref
    return typeof v === "string" && v.length > 0 ? v : null
  }

  /** The approval summary's own "who/what" line, when the row is an approval. */
  const approvalSubtitle = (): string | null => {
    const v = props.item.metadata?.subtitle
    // The default summarizer's placeholder subtitle is a state claim frozen at
    // creation; on a wedged row it is false.
    if (wedged() && isPendingSubtitle(typeof v === "string" ? v : null)) return null
    return typeof v === "string" && v.length > 0
      ? localizeApprovalText(localizedApprovalSubtitle(v, i18n.t), copyCtx())
      : null
  }

  // LIF-18: a notification about this approval opened Home for it. The row
  // opens its card and comes into view, once; the request is then spent.
  createEffect(() => {
    const focus = focusedApproval()
    if (focus === null || !isApproval() || props.item.entityId !== focus) return
    setExpanded(true)
    clearApprovalFocus(focus)
    // After the expanded card rendered, so the whole card is what comes into view.
    setTimeout(() => rowEl?.scrollIntoView?.({ block: "center", behavior: "smooth" }), 0)
  })

  /** The tool an approval row's request runs; undefined on any other row. */
  const approvalToolName = (): string | undefined => {
    const tool = props.item.metadata?.toolName
    return isApproval() && typeof tool === "string" ? tool : undefined
  }
  /** Why the row is the reader's (`standing_in`: they hold it for someone away), for a tour to ring it. */
  const placement = (): string | undefined => {
    const p = props.item.metadata?.placement
    return typeof p === "string" ? p : undefined
  }

  const testId = (): string =>
    `attention-row-${props.item.app}-${props.item.entity}-${props.item.entityId}`

  /** The entity the row's conversation belongs to (a task's comments): named on the row. */
  const anchor = (): ThreadAnchor | null =>
    props.item.app === "kernel" ? parseThreadAnchor(props.item.metadata?.threadAnchor) : null
  const AnchorLine = (): ReturnType<Component> => (
    <Show when={anchor()}>
      {(a) => (
        <span
          data-testid={`${testId()}-anchor`}
          class="min-w-0 truncate text-[12px] leading-snug text-text-secondary"
          title={threadAnchorTitle(a(), i18n.t)}
        >
          {threadAnchorTitle(a(), i18n.t)}
        </span>
      )}
    </Show>
  )

  /**
   * Whether the summarizer title says nothing the action badge beside it has
   * not already said. "Knowledge: create" as a badge with "Knowledge Create" as
   * the title is the same three words twice on a 390px row; the badge alone is
   * enough. Compared on letters and digits only so punctuation and casing do
   * not hide the repetition.
   */
  const titleRepeatsBadge = (): boolean => {
    const label = isApproval() ? actionLabel() : null
    if (label === null) return false
    const fold = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "")
    return fold(label) === fold(title())
  }

  /**
   * The phone row's single meta line: who, when and how long is left, as one
   * plain sentence. The deadline is PROSE here, not the desktop row's mono
   * warning chip: on a phone it is the only place the figure fits, and a lone
   * orange monospace "44m left" floating in a column of its own was the loudest
   * thing on the screen for the least important reason.
   */
  const compactSecondary = (): string => {
    const parts: string[] = []
    if (isApproval()) {
      // No request handle here: on a phone it led the line ("demo-reply-kestrel-10-…") where the
      // reader looks for who asked. It stays citable on the desktop row and in the card's chip.
      const by = requesterName()
      if (by) parts.push(i18n.t("kernel.shellUi.byName", { name: by }))
      parts.push(formatRelativeTime(props.item.occurredAt, { i18n: rowLocale() }))
    } else {
      parts.push(formatMetaLine(props.item, rowLocale()))
    }
    return parts.filter((p) => p !== "").join(" · ")
  }

  /**
   * How long is left, kept OUT of the truncating byline.
   *
   * It used to be the last segment of one truncated line, so a row read "by
   * Amina Cherif · 2…" and the "3d left" the row exists to convey never
   * appeared at all. It is the one figure on the line with a deadline attached,
   * so it is the one segment that may not be dropped: the byline truncates and
   * this does not.
   */
  const compactMetric = (): string => getMetric(props.item, rowLocale()).text

  const KindIcon = (): ReturnType<Component> => {
    const k = getKindIcon(props.item.kind)
    const Icon = k.icon as Component<{ size?: number; class?: string }>
    return (
      <Icon
        size={14}
        class={
          k.tone === "warning"
            ? "text-warning"
            : "text-text-tertiary transition-colors duration-150 group-hover/row:text-text-secondary"
        }
      />
    )
  }

  return (
    // A decision waiting out its Undo window hides the row; Undo brings it back.
    <Show when={!rowDecisionInFlight()}>
      <Show when={compact()}>
        <li
          ref={rowEl}
          class="group/row relative flex flex-col gap-1 px-3 py-2.5 transition-colors hover:bg-surface-hover/50"
          classList={{ "cursor-pointer": isNavigable() }}
          data-testid={`attention-row-${props.item.app}-${props.item.entity}-${props.item.entityId}`}
          data-kind={props.item.kind}
          /* Which tool an approval runs, so a guided tour can ring one kind of
             request in Home (the routine's web lookup), as on its card. */
          data-tool-name={approvalToolName()}
          data-placement={placement()}
          data-compact="true"
          onClick={handleClick}
        >
          {/* Title line: the kind glyph INLINE before the title (a lock, a
              bell), the action badge, the title, and the details chevron at the
              row end. One line, truncated, never two. */}
          <div data-testid={`${testId()}-title-line`} class="flex min-w-0 items-center gap-1.5">
            <span class="flex shrink-0 items-center">
              <KindIcon />
            </span>
            <Show when={isApproval() ? actionLabel() : null}>
              {(label) => (
                <AppPill
                  appId={actionAppId()}
                  testid={`${testId()}-action-chip`}
                  data-impact={approvalImpact()}
                  class="shrink-0 px-1.5 py-px text-[11px] font-semibold leading-tight"
                  title={label()}
                >
                  {/* The app alone ("Workspace"), so the title leads the phone row; the
                      action itself is the title's own words (P-05). A title that only
                      repeats the badge is not shown, so the badge then stays whole. */}
                  {titleRepeatsBadge() ? label() : shortActionLabel(label())}
                </AppPill>
              )}
            </Show>
            <Show when={!titleRepeatsBadge()}>
              <span
                data-testid={`${testId()}-title`}
                class="min-w-0 flex-1 truncate text-[14px] font-medium leading-snug text-text"
                title={title()}
              >
                {title()}
              </span>
            </Show>
            <Show when={isApproval() && !decideInContext()}>
              <button
                type="button"
                data-testid={`${testId()}-details`}
                aria-expanded={expanded()}
                aria-label={i18n.t("kernel.homeRowDetails")}
                onClick={(e) => {
                  e.stopPropagation()
                  setExpanded((v) => !v)
                }}
                class="ml-auto flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-secondary"
              >
                <span
                  aria-hidden="true"
                  class="font-mono text-[13px] leading-none transition-transform duration-150"
                  classList={{ "rotate-90": expanded() }}
                >
                  ›
                </span>
              </button>
            </Show>
          </div>
          <AnchorLine />
          {/* One meta line: who, when, how long is left. The byline truncates,
              the deadline never does. */}
          <span
            data-testid={`${testId()}-secondary`}
            class="flex min-w-0 items-center gap-1.5 text-[12px] leading-snug text-text-tertiary"
          >
            <span class="min-w-0 truncate">{compactSecondary()}</span>
            <Show when={compactMetric()}>
              {(metric) => (
                <span data-testid={`${testId()}-deadline`} class="shrink-0">
                  {metric()}
                </span>
              )}
            </Show>
          </span>
          <LastFailureBanner />
          <NotSentLine />
          <GuardLine item={props.item} testId={testId()} />
          <RouteWhyLine item={props.item} testId={testId()} />
          <AwayRecapLines item={props.item} testId={testId()} />
          <Show
            when={
              hasInlineActions() ||
              isNavigable() ||
              stoppedDraft() ||
              (props.item.persisted && !isNavigable())
            }
          >
            <div data-testid={`${testId()}-actions`} class="mt-1 flex items-stretch gap-2">
              {/* One live pair at a time. Expanding the row renders the full
                  ApprovalCard underneath, which carries its own Approve /
                  Reject: two pairs with different wording, both live, on one
                  phone screen. The row's pair stands down while the card is
                  open. */}
              <Show when={hasInlineActions() && !expanded()}>
                <ApprovalActions
                  compact
                  testId={testId()}
                  submitting={submitting()}
                  showRejectInput={showRejectInput()}
                  rejectReason={rejectReason()}
                  onApprove={onApprove}
                  onRejectStart={onRejectStart}
                  onRejectSubmit={onRejectSubmit}
                  onRejectInput={setRejectReason}
                />
              </Show>
              <Show when={openLink() && !expanded()}>
                <button
                  type="button"
                  data-testid={`${testId()}-open-link`}
                  onClick={(e) => {
                    e.stopPropagation()
                    openLinked()
                  }}
                  class="flex min-h-11 shrink-0 items-center justify-center rounded-md border border-border px-3 text-[13px] font-medium text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
                >
                  {i18n.t("kernel.homeRowOpen")}
                </button>
              </Show>
              <Show when={isNavigable()}>
                <button
                  type="button"
                  data-testid={`${testId()}-open`}
                  onClick={(e) => {
                    e.stopPropagation()
                    handleClick()
                  }}
                  class="flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-md border border-accent-border bg-accent-glow px-3 text-[13px] font-medium text-accent transition-colors hover:bg-accent-wash"
                >
                  {isApproval() && decideInContext()
                    ? i18n.t("kernel.homeRowOpenTicket")
                    : i18n.t("kernel.homeRowOpen")}
                </button>
              </Show>
              <Show when={offersAskDraft(props.item)}>
                <AskDraftButton item={props.item} testId={testId()} compact />
              </Show>
              <AskReassignButton item={props.item} testId={testId()} compact />
              <BackToFiveDaysButton item={props.item} testId={testId()} compact />
              <Show when={offersNotNow(props.item)}>
                <NotNowButton item={props.item} testId={testId()} compact />
              </Show>
              <Show when={stoppedDraft()}>
                <StoppedDraftActions item={props.item} testId={testId()} compact />
              </Show>
              <Show when={stoppedDraft() || isStoppedSendNotice(props.item)}>
                <DismissButton
                  item={props.item}
                  testId={testId()}
                  compact
                  {...(stoppedDraft() ? { onDismiss: () => void decide("deny") } : {})}
                />
              </Show>
              <Show
                when={
                  props.item.persisted && !hasInlineActions() && !isStoppedSendNotice(props.item)
                }
              >
                <button
                  type="button"
                  data-testid={`${testId()}-mark-read`}
                  title={i18n.t("kernel.homeRowMarkAsRead")}
                  onClick={(e) => {
                    e.stopPropagation()
                    markAttentionRead(api, props.item.app, props.item.entity, props.item.entityId)
                  }}
                  class="flex min-h-11 shrink-0 items-center gap-1.5 rounded-md border border-border px-3 text-[13px] font-medium text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
                >
                  <Check size={13} />
                  {i18n.t("kernel.homeRowRead")}
                </button>
              </Show>
            </div>
          </Show>
          <Show when={expanded() && approvalId()}>
            <div
              data-testid={`${testId()}-expanded`}
              onClick={(e) => e.stopPropagation()}
              // A held draft's row opens its own card: brought into view, not left below the fold.
              ref={(el) => {
                if (heldDraft()) queueMicrotask(() => el.scrollIntoView?.({ block: "nearest" }))
              }}
            >
              <ApprovalCard
                requestId={approvalId()!}
                compact={false}
                approveOnOpen={approveOnOpen()}
                inFeed
              />
            </div>
          </Show>
        </li>
      </Show>
      <Show when={!compact()}>
        <li
          ref={rowEl}
          class="group/row relative flex flex-wrap items-start gap-x-3 gap-y-2 py-3 pl-0 pr-4 transition-colors hover:bg-surface-hover/50"
          classList={{ "cursor-pointer": isNavigable() }}
          data-testid={`attention-row-${props.item.app}-${props.item.entity}-${props.item.entityId}`}
          data-kind={props.item.kind}
          /* Which tool an approval runs, so a guided tour can ring one kind of
             request in Home (the routine's web lookup), as on its card. */
          data-tool-name={approvalToolName()}
          data-placement={placement()}
          onClick={handleClick}
        >
          {/* Accent rail — appears only on row hover, anchored to the left edge. */}
          <span
            aria-hidden="true"
            class="pointer-events-none absolute left-0 top-2 bottom-2 w-[2px] rounded-r bg-accent opacity-0 transition-opacity duration-150 group-hover/row:opacity-100"
          />
          {/* Kind icon rail (40px), aligned with the first text line. */}
          <span class="flex h-5 w-10 shrink-0 items-center justify-center">
            <KindIcon />
          </span>
          {/* Body: title, what changes, who it reaches, meta. */}
          <div class="flex min-w-[300px] flex-1 flex-col gap-1">
            <span
              data-testid={`${testId()}-title`}
              class="line-clamp-2 text-[14px] font-medium leading-snug text-text"
              title={title()}
            >
              {/* Gated-action chip on approval rows: WHAT action pends ("Tickets:
              reply"), in its app's colour (AppPill) so a pile sorts by app at
              a glance. The colour names the app, not the risk: the blast
              radius stays on `data-impact` and in the expanded card.
              Leads the title, the most important thing on the row — telling
              a reviewer what they are approving or denying without opening
              it. Absent on older cached items that carry no actionLabel. */}
              {/* WHICH record, by the id people use (`ticket-B2B-123`), before
              anything else: the approval card leads with it too. */}
              <Show when={isApproval() ? recordRef() : null}>
                {(ref) => (
                  <span
                    data-testid={`${testId()}-record-ref`}
                    class="mr-1.5 inline-block shrink-0 rounded border border-border-subtle px-1 py-px align-middle font-mono text-[11.5px] font-normal leading-tight text-text-secondary"
                  >
                    {ref()}
                  </span>
                )}
              </Show>
              <Show when={isApproval() ? actionLabel() : null}>
                {(label) => (
                  <AppPill
                    appId={actionAppId()}
                    testid={`${testId()}-action-chip`}
                    data-impact={approvalImpact()}
                    class="mr-1.5 inline-block shrink-0 px-1.5 py-px align-middle text-[11.5px] font-semibold leading-tight"
                  >
                    {label()}
                  </AppPill>
                )}
              </Show>
              {title()}
              <Show when={bundleSteps()}>
                {(n) => (
                  <span class="ml-1.5 font-mono text-[11px] font-normal text-text-tertiary">
                    {n()} {i18n.t("kernel.shellUi.steps")}
                  </span>
                )}
              </Show>
            </span>
            <AnchorLine />
            {/* S16: a computer session's own words (its notice body), plain text. */}
            <Show when={sessionNoticeWords(props.item)}>
              {(words) => (
                <span
                  data-testid={`${testId()}-body`}
                  class="line-clamp-2 text-[12.5px] leading-snug text-text-secondary"
                >
                  {words()}
                </span>
              )}
            </Show>
            <Show when={bundleSequence().length > 1}>
              <ol
                data-testid={`${testId()}-sequence`}
                aria-label={i18n.t("kernel.approvalsUi.stepSequence")}
                class="flex flex-col gap-0.5 border-l-2 border-border pl-2.5 text-[12.5px] leading-snug text-text-secondary"
              >
                <For each={bundleSequence()}>
                  {(title, i) => (
                    <li class="truncate" data-testid={`${testId()}-sequence-step-${i() + 1}`}>
                      <span class="font-mono text-[11px] text-text-tertiary">{i() + 1}.</span>{" "}
                      <SummaryLineText line={title} format={humanizeRefTokens} />
                    </li>
                  )}
                </For>
              </ol>
            </Show>
            <Show when={bundleSequence().length <= 1 && summaryLines().length > 0}>
              <ul
                data-testid={`${testId()}-lines`}
                class="flex flex-col gap-0.5 border-l-2 border-border pl-2.5 text-[12.5px] leading-snug text-text-secondary"
              >
                <For each={summaryLines()}>
                  {(line) => (
                    <li class="truncate">
                      <SummaryLineText line={line} format={humanizeRefTokens} />
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            {/* WHO/WHAT this reaches. An approval row led with the action and the
            entity, so judging it meant opening it just to learn whose reply
            or which customer's shipment it was (ticket-10176). */}
            <Show when={approvalSubtitle()}>
              <span
                class="truncate text-[12px] leading-snug text-text-secondary"
                data-testid={`${testId()}-subtitle`}
              >
                {approvalSubtitle()}
              </span>
            </Show>
            <LastFailureBanner />
            <NotSentLine />
            <GuardLine item={props.item} testId={testId()} />
            <RouteWhyLine item={props.item} testId={testId()} />
            <AwayRecapLines item={props.item} testId={testId()} />
            <span class="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] leading-snug text-text-tertiary">
              <Show
                when={isApproval()}
                fallback={<span>{formatMetaLine(props.item, rowLocale())}</span>}
              >
                {/* The reference an agent or a colleague cites ("approve
                request-42"), citable from the collapsed row. */}
                {/* Who asked and when lead; the handle comes last, a reference to cite and
                    never the line's main text (cold walk: "demo-…" slugs read as the summary). */}
                <Show when={requesterName()}>
                  {(name) => (
                    <span data-testid={`${testId()}-requester`}>
                      {i18n.t("kernel.shellUi.by")} {name()}
                      <span aria-hidden="true"> ·</span>
                    </span>
                  )}
                </Show>
                <span>{formatRelativeTime(props.item.occurredAt, { i18n: rowLocale() })}</span>
                <Show when={approvalRef()}>
                  {(ref) => (
                    <span>
                      <span aria-hidden="true">· </span>
                      <span
                        data-testid={`${testId()}-ref`}
                        class="font-mono"
                        title={props.item.entityId}
                      >
                        {ref()}
                      </span>
                    </span>
                  )}
                </Show>
              </Show>
            </span>
          </div>
          {/* Metric + actions. `ml-auto` keeps them right-aligned; on a narrow row
          the whole cluster wraps under the body instead of eating the title.
          At phone width (below `sm`, 640px) the cluster itself wraps again:
          the approval actions (Approve/Reject, or the reject reason field)
          take the FULL row width so they never compete for space with the
          metric or Details, and Details drops to its own line below them if
          there still is not room — at 390px an unwrapped row of deadline,
          Approve, Reject and Details clipped the Details control (F2). */}
          <div class="ml-auto flex w-full shrink-0 flex-wrap items-center justify-end gap-2 self-center pl-10 sm:w-auto sm:flex-nowrap sm:pl-0">
            <Show when={getMetric(props.item, rowLocale()).text}>
              <span
                data-testid={`${testId()}-metric`}
                class={`shrink-0 font-mono text-[11px] tabular-nums ${
                  TONE_TEXT[getMetric(props.item, rowLocale()).tone]
                }`}
              >
                {getMetric(props.item, rowLocale()).text}
              </span>
            </Show>
            {/* See the compact branch: the expanded card owns the decision. */}
            <Show when={hasInlineActions() && !expanded()}>
              <ApprovalActions
                testId={testId()}
                submitting={submitting()}
                showRejectInput={showRejectInput()}
                rejectReason={rejectReason()}
                onApprove={onApprove}
                onRejectStart={onRejectStart}
                onRejectSubmit={onRejectSubmit}
                onRejectInput={setRejectReason}
              />
            </Show>
            {/* Explicit dismiss for persisted event rows (notifications, decisions):
            the row must be clearable without opening its target. Approvals
            clear through their decision instead. Dimmed at rest,
            never hidden (ticket-10174): opacity only, so nothing resizes under
            the cursor (ticket-10226). */}
            <Show when={offersAskDraft(props.item)}>
              <AskDraftButton item={props.item} testId={testId()} compact={false} />
            </Show>
            <AskReassignButton item={props.item} testId={testId()} compact={false} />
            <BackToFiveDaysButton item={props.item} testId={testId()} compact={false} />
            <Show when={offersNotNow(props.item)}>
              <NotNowButton item={props.item} testId={testId()} compact={false} />
            </Show>
            <Show when={stoppedDraft()}>
              <StoppedDraftActions item={props.item} testId={testId()} compact={false} />
            </Show>
            <Show when={stoppedDraft() || isStoppedSendNotice(props.item)}>
              <DismissButton
                item={props.item}
                testId={testId()}
                compact={false}
                {...(stoppedDraft() ? { onDismiss: () => void decide("deny") } : {})}
              />
            </Show>
            <Show
              when={props.item.persisted && !hasInlineActions() && !isStoppedSendNotice(props.item)}
            >
              <button
                type="button"
                data-testid={`${testId()}-mark-read`}
                title={i18n.t("kernel.homeRowMarkAsRead")}
                onClick={(e) => {
                  e.stopPropagation()
                  markAttentionRead(api, props.item.app, props.item.entity, props.item.entityId)
                }}
                class="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium text-text-tertiary opacity-60 transition-all duration-150 hover:bg-surface-hover hover:text-accent group-hover/row:opacity-100"
              >
                <Check size={12} />
                {i18n.t("kernel.homeRowRead")}
              </button>
            </Show>
            {/* A decide-in-context approval offers ONE always-visible way into the
            record (a customer reply is judged from the ticket, not from a feed
            row). It used to render this button AND the generic Open button
            below it, both labelled "Open ticket" — twice on every row. */}
            <Show when={isNavigable()}>
              <button
                type="button"
                data-testid={`${testId()}-open`}
                onClick={(e) => {
                  e.stopPropagation()
                  handleClick()
                }}
                class={
                  isApproval() && decideInContext()
                    ? "flex shrink-0 items-center gap-1.5 rounded-md border border-accent-border bg-accent-glow px-2.5 py-1.5 text-[12.5px] font-medium text-accent transition-colors hover:bg-accent-wash"
                    : "flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium text-text-tertiary opacity-60 transition-all duration-150 hover:bg-surface-hover hover:text-accent group-hover/row:opacity-100"
                }
              >
                {isApproval() && decideInContext()
                  ? i18n.t("kernel.homeRowOpenTicket")
                  : i18n.t("kernel.homeRowOpen")}
                <KbdHint k="O" />
              </button>
            </Show>
            <Show when={openLink()}>
              <button
                type="button"
                data-testid={`${testId()}-open-link`}
                onClick={(e) => {
                  e.stopPropagation()
                  openLinked()
                }}
                class="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] font-medium text-text-tertiary transition-all duration-150 hover:bg-surface-hover hover:text-accent"
              >
                {i18n.t("kernel.homeRowOpen")}
              </button>
            </Show>
            <Show when={isApproval() && !decideInContext()}>
              {/* Details affordance — the row itself toggles too; the chevron makes
              the expandability discoverable. */}
              <button
                type="button"
                data-testid={`${testId()}-details`}
                aria-expanded={expanded()}
                onClick={(e) => {
                  e.stopPropagation()
                  setExpanded((v) => !v)
                }}
                class="flex shrink-0 items-center gap-1 rounded-md px-2 py-1.5 text-[12px] font-medium text-text-tertiary transition-all duration-150 hover:bg-surface-hover hover:text-text-secondary"
              >
                <span
                  aria-hidden="true"
                  class="font-mono text-[10px] transition-transform duration-150"
                  classList={{ "rotate-90": expanded() }}
                >
                  ›
                </span>
                {i18n.t("kernel.homeRowDetails")}
              </button>
            </Show>
          </div>
          <Show when={expanded() && approvalId()}>
            {/* Full approval card inline: exact payload, editable fields, origin
            deep-links — everything the operator needs to validate the action
            without leaving the feed. */}
            <div
              data-testid={`${testId()}-expanded`}
              class="basis-full pl-10"
              onClick={(e) => e.stopPropagation()}
            >
              <ApprovalCard
                requestId={approvalId()!}
                compact={false}
                approveOnOpen={approveOnOpen()}
                inFeed
              />
            </div>
          </Show>
        </li>
      </Show>
    </Show>
  )
}

const ApprovalActions: Component<{
  /** Phone tier: Approve and Reject as two equal 44px buttons on their own
   *  row, no keyboard hints (there is no keyboard behind them). */
  compact?: boolean
  testId: string
  submitting: boolean
  showRejectInput: boolean
  rejectReason: string
  onApprove: (e: MouseEvent) => void
  onRejectStart: (e: MouseEvent) => void
  onRejectSubmit: (e: MouseEvent) => void
  onRejectInput: (v: string) => void
}> = (props) => {
  const i18n = useI18n()
  return (
    // `w-full` at phone tier is what forces this whole group onto its OWN
    // line inside the wrapping actions row (AttentionRow): a 100%-width flex
    // child always starts a fresh line among wrapped siblings. `sm:w-auto`
    // gives it back to content width above the phone breakpoint.
    <div
      class={
        props.compact
          ? "flex min-w-0 flex-1 items-stretch gap-2"
          : "flex w-full shrink-0 items-center gap-1.5 sm:w-auto"
      }
    >
      <Show
        when={!props.showRejectInput}
        fallback={
          <>
            <input
              data-testid={`${props.testId}-reject-reason`}
              type="text"
              class={
                props.compact
                  ? "min-h-11 min-w-0 flex-1 rounded-md border border-border bg-bg px-2.5 text-[13px] text-text outline-none focus:border-accent-border"
                  : "w-full min-w-0 flex-1 rounded-md border border-border bg-bg px-2.5 py-1.5 text-[12.5px] text-text outline-none focus:border-accent-border sm:w-44 sm:flex-none"
              }
              placeholder={i18n.t("kernel.reasonOptional")}
              value={props.rejectReason}
              onClick={(e) => e.stopPropagation()}
              onInput={(e) => props.onRejectInput((e.target as HTMLInputElement).value)}
            />
            <button
              type="button"
              data-testid={`${props.testId}-reject-submit`}
              class={
                props.compact
                  ? "flex min-h-11 shrink-0 items-center gap-1 rounded-md border border-warning-border bg-warning-glow px-3 text-[13px] font-medium text-warning hover:bg-warning-glow/80 disabled:opacity-50"
                  : "flex shrink-0 items-center gap-1 rounded-md border border-warning-border bg-warning-glow px-2.5 py-1.5 text-[12.5px] font-medium text-warning hover:bg-warning-glow/80 disabled:opacity-50"
              }
              disabled={props.submitting}
              onClick={props.onRejectSubmit}
            >
              <X size={12} />
              {props.submitting
                ? i18n.t("kernel.shellUi.rejecting")
                : i18n.t("kernel.common.reject")}
            </button>
          </>
        }
      >
        {/* Approve/Reject FILL the width of the group at phone tier (each an
            equal flex-1), instead of shrinking to content and leaving Details
            to fight the leftover space. */}
        <button
          type="button"
          data-testid={`${props.testId}-approve`}
          class={
            props.compact
              ? "flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-md bg-accent px-3 text-[13px] font-medium text-bg shadow-sm transition-colors hover:bg-accent-hover disabled:opacity-50"
              : "flex flex-1 items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-medium text-bg shadow-sm transition-colors hover:bg-accent-hover disabled:opacity-50 sm:flex-initial"
          }
          disabled={props.submitting}
          onClick={props.onApprove}
        >
          <Check size={12} />
          {props.submitting ? i18n.t("kernel.shellUi.approving") : i18n.t("kernel.common.approve")}
          <Show when={!props.compact}>
            <KbdHint k="A" />
          </Show>
        </button>
        <button
          type="button"
          data-testid={`${props.testId}-reject`}
          class={
            props.compact
              ? "flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-md border border-border px-3 text-[13px] font-medium text-text-secondary transition-colors hover:bg-surface-hover hover:text-text disabled:opacity-50"
              : "flex flex-1 items-center justify-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12.5px] font-medium text-text-secondary transition-colors hover:bg-surface-hover hover:text-text disabled:opacity-50 sm:flex-initial"
          }
          disabled={props.submitting}
          onClick={props.onRejectStart}
        >
          {i18n.t("kernel.common.reject")}
          <Show when={!props.compact}>
            <KbdHint k="R" />
          </Show>
        </button>
      </Show>
    </div>
  )
}

/**
 * Tiny `[X]` keyboard hint chip — Geist Mono, dimmed until the row is hovered.
 *
 * It used to be `hidden` and flip to `inline-block` on hover, which is a
 * DISPLAY change: the chip took no space, then suddenly did, so every button
 * carrying one grew wider the instant the cursor entered the row. Approve and
 * Reject resized and shifted under a cursor already travelling towards them —
 * confusing to read and a genuine mis-click hazard on a row whose buttons send
 * mail (ticket-10226). The chip is now always laid out and only its OPACITY
 * changes, so the row's geometry is fixed and hovering merely brings the hint
 * forward.
 */
const KbdHint: Component<{ k: string }> = (props) => (
  <span
    aria-hidden="true"
    class="inline-block font-mono text-[10px] opacity-0 transition-opacity duration-150 group-hover/row:opacity-60"
  >
    [{props.k}]
  </span>
)

/**
 * One attention row. A computer chat's permission request is decided in its
 * chat (ThreadNodePermissions): here it is only a notification that the agent
 * needs you, which opens that chat.
 */
const AttentionRow: Component<AttentionRowProps> = (props) => {
  const i18n = useI18n()
  const item = (): AttentionItem => {
    const prompt = nodePermissionPromptOf(props.item)
    if (!prompt) return props.item
    const agent = prompt.agentName ?? i18n.t("kernel.nodes.permissionCard.yourAgent")
    return { ...props.item, summary: i18n.t("kernel.nodes.permissionCard.needsYou", { agent }) }
  }
  // The approvals list's two other kinds have rows of their own in the same
  // anatomy (DecisionRow): a routine run waiting for its owner's private
  // mailbox (Run now / Dismiss) and an access request (Grant / Deny).
  const wait = () => routineMailboxWaitOf(props.item)
  const access = () => accessRequestOf(props.item)
  return (
    <Switch fallback={<AttentionRowBody item={item()} />}>
      <Match when={wait()}>{(w) => <RoutineMailboxWaitsRow item={props.item} wait={w()} />}</Match>
      <Match when={access()}>{(a) => <AccessRequestRow item={props.item} facts={a()} />}</Match>
    </Switch>
  )
}

export default AttentionRow
