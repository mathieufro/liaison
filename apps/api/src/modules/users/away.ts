// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHEN SOMEONE IS AWAY, AND WHO IS NEXT IN LINE: the one writer of kernel.away_ranges.
//
// A member has no write path on away_ranges, not on their own row either (migration 0279): every
// write goes through this module, for the `set_away` tool and the profile's Away section alike.
// A range holds dates and ids, never a reason. Going away rewrites no approval: who an item is
// for is computed at read time (modules/approvals/route-world.ts), so a range only moves where a
// pending row shows, and ending it moves it back.

import {
  type AwayRangeDays,
  decidingScopeForToolDef,
  isAwayOn,
  personLocalDate,
} from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type PrivilegedDb, type RlsClient } from "~/db"
import { privilegedFrom, withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { appsLogger as log } from "~/lib/logger"
import { readPeopleDecide } from "~/modules/approvals/route-world"
import { manifestRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { sweepSkippingMoving } from "~/modules/org/transfer-state/skip-moving"
import { hasScope } from "~/modules/permissions/permissions"

const K = drizzleSql.raw(schemaRef("kernel"))

/** Who may set or end another person's range. */
export const AWAY_OTHERS_SCOPES = ["kernel:users:admin", "projects:capacity:write"] as const

/** Days after a range's last day before its row is deleted. */
export const AWAY_RETENTION_DAYS = 90

/** How long after saving a range its author can still take it back as if it never existed. */
export const AWAY_UNDO_SECONDS = 8
/** The server's margin on the undo window: a click at 7.9 s still lands after the round trip. */
const AWAY_UNDO_GRACE_SECONDS = 30

/** The forms a range is said in, as `days_off_set` takes them. */
export interface AwayForm {
  on?: string
  from?: string
  to?: string
  week?: number
  weekYear?: number
  everyWeekday?: number[]
}

export type ResolvedAwayDates =
  | { kind: "range"; startsOn: string; endsOn: string }
  | { kind: "weekly"; startsOn: string; endsOn: string | null; weekdays: number[] }

export type AwayRefusalCode =
  | "not_allowed"
  | "bad_next_in_line"
  | "bad_dates"
  | "past_dates"
  | "person_not_found"
  | "person_inactive"

export class AwayRefusal extends Error {
  constructor(
    readonly code: AwayRefusalCode,
    message: string,
  ) {
    super(message)
    this.name = "AwayRefusal"
  }
}

// ---------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const
const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** ISO weekday of a date, Monday 1 to Sunday 7. */
export function isoWeekdayOf(date: string): number {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay()
  return day === 0 ? 7 : day
}

/** "Mon 7 Dec 2026": the form every result states a date in, so a misread date is seen at once. */
export function dayLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  return `${DAY_NAMES[isoWeekdayOf(date) - 1]} ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

function isRealDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  const d = new Date(`${date}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date
}

/** `YYYY-MM-DD` as given; `MM-DD` as its next occurrence on or after `onOrAfter`. */
function resolveDay(value: string, onOrAfter: string, field: string): string {
  if (/^\d{2}-\d{2}$/.test(value)) {
    const year = Number(onOrAfter.slice(0, 4))
    for (const y of [year, year + 1, year + 2, year + 3, year + 4]) {
      const candidate = `${y}-${value}`
      if (isRealDate(candidate) && candidate >= onOrAfter) return candidate
    }
    throw new AwayRefusal("bad_dates", `${field} "${value}" is not a date.`)
  }
  if (!isRealDate(value)) {
    throw new AwayRefusal("bad_dates", `${field} "${value}" is not a date (YYYY-MM-DD or MM-DD).`)
  }
  return value
}

/** Monday of ISO week `week` of ISO year `year`. */
function isoWeekMonday(year: number, week: number): string {
  // 4 January is always in week 1.
  const jan4 = `${year}-01-04`
  const monday1 = addDays(jan4, 1 - isoWeekdayOf(jan4))
  return addDays(monday1, (week - 1) * 7)
}

function isoWeeksIn(year: number): number {
  // A year has 53 ISO weeks when 28 December falls in week 53.
  const dec28 = `${year}-12-28`
  const monday1 = isoWeekMonday(year, 1)
  return (
    Math.floor(
      (Date.parse(`${dec28}T00:00:00Z`) - Date.parse(`${monday1}T00:00:00Z`)) / (7 * 86_400_000),
    ) + 1
  )
}

function isoYearOf(date: string): number {
  // The ISO year is the year of that week's Thursday.
  return Number(addDays(date, 4 - isoWeekdayOf(date)).slice(0, 4))
}

/**
 * The dates a form says, read on the server against the person's own today, never by the model.
 * Exactly one of `on`, `from` and `to`, `week`, `everyWeekday` (which takes an optional `from`
 * and `to`). A range whose last day is before today is refused, as is a last day before the first.
 */
export function resolveAwayDates(form: AwayForm, today: string): ResolvedAwayDates {
  const weekly = form.everyWeekday !== undefined
  const forms = [
    form.on !== undefined,
    !weekly && (form.from !== undefined || form.to !== undefined),
    form.week !== undefined,
    weekly,
  ].filter(Boolean).length
  if (forms !== 1) {
    throw new AwayRefusal(
      "bad_dates",
      "Give exactly one of: on (one day), from and to (a range), week (an ISO week number), or everyWeekday (days of every week).",
    )
  }
  if (weekly) {
    const days = [...new Set(form.everyWeekday ?? [])].sort((a, b) => a - b)
    if (days.length === 0 || days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
      throw new AwayRefusal("bad_dates", "everyWeekday takes ISO days, Monday 1 to Sunday 7.")
    }
    const startsOn = form.from !== undefined ? resolveDay(form.from, today, "from") : today
    const endsOn = form.to !== undefined ? resolveDay(form.to, startsOn, "to") : null
    if (endsOn !== null) checkOrder(startsOn, endsOn, today)
    return { kind: "weekly", startsOn, endsOn, weekdays: days }
  }
  if (form.on !== undefined) {
    const day = resolveDay(form.on, today, "on")
    checkOrder(day, day, today)
    return { kind: "range", startsOn: day, endsOn: day }
  }
  if (form.week !== undefined) {
    const week = form.week
    let year = form.weekYear ?? isoYearOf(today)
    if (!Number.isInteger(week) || week < 1 || week > 53) {
      throw new AwayRefusal("bad_dates", `week ${week} is not an ISO week number (1 to 53).`)
    }
    // Without a year: this ISO year's week if it has not ended, else next year's.
    if (
      form.weekYear === undefined &&
      addDays(isoWeekMonday(year, Math.min(week, isoWeeksIn(year))), 6) < today
    ) {
      year += 1
    }
    if (week > isoWeeksIn(year)) {
      throw new AwayRefusal("bad_dates", `${year} has no ISO week ${week}.`)
    }
    const startsOn = isoWeekMonday(year, week)
    const endsOn = addDays(startsOn, 6)
    checkOrder(startsOn, endsOn, today)
    return { kind: "range", startsOn, endsOn }
  }
  if (form.from === undefined || form.to === undefined) {
    throw new AwayRefusal("bad_dates", "A range needs both from and to (the last day, included).")
  }
  const startsOn = resolveDay(form.from, today, "from")
  const endsOn = resolveDay(form.to, startsOn, "to")
  checkOrder(startsOn, endsOn, today)
  return { kind: "range", startsOn, endsOn }
}

function checkOrder(startsOn: string, endsOn: string, today: string): void {
  if (endsOn < startsOn) {
    throw new AwayRefusal(
      "bad_dates",
      `The last day (${dayLabel(endsOn)}) is before the first (${dayLabel(startsOn)}). Nothing was recorded.`,
    )
  }
  if (endsOn < today) {
    throw new AwayRefusal(
      "past_dates",
      `${dayLabel(startsOn)} to ${dayLabel(endsOn)} is already over (today is ${dayLabel(today)}). Nothing was recorded.`,
    )
  }
}

/** The days of a range as labels, at most `max`, then how many more. */
export function rangeDayLabels(startsOn: string, endsOn: string, max = 31): string[] {
  const out: string[] = []
  let d = startsOn
  let count = 0
  while (d <= endsOn) {
    if (count < max) out.push(dayLabel(d))
    count++
    d = addDays(d, 1)
  }
  if (count > max) out.push(`and ${count - max} more days`)
  return out
}

/** The next `n` days on or after `from` that a weekly range covers. */
export function nextWeeklyDates(
  weekdays: readonly number[],
  from: string,
  endsOn: string | null,
  n = 3,
): string[] {
  const out: string[] = []
  let d = from
  for (let i = 0; i < 7 * (n + 1) && out.length < n; i++) {
    if (endsOn !== null && d > endsOn) break
    if (weekdays.includes(isoWeekdayOf(d))) out.push(dayLabel(d))
    d = addDays(d, 1)
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------------------------

interface PersonRow {
  id: string
  name: string
  status: string
  user_type: string
  timezone: string | null
}

async function readPeople(
  tx: PrivilegedDb,
  orgId: string,
  ids: string[],
): Promise<Map<string, PersonRow>> {
  const unique = [...new Set(ids)].filter((id) => /^[0-9a-fA-F-]{36}$/.test(id))
  if (unique.length === 0) return new Map()
  const rows = extractRows<PersonRow>(
    await tx.execute(drizzleSql`
      SELECT id, name, status, user_type, timezone FROM ${K}.users
      WHERE org_id = ${orgId}::uuid AND id IN (${drizzleSql.join(
        unique.map((id) => drizzleSql`${id}::uuid`),
        drizzleSql`, `,
      )})`),
  )
  return new Map(rows.map((r) => [r.id, r]))
}

async function orgTimezone(tx: PrivilegedDb, orgId: string): Promise<string | null> {
  const rows = extractRows<{ timezone: string | null }>(
    await tx.execute(drizzleSql`SELECT timezone FROM ${K}.organizations WHERE id = ${orgId}::uuid`),
  )
  return rows[0]?.timezone ?? null
}

/** The person's own today: their zone, else the org's, else UTC. */
async function todayOf(
  tx: PrivilegedDb,
  orgId: string,
  person: PersonRow,
  now: Date,
): Promise<string> {
  const orgTz = person.timezone ? null : await orgTimezone(tx, orgId)
  return personLocalDate(now, person.timezone, orgTz)
}

function checkTarget(person: PersonRow | undefined): PersonRow {
  if (!person)
    throw new AwayRefusal(
      "person_not_found",
      "No member of this organization has that id. Nothing was recorded.",
    )
  if (person.status !== "active") {
    throw new AwayRefusal(
      "person_inactive",
      `${person.name} is no longer an active member. Nothing was recorded.`,
    )
  }
  if (person.user_type === "external") {
    throw new AwayRefusal(
      "person_not_found",
      `${person.name} is an external user and has no away days here. Nothing was recorded.`,
    )
  }
  return person
}

function checkNextInLine(
  next: PersonRow | undefined,
  targetId: string,
  targetName: string,
): PersonRow {
  if (!next) {
    throw new AwayRefusal(
      "bad_next_in_line",
      "Next in line must be an active member of this organization; no member has that id. Nothing was recorded.",
    )
  }
  if (next.id === targetId) {
    throw new AwayRefusal(
      "bad_next_in_line",
      `${targetName} cannot be their own next in line. Nothing was recorded.`,
    )
  }
  if (next.status !== "active") {
    throw new AwayRefusal(
      "bad_next_in_line",
      `${next.name} is no longer an active member, so cannot be next in line. Nothing was recorded.`,
    )
  }
  if (next.user_type === "external") {
    throw new AwayRefusal(
      "bad_next_in_line",
      `${next.name} is an external user, so cannot be next in line. Nothing was recorded.`,
    )
  }
  return next
}

/** Whether `scopes` may set or end someone else's range. */
export function mayActForOthers(scopes: readonly string[]): boolean {
  return AWAY_OTHERS_SCOPES.some((s) => hasScope(s, [...scopes]))
}

/**
 * The refusal `set_away` answers before any gate: someone else's range without the scope, or a
 * next in line who cannot be one, never leaves an approval behind for a person to decide in vain.
 * Null lets the call through.
 */
export async function setAwayRefusal(
  params: { userId?: string; nextInLineId?: string },
  ctx: { orgId: string; userId: string; scopes: readonly string[] },
): Promise<{ ok: false; code: AwayRefusalCode; message: string } | null> {
  const targetId = params.userId ?? ctx.userId
  if (targetId !== ctx.userId && !mayActForOthers(ctx.scopes)) {
    return {
      ok: false,
      code: "not_allowed",
      message:
        "Only a person with kernel:users:admin or projects:capacity:write can set or end someone else's away days. Nothing was recorded; the person can say it themselves, in their chat or in their profile settings.",
    }
  }
  if (params.nextInLineId === undefined && targetId === ctx.userId) return null
  try {
    return await withPrivilegedDb(ctx.orgId, "away-refusal-check", async (tx) => {
      const people = await readPeople(tx, ctx.orgId, [targetId, params.nextInLineId ?? targetId])
      const target = checkTarget(people.get(targetId))
      if (params.nextInLineId !== undefined) {
        checkNextInLine(people.get(params.nextInLineId), target.id, target.name)
      }
      return null
    })
  } catch (err) {
    if (err instanceof AwayRefusal) return { ok: false, code: err.code, message: err.message }
    throw err
  }
}

// ---------------------------------------------------------------------------------------------
// What changes for the person while away
// ---------------------------------------------------------------------------------------------

export interface CannotDecideLine {
  label: string
  goesTo: string[]
}

/** Every deciding scope the org's tools have, with the app it belongs to. */
function decidingScopes(orgId: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const [[tOrgId, tApp], tool] of toolRegistry.entriesOf(orgId)) {
    if (tOrgId !== orgId) continue
    const def = tool as { gated?: boolean; approveScope?: string; readOnly?: boolean }
    if (def.readOnly === true && def.gated !== true) continue
    out.set(decidingScopeForToolDef(def, tApp), tApp)
  }
  return out
}

function scopeLabel(orgId: string, app: string): string {
  if (app === "kernel") return "Skills, routines and roles approvals"
  const name = (manifestRegistry.get([orgId, app]) as { displayName?: string } | undefined)
    ?.displayName
  return `${name ?? app.charAt(0).toUpperCase() + app.slice(1)} approvals`
}

/**
 * What the person can approve that their next in line cannot, by plain label, with who gets
 * those items instead: the other people who hold that deciding scope. Next in line grants
 * nothing, so this is what the person has to hear before they leave.
 */
async function cannotDecideFor(
  tx: PrivilegedDb,
  orgId: string,
  personId: string,
  nextInLineId: string | null,
): Promise<CannotDecideLine[]> {
  const scopes = decidingScopes(orgId)
  if (scopes.size === 0) return []
  const pairs = new Map<string, { userId: string; scope: string; app: string }>()
  const key = (u: string, s: string, a: string) => `${u}\u0000${s}\u0000${a}`
  const members = extractRows<{ id: string; name: string }>(
    await tx.execute(drizzleSql`
      SELECT id, name FROM ${K}.users
      WHERE org_id = ${orgId}::uuid AND status = 'active' AND user_type <> 'external'
      ORDER BY name LIMIT 500`),
  )
  for (const [scope, app] of scopes) {
    for (const m of members) pairs.set(key(m.id, scope, app), { userId: m.id, scope, app })
  }
  const holds = await readPeopleDecide(tx as never, orgId, pairs)
  const out: CannotDecideLine[] = []
  for (const [scope, app] of scopes) {
    if (!holds.has(key(personId, scope, app))) continue
    if (nextInLineId && holds.has(key(nextInLineId, scope, app))) continue
    const others = members
      .filter((m) => m.id !== personId && m.id !== nextInLineId && holds.has(key(m.id, scope, app)))
      .map((m) => m.name)
    out.push({
      label: scopeLabel(orgId, app),
      goesTo:
        others.length > 3 ? [...others.slice(0, 3), `and ${others.length - 3} others`] : others,
    })
  }
  return out.sort((a, b) => a.label.localeCompare(b.label))
}

/** The person's enabled routines whose cards only they decide: those never pass on while away. */
async function routinesStayingWith(
  tx: PrivilegedDb,
  orgId: string,
  personId: string,
): Promise<string[]> {
  const rows = extractRows<{ name: string }>(
    await tx.execute(drizzleSql`
      SELECT name FROM ${K}.routines
      WHERE org_id = ${orgId}::uuid AND owner_user_id = ${personId}::uuid
        AND enabled = true AND approver = 'owner'
      ORDER BY name`),
  )
  return rows.map((r) => r.name)
}

async function standingNextInLine(tx: PrivilegedDb, personId: string): Promise<string | null> {
  const rows = extractRows<{ next_in_line_id: string | null }>(
    await tx.execute(drizzleSql`
      SELECT next_in_line_id FROM ${K}.user_preferences WHERE user_id = ${personId}::uuid`),
  )
  return rows[0]?.next_in_line_id ?? null
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

export interface AwayRangeView {
  id: string
  from: string
  to: string | null
  everyWeekday: number[] | null
  days: string[]
  nextInLine: { id: string; name: string; active: boolean } | null
  /** The range names nobody and the person's standing default is used. */
  nextInLineIsDefault: boolean
  source: "said" | "lead" | "calendar"
  setBy: { id: string; name: string } | null
  endedEarlyOn: string | null
  runningToday: boolean
}

interface RangeRow {
  id: string
  user_id: string
  starts_on: string
  ends_on: string | null
  weekdays: number[] | null
  next_in_line_id: string | null
  status: AwayRangeDays["status"]
  ended_early_on: string | null
  source: "said" | "lead" | "calendar"
  set_by: string | null
  created_at: string
}

function rangeDays(r: RangeRow): AwayRangeDays {
  return {
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    weekdays: r.weekdays,
    status: r.status,
    endedEarlyOn: r.ended_early_on,
  }
}

/** Running: started, not over, not ended early; a weekly range also on a day it does not cover. */
function isRunning(r: RangeRow, today: string): boolean {
  if (r.status !== "active") return false
  if (r.starts_on > today) return false
  if (r.ends_on !== null && r.ends_on < today) return false
  if (r.ended_early_on !== null && r.ended_early_on <= today) return false
  return true
}

const RANGE_COLUMNS =
  drizzleSql.raw(`id, user_id, starts_on::text AS starts_on, ends_on::text AS ends_on,
  weekdays, next_in_line_id, status, ended_early_on::text AS ended_early_on, source, set_by,
  created_at::text AS created_at`)

/**
 * The person's active ranges that are not over yet, with names, for their profile and for the
 * tool's result. A range naming nobody shows the standing default.
 */
export async function listAwayRanges(
  orgId: string,
  personId: string,
  now: Date = new Date(),
): Promise<{
  today: string
  ranges: AwayRangeView[]
  standingNextInLine: { id: string; name: string; active: boolean } | null
}> {
  return withPrivilegedDb(orgId, "away-list", async (tx) => {
    const people = await readPeople(tx, orgId, [personId])
    const person = people.get(personId)
    if (!person)
      return { today: personLocalDate(now, null, null), ranges: [], standingNextInLine: null }
    const today = await todayOf(tx, orgId, person, now)
    const rows = extractRows<RangeRow>(
      await tx.execute(drizzleSql`
        SELECT ${RANGE_COLUMNS} FROM ${K}.away_ranges
        WHERE org_id = ${orgId}::uuid AND user_id = ${personId}::uuid AND status = 'active'
          AND (ends_on IS NULL OR ends_on >= ${today}::date)
          AND (ended_early_on IS NULL OR ended_early_on > ${today}::date)
        ORDER BY starts_on`),
    )
    const standingId = await standingNextInLine(tx, personId)
    const names = await readPeople(tx, orgId, [
      ...rows.flatMap((r) => [r.next_in_line_id ?? "", r.set_by ?? ""]),
      standingId ?? "",
    ])
    const who = (id: string | null) => {
      const p = id ? names.get(id) : undefined
      return p ? { id: p.id, name: p.name, active: p.status === "active" } : null
    }
    return {
      today,
      standingNextInLine: who(standingId),
      ranges: rows.map((r) => ({
        id: r.id,
        from: r.starts_on,
        to: r.ends_on,
        everyWeekday: r.weekdays,
        days:
          r.weekdays === null && r.ends_on !== null
            ? rangeDayLabels(r.starts_on, r.ends_on, 3)
            : nextWeeklyDates(
                r.weekdays ?? [],
                r.starts_on > today ? r.starts_on : today,
                r.ends_on,
              ),
        nextInLine: who(r.next_in_line_id ?? standingId),
        nextInLineIsDefault: r.next_in_line_id === null,
        source: r.source,
        setBy: r.set_by && r.set_by !== personId ? (who(r.set_by) ?? null) : null,
        endedEarlyOn: r.ended_early_on,
        runningToday: isRunning(r, today),
      })),
    }
  })
}

/**
 * Who among `userIds` is away today in their own time zone, until when and who is next in line,
 * as a colleague reads it: active ranges only, and the standing default when a range names
 * nobody (one privileged read of that one column, since only its owner reads user_preferences).
 */
export async function readAwayToday(
  orgId: string,
  userIds: readonly string[],
  now: Date = new Date(),
): Promise<Map<string, { until: string; nextInLineId: string | null }>> {
  const out = new Map<string, { until: string; nextInLineId: string | null }>()
  if (userIds.length === 0) return out
  return withPrivilegedDb(orgId, "away-read-today", async (tx) => {
    const people = await readPeople(tx, orgId, [...userIds])
    const orgTz = await orgTimezone(tx, orgId)
    const rows = extractRows<RangeRow>(
      await tx.execute(drizzleSql`
        SELECT ${RANGE_COLUMNS} FROM ${K}.away_ranges
        WHERE org_id = ${orgId}::uuid AND status = 'active' AND user_id IN (${drizzleSql.join(
          [...people.keys()].map((id) => drizzleSql`${id}::uuid`),
          drizzleSql`, `,
        )})`),
    )
    for (const [id, person] of people) {
      const mine = rows.filter((r) => r.user_id === id)
      const today = personLocalDate(now, person.timezone, orgTz)
      const covering = mine
        .filter((r) => isAwayOn(rangeDays(r), today))
        .sort((a, b) => b.starts_on.localeCompare(a.starts_on))
      if (covering.length === 0) continue
      let until = today
      for (let i = 1; i <= 400; i++) {
        const next = addDays(today, i)
        if (!mine.some((r) => isAwayOn(rangeDays(r), next))) break
        until = next
      }
      const nextInLineId = covering[0]?.next_in_line_id ?? (await standingNextInLine(tx, id))
      out.set(id, { until, nextInLineId })
    }
    return out
  })
}

// ---------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------

export interface SetAwayInput {
  orgId: string
  /** Who says it: the person themselves, or a holder of AWAY_OTHERS_SCOPES. */
  actorId: string
  actorScopes: readonly string[]
  /** Whose range. Defaults to the actor. */
  userId?: string
  form: AwayForm
  nextInLineId?: string
  end?: boolean
  now?: Date
}

export interface PersonRef {
  id: string
  name: string
}

export type SetAwayResult =
  | {
      ok: true
      action: "set"
      id: string
      for: PersonRef
      resolved:
        | { from: string; to: string; days: string[] }
        | { from: string; to: string | null; everyWeekday: string[]; next: string[] }
      nextInLine: PersonRef | null
      nextInLineIsDefault: boolean
      cannotDecide: CannotDecideLine[]
      staysWithYou: string[]
      setBy: PersonRef | null
      message: string
      next: string
    }
  | {
      ok: true
      action: "end"
      for: PersonRef
      ended: { id: string; from: string; to: string | null; everyWeekday: string[] | null }[]
      message: string
      next?: string
    }
  | {
      ok: true
      action: "default"
      for: PersonRef
      nextInLine: PersonRef
      cannotDecide: CannotDecideLine[]
      message: string
    }

function sayDates(r: {
  from: string
  to: string | null
  weekdays: readonly number[] | null
}): string {
  if (r.weekdays && r.weekdays.length > 0) {
    const days = r.weekdays.map((d) => DAY_NAMES[d - 1]).join(", ")
    return `every ${days} from ${dayLabel(r.from)}${r.to ? ` to ${dayLabel(r.to)}` : ", with no end"}`
  }
  if (r.to === null || r.to === r.from) return `on ${dayLabel(r.from)}`
  return `from ${dayLabel(r.from)} to ${dayLabel(r.to)}`
}

function nextInLineSentence(
  personName: string,
  nextInLine: PersonRef | null,
  isDefault: boolean,
  own: boolean,
): string {
  if (!nextInLine) {
    return own
      ? "Nobody is next in line, so items for you stay with the usual approvers."
      : `Nobody is next in line, so items for ${personName} stay with the usual approvers.`
  }
  return `Next in line: ${nextInLine.name}${isDefault ? " (the standing choice)" : ""}.`
}

/**
 * Sets, ends, or names the standing next in line, for the tool and the profile alike. Throws
 * {@link AwayRefusal} with a plain message naming what did not happen.
 */
export async function setAway(input: SetAwayInput): Promise<SetAwayResult> {
  const now = input.now ?? new Date()
  const targetId = input.userId ?? input.actorId
  const own = targetId === input.actorId
  if (!own && !mayActForOthers(input.actorScopes)) {
    throw new AwayRefusal(
      "not_allowed",
      "Only a person with kernel:users:admin or projects:capacity:write can set or end someone else's away days. Nothing was recorded.",
    )
  }
  const hasDates =
    input.form.on !== undefined ||
    input.form.from !== undefined ||
    input.form.to !== undefined ||
    input.form.week !== undefined ||
    input.form.everyWeekday !== undefined

  const outcome = await withPrivilegedDb(input.orgId, "away-set", async (tx) => {
    const people = await readPeople(tx, input.orgId, [
      targetId,
      input.actorId,
      input.nextInLineId ?? targetId,
    ])
    const target = checkTarget(people.get(targetId))
    const actor = people.get(input.actorId)
    const forRef = { id: target.id, name: target.name }
    const next =
      input.nextInLineId !== undefined
        ? checkNextInLine(people.get(input.nextInLineId), target.id, target.name)
        : undefined
    const today = await todayOf(tx, input.orgId, target, now)

    if (input.end === true) {
      if (hasDates || next) {
        throw new AwayRefusal(
          "bad_dates",
          "end: true takes no dates and no next in line. Nothing was changed.",
        )
      }
      const rows = extractRows<RangeRow>(
        await tx.execute(drizzleSql`
          SELECT ${RANGE_COLUMNS} FROM ${K}.away_ranges
          WHERE org_id = ${input.orgId}::uuid AND user_id = ${target.id}::uuid AND status = 'active'
          ORDER BY starts_on`),
      )
      const running = rows.filter((r) => isRunning(r, today))
      for (const r of running) {
        await tx.execute(drizzleSql`
          UPDATE ${K}.away_ranges SET ended_early_on = ${today}::date, updated_at = now()
          WHERE id = ${r.id}::uuid AND org_id = ${input.orgId}::uuid`)
      }
      const ended = running.map((r) => ({
        id: r.id,
        from: r.starts_on,
        to: r.ends_on,
        everyWeekday: r.weekdays ? r.weekdays.map((d) => DAY_NAMES[d - 1] as string) : null,
      }))
      const whose = own ? "You are" : `${target.name} is`
      return {
        ok: true as const,
        action: "end" as const,
        for: forRef,
        ended,
        message:
          ended.length === 0
            ? `Nothing was running, so nothing was ended: ${own ? "you are" : `${target.name} is`} not away today (${dayLabel(today)}). Ranges that start later were left as they are.`
            : `Ended ${ended.map((e) => sayDates({ from: e.from, to: e.to, weekdays: rows.find((r) => r.id === e.id)?.weekdays ?? null })).join("; ")}, as of today, ${dayLabel(today)}. ${whose} back today; items for ${own ? "you" : target.name} show as theirs again. No approval was moved or rewritten. Ranges that start later were left as they are.`,
        ...(ended.length === 0 ? {} : { next: "Say the dates again to set a new range." }),
        endedAny: ended.length > 0,
      }
    }

    if (!hasDates) {
      if (!next) {
        throw new AwayRefusal(
          "bad_dates",
          "Give the dates (on, from and to, week, or everyWeekday), end: true, or a nextInLineId to name the standing next in line. Nothing was changed.",
        )
      }
      await tx.execute(drizzleSql`
        INSERT INTO ${K}.user_preferences (user_id, digest_cadence, timezone, next_in_line_id)
        VALUES (${target.id}::uuid, 'daily', ${target.timezone ?? (await orgTimezone(tx, input.orgId)) ?? "UTC"}, ${next.id}::uuid)
        ON CONFLICT (user_id) DO UPDATE SET next_in_line_id = EXCLUDED.next_in_line_id, updated_at = now()`)
      const cannotDecide = await cannotDecideFor(tx, input.orgId, target.id, next.id)
      return {
        ok: true as const,
        action: "default" as const,
        for: forRef,
        nextInLine: { id: next.id, name: next.name },
        cannotDecide,
        message: `${next.name} is now ${own ? "your" : `${target.name}'s`} standing next in line, used whenever a range names nobody. No away dates were recorded and no approval was moved.${cannotDecide.length > 0 ? ` ${next.name} cannot approve: ${cannotDecide.map((c) => c.label).join(", ")}; those go to the usual approvers.` : ""}`,
      }
    }

    const dates = resolveAwayDates(input.form, today)
    const weekdays = dates.kind === "weekly" ? dates.weekdays : null
    const inserted = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO ${K}.away_ranges
          (org_id, user_id, starts_on, ends_on, weekdays, next_in_line_id, source, status, set_by)
        VALUES (${input.orgId}::uuid, ${target.id}::uuid, ${dates.startsOn}::date, ${dates.endsOn}::date,
          ${
            weekdays === null
              ? null
              : drizzleSql`ARRAY[${drizzleSql.join(
                  weekdays.map((d) => drizzleSql`${d}`),
                  drizzleSql`, `,
                )}]::smallint[]`
          },
          ${next?.id ?? null}, ${own ? "said" : "lead"}, 'active', ${input.actorId}::uuid)
        RETURNING id`),
    )
    const id = inserted[0]?.id
    if (!id) throw new Error("away range insert returned no row")

    const standingId = next ? null : await standingNextInLine(tx, target.id)
    const effective =
      next ??
      (standingId
        ? (people.get(standingId) ??
          (await readPeople(tx, input.orgId, [standingId])).get(standingId))
        : undefined)
    const effectiveRef =
      effective && effective.status === "active" ? { id: effective.id, name: effective.name } : null
    const cannotDecide = await cannotDecideFor(tx, input.orgId, target.id, effectiveRef?.id ?? null)
    const staysWithYou = await routinesStayingWith(tx, input.orgId, target.id)

    const resolved =
      dates.kind === "range"
        ? {
            from: dates.startsOn,
            to: dates.endsOn,
            days: rangeDayLabels(dates.startsOn, dates.endsOn),
          }
        : {
            from: dates.startsOn,
            to: dates.endsOn,
            everyWeekday: dates.weekdays.map((d) => DAY_NAMES[d - 1] as string),
            next: nextWeeklyDates(dates.weekdays, dates.startsOn, dates.endsOn),
          }
    const said = sayDates({ from: dates.startsOn, to: dates.endsOn, weekdays })
    const parts = [
      `Recorded: ${own ? "you are" : `${target.name} is`} away ${said}.`,
      nextInLineSentence(target.name, effectiveRef, !next && effectiveRef !== null, own),
      cannotDecide.length > 0
        ? `${effectiveRef ? `${effectiveRef.name} cannot approve` : "Nobody stands in for"} ${cannotDecide.map((c) => `${c.label} (goes to ${c.goesTo.length > 0 ? c.goesTo.join(", ") : "nobody else who can approve it"})`).join("; ")}.`
        : "",
      staysWithYou.length > 0
        ? `These routines' cards stay with ${own ? "you" : target.name} only, even while away: ${staysWithYou.join(", ")}.`
        : "",
      `No approval was moved or rewritten: items show for the next in line only while ${own ? "you are" : `${target.name} is`} away, and ${own ? "you" : target.name} can still act on them.`,
      own ? "" : `${target.name} gets a Home line saying you set it, with End early.`,
    ].filter((s) => s.length > 0)
    return {
      ok: true as const,
      action: "set" as const,
      id,
      for: forRef,
      resolved,
      nextInLine: effectiveRef,
      nextInLineIsDefault: !next && effectiveRef !== null,
      cannotDecide,
      staysWithYou,
      setBy: own ? null : actor ? { id: actor.id, name: actor.name } : null,
      message: parts.join(" "),
      next: "If a date is wrong, say so now: end: true takes it back.",
      said,
      own,
    }
  })

  if (outcome.action === "set" && !outcome.own) {
    await announceToPerson(
      input.orgId,
      input.actorId,
      outcome.setBy?.name ?? "A colleague",
      outcome.for.id,
      outcome.id,
      outcome.said,
    )
  }
  if (outcome.action === "end" && !own && outcome.endedAny) {
    log.info({ orgId: input.orgId, personId: targetId }, "away ended by a colleague")
  }
  const {
    said: _s,
    own: _o,
    endedAny: _e,
    ...rest
  } = outcome as typeof outcome & {
    said?: string
    own?: boolean
    endedAny?: boolean
  }
  return rest as SetAwayResult
}

/**
 * The Home line for the person someone else marked away: who set it and the dates, never a
 * reason, with End early on their profile. An agent notification event in their own feed.
 */
async function announceToPerson(
  orgId: string,
  actorId: string,
  actorName: string,
  personId: string,
  rangeId: string,
  said: string,
): Promise<void> {
  try {
    await withPrivilegedDb(orgId, "away-announce", async (tx) => {
      await tx.queueEvent({
        app: "kernel",
        entity: "agent_notification",
        action: "create",
        entityId: rangeId,
        data: {
          summary: `${actorName} marked you away ${said}`,
          urgency: 40,
          targetUserIds: [personId],
          link: { tabType: "settings", entityId: "profile" },
          awayNamed: { rangeId, setBy: actorId },
        },
        actorId,
        actorType: "user",
        orgId,
        timestamp: new Date().toISOString(),
      })
    })
  } catch (err) {
    // The range stands; the person still sees it on their profile.
    log.warn({ err, orgId, personId }, "could not post the away line to the person named")
  }
}

/**
 * Takes back a range its author saved moments ago, as if it never existed. Later than that, the
 * range is ended early instead, so who was away when stays true.
 */
export async function undoAway(
  orgId: string,
  actorId: string,
  rangeId: string,
): Promise<{ undone: boolean; message: string }> {
  return withPrivilegedDb(orgId, "away-undo", async (tx) => {
    const rows = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        DELETE FROM ${K}.away_ranges
        WHERE id = ${rangeId}::uuid AND org_id = ${orgId}::uuid AND set_by = ${actorId}::uuid
          AND source <> 'calendar'
          AND created_at > now() - make_interval(secs => ${AWAY_UNDO_SECONDS + AWAY_UNDO_GRACE_SECONDS})
        RETURNING id`),
    )
    return rows.length > 0
      ? { undone: true, message: "Taken back: that range was removed and nothing else changed." }
      : {
          undone: false,
          message:
            "Too late to take it back as if unsaid: use End early instead. Nothing was changed.",
        }
  })
}

/** Ends one of the person's own ranges as of their today ("End early" on the profile). */
export async function endAwayRange(
  orgId: string,
  personId: string,
  rangeId: string,
  now: Date = new Date(),
): Promise<{ ended: boolean; message: string }> {
  return withPrivilegedDb(orgId, "away-end-one", async (tx) => {
    const people = await readPeople(tx, orgId, [personId])
    const person = people.get(personId)
    if (!person) return { ended: false, message: "Nothing was changed." }
    const today = await todayOf(tx, orgId, person, now)
    const rows = extractRows<RangeRow>(
      await tx.execute(drizzleSql`
        SELECT ${RANGE_COLUMNS} FROM ${K}.away_ranges
        WHERE id = ${rangeId}::uuid AND org_id = ${orgId}::uuid AND user_id = ${personId}::uuid`),
    )
    const r = rows[0]
    if (!r) return { ended: false, message: "No such range of yours. Nothing was changed." }
    if (r.starts_on > today) {
      // Not started: ending it early means it never happens. A calendar row is set aside rather
      // than deleted, so the next sync of its event does not bring it back.
      await tx.execute(
        r.source === "calendar"
          ? drizzleSql`UPDATE ${K}.away_ranges SET status = 'declined', updated_at = now() WHERE id = ${r.id}::uuid`
          : drizzleSql`DELETE FROM ${K}.away_ranges WHERE id = ${r.id}::uuid`,
      )
      return {
        ended: true,
        message: `Removed ${sayDates({ from: r.starts_on, to: r.ends_on, weekdays: r.weekdays })}, which had not started.`,
      }
    }
    if (!isRunning(r, today))
      return { ended: false, message: "That range is already over. Nothing was changed." }
    await tx.execute(drizzleSql`
      UPDATE ${K}.away_ranges SET ended_early_on = ${today}::date, updated_at = now()
      WHERE id = ${r.id}::uuid`)
    return {
      ended: true,
      message: `Ended ${sayDates({ from: r.starts_on, to: r.ends_on, weekdays: r.weekdays })} as of today, ${dayLabel(today)}.`,
    }
  })
}

/** A person deactivated: their ranges go at once (retention), standing defaults naming them read as absent. */
export async function deleteAwayRangesOf(
  tx: PrivilegedDb,
  orgId: string,
  personId: string,
): Promise<void> {
  await tx.execute(drizzleSql`
    DELETE FROM ${K}.away_ranges WHERE org_id = ${orgId}::uuid AND user_id = ${personId}::uuid`)
}

/** The daily retention: a range goes 90 days after its last day, or after the day it was ended. */
export async function pruneAwayRanges(
  days: number = AWAY_RETENTION_DAYS,
): Promise<{ deleted: number }> {
  // An org being moved keeps its rows as they are until the move ends.
  return sweepSkippingMoving((notMoving) =>
    withSystemDb("away-ranges-prune", async (tx) => {
      const rows = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          DELETE FROM ${K}.away_ranges
          WHERE COALESCE(ended_early_on, ends_on) IS NOT NULL
            AND COALESCE(ended_early_on, ends_on) < (now() AT TIME ZONE 'UTC')::date - ${days}::int
            AND ${notMoving(drizzleSql.raw("org_id"))}
          RETURNING id`),
      )
      return { deleted: rows.length }
    }),
  )
}

