// SPDX-License-Identifier: FSL-1.1-ALv2

import {
  type ApprovalRequestSummary,
  canDecidePure,
  containsRefToken,
  decidingScope,
  factsFromSummary,
  htmlToText,
  humanizeRefTokens as humanizeRefs,
  isApprovingWedged,
  isSharedSurfaceFacts,
  type RefSourceLookup,
} from "@liaison/shared"
import { Hourglass, Mail } from "lucide-solid"
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js"
import type { ApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"
import { isPendingSubtitle, readableSummaryLines } from "~/lib/approval-summary-lines"
import { nativeHaptic } from "~/lib/native-bridge"
import { relativeTime } from "~/lib/relative-time"
import {
  approvalKindLabel,
  approvalScopeLabel,
  localizeApprovalText,
  localizeRefPhrases,
} from "~/modules/approvals/approval-copy"
import {
  acknowledgePayloadChanges,
  decide,
  ensureBundleLoaded,
  ensureLoaded,
  getBundleSteps,
  getById,
  isDecideInFlight,
  payloadChangedSinceReview,
  refreshRow,
  updatePayloadAction,
} from "~/modules/approvals/approvals-store"
import {
  decideErrorToast,
  handlerCause,
  localizedApprovalSubtitle,
} from "~/modules/approvals/decide-error"
import { announceApprovalDecided } from "~/modules/approvals/decided-event"
import {
  type DecisionLabel,
  isDecisionQueued,
  isDecisionUndone,
} from "~/modules/approvals/decision-queue"
import { emailBodyPreset } from "~/modules/approvals/email-body"
import { createPayloadFileNames } from "~/modules/approvals/payload-file-names"
import SkillApprovalView from "~/modules/approvals/SkillApprovalView"
import { SummaryLineText } from "~/modules/approvals/SummaryLineText"
import { sendGuardLine } from "~/modules/approvals/send-guard-line"
import { useEditableDraft } from "~/modules/approvals/useEditableDraft"
import { ComposerAssist } from "~/modules/assist/ComposerAssist"
import { DictationMic, RecorderRow } from "~/modules/assist/RecorderBar"
import { useFormDictation } from "~/modules/assist/useDictation"
import { hasScope, userFromToken } from "~/modules/auth/auth-store"
import { RichEditor, type RichEditorHandle } from "~/modules/editor"
import { currentLocale, type Translate, tNow, useI18n } from "~/modules/i18n/i18n-context"
// The mailbox and mail stores are pulled in DYNAMICALLY below, not imported at
// module scope. Statically importing the mail message store drags the whole mail
// conversation store (and its module-scope memos) into every surface that
// renders an approval card, for a path only a sealed mail send ever takes.
import {
  isSealedMailApproval,
  MailApprovalFulfilmentError,
  type MailboxFulfilmentBody,
  mailAttachmentDisclosure,
  outboundAttachmentFileIds,
  readSealedDraft,
  sealedDraftEditFields,
  sealedDraftPreviewPayload,
} from "~/modules/mailbox/approval-mail-fulfilment"
import type { OpenedApprovalDraft } from "~/modules/mailbox/crypto-protocol"
import { MailboxLockedPanel } from "~/modules/mailbox/MailboxLockedPanel"
import { mailboxCryptoClient, mailboxStore } from "~/modules/mailbox/mailbox-store"
import { requestMailboxUnlock } from "~/modules/mailbox/mailbox-unlock-bus"
import { useOptionalApi } from "~/modules/shell/ApiContext"
import { AppPill, appIdOfTool } from "~/modules/shell/AppPill"
import { formatTimeLeft, rowLocaleFrom } from "~/modules/shell/attention-row-format"
import { attentionStore, getAttentionApi } from "~/modules/shell/attention-store"
import { openEntity } from "~/modules/shell/entity-opener"
import { MarkdownContent } from "~/modules/shell/markdown-content"
import { shellTier } from "~/modules/shell/shell-tier"
import { useTabIsActive } from "~/modules/shell/TabVisibilityContext"
import { openTab } from "~/modules/shell/tab-store"
import { addToast } from "~/modules/shell/toast-store"
import { createOverflowed } from "~/primitives/createOverflowed"
import { BottomSheetActions, type SheetAction } from "~/ui/BottomSheetActions"
import { Button } from "~/ui/Button"
import { OverlaySheet } from "~/ui/OverlaySheet"

interface ApprovalCardProps {
  requestId: string
  compact?: boolean
  /** Opened by an Approve pressed elsewhere (a Home row): approve as soon as the
   *  request has loaded, through this card's own path (decrypt, unlock). */
  approveOnOpen?: boolean
  /** The agent turn that raised it (the message that started the turn). */
  turnId?: string | null
  /** The person's message that turn answers; `data-turn-id` is `askId ?? turnId`. */
  askId?: string | null
}

const TIMEOUT_MS = 30_000
const TERMINAL_STATUSES = new Set(["approved", "denied", "expired", "cancelled", "withdrawn"])

function relativeFromNow(iso: string | undefined, locale: string): string {
  return relativeTime(iso ?? new Date(), locale, { style: "long" })
}

/** Preview cap for a flattened payload field value. Fields longer than this
 *  render a "Show more" toggle (PayloadValue) instead of being silently
 *  truncated — the reviewer must be able to read the FULL value (e.g. the
 *  entire outgoing customer reply) before approving a gated send. */
/**
 * M2-1 T12. How long this request still has, in whole minutes, and whether that
 * is little enough to say so in amber. Pure and exported because the THRESHOLD
 * is the thing worth pinning: a colour read off a rendered card is a screenshot,
 * not a test.
 */
export const DEADLINE_URGENT_MINUTES = 15

export function minutesLeft(expiresAt: string | undefined, now: number): number | null {
  if (!expiresAt) return null
  const at = Date.parse(expiresAt)
  if (!Number.isFinite(at)) return null
  return Math.max(0, Math.ceil((at - now) / 60_000))
}

export function deadlineIsUrgent(minutes: number | null): boolean {
  return minutes !== null && minutes < DEADLINE_URGENT_MINUTES
}

const PAYLOAD_PREVIEW_CHARS = 300

/** How much of the Message block is shown before it offers Show more.
 *  COUNTED IN LINES, not in pixels: a pixel ceiling lands wherever the text
 *  happens to be and sliced the last line through the middle, so the reviewer
 *  read a smear of half letters and could not tell whether anything was
 *  missing. A line count always ends on a whole line. */
const MESSAGE_CLAMP_CLASS = "line-clamp-12"
/** A customer email body edited in place: the field's frame around the shared editor. */
const EMAIL_BODY_EDITOR_CLASS =
  "rounded border border-border bg-bg px-2 py-1.5 [--editor-bg:var(--color-bg)]"

/**
 * Flatten the exact tool payload into `path: value` rows so the reviewer sees
 * EVERY field that will execute, not just the curated summary lines. The
 * summary is a courtesy; this is the ground truth an operator validates
 * against (e.g. notifyCustomer on a fulfillment, every Boxtal shipment field).
 *
 * Values are returned FULL (uncapped) — truncation for display is handled by
 * PayloadValue's expand/collapse toggle, never here.
 */
function flattenPayload(
  value: unknown,
  prefix = "",
  format: (text: string) => string = humanizeRefs,
): Array<[string, string]> {
  if (Array.isArray(value)) {
    if (value.length === 0) return [[prefix || "value", "[] (empty list)"]]
    return value.flatMap((v, i) => flattenPayload(v, prefix ? `${prefix}[${i}]` : `[${i}]`, format))
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return [[prefix || "value", "{} (empty)"]]
    return entries.flatMap(([k, v]) => flattenPayload(v, prefix ? `${prefix}.${k}` : k, format))
  }
  const rendered =
    value === undefined ? "(not set)" : typeof value === "string" ? value : JSON.stringify(value)
  // humanizeRefTokens is "display only, so a human never sees a raw token" —
  // the exact-payload list is a display surface like the summary lines, so
  // it gets the same treatment even though it shows otherwise-raw values.
  return [[prefix || "value", format(rendered)]]
}

/** True when `line` looks like a truncated PREFIX of `body` — i.e. the same
 *  clipped body-preview a summarizer pushes into `summary.lines` (e.g.
 *  `clip(preview, 220)` in tickets/mail summarizers) that now duplicates the
 *  full Message block rendered separately below. Only drops lines that are
 *  actually body-shaped: either long (> 60 chars, so a short metadata line
 *  that happens to prefix the body is never dropped) or carrying the clip's
 *  trailing ellipsis (the strongest signal a line was truncated) — never both
 *  required, since rows stored before `truncateApprovalSummary` (packages/shared)
 *  marked its own 200-char cut with "…" carry a bare truncated prefix. */
function isTruncatedBodyPreview(line: string, body: string): boolean {
  const trimmedLine = line.trim()
  if (trimmedLine.length === 0) return false
  const hasEllipsis = /(…|\.\.\.)\s*$/.test(trimmedLine)
  if (!hasEllipsis && trimmedLine.length <= 60) return false
  const strippedLine = trimmedLine.replace(/(…|\.\.\.)\s*$/, "").trim()
  if (strippedLine.length === 0) return false
  const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim()
  const normalizedLine = normalize(strippedLine)
  const normalizedBody = normalize(body)
  return normalizedBody.startsWith(normalizedLine)
}

/** Filter `summary.lines` down to metadata only when a Message block is about
 *  to render the full body separately — drops any line that is a truncated
 *  prefix of that body (see isTruncatedBodyPreview) so the card never shows
 *  the same customer-facing text twice: once cropped, once in full. Keeps
 *  every other line untouched (dates, reasons, recipients, attachments). */
function dedupeSummaryLines(lines: string[], messageBody: string | null): string[] {
  if (!messageBody) return lines
  return lines.filter((line) => !isTruncatedBodyPreview(line, messageBody))
}

/** The `summary` jsonb on an approval row is NULLABLE, and a row written by
 *  anything other than the summarizer (a fixture, an import, an older gated
 *  tool) carries no summary at all — or a partial one with no `lines`. The
 *  card must still render such a row: the decision is what matters, not its
 *  courtesy header. These two readers are the ONLY way the card reaches into
 *  `summary`, so a missing one degrades to the tool name plus no lines rather
 *  than throwing and taking the whole tab down with an error boundary. */
function summaryTitleOf(row: ApprovalRequestSummary): string {
  const title = row.summary?.title
  // A missing title, or one an older fallback stored as the raw tool id, reads
  // as the action in words ("Tickets: reply"), never "tickets:reply".
  return typeof title === "string" && title.trim().length > 0 && title !== row.toolName
    ? localizeApprovalText(title, readerCopy())
    : approvalKindLabel(row.toolName, row.summary?.kind, readerCopy())
}

function summaryLinesOf(row: ApprovalRequestSummary): string[] {
  const lines = row.summary?.lines
  return Array.isArray(lines)
    ? readableSummaryLines(lines.filter((l): l is string => typeof l === "string")).map((line) =>
        localizeApprovalText(line, readerCopy()),
      )
    : []
}

/** True when the app wrote a real summary (its own title plus lines). The card then states the
 *  effect in words, so the exact payload, still the safety record of what runs, sits closed
 *  behind "Technical details". A row with no summary shows it open: it is all there is. */
export function hasCuratedSummary(row: ApprovalRequestSummary): boolean {
  const title = row.summary?.title
  const lines = row.summary?.lines
  return (
    typeof title === "string" &&
    title.trim().length > 0 &&
    title !== row.toolName &&
    Array.isArray(lines) &&
    lines.some((l) => typeof l === "string" && l.trim().length > 0)
  )
}

/** The stored English summary is shown in the reader's language (approval-copy). */
function readerCopy() {
  return { t: tNow, locale: currentLocale() }
}

/** The full outgoing message body carried in a gated tool's exact payload, if
 *  this approval sends a message the reviewer must read in full before
 *  approving (a ticket/mail reply, nudge, or close-with-email). Returns the
 *  UNTRUNCATED text (payload is the ground truth), preferring plain textBody
 *  and stripping tags from an htmlBody fallback. Null when there is no message
 *  body — so the block is skipped for non-message approvals. */
function primaryMessageBody(
  payload: Record<string, unknown> | undefined,
  editableFields?: ReadonlyArray<{ field: string }>,
): string | null {
  return primaryMessageField(payload, editableFields)?.body ?? null
}

/** The payload keys a gated tool's outgoing message may live under. */
const MESSAGE_PATHS = ["textBody", "body", "message"]

/**
 * The same body, WITH the payload path it was taken from.
 *
 * The path is what lets the exact-payload list leave that field out: the
 * kernel:update_skill card printed the whole playbook twice, once under
 * MESSAGE and again under EXACT PAYLOAD, which on a phone is two full screens
 * of the same text. Nothing is hidden by this: the field is shown, once, in
 * the place that renders it readably.
 *
 * When the approval declares its message as an editable field, only that field
 * is the message: it is what the tool sends and what Edit writes. Falling back to
 * another key showed a `body` the tool never reads as the MESSAGE, and after an
 * edit of the real `textBody` the card showed the new text above an exact payload
 * still listing the old one.
 */
function primaryMessageField(
  payload: Record<string, unknown> | undefined,
  editableFields?: ReadonlyArray<{ field: string }>,
): { path: string; body: string } | null {
  if (!payload) return null
  const declared = (editableFields ?? [])
    .map((f) => f.field)
    .filter((f) => MESSAGE_PATHS.includes(f))
  for (const path of declared.length > 0 ? declared : MESSAGE_PATHS) {
    const value = payload[path]
    if (typeof value === "string" && value.trim().length > 0) return { path, body: value }
  }
  const html = payload.htmlBody
  if (typeof html === "string" && html.trim().length > 0) {
    const stripped = htmlToText(html, { singleLine: true })
    if (stripped.length > 0) return { path: "htmlBody", body: stripped }
  }
  return null
}

/**
 * The exact-payload rows MINUS the one field already rendered in full under
 * "Message". Everything else is listed unchanged: the reviewer still sees every
 * field that will execute, and the long one is shown once rather than twice.
 */
function payloadRowsWithoutMessage(
  payload: Record<string, unknown> | undefined,
  toolName: string,
  editableFields?: ReadonlyArray<{ field: string }>,
  format?: (text: string) => string,
): Array<[string, string]> {
  const rows = flattenPayload(payload, "", format)
  const shown = primaryMessageField(payload, editableFields)
  if (!shown) return rows
  // A customer email is shown rendered: its HTML part is that same message.
  const email = emailBodyPreset(toolName, shown.path) !== undefined
  return rows.filter(([path]) => path !== shown.path && !(email && path === "htmlBody"))
}

/** Renders a single flattened payload value, capped at
 *  PAYLOAD_PREVIEW_CHARS by default with a local "Show more"/"Show less"
 *  toggle. Expand state is per-instance (keyed by the caller via `path` in
 *  the `For` key), so expanding one field never expands its siblings. The
 *  expanded block is whitespace-pre-wrap + break-words so a long customer
 *  message wraps and stays selectable without breaking the card layout. */
/**
 * A47b. The payload paths the tool's own schema supplied rather than the requester, carried on
 * the approval row. The card shows the arguments the handler will run on, so a reviewer has to
 * be able to tell the two apart: these are marked, the rest is what was actually asked for.
 */
function defaultedPaths(row: { metadata?: Record<string, unknown> }): Set<string> {
  const raw = row.metadata?.defaultedParams
  return new Set(Array.isArray(raw) ? raw.filter((p): p is string => typeof p === "string") : [])
}

const PayloadValue: Component<{
  path: string
  value: string
  previewChars?: number
  /** The file id behind a value shown as its file name: kept on the value for audit. */
  fileId?: string
}> = (props) => {
  const i18n = useI18n()
  const [expanded, setExpanded] = createSignal(false)
  const cap = () => props.previewChars ?? PAYLOAD_PREVIEW_CHARS
  const isLong = () => props.value.length > cap()
  const preview = () => (isLong() ? `${props.value.slice(0, cap())}...` : props.value)
  const toggleTestId = () => `approval-payload-toggle-${props.path}`

  return (
    <span class="min-w-0">
      <span
        // `break-words`, never `break-all`: break-all cuts mid-word wherever
        // the line happens to end, so a phone payload read as gibberish split
        // across every line. Long unbroken tokens (a url, a uuid) still wrap,
        // because overflow-wrap: anywhere is what break-words compiles to for
        // a word longer than the line.
        class={
          expanded()
            ? "whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
            : "break-words [overflow-wrap:anywhere]"
        }
        data-testid={`approval-payload-value-${props.path}`}
        title={props.fileId}
        data-file-id={props.fileId}
      >
        {expanded() ? props.value : preview()}
      </span>
      <Show when={isLong()}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          class="ml-1 h-auto px-1 py-0 text-[11px] normal-case"
          data-testid={toggleTestId()}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded() ? i18n.t("kernel.common.showLess") : i18n.t("kernel.common.showMore")}
        </Button>
      </Show>
    </span>
  )
}

