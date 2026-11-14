// SPDX-License-Identifier: FSL-1.1-ALv2
// Declarative app settings: the manifest `settings` object the kernel renders as
// ONE settings page per app (`/settings/apps/<app>`), and the `kind` that tells
// an app from a connector. This module is the single structural definition: the
// runtime manifest validator (apps/api `validateAppManifest`) and the package
// schema below both parse a manifest's `settings` with `appSettingsSchema` and
// run `settingsDeclarationErrors` for the cross-field rules.
//
// A section holds blocks, each tagged by `block`:
//   - `field`: one value at a dot path, stored in the org or user settings
//     namespace of the app (`source: "settings"`, the default), in a declared
//     `configKeys` key (`"config"`, org sections only), or read and written by a
//     pair of the app's own tools (`{ tool: { get, set } }`).
//   - `connections`: the manifest `connections` (all, or the named ones), with
//     an optional `status` read tool whose answer is the block's status line.
//   - `list` / `tree`: rows bound to the app's tools by name.
//   - `custom`: an export of the app's UI bundle, with the reason a declarative
//     block cannot do the job.
import { z } from "zod"

export const APP_KINDS = ["app", "connector"] as const
export type AppKind = (typeof APP_KINDS)[number]

export const SETTINGS_FIELD_TYPES = [
  "text",
  "textarea",
  "number",
  "toggle",
  "select",
  "multiselect",
  "url",
  "email",
  "date",
  "dates",
  "duration",
  "schedule",
] as const
export type SettingsFieldType = (typeof SETTINGS_FIELD_TYPES)[number]

/**
 * Top-level keys of `organizations.settings` (and `users.settings`) that the
 * kernel owns. An app's settings live at `settings.<app name>`, so an app named
 * like one of these would read and write kernel state through its settings
 * page. Every name here is refused as an app name. Kept in step with the org
 * settings schemas (`@liaison/shared` validation/org.ts and
 * org-kernel-settings.ts) and the keys the kernel writes directly
 * (`enabledApps`, `hiddenApps`, `demo`, `demoReset`). `users.settings` holds
 * app namespaces only today, so it adds no key of its own.
 */
export const RESERVED_SETTINGS_NAMESPACES = [
  "kernel",
  "providerKeys",
  "integrations",
  "taintSources",
  "ai",
  "requireAdminSecondFactor",
  "rateLimitPerMinute",
  "enabledApps",
  "hiddenApps",
  "fileSizeLimitMb",
  "importFileSizeLimitMb",
  "storageQuotaGb",
  "auditRetentionDays",
  "resetDate",
  "enterpriseAllowance",
  "webContentProtection",
  "webFetchAllowlist",
  "webFetchBlocklist",
  "webSearchCreditCost",
  "allowedMailDomains",
  "email",
  "demo",
  "demoReset",
  "mediaAnalysis",
] as const

const RESERVED_SET = new Set<string>(RESERVED_SETTINGS_NAMESPACES)

/** Is `name` a kernel-owned settings key, and so not a valid app name? */
export function isReservedSettingsNamespace(name: string): boolean {
  return RESERVED_SET.has(name)
}

/**
 * Key names that hold secret material (the org route withholds them from
 * members). Secrets never travel as settings fields: credentials go through
 * `connections`. Same pattern as the org route's redaction.
 */
export const SETTINGS_SECRET_KEY_PATTERN =
  /secret|password|passphrase|api[-_]?key|credential|ciphertext|encrypted|(access|refresh|auth|bearer|api|id)[-_]?token/i

const SEGMENT = "[a-zA-Z][a-zA-Z0-9_]*"
/** A field key: a dot path of identifiers, at most 8 deep. */
const FIELD_KEY_REGEX = new RegExp(`^${SEGMENT}(\\.${SEGMENT}){0,7}$`)
/**
 * Segments that reach the object machinery instead of data (`constructor.prototype.x`
 * would write on the prototype every object shares). The host refuses them too.
 */
