// SPDX-License-Identifier: FSL-1.1-ALv2

import { z } from "zod"
import { runsForErrors } from "~/infra/jobs/fanout-runs-for"
import { appSurfaceErrors } from "~/modules/apps/app-surface"
import { connectionLimitsErrors } from "~/modules/apps/connection-limits"
import { createParamValidatorCache } from "~/modules/apps/param-validator"
import { pinnedOverlap } from "~/modules/apps/pinned-params"
import { validateProviderContracts } from "~/modules/apps/provider-contracts/validate"
import { resultCardErrors } from "~/modules/apps/result-card-schema"

/** Compiles a knowledge source kind's configSchema (the same options its config check uses). */
export const knowledgeConfigValidator = createParamValidatorCache({ allErrors: true })

const SEMVER_REGEX = /^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/
const NAME_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/
// A `schema.<table>` key becomes a Postgres table name, so the snake_case the
// manifest path (and every bundled app) uses is valid here too.
const TABLE_KEY_REGEX = /^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$/
const SLOT_KEY_REGEX = /^[a-z0-9-]+:[a-z0-9-]+(:[a-z0-9-]+)*$/
const WEBHOOK_KEY_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/
const EVENT_REGEX = /^[a-z_]+:[a-z_]+$/
const CRON_REGEX =
  /^(\*(\/\d+)?|[0-9,\-/]+)\s+(\*(\/\d+)?|[0-9,\-/]+)\s+(\*(\/\d+)?|[0-9,\-/]+)\s+(\*(\/\d+)?|[0-9,\-/]+)\s+(\*(\/\d+)?|[0-9,\-/]+)(\s+(\*(\/\d+)?|[0-9,\-/]+))?$/

function isFunction(v: unknown): boolean {
  return typeof v === "function"
}

const dimensionDefSchema = z.object({
  type: z.enum(["membership", "level", "enum", "value"]),
  order: z.array(z.string()).optional(),
  values: z.array(z.string()).optional(),
})

const fieldDefSchema = z.union([
  z.string(),
  z.object({
    type: z.string(),
    required: z.boolean().optional(),
    // Per-field GDPR erasure declaration (G1). A `userRef` field references a
    // kernel.users id; `onErase` says what the cascade does to it. The
    // cross-field rule (userRef⇔onErase, onErase enum) is enforced in
    // validateSchemaConstraints so both the manifest and descriptor paths
    // share one check.
    userRef: z.literal(true).optional(),
    onErase: z.enum(["delete", "anonymize"]).optional(),
  }),
])

const entitySchemaSchema = z.object({
  fields: z.record(z.string(), fieldDefSchema).optional(),
  dimensions: z.record(z.string(), dimensionDefSchema).optional(),
  timeline: z.array(z.string()).optional(),
  searchable: z.array(z.string()).optional(),
})

