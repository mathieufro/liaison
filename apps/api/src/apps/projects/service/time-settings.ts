// SPDX-License-Identifier: FSL-1.1-ALv2
// Time settings: hours in a day and the shared days-off calendar (company, settings admin), and
// one person's days per week (a count from 1 to 5, no weekday, no reason). Days per week follow
// the rule of `set_away`: the person themselves, or a holder of `kernel:users:admin` or
// `projects:capacity:write`; someone else's change gives the person a Home line naming who.
import { formatDuration, parseDuration } from "@liaison/shared"
import { and, sql as drizzleSql, eq, isNotNull } from "drizzle-orm"
import { kernelRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient } from "~/db"
import { daysOff, personCapacity, timeSettings } from "~/db/schema/app_projects"
import { schemaRef } from "~/db/schema-ref"
import { hasScope } from "~/modules/permissions/permissions"
import { mayActForOthers } from "~/modules/users/away"
import { ProjectsServiceError } from "./statuses"
import { hoursPerDayMinutes } from "./time-plan"

type Tx = RlsClient

export const SETTINGS_ADMIN_SCOPE = "projects:settings:admin"

interface Person {
  id: string
  name: string
  status: string
  user_type: string
}

async function person(tx: Tx, orgId: string, id: string): Promise<Person | undefined> {
  return extractRows<Person>(
    await tx.execute(drizzleSql`
      SELECT id::text AS id, name, status::text AS status, user_type FROM ${kernelRel("users")}
       WHERE org_id = ${orgId}::uuid AND id = ${id}::uuid LIMIT 1`),
  )[0]
}

/**
 * The calendars the caller can read and has selected, if the calendar app is there, each with
 * whether the org owns it. Only an org-owned calendar can be the company's days off: a person's
 * own calendar is theirs, whoever can read it.
 */
async function selectedCalendars(
  tx: Tx,
): Promise<Array<{ value: string; label: string; shared: boolean }>> {
  const rel = `${schemaRef("app_calendar")}.calendars`
  const present = extractRows<{ t: string | null }>(
    await tx.execute(drizzleSql`SELECT to_regclass(${rel})::text AS t`),
  )[0]?.t
  if (!present) return []
  return extractRows<{ value: string; label: string; shared: boolean }>(
    await tx.execute(drizzleSql`
      SELECT c.id::text AS value, c.name AS label,
             EXISTS (SELECT 1 FROM ${drizzleSql.raw(`${schemaRef("app_calendar")}.accounts`)} a
                      WHERE a.id = c.account_id AND a.org_id = c.org_id
                        AND a.owner_type = 'org') AS shared
        FROM ${drizzleSql.raw(rel)} c
       WHERE c.selected ORDER BY c.name`),
  )
}

/** The calendars that may be the company's days off. */
async function sharedCalendars(tx: Tx): Promise<Array<{ value: string; label: string }>> {
  return (await selectedCalendars(tx))
    .filter((c) => c.shared)
    .map(({ value, label }) => ({ value, label }))
}

function refuseOthers(): never {
  throw new ProjectsServiceError(
    403,
    "not_allowed",
    "Only the person, or someone with kernel:users:admin or projects:capacity:write, can read or set their days per week. Nothing was changed.",
  )
}