/** `kernel:set_away`'s handler: the same write as the profile, answered as plain facts. */
export async function handleSetAwayTool(
  params: AwayForm & { userId?: string; nextInLineId?: string; end?: boolean },
  ctx: { orgId: string; userId: string; scopes: string[] },
): Promise<SetAwayResult | { ok: false; code: AwayRefusalCode; message: string }> {
  const { userId, nextInLineId, end, ...form } = params
  try {
    return await setAway({
      orgId: ctx.orgId,
      actorId: ctx.userId,
      actorScopes: ctx.scopes,
      ...(userId ? { userId } : {}),
      ...(nextInLineId ? { nextInLineId } : {}),
      ...(end ? { end } : {}),
      form,
    })
  } catch (err) {
    if (err instanceof AwayRefusal) return { ok: false, code: err.code, message: err.message }
    throw err
  }
}

/**
 * The colleagues the profile offers as next in line: active members, never an external user nor
 * the person, each with `awayUntil` when they are away today, so "Tom is away too" shows before
 * saving.
 */
export async function nextInLineChoices(
  orgId: string,
  personId: string,
  now: Date = new Date(),
): Promise<Array<{ id: string; name: string; awayUntil: string | null }>> {
  const members = await withPrivilegedDb(orgId, "away-choices", async (tx) =>
    extractRows<{ id: string; name: string }>(
      await tx.execute(drizzleSql`
        SELECT id, name FROM ${K}.users
        WHERE org_id = ${orgId}::uuid AND status = 'active' AND user_type <> 'external'
          AND id <> ${personId}::uuid
        ORDER BY name LIMIT 500`),
    ),
  )
  const away = await readAwayToday(
    orgId,
    members.map((m) => m.id),
    now,
  )
  return members.map((m) => ({ ...m, awayUntil: away.get(m.id)?.until ?? null }))
}

