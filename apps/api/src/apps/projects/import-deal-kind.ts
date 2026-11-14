// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Import kind `projects.deal` (modules/imports): a deal is a top-level task of
 * a pipeline with its company, contact and amount, created through the same
 * services the agent's deal tools use (`createTask`, then `writeDealFields`),
 * so the outcome, the board position and the events are the product's own.
 *
 * Per record, inside its savepoint of the run's privileged transaction:
 *   1. Dedup on the task's `external_ref` (`deal:<source>:<key>`, kept apart
 *      from task imports of the same source). Already there: skipped, never
 *      changed.
 *   2. The pipeline is found by exact name; absent, it is created with the
 *      default stages. A project that is not a pipeline refuses the record.
 *   3. The stage is found by label in that pipeline (an unknown one refuses
 *      the record and names the stages); no stage puts the deal in the first.
 *   4. The company is found by domain, else by name, else created (needs
 *      company write access); the contact by email (an unknown one is
 *      reported, the deal is still imported). The amount needs deal write
 *      access.
 * Every row the record wrote goes on the run's ledger, so an undo removes the
 * deal with its task, thread and amount, and the company only when nothing
 * else uses it.
 */
import { sql as drizzleSql } from "drizzle-orm"
import { z } from "zod"
import { resolveImportCompany } from "~/apps/contacts/import-kind"
import {
  findTaskIdByExternalRef,
  formatTaskImportError,
  normalizeEmail,
  projectIdByName,
  resolveUser,
  serviceActor,
  statusIdsOf,
} from "~/apps/projects/import-kind"
import { kernelRel, projectsRel } from "~/apps/projects/schema-refs"
import { createPipeline } from "~/apps/projects/service/create-project"
import {
  PIPELINE_CLOSING_STAGES,
  PIPELINE_OPEN_STAGES,
  projectKind,
  setLostReason,
  writeDealFields,
} from "~/apps/projects/service/deals"
import { createTask } from "~/apps/projects/service/tasks"
import { extractRows, type PrivilegedDb } from "~/db"
import { importServiceClient } from "~/modules/imports/service-client"
import {
  dedupValueOf,
  type HostImportContext,
  type HostImportHandler,
  type HostRecordOutcome,
  type ImportRowRef,
} from "~/modules/imports/types"
import { hasScope } from "~/modules/permissions/permissions"

export const dealImportRecordSchema = z
  .object({
    externalRef: z.string().min(1),
    /** The pipeline's name: found, or created with the default stages. */
    pipeline: z.string().trim().min(1),
    title: z.string().trim().min(1).max(500),
    /** The stage's label in that pipeline; none puts the deal in the first stage. */
    stage: z.string().trim().optional().nullable(),
    description: z.string().optional().nullable(),
    companyName: z.string().optional().nullable(),
    companyDomain: z.string().optional().nullable(),
    contactEmail: z.string().optional().nullable(),
    /** The deal owner (the task's assignee), by email. */
    ownerEmail: z.string().optional().nullable(),
    /** Whole minor units (cents), with its currency. */
    amountMinor: z.number().int().min(0).optional().nullable(),
    currency: z
      .string()
      .regex(/^[A-Za-z]{3}$/, "currency is a three-letter code such as EUR")
      .optional()
      .nullable(),
    amountPeriod: z.enum(["once", "month", "year"]).optional(),
    probability: z.number().int().min(0).max(100).optional().nullable(),
    nextStep: z.string().optional().nullable(),
    /** Kept when the stage is a lost one. */
    lostReason: z.string().optional().nullable(),
    createdAt: z.string().optional().nullable(),
  })
  .superRefine((r, issue) => {
    if ((r.amountMinor == null) !== (r.currency == null)) {
      issue.addIssue({
        code: "custom",
        message:
          "an amount needs its currency and a currency needs an amount (amountMinor and currency)",
      })
    }
    if (r.createdAt && Number.isNaN(new Date(r.createdAt).getTime())) {
      issue.addIssue({ code: "custom", message: `createdAt is not a date: "${r.createdAt}"` })
    }
  })

type DealRecord = z.infer<typeof dealImportRecordSchema>