const toolSchema = z.object({
  description: z.string(),
  params: z
    .union([
      z.record(z.string(), z.string()),
      z
        .any()
        .refine(
          (v) => v && typeof v.safeParse === "function",
          "params must be a Zod schema or field map",
        ),
    ])
    .optional(),
  requiredScopes: z.array(z.string().min(1)).min(1),
  handler: z.any().refine(isFunction, "handler must be a function"),
  gated: z.boolean().optional(),
  // See manifest-schema.ts: a handler-conditionally-gated tool keeps `gated`
  // unset but marks `conditionalGate: true` so gate-only companion fields
  // (editableFields, approvalImpact) stay declarable.
  conditionalGate: z.boolean().optional(),
  // Blast-radius classification for a gated tool's approval. "external" = the
  // action's effect leaves the org or is customer/world-visible (send an
  // email, reply to a customer ticket, post publicly, create a refund/
  // shipment/invoice sent to a customer, spend money). "internal" =
  // org-internal and reversible (close/reopen a ticket, set a label/category/
  // priority, an internal note). Undeclared gated tools are treated as
  // "external" downstream — fail-safe: nothing risky may read as safe.
  approvalImpact: z.enum(["external", "internal"]).optional(),
  // Approvals for this tool must be decided FROM THE RECORD, not from a feed
  // row: the card renders only a way into the record outside it. For actions a
  // reviewer cannot judge without the surrounding context (a customer-facing
  // ticket reply). Presentation-level by design, not a security boundary.
  decideInContext: z.boolean().optional(),
  // DELIBERATELY ABSENT: `approveScope` / `approvalDimension`. These are
  // HOST-ONLY registry fields (set by host-registered tools, e.g. the skill
  // tools in skills-routines-tools.ts). Letting a sandboxed third-party
  // manifest choose which scope decides its own approvals is a privilege-
  // escalation surface (an app could name a weak scope to dodge
  // `<app>:approve`) that needs its own validation design before exposure.
  // The registry-field-closure oracle pins this: it asserts these fields stay
  // out of this schema AND are set on the host-registration path, so adding
  // the manifest field without threading the runtime.ts copy fails CI.
  trustBoundary: z.enum(["internal", "agent", "user"]).optional(),
  // Provider-contract op / outbound legal action flags (see manifest-schema.ts).
  contractOnly: z.boolean().optional(),
  noAutoApprove: z.boolean().optional(),
  // The params the preflight pins; a caller's value is dropped (execute-tool.ts).
  pinnedParams: z
    .array(
      z
        .string()
        .min(1)
        .regex(/^[^.]+$/, "a pinned param is a top-level param name, never a dotted path"),
    )
    .optional(),
  // The params carrying text a person outside the org reads (outbound-placeholders.ts).
  outboundTextParams: z
    .array(
      z
        .string()
        .min(1)
        .regex(/^[^.]+$/, "a top-level param name, never a dotted path"),
    )
    .optional(),
  // Webhook signing secrets the host writes into this tool's answer (reveal-secrets.ts).
  revealsSecrets: z.array(z.string().min(1)).optional(),
  instructions: z.string().optional(),
  taintSource: z.boolean().optional(),
  // The tool has an external side effect or an exfiltration channel (it sends, posts,
  // uploads or fetches outward). An UNGATED call after the turn read untrusted text parks as an
  // approval instead of running (taint_escalation). See scopes/taint.ts.
  externalEffect: z.boolean().optional(),
  retryOnTransientDbError: z.boolean().optional(),
  atomic: z.boolean().optional(),
  approvalCard: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  returns: z
    .object({
      schema: z.record(z.string(), z.string()).optional(),
      dimensions: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  import: z
    .object({
      kinds: z.record(
        z.string().regex(/^[a-z][a-z0-9-]*$/, "Import kind name must be kebab-case"),
        z.object({
          label: z.string().optional(),
          schema: z.record(z.string(), z.unknown()),
          handler: z.string().min(1),
          dedupKey: z.string().min(1),
          tables: z.array(z.string().min(1)).min(1),
          writeScopes: z.array(z.string().min(1)).min(1),
          dimension: z.object({ field: z.string(), dimension: z.string() }).optional(),
          people: z.array(z.string()).optional(),
          files: z.array(z.string()).optional(),
          parent: z.string().optional(),
        }),
      ),
    })
    .optional(),
})

const jobSchema = z.object({
  schedule: z
    .string()
    .refine((s) => CRON_REGEX.test(s), "Invalid cron expression")
    .optional(),
  handler: z.any().refine(isFunction, "handler must be a function"),
  // Bridge-owned transactions escape hatch, same as tools: by default a
  // sandboxed job runs with NO ambient transaction (one short RLS transaction
  // per bridge call, so no connection/row lock is held across its network I/O).
  // `atomic: true` keeps the legacy whole-run transaction for a job whose
  // failure paths rely on whole-run rollback. See modules/apps/runtime.ts
  // jobTxMode + infra/jobs/job-context.ts.
  atomic: z.boolean().optional(),
  // Which orgs a scheduled run is for (infra/jobs/fanout-runs-for.ts); checked by runsForErrors.
  runsFor: z.unknown().optional(),
  retry: z
    .object({
      attempts: z.number().optional(),
      backoff: z.enum(["exponential", "fixed"]).optional(),
    })
    .optional(),
})

const webhookSchema = z.object({
  handler: z.any().refine(isFunction, "handler must be a function"),
  verify: z.any().refine(isFunction, "verify must be a function"),
  bodyLimitBytes: z
    .number()
    .int()
    .min(1024)
    .max(10 * 1024 * 1024)
    .optional(),
  timeoutMs: z.number().int().min(1000).max(29000).optional(),
  // See webhookHandlers registry's requiresUserActor doc comment
  // (modules/apps/app-registries.ts) — opt-in, defaults unset/false.
  requiresUserActor: z.boolean().optional(),
})

const viewEntrySchema = z.looseObject({
  icon: z.any().optional(),
  label: z.string(),
  order: z.number().optional(),
  component: z.any().optional(),
  saveable: z.boolean().optional(),
})

const entityDefSchema = z.object({
  labelField: z.string(),
  handlePrefix: z.string().optional(),
  searchable: z.boolean().optional(),
  cardComponent: z.any().optional(),
  tableName: z.string().optional(),
})

const slotSchema = z.object({
  position: z.enum(["tabs", "toolbar", "menu", "sidebar"]),
})

const contributionSchema = z.union([
  z.looseObject({ label: z.string(), component: z.any() }),
  z.array(z.object({ label: z.string(), action: z.any() })),
])

const SKILL_DESCRIPTION_MAX = 100

const builtinSkillSchema = z.object({
  description: z.string().min(1).max(SKILL_DESCRIPTION_MAX),
  // Body may be a string OR a lazy loader `() => Promise<string>` — the runtime
  // resolves the function once at app-register, failing app registration if it
  // throws. Lazy form supports the file-system load pattern documented in the
  // spec while keeping the descriptor surface synchronous to author.
  body: z.union([z.string().min(1), z.function()]),
  requiredScopes: z.array(z.string()).optional(),
  // Component A: `playbook` (agent-only how-to, default) vs `guide` (a
  // user-facing "how to use this app" doc). `enabledByDefault` drives the
  // reconcile overlay — false ⇒ seed a disabledBy:'seed' row at first install.
  kind: z.enum(["playbook", "guide"]).optional(),
  enabledByDefault: z.boolean().optional(),
  // An app feature the skill belongs to: an org with the feature off is shown no
  // listing of it and cannot read it, as with a tool of that feature.
  feature: z.string().min(1).optional(),
})

const agentDeclSchema = z.object({
  whenToUse: z.string().min(1),
  systemPrompt: z.string().min(1),
  scopeCeiling: z.array(z.string()),
  toolAllowlist: z.array(z.string()).optional(),
  toolDenylist: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  defaultMaxSteps: z.number().int().positive().optional(),
  defaultTimeoutMs: z.number().int().positive().optional(),
  contextProfile: z.enum(["minimal", "standard", "full"]).optional(),
})

const routineTemplateSchema = z.object({
  description: z.string().min(1),
  kind: z.enum(["recurring", "scheduled", "event"]),
  cron: z.string().optional(),
  timezone: z.string().optional(),
  runAt: z.string().optional(),
  event: z.string().optional(),
  promptTemplate: z.string().min(1),
  scopes: z.array(z.string()),
  enabledByDefault: z.boolean(),
  followUp: z.boolean().optional(),
  // A flow template (0303) and its event filter, with `{{projectId}}` / `{{status:<label>}}`
  // placeholders filled for the chosen project when the template is enabled. Checked against the
  // flow schema then (routineFlowSchema), placeholders filled.
  flow: z.record(z.string(), z.unknown()).optional(),
  eventFilter: z.record(z.string(), z.unknown()).optional(),
})

const appPromptSchema = z.object({ content: z.string().min(1) })

const appDescriptorSchema = z.object({
  name: z.string().regex(NAME_REGEX, "Name must be lowercase alphanumeric + hyphens"),
  version: z.string().regex(SEMVER_REGEX, "Version must be valid semver"),
  // Declarative settings page and app kind (app-sdk app-settings.ts). Shape
  // only here; settingsErrors (below) runs the cross-field rules.
  kind: z.enum(["app", "connector"]).optional(),
  settings: z.unknown().optional(),
  description: z.string().optional(),
  // The agent guide: one string (a core with no sections), or a short core
  // plus sections keyed by the app tools they are about (app-guide.ts).
  agentInstructions: z
    .union([
      z.string(),
      z.object({
        core: z.string().min(1),
        sections: z
          .array(
            z.object({
              tools: z.array(z.string().min(1)).min(1),
              text: z.string().min(1),
            }),
          )
          .optional(),
      }),
    ])
    .optional(),
  dependencies: z
    .object({
      required: z.array(z.string()).optional(),
      optional: z.array(z.string()).optional(),
    })
    .optional(),
  schema: z
    .record(
      z
        .string()
        .regex(
          TABLE_KEY_REGEX,
          "Table name must be lowercase alphanumeric with hyphens or underscores",
        ),
      entitySchemaSchema,
    )
    .optional(),
  tools: z.record(z.string(), toolSchema).optional(),
  views: z
    .record(z.string(), z.union([viewEntrySchema, z.record(z.string(), viewEntrySchema)]))
    .optional(),
  entities: z.record(z.string(), entityDefSchema).optional(),
  events: z
    .object({
      emits: z
        .array(z.string().regex(EVENT_REGEX, "Event must match entity:action format"))
        .optional(),
      subscribes: z
        .record(z.string(), z.any().refine(isFunction, "subscriber must be a function"))
        .optional(),
    })
    .optional(),
  slots: z
    .record(
      z.string().regex(SLOT_KEY_REGEX, "Slot key must follow <entity>:<location> format"),
      slotSchema,
    )
    .optional(),
  contributions: z.record(z.string(), contributionSchema).optional(),
  jobs: z.record(z.string(), jobSchema).optional(),
  webhooks: z
    .record(
      z.string().regex(WEBHOOK_KEY_REGEX, "Webhook name must be lowercase alphanumeric + hyphens"),
      webhookSchema,
    )
    .optional(),
  // Declared data store collections (@liaison/app-sdk app-store.ts): shape and
  // readScope rule both in storeErrors below.
  store: z.unknown().optional(),
  // Shape only; the cross-field rule is webhookHealthErrors (manifest-schema.ts webhookHealth).
  webhookHealth: z
    .object({
      probe: z.unknown(),
      reason: z.string().optional(),
      deliveryGraceSec: z.unknown().optional(),
    })
    .strict()
    .optional(),
  skills: z
    .record(z.string().regex(NAME_REGEX, "Skill name must be kebab-case"), builtinSkillSchema)
    .optional(),
  agents: z
    .record(z.string().regex(NAME_REGEX, "Agent type must be kebab-case"), agentDeclSchema)
    .optional(),
  routines: z
    .record(
      z.string().regex(NAME_REGEX, "Routine template key must be kebab-case"),
      routineTemplateSchema,
    )
    .optional(),
  prompts: z
    .record(z.string().regex(NAME_REGEX, "Prompt name must be kebab-case"), appPromptSchema)
    .optional(),
  implements: z
    .array(
      z.object({
        contract: z.string(),
        version: z.number().int().min(1),
        tools: z.record(z.string(), z.string()),
      }),
    )
    .optional(),
  contract_calls: z
    .array(
      z.object({ contract: z.string(), bindingSetting: z.string(), reason: z.string().optional() }),
    )
    .optional(),
  export: z
    .object({
      formats: z.array(z.string()),
      handler: z.any().refine(isFunction, "export handler must be a function"),
      schema: z.record(z.string(), z.string()).optional(),
      dimensions: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
})

/** Concrete inferred types for Component-A manifest sections (M4) — so the
 *  reconcile loop in runtime.ts reads `desc.agents`/`desc.routines` as typed
 *  members instead of `as Record<string, any>`. */
export type AppAgentDecl = z.infer<typeof agentDeclSchema>
export type AppRoutineTemplate = z.infer<typeof routineTemplateSchema>
export type AppBuiltinSkill = z.infer<typeof builtinSkillSchema>

interface ValidationResult {
  success: boolean
  data?: any
  error?: string
}

function validateSchemaConstraints(schema: Record<string, any>, errors: string[]): void {
  for (const [entityName, entity] of Object.entries(schema)) {
    // G1: per-field user-reference erasure declaration. `userRef` requires
    // `onErase`; `onErase` requires `userRef`; `onErase` must be one of the
    // two strategies. A `userRef` field is structurally a member of `fields`.
    if (entity.fields) {
      for (const [fieldName, fieldDef] of Object.entries(entity.fields as Record<string, any>)) {
        if (!fieldDef || typeof fieldDef !== "object") continue
        const hasUserRef = fieldDef.userRef === true
        const hasOnErase = fieldDef.onErase !== undefined
        if (hasUserRef && !hasOnErase) {
          errors.push(
            `schema.${entityName}.fields.${fieldName}: userRef requires onErase ("delete" | "anonymize")`,
          )
        }
        if (hasOnErase && !hasUserRef) {
          errors.push(`schema.${entityName}.fields.${fieldName}: onErase requires userRef: true`)
        }
        if (hasOnErase && fieldDef.onErase !== "delete" && fieldDef.onErase !== "anonymize") {
          errors.push(
            `schema.${entityName}.fields.${fieldName}: onErase must be "delete" or "anonymize" (got "${fieldDef.onErase}")`,
          )
        }
      }
    }
    if (entity.timeline && entity.fields) {
      for (const field of entity.timeline) {
        if (!(field in entity.fields)) {
          errors.push(`schema.${entityName}.timeline: field "${field}" not found in fields`)
        }
      }
    }
    if (entity.dimensions) {
      for (const [dimName, dimDef] of Object.entries(entity.dimensions as Record<string, any>)) {
        if (dimDef.type === "level" && (!dimDef.order || dimDef.order.length === 0)) {
          errors.push(
            `schema.${entityName}.dimensions.${dimName}: level dimension must have a non-empty "order" array`,
          )
        }
      }
    }
  }
}

/**
 * A guide section names tools of THIS app (app-guide.ts): a typo would leave
 * the section unreachable forever, silently. Shared by the descriptor and
 * manifest validators.
 */
function validateGuideSections(data: Record<string, unknown>, errors: string[]): void {
  const guide = data.agentInstructions
  if (!guide || typeof guide !== "object") return
  const name = String(data.name ?? "")
  const known = new Set(Object.keys((data.tools as Record<string, unknown> | undefined) ?? {}))
  const sections = (guide as { sections?: Array<{ tools?: string[] }> }).sections ?? []
  sections.forEach((section, index) => {
    for (const t of section.tools ?? []) {
      const bare = t.startsWith(`${name}__`) ? t.slice(name.length + 2) : t
      if (!known.has(bare)) {
        errors.push(`agentInstructions.sections[${index}].tools: "${t}" is not a tool of "${name}"`)
      }
    }
  })
}

/**
 * The webhook-health contract (manifest-schema.ts `webhookHealth`, judged by
 * modules/webhooks/ingest-health.ts). An app with webhooks declares exactly one of
 * `{ probe: "<scheduled job>" }` (optionally with `deliveryGraceSec`, how late its
 * sender may deliver) or `{ probe: null, reason: "<why no upstream can be queried>" }`.
 * The per-endpoint `silenceSec` and per-job `upstreamProbe` keys it replaced are
 * refused by name so an old manifest says what to change.
 */
/**
 * A scheduled job's runs are named `fo.<app>.<job>.<org>.<time>`
 * (infra/jobs/fanout.ts), so its name may not carry a "." or ":".
 */
export function scheduledJobNameErrors(app: any): string[] {
  const jobs = app?.jobs && typeof app.jobs === "object" ? app.jobs : {}
  const errors: string[] = []
  for (const [name, def] of Object.entries(jobs as Record<string, any>)) {
    if (def?.schedule && !/^[A-Za-z0-9_-]+$/.test(name)) {
      errors.push(`jobs.${name}: a scheduled job's name may use only letters, digits, "-" and "_"`)
    }
  }
  return errors
}

export function webhookHealthErrors(app: any): string[] {
  const errors: string[] = []
  const webhooks = app?.webhooks && typeof app.webhooks === "object" ? app.webhooks : {}
  const jobs = app?.jobs && typeof app.jobs === "object" ? app.jobs : {}
  for (const [name, def] of Object.entries(webhooks as Record<string, unknown>)) {
    if (def && typeof def === "object" && Object.hasOwn(def, "silenceSec")) {
      errors.push(
        `webhooks.${name}.silenceSec: no longer accepted, declare the app-level "webhookHealth" contract instead`,
      )
    }
  }
  for (const [name, def] of Object.entries(jobs as Record<string, unknown>)) {
    if (def && typeof def === "object" && Object.hasOwn(def, "upstreamProbe")) {
      errors.push(
        `jobs.${name}.upstreamProbe: no longer accepted, name the job in "webhookHealth": { "probe": "${name}" }`,
      )
    }
  }
  const health = app?.webhookHealth
  if (Object.keys(webhooks).length === 0) {
    if (health !== undefined)
      errors.push(`webhookHealth: only allowed on an app that declares webhooks`)
    return errors
  }
  const shapes = `{ "probe": "<scheduled job>" } or { "probe": null, "reason": "<why no upstream can be queried>" }`
  if (!health || typeof health !== "object") {
    errors.push(`webhookHealth: required on an app that declares webhooks, one of ${shapes}`)
    return errors
  }
  const { probe, reason, deliveryGraceSec } = health as {
    probe?: unknown
    reason?: unknown
    deliveryGraceSec?: unknown
  }
  if (deliveryGraceSec !== undefined) {
    if (typeof probe !== "string") {
      errors.push(`webhookHealth.deliveryGraceSec: only allowed with a "probe" job`)
    } else if (
      typeof deliveryGraceSec !== "number" ||
      !Number.isInteger(deliveryGraceSec) ||
      deliveryGraceSec < 60 ||
      deliveryGraceSec > 86400
    ) {
      errors.push(`webhookHealth.deliveryGraceSec: an integer number of seconds, 60 to 86400`)
    }
  }
  if (probe === null) {
    if (typeof reason !== "string" || reason.trim() === "") {
      errors.push(`webhookHealth.reason: required and non-empty when "probe" is null`)
    }
  } else if (typeof probe === "string" && probe !== "") {
    if (reason !== undefined) {
      errors.push(`webhookHealth.reason: only allowed when "probe" is null`)
    }
    const job = (jobs as Record<string, any>)[probe]
    if (!job) {
      errors.push(`webhookHealth.probe: job "${probe}" is not declared in "jobs"`)
    } else if (typeof job.schedule !== "string" || job.schedule === "") {
      errors.push(
        `webhookHealth.probe: job "${probe}" has no "schedule", a probe must run on a cron`,
      )
    }
  } else {
    errors.push(`webhookHealth.probe: must be a job name or null, one of ${shapes}`)
  }
  return errors
}

/**
 * Every dimension a manifest names outside its schema must be one it declares:
 * a tool's `returns.dimensions` (the response filter for external data), the
 * export's `dimensions` and an import kind's `dimension`. Each value is a full
 * key, `<app>:<dimension>`, and the app's dimensions are the ones under
 * `schema.<table>.dimensions`. An undeclared key still "works" at runtime (the
 * filter falls back to a membership match) but no admin can grant it: the
 * role editor offers only declared dimensions and refuses any other, so the
 * filtered rows are hidden from every person but a wildcard holder.
 */
export function dimensionReferenceErrors(app: any): string[] {
  const name = typeof app?.name === "string" ? app.name : ""
  const declared = new Set<string>()
  for (const entity of Object.values((app?.schema ?? {}) as Record<string, any>)) {
    for (const dim of Object.keys((entity?.dimensions ?? {}) as Record<string, unknown>)) {
      declared.add(`${name}:${dim}`)
    }
  }
  const errors: string[] = []
  const check = (where: string, key: unknown) => {
    if (typeof key !== "string" || declared.has(key)) return
    const known = declared.size > 0 ? [...declared].sort().join(", ") : "none"
    errors.push(
      `${where}: "${key}" is not a dimension of "${name}" (declare it under schema.<table>.dimensions; declared: ${known})`,
    )
  }
  for (const [toolName, tool] of Object.entries((app?.tools ?? {}) as Record<string, any>)) {
    for (const [field, key] of Object.entries(
      (tool?.returns?.dimensions ?? {}) as Record<string, unknown>,
    )) {
      check(`tools.${toolName}.returns.dimensions.${field}`, key)
    }
  }
  for (const [field, key] of Object.entries(
    (app?.export?.dimensions ?? {}) as Record<string, unknown>,
  )) {
    check(`export.dimensions.${field}`, key)
  }
  for (const [kind, def] of Object.entries((app?.import?.kinds ?? {}) as Record<string, any>)) {
    if (def?.dimension) check(`import.kinds.${kind}.dimension.dimension`, def.dimension.dimension)
  }
  return errors
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * `entities.<e>.print` (modules/documents/print.ts). The kernel runs the
 * record tool itself, under the caller's authorization, every time a person
 * or an agent prints: so it must be a tool this app declares, readOnly, and
 * never gated (neither `gated` nor `conditionalGate`), and the entity must
 * declare the fileParent the printed files land on. Otherwise
 * `print_record_tool_invalid`. Declared field paths describe the record's
 * shape (no numeric index, each once); a repeating field sits inside its list
 * (`print_field_invalid`). Runs on the raw manifest or descriptor.
 */
/**
 * `print.parentMadeOnPrint` lets a preview read a record whose fileParent row does not exist
 * yet, on the caller holding the parent's read scope. That is safe only when holding the scope
 * means seeing every row: so the parent must be this app's own table, its read scope the table's
 * generated RLS read scope, with no dimension, personal or migration-owned visibility. Then "no
 * row seen" by a holder means no row, never a row RLS hides.
 */
function parentMadeOnPrintErrors(
  root: Record<string, unknown> | undefined,
  entity: Record<string, unknown>,
  where: string,
): string[] {
  const parent = asRecord(entity.fileParent)
  const appName = typeof root?.name === "string" ? root.name : ""
  const tableName = typeof parent?.tableName === "string" ? parent.tableName : ""
  const table = asRecord(asRecord(root?.schema)?.[tableName])
  const fail = (why: string) => [`print_record_tool_invalid: ${where}.parentMadeOnPrint: ${why}`]
  if (!parent || parent.schemaRef !== `app_${appName}` || !table) {
    return fail("the fileParent must be a table of this app's own schema")
  }
  if (table.dimensions || table.personalScope || table.rlsGovernedByMigration === true) {
    return fail(
      `table "${tableName}" restricts rows beyond its scope (dimensions, personal or migration policies)`,
    )
  }
  const rlsEntity = typeof table.rlsScope === "string" ? table.rlsScope : tableName
  if (parent.readScope !== `${appName}:${rlsEntity}:read`) {
    return fail(
      `the fileParent readScope must be the table's own read scope "${appName}:${rlsEntity}:read"`,
    )
  }
  return []
}

/**
 * `entities.<e>.pick` names one of the app's own tools that is readOnly, ungated and takes
 * `queryParam` (a JSON-schema params object is checked; a Zod one is not introspected).
 */
export function pickDeclarationErrors(app: unknown): string[] {
  const root = asRecord(app)
  const entities = asRecord(root?.entities)
  if (!entities) return []
  const tools = asRecord(root?.tools) ?? {}
  const errors: string[] = []
  for (const [entityName, rawEntity] of Object.entries(entities)) {
    const pick = asRecord(asRecord(rawEntity)?.pick)
    if (!pick) continue
    const where = `entities.${entityName}.pick`
    const toolName = typeof pick.tool === "string" ? pick.tool : ""
    const tool = asRecord(tools[toolName])
    if (!tool) {
      errors.push(`pick_tool_invalid: ${where}.tool: "${toolName}" is not a tool of this app`)
      continue
    }
    if (tool.readOnly !== true) {
      errors.push(`pick_tool_invalid: ${where}.tool: tool "${toolName}" must be readOnly`)
    }
    if (tool.gated === true || tool.conditionalGate === true) {
      errors.push(`pick_tool_invalid: ${where}.tool: tool "${toolName}" must not be gated`)
    }
    const params = asRecord(tool.params)
    const properties = params && !("safeParse" in params) ? asRecord(params.properties) : undefined
    const queryParam = typeof pick.queryParam === "string" ? pick.queryParam : ""
    if (properties && !(queryParam in properties)) {
      errors.push(
        `pick_tool_invalid: ${where}.queryParam: tool "${toolName}" takes no parameter "${queryParam}"`,
      )
    }
    for (const key of Object.keys(asRecord(pick.params) ?? {})) {
      if (properties && !(key in properties)) {
        errors.push(
          `pick_tool_invalid: ${where}.params: tool "${toolName}" takes no parameter "${key}"`,
        )
      }
      if (key === queryParam) {
        errors.push(`pick_tool_invalid: ${where}.params: "${key}" is the query parameter`)
      }
    }
  }
  return errors
}

/**
 * `entities.<e>.routineFlow` (modules/agent/routines/flow-records.ts): `updateTool` and
 * `commentTool` are this app's own write tools taking `recordParam`, and `notifyScope` is one of
 * this app's scopes. The handler exports are checked when the app registers (core apps only).
 */
export function routineFlowDeclarationErrors(app: unknown): string[] {
  const root = asRecord(app)
  const entities = asRecord(root?.entities)
  if (!entities) return []
  const appName = typeof root?.name === "string" ? root.name : ""
  const tools = asRecord(root?.tools) ?? {}
  const errors: string[] = []
  for (const [entityName, rawEntity] of Object.entries(entities)) {
    const decl = asRecord(asRecord(rawEntity)?.routineFlow)
    if (!decl) continue
    const where = `entities.${entityName}.routineFlow`
    const recordParam = typeof decl.recordParam === "string" ? decl.recordParam : ""
    for (const key of ["updateTool", "commentTool"] as const) {
      const toolName = typeof decl[key] === "string" ? (decl[key] as string) : ""
      const tool = asRecord(tools[toolName])
      if (!tool) {
        errors.push(
          `routine_flow_invalid: ${where}.${key}: "${toolName}" is not a tool of this app`,
        )
        continue
      }
      if (tool.readOnly === true) {
        errors.push(`routine_flow_invalid: ${where}.${key}: tool "${toolName}" must write`)
      }
      const params = asRecord(tool.params)
      const properties =
        params && !("safeParse" in params) ? asRecord(params.properties) : undefined
      if (properties && !(recordParam in properties)) {
        errors.push(
          `routine_flow_invalid: ${where}.recordParam: tool "${toolName}" takes no parameter "${recordParam}"`,
        )
      }
    }
    const notifyScope = typeof decl.notifyScope === "string" ? decl.notifyScope : ""
    if (appName && !notifyScope.startsWith(`${appName}:`)) {
      errors.push(
        `routine_flow_invalid: ${where}.notifyScope: "${notifyScope}" is not a scope of this app`,
      )
    }
  }
  return errors
}

/**
 * `entities.<e>.tableBacking` names another entity of the app as its `parent` (the record whose
 * children are a backed table's rows).
 */
export function tableBackingDeclarationErrors(app: unknown): string[] {
  const root = asRecord(app)
  const entities = asRecord(root?.entities)
  if (!entities) return []
  const errors: string[] = []
  for (const [entityName, rawEntity] of Object.entries(entities)) {
    const decl = asRecord(asRecord(rawEntity)?.tableBacking)
    if (!decl) continue
    const parent = typeof decl.parent === "string" ? decl.parent : ""
    if (!asRecord(entities[parent]) || parent === entityName) {
      errors.push(
        `table_backing_invalid: entities.${entityName}.tableBacking.parent: "${parent}" is not another entity of this app`,
      )
    }
  }
  return errors
}

export function printDeclarationErrors(app: unknown): string[] {
  const root = asRecord(app)
  const entities = asRecord(root?.entities)
  if (!entities) return []
  const tools = asRecord(root?.tools) ?? {}
  const errors: string[] = []
  for (const [entityName, rawEntity] of Object.entries(entities)) {
    const entity = asRecord(rawEntity)
    const print = asRecord(entity?.print)
    if (!entity || !print) continue
    const where = `entities.${entityName}.print`
    if (!asRecord(entity.fileParent)) {
      errors.push(
        `print_record_tool_invalid: ${where}: a printable entity must declare a fileParent (the printed files are stored on it)`,
      )
    }
    if (print.parentMadeOnPrint === true)
      errors.push(...parentMadeOnPrintErrors(root, entity, where))
    const toolName = typeof print.recordTool === "string" ? print.recordTool : ""
    const tool = asRecord(tools[toolName])
    if (!tool) {
      errors.push(
        `print_record_tool_invalid: ${where}.recordTool: "${toolName}" is not a tool of this app`,
      )
    } else {
      if (tool.readOnly !== true) {
        errors.push(
          `print_record_tool_invalid: ${where}.recordTool: tool "${toolName}" must be readOnly (the kernel runs it on every print)`,
        )
      }
      if (tool.gated === true || tool.conditionalGate === true) {
        errors.push(
          `print_record_tool_invalid: ${where}.recordTool: tool "${toolName}" must not be gated (printing reads the record, it never waits for an approval)`,
        )
      }
      const idParam = typeof print.idParam === "string" ? print.idParam : ""
      // A JSON-schema params object is checked; a Zod schema (in-process
      // descriptor) is not introspected here.
      const params = asRecord(tool.params)
      const properties =
        params && !("safeParse" in params) ? asRecord(params.properties) : undefined
      if (properties && !(idParam in properties)) {
        errors.push(
          `print_record_tool_invalid: ${where}.idParam: tool "${toolName}" takes no parameter "${idParam}"`,
        )
      }
    }
    const seen = new Set<string>()
    const fields = Array.isArray(print.fields) ? print.fields : []
    fields.forEach((rawField, i) => {
      const field = asRecord(rawField)
      const path = typeof field?.path === "string" ? field.path : ""
      const segments = path.split(".")
      if (segments.some((s) => /^\d+$/.test(s))) {
        errors.push(
          `print_field_invalid: ${where}.fields[${i}].path: "${path}" names a row by number; declare the list's fields with repeat instead`,
        )
      }
      if (seen.has(path)) {
        errors.push(`print_field_invalid: ${where}.fields[${i}].path: "${path}" is declared twice`)
      }
      seen.add(path)
      const repeat = typeof field?.repeat === "string" ? field.repeat : undefined
      if (repeat !== undefined) {
        if (!path.startsWith(`${repeat}.`)) {
          errors.push(
            `print_field_invalid: ${where}.fields[${i}]: a field repeating over "${repeat}" must have a path inside it ("${repeat}.<field>")`,
          )
        }
        if (repeat.split(".").some((s) => /^\d+$/.test(s))) {
          errors.push(
            `print_field_invalid: ${where}.fields[${i}].repeat: "${repeat}" names a row by number`,
          )
        }
      }
    })
  }
  return errors
}

export function validateAppDescriptor(descriptor: any): ValidationResult {
  // Pre-launch breaking change: descriptors that still ship `skills.overview`
  // must migrate to top-level `agentInstructions`.
  if (
    descriptor &&
    typeof descriptor === "object" &&
    descriptor.skills &&
    typeof descriptor.skills === "object" &&
    "overview" in descriptor.skills
  ) {
    return {
      success: false,
      error:
        '"skills.overview" was removed — move the content to top-level "agentInstructions" (pre-launch breaking change)',
    }
  }

  const retired = retiredToolScopeErrors(descriptor?.tools)
  if (retired.length > 0) return { success: false, error: retired.join("; ") }

  const result = appDescriptorSchema.safeParse(descriptor)

  if (!result.success) {
    const messages = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)
    return { success: false, error: messages.join("; ") }
  }

  const { data } = result

  // Cross-field validations
  const errors: string[] = []

  validateGuideSections(data as Record<string, unknown>, errors)
  validateProviderContracts(data as Record<string, unknown>, errors)
  // On the raw input: the schema strips the retired keys this names.
  errors.push(...webhookHealthErrors(descriptor))
  errors.push(...knowledgeSourceErrors(descriptor))
  errors.push(...knowledgeItemsErrors(descriptor))
  errors.push(...scheduledJobNameErrors(descriptor))
  errors.push(...runsForErrors(descriptor))
  errors.push(...settingsErrors(data as Record<string, any>))
  errors.push(...storeErrors(descriptor))
  errors.push(...connectionAdminScopeErrors(data as Record<string, any>))
  errors.push(...dimensionReferenceErrors(descriptor))
  errors.push(...printDeclarationErrors(descriptor))
  errors.push(...pickDeclarationErrors(descriptor))
  errors.push(...routineFlowDeclarationErrors(descriptor))
  errors.push(...tableBackingDeclarationErrors(descriptor))

  // Every tool scope must be prefixed with the app's scope namespace
  if (data.tools) {
    for (const [toolName, tool] of Object.entries(data.tools as Record<string, any>)) {
      errors.push(...toolScopeNamespaceErrors(toolName, tool.requiredScopes, data.name))
      // `approvalImpact` classifies the pending approval a gated call parks —
      // meaningless on a tool that can never park one (same rule as
      // editableFields in validateAppManifest below).
      if (
        tool.approvalImpact !== undefined &&
        tool.gated !== true &&
        tool.conditionalGate !== true
      ) {
        errors.push(
          `tools.${toolName}.approvalImpact: only allowed on gated tools (gated: true) or handler-conditionally-gated tools (conditionalGate: true)`,
        )
      }
    }
  }

  if (data.schema) validateSchemaConstraints(data.schema, errors)

  if (errors.length > 0) {
    return { success: false, error: errors.join("; ") }
  }

  return { success: true, data }
}

import {
  appSecretsDeclarationSchema,
  appSettingsSchema,
  configKeysDeclarationErrors,
  listingDeclarationErrors,
  secretsDeclarationErrors,
  settingsDeclarationErrors,
  storeDeclarationErrors,
} from "@liaison/app-sdk"
import { appIconSvgProblems, decidingScopeForToolDef, isAppIconName } from "@liaison/shared"
import Ajv from "ajv"
import { oauthManifestKnobErrors } from "~/modules/apps/connections/oauth-manifest-knobs"
import { appManifestJsonSchema } from "~/modules/apps/manifest-schema"
import { defaultFillerCompileError } from "~/modules/apps/param-validator"
import { fieldDefaultErrors } from "~/modules/apps/settings-schema-from-manifest"
import { importDeclarationErrors } from "~/modules/imports/kind-schema"
import { KERNEL_SCOPES } from "~/modules/permissions/scope-catalog"

const KERNEL_SCOPE_SET = new Set(KERNEL_SCOPES.map((e) => e.scope))

/**
 * The scopes a manifest declares or derives (an in-tree app's `scopes` array is
 * informational and usually empty): its tools' required scopes, its roles, its
 * entities' read scopes, its bulk actions, its declared `scopes`, and the app's
 * default approver scope.
 */
function manifestOwnScopes(manifest: Record<string, any>): Set<string> {
  const out = new Set<string>()
  const add = (s: unknown) => {
    if (typeof s === "string" && s.length > 0) out.add(s)
  }
  for (const tool of Object.values((manifest.tools ?? {}) as Record<string, any>)) {
    for (const s of Array.isArray(tool?.requiredScopes) ? tool.requiredScopes : []) add(s)
  }
  for (const role of Object.values((manifest.roles ?? {}) as Record<string, any>)) {
    for (const s of Array.isArray(role?.scopes) ? role.scopes : []) add(s)
  }
  for (const entity of Object.values((manifest.entities ?? {}) as Record<string, any>)) {
    add(entity?.readScope)
  }
  for (const bulk of Object.values((manifest.bulk ?? {}) as Record<string, any>)) add(bulk?.scope)
  for (const s of Array.isArray(manifest.scopes) ? manifest.scopes : []) add(s)
  if (typeof manifest.name === "string") add(decidingScopeForToolDef({}, manifest.name))
  return out
}

/**
 * The manifest's `store` declaration (app-sdk app-store.ts): its shape, and each
 * collection's readScope one of the app's own declared scopes. Shared by the
 * manifest and the descriptor validators.
 */
export function storeErrors(manifest: Record<string, any>): string[] {
  if (manifest?.store === undefined) return []
  const own = manifestOwnScopes(manifest)
  return storeDeclarationErrors(manifest, { knownScopes: (s) => own.has(s) })
}

/**
 * The manifest's `secrets` placements (app-sdk secret-placement.ts): each `in`
 * a placement, each key a declared connection secret, each host one of that
 * connection's (or, when it names none, of network.allowedDomains).
 */
export function secretsErrors(manifest: Record<string, any>): string[] {
  if (manifest?.secrets === undefined) return []
  const errors: string[] = []
  const parsed = appSecretsDeclarationSchema.safeParse(manifest.secrets)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(`secrets.${issue.path.join(".")}: ${issue.message}`)
    }
    return errors
  }
  return secretsDeclarationErrors(manifest)
}

/**
 * `kind` and the declarative `settings` page (app-sdk app-settings.ts): the
 * structure, then the cross-field rules, then each field default against its
 * own type. Shared by the manifest and the descriptor validators.
 */
function settingsErrors(manifest: Record<string, any>): string[] {
  const errors: string[] = []
  if (manifest.settings !== undefined) {
    const parsed = appSettingsSchema.safeParse(manifest.settings)
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        errors.push(`settings.${issue.path.join(".")}: ${issue.message}`)
      }
    } else {
      parsed.data.sections.forEach((section, si) => {
        section.blocks.forEach((block, bi) => {
          const at = `settings.sections[${si}].blocks[${bi}]`
          if (block.block === "field") errors.push(...fieldDefaultErrors(at, block))
          if (block.block === "list") {
            for (const [fi, f] of (block.createFields ?? []).entries()) {
              errors.push(...fieldDefaultErrors(`${at}.createFields[${fi}]`, f))
            }
          }
        })
      })
    }
  }
  const own = manifestOwnScopes(manifest)
  errors.push(
    ...settingsDeclarationErrors(manifest, {
      knownScopes: (s) => KERNEL_SCOPE_SET.has(s) || own.has(s),
    }),
  )
  return errors
}

