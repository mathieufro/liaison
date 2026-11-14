// SPDX-License-Identifier: FSL-1.1-ALv2
// Margin and cost rates: finance's figures, chat only.
//
// Margin is one project's invoiced amount (read from invoicing, excluding VAT and net of credit
// notes) minus its time at cost (each hour at the cost rate in force on its work date, from
// `project_time_cost`). It is one figure per project and never a figure per person: there is no
// person parameter, no breakdown, and the time with no rate is counted, never named. Cost and
// rates are read only with the exact `projects:margin:read` scope (row security says the same),
// and when invoices cannot be read the answer is a refusal, never cost shown alone.
import { sql as drizzleSql } from "drizzle-orm"
import { kernelRel, projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient } from "~/db"
import { type BudgetTask, type Coverage, coverageOf, liveTasks } from "./coverage"
import { mixedCurrencies, parseCurrency } from "./currency"
import { ProjectsServiceError } from "./statuses"
import { isCalendarDate, loadPlanningProject, requirePlanning } from "./time-plan"

type Tx = RlsClient

export const MARGIN_READ_SCOPE = "projects:margin:read"
export const COST_RATES_WRITE_SCOPE = "projects:cost_rates:write"

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

/** Exact scopes only: a wildcard grant does not read cost (row security uses the same rule). */
function requireExact(scopes: readonly string[], scope: string, what: string): void {
  if (scopes.includes(scope)) return
  throw new ProjectsServiceError(
    403,
    "finance_only",
    `Cost rates are visible to finance only, so I cannot work out ${what} for you. Nothing was read.`,
    {
      next: "budget_get gives the project's hours, coverage and, with the money scope, its price and what is invoiced.",
    },
  )
}

