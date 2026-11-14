// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The deals factory: a sales pipeline and its deals, through `createPipeline`,
// `createTask` and `writeDealFields`, the services the agent's deal tools use,
// inside one RLS transaction as the pipeline's owner. A pipeline is found again
// by its key and a deal by its task `externalRef`, so a re-run adopts instead
// of duplicating. No privileged write, and no random draw: every deal is a
// literal in the spec.
import { sql } from "drizzle-orm"
import { createPipeline } from "~/apps/projects/service/create-project"
import { setLostReason, writeDealFields } from "~/apps/projects/service/deals"
import { createTask } from "~/apps/projects/service/tasks"
import type { UserContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import type { SeedContext } from "~/seed/context"
import { asUser, rowsOf } from "~/seed/factories/people/actors"

export interface DealSpec {
  key: string
  title: string
  /** A stage label of the pipeline (Lead, Qualified, Demo, Proposal, Won, Lost). */
  stage: string
  companyKey?: string
  contactKey?: string
  /** Person key of the deal's owner. */
  owner?: string
  amountMinor: number
  currency: string
  probability?: number
  nextStep?: string
  lostReason?: string
}

export interface PipelineSpec {
  key: string
  name: string
  description: string
  deals: DealSpec[]
}

type ExecTx = { execute: (q: unknown) => Promise<unknown> }

/** Seed one pipeline with its deals as `owner`; returns the deal task ids by key. */
export async function seedPipeline(
  ctx: SeedContext,
  owner: UserContext,
  input: {
    people: Record<string, { userId: string } | undefined>
    companyIds: Readonly<Record<string, string>>
    contactIds: Readonly<Record<string, string>>
    spec: PipelineSpec
    externalRefOf: (dealKey: string) => string
  },
): Promise<{ projectId: string; dealIds: Record<string, string> }> {
  const { orgId } = ctx
  const dealIds: Record<string, string> = {}
  let projectId = ""
  await asUser(owner, async (tx) => {
    const found = rowsOf<{ id: string }>(
      await (tx as ExecTx).execute(
        sql`SELECT id FROM ${sql.raw(schemaRef("app_projects"))}.projects
            WHERE org_id = ${orgId} AND key = ${input.spec.key} LIMIT 1`,
      ),
    )[0]
    if (found) {
      projectId = found.id
    } else {
      const created = await createPipeline({
        tx: tx as never,
        orgId,
        actor: owner,
        input: { name: input.spec.name, description: input.spec.description, key: input.spec.key },
      })
      projectId = created.id
    }
    for (const deal of input.spec.deals) {
      const externalRef = input.externalRefOf(deal.key)
      const existing = rowsOf<{ id: string }>(
        await (tx as ExecTx).execute(
          sql`SELECT id FROM ${sql.raw(schemaRef("app_projects"))}.tasks
              WHERE org_id = ${orgId} AND external_ref = ${externalRef} LIMIT 1`,
        ),
      )[0]
      if (existing) {
        dealIds[deal.key] = existing.id
        continue
      }
      const assignee = deal.owner ? input.people[deal.owner]?.userId : undefined
      const task = await createTask({
        tx: tx as never,
        orgId,
        actor: owner,
        input: {
          projectId,
          title: deal.title,
          statusLabel: deal.stage,
          ...(assignee ? { assigneeId: assignee } : {}),
          externalRef,
        } as never,
      })
      const companyId = deal.companyKey ? input.companyIds[deal.companyKey] : undefined
      const contactId = deal.contactKey ? input.contactIds[deal.contactKey] : undefined
      await writeDealFields(tx as never, orgId, owner.scopes, task.id, {
        ...(companyId ? { companyId } : {}),
        ...(contactId ? { contactId } : {}),
        amountMinor: deal.amountMinor,
        currency: deal.currency,
        ...(deal.probability !== undefined ? { probability: deal.probability } : {}),
        ...(deal.nextStep ? { nextStep: deal.nextStep } : {}),
      })
      if (deal.lostReason) await setLostReason(tx as never, orgId, task.id, deal.lostReason)
      dealIds[deal.key] = task.id
    }
  })
  ctx.log(`deals: pipeline ${input.spec.key} with ${Object.keys(dealIds).length} deals`)
  return { projectId, dealIds }
}
