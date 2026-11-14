// SPDX-License-Identifier: FSL-1.1-ALv2

import { Hourglass } from "lucide-solid"
import { type Component, createEffect, createSignal, For, on, Show } from "solid-js"
import { env } from "~/lib/env"
import ScopeRequestToolCard from "~/modules/admin-scope-requests/ScopeRequestToolCard"
import { formatToolName } from "~/modules/agent/format-tool-name"
import { SetupChecklistCard, setupStateResult } from "~/modules/agent/SetupChecklistCard"
import { appAndTool, hasToolCard, ToolCard, toolCallFailed } from "~/modules/agent/ToolCard"
import { pageHandleOf } from "~/modules/app-pages/open-page"
import { PageHandleCard } from "~/modules/app-pages/PageHandleCard"
import ApprovalCard from "~/modules/approvals/ApprovalCard"
import { ensureLoaded, getById } from "~/modules/approvals/approvals-store"
import { BugReportDraftCard } from "~/modules/bug-report/BugReportDraftCard"
import { isDesktop } from "~/modules/desktop/desktop-store"
import LocalPermissionCard, { currentLocalPrompt } from "~/modules/desktop/LocalPermissionCard"
import { catalogHasKey, useI18n } from "~/modules/i18n/i18n-context"
import ImportRunCard from "~/modules/imports/ImportRunCard"
import { MailboxSetupCard, mailboxSetupCardRef } from "~/modules/mailbox/MailboxSetupCard"
import SecretRequestToolCard from "~/modules/secret-request/SecretRequestToolCard"
import { useOptionalApi } from "~/modules/shell/ApiContext"
import type { ToolCallState } from "~/modules/threads/message-store"

interface ToolCallRowProps {
  toolCall: ToolCallState
  /**
   * The turn this call belongs to: the id of the message that started it
   * (`metadata.turnId`, the live stream's `turnId`).
   */
  turnId?: string | null
  /**
   * The PERSON'S message the turn answers (`metadata.askId`, the live stream's
   * `askId`), which differs from `turnId` on the turn an approved call handed
   * back. `data-turn-id` on the row and on the approval card it raises is
   * `askId ?? turnId`, so a guided tour rings only the turn answering its own
   * request, never an earlier turn of the same conversation.
   */
  askId?: string | null
}

interface ToolCallGroupProps {
  toolCalls: ToolCallState[]
  turnId?: string | null
  /** See ToolCallRowProps.askId. */
  askId?: string | null
}

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-text-tertiary",
  running: "bg-accent animate-pulse",
  completed: "bg-green-500",
  error: "bg-red-500",
}

function statusStyle(status: string | undefined): string {
  return STATUS_STYLES[status ?? "completed"] ?? STATUS_STYLES.completed
}

function blockedPayload(
  result: unknown,
): { reason: string; approvalRequestId?: string; summary?: any } | null {
  if (result === null || typeof result !== "object") return null
  const obj = result as any
  if (obj.blocked === true) return obj
  if (obj.blocked && typeof obj.blocked === "object") return obj.blocked
  return null
}

/**
 * A dispatch to the person's computer waiting for their approval: its card is drawn at the END
 * of the turn (TurnEndApprovals), after the agent's closing words, not inside the tool row where
 * the summary that follows would push it out of sight.
 */
export function dispatchApprovalId(toolCall: ToolCallState): string | null {
  const name = toolCall.toolName
  if (name !== "kernel__run_on_my_computer" && name !== "kernel:run_on_my_computer") return null
  const id = blockedPayload(toolCall.result)?.approvalRequestId
  return typeof id === "string" && id.length > 0 ? id : null
}

/**
 * A pending request the agent edited in this step (kernel approval_update_payload): the person
 * decides on the edited version, so the step shows its card exactly as a step that filed one.
 */
export function editedApprovalId(toolCall: ToolCallState): string | null {
  const name = toolCall.toolName
  if (name !== "kernel__approval_update_payload" && name !== "kernel:approval_update_payload")
    return null
  if (toolCall.status === "error") return null
  const result = toolCall.result
  if (result === null || typeof result !== "object") return null
  const id = (result as { id?: unknown }).id
  return typeof id === "string" && id.length > 0 ? id : null
}

