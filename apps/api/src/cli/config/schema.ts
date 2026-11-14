// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Authoritative Zod schema for the v1 provisioning config (spec §4) plus
 * `validateConfig`, which enforces shape + the plan-time invariants that must
 * fail BEFORE any write.
 *
 * This is the CLI INPUT contract — deliberately independent of the DB settings
 * contracts (`org.ts` / `org-kernel-settings.ts`). The top level is strict so a
 * typo'd section name is a clean usage error (exit 2) rather than a silent
 * skip.
 *
 * Role names (`users[].role`) and `${ENV}` resolution are NOT validated here —
 * roles are checked against `kernel.roles` at plan time (the users provisioner),
 * env interpolation is `parse.ts`.
 */
import { commercialIdentitySchema, googleOAuthClientIdSchema, orgCapsSchema } from "@liaison/shared"
import { z } from "zod"
import { MAIL_PROVIDER_IDS } from "~/modules/mail/provider-ids"

/**
 * The IMAP credential field names this config models. Kept as a const tuple so
 * (a) the Zod `imap` object is built from a single source of truth and (b) the
 * manifest-parity test can assert these are a subset of both the mail and the
 * tickets manifests' `connections.imap.credentialFields[].name`.
 */
export const imapCredentialFieldNames = [
  "email",
  "imapHost",
  "imapPort",
  "smtpHost",
  "smtpPort",
  "username",
  "password",
] as const

const creditsSchema = z
  .object({
    currency: z.string().optional(),
    initial: z.string().optional(),
  })
  .optional()

const orgSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  timezone: z.string().optional(),
  defaultLocale: z.string().optional(),
  credits: creditsSchema,
  // Administrators must use two-step verification (an admin without it gets a
  // session that can only set it up). Absent leaves the org's setting as it is.
  requireAdminSecondFactor: z.boolean().optional(),
})

// `password` is optional: without one the owner signs in passwordless, with an
// emailed code (logged to the app's stdout when SMTP is not configured), exactly
// as after the browser's first Register.
const adminSchema = z
  .object({
    email: z.string().min(1),
    name: z.string().min(1),
    password: z.string().min(1).optional(),
  })
  .optional()

const userSchema = z
  .object({
    email: z.string().min(1),
    name: z.string().min(1),
    // role NAME (validated against kernel.roles at plan time, not here).
    role: z.string().min(1),
    mode: z.enum(["invite", "create"]).default("invite"),
    password: z.string().min(1).optional(),
  })
  .refine((u) => u.mode !== "create" || (u.password !== undefined && u.password.length > 0), {
    message: "password is required when mode is 'create'",
    path: ["password"],
  })

// A named role and the exact set of scopes it should grant. The roles
// provisioner reconciles the live role to this set (missing scopes granted,
// extra scopes revoked), so the config is the desired state. `users[].role`
// references a role by `name`. Scopes are hierarchical `app:resource:action`
// strings — granting `app:*` (or omitting an app's scopes entirely) is how an
// admin includes (or withholds) a whole app from a role, e.g. an `ops` role
// that omits `pennylane:*` / `ads:*` keeps those apps off that role's
// surface AND blocks their tools.
export const roleSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  scopes: z.array(z.string().min(1)),
})

const byokEntrySchema = z.object({
  apiKey: z.string().min(1),
  validate: z.boolean().optional(),
})

const apiKeySchema = z.object({
  label: z.string().min(1),
  // Supplied → upsert by key_hash; omitted → generated + emitted once.
  key: z.string().min(1).optional(),
  allowedOrigins: z.array(z.string()).optional(),
})

/**
 * What the person chose to set up (`setup.features`): the onboarding asks
 * before any connector, and `liaison setup state` / the agent's `setup_state`
 * count only these as left (connection-guides/setup-features.ts lists the ids).
 */
export const setupSchema = z
  .object({
    features: z.array(z.string().min(1)),
  })
  .strict()
  .optional()

