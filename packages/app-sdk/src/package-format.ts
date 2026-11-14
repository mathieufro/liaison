// SPDX-License-Identifier: FSL-1.1-ALv2
// `.liaisonapp` package format — the typed, versioned contract shared by the
// freeze tool, the verify/install service, the `liaison app` CLI, and the admin
// UI. A `.liaisonapp` is a gzipped tarball with a fixed file layout; this module
// defines its manifest schema and the file conventions.
//
// See docs/app-package-format.md for the human-readable spec.
import { z } from "zod"
import { appConfigKeySchema, configKeysDeclarationErrors } from "./app-config-keys"
import { appListingSchema, isSpdxLicenseExpression } from "./app-listing"
import { appKindSchema, appSettingsSchema, settingsDeclarationErrors } from "./app-settings"
import { appStoreDeclarationSchema, storeDeclarationErrors } from "./app-store"
import { appSecretsDeclarationSchema, secretsDeclarationErrors } from "./secret-placement"

/** Major version of the `.liaisonapp` format. Bumped only on a breaking change. */
export const LIAISON_APP_VERSION = 1

/** Files that MUST be present in a valid `.liaisonapp` tarball. */
export const REQUIRED_FILES = ["app.manifest.json", "bundle.js"] as const

/** Files that MAY be present in a `.liaisonapp` tarball. */
export const OPTIONAL_FILES = ["ui.js", "README.md", "CHANGELOG.md", "LICENSE"] as const

/**
 * The cosign signature is a DETACHED sibling artifact, never inside the tarball:
 * a `.liaisonapp` published at `<url>` is signed by `<url>.cosign.bundle`.
 * Embedding the signature would require re-taring after signing, changing the
 * bytes the signature was computed over.
 */
export const SIGNATURE_SUFFIX = ".cosign.bundle"

// Scope shape: `app:resource` or `app:resource:action`, all kebab-case.
const scopeShape = /^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*){1,2}$/

const semver = /^\d+\.\d+\.\d+(-[\w.]+)?$/

// Phase 17 — cross-app tool target shape: `appname:tool.name`. Dots are
// permitted in the tool-name segment so Shopify-style names (orders.get) work.
const crossAppCallTargetShape = /^[a-z][a-z0-9_-]*:[a-z][a-zA-Z0-9_.]*$/

// Phase 17 — pdf_templates[].source: relative TS path under the app root.
const pdfTemplateSourceShape = /^[a-z0-9_/-]+\.ts$/

// Phase 17 — slot panel/tab shape (contact_detail panels, document_detail tabs).
const slotPanelSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  component: z.string().min(1),
  order: z.number().int().optional(),
  visibility_scope: z.string().optional(),
})

// Manifest tool entry, e.g. bundled-apps/boxtal/app.manifest.json's
// `tools.packages_list`. `requiredScopes` lists every scope the tool needs,
// one entry or several. The retired single `scope` key is refused rather than
// silently stripped, so an old manifest fails install instead of losing its
// scope; the issue path names the tool.
const toolEntrySchema = z.object({
  description: z.string(),
  scope: z
    .never({
      error: 'the tool must list its scopes in "requiredScopes", "scope" is no longer accepted',
    })
    .optional(),
  handler: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
  requiredScopes: z
    .array(z.string().regex(scopeShape, "requiredScopes entries must be app:resource[:action]"))
    .min(1, "requiredScopes must list at least one scope"),
  // Scope taint: the schema-qualified table the tool writes (`app_<name>.<table>`),
  // or `readOnly` for a tool that writes nothing. A tool with neither is refused
  // on a turn that has read scoped data. Installed apps are sandboxed, so the
  // runtime honours `readOnly` only on a first-party catalog install (its artifact
  // is the image's own tarball) and ignores it on any other.
  writesToTable: z
    .string()
    .regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/, "writesToTable must be schema.table")
    .optional(),
  readOnly: z.boolean().optional(),
})

/**
 * Manifest schema for a distributable `.liaisonapp`. Stricter than the runtime
 * `app.manifest.json` schema: it requires distribution metadata (license)
 * and forbids `trusted` — installed apps are always sandboxed.
 */
