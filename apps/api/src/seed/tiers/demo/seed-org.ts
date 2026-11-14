// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `seedDemoOrg` — the reusable per-org seeder behind the public demo instance.
//
// ONE call brings an org from nothing to "a company you can log into": the org
// row, its roles, its people with working passwords and no uploaded picture, a personal
// agent each, the shared role agents, and the app surface enabled and
// installed. It is IDEMPOTENT: running it twice changes no row counts and
// throws nothing, so the demo box can re-run it on every deploy and a visitor
// org can be topped up rather than rebuilt.
//
// WHAT IT DOES NOT DO: any domain data (tickets, mail, conversations, orders,
// invoices, knowledge articles). Those are seeded by the later batches ON TOP
// of what this returns.
//
// ── THE SEAM OTHER BATCHES CODE AGAINST ────────────────────────────────────
// `SeedDemoOrgResult` is the contract. A domain-data seeder takes it and needs
// nothing else:
//
//   const org = await seedDemoOrg({ orgSlug: "demo", variant: "visitor" })
//   org.orgId                      // the org every write is scoped to
//   org.peopleByKey.amina.userId   // who a ticket is assigned to / authored by
//   org.peopleByKey.amina.personalAgentId
//   org.agentsByHandle["@support"].agentId
//   org.appsByName.tickets.installed
//   org.world.customers            // who to seed conversations from
//   org.world.catalog              // what to seed orders for
//
// Keys are the stable `DemoPerson.key` values from `world.ts` (elodie, tobias,
// amina, lucas, margot, henrik, giulia), never emails or display names, so a
// later batch never has to re-derive an id. The result is a plain value: it can
// be returned across a process boundary and re-read, and nothing in it is a
// live handle.
//
// ── THE CHOICES ────────────────────────────────────────────────────────────
//  * Locale `en`, timezone `Europe/Paris`. The company is French and its
//    working day should read as one, but the demo is opened by visitors from
//    anywhere and the UI copy a visitor lands on has to be the one they read:
//    `en` is the default and a visitor switches to `fr` in Settings in one
//    click. `DemoOrgOptions.locale` overrides it for a French-facing demo.
//  * THE SEVEN PEOPLE HAVE NO PASSWORD AT ALL. They are the company: they
//    author tickets, are assigned work, sit in threads and turn up in the
//    directory, and none of that needs a login. They used to share a published
//    constant so a stranger could sign in as one of them, which made one org's
//    seven accounts a front door on the public internet. The seeder now nulls
//    `kernel.users.password_hash` for every one of them after provisioning,
//    which is the passwordless shape `login()` already refuses. A PRIVATE QA
//    box can ask for the opposite with `personaPassword` (CLI `--passwords`),
//    which is refused outright while demo mode is on.
//  * EXACTLY ONE ACCOUNT CAN SIGN IN: the org's OWNER, supplied by the caller
//    (`SeedDemoOrgOptions.owner`). For a visitor org that is the person who
//    registered, who is therefore the admin of the company they were just
//    handed; for the reserved org it is the App Review account.
//  * Every address is on a PER-ORG subdomain of `resonantaudiolabs.example`
//    (RFC 2606 reserved), so a demo agent that actually tries to send mail can
//    never reach a real inbox. The subdomain is not decoration: see below.
//  * ADDRESSES ARE UNIQUE PER ORG (`demoPersonEmail`). One demo box hosts one
//    org per visitor, all seeded from the same world, and a `kernel.users` row
//    is unique on `(org_id, lower(email))` but an address that repeats across
//    orgs makes every by-address lookup ambiguous. Deriving the domain from the
//    org slug keeps each org's copy of the world distinct, and the world file
//    stays the single source of truth for who these people are.
//  * THE ORG IS MARKED AS A DEMO ORG HERE, in `seedDemoOrg`, before any person
//    exists to log into it. The marker is what turns on the egress lockdown and
//    the token ceiling, and this is the only component that knows at creation
//    time that the org it is filling is a demo org.
//  * `ads` and `calls` are deliberately not part of the demo surface.

import { randomBytes } from "node:crypto"
import type { CommercialIdentity } from "@liaison/shared"
import { and, eq } from "drizzle-orm"
import type { ProvisioningConfig } from "~/cli/config/schema"
import { writeApproveRepliesFromHome } from "~/cli/provisioners/ticket-inboxes"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { organizations, roles, userRoles, users } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { personalAgentBaseHandle } from "~/modules/agent/directory/personal-agent"
import { isDemoModeEnabled, isPublicDemoInstance } from "~/modules/demo/demo-mode"
import {
  invalidateDemoMarker,
  loadDemoMarker,
  markOrgAsDemo,
  reservedMarker,
  visitorMarker,
} from "~/modules/demo/demo-org"
import { zeroDemoOrgPlatformCredit } from "~/modules/demo/demo-reset"
import {
  pinAgentModel,
  type SeededAgent,
  seedBaseAgent,
  seedPersonalAgent,
  upsertRoleAgent,
} from "~/seed/factories/agent/agents"
import { installApps, type SeededApp, seedSavedViewDefaults } from "~/seed/factories/org/apps"
import {
  claimOrgSlug,
  findOrgIdBySlug,
  hasOrgSlugClaim,
  provisionAdminAndRoles,
  provisionOrgShell,
  provisionPeople,
  releaseOrgSlugClaim,
} from "~/seed/factories/org/org"
import {
  orgUserIdsByEmail,
  setPeoplePassword,
  writePersonProfile,
} from "~/seed/factories/people/people"
import { grantRoleDimension } from "~/seed/factories/people/role-grants"
import {
  DEMO_DESK_TEAMS,
  DEMO_EMAIL_DOMAIN,
  DEMO_ROLE_AGENTS,
  DEMO_WORLD,
  type DemoPerson,
  type DemoRole,
  type DemoRoleAgent,
  type DemoWorld,
} from "~/seed/world/fiction"
import { demoModelPreference, demoModelPreferenceOverride } from "./model-preference"
import { DEMO_DOMAIN_ACCESS, demoScopesForRole } from "./role-scopes"