function money(minor: number, currency: string | null): string {
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: currency ?? "EUR",
    }).format(minor / 100)
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency ?? ""}`.trim()
  }
}

const hoursText = (minutes: number) => `${Math.round((minutes / 60) * 10) / 10} h`

/** "2026-10" to its first and last day. */
function monthRange(month: string): { from: string; to: string; label: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(month)
  const y = Number(m?.[1])
  const mo = Number(m?.[2])
  if (!m || mo < 1 || mo > 12) {
    throw new ProjectsServiceError(
      400,
      "invalid_month",
      `Nothing was read: "${month}" is not a month. Write it YYYY-MM, like 2026-10.`,
    )
  }
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate()
  return {
    from: `${month}-01`,
    to: `${month}-${String(last).padStart(2, "0")}`,
    label: `${MONTHS[mo - 1]} ${y}`,
  }
}

/** The project's live tasks, as coverage reads them (same rule as `budget_get`). */
async function readTasks(tx: Tx, orgId: string, projectId: string): Promise<BudgetTask[]> {
  const rows = extractRows<{
    id: string
    parent_id: string | null
    title: string
    position: number
    number: number
    timebox_minutes: number | null
    is_milestone: boolean
    archived: boolean
    closed: boolean
    started: boolean
  }>(
    await tx.execute(drizzleSql`
      SELECT t.id::text AS id, t.parent_task_id::text AS parent_id, t.title, t.position,
             t.number, t.timebox_minutes, t.is_milestone,
             t.archived_at IS NOT NULL AS archived,
             (NOT cancelled.is AND (t.completed_at IS NOT NULL OR s.terminal)) AS closed,
             (NOT cancelled.is AND (t.completed_at IS NOT NULL OR s.terminal
              OR (s."order" > (SELECT min(s2."order") FROM ${projectsRel("project_statuses")} s2
                                WHERE s2.project_id = t.project_id)
                  AND lower(s.label) NOT IN ('backlog', 'todo', 'to do')))) AS started
        FROM ${projectsRel("tasks")} t
        JOIN ${projectsRel("project_statuses")} s ON s.id = t.status_id
        CROSS JOIN LATERAL (SELECT lower(s.label) IN ('cancelled', 'canceled') AS is) cancelled
       WHERE t.project_id = ${projectId}::uuid AND t.org_id = ${orgId}::uuid`),
  )
  return rows.map((r) => ({
    id: r.id,
    parentId: r.parent_id,
    name: r.title,
    position: r.position,
    number: r.number,
    timebox: r.timebox_minutes,
    isMilestone: r.is_milestone,
    archived: r.archived,
    closed: r.closed,
    started: r.started,
  }))
}

/** What margin needs from projects: the cost side, read before invoices are asked for. */
export interface MarginCost {
  projectId: string
  projectName: string
  period: { from: string; to: string; label: string } | null
  /** Time at cost, minor units. */
  costMinor: number
  takenMinutes: number
  minutesWithoutRate: number
  partial: boolean
  coverage: Coverage
  /** The project's billing currency, when it has one. */
  currency: string | null
  /** The currencies the costed time is in (its rates', or a frozen cost's); empty when none says. */
  costCurrencies: string[]
  /** Some costed time comes from a rate, or a frozen cost, with no currency. */
  costUnlabelled: boolean
}

export async function getMarginCost(args: {
  tx: Tx
  orgId: string
  scopes: readonly string[]
  projectId: string
  month?: string
}): Promise<MarginCost> {
  const { tx, orgId, scopes, projectId } = args
  const project = await loadPlanningProject(tx, orgId, projectId)
  requirePlanning(orgId, project, scopes)
  requireExact(scopes, MARGIN_READ_SCOPE, "margin")
  const period = args.month ? monthRange(args.month) : null
  const from = period ? drizzleSql`${period.from}::date` : drizzleSql`NULL::date`
  const to = period ? drizzleSql`${period.to}::date` : drizzleSql`NULL::date`

  const cost = extractRows<{
    cost: string | number
    without: string | number
    currencies: string[] | string | null
    unlabelled: boolean | null
  }>(
    await tx.execute(drizzleSql`
      SELECT ${projectsRel("project_time_cost")}(${projectId}::uuid, ${from}, ${to}) AS cost,
             ${projectsRel("project_time_minutes_without_rate")}(${projectId}::uuid, ${from}, ${to})
               AS without,
             ${projectsRel("project_time_cost_currencies")}(${projectId}::uuid, ${from}, ${to})
               AS currencies,
             ${projectsRel("project_time_cost_unlabelled")}(${projectId}::uuid, ${from}, ${to})
               AS unlabelled`),
  )[0]
  const totals = extractRows<{ task_id: string; minutes: string | number; has_entries: boolean }>(
    await tx.execute(drizzleSql`
      SELECT task_id::text AS task_id, minutes, has_entries
        FROM ${projectsRel("task_time_totals")}(${projectId}::uuid, ${from}, ${to})`),
  )
  const live = liveTasks(await readTasks(tx, orgId, projectId))
  const liveIds = new Set(live.map((t) => t.id))
  const hasEntries = new Set(
    totals.filter((r) => r.has_entries && liveIds.has(r.task_id)).map((r) => r.task_id),
  )
  const coverage = coverageOf(live, hasEntries)
  const terms = extractRows<{ currency: string | null }>(
    await tx.execute(drizzleSql`
      SELECT currency FROM ${projectsRel("project_billing_terms")}
       WHERE project_id = ${projectId}::uuid AND org_id = ${orgId}::uuid`),
  )[0]
  return {
    projectId,
    projectName: project.name,
    period,
    costMinor: Number(cost?.cost ?? 0),
    takenMinutes: totals.reduce((s, r) => s + Number(r.minutes), 0),
    minutesWithoutRate: Number(cost?.without ?? 0),
    partial: coverage.withEntries < coverage.total,
    coverage,
    currency: terms?.currency ?? null,
    costCurrencies: textArray(cost?.currencies),
    costUnlabelled: cost?.unlabelled === true,
  }
}

/** A Postgres text[] as the driver hands it back: an array, or its literal ("{EUR,USD}"). */
function textArray(v: string[] | string | null | undefined): string[] {
  if (Array.isArray(v)) return v
  if (typeof v !== "string" || v.length < 2) return []
  const inner = v.slice(1, -1)
  return inner === "" ? [] : inner.split(",").map((s) => s.replace(/^"|"$/g, ""))
}

/** What invoicing answered: an amount, or why it could not. */
export type InvoicedRead =
  | { ok: true; invoicedMinor: number; currency: string | null; documents: number }
  | {
      ok: false
      off: boolean
      /** Invoicing's own refusal, passed on as it is (documents in two currencies). */
      refusal?: { code: string; message: string; next?: string }
    }

/** The margin answer. Never built from cost alone: a failed invoice read is a refusal. */
export type MarginResult =
  | {
      projectId: string
      projectName: string
      period?: { from: string; to: string; label: string }
      title: string
      margin: number
      invoiced: number
      cost: number
      currency: string
      takenMinutes: number
      partial: boolean
      coverage: Coverage
      marginText: string
      sub: string
      delta: string
      line: string
      how: string
      leftOut: string[]
      ratesMissing?: { minutes: number; text: string; next: string }
    }
  | { error: { code: string; message: string; next?: string; retryable: boolean } }

const LEFT_OUT = [
  "Overheads, expenses, subcontractors and software: the accounts hold them at company level, not by project.",
  "Time nobody entered: it costs nothing here, so a project with blanks looks better than it is. That is why a figure reads partial.",
  "Earned revenue: invoiced is not earned, and an advance can pay for work not done yet.",
  "The accuracy of the cost rates: each is a number someone typed, and only as good as that.",
]

export function composeMargin(cost: MarginCost, invoiced: InvoicedRead): MarginResult {
  if (!invoiced.ok && invoiced.refusal) {
    return { error: { ...invoiced.refusal, retryable: false } }
  }
  if (!invoiced.ok) {
    return invoiced.off
      ? {
          error: {
            code: "invoicing_off",
            message:
              "Invoicing is not on in this workspace, so I cannot work out margin. Nothing was computed.",
            next: "budget_get gives the project's hours and coverage.",
            retryable: false,
          },
        }
      : {
          error: {
            code: "invoices_unreadable",
            message:
              "I cannot read invoices right now, so I cannot work out margin. Nothing was computed.",
            next: "Try again in a moment. budget_get gives the project's hours and coverage meanwhile.",
            retryable: true,
          },
        }
  }
  // Invoices and time at cost must be in one currency, or the subtraction means nothing.
  const used = [
    ...new Set([...cost.costCurrencies, ...(invoiced.currency ? [invoiced.currency] : [])]),
  ]
  // Time at a rate with no currency beside time at one with a currency: two units, one sum.
  if (used.length > 1 || (cost.costUnlabelled && cost.costCurrencies.length > 0)) {
    return mixedCurrencies(
      cost.costUnlabelled ? [...used, "time at a rate with no currency"] : used,
      `${cost.projectName}'s margin`,
      "cost_rates_list shows each rate's currency; set the odd one again in the invoices' currency with cost_rate_set.",
    )
  }
  const currency = invoiced.currency ?? cost.costCurrencies[0] ?? cost.currency ?? "EUR"
  const marginMinor = invoiced.invoicedMinor - cost.costMinor
  const where = cost.period ? `${cost.projectName}, ${cost.period.label}` : cost.projectName
  const cover = `Time spent is entered on ${cost.coverage.withEntries} of ${cost.coverage.total} tasks.`
  const sub = `${money(invoiced.invoicedMinor, currency)} invoiced, ${hoursText(cost.takenMinutes)} taken, costing ${money(cost.costMinor, currency)}. ${cover}`
  const partialText = cost.partial
    ? ` Partial: ${cover.charAt(0).toLowerCase()}${cover.slice(1)}`
    : ""
  const how = `Invoices linked to the project, excluding VAT and net of credit notes, minus each hour taken at the cost rate on that day.${
    cost.period ? ` Only the invoices issued and the hours worked in ${cost.period.label}.` : ""
  }${invoiced.documents === 0 ? " No issued invoice is linked to the project yet." : ""}`
  const ratesMissing =
    cost.minutesWithoutRate > 0
      ? {
          minutes: cost.minutesWithoutRate,
          text: `${hoursText(cost.minutesWithoutRate)} taken have no cost rate on their day, so they cost nothing here.`,
          next: "cost_rates_list shows the rates set; cost_rate_set adds a missing one from a date.",
        }
      : undefined
  return {
    projectId: cost.projectId,
    projectName: cost.projectName,
    ...(cost.period ? { period: cost.period } : {}),
    title: `Margin: invoiced minus time at cost, ${where}`,
    margin: marginMinor / 100,
    invoiced: invoiced.invoicedMinor / 100,
    cost: cost.costMinor / 100,
    currency,
    takenMinutes: cost.takenMinutes,
    partial: cost.partial,
    coverage: cost.coverage,
    marginText: money(marginMinor, currency),
    sub,
    delta: cost.partial ? "Partial" : "Complete",
    line: `${where}: ${money(marginMinor, currency)}, invoiced ${money(invoiced.invoicedMinor, currency)} minus ${money(cost.costMinor, currency)} of time at cost.${partialText}${
      ratesMissing ? ` ${ratesMissing.text}` : ""
    }`,
    how,
    leftOut: LEFT_OUT,
    ...(ratesMissing ? { ratesMissing } : {}),
  }
}

