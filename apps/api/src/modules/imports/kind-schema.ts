// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Import kind declarations (`import.kinds` in an app manifest): the cross-field
 * rules the JSON Schema of the manifest cannot express, and the compiled record
 * validator a run checks every record with.
 *
 * Kept free of runtime imports (Ajv, the param-validator cache and lib/guards
 * only) so the manifest validator (modules/apps/contract.ts) can use it without
 * an import cycle.
 */
import type { ValidateFunction } from "ajv"
import { isRecord } from "~/lib/guards"
import { createParamValidatorCache } from "~/modules/apps/param-validator"

/** One kind as declared in a manifest's `import.kinds.<name>`. */
export interface ImportKindDecl {
  label?: string
  schema: Record<string, unknown>
  handler: string
  /** Export name of the preview's check (installed apps): the handler's own
   *  per-record checks without writing, one `{ status, error? }` per record. */
  check?: string
  dedupKey: string
  tables: string[]
  writeScopes: string[]
  dimension?: { field: string; dimension: string }
  people?: string[]
  files?: string[]
  parent?: string
  /** Tables (a subset of `tables`) holding in-run roll-ups: rows a later
   *  record of the same run updates (a conversation's counters). For a row of
   *  these tables the run created, undo's changed-after check compares with
   *  the run's end instead of the moment the row was recorded. */
  rollupTables?: string[]
}

export interface ImportDecl {
  kinds: Record<string, ImportKindDecl>
}

// Same options as the manifest validator's instance (MANIFEST_AJV_OPTIONS in
// contract.ts); `strict: false` lets a kind schema carry descriptive keywords
// (`description`, `examples`) without failing compilation. Each schema compiles
// on its own Ajv (createParamValidatorCache): a shared instance would hold every
// org's manifest copy of a kind schema for the life of the process.
const compiled = createParamValidatorCache({
  allErrors: true,
  allowUnionTypes: true,
  strict: false,
})

/** The compiled validator of a kind's record schema (cached per schema object). */
export function compileKindSchema(schema: Record<string, unknown>): ValidateFunction {
  return compiled(schema)
}

/** Validate one record against its kind. `null` when valid, else the error text. */
export function kindRecordError(decl: ImportKindDecl, record: unknown): string | null {
  const validate = compileKindSchema(decl.schema)
  if (validate(record)) return null
  return (validate.errors ?? [])
    .map((e) => {
      const extra = (e.params as { additionalProperty?: unknown }).additionalProperty
      const named = typeof extra === "string" ? ` (${extra})` : ""
      return `${e.instancePath || "/"}: ${e.message ?? "invalid"}${named}`
    })
    .join("; ")
}