/**
 * The throwaway password the provisioning CLI is handed for the seven people.
 *
 * It is never published, never returned and never usable: `ensureUser` requires
 * one to CREATE a user at all, and the persona password pass below takes the
 * hash straight back off again the moment provisioning is done. Random per run so the window
 * between the two is not a window anybody can walk through.
 */
function throwawayPassword(): string {
  return `${randomBytes(24).toString("base64url")}aA1!`
}

export const DEMO_TIMEZONE = "Europe/Paris"
export const DEMO_LOCALE = "en"

/** The teams each desk role is granted (`DEMO_DESK_TEAMS` in the `products` world). */
export type DemoDeskTeams = Readonly<Record<Exclude<DemoRole, "founder_admin">, readonly string[]>>

/**
 * The mail domain a given demo org's people live on: one DNS label per org
 * under the world's reserved `.example` domain (`products`' by default).
 * Deterministic in the slug, so a re-seed of the same org resolves the same
 * people.
 */
export function demoOrgEmailDomain(orgSlug: string, worldDomain = DEMO_EMAIL_DOMAIN): string {
  const label =
    orgSlug
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "org"
  return `${label}.${worldDomain}`
}

/**
 * A persona's address IN THIS ORG. Unique per org on purpose: see the note at
 * the top of this file about `login()` and multi-org emails.
 */
export function demoPersonEmail(
  orgSlug: string,
  personKey: string,
  worldDomain = DEMO_EMAIL_DOMAIN,
): string {
  return `${personKey}@${demoOrgEmailDomain(orgSlug, worldDomain)}`
}

import { DEMO_APPS, DEMO_WORLD_APPS } from "./demo-apps"

export { DEMO_APPS }

/**
 * Liaison role name per world role. `founder_admin` maps onto the seeded
 * `admin` default role (scopes `*`); the rest are custom roles reconciled to
 * the scope bundle `role-scopes.ts` declares for that role.
 */
const ROLE_NAMES: Record<DemoRole, string> = {
  founder_admin: "admin",
  ops_lead: "operations",
  support: "support",
  fulfillment: "fulfillment",
  engineering: "engineering",
  finance: "finance",
  sales: "sales",
}

const ROLE_DESCRIPTIONS: Record<string, string> = {
  operations: "Runs the desk: support oversight, orders, shipping and the dealer queue",
  support: "Answers customer tickets and mail, and curates the knowledge base",
  fulfillment: "Prepares shipments and returns, and keeps stock accurate",
  engineering: "Builds the product and fixes the bugs support hands over",
  finance: "Issues invoices and credit notes, and owns the month end close",
  sales: "Looks after dealers and education accounts, and writes the quotes",
}

export type DemoOrgVariant = "reserved" | "visitor"

/** The one account a seeded demo org can be signed into with. */
export interface DemoOrgOwner {
  email: string
  name: string
  /** Used only when the account does not exist yet. Never returned. */
  password: string
}

export interface SeedDemoOrgOptions {
  orgSlug: string
  orgName?: string
  /**
   * `visitor` is a disposable org created on demand for the person who just
   * registered; nothing outside it may depend on its id and a reaper may delete
   * it whole. `reserved` is the single non-public org handed to Apple's Beta
   * App Review, which never expires and is re-seeded nightly. Same world, same
   * seed, one field apart.
   */
  variant: DemoOrgVariant
  /**
   * THE ONE ACCOUNT THAT CAN SIGN IN. The person this org belongs to: for a
   * visitor org the caller who registered, for the reserved org the App Review
   * account. They are created as the org's `admin`, which is the role the
   * founder persona used to hold, so they land in the seeded company as its
   * CEO and see all of it.
   *
   * Omitted only where no one is ever going to sign in (the nightly reset's
   * throwaway probe org). Then the org is seeded with NO loginable account at
   * all, which is the safe direction.
   *
   * `password` is used only to CREATE the account: `ensureUser` never resets an
   * existing one, so a re-seed cannot lock the owner out of their own org.
   */
  owner?: DemoOrgOwner
  /**
   * GIVE THE SEVEN PEOPLE A WORKING PASSWORD, instead of no password at all.
   *
   * The default (no password, see the note at the top of this file) is the only
   * safe shape for the public demo box, where the seven accounts would
   * otherwise be seven published logins on the open internet. It is the wrong
   * shape for a private QA box, where the reason the seeded world exists is
   * that a tester signs in AS the support agent and walks her desk.
   *
   * So this is refused outright on a public demo box (`isPublicDemoInstance`:
   * demo mode on, unless the box is declared private AND served on a loopback
   * BASE_URL), before a single row is written: a box that is the public demo
   * never gets to hand out persona logins, whatever its operator passes. Everywhere else it is an explicit,
   * per-run choice made on the command line (`--passwords <pw>`).
   *
   * It is applied as a straight `password_hash` rewrite rather than handed to
   * the provisioner, because `ensureUser` never resets an existing password:
   * an org seeded before the flag existed has to become reachable on a re-seed,
   * which is the only time anybody would reach for it.
   */
  personaPassword?: string
  /**
   * Reserved for the later batches: `seedDemoOrg` itself never writes domain
   * data. It is carried through to the result so a caller that asked for it can
   * see, in one value, that the org it got back still needs the domain pass.
   */
  includeDomainData?: boolean
  /** Defaults to `DEMO_WORLD`. Injectable so a test can seed a smaller world. */
  world?: DemoWorld
  /** The org's shared role agents. Defaults to the `products` world's `DEMO_ROLE_AGENTS`. */
  roleAgents?: readonly DemoRoleAgent[]
  /** The teams each desk role is granted. Defaults to the `products` world's `DEMO_DESK_TEAMS`. */
  deskTeams?: DemoDeskTeams
  /**
   * The reserved `.example` domain the world's people live under, one label per
   * org below it. Defaults to the `products` world's `DEMO_EMAIL_DOMAIN`.
   */
  emailDomain?: string
  /**
   * How long a `visitor` org's demo marker is valid for. Defaults to the demo
   * box's own `LIAISON_DEMO_VISITOR_TTL_HOURS`. Ignored for `reserved`, whose
   * marker never expires.
   */
  visitorTtlHours?: number
  locale?: string
  timezone?: string
  apps?: readonly string[]
  /**
   * SEED INTO AN ORG SOMEONE ELSE ALREADY MADE (a QA harness, a trial), rather
   * than one this seeder owns under `orgSlug`. `orgSlug` must then be that
   * org's slug. The org is never marked as a demo org (a marker makes its legal
   * records purgeable), its name, locale, timezone, credits and database domain
   * access stay as they are, and `adminUserId` (one of its admins) is the
   * account the provisioning acts as. A world person whose address already
   * belongs to a member of the org is ADOPTED in that seat: their password,
   * profile and roles stay, and they are given the seat's role on top, because
   * the world writes that seat's rows as them (under their own access). An
   * existing role of the same name as a world role is never rewritten.
   */
  existingOrg?: ExistingOrgTarget
  /**
   * Addresses for some of the world's people, by person key, instead of the
   * per-org `demoPersonEmail`: a caller's own team taking the world's seats.
   */
  personEmails?: Readonly<Record<string, string>>
  log?: (msg: string) => void
}

