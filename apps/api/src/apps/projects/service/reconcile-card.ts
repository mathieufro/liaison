// SPDX-License-Identifier: FSL-1.1-ALv2
// What the `reconcile` card draws, worked out from a stored reconciliation. Pure: the kernel's
// card template (the projects manifest, `resultCard` of kind `groups`) reads these fields from
// the tool's result, so the card resolves with no app bundle and looks the same in chat, after a
// reload and on a phone. Every figure was computed by the server before it reaches here; this
// only words it. No person is named anywhere on the card.
import { TOOL_CARD_GROUPS_MAX_ROWS } from "@liaison/shared"
import { cutText, NOT_EVERYTHING_SEEN, OTHER_LINE_NAME, worded } from "./reconcile-lines"
import type { Basis } from "./time-plan"

/** A stored line, as the card reads it. */
export interface CardLine {
  id: string
  position: number
  name: string
  wording?: string | null
  why?: string
  kind: "planned" | "unplanned" | "other" | "manual"
  tag?: string
  plannedMinutes: number | null
  realMinutes: number
  realNoteMinutes?: number | null
  traceEstimateMinutes: number | null
  billMinutes: number
  proofs: Array<{ label: string; url?: string }>
  /** The line's tasks: a line of one task done for another client can be moved there. */
  taskIds?: readonly string[]
  /** The project the line's work belongs to, readable by the asker. */
  moveTo?: { projectId: string; key: string }
}

export interface CardInput {
  state: "proposed" | "drafted" | "invoiced" | "credited"
  basis: Basis
  hoursPerDayMinutes: number
  projectName: string
  periodLabel: string
  lines: readonly CardLine[]
  rateMinor: number | null
  currency: string | null
  coverage: { withEntries: number; total: number }
  notSeen: ReadonlyArray<{ source: string; why: string }>
  excludedCount: number
  late: string | null
}

/** The seven situations a card can be in, read by the card's status. */
export type CardFit = "fits" | "over" | "estimated" | "fixed" | "nothing"

const REPO_SOURCE = /\b(github|gitlab)\b/i

function unitOf(basis: Basis): "d" | "h" {
  return basis === "daily" ? "d" : "h"
}

/** A quantity in the line's unit, as the inline field shows it: 3.5 for 3.5 days. */
export function inUnit(minutes: number, basis: Basis, hpd: number): number {
  const per = basis === "daily" ? hpd : 60
  return Math.round((minutes / per) * 100) / 100
}

function moneyOf(
  minutes: number,
  basis: Basis,
  rateMinor: number | null,
  currency: string | null,
  hpd: number,
): { minor: number; currency: string } | undefined {
  if (rateMinor === null || !currency) return undefined
  if (basis === "daily") return { minor: Math.round((minutes / hpd) * rateMinor), currency }
  if (basis === "hourly" || basis === "retainer") {
    return { minor: Math.round((minutes / 60) * rateMinor), currency }
  }
  return undefined
}

/** The period's plan: the planned time of every line on the card, however they are grouped. */
function periodPlanOf(lines: readonly CardLine[]): number {
  return lines.reduce((s, l) => s + (l.plannedMinutes ?? 0), 0)
}

/** Whether the card bills more than the period's plan, whatever the grouping. */
function billedOverPlan(input: CardInput): boolean {
  const plan = periodPlanOf(input.lines)
  return plan > 0 && input.lines.reduce((s, l) => s + l.billMinutes, 0) > plan
}

function fitOf(input: CardInput): CardFit {
  if (input.lines.length === 0) return "nothing"
  if (input.basis === "fixed") return "fixed"
  if (billedOverPlan(input)) return "over"
  const { withEntries, total } = input.coverage
  if (total > 0 && withEntries * 2 < total) return "estimated"
  const over = input.lines.some(
    (l) => l.kind === "planned" && l.plannedMinutes !== null && l.realMinutes > l.plannedMinutes,
  )
  return over ? "over" : "fits"
}

/** What the rows may take of the card's byte bound; the header, totals and notes take the rest. */
export const ROWS_BYTE_BUDGET = 17_000
/** A row draws at most this many proof links: past it the line's proof is in the stored card. */
export const PROOF_LINKS_SHOWN = 3

/**
 * The proof a row draws, at most `links` chips. When some are left out the last chip says how
 * many ("+2"), so a line's title never names work its chips seem not to hold.
 */