/** Clears the person's standing next in line. */
export async function clearStandingNextInLine(orgId: string, personId: string): Promise<void> {
  await withPrivilegedDb(orgId, "away-clear-default", async (tx) => {
    await tx.execute(drizzleSql`
      UPDATE ${K}.user_preferences SET next_in_line_id = NULL, updated_at = now()
      WHERE user_id = ${personId}::uuid
        AND user_id IN (SELECT id FROM ${K}.users WHERE org_id = ${orgId}::uuid)`)
  })
}

// ---------------------------------------------------------------------------------------------
// From the person's own calendar
// ---------------------------------------------------------------------------------------------

/** Days a calendar-derived range may span before it is asked about instead of counted. */
export const CALENDAR_AWAY_MAX_DAYS = 30
/** Open questions per person; the rest wait for a later sync. */
export const CALENDAR_AWAY_MAX_OPEN_QUESTIONS = 3

/** What one calendar event says about the person, decided from the event alone. */
export interface CalendarAwayEffect {
  /** `<calendar id>:<google event id>`, the row's only link to the event. */
  ref: string
  googleEventId: string
  kind: "active" | "ask" | "none" | "cancelled"
  startsOn?: string
  endsOn?: string
  /** The person organises the event: only then does a date change keep a Yes. */
  organised: boolean
}

