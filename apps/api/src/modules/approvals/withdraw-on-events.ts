// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WAITING DRAFTS THAT AN EVENT MADE POINTLESS ARE WITHDRAWN AT ONCE.
//
// When an address opts out (`mail/suppression:added`), the waiting commercial drafts to it
// (`mail:compose` and `mail:reply` whose pinned send check says `marketing` and lists that
// address) are cancelled with the reason, so Home stops offering them. This is a courtesy, not
// the guarantee: the send check reads the opt-out list at send and the card reads it at render,
// so a draft this misses (a lost event, a draft staged with no check) still cannot go.
// `addSuppression` withdraws in the request that records the opt-out; the subscriber below does
// the same for an opt-out recorded anywhere else, and finds nothing left when both ran.
//
// When a record that has a say over mail about it closes (`<app>/<entity>:closed` for a kind an
// app declares in `sendGuardProviders`, such as `projects/deal:closed`), the waiting
// `mail:compose` and `mail:reply` whose pinned send check names that record are cancelled the
// same way. The guarantee there too is the check at send: the record's own provider stops a mail
// about a closed record.

import { createHash } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type PrivilegedDb, type RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import type { AppEvent } from "~/infra/events/event-bus"
import { appsLogger as log } from "~/lib/logger"
import { enqueueRoutineDecisionTurn } from "~/modules/approvals/approval-result-turn"
import { loadApprovalSummary } from "~/modules/approvals/event-data"
import { appBridgeManifestRegistry } from "~/modules/apps/app-registries"

const K = drizzleSql.raw(schemaRef("kernel"))

/** What a draft withdrawn for an opt-out reads, on its card and to the agent that asked. */
export const OPTED_OUT_REASON =
  "Cancelled: a recipient opted out of commercial mail, so this draft cannot be sent"

/** What a draft withdrawn because the record it follows up on closed reads: "the deal ...". */
export function closedRecordReason(entity: string): string {
  return `Cancelled: the ${entity.replace(/_/g, " ")} it follows up on was closed, so this draft cannot be sent`
}

/** Who caused the withdrawal: the person or system that recorded the opt-out. */
export interface WithdrawActor {
  actorId: string | null
  actorType: "user" | "agent" | "system"
}

function hashOf(orgId: string, email: string): string {
  return createHash("sha256").update(`${orgId}:${email.trim().toLowerCase()}`).digest("hex")
}

/**
 * Cancel the pending commercial drafts of `orgId` addressed to the address whose fingerprint is
 * `emailHash`. A service message (an invoice, an order) is left alone. Returns the cancelled ids.
 */
export async function withdrawCommercialDraftsTo(
  orgId: string,
  emailHash: string,
  actor: WithdrawActor,
): Promise<string[]> {
  const cancelled = await withPrivilegedDb(orgId, "approvals-withdraw-opted-out", (tx) =>
    withdrawCommercialDraftsOn(tx, orgId, emailHash, actor),
  )
  await continueRoutinesAfterWithdrawal(orgId, cancelled)
  return cancelled
}

/** A routine run waiting on one of these carries on with the cancellation. After the commit. */
export async function continueRoutinesAfterWithdrawal(
  orgId: string,
  cancelled: readonly string[],
): Promise<void> {
  for (const id of cancelled) await enqueueRoutineDecisionTurn(orgId, id)
}

/**
 * The withdrawal on the caller's privileged transaction (or an RLS one stepped into the admin
 * role), so it commits or rolls back with the
 * opt-out that caused it. The caller runs `continueRoutinesAfterWithdrawal` once it committed.
 */
