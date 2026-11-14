// SPDX-License-Identifier: FSL-1.1-ALv2
import { z } from "zod"
import { reasoningLevelSchema } from "../reasoning"

// clientSecretEncrypted is the on-disk ciphertext — stays opaque through the
// kernel-settings accessor; resolveGoogleOAuthClientConfig handles decryption
// when it needs the plaintext. Not marked "encrypted" so the accessor leaves
// it untouched.
const oauthClientSchema = z.object({
  clientId: z.string(),
  clientSecretEncrypted: z.string(),
})

// Google OAuth client ids always end with this suffix. Anything else (an email
// address, an API key, a project number) makes Google reject the authorize URL
// with "invalid_client — Client missing a project id", so writes are validated
// against it. Stored values stay a plain string above: rows written before this
// validation existed must keep loading.
export const GOOGLE_OAUTH_CLIENT_ID_SUFFIX = ".apps.googleusercontent.com"

export const googleOAuthClientIdSchema = z
  .string()
  .trim()
  .refine(
    (v) =>
      v.length > GOOGLE_OAUTH_CLIENT_ID_SUFFIX.length && v.endsWith(GOOGLE_OAUTH_CLIENT_ID_SUFFIX),
    {
      message: `Client ID must be a Google OAuth client id ending in "${GOOGLE_OAUTH_CLIENT_ID_SUFFIX}" (find it in Google Cloud Console → APIs & Services → Credentials)`,
    },
  )

const providerKeyEntrySchema = z
  .object({
    encrypted: z.string().nullable().optional(),
    apiKey: z.string().describe("encrypted").nullable().optional(),
    preview: z.string().nullable().optional(),
    maskedHint: z.string().nullable().optional(),
    validatedAt: z.string().nullable().optional(),
    // Whether the stored key passed live validation when it was written. The
    // provisioning CLI's idempotent-skip path reports this STORED outcome rather
    // than optimistically claiming `true`. Optional/nullable: entries written
    // before this field existed (or via the settings UI) simply omit it.
    validated: z.boolean().nullable().optional(),
  })
  .passthrough()

// --- Demo mode: the per-org marker -----------------------------------------
//
// A public demo instance runs one kind of org, plus one exception: a VISITOR
// org is the disposable workspace a self-serve signup creates and its owner is
// its admin, and the RESERVED org is the single non-public workspace handed to
// Apple's Beta App Review. Both are marked here, in `organizations.settings`
// under the `demo` key, following the `providerKeys` precedent rather than
// adding a column: the marker is deployment posture, not tenant data, it is
// read by a handful of call sites, and a migration for it would land on every
// customer's database to carry a field only a demo box ever sets.
//
// What keys off this marker: the demo seeder's data provider, the outbound
// egress lockdown (no customer mail, no real connector credentials) and the
// BYOK spend ceiling. Absent marker means a normal, fully capable org, so the
// default everywhere is "not a demo" and nothing changes for a real customer.
/** Every demo variant a marker may carry. The kernel's immutability trigger reads this list too. */
export const DEMO_ORG_VARIANTS = ["reserved", "visitor"] as const

export const demoOrgMarkerSchema = z
  .object({
    /**
     * `visitor` is a disposable self-serve signup, which is what almost every
     * demo org is. `reserved` is the ONE non-public org handed to Apple's Beta
     * App Review: it never expires, it is re-seeded nightly, and it is the only
     * demo org allowed to spend the deployment's own model key.
     */
    variant: z.enum(DEMO_ORG_VARIANTS),
    /** ISO 8601. When the marker was written (not when the org row was inserted). */
    createdAt: z.string(),
    /**
     * ISO 8601, or null for "never expires". The reserved org is always null;
     * a visitor org carries a real expiry so a reaper can drop it.
     */
    expiresAt: z.string().nullable(),
  })
  .passthrough()

export type DemoOrgMarker = z.infer<typeof demoOrgMarkerSchema>
export type DemoVariant = DemoOrgMarker["variant"]

/**
 * Per-workspace app state (S18–S20): an app is On, Off (`disabled`) or removed
 * from the workspace, and usable by everyone or restricted to listed roles and
 * people. Stored on `kernel.apps` (+ `kernel.org_app_access`), never in org
 * settings JSON.
 */
