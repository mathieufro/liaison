// SPDX-License-Identifier: FSL-1.1-ALv2
import { commercialIdentitySchema, orgKernelSettingsSchema, updateOrgSchema } from "@liaison/shared"
import { eq, sql } from "drizzle-orm"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { withPrivilegedDb } from "~/db/privileged"
import { organizations } from "~/db/schema/kernel"
import { isManagedEdition } from "~/lib/edition"
import { redis } from "~/lib/redis"
import { success } from "~/lib/response"
import { getOrgKernelSettings } from "~/lib/settings"
import { zValidator } from "~/lib/validate"
import { resolveKnownSurfacePermission } from "~/modules/agent/media/media-analysis-constants"
import { bumpOrgPermissionVersions, hasSecondFactor } from "~/modules/auth/admin-second-factor"
import { invalidateAuthCache } from "~/modules/auth/auth-state"
import { isDemoOrgId } from "~/modules/demo/demo-org"
import { assertAuditDaysWithinCap, getOrgUsage, readOrgCaps } from "~/modules/org/caps"
import { hasScope } from "~/modules/permissions/permissions"

export const org = new Hono<AppEnv>()

// Keys inside `organizations.settings` that hold secrets or other
// admin-only configuration: BYOK provider keys (encrypted ciphertext +
// validation metadata), the Google OAuth client config (clientSecretEncrypted),
// and the per-org taint-source ledger. These are stripped from the response for
// any caller lacking `kernel:org:admin` — the same scope the PATCH handler
// requires to write them. Non-sensitive fields (rate limits, quotas, web-fetch
// allow/blocklists, tickets settings, etc.) stay visible to all members.
const SENSITIVE_SETTINGS_KEYS = ["providerKeys", "integrations", "taintSources"] as const

// Anything under a key that names secret material is withheld from the
// non-admin view whatever block it sits in, so a future setting that stores a
// credential next to the known ones does not leak by default.
const SECRET_KEY_PATTERN =
  /secret|password|passphrase|api[-_]?key|credential|ciphertext|encrypted|(access|refresh|auth|bearer|api|id)[-_]?token/i

function redactSecretKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecretKeys)
  if (!value || typeof value !== "object") return value
  const out: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key)) continue
    out[key] = redactSecretKeys(inner)
  }
  return out
}

export function stripSensitiveSettings(settings: unknown): unknown {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return settings
  const out: Record<string, unknown> = { ...(settings as Record<string, unknown>) }
  for (const key of SENSITIVE_SETTINGS_KEYS) delete out[key]
  // `ai.models` is the AI models page's admin state: the org's own model
  // servers (their addresses can be internal hosts) and the models added on
  // them. Members read the models they can run from /api/credits/models.
  const ai = out.ai
  if (ai && typeof ai === "object" && !Array.isArray(ai)) {
    const { models: _models, ...rest } = ai as Record<string, unknown>
    if (Object.keys(rest).length > 0) out.ai = rest
    else delete out.ai
  }
  return redactSecretKeys(out)
}

/**
 * The org's pushed sending key (managed edition, `cloudSender.keyCiphertext`,
 * modules/cloud/mail-sender.ts) never reaches a browser, admins included: it is
 * the control plane's to rotate, nobody's to read.
 */
function withoutCloudSenderKey(settings: unknown): unknown {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return settings
  const all = settings as Record<string, unknown>
  const sender = all.cloudSender
  if (!sender || typeof sender !== "object" || Array.isArray(sender)) return settings
  const { keyCiphertext: _key, ...rest } = sender as Record<string, unknown>
  return { ...all, cloudSender: rest }
}

org.get("/", async (c) => {
  const orgId = c.get("orgId")
  const scopes = c.get("scopes") ?? []
  const orgRow = await withPrivilegedDb(orgId, "org-get", async (tx) => {
    const [row] = await tx
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        timezone: organizations.timezone,
        businessHours: organizations.businessHours,
        defaultLocale: organizations.defaultLocale,
        settings: organizations.settings,
        updateChecksEnabled: organizations.updateChecksEnabled,
        createdAt: organizations.createdAt,
        updatedAt: organizations.updatedAt,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId))
    return row
  })
  if (!orgRow) throw new HTTPException(404, { message: "Organization not found" })
  // Whether this org is a demo workspace (a visitor's, or the reserved review
  // one): the demo surfaces (the "Demo instance" banner) follow the org, not the
  // deployment, so a real org on a demo box shows none of them.
  const demo = await isDemoOrgId(orgId)
  if (!hasScope("kernel:org:admin", scopes)) {
    return success(c, { ...orgRow, settings: stripSensitiveSettings(orgRow.settings), demo })
  }
  return success(c, { ...orgRow, settings: withoutCloudSenderKey(orgRow.settings), demo })
})