export const emailSchema = z
  .object({
    from: z.string().optional(),
    replyTo: z.string().optional(),
    // The legal name and postal address every commercial mail states (its footer).
    commercialIdentity: commercialIdentitySchema.optional(),
  })
  .optional()

/**
 * A person's IMAP connection is re-connect-replaces keyed on (org, app,
 * connection, owner), not on the address (`createCredentialConnection`), so a
 * second IMAP box for the same person in the same app would silently overwrite
 * the first. An org mailbox is keyed on its address too: an org holds several.
 */
export const IMAP_ONE_PER_OWNER_MESSAGE =
  "at most one personal IMAP mailbox per owner is supported: a second IMAP connection for the " +
  "same person replaces the first one"

/** `ownerOf` names the person; an entry with no owner is the org's and is not limited here. */
export function atMostOneImapPerOwner<T extends { provider: string }>(
  list: T[],
  ownerOf: (entry: T) => string | undefined,
): boolean {
  const owners = list
    .filter((m) => m.provider === "imap")
    .map(ownerOf)
    .filter((owner) => owner !== undefined)
  return new Set(owners).size === owners.length
}

// IMAP credentials. The field names MUST match the `imap` connection's
// credentialFields in BOTH the mail and the tickets manifests (they declare the
// same set). Ports are accepted as numbers here (the YAML/JSON native shape);
// the provisioners stringify them before handing to createCredentialConnection.
export const imapSchema = z.object({
  email: z.string().min(1),
  imapHost: z.string().min(1),
  imapPort: z.number(),
  smtpHost: z.string().min(1),
  smtpPort: z.number(),
  username: z.string().min(1),
  password: z.string().min(1),
})

const googleClientSchema = z.object({
  // A Google OAuth client id, ending in ".apps.googleusercontent.com": an id
  // from another provider's app (a Shopify client id) is refused before anything is saved.
  clientId: z.string().pipe(googleOAuthClientIdSchema),
  clientSecret: z.string().min(1),
})

/**
 * A MAIL app mailbox: a box people read and send from in the Mail app. It never
 * creates a ticket inbox. `owner` omitted means a shared (org-owned) mailbox;
 * `owner: <member email>` means that member's personal mailbox.
 */
const mailMailboxSchema = z
  .object({
    address: z.string().min(1),
    provider: z.enum(["gmail", "imap"]),
    owner: z.string().min(1).optional(),
    google: googleClientSchema.optional(),
    imap: imapSchema.optional(),
  })
  .strict()
  .refine((m) => m.provider !== "imap" || m.imap !== undefined, {
    message: "imap config is required when provider is 'imap'",
    path: ["imap"],
  })
  .refine((m) => !(m.provider === "gmail" && m.owner !== undefined), {
    message:
      "a personal Gmail mailbox cannot be provisioned: its owner connects it in Settings > Mail " +
      "(the Google consent must be the owner's own)",
    path: ["owner"],
  })

const mailSchema = z
  .object({
    mailboxes: z
      .array(mailMailboxSchema)
      .optional()
      .refine((list) => atMostOneImapPerOwner(list ?? [], (m) => m.owner), {
        message: IMAP_ONE_PER_OWNER_MESSAGE,
      }),
  })
  .strict()
  .optional()

/**
 * A TICKETS inbox backed by a connection the tickets app owns: mail arriving on
 * it becomes tickets. Independent of the Mail app (no mail app mailbox is
 * created or needed). `name`, `fromDisplayName`, `defaultTeam` and `default`
 * converge on every apply once the inbox exists.
 */