export async function withdrawCommercialDraftsOn(
  tx: PrivilegedDb | RlsClient,
  orgId: string,
  emailHash: string,
  actor: WithdrawActor,
): Promise<string[]> {
  {
    const candidates = extractRows<{ id: string; addresses: unknown }>(
      await tx.execute(drizzleSql`
        SELECT id::text AS id, current_payload->'sendGuard'->'addresses' AS addresses
          FROM ${K}.approval_requests
         WHERE org_id = ${orgId}::uuid AND status = 'pending'
           AND tool_name IN ('mail:compose', 'mail:reply')
           AND current_payload->'sendGuard'->>'classification' = 'marketing'
         FOR UPDATE SKIP LOCKED`),
    )
    // The addresses are compared in memory: the list keeps fingerprints, never an address.
    const ids = candidates
      .filter(
        (c) =>
          Array.isArray(c.addresses) &&
          c.addresses.some((a) => typeof a === "string" && hashOf(orgId, a) === emailHash),
      )
      .map((c) => c.id)
    if (ids.length === 0) return []
    const rows = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        UPDATE ${K}.approval_requests
           SET status = 'cancelled', decided_at = now(), reason = ${OPTED_OUT_REASON}
         WHERE org_id = ${orgId}::uuid AND status = 'pending'
           AND id = ANY(${`{${ids.join(",")}}`}::uuid[])
        RETURNING id::text AS id`),
    ).map((r) => r.id)
    for (const id of rows) {
      await tx.queueEvent({
        app: "kernel",
        entity: "approval_request",
        action: "update",
        entityId: id,
        orgId,
        actorId: actor.actorId,
        actorType: actor.actorType,
        data: await loadApprovalSummary(tx, orgId, id),
      })
    }
    return rows
  }
}

/**
 * Cancel the pending mail drafts of `orgId` whose pinned send check names the record
 * `{kind, id}` (a deal: `projects:deal`). Returns the cancelled ids; the routines waiting on
 * them carry on after the commit.
 */
export async function withdrawDraftsForClosedRecord(
  orgId: string,
  kind: string,
  id: string,
  actor: WithdrawActor,
): Promise<string[]> {
  const ref = JSON.stringify([{ kind, id }])
  const cancelled = await withPrivilegedDb(
    orgId,
    "approvals-withdraw-record-closed",
    async (tx) => {
      const rows = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
        UPDATE ${K}.approval_requests
           SET status = 'cancelled', decided_at = now(),
               reason = ${closedRecordReason(kind.slice(kind.indexOf(":") + 1))}
         WHERE org_id = ${orgId}::uuid AND status = 'pending'
           AND tool_name IN ('mail:compose', 'mail:reply')
           AND current_payload->'sendGuard'->'refs' @> ${ref}::jsonb
        RETURNING id::text AS id`),
      ).map((r) => r.id)
      for (const id of rows) {
        await tx.queueEvent({
          app: "kernel",
          entity: "approval_request",
          action: "update",
          entityId: id,
          orgId,
          actorId: actor.actorId,
          actorType: actor.actorType,
          data: await loadApprovalSummary(tx, orgId, id),
        })
      }
      return rows
    },
  )
  await continueRoutinesAfterWithdrawal(orgId, cancelled)
  return cancelled
}

function actorOf(event: AppEvent): WithdrawActor {
  return {
    actorId: event.actorId ?? null,
    actorType:
      event.actorType === "user" || event.actorType === "agent" ? event.actorType : "system",
  }
}

/** Whether an app of `orgId` declares `kind` as a record with a say over mail about it. */
function isSendGuardKind(orgId: string, kind: string): boolean {
  for (const [, manifest] of appBridgeManifestRegistry.entriesOf(orgId)) {
    if (manifest.sendGuardProviders?.[kind]) return true
  }
  return false
}

/**
 * `mail/suppression:added {emailHash}`: withdraw what is still waiting for that address.
 * `<app>/<entity>:closed` of a send-check record (`projects/deal:closed`): withdraw the drafts
 * about that record. Runs once, after the change committed; a failure is logged, and the send
 * check still refuses.
 */
export async function handleWithdrawOnEvent(event: AppEvent): Promise<void> {
  if (event.ephemeral || !event.orgId) return
  if (event.action === "closed") {
    const kind = `${event.app}:${event.entity}`
    const id = event.entityId
    if (typeof id !== "string" || id.length === 0 || !isSendGuardKind(event.orgId, kind)) return
    try {
      await withdrawDraftsForClosedRecord(event.orgId, kind, id, actorOf(event))
    } catch (err) {
      log.error(
        { err, orgId: event.orgId, kind, id },
        "withdrawing drafts about a closed record failed; the send check still refuses them",
      )
    }
    return
  }
  if (event.app !== "mail" || event.entity !== "suppression" || event.action !== "added") return
  const emailHash = (event.data as { emailHash?: unknown } | undefined)?.emailHash
  if (typeof emailHash !== "string" || !/^[0-9a-f]{64}$/.test(emailHash)) return
  try {
    await withdrawCommercialDraftsTo(event.orgId, emailHash, actorOf(event))
  } catch (err) {
    log.error(
      { err, orgId: event.orgId, emailHash },
      "withdrawing drafts to an opted-out address failed; the send check still refuses them",
    )
  }
}