/**
 * A connection's `adminScope` (who administers it for the organization,
 * connections/admin-scope.ts) is one of the app's own scopes: in its namespace
 * and declared or derived by the manifest, so it can be granted.
 */
function connectionAdminScopeErrors(manifest: Record<string, any>): string[] {
  const conns = manifest.connections
  if (!conns || typeof conns !== "object") return []
  const appName = typeof manifest.name === "string" ? manifest.name : ""
  const own = manifestOwnScopes(manifest)
  const errors: string[] = []
  for (const [name, conn] of Object.entries(conns as Record<string, any>)) {
    const scope = conn?.adminScope
    if (scope === undefined) continue
    if (typeof scope !== "string" || !scopeMatchesApp(scope, appName) || !own.has(scope)) {
      errors.push(
        `connections.${name}.adminScope: "${String(scope)}" must be one of the app's own declared scopes (${appName}:...)`,
      )
    }
  }
  return errors
}

// Scopes are colon-delimited `app:resource:action`. An app NAME may contain hyphens
// (e.g. "mcp-manager"), but its scope segment uses the hyphen→underscore-normalized form
// ("mcp_manager:…") because the app's RLS policies, `requireScope` route guards, and role
// grants all key off that namespace. Accept either the raw name or its normalization as the
// tool-scope prefix. For an app whose name has no hyphen the two forms are identical, so this
// is a no-op for every existing single-word app — it only legitimizes hyphenated app names.
function appScopePrefix(appName: string): string {
  return appName.replace(/-/g, "_")
}
function scopeMatchesApp(scope: string, appName: string): boolean {
  return scope.startsWith(`${appName}:`) || scope.startsWith(`${appScopePrefix(appName)}:`)
}