export async function getTimeSettings(args: {
  tx: Tx
  orgId: string
  userId: string
  scopes: readonly string[]
  input: { userId?: string }
}): Promise<Record<string, unknown>> {
  const { tx, orgId } = args
  if (args.input.userId) {
    const target = args.input.userId
    if (target !== args.userId && !mayActForOthers(args.scopes)) refuseOthers()
    const [row] = await tx
      .select({ d: personCapacity.daysPerWeek })
      .from(personCapacity)
      .where(and(eq(personCapacity.orgId, orgId), eq(personCapacity.userId, target)))
    return { userId: target, daysPerWeek: row?.d ?? 5 }
  }
  const [row] = await tx.select().from(timeSettings).where(eq(timeSettings.orgId, orgId))
  const hpd = await hoursPerDayMinutes(tx, orgId)
  const used = extractRows<{ n: number }>(
    await tx.execute(drizzleSql`
      SELECT count(*)::int AS n FROM ${drizzleSql.raw(schemaRef("app_projects"))}.projects
       WHERE org_id = ${orgId}::uuid AND time_budgets_on AND archived_at IS NULL`),
  )[0]?.n
  const options = await sharedCalendars(tx)
  const calendarId = row?.daysOffCalendarId ?? null
  return {
    hoursPerDay: hpd / 60,
    hoursPerDayText: formatDuration(hpd, "h"),
    daysOffCalendarId: calendarId,
    calendar: calendarId
      ? { id: calendarId, name: options.find((o) => o.value === calendarId)?.label ?? null }
      : null,
    projectsUsing: used ?? 0,
    options,
  }
}

export interface TimeSettingsSetInput {
  hoursPerDay?: number | string
  daysOffCalendarId?: string | null
  userId?: string
  daysPerWeek?: number
}

function hoursOf(value: number | string): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 60) : null
  const asNumber = Number(value)
  if (value.trim() !== "" && Number.isFinite(asNumber)) return Math.round(asNumber * 60)
  return parseDuration(value, 24 * 60)
}

