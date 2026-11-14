// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE GATE OF A MANAGED SIDE CALL (S31).
//
// On a managed cell every AI call runs on OpenRouter with the cell's key, and
// the calls that are not chat turns (embeddings, media analysis) pass the same
// two chokepoints as a turn: `resolveKey` (which refuses the platform key while
// payment is required) and `spendGate` (balance, breaker, pushed rate).
// They are then metered like any OpenRouter call: the reported USD cost, raw
// cost x the pushed rate, one usage row per call (`finalizeUsage`).
//
// Unlike `preCheck`, the model is fixed by the caller (an OpenRouter id), not
// resolved from the org's enabled models: a side call's model is the
// product's choice, never the org's list.
import { and, eq } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { resolveKey, spendGate } from "~/modules/agent/credits/credit-meter"
import { openRouterModelKey } from "~/modules/agent/credits/model-keys"

/** What `finalizeUsage` needs to meter the call: the provider reports the cost. */
export interface ManagedSideCallModel {
  provider: "openrouter"
  modelId: string
  inputCostPerM: "0"
  outputCostPerM: "0"
}

export type ManagedSideCallGate =
  | {
      allowed: true
      key: string
      keySource: "liaison" | "byok"
      model: ManagedSideCallModel
    }
  | {
      allowed: false
      status: number
      reason: string
      /** `payment_required` while the org's renewal is unpaid. */
      billingCode?: string
    }

/** The usage row's model for an OpenRouter side call: `openrouter/<upstream id>`. */
export function managedSideCallModel(upstreamId: string): ManagedSideCallModel {
  return {
    provider: "openrouter",
    modelId: openRouterModelKey(upstreamId),
    inputCostPerM: "0",
    outputCostPerM: "0",
  }
}

/**
 * May this org spend on `upstreamId` right now, and with which key? Refusals
 * carry the reason the caller shows (or logs) and never throw.
 */
export async function managedSideCallGate(
  orgId: string,
  upstreamId: string,
): Promise<ManagedSideCallGate> {
  let resolved: { key: string; source: "byok" | "liaison" }
  try {
    resolved = await resolveKey(orgId, { provider: "openrouter", upstreamId })
  } catch (err) {
    const coded = err as { status?: unknown; code?: unknown }
    return {
      allowed: false,
      status: typeof coded.status === "number" ? coded.status : 500,
      reason: err instanceof Error ? err.message : String(err),
      ...(typeof coded.code === "string" ? { billingCode: coded.code } : {}),
    }
  }
  const model = managedSideCallModel(upstreamId)
  const block = await spendGate(orgId, resolved.source, model.modelId)
  if (block) {
    return {
      allowed: false,
      status: block.status,
      reason: block.reason,
      ...(block.billingCode ? { billingCode: block.billingCode } : {}),
    }
  }
  return { allowed: true, key: resolved.key, keySource: resolved.source, model }
}

const attributionUsers = new Map<string, string | null>()

/**
 * The user a system side call (an embed batch of the indexer) is billed to:
 * a real user of the org, never the zero-uuid system sentinel. The same
 * convention as the media-analysis job and sub-runs (`resolveAnyOrgUser`,
 * files/media-analysis-job.ts; the rule is stated in
 * apps/tickets/link-ingest-job.ts). Remembered per org for the process.
 */
export async function systemWorkUserId(orgId: string): Promise<string | null> {
  if (attributionUsers.has(orgId)) return attributionUsers.get(orgId) ?? null
  const { users } = await import("~/db/schema/kernel")
  const [u] = await withPrivilegedDb(orgId, "side-call-attribution-user", (tx) =>
    tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.orgId, orgId), eq(users.userType, "member")))
      .limit(1),
  )
  const id = u?.id ?? null
  if (id) attributionUsers.set(orgId, id)
  return id
}