export const orgAppStatusSchema = z.enum(["active", "disabled", "error", "removed"])
export const orgAppAccessModeSchema = z.enum(["everyone", "restricted"])

/** Body of `PUT /api/org/apps/:app/access`. */
export const setOrgAppAccessSchema = z.strictObject({
  mode: orgAppAccessModeSchema,
  roleIds: z.array(z.string().uuid()).max(200).default([]),
  userIds: z.array(z.string().uuid()).max(1000).default([]),
})

/** Error code of every refusal of an Off or removed app (tools 409, routes 410, public 503). */
export const APP_DISABLED_CODE = "app_disabled"
export const APP_DISABLED_MESSAGE = "This app is turned off by your admin."
/** A scope request or call for an app restricted away from the person. */
export const APP_RESTRICTED_MESSAGE = "This app is restricted by your admin."

// --- AI models: which models an org runs (settings `ai.models`) -------------
//
// Native models are the rows of the global model catalogue; `disabled` lists
// the ones an admin switched off. ADDED models are the org's own: picked from
// OpenRouter's catalogue (`openrouter/<id>`) or served by one of the org's own
// OpenAI-compatible servers (`custom/<serverId>/<model name>`). A key's prefix
// says which namespace it lives in, so the three can never collide. The
// server's key, when it has one, sits beside the other provider keys under
// `providerKeys["custom:<serverId>"]`.
export const ADDED_MODEL_REASONING_EFFORTS = ["low", "medium", "high"] as const

export const addedModelSchema = z
  .object({
    key: z.string().min(1).max(200),
    provider: z.enum(["openrouter", "custom"]),
    upstreamId: z.string().min(1).max(200),
    serverId: z.string().optional(),
    displayName: z.string(),
    contextWindow: z.number().int().positive(),
    inputCostPerM: z.string().nullable(),
    outputCostPerM: z.string().nullable(),
    tools: z.boolean(),
    reasoningEfforts: z
      .array(z.enum(ADDED_MODEL_REASONING_EFFORTS))
      .max(ADDED_MODEL_REASONING_EFFORTS.length),
    canDisableReasoning: z.boolean(),
    enabled: z.boolean(),
    addedAt: z.string(),
    priceUpdatedAt: z.string().optional(),
    // Set by the price job when OpenRouter's catalogue no longer lists the model.
    unavailableSince: z.string().nullable().optional(),
  })
  .passthrough()

export const modelServerSchema = z
  .object({
    id: z.string().regex(/^[0-9a-f]{8}$/),
    name: z.string().min(1),
    baseURL: z.string().min(1),
    addedAt: z.string(),
  })
  .passthrough()

export const aiModelsSettingsSchema = z
  .object({
    disabled: z.array(z.string()).max(1000).optional(),
    autoModelKey: z.string().nullable().optional(),
    // The reasoning level of a turn that asks for none (no level on the
    // conversation or the routine): `resolveTurnReasoningLevel`. Absent or null
    // means the built-in default (Auto: High; a chosen model: its own default).
    // A malformed value (hand-edited JSON) reads as unset rather than failing
    // every read of the org's settings.
    defaultReasoningLevel: reasoningLevelSchema.nullable().optional().catch(null),
    // OpenRouter upstream hosts this org's requests are never routed to
    // (providers/openrouter-blocked-hosts.ts). Set, even empty, it REPLACES the
    // instance default (LIAISON_OPENROUTER_IGNORE_HOSTS); absent, the default
    // applies. A malformed value reads as absent.
    blockedHosts: z.array(z.string()).max(1000).optional().catch(undefined),
    added: z.array(addedModelSchema).max(200).optional(),
    servers: z.array(modelServerSchema).max(100).optional(),
    // When OpenRouter's default model was made Auto for an org whose only key
    // is OpenRouter's (once, ever): after that, an admin's removal sticks.
    openRouterDefaultProvisionedAt: z.string().optional(),
  })
  .passthrough()

/** The most OpenRouter hosts an org may block. */
export const BLOCKED_HOSTS_MAX = 20
/** The longest host name an org may block. */
export const BLOCKED_HOST_NAME_MAX = 100

