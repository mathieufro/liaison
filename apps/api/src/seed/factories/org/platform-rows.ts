// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The org's platform rows a test needs in a given state, written in their
// schema's shape: outbox events (pending or already processed), a durable
// consumer's mark, an MCP connection, an export run, a control-plane message,
// a custom app's install record, a connected account, an org's OAuth client.
//
// These are rows the product writes as a side effect of work no test can run
// on demand (an outbox drain, an OAuth round trip, a control-plane queue, an
// upload), so a test states the result through here instead of by hand.
// Privileged: written over the system connection, like the product does.
import { sql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import {
  apps,
  appsActiveVersion,
  appsInstalled,
  connectedAccounts,
  controlPlaneOutbox,
  durableConsumerMarks,
  mcpConnections,
  oauthProviders,
  orgExports,
  pendingEvents,
} from "~/db/schema/kernel"

/** One outbox event of the org; its id. `processed`: already drained. */
export async function seedPendingEvent(
  orgId: string,
  payload: Record<string, unknown>,
  opts: { processed?: boolean } = {},
): Promise<string> {
  const [row] = await withSystemDb("seed-pending-event", (db) =>
    db
      .insert(pendingEvents)
      .values({ orgId, payload, processedAt: opts.processed ? sql`now()` : null })
      .returning({ id: pendingEvents.id }),
  )
  return row?.id as string
}

/**
 * `count` already-processed outbox events of the org in one statement, each
 * padded to about `padBytes` of payload: the history an org's outbox keeps,
 * at a scale a test of a size-bound path needs.
 */
export async function seedProcessedPendingEvents(
  orgId: string,
  count: number,
  padBytes = 600,
): Promise<void> {
  await withSystemDb("seed-processed-pending-events", (db) =>
    db.execute(
      sql`INSERT INTO ${pendingEvents} (org_id, payload, processed_at)
          SELECT ${orgId}::uuid,
                 jsonb_build_object('entity', 'x', 'action', 'y', 'n', g, 'pad', repeat('p', ${padBytes}::int)),
                 now()
            FROM generate_series(1, ${count}::int) g`,
    ),
  )
}

/** A durable consumer's mark that it handled `eventId`. */
export async function seedDurableConsumerMark(consumer: string, eventId: string): Promise<void> {
  await withSystemDb("seed-durable-consumer-mark", (db) =>
    db.insert(durableConsumerMarks).values({ consumer, eventId }),
  )
}

/** An MCP connection of a user; its id. */
export async function seedMcpConnection(row: {
  orgId: string
  userId: string
  clientId: string
  label: string
  refreshTokenHash: string
}): Promise<string> {
  const [created] = await withSystemDb("seed-mcp-connection", (db) =>
    db.insert(mcpConnections).values(row).returning({ id: mcpConnections.id }),
  )
  return created?.id as string
}

/** An org export run in a given status; its id. */
export async function seedOrgExport(row: typeof orgExports.$inferInsert): Promise<string> {
  const [created] = await withSystemDb("seed-org-export", (db) =>
    db.insert(orgExports).values(row).returning({ id: orgExports.id }),
  )
  return created?.id as string
}

/** A queued control-plane message. */
export async function seedControlPlaneMessage(row: {
  type: string
  messageId: string
  data: Record<string, unknown>
}): Promise<void> {
  await withSystemDb("seed-control-plane-message", (db) =>
    db.insert(controlPlaneOutbox).values(row),
  )
}

/**
 * An app's registration row for an org (`kernel.apps`), as registration writes
 * it; its id. For a test that needs the app known to the org without loading a
 * bundle.
 */
export async function seedAppRow(row: typeof apps.$inferInsert): Promise<string> {
  const [created] = await withSystemDb("seed-app-row", (db) =>
    db.insert(apps).values(row).returning({ id: apps.id }),
  )
  return created?.id as string
}

/** A custom app's install record for an org (an upload's row). */
export async function seedCustomAppInstall(row: typeof appsInstalled.$inferInsert): Promise<void> {
  await withSystemDb("seed-custom-app-install", (db) => db.insert(appsInstalled).values(row))
}

/**
 * The active version of an app, for an org (`orgId`) or the instance (no
 * `orgId`). `onConflict: "skip"` keeps a version already active.
 */
export async function seedActiveAppVersion(
  row: typeof appsActiveVersion.$inferInsert,
  opts: { onConflict?: "error" | "skip" } = {},
): Promise<void> {
  await withSystemDb("seed-active-app-version", async (db) => {
    const insert = db.insert(appsActiveVersion).values(row)
    return opts.onConflict === "skip" ? insert.onConflictDoNothing() : insert
  })
}

/**
 * A connected account row in a given status, holding the encrypted tokens the
 * row names and no others; its id.
 */
export async function seedConnectedAccountRow(
  row: typeof connectedAccounts.$inferInsert,
): Promise<string> {
  const [created] = await withSystemDb("seed-connected-account-row", (db) =>
    db.insert(connectedAccounts).values(row).returning({ id: connectedAccounts.id }),
  )
  return created?.id as string
}

/** The org's OAuth client for a provider, as the setup path stores it; its id. */
export async function seedOAuthProviderRow(
  row: typeof oauthProviders.$inferInsert,
): Promise<string> {
  const [created] = await withSystemDb("seed-oauth-provider-row", (db) =>
    db.insert(oauthProviders).values(row).returning({ id: oauthProviders.id }),
  )
  return created?.id as string
}