// ── Cost rates ──────────────────────────────────────────────────────────────

export interface CostRateRow {
  id: string
  userId: string
  name: string | null
  /** Per hour, major units. */
  rate: number
  currency: string | null
  from: string
}

const toRow = (r: {
  id: string
  user_id: string
  name: string | null
  rate_minor: string | number
  currency: string | null
  effective_from: string
}): CostRateRow => ({
  id: r.id,
  userId: r.user_id,
  name: r.name,
  rate: Number(r.rate_minor) / 100,
  currency: r.currency,
  from: r.effective_from,
})

export async function listCostRates(args: {
  tx: Tx
  orgId: string
  scopes: readonly string[]
}): Promise<{ rates: CostRateRow[]; message: string }> {
  requireExact(args.scopes, MARGIN_READ_SCOPE, "cost rates")
  const rows = extractRows<Parameters<typeof toRow>[0]>(
    await args.tx.execute(drizzleSql`
      SELECT c.id::text AS id, c.user_id::text AS user_id, u.name, c.rate_minor, c.currency,
             c.effective_from::text AS effective_from
        FROM ${projectsRel("cost_rates")} c
        LEFT JOIN ${kernelRel("users")} u ON u.id = c.user_id AND u.org_id = c.org_id
       WHERE c.org_id = ${args.orgId}::uuid
       ORDER BY u.name NULLS LAST, c.user_id, c.effective_from`),
  )
  const rates = rows.map(toRow)
  return {
    rates,
    message:
      rates.length === 0
        ? "No cost rate is set. Time with no rate costs nothing in margin; set one with cost_rate_set."
        : `${rates.length} cost rate${rates.length === 1 ? "" : "s"}. A rate applies from its date, so an earlier hour keeps its earlier cost.`,
  }
}

