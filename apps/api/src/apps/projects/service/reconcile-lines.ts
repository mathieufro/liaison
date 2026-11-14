// SPDX-License-Identifier: FSL-1.1-ALv2
// Pure rules of a reconcile: which period an ask means, what a line plans, holds and bills,
// how a proof is labelled, and what a line may say. The agent supplies grouping and wording;
// every figure here is the server's. Nothing here knows who did the work: a task has minutes
// and entries, never an author.
import { parseDuration } from "@liaison/shared"
import { type BudgetTask, plannedByTask, realByTask } from "./coverage"
import { ProjectsServiceError } from "./statuses"
import type { Basis } from "./time-plan"

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

export const OTHER_LINE_NAME = "Other closed tasks"
export const NO_PLAN_TAG = "No plan and no real time"
/** A card holds at most this many rows; what is over folds into "Other closed tasks". */
export const RECONCILE_LINES_MAX = 40
export const NOT_EVERYTHING_SEEN = "I only read what you can read, so someone else may see more."

export interface Period {
  from: string
  to: string
  label: string
  /** YYYY-MM when the period is one calendar month. */
  month: string | null
}

function isDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const [y, m, d] = v.split("-").map(Number) as [number, number, number]
  const day = new Date(Date.UTC(y, m - 1, d))
  return day.getUTCFullYear() === y && day.getUTCMonth() === m - 1 && day.getUTCDate() === d
}

function lastDay(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function shortDate(iso: string, withYear = true): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number]
  return `${d} ${MONTHS[m - 1]?.slice(0, 3)}${withYear ? ` ${y}` : ""}`
}

/**
 * The period an ask names: a month (YYYY-MM), or from and to (YYYY-MM-DD), or, with neither,
 * the month of today in the org's zone. A wrong or mixed form is refused with the forms it takes.
 */
export function resolvePeriod(
  input: { month?: string; from?: string; to?: string },
  today: string,
): Period {
  const { month, from, to } = input
  if (month !== undefined && (from !== undefined || to !== undefined)) {
    throw new ProjectsServiceError(400, "invalid_period", "Give a month or from and to, not both.")
  }
  if (from !== undefined || to !== undefined) {
    if (!from || !to || !isDate(from) || !isDate(to) || from > to) {
      throw new ProjectsServiceError(
        400,
        "invalid_period",
        "from and to must both be days written YYYY-MM-DD, from on or before to.",
      )
    }
    const [y, m] = from.split("-").map(Number) as [number, number]
    const whole = from.endsWith("-01") && to === `${from.slice(0, 8)}${lastDay(y, m)}`
    return {
      from,
      to,
      label: whole ? `${MONTHS[m - 1]} ${y}` : `${shortDate(from)} to ${shortDate(to)}`,
      month: whole ? from.slice(0, 7) : null,
    }
  }
  const ym = month ?? today.slice(0, 7)
  const match = /^(\d{4})-(\d{2})$/.exec(ym)
  const y = Number(match?.[1])
  const m = Number(match?.[2])
  if (!match || m < 1 || m > 12) {
    throw new ProjectsServiceError(400, "invalid_period", "month must be written YYYY-MM.")
  }
  const mm = String(m).padStart(2, "0")
  return {
    from: `${y}-${mm}-01`,
    to: `${y}-${mm}-${lastDay(y, m)}`,
    label: `${MONTHS[m - 1]} ${y}`,
    month: `${y}-${mm}`,
  }
}

/** Asked after the period ended: its invoice should already have issued. */
export function lateNote(period: Period): string {
  const name = period.month ? `${MONTHS[Number(period.month.slice(5)) - 1]}'s` : "This period's"
  return `${name} invoice should have issued by ${shortDate(period.to, false)}. It issues with today's date, since invoice dates in a series never go back. Ask your accountant whether anything else is needed.`
}

// ── Lines ───────────────────────────────────────────────────────────────────

