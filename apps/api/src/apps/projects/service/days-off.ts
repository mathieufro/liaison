// SPDX-License-Identifier: FSL-1.1-ALv2
// Company days off: the one table the settings list and the agent tools write, read by capacity
// at once (no job). Company rows only: one person's days are away days in the kernel record,
// set through `kernel:set_away`, and carry no label or reason. Every date form is resolved here,
// in the org's zone, never by the model, and every answer states the dates with weekdays.
import { dayLabel, expandDaysOff, resolveDayForm } from "@liaison/shared"
import { and, eq } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { daysOff } from "~/db/schema/app_projects"
import { hasScope } from "~/modules/permissions/permissions"
import { scheduleCapacityLines } from "./home-lines"
import { ProjectsServiceError } from "./statuses"
import { orgTimezone } from "./time-plan"
import { todayIn } from "./took"

type Tx = RlsClient

const LABEL_MAX = 60

export interface DaysOffInput {
  on?: string
  from?: string
  to?: string
  week?: number
  weekYear?: number
  label?: string | null
  yearly?: boolean
}

export interface DayOffView {
  id: string
  from: string
  to: string
  days: string[]
  yearly: boolean
  label: string | null
  fromCalendar: boolean
  /** "calendar" on a day read from the shared calendar (the settings list marks it); else null. */
  source: "calendar" | null
}

function said(from: string, to: string): string[] {
  const out: string[] = []
  for (const d of expandDaysOff([{ startsOn: from, endsOn: to }], from, to)) out.push(dayLabel(d))
  return out
}

function view(row: typeof daysOff.$inferSelect): DayOffView {
  return {
    id: row.id,
    from: row.startsOn,
    to: row.endsOn,
    days: said(row.startsOn, row.endsOn),
    yearly: row.recursYearly,
    // A day read from the shared calendar keeps its event title out of what is read back: that
    // title may come from someone outside the org, and this read carries no outside text.
    label: row.sourceEventId === null ? row.label : null,
    fromCalendar: row.sourceEventId !== null,
    source: row.sourceEventId !== null ? "calendar" : null,
  }
}

async function today(tx: Tx, orgId: string, now?: Date): Promise<string> {
  return todayIn(await orgTimezone(tx, orgId), now)
}

export const DAYS_OFF_SCOPE = "projects:settings:admin"

function requireSettingsAdmin(scopes: readonly string[]): void {
  if (!hasScope(DAYS_OFF_SCOPE, [...scopes])) {
    throw new ProjectsServiceError(
      403,
      "not_allowed",
      "Company days off need projects:settings:admin. Nothing was changed. One person's own days go through kernel set_away.",
    )
  }
}

export async function setDaysOff(args: {
  tx: Tx
  orgId: string
  actorId: string
  scopes: readonly string[]
  via: "settings" | "agent"
  input: DaysOffInput
  now?: Date
}): Promise<{
  id: string
  resolved: { from: string; to: string; days: string[] }
  yearly: boolean
  created: boolean
  message: string
}> {
  const { tx, orgId, input } = args
  requireSettingsAdmin(args.scopes)
  const yearly = input.yearly === true
  const form = resolveDayForm(
    {
      ...(input.on !== undefined ? { on: input.on } : {}),
      ...(input.from !== undefined ? { from: input.from } : {}),
      ...(input.to !== undefined ? { to: input.to } : {}),
      ...(input.week !== undefined ? { week: input.week } : {}),
      ...(input.weekYear !== undefined ? { weekYear: input.weekYear } : {}),
      yearly,
    },
    await today(tx, orgId, args.now),
    null,
  )
  if (!form.ok) {
    throw new ProjectsServiceError(422, form.code, `${form.message} Nothing was recorded.`)
  }
  const label = input.label?.trim() ? input.label.trim().slice(0, LABEL_MAX) : null
  if (yearly && form.days.length > 32) {
    throw new ProjectsServiceError(
      422,
      "bad_dates",
      "A yearly day off spans at most 32 days. Nothing was recorded.",
    )
  }
  const key = and(
    eq(daysOff.orgId, orgId),
    eq(daysOff.startsOn, form.from),
    eq(daysOff.endsOn, form.to),
    eq(daysOff.recursYearly, yearly),
  )
  const [existing] = await tx.select().from(daysOff).where(key).limit(1)
  let id: string
  let created = false
  if (existing) {
    id = existing.id
    if (label !== null && label !== existing.label) {
      await tx.update(daysOff).set({ label, updatedAt: new Date() }).where(eq(daysOff.id, id))
    }
  } else {
    const [row] = await tx
      .insert(daysOff)
      .values({
        orgId,
        startsOn: form.from,
        endsOn: form.to,
        recursYearly: yearly,
        label,
        createdBy: args.actorId,
        createdVia: args.via,
      })
      .returning({ id: daysOff.id })
    if (!row) throw new ProjectsServiceError(500, "write_failed", "The day off was not saved.")
    id = row.id
    created = true
  }
  // A day off this week can put someone over: the leads' line follows after the commit.
  if (created) scheduleCapacityLines(orgId)
  const span = form.from === form.to ? form.days[0] : `${form.days[0]} to ${form.days.at(-1)}`
  return {
    id,
    resolved: { from: form.from, to: form.to, days: form.days },
    yearly,
    created,
    message: `${created ? "Recorded" : "Already recorded"} as a company day off: ${span}${
      yearly ? ", every year" : ""
    }. Capacity counts it from now; no task moved and nobody was asked anything.`,
  }
}

