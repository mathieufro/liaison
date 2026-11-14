// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The approval card of "enable the Deal follow-ups routine": what it would look
// for, when a draft stops, who it skips today and why (counted from the same
// server read the routine makes, so the numbers are the routine's own), who
// approves each draft, and what every mail gets at send. Shown to people; no
// model reads it.

import { sql as drizzleSql } from "drizzle-orm"
import { kernelRel, projectsRel } from "~/apps/projects/schema-refs"
import { extractRows } from "~/db"
import { appsLogger as log } from "~/lib/logger"
import {
  DEAL_FOLLOWUPS_DEFAULT_QUIET_DAYS,
  dealFollowupOptions,
} from "~/modules/agent/routines/kernel-routine-templates"
import type { ApprovalSummarizer } from "~/modules/apps/app-registries"
import { readCommercialIdentity } from "~/modules/mail/commercial-footer"

type SummaryCtx = Parameters<ApprovalSummarizer>[1]

interface SetupParams {
  timezone?: string
  time?: string
  quietDays?: number
  pipelineId?: string
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function skipsLine(counts: Record<string, number> | null): string {
  const base =
    "Skips: people who opted out, and people with no recorded reason to get sales messages."
  if (!counts) return base
  const parts = [
    counts.no_basis
      ? `${plural(counts.no_basis, "deal's person has", "deals' people have")} no recorded basis`
      : null,
    counts.consumer_unknown
      ? `${plural(counts.consumer_unknown, "deal's person is", "deals' people are")} not known to be a business`
      : null,
    counts.no_sender
      ? `${plural(counts.no_sender, "deal has no mailbox of its", "deals have no mailbox of their")} owner to send from`
      : null,
  ].filter((x): x is string => x !== null)
  return parts.length === 0
    ? `${base} Of the deals quiet today, none is skipped for a missing basis or sender.`
    : `${base} Of the deals quiet today: ${parts.join(", ")}.`
}

export async function summarizeDealFollowupsSetup(
  p: SetupParams,
  ctx: SummaryCtx,
): Promise<unknown> {
  const options = dealFollowupOptions({ quietDays: p.quietDays, pipelineId: p.pipelineId })
  const quietDays = "error" in options ? DEAL_FOLLOWUPS_DEFAULT_QUIET_DAYS : options.quietDays
  const pipelineId = "error" in options ? null : options.pipelineId

  let pipelineName: string | null = null
  let counts: Record<string, number> | null = null
  let example: { title: string; contactName: string | null } | null = null
  try {
    if (pipelineId) {
      const rows = extractRows<{ name: string }>(
        await ctx.tx.execute(drizzleSql`
          SELECT name FROM ${projectsRel("projects")}
          WHERE id = ${pipelineId}::uuid AND org_id = ${ctx.orgId}::uuid LIMIT 1`),
      )
      pipelineName = rows[0]?.name ?? null
    }
    const scopes =
      ctx.actor && "scopes" in ctx.actor && Array.isArray(ctx.actor.scopes) ? ctx.actor.scopes : []
    const { followupCandidates } = await import("~/apps/projects/service/deals")
    const rows = await followupCandidates(ctx.tx as never, ctx.orgId, scopes, {
      quietDays,
      callerUserId: ctx.userId,
      ...(pipelineId ? { projectId: pipelineId } : {}),
    })
    counts = {}
    for (const r of rows) if (r.skip) counts[r.skip] = (counts[r.skip] ?? 0) + 1
    const ready = rows.find((r) => r.skip === null)
    if (ready) {
      const names = ready.contactId
        ? extractRows<{ name: string | null }>(
            await ctx.tx.execute(drizzleSql`
              SELECT name FROM ${kernelRel("contacts")}
              WHERE id = ${ready.contactId}::uuid AND org_id = ${ctx.orgId}::uuid LIMIT 1`),
          )
        : []
      example = { title: ready.title, contactName: names[0]?.name ?? null }
    }
  } catch (err) {
    // The card still says what the routine does; only today's numbers are left out.
    log.warn({ err, orgId: ctx.orgId }, "deal follow-ups card: today's counts unavailable")
  }

  const identity = await readCommercialIdentity(ctx.orgId).catch(() => null)
  const where = pipelineId ? (pipelineName ?? "the chosen pipeline") : "every pipeline"
  const at = p.time ?? "08:00"
  return {
    kind: "enable_routine_template",
    title: "Create routine: Deal follow-ups",
    subtitle: "It only drafts. Each follow-up waits as an approval before it is sent.",
    lines: [
      `Runs: every weekday at ${at}${p.timezone ? ` (${p.timezone})` : ", in the owner's timezone"}`,
      `Looks for: open deals in ${where} with nothing from the client for ${plural(quietDays, "day", "days")}`,
      "Stops when: anyone at the company replies, someone opts out, or the deal closes",
      skipsLine(counts),
      "Who approves: the deal's owner when it sends from their own mailbox, the mail approvers when it sends from a shared one; in Home and in this thread",
      example
        ? `Example draft: a short check-in on "${example.title}"${example.contactName ? ` to ${example.contactName}` : ""}, in the language of their last message, signed by the deal's owner`
        : "Example draft: a short check-in on the deal to its contact, in the language of their last message, signed by the deal's owner",
      "Checked again at send: a reply or an opt-out that comes in while a draft waits cancels it, even after approval.",
      identity
        ? `Added at send, and nobody can remove it: ${identity.legalName}, its postal address, an opt-out link.`
        : "Added at send: the company's legal name, postal address and an opt-out link. Not set yet: commercial mail is refused until they are set in the mail settings.",
    ],
  }
}
