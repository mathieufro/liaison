// SPDX-License-Identifier: FSL-1.1-ALv2
import type { AttentionItem } from "@liaison/shared"
import { sql } from "drizzle-orm"
import { extractRows, type RlsClient } from "~/db"

function mkItem(provider: string, urgency: number, suffix: string): AttentionItem {
  return {
    id: `${provider}:item:${suffix}`,
    app: provider,
    entity: "thing",
    entityId: suffix,
    kind: "admin_action",
    summary: `${provider} item`,
    urgency,
    occurredAt: new Date().toISOString(),
    action: { type: "open_entity", tabType: `${provider}:thing`, entityId: suffix },
  }
}

export async function highUrgencyProvider(): Promise<AttentionItem[]> {
  return [mkItem("aggSortHigh", 80, "1")]
}

export async function lowUrgencyProvider(): Promise<AttentionItem[]> {
  return [mkItem("aggSortLow", 30, "2")]
}

export async function throwingProvider(): Promise<AttentionItem[]> {
  throw new Error("intentional aggregator test failure")
}

export async function multiKindProvider(): Promise<AttentionItem[]> {
  // Three rules firing on the SAME entity plus one distinct entity — mirrors a
  // ticket that is simultaneously awaiting_agent, unassigned, and sla_risk.
  const shared = "ticket-1"
  return [
    { ...mkItem("aggDedupe", 60, shared), id: `awaiting:${shared}`, kind: "awaiting_agent" },
    { ...mkItem("aggDedupe", 40, shared), id: `unassigned:${shared}`, kind: "unassigned" },
    { ...mkItem("aggDedupe", 75, shared), id: `sla:${shared}`, kind: "sla_risk" },
    { ...mkItem("aggDedupe", 40, "ticket-2"), id: "unassigned:ticket-2", kind: "unassigned" },
  ]
}

/** A kernel provider's items about apps (a connection's health, an approval of a tool). */
export async function kernelItemsAboutAppsProvider(): Promise<AttentionItem[]> {
  return [
    { ...mkItem("kernel", 70, "conn-off"), id: "conn:off", metadata: { appName: "aggOffApp" } },
    {
      ...mkItem("kernel", 70, "appr-off"),
      id: "appr:off",
      metadata: { toolName: "aggOffApp:do_thing" },
    },
    { ...mkItem("kernel", 70, "conn-on"), id: "conn:on", metadata: { appName: "aggOnApp" } },
  ]
}

/** The transaction this provider ran in, as an item id (one transaction for every kernel provider). */
async function txItem(tx: RlsClient, name: string): Promise<AttentionItem[]> {
  const [row] = extractRows<{ id: string }>(
    await tx.execute(sql`SELECT txid_current()::text AS id`),
  )
  return [{ ...mkItem(name, 50, name), id: `${name}:tx:${row?.id ?? "none"}` }]
}

export async function txProviderA(tx: RlsClient): Promise<AttentionItem[]> {
  return txItem(tx, "aggTxA")
}

export async function txProviderB(tx: RlsClient): Promise<AttentionItem[]> {
  return txItem(tx, "aggTxB")
}

/** Fails on the database: only its own savepoint may roll back. */
export async function sqlFailingProvider(tx: RlsClient): Promise<AttentionItem[]> {
  await tx.execute(sql`SELECT 1 / 0`)
  return []
}

/** Echoes whom the aggregator passed on to it, as one item per provider. */
function passOnEcho(app: string, userId: string, forUserIds?: readonly string[]): AttentionItem[] {
  return [{ ...mkItem(app, 50, `${app}-${userId}`), metadata: { forUserIds: forUserIds ?? [] } }]
}

export async function passOnEchoA(
  _tx: RlsClient,
  _orgId: string,
  userId: string,
  forUserIds?: readonly string[],
): Promise<AttentionItem[]> {
  return passOnEcho("routePassOnDeclared", userId, forUserIds)
}

export async function passOnEchoB(
  _tx: RlsClient,
  _orgId: string,
  userId: string,
  forUserIds?: readonly string[],
): Promise<AttentionItem[]> {
  return passOnEcho("routePassOnUndeclared", userId, forUserIds)
}
