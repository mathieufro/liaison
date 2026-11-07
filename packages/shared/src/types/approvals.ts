// SPDX-License-Identifier: FSL-1.1-ALv2
import { z } from "zod"

// Two link shapes: an in-app entity link (opened via openEntity/tab system)
// or an EXTERNAL https URL (opened in a new browser tab) for entities whose
// real surface lives outside Liaison, e.g. a Shopify admin order page.
// External URLs are https-only; the renderer must use rel="noopener".
export const approvalSummaryLinkSchema = z.union([
  z.object({
    label: z.string().min(1).max(100),
    app: z.string().min(1).max(50),
    entityType: z.string().min(1).max(50),
    entityId: z.string().min(1).max(100),
  }),
  z.object({
    label: z.string().min(1).max(100),
    url: z
      .string()
      .url()
      .max(500)
      .refine((u) => u.startsWith("https://"), "external links must be https"),
  }),
])

/**
 * A summary line's cap. Long enough for a short note or message written out in
 * full (an MCP tool's argument text, approval-summary.ts in the api), short
 * enough that a card stays a card; a longer value ends on "…" and stays whole
 * in the card's exact payload.
 */
export const APPROVAL_SUMMARY_LINE_MAX = 500

export const approvalSummarySchema = z.object({
  kind: z.string().min(1).max(100),
  title: z.string().min(1).max(200),
  subtitle: z.string().max(200).optional(),
  lines: z.array(z.string().max(APPROVAL_SUMMARY_LINE_MAX)).max(8),
  links: z.array(approvalSummaryLinkSchema).max(10).optional(),
  // Per-call blast-radius override for the attention feed. A summarizer sees
  // the actual params at gate time, so it can refine the manifest's static
  // `approvalImpact` for param-dependent tools (e.g. tickets close: silent
  // close is internal, but a close WITH a body emails the customer, external).
  // Frozen with the summary on the approval row; when absent, consumers fall
  // back to the manifest declaration, then to "external".
  impact: z.enum(["external", "internal"]).optional(),
  // The id of the record acted on (`ticket-B2B-123`), shown first on the card
  // as a monospace chip so a reviewer knows WHICH record before reading more.
  ref: z.string().max(40).optional(),
})

export type ApprovalSummary = z.infer<typeof approvalSummarySchema>
export type ApprovalSummaryLink = z.infer<typeof approvalSummaryLinkSchema>

export function truncateApprovalSummary(s: ApprovalSummary): ApprovalSummary {
  return {
    kind: s.kind.slice(0, 100),
    title: s.title.slice(0, 200),
    subtitle: s.subtitle !== undefined ? s.subtitle.slice(0, 200) : undefined,
    impact: s.impact,
    ref: s.ref !== undefined ? s.ref.slice(0, 40) : undefined,
    // A line past the cap ends on "…" so a reviewer can tell it was cut (the
    // full value stays in the card's exact payload).
    lines: s.lines
      .slice(0, 8)
      .map((line) =>
        line.length > APPROVAL_SUMMARY_LINE_MAX
          ? `${line.slice(0, APPROVAL_SUMMARY_LINE_MAX - 1)}…`
          : line,
      ),
    links: s.links?.slice(0, 10).map((link) =>
      "url" in link
        ? { label: link.label.slice(0, 100), url: link.url.slice(0, 500) }
        : {
            label: link.label.slice(0, 100),
            app: link.app.slice(0, 50),
            entityType: link.entityType.slice(0, 50),
            entityId: link.entityId.slice(0, 100),
          },
    ),
  }
}

export type ApprovalRequestStatus =
  | "pending"
  | "deferred"
  | "approving"
  | "approved"
  | "denied"
  | "expired"
  | "cancelled"
  | "withdrawn"

export interface ApprovalEditableField {
  field: string
  label: string
  // Phase 16 Task A5 widened the supported widgets so approval-card editable
  // fields can affordance more than just plain-text inputs. `checkbox-per-line`
  // is the line-by-line restock toggles on refund cards; `key-value-list` lets
  // a card edit a sparse map (e.g. line-item quantity overrides);
  // `checkbox` is a single boolean (e.g. "Notify customer");
  // `email-list` edits a recipient array (mail to/cc/bcc) before approving a send.
  widget: "text" | "richtext" | "checkbox" | "checkbox-per-line" | "key-value-list" | "email-list"
  /**
   * For `checkbox-per-line` and `key-value-list` widgets only — names the
   * dot-path under `currentPayload` whose entries the widget renders.
   * Validated server-side against the tool's editable-field schema.
   */
  listSource?: string
  /**
   * Payload keys holding a DERIVED rendering of this field (e.g. an agent's
   * pre-rendered `htmlBody` derived from `textBody`). When an edit changes this
   * field, the kernel blanks each listed key so the executed handler regenerates
   * it from the edited value — otherwise the send ships the stale derived copy
   * (the approved-but-wrong-draft-sent bug: email clients render the untouched
   * htmlBody, not the edited textBody).
   */
  invalidates?: string[]
}

export interface ApprovalLastEdit {
  editorUserId: string
  at: string
  diff: Array<{ field: string; from: unknown; to: unknown }>
}