const ticketInboxSchema = z
  .object({
    address: z.string().min(1),
    provider: z.enum(["gmail", "imap"]),
    google: googleClientSchema.optional(),
    imap: imapSchema.optional(),
    name: z.string().min(1).optional(),
    fromDisplayName: z.string().optional(),
    // The team every ticket arriving on this inbox inherits (`inbound.ts` ->
    // `team: inbox.default_team`). Without it inbound tickets land team-less.
    defaultTeam: z.string().min(1).optional(),
    // Each new ticket raises an attention item for the holders of
    // tickets:inboxes:admin. Absent leaves the stored value as is (default off).
    notifyNewTicket: z.boolean().optional(),
    // The inbox that tickets created without an explicit inbox land in.
    default: z.boolean().optional(),
  })
  .strict()
  .refine((m) => m.provider !== "imap" || m.imap !== undefined, {
    message: "imap config is required when provider is 'imap'",
    path: ["imap"],
  })

const ticketsSchema = z
  .object({
    // `settings.tickets.approveRepliesFromHome`: a pending customer reply can be
    // approved, edited or rejected from its Home card instead of only from the
    // ticket. Absent leaves the stored value as is (default off).
    approveRepliesFromHome: z.boolean().optional(),
    inboxes: z
      .array(ticketInboxSchema)
      .optional()
      .refine((list) => (list ?? []).filter((i) => i.default === true).length <= 1, {
        message: "at most one inbox can be the default",
      }),
  })
  .strict()
  .optional()

const connectionSchema = z.object({
  name: z.string().min(1),
  identifier: z.string().optional(),
  ownerType: z.enum(["org", "user"]).optional(),
  credentials: z.record(z.string(), z.string()).optional(),
  // OAuth2 connections only: the per-connection OAuth client (app id/secret from
  // the provider -- Shopify app, Meta app, Google client). Provisioned headlessly
  // so `liaison connect <app>/<conn>` can then run the browser consent. Ignored
  // for credentials connections. Empty strings are allowed on purpose: a client
  // declared via an unset `${ENV:-}` ref is treated as "not configured yet" and
  // SKIPPED by the connector (incremental setup), not rejected here.
  oauthClient: z.object({ clientId: z.string(), clientSecret: z.string() }).optional(),
  // Moved: refused below with where it went (the app's provisioning).
  sharedDrives: z.unknown().optional(),
})

/**
 * Per-org mail provider switches (Settings > Mail > Providers), keyed by the
 * provider ids the mail module defines. Strict: an unknown provider id or an
 * extra field is a usage error, never stored.
 *
 * Unknown ids are refused by our own check, one issue per id at the id's own
 * path, before the typed record parses: the record's built-in unknown-key issue
 * changed shape across zod releases (a per-key `invalid_key` became one
 * `unrecognized_keys` on the record), so relying on it lost the id and the
 * known-providers hint from the message.
 */
const mailProviderSwitchSchema = z.object({ enabled: z.boolean() }).strict()
type MailProviderSwitch = z.infer<typeof mailProviderSwitchSchema>

export const mailProvidersSchema = z
  .record(z.string(), mailProviderSwitchSchema)
  .superRefine((record, ctx) => {
    const known: readonly string[] = MAIL_PROVIDER_IDS
    for (const key of Object.keys(record)) {
      if (known.includes(key)) continue
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `unknown mail provider (known providers: ${MAIL_PROVIDER_IDS.join(", ")})`,
      })
    }
  })
  .transform((record) => {
    const out: Partial<Record<(typeof MAIL_PROVIDER_IDS)[number], MailProviderSwitch>> = {}
    for (const id of MAIL_PROVIDER_IDS) {
      const entry = record[id]
      if (entry) out[id] = entry
    }
    return out
  })