/**
 * The manifest's `knowledgeSources` kinds (apps/knowledge/app-sources.ts): each
 * `readScope` in the app's own namespace, each `configSchema` a JSON Schema
 * that compiles (a source's config is validated against it at creation).
 */
export function knowledgeSourceErrors(manifest: any): string[] {
  const decl = manifest?.knowledgeSources
  if (decl === undefined) return []
  if (!decl || typeof decl !== "object" || Array.isArray(decl)) {
    return ["knowledgeSources: must be an object of kinds"]
  }
  const errors: string[] = []
  const appName = String(manifest.name ?? "")
  for (const [kind, raw] of Object.entries(decl as Record<string, any>)) {
    if (!raw || typeof raw !== "object") continue
    if (typeof raw.handler !== "string" || raw.handler.length === 0) {
      errors.push(`knowledgeSources.${kind}.handler: must be a string export name`)
    }
    if (typeof raw.readScope === "string" && !scopeMatchesApp(raw.readScope, appName)) {
      errors.push(
        `knowledgeSources.${kind}.readScope: must start with "${appScopePrefix(appName)}:" (got "${raw.readScope}")`,
      )
    }
    if (raw.configSchema !== undefined) {
      try {
        knowledgeConfigValidator(raw.configSchema)
      } catch (err) {
        errors.push(
          `knowledgeSources.${kind}.configSchema: not a valid JSON Schema (${err instanceof Error ? err.message : String(err)})`,
        )
      }
    }
  }
  return errors
}