export type LineKind = "planned" | "unplanned" | "other"
export type LineReason = "our_mistake" | "client_asked" | "other_client"
export type ProofKind =
  | "task"
  | "commit"
  | "pull_request"
  | "merge_request"
  | "calendar_event"
  | "knowledge_doc"
  | "mail"
  | "ticket"
  | "note"

const PROOF_KINDS: ReadonlySet<string> = new Set([
  "task",
  "commit",
  "pull_request",
  "merge_request",
  "calendar_event",
  "knowledge_doc",
  "mail",
  "ticket",
  "note",
])
const LINE_KEYS: ReadonlySet<string> = new Set([
  "key",
  "name",
  "why",
  "taskIds",
  "reason",
  "otherProjectKey",
  "traceEstimate",
  "proofs",
])
const PROOF_KEYS: ReadonlySet<string> = new Set(["kind", "ref", "label", "url", "occurredOn"])

export interface ProposedProof {
  kind: ProofKind
  ref: string
  label?: string
  url?: string
  occurredOn?: string
}

export interface ProposedLine {
  key?: string
  name: string
  why?: string
  taskIds: string[]
  reason?: LineReason
  otherProjectKey?: string
  traceEstimate?: string
  proofs: ProposedProof[]
}

const bad = (message: string) => new ProjectsServiceError(400, "invalid_params", message)

/** A line's name, as stored: past it the name is cut, so forty lines always fit the card. */
export const LINE_NAME_MAX = 120
/** A line's why, as stored. */
export const LINE_WHY_MAX = 300

/** Text cut to `max` characters, ending with an ellipsis when it was cut. */
export function cutText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}

/**
 * A proposal's lines as the agent may send them: grouping, wording and proofs. A line that
 * carries a figure (planned, real, bill or anything else not listed) is refused whole: the
 * server works out every figure, and whether the line is in the plan, from its tasks.
 */
export function readProposedLines(raw: unknown): ProposedLine[] {
  if (!Array.isArray(raw)) throw bad("lines must be a list of lines.")
  return raw.map((value, i) => {
    if (!value || typeof value !== "object") throw bad(`line ${i + 1} is not a line.`)
    const line = value as Record<string, unknown>
    const extra = Object.keys(line).filter((k) => !LINE_KEYS.has(k))
    if (extra.length > 0) {
      throw bad(
        `line ${i + 1} carries ${extra.join(", ")}: a line takes a name, why, tasks, reason and proofs only. The server works out planned, real, bill and whether the line is in the plan from its tasks. Nothing was saved.`,
      )
    }
    if (typeof line.name !== "string" || line.name.trim() === "") {
      throw bad(`line ${i + 1} needs a name.`)
    }
    if (
      line.reason !== undefined &&
      !["our_mistake", "client_asked", "other_client"].includes(String(line.reason))
    ) {
      throw bad(`line ${i + 1}: reason is our_mistake, client_asked or other_client.`)
    }
    const taskIds = line.taskIds === undefined ? [] : line.taskIds
    if (!Array.isArray(taskIds) || taskIds.some((t) => typeof t !== "string")) {
      throw bad(`line ${i + 1}: taskIds is a list of task ids or keys.`)
    }
    const proofs = line.proofs === undefined ? [] : line.proofs
    if (!Array.isArray(proofs)) throw bad(`line ${i + 1}: proofs is a list.`)
    return {
      ...(typeof line.key === "string" ? { key: line.key } : {}),
      name: cutText(line.name.trim(), LINE_NAME_MAX),
      ...(typeof line.why === "string" && line.why.trim() !== ""
        ? { why: cutText(line.why.trim(), LINE_WHY_MAX) }
        : {}),
      taskIds: taskIds as string[],
      ...(line.reason !== undefined ? { reason: line.reason as LineReason } : {}),
      ...(typeof line.otherProjectKey === "string"
        ? { otherProjectKey: line.otherProjectKey }
        : {}),
      ...(typeof line.traceEstimate === "string" ? { traceEstimate: line.traceEstimate } : {}),
      proofs: proofs.map((p, j) => readProof(p, i, j)),
    }
  })
}