const appSchema = z
  .object({
    name: z.string().min(1),
    enable: z.boolean(),
    connection: connectionSchema.optional(),
    // More accounts of a multiInstance credentials connection, each by its
    // `identifier` (an API connection per slug, for one). Applied after the
    // app's `provision`, which may set up what an account needs first.
    connections: z.array(connectionSchema).optional(),
    // Mail app only: which mail providers are switched on for the org.
    providers: mailProvidersSchema.optional(),
    // Non-secret app config keys (`kernel.apps.config`), written through the
    // same allowlist as `PUT /api/apps/:app/config/:key`: each key must be
    // declared in the app manifest's `configKeys`. A null value clears the key.
    config: z.record(z.string().min(1), z.unknown()).optional(),
    // Org settings of the app's settings page (`organizations.settings.<app>`), by
    // field path, written like `PATCH /api/apps/:app/settings/org`: each path must be
    // an org field the manifest declares, and the value must pass its type.
    settings: z.record(z.string().min(1), z.unknown()).optional(),
    // Refused with where it went (the database app's own provisioning), so a
    // file that still carries it fails instead of being silently ignored.
    domainAccess: z.unknown().optional(),
    // The app's own setup as data (manifest `provisioning`): validated against the
    // schema the app declares and applied by the app's provisioning handler.
    provision: z.record(z.string().min(1), z.unknown()).optional(),
  })
  .refine((a) => a.providers === undefined || a.name === "mail", {
    message: "providers is only supported on the 'mail' app",
    path: ["providers"],
  })
  .refine((a) => a.providers === undefined || a.enable, {
    message: "providers requires enable: true (a disabled app entry is skipped)",
    path: ["providers"],
  })
  .refine((a) => a.config === undefined || a.enable, {
    message: "config requires enable: true (a disabled app entry is skipped)",
    path: ["config"],
  })
  .refine((a) => a.connection?.sharedDrives === undefined, {
    message:
      "connection.sharedDrives moved into the google-drive app's provisioning: write it as provision: { sharedDrives: [{ account: <the org connection's Google account>, drives: [...] }] }",
    path: ["connection", "sharedDrives"],
  })
  .refine((a) => (a.connections ?? []).every((c) => c.sharedDrives === undefined), {
    message:
      "connections[].sharedDrives moved into the google-drive app's provisioning: write it as provision: { sharedDrives: [{ account: <the org connection's Google account>, drives: [...] }] }",
    path: ["connections"],
  })
  .refine((a) => a.settings === undefined || a.enable, {
    message: "settings requires enable: true (a disabled app entry is skipped)",
    path: ["settings"],
  })
  .refine((a) => a.provision === undefined || a.enable, {
    message: "provision requires enable: true (a disabled app entry is skipped)",
    path: ["provision"],
  })
  .refine((a) => a.connections === undefined || a.enable, {
    message: "connections requires enable: true (a disabled app entry is skipped)",
    path: ["connections"],
  })
  .refine((a) => (a.connections ?? []).every((c) => c.identifier !== undefined), {
    message: "each entry of connections names its account with identifier",
    path: ["connections"],
  })
  .refine((a) => a.domainAccess === undefined, {
    message:
      "domainAccess moved into the app's provisioning: write it as provision: { domainAccess: ... }",
    path: ["domainAccess"],
  })

export const kbCollectionSchema = z.object({
  name: z.string().min(1),
  // Optional display alias only — idempotency is keyed by name (correction #13).
  slug: z.string().optional(),
})

// One document from one file.
const kbFileDocumentSchema = z
  .object({
    title: z.string().min(1),
    collection: z.string().min(1),
    contentFile: z.string().min(1),
  })
  .strict()

/**
 * Every matching text file under a directory, one document each (a crawled
 * website, a repo's docs, a folder of manuals converted to Markdown). `dir` is
 * relative to the config file. `include` / `exclude` are globs relative to
 * `dir`; dot files and `node_modules` are never read. Each file's title comes
 * from its front matter `title`, else its first Markdown heading, else its file
 * name; a `source` / `url` front matter value is kept as a "Source:" line so an
 * agent can cite it.
 */
export const DEFAULT_KNOWLEDGE_DIR_INCLUDE = "**/*.{md,markdown,mdx,txt,rst,adoc}"

