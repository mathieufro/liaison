// SPDX-License-Identifier: FSL-1.1-ALv2
import type { ApprovalRequestSummary } from "@liaison/shared"
import type { ApiClient } from "~/lib/api-client"
import { type DecisionLabel, queueDecision } from "~/modules/approvals/decision-queue"
import type { MailboxFulfilmentBody } from "~/modules/mailbox/approval-mail-fulfilment"

export async function listDecidableByMe(api: ApiClient): Promise<ApprovalRequestSummary[]> {
  return (
    (await api.get<ApprovalRequestSummary[]>("/approvals?status=pending&decidableByMe=true")) ?? []
  )
}

export async function getApproval(api: ApiClient, id: string): Promise<ApprovalRequestSummary> {
  return await api.get<ApprovalRequestSummary>(`/approvals/${id}`)
}

/** Fetch every step of a bundle, ordered by bundle position. */
export async function listBundle(
  api: ApiClient,
  bundleId: string,
): Promise<ApprovalRequestSummary[]> {
  return (await api.get<ApprovalRequestSummary[]>(`/approvals?bundleId=${bundleId}`)) ?? []
}

export type DecideBody =
  | {
      decision: "approve"
      /**
       * Blueprint Task 9.8 and 9.9. For a gated mail send from an end-to-end
       * encrypted personal mailbox, the drafted body and subject are stored as
       * CIPHERTEXT, so the send cannot execute unless the mailbox owner's own
       * browser supplies the plaintext here, as part of approving.
       *
       * It travels with the decision and nowhere else. The server merges it in
       * memory just before the handler runs and stores none of it, which is why
       * this is not an `approval_update_payload` edit: that writes cleartext into
       * `current_payload` and into a message diff, permanently.
       */
      mailboxFulfilment?: MailboxFulfilmentBody
      /**
       * Fingerprint of the payload the person reviewed (`ApprovalRequestSummary.payloadHash`).
       * The server refuses the approve (409 `payload_changed`) if the request was edited since.
       */
      payloadHash?: string
      /** For a bundle: the fingerprint of every later step the person saw, by step id. */
      stepPayloadHashes?: Record<string, string>
      /**
       * "Send now" on a mail draft held by an automatic reply. The server judges the hold again
       * under its lock and refuses (422 `send_guard_not_held`) when the draft is no longer held.
       */
      sendGuardOverride?: "auto_reply"
    }
  | { decision: "deny"; reason: string }

export interface DecideResult {
  id: string
  status: "approved" | "denied"
  decidedBy: string
  decidedAt: string
  reason?: string
}

export async function decideApproval(
  api: ApiClient,
  id: string,
  body: DecideBody,
  label?: DecisionLabel | null,
): Promise<DecideResult> {
  // Behind the Undo window: resolves once sent (decision-queue.ts). The label
  // names the approval in the decision toast.
  return await queueDecision<DecideResult>(api, "approval", id, body, { label })
}

export interface UpdatePayloadResult {
  id: string
  currentPayload: Record<string, unknown>
  /** Fingerprint of the payload as it now stands (the editor's own version). */
  payloadHash?: string
  lastEdit: ApprovalRequestSummary["lastEdit"]
}

export async function updatePayload(
  api: ApiClient,
  id: string,
  fields: Record<string, unknown>,
): Promise<UpdatePayloadResult> {
  return await api.post<UpdatePayloadResult>(`/approvals/${id}/payload`, { fields })
}