export interface CalendarAwayPerson {
  id: string
  name: string
  timezone: string
  workHoursStart: string
  workHoursEnd: string
  workDays: number[]
}

/**
 * The person whose own calendar is read, with what "a whole working day" means for them. Runs
 * on the caller's privileged transaction (the calendar sync's), never a slot of its own.
 */
export async function readCalendarAwayPerson(
  tx: PrivilegedDb,
  orgId: string,
  personId: string,
): Promise<CalendarAwayPerson | null> {
  const person = (await readPeople(tx, orgId, [personId])).get(personId)
  if (!person || person.status !== "active" || person.user_type === "external") return null
  const prefs = extractRows<{ s: string; e: string; days: number[]; tz: string }>(
    await tx.execute(drizzleSql`
      SELECT to_char(work_hours_start, 'HH24:MI') AS s, to_char(work_hours_end, 'HH24:MI') AS e,
        work_days AS days, timezone AS tz
      FROM ${K}.user_preferences WHERE user_id = ${personId}::uuid`),
  )[0]
  const tz = person.timezone ?? (await orgTimezone(tx, orgId)) ?? prefs?.tz ?? "UTC"
  return {
    id: person.id,
    name: person.name,
    timezone: tz,
    workHoursStart: prefs?.s ?? "09:00",
    workHoursEnd: prefs?.e ?? "17:00",
    workDays: prefs?.days ?? [1, 2, 3, 4, 5],
  }
}