export function shownProof<P extends { label: string; href?: string }>(
  proof: P[],
  links: number,
): Array<P | { label: string }> {
  if (proof.length <= links) return proof
  if (links < 2) return proof.slice(0, links)
  return [...proof.slice(0, links - 1), { label: `+${proof.length - (links - 1)}` }]
}

type Row = { name: string; why?: string; proof: Array<{ label: string; href?: string }> } & Record<
  string,
  unknown
>

/**
 * Keep the rows inside the card's bound, so a long month never falls back to the plain tool
 * row: fewer proof links first, then a shorter why, then a shorter name. Every line stays; only
 * its decoration goes, and the stored line keeps its whole wording.
 */
function fitGroups<G extends { label: string; rows: Row[] }>(groups: G[]): G[] {
  const size = (gs: G[]) => new TextEncoder().encode(JSON.stringify(gs)).length
  const shaped = (links: number, why: number | null, name: number | null) =>
    groups.map((g) => ({
      ...g,
      rows: g.rows.map(({ why: rowWhy, ...r }) => ({
        ...r,
        ...(name !== null ? { name: cutText(r.name, name) } : {}),
        proof: shownProof(r.proof, links),
        ...(rowWhy !== undefined && why !== 0
          ? { why: why === null ? rowWhy : cutText(rowWhy, why) }
          : {}),
      })),
    }))
  const steps = [
    [PROOF_LINKS_SHOWN, null, null],
    [1, null, null],
    [1, 60, null],
    [0, 60, null],
    [0, 30, null],
    [0, 30, 80],
    [0, 0, 40],
  ] as const
  for (const [links, why, name] of steps) {
    const out = shaped(links, why, name)
    if (size(out) <= ROWS_BYTE_BUDGET) return out
  }
  // The last step: forty rows of a 40-character name, with no proof and no why, always fit.
  return shaped(0, 0, 40)
}

