// SPDX-License-Identifier: FSL-1.1-ALv2
import type { ApprovalRequestSummary } from "@liaison/shared"
import { factsFromSummary, holdsDecidingScope, isNotified } from "@liaison/shared"
import { createStore, produce } from "solid-js/store"
import type { ApiClient } from "~/lib/api-client"
import { isPendingSubtitle } from "~/lib/approval-summary-lines"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import {
  decideApproval as decideApi,
  getApproval as getApi,
  listDecidableByMe as listApi,
  listBundle as listBundleApi,
  updatePayload as updatePayloadApi,
} from "~/modules/approvals/approvals-service"
import type { DecisionLabel } from "~/modules/approvals/decision-queue"
import { hasScope } from "~/modules/auth/auth-store"
import type { MailboxFulfilmentBody } from "~/modules/mailbox/approval-mail-fulfilment"

// Lifecycle order — a row may only be replaced by an equal-or-later state, so a
// stale fetch (e.g. a late listBundle) can never overwrite a fresher WS update.
// `deferred` is a bundle step's start state and must rank BELOW the terminal
// statuses, otherwise a stale deferred row would clobber an approved/cancelled one.
function statusRank(status: ApprovalRequestSummary["status"]): number {
  switch (status) {
    case "deferred":
      return 0
    case "pending":
      return 1
    case "approving":
      return 2
    default:
      // approved | denied | expired | cancelled — terminal
      return 3
  }
}

interface ApprovalsState {
  byId: Record<string, ApprovalRequestSummary>
  decidableIds: string[]
  loadingByMe: boolean
  needsDecidableRefresh: boolean
  /** Ordered step ids for a bundle, keyed by the bundle's UUID. Under
   *  parallel approval bundling the bundle UUID is generally distinct from any
   *  member's approval id, so we key on bundleId rather than the "head" id. */
  bundleStepsByBundleId: Record<string, string[]>
  /**
   * The payload fingerprint of each request as this person first saw it (or last acknowledged, or
   * edited themselves). An approve is bound to THIS version, never to whatever a live update pushed
   * since: an edit made by someone else while the card is open must be noticed, not approved.
   */
  reviewedPayloadHash: Record<string, string>
}

const [approvalsStore, setApprovalsStore] = createStore<ApprovalsState>({
  byId: {},
  decidableIds: [],
  loadingByMe: false,
  needsDecidableRefresh: false,
  bundleStepsByBundleId: {},
  reviewedPayloadHash: {},
})

export { approvalsStore }

const inFlightLoadsById = new Map<string, Promise<ApprovalRequestSummary>>()
const inFlightDecideById = new Set<string>()

export function isDecideInFlight(id: string): boolean {
  return inFlightDecideById.has(id)
}

// Queue membership mirrors the server's decidable list: NOTIFIED and holding
// the row's own deciding scope (`approveScope`, via the shared authority
// module — never a scope recomputed from the tool name, which is how skill
// approvals vanished from this queue for the people holding
// kernel:skills:approve). Deliberately NOT shared-surface-widened: the queue
// is notify-routed anti-noise like the attention feed; a teammate's ticket
// draft is decidable from its card, not pushed into everyone's queue.
function isLocallyDecidable(row: ApprovalRequestSummary, currentUserId: string): boolean {
  const facts = factsFromSummary(row)
  return (
    isNotified(facts, currentUserId) &&
    holdsDecidingScope(facts, { userId: currentUserId, hasScope })
  )
}

function sortDecidable(s: ApprovalsState): void {
  s.decidableIds.sort((a, b) => {
    const ra = s.byId[a]
    const rb = s.byId[b]
    if (!ra || !rb) return 0
    return Date.parse(ra.createdAt) - Date.parse(rb.createdAt)
  })
}

function shouldReplace(
  existing: ApprovalRequestSummary | undefined,
  next: ApprovalRequestSummary,
): boolean {
  if (!existing) return true
  return statusRank(next.status) >= statusRank(existing.status)
}

function mergeRow(s: ApprovalsState, row: ApprovalRequestSummary): boolean {
  const existing = s.byId[row.id]
  if (!shouldReplace(existing, row)) return false
  if (row.payloadHash && !s.reviewedPayloadHash[row.id]) {
    s.reviewedPayloadHash[row.id] = row.payloadHash
  }
  // Bundle linkage is monotonic: a standalone approval is promoted to a bundle
  // head exactly once (resolveBundleForRefs) and never de-promoted. A delayed
  // or buffered WS `create` carries the pre-promotion snapshot (bundleId:null)
  // with the SAME `pending` status, so `shouldReplace` admits it — without this
  // guard it would regress an already-promoted head back to a non-bundle row
  // and the stacked steps would vanish from the card.
  if (existing?.bundleId && !row.bundleId) {
    s.byId[row.id] = {
      ...row,
      bundleId: existing.bundleId,
      bundlePosition: existing.bundlePosition,
    }
    return true
  }
  s.byId[row.id] = row
  return true
}