export async function setCostRate(args: {
  tx: Tx
  orgId: string
  scopes: readonly string[]
  input: { userId?: string; rate?: number; from?: string; currency?: string }
}): Promise<CostRateRow & { message: string }> {
  const { tx, orgId, input } = args
  requireExact(args.scopes, COST_RATES_WRITE_SCOPE, "or change cost rates")
  const userId = typeof input.userId === "string" ? input.userId.trim() : ""
  if (!/^[0-9a-f-]{36}$/i.test(userId)) {
    throw new ProjectsServiceError(
      400,
      "invalid_user",
      "Nothing changed: userId is not a person's id.",
      {
        next: "Find the person with users_search, then call again with their id.",
      },
    )
  }
  if (typeof input.rate !== "number" || !Number.isFinite(input.rate) || input.rate < 0) {
    throw new ProjectsServiceError(
      400,
      "invalid_amount",
      "Nothing changed: rate is an amount per hour, zero or more.",
    )
  }
  const from = typeof input.from === "string" ? input.from : ""
  if (!isCalendarDate(from)) {
    throw new ProjectsServiceError(
      400,
      "invalid_date",
      "Nothing changed: from is the day the rate applies from, written YYYY-MM-DD.",
    )
  }
  const person = extractRows<{ name: string | null }>(
    await tx.execute(drizzleSql`
      SELECT name FROM ${kernelRel("users")}
       WHERE id = ${userId}::uuid AND org_id = ${orgId}::uuid LIMIT 1`),
  )[0]
  if (!person) {
    throw new ProjectsServiceError(404, "user_not_found", "Nothing changed: no such person here.", {
      next: "Find the person with users_search, then call again with their id.",
    })
  }
  const currency = parseCurrency(input.currency) ?? null
  if (currency === null) {
    // A new rate needs its currency; a rate already set on that day keeps its own.
    const kept = extractRows<{ currency: string | null }>(
      await tx.execute(drizzleSql`
        SELECT currency FROM ${projectsRel("cost_rates")}
         WHERE org_id = ${orgId}::uuid AND user_id = ${userId}::uuid
           AND effective_from = ${from}::date`),
    )[0]
    if (!kept?.currency) {
      throw new ProjectsServiceError(
        400,
        "currency_required",
        "Nothing changed: a cost rate needs its currency.",
        { next: "Call again with currency, an ISO 4217 code like EUR." },
      )
    }
  }
  const row = extractRows<Parameters<typeof toRow>[0]>(
    await tx.execute(drizzleSql`
      INSERT INTO ${projectsRel("cost_rates")} (org_id, user_id, rate_minor, currency, effective_from)
      VALUES (${orgId}::uuid, ${userId}::uuid, ${Math.round(input.rate * 100)}, ${currency},
              ${from}::date)
      ON CONFLICT (org_id, user_id, effective_from) DO UPDATE SET
        rate_minor = EXCLUDED.rate_minor,
        currency = coalesce(EXCLUDED.currency, cost_rates.currency),
        updated_at = now()
      RETURNING id::text AS id, user_id::text AS user_id, ${person.name}::text AS name, rate_minor,
                currency, effective_from::text AS effective_from`),
  )[0]
  if (!row)
    throw new ProjectsServiceError(500, "not_saved", "Nothing changed: the rate was not saved.")
  const out = toRow(row)
  return {
    ...out,
    message: `From ${from}, ${person.name ?? "this person"}'s time costs ${money(
      Math.round(input.rate * 100),
      out.currency,
    )} an hour in margin. Hours before ${from} keep the rate they had.`,
  }
}