const kbDirDocumentSchema = z
  .object({
    dir: z.string().min(1),
    collection: z.string().min(1),
    include: z.array(z.string().min(1)).optional(),
    exclude: z.array(z.string().min(1)).optional(),
  })
  .strict()

/** The largest inline document body, in UTF-8 bytes. */
export const KNOWLEDGE_INLINE_CONTENT_MAX_BYTES = 1024 * 1024

// One document whose Markdown body is given inline (an agent writing a policy).
export const kbInlineDocumentSchema = z
  .object({
    title: z.string().min(1),
    collection: z.string().min(1),
    content: z
      .string()
      .min(1)
      .refine(
        (v) => Buffer.byteLength(v, "utf8") <= KNOWLEDGE_INLINE_CONTENT_MAX_BYTES,
        "content is larger than 1 MB: upload it as a file and pass contentFileId",
      ),
  })
  .strict()

// One document read from a file already uploaded to the org (`kernel.files`),
// read under the applying person's own access.
export const kbUploadedDocumentSchema = z
  .object({
    title: z.string().min(1),
    collection: z.string().min(1),
    contentFileId: z.string().uuid(),
  })
  .strict()

const kbDocumentSchema = z.union(
  [kbFileDocumentSchema, kbDirDocumentSchema, kbInlineDocumentSchema, kbUploadedDocumentSchema],
  {
    error: () =>
      "a knowledge document is one of { title, collection, contentFile }, " +
      "{ title, collection, content }, { title, collection, contentFileId } or " +
      "{ dir, collection, include?, exclude? }",
  },
)

export const kbSourceSchema = z.object({
  type: z.string().min(1),
  app: z.string().min(1),
  path: z.string().min(1),
})

const knowledgeSchema = z
  .object({
    collections: z.array(kbCollectionSchema).optional(),
    documents: z.array(kbDocumentSchema).optional(),
    sources: z.array(kbSourceSchema).optional(),
  })
  .optional()