const UNSAFE_KEY_SEGMENTS = new Set(["__proto__", "constructor", "prototype"])
const hasUnsafeKeySegment = (key: string): boolean =>
  key.split(".").some((s) => UNSAFE_KEY_SEGMENTS.has(s))
const SECTION_ID_REGEX = /^[a-z][a-z0-9-]*$/
/** A tool of the declaring app, by its manifest name (`categories.list`, `settings_get`). */
const TOOL_REF_REGEX = /^[a-zA-Z][a-zA-Z0-9_.-]*$/

const toolRef = z.string().max(128).regex(TOOL_REF_REGEX, "must be a tool name of this app")
const labelKey = z.string().min(1).max(200)

/** How a list column's cell reads. */
export const SETTINGS_LIST_COLUMN_FORMATS = [
  "text",
  "datetime",
  "enum",
  "status",
  "basisPoints",
] as const

const optionSchema = z
  .object({
    value: z.union([z.string(), z.number()]),
    label: z.string().min(1),
    labelKey: labelKey.optional(),
  })
  .strict()

const validationSchema = z
  .object({
    min: z.number().optional(),
    max: z.number().optional(),
    pattern: z.string().min(1).optional(),
    required: z.boolean().optional(),
  })
  .strict()

const sourceSchema = z.union([
  z.literal("settings"),
  z.literal("config"),
  z.object({ tool: z.object({ get: toolRef, set: toolRef }).strict() }).strict(),
])

const fieldShape = {
  key: z
    .string()
    .max(200)
    .regex(FIELD_KEY_REGEX, "must be a dot path of identifiers")
    .refine((k) => !hasUnsafeKeySegment(k), "must not use constructor, prototype or __proto__"),
  type: z.enum(SETTINGS_FIELD_TYPES),
  label: z.string().min(1),
  labelKey: labelKey.optional(),
  help: z.string().min(1).optional(),
  helpKey: labelKey.optional(),
  options: z.array(optionSchema).min(1).optional(),
  optionsTool: toolRef.optional(),
  default: z.unknown().optional(),
  validation: validationSchema.optional(),
}

/** A field as a list block's create form declares it (no own store). */
const listCreateFieldSchema = z.object(fieldShape).strict()

const fieldBlockSchema = z
  .object({ block: z.literal("field"), ...fieldShape, source: sourceSchema.optional() })
  .strict()

const connectionsBlockSchema = z
  .object({
    block: z.literal("connections"),
    /** The manifest `connections` this block shows; absent = all of them. */
    names: z.array(z.string().min(1)).min(1).optional(),
    /**
     * A read tool of the app that checks the connection works (a cheap real
     * read). Its answer is the block's status line: data = connected, a
     * `not_connected` / `<x>_not_connected` error = not connected, any other
     * error = unavailable with its message. A `warnings: string[]` in the
     * answer is listed under the line. Never an approval-gated tool.
     */
    status: z
      .object({
        tool: toolRef,
        params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      })
      .strict()
      .optional(),
    /** What disconnecting an account deletes, said in the confirmation. */
    disconnectBody: z.string().min(1).optional(),
    disconnectBodyKey: labelKey.optional(),
  })
  .strict()