/** An access request the agent filed in this step (kernel request_scope): decided in place. */
export function requestedScopeId(toolCall: ToolCallState): string | null {
  const name = toolCall.toolName
  if (name !== "kernel__request_scope" && name !== "kernel:request_scope") return null
  if (toolCall.status === "error") return null
  const result = toolCall.result
  if (result === null || typeof result !== "object") return null
  const id = (result as { requestId?: unknown }).requestId
  return typeof id === "string" && id.length > 0 ? id : null
}

/** A secret the agent asked for in this step (kernel request_secret): typed into its card here. */
export function requestedSecretId(toolCall: ToolCallState): string | null {
  const name = toolCall.toolName
  if (name !== "kernel__request_secret" && name !== "kernel:request_secret") return null
  if (toolCall.status === "error") return null
  const result = toolCall.result
  if (result === null || typeof result !== "object") return null
  // The same pending card the conversation already shows (the server answered
  // `already_posted`): drawn once, where it was first posted.
  if ((result as { card?: unknown }).card === "already_posted") return null
  const id = (result as { requestId?: unknown }).requestId
  return typeof id === "string" && id.length > 0 ? id : null
}

/**
 * A bug report the agent prepared for the Liaison team in this step (kernel
 * report_bug on a team-only server): its reporter sends it from the card here.
 */
export function reportBugDraftId(toolCall: ToolCallState): string | null {
  const name = toolCall.toolName
  if (name !== "kernel__report_bug" && name !== "kernel:report_bug") return null
  if (toolCall.status === "error") return null
  const result = toolCall.result
  if (result === null || typeof result !== "object") return null
  if ((result as { awaitingConfirmation?: unknown }).awaitingConfirmation !== true) return null
  const id = (result as { draftId?: unknown }).draftId
  return typeof id === "string" && id.length > 0 ? id : null
}

/**
 * The import run a call shows (kernel import_start, import_status): the run it
 * started or read, or the approval an agent's start waits on (the card finds
 * the run that approval starts). A preview's status shows no card.
 */
export function importRunRef(
  toolCall: ToolCallState,
): { runId: string } | { approvalRequestId: string } | null {
  const name = toolCall.toolName.replace("kernel:", "kernel__")
  if (name !== "kernel__import_start" && name !== "kernel__import_status") return null
  if (toolCall.status === "error") return null
  const result = toolCall.result
  if (result === null || typeof result !== "object") return null
  if (name === "kernel__import_start") {
    const approval = blockedPayload(result)?.approvalRequestId
    if (typeof approval === "string" && approval.length > 0) return { approvalRequestId: approval }
  }
  if ((result as { preview?: unknown }).preview === true) return null
  const id = (result as { runId?: unknown }).runId
  return typeof id === "string" && id.length > 0 ? { runId: id } : null
}

/**
 * Group consecutive tool calls by name into stacks.
 * A run of 2+ calls to the same tool becomes a single group row, except a
 * call that draws a card the person acts on (a secure card, an access
 * request, an import run): it always stands as its own row. A collapsed
 * "Request Secret ×2" hid the Connect card the answer said was above
 * (2026-10-27).
 */
export interface ToolCallGroup {
  toolName: string
  calls: ToolCallState[]
}

/** A read of an app that draws nothing of its own: consecutive ones roll up to one line. */
export function isRolledUpRead(toolCall: ToolCallState): boolean {
  return (
    toolCall.readOnly === true &&
    !drawsCard(toolCall) &&
    rowApprovalId(toolCall) === null &&
    dispatchApprovalId(toolCall) === null
  )
}

/** The app a call reads, as its row names it: the registry's label, else the app id in words. */
export function callAppLabel(toolCall: ToolCallState): string {
  if (toolCall.appLabel) return toolCall.appLabel
  const app = appAndTool(toolCall.toolName)?.app
  return app ? formatToolName(app) : formatToolName(toolCall.toolName)
}

/** A call whose row draws a card the person acts on: never folded into a group. */
export function drawsCard(toolCall: ToolCallState): boolean {
  return (
    requestedSecretId(toolCall) !== null ||
    requestedScopeId(toolCall) !== null ||
    reportBugDraftId(toolCall) !== null ||
    importRunRef(toolCall) !== null ||
    mailboxSetupCardRef(toolCall) !== null ||
    hasToolCard(toolCall) ||
    pageHandleOf(toolCall) !== null
  )
}