export function decidableByMe(): ApprovalRequestSummary[] {
  return approvalsStore.decidableIds
    .map((id) => approvalsStore.byId[id])
    .filter((r): r is ApprovalRequestSummary => Boolean(r) && r.status === "pending")
}

export function hasPendingDecisions(): boolean {
  return decidableByMe().length > 0
}

export function getById(id: string): ApprovalRequestSummary | undefined {
  return approvalsStore.byId[id]
}

export async function loadDecidableByMe(api: ApiClient): Promise<void> {
  setApprovalsStore("loadingByMe", true)
  try {
    const rows = await listApi(api)
    setApprovalsStore(
      produce((s) => {
        const fetchedIds = new Set<string>()
        for (const row of rows) {
          mergeRow(s, row)
          if (row.status === "pending") fetchedIds.add(row.id)
        }
        // Merge with existing decidable ids so WS-added rows that arrived
        // between the fetch start and response are not silently dropped.
        const merged = new Set<string>([
          ...s.decidableIds.filter((id) => s.byId[id]?.status === "pending"),
          ...fetchedIds,
        ])
        s.decidableIds = [...merged]
        sortDecidable(s)
        s.needsDecidableRefresh = false
      }),
    )
  } finally {
    setApprovalsStore("loadingByMe", false)
  }
}

const inFlightBundleLoads = new Map<string, Promise<void>>()

export async function ensureLoaded(api: ApiClient, id: string): Promise<ApprovalRequestSummary> {
  const existing = approvalsStore.byId[id]
  if (existing) {
    void ensureBundleLoaded(api, existing)
    return existing
  }
  const inFlight = inFlightLoadsById.get(id)
  if (inFlight) return inFlight
  const promise = (async () => {
    try {
      const row = await getApi(api, id)
      setApprovalsStore(produce((s) => mergeRow(s, row)))
      void ensureBundleLoaded(api, row)
      return row
    } finally {
      inFlightLoadsById.delete(id)
    }
  })()
  inFlightLoadsById.set(id, promise)
  return promise
}

/**
 * Re-read one request from the server and merge it. A card opened later than the store first
 * loaded the row (Home at sign-in, then the ticket an hour on) may hold a version the live update
 * never replaced: a phone drops its socket in the background. Deduped with `ensureLoaded`.
 */
export async function refreshRow(
  api: ApiClient,
  id: string,
  opts?: { acknowledge?: boolean },
): Promise<ApprovalRequestSummary> {
  const inFlight = inFlightLoadsById.get(id)
  if (inFlight) return inFlight
  const promise = (async () => {
    try {
      const row = await getApi(api, id)
      if (!row?.id) return approvalsStore.byId[id] ?? row
      // `acknowledge`: the card shows this version as it lands, so the person reviews it here.
      // One store write, so the card never flashes "changed" between the two.
      setApprovalsStore(
        produce((s) => {
          mergeRow(s, row)
          const now = s.byId[id]?.payloadHash
          if (opts?.acknowledge && now) s.reviewedPayloadHash[id] = now
        }),
      )
      return row
    } finally {
      inFlightLoadsById.delete(id)
    }
  })()
  inFlightLoadsById.set(id, promise)
  return promise
}

/** When `row` is the bundle's first member (position 0), fetch and merge every
 *  sibling step and record the ordered ids under `bundleStepsByBundleId`. The
 *  index key is the bundle UUID — under parallel approval bundling it is
 *  generally distinct from any member's approval id, so we no longer require
 *  `bundleId === id`. */
export async function ensureBundleLoaded(
  api: ApiClient,
  row: ApprovalRequestSummary,
): Promise<void> {
  if (!row.bundleId || row.bundlePosition !== 0) return
  if (approvalsStore.bundleStepsByBundleId[row.bundleId]) return
  const bundleId = row.bundleId
  const inFlight = inFlightBundleLoads.get(bundleId)
  if (inFlight) return inFlight
  const promise = (async () => {
    try {
      const steps = await listBundleApi(api, bundleId)
      setApprovalsStore(
        produce((s) => {
          for (const step of steps) mergeRow(s, step)
          s.bundleStepsByBundleId[bundleId] = steps
            .slice()
            .sort((a, b) => (a.bundlePosition ?? 0) - (b.bundlePosition ?? 0))
            .map((step) => step.id)
        }),
      )
    } finally {
      inFlightBundleLoads.delete(bundleId)
    }
  })()
  inFlightBundleLoads.set(bundleId, promise)
  return promise
}

