// SPDX-License-Identifier: FSL-1.1-ALv2
import type { AttentionItem, AttentionKind } from "@liaison/shared"
import { sql } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import {
  externalOnlyDetail,
  getDetailExternalLink,
  resolveConnectionTemplateVars,
} from "~/modules/apps/detail-external-link"
import { resolveReferenceMetadataFromManifests } from "~/modules/threads/reference-display"

const K = sql.raw(schemaRef("kernel"))

const PROVIDER_ITEM_CAP = 200

interface EventRow {
  id: string
  app: string
  entity_type: string
  entity_id: string
  kind: string
  urgency: number
  summary: string
  occurred_at: string | Date
  metadata: Record<string, unknown> | null
}

/**
 * Aggregator-facing provider that surfaces persisted, unread, non-email-only
 * attention rows for the current user. A row set aside ("Not now") stays out
 * until its `set_aside_until` passes. Registered into
 * `attentionItemsRegistry` at `["*", "kernel"]` by the bootstrap step.
 */
export async function getEventAttentionItems(
  tx: RlsClient,
  orgId: string,
  userId: string,
): Promise<AttentionItem[]> {
  const rows = (await tx.execute(sql`
    SELECT id, app, entity_type, entity_id, kind, urgency, summary,
           occurred_at, metadata
    FROM ${K}.attention_events
    WHERE org_id = ${orgId}
      AND user_id = ${userId}
      AND read_at IS NULL
      AND email_only = false
      AND (set_aside_until IS NULL OR set_aside_until <= now())
    ORDER BY urgency DESC, occurred_at ASC
    LIMIT ${PROVIDER_ITEM_CAP}`)) as unknown as EventRow[]

  // Connection template vars (e.g. the Shopify shop subdomain) are resolved once
  // per app across the batch — a single small query even when many rows share an
  // app. `null` is cached too, so a disconnected app isn't re-queried per row.
  const connVarsCache = new Map<string, Record<string, string> | null>()
  const connVarsFor = async (app: string): Promise<Record<string, string> | null> => {
    if (connVarsCache.has(app)) return connVarsCache.get(app) ?? null
    const resolved = await resolveConnectionTemplateVars(tx, orgId, app)
    connVarsCache.set(app, resolved)
    return resolved
  }

  const items: AttentionItem[] = []
  for (const r of rows) {
    const meta = resolveReferenceMetadataFromManifests(r.app, r.entity_type, orgId)
    const tabType = meta?.tabType ?? `${r.app}:${r.entity_type}`
    const occurredIso =
      r.occurred_at instanceof Date
        ? r.occurred_at.toISOString()
        : new Date(r.occurred_at).toISOString()
    // A `metadata.link` overrides the default deep-link. Generic — works for any
    // kind whose entity_id is not itself navigable (e.g. agent_notification). A
    // link may target an in-app tab (`tabType` + `entityId`) or an external URL
    // (`url`), the latter for entities with no in-app view (e.g. a Shopify order).
    const link = r.metadata?.link as
      | { tabType?: unknown; entityId?: unknown; url?: unknown; label?: unknown }
      | undefined

    let action: AttentionItem["action"]
    if (
      link &&
      typeof link === "object" &&
      typeof link.tabType === "string" &&
      typeof link.entityId === "string"
    ) {
      action = { type: "open_entity", tabType: link.tabType, entityId: link.entityId }
    } else if (link && typeof link === "object" && isHttpUrl(link.url)) {
      action = {
        type: "open_url",
        url: link.url,
        ...(typeof link.label === "string" ? { label: link.label } : {}),
      }
    } else {
      // No explicit link override. If the entity declares an external-only detail
      // view (externalLink, no in-app component), resolve the deep link now so the
      // client can open it directly — the in-app tab type no longer exists.
      const ext = externalOnlyDetail(orgId, r.app, r.entity_type)
        ? await (async () => {
            const vars = await connVarsFor(r.app)
            return vars
              ? getDetailExternalLink(orgId, r.app, r.entity_type, r.entity_id, vars)
              : null
          })()
        : null
      action = ext
        ? { type: "open_url", url: ext.url, label: ext.label }
        : { type: "open_entity", tabType, entityId: r.entity_id }
    }

    const item: AttentionItem = {
      id: r.id,
      app: r.app,
      entity: r.entity_type,
      entityId: r.entity_id,
      kind: r.kind as AttentionKind,
      summary: r.summary,
      urgency: Number(r.urgency),
      occurredAt: occurredIso,
      action,
      persisted: true,
      ...(r.metadata ? { metadata: r.metadata } : {}),
    }
    items.push(item)
  }
  return items
}

/** Only an absolute http(s) URL may become an open_url action: a link stored in
 *  metadata (agent-written) must never hand the client javascript:, data: or file:. */
function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false
  try {
    const { protocol } = new URL(value)
    return protocol === "http:" || protocol === "https:"
  } catch {
    return false
  }
}