const listBlockSchema = z
  .object({
    block: z.literal("list"),
    /** A heading over the list, saying what its rows are and what Add adds. */
    title: z.string().min(1).optional(),
    titleKey: labelKey.optional(),
    ops: z
      .object({
        list: toolRef,
        create: toolRef.optional(),
        /**
         * Edits a row in place: the page opens `createFields` filled from the
         * row and, on Save, calls this tool with `{ id, ...those fields }`.
         */
        update: toolRef.optional(),
        archive: toolRef.optional(),
        rowAction: z
          .array(
            z
              .object({ label: z.string().min(1), labelKey: labelKey.optional(), tool: toolRef })
              .strict(),
          )
          .optional(),
      })
      .strict(),
    columns: z
      .array(
        z
          .object({
            key: z.string().min(1),
            label: z.string().min(1),
            labelKey: labelKey.optional(),
            /**
             * How the cell reads (default `text`): `datetime` a relative time
             * ("2h ago", "Never"), `enum` the label of the value's option,
             * `status` that label as a badge, with the row's `errorKey` value
             * (the real error) beside it, `basisPoints` an integer of basis
             * points read as a percentage in the reader's locale (2000 → "20%").
             */
            format: z.enum(SETTINGS_LIST_COLUMN_FORMATS).optional(),
            /** `enum` / `status`: the label of each value (a value without one reads as itself). */
            options: z.array(optionSchema).optional(),
            /** `status`: the row key holding the error message shown with the badge. */
            errorKey: z.string().min(1).optional(),
          })
          .strict(),
      )
      .min(1),
    createFields: z.array(listCreateFieldSchema).optional(),
    /** The archive action's name ("Remove", "Revoke"); default "Archive". */
    archiveLabel: z.string().min(1).optional(),
    archiveLabelKey: labelKey.optional(),
    /** A key of the create result shown once (a generated secret), never stored by the page. */
    revealOnCreate: z.string().min(1).optional(),
  })
  .strict()

const treeBlockSchema = z
  .object({
    block: z.literal("tree"),
    ops: z
      .object({
        list: toolRef,
        create: toolRef,
        update: toolRef,
        reorder: toolRef,
        archive: toolRef,
      })
      .strict(),
    maxDepth: z.number().int().min(1).max(5),
  })
  .strict()

const customBlockSchema = z
  .object({
    block: z.literal("custom"),
    /** Export name in the app's UI bundle. */
    component: z.string().min(1),
    /** Why no declarative block fits; listed in the settings inventory. */
    reason: z.string().trim().min(1, "a custom block states why no declarative block fits"),
  })
  .strict()

export const settingsBlockSchema = z.discriminatedUnion("block", [
  fieldBlockSchema,
  connectionsBlockSchema,
  listBlockSchema,
  treeBlockSchema,
  customBlockSchema,
])

export const settingsSectionSchema = z
  .object({
    id: z.string().max(64).regex(SECTION_ID_REGEX, "must be kebab-case"),
    title: z.string().min(1),
    titleKey: labelKey.optional(),
    description: z.string().min(1).optional(),
    descriptionKey: labelKey.optional(),
    /** `user`: the viewer's own preferences. `org`: the organization's settings. */
    scope: z.enum(["user", "org"]),
    /**
     * Scope that reads and writes an org section's `config` and `tool` fields and
     * writes its `settings` fields. Default `kernel:apps:admin`. Not allowed on a
     * user section.
     */
    adminScope: z.string().min(1).optional(),
    /** Names a feature the app declares under top-level `features`: off, the section is absent. */
    feature: z.string().min(1).optional(),
    blocks: z.array(settingsBlockSchema).min(1),
  })
  .strict()

export const appSettingsSchema = z
  .object({ sections: z.array(settingsSectionSchema).min(1) })
  .strict()

export const appKindSchema = z.enum(APP_KINDS)

export type AppSettingsSchema = z.infer<typeof appSettingsSchema>
export type SettingsSection = z.infer<typeof settingsSectionSchema>
export type SettingsBlock = z.infer<typeof settingsBlockSchema>
export type SettingsField = z.infer<typeof fieldBlockSchema>
export type SettingsListCreateField = z.infer<typeof listCreateFieldSchema>
export type SettingsFieldSource = z.infer<typeof sourceSchema>
export type SettingsConnectionsBlock = z.infer<typeof connectionsBlockSchema>
export type SettingsListBlock = z.infer<typeof listBlockSchema>
export type SettingsTreeBlock = z.infer<typeof treeBlockSchema>
export type SettingsCustomBlock = z.infer<typeof customBlockSchema>