/** Ordered bundle step rows for a bundle id. Returns the indexed list when
 *  available, otherwise scans `byId` for any rows whose `bundleId` matches.
 *  Falling back to `byId` is what lets pure WS deliveries (e.g. step bundles
 *  the agent emits mid-conversation, never served by `listBundle`) render
 *  without requiring a full fetch first. */
export function getBundleSteps(bundleId: string): ApprovalRequestSummary[] {
  const ids = approvalsStore.bundleStepsByBundleId[bundleId]
  if (ids && ids.length > 0) {
    return ids
      .map((id) => approvalsStore.byId[id])
      .filter((r): r is ApprovalRequestSummary => Boolean(r))
  }
  const fallback: ApprovalRequestSummary[] = []
  for (const row of Object.values(approvalsStore.byId)) {
    if (row.bundleId === bundleId) fallback.push(row)
  }
  fallback.sort((a, b) => (a.bundlePosition ?? 0) - (b.bundlePosition ?? 0))
  return fallback
}

/** The version of a request this person reviewed: what an approve is bound to. */
export function reviewedPayloadHash(id: string): string | undefined {
  return approvalsStore.reviewedPayloadHash[id] ?? approvalsStore.byId[id]?.payloadHash
}

/** Record the version a surface outside the store (the attention feed) showed, if none yet. */
export function notePayloadSeen(id: string, payloadHash: string | undefined): void {
  if (!payloadHash || approvalsStore.reviewedPayloadHash[id]) return
  setApprovalsStore("reviewedPayloadHash", id, payloadHash)
}

/** Whether a request changed (by someone else) after this person first saw it. */
export function payloadChangedSinceReview(id: string): boolean {
  const seen = approvalsStore.reviewedPayloadHash[id]
  const now = approvalsStore.byId[id]?.payloadHash
  return Boolean(seen && now && seen !== now)
}

/**
 * The person looked at the current version of these requests: approves now bind to it. A card
 * calls this for the version it first shows, so "changed since you saw it" means changed while
 * the card was open, never since the row was first loaded somewhere else in the app.
 */
export function acknowledgePayloadChanges(ids: string[]): void {
  setApprovalsStore(
    produce((s) => {
      for (const id of ids) {
        const now = s.byId[id]?.payloadHash
        if (now) s.reviewedPayloadHash[id] = now
      }
    }),
  )
}

/** The later steps a bundle head's approve will run, with the version of each the person saw. */
function stepHashesFor(headId: string): Record<string, string> | undefined {
  const bundleId = approvalsStore.byId[headId]?.bundleId
  if (!bundleId) return undefined
  const out: Record<string, string> = {}
  for (const step of getBundleSteps(bundleId)) {
    if (step.id === headId || step.status !== "deferred") continue
    const hash = reviewedPayloadHash(step.id)
    if (hash) out[step.id] = hash
  }
  return out
}

/**
 * What a decision's toast names: the approval's title, and its subtitle unless
 * that speaks of the pending state it was written in ("Pending approval, nothing
 * is shipped or bought yet" under "Approved"); its handle then.
 */
export function decisionLabel(row: {
  summary: { title: string; subtitle?: string | null }
  handle?: string | null
}): DecisionLabel {
  const subtitle = row.summary.subtitle
  return {
    title: row.summary.title,
    detail: subtitle && !isPendingSubtitle(subtitle) ? subtitle : (row.handle ?? null),
  }
}