/** The deal ref the task carries: apart from `projects.task` imports of one source. */
function dealRef(record: DealRecord): string {
  return `deal:${record.externalRef}`
}

const DEFAULT_STAGES = [...PIPELINE_OPEN_STAGES, ...PIPELINE_CLOSING_STAGES].map(([label]) => label)

function needsDealWrite(record: DealRecord): boolean {
  return record.amountMinor != null || record.probability != null || record.amountPeriod != null
}

/** What the run and the preview both refuse before anything else is read. */
function scopeRefusal(ctx: HostImportContext, record: DealRecord): string | null {
  return needsDealWrite(record) && !hasScope("projects:deals:write", ctx.actorScopes)
    ? "An amount or a probability needs deal access (projects:deals:write). Nothing was imported for this row."
    : null
}

interface PipelineFacts {
  projectId: string | null
  /** Stage labels of an existing pipeline, in order. */
  stages: Array<{ id: string; label: string }>
}

async function pipelineFacts(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  name: string,
): Promise<PipelineFacts> {
  const projectId = await projectIdByName(tx, ctx.orgId, name)
  if (!projectId) return { projectId: null, stages: [] }
  const kind = await projectKind(importServiceClient(tx), ctx.orgId, projectId)
  if (kind !== "pipeline") {
    throw new Error(
      `"${name}" is a project, not a pipeline, so it cannot hold deals. Name a pipeline, or a new name to create one. Nothing was imported for this row.`,
    )
  }
  const stages = extractRows<{ id: string; label: string }>(
    await tx.execute(drizzleSql`
      SELECT id::text AS id, label FROM ${projectsRel("project_statuses")}
      WHERE org_id = ${ctx.orgId}::uuid AND project_id = ${projectId}::uuid
      ORDER BY "order", id
    `),
  )
  return { projectId, stages }
}

function stageRefusal(stage: string, labels: readonly string[]): string {
  return `The pipeline has no stage "${stage}". Its stages are: ${labels.join(", ")}. Nothing was imported for this row.`
}

/** A preview's check of one deal: what the run would do, nothing written. */
async function checkDeal(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  raw: Record<string, unknown>,
): Promise<"created" | "skipped"> {
  const record = dealImportRecordSchema.parse(raw)
  if (await findTaskIdByExternalRef(tx, ctx.orgId, ctx.sourceLabel, dealRef(record))) {
    return "skipped"
  }
  const refusal = scopeRefusal(ctx, record)
  if (refusal) throw new Error(refusal)
  const facts = await pipelineFacts(tx, ctx, record.pipeline)
  const labels = facts.projectId ? facts.stages.map((s) => s.label) : DEFAULT_STAGES
  if (record.stage && !labels.some((l) => l.toLowerCase() === record.stage?.toLowerCase())) {
    throw new Error(stageRefusal(record.stage, labels))
  }
  await resolveImportCompany(
    tx,
    ctx,
    { name: record.companyName, domain: record.companyDomain },
    { write: false },
  )
  return "created"
}