/** GET and PATCH /settings/ai/models `blockedHosts`: the OpenRouter hosts the org's requests never reach. */
export interface BlockedHostsView {
  /** The effective list: the org's own, or the instance default when it set none. */
  hosts: string[]
  /** True when the org set no list (the instance default applies). */
  isDefault: boolean
  /** The instance default (LIAISON_OPENROUTER_IGNORE_HOSTS). */
  defaultHosts: string[]
}

/**
 * PATCH /settings/ai/models `blockedHosts`: trimmed non-empty names, at most
 * BLOCKED_HOSTS_MAX, deduplicated case-insensitively (first spelling kept).
 * null removes the org's list, so the instance default applies again.
 */
export const blockedHostsPatchSchema = z
  .array(z.string().trim().min(1).max(BLOCKED_HOST_NAME_MAX))
  .max(BLOCKED_HOSTS_MAX)
  .transform((hosts) => {
    const seen = new Set<string>()
    return hosts.filter((h) => {
      const k = h.toLowerCase()
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
  })
  .nullable()

// --- Conversation history (settings `ai.history`) ----------------------------

/** The smallest history budget an org may set, in tokens. */
export const HISTORY_BUDGET_SETTING_MIN = 32_000
/** The largest history budget an org may set, in tokens. */
export const HISTORY_BUDGET_SETTING_MAX = 2_000_000

/** GET and PATCH response of /api/settings/ai/history. */
export const historySettingsSchema = z.object({
  /** The org's own budget, null = the instance default. */
  budgetTokens: z.number().int().nullable(),
  /** The instance default (`AGENT_HISTORY_BUDGET_TOKENS`). */
  defaultBudgetTokens: z.number().int(),
  minBudgetTokens: z.number().int(),
  maxBudgetTokens: z.number().int(),
  /** Summarize an idle thread while the prompt cache is still warm. */
  warmCompaction: z.boolean(),
})
export type HistorySettings = z.infer<typeof historySettingsSchema>

/** PATCH body of /api/settings/ai/history: each field optional, null clears the budget. */
export const historySettingsPatchSchema = z
  .strictObject({
    budgetTokens: z
      .number()
      .int()
      .min(HISTORY_BUDGET_SETTING_MIN)
      .max(HISTORY_BUDGET_SETTING_MAX)
      .nullable()
      .optional(),
    warmCompaction: z.boolean().optional(),
  })
  .refine((v) => v.budgetTokens !== undefined || v.warmCompaction !== undefined, {
    message: "Nothing to change",
  })
export type HistorySettingsPatch = z.infer<typeof historySettingsPatchSchema>

export type AddedModel = z.infer<typeof addedModelSchema>
export type ModelServer = z.infer<typeof modelServerSchema>
export type AiModelsSettings = z.infer<typeof aiModelsSettingsSchema>

/**
 * What a commercial mail must state about its sender: the legal name and the
 * postal address printed in its footer, and the country policy that decides
 * whether a recipient's professional interest is enough (`optout`) or consent
 * is needed (`consent`). Written by `config apply` (`email.commercialIdentity`)
 * and the organization settings page.
 */
export const commercialIdentitySchema = z
  .object({
    legalName: z.string().trim().min(1).max(200),
    postalAddress: z.string().trim().min(1).max(500),
    countryPolicy: z.record(z.string(), z.enum(["optout", "consent"])).optional(),
  })
  .strict()
export type CommercialIdentity = z.infer<typeof commercialIdentitySchema>

export const orgKernelSettingsSchema = z
  .object({
    rateLimitPerMinute: z.number().nullable().optional(),
    enterpriseAllowance: z.string().nullable().optional(),
    resetDate: z.string().nullable().optional(),
    integrations: z
      .object({
        google: z
          .object({
            oauthClient: oauthClientSchema.nullable().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    providerKeys: z.record(z.string(), providerKeyEntrySchema).optional(),
    // Constrained enum so a malformed value rejects rather than reading as
    // "off". Absent means "standard" (see validation/org.ts).
    webContentProtection: z.enum(["off", "standard", "hardened"]).optional(),
    // Administrators must use two-step verification (auth/admin-second-factor.ts).
    requireAdminSecondFactor: z.boolean().optional(),
    // The features the person chose in the onboarding (config `setup.features`,
    // apps/api connection-guides/setup-features.ts): what setup state counts as left.
    chosenFeatures: z.array(z.string()).max(100).optional(),
    webSearchCreditCost: z.union([z.string(), z.number()]).optional(),
    webFetchAllowlist: z.array(z.string()).max(1000).optional(),
    webFetchBlocklist: z.array(z.string()).max(1000).optional(),
    ai: z
      .object({
        creditCap: z.number().nullable().optional(),
        // P4c-T48: the embedding model hybrid memory search indexes and
        // queries with. Per org because the vectors an org already has were
        // computed by ONE model and are not comparable across models: changing
        // it is a re-embed, which is why it is a setting an admin sets
        // deliberately rather than something the search path infers. Absent
        // means the default (`gemini-embedding-001`).
        embeddingModelId: z.string().nullable().optional(),
        // The cosine similarity at or above which two documents are the same
        // fact told twice, and collapse to one hit. Absent means 0.95.
        nearDuplicateThreshold: z.number().nullable().optional(),
        // Which models the org runs, and which one Auto means (see
        // aiModelsSettingsSchema above). Absent means today's behaviour: every
        // native model of a keyed provider, Auto = the cheapest auto model.
        models: aiModelsSettingsSchema.optional(),
        // Voice dictation's transcription model (S7). Absent or null means the
        // measured default (or the Gemini fallback with only a Google key).
        // Written only by PATCH /api/settings/ai/transcription, under the org
        // row lock, as one sub-path jsonb_set.
        transcription: z
          .object({ modelKey: z.string().nullable().optional() })
          .passthrough()
          .optional(),
        // Conversation history (checkpoints): how much raw history an agent
        // replays before it summarizes the older part, and whether an idle
        // thread is summarized while the provider's prompt cache is still warm.
        // Absent means the instance default (AGENT_HISTORY_BUDGET_TOKENS) and on.
        // Written only by PATCH /api/settings/ai/history.
        history: z
          .object({
            budgetTokens: z.number().int().positive().nullable().optional(),
            warmCompaction: z.boolean().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    taintSources: z.record(z.string(), z.unknown()).optional(),
    // Per-org transactional email identity. Both fields optional; resolvers fall
    // back to `env.EMAIL_FROM` (from) / undefined (replyTo). Declared explicitly
    // (NOT relying on `.passthrough()`) so the fields are typed `string`, not
    // `unknown`. `.partial()` lets a PATCH that sets only one field still validate.
    email: z
      .object({
        from: z.string().optional(),
        replyTo: z.string().optional(),
      })
      .partial()
      .optional(),
    // The sender identity a commercial mail states (commercialIdentitySchema).
    // Read-tolerant: a stored value that no longer parses reads as unset, so the
    // send check refuses commercial mail until it is set again.
    commercialIdentity: z.unknown().optional(),
    // Demo-instance marker (see demoOrgMarkerSchema above). Declared explicitly
    // rather than left to `.passthrough()` so it is typed, not `unknown`.
    demo: demoOrgMarkerSchema.nullable().optional(),
    // Per-surface media-analysis toggles. `.partial()` so a PUT that sets a
    // single toggle still validates; the resolver fills in the defaults
    // (tickets on, mail off). Declared explicitly (NOT relying on
    // `.passthrough()`) so the field is typed `boolean`, not `unknown`.
    mediaAnalysis: z
      .object({
        tickets: z
          .object({ image: z.boolean(), video: z.boolean(), document: z.boolean() })
          .partial()
          .optional(),
        mail: z
          .object({ image: z.boolean(), video: z.boolean(), document: z.boolean() })
          .partial()
          .optional(),
        // Agent-chat / thread attachments (files parented to kernel entities).
        kernel: z
          .object({ image: z.boolean(), video: z.boolean(), document: z.boolean() })
          .partial()
          .optional(),
        // An app's own files, read by the app itself through the declared
        // `files.analyzeDocument` host call (e.g. a shipping label).
        apps: z
          .object({ image: z.boolean(), video: z.boolean(), document: z.boolean() })
          .partial()
          .optional(),
      })
      .optional(),
  })
  .passthrough()

export type OrgKernelSettings = z.infer<typeof orgKernelSettingsSchema>

/** Anything carrying a kernel `settings` blob: an org row, or the parsed settings. */
export interface DemoMarkedOrg {
  settings?: unknown
}

/**
 * The demo marker on an org, or null when there is none (the normal case).
 * Tolerant by design: a malformed marker reads as "not a demo" rather than
 * throwing, because every caller is on a request path that must not 500 over a
 * hand-edited settings blob. It is a restriction switch, and the safe answer
 * for a normal org is the one that changes nothing.
 */
export function demoMarker(org: DemoMarkedOrg | null | undefined): DemoOrgMarker | null {
  const settings = org?.settings
  if (!settings || typeof settings !== "object") return null
  const raw = (settings as Record<string, unknown>).demo
  if (!raw || typeof raw !== "object") return null
  const parsed = demoOrgMarkerSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** Is this org a demo org (of either variant)? */
export function isDemoOrg(org: DemoMarkedOrg | null | undefined): boolean {
  return demoMarker(org) !== null
}

/** Which kind of demo org this is, or null when it is not one. */
export function demoVariant(org: DemoMarkedOrg | null | undefined): DemoVariant | null {
  return demoMarker(org)?.variant ?? null
}

/**
 * The machine code every credential path answers with once a demo workspace is
 * over (`{ error: { code } }` on a 403, the reason of the websocket close), so a
 * client can tell it apart from any other refusal and leave the workspace.
 */
export const DEMO_WORKSPACE_EXPIRED_CODE = "demo_workspace_expired"

/** The websocket close code for an expired demo workspace (reason: the code above). */
export const DEMO_WORKSPACE_EXPIRED_WS_CLOSE = 4003

/**
 * The machine code every user credential path answers with while the org is
 * suspended or closed for billing (managed edition): a 403 whose `error` is an
 * `OrgSuspendedError`, and the reason of the websocket close. Signed control
 * plane calls, health and cell webhooks are not user credentials and never get it.
 */
export const ORG_SUSPENDED_CODE = "org_suspended"

/** The websocket close code for a suspended org (reason: the code above). */
export const ORG_SUSPENDED_WS_CLOSE = 4004

/**
 * An org moving to another instance (`@liaison/control-plane-contract`
 * moves.ts): the 503 code with its `Retry-After`, and the websocket close the
 * client answers by reconnecting every `ORG_MOVING_RETRY_AFTER_SECONDS`.
 */
export {
  ORG_MOVING_CODE,
  ORG_MOVING_RETRY_AFTER_SECONDS,
  ORG_MOVING_WS_CLOSE,
  type OrgMovingError,
  orgMovingErrorSchema,
} from "@liaison/control-plane-contract"

/**
 * The `error` object of the 403 `org_suspended` reply (`{ error: OrgSuspendedError }`):
 * until when admins can still export and pay (null once closed, or when the
 * control plane did not say), and the billing contact address to show (null
 * when the control plane did not push one). Both come from the control plane.
 */
export const orgSuspendedErrorSchema = z
  .object({
    code: z.literal(ORG_SUSPENDED_CODE),
    accessUntil: z.iso.datetime().nullable(),
    contact: z.string().max(320).nullable(),
    message: z.string().optional(),
  })
  .strict()
export type OrgSuspendedError = z.infer<typeof orgSuspendedErrorSchema>

/**
 * The machine code of a 402 for metered use (AI calls, top-ups) while the org
 * is past due or suspended: pay the open invoice in Billing first.
 */
export const PAYMENT_REQUIRED_CODE = "payment_required"
/** A managed org's turn refused at zero credits: the row says so with the way to Billing. */
export const OUT_OF_CREDITS_CODE = "out_of_credits"

/** Has this demo org passed its expiry? False for a non-demo org or a null expiry. */
export function isDemoOrgExpired(
  org: DemoMarkedOrg | null | undefined,
  now: Date = new Date(),
): boolean {
  const marker = demoMarker(org)
  if (!marker?.expiresAt) return false
  const at = Date.parse(marker.expiresAt)
  return Number.isFinite(at) && at <= now.getTime()
}