/** An org that exists already, and the admin who seeds it (see `existingOrg`). */
export interface ExistingOrgTarget {
  orgId: string
  adminUserId: string
}

export interface SeededPerson {
  key: string
  name: string
  /** The address in THIS org (`<key>@<org slug>.resonantaudiolabs.example`). */
  email: string
  jobTitle: string
  bio: string
  /** World role (`support`, `finance`, ...). */
  role: DemoRole
  /** Liaison role name the user is assigned to (`admin`, `support`, ...). */
  roleName: string
  userId: string
  /** The user's own `Liaison` agent (kind `personal`). */
  personalAgentId: string
  avatarKey: string | null
  avatarUrl: string | null
}

export interface SeedDemoOrgResult {
  orgId: string
  orgSlug: string
  orgName: string
  variant: DemoOrgVariant
  locale: string
  timezone: string
  /** False on a re-run: the org was already there. */
  createdOrg: boolean
  /** The owner's user id, or null when the seed was asked for no owner. */
  ownerUserId: string | null
  /** The founder persona. An `admin` by role, and passwordless like the rest. */
  adminUserId: string
  people: SeededPerson[]
  peopleByKey: Record<string, SeededPerson>
  agents: SeededAgent[]
  agentsByHandle: Record<string, SeededAgent>
  apps: SeededApp[]
  appsByName: Record<string, SeededApp>
  /** Apps that refused to install or enable. Empty on a healthy seed. */
  failedApps: string[]
  /** The world this org was seeded from: the later batches read it for content. */
  world: DemoWorld
  /** What the caller asked for; this seeder never writes domain data itself. */
  domainDataRequested: boolean
}

/**
 * The provisioning config for one demo org.
 *
 * THE ORG'S ADMIN IS ITS OWNER, not one of the seven. `config.admin` is the
 * account the org is created around, and it used to be the founder persona,
 * which is how a published password ended up holding `*` scopes on a public
 * box. The caller's own account takes that seat now and the founder is demoted
 * to an ordinary (passwordless) entry in `users[]`, still carrying the `admin`
 * ROLE so the seeded world reads as hers.
 *
 * With no owner the founder keeps the seat, on a throwaway password that is
 * nulled with everyone else's: an org nobody can sign into.
 */
function buildConfig(
  opts: Required<Pick<SeedDemoOrgOptions, "orgSlug">> & {
    orgName: string
    locale: string
    timezone: string
    world: DemoWorld
    owner: DemoOrgOwner | null
    password: string
    /** The address of a world person in this org. */
    emailOf: (key: string) => string
    /** Role names the org already has: never provisioned (so never rewritten). */
    existingRoles?: ReadonlySet<string>
    /**
     * Write the world company's commercial identity on the org. Only for an org
     * the seed owns: an existing org's identity is its owner's to state.
     */
    commercialIdentity?: boolean
  },
): { config: ProvisioningConfig; admin: DemoPerson } {
  const admin = opts.world.team.find((p) => p.role === "founder_admin")
  if (!admin) throw new Error("seedDemoOrg: the world has no founder_admin to own the org")

  const provisioned = opts.world.team
  const customRoles = [...new Set(provisioned.map((p) => p.role))]
    .filter((role) => ROLE_NAMES[role] !== "admin")
    .filter((role) => !opts.existingRoles?.has(ROLE_NAMES[role]))
    .map((role) => ({
      name: ROLE_NAMES[role],
      description: ROLE_DESCRIPTIONS[ROLE_NAMES[role]] ?? ROLE_NAMES[role],
      scopes: demoScopesForRole(role),
    }))

  const config: ProvisioningConfig = {
    org: {
      slug: opts.orgSlug,
      name: opts.orgName,
      timezone: opts.timezone,
      defaultLocale: opts.locale,
      // NO PLATFORM CREDIT, EVER. This used to hand every demo org 25 EUR of
      // real balance on create, spendable by whoever was handed the org. A demo
      // org runs on the owner's own model key and nothing else.
      // `zeroDemoOrgPlatformCredit` below is the second line, for an org some
      // other provisioning path already funded.
      credits: { currency: "EUR", initial: "0" },
    },
    ...(opts.commercialIdentity
      ? { email: { commercialIdentity: demoCommercialIdentity(opts.world.company) } }
      : {}),
    admin: opts.owner
      ? { email: opts.owner.email, name: opts.owner.name, password: opts.owner.password }
      : {
          email: opts.emailOf(admin.key),
          name: admin.name,
          password: opts.password,
        },
    roles: customRoles,
    users: provisioned
      .filter((p) => opts.owner !== null || p.key !== admin.key)
      .map((p) => ({
        email: opts.emailOf(p.key),
        name: p.name,
        role: ROLE_NAMES[p.role],
        mode: "create" as const,
        password: opts.password,
      })),
  }
  return { config, admin }
}