/** The manifest's `knowledgeItems` (apps/knowledge/source-registry.ts): its `readScope` in the app's own namespace. */
export function knowledgeItemsErrors(manifest: any): string[] {
  const decl = manifest?.knowledgeItems
  if (!decl || typeof decl !== "object" || typeof decl.readScope !== "string") return []
  const appName = String(manifest.name ?? "")
  return scopeMatchesApp(decl.readScope, appName)
    ? []
    : [
        `knowledgeItems.readScope: must start with "${appScopePrefix(appName)}:" (got "${decl.readScope}")`,
      ]
}

/** One error per `requiredScopes` entry outside the app's own namespace. */
function toolScopeNamespaceErrors(
  toolName: string,
  requiredScopes: readonly string[],
  appName: string,
): string[] {
  return requiredScopes
    .filter((scope) => !scopeMatchesApp(scope, appName))
    .map(
      (scope) =>
        `tools.${toolName}.requiredScopes: must start with "${appScopePrefix(appName)}:" (got "${scope}")`,
    )
}

/**
 * A tool lists its scopes in `requiredScopes` only. The retired single `scope`
 * key is refused by name before schema validation, so an old manifest gets an
 * error that says what to change instead of a generic schema mismatch.
 */
function retiredToolScopeErrors(tools: unknown): string[] {
  if (!tools || typeof tools !== "object") return []
  const errors: string[] = []
  for (const [toolName, tool] of Object.entries(tools as Record<string, unknown>)) {
    if (tool && typeof tool === "object" && Object.hasOwn(tool, "scope")) {
      errors.push(
        `tools.${toolName}.scope: tool "${toolName}" must list its scopes in "requiredScopes", "scope" is no longer accepted`,
      )
    }
  }
  return errors
}

