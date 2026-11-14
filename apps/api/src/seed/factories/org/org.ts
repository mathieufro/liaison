// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The org factory: create (or find) an org, its admin, its roles and its people
// through the provisioning CLI's own provisioners (`liaison config apply`), so
// a seeded org is built by exactly the code an operator's config builds it
// with. Nothing here re-implements a provisioner.
//
// Three passes, each idempotent, so a re-seed is the same run as a no-op:
//   1. the org alone (`provisionOrgShell`), with its email section (the
//      commercial identity its mail states) when the config has one, so a tier
//      can stamp what it must on the org (a demo marker, say) before a single
//      account exists in it;
//   2. the admin and the roles (`provisionAdminAndRoles`);
//   3. the people (`provisionPeople`). `runConfigApply` validates every
//      `users[].role` before any provisioner writes, and for an org that does
//      not exist yet it can only check the DEFAULT role names, so the people
//      come after the roles they hold are real.
//
// Privileged: an org's bootstrap register (the org row, its first admin) is
// privileged in the product too; the provisioners run it that way.
import { eq, sql } from "drizzle-orm"
import { runConfigApply } from "~/cli/config/apply"
import type { ProvisioningConfig } from "~/cli/config/schema"
import { adminProvisioner } from "~/cli/provisioners/admin"
import { emailProvisioner } from "~/cli/provisioners/email"
import { orgProvisioner } from "~/cli/provisioners/org"
import { rolesProvisioner } from "~/cli/provisioners/roles"
import { usersProvisioner } from "~/cli/provisioners/users"
import { withSystemDb } from "~/db/privileged"
import { organizations, systemConfig } from "~/db/schema/kernel"

export type OrgConfig = Omit<ProvisioningConfig, "users">
export type PeopleConfig = NonNullable<ProvisioningConfig["users"]>

// A seeded org is the seeder's: what it declares is what the org holds after
// the run, whatever moved on the server since (a release that changes a role's
// scopes, an app upgrade extending a role, somebody's edit). Without `prefer`
// such a path is a conflict the apply leaves unwritten (exit 3), and a re-seed
// of an existing org stopped at its first pass for good.
function applyOptions(log: (msg: string) => void) {
  return {
    format: "json" as const,
    dryRun: false,
    validateByok: false,
    echoSupplied: false,
    prefer: { all: "file" as const, scoped: [] },
    log,
  }
}

// ── The slug claim ──────────────────────────────────────────────────────────
//
// A tier that creates an org and then stamps it (the demo marker) has a window
// between the two: a process killed inside it leaves an org this seeder made
// but that carries no stamp, which the next run cannot tell from a real
// workspace and refuses. So the seeder claims the slug BEFORE it creates the
// org, and releases the claim once the stamp is on. A claim still there on the
// next run says the org under that slug is this seeder's own interrupted work.

const claimKey = (orgSlug: string) => `seed.org-claim:${orgSlug}`

/** Claim a slug this run is about to create an org under. */
export async function claimOrgSlug(orgSlug: string): Promise<void> {
  await withSystemDb("seed-org-claim", (tx) =>
    tx
      .insert(systemConfig)
      .values({ key: claimKey(orgSlug), value: { claimedBy: "seed" } })
      .onConflictDoUpdate({ target: systemConfig.key, set: { updatedAt: sql`now()` } }),
  )
}

/** Whether an earlier run claimed the slug and never got to release it. */
export async function hasOrgSlugClaim(orgSlug: string): Promise<boolean> {
  const [row] = await withSystemDb("seed-org-claim-read", (tx) =>
    tx
      .select({ key: systemConfig.key })
      .from(systemConfig)
      .where(eq(systemConfig.key, claimKey(orgSlug)))
      .limit(1),
  )
  return row !== undefined
}

/** Release the claim once the org carries what the tier stamps on it. */
export async function releaseOrgSlugClaim(orgSlug: string): Promise<void> {
  await withSystemDb("seed-org-claim-release", (tx) =>
    tx.delete(systemConfig).where(eq(systemConfig.key, claimKey(orgSlug))),
  )
}

/** The id of the org behind a slug, or null when there is none. */
export async function findOrgIdBySlug(orgSlug: string): Promise<string | null> {
  const [org] = await withSystemDb("seed-org-lookup", (tx) =>
    tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, orgSlug))
      .limit(1),
  )
  return org?.id ?? null
}

/** The slug of an org, or the empty string when there is no such org. */
export async function orgSlugOf(orgId: string): Promise<string> {
  const [org] = await withSystemDb("seed-org-slug", (tx) =>
    tx
      .select({ slug: organizations.slug })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1),
  )
  return org?.slug ?? ""
}

/** The id of the org behind a slug, once provisioning has created it. */
export async function requireOrgIdBySlug(orgSlug: string, who: string): Promise<string> {
  const id = await findOrgIdBySlug(orgSlug)
  if (!id) throw new Error(`${who}: org '${orgSlug}' missing after provisioning`)
  return id
}

/** Pass 1: the org row alone. `created` is true only when this pass inserted it. */
export async function provisionOrgShell(
  config: OrgConfig,
  who: string,
  log: (msg: string) => void,
): Promise<{ orgId: string; created: boolean }> {
  const pass = await runConfigApply({
    ...applyOptions(log),
    config,
    registry: { org: orgProvisioner, email: emailProvisioner },
  })
  if (pass.exitCode !== 0) {
    throw new Error(
      `${who}: org provisioning failed for '${config.org.slug}' (exit ${pass.exitCode})`,
    )
  }
  return {
    orgId: await requireOrgIdBySlug(config.org.slug, who),
    created: pass.report.changed.includes("org.created"),
  }
}

/**
 * The config of a pass after the first: without the email section, which pass 1
 * wrote. A pass whose registry has no email provisioner never writes it, and
 * carrying it would only make the apply's drift record read the org's email
 * settings back twice per pass, on the visitor seed's load path.
 */
function laterPass(config: OrgConfig): OrgConfig {
  const { email: _written, ...rest } = config
  return rest
}

/** Pass 2: the org's admin and its custom roles. */
export async function provisionAdminAndRoles(
  config: OrgConfig,
  who: string,
  log: (msg: string) => void,
): Promise<void> {
  const pass = await runConfigApply({
    ...applyOptions(log),
    config: laterPass(config),
    registry: { org: orgProvisioner, admin: adminProvisioner, roles: rolesProvisioner },
  })
  if (pass.exitCode !== 0) {
    throw new Error(
      `${who}: role provisioning failed for '${config.org.slug}' (exit ${pass.exitCode})`,
    )
  }
}

/** Pass 3: the people, each with the role pass 2 made real. */
export async function provisionPeople(
  config: OrgConfig,
  people: PeopleConfig,
  who: string,
  log: (msg: string) => void,
): Promise<void> {
  const pass = await runConfigApply({
    ...applyOptions(log),
    config: { ...laterPass(config), users: people },
    registry: { org: orgProvisioner, admin: adminProvisioner, users: usersProvisioner },
  })
  if (pass.exitCode !== 0) {
    throw new Error(
      `${who}: user provisioning failed for '${config.org.slug}' (exit ${pass.exitCode})`,
    )
  }
}
