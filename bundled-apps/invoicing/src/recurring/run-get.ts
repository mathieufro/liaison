// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One month-end run as a person or an agent reads it: its state and dates, and each row with its
// draft id, amounts, account manager, latest change and flags, so a change is made on the right
// draft with the draft tools.
import type { ErrorEnvelope } from "../mutations/shared"
import { AMOUNT_CHECK } from "./flags"
import { updatedAtOf } from "./restage"
import { dayOf, draftLines, draftTotals, jsonOf, type Row, type RunCtx, runItems } from "./run-card"

export interface RunRow {
  item_id: string
  draft_id: string | null
  document_id: string
  state: string
  customer: string | null
  account_manager: string | null
  net_minor: string
  vat_minor: string
  total_minor: string
  currency: string
  number: string | null
  updated_at: string | null
  latest_change: Record<string, unknown> | null
  flags: string[]
  failure: unknown
  /** Where the issued invoice stands with the e-invoicing platform, its collection report and payment. */
  einvoice_state: string | null
  collection_state: string | null
  payment_status: string | null
  /** An address an agent found for a row that has none, which a person uses; only on such a row. */
  fix_suggestion?: Record<string, unknown>
}

/**
 * A schedule edited after its row was drafted never moves the row: the row says so, and its own
 * edit changes this month if someone wants that too. A "from now on" written from this row is not
 * such a change.
 */
function scheduleMoved(item: Row, schedule: Row | null): string[] {
  if (!schedule || item.schedule_version === null || item.schedule_version === undefined) return []
  if (item.state === "issued" || item.state === "left_out") return []
  const patch = jsonOf<Row | null>(item.schedule_patch, null)
  const own = patch?.written === true ? Number(patch.written_version) : null
  const now = Number(schedule.version ?? 1)
  return now > Number(item.schedule_version) && now !== own
    ? ["The schedule changed after this draft"]
    : []
}

/** A card staged for the run and not yet decided: the run still waits for it. */
function cardWaiting(run: Row, rows: readonly { state: string }[]): boolean {
  const id = run.approval_request_id
  if (typeof id !== "string" || id === "" || id === "staging") return false
  return run.status === "drafted" || rows.some((r) => r.state === "waiting_reapproval")
}

function suggestionOf(item: Row): { fix_suggestion?: Record<string, unknown> } {
  const found = jsonOf<Record<string, unknown> | null>(item.fix_suggestion, null)
  return found && typeof found === "object" ? { fix_suggestion: found } : {}
}

export async function recurringRunGet(
  ctx: RunCtx,
  input: { run_id?: string },
): Promise<{ status: "completed"; run: Row; rows: RunRow[]; message: string } | ErrorEnvelope> {
  let run: Row | null = null
  if (input.run_id) run = (await ctx.db.findOne("recurring_runs", input.run_id)) as Row | null
  else
    run =
      (
        (await ctx.db.findMany("recurring_runs", {
          orderBy: { issue_on: "desc" },
          limit: 1,
        })) as Row[]
      )[0] ?? null
  if (!run) {
    return {
      status: "error",
      error: {
        code: "run_not_found",
        message: input.run_id
          ? `No month-end run ${input.run_id}.`
          : "No month-end run exists yet.",
      },
    }
  }
  const rows: RunRow[] = []
  for (const item of await runItems(ctx, String(run.id))) {
    const doc = (await ctx.db.findOne("documents", String(item.document_id))) as Row | null
    const schedule = item.schedule_id
      ? ((await ctx.db.findOne("recurring_schedules", String(item.schedule_id))) as Row | null)
      : null
    const t = doc
      ? draftTotals(await draftLines(ctx, String(doc.id)))
      : { net: 0n, vat: 0n, total: 0n }
    const log = jsonOf<Array<Record<string, unknown>>>(doc?.lifecycle_log, [])
    rows.push({
      item_id: String(item.id),
      draft_id: doc && doc.status === "draft" ? String(doc.id) : null,
      document_id: String(item.document_id),
      state: String(item.state),
      customer: (doc?.counterparty_name as string | null) ?? null,
      account_manager: (schedule?.created_by as string | null) ?? null,
      net_minor: t.net.toString(),
      vat_minor: t.vat.toString(),
      total_minor: t.total.toString(),
      currency: String(doc?.currency ?? "EUR"),
      number: (item.issued_number as string | null) ?? (doc?.number as string | null) ?? null,
      updated_at: doc ? updatedAtOf(doc) : null,
      latest_change: log.length > 0 ? (log[log.length - 1] ?? null) : null,
      flags: [
        ...(typeof item.note === "string" && item.note ? item.note.split(" · ") : []),
        ...scheduleMoved(item, schedule),
      ],
      failure: item.failure ?? null,
      einvoice_state: (doc?.einvoice_state as string | null) ?? null,
      collection_state: (doc?.collection_state as string | null) ?? null,
      payment_status: (doc?.payment_status as string | null) ?? null,
      ...suggestionOf(item),
    })
  }
  const issuer = run.issuer_profile_id
    ? ((await ctx.db.findOne("issuer_profiles", String(run.issuer_profile_id))) as Row | null)
    : null
  const runOut: Row = {
    id: String(run.id),
    status: run.status,
    issue_on: dayOf(run.issue_on),
    latest_issue_on: dayOf(run.latest_issue_on),
    period: run.period_label,
    approved_by: run.approved_by ?? null,
    approved_at: run.approved_at ?? null,
    auto: run.auto === true,
    approval_request_id: run.approval_request_id ?? null,
    timezone: (issuer?.timezone as string | null) ?? null,
  }
  const far = rows.filter(
    (r) =>
      r.state !== "issued" &&
      r.state !== "left_out" &&
      r.flags.some((f) => f.startsWith(AMOUNT_CHECK)),
  )
  return {
    status: "completed",
    run: runOut,
    rows,
    message:
      `Run ${String(run.id)} for ${String(run.period_label)} is ${String(run.status)}, ${rows.length} row${rows.length === 1 ? "" : "s"}. Change a row with drafts_update on its draft_id.` +
      (far.length > 0
        ? ` ${far.length} row${far.length === 1 ? " bills" : "s bill"} far from the last invoice of ${far.length === 1 ? "its" : "their"} schedule (${far
            .slice(0, 3)
            .map((r) => r.customer ?? r.item_id)
            .join(
              ", ",
            )}${far.length > 3 ? ", ..." : ""}). The "Check the amount" flag names what was billed last time: check it with a person before the card is approved.`
        : "") +
      (cardWaiting(run, rows)
        ? ` Its card (approval ${String(run.approval_request_id)}) waits for a person, who approves or rejects it on the card; no tool approves it.`
        : ""),
  }
}