/**
 * The manifest schema uses union types on purpose (an attention rule's
 * `resolveWhen.equals` is a string, number or boolean): allowed explicitly, so
 * compiling it prints no strict-mode warning (every CLI command loads it).
 */
export const MANIFEST_AJV_OPTIONS = { allErrors: true, allowUnionTypes: true } as const

const ajv = new Ajv(MANIFEST_AJV_OPTIONS)
const validateManifestSchema = ajv.compile(appManifestJsonSchema)

/**
 * Why the manifest's icon fields cannot be shown as written: `iconSvg` must be
 * plain drawing markup (the allowlist in @liaison/shared, nothing stripped) and
 * `iconName` a name from Liaison's icon set. Empty when both are absent or clean.
 */
export function appIconErrors(manifest: { iconSvg?: unknown; iconName?: unknown }): string[] {
  const errors: string[] = []
  if (manifest.iconSvg !== undefined) {
    const problems = appIconSvgProblems(manifest.iconSvg)
    if (problems.length > 0) errors.push(`its iconSvg contains ${problems.join(", ")}`)
  }
  if (manifest.iconName !== undefined && !isAppIconName(manifest.iconName)) {
    errors.push(`its iconName '${String(manifest.iconName)}' is not an icon of Liaison's icon set`)
  }
  return errors
}

/**
 * Tool keys only an app the platform vouches for may declare: a core app or the
 * image's own catalog artifact (`_firstParty`, a voucher for declarations only). A third-party
 * manifest declaring one is refused at registration, signed by a trusted publisher or not.
 * - `sinkReadersSelf` says the acting user alone reads what the tool writes, and
 *   `contentParams` names the only parameters through which a call carries the turn
 *   (scope-taint.ts, rules 6d and 6f): claims about what the handler does that narrow a
 *   scope-taint refusal.
 * - `humanTurnOnly` and `dmOnly` say where a call may run (execute-tool.ts): product rules
 *   of Liaison's own apps, not a contract a third-party app is offered.
 */
export const FIRST_PARTY_ONLY_TOOL_KEYS = [
  "sinkReadersSelf",
  "contentParams",
  "humanTurnOnly",
  "dmOnly",
] as const

const FIRST_PARTY_ONLY_REASON: Record<(typeof FIRST_PARTY_ONLY_TOOL_KEYS)[number], string> = {
  sinkReadersSelf: "it narrows a scope-taint refusal",
  contentParams: "it narrows a scope-taint refusal",
  humanTurnOnly: "it is a rule of Liaison's own apps",
  dmOnly: "it is a rule of Liaison's own apps",
}

/** The registration errors for a manifest nobody vouched for that declares a key above. */
export function firstPartyOnlyToolKeyErrors(manifest: any): string[] {
  const errors: string[] = []
  for (const [toolName, tool] of Object.entries((manifest?.tools ?? {}) as Record<string, any>)) {
    for (const key of FIRST_PARTY_ONLY_TOOL_KEYS) {
      if (tool?.[key] !== undefined) {
        errors.push(
          `tools.${toolName}.${key}: only a first-party app may declare it, because ${FIRST_PARTY_ONLY_REASON[key]}; remove it from the manifest`,
        )
      }
    }
  }
  return errors
}

/**
 * A context provider names a tool of its own app that writes nothing, and a
 * scope that tool requires: the scope is what a turn must hold for the tool to
 * run, so it cannot be one the tool does not check. `loadTools` are the app's
 * own tools.
 */
function contextProviderErrors(manifest: any): string[] {
  const providers = manifest?.contextProviders
  if (!Array.isArray(providers)) return []
  const tools = (manifest.tools ?? {}) as Record<string, any>
  const errors: string[] = []
  providers.forEach((p: { tool: string; scope: string; loadTools?: string[] }, i: number) => {
    const at = `contextProviders[${i}]`
    const tool = tools[p.tool]
    if (!tool) {
      errors.push(`${at}.tool: '${p.tool}' is not a tool of this app`)
      return
    }
    if (tool.readOnly !== true || typeof tool.writesToTable === "string" || tool.gated === true) {
      errors.push(`${at}.tool: '${p.tool}' must be declared readOnly, ungated and write no table`)
    }
    const required: unknown[] = Array.isArray(tool.requiredScopes) ? tool.requiredScopes : []
    if (!required.includes(p.scope)) {
      errors.push(`${at}.scope: '${p.scope}' is not in the requiredScopes of '${p.tool}'`)
    }
    for (const name of p.loadTools ?? []) {
      if (!tools[name]) errors.push(`${at}.loadTools: '${name}' is not a tool of this app`)
    }
  })
  return errors
}

/**
 * A `resultTaintWhen` names read scopes of the app's own (`<app>:<resource>:read`): it classifies
 * part of what the tool returns, so it can only be a read scope of this app.
 */
export function resultTaintWhenErrors(manifest: any): string[] {
  const errors: string[] = []
  const app = typeof manifest?.name === "string" ? manifest.name : ""
  for (const [toolName, tool] of Object.entries((manifest?.tools ?? {}) as Record<string, any>)) {
    const decl = tool?.resultTaintWhen
    if (decl === undefined) continue
    for (const scope of Array.isArray(decl?.scopes) ? decl.scopes : []) {
      const parts = typeof scope === "string" ? scope.split(":") : []
      if (parts.length !== 3 || parts[0] !== app || parts[2] !== "read" || !parts[1]) {
        errors.push(
          `tools.${toolName}.resultTaintWhen.scopes: '${String(scope)}' must be a read scope of this app (${app}:<resource>:read)`,
        )
      }
    }
  }
  return errors
}

/**
 * An activity source names a read-only, ungated tool of its own app that writes
 * nothing, and a scope that tool requires, so the scope is one the tool checks.
 * Two sources of one app never share a filter key.
 */
function activitySourceErrors(manifest: any): string[] {
  const sources = manifest?.activitySources
  if (!Array.isArray(sources)) return []
  const tools = (manifest.tools ?? {}) as Record<string, any>
  const errors: string[] = []
  const keys = new Set<string>()
  sources.forEach((s: { tool: string; scope: string; filterKey: string }, i: number) => {
    const at = `activitySources[${i}]`
    if (keys.has(s.filterKey)) errors.push(`${at}.filterKey: '${s.filterKey}' is declared twice`)
    keys.add(s.filterKey)
    const tool = tools[s.tool]
    if (!tool) {
      errors.push(`${at}.tool: '${s.tool}' is not a tool of this app`)
      return
    }
    if (tool.readOnly !== true || typeof tool.writesToTable === "string" || tool.gated === true) {
      errors.push(`${at}.tool: '${s.tool}' must be declared readOnly, ungated and write no table`)
    }
    const required: unknown[] = Array.isArray(tool.requiredScopes) ? tool.requiredScopes : []
    if (!required.includes(s.scope)) {
      errors.push(`${at}.scope: '${s.scope}' is not in the requiredScopes of '${s.tool}'`)
    }
  })
  return errors
}

/**
 * The refusal of a manifest that carries `trusted`. No manifest decides where
 * its app runs: the core apps (core/registry.ts) are server code, every other
 * app runs sandboxed.
 */
export const TRUSTED_FIELD_REFUSAL =
  "trusted is not a manifest field: the platform decides which apps are core (server code); every other app runs sandboxed. Remove it."