function readProof(value: unknown, i: number, j: number): ProposedProof {
  if (!value || typeof value !== "object") throw bad(`line ${i + 1}, proof ${j + 1} is not one.`)
  const p = value as Record<string, unknown>
  const extra = Object.keys(p).filter((k) => !PROOF_KEYS.has(k))
  if (extra.length > 0) {
    throw bad(`line ${i + 1}, proof ${j + 1} carries ${extra.join(", ")}: a proof is a reference.`)
  }
  if (typeof p.kind !== "string" || !PROOF_KINDS.has(p.kind)) {
    throw bad(`line ${i + 1}, proof ${j + 1}: kind is one of ${[...PROOF_KINDS].join(", ")}.`)
  }
  if (typeof p.ref !== "string" || p.ref.trim() === "") {
    throw bad(`line ${i + 1}, proof ${j + 1} needs a ref.`)
  }
  // A document's title is re-read under the asker's rows by its id; a slug or a title cannot be.
  if (p.kind === "knowledge_doc" && !UUID_REF.test(p.ref.trim())) {
    throw bad(
      `line ${i + 1}, proof ${j + 1}: a knowledge document is cited by its id. Nothing was saved.`,
    )
  }
  return {
    kind: p.kind as ProofKind,
    ref: p.ref.trim().slice(0, 500),
    ...(typeof p.label === "string" ? { label: p.label } : {}),
    ...(typeof p.url === "string" ? { url: p.url } : {}),
    ...(typeof p.occurredOn === "string" && isDate(p.occurredOn)
      ? { occurredOn: p.occurredOn }
      : {}),
  }
}

const UUID_REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const PROOF_WORD: Record<ProofKind, string> = {
  task: "Task",
  commit: "Commit",
  pull_request: "Pull request",
  merge_request: "Merge request",
  calendar_event: "Meeting",
  knowledge_doc: "Document",
  mail: "Mail",
  ticket: "Ticket",
  note: "Note",
}

/**
 * A proof label that names no member: the label, else its reference, else the proof's kind
 * ("Commit"). A billed line never carries who did the work, in its proof either.
 */
export function unnamedProofLabel(
  label: string,
  p: ProposedProof,
  members: ReadonlyArray<{ name: string | null; email: string | null }>,
): string {
  if (!namedMember(label, members)) return label
  const byRef = proofLabel({ ...p, label: p.ref })
  return namedMember(byRef, members) ? PROOF_WORD[p.kind] : byRef
}

/** The member a text names, by full name or email, or null. A client's contact is not a member. */
export function namedMember(
  text: string,
  members: ReadonlyArray<{ name: string | null; email: string | null }>,
): string | null {
  const hay = text.toLowerCase()
  for (const m of members) {
    const name = m.name?.trim()
    if (name && /\s/.test(name) && hay.includes(name.toLowerCase())) return name
    const email = m.email?.trim()
    if (email && hay.includes(email.toLowerCase())) return email
  }
  return null
}

/**
 * A proof's stored label. A meeting or a mail gets the server's own, from its date ("Meeting,
 * 8 Oct"); whatever label came with it is ignored. Others keep theirs, at most 60 characters.
 */
export function proofLabel(p: ProposedProof): string {
  if (p.kind === "calendar_event" || p.kind === "mail") {
    const word = p.kind === "mail" ? "Mail" : "Meeting"
    return p.occurredOn ? `${word}, ${shortDate(p.occurredOn, false)}` : word
  }
  const label = (p.label ?? "").replace(/\s+/g, " ").trim() || p.ref
  return label.length <= 60 ? label : `${label.slice(0, 59)}…`
}

/**
 * A proof keeps its link only when it is an https link on the host of one of the project's
 * repositories (its GitHub or GitLab); anything else stays a label with no link.
 */
export function keptProofUrl(p: ProposedProof, repoHosts: ReadonlySet<string>): string | undefined {
  if (!p.url) return undefined
  if (!["commit", "pull_request", "merge_request"].includes(p.kind)) return undefined
  try {
    const u = new URL(p.url)
    if (u.protocol !== "https:" || u.username || u.password) return undefined
    return repoHosts.has(u.hostname.toLowerCase()) ? u.toString() : undefined
  } catch {
    return undefined
  }
}