/**
 * What the world company's mail states about its sender (the commercial
 * footer): its legal name and postal address, as a real company records them.
 * Without them the mail app refuses to stage any business mail, so a seeded
 * org that should behave like a company carries them.
 */
export function demoCommercialIdentity(company: DemoWorld["company"]): CommercialIdentity {
  const country = new Intl.DisplayNames(["en"], { type: "region" }).of(company.country)
  return {
    legalName: company.legalName,
    postalAddress: `${company.addressLine1}, ${company.postalCode} ${company.city}, ${country ?? company.country}`,
  }
}

/** The ticket team dimension a desk's grant is written under. */
export const DESK_TEAM_DIMENSION = "tickets:team"

/**
 * THE DESK'S TEAM RIDES ON THE DESK'S ROLE.
 *
 * Every seeded ticket is tagged with a team, and RLS shows a team-tagged
 * ticket only to someone holding that team, so a desk person with no
 * `tickets:team` grant saw an empty queue while the admin saw everything. Each
 * desk role is granted the teams `DEMO_DESK_TEAMS` names for it, and every
 * person holds it through their role.
 *
 * On the ROLE rather than on each person because the nightly reset clears
 * `user_dimension_grants` (a visitor could have written one) AFTER this seeder
 * runs, while `role_dimension_grants` hang off `roles`, which the reset keeps
 * and the seed converges. Desired state: a role whose grant already lists
 * exactly its desk's teams is left alone (no permission bump on a no-op
 * re-seed); anything else, including a grant a visitor widened or narrowed, is
 * rewritten to the desk's teams. Runs after the apps are registered (the
 * `tickets:team` dimension is the tickets app's) and before the agents, whose
 * ceilings snapshot their owners' grants.
 */
async function grantDeskTeams(
  orgId: string,
  adminUserId: string,
  team: readonly DemoPerson[],
  deskTeams: DemoDeskTeams,
  log: (msg: string) => void,
): Promise<void> {
  const deskRoles = [...new Set(team.map((p) => p.role))].filter(
    (role): role is Exclude<DemoRole, "founder_admin"> => role !== "founder_admin",
  )
  await grantRoleDimension(
    orgId,
    adminUserId,
    DESK_TEAM_DIMENSION,
    deskRoles.map((role) => [ROLE_NAMES[role], deskTeams[role]] as const),
    "seedDemoOrg",
    log,
  )
}

/**
 * The demo warehouse's confidential domains (revenue, dealers, customers), each
 * run for the roles `DEMO_DOMAIN_ACCESS` names: the database app's provision
 * block (roles by name), applied by the warehouse layer once the app is there.
 */
export function demoDomainAccessProvision(): {
  domainAccess: Record<string, { tier: "confidential"; roles: string[] }>
} {
  return {
    domainAccess: Object.fromEntries(
      Object.entries(DEMO_DOMAIN_ACCESS).map(([domain, demoRoles]) => [
        domain,
        { tier: "confidential" as const, roles: demoRoles.map((role) => ROLE_NAMES[role]) },
      ]),
    ),
  }
}

/**
 * Pin one seeded agent to the box's model override, when the box names one.
 *
 * A personal agent is created by `getOrCreatePersonalAgentId`, which is the
 * product's own call and knows nothing about the demo world, so the override
 * is applied here rather than threaded through it. A no-op on every box that
 * names no override, which is every box but a QA one.
 */
async function applyDemoModelPreference(agentId: string): Promise<void> {
  const pinned = demoModelPreferenceOverride()
  if (!pinned) return
  await pinAgentModel(agentId, pinned)
}

/**
 * Create the org's shared role agents. Mirrors what `POST /api/agents` writes
 * (same columns, same `(orgId, handle)` conflict target), so a re-seed adopts
 * the agent already answering under the handle instead of duplicating it.
 */
async function seedRoleAgents(
  orgId: string,
  roleAgents: readonly DemoRoleAgent[],
  log: (msg: string) => void,
): Promise<SeededAgent[]> {
  const seeded: SeededAgent[] = []
  for (const def of roleAgents) {
    // The box may pin every demo agent to one model (a QA box does, so its
    // spend is bounded); unset, the agent keeps the model the world names. The
    // factory writes the same value on insert AND on conflict.
    const modelPreference = demoModelPreference(def.modelPreference)
    const agent = await upsertRoleAgent(orgId, {
      handle: def.handle,
      displayName: def.displayName,
      purpose: def.purpose,
      systemPrompt: def.systemPrompt,
      // The role bundle is written for the human roles; the factory drops the
      // scopes nothing declares before it becomes a ceiling.
      scopes: demoScopesForRole(def.scopeRole),
      toolAllowlist: def.toolAllowlist,
      modelPreference,
    })
    log(`agent '${def.handle}': ready`)
    seeded.push(agent)
  }
  return seeded
}