export async function setTimeSettings(args: {
  tx: Tx
  orgId: string
  userId: string
  userName?: string
  scopes: readonly string[]
  input: TimeSettingsSetInput
}): Promise<Record<string, unknown>> {
  const { tx, orgId, input } = args
  const changed: string[] = []
  const isAdmin = hasScope(SETTINGS_ADMIN_SCOPE, [...args.scopes])
  const [current] = await tx.select().from(timeSettings).where(eq(timeSettings.orgId, orgId))
  const currentHpd = current?.hoursPerDayMinutes ?? (await hoursPerDayMinutes(tx, orgId))
  const nextHpd = input.hoursPerDay !== undefined ? hoursOf(input.hoursPerDay) : null
  if (input.hoursPerDay !== undefined && (nextHpd === null || nextHpd < 60 || nextHpd > 1440)) {
    throw new ProjectsServiceError(
      422,
      "hours_per_day_invalid",
      "Hours in a day must be between 1 and 24, for example 7 or 7.5. Nothing was changed.",
    )
  }
  const hpdChanges = nextHpd !== null && nextHpd !== currentHpd
  const calendarChanges =
    input.daysOffCalendarId !== undefined &&
    (input.daysOffCalendarId ?? null) !== (current?.daysOffCalendarId ?? null)
  if ((hpdChanges || calendarChanges) && !isAdmin) {
    throw new ProjectsServiceError(
      403,
      "not_allowed",
      "Hours in a day and the shared calendar need projects:settings:admin. Nothing was changed.",
    )
  }
  if (calendarChanges && input.daysOffCalendarId) {
    const choices = await selectedCalendars(tx)
    const choice = choices.find((c) => c.value === input.daysOffCalendarId)
    if (choice && !choice.shared) {
      throw new ProjectsServiceError(
        422,
        "calendar_not_found",
        `${choice.label} is a person's own calendar, so it cannot be the company's days off. Nothing was changed; pick a calendar the organization connected.`,
      )
    }
    if (!choice) {
      throw new ProjectsServiceError(
        422,
        "calendar_not_found",
        "That calendar is not one of your selected calendars. Nothing was changed; pick one you can read and have selected.",
      )
    }
  }
  if (hpdChanges || calendarChanges) {
    const values = {
      hoursPerDayMinutes: nextHpd ?? currentHpd,
      daysOffCalendarId: calendarChanges
        ? (input.daysOffCalendarId ?? null)
        : (current?.daysOffCalendarId ?? null),
      updatedBy: args.userId,
      updatedAt: new Date(),
    }
    await tx
      .insert(timeSettings)
      .values({ orgId, ...values })
      .onConflictDoUpdate({ target: timeSettings.orgId, set: values })
    if (hpdChanges) changed.push(`hours in a day are ${formatDuration(nextHpd, "h")}`)
    if (calendarChanges) {
      // The days read from the calendar left behind stay, as ordinary typed days.
      await tx
        .update(daysOff)
        .set({ sourceEventId: null, updatedAt: new Date() })
        .where(and(eq(daysOff.orgId, orgId), isNotNull(daysOff.sourceEventId)))
      changed.push(
        input.daysOffCalendarId
          ? "company days off will also be read from the chosen calendar, within a day"
          : "no shared calendar is read any more; days already read stay as typed rows",
      )
    }
  }

  let person_: Record<string, unknown> | undefined
  if (input.daysPerWeek !== undefined || input.userId !== undefined) {
    const target = input.userId ?? args.userId
    const forOther = target !== args.userId
    if (forOther && !mayActForOthers(args.scopes)) refuseOthers()
    if (input.daysPerWeek === undefined) {
      throw new ProjectsServiceError(
        422,
        "days_per_week_invalid",
        "Give daysPerWeek, a whole number from 1 to 5. Nothing was changed.",
      )
    }
    const d = input.daysPerWeek
    if (!Number.isInteger(d) || d < 1 || d > 5) {
      throw new ProjectsServiceError(
        422,
        "days_per_week_invalid",
        `Days per week is a whole number from 1 to 5; ${d} is not. Nothing was changed.`,
      )
    }
    const who = await person(tx, orgId, target)
    if (!who || who.user_type === "external") {
      throw new ProjectsServiceError(
        404,
        "person_not_found",
        "No member of this organization has that id. Nothing was changed.",
      )
    }
    if (who.status !== "active") {
      throw new ProjectsServiceError(
        422,
        "person_inactive",
        `${who.name} is no longer an active member. Nothing was changed.`,
      )
    }
    const key = and(eq(personCapacity.orgId, orgId), eq(personCapacity.userId, target))
    const [before] = await tx.select().from(personCapacity).where(key)
    const was = before?.daysPerWeek ?? 5
    if (d === 5) {
      // Five is the default: no row is kept for it.
      await tx.delete(personCapacity).where(key)
    } else {
      await tx
        .insert(personCapacity)
        .values({ orgId, userId: target, daysPerWeek: d, updatedBy: args.userId })
        .onConflictDoUpdate({
          target: [personCapacity.orgId, personCapacity.userId],
          set: { daysPerWeek: d, updatedBy: args.userId, updatedAt: new Date() },
        })
    }
    const name = forOther ? who.name : "you"
    changed.push(
      was === d
        ? `${forOther ? who.name : "You"} already work${forOther ? "s" : ""} ${d} days a week`
        : `${name} ${forOther ? "works" : "work"} ${d} days a week from now`,
    )
    if (forOther && was !== d) {
      await tx.queueEvent({
        app: "kernel",
        entity: "agent_notification",
        action: "create",
        entityId: target,
        data: {
          summary: `${args.userName ?? "A colleague"} set your days per week to ${d}${
            d === 5
              ? ""
              : ". Back to 5 days: ask your agent, or set it in your Projects time settings"
          }`,
          urgency: 40,
          targetUserIds: [target],
          link: { tabType: "settings", entityId: "apps/projects" },
          capacityNamed: { setBy: args.userId, daysPerWeek: d },
        },
        actorId: args.userId,
        actorType: "user",
        orgId,
        timestamp: new Date().toISOString(),
      })
    }
    person_ = { userId: target, daysPerWeek: d }
  }

  const out = await getTimeSettings({
    tx,
    orgId,
    userId: args.userId,
    scopes: args.scopes,
    input: {},
  })
  return {
    ...out,
    ...(person_ ? { person: person_ } : {}),
    message:
      changed.length > 0
        ? `Saved: ${changed.join("; ")}. Capacity reads it at once; no task moved and nobody was asked anything.`
        : "Nothing changed: the values were already set.",
  }
}
