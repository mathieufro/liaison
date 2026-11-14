// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Email-identity provisioner (Task 7). Writes the per-org transactional email
 * identity into the passthrough kernel settings (`settings.email.{from,replyTo}`)
 * so invitations and password resets brand their outbound mail per-org (resolved
 * by `modules/org/email-from.ts`).
 *
 * Handle: `withPrivilegedDb` (org-scoped) via `ctx.priv`. The jsonb merge mirrors
 * the BYOK provisioner's `settings || jsonb_build_object(...)` shape so a value
 * written here is read back identically by `getOrgKernelSettings`.
 *
 * Idempotency: read the current `settings.email`, in the write's own
 * transaction; if BOTH `from` and `replyTo` already equal the config (after the same merge semantics) → skip the write and
 * report `set:false` / `unchanged`. Otherwise merge only the supplied keys
 * (`from`/`replyTo`), leaving any unrelated `settings.email.*` keys intact.
 */
import { orgKernelSettingsSchema } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import type { ProvisioningConfig } from "~/cli/config/schema"
import type { Provisioner, ProvisionPlan, ProvisionResult } from "~/cli/provisioners/types"
import { schemaRef } from "~/db/schema-ref"
import { getOrgKernelSettings } from "~/lib/settings"

interface EmailSection {
  /** The resolved `from` after this run (the config value, or the stored value
   *  if the config did not set it). May be undefined if neither is set. */
  from?: string
  /** The resolved `replyTo` after this run. */
  replyTo?: string
  /** Whether this run wrote (merged) the settings (false = idempotent skip). */
  set: boolean
}

export const emailProvisioner: Provisioner<ProvisioningConfig> = {
  key: "email",

  async plan(ctx, config): Promise<ProvisionPlan> {
    const email = config.email
    if (!email || nothingToSet(email)) {
      return { actions: [] }
    }
    // The driver plans before any apply → `ctx.orgId` is unset here (org is
    // created in its apply). Without an org we cannot read the stored email
    // identity; report the set intent. `apply` does the real unchanged compare.
    const stored =
      ctx.orgId === ""
        ? null
        : await ctx.priv("cli-plan-email", (tx) =>
            getOrgKernelSettings(tx, ctx.orgId, orgKernelSettingsSchema),
          )
    const unchanged =
      stored !== null &&
      isUnchanged(stored.email, email) &&
      identityUnchanged(stored.commercialIdentity, email.commercialIdentity)
    return {
      ...(ctx.toolPath ? { changes: unchanged ? 0 : 1 } : {}),
      actions: [
        unchanged
          ? `email identity unchanged (from=${email.from ?? "—"})`
          : `set email identity (from=${email.from ?? "—"}, replyTo=${email.replyTo ?? "—"}${
              email.commercialIdentity
                ? `, commercial identity ${email.commercialIdentity.legalName}`
                : ""
            })`,
      ],
    }
  },

  async apply(ctx, _plan, config): Promise<ProvisionResult> {
    const email = config.email
    if (!email || nothingToSet(email)) {
      return {}
    }

    // Read, compare and write in one transaction: the stored settings the
    // merge is decided on are the ones it writes over.
    const mergeJson = JSON.stringify({
      ...(email.from !== undefined ? { from: email.from } : {}),
      ...(email.replyTo !== undefined ? { replyTo: email.replyTo } : {}),
    })
    // The commercial identity is one value, replaced whole (settings.commercialIdentity).
    const identityJson = email.commercialIdentity ? JSON.stringify(email.commercialIdentity) : null
    const k = drizzleSql.raw(schemaRef("kernel"))
    const { stored, wrote } = await ctx.priv("cli-email-write", async (tx) => {
      const current = await getOrgKernelSettings(tx, ctx.orgId, orgKernelSettingsSchema)
      if (
        isUnchanged(current.email, email) &&
        identityUnchanged(current.commercialIdentity, email.commercialIdentity)
      ) {
        return { stored: current, wrote: false }
      }
      // Merge only the supplied keys onto the existing settings.email object so an
      // unrelated key under settings.email is preserved.
      await tx.execute(drizzleSql`
        UPDATE ${k}.organizations
        SET settings = COALESCE(settings, '{}'::jsonb) ||
          jsonb_build_object('email',
            COALESCE(settings->'email', '{}'::jsonb) || ${mergeJson}::jsonb
          ) ||
          CASE WHEN ${identityJson}::jsonb IS NULL THEN '{}'::jsonb
               ELSE jsonb_build_object('commercialIdentity', ${identityJson}::jsonb) END,
          updated_at = now()
        WHERE id = ${ctx.orgId}::uuid
      `)
      return { stored: current, wrote: true }
    })

    if (!wrote) {
      const section: EmailSection = {
        ...(stored.email?.from !== undefined ? { from: stored.email.from } : {}),
        ...(stored.email?.replyTo !== undefined ? { replyTo: stored.email.replyTo } : {}),
        set: false,
      }
      ctx.log(`email identity already set (from=${section.from ?? "—"})`)
      return { section, unchanged: ["email"] }
    }

    const resolvedFrom = email.from ?? stored.email?.from
    const resolvedReplyTo = email.replyTo ?? stored.email?.replyTo
    const section: EmailSection = {
      ...(resolvedFrom !== undefined ? { from: resolvedFrom } : {}),
      ...(resolvedReplyTo !== undefined ? { replyTo: resolvedReplyTo } : {}),
      set: true,
    }
    if (email.commercialIdentity) {
      ctx.log(`commercial identity set (${email.commercialIdentity.legalName})`)
    }
    ctx.log(`email identity set (from=${section.from ?? "—"}, replyTo=${section.replyTo ?? "—"})`)
    return { section, changed: ["email"] }
  },
}

/**
 * The merge is a no-op when every supplied key already equals the stored value.
 * (Keys the config does not set are not compared — a partial config only updates
 * what it names.)
 */
function isUnchanged(
  stored: { from?: string; replyTo?: string } | undefined,
  config: { from?: string; replyTo?: string },
): boolean {
  if (config.from !== undefined && stored?.from !== config.from) return false
  if (config.replyTo !== undefined && stored?.replyTo !== config.replyTo) return false
  return true
}

function nothingToSet(email: { from?: string; replyTo?: string; commercialIdentity?: unknown }) {
  return (
    email.from === undefined &&
    email.replyTo === undefined &&
    email.commercialIdentity === undefined
  )
}

/** A commercial identity the config does not set is never compared. */
function identityUnchanged(stored: unknown, config: unknown): boolean {
  if (config === undefined) return true
  return JSON.stringify(stored ?? null) === JSON.stringify(config)
}