/**
 * Why the seeder may NOT write the demo marker on an org, or null when it may.
 * The marker makes an org's legal records purgeable at expiry, so it goes only
 * on an org that already carries it or that this seeding run created itself.
 */
export function demoMarkRefusal(input: {
  orgSlug: string
  hasMarker: boolean
  createdThisRun: boolean
}): string | null {
  if (input.hasMarker || input.createdThisRun) return null
  return (
    `seedDemoOrg: refusing to seed '${input.orgSlug}': an organization already exists ` +
    `under that slug, it is NOT a demo org and this run did not create it. Seeding it ` +
    `would mark a real workspace as a demo org, and its legal records would be purged ` +
    `at expiry. Use another slug, or delete the org first if it really is a demo leftover.`
  )
}

/**
 * A run killed between creating the org and marking it (the window
 * `claimOrgSlug` covers) left a half-made org under the slug: no marker, no
 * people, perhaps not even its default roles. Its claim says it is this
 * seeder's own, so it is deleted and the run makes it again from nothing.
 * Returns true when it cleared one. An org that carries the marker is a normal
 * re-seed (its stale claim is released); one without a claim is never touched.
 */
async function clearInterruptedOrg(
  orgSlug: string,
  orgId: string,
  log: (msg: string) => void,
): Promise<boolean> {
  if (!(await hasOrgSlugClaim(orgSlug))) return false
  await invalidateDemoMarker(orgId)
  if (await loadDemoMarker(orgId)) {
    await releaseOrgSlugClaim(orgSlug)
    return false
  }
  const { purgeOrg } = await import("~/modules/org/purge/purge-org")
  await purgeOrg(orgId, {
    reason: "seed-interrupted-org",
    // Re-checked before every destructive step: still claimed, still unmarked.
    assertAllowed: async (id) => {
      await invalidateDemoMarker(id)
      if (!(await hasOrgSlugClaim(orgSlug)) || (await loadDemoMarker(id))) {
        throw new Error(`seedDemoOrg: '${orgSlug}' is no longer an interrupted seed's org`)
      }
    },
    settle: false,
    verify: false,
    regenerateTriggers: false,
  })
  log(`org '${orgSlug}': cleared the half-made org an interrupted seed left, making it again`)
  return true
}

export async function seedDemoOrg(opts: SeedDemoOrgOptions): Promise<SeedDemoOrgResult> {
  const world = opts.world ?? DEMO_WORLD
  const owner = opts.owner ?? null
  const password = throwawayPassword()
  const locale = opts.locale ?? DEMO_LOCALE
  const timezone = opts.timezone ?? DEMO_TIMEZONE
  const orgName = opts.orgName ?? world.company.legalName
  const appNames = opts.apps ?? DEMO_WORLD_APPS.products
  const log = opts.log ?? (() => {})

  // BEFORE ANY WRITE. A demo box may not hand out persona logins, and an
  // operator who asked for them on one has to be told so with the workspace
  // still exactly as it was.
  const personaPassword = opts.personaPassword?.trim() ?? ""
  if (personaPassword !== "" && isPublicDemoInstance()) {
    throw new Error(
      "seedDemoOrg: refusing to give the seeded people passwords on a public demo box. " +
        "Those seven accounts are public there, and a shared password on them is a front door. " +
        "Seed without the passwords flag, or declare a private QA box (LIAISON_PRIVATE_DEMO_BOX " +
        "with a loopback BASE_URL), or turn demo mode off there.",
    )
  }

  const emailOf = (key: string): string =>
    (opts.personEmails?.[key] ?? demoPersonEmail(opts.orgSlug, key, opts.emailDomain)).toLowerCase()

  // An org someone else made: read what it is, write nothing about it.
  const target = opts.existingOrg ? await readExistingOrg(opts.existingOrg, opts.orgSlug) : null

  let existingOrgId = target ? target.orgId : await findOrgIdBySlug(opts.orgSlug)
  if (
    !target &&
    existingOrgId !== null &&
    (await clearInterruptedOrg(opts.orgSlug, existingOrgId, log))
  ) {
    existingOrgId = null
  }
  const createdOrg = existingOrgId === null
  if (createdOrg) await claimOrgSlug(opts.orgSlug)

  // ── THE ADOPTION GUARD ───────────────────────────────────────────────────
  //
  // An org that already exists under this slug is adopted: the provisioning
  // passes below update it in place, the marker is stamped on it and, when the
  // caller asked for a reset, its content is deleted. That is exactly right for
  // an org this seeder made, and catastrophic for one it did not.
  //
  // So an existing org is adopted only when the ROW ITSELF says it is a demo
  // org, read fresh out of Postgres (`invalidateDemoMarker` first, because the
  // request path cache is a value some other code path wrote and this is the
  // one read that must not trust it). There is no override: the marker makes
  // an org's legal records purgeable at expiry, so it is only ever written on
  // an org that already carries it or that this run created (checked again,
  // against what the org pass actually did, right before the marker lands).
  // A variant change is refused for the same reason, but in ONE direction
  // only: demoting the reserved org to a `visitor` org would hand it to the
  // nightly reaper. The other direction is allowed, because it can only ever
  // make a workspace safer rather than disposable.
  if (!target && existingOrgId !== null) {
    const adoptedId = existingOrgId
    invalidateDemoMarker(adoptedId)
    const existingMarker = await loadDemoMarker(adoptedId)
    const refusal = demoMarkRefusal({
      orgSlug: opts.orgSlug,
      hasMarker: existingMarker !== null,
      createdThisRun: false,
    })
    if (refusal) throw new Error(refusal)
    if (existingMarker?.variant === "reserved" && opts.variant === "visitor") {
      throw new Error(
        `seedDemoOrg: refusing to seed '${opts.orgSlug}' as a 'visitor' org: it is already a ` +
          `'reserved' demo org, and demoting it would hand the App Review workspace to the ` +
          `nightly reaper.`,
      )
    }
  }

  // In an existing org its admin is the account the passes act as (created
  // already, so `ensureUser` leaves it as it is), and the org's own settings
  // are handed back unchanged.
  const { config } = buildConfig({
    orgSlug: opts.orgSlug,
    orgName: target ? target.orgName : orgName,
    locale: target ? target.locale : locale,
    timezone: target ? target.timezone : timezone,
    world,
    owner: target ? { ...target.admin, password } : owner,
    password,
    emailOf,
    ...(target ? { existingRoles: target.roleNames } : { commercialIdentity: true }),
  })

  // org, then admin and roles, then people, through the org factory (the
  // provisioning CLI's own provisioners, three idempotent passes; see
  // factories/org/org.ts for why the people come last).
  //
  // `apps` is deliberately in no pass: the demo installs them below one at a
  // time so a single refusing bundle leaves the rest of the org seeded and is
  // reported rather than aborting the seed.
  const { users: userEntries, ...configWithoutUsers } = config

  // THREE passes, not two: the org alone first, so the demo marker below is
  // written before the admin provisioner creates the first account. An org that
  // has a person in it is an org somebody can sign into, and demo mode's
  // restrictions are all keyed on the marker.
  const markedOrgId = target ? target.orgId : await markNewDemoOrg(configWithoutUsers, opts, log)

  await provisionAdminAndRoles(configWithoutUsers, "seedDemoOrg", log)
  await provisionPeople(configWithoutUsers, userEntries ?? [], "seedDemoOrg", log)

  const orgId = markedOrgId
  const adopted = target?.memberEmails ?? new Set<string>()
  const idByEmail = await orgUserIdsByEmail(orgId)

  const people: SeededPerson[] = []
  for (const person of world.team) {
    const email = emailOf(person.key)
    const userId = idByEmail.get(email)
    if (!userId) throw new Error(`seedDemoOrg: user '${email}' missing after provisioning`)
    people.push({
      key: person.key,
      name: person.name,
      email,
      jobTitle: person.jobTitle,
      bio: person.bio,
      role: person.role,
      roleName: ROLE_NAMES[person.role],
      userId,
      personalAgentId: "",
      avatarKey: null,
      avatarUrl: null,
    })
  }
  return seedDemoOrgPeople({
    opts,
    world,
    orgId,
    orgName: target ? target.orgName : orgName,
    locale: target ? target.locale : locale,
    timezone: target ? target.timezone : timezone,
    createdOrg,
    people,
    idByEmail,
    owner: target ? null : owner,
    adopted,
    existingRoles: target?.roleNames ?? new Set<string>(),
    existingOrg: target !== null,
    appNames,
    personaPassword,
    log,
  })
}