/** The hosts a project's repositories live on. */
export function repoHostsOf(repos: ReadonlyArray<{ provider: string; repo: string }>): Set<string> {
  const hosts = new Set<string>()
  for (const r of repos) {
    try {
      if (/^https:\/\//i.test(r.repo)) {
        hosts.add(new URL(r.repo).hostname.toLowerCase())
        continue
      }
    } catch {
      // not a URL: a path on the provider's own host
    }
    if (r.provider === "github") hosts.add("github.com")
    if (r.provider === "gitlab") hosts.add("gitlab.com")
  }
  return hosts
}

// ── Figures ─────────────────────────────────────────────────────────────────

export interface ComputedProof {
  kind: ProofKind
  ref: string
  label: string
  url?: string
  occurredOn?: string
}

export interface ComputedLine {
  position: number
  name: string
  why?: string
  kind: LineKind
  reason?: LineReason
  tag?: string
  taskIds: string[]
  plannedMinutes: number | null
  realMinutes: number
  traceEstimateMinutes: number | null
  billMinutes: number
  proofs: ComputedProof[]
  /** The project the line's work belongs to, when it is not this one (read under the asker). */
  otherProjectId?: string
}

/** The tasks of a set that no other task of the set contains: counting them counts each once. */
function rootsOf(ids: readonly string[], byId: ReadonlyMap<string, BudgetTask>): string[] {
  const set = new Set(ids)
  return ids.filter((id) => {
    let parent = byId.get(id)?.parentId ?? null
    const seen = new Set<string>()
    while (parent && !seen.has(parent)) {
      if (set.has(parent)) return false
      seen.add(parent)
      parent = byId.get(parent)?.parentId ?? null
    }
    return true
  })
}

/**
 * Whether a line is in the plan, from its tasks alone: it is when at least one of them carries
 * planned time in the period. The caller never says so.
 */
export function lineKindOf(planned: number | null): "planned" | "unplanned" {
  return planned !== null && planned > 0 ? "planned" : "unplanned"
}

/**
 * The default bill (deterministic): a line in the plan bills what it planned, never its
 * overage; a line not in the plan bills nothing; a retainer bills what was spent. Only when the
 * period has no plan at all does a line on a daily or hourly project bill its real time, else
 * nothing, tagged so. The person may still bill any line.
 */
export function defaultBill(
  basis: Basis,
  kind: LineKind,
  planned: number | null,
  real: number,
  periodPlanned: boolean,
): { bill: number; tag?: string } {
  if (basis === "retainer") return { bill: real }
  if (kind === "planned" && planned !== null && planned > 0) return { bill: planned }
  if (kind === "unplanned" && !periodPlanned && (basis === "hourly" || basis === "daily")) {
    return real > 0 ? { bill: real } : { bill: 0, tag: NO_PLAN_TAG }
  }
  return { bill: 0 }
}

