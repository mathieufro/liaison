// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Per-action faceting for the approval rows in the attention feed.
//
// Approvals are NOW items, so they render as individual rows at the top of Home
// rather than inside a collapsible group. That is right when three are pending
// and useless when thirty are: an operator who wants to clear every
// "Tickets: reply" in one pass has to eyeball a mixed list and pick them out by
// their action chip. These helpers build the facet set from what is actually
// pending -- never a hardcoded list of apps or tools, so a newly installed app's
// gated tools face up on their own -- and narrow the list to one action.
//
// Keyed on `metadata.toolName` (the real gated tool id, e.g. "tickets:reply"),
// NOT on the humanized label: two tools can humanize to the same words, and the
// id is the thing the operator is really selecting.

import type { AttentionItem } from "@liaison/shared"

/** One selectable action, with how many approvals are pending for it. */
export interface ApprovalFacet {
  /** The gated tool id, e.g. "tickets:reply". The filter value. */
  key: string
  /** Humanized action, e.g. "Tickets: reply". Falls back to the raw id. */
  label: string
  /** A kind facet's catalog label (access requests, routine runs): rendered
   *  through i18n instead of `label`. */
  labelKey?: string
  /** Named by the rows' pill: `label` is shown as it is. */
  pill?: true
  count: number
}

/**
 * A row of the person's approvals list: everything that waits on the person's
 * decision, in one list (Home's Approvals card, the phone Approvals screen, the
 * badge). Three kinds share it:
 *   - an approval of an agent's gated action (Approve / Reject);
 *   - an access request, an agent or a person asking for a scope (Grant / Deny,
 *     AccessRequestRow), which only holders of `kernel:scope_requests:admin`
 *     receive;
 *   - a run of the person's own routine waiting for their private mailbox (Run
 *     now / Dismiss, RoutineMailboxWaitRow), which only its owner receives.
 */
export function isApprovalItem(item: AttentionItem): boolean {
  return (
    item.action?.type === "decide_approval" ||
    item.kind === "routine_mailbox_wait" ||
    item.kind === "scope_request"
  )
}

/** The facet every access request files under (no tool to facet on). */
export const ACCESS_REQUESTS_FACET = "kernel:access_requests"
/** The facet every routine run waiting for a private mailbox files under. */
export const ROUTINE_RUNS_FACET = "kernel:routine_runs"

/** The catalog key of a kind facet's label, null for a tool facet. */
export function kindFacetLabelKey(key: string): string | null {
  if (key === ACCESS_REQUESTS_FACET) return "kernel.approvalKinds.accessRequests"
  if (key === ROUTINE_RUNS_FACET) return "kernel.approvalKinds.routineRuns"
  return null
}

/**
 * The facet an approvals-list row files under: the gated tool id behind an
 * approval, a kind facet for an access request or a waiting routine run, or
 * null when the item is not in the list (or an approval predates the metadata,
 * as a stale cached feed can).
 */
export function approvalActionKey(item: AttentionItem): string | null {
  if (!isApprovalItem(item)) return null
  if (item.kind === "scope_request") return ACCESS_REQUESTS_FACET
  if (item.kind === "routine_mailbox_wait") return ROUTINE_RUNS_FACET
  const tool = item.metadata?.toolName
  if (typeof tool !== "string" || tool === "") return null
  // A row the server names with a pill ("Billing: payment reminder" on a mail draft) files under
  // that name, so the count sits beside the name the row shows.
  const pill = approvalRowPill(item)
  return pill ? `${tool}${PILL_FACET_SEPARATOR}${pill.label}` : tool
}

/** Between a tool id and a pill's label in a pill facet's key. */
export const PILL_FACET_SEPARATOR = "|pill:"

/** The pill the server put on an approval row (attention.ts), when it has one. */
export function approvalRowPill(item: AttentionItem): { label: string; labelKey?: string } | null {
  const pill = item.metadata?.pill as { label?: unknown; labelKey?: unknown } | undefined
  if (!pill || typeof pill.label !== "string" || pill.label === "") return null
  return typeof pill.labelKey === "string" && pill.labelKey !== ""
    ? { label: pill.label, labelKey: pill.labelKey }
    : { label: pill.label }
}

function approvalActionLabel(item: AttentionItem): string | null {
  const label = item.metadata?.actionLabel
  return typeof label === "string" && label !== "" ? label : null
}

/**
 * True when the row is for someone else, a decision the viewer can also take
 * ("For others, you can also approve"): the server's `metadata.placement` is
 * `others`. Such a row is neither counted nor pushed for the viewer; it sits in
 * Home's closed group with its count. A feed that predates `placement` reads
 * every row as the viewer's own, so a stale feed hides nothing it should show.
 */
export function isOthersItem(item: AttentionItem): boolean {
  if (!isApprovalItem(item)) return false
  return item.metadata?.placement === "others"
}

/**
 * Split the approvals into the viewer's own and the rows for others. Both
 * halves come back so Home can show the second as a closed group with its
 * count rather than hiding it.
 */