export async function decide(
  api: ApiClient,
  id: string,
  decision: "approve" | "deny",
  // `mailboxFulfilment` (blueprint Task 9.8 and 9.9): plaintext the mailbox
  // owner's browser decrypted so a gated send from an encrypted mailbox can
  // execute. It rides the decision and is never stored anywhere.
  opts?: {
    reason?: string
    mailboxFulfilment?: MailboxFulfilmentBody
    payloadHash?: string
    /** "Send now" on a held mail draft (approvals-service.ts `DecideBody`). */
    sendGuardOverride?: "auto_reply"
    /** What the decision toast names, when the surface knows better than the
     *  row alone (a sequence's outcome and its steps). */
    label?: DecisionLabel | null
  },
) {
  inFlightDecideById.add(id)
  try {
    if (decision === "approve") await settlePendingSaves(id)
    // An approve is bound to the payload the person SAW: the fingerprint of the row this card
    // renders (kept current by the live updates), or the one the caller was handed. Never one
    // fetched at click time, which would bind the decision to whatever the payload is NOW. With
    // none, the server refuses the approve and the card reloads.
    // A live update that changed the payload since the person saw it does NOT move this: the
    // server then refuses the stale version (409) until the person acknowledges the change.
    const payloadHash =
      decision === "approve" ? (opts?.payloadHash ?? reviewedPayloadHash(id)) : undefined
    const stepPayloadHashes = decision === "approve" ? stepHashesFor(id) : undefined
    // The decision toast names what is decided: the surface's label (a
    // sequence's outcome and steps), else the approval's own title.
    const row = approvalsStore.byId[id]
    const label = opts?.label ?? (row ? decisionLabel(row) : null)
    const result =
      decision === "approve"
        ? await decideApi(
            api,
            id,
            {
              decision: "approve",
              ...(opts?.mailboxFulfilment ? { mailboxFulfilment: opts.mailboxFulfilment } : {}),
              ...(payloadHash ? { payloadHash } : {}),
              ...(opts?.sendGuardOverride ? { sendGuardOverride: opts.sendGuardOverride } : {}),
              ...(stepPayloadHashes && Object.keys(stepPayloadHashes).length > 0
                ? { stepPayloadHashes }
                : {}),
            },
            label,
          )
        : await decideApi(api, id, { decision: "deny", reason: opts?.reason ?? "" }, label)
    // Apply the decision to the local store immediately on success. Without
    // this, the deciding user's own card has to wait for the WS broadcast to
    // round-trip — and under heavy parallel-test load that exceeded 15s for
    // the approver in `approval-cross-thread.scenario.test.ts`, manifesting
    // as a "flaky" test that was really an actual UX defect (slow visual
    // feedback on the user's own click). The WS handler that follows is
    // idempotent via `mergeRow` + `shouldReplace`, so the eventual broadcast
    // is a no-op (or a fill-in for any field the response didn't include).
    // BEST-EFFORT: the decision is already committed server-side, so a local
    // echo failure must never make decide() throw — the caller's catch would
    // treat a SUCCESSFUL decide as failed and unlock the Approve/Deny buttons
    // on an already-decided request (re-clickable card until the WS lands).
    try {
      applyLocalDecision(id, result)
    } catch (err) {
      console.error(
        "approvals: local decision echo failed (decision is committed server-side)",
        err,
      )
    }
    return result
  } finally {
    inFlightDecideById.delete(id)
  }
}

function applyLocalDecision(
  id: string,
  result: { status: "approved" | "denied"; decidedBy: string; decidedAt: string; reason?: string },
): void {
  setApprovalsStore(
    produce((s) => {
      const existing = s.byId[id]
      if (!existing) return
      // Mutate in place via produce — merges the decision fields onto the
      // existing pending row. Status monotonically advances (pending →
      // approved/denied), so a later WS update with the same status is a
      // no-op via the shouldReplace rank check.
      existing.status = result.status
      existing.decidedBy = result.decidedBy
      existing.decidedAt = result.decidedAt
      if (result.reason !== undefined) existing.reason = result.reason
      const idx = s.decidableIds.indexOf(id)
      if (idx !== -1) s.decidableIds.splice(idx, 1)
    }),
  )
}

/**
 * Edits still on their way to the server, by request id. An approve waits for
 * them: a person who saves a step's edit and presses Approve right away means
 * "approve what I just wrote", but the approve used to leave first, bound to
 * the version before the edit, and the server refused it (409
 * payload_changed: "a step of this request was edited after you opened it").
 */
const pendingSaves = new Map<string, Promise<unknown>>()

export async function updatePayloadAction(
  api: ApiClient,
  id: string,
  fields: Record<string, unknown>,
) {
  // The version this save edits. The live update carrying the edit can land
  // before or after the response; only one that has not landed yet is echoed.
  const editedFrom = approvalsStore.byId[id]?.payloadHash
  const save = updatePayloadApi(api, id, fields)
  pendingSaves.set(id, save)
  try {
    const result = await save
    setApprovalsStore(
      produce((s) => {
        if (!result.payloadHash) return
        // The person wrote this version: it is the one they reviewed.
        s.reviewedPayloadHash[id] = result.payloadHash
        // And the card shows it now, not when the live update arrives. Until
        // then the store held the old payload under the new reviewed version:
        // the card read "changed since you opened it" about the person's own
        // edit and refused their Approve. A row a live update already moved on
        // (this edit, or a later one by someone else) is left as it is.
        const row = s.byId[id]
        if (!row || !editedFrom || row.payloadHash !== editedFrom) return
        row.currentPayload = result.currentPayload
        row.payloadHash = result.payloadHash
        if (result.lastEdit !== undefined) row.lastEdit = result.lastEdit
      }),
    )
    return result
  } finally {
    if (pendingSaves.get(id) === save) pendingSaves.delete(id)
  }
}