/**
 * A turn's calls for a layout that folds them under one "Used N tools" line: the calls that
 * drew a result card stand under the message, as they do live, and only the rest fold.
 */
export function splitCardCalls(toolCalls: ToolCallState[]): {
  cards: ToolCallState[]
  folded: ToolCallState[]
} {
  const cards: ToolCallState[] = []
  const folded: ToolCallState[] = []
  for (const tc of toolCalls) (hasToolCard(tc) ? cards : folded).push(tc)
  return { cards, folded }
}

/**
 * Stack a turn's calls: at least 2 consecutive reads of apps with no card become one roll-up
 * group ("Read 3 apps"); otherwise consecutive calls of one tool stack as before.
 */
export function groupToolCalls(toolCalls: ToolCallState[]): ToolCallGroup[] {
  const groups: ToolCallGroup[] = []
  let i = 0
  while (i < toolCalls.length) {
    let end = i
    while (end < toolCalls.length && isRolledUpRead(toolCalls[end])) end++
    if (end - i >= 2) {
      groups.push({ toolName: toolCalls[i].toolName, calls: toolCalls.slice(i, end) })
      i = end
      continue
    }
    const tc = toolCalls[i]
    i++
    const last = groups[groups.length - 1]
    if (
      last &&
      last.toolName === tc.toolName &&
      !drawsCard(tc) &&
      !last.calls.some(drawsCard) &&
      !(last.calls.length >= 2 && last.calls.every(isRolledUpRead))
    ) {
      last.calls.push(tc)
    } else {
      groups.push({ toolName: tc.toolName, calls: [tc] })
    }
  }
  return groups
}