/** What an existing org is, read before the seed touches it (see `existingOrg`). */
interface ExistingOrgFacts {
  orgId: string
  orgName: string
  locale: string
  timezone: string
  admin: { email: string; name: string }
  /** Lower-cased addresses of the org's members. */
  memberEmails: ReadonlySet<string>
  roleNames: ReadonlySet<string>
}

async function readExistingOrg(
  target: ExistingOrgTarget,
  orgSlug: string,
): Promise<ExistingOrgFacts> {
  const [org] = await withSystemDb("seed-demo-existing-org", (tx) =>
    tx
      .select({
        slug: organizations.slug,
        name: organizations.name,
        timezone: organizations.timezone,
        defaultLocale: organizations.defaultLocale,
      })
      .from(organizations)
      .where(eq(organizations.id, target.orgId))
      .limit(1),
  )
  if (!org) throw new Error(`seedDemoOrg: no org ${target.orgId} to seed into`)
  if (org.slug !== orgSlug) {
    throw new Error(`seedDemoOrg: org ${target.orgId} is '${org.slug}', not '${orgSlug}'`)
  }
  const members = await withSystemDb("seed-demo-existing-members", (tx) =>
    tx
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(eq(users.orgId, target.orgId)),
  )
  const admin = members.find((m) => m.id === target.adminUserId)
  if (!admin) {
    throw new Error(`seedDemoOrg: user ${target.adminUserId} is not a member of ${orgSlug}`)
  }
  const adminRoles = await withSystemDb("seed-demo-existing-admin", (tx) =>
    tx
      .select({ name: roles.name })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(and(eq(userRoles.userId, admin.id), eq(roles.orgId, target.orgId))),
  )
  if (!adminRoles.some((r) => r.name === "admin")) {
    throw new Error(`seedDemoOrg: ${admin.email} is not an admin of ${orgSlug}`)
  }
  const roleRows = await withSystemDb("seed-demo-existing-roles", (tx) =>
    tx.select({ name: roles.name }).from(roles).where(eq(roles.orgId, target.orgId)),
  )
  return {
    orgId: target.orgId,
    orgName: org.name,
    locale: org.defaultLocale ?? DEMO_LOCALE,
    timezone: org.timezone ?? DEMO_TIMEZONE,
    admin: { email: admin.email, name: admin.name ?? admin.email },
    memberEmails: new Set(members.map((m) => m.email.toLowerCase())),
    roleNames: new Set(roleRows.map((r) => r.name)),
  }
}

/**
 * The org pass and the demo marker, for an org this seeder owns under its slug.
 * Returns the org's id.
 */