/** The fields the `reconcile` card template reads, beside the tool's own result. */
export function reconcileCardFields(input: CardInput) {
  const { basis, hoursPerDayMinutes: hpd } = input
  const q = (m: number) => worded(m, basis, hpd)
  const fit = fitOf(input)
  const fixed = basis === "fixed"
  const editable = input.state === "proposed" && !fixed && fit !== "nothing"
  const row = (l: CardLine) => {
    const realShown =
      l.realNoteMinutes !== null && l.realNoteMinutes !== undefined
        ? q(l.realNoteMinutes)
        : l.realMinutes > 0
          ? q(l.realMinutes)
          : l.traceEstimateMinutes !== null
            ? `~${q(l.traceEstimateMinutes)}`
            : undefined
    const amount = fixed
      ? undefined
      : moneyOf(l.billMinutes, basis, input.rateMinor, input.currency, hpd)
    return {
      id: l.id,
      name: l.wording?.trim() ? l.wording : l.name,
      ...(l.tag ? { tag: l.tag } : {}),
      ...(l.why ? { why: l.why } : {}),
      proof: l.proofs.map((p) => ({ label: p.label, ...(p.url ? { href: p.url } : {}) })),
      ...(l.plannedMinutes !== null ? { planned: q(l.plannedMinutes) } : {}),
      ...(realShown !== undefined ? { real: realShown } : {}),
      ...(fixed ? {} : { bill: q(l.billMinutes) }),
      ...(amount ? { amount } : {}),
      unit: unitOf(basis),
      // One task done for another client: the row offers to move it there (projects:move).
      ...(input.state === "proposed" && l.moveTo && l.taskIds?.length === 1
        ? {
            moveTaskId: l.taskIds[0],
            moveProjectId: l.moveTo.projectId,
            moveLabel: `Move it to ${l.moveTo.key}`,
          }
        : {}),
      ...(editable
        ? {
            billValue: inUnit(l.billMinutes, basis, hpd),
            realValue: inUnit(l.realNoteMinutes ?? l.realMinutes, basis, hpd),
          }
        : {}),
    }
  }
  const planned = input.lines.filter((l) => l.kind === "planned" || l.kind === "manual")
  const rest = input.lines.filter((l) => l.kind === "unplanned" || l.kind === "other")
  const groups = fitGroups([
    ...(planned.length > 0 ? [{ label: "In the plan", rows: planned.map(row) }] : []),
    ...(rest.length > 0 ? [{ label: "Not in the plan", rows: rest.map(row) }] : []),
  ])

  const billMinutes = input.lines.reduce((s, l) => s + l.billMinutes, 0)
  const realMinutes = input.lines.reduce((s, l) => s + l.realMinutes, 0)
  const plannedMinutes = periodPlanOf(input.lines)
  const total = fixed
    ? undefined
    : moneyOf(billMinutes, basis, input.rateMinor, input.currency, hpd)
  const offBill = rest.filter((l) => l.billMinutes === 0).length

  const sub =
    fit === "nothing"
      ? `No closed task, time or trace I can read for ${input.periodLabel}, so nothing to bill.`
      : fixed
        ? `Fixed price, so this bills nothing. Planned ${q(plannedMinutes)}, time spent ${q(realMinutes)}.`
        : fit === "over" && billMinutes > plannedMinutes
          ? `Planned ${q(plannedMinutes)}. Billed ${q(billMinutes)}, more than planned. Time spent ${q(realMinutes)}.`
          : fit === "over"
            ? `Planned ${q(plannedMinutes)}. Time spent ${q(realMinutes)}, so Billed stays at what was planned: ${q(billMinutes)}.`
            : `Planned ${q(plannedMinutes)}. Time spent ${q(realMinutes)}. Billed ${q(billMinutes)}.`

  const repo = input.notSeen.find((n) => REPO_SOURCE.test(n.source))
  const notes: Array<{ text: string }> = []
  if (input.late) notes.push({ text: input.late })
  if (offBill > 0) {
    notes.push({
      text: `${offBill} line${offBill === 1 ? "" : "s"} not in the plan ${offBill === 1 ? "is" : "are"} left off the bill. Nothing is asked of you about ${offBill === 1 ? "it" : "them"}; to bill one, change its line.`,
    })
  }
  if (input.notSeen.length > 0 || fit === "nothing") notes.push({ text: NOT_EVERYTHING_SEEN })

  const foot =
    input.excludedCount > 0
      ? `Work by the client's own people is left out (${input.excludedCount} task${input.excludedCount === 1 ? "" : "s"}).`
      : undefined

  return {
    title:
      fit === "nothing"
        ? `${input.projectName}, ${input.periodLabel}: nothing to check`
        : `${input.projectName}, ${input.periodLabel}: planned vs done`,
    end: input.periodLabel,
    fit,
    sub,
    cover:
      fit === "nothing"
        ? null
        : `Time spent is entered on ${input.coverage.withEntries} of ${input.coverage.total} tasks${fit === "estimated" ? ", so it is partial. A ~ is an estimate from what was read." : "."}`,
    // Every key is present, null when it does not apply: the result's declared shape is fixed.
    notice: repo
      ? {
          title: `${repo.source} was not seen`,
          text: "So commits and pull requests are not on this card, and the proof is shorter. Planned, Time spent and Billed do not depend on it.",
        }
      : null,
    connectGithub:
      repo && /github/i.test(repo.source) && input.state === "proposed" ? "github" : null,
    fixedPrice: fixed ? true : null,
    editable: editable ? "yes" : null,
    groups,
    tot: total ? [{ k: "Excl. VAT", v: total }] : [],
    notes: notes.slice(0, 3),
    foot: foot ?? null,
  }
}

/** Rows a card draws: past the bound the card would fall back, so it never holds more. */
export const CARD_ROWS_MAX = TOOL_CARD_GROUPS_MAX_ROWS

/**
 * The card as a coding agent's terminal reads it: one line per line of work, the total, and
 * that nothing is billed from here. The draft and its issue stay in Liaison.
 */
export function reconcileCodingAgentText(args: {
  title: string
  lines: ReadonlyArray<{ name: string; planned?: string; real?: string; bill?: string }>
  billText: string
  amountText: string | null
  coverageText: string
  notSeen: ReadonlyArray<{ source: string }>
  link: string | null
}): string {
  const out = [args.title]
  for (const l of args.lines) {
    const parts = [
      l.planned ? `planned ${l.planned}` : "not in the plan",
      l.real ? `time spent ${l.real}` : null,
      l.bill !== undefined ? `billed ${l.bill}` : null,
    ].filter(Boolean)
    out.push(`- ${l.name}: ${parts.join(", ")}`)
  }
  out.push(
    `To bill: ${args.billText}${args.amountText ? ` (${args.amountText} excluding VAT)` : ""}.`,
  )
  out.push(`${args.coverageText}.`)
  if (args.notSeen.length > 0) {
    out.push(`Not seen: ${args.notSeen.map((n) => n.source).join(", ")}.`)
  }
  out.push(
    "Nothing is billed from here. The card is saved in Liaison and has no accept or invoice step yet: an invoice for its lines is drafted in Invoicing, by you.",
  )
  if (args.link) out.push(args.link)
  return out.join("\n")
}

export { OTHER_LINE_NAME }