export const packageManifestSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/, "app name must be kebab-case, start with a letter"),
    version: z.string().regex(semver, "semver required"),
    packageFormat: z.literal(LIAISON_APP_VERSION),
    displayName: z.string().optional(),
    description: z.string().optional(),
    author: z.string().optional(),
    // SPDX identifier required — installed apps run on someone's server, license matters.
    license: z.string().min(1, "license required (SPDX identifier, e.g. 'MIT' or 'Apache-2.0')"),
    homepage: z.url().optional(),
    // The app's icon as data, never code: SVG markup (at most 8 KB of plain
    // drawing elements; the server refuses anything else at install) or the name
    // of an icon in Liaison's icon set. Absent: the host draws a tile with the
    // app's initial.
    iconSvg: z.string().min(1).max(8192, "iconSvg must be at most 8 KB").optional(),
    iconName: z.string().min(1).optional(),
    // The host API range this app needs (a semver range such as "^1"); "^1"
    // when absent. The server refuses an app whose range it cannot satisfy.
    host: z.string().min(1, 'host must be a semver range, e.g. "^1"').optional(),
    // A security release: once this version is active, a rollback never goes
    // below it. Honoured for first-party (catalog) packages only.
    noRollback: z.boolean().optional(),
    // Ignored. Older packages carry them; they stay accepted so those still parse.
    sdkVersion: z.string().optional(),
    minLiaisonVersion: z.string().optional(),
    // Release-channel URL: a STABLE pointer the app author commits to keeping
    // current — it must always serve the latest `.liaisonapp` for this app. This
    // is what `liaison app upgrade` re-fetches. Absent → the app is install-only.
    updateUrl: z.url().optional(),
    scopes: z.array(z.string().regex(scopeShape, "scope must be app:resource[:action]")),
    // Tools this app exposes, keyed by tool name. Aligns with the runtime
    // manifest schema's `toolSchema` (apps/api/src/modules/apps/manifest-schema.ts).
    tools: z.record(z.string(), toolEntrySchema).optional(),
    // Aligns with the runtime manifest schema (apps/api/src/modules/apps/manifest-schema.ts):
    // connections keyed by name. The key becomes the connection identifier the
    // kernel exposes via `connectionConfigRegistry`.
    connections: z
      .record(z.string(), z.object({ type: z.enum(["oauth2", "credentials"]) }).passthrough())
      .optional(),
    // Non-secret `kernel.apps.config` keys an admin may write (kernel route
    // `PUT /api/apps/:app/config/:key`, `config apply` `apps[].config`). A key a
    // connection reserves for a secret is refused below.
    configKeys: z.array(appConfigKeySchema).optional(),
    // `app` (default) or `connector` (no workspace view; its settings render as a
    // card on the Connectors page), and the declarative settings page
    // (./app-settings.ts). Cross-field rules run in the superRefine below.
    kind: appKindSchema.optional(),
    settings: appSettingsSchema.optional(),
    // Store listing (./app-listing.ts): mandatory for catalog and registry entries,
    // absent on an Unlisted URL install. A listed package's `license` must be an
    // SPDX expression (checked below); pricing keys are refused by the schema.
    listing: appListingSchema.optional(),
    // Kept for the views a package declares, so the connector rule below sees them.
    views: z.record(z.string(), z.unknown()).optional(),
    // No `trusted` field, with any value: every package runs sandboxed, and only
    // the platform's own core apps run as server code (a fixed list in the
    // server, never a manifest claim). A manifest that carries it is refused.
    trusted: z
      .never({
        error:
          "trusted is not a manifest field: every package runs sandboxed, and the platform alone decides which apps are core. Remove it.",
      })
      .optional(),
    // Phase 17 — opaque capability strings. The runtime gate is
    // `requireCapability` in apps/api/.../rpc-bridge.ts; there is no
    // schema-level allowlist by design (any future capability lands without a
    // schema bump).
    capabilities: z.array(z.string()).optional(),
    // Phase 17 — declared PDF templates the app ships. The `source` is a
    // relative TS path under the app root that the freeze step transpiles
    // into the templates bundle (see scripts/freeze-app.ts). `kind` is the
    // key apps pass to `ctx.pdf.render({ template_kind })`.
    pdf_templates: z
      .array(
        z.object({
          kind: z.string().min(1).max(128),
          source: z
            .string()
            .regex(
              pdfTemplateSourceShape,
              "pdf_templates[].source must be a relative .ts path (e.g. templates/invoice.ts)",
            ),
        }),
      )
      .optional(),
    // Phase 17 — explicit declaration of cross-app tool invocations the app
    // will perform via `ctx.executeTool` (e.g. `mail:compose`). Synthesized
    // into `dependencies.tools` by `validateManifest` when only this form is
    // declared.
    cross_app_calls: z
      .array(
        z.object({
          target: z
            .string()
            .regex(crossAppCallTargetShape, "cross_app_calls[].target must be appname:tool.name"),
          reason: z.string().min(1),
        }),
      )
      .optional(),
    // Phase 17 — UI slot contributions. Known slots:
    //   - `contact_detail.panels[]` — panels mounted in the contact detail page.
    //   - `invoicing.document_detail.tabs[]` — tabs mounted in the invoicing
    //     document detail page (used by other apps that want to add a tab).
    // `catchall` permits the per-app namespace (`invoicing`, future apps)
    // without requiring a schema bump per addition.
    slots: z
      .object({
        contact_detail: z.object({ panels: z.array(slotPanelSchema) }).optional(),
      })
      .catchall(
        z
          .object({
            document_detail: z.object({ tabs: z.array(slotPanelSchema) }).optional(),
          })
          .optional(),
      )
      .optional(),
    // Read-only tools that give a company's or a contact's timeline its rows.
    // Aligns with the runtime manifest schema's `activitySources`
    // (apps/api/src/modules/apps/manifest-schema.ts).
    activitySources: z
      .array(
        z
          .object({
            tool: z.string().min(1),
            scope: z.string().regex(scopeShape, "scope must be app:resource[:action]"),
            label: z.string().min(1),
            labelKey: z.string().min(1).optional(),
            filterKey: z.string().regex(/^[a-z][a-z0-9_-]*$/, "filterKey must be lowercase"),
          })
          .strict(),
      )
      .optional(),
    // The app data store's declared collections (./app-store.ts): what the
    // agent's data tools, dashboard blocks and search may read, under which scope.
    store: appStoreDeclarationSchema.optional(),
    // Where each declared secret config key may be written by `ctx.fetch`'s
    // `configSecrets` (./secret-placement.ts): its hosts and the one header,
    // query parameter or JSON body path. A key with no entry is placed nowhere.
    secrets: appSecretsDeclarationSchema.optional(),
    // Phase 17 — explicit dependency tools (canonical form). Synthesized from
    // `cross_app_calls` when only that is declared. `passthrough` preserves
    // any other dependency keys other plans may add.
    dependencies: z
      .object({
        tools: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .superRefine((data, ctx) => {
    for (const message of configKeysDeclarationErrors(data.configKeys, data.connections)) {
      ctx.addIssue({ code: "custom", message, path: ["configKeys"] })
    }
    for (const message of settingsDeclarationErrors(data)) {
      ctx.addIssue({ code: "custom", message, path: ["settings"] })
    }
    const ownScopes = new Set([
      ...data.scopes,
      ...Object.values(data.tools ?? {}).flatMap((t) => t.requiredScopes),
    ])
    for (const message of storeDeclarationErrors(data, { knownScopes: (s) => ownScopes.has(s) })) {
      ctx.addIssue({ code: "custom", message, path: ["store"] })
    }
    for (const message of secretsDeclarationErrors(data)) {
      ctx.addIssue({ code: "custom", message, path: ["secrets"] })
    }
    if (data.listing !== undefined && !isSpdxLicenseExpression(data.license)) {
      ctx.addIssue({
        code: "custom",
        message:
          "a listed app needs a top-level SPDX license (e.g. 'MIT', 'Apache-2.0', 'FSL-1.1-ALv2')",
        path: ["license"],
      })
    }
    // pdf_templates requires the pdf.render capability.
    if (data.pdf_templates && data.pdf_templates.length > 0) {
      const caps = data.capabilities ?? []
      if (!caps.includes("pdf.render")) {
        ctx.addIssue({
          code: "custom",
          message: "pdf.render capability required when pdf_templates declared",
          path: ["capabilities"],
        })
      }
    }
    // cross_app_calls and dependencies.tools, when both present, must agree.
    if (data.cross_app_calls && data.dependencies?.tools) {
      const a = new Set(data.cross_app_calls.map((c) => c.target))
      const b = new Set(data.dependencies.tools)
      const equal = a.size === b.size && [...a].every((x) => b.has(x))
      if (!equal) {
        ctx.addIssue({
          code: "custom",
          message:
            "cross_app_calls and dependencies.tools disagree — declare one or make them equal",
          path: ["dependencies", "tools"],
        })
      }
    }
  })

export type PackageManifest = z.infer<typeof packageManifestSchema>

/**
 * Phase 17 — install-time validation entry point. Wraps
 * `packageManifestSchema.safeParse` with throw-on-failure semantics and
 * synthesizes `dependencies.tools` from `cross_app_calls` when only the
 * latter is declared (single source of truth at runtime).
 */
export class ManifestValidationError extends Error {
  constructor(public readonly issues: z.ZodIssue[]) {
    super(issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "))
    this.name = "ManifestValidationError"
  }
}

/**
 * Snapshot of the cross-app tool registry passed to `validateManifest` when
 * the caller wants install-time target resolution. The kernel install path
 * builds this from its tool registry (see B7); third-party tooling can pass
 * an in-memory Set wrapper.
 */
export interface ToolRegistrySnapshot {
  has: (toolName: string) => boolean
}

export interface ValidateManifestOptions {
  /** When true, every `cross_app_calls[].target` must exist in the
   * `toolRegistry` snapshot or validation throws. Default false — install
   * paths set this to true; the freeze path leaves it off. */
  resolveTargets?: boolean
}

export function validateManifest(
  input: unknown,
  options?: ValidateManifestOptions,
  toolRegistry?: ToolRegistrySnapshot,
): PackageManifest {
  const r = packageManifestSchema.safeParse(input)
  if (!r.success) throw new ManifestValidationError(r.error.issues)
  const data = r.data
  // Synthesize dependencies.tools when only cross_app_calls is declared so
  // downstream callers (B7's resolve-targets pass) have one canonical list.
  if (data.cross_app_calls && data.cross_app_calls.length > 0) {
    const existing = data.dependencies?.tools
    if (!existing || existing.length === 0) {
      data.dependencies = {
        ...(data.dependencies ?? {}),
        tools: data.cross_app_calls.map((c) => c.target),
      }
    }
  }
  // Phase 17 B7 — install-time resolve-targets pass. Verifies every declared
  // cross-app target is registered against `toolRegistry`. Surfacing the
  // failure here (not at first-call) means an install with a typo on
  // `mail:composee` fails loudly at install time, not weeks later when an
  // agent first invokes the tool.
  if (options?.resolveTargets) {
    if (!toolRegistry) {
      throw new Error("validateManifest: resolveTargets requires a toolRegistry argument")
    }
    const missing: string[] = []
    for (const call of data.cross_app_calls ?? []) {
      if (!toolRegistry.has(call.target)) missing.push(call.target)
    }
    if (missing.length > 0) {
      throw new ManifestValidationError([
        {
          code: "custom",
          path: ["cross_app_calls"],
          message: `cross-app target tool not declared by target app: ${missing.join(", ")}`,
        } as z.ZodIssue,
      ])
    }
  }
  return data
}

/**
 * Shape returned by `GET /api/apps` — pinned here so the `liaison app` CLI and
 * the admin UI stay in sync on the registry-listing contract.
 */
export const appRegistryEntrySchema = z.object({
  name: z.string(),
  version: z.string(),
  displayName: z.string().optional(),
  // An installed app's publisher as its manifest names it (`author`), shown on
  // the App store page of an app without a listing.
  author: z.string().optional(),
  source: z.enum(["in-tree", "installed"]),
  status: z.enum(["active", "shadowed-by-bundled", "error"]),
  statusMessage: z.string().optional(),
  // A core app (server code); false for every other app, installed ones included.
  core: z.boolean(),
  grantedScopes: z.array(z.string()).optional(),
  // Capabilities the admin granted; absent for installs that pre-date capability grants.
  grantedCapabilities: z.array(z.string()).optional(),
  grantedCrossAppCalls: z.array(z.string()).optional(),
  // Whether the package ships an interface (ui.js), why it may load (null = it may
  // not), and the admin's recorded "runs with full access to your session" approval.
  hasUiBundle: z.boolean().optional(),
  uiTrust: z.enum(["first-party", "publisher-signed", "admin-approved"]).nullable().optional(),
  uiFullAccessApproved: z.boolean().optional(),
  uiFullAccessApprovedAt: z.string().optional(),
  updateUrl: z.string().optional(),
  installedAt: z.string().optional(),
  upgradedAt: z.string().optional(),
  // The version a rollback returns to (kept on disk beside the active one), and
  // whether the active version is a security release that refuses a rollback.
  previousVersion: z.string().optional(),
  noRollback: z.boolean().optional(),
})

export type AppRegistryEntry = z.infer<typeof appRegistryEntrySchema>