org.patch("/", zValidator("json", updateOrgSchema), async (c) => {
  const orgId = c.get("orgId")
  const updates = c.req.valid("json")
  const scopes = c.get("scopes") ?? []

  const touchesTopLevel =
    updates.name !== undefined ||
    updates.timezone !== undefined ||
    updates.defaultLocale !== undefined ||
    updates.businessHours !== undefined ||
    updates.updateChecksEnabled !== undefined
  const patchSettings = updates.settings ?? {}
  const touchesSettings = Object.keys(patchSettings).length > 0
  const hasAnyChange = touchesTopLevel || touchesSettings

  // Reject no-op patches early — an empty body must not bypass scope checks or
  // emit a spurious org-update event.
  if (!hasAnyChange) {
    throw new HTTPException(400, { message: "No fields to update" })
  }

  // App settings (tickets included) are written per field through
  // PATCH /api/apps/:app/settings/org, under each section's own scope.
  if (!hasScope("kernel:org:admin", scopes)) {
    throw new HTTPException(403, { message: "Missing scope: kernel:org:admin" })
  }

  // Requiring a second factor of administrators: the admin turning it on must
  // have one, or the change would lock them out of the screen they are on.
  const enablesAdminSecondFactor = patchSettings.requireAdminSecondFactor === true
  if (enablesAdminSecondFactor) {
    const enrolled = await withPrivilegedDb(orgId, "org-update-2fa-self", (tx) =>
      hasSecondFactor(tx, c.get("userId"), orgId),
    )
    if (!enrolled) {
      throw new HTTPException(409, {
        message:
          "Set up two-step verification on your own account before requiring it for administrators.",
      })
    }
  }
  // The audit retention in the managed edition (S24): the admin's
  // choice is stored apart (`auditRetentionDaysChosen`), never above the
  // plan's `auditDays`; the retention job keeps min(choice ?? cap, cap). A
  // self-hosted org writes `auditRetentionDays` as always.
  let settingsToMerge: Record<string, unknown> | undefined = updates.settings
  if (isManagedEdition() && patchSettings.auditRetentionDays !== undefined) {
    const days = patchSettings.auditRetentionDays
    assertAuditDaysWithinCap(await readOrgCaps(orgId), days)
    const { auditRetentionDays: _sold, ...rest } = patchSettings
    settingsToMerge = { ...rest, auditRetentionDaysChosen: days }
  }
  let bumpedUserIds: string[] = []

  const updated = await withPrivilegedDb(orgId, "org-update", async (tx) => {
    if (enablesAdminSecondFactor) {
      const [prev] = await tx
        .select({
          on: sql<boolean>`COALESCE((${organizations.settings}->>'requireAdminSecondFactor')::boolean, false)`,
        })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .for("update")
      if (prev?.on !== true) bumpedUserIds = await bumpOrgPermissionVersions(tx, orgId)
    }
    // Atomic JSONB merge to avoid TOCTOU race on concurrent PATCHes
    const setValues: Record<string, unknown> = { ...updates, updatedAt: new Date() }
    // An admin choosing the time zone is what makes it the org's clock for
    // quiet hours (notifications/quiet-window.ts); the column default is not.
    const settingsPatch = {
      ...(settingsToMerge ?? {}),
      ...(updates.timezone !== undefined ? { timezoneSet: true } : {}),
    }
    if (Object.keys(settingsPatch).length > 0) {
      setValues.settings = sql`COALESCE(${organizations.settings}, '{}'::jsonb) || ${JSON.stringify(settingsPatch)}::jsonb`
    }

    const [row] = await tx
      .update(organizations)
      .set(setValues)
      .where(eq(organizations.id, orgId))
      .returning()

    await tx.queueEvent({
      app: "kernel",
      entity: "org",
      action: "update",
      entityId: orgId,
      orgId,
      actorId: c.get("userId"),
      data: { settings: row.settings },
    })

    return row
  })

  for (const id of bumpedUserIds) invalidateAuthCache(id)

  // Sync rate limit to Redis so the rate limiter middleware picks it up
  // immediately. A null/absent limit must DELETE the key — not leave a stale
  // one — otherwise an admin who clears the org limit can never remove it
  // (orgRateLimiter keeps enforcing the old value forever).
  const settings = await withPrivilegedDb(orgId, "org-update-rl-sync", (tx) =>
    getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema),
  )
  if (settings.rateLimitPerMinute != null) {
    await redis.set(`ratelimit:config:limit:${orgId}`, String(settings.rateLimitPerMinute))
  } else {
    await redis.del(`ratelimit:config:limit:${orgId}`)
  }

  return success(c, updated)
})