/** A payload value, shown as its file's name when it is a file id the viewer
 *  can read (payload-file-names.ts); the id stays on it as a tooltip. */
const PayloadFileValue: Component<{
  path: string
  value: string
  names: Map<string, string> | undefined
}> = (props) => {
  const name = () => props.names?.get(props.value)
  return (
    <PayloadValue
      path={props.path}
      value={name() ?? props.value}
      fileId={name() ? props.value : undefined}
    />
  )
}

function editErrorToast(err: ApiError, t: Translate): { message: string; type: "error" } {
  const code = err.code
  const status = err.status
  if (status === 400 && code === "invalid_edit") {
    return {
      message: t("kernel.approvalsUi.err.invalidFields", { detail: err.message }),
      type: "error",
    }
  }
  if (status === 403) return { message: t("kernel.approvalsUi.err.cannotEdit"), type: "error" }
  if (status === 404) return { message: t("kernel.approvalsUi.err.gone"), type: "error" }
  if (status === 409 && code === "stale_status")
    return { message: t("kernel.approvalsUi.err.notPending"), type: "error" }
  if (status === 409 && code === "sealed_draft_not_editable")
    return { message: t("kernel.approvalsUi.err.sealedDraftNotEditable"), type: "error" }
  if (status === 0) return { message: t("kernel.approvalsUi.err.offline"), type: "error" }
  return {
    message: t("kernel.approvalsUi.err.updateFailed", { code: code ?? "error" }),
    type: "error",
  }
}

/**
 * The full outgoing message a request sends: a single request's, and each step's
 * of a sequence (the reply that goes out last reads exactly as it would alone).
 * The summary lines are capped at 500 chars by the approval-summary schema (a
 * skim preview), so a reviewer approving a customer-facing send needs the
 * COMPLETE message, expandable, sourced untruncated from the payload.
 */
const ApprovalMessageBlock: Component<{
  api: ApiClient | undefined
  body: string
  /** `<testid>`, `<testid>-body`, `<testid>-toggle`. */
  testid: string
}> = (props) => {
  const i18n = useI18n()
  /** Whether the full message is shown, or its clamped head. */
  const [expanded, setExpanded] = createSignal(false)
  // The block's own box, measured rather than guessed: `createOverflowed`
  // answers whether the rendered content outgrew the clamp, re-reading on resize
  // and whenever the markdown body mutates under it.
  const [bodyEl, setBodyEl] = createSignal<HTMLElement | undefined>(undefined)
  const { overflowed } = createOverflowed(bodyEl)
  return (
    <div class="mt-2" data-testid={props.testid}>
      <div class="text-[11px] uppercase tracking-wide text-text-tertiary">
        {i18n.t("kernel.approvalsUi.message")}
      </div>
      {/* The SAME renderer a message uses. A skill playbook or a
        customer reply is written in markdown, and printing its
        source at a reviewer ("## Tone", "- bullet", "**bold**")
        is asking them to parse it themselves. Bounded and
        scrollable: a 10KB playbook must not turn the card into
        a page the decide buttons have scrolled off. */}
      <div
        data-testid={`${props.testid}-body`}
        data-expanded={expanded() ? "true" : "false"}
        class={
          expanded()
            ? "mt-1 break-words [overflow-wrap:anywhere]"
            : `mt-1 ${MESSAGE_CLAMP_CLASS} break-words [overflow-wrap:anywhere]`
        }
        ref={setBodyEl}
      >
        <Switch fallback={<div class="whitespace-pre-wrap text-text-secondary">{props.body}</div>}>
          {/* A customer email too: in the app's theme, never a
            white email sheet (dark mode read grey on white). */}
          <Match when={props.api}>
            {(api) => (
              <MarkdownContent api={api()} content={props.body} class="text-text-secondary" />
            )}
          </Match>
        </Switch>
      </div>
      {/* WHETHER THE BOX OVERFLOWS, not how many characters are
        in it. A 542 character note broken every few words
        outgrew the clamp, was cut mid word and offered no way
        to read the rest, because 542 is under a 600 character
        rule; a longer message on three long lines fitted and
        offered a toggle for nothing. Once expanded the box has
        no maximum and cannot overflow, so the toggle stays put
        rather than stranding the reviewer in the long form. */}
      <Show when={overflowed() || expanded()}>
        <button
          type="button"
          data-testid={`${props.testid}-toggle`}
          onClick={() => setExpanded(!expanded())}
          class="mt-1 text-[12px] font-medium text-accent hover:underline"
        >
          {expanded()
            ? i18n.t("kernel.approvalMessageShowLess")
            : i18n.t("kernel.approvalMessageShowMore")}
        </button>
      </Show>
    </div>
  )
}

type SummaryLink = NonNullable<NonNullable<ApprovalRequestSummary["summary"]>["links"]>[number]

/** A request's links (the record it acts on, an outside page): a single request's,
 *  and each step's of a sequence. */
const ApprovalLinks: Component<{
  api: ApiClient | undefined
  links: SummaryLink[]
  testid?: string
}> = (props) => {
  const i18n = useI18n()
  return (
    <div class="mt-3 flex flex-wrap gap-2" data-testid={props.testid}>
      <For each={props.links}>
        {(link) =>
          "url" in link ? (
            // External surface (e.g. the Shopify admin order
            // page) — a real link in a new tab, not an in-app
            // tab. https-only, enforced by the summary schema.
            <a
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center rounded-md border border-border px-2.5 py-1 text-[12px] font-medium text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
            >
              {localizeApprovalText(link.label, readerCopy())}
            </a>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const api = props.api
                if (!api) return
                void openEntity(api, link.app, link.entityType, link.entityId).catch(() => {
                  addToast({
                    message: i18n.t("kernel.approvalsUi.approvalRequestNoLongerExists"),
                    type: "error",
                  })
                })
              }}
            >
              {localizeApprovalText(link.label, readerCopy())}
            </Button>
          )
        }
      </For>
    </div>
  )
}

/** One deferred step inside a bundle. Renders the step summary and — when the
 *  step has token-free editable fields and is still `deferred` — an inline
 *  editor that posts to *that step's* own /payload route. A field whose value
 *  carries an @ref token is never offered for editing (L4): persisting its
 *  humanized form would destroy the token. */