/** Why the most recent post-approval execution failed. Present on a request
 *  that came BACK to pending after the approved handler failed with no effect
 *  (or ambiguously) — sourced once from `approved_handler_executions`. Rendered
 *  inline on the approval card so an approver who clicks Approve and sees the
 *  card silently revert learns the reason (e.g. "Order has no OPEN fulfillment
 *  orders to fulfill"). */
export interface ApprovalLastFailure {
  code: string
  message: string
  at: string
}

/**
 * What the send check says about an agent's mail draft, read fresh at each card read (never
 * stored). `quote` is the start of the message that stopped or held it, read with the viewer's
 * own access: a message in a mailbox the viewer cannot read gives no quote and no `record`.
 */
export interface ApprovalSendGuard {
  state: "clear" | "replied" | "bounced" | "held" | "opted_out" | "ref_stop" | "unavailable"
  /** Who wrote the message that stopped or held it. */
  who?: string | null
  /** When that message came in (ISO). */
  at?: string
  /** A hold's end (ISO): until then the draft waits, after it the hold clears by itself. */
  holdUntil?: string
  quote?: string
  /** The stop's code (`send_guard_replied`, a provider's own), or why the check could not run. */
  code?: string
  /** A provider's or a check's own words for a stop. */
  label?: string
  optedOut?: string[]
  /** Where the message sits, when the viewer can open it. */
  record?: { kind: "conversation" | "ticket"; id: string }
}

/** Who asked for an approval (see `ApprovalRequestSummary.requester`). */
export interface ApprovalRequester {
  kind: "agent" | "user"
  id: string
  name: string
}

export interface ApprovalRequestSummary {
  id: string
  handle: string
  status: ApprovalRequestStatus
  createdAt: string
  expiresAt: string
  toolName: string
  /**
   * The row's persisted decision scope (null = derived `<app>:approve`).
   * Dimension-constrained approvals (e.g. skills → `kernel:skills:approve`)
   * carry their custom scope here so clients can ask "can I decide this?"
   * through the shared authority module (`decidingScope`/`factsFromSummary`)
   * instead of recomputing from the tool name — the recompute is how the web
   * card rendered skill approvals without Approve/Deny for actual approvers.
   * Optional ONLY for the wire boundary: rows cached from a pre-approveScope
   * deploy may lack it, and `factsFromSummary` maps absent to the legacy null
   * fallback. Server builders always supply it (required on
   * `BuildApprovalSummaryRaw`).
   */
  approveScope?: string | null
  summary: ApprovalSummary
  editableFields: ApprovalEditableField[]
  currentPayload: Record<string, unknown>
  /**
   * Fingerprint of `currentPayload` (and the tool): the version a decision is bound to. An approve
   * carries it back as `payloadHash`, and the server refuses it (409 `payload_changed`) when the
   * payload was edited after this was read. Required on the wire from the server; optional here
   * only for rows cached before the field existed.
   */
  payloadHash?: string
  threadId: string
  originatingThreadId: string
  /**
   * The human this request is accountable to: self-approval and requester
   * checks key on it. It carries no name on purpose: who ASKED is `requester`,
   * and a surface that printed this person instead named the routine's owner
   * on every draft the @support routine wrote.
   */
  requestedBy: { id: string }
  /**
   * Who asked, as every surface names it: the role or system agent whose turn
   * raised the request, else the person (a personal agent acts as its person).
   * Resolved once on the server (modules/approvals/requester.ts). Optional only
   * at the wire boundary, for a row cached from before it existed.
   */
  requester?: ApprovalRequester
  notifyUserIds: string[]
  decidedBy?: string
  /** Display name of the decider, when resolvable — so the card can say
   *  "Approved by Bob" instead of showing a raw user id or nothing. */
  decidedByName?: string
  decidedAt?: string
  reason?: string
  /** True when the call waits only because its conversation read outside text (the
   *  `taint_escalation` reason): the conversation's outside-text globe pulses when one appears. */
  heldForOutsideText?: true
  bundleId: string | null
  bundlePosition: number | null
  /** Edge to a source approval whose outputs this step depends on. Independent
   *  of `bundleId` — a step can depend on a source in a different bundle (the
   *  cross-step `@ref` case under parallel approval bundling). */
  dependsOnId: string | null
  /**
   * When the gated tool targets a PERSONALLY-owned resource (e.g. a mail reply
   * from a personal mailbox), the resolved owner's user id. Such approvals are
   * privately routed: visible and decidable only by the requester and this
   * owner, never the org-wide approver set. Null for org/shared resources.
   */
  resourceOwnerId?: string | null
  lastEdit: ApprovalLastEdit | null
  /** A gated mail send's guard state (`mail:compose`, `mail:reply` drafted by an agent). */
  sendGuard?: ApprovalSendGuard
  /** The most recent post-approval execution failure, when the request reverted
   *  to pending; null if it never failed. The card renders this inline so a
   *  no-effect failure is never a silent drop-back to pending. */
  lastFailure: ApprovalLastFailure | null
  /**
   * Free-form metadata carried from the approval row's `metadata` jsonb. The
   * kernel currently uses this to thread sub-run breadcrumbs:
   *   { runId, parentRunId, subagentType, label, hiddenThreadId }
   * Frontends should treat unknown keys as opaque and render only the keys
   * they understand. `hiddenThreadId` enables the approval card's "See
   * sub-run reasoning" deep-link to point at the existing `/threads/:id`
   * route rather than a separate `/runs/:runId` page.
   */
  metadata?: Record<string, unknown>
}