export async function listDaysOff(args: {
  tx: Tx
  orgId: string
  from?: string
  to?: string
}): Promise<{ rows: DayOffView[] }> {
  const rows = await args.tx
    .select()
    .from(daysOff)
    .where(eq(daysOff.orgId, args.orgId))
    .orderBy(daysOff.startsOn, daysOff.endsOn)
  const from = args.from
  const to = args.to
  const kept =
    from || to
      ? rows.filter((r) =>
          r.recursYearly
            ? expandDaysOff(
                [{ startsOn: r.startsOn, endsOn: r.endsOn, yearly: true }],
                from ?? r.startsOn,
                to ?? `${Number((from ?? r.startsOn).slice(0, 4)) + 1}-12-31`,
              ).length > 0
            : (!to || r.startsOn <= to) && (!from || r.endsOn >= from),
        )
      : rows
  return { rows: kept.map(view) }
}

export async function removeDaysOff(args: {
  tx: Tx
  orgId: string
  scopes: readonly string[]
  input: { id?: string; on?: string }
}): Promise<{ removed: DayOffView[]; fromCalendar: DayOffView[]; message: string }> {
  const { tx, orgId, input } = args
  requireSettingsAdmin(args.scopes)
  if ((input.id === undefined) === (input.on === undefined)) {
    throw new ProjectsServiceError(
      422,
      "bad_dates",
      "Give the id of a day off, or on (YYYY-MM-DD) for the rows covering that day. Nothing was removed.",
    )
  }
  let rows: Array<typeof daysOff.$inferSelect>
  if (input.id !== undefined) {
    rows = await tx
      .select()
      .from(daysOff)
      .where(and(eq(daysOff.orgId, orgId), eq(daysOff.id, input.id)))
  } else {
    const on = input.on as string
    rows = (await tx.select().from(daysOff).where(eq(daysOff.orgId, orgId))).filter(
      (r) =>
        expandDaysOff([{ startsOn: r.startsOn, endsOn: r.endsOn, yearly: r.recursYearly }], on, on)
          .length > 0,
    )
  }
  const typed = rows.filter((r) => r.sourceEventId === null)
  const imported = rows.filter((r) => r.sourceEventId !== null)
  for (const r of typed) await tx.delete(daysOff).where(eq(daysOff.id, r.id))
  const parts: string[] = []
  if (typed.length > 0) {
    parts.push(`Removed ${typed.map((r) => view(r).days.join(", ")).join("; ")}.`)
  }
  if (imported.length > 0) {
    parts.push(
      "Kept the days read from the shared calendar: change them in that calendar and they follow within a day.",
    )
  }
  if (rows.length === 0) parts.push("No company day off matched. Nothing was removed.")
  return {
    removed: typed.map(view),
    fromCalendar: imported.map(view),
    message: parts.join(" "),
  }
}