// Invoicing issuer profile. `shopifyShop` drives the Shopify shop -> issuer
// mapping the `onShopifyOrderPaid` auto-flow reads via
// `issuer_profiles.shopify_shop_id` (see `invoicingProvisioner`): "auto"
// resolves the org's active shopify connection's identifier (the shop
// domain), an explicit string sets it verbatim, and omitted/null clears any
// mapping intent (no write to that column).
// Luhn checksum, a local copy: the CLI cannot import bundled-app source.
function luhnValid(digits: string): boolean {
  let sum = 0
  const rev = [...digits].reverse()
  for (let i = 0; i < rev.length; i++) {
    let d = Number(rev[i])
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

// Spaces, dots and dashes written in a SIREN or SIRET ("552 032 534") are
// dropped before the checksum and the stored value.
const identifierDigits = z.string().transform((v) => v.replace(/[\s.-]/g, ""))

const sirenField = identifierDigits.refine(
  (v) => /^\d{9}$/.test(v) && luhnValid(v),
  "must be a 9-digit SIREN with a valid checksum",
)

const siretField = identifierDigits.refine((v) => {
  if (!/^\d{14}$/.test(v)) return false
  // La Poste establishments: the digit sum is a multiple of 5 instead of Luhn.
  if (v.startsWith("356000000")) {
    return [...v].reduce((a, c) => a + Number(c), 0) % 5 === 0
  }
  return luhnValid(v.slice(0, 9)) && luhnValid(v)
}, "must be a 14-digit SIRET with a valid checksum")

const isoDateField = z.string().refine((v) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}, "must be a calendar date YYYY-MM-DD")

export const issuerProfileSchema = z
  .object({
    legalName: z.string().min(1),
    country: z.string().min(1),
    vatId: z.string().optional(),
    taxRegistrationId: z.string().optional(),
    address: z.string().optional(),
    iban: z.string().optional(),
    swiftBic: z.string().optional(),
    bankName: z.string().optional(),
    defaultCurrency: z.string().optional(),
    defaultLanguage: z.enum(["en", "fr", "de"]).optional(),
    paymentTermsDays: z.number().int().optional(),
    shopifyShop: z.string().optional().nullable(),
    autoEmail: z.boolean().optional(),
    invoiceApprovalThresholdMinor: z.number().int().nullable().optional(),
    // Local filesystem path to a PNG/JPEG logo, resolved against the config
    // file's directory when relative (see `resolveLocalFile` in the
    // provisioner). Uploaded into `kernel.files` and linked via
    // `issuer_profiles.logo_file_id`; a byte-identical re-run is `unchanged`.
    logoPath: z.string().optional(),
    // A PNG/JPEG already uploaded to the org (`kernel.files`), read under the
    // applying person's own access. Instead of `logoPath`, never with it.
    logoFileId: z.string().uuid().optional(),
    // French legal identity (printed on every invoice, sent with every e-invoice).
    siren: sirenField.optional(),
    siret: siretField.optional(),
    legalForm: z.string().min(1).optional(),
    shareCapital: z.string().min(1).optional(),
    rcsCity: z.string().min(1).optional(),
    vatOnDebits: z.boolean().optional(),
    routingAddress: z.string().min(1).optional(),
    addressLine1: z.string().min(1).optional(),
    addressLine2: z.string().min(1).optional(),
    postcode: z.string().min(1).optional(),
    city: z.string().min(1).optional(),
    countryCode: z.string().length(2).optional(),
  })
  .strict()

// The organisation's e-invoicing settings (one row): whether a document with
// missing e-invoice data is refused or issued with a warning, the date the
// legal mentions switch to the new tax code references, and the transmission
// settings: the installed app that is the e-invoicing platform (the binding of
// the `einvoicing-pa@1` provider contract), the cut-over date from which
// documents are sent / booked, and the send and booking switches (both off
// unless set).
export const einvoicingSchema = z
  .object({
    gateMode: z.enum(["warn", "enforce"]).optional(),
    cibsSwitchDate: isoDateField.optional(),
    providerApp: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,62}$/, "providerApp must be an installed app's name")
      .optional(),
    cutoverDate: isoDateField.optional(),
    sendEnabled: z.boolean().optional(),
    bookEnabled: z.boolean().optional(),
  })
  .strict()

export const taxRegimeSchema = z.object({
  issuerCountry: z.string().min(1),
  treatment: z.string().min(1),
  defaultRateBp: z.number().int(),
  legalMentionTemplateEn: z.string().optional(),
  legalMentionTemplateFr: z.string().optional(),
  legalMentionTemplateDe: z.string().optional(),
  requiresHsCode: z.boolean().optional(),
})

export const hsCodeSchema = z.object({
  code: z.string().min(1),
  description: z.string().optional(),
})

const invoicingSchema = z
  .object({
    issuerProfiles: z.array(issuerProfileSchema).optional(),
    taxRegimes: z.array(taxRegimeSchema).optional(),
    hsCodes: z.array(hsCodeSchema).optional(),
    einvoicing: einvoicingSchema.optional(),
  })
  // Strict like the top level: a typo'd key (`einvoice`, `issuerProfile`) is a usage error, never a silent skip.
  .strict()
  .optional()

// A role agent (a support agent, a sales agent...). Idempotent by `handle`;
// `scopes` are added to the common agent base, never admin scopes.
export const agentSchema = z
  .object({
    handle: z.string().min(1),
    displayName: z.string().min(1),
    purpose: z.string().optional(),
    systemPrompt: z.string().optional(),
    scopes: z.array(z.string().min(1)).optional(),
    // Pins the agent's model (a model id of the catalog), instead of auto mode.
    model: z.string().min(1).optional(),
  })
  .strict()