/** The default scope of an org section that declares none. */
export const DEFAULT_SETTINGS_ADMIN_SCOPE = "kernel:apps:admin"

/** Where a field's value lives: `settings`, `config`, or a tool pair. */
export function fieldSourceKind(
  field: Pick<SettingsField, "source">,
): "settings" | "config" | "tool" {
  const s = field.source
  if (s === undefined || s === "settings") return "settings"
  if (s === "config") return "config"
  return "tool"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export interface SettingsDeclarationOptions {
  /**
   * Scopes an org section's `adminScope` may name (the app's own declared or
   * derived scopes plus the kernel scopes). Omitted = not checked here (the
   * package schema has no kernel catalog; the runtime validator passes it).
   */
  knownScopes?: (scope: string) => boolean
}

/**
 * Cross-field problems of a manifest's `kind` and `settings` (the shape itself
 * is `appSettingsSchema`'s job, run first). Accepts the raw manifest; returns
 * human-readable messages, empty when valid.
 */
export function settingsDeclarationErrors(
  manifest: unknown,
  opts: SettingsDeclarationOptions = {},
): string[] {
  const errors: string[] = []
  if (!isRecord(manifest)) return errors
  const name = typeof manifest.name === "string" ? manifest.name : ""
  if (name && isReservedSettingsNamespace(name)) {
    errors.push(`name: "${name}" is reserved, it names kernel settings`)
  }

  const views = isRecord(manifest.views) ? manifest.views : {}
  // An app's own settings pages are gone: ONE declarative page per app.
  if (views.settings !== undefined) {
    errors.push(
      'views.settings: removed; declare the app\'s settings page with the manifest "settings" object (sections of blocks)',
    )
  }
  if (manifest.kind === "connector") {
    for (const key of ["activityBar", "tabTypes"]) {
      if (views[key] !== undefined) {
        errors.push(`views.${key}: a connector has no workspace view (kind "connector")`)
      }
    }
  }

  const parsed = appSettingsSchema.safeParse(manifest.settings)
  if (manifest.settings === undefined || !parsed.success) return errors
  const settings = parsed.data

  const tools = new Set(Object.keys(isRecord(manifest.tools) ? manifest.tools : {}))
  const connections = new Set(
    Object.keys(isRecord(manifest.connections) ? manifest.connections : {}),
  )
  const configKeys = new Set(
    (Array.isArray(manifest.configKeys) ? manifest.configKeys : [])
      .filter(isRecord)
      .map((d) => d.key)
      .filter((k): k is string => typeof k === "string"),
  )
  const needTool = (where: string, tool: string) => {
    if (!tools.has(tool)) errors.push(`${where}: "${tool}" is not a tool of this app`)
  }

  const sectionIds = new Set<string>()
  const settingsKeys = { user: new Map<string, string>(), org: new Map<string, string>() }
  settings.sections.forEach((section, si) => {
    const at = `settings.sections[${si}]`
    if (sectionIds.has(section.id)) errors.push(`${at}.id: duplicate section id "${section.id}"`)
    sectionIds.add(section.id)
    if (section.adminScope !== undefined) {
      if (section.scope === "user") {
        errors.push(`${at}.adminScope: only an org section has an admin scope`)
      } else if (opts.knownScopes && !opts.knownScopes(section.adminScope)) {
        errors.push(
          `${at}.adminScope: "${section.adminScope}" is neither a scope of this app nor a kernel scope`,
        )
      }
    }
    section.blocks.forEach((block, bi) => {
      const bat = `${at}.blocks[${bi}]`
      switch (block.block) {
        case "field": {
          errors.push(...fieldErrors(bat, block, needTool))
          if (block.key.split(".").some((seg) => SETTINGS_SECRET_KEY_PATTERN.test(seg))) {
            errors.push(
              `${bat}.key: "${block.key}" names secret material, secrets go through connections`,
            )
          }
          const kind = fieldSourceKind(block)
          if (kind === "config") {
            if (section.scope !== "org") {
              errors.push(`${bat}.source: a "config" field belongs in an org section`)
            }
            if (!configKeys.has(block.key)) {
              errors.push(`${bat}.key: "${block.key}" is not declared in configKeys`)
            }
          } else if (kind === "tool" && isRecord(block.source)) {
            const t = (block.source as { tool: { get: string; set: string } }).tool
            needTool(`${bat}.source.tool.get`, t.get)
            needTool(`${bat}.source.tool.set`, t.set)
          } else if (kind === "settings") {
            const seen = settingsKeys[section.scope]
            const clash = [...seen.keys()].find(
              (k) =>
                k === block.key || k.startsWith(`${block.key}.`) || block.key.startsWith(`${k}.`),
            )
            if (clash !== undefined) {
              errors.push(
                `${bat}.key: "${block.key}" overlaps "${clash}" (${seen.get(clash)}) in the ${section.scope} settings`,
              )
            }
            seen.set(block.key, bat)
          }
          break
        }
        case "connections": {
          if (connections.size === 0) {
            errors.push(`${bat}: a connections block needs manifest connections`)
          }
          for (const n of block.names ?? []) {
            if (!connections.has(n))
              errors.push(`${bat}.names: "${n}" is not a declared connection`)
          }
          if (block.status) {
            const t = block.status.tool
            needTool(`${bat}.status.tool`, t)
            const decl = isRecord(manifest.tools) ? manifest.tools[t] : undefined
            if (isRecord(decl) && decl.gated === true) {
              errors.push(
                `${bat}.status.tool: "${t}" is approval-gated, a status read answers at once`,
              )
            }
          }
          break
        }
        case "list": {
          for (const [op, tool] of Object.entries(block.ops)) {
            if (typeof tool === "string") needTool(`${bat}.ops.${op}`, tool)
          }
          for (const [ri, action] of (block.ops.rowAction ?? []).entries()) {
            needTool(`${bat}.ops.rowAction[${ri}].tool`, action.tool)
          }
          if (block.createFields && !block.ops.create) {
            errors.push(`${bat}.createFields: declared without ops.create`)
          }
          if (block.archiveLabel && !block.ops.archive) {
            errors.push(`${bat}.archiveLabel: declared without ops.archive`)
          }
          if (block.revealOnCreate && !block.ops.create) {
            errors.push(`${bat}.revealOnCreate: declared without ops.create`)
          }
          for (const [fi, f] of (block.createFields ?? []).entries()) {
            errors.push(...fieldErrors(`${bat}.createFields[${fi}]`, f, needTool))
          }
          break
        }
        case "tree": {
          for (const [op, tool] of Object.entries(block.ops)) needTool(`${bat}.ops.${op}`, tool)
          break
        }
        case "custom":
          break
      }
    })
  })
  return errors
}

function fieldErrors(
  at: string,
  field: SettingsListCreateField,
  needTool: (where: string, tool: string) => void,
): string[] {
  const errors: string[] = []
  const choice = field.type === "select" || field.type === "multiselect"
  if (choice && !field.options && !field.optionsTool) {
    errors.push(`${at}: a ${field.type} field declares options or optionsTool`)
  }
  if (!choice && (field.options || field.optionsTool)) {
    errors.push(`${at}: options belong to select and multiselect fields`)
  }
  if (field.options && field.optionsTool) {
    errors.push(`${at}: declare options or optionsTool, not both`)
  }
  if (field.optionsTool) needTool(`${at}.optionsTool`, field.optionsTool)
  const v = field.validation
  if (v?.min !== undefined && v.max !== undefined && v.min > v.max) {
    errors.push(`${at}.validation: min is greater than max`)
  }
  if (v?.pattern !== undefined) {
    try {
      new RegExp(v.pattern)
    } catch {
      errors.push(`${at}.validation.pattern: not a valid regular expression`)
    }
  }
  return errors
}