async function contactIdByEmail(
  tx: PrivilegedDb,
  orgId: string,
  email: string,
): Promise<string | null> {
  const rows = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id::text AS id FROM ${kernelRel("contacts")}
      WHERE org_id = ${orgId}::uuid AND lower(email) = ${email} AND org_access <> 'none'
      ORDER BY created_at, id
      LIMIT 1
    `),
  )
  return rows[0]?.id ?? null
}

async function importDeal(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  raw: Record<string, unknown>,
): Promise<HostRecordOutcome> {
  const record = dealImportRecordSchema.parse(raw)
  const { orgId } = ctx
  const ref = dedupValueOf(ctx.sourceLabel, dealRef(record))
  if (await findTaskIdByExternalRef(tx, orgId, ctx.sourceLabel, dealRef(record))) {
    return { status: "skipped" as const, rows: [] }
  }
  const refusal = scopeRefusal(ctx, record)
  if (refusal) throw new Error(refusal)

  const rows: ImportRowRef[] = []
  const actor = serviceActor(ctx)
  const dealActor = { ...actor, scopes: ctx.actorScopes }

  // Pipeline: found, or created with the default stages.
  let facts = await pipelineFacts(tx, ctx, record.pipeline)
  let pipelineCreated = false
  if (!facts.projectId) {
    if (
      record.stage &&
      !DEFAULT_STAGES.some((l) => l.toLowerCase() === record.stage?.toLowerCase())
    ) {
      throw new Error(stageRefusal(record.stage, DEFAULT_STAGES))
    }
    const detail = await createPipeline({
      tx: importServiceClient(tx),
      orgId,
      actor,
      input: { name: record.pipeline },
    })
    rows.push({ table: "app_projects.projects", id: detail.id })
    for (const id of await statusIdsOf(tx, orgId, detail.id)) {
      rows.push({ table: "app_projects.project_statuses", id })
    }
    pipelineCreated = true
    facts = await pipelineFacts(tx, ctx, record.pipeline)
  }
  const projectId = facts.projectId as string
  let statusId: string | null = null
  if (record.stage) {
    const found = facts.stages.find((s) => s.label.toLowerCase() === record.stage?.toLowerCase())
    if (!found)
      throw new Error(
        stageRefusal(
          record.stage,
          facts.stages.map((s) => s.label),
        ),
      )
    statusId = found.id
  }

  // Company, contact and owner.
  const company = await resolveImportCompany(
    tx,
    ctx,
    { name: record.companyName, domain: record.companyDomain },
    { write: true },
  )
  if (company?.created) rows.push({ table: "kernel.companies", id: company.id })
  const contactEmail = normalizeEmail(record.contactEmail)
  const contactId = contactEmail ? await contactIdByEmail(tx, orgId, contactEmail) : null
  const ownerEmail = normalizeEmail(record.ownerEmail)
  const owner = ownerEmail
    ? await resolveUser(tx, orgId, ownerEmail, null, { placeholders: false })
    : null

  const task = await createTask({
    tx: importServiceClient(tx),
    orgId,
    actor,
    input: {
      projectId,
      ...(statusId ? { statusId } : {}),
      title: record.title,
      description: record.description ?? null,
      assigneeId: owner?.id ?? null,
      createdAt: record.createdAt ?? null,
      externalRef: ref,
    },
  })
  await writeDealFields(importServiceClient(tx), orgId, dealActor.scopes, task.id, {
    ...(company ? { companyId: company.id } : {}),
    ...(contactId ? { contactId } : {}),
    ...(record.amountMinor != null
      ? { amountMinor: record.amountMinor, currency: record.currency ?? null }
      : {}),
    ...(record.amountPeriod ? { amountPeriod: record.amountPeriod } : {}),
    ...(record.probability != null ? { probability: record.probability } : {}),
    ...(record.nextStep ? { nextStep: record.nextStep } : {}),
  })
  if (record.lostReason)
    await setLostReason(importServiceClient(tx), orgId, task.id, record.lostReason)

  // Ledger: the task's thread and seats, then the task (its deal rows go with it).
  rows.push({ table: "kernel.threads", id: task.threadId })
  for (const p of extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id FROM ${kernelRel("thread_participants")}
      WHERE thread_id = ${task.threadId}::uuid AND org_id = ${orgId}::uuid
      ORDER BY created_at, id
    `),
  )) {
    rows.push({ table: "kernel.thread_participants", id: p.id })
  }
  rows.push({ table: "app_projects.tasks", id: task.id })

  return {
    status: "created" as const,
    rows,
    report: {
      pipelineCreated,
      ...(company ? { company: company.name, companyCreated: company.created } : {}),
      ...(company?.notice ? { companyNotice: company.notice } : {}),
      ...(contactEmail && !contactId ? { contactUnresolved: contactEmail } : {}),
      ...(ownerEmail && !owner ? { ownerUnresolved: ownerEmail } : {}),
    },
  }
}

export const dealImportHandler: HostImportHandler = {
  importRecord: importDeal,
  checkRecord: checkDeal,
  formatError: (err) => {
    const text = formatTaskImportError(err)
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : null
    return cause ? `${text} (${cause})` : text
  },
}