/** Single tool call row (used standalone or inside an expanded group). */
function SingleToolCallRow(props: ToolCallRowProps) {
  const i18n = useI18n()
  const [expanded, setExpanded] = createSignal(false)
  const canExpand = env.DEV
  const pinnedToTurnEnd = () => dispatchApprovalId(props.toolCall) !== null
  const blocked = () => (pinnedToTurnEnd() ? null : blockedPayload(props.toolCall.result))
  const requestId = () => blockedPayload(props.toolCall.result)?.approvalRequestId

  return (
    <div
      class="text-[12px]"
      data-testid="tool-call-row"
      data-tool-name={props.toolCall.toolName}
      data-request-id={requestId()}
      data-turn-id={props.askId ?? props.turnId ?? undefined}
    >
      <Show when={!hasToolCard(props.toolCall)}>
        <button
          type="button"
          class={`flex w-full items-center gap-2 rounded px-1 py-0.5 text-left ${canExpand ? "hover:bg-surface-hover" : "cursor-default"}`}
          onClick={() => canExpand && setExpanded((prev) => !prev)}
        >
          <span
            data-status={props.toolCall.status}
            class={`h-1.5 w-1.5 shrink-0 rounded-full ${statusStyle(props.toolCall.status)}`}
          />
          <span class="shrink-0 font-medium text-text-secondary">
            {formatToolName(props.toolCall.toolName)}
          </span>
          <Show when={props.toolCall.summary}>
            {(summary) => (
              <span data-testid="tool-call-summary" class="min-w-0 truncate text-text-tertiary">
                {summary()}
              </span>
            )}
          </Show>
        </button>
        <Show when={canExpand && expanded()}>
          <div class="ml-4 mt-1 space-y-1 text-[11px] text-text-tertiary">
            <Show when={props.toolCall.args}>
              <div>
                <span class="font-medium text-text-secondary">{i18n.t("kernel.args")}</span>
                <pre class="mt-0.5 max-h-32 overflow-auto rounded bg-surface-hover p-1.5 text-[10.5px]">
                  {JSON.stringify(props.toolCall.args, null, 2)}
                </pre>
              </div>
            </Show>
            <Show when={props.toolCall.result}>
              <div>
                <span class="font-medium text-text-secondary">{i18n.t("kernel.result")}</span>
                <pre class="mt-0.5 max-h-32 overflow-auto rounded bg-surface-hover p-1.5 text-[10.5px]">
                  {typeof props.toolCall.result === "string"
                    ? props.toolCall.result
                    : JSON.stringify(props.toolCall.result, null, 2)}
                </pre>
              </div>
            </Show>
          </div>
        </Show>
      </Show>
      {/* The tool's own result card: drawn instead of the row's line, never folded. */}
      <Show when={hasToolCard(props.toolCall)}>
        <ToolCard toolCall={props.toolCall} />
      </Show>
      {/*
        P6d-T12: a local session's permission prompt is answered HERE, inside
        the row that raised it, exactly as a blocked cloud tool's approval is
        answered just below. Nothing at all in a browser.
      */}
      <LocalPermissionCard toolCallId={props.toolCall.toolCallId} />
      <Show when={blocked()}>
        {(payload) => (
          <Show
            when={payload().approvalRequestId}
            fallback={
              <LegacyBlockedApprovalSummary
                summary={payload().summary ?? null}
                toolName={formatToolName(props.toolCall.toolName)}
              />
            }
          >
            {(requestId) => (
              <ApprovalCard
                requestId={requestId()}
                compact={true}
                turnId={props.turnId}
                askId={props.askId}
              />
            )}
          </Show>
        )}
      </Show>
      <Show when={!blocked() && editedApprovalId(props.toolCall)}>
        {(editedId) => (
          <ApprovalCard
            requestId={editedId()}
            compact={true}
            turnId={props.turnId}
            askId={props.askId}
          />
        )}
      </Show>
      <Show when={requestedScopeId(props.toolCall)}>
        {(scopeRequestId) => <ScopeRequestToolCard requestId={scopeRequestId()} />}
      </Show>
      <Show when={requestedSecretId(props.toolCall)}>
        {(secretRequestId) => <SecretRequestToolCard requestId={secretRequestId()} />}
      </Show>
      <Show when={reportBugDraftId(props.toolCall)}>
        {(draftId) => <BugReportDraftCard draftId={draftId()} />}
      </Show>
      <Show when={importRunRef(props.toolCall)}>
        {(ref) => {
          const r = ref()
          return "runId" in r ? (
            <ImportRunCard runId={r.runId} />
          ) : (
            <ImportRunCard approvalRequestId={r.approvalRequestId} />
          )
        }}
      </Show>
      <Show when={setupStateResult(props.toolCall)}>
        {(state) => <SetupChecklistCard state={state()} />}
      </Show>
      <Show when={pageHandleOf(props.toolCall)}>
        {(handle) => <PageHandleCard handle={handle()} />}
      </Show>
      <Show when={mailboxSetupCardRef(props.toolCall)}>
        {(ref) => <MailboxSetupCard email={ref().email} makePrivate={ref().makePrivate} />}
      </Show>
    </div>
  )
}

interface LegacySummaryProps {
  summary: { title?: string; subtitle?: string; lines?: string[]; kind?: string } | null
  toolName: string
}

const LegacyBlockedApprovalSummary: Component<LegacySummaryProps> = (props) => {
  const i18n = useI18n()
  return (
    <div
      class="my-2 rounded-lg border border-border bg-elevated p-3 text-[13px]"
      data-testid="approval-legacy-summary"
    >
      <div class="flex items-center gap-2 text-text-secondary">
        <Hourglass size={14} />
        <span class="font-medium">{props.summary?.title ?? props.toolName}</span>
      </div>
      <Show when={props.summary?.subtitle}>
        <div class="mt-0.5 text-text-secondary">{props.summary?.subtitle}</div>
      </Show>
      <Show when={props.summary?.lines?.length}>
        <ul class="mt-2 space-y-1 text-text-secondary">
          <For each={props.summary?.lines ?? []}>{(line) => <li>{line}</li>}</For>
        </ul>
      </Show>
      <div class="mt-2 text-[11px] text-text-tertiary">{i18n.t("kernel.toolPendingApproval")}</div>
    </div>
  )
}

/**
 * Approval rows a tool group asked for, by id: each is loaded once, and a
 * failed load is not retried by every group render (the card retries its own).
 */
const requestedApprovalLoads = new Set<string>()

function loadApprovalOnce(api: Parameters<typeof ensureLoaded>[0], id: string): void {
  if (requestedApprovalLoads.has(id)) return
  requestedApprovalLoads.add(id)
  void ensureLoaded(api, id).catch(() => undefined)
}

