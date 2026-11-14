// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Invoicing UI kit: the shared primitive set from @liaison/app-ui/kit plus the
// invoicing-only surfaces (minor-unit Money, document StatusBadge and
// TypeLabel, date input, styled Select) and the invoicing default test ids on
// ConfirmDialog.
//
// Principles: quiet surfaces, one accent, generous spacing, tabular money,
// status as tinted badges (never raw enum text), real form controls (no naked
// native widgets). Restraint over decoration.

import {
  Badge,
  type BadgeTone,
  cx,
  inputClass,
  ConfirmDialog as SharedConfirmDialog,
} from "@liaison/app-ui/kit"
import { type Component, type JSX, Show } from "solid-js"
import { formatMoneyGrouped } from "../money"
import { tr } from "./i18n"

export {
  Badge,
  type BadgeTone,
  Button,
  cx,
  Field,
  inputClass,
  SectionLabel,
  Segmented,
} from "@liaison/app-ui/kit"

// ── Money ──────────────────────────────────────────────────────────────────
/**
 * Whether an id names a person the host can describe (a user id). A record written by a seed,
 * an import or the system names its writer with a word ("seed", "system"), which the host's
 * person preview refuses: asking for it only fails, on every draw.
 */
export function isUserId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  )
}

// Minor units (bigint|number|string) → grouped major string, tabular + mono so
// columns of figures align. Currency code rendered as a quiet trailing token.
// The currency's ISO 4217 exponent decides how many minor digits split off:
// zero-decimal currencies (JPY, KRW, ...) have no fractional unit, so their
// minor amount IS their major amount and must NOT be divided by 100.
export { formatMoneyGrouped as formatMoneyMinor }

export const Money: Component<{
  minor: bigint | number | string | null | undefined
  currency?: string
  emphasis?: boolean
  class?: string
  // Use the currency only to pick the right minor-unit exponent, without
  // rendering the trailing code (line rows inherit the document's currency
  // shown once on the totals block).
  codeless?: boolean
}> = (props) => (
  <span
    class={cx(
      "font-mono tabular-nums whitespace-nowrap",
      props.emphasis ? "text-text font-medium" : "text-text",
      props.class,
    )}
  >
    {formatMoneyGrouped(props.minor, props.currency)}
    <Show when={props.currency && !props.codeless}>
      <span class="ml-1 text-text-tertiary">{props.currency}</span>
    </Show>
  </span>
)

// Document lifecycle status → tone + human label. One source of truth so every
// surface (tables, detail, editor) renders status identically.
const STATUS_TONE: Record<string, BadgeTone> = {
  draft: "muted",
  pending_approval: "warning",
  issued: "accent",
  fulfilled: "success",
  sent: "neutral",
  accepted: "success",
  paid: "success",
  overdue: "warning",
  refunded: "muted",
  rejected: "error",
  expired: "muted",
  voided: "error",
  cancelled: "error",
  closed: "neutral",
  received: "neutral",
}

const humanize = (s: string): string => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())

export const StatusBadge: Component<{ status: string; testid?: string }> = (props) => (
  <Badge tone={STATUS_TONE[props.status] ?? "neutral"} dot testid={props.testid}>
    {tr(humanize(props.status))}
  </Badge>
)

const TYPE_LABEL: Record<string, string> = {
  invoice: "Invoice",
  quote: "Quote",
  proforma: "Proforma",
  purchase_order: "Purchase order",
}

// Document type — a quiet capability label, not a loud badge.
export const TypeLabel: Component<{ type: string; class?: string; testid?: string }> = (props) => (
  <span data-testid={props.testid} class={cx("text-text-secondary", props.class)}>
    {tr(TYPE_LABEL[props.type] ?? humanize(props.type))}
  </span>
)

// ── Form controls ────────────────────────────────────────────────────────────
// `[color-scheme:dark]` themes the native date/number spinners to the charcoal
// palette instead of the jarring default light widget.
export const dateInputClass = cx(inputClass, "[color-scheme:dark]")
/** A date field that sizes itself: the kit's `inputClass` carries `w-full`,
 *  which beats a caller's own width and stretches the field across its row. */
export const dateRangeInputClass = cx(
  inputClass.replace(/(^|\s)w-full(?=\s)/, " "),
  "[color-scheme:dark]",
)

const Chevron: Component<{ class?: string }> = (props) => (
  <svg
    class={cx("pointer-events-none h-3.5 w-3.5 text-text-tertiary", props.class)}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="m6 9 6 6 6-6" />
  </svg>
)

// Styled native <select> — keeps real <select> semantics (a11y + e2e locate by
// the forwarded testid) while hiding the default widget chrome behind our own
// chevron.
export const Select: Component<{
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  testid?: string
  class?: string
  children: JSX.Element
}> = (props) => (
  <div class={cx("relative", props.class)}>
    <select
      data-testid={props.testid}
      disabled={props.disabled}
      value={props.value}
      onChange={(e) => props.onChange(e.currentTarget.value)}
      class={cx(inputClass, "cursor-pointer appearance-none pr-8")}
    >
      {props.children}
    </select>
    <div class="absolute inset-y-0 right-2.5 flex items-center">
      <Chevron />
    </div>
  </div>
)

// ── ConfirmDialog ─────────────────────────────────────────────────────────────
// The shared modal with the invoicing overlay and cancel-button test ids.
export const ConfirmDialog: Component<{
  open: boolean
  title: string
  body?: string
  confirmLabel: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
  testid?: string
}> = (props) => (
  <SharedConfirmDialog
    open={props.open}
    title={props.title}
    body={props.body}
    confirmLabel={props.confirmLabel}
    danger={props.danger}
    busy={props.busy}
    onConfirm={props.onConfirm}
    onCancel={props.onCancel}
    testid={props.testid ?? "invoicing-confirm-dialog"}
    cancelTestid="confirm-dialog-cancel-btn"
  />
)