/** Where the removed top-level `apiConnectors` section went. */
export const API_CONNECTORS_MOVED =
  "apiConnectors moved into the api-connector app's provisioning: write each connection as " +
  "apps: [{ name: api-connector, enable: true, provision: { connectors: [{ identifier, adapter }] }, " +
  "connections: [{ name: api, identifier, credentials }] }] (adapter inline, or { $file: <path> } " +
  "relative to the config file). See docs/provisioning-cli.md."

/** The authoritative provisioning config schema. Top level is strict. */
/**
 * The org's caps (modules/org/caps.ts), operator only: no agent config tool
 * takes this section. A named cap is set, `null` makes it unlimited, a cap not
 * named is kept. A cap is a whole number of at least 1 (0 is refused) and at
 * most its bound: the same schema as `organizations.caps` (one bounds table).
 */
export const limitsSchema = orgCapsSchema.optional()

/**
 * The two opt-ins to share with the Liaison team, instance-wide: register
 * this server (a random id, the version, the edition and the active user
 * count), and allow bug report forwarding (needs register). Both default to
 * off; an answer of "no" is an answer and is recorded. Operator only.
 */
export const liaisonTeamSchema = z
  .strictObject({
    register: z.boolean().optional(),
    forwardBugReports: z.boolean().optional(),
  })
  .optional()

export const configSchema = z
  .object({
    org: orgSchema,
    admin: adminSchema,
    setup: setupSchema,
    roles: z.array(roleSchema).optional(),
    users: z.array(userSchema).optional(),
    byok: z.record(z.string(), byokEntrySchema).optional(),
    apiKeys: z.array(apiKeySchema).optional(),
    email: emailSchema,
    mail: mailSchema,
    tickets: ticketsSchema,
    apps: z.array(appSchema).optional(),
    // Refused with where it went (the api-connector app's own provisioning), so a
    // file that still carries it fails instead of being silently ignored.
    apiConnectors: z.unknown().optional(),
    knowledge: knowledgeSchema,
    agents: z.array(agentSchema).optional(),
    invoicing: invoicingSchema,
    limits: limitsSchema,
    liaisonTeam: liaisonTeamSchema,
  })
  .strict()
  .refine((c) => c.apiConnectors === undefined, {
    message: API_CONNECTORS_MOVED,
    path: ["apiConnectors"],
  })

export type ProvisioningConfig = z.infer<typeof configSchema>

export type ValidateConfigResult =
  | { ok: true; config: ProvisioningConfig }
  | { ok: false; code: 2; message: string }

/**
 * The removed top-level `mailboxes` key mixed two products: it connected a MAIL
 * app mailbox and then attached a ticket inbox to it, which never receives
 * tickets (the tickets app syncs only connections it owns). It is refused with
 * guidance instead of being mapped, because the right target depends on intent.
 */
export const LEGACY_MAILBOXES_MESSAGE =
  "mailboxes: this section was removed. For a support inbox whose mail becomes tickets, " +
  "move the entry to tickets.inboxes (address, provider, google or imap, and the old " +
  "inbox.name, inbox.fromDisplayName, inbox.defaultTeam, inbox.default as direct fields). " +
  "For a mailbox people read and send from in the Mail app, move it to mail.mailboxes " +
  "(no inbox block). See docs/provisioning-cli.md."

function legacyMailboxesMessage(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null || !("mailboxes" in raw)) return null
  return LEGACY_MAILBOXES_MESSAGE
}

/**
 * Validate a raw (interpolated) config object against the schema. Returns the
 * typed config on success, or a usage-error fragment (code 2) with a
 * path-prefixed message on failure — never throws.
 */
export function validateConfig(raw: unknown): ValidateConfigResult {
  const legacy = legacyMailboxesMessage(raw)
  if (legacy) return { ok: false, code: 2, message: legacy }
  const result = configSchema.safeParse(raw)
  if (result.success) return { ok: true, config: result.data }
  const message = result.error.issues
    .map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message))
    .join("; ")
  return { ok: false, code: 2, message }
}