export interface CalendarAwayOutcome {
  activated: number
  asked: number
  moved: number
  deleted: number
  waiting: number
}

interface CalendarRangeRow extends RangeRow {
  source_event_ref: string
}

function spanDays(startsOn: string, endsOn: string): number {
  return (
    Math.round(
      (Date.parse(`${endsOn}T00:00:00Z`) - Date.parse(`${startsOn}T00:00:00Z`)) / 86_400_000,
    ) + 1
  )
}

/**
 * Applies what the person's own calendar says, one effect per event, to their calendar rows:
 * an out-of-office over whole working days is active at once, a leave-looking all-day event is
 * asked about once, a moved event moves its range with a line, a cancelled one deletes its row
 * unless it was ended early. Ended early, undone or answered No: a later sync does not re-arm
 * it, unless the event moves to start after the day it was ended. No title reaches this module.
 *
 * `seriesRefs`: for a recurring series read whole, the refs of its occurrences in the window;
 * the series' other rows that have not started are removed (all of them when it is cancelled).
 *
 * Runs on the caller's privileged transaction, Home lines included (each in a savepoint, so a
 * line that cannot be queued leaves the rows standing): one slot for the whole sync, never a
 * second taken while the first is held.
 */
export async function applyCalendarAwayEffects(
  tx: PrivilegedDb,
  orgId: string,
  personId: string,
  effects: readonly CalendarAwayEffect[],
  opts: {
    seriesRefs?: Array<{ prefix: string; keep: ReadonlySet<string>; cancelled?: boolean }>
    now?: Date
  } = {},
): Promise<CalendarAwayOutcome> {
  const now = opts.now ?? new Date()
  const out: CalendarAwayOutcome = { activated: 0, asked: 0, moved: 0, deleted: 0, waiting: 0 }
  if (effects.length === 0 && (opts.seriesRefs ?? []).length === 0) return out
  const lines: Array<{
    rangeId: string
    kind: "set" | "moved" | "asked"
    said: string
    eventRef: string
    googleEventId: string
  }> = []
  let personName = ""
  let nextName: string | null = null
  await (async () => {
    const person = (await readPeople(tx, orgId, [personId])).get(personId)
    if (!person || person.status !== "active" || person.user_type === "external") return
    personName = person.name
    const today = await todayOf(tx, orgId, person, now)
    const rows = extractRows<CalendarRangeRow>(
      await tx.execute(drizzleSql`
        SELECT ${RANGE_COLUMNS}, source_event_ref FROM ${K}.away_ranges
        WHERE org_id = ${orgId}::uuid AND user_id = ${personId}::uuid AND source = 'calendar'`),
    )
    const byRef = new Map(rows.map((r) => [r.source_event_ref, r]))
    let openQuestions = rows.filter((r) => r.status === "asked").length

    const remove = async (r: CalendarRangeRow) => {
      await tx.execute(drizzleSql`DELETE FROM ${K}.away_ranges WHERE id = ${r.id}::uuid`)
      if (r.status === "asked") openQuestions--
      byRef.delete(r.source_event_ref)
      out.deleted++
    }
    const ask = async (
      e: CalendarAwayEffect & { startsOn: string; endsOn: string },
      existing: CalendarRangeRow | undefined,
    ) => {
      if (openQuestions >= CALENDAR_AWAY_MAX_OPEN_QUESTIONS && existing?.status !== "asked") {
        out.waiting++
        return
      }
      const said = sayDates({ from: e.startsOn, to: e.endsOn, weekdays: null })
      if (existing) {
        await tx.execute(drizzleSql`
          UPDATE ${K}.away_ranges SET status = 'asked', starts_on = ${e.startsOn}::date,
            ends_on = ${e.endsOn}::date, ended_early_on = NULL, updated_at = now()
          WHERE id = ${existing.id}::uuid`)
        if (existing.status !== "asked") {
          openQuestions++
          lines.push({
            rangeId: existing.id,
            kind: "asked",
            said,
            eventRef: e.ref,
            googleEventId: e.googleEventId,
          })
          out.asked++
        }
        return
      }
      const id = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO ${K}.away_ranges (org_id, user_id, starts_on, ends_on, source, status, source_event_ref, set_by)
          VALUES (${orgId}::uuid, ${personId}::uuid, ${e.startsOn}::date, ${e.endsOn}::date, 'calendar', 'asked', ${e.ref}, ${personId}::uuid)
          RETURNING id`),
      )[0]?.id
      if (!id) return
      openQuestions++
      lines.push({
        rangeId: id,
        kind: "asked",
        said,
        eventRef: e.ref,
        googleEventId: e.googleEventId,
      })
      out.asked++
    }

    for (const e of effects) {
      const existing = byRef.get(e.ref)
      if (e.kind === "cancelled" || e.kind === "none") {
        // Ended early, the row records who was away when, and stays.
        // A declined row stays while its event lives, so a later sync does not ask again.
        if (
          existing &&
          existing.ended_early_on === null &&
          (e.kind === "cancelled" || existing.status !== "declined")
        )
          await remove(existing)
        continue
      }
      if (!e.startsOn || !e.endsOn) continue
      const dated = e as CalendarAwayEffect & { startsOn: string; endsOn: string }
      const tooLong = spanDays(dated.startsOn, dated.endsOn) > CALENDAR_AWAY_MAX_DAYS
      const same =
        existing && existing.starts_on === dated.startsOn && existing.ends_on === dated.endsOn
      if (!existing) {
        if (dated.endsOn < today) continue
        if (e.kind === "ask" || tooLong) {
          await ask(dated, undefined)
          continue
        }
        const id = extractRows<{ id: string }>(
          await tx.execute(drizzleSql`
            INSERT INTO ${K}.away_ranges (org_id, user_id, starts_on, ends_on, source, status, source_event_ref, set_by)
            VALUES (${orgId}::uuid, ${personId}::uuid, ${dated.startsOn}::date, ${dated.endsOn}::date, 'calendar', 'active', ${e.ref}, ${personId}::uuid)
            RETURNING id`),
        )[0]?.id
        if (id) {
          lines.push({
            rangeId: id,
            kind: "set",
            said: sayDates({ from: dated.startsOn, to: dated.endsOn, weekdays: null }),
            eventRef: e.ref,
            googleEventId: e.googleEventId,
          })
          out.activated++
        }
        continue
      }
      if (same) continue
      if (existing.status === "declined") continue
      if (existing.ended_early_on !== null) {
        // Ended early: only a move to after the day it was ended brings it back.
        if (dated.startsOn <= existing.ended_early_on) continue
      }
      if (existing.status === "asked") {
        await tx.execute(drizzleSql`
          UPDATE ${K}.away_ranges SET starts_on = ${dated.startsOn}::date, ends_on = ${dated.endsOn}::date,
            updated_at = now() WHERE id = ${existing.id}::uuid`)
        continue
      }
      // Active and moved. Someone else's event, or one now too long, is a new question.
      if (!e.organised || tooLong) {
        await ask(dated, existing)
        continue
      }
      await tx.execute(drizzleSql`
        UPDATE ${K}.away_ranges SET starts_on = ${dated.startsOn}::date, ends_on = ${dated.endsOn}::date,
          ended_early_on = NULL, updated_at = now() WHERE id = ${existing.id}::uuid`)
      lines.push({
        rangeId: existing.id,
        kind: existing.ended_early_on !== null ? "set" : "moved",
        said: sayDates({ from: dated.startsOn, to: dated.endsOn, weekdays: null }),
        eventRef: e.ref,
        googleEventId: e.googleEventId,
      })
      if (existing.ended_early_on !== null) out.activated++
      else out.moved++
    }

    for (const series of opts.seriesRefs ?? []) {
      for (const r of [...byRef.values()]) {
        if (!r.source_event_ref.startsWith(series.prefix) || series.keep.has(r.source_event_ref))
          continue
        if (r.ended_early_on !== null) continue
        // A rule change drops the occurrences that have not started; a cancelled series all.
        if (!series.cancelled && r.starts_on <= today) continue
        await remove(r)
      }
    }

    if (lines.length > 0) {
      const standingId = await standingNextInLine(tx, personId)
      const next = standingId
        ? (await readPeople(tx, orgId, [standingId])).get(standingId)
        : undefined
      nextName = next && next.status === "active" ? next.name : null
    }
  })()
  for (const line of lines)
    await announceCalendarLine(tx, orgId, personId, personName, nextName, line)
  return out
}

/**
 * The person's own Home line about a calendar row: dates with weekdays and who is next in
 * line. An asked line names no event: the Home feed reads the title live from the person's
 * own calendar when it shows the row, so the title is stored nowhere here.
 */
async function announceCalendarLine(
  db: PrivilegedDb,
  orgId: string,
  personId: string,
  _personName: string,
  nextName: string | null,
  line: {
    rangeId: string
    kind: "set" | "moved" | "asked"
    said: string
    eventRef: string
    googleEventId: string
  },
): Promise<void> {
  const next = nextName
    ? ` Next in line: ${nextName}.`
    : " Nobody is next in line, so items for you stay with the usual approvers."
  const summary =
    line.kind === "set"
      ? `Your calendar marks you away ${line.said}.${next}`
      : line.kind === "moved"
        ? `Your away moved: ${line.said}.${next}`
        : `Is this calendar event time off, ${line.said}? It counts for nothing until you say Yes.`
  const calendarId = line.eventRef.slice(0, line.eventRef.indexOf(":"))
  try {
    await db.transaction(async (tx) => {
      await tx.queueEvent({
        app: "kernel",
        entity: "agent_notification",
        action: "create",
        entityId: line.rangeId,
        data: {
          summary,
          urgency: line.kind === "asked" ? 30 : 40,
          targetUserIds: [personId],
          link: { tabType: "settings", entityId: "profile" },
          awayCalendar: {
            rangeId: line.rangeId,
            kind: line.kind,
            said: line.said,
            nextInLine: nextName,
            calendarId,
            googleEventId: line.googleEventId,
          },
        },
        actorId: personId,
        actorType: "system",
        orgId,
        timestamp: new Date().toISOString(),
      })
    })
  } catch (err) {
    // The row stands; the person still sees it on their profile.
    log.warn({ err, orgId, personId }, "could not post the calendar away line")
  }
}

/**
 * The person answers about one of their calendar rows: Yes counts an asked row from now on;
 * No declines it, and Undo on a row the calendar made active declines it too, so no later
 * sync asks again or re-arms it.
 */
export async function answerCalendarAway(
  orgId: string,
  personId: string,
  rangeId: string,
  yes: boolean,
): Promise<{ ok: boolean; status?: "active" | "declined"; message: string }> {
  return withPrivilegedDb(orgId, "away-calendar-answer", async (tx) => {
    const r = extractRows<CalendarRangeRow>(
      await tx.execute(drizzleSql`
        SELECT ${RANGE_COLUMNS}, source_event_ref FROM ${K}.away_ranges
        WHERE id = ${rangeId}::uuid AND org_id = ${orgId}::uuid AND user_id = ${personId}::uuid
          AND source = 'calendar'`),
    )[0]
    if (!r) return { ok: false, message: "No such calendar range of yours. Nothing was changed." }
    const said = sayDates({ from: r.starts_on, to: r.ends_on, weekdays: null })
    if (yes) {
      if (r.status !== "asked")
        return {
          ok: false,
          message: `That range is not waiting for an answer (${r.status}). Nothing was changed.`,
        }
      await tx.execute(drizzleSql`
        UPDATE ${K}.away_ranges SET status = 'active', updated_at = now() WHERE id = ${r.id}::uuid`)
      return {
        ok: true,
        status: "active",
        message: `Recorded: you are away ${said}. Undo on your profile takes it back.`,
      }
    }
    if (r.status === "declined")
      return { ok: true, status: "declined", message: "Already set aside. Nothing was changed." }
    await tx.execute(drizzleSql`
      UPDATE ${K}.away_ranges SET status = 'declined', updated_at = now() WHERE id = ${r.id}::uuid`)
    return {
      ok: true,
      status: "declined",
      message: `Not counted: ${said} is not away time, and that event will not be asked about again.`,
    }
  })
}

/**
 * Disconnecting a calendar account deletes the rows its calendars made; said rows stay. Runs on
 * the purge's own transaction when it is privileged or may elevate (privilegedFrom), so the
 * rows go with the account, in one commit, without a second privileged slot.
 */
export async function deleteCalendarAwayRanges(
  db: Pick<RlsClient, "execute">,
  orgId: string,
  calendarIds: readonly string[],
): Promise<number> {
  if (calendarIds.length === 0) return 0
  return privilegedFrom(db, orgId, "away-calendar-disconnect", async (tx) => {
    const rows = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        DELETE FROM ${K}.away_ranges
        WHERE org_id = ${orgId}::uuid AND source = 'calendar'
          AND split_part(source_event_ref, ':', 1) IN (${drizzleSql.join(
            calendarIds.map((id) => drizzleSql`${id}`),
            drizzleSql`, `,
          )})
        RETURNING id`),
    )
    return rows.length
  })
}

/** The person's open calendar questions, for their profile: dates only, never a title. */
export async function listCalendarQuestions(
  orgId: string,
  personId: string,
): Promise<Array<{ id: string; from: string; to: string | null; said: string }>> {
  return withPrivilegedDb(orgId, "away-calendar-questions", async (tx) => {
    const rows = extractRows<RangeRow>(
      await tx.execute(drizzleSql`
        SELECT ${RANGE_COLUMNS} FROM ${K}.away_ranges
        WHERE org_id = ${orgId}::uuid AND user_id = ${personId}::uuid AND source = 'calendar'
          AND status = 'asked'
        ORDER BY starts_on`),
    )
    return rows.map((r) => ({
      id: r.id,
      from: r.starts_on,
      to: r.ends_on,
      said: sayDates({ from: r.starts_on, to: r.ends_on, weekdays: null }),
    }))
  })
}