// ---------------------------------------------------------------------------
// Media-analysis settings — a DEDICATED strict route. Never a generic settings
// merge: a strictObject that accepts ONLY the four booleans (so a body that
// smuggles `providerKeys` — or any other key the generic schema would accept,
// e.g. `rateLimitPerMinute` — is rejected). The write uses `jsonb_set` keyed
// to `{mediaAnalysis}` so every sibling settings key (providerKeys, etc.)
// SURVIVES untouched.
// ---------------------------------------------------------------------------
const mediaAnalysisStrictSchema = z.strictObject({
  tickets: z.strictObject({ image: z.boolean(), video: z.boolean() }),
  mail: z.strictObject({ image: z.boolean(), video: z.boolean() }),
})

// The org's caps and what it uses of them (Settings → Organization → Usage and
// limits). Read only: caps are set by the operator (`liaison org caps`).
org.get("/usage", async (c) => {
  const scopes = c.get("scopes") ?? []
  if (!hasScope("kernel:org:admin", scopes)) {
    throw new HTTPException(403, { message: "Missing scope: kernel:org:admin" })
  }
  return success(c, await getOrgUsage(c.get("orgId")))
})

// The legal name and postal address every commercial mail states, and the
// country policy for professional interest (modules/mail/commercial-footer.ts).
// Unset, no commercial mail stages or sends.
org.get("/settings/commercial-identity", async (c) => {
  const orgId = c.get("orgId")
  if (!hasScope("kernel:org:admin", c.get("scopes") ?? [])) {
    throw new HTTPException(403, { message: "Missing scope: kernel:org:admin" })
  }
  const { readCommercialIdentity } = await import("~/modules/mail/commercial-footer")
  return success(c, { commercialIdentity: await readCommercialIdentity(orgId) })
})

org.put(
  "/settings/commercial-identity",
  zValidator("json", commercialIdentitySchema),
  async (c) => {
    const orgId = c.get("orgId")
    if (!hasScope("kernel:org:admin", c.get("scopes") ?? [])) {
      throw new HTTPException(403, { message: "Missing scope: kernel:org:admin" })
    }
    const body = c.req.valid("json")
    await withPrivilegedDb(orgId, "org-commercial-identity", async (tx) => {
      // jsonb_set keyed to {commercialIdentity}: every other settings key is untouched.
      await tx.execute(sql`
        UPDATE ${organizations}
        SET settings = jsonb_set(
              COALESCE(settings, '{}'::jsonb),
              '{commercialIdentity}',
              ${JSON.stringify(body)}::jsonb,
              true
            ),
            updated_at = now()
        WHERE id = ${orgId}
      `)
    })
    const { readCommercialIdentity } = await import("~/modules/mail/commercial-footer")
    return success(c, { commercialIdentity: await readCommercialIdentity(orgId) })
  },
)

org.get("/settings/media-analysis", async (c) => {
  const orgId = c.get("orgId")
  const scopes = c.get("scopes") ?? []
  if (!hasScope("kernel:org:admin", scopes)) {
    throw new HTTPException(403, { message: "Missing scope: kernel:org:admin" })
  }
  const settings = await withPrivilegedDb(orgId, "org-media-analysis-get", (tx) =>
    getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema),
  )
  // Project the resolved 2×2 so the client always gets four concrete booleans
  // (defaults applied via the shared resolver).
  const resolved = {
    tickets: {
      image: resolveKnownSurfacePermission(settings, "tickets", "image"),
      video: resolveKnownSurfacePermission(settings, "tickets", "video"),
    },
    mail: {
      image: resolveKnownSurfacePermission(settings, "mail", "image"),
      video: resolveKnownSurfacePermission(settings, "mail", "video"),
    },
  }
  return success(c, resolved)
})

org.put("/settings/media-analysis", zValidator("json", mediaAnalysisStrictSchema), async (c) => {
  const orgId = c.get("orgId")
  const scopes = c.get("scopes") ?? []
  if (!hasScope("kernel:org:admin", scopes)) {
    throw new HTTPException(403, { message: "Missing scope: kernel:org:admin" })
  }
  const body = c.req.valid("json")
  await withPrivilegedDb(orgId, "org-media-analysis", async (tx) => {
    // jsonb_set keyed to {mediaAnalysis} — touches ONLY that key; every other
    // settings key (providerKeys, integrations, taintSources, …) is untouched.
    await tx.execute(sql`
        UPDATE ${organizations}
        SET settings = jsonb_set(
              COALESCE(settings, '{}'::jsonb),
              '{mediaAnalysis}',
              ${JSON.stringify(body)}::jsonb,
              true
            ),
            updated_at = now()
        WHERE id = ${orgId}
      `)
  })
  return success(c, body)
})
