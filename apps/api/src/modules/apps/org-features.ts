// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Switches inside an app, per org (`kernel.org_app_features`): THE writer, and the
 * words a refusal uses. The reader is `isFeatureOffForTool` in org-apps.ts, which
 * loads the rows with the rest of the org's app state.
 *
 * A member has no write path on the table: every write comes here, on a privileged
 * handle, after the feature's declared `adminScope` is checked, and records who and
 * when. There is no route or tool for it: an app's own writer calls it, which is how
 * a feature whose row is derived from the app's data stays true to that data.
 *
 * A writer that keeps the row inside its own transaction uses `writeOrgAppFeature`
 * and calls `noteOrgFeatureChanged` once it has committed; `setOrgAppFeature` does
 * both in a transaction of its own.
 */
import { sql } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { orgAppFeatures } from "~/db/schema/kernel"
import { broadcastEphemeral } from "~/infra/events/event-bus"
import { rootLogger } from "~/lib/logger"
import { manifestRegistry } from "~/modules/apps/app-registries"
import { FEATURE_OFF_CODE, noteOrgAppsChanged } from "~/modules/apps/org-apps"
import { serverT } from "~/modules/i18n/server-i18n"
import { hasScope } from "~/modules/permissions/permissions"

const log = rootLogger.child({ module: "apps/org-features" })

/** A refused feature write: nothing was written. */
export class OrgFeatureError extends Error {
  constructor(
    readonly status: 403 | 404,
    readonly code: "forbidden" | "not_found",
    message: string,
  ) {
    super(message)
    this.name = "OrgFeatureError"
  }
}

export interface OrgFeatureWrite {
  orgId: string
  app: string
  feature: string
  enabled: boolean
  /** Who is writing. `userId` null is a system writer, which still names its scopes. */
  actor: { userId: string | null; scopes: readonly string[] }
}

/**
 * Write the row in the caller's transaction, after checking the declared
 * `adminScope`. `changed` is false when the row already says this: who and when stay
 * as they were and nobody is told. On `changed`, the caller calls
 * `noteOrgFeatureChanged` after its commit.
 */
export async function writeOrgAppFeature(
  tx: PrivilegedDb,
  write: OrgFeatureWrite,
): Promise<{ changed: boolean }> {
  const { orgId, app, feature, enabled, actor } = write
  const declared = manifestRegistry.get([orgId, app])?.features?.[feature]
  if (!declared) {
    throw new OrgFeatureError(
      404,
      "not_found",
      `The app ${app} declares no feature ${feature}, so nothing was written.`,
    )
  }
  if (!hasScope(declared.adminScope, [...actor.scopes])) {
    throw new OrgFeatureError(
      403,
      "forbidden",
      `Changing the feature ${feature} of ${app} needs the scope ${declared.adminScope}, so nothing was written.`,
    )
  }
  const stamp = { enabled, changedBy: actor.userId, changedAt: new Date() }
  const written = await tx
    .insert(orgAppFeatures)
    .values({ orgId, appName: app, feature, ...stamp })
    .onConflictDoUpdate({
      target: [orgAppFeatures.orgId, orgAppFeatures.appName, orgAppFeatures.feature],
      set: stamp,
      where: sql`${orgAppFeatures.enabled} IS DISTINCT FROM ${enabled}`,
    })
    .returning({ feature: orgAppFeatures.feature })
  if (written.length === 0) return { changed: false }
  // Durable and delivered to every process after the commit: each one tells its
  // own live MCP sessions that the tool list changed (mcp/catalog-notifier.ts).
  await tx.queueEvent({
    app: "kernel",
    entity: "app",
    action: "feature_update",
    entityId: `${app}:${feature}`,
    orgId,
    actorId: actor.userId ?? undefined,
    data: { app, feature, enabled },
  })
  return { changed: true }
}

/**
 * A feature row committed: this process and its peers reload the org's state, and
 * open tabs are told. A failed broadcast only delays the tabs until their next load.
 */
export async function noteOrgFeatureChanged(
  orgId: string,
  app: string,
  feature: string,
  enabled: boolean,
): Promise<void> {
  await noteOrgAppsChanged(orgId)
  void broadcastEphemeral({
    app: "kernel",
    entity: "org_app",
    action: "update",
    orgId,
    data: { app, feature, enabled },
  }).catch((err) =>
    log.warn({ err, orgId, app, feature }, "org feature broadcast failed; tabs converge on reload"),
  )
}

/** Write the row in a transaction of its own, then tell everyone. */
export async function setOrgAppFeature(write: OrgFeatureWrite): Promise<{ changed: boolean }> {
  const { orgId, app, feature, enabled } = write
  const result = await withPrivilegedDb(orgId, "org-feature-write", (tx) =>
    writeOrgAppFeature(tx, write),
  )
  if (result.changed) await noteOrgFeatureChanged(orgId, app, feature, enabled)
  return result
}

/** What every door answers for a tool of a feature that is off. Never retryable. */
export interface FeatureOffAnswer {
  code: typeof FEATURE_OFF_CODE
  feature: string
  message: string
  next: string
  retryable: false
}

/** The catalog's text for `key`, or undefined when it has none. */
function declaredText(key: string | undefined): string | undefined {
  if (!key) return undefined
  const text = serverT("en", key)
  return text === key ? undefined : text
}

/**
 * The answer for this tool, in the words its feature declares. A feature that
 * declares none gets plain facts: what did not run, and who can change that.
 */
export function featureOffAnswer(
  orgId: string,
  tool: { appName: string; name: string; feature?: string },
): FeatureOffAnswer {
  const feature = tool.feature ?? ""
  const declared = manifestRegistry.get([orgId, tool.appName])?.features?.[feature]
  const label = declaredText(declared?.labelKey) ?? feature
  return {
    code: FEATURE_OFF_CODE,
    feature,
    message:
      declaredText(declared?.offMessageKey) ??
      `${label} is off for this workspace, so ${tool.appName}__${tool.name} did not run and nothing changed.`,
    next:
      declaredText(declared?.offNextKey) ??
      (declared
        ? `Say that it is off. Someone holding ${declared.adminScope} can turn it on.`
        : "Say that it is off."),
    retryable: false,
  }
}