async function markNewDemoOrg(
  configWithoutUsers: Omit<ProvisioningConfig, "users">,
  opts: SeedDemoOrgOptions,
  log: (msg: string) => void,
): Promise<string> {
  const orgShell = await provisionOrgShell(configWithoutUsers, "seedDemoOrg", log)

  // THE DEMO MARKER, as early as it can possibly be written: the org row now
  // exists (the org pass created it) and not one account exists to log into it.
  // Everything demo mode restricts (`assertDemoEgressAllowed`, the spend
  // ceiling) returns on line one for an unmarked org, so an unmarked demo org
  // is a workspace with real SMTP, real connector credentials and no token
  // ceiling. The seeder is the only component that knows at creation time that
  // this org is a demo org, so it writes the marker itself rather than hoping a
  // caller remembers to.
  //
  // A marker already on the org, of the same variant, is kept as it stands: a
  // re-seed tops an org up, it does not restart its clock, so a visitor org
  // cannot outlive its TTL by being re-seeded and the marker is a stable value
  // a content-level idempotency check can compare.
  //
  // And only on an org that is already a demo org or that THIS run created. The
  // lookup above ran before the org pass, so it is checked again here against
  // what the pass did (`org.created` comes from the insert itself) and a fresh
  // read of the row: an org that appeared under this slug in between, or lost
  // its marker in between, is refused rather than made purgeable.
  const markedOrgId = orgShell.orgId
  invalidateDemoMarker(markedOrgId)
  const existingMarker = await loadDemoMarker(markedOrgId)
  const markRefusal = demoMarkRefusal({
    orgSlug: opts.orgSlug,
    hasMarker: existingMarker !== null,
    createdThisRun: orgShell.created,
  })
  if (markRefusal) throw new Error(markRefusal)
  const marker =
    existingMarker?.variant === opts.variant
      ? existingMarker
      : opts.variant === "reserved"
        ? reservedMarker()
        : visitorMarker(opts.visitorTtlHours ?? env.LIAISON_DEMO_VISITOR_TTL_HOURS)
  await markOrgAsDemo(markedOrgId, marker)
  await releaseOrgSlugClaim(opts.orgSlug)
  log(`org '${opts.orgSlug}': marked as a ${opts.variant} demo org`)

  // NO PLATFORM CREDIT ON ANY SEEDING PATH. The config above asks for zero, but
  // `ensureOrg` only initialises credits when it CREATES an org, so an org some
  // other path created (the signup route makes the org itself, and an operator
  // may have topped one up) would keep whatever balance it was handed. This
  // runs on every seed, right after the marker lands, and is keyed on the org
  // rather than on `LIAISON_DEMO_MODE`: seeding a demo org on a box whose demo
  // flag is off must not leave spendable money behind either.
  await zeroDemoOrgPlatformCredit(markedOrgId)

  // THE RESERVED ORG APPROVES TICKET REPLIES FROM HOME. Its review notes walk
  // the reviewer through approving a drafted customer reply from the Home
  // screen, which the tickets app only offers when this org setting is on.
  // Written here, on every seed, through the provisioning CLI's own writer, so
  // the setting survives a reset, a reviewer turning it off and a new box. A
  // visitor org keeps the product default.
  if (opts.variant === "reserved") {
    await writeApproveRepliesFromHome(
      (reason, fn) => withPrivilegedDb(markedOrgId, reason, fn),
      markedOrgId,
      true,
    )
  }
  return markedOrgId
}

