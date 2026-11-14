// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The record of a commercial send, written once the provider accepted the mail: who approved
// it, a hash of the text that left (footer included), the basis it went under, its class and
// the opt-out check it passed. When the recipient was owed the notice of where their address
// came from, the footer carried it, and their contact records it now. A send that failed
// writes nothing, so the notice stays owed and the next mail carries it.

import { createHash } from "node:crypto"
import { withPrivilegedDb } from "~/db/privileged"
import { rootLogger } from "~/lib/logger"
import { writeAuditLog } from "~/modules/audit/service"
import { art14NoticeDue, markArt14NoticeSent } from "~/modules/mail/commercial-footer"
import { hashEmail, lawfulBasisFacts } from "~/modules/mail/suppressions"

export interface CommercialSend {
  orgId: string
  actorId: string
  actorType: "user" | "agent"
  toolName: string
  /** The one outside recipient the opt-out link was minted for. */
  recipient: string
  /** The bodies as they left, footer included. */
  textBody: unknown
  htmlBody: unknown
  mode: string | null
  approvedBy: "person" | "approver" | "policy"
  approverId: string | null
  approvalRequestId?: string
}

const sha = (v: unknown) =>
  typeof v === "string" ? createHash("sha256").update(v).digest("hex") : null

/** Writes the record and marks the notice in one transaction. Throws when either write fails. */
export async function recordCommercialSend(send: CommercialSend): Promise<{ notice: boolean }> {
  const { orgId } = send
  return withPrivilegedDb(orgId, "mail-commercial-send-record", async (tx) => {
    const facts = (await lawfulBasisFacts(orgId, [send.recipient], tx)).recipients[0]
    const due = await art14NoticeDue(orgId, send.recipient, tx)
    await writeAuditLog(
      tx,
      {
        orgId,
        actorId: send.actorId,
        actorType: send.actorType,
        app: "mail",
        entityType: "contact",
        ...(facts?.contactIds[0] ? { entityId: facts.contactIds[0] } : {}),
        action: "mail.commercial_send",
        metadata: {
          toolName: send.toolName,
          approvedBy: send.approvedBy,
          approverId: send.approverId,
          ...(send.approvalRequestId ? { approvalRequestId: send.approvalRequestId } : {}),
          recipientHash: hashEmail(orgId, send.recipient),
          contactIds: facts?.contactIds ?? [],
          textSha256: sha(send.textBody),
          htmlSha256: sha(send.htmlBody),
          lawfulBasis: facts?.basis ?? null,
          classification: "marketing",
          mode: send.mode,
          suppressionCheck: "not_opted_out",
          art14Notice: due !== null,
        },
      },
      { required: true },
    )
    if (due) await markArt14NoticeSent(orgId, send.recipient, tx)
    return { notice: due !== null }
  })
}

/**
 * After the mail left: the record, or a logged error when it cannot be written (the mail is
 * already gone, so nothing is refused). Answers whether it was written.
 */
export async function recordCommercialSendAfterSend(send: CommercialSend): Promise<boolean> {
  try {
    await recordCommercialSend(send)
    return true
  } catch (err) {
    rootLogger.error(
      { err, orgId: send.orgId, toolName: send.toolName },
      "commercial send record failed after the mail left; the send is not in the audit log",
    )
    return false
  }
}