/** Wait for the person's own edits to this request and its bundle to land. */
async function settlePendingSaves(id: string): Promise<void> {
  const bundleId = approvalsStore.byId[id]?.bundleId
  const ids = new Set([id, ...(bundleId ? getBundleSteps(bundleId).map((s) => s.id) : [])])
  const waits = [...ids].map((k) => pendingSaves.get(k)).filter(Boolean) as Promise<unknown>[]
  // A failed save already told the person (a toast); the approve then binds
  // to the version they saw, and the server judges it.
  await Promise.allSettled(waits)
}

export function handleWsCreate(row: ApprovalRequestSummary, currentUserId: string): void {
  if (!row || typeof row !== "object" || !row.id) return
  setApprovalsStore(
    produce((s) => {
      const replaced = mergeRow(s, row)
      if (!replaced) return
      // A bundle member arrives via WS. If the bundle's index exists (either
      // populated by `ensureBundleLoaded` after a fetch, or seeded on a prior
      // WS create) we append this row to it. Position-sort keeps the list
      // consistent under out-of-order delivery.
      if (row.bundleId) {
        const stepIds = s.bundleStepsByBundleId[row.bundleId]
        if (stepIds && !stepIds.includes(row.id)) {
          stepIds.push(row.id)
          stepIds.sort(
            (a, b) => (s.byId[a]?.bundlePosition ?? 0) - (s.byId[b]?.bundlePosition ?? 0),
          )
        }
      }
      if (!Array.isArray(row.notifyUserIds)) {
        s.needsDecidableRefresh = true
        return
      }
      const decidable = isLocallyDecidable(row, currentUserId) && row.status === "pending"
      const idx = s.decidableIds.indexOf(row.id)
      if (decidable && idx === -1) {
        s.decidableIds.push(row.id)
        sortDecidable(s)
      } else if (!decidable && idx !== -1) {
        s.decidableIds.splice(idx, 1)
      }
    }),
  )
}

export function handleWsUpdate(row: ApprovalRequestSummary): void {
  if (!row?.id) return
  setApprovalsStore(
    produce((s) => {
      const replaced = mergeRow(s, row)
      if (!replaced) return
      const idx = s.decidableIds.indexOf(row.id)
      if (row.status !== "pending" && idx !== -1) {
        s.decidableIds.splice(idx, 1)
      }
    }),
  )
}

const inFlightTicketRefreshIds = new Set<string>()

/**
 * A TICKET CHANGED: re-read the pending approvals that act on it (QA APR-02).
 * A ticket approval's `summary.ref` is served live (the ticket's CURRENT
 * display handle), so a reclassify changes it without touching the approval
 * row, and no approval event fires. The Home row follows because every ticket
 * event reloads the attention feed; a card already open on /approvals kept the
 * old ref until a reload. `keys` are the ids the ticket event names (its uuid,
 * its handle): matched against the approval payload's `ticketId`.
 */
export function refreshTicketApprovals(
  api: ApiClient,
  keys: Array<string | null | undefined>,
): void {
  const wanted = new Set(keys.filter((k): k is string => typeof k === "string" && k.length > 0))
  if (wanted.size === 0) return
  const ids = Object.values(approvalsStore.byId)
    .filter(
      (row) =>
        row.status === "pending" &&
        row.toolName.startsWith("tickets:") &&
        typeof row.currentPayload?.ticketId === "string" &&
        wanted.has(row.currentPayload.ticketId as string),
    )
    .map((row) => row.id)
  for (const id of ids) {
    if (inFlightTicketRefreshIds.has(id)) continue
    inFlightTicketRefreshIds.add(id)
    void getApi(api, id)
      .then((row) => {
        if (row?.id) setApprovalsStore(produce((s) => mergeRow(s, row)))
      })
      .catch(() => {
        // Best effort: the next list load or reload serves the live ref.
      })
      .finally(() => inFlightTicketRefreshIds.delete(id))
  }
}

export function resetApprovalsStore(): void {
  setApprovalsStore({
    byId: {},
    decidableIds: [],
    loadingByMe: false,
    needsDecidableRefresh: false,
    bundleStepsByBundleId: {},
    reviewedPayloadHash: {},
  })
  inFlightLoadsById.clear()
  inFlightDecideById.clear()
  inFlightBundleLoads.clear()
  inFlightTicketRefreshIds.clear()
}

onSessionTeardown(resetApprovalsStore)