/** Everything after the people exist: passwords, apps, grants, agents, profiles. */
async function seedDemoOrgPeople(input: {
  opts: SeedDemoOrgOptions
  world: DemoWorld
  orgId: string
  orgName: string
  locale: string
  timezone: string
  createdOrg: boolean
  people: SeededPerson[]
  idByEmail: Map<string, string>
  owner: DemoOrgOwner | null
  /** Members adopted in their seats: their password and profile stay theirs. */
  adopted: ReadonlySet<string>
  existingRoles: ReadonlySet<string>
  existingOrg: boolean
  appNames: readonly string[]
  personaPassword: string
  log: (msg: string) => void
}): Promise<SeedDemoOrgResult> {
  const { opts, world, orgId, orgName, locale, timezone, createdOrg, people, idByEmail } = input
  const { owner, adopted, appNames, personaPassword, log } = input
  const admin = people.find((p) => p.role === "founder_admin")
  if (!admin) throw new Error("seedDemoOrg: no founder_admin among the seeded people")

  const ownerUserId = owner ? (idByEmail.get(owner.email.toLowerCase()) ?? null) : null
  if (owner && !ownerUserId) {
    throw new Error(`seedDemoOrg: owner '${owner.email}' missing after provisioning`)
  }

  // ── THE SEVEN PEOPLE CANNOT BE SIGNED IN AS ──────────────────────────────
  //
  // They exist so the workspace reads as a company: they author tickets, hold
  // assignments, sit in threads and appear in the directory. None of that needs
  // a credential, and a credential is what turned one org's seven accounts into
  // a front door for anybody who found the password. `ensureUser` requires a
  // password to CREATE a row at all, so the provisioning passes above wrote a
  // throwaway hash and this takes it straight back off: `password_hash` null is
  // the shape `login()` already refuses, so there is no password to guess, to
  // publish or to change.
  //
  // The OWNER is exempt: theirs is the one account the org is signed into with.
  //
  // ...UNLESS THIS IS A PRIVATE QA BOX AND THE OPERATOR ASKED. See
  // `SeedDemoOrgOptions.personaPassword`: the refusal at the top of this
  // function has already established that demo mode is off.
  const personaIds = people
    .filter((p) => !adopted.has(p.email))
    .map((p) => p.userId)
    .filter((id) => id !== ownerUserId)
  await setPeoplePassword(orgId, personaIds, personaPassword === "" ? null : personaPassword)
  log(
    personaPassword === ""
      ? `org '${opts.orgSlug}': ${personaIds.length} seeded people left with no password`
      : `org '${opts.orgSlug}': ${personaIds.length} seeded people given the supplied QA password`,
  )

  const apps = await installApps(orgId, admin.userId, appNames, log)

  // Shopify is the one app with no local mirror: its entities are declared
  // `external: true`, so every screen is a live GraphQL call and seeded rows
  // would render nothing. A demo org therefore gets a connection whose token is
  // an internal sentinel, which the demo provider answers from fixtures and
  // never puts on the wire. `home_load` needs the shop domain to return a
  // bundle at all, and boxtal's `to_prepare_list`, the operator's main screen,
  // derives its rows from a live Shopify order scan: without this both are
  // empty. The installer also resets the per org write overlay, which is what
  // makes a re-seed a true reset rather than an adoption of whatever the last
  // visitor did.
  //
  // Gated on the app being ENABLED for the org, not on `installed`: that flag
  // only says the app came from the baked catalog, and an instance whose apps
  // were installed any other way (a dev or test box installing from each app's
  // own build) enables Shopify all the same and then rendered it empty.
  if (apps.some((a) => a.name === "shopify" && a.enabled)) {
    const { installDemoShopifyConnection } = await import("~/modules/demo/shopify")
    await installDemoShopifyConnection({ orgId, createdByUserId: admin.userId })
    log("app 'shopify': demo fixture connection installed, write overlay reset")
  }

  // The API connector gets the fixture CRM as its one connection, for the same
  // reason as Shopify: demo mode refuses adapter uploads and credentials, so
  // without it the customer card and the connector tools have nothing to show.
  // The adapter and the sentinel key are fixed constants, and the fixture
  // origin is answered in-process for demo orgs only (never put on the wire).
  // Only the demo instance answers that origin: anywhere else the connection
  // would point at a host that does not resolve, and every read would fail, so
  // none is seeded there.
  if (isDemoModeEnabled() && apps.some((a) => a.name === "api-connector" && a.enabled)) {
    const { installDemoApiConnectorConnection } = await import("~/modules/demo/api-connector")
    const conn = await installDemoApiConnectorConnection({ orgId, createdByUserId: admin.userId })
    log(`app 'api-connector': demo fixture connection '${conn.identifier}' installed`)
  }

  // Boxtal gets a sentinel connection for the same reason: without one every
  // quote says "Boxtal not connected", and the commerce scenario cannot stage
  // its order's label. Its keys are fixed constants, and for a demo org every
  // Boxtal host is answered in-process (or refused), never put on the wire,
  // so no carrier is ever booked.
  if (apps.some((a) => a.name === "boxtal" && a.enabled)) {
    const { installDemoBoxtalConnection } = await import("~/modules/demo/boxtal")
    await installDemoBoxtalConnection({ orgId, createdByUserId: admin.userId })
    log("app 'boxtal': demo fixture connection installed")
  }

  // Saved views the manifests declare, the same post-bootstrap step a first
  // registration runs. Idempotent; needs the apps registered first.
  await seedSavedViewDefaults(orgId)

  // Only the desk roles this seed made carry its grants; an existing org's own
  // roles stay as its admins set them.
  await grantDeskTeams(
    orgId,
    admin.userId,
    world.team.filter((p) => !input.existingRoles.has(ROLE_NAMES[p.role])),
    opts.deskTeams ?? DEMO_DESK_TEAMS,
    log,
  )

  // Agents last: a personal agent's ceiling is a snapshot of its owner's
  // grants, so every role and app scope has to be in place before it is cut.
  const seededAgents: SeededAgent[] = [await seedBaseAgent(orgId)]

  for (const person of people) {
    const agent = await seedPersonalAgent(orgId, person.userId, personalAgentBaseHandle(person.key))
    person.personalAgentId = agent.agentId
    seededAgents.push({ ...agent, kind: "personal", ownerKey: person.key })
  }

  // The owner is not in `people`: `people` is the fictional staff, and when
  // `opts.owner` is set the owner is a separate account layered on top (the App
  // Review reviewer on the reserved org, or whoever registered a visitor one).
  // So the loop above, which walks `people`, skips the ONE account the org is
  // ever signed into with. Without this the reviewer opens the product on a
  // chat with nobody in it, which is not the product. The visitor path patches
  // this itself in `demo/routes.ts`; doing it here covers both, and
  // `getOrCreatePersonalAgentId` makes the overlap a no-op.
  if (ownerUserId && !people.some((p) => p.userId === ownerUserId)) {
    const agent = await seedPersonalAgent(orgId, ownerUserId, "@owner")
    // The owner's agent is the one a QA tester actually chats with, so the
    // box's model pin has to reach it too, not only the role desks.
    await applyDemoModelPreference(agent.agentId)
    seededAgents.push({ ...agent, kind: "personal" })
    log(`org '${opts.orgSlug}': owner given their own personal agent`)
  }

  seededAgents.push(...(await seedRoleAgents(orgId, opts.roleAgents ?? DEMO_ROLE_AGENTS, log)))

  for (const person of people) {
    if (adopted.has(person.email)) continue
    const { avatarKey, avatarUrl } = await writePersonProfile(orgId, person.userId, {
      jobTitle: person.jobTitle,
      bio: person.bio,
      personKey: person.key,
    })
    person.avatarKey = avatarKey
    person.avatarUrl = avatarUrl
  }

  return {
    orgId,
    orgSlug: opts.orgSlug,
    orgName,
    variant: opts.variant,
    locale,
    timezone,
    createdOrg,
    ownerUserId,
    adminUserId: admin.userId,
    people,
    peopleByKey: Object.fromEntries(people.map((p) => [p.key, p])),
    agents: seededAgents,
    agentsByHandle: Object.fromEntries(seededAgents.map((a) => [a.handle, a])),
    apps,
    appsByName: Object.fromEntries(apps.map((a) => [a.name, a])),
    failedApps: apps.filter((a) => a.error !== undefined).map((a) => a.name),
    world,
    domainDataRequested: opts.includeDomainData === true,
  }
}