export function partitionOthersRows(items: AttentionItem[]): {
  mine: AttentionItem[]
  others: AttentionItem[]
} {
  const mine: AttentionItem[] = []
  const others: AttentionItem[] = []
  for (const item of items) {
    if (isOthersItem(item)) others.push(item)
    else mine.push(item)
  }
  return { mine, others }
}

/**
 * Build the facet set from the pending approvals themselves. Ordered by count
 * descending, then label, so the biggest pile to clear is the first chip. An
 * approval with no `toolName` contributes no facet (it stays visible under
 * "All" and is simply not selectable) rather than inventing an "Unknown" bucket.
 */
export function approvalActionFacets(items: AttentionItem[]): ApprovalFacet[] {
  const byKey = new Map<string, ApprovalFacet>()
  for (const item of items) {
    const key = approvalActionKey(item)
    if (!key) continue
    const existing = byKey.get(key)
    if (existing) {
      existing.count += 1
      continue
    }
    const labelKey = kindFacetLabelKey(key)
    const pill = approvalRowPill(item)
    byKey.set(key, {
      key,
      label: labelKey ? key : (pill?.label ?? approvalActionLabel(item) ?? key),
      ...(labelKey ? { labelKey } : pill?.labelKey ? { labelKey: pill.labelKey } : {}),
      ...(pill ? { pill: true } : {}),
      count: 1,
    })
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

/**
 * Narrow a feed list to one approval action.
 *
 * Scoped deliberately: ONLY approval rows are filtered. A pending scope request
 * or an SLA fire sharing the NOW list is a different kind of demand on the
 * operator and must not vanish because they focused the approval queue -- that
 * would be a filter that silently hides unrelated urgent work.
 *
 * `null` (no selection) returns the list untouched.
 */
export function filterApprovalsByAction(
  items: AttentionItem[],
  actionKey: string | null,
): AttentionItem[] {
  if (!actionKey) return items
  return items.filter((item) => !isApprovalItem(item) || approvalActionKey(item) === actionKey)
}

/**
 * The facet bar is worth showing only when it can actually sort something out:
 * at least two distinct actions pending. One action needs no picker, and zero
 * approvals needs no bar at all.
 */
export function shouldShowApprovalFacets(facets: ApprovalFacet[]): boolean {
  return facets.length >= 2
}

/**
 * Keep a selection across refreshes, INCLUDING once its last approval is
 * decided.
 *
 * This used to drop back to "All" the moment the selected facet emptied. The
 * intent was to avoid a filter pointing at nothing, but the effect was worse:
 * an operator clearing a pile approves the last one and the view silently
 * widens to the whole queue, right under a cursor already moving to the next
 * Approve button — so the next click lands on an unrelated request. Clearing a
 * queue must not itself be the thing that changes what is on screen
 * (ticket-10225). The selection now sticks, `facetsWithSelection` keeps its
 * chip visible at 0, and leaving the filter stays a deliberate click.
 */
export function reconcileSelection(
  selected: string | null,
  _facets: ApprovalFacet[],
): string | null {
  return selected ?? null
}

/**
 * The chips to render: the live facets, plus a zero-count chip for a selection
 * whose approvals are all gone — without it the operator would be inside a
 * filter with no chip showing it, and no obvious way back to "All".
 */
export function facetsWithSelection(
  facets: ApprovalFacet[],
  selected: string | null,
): ApprovalFacet[] {
  if (!selected || facets.some((f) => f.key === selected)) return facets
  const labelKey = kindFacetLabelKey(selected)
  return [
    ...facets,
    { key: selected, label: selected, ...(labelKey ? { labelKey } : {}), count: 0 },
  ]
}

/**
 * Split the feed under an active facet into the rows the facet SELECTED and the
 * rows that are shown ANYWAY.
 *
 * `filterApprovalsByAction` deliberately keeps non-approval rows (a scope
 * request, an SLA fire) visible under every facet: they are unrelated urgent
 * work and a filter must not silently bury them. Correct, but it reads as a
 * broken filter — an operator who picked "Boxtal: create shipment" sees an
 * "SLA approaching for ticket-10191" row sitting in the results and reports the
 * filter as leaking (ticket-10195). The rows are the same; what was missing was
 * saying WHY they are there. Home renders the second list under its own
 * heading.
 */
export function partitionByAction(
  items: AttentionItem[],
  actionKey: string | null,
): { matched: AttentionItem[]; alsoShown: AttentionItem[] } {
  if (!actionKey) return { matched: items, alsoShown: [] }
  const matched: AttentionItem[] = []
  const alsoShown: AttentionItem[] = []
  for (const item of items) {
    // Approvals are what the facet actually narrows: a non-matching one (or one
    // with no toolName to match on) is hidden, exactly as before. Everything
    // that is NOT an approval survives the filter and is labelled instead.
    if (isApprovalItem(item)) {
      if (approvalActionKey(item) === actionKey) matched.push(item)
    } else {
      alsoShown.push(item)
    }
  }
  return { matched, alsoShown }
}