/**
 * The approval whose card a call's own row draws: a blocked call's request
 * (not a dispatch, whose card sits at the end of the turn) or a request the
 * agent edited.
 */
export function rowApprovalId(toolCall: ToolCallState): string | null {
  if (dispatchApprovalId(toolCall) !== null) return null
  const blocked = blockedPayload(toolCall.result)?.approvalRequestId
  if (typeof blocked === "string" && blocked.length > 0) return blocked
  return editedApprovalId(toolCall)
}

/** The codes a connector answers with when it has no connection to read. */
const NOT_CONNECTED_CODES = new Set(["not_connected", "no_connection", "connection_missing"])

/** A call its app answered with "not connected": nothing was read, and nothing failed. */
export function answeredNotConnected(tc: ToolCallState): boolean {
  const r = tc.result
  if (r === null || typeof r !== "object") return false
  const code = (r as { error?: { code?: unknown } | null }).error?.code
  return typeof code === "string" && NOT_CONNECTED_CODES.has(code)
}

/**
 * Consecutive reads of apps, as one row: "Read 3 apps" with their names, or "Read 2 of 3 apps"
 * and which did not answer. While they run, one line per call, in order. Built from the calls'
 * own stored fields, so it reads the same live and after a reload.
 */
function ReadRollup(props: ToolCallGroupProps) {
  const i18n = useI18n()
  const [expanded, setExpanded] = createSignal(false)
  const running = () =>
    props.toolCalls.some((tc) => tc.status === "running" || tc.status === "pending")
  const apps = () => {
    // An app "did not answer" only when none of its calls got an answer. A call refused for its
    // own arguments and then made again (the model's retry) was answered: the app is up.
    const seen: { label: string; answered: boolean }[] = []
    for (const tc of props.toolCalls) {
      // An app with no connection was not read and did not fail: it is left out of the line.
      if (answeredNotConnected(tc)) continue
      const label = callAppLabel(tc)
      const known = seen.find((a) => a.label === label)
      if (known) known.answered ||= !toolCallFailed(tc)
      else seen.push({ label, answered: !toolCallFailed(tc) })
    }
    return seen.map((a) => ({ label: a.label, failed: !a.answered }))
  }
  const failed = () => apps().filter((a) => a.failed)
  const title = () => {
    const n = apps().length
    if (failed().length > 0) {
      return i18n.t("kernel.toolCard.readSomeApps", { count: n - failed().length, total: n })
    }
    return n === 1
      ? i18n.t("kernel.toolCard.readOneApp")
      : i18n.t("kernel.toolCard.readApps", { count: n })
  }
  const summary = () =>
    failed().length > 0
      ? failed()
          .map((a) => i18n.t("kernel.toolCard.didNotAnswer", { app: a.label }))
          .join(". ")
      : apps()
          .map((a) => a.label)
          .join(", ")
  const runningLine = (tc: ToolCallState) => {
    if (tc.runningLabelKey && catalogHasKey(tc.runningLabelKey)) return i18n.t(tc.runningLabelKey)
    return tc.runningLabel ?? i18n.t("kernel.toolCard.reading", { app: callAppLabel(tc) })
  }
  return (
    <Show
      when={!running()}
      fallback={
        <div class="text-[12px]" data-testid="tool-rollup-running">
          <For each={props.toolCalls}>
            {(tc) => (
              <div class="flex items-center gap-2 px-1 py-0.5" data-testid="tool-rollup-line">
                <span class={`h-1.5 w-1.5 shrink-0 rounded-full ${statusStyle(tc.status)}`} />
                <span class="font-medium text-text-secondary">{callAppLabel(tc)}</span>
                <span class="min-w-0 truncate text-text-tertiary">
                  {tc.status === "running" || tc.status === "pending" ? runningLine(tc) : ""}
                </span>
              </div>
            )}
          </For>
        </div>
      }
    >
      <Show when={apps().length > 0}>
        <div class="text-[12px]" data-testid="tool-rollup">
          <button
            type="button"
            data-testid="tool-rollup-toggle"
            class="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-surface-hover"
            onClick={() => setExpanded((prev) => !prev)}
          >
            <span
              class={`h-1.5 w-1.5 shrink-0 rounded-full ${statusStyle(failed().length > 0 ? "error" : "completed")}`}
            />
            <span class="shrink-0 font-medium text-text-secondary" data-testid="tool-rollup-title">
              {title()}
            </span>
            <span class="min-w-0 truncate text-text-tertiary" data-testid="tool-rollup-summary">
              {summary()}
            </span>
          </button>
          <Show when={expanded()}>
            <div class="ml-3 mt-0.5 border-l border-border-subtle pl-2">
              <For each={props.toolCalls}>
                {(tc) => (
                  <SingleToolCallRow toolCall={tc} turnId={props.turnId} askId={props.askId} />
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </Show>
  )
}

/** Stacked group: "Thread Read ×8" with expand to see individual calls. */
function StackedToolCallGroup(props: ToolCallGroupProps) {
  return (
    <Show
      when={props.toolCalls.length >= 2 && props.toolCalls.every(isRolledUpRead)}
      fallback={<NamedToolCallGroup {...props} />}
    >
      <ReadRollup {...props} />
    </Show>
  )
}

function NamedToolCallGroup(props: ToolCallGroupProps) {
  const [expanded, setExpanded] = createSignal(false)
  // A GROUP HOLDING A PENDING APPROVAL OPENS. The card renders inside its own
  // row, and a collapsed "Enable App ×2" hid the cards the person had to
  // decide. The rows are loaded here (a card loads its own only once drawn).
  // The group opens when a pending approval appears in it, not while one is
  // pending: a group the person closed stays closed.
  const apiCtx = useOptionalApi()
  const approvalIds = () =>
    props.toolCalls.map(rowApprovalId).filter((id): id is string => id !== null)
  createEffect(() => {
    if (!apiCtx) return
    for (const id of approvalIds()) loadApprovalOnce(apiCtx, id)
  })
  const holdsPendingApproval = () => approvalIds().some((id) => getById(id)?.status === "pending")
  createEffect(
    on(holdsPendingApproval, (pending, wasPending) => {
      if (pending && !wasPending) setExpanded(true)
    }),
  )
  // A GROUP HOLDING THE QUESTION A LOCAL TURN IS PARKED ON IS OPEN. The card
  // renders inside its own row, and a collapsed "Skill Read ×2" rendered no
  // row at all: the turn waited on an Allow nobody could see (2026-09-23).
  const holdsPrompt = () => {
    if (!isDesktop()) return false
    const prompt = currentLocalPrompt()
    return !!prompt && props.toolCalls.some((tc) => tc.toolCallId === prompt.toolUseId)
  }
  const open = () => expanded() || holdsPrompt()

  const groupStatus = () => {
    const statuses = props.toolCalls.map((tc) => tc.status)
    if (statuses.some((s) => s === "running")) return "running"
    if (statuses.some((s) => s === "error")) return "error"
    if (statuses.some((s) => s === "pending")) return "pending"
    return "completed"
  }

  return (
    <div class="text-[12px]" data-testid="tool-call-group" data-open={open() ? "true" : "false"}>
      <button
        type="button"
        data-testid="tool-call-group-toggle"
        class="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-surface-hover"
        onClick={() => setExpanded((prev) => !prev)}
      >
        <span class={`h-1.5 w-1.5 shrink-0 rounded-full ${statusStyle(groupStatus())}`} />
        <span class="font-medium text-text-secondary">
          {formatToolName(props.toolCalls[0].toolName)}
        </span>
        <span class="rounded-full bg-surface-hover px-1.5 py-px text-[10px] font-medium text-text-tertiary">
          ×{props.toolCalls.length}
        </span>
        <span class="text-[10px] text-text-tertiary">{open() ? "▾" : "▸"}</span>
      </button>
      <Show when={open()}>
        <div class="ml-3 mt-0.5 border-l border-border-subtle pl-2">
          <For each={props.toolCalls}>
            {(tc) => <SingleToolCallRow toolCall={tc} turnId={props.turnId} askId={props.askId} />}
          </For>
        </div>
      </Show>
    </div>
  )
}

/** Renders a group — single call rendered directly, 2+ stacked. */
export default function ToolCallRow(props: ToolCallRowProps) {
  return <SingleToolCallRow toolCall={props.toolCall} turnId={props.turnId} askId={props.askId} />
}

export { SingleToolCallRow, StackedToolCallGroup }