const QUALIFIED_TABLE = /^([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)$/

/**
 * Kernel tables a BUILT-IN app's kind may write (and undo may delete): the
 * people, files and threads a ticket or task import creates. Any other kernel
 * table is refused in every manifest, and an installed (bundled) app may only
 * name tables of its own `app_<name>` schema (`importTableErrors`).
 */
export const KERNEL_IMPORT_TABLES: ReadonlySet<string> = new Set([
  "kernel.companies",
  "kernel.contacts",
  "kernel.files",
  "kernel.message_reactions",
  "kernel.messages",
  "kernel.resource_grants",
  "kernel.routines",
  "kernel.skills",
  "kernel.thread_participants",
  "kernel.threads",
  "kernel.user_dimension_grants",
  "kernel.users",
])

/** The schema an app's own tables live in: `app_<name>`, dashes as underscores. */
export function ownAppSchema(appName: string): string {
  return `app_${appName.replace(/-/g, "_")}`
}

/**
 * Tables a kind may declare: its app's own schema, plus (built-in apps only)
 * the allowlisted kernel tables. Undo deletes exactly what a kind declares,
 * so a kind naming another app's table or a kernel table such as
 * `kernel.organizations` is refused.
 */
export function importTableErrors(
  appName: string,
  kindName: string,
  tables: readonly string[],
  opts: { builtin: boolean },
): string[] {
  const errors: string[] = []
  const own = ownAppSchema(appName)
  for (const t of tables) {
    const m = QUALIFIED_TABLE.exec(t)
    if (!m) {
      errors.push(`import.kinds.${kindName}.tables: "${t}" is not a schema-qualified table`)
      continue
    }
    if (m[1] === own) continue
    if (KERNEL_IMPORT_TABLES.has(t) && opts.builtin) continue
    errors.push(
      KERNEL_IMPORT_TABLES.has(t)
        ? `import.kinds.${kindName}.tables: "${t}" may only be written by a built-in app's kind`
        : `import.kinds.${kindName}.tables: "${t}" is outside the app's own schema (${own})`,
    )
  }
  return errors
}

/**
 * What a kind may declare given who runs it: `importTableErrors`, and
 * `rollupTables` (rows whose ledger time a record may move) only for a
 * built-in app's kind, never an installed one.
 */
export function importKindRestrictionErrors(
  appName: string,
  kindName: string,
  decl: Pick<ImportKindDecl, "tables" | "rollupTables">,
  opts: { builtin: boolean },
): string[] {
  const errors = importTableErrors(appName, kindName, decl.tables, opts)
  if (!opts.builtin && (decl.rollupTables?.length ?? 0) > 0) {
    errors.push(
      `import.kinds.${kindName}.rollupTables: only a built-in app's kind may declare them`,
    )
  }
  return errors
}

/**
 * Cross-field rules for `import.kinds` (the JSON Schema of the manifest checks
 * the shape): a record schema of `type: "object"` that compiles, a dedupKey
 * naming a top-level string property, a dimension field that exists, a
 * parent naming a sibling kind, and rollupTables among the kind's tables.
 */
export function importDeclarationErrors(importDecl: unknown, appName?: string): string[] {
  if (importDecl === undefined) return []
  if (!isRecord(importDecl) || !isRecord(importDecl.kinds)) return []
  const errors: string[] = []
  const kinds = importDecl.kinds
  for (const [name, raw] of Object.entries(kinds)) {
    if (!isRecord(raw)) continue
    const at = `import.kinds.${name}`
    if (appName !== undefined && Array.isArray(raw.tables)) {
      // The manifest alone cannot say whether the app is built in: kernel
      // tables pass here only when allowlisted; registration then refuses
      // them for an installed app (runtime.ts).
      errors.push(
        ...importTableErrors(
          appName,
          name,
          raw.tables.filter((t): t is string => typeof t === "string"),
          { builtin: true },
        ),
      )
    }
    const schema = raw.schema
    if (!isRecord(schema) || schema.type !== "object") {
      errors.push(`${at}.schema: must be an object schema (type: "object")`)
      continue
    }
    try {
      compileKindSchema(schema)
    } catch (err) {
      errors.push(
        `${at}.schema: does not compile: ${err instanceof Error ? err.message : String(err)}`,
      )
      continue
    }
    const props = isRecord(schema.properties) ? schema.properties : {}
    const dedupKey = raw.dedupKey
    if (typeof dedupKey === "string") {
      const prop = props[dedupKey]
      if (!isRecord(prop) || prop.type !== "string") {
        errors.push(`${at}.dedupKey: "${dedupKey}" must name a top-level string property`)
      } else {
        const required = Array.isArray(schema.required) ? schema.required : []
        if (!required.includes(dedupKey)) {
          errors.push(`${at}.dedupKey: "${dedupKey}" must be listed in schema.required`)
        }
      }
    }
    const dimension = raw.dimension
    if (isRecord(dimension) && typeof dimension.field === "string" && !(dimension.field in props)) {
      errors.push(`${at}.dimension.field: "${dimension.field}" is not a property of the schema`)
    }
    if (Array.isArray(raw.rollupTables)) {
      const tables = Array.isArray(raw.tables) ? raw.tables : []
      for (const t of raw.rollupTables) {
        if (!tables.includes(t)) {
          errors.push(`${at}.rollupTables: "${String(t)}" is not one of the kind's tables`)
        }
      }
    }
    const parent = raw.parent
    if (typeof parent === "string") {
      if (parent === name) errors.push(`${at}.parent: a kind cannot be its own parent`)
      else if (!(parent in kinds))
        errors.push(`${at}.parent: "${parent}" is not a kind of this app`)
    }
  }
  return errors
}