const BundleStepRow: Component<{
  api: ApiClient | undefined
  step: ApprovalRequestSummary
  index: number
  /** Source approval's position within the same bundle, when known. Renders
   *  the "depends on #N" chip for dependent rows. Null for parallel roots and
   *  for cross-bundle dependencies. */
  dependsOnPosition?: number | null
  /** Text with its @ref tokens read as the steps they come from, in the reader's language. */
  refText: (text: string) => string
}> = (props) => {
  const i18n = useI18n()
  const editableFields = () =>
    props.step.editableFields.filter((f) => !containsRefToken(props.step.currentPayload[f.field]))
  // A sealed draft is edited on its own card, where the owner's browser opens it.
  const canEdit = () =>
    Boolean(props.api) &&
    props.step.status === "deferred" &&
    editableFields().length > 0 &&
    !sealedStep()

  const {
    editing,
    draft,
    setDraft,
    enter: enterEdit,
    cancel: cancelEdit,
    close: closeEdit,
    changedFields,
    isDirty,
  } = useEditableDraft({
    initial: () => props.step.currentPayload,
    editableFields,
  })
  // One mic, left of Save: the take writes to the draft field last focused.
  const draftDictation = useFormDictation()

  async function onSave() {
    const fields = changedFields()
    if (Object.keys(fields).length === 0) {
      closeEdit()
      return
    }
    const api = props.api
    if (!api) return
    try {
      await updatePayloadAction(api, props.step.id, fields)
      closeEdit()
    } catch (err) {
      if (err instanceof ApiError) addToast(editErrorToast(err, i18n.t))
      else addToast({ message: i18n.t("kernel.approvalsUi.couldnTReachServer"), type: "error" })
    }
  }

  const testidBase = () => `approval-bundle-step-${props.index + 1}`
  // The step reads as it would alone: its message in full, its lines without a
  // clipped copy of that message, and the exact payload minus the message.
  const messageField = createMemo(() =>
    primaryMessageField(props.step.currentPayload, props.step.editableFields),
  )
  const stepLines = createMemo(() =>
    dedupeSummaryLines(summaryLinesOf(props.step), messageField()?.body ?? null),
  )
  // A send from an encrypted personal mailbox: its draft is ciphertext only the
  // mailbox owner's browser opens, so the row lists none of the key material
  // and the step is decided on its own card (which opens and fulfils it).
  const sealedStep = () =>
    isSealedMailApproval({ toolName: props.step.toolName, payload: props.step.currentPayload })
  const stepRows = createMemo(() =>
    payloadRowsWithoutMessage(
      sealedStep()
        ? sealedDraftPreviewPayload(props.step.currentPayload ?? {}, null)
        : props.step.currentPayload,
      props.step.toolName,
      props.step.editableFields,
      props.refText,
    ),
  )
  const stepFileNames = createPayloadFileNames(() => props.api, stepRows)
  const stepSubtitle = () => {
    const sub = props.step.summary?.subtitle
    if (typeof sub !== "string" || sub.trim() === "") return null
    return props.refText(localizeApprovalText(localizedApprovalSubtitle(sub, i18n.t), readerCopy()))
  }

  return (
    <div data-testid={testidBase()} class="rounded border border-border bg-bg-subtle p-2">
      <div class="font-medium text-text" data-testid={`${testidBase()}-title`}>
        {props.refText(summaryTitleOf(props.step))}
      </div>
      <Show when={stepSubtitle()}>
        {(sub) => (
          <div
            class="mt-0.5 break-words text-text-secondary"
            data-testid={`${testidBase()}-subtitle`}
          >
            {sub()}
          </div>
        )}
      </Show>

      <Show when={typeof props.dependsOnPosition === "number"}>
        <div
          class="mt-1 inline-block rounded bg-bg px-2 py-0.5 text-[11px] text-text-tertiary"
          data-testid={`${testidBase()}-depends-on`}
        >
          {i18n.t("kernel.approvalsUi.dependsOn")}
          {(props.dependsOnPosition ?? 0) + 1}
        </div>
      </Show>

      <Show when={!editing() && stepLines().length > 0}>
        <ul class="mt-1 space-y-0.5 text-text-secondary" data-testid={`${testidBase()}-lines`}>
          <For each={stepLines()}>
            {(line) => (
              <li>
                <SummaryLineText line={line} format={props.refText} />
              </li>
            )}
          </For>
        </ul>
      </Show>

      <Show when={!editing() ? messageField() : null}>
        {(field) => (
          <ApprovalMessageBlock
            api={props.api}
            body={props.refText(field().body)}
            testid={`${testidBase()}-message`}
          />
        )}
      </Show>

      <Show when={!editing() && (props.step.summary?.links?.length ?? 0) > 0}>
        <ApprovalLinks
          api={props.api}
          links={props.step.summary?.links ?? []}
          testid={`${testidBase()}-links`}
        />
      </Show>

      {/* Exact payload for THIS step — same full-disclosure rule as the main card. */}
      <Show when={!editing() && stepRows().length > 0}>
        <details
          class="mt-2"
          data-testid={`${testidBase()}-payload`}
          open={!hasCuratedSummary(props.step)}
        >
          <summary class="cursor-pointer text-[11px] uppercase tracking-wide text-text-tertiary">
            {hasCuratedSummary(props.step)
              ? i18n.t("kernel.approvalsUi.technicalDetails")
              : i18n.t("kernel.approvalsUi.exactPayload")}
          </summary>
          <ul class="mt-1 space-y-0.5 font-mono text-[11px] leading-snug text-text-secondary">
            <For each={stepRows()}>
              {([path, val]) => (
                <li class="flex gap-2">
                  <span class="shrink-0 text-text-tertiary">{path}:</span>
                  <PayloadFileValue
                    path={`${testidBase()}-${path}`}
                    value={val}
                    names={stepFileNames()}
                  />
                  <Show when={defaultedPaths(props.step).has(path)}>
                    <span
                      class="shrink-0 text-text-tertiary"
                      data-testid={`${testidBase()}-default-${path}`}
                    >
                      {i18n.t("kernel.approvalsUi.default")}
                    </span>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </details>
      </Show>

      <Show when={editing()}>
        <div class="mt-2 flex flex-col gap-2">
          <For each={editableFields()}>
            {(field) => {
              const value = () => String(draft()[field.field] ?? "")
              const onInput = (e: InputEvent) => {
                const target = e.currentTarget as HTMLInputElement | HTMLTextAreaElement
                setDraft({ ...draft(), [field.field]: target.value })
              }
              const inputId = `${testidBase()}-field-${field.field}`
              // The draft's text field (rich or plain) for the writing helpers.
              let richField: RichEditorHandle | undefined
              let plainField: HTMLTextAreaElement | undefined
              const writable = () =>
                Boolean(emailBodyPreset(props.step.toolName, field.field)) ||
                field.widget === "richtext"
              // Phase 16.6 — widget cases beyond text/richtext: `checkbox`,
              // `checkbox-per-line` (one checkbox per item in `listSource`),
              // `key-value-list` (editable string-keyed map).
              const listSource = (field as { listSource?: string }).listSource ?? field.field
              const resolveList = (): Array<Record<string, unknown>> => {
                const v = (draft() as Record<string, unknown>)[listSource]
                return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : []
              }
              const resolveMap = (): Record<string, string> => {
                const v = (draft() as Record<string, unknown>)[field.field]
                return v && typeof v === "object" ? (v as Record<string, string>) : {}
              }
              // `email-list` (mail to/cc/bcc): a comma-separated input over a recipient array. Each item
              // is a bare email string or a `{ email, name? }` object; render emails joined by ", " and
              // parse a comma/semicolon-separated edit back to a bare-email string[].
              const resolveEmails = (): string => {
                const v = (draft() as Record<string, unknown>)[field.field]
                if (!Array.isArray(v)) return ""
                return v
                  .map((item) =>
                    typeof item === "string"
                      ? item
                      : item && typeof item === "object"
                        ? String((item as { email?: unknown }).email ?? "")
                        : "",
                  )
                  .filter((s) => s.length > 0)
                  .join(", ")
              }
              const onEmailsInput = (e: InputEvent) => {
                const target = e.currentTarget as HTMLInputElement
                const list = target.value
                  .split(/[,;]/)
                  .map((s) => s.trim())
                  .filter((s) => s.length > 0)
                setDraft({ ...draft(), [field.field]: list })
              }
              return (
                <div
                  class="flex flex-col gap-1"
                  onFocusIn={() => draftDictation.focused(richField ?? plainField)}
                >
                  <div class="flex items-center justify-between gap-2">
                    <label
                      for={inputId}
                      class="text-[11px] uppercase tracking-wide text-text-tertiary"
                    >
                      {field.label}
                    </label>
                    <Show when={writable()}>
                      <span class="flex min-w-0 flex-1 items-center justify-end gap-0.5">
                        <ComposerAssist target={() => richField ?? plainField} />
                      </span>
                    </Show>
                  </div>
                  <Switch
                    fallback={
                      <input
                        type="text"
                        id={inputId}
                        data-testid={inputId}
                        class="rounded border border-border bg-bg px-2 py-1 text-text"
                        value={value()}
                        onInput={onInput}
                      />
                    }
                  >
                    <Match when={emailBodyPreset(props.step.toolName, field.field)}>
                      {(preset) => (
                        <RichEditor
                          preset={preset()}
                          ref={(handle) => {
                            richField = handle
                            draftDictation.field(handle)
                          }}
                          value={value()}
                          onChange={(md) => setDraft({ ...draft(), [field.field]: md })}
                          class={EMAIL_BODY_EDITOR_CLASS}
                          editorClass="min-h-[7.5rem] text-text"
                          aria-label={field.label}
                          data-testid={inputId}
                        />
                      )}
                    </Match>
                    <Match when={field.widget === "richtext"}>
                      <textarea
                        ref={(el) => {
                          plainField = el
                          draftDictation.field(el)
                        }}
                        rows={6}
                        id={inputId}
                        data-testid={inputId}
                        class="rounded border border-border bg-bg px-2 py-1 text-text"
                        value={value()}
                        onInput={onInput}
                      />
                    </Match>
                    <Match when={field.widget === "checkbox"}>
                      <input
                        type="checkbox"
                        id={inputId}
                        data-testid={`${testidBase()}-${field.field}-checkbox`}
                        checked={Boolean(draft()[field.field])}
                        onChange={(e) =>
                          setDraft({
                            ...draft(),
                            [field.field]: e.currentTarget.checked,
                          })
                        }
                      />
                    </Match>
                    <Match when={field.widget === "checkbox-per-line"}>
                      <For each={resolveList()}>
                        {(item) => {
                          const itemId = String(item.id ?? "")
                          return (
                            <label class="flex items-center gap-2 text-xs">
                              <input
                                type="checkbox"
                                data-testid={`${testidBase()}-${field.field}-checkbox-${itemId}`}
                                checked={Boolean(item[field.field] ?? false)}
                                onChange={(e) => {
                                  const list = resolveList()
                                  const next = list.map((it) =>
                                    it.id === item.id
                                      ? { ...it, [field.field]: e.currentTarget.checked }
                                      : it,
                                  )
                                  setDraft({ ...draft(), [listSource]: next })
                                }}
                              />
                              {String(item.title ?? item.id ?? "")}
                            </label>
                          )
                        }}
                      </For>
                    </Match>
                    <Match when={field.widget === "key-value-list"}>
                      <For each={Object.entries(resolveMap())}>
                        {([k, v], i) => (
                          <div class="flex gap-2">
                            <input
                              type="text"
                              data-testid={`${testidBase()}-${field.field}-key-${i()}`}
                              value={k}
                              onInput={(e) => {
                                const obj = { ...resolveMap() }
                                const newKey = e.currentTarget.value
                                if (newKey !== k) {
                                  obj[newKey] = obj[k]
                                  delete obj[k]
                                }
                                setDraft({ ...draft(), [field.field]: obj })
                              }}
                            />
                            <input
                              type="text"
                              data-testid={`${testidBase()}-${field.field}-value-${i()}`}
                              value={v}
                              onInput={(e) => {
                                const obj = { ...resolveMap(), [k]: e.currentTarget.value }
                                setDraft({ ...draft(), [field.field]: obj })
                              }}
                            />
                          </div>
                        )}
                      </For>
                    </Match>
                    <Match when={field.widget === "email-list"}>
                      <input
                        type="text"
                        id={inputId}
                        data-testid={inputId}
                        placeholder={i18n.t("kernel.approvalsUi.emailExampleComAnotherExampleCom")}
                        class="rounded border border-border bg-bg px-2 py-1 text-text"
                        value={resolveEmails()}
                        onInput={onEmailsInput}
                      />
                    </Match>
                  </Switch>
                </div>
              )
            }}
          </For>
        </div>
      </Show>

      <div class="mt-1 text-[11px] text-text-tertiary" data-testid={`${testidBase()}-runs-hint`}>
        {i18n.t("kernel.approvalsUi.step")} {(props.step.bundlePosition ?? 0) + 1}
        <Show
          when={typeof props.dependsOnPosition === "number"}
          fallback={<> {i18n.t("kernel.approvalsUi.needsASeparateApproval")}</>}
        >
          {" "}
          {sealedStep()
            ? i18n.t("kernel.approvalsUi.sealedStepWaitsForOwner")
            : i18n.t("kernel.approvalsUi.runsAutomaticallyAfterApproval")}
        </Show>
      </div>

      <Show when={editing()}>
        {/* The mic left of Save; a take turns this row into the recorder line. */}
        <div class="mt-2 flex items-center gap-2">
          <RecorderRow dictation={draftDictation.dictation}>
            <DictationMic dictation={draftDictation.dictation} />
            <Button
              type="button"
              size="sm"
              data-testid={`${testidBase()}-save`}
              disabled={!isDirty()}
              onClick={() => void onSave()}
            >
              {i18n.t("kernel.common.save")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid={`${testidBase()}-cancel`}
              onClick={cancelEdit}
            >
              {i18n.t("kernel.common.cancel")}
            </Button>
          </RecorderRow>
        </div>
      </Show>
      <Show when={!editing() && canEdit()}>
        <div class="mt-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid={`${testidBase()}-edit`}
            onClick={enterEdit}
          >
            {i18n.t("kernel.common.edit")}
          </Button>
        </div>
      </Show>
      <Show when={!editing() && props.step.status === "pending" && sealedStep()}>
        <div class="mt-2" data-testid={`${testidBase()}-own-card`}>
          <ApprovalCard requestId={props.step.id} compact />
        </div>
      </Show>
      <Show when={!editing() && props.step.status === "pending" && !sealedStep()}>
        <div class="mt-2 flex gap-2">
          <Button
            type="button"
            size="sm"
            data-testid={`${testidBase()}-approve`}
            disabled={isDecideInFlight(props.step.id)}
            onClick={() => void onApproveStep()}
          >
            {i18n.t("kernel.common.approve")}
          </Button>
        </div>
      </Show>
    </div>
  )

  async function onApproveStep() {
    const api = props.api
    if (!api) return
    try {
      await decide(api, props.step.id, "approve")
    } catch (err) {
      if (isDecisionUndone(err)) return
      // `err.message` on a decide failure is the opaque code (`handler_failed`),
      // never the upstream reason — go through the shared mapping so a bundle
      // step reports the same cause the standalone card does.
      addToast(
        err instanceof ApiError
          ? decideErrorToast(err, i18n.t).toast
          : { message: i18n.t("kernel.approvalsUi.couldnTReachServer"), type: "error" },
      )
    }
  }
}

/** First uuid segment (8 hex chars): the shortest prefix that is still a
 *  whole search token, so what the card prints is exactly what global
 *  search matches. Non-uuid ids (tests, legacy) are shown whole. */
export function shortApprovalId(id: string): string {
  const seg = id.split("-")[0] ?? id
  return seg.length >= 8 ? seg.slice(0, 8) : id
}

const ApprovalCard: Component<ApprovalCardProps> = (props) => {
  const i18n = useI18n()
  // Read inside the reactive scope that renders the string, so a language
  // change re-renders the deadline (attention-row-format.rowLocaleFrom).
  const rowLocale = () => rowLocaleFrom(i18n)
  const apiCtx = useOptionalApi()
  const compact = () => props.compact !== false

  const [loadFailed, setLoadFailed] = createSignal<ApiError | null>(null)

  // The version this card shows once it has the server's current one is the version the person
  // reviews here: Approve binds to it, and only a change made while the card is open asks them
  // to read again. A row the store already held is re-read first, since it may predate an edit
  // whose live update this device missed.
  if (apiCtx) {
    const id = props.requestId
    if (getById(id) !== undefined) {
      void ensureLoaded(apiCtx, id)
      // Offline, the card still shows the version it holds, and that is the one reviewed.
      void refreshRow(apiCtx, id, { acknowledge: true })
        .catch(() => undefined)
        .then(() => acknowledgePayloadChanges([id]))
    } else {
      void ensureLoaded(apiCtx, id)
        .then(() => acknowledgePayloadChanges([id]))
        .catch((err) => {
          if (err instanceof ApiError) setLoadFailed(err)
        })
    }
  }

  const current = createMemo<ApprovalRequestSummary | undefined>(() => getById(props.requestId))
  // A send from an end-to-end encrypted mailbox stores its subject and body as
  // ciphertext. The approver is the mailbox owner and this browser holds the
  // key, so the card decrypts the draft to SHOW it, exactly as Approve decrypts
  // it to send. Display only: the text is never stored or sent back. A signal,
  // not a resource, so a slow decrypt never suspends the surrounding tab.
  const sealedDraft = createMemo(() => {
    const c = current()
    return c ? isSealedMailApproval({ toolName: c.toolName, payload: c.currentPayload }) : false
  })
  const [openedDraft, setOpenedDraft] = createSignal<OpenedApprovalDraft | null>(null)
  const [draftUnreadable, setDraftUnreadable] = createSignal(false)
  createEffect(() => {
    const c = current()
    const unlocked = mailboxStore.status === "unlocked"
    setOpenedDraft(null)
    setDraftUnreadable(false)
    if (!c || !sealedDraft() || !unlocked) return
    const client = mailboxCryptoClient()
    if (!client) return
    let cancelled = false
    onCleanup(() => {
      cancelled = true
    })
    void (async () => {
      try {
        const opened = await client.openApprovalDraft(
          readSealedDraft({ id: c.id, toolName: c.toolName, payload: c.currentPayload }),
        )
        if (!cancelled) setOpenedDraft(opened)
      } catch {
        if (!cancelled) setDraftUnreadable(true)
      }
    })()
  })
  /** The payload as the card SHOWS it: a sealed draft's key material is replaced
   *  by its decrypted subject and body; every other approval is unchanged. */
  const displayPayload = createMemo<Record<string, unknown> | undefined>(() => {
    const c = current()
    if (!c) return undefined
    return sealedDraft()
      ? sealedDraftPreviewPayload(c.currentPayload ?? {}, openedDraft())
      : c.currentPayload
  })
  // `summary.lines` minus any line that duplicates the Message block below
  // (see dedupeSummaryLines) — the only thing that differs card-to-card is
  // whether a Message block will render at all, so this is a single memo the
  // whole card reads instead of recomputing the filter per render.
  const visibleSummaryLines = createMemo<string[]>(() => {
    const c = current()
    if (!c) return []
    return dedupeSummaryLines(
      summaryLinesOf(c),
      primaryMessageBody(displayPayload(), c.editableFields),
    )
  })
  // create_skill / update_skill get a dedicated rich view (the full skill, or a
  // body diff) instead of the raw flattened payload — a ~10KB markdown body in
  // the generic "Exact payload" list is unreadable and hides what changed. Null
  // for every other approval kind.
  const skillApprovalKind = createMemo<"create" | "update" | null>(() => {
    const k = current()?.summary?.kind
    if (k === "create_skill") return "create"
    if (k === "update_skill") return "update"
    return null
  })
  // The card's "host" (the row that exposes Approve / Deny) is the bundle's
  // position-0 member. Under parallel approval bundling that's no longer
  // required to share the bundle's UUID — bundleId is generally a fresh step
  // UUID distinct from any approval id. We use position only.
  const isBundleHead = () => {
    const c = current()
    return Boolean(c?.bundleId && c.bundlePosition === 0)
  }
  const bundleSteps = createMemo<ApprovalRequestSummary[]>(() => {
    const c = current()
    if (!isBundleHead() || !c?.bundleId) return []
    return getBundleSteps(c.bundleId).filter((s) => s.id !== props.requestId)
  })
  // WHAT THE STEP ROWS ARE KEYED BY: the step IDS, never the step rows.
  // Every store write replaces a row object wholesale (`byId[id] = row`), so a
  // WS update, a decidable-list refresh or a late listBundle hands `<For>` a
  // brand new object for a step that did not change. `<For>` reconciles by
  // REFERENTIAL identity, so it disposed the row and built a new one, and the
  // row's own state went with it: a step editor a person had open closed under
  // them mid-edit, with whatever they had typed. Ids are strings and compare by
  // value, so the row stays mounted and only the step it reads changes.
  const bundleStepIds = createMemo<string[]>(() => bundleSteps().map((s) => s.id))
  // Requests (this one, or a later step of its bundle) that someone changed after this person
  // first saw them. Approve stays bound to the version they saw until they read the new one.
  const changedSinceReview = createMemo<string[]>(() =>
    [props.requestId, ...bundleStepIds()].filter((id) => payloadChangedSinceReview(id)),
  )
  // A later step binds to the version this card first shows of it, as the head does above.
  const shownStepIds = new Set<string>()
  createEffect(() => {
    const fresh = bundleStepIds().filter((id) => !shownStepIds.has(id) && getById(id)?.payloadHash)
    if (fresh.length === 0) return
    for (const id of fresh) shownStepIds.add(id)
    acknowledgePayloadChanges(fresh)
  })
  // The bundle's "kind" controls the Approve button's label. A `sequence` has
  // at least one dep edge within the bundle — clicking Approve on the head
  // cascades through dependents. A `parallel` bundle has none — approving the
  // head only resolves the head; siblings need their own approvals (the
  // per-step row carries that hint via `dependsOnPosition`-null branch). The
  // distinction matters because the existing decideApproval cascade walks
  // depends_on_id edges only, NEVER bundle membership alone.
  // An agent asking to add another agent to the conversation: the decision is
  // "Add" or "Don't add", worded as the question the card asks.
  const isAgentInvite = () => current()?.toolName === "kernel:agents_invite"
  const approveLabel = (fallback: string): string =>
    isAgentInvite()
      ? i18n.t("kernel.approvalsUi.agentInviteAdd")
      : bundleKind() === "sequence"
        ? i18n.t("kernel.approvalsUi.approveSequence")
        : fallback
  const denyLabel = (): string =>
    isAgentInvite()
      ? i18n.t("kernel.approvalsUi.agentInviteDecline")
      : i18n.t("kernel.approvalDeny")

  const bundleKind = createMemo<"single" | "parallel" | "sequence">(() => {
    const steps = bundleSteps()
    if (steps.length === 0) return "single"
    return steps.some((s) => s.dependsOnId != null) ? "sequence" : "parallel"
  })
  /** A sequence's last step: what approving it brings about, the card's title.
   *  A parallel bundle's steps are decided one by one, so it keeps its own. */
  const bundleOutcome = createMemo<ApprovalRequestSummary | null>(() => {
    const steps = bundleSteps()
    return bundleKind() === "sequence" ? (steps[steps.length - 1] ?? null) : null
  })
  /**
   * The decision toast for a sequence: ONE item named by the outcome the card
   * is titled by, marked as a sequence of N steps with every step's name. The
   * head's approve runs every step, so its Undo takes back all of them.
   */
  const sequenceDecisionLabel = (): DecisionLabel | null => {
    const c = current()
    const last = bundleOutcome()
    if (!c || !last) return null
    return {
      title: refText(summaryTitleOf(last)),
      detail: null,
      steps: [c, ...bundleSteps()].map((s) => refText(summaryTitleOf(s))),
    }
  }
  /** The steps a later step's @ref tokens cite: this request and its bundle's steps. */
  const refSources = createMemo<RefSourceLookup>(() => {
    const c = current()
    const byId = new Map(
      (c ? [c, ...bundleSteps()] : []).map((s) => [
        s.id.toLowerCase(),
        { step: (s.bundlePosition ?? 0) + 1, toolName: s.toolName, payload: s.currentPayload },
      ]),
    )
    return (id) => byId.get(id.toLowerCase())
  })
  /** Text as the card shows it: a token reads as the step it comes from
   *  ("the quote PDF from step 2"), in the reader's language. */
  const refText = (text: string): string =>
    localizeRefPhrases(humanizeRefs(text, refSources()), readerCopy())
  // The exact-payload rows, and the names of the files they name by id.
  const payloadRows = createMemo<Array<[string, string]>>(() => {
    const c = current()
    return c
      ? payloadRowsWithoutMessage(displayPayload(), c.toolName, c.editableFields, refText)
      : []
  })
  const payloadFileNames = createPayloadFileNames(() => apiCtx, payloadRows)
  // A standalone approval can be promoted to a bundle head AFTER this card
  // mounts — the WS update carrying the new bundle linkage may arrive late.
  // The mount-time ensureLoaded only loads steps if the row was already a head;
  // re-ensure reactively so a late promotion still pulls the stacked steps.
  // ensureBundleLoaded is idempotent (skips when loaded / in-flight).
  createEffect(() => {
    const c = current()
    if (apiCtx && c && c.bundleId && c.bundlePosition === 0) {
      void ensureBundleLoaded(apiCtx, c)
    }
  })
  // Resolve a step's depends_on source position within the same bundle.
  // Used to render "depends on #N" chips on dependent rows. Returns null when
  // the dep target isn't in this bundle (cross-bundle deps fall through).
  const positionInBundle = (sourceId: string | null | undefined): number | null => {
    if (!sourceId) return null
    const c = current()
    if (!c?.bundleId) return null
    const member = getBundleSteps(c.bundleId).find((s) => s.id === sourceId)
    return member?.bundlePosition ?? null
  }
  const currentUserId = () => userFromToken()?.userId ?? null
  const isRequester = () => current()?.requestedBy.id === currentUserId()
  // Who asked, as the server resolved it (modules/approvals/requester.ts): the
  // agent or routine whose turn raised it ("{Person}'s agent" for a personal
  // agent), and the person only when no agent did. The card never
  // names `requestedBy`, the accountable human, which is how a draft the
  // @support routine wrote read "by" the routine's owner.
  const requesterName = () => current()?.requester?.name ?? ""
  // Decide-eligibility is the shared authority answer (`canDecidePure` over the
  // row's own persisted approveScope) — never a scope recomputed from the tool
  // name, which is how skill approvals rendered without Approve/Deny for the
  // people actually holding kernel:skills:approve.
  const decideFacts = () => {
    const c = current()
    return c ? factsFromSummary(c) : null
  }
  const canApprove = () => {
    const f = decideFacts()
    const uid = currentUserId()
    if (!f || !uid) return false
    return canDecidePure(f, { userId: uid, hasScope }, { sharedSurface: isSharedSurfaceFacts(f) })
  }

  // edit state
  const {
    editing,
    draft,
    setDraft,
    enter: enterEdit,
    cancel: cancelEdit,
    close: closeEdit,
    changedFields: changedEditableFields,
    isDirty,
  } = useEditableDraft({
    // A sealed draft carries no plaintext body: the editor opens on the text
    // this browser decrypted to show it (the same preview the card renders),
    // never on the bare payload, which would open an empty Body. Saving posts
    // the edited text to the payload route, which seals it again to the
    // mailbox and stores no plaintext (approvals/edit.ts).
    initial: () => {
      const c = current()
      if (!c) return {}
      return sealedDraft()
        ? sealedDraftPreviewPayload(c.currentPayload ?? {}, openedDraft())
        : (c.currentPayload ?? {})
    },
    editableFields: () => current()?.editableFields ?? [],
  })
  // One mic, left of Save: the take writes to the draft field last focused.
  const draftDictation = useFormDictation()

  // optimistic state. "decided" = the decide call RESOLVED successfully; the
  // card must stay locked until the terminal row arrives over WS — reverting
  // to idle here reopened the Approve/Deny buttons on an already-decided
  // request for a beat before the card flipped/disappeared.
  type Optimistic = "idle" | "executing" | "decided"
  const [optimistic, setOptimistic] = createSignal<Optimistic>("idle")
  const [inlineError, setInlineError] = createSignal<string | null>(null)
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  function clearOptimisticTimeout() {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle)
      timeoutHandle = null
    }
  }
  onCleanup(clearOptimisticTimeout)

  // when WS lands a terminal status, clear optimistic
  createEffect(() => {
    const c = current()
    if (c && TERMINAL_STATUSES.has(c.status)) {
      setOptimistic("idle")
      clearOptimisticTimeout()
    }
  })

  // deny state
  const [denying, setDenying] = createSignal(false)
  const [denyReason, setDenyReason] = createSignal("")

  function startExecuting() {
    setOptimistic("executing")
    setInlineError(null)
    clearOptimisticTimeout()
    timeoutHandle = setTimeout(() => {
      timeoutHandle = null
      // Only an in-flight decide may unlock on timeout (the request may have
      // never reached the server). A resolved decide stays locked: the row IS
      // decided server-side, re-enabling the buttons would invite a double
      // decide on a request that is merely slow to confirm over WS.
      if (optimistic() === "executing") setOptimistic("idle")
      addToast({
        message: i18n.t("kernel.approvalsUi.stillExecutingInTheBackgroundRefresh"),
        type: "info",
      })
    }, TIMEOUT_MS)
  }

  function clearExecuting() {
    setOptimistic("idle")
    clearOptimisticTimeout()
  }

  function handleDecideError(err: unknown): { keepReasonOpen: boolean } {
    // Undone inside its window: nothing was sent, the card is back as it was.
    if (isDecisionUndone(err)) {
      clearExecuting()
      return { keepReasonOpen: false }
    }
    if (err instanceof ApiError) {
      const handling = decideErrorToast(err, i18n.t)
      addToast(handling.toast)
      if (!handling.keepExecuting) clearExecuting()
      if (handling.inline) setInlineError(handlerCause(err) ?? err.message)
      // The server holds a newer version than this card: read it now rather than wait for a live
      // update this device may have missed, so the card shows what the person must review.
      if (
        ((err.status === 409 && err.code === "payload_changed") ||
          (err.status === 422 && err.code === "send_guard_not_held")) &&
        apiCtx
      )
        void refreshRow(apiCtx, props.requestId).catch(() => {})
      // Some failures prove the approval is gone, in which case a feed row still
      // advertising it is stale and must not survive the error (ticket-10197 /
      // ticket-10200). decide-error.ts owns that judgement so this surface and
      // the attention row cannot drift apart -- notably it is NOT every 409:
      // execution_outcome_unknown leaves the row in place, because Reject is the
      // only control that still works on it.
      if (handling.refreshFeed) {
        const api = getAttentionApi()
        if (api) attentionStore.markStaleAndReload(api)
      }
      return { keepReasonOpen: handling.keepReasonOpen }
    }
    clearExecuting()
    addToast({ message: i18n.t("kernel.approvalsUi.couldnTReachServer"), type: "error" })
    return { keepReasonOpen: false }
  }

  /**
   * Blueprint Task 9.8 and 9.9. A gated send from an end-to-end encrypted
   * personal mailbox stores its drafted body and subject as ciphertext, so the
   * send cannot execute unless THIS browser decrypts them and hands them over
   * as part of approving. It travels with the decision and is stored nowhere.
   *
   * A failure here aborts the approval. Approving anyway would send a blank
   * email and record it as a success.
   */
  async function mailboxFulfilmentForApproval(): Promise<MailboxFulfilmentBody | undefined> {
    const row = current()
    if (!row) return undefined
    if (!isSealedMailApproval({ toolName: row.toolName, payload: row.currentPayload })) {
      return undefined
    }
    const api = apiCtx
    if (!api) {
      throw new MailApprovalFulfilmentError(
        "mailbox_locked",
        i18n.t("kernel.mailboxEncryption.approval.noServer"),
      )
    }
    const [
      { mailboxCryptoClient },
      { loadMessages, sealedMessageById },
      { buildMailboxFulfilment, outboundAttachmentFileIds },
      { createAttachmentOpener },
    ] = await Promise.all([
      import("~/modules/mailbox/mailbox-store"),
      import("~/modules/mail/mail-message-store"),
      import("~/modules/mailbox/approval-mail-fulfilment"),
      import("~/modules/mailbox/attachment-opener"),
    ])
    const client = mailboxCryptoClient()
    if (!client) {
      throw new MailApprovalFulfilmentError(
        "mailbox_locked",
        i18n.t("kernel.mailboxEncryption.approval.unlockFirst"),
      )
    }
    const quoted = row.currentPayload.mailboxQuoteMessageIds
    // Task 9.9. The files this send re-attaches are stored as ciphertext the
    // server cannot open, so their readable bytes have to come from here. The
    // opener fetches each file's envelope and its stored object, decrypts in the
    // crypto worker, and throws rather than returning a short or empty file.
    const attachmentIds = outboundAttachmentFileIds(row.currentPayload)
    const openAttachments = createAttachmentOpener({
      client,
      // Kernel relative: the api client prefixes `/api` itself.
      fetchMetadata: (fileId) => api.get(`/files/${fileId}/metadata`),
      fetchCiphertext: async (fileId) => {
        const response = await api.rawGet(`/files/${fileId}/inline?download=1`)
        return await response.arrayBuffer()
      },
    })
    return await buildMailboxFulfilment(
      {
        isUnlocked: () => client.isUnlocked(),
        openApprovalDraft: (sealed) => client.openApprovalDraft(sealed),
        openMessages: async (ids) => {
          // The quoted original is read from the mail store, which holds only
          // the conversations this browser has opened. Approving from Home or a
          // chat, before the conversation was ever opened here, loads it first
          // instead of refusing the approval.
          const conversationId = row.currentPayload.conversationId
          if (ids.some((id) => !sealedMessageById(id)) && typeof conversationId === "string") {
            await loadMessages(api, conversationId)
          }
          const opened = []
          for (const id of ids) {
            const sealed = sealedMessageById(id)
            if (sealed) opened.push(await client.openMessage(sealed))
          }
          return opened
        },
        openAttachments,
      },
      {
        id: row.id,
        toolName: row.toolName,
        payload: row.currentPayload,
        ...(Array.isArray(quoted)
          ? { quotedMessageIds: quoted.filter((v): v is string => typeof v === "string") }
          : {}),
        // Every re-attached file is named, not only the ones this browser has
        // already established are sealed: the opener reads each file's envelope
        // and passes an unsealed one straight through, so a mixed send still
        // goes out whole and no id needs a sealedness guess up front.
        ...(attachmentIds.length > 0 ? { sealedAttachmentFileIds: attachmentIds } : {}),
      },
    )
  }

  // An Approve pressed while the mailbox was locked. The press is remembered,
  // not dropped: the unlock modal opens, and once the mailbox is open the
  // approve carries on by itself, so the user never has to find the button
  // and press it a second time.
  const [approveAfterUnlock, setApproveAfterUnlock] = createSignal<false | true | "auto_reply">(
    false,
  )
  createEffect(() => {
    const pressed = approveAfterUnlock()
    if (!pressed || mailboxStore.status !== "unlocked") return
    setApproveAfterUnlock(false)
    if (current()?.status !== "pending") return
    void onApprove(pressed === "auto_reply" ? "auto_reply" : undefined)
  })

  // Once per card, so a later re-render never approves a second time.
  let approvedOnOpen = false
  createEffect(() => {
    if (!props.approveOnOpen || approvedOnOpen || current()?.status !== "pending") return
    approvedOnOpen = true
    void onApprove()
  })

  /** The card's own element: a decision is announced from it (`decided-event.ts`). */
  let cardEl: HTMLDivElement | undefined

  async function onApprove(sendGuardOverride?: "auto_reply") {
    if (!apiCtx) return
    if (changedSinceReview().length > 0) {
      addToast({ message: i18n.t("kernel.approvalsUi.err.payloadChanged"), type: "info" })
      return
    }
    let mailboxFulfilment: MailboxFulfilmentBody | undefined
    try {
      mailboxFulfilment = await mailboxFulfilmentForApproval()
    } catch (err) {
      // A locked mailbox is a state the approver can fix right here: open the
      // unlock modal and finish the approve once it opens. No error toast: the
      // modal is the answer, and nothing went wrong.
      if (
        err instanceof MailApprovalFulfilmentError &&
        err.code === "mailbox_locked" &&
        mailboxStore.status !== "unlocked"
      ) {
        setApproveAfterUnlock(sendGuardOverride ?? true)
        requestMailboxUnlock()
        return
      }
      // Refuse, do not approve. The message is the user's, in their words.
      addToast({
        message:
          err instanceof MailApprovalFulfilmentError
            ? err.message
            : i18n.t("kernel.approvalsUi.thisEncryptedMessageCouldNotBe"),
        type: "error",
      })
      return
    }
    // Before the decision is sent: an Undo window hides the card at once.
    announceApprovalDecided(cardEl)
    startExecuting()
    try {
      await decide(apiCtx, props.requestId, "approve", {
        ...(mailboxFulfilment ? { mailboxFulfilment } : {}),
        ...(sendGuardOverride ? { sendGuardOverride } : {}),
        label: sequenceDecisionLabel(),
      })
      setOptimistic("decided")
    } catch (err) {
      handleDecideError(err)
    }
  }

  /** Close out a request wedged at `approving` (outcome unknown). */
  async function onCloseStale() {
    if (!apiCtx) return
    try {
      await decide(apiCtx, props.requestId, "deny", {
        reason: "Closed by an operator: the approved run never confirmed its outcome.",
      })
      setOptimistic("decided")
    } catch (err) {
      handleDecideError(err)
    }
  }

  async function onDenySubmit() {
    if (!apiCtx) return
    // A deny reason is optional -- submit with or without one.
    const reason = denyReason().trim()
    announceApprovalDecided(cardEl)
    startExecuting()
    try {
      await decide(apiCtx, props.requestId, "deny", reason ? { reason } : {})
      setOptimistic("decided")
      setDenying(false)
      setDenyReason("")
    } catch (err) {
      setDenying(handleDecideError(err).keepReasonOpen)
    }
  }

  async function onSave() {
    if (!apiCtx) return
    const changed = changedEditableFields()
    if (Object.keys(changed).length === 0) return
    let fields = changed
    const c = current()
    if (c && sealedDraft()) {
      const whole = sealedDraftEditFields(
        c.currentPayload ?? {},
        draft(),
        changed,
        c.editableFields.map((f) => f.field),
      )
      if (!whole) {
        addToast({
          message: i18n.t("kernel.approvalsUi.err.sealedDraftNotEditable"),
          type: "error",
        })
        return
      }
      fields = whole
    }
    try {
      await updatePayloadAction(apiCtx, props.requestId, fields)
      closeEdit()
    } catch (err) {
      if (err instanceof ApiError) addToast(editErrorToast(err, i18n.t))
      else addToast({ message: i18n.t("kernel.approvalsUi.couldnTReachServer"), type: "error" })
    }
  }

  const isApproving = () => current()?.status === "approving" || optimistic() !== "idle"
  // A row stranded at `approving` (decided minutes ago, outcome never
  // confirmed) is an operator-review state, not "still executing". Ticker so
  // the card flips over without a reload. Gated on tab activity: a hidden
  // tab's card doesn't need to keep recomputing every 30s (C3) — recompute
  // once immediately on reactivation instead so the state isn't stale by up
  // to 30s the moment the user looks back at it.
  const isTabActive = useTabIsActive()
  const [nowTick, setNowTick] = createSignal(Date.now())
  const staleTicker = setInterval(() => {
    if (isTabActive()) setNowTick(Date.now())
  }, 30_000)
  onCleanup(() => clearInterval(staleTicker))
  createEffect(() => {
    if (isTabActive()) setNowTick(Date.now())
  })
  const staleApproving = () => {
    const c = current()
    if (c?.status !== "approving") return false
    const at = c.decidedAt ? Date.parse(c.decidedAt) : Number.NaN
    // The server's own window (decide.ts accepts the stale-request deny only past
    // it), so "Close stale request" is never offered before it can work.
    return Number.isFinite(at) && isApprovingWedged(at, nowTick())
  }
  const isPending = () => current()?.status === "pending" && !isApproving()

  const deadlineMinutes = () => minutesLeft(current()?.expiresAt, nowTick())

  const phone = () => shellTier() === "phone"

  // The send check on an agent's mail draft, as the server read it for this card. A stop is
  // final: the draft can never be approved as it is. A hold replaces Approve with Send now.
  const sendGuard = () => current()?.sendGuard
  const guardStopped = () => {
    const state = sendGuard()?.state
    return (
      state === "replied" || state === "bounced" || state === "opted_out" || state === "ref_stop"
    )
  }
  const guardHeld = () => sendGuard()?.state === "held"
  const decidable = () => !editing() && !denying() && isPending() && canApprove()
  const showApprove = () => decidable() && !guardStopped() && !guardHeld()
  const showSendNow = () => decidable() && guardHeld()
  const guardLine = (): string | null => sendGuardLine(sendGuard(), i18n.t, i18n.locale())

  /**
   * Task 9.9. A sealed send that re-attaches stored files decrypts them HERE at
   * the moment of approval and puts them on the wire. The approver is told that
   * before they click, not after: a person must never discover that approving
   * released something they were not shown.
   */
  const mailboxAttachmentNotice = () => {
    const c = current()
    if (!c || !isPending()) return null
    if (!isSealedMailApproval({ toolName: c.toolName, payload: c.currentPayload })) return null
    return mailAttachmentDisclosure(outboundAttachmentFileIds(c.currentPayload).length, i18n.t)
  }
  // An eligible approver may REJECT (deny), not only the requester — mirrors the
  // backend decide authz (decide.ts: deny allowed for in-audience approver OR
  // requester). Previously gated on isRequester() only, so an approver could
  // approve but never deny.
  const showDeny = () => !editing() && !denying() && isPending() && (canApprove() || isRequester())
  const showEdit = () => {
    const c = current()
    if (!c) return false
    if (!isPending() || editing() || denying()) return false
    if (c.editableFields.length === 0) return false
    // A sealed draft is edited only once this browser has opened it: until then
    // the card shows the locked notice with its Unlock action instead, so Edit
    // never opens on an empty body.
    if (sealedDraft() && !openedDraft()) return false
    return canApprove() || isRequester()
  }

  // The card's decide row, as data: the same actions feed the inline desktop
  // row and the phone bottom sheet.
  const pendingActions = (): SheetAction[] => {
    const actions: SheetAction[] = []
    if (showEdit()) {
      actions.push({
        label: i18n.t("kernel.common.edit"),
        testid: "approval-card-action-edit",
        onClick: enterEdit,
      })
    }
    if (showSendNow()) {
      actions.push({
        label: i18n.t("kernel.approvalsUi.sendGuard.sendNow"),
        testid: "approval-card-action-send-now",
        entityId: props.requestId,
        onClick: () => void onApprove("auto_reply"),
      })
    }
    if (showApprove()) {
      actions.push({
        label: approveLabel(i18n.t("kernel.common.approve")),
        testid: "approval-card-action-approve",
        // Which request this Approve decides: a guided tour presses it only
        // on the request its own run created.
        entityId: props.requestId,
        onClick: () => void onApprove(),
      })
    }
    if (showDeny()) {
      actions.push({
        // The SAME verb the card's own buttons carry: this sheet and the card
        // are one control in two shapes, and "Deny" here beside "Reject" there
        // read as two different decisions.
        label: denyLabel(),
        testid: "approval-card-action-deny",
        onClick: () => setDenying(true),
      })
    }
    return actions
  }

  // Provenance facts for the footer strip: which scope governs the decision,
  // N-eyes sign-off progress, and who decided. Structure is information — each
  // chip states a fact that governs this row, nothing decorative.
  const governingScope = () => {
    const f = decideFacts()
    return f ? decidingScope(f) : null
  }
  const nEyes = () => {
    const c = current()
    if (!c || c.status !== "pending") return null
    const min = Number(c.metadata?.minApprovers)
    if (!Number.isFinite(min) || min < 2) return null
    const done = Array.isArray(c.metadata?.approvedBy) ? c.metadata.approvedBy.length : 0
    return { need: min, done }
  }
  const decidedLine = () => {
    const c = current()
    if (!c?.decidedBy) return null
    if (c.status !== "approved" && c.status !== "denied") return null
    // The viewer's own decision (a requester approving their own card) names
    // them as "you", never as an unnamed teammate.
    const who =
      c.decidedBy === currentUserId()
        ? i18n.t("kernel.approvalsUi.decidedByYou")
        : (c.decidedByName ?? i18n.t("kernel.approvalsUi.aTeammate"))
    return c.decidedAt
      ? i18n.t(`kernel.approvalsUi.decidedByAt.${c.status}`, {
          who,
          when: relativeFromNow(c.decidedAt, i18n.locale()),
        })
      : i18n.t(`kernel.approvalsUi.decidedBy.${c.status}`, { who })
  }

  const statusBadge = () => {
    const c = current()
    if (!c) return null
    // Stranded at `approving`: it WAS approved; what is unknown is the outcome
    // (said by the stale-approving notice below).
    if (c.status === "approved" || staleApproving()) return i18n.t("kernel.approvalsUi.approved")
    if (c.status === "denied") return i18n.t("kernel.approvalsUi.denied")
    if (c.status === "expired") return i18n.t("kernel.approvalsUi.expired")
    if (c.status === "withdrawn") return i18n.t("kernel.approvalsUi.withdrawn")
    return null
  }

  return (
    // A decision waiting out its Undo window hides the card; Undo brings it back.
    <Show when={!isDecisionQueued("approval", props.requestId)}>
      <div
        ref={cardEl}
        class={`my-2 rounded-lg border border-border bg-elevated text-[13px] ${
          compact() ? "p-3" : "p-4"
        }`}
        data-testid="approval-card"
        data-request-id={props.requestId}
        /* Which tool the request runs, so a guided tour can point at one kind of card. */
        data-tool-name={current()?.toolName}
        data-turn-id={props.askId ?? props.turnId ?? undefined}
      >
        <Show
          when={loadFailed()}
          fallback={
            <Show when={current()} fallback={<SkeletonRows />}>
              {(c) => (
                <div>
                  {/* G2: at phone width this line used to ALSO carry the
                    request id (handle + uuid segment) ahead of the deadline,
                    which packed icon + kind + id + separator + deadline onto
                    one line that wrapped at 390px. The id is a desktop-only
                    affordance now (copy-to-clipboard for citing a request in
                    chat/tickets — a phone reader has neither use); the phone
                    line is just the kind, left, and the deadline (or, once
                    decided, the status badge), right, nothing else. */}
                  <div class="flex items-center justify-between gap-2">
                    <div class="flex min-w-0 items-center gap-2 text-text-secondary">
                      {/* WHICH record first (`ticket-B2B-123`), as a monospace chip
                        leading the card, before the kind label, as on the Home
                        row: the reviewer knows what they act on before reading
                        more. */}
                      <Show when={c().summary?.ref}>
                        {(ref) => (
                          <span
                            data-testid="approval-card-ref"
                            class="shrink-0 rounded border border-border-subtle bg-bg-subtle px-1.5 py-0.5 font-mono text-[12px] text-text-secondary"
                          >
                            {ref()}
                          </span>
                        )}
                      </Show>
                      <Show
                        when={c().summary?.kind?.startsWith?.("mail.")}
                        fallback={<Hourglass size={14} />}
                      >
                        <Mail size={14} />
                      </Show>
                      {/* The action, in its app's colour: the same pill as the
                        Home row this card expands from (AppPill). */}
                      <AppPill
                        appId={appIdOfTool(c().toolName)}
                        testid="approval-card-kind"
                        class="min-w-0 truncate px-1.5 py-px text-[11px] font-semibold leading-tight"
                      >
                        {approvalKindLabel(c().toolName, c().summary?.kind, readerCopy())}
                      </AppPill>
                    </div>
                    <Show
                      when={phone()}
                      fallback={
                        <div class="flex items-center gap-2">
                          {/* Stable human identifiers for this approval: the handle
                            (request-N) AND the uuid's first segment, both always
                            visible. Agents cite approvals by uuid in chat and
                            reviewers by handle in tickets/notes; hiding the uuid
                            behind a hover meant "approve 3f2a9c1e-..." could not
                            be matched to any card by eye. Click copies the full
                            uuid, hover shows it. */}
                          <button
                            type="button"
                            data-testid="approval-card-handle"
                            class="flex items-center gap-1 rounded bg-bg-subtle px-1.5 py-0.5 font-mono text-[10px] text-text-tertiary hover:text-text-secondary"
                            title={`${c().id}\n${i18n.t("kernel.approvalsUi.copyIdHint")}`}
                            onClick={() => {
                              void navigator.clipboard?.writeText(c().id)
                              addToast({
                                message: i18n.t("kernel.approvalsUi.copiedId", { id: c().id }),
                                type: "info",
                              })
                            }}
                          >
                            <span>{c().handle}</span>
                            <span aria-hidden="true">·</span>
                            <span data-testid="approval-card-short-id">
                              {shortApprovalId(c().id)}
                            </span>
                          </button>
                          <Show when={statusBadge()}>
                            <span
                              data-testid="approval-card-status-badge"
                              class="rounded bg-bg-subtle px-2 py-0.5 text-[11px] text-text-secondary"
                            >
                              {statusBadge()}
                            </span>
                          </Show>
                        </div>
                      }
                    >
                      {/* Direct children of the row (no wrapping div), so the
                        deadline chip — when it renders — is the LAST CHILD of
                        the first line, not nested a level deeper. */}
                      <Show when={statusBadge()}>
                        <span
                          data-testid="approval-card-status-badge"
                          class="rounded bg-bg-subtle px-2 py-0.5 text-[11px] text-text-secondary"
                        >
                          {statusBadge()}
                        </span>
                      </Show>
                      {/* How long is left, where a phone reader looks first. Only
                        while the request is still live (an approved row's
                        countdown is noise). */}
                      <Show when={isPending() && deadlineMinutes() !== null}>
                        <span
                          data-testid="approval-card-deadline"
                          data-urgent={deadlineIsUrgent(deadlineMinutes()) ? "true" : "false"}
                          class={`font-mono text-[11px] tabular-nums ${
                            deadlineIsUrgent(deadlineMinutes())
                              ? "text-amber-300"
                              : "text-text-tertiary"
                          }`}
                        >
                          {formatTimeLeft((deadlineMinutes() ?? 0) * 60, rowLocale())}
                        </span>
                      </Show>
                    </Show>
                  </div>

                  <div class="mt-2 flex min-w-0 items-baseline gap-2">
                    <div class="min-w-0 font-medium text-text" data-testid="approval-card-title">
                      {/* A bundle reads as its outcome (its last step), as the
                        Home row does; this request's own title becomes step 1. */}
                      <Show when={bundleOutcome()} fallback={summaryTitleOf(c())}>
                        {(last) => (
                          <>
                            {refText(summaryTitleOf(last()))}
                            <span
                              class="ml-1.5 font-mono text-[11px] font-normal text-text-tertiary"
                              data-testid="approval-card-bundle-steps"
                            >
                              {bundleSteps().length + 1} {i18n.t("kernel.shellUi.steps")}
                            </span>
                          </>
                        )}
                      </Show>
                    </div>
                  </div>
                  <Show when={bundleOutcome()}>
                    <div
                      class="mt-1 text-[12px] text-text-secondary"
                      data-testid="approval-card-head-step"
                    >
                      {i18n.t("kernel.approvalsUi.step")} 1{i18n.t("kernel.capabilities.separator")}
                      {summaryTitleOf(c())}
                    </div>
                  </Show>

                  {/* Persistent inline failure: when a previous approve executed
                    the handler but it failed with no effect and the card reverted
                    to pending, show WHY right here (single source: the approval's
                    lastFailure) instead of a silent drop-back + a missed toast. */}
                  <Show when={c().lastFailure}>
                    {(f) => (
                      <div
                        class="mt-2 rounded border border-error-border/60 bg-error-glow px-2 py-1.5 text-[12px] text-error"
                        data-testid="approval-card-last-failure"
                      >
                        {i18n.t("kernel.approvalsUi.lastAttemptFailed")} {f().message}
                      </div>
                    )}
                  </Show>

                  {/* What the send check says now, read for this card. Calm: a line, not an alarm. */}
                  <Show when={guardLine()}>
                    {(line) => (
                      <div
                        class="mt-2 rounded border border-border px-2 py-1.5 text-[12px] text-text-secondary"
                        data-testid="approval-card-send-guard"
                        data-state={sendGuard()?.state}
                      >
                        <div>{line()}</div>
                        <Show when={sendGuard()?.quote}>
                          {(quote) => (
                            <blockquote
                              class="mt-1 border-l-2 border-border pl-2 italic"
                              data-testid="approval-card-send-guard-quote"
                            >
                              {quote()}
                            </blockquote>
                          )}
                        </Show>
                      </div>
                    )}
                  </Show>

                  <Show
                    when={
                      c().summary?.subtitle &&
                      !(c().status !== "pending" && isPendingSubtitle(c().summary?.subtitle))
                    }
                  >
                    <div class="mt-0.5 break-words text-text-secondary">
                      <PayloadValue
                        path="summary-subtitle"
                        value={localizeApprovalText(
                          localizedApprovalSubtitle(c().summary?.subtitle ?? "", i18n.t),
                          readerCopy(),
                        )}
                      />
                    </div>
                  </Show>

                  {/* Skill create/update render a dedicated readable view (the full
                    skill, or a git-style body diff) in place of the raw payload. */}
                  <Show when={!editing() && skillApprovalKind()}>
                    {(kind) => (
                      <SkillApprovalView api={apiCtx} kind={kind()} payload={c().currentPayload} />
                    )}
                  </Show>

                  <Show
                    when={visibleSummaryLines().length > 0 && !editing() && !skillApprovalKind()}
                  >
                    <ul class="mt-2 space-y-1 text-text-secondary">
                      <For each={visibleSummaryLines()}>
                        {(line) => (
                          <li>
                            <SummaryLineText line={line} format={refText} />
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>

                  <Show when={!editing() && sealedDraft() && !openedDraft()}>
                    {/* The draft is readable once the mailbox unlocks (the effect
                      above re-runs on the status change), so the way to unlock
                      sits right here rather than in the mail tab. Unreadable
                      and still opening keep their one quiet line. */}
                    <Show
                      when={!draftUnreadable() && mailboxStore.status !== "unlocked"}
                      fallback={
                        <div
                          class="mt-2 text-[12px] text-text-tertiary"
                          data-testid="approval-card-sealed-draft-notice"
                        >
                          {draftUnreadable()
                            ? i18n.t("kernel.approvalsUi.err.sealedDraftUnreadable")
                            : i18n.t("kernel.approvalsUi.err.sealedDraftOpening")}
                        </div>
                      }
                    >
                      <div class="mt-2" data-testid="approval-card-sealed-draft-notice">
                        <MailboxLockedPanel
                          variant="card"
                          body={i18n.t("kernel.approvalsUi.err.sealedDraftLocked")}
                          devicePrfMismatch={
                            mailboxStore.lastErrorCode === "MAILBOX_DEVICE_PRF_MISMATCH"
                          }
                          unlockTestId="approval-card-sealed-draft-unlock"
                        />
                      </div>
                    </Show>
                  </Show>

                  {/* Full outgoing message — the summary lines above are capped at
                    500 chars by the approval-summary schema (a skim preview), so
                    a reviewer approving a customer-facing send needs the COMPLETE
                    message here, expandable, sourced untruncated from the payload.
                    Skipped for skill kinds: the SkillApprovalView above already
                    renders the body (a skill payload's `body` would otherwise
                    double up here as a redundant "Message" block). */}
                  <Show
                    when={
                      !editing() && !skillApprovalKind()
                        ? primaryMessageField(displayPayload(), current()?.editableFields)
                        : null
                    }
                  >
                    {(field) => (
                      <ApprovalMessageBlock
                        api={apiCtx}
                        body={refText(field().body)}
                        testid="approval-card-message"
                      />
                    )}
                  </Show>
                  {/* Exact payload — always rendered while the request is still
                    decidable. Complete field list of what will execute; the
                    curated lines above never substitute for it. */}
                  <Show
                    when={
                      !editing() &&
                      !TERMINAL_STATUSES.has(c().status) &&
                      !skillApprovalKind() &&
                      Object.keys(c().currentPayload ?? {}).length > 0
                    }
                  >
                    <details
                      class="mt-3"
                      data-testid="approval-card-payload"
                      open={!hasCuratedSummary(c())}
                    >
                      <summary class="cursor-pointer text-[11px] uppercase tracking-wide text-text-tertiary">
                        {hasCuratedSummary(c())
                          ? i18n.t("kernel.approvalsUi.technicalDetails")
                          : i18n.t("kernel.approvalsUi.exactPayload")}
                      </summary>
                      <ul class="mt-1 space-y-0.5 font-mono text-[11px] leading-snug text-text-secondary">
                        <For each={payloadRows()}>
                          {([path, val]) => (
                            <li class="flex gap-2">
                              <span class="shrink-0 text-text-tertiary">{path}:</span>
                              <PayloadFileValue
                                path={path}
                                value={val}
                                names={payloadFileNames()}
                              />
                              <Show when={defaultedPaths(c()).has(path)}>
                                <span
                                  class="shrink-0 text-text-tertiary"
                                  data-testid={`approval-payload-default-${path}`}
                                >
                                  {i18n.t("kernel.approvalsUi.default")}
                                </span>
                              </Show>
                            </li>
                          )}
                        </For>
                      </ul>
                    </details>
                  </Show>

                  <Show when={bundleSteps().length > 0}>
                    <div class="mt-3 flex flex-col gap-2" data-testid="approval-bundle-steps">
                      <For each={bundleStepIds()}>
                        {(stepId, i) => (
                          <Show when={getById(stepId)}>
                            {(step) => (
                              <BundleStepRow
                                api={apiCtx}
                                step={step()}
                                index={i()}
                                dependsOnPosition={positionInBundle(step().dependsOnId)}
                                refText={refText}
                              />
                            )}
                          </Show>
                        )}
                      </For>
                    </div>
                  </Show>

                  <Show when={c().summary?.links?.length}>
                    <ApprovalLinks api={apiCtx} links={c().summary?.links ?? []} />
                  </Show>

                  <Show when={editing()}>
                    <div class="mt-3 flex flex-col gap-2">
                      <For each={c().editableFields}>
                        {(field) => {
                          const value = () => String(draft()[field.field] ?? "")
                          const onInput = (e: InputEvent) => {
                            const target = e.currentTarget as HTMLInputElement | HTMLTextAreaElement
                            setDraft({ ...draft(), [field.field]: target.value })
                          }
                          const inputId = `approval-card-field-${field.field}`
                          let richField: RichEditorHandle | undefined
                          let plainField: HTMLTextAreaElement | undefined
                          return (
                            <div
                              class="flex flex-col gap-1"
                              onFocusIn={() => draftDictation.focused(richField ?? plainField)}
                            >
                              <div class="flex items-center justify-between gap-2">
                                <label
                                  for={inputId}
                                  class="text-[11px] uppercase tracking-wide text-text-tertiary"
                                >
                                  {field.label}
                                </label>
                                <Show when={field.widget === "richtext"}>
                                  <span class="flex min-w-0 flex-1 items-center justify-end gap-0.5">
                                    <ComposerAssist target={() => richField ?? plainField} />
                                  </span>
                                </Show>
                              </div>
                              <Show
                                when={field.widget === "richtext"}
                                fallback={
                                  <input
                                    type="text"
                                    id={inputId}
                                    data-testid={inputId}
                                    class="rounded border border-border bg-bg px-2 py-1 text-text"
                                    value={value()}
                                    onInput={onInput}
                                  />
                                }
                              >
                                <Show
                                  when={emailBodyPreset(c().toolName, field.field)}
                                  fallback={
                                    <textarea
                                      ref={(el) => {
                                        plainField = el
                                        draftDictation.field(el)
                                      }}
                                      rows={6}
                                      id={inputId}
                                      data-testid={inputId}
                                      class="rounded border border-border bg-bg px-2 py-1 text-text"
                                      value={value()}
                                      onInput={onInput}
                                    />
                                  }
                                >
                                  {(preset) => (
                                    <RichEditor
                                      preset={preset()}
                                      ref={(handle) => {
                                        richField = handle
                                        draftDictation.field(handle)
                                      }}
                                      value={value()}
                                      onChange={(md) => setDraft({ ...draft(), [field.field]: md })}
                                      class={EMAIL_BODY_EDITOR_CLASS}
                                      editorClass="min-h-[7.5rem] text-text"
                                      aria-label={field.label}
                                      data-testid={inputId}
                                    />
                                  )}
                                </Show>
                              </Show>
                            </div>
                          )
                        }}
                      </For>
                    </div>
                  </Show>

                  <Show when={inlineError()}>
                    <div
                      data-testid="approval-card-error"
                      class="mt-3 rounded border border-danger/40 bg-danger/5 p-2 text-[12px] text-danger"
                    >
                      {inlineError()}
                    </div>
                  </Show>

                  {/* G2: at phone width the requester line stands alone, and
                    everything else that used to share its row (the governing
                    scope / private-owner badge, sign-off count, decided-by)
                    moves under it as ONE muted row, freeing the requester line
                    from competing for space at 390px. Desktop keeps the
                    original single row. */}
                  <Show
                    when={phone()}
                    fallback={
                      <div class="mt-3 flex items-center justify-between gap-2 text-[11px] text-text-tertiary">
                        <div
                          class="flex flex-wrap items-center gap-x-2 gap-y-1"
                          data-testid="approval-card-provenance"
                        >
                          <span>
                            {i18n.t("kernel.approvalsUi.requestedBy")} {requesterName()} ·{" "}
                            {relativeFromNow(c().createdAt, i18n.locale())}
                          </span>
                          <Show
                            when={!c().resourceOwnerId && governingScope()}
                            fallback={
                              <Show when={c().resourceOwnerId}>
                                <span
                                  data-testid="approval-card-private-badge"
                                  class="rounded bg-bg-subtle px-1.5 py-0.5 text-[10px]"
                                  title={i18n.t(
                                    "kernel.approvalsUi.routedPrivatelyToTheResourceOwner",
                                  )}
                                >
                                  {i18n.t("kernel.approvalsUi.privateOwnerDecides")}
                                </span>
                              </Show>
                            }
                          >
                            {(scope) => (
                              <span
                                data-testid="approval-card-scope"
                                class="rounded bg-bg-subtle px-1.5 py-0.5 text-[10px]"
                                title={`${i18n.t("kernel.approvalsUi.onlyHoldersOfThisScopeCan")}: ${scope()}`}
                                data-scope={scope()}
                              >
                                {approvalScopeLabel(scope(), readerCopy())}
                              </span>
                            )}
                          </Show>
                          <Show when={nEyes()}>
                            {(n) => (
                              <span
                                data-testid="approval-card-neyes"
                                class="rounded bg-bg-subtle px-1.5 py-0.5 text-[10px]"
                                title={i18n.t(
                                  "kernel.approvalsUi.orgPolicyRequiresMultipleDistinctApprovers",
                                )}
                              >
                                {n().done} {i18n.t("kernel.approvalsUi.of")} {n().need}{" "}
                                {i18n.t("kernel.approvalsUi.signOffs")}
                              </span>
                            )}
                          </Show>
                          <Show when={decidedLine()}>
                            <span data-testid="approval-card-decided-by">{decidedLine()}</span>
                          </Show>
                        </div>
                      </div>
                    }
                  >
                    <div class="mt-3 flex flex-col gap-1 text-[11px] text-text-tertiary">
                      <span data-testid="approval-card-provenance">
                        {i18n.t("kernel.approvalsUi.requestedBy")} {requesterName()} ·{" "}
                        {relativeFromNow(c().createdAt, i18n.locale())}
                      </span>
                      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <Show
                          when={!c().resourceOwnerId && governingScope()}
                          fallback={
                            <Show when={c().resourceOwnerId}>
                              <span
                                data-testid="approval-card-private-badge"
                                class="rounded bg-bg-subtle px-1.5 py-0.5 text-[10px]"
                                title={i18n.t(
                                  "kernel.approvalsUi.routedPrivatelyToTheResourceOwner",
                                )}
                              >
                                {i18n.t("kernel.approvalsUi.privateOwnerDecides")}
                              </span>
                            </Show>
                          }
                        >
                          {(scope) => (
                            <span
                              data-testid="approval-card-scope"
                              class="rounded bg-bg-subtle px-1.5 py-0.5 text-[10px]"
                              title={`${i18n.t("kernel.approvalsUi.onlyHoldersOfThisScopeCan")}: ${scope()}`}
                              data-scope={scope()}
                            >
                              {approvalScopeLabel(scope(), readerCopy())}
                            </span>
                          )}
                        </Show>
                        <Show when={nEyes()}>
                          {(n) => (
                            <span
                              data-testid="approval-card-neyes"
                              class="rounded bg-bg-subtle px-1.5 py-0.5 text-[10px]"
                              title={i18n.t(
                                "kernel.approvalsUi.orgPolicyRequiresMultipleDistinctApprovers",
                              )}
                            >
                              {n().done} {i18n.t("kernel.approvalsUi.of")} {n().need}{" "}
                              {i18n.t("kernel.approvalsUi.signOffs")}
                            </span>
                          )}
                        </Show>
                        <Show when={decidedLine()}>
                          <span data-testid="approval-card-decided-by">{decidedLine()}</span>
                        </Show>
                      </div>
                    </div>
                  </Show>

                  <Show
                    when={
                      c().metadata &&
                      typeof c().metadata?.runId === "string" &&
                      // A sub-run a chat turn spawned has no parent run, only its role.
                      (typeof c().metadata?.parentRunId === "string" ||
                        typeof c().metadata?.subagentType === "string")
                    }
                  >
                    <div
                      data-testid="approval-card-subrun-breadcrumb"
                      class="mt-2 text-[11px] text-text-secondary"
                    >
                      {i18n.t("kernel.approvalsUi.triggeredBySubRun")}{" "}
                      <strong>{String(c().metadata?.subagentType ?? "(unknown)")}</strong>
                      <Show when={c().metadata?.label}> ({String(c().metadata?.label)})</Show>
                      <Show
                        when={c().metadata?.hiddenThreadId}
                        fallback={
                          <span
                            data-testid="approval-card-subrun-link-missing"
                            class="ml-2 text-text-tertiary"
                          >
                            {i18n.t("kernel.approvalsUi.transcriptUnavailable")}
                          </span>
                        }
                      >
                        <a
                          data-testid="approval-card-subrun-link"
                          class="ml-2 underline"
                          href={`#/threads/${String(c().metadata?.hiddenThreadId)}`}
                          onClick={(e) => {
                            e.preventDefault()
                            const threadId = String(c().metadata?.hiddenThreadId)
                            openTab({
                              type: "thread",
                              entityId: threadId,
                              label: i18n.t("kernel.approvalsUi.subRun"),
                            })
                          }}
                        >
                          {i18n.t("kernel.approvalsUi.seeSubRunReasoning")}
                        </a>
                      </Show>
                    </div>
                  </Show>

                  <Show when={isApproving() && !staleApproving()}>
                    <div
                      data-testid="approval-card-executing"
                      class="mt-3 flex items-center gap-2 text-text-secondary"
                    >
                      <Hourglass size={14} />
                      <span>{i18n.t("kernel.executing")}</span>
                    </div>
                  </Show>
                  <Show when={staleApproving()}>
                    {/* Approved but the run never confirmed its outcome (the
                      backend strands such rows at `approving` for operator
                      review rather than guessing). An eternal hourglass here
                      reads as "still working" — say what actually happened. */}
                    <div
                      data-testid="approval-card-stale-approving"
                      class="mt-3 rounded border border-warning/40 bg-warning/5 p-2 text-warning"
                    >
                      {i18n.t("kernel.approvalsUi.approvedButTheToolRunHas")}
                      {/* The server's own way out for a wedged row (decide.ts:
                        a deny on a row wedged past the grace window terminates
                        it and records deniedWhileWedged, so nobody later reads
                        the denial as proof the action never ran). Approve is
                        never offered again: it would re-run a side effect that
                        may already have landed. */}
                      <Show when={canApprove() || isRequester()}>
                        <div class="mt-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            data-testid="approval-card-stale-close"
                            disabled={optimistic() !== "idle"}
                            onClick={() => void onCloseStale()}
                          >
                            {i18n.t("kernel.approvalsUi.closeStaleRequest")}
                          </Button>
                        </div>
                      </Show>
                    </div>
                  </Show>

                  <Show when={denying() && !isApproving() && phone()}>
                    {/* At phone width the reason is asked in a sheet: the row of
                      three buttons stays where the thumb left it. */}
                    <OverlaySheet
                      open={true}
                      onClose={() => {
                        setDenying(false)
                        setDenyReason("")
                      }}
                      variant="bottom"
                      title={i18n.t("kernel.approvalDenyTitle")}
                      closeLabel={i18n.t("kernel.close")}
                    >
                      <div class="flex flex-col gap-3 p-4" data-testid="approval-deny-sheet">
                        <input
                          type="text"
                          data-testid="approval-card-deny-reason"
                          placeholder={i18n.t("kernel.reasonOptional")}
                          class="min-h-11 rounded border border-border bg-bg px-3 text-text"
                          value={denyReason()}
                          onInput={(e) => setDenyReason(e.currentTarget.value)}
                        />
                        <button
                          type="button"
                          data-testid="approval-card-action-deny-submit"
                          class="min-h-11 w-full rounded-lg bg-danger text-[15px] font-medium text-white"
                          onClick={() => {
                            nativeHaptic("warning")
                            void onDenySubmit()
                          }}
                        >
                          {i18n.t("kernel.approvalDenySubmit")}
                        </button>
                      </div>
                    </OverlaySheet>
                  </Show>

                  <Show when={denying() && !isApproving() && !phone()}>
                    <div class="mt-3 flex flex-col gap-2">
                      <input
                        type="text"
                        data-testid="approval-card-deny-reason"
                        placeholder={i18n.t("kernel.reasonOptional")}
                        class="rounded border border-border bg-bg px-2 py-1 text-text"
                        value={denyReason()}
                        onInput={(e) => setDenyReason(e.currentTarget.value)}
                      />
                      <div class="flex gap-2">
                        <Button
                          type="button"
                          size="sm"
                          data-testid="approval-card-action-deny-submit"
                          onClick={() => void onDenySubmit()}
                        >
                          {i18n.t("kernel.common.submit")}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setDenying(false)
                            setDenyReason("")
                          }}
                        >
                          {i18n.t("kernel.common.cancel")}
                        </Button>
                      </div>
                    </div>
                  </Show>

                  <Show when={editing()}>
                    {/* The mic left of Save; a take turns this row into the recorder line. */}
                    <div class="mt-3 flex items-center gap-2">
                      <RecorderRow dictation={draftDictation.dictation}>
                        <DictationMic dictation={draftDictation.dictation} />
                        <Button
                          type="button"
                          size="sm"
                          data-testid="approval-card-action-save"
                          disabled={!isDirty()}
                          onClick={() => void onSave()}
                        >
                          {i18n.t("kernel.common.save")}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          data-testid="approval-card-action-cancel"
                          onClick={cancelEdit}
                        >
                          {i18n.t("kernel.common.cancel")}
                        </Button>
                      </RecorderRow>
                    </div>
                  </Show>

                  <Show when={mailboxAttachmentNotice()}>
                    {(notice) => (
                      <p
                        class="mt-3 text-xs text-muted-foreground"
                        data-testid="approval-card-mailbox-attachment-notice"
                      >
                        {notice()}
                      </p>
                    )}
                  </Show>

                  {/* Next to the decide row: Approve stays bound to the version the person saw until they
                    read the new one, so the way to read it sits where they press Approve. */}
                  <Show when={isPending() && changedSinceReview().length > 0}>
                    <div
                      class="mt-2 rounded border border-border bg-bg-subtle p-2 text-[12px] text-text"
                      data-testid="approval-card-changed-notice"
                      role="status"
                    >
                      <div>{i18n.t("kernel.approvalsUi.changedSinceOpened")}</div>
                      <button
                        type="button"
                        class="mt-1 text-[12px] font-medium text-accent hover:underline"
                        data-testid="approval-card-changed-ack"
                        onClick={() => acknowledgePayloadChanges(changedSinceReview())}
                      >
                        {i18n.t("kernel.approvalsUi.readTheNewVersion")}
                      </button>
                    </div>
                  </Show>

                  <Show when={!editing() && !denying() && isPending()}>
                    <Show
                      when={phone()}
                      fallback={
                        <BottomSheetActions
                          class="mt-3"
                          actions={pendingActions()}
                          moreLabel={i18n.t("kernel.actions")}
                          closeLabel={i18n.t("kernel.close")}
                        />
                      }
                    >
                      {/* A decision is the whole point of the card, so at phone
                        width all three verbs are on screen at 44px rather than
                        one tap deep behind a "more" trigger. */}
                      <div
                        class="mt-3 flex items-center gap-2"
                        data-testid="approval-card-actions"
                        // The bottom tab bar is drawn OVER the scrolling card, so
                        // the decide row ended up underneath it: the one control
                        // the card exists for was the one a thumb could not
                        // reach. It clears the bar off the shell's own variable
                        // (`--shell-bottom-bar`, 0 above phone width) plus the
                        // device safe area, so nothing here is a guessed number.
                        style={{
                          "padding-bottom":
                            "calc(env(safe-area-inset-bottom, 0px) + var(--shell-bottom-bar, 0px))",
                        }}
                      >
                        <Show when={showDeny()}>
                          <button
                            type="button"
                            data-testid="approval-card-action-deny"
                            class="min-h-11 flex-1 rounded-lg border border-border text-[15px] text-text"
                            onClick={() => setDenying(true)}
                          >
                            {denyLabel()}
                          </button>
                        </Show>
                        <Show when={showEdit()}>
                          <button
                            type="button"
                            data-testid="approval-card-action-edit"
                            class="min-h-11 flex-1 rounded-lg border border-border text-[15px] text-text"
                            onClick={() => enterEdit()}
                          >
                            {i18n.t("kernel.approvalEdit")}
                          </button>
                        </Show>
                        <Show when={showSendNow()}>
                          <button
                            type="button"
                            data-testid="approval-card-action-send-now"
                            data-entity-id={props.requestId}
                            class="min-h-11 flex-[1.4] rounded-lg bg-accent text-[15px] font-medium text-accent-foreground"
                            onClick={() => void onApprove("auto_reply")}
                          >
                            {i18n.t("kernel.approvalsUi.sendGuard.sendNow")}
                          </button>
                        </Show>
                        <Show when={showApprove()}>
                          <button
                            type="button"
                            data-testid="approval-card-action-approve"
                            data-entity-id={props.requestId}
                            data-tool-name={current()?.toolName}
                            class="min-h-11 flex-[1.4] rounded-lg bg-accent text-[15px] font-medium text-accent-foreground"
                            onClick={() => {
                              nativeHaptic("success")
                              void onApprove()
                            }}
                          >
                            {approveLabel(i18n.t("kernel.approvalApprove"))}
                          </button>
                        </Show>
                      </div>
                    </Show>
                  </Show>
                </div>
              )}
            </Show>
          }
        >
          {(err) => (
            <div data-testid="approval-card-error" class="text-[12px] text-text-secondary">
              {err().status === 404
                ? i18n.t("kernel.approvalsUi.approvalRequestNoLongerExists")
                : i18n.t("kernel.approvalsUi.couldnTLoadApprovalRequest")}
            </div>
          )}
        </Show>
      </div>
    </Show>
  )
}

const SkeletonRows: Component = () => (
  <div class="flex flex-col gap-2" data-testid="approval-card-skeleton">
    <div class="h-3 w-1/3 animate-pulse rounded bg-bg-subtle" />
    <div class="h-3 w-2/3 animate-pulse rounded bg-bg-subtle" />
    <div class="h-3 w-1/2 animate-pulse rounded bg-bg-subtle" />
  </div>
)

export default ApprovalCard