export function validateAppManifest(manifest: any): ValidationResult {
  if (manifest !== null && typeof manifest === "object" && "trusted" in manifest) {
    return { success: false, error: TRUSTED_FIELD_REFUSAL }
  }
  const retired = retiredToolScopeErrors(manifest?.tools)
  if (retired.length > 0) return { success: false, error: retired.join("; ") }

  // Step 1: JSON Schema structural validation
  const valid = validateManifestSchema(manifest)
  if (!valid) {
    // Name the offending key: "must NOT have additional properties" alone does not say which.
    const messages = (validateManifestSchema.errors ?? []).map((e) => {
      const extra = (e.params as { additionalProperty?: unknown }).additionalProperty
      return `${e.instancePath || "/"}: ${e.message}${typeof extra === "string" ? ` (${extra})` : ""}`
    })
    return { success: false, error: messages.join("; ") }
  }

  // Step 2: Cross-field validations
  const errors: string[] = []
  validateGuideSections(manifest, errors)
  validateProviderContracts(manifest, errors)
  errors.push(...webhookHealthErrors(manifest))
  errors.push(...knowledgeSourceErrors(manifest))
  errors.push(...knowledgeItemsErrors(manifest))
  errors.push(...scheduledJobNameErrors(manifest))
  errors.push(...runsForErrors(manifest))
  errors.push(...configKeysDeclarationErrors(manifest.configKeys, manifest.connections))
  errors.push(...settingsErrors(manifest))
  errors.push(...storeErrors(manifest))
  errors.push(...secretsErrors(manifest))
  errors.push(...connectionAdminScopeErrors(manifest))
  for (const [name, conn] of Object.entries((manifest.connections ?? {}) as Record<string, any>)) {
    for (const e of connectionLimitsErrors(conn?.limits)) errors.push(`connections.${name}.${e}`)
  }
  errors.push(...apiConnectionErrors(manifest))
  errors.push(...dimensionReferenceErrors(manifest))
  errors.push(...appSurfaceErrors(manifest))
  errors.push(...oauthManifestKnobErrors(manifest))
  errors.push(...listingDeclarationErrors(manifest))
  errors.push(...appIconErrors(manifest))
  errors.push(...resultCardErrors(manifest))
  errors.push(...contextProviderErrors(manifest))
  errors.push(...resultTaintWhenErrors(manifest))
  errors.push(...activitySourceErrors(manifest))
  errors.push(
    ...importDeclarationErrors(
      manifest.import,
      typeof manifest.name === "string" ? manifest.name : undefined,
    ),
  )

  // Tool handlers must be strings (not functions)
  if (manifest.tools) {
    for (const [toolName, tool] of Object.entries(manifest.tools as Record<string, any>)) {
      if (typeof tool.handler !== "string") {
        errors.push(
          `tools.${toolName}.handler: must be a string export name, not ${typeof tool.handler}`,
        )
      }
      if (tool.summarizer !== undefined && typeof tool.summarizer !== "string") {
        errors.push(
          `tools.${toolName}.summarizer: must be a string export name, not ${typeof tool.summarizer}`,
        )
      }
      if (tool.preflight !== undefined && typeof tool.preflight !== "string") {
        errors.push(
          `tools.${toolName}.preflight: must be a string export name, not ${typeof tool.preflight}`,
        )
      }
      // A `contentParams` entry the tool does not take is never set by a call, so every call
      // would pass as carrying none of the turn (scope-taint.ts, rule 6f): refused here.
      if (Array.isArray(tool.contentParams)) {
        const props = (tool.params?.properties ?? {}) as Record<string, unknown>
        for (const p of tool.contentParams as unknown[]) {
          if (typeof p !== "string" || !Object.hasOwn(props, p)) {
            errors.push(
              `tools.${toolName}.contentParams: "${String(p)}" is not in params.properties, so no call would carry it`,
            )
          }
        }
      }
      // Every scope the tool requires must sit in the app's own namespace.
      errors.push(...toolScopeNamespaceErrors(toolName, tool.requiredScopes, String(manifest.name)))
      // A47b. The manifest's parameter defaults are filled by a second ajv pass, compiled
      // lazily at the tool's first dispatch. Ajv strict mode THROWS on a default that sits
      // where it can never apply (inside a oneOf, anyOf or if branch), and at first dispatch
      // that throw lands after the policy and after the approval card. Compile it here, so
      // the manifest is refused at registration and the tool is named.
      if (tool.params && typeof tool.params === "object" && "type" in tool.params) {
        const fillerError = defaultFillerCompileError(tool.params, {
          allErrors: true,
          allowUnionTypes: true,
        })
        if (fillerError) {
          errors.push(
            `tools.${toolName}.params: parameter defaults cannot be compiled, which a dispatch ` +
              `would only discover after the approval card was shown. A default inside a oneOf, ` +
              `anyOf or if branch is never filled: move it to the property itself. (${fillerError})`,
          )
        }
      }
      if (tool.approvalImpact !== undefined) {
        // Same gating rule as editableFields below: `approvalImpact`
        // classifies the pending approval a gated call parks, so it is only
        // meaningful on declaratively-gated or handler-conditionally-gated
        // tools. (The enum itself is enforced by the JSON schema.)
        if (tool.gated !== true && tool.conditionalGate !== true) {
          errors.push(
            `tools.${toolName}.approvalImpact: only allowed on gated tools (gated: true) or handler-conditionally-gated tools (conditionalGate: true)`,
          )
        }
      }
      if (tool.editableFields !== undefined) {
        // `editableFields` is meaningful for any tool that can park a pending
        // approval: declaratively-gated tools (`gated: true`), and
        // handler-CONDITIONALLY-gated tools (`conditionalGate: true`) whose
        // handler calls `ctx.requestApproval` mid-execution (e.g. invoicing's
        // per-issuer threshold gate on `invoice_issue`). The latter cannot set
        // `gated: true` (that would gate unconditionally), so they mark
        // `conditionalGate: true` to opt their approval payload into editing.
        if (tool.gated !== true && tool.conditionalGate !== true) {
          errors.push(
            `tools.${toolName}.editableFields: only allowed on gated tools (gated: true) or handler-conditionally-gated tools (conditionalGate: true)`,
          )
        }
        // A pinned param is the server's to set (its preflight pins it, the
        // execution checks it): no editable field may reach it, above or below.
        const pinned: string[] = Array.isArray(tool.pinnedParams) ? tool.pinnedParams : []
        for (const ef of tool.editableFields as Array<{ field?: unknown }>) {
          const hit = typeof ef.field === "string" ? pinnedOverlap(pinned, ef.field) : null
          if (hit !== null) {
            errors.push(
              `tools.${toolName}.editableFields: field "${String(ef.field)}" reaches the pinned param "${hit}"`,
            )
          }
        }
        const props = (tool.params?.properties ?? {}) as Record<string, { type?: string }>
        for (const ef of tool.editableFields as Array<{
          field: string
          widget: string
          invalidates?: unknown
        }>) {
          if (ef.invalidates !== undefined) {
            if (
              !Array.isArray(ef.invalidates) ||
              ef.invalidates.some((k) => typeof k !== "string" || k === "")
            ) {
              errors.push(
                `tools.${toolName}.editableFields: field "${ef.field}" invalidates must be an array of non-empty strings`,
              )
            } else {
              for (const k of ef.invalidates as string[]) {
                if (!(k in props)) {
                  errors.push(
                    `tools.${toolName}.editableFields: field "${ef.field}" invalidates "${k}" not found in params.properties`,
                  )
                } else if (k === ef.field) {
                  errors.push(
                    `tools.${toolName}.editableFields: field "${ef.field}" cannot invalidate itself`,
                  )
                }
              }
            }
          }
          if (!(ef.field in props)) {
            errors.push(
              `tools.${toolName}.editableFields: field "${ef.field}" not found in params.properties`,
            )
          } else if (
            (ef.widget === "text" || ef.widget === "richtext") &&
            props[ef.field].type !== "string"
          ) {
            errors.push(
              `tools.${toolName}.editableFields: field "${ef.field}" widget "${ef.widget}" requires params.properties.${ef.field}.type === "string"`,
            )
          } else if (ef.widget === "email-list" && props[ef.field].type !== "array") {
            errors.push(
              `tools.${toolName}.editableFields: field "${ef.field}" widget "email-list" requires params.properties.${ef.field}.type === "array"`,
            )
          }
        }
      }
      if (tool.approvalExpiryHours !== undefined) {
        const v = tool.approvalExpiryHours
        if (!Number.isInteger(v) || v < 1 || v > 720) {
          errors.push(
            `tools.${toolName}.approvalExpiryHours: must be an integer in [1, 720], got ${v}`,
          )
        }
      }
    }
  }

  // Event subscribers must be strings
  const subscribes = (manifest.events as any)?.subscribes
  if (subscribes && typeof subscribes === "object") {
    for (const [eventType, handler] of Object.entries(subscribes)) {
      if (typeof handler !== "string") {
        errors.push(`events.subscribes.${eventType}: subscriber must be a string export name`)
      }
    }
  }

  // Cron expression validation (better error message than pattern)
  if (manifest.jobs) {
    for (const [jobName, jobDef] of Object.entries(manifest.jobs as Record<string, any>)) {
      if (jobDef.schedule && !CRON_REGEX.test(jobDef.schedule)) {
        errors.push(`jobs.${jobName}.schedule: invalid cron expression "${jobDef.schedule}"`)
      }
    }
  }

  if (manifest.schema) validateSchemaConstraints(manifest.schema, errors)

  // Validate constraint and index field references. Every entity table also
  // carries IMPLICIT system columns emitted by generateTableDdl/ddl.ts
  // regardless of what's declared under `fields` — id, orgId, createdAt,
  // updatedAt (plus handle when handlePrefix/systemColumns.handle is set) —
  // so an index/constraint on one of those is legitimate even though it has
  // no matching `fields` entry. Without this allowance, a perf-index migration
  // that mirrors a manifest `indexes: [["createdAt"]]` entry trips this
  // validator on every app registration (`Schema "x" index references
  // unknown field "createdAt"`), even though the runtime DDL generator itself
  // supports indexing these columns.
  const SYSTEM_COLUMN_FIELDS = new Set(["id", "orgId", "createdAt", "updatedAt", "handle"])
  if (manifest.schema) {
    for (const [entityName, entityDef] of Object.entries(manifest.schema as Record<string, any>)) {
      const declaredFields = new Set([
        ...Object.keys(entityDef.fields ?? {}),
        ...SYSTEM_COLUMN_FIELDS,
      ])
      if (entityDef.constraints?.unique) {
        for (const u of entityDef.constraints.unique) {
          const cols: string[] = Array.isArray(u) ? u : (u.columns ?? [])
          for (const col of cols) {
            if (!declaredFields.has(col)) {
              errors.push(`Schema "${entityName}" constraint references unknown field "${col}"`)
            }
          }
        }
      }
      if (entityDef.indexes) {
        for (const idx of entityDef.indexes) {
          const cols: string[] = Array.isArray(idx) ? idx : (idx.columns ?? [])
          for (const col of cols) {
            if (!declaredFields.has(col)) {
              errors.push(`Schema "${entityName}" index references unknown field "${col}"`)
            }
          }
        }
      }
    }
  }

  // Cross-field: entity-schema key match (entities.<x> requires schema.<x>, or
  // entities.<x>.tableName must point at an existing schema entry).
  // Entities marked `external: true` live in an external system (e.g. Shopify
  // orders) and have no local table — the mismatch check skips them.
  if (manifest.schema && manifest.entities) {
    const schemaKeys = new Set(Object.keys(manifest.schema))
    for (const [k, def] of Object.entries(manifest.entities as Record<string, any>)) {
      if (def?.external === true) continue
      const target = def?.tableName ?? k
      if (!schemaKeys.has(target)) {
        errors.push(`entity_schema_mismatch: entities.${k} has no matching schema.${target}`)
      }
    }
  }

  errors.push(...printDeclarationErrors(manifest))
  errors.push(...pickDeclarationErrors(manifest))
  errors.push(...routineFlowDeclarationErrors(manifest))
  errors.push(...tableBackingDeclarationErrors(manifest))

  // Cross-field: searchable entities must declare tableName + readScope
  if (manifest.entities) {
    for (const [k, def] of Object.entries(manifest.entities as Record<string, any>)) {
      if (def?.searchable === true) {
        if (!def.tableName) {
          errors.push(`entities.${k}: searchable entities require tableName`)
        }
        if (!def.readScope) {
          errors.push(`entities.${k}: searchable entities require readScope`)
        }
        if (!def.labelField) {
          errors.push(`entities.${k}: searchable entities require labelField`)
        }
      }
    }
  }

  // Cross-field: bulk action sanity checks
  if (manifest.bulk) {
    const toolNames = new Set(Object.keys((manifest.tools as Record<string, any>) ?? {}))
    for (const [actionName, action] of Object.entries(manifest.bulk as Record<string, any>)) {
      const underlying = action.underlyingTool as string | undefined
      if (!underlying || !toolNames.has(underlying)) {
        errors.push(
          `bulk.${actionName}.underlyingTool: unknown tool "${underlying}" (must be a declared manifest tool)`,
        )
        continue
      }
      if (action.agentTool && toolNames.has(action.agentTool)) {
        errors.push(
          `bulk.${actionName}.agentTool: collides with existing tool "${action.agentTool}"`,
        )
      }
      if (action.sharedFields && action.sharedFields.length > 0) {
        const underlyingTool = (manifest.tools as Record<string, any>)[underlying] ?? {}
        const declaredEditable = new Set<string>(
          ((underlyingTool.editableFields ?? []) as Array<{ field: string }>).map((f) => f.field),
        )
        const declaredParams = new Set<string>(
          Object.keys(
            ((underlyingTool.params as any)?.properties ?? {}) as Record<string, unknown>,
          ),
        )
        const hasMetadata = declaredEditable.size > 0 || declaredParams.size > 0
        if (!hasMetadata) {
          errors.push(
            `bulk.${actionName}.sharedFields: underlying tool "${underlying}" exposes no editableFields or params metadata to validate shared fields against`,
          )
        } else {
          for (const f of action.sharedFields as string[]) {
            if (!declaredEditable.has(f) && !declaredParams.has(f)) {
              errors.push(
                `bulk.${actionName}.sharedFields: field "${f}" not declared in tool "${underlying}" editableFields or params`,
              )
            }
          }
        }
      }
    }
  }

  // Cross-field: savedViews defaults must have unique keys per view
  if (manifest.savedViews) {
    const tabTypes = new Set(
      Object.keys((manifest.views as any)?.tabTypes ?? ({} as Record<string, unknown>)),
    )
    for (const [viewId, view] of Object.entries(manifest.savedViews as Record<string, any>)) {
      if (viewId !== "home" && !tabTypes.has(viewId)) {
        errors.push(`savedViews.${viewId}: unknown viewId (no matching views.tabTypes entry)`)
      }
      const seen = new Set<string>()
      for (const def of (view.defaults ?? []) as Array<{ key: string }>) {
        if (seen.has(def.key)) {
          errors.push(`savedViews.${viewId}.defaults: duplicate key "${def.key}"`)
        }
        seen.add(def.key)
      }
    }
  }

  // Cross-field: roles.extends must reference an in-manifest role and not cycle
  if (manifest.roles) {
    const known = new Set(Object.keys(manifest.roles))
    for (const [name, def] of Object.entries(manifest.roles as Record<string, any>)) {
      if (def.extends) {
        if (!known.has(def.extends)) {
          errors.push(`role "${name}" extends unknown role "${def.extends}"`)
          continue
        }
        const visited = new Set<string>([name])
        let cur: string | undefined = def.extends as string
        while (cur) {
          if (visited.has(cur)) {
            errors.push(`role extends cycle involving "${name}"`)
            break
          }
          visited.add(cur)
          cur = (manifest.roles as Record<string, any>)[cur]?.extends
        }
      }
    }
  }

  // Cross-field: memberPresetScopes and everyMemberScopes may only hand members
  // what the app's own `member` tier already grants (never an editor/admin
  // scope, never another app's namespace).
  for (const field of ["memberPresetScopes", "everyMemberScopes"] as const) {
    const declared = manifest[field]
    if (!Array.isArray(declared) || declared.length === 0) continue
    const roles = (manifest.roles ?? {}) as Record<string, { extends?: string; scopes?: string[] }>
    const memberTier = new Set<string>()
    const seen = new Set<string>()
    let cur: string | undefined = roles.member ? "member" : undefined
    while (cur && !seen.has(cur)) {
      seen.add(cur)
      for (const s of roles[cur]?.scopes ?? []) memberTier.add(s)
      cur = roles[cur]?.extends
    }
    for (const scope of declared as string[]) {
      if (!memberTier.has(scope)) {
        errors.push(`${field}: "${scope}" must be granted by this app's own \`member\` role`)
      }
    }
  }

  // Cross-field: Component-A routine-template identity + kind/column checks.
  // An event template's `event` must be `<manifest.name>:<entity>:<action>`
  // where `entity:action` is one the app actually emits.
  if (manifest.routines) {
    const emits = new Set<string>(
      ((manifest.events as { emits?: string[] } | undefined)?.emits as string[] | undefined) ?? [],
    )
    for (const [key, t] of Object.entries(manifest.routines as Record<string, any>)) {
      if (t.kind === "event") {
        if (!t.event) {
          errors.push(`routines.${key}.event: required for kind:'event'`)
          continue
        }
        const parts = String(t.event).split(":")
        if (parts.length !== 3) {
          errors.push(`routines.${key}.event: must be <app>:<entity>:<action>`)
          continue
        }
        const [evApp, ent, act] = parts
        if (evApp !== manifest.name) {
          errors.push(
            `routines.${key}.event: app "${evApp}" must equal manifest name "${manifest.name}"`,
          )
          continue
        }
        if (!emits.has(`${ent}:${act}`)) {
          errors.push(`routines.${key}.event "${t.event}" not declared in events.emits`)
        }
      } else if (t.kind === "recurring") {
        if (!t.cron || !t.timezone) {
          errors.push(`routines.${key}: recurring template needs cron + timezone`)
        }
      } else if (t.kind === "scheduled") {
        if (!t.runAt) {
          errors.push(`routines.${key}: scheduled template needs runAt`)
        }
      }
    }
  }

  if (errors.length > 0) {
    return { success: false, error: errors.join("; ") }
  }

  return { success: true, data: manifest }
}

/**
 * An app declares at most one API connection (a credentials connection with an
 * `api` block), and its `customerContext` names tools the app itself declares.
 */
function apiConnectionErrors(manifest: Record<string, any>): string[] {
  const errors: string[] = []
  const apiConns = Object.entries((manifest.connections ?? {}) as Record<string, any>).filter(
    ([, c]) => c?.api,
  )
  if (apiConns.length > 1) {
    errors.push(
      `connections: at most one connection may carry an api block (${apiConns.map(([n]) => n).join(", ")})`,
    )
  }
  const tools = (manifest.tools ?? {}) as Record<string, unknown>
  for (const [name, conn] of apiConns) {
    const cc = conn.api?.customerContext as Record<string, unknown> | undefined
    for (const [key, tool] of Object.entries(cc ?? {})) {
      if (typeof tool === "string" && !tools[tool]) {
        errors.push(
          `connections.${name}.api.customerContext.${key}: "${tool}" is not a tool of the app`,
        )
      }
    }
  }
  return errors
}