export function computeLines(args: {
  basis: Basis
  hoursPerDayMinutes: number
  /** Every live task of the project, for planned and real under the timebox rule. */
  projectTasks: readonly BudgetTask[]
  /** Each task's own real minutes. */
  ownReal: ReadonlyMap<string, number>
  lines: ReadonlyArray<
    ProposedLine & {
      resolvedTaskIds: string[]
      proofsOut: ComputedProof[]
      otherProjectId?: string
    }
  >
  /** Tasks of the period no line lists and the proposal did not leave out as the client's own. */
  unlisted: readonly string[]
}): ComputedLine[] {
  const byId = new Map(args.projectTasks.map((t) => [t.id, t]))
  const planned = plannedByTask(args.projectTasks)
  const real = realByTask(args.projectTasks, args.ownReal)
  const figures = (ids: readonly string[]) => {
    const roots = rootsOf(ids, byId)
    const p = roots.reduce((s, id) => s + (planned.get(id) ?? 0), 0)
    const r = roots.reduce((s, id) => s + (real.get(id) ?? args.ownReal.get(id) ?? 0), 0)
    return { planned: p > 0 ? p : null, real: r }
  }
  // The period's plan: the planned time of every task on the card, each counted once.
  const periodPlanned =
    (figures([...new Set([...args.lines.flatMap((l) => l.resolvedTaskIds), ...args.unlisted])])
      .planned ?? 0) > 0
  const out: ComputedLine[] = []
  for (const line of args.lines) {
    const f = figures(line.resolvedTaskIds)
    const kind = lineKindOf(f.planned)
    let trace: number | null = null
    if (line.traceEstimate !== undefined) {
      if (f.real > 0) {
        throw new ProjectsServiceError(
          400,
          "trace_estimate_with_real",
          `"${line.name}" has real time entered, so it takes no estimate. Nothing was saved.`,
          { line: line.name, next: "Send the line again without traceEstimate." },
        )
      }
      if (line.proofsOut.length === 0) {
        throw new ProjectsServiceError(
          400,
          "trace_estimate_needs_proof",
          `"${line.name}" has an estimate but no proof. Nothing was saved.`,
          { line: line.name, next: "Cite what the estimate rests on, or drop it." },
        )
      }
      trace = parseDuration(line.traceEstimate, args.hoursPerDayMinutes)
      if (trace === null || trace <= 0) {
        throw new ProjectsServiceError(
          400,
          "invalid_trace_estimate",
          `"${line.traceEstimate}" is not a duration. Try 2 h, half a day or 2 days. Nothing was saved.`,
        )
      }
    }
    const { bill, tag } = defaultBill(args.basis, kind, f.planned, f.real, periodPlanned)
    out.push({
      position: out.length,
      name: line.name,
      ...(line.why ? { why: line.why } : {}),
      kind,
      ...(line.reason ? { reason: line.reason } : {}),
      ...(tag ? { tag } : {}),
      taskIds: line.resolvedTaskIds,
      plannedMinutes: f.planned,
      realMinutes: f.real,
      traceEstimateMinutes: trace,
      billMinutes: bill,
      proofs: line.proofsOut,
      ...(line.otherProjectId ? { otherProjectId: line.otherProjectId } : {}),
    })
  }
  // Past the card's bound, the last lines fold into "Other closed tasks" with the unlisted ones.
  let otherIds = [...args.unlisted]
  let otherProofs: ComputedProof[] = []
  const room =
    otherIds.length > 0 || out.length > RECONCILE_LINES_MAX ? RECONCILE_LINES_MAX - 1 : out.length
  if (out.length > room) {
    for (const extra of out.splice(room)) {
      otherIds = [...otherIds, ...extra.taskIds]
      otherProofs = [...otherProofs, ...extra.proofs]
    }
  }
  if (otherIds.length > 0) {
    const ids = [...new Set(otherIds)]
    const f = figures(ids)
    const { bill } = defaultBill(args.basis, "other", f.planned, f.real, periodPlanned)
    out.push({
      position: out.length,
      name: OTHER_LINE_NAME,
      kind: "other",
      taskIds: ids,
      plannedMinutes: f.planned,
      realMinutes: f.real,
      traceEstimateMinutes: null,
      billMinutes: bill,
      proofs: otherProofs,
    })
  }
  return out
}

/** A quantity in the project's unit: days on a project billed by the day, hours otherwise. */
export function worded(minutes: number, basis: Basis, hoursPerDayMinutes: number): string {
  const per = basis === "daily" ? hoursPerDayMinutes : 60
  const unit = basis === "daily" ? "d" : "h"
  return `${Math.round((minutes / per) * 100) / 100} ${unit}`
}

/** What a quantity bills at the project's rate, in minor units, or null without a rate. */
export function amountMinor(
  minutes: number,
  basis: Basis,
  rateMinor: number | null,
  hoursPerDayMinutes: number,
): number | null {
  if (rateMinor === null) return null
  if (basis === "daily") return Math.round((minutes / hoursPerDayMinutes) * rateMinor)
  if (basis === "hourly" || basis === "retainer") return Math.round((minutes / 60) * rateMinor)
  return null
}
