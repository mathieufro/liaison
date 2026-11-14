// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { calendarAppManifest } from "~/apps/calendar/manifest-descriptor"
import { sql } from "~/db"
import {
  getDeclaredEmits,
  resetAppRegistries,
  setDeclaredEmits,
} from "~/modules/apps/app-registries"
import type { AppDescriptor } from "~/modules/apps/runtime"
import { registerApps } from "~/modules/apps/runtime"
import { acquireAppSchemaJsLock, releaseAppSchemaJsLock } from "~/tests/helpers/app-schema-lock"

const TEST_ORG_ID = "00000000-0000-0000-0000-000000000301"

async function registerCalendarAppForTest() {
  resetAppRegistries()
  await sql`DELETE FROM kernel.apps WHERE org_id = ${TEST_ORG_ID} AND name = 'calendar'`
  setDeclaredEmits(
    "*",
    "kernel",
    new Set(["connected_account:create", "connected_account:disconnect"]),
  )
  await registerApps([calendarAppManifest as unknown as AppDescriptor], TEST_ORG_ID)
}

describe("calendar app registration", () => {
  beforeAll(async () => {
    await acquireAppSchemaJsLock("app_calendar")
    try {
      await sql`INSERT INTO kernel.organizations (id, name, slug)
        VALUES (${TEST_ORG_ID}, 'Calendar Reg Org', 'calendar-reg-test')
        ON CONFLICT (id) DO NOTHING`
      await sql`DELETE FROM kernel.apps WHERE name = 'calendar'`
      await registerCalendarAppForTest()
    } catch (err) {
      await releaseAppSchemaJsLock("app_calendar")
      throw err
    }
  }, 120_000)

  afterAll(async () => {
    try {
      await sql`DELETE FROM kernel.apps WHERE name = 'calendar'`
      await sql`DELETE FROM kernel.organizations WHERE id = ${TEST_ORG_ID}`
    } finally {
      await releaseAppSchemaJsLock("app_calendar")
    }
  }, 60_000)

  it("creates the app_calendar schema and accounts/calendars/events/sync_log tables", async () => {
    for (const table of ["accounts", "calendars", "events", "sync_log"]) {
      const [tableCheck] = await sql`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'app_calendar' AND table_name = ${table}
        ) AS "exists"
      `
      expect(tableCheck.exists).toBe(true)
    }
  })

  it("a fresh instance has app_calendar.events.event_type after registration", async () => {
    // The table comes from the manifest, so this column has to as well: a
    // migration alone finds no table on a new instance. Taken away first, so only
    // the registration can bring it back.
    await sql`ALTER TABLE app_calendar.events DROP COLUMN IF EXISTS event_type`
    await registerCalendarAppForTest()
    const rows = await sql`
      SELECT data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = 'app_calendar' AND table_name = 'events' AND column_name = 'event_type'`
    expect(rows.map((r: any) => [r.data_type, r.is_nullable])).toEqual([["text", "YES"]])
  })

  it("creates accounts table with ownerType/ownerId/syncStatus columns", async () => {
    const cols = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'app_calendar' AND table_name = 'accounts'
      ORDER BY ordinal_position
    `
    const colNames = cols.map((c: any) => c.column_name)
    expect(colNames).toContain("connected_account_id")
    expect(colNames).toContain("owner_type")
    expect(colNames).toContain("owner_id")
    expect(colNames).toContain("email_address")
    expect(colNames).toContain("sync_status")
  })

  it("creates calendars table with sync + watch-channel columns", async () => {
    const cols = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'app_calendar' AND table_name = 'calendars'
      ORDER BY ordinal_position
    `
    const colNames = cols.map((c: any) => c.column_name)
    for (const col of [
      "account_id",
      "google_calendar_id",
      "selected",
      "sync_token",
      "watch_channel_id",
      "watch_resource_id",
      "watch_expiration",
      "sync_pending",
    ]) {
      expect(colNames).toContain(col)
    }
  })

  it("creates events table with sync-state columns and allows googleEventId IS NULL (local-born pre-push rows)", async () => {
    const cols = await sql`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'app_calendar' AND table_name = 'events'
      ORDER BY ordinal_position
    `
    const colNames = cols.map((c: any) => c.column_name)
    for (const col of [
      "calendar_id",
      "google_event_id",
      "etag",
      "recurring_event_id",
      "original_start_time",
      "liaison_sync_version",
      "pending_push",
      "google_updated_at",
    ]) {
      expect(colNames).toContain(col)
    }
    const googleEventId = cols.find((c: any) => c.column_name === "google_event_id")
    expect(googleEventId).toBeDefined()
    expect(googleEventId?.is_nullable).toBe("YES")
  })

  it("declares a unique partial index on (calendarId, googleEventId) where googleEventId is not null", async () => {
    const indexes = await sql`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'app_calendar' AND tablename = 'events'
    `
    const partial = indexes.find(
      (i: any) => i.indexdef.includes("google_event_id") && i.indexdef.includes("UNIQUE"),
    )
    expect(partial).toBeDefined()
    expect(partial!.indexdef).toContain("google_event_id IS NOT NULL")
  })

  it("declares pendingPush partial index", async () => {
    const indexes = await sql`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'app_calendar' AND tablename = 'events'
    `
    const idx = indexes.find((i: any) => i.indexdef.includes("pending_push"))
    expect(idx).toBeDefined()
  })

  it("declares the calaccess membership dimension on accounts (self-ref) and calendars (own calaccess column, denormalized from accountId)", async () => {
    const accountsDim = (calendarAppManifest as any).schema.accounts.dimensions.calaccess
    expect(accountsDim).toBeDefined()
    expect(accountsDim.type).toBe("membership")
    const calendarsDim = (calendarAppManifest as any).schema.calendars.dimensions.calaccess
    expect(calendarsDim.type).toBe("membership")
    const calaccessField = (calendarAppManifest as any).schema.calendars.fields.calaccess
    expect(calaccessField).toBe("string")
  })

  it("declares events/sync_log calaccess as their own membership dimension column (denormalized from the owning calendar's account id at write time)", async () => {
    const eventsDim = (calendarAppManifest as any).schema.events.dimensions.calaccess
    expect(eventsDim.type).toBe("membership")
    expect((calendarAppManifest as any).schema.events.fields.calaccess).toBe("string")
    const syncLogDim = (calendarAppManifest as any).schema.sync_log.dimensions.calaccess
    expect(syncLogDim.type).toBe("membership")
    expect((calendarAppManifest as any).schema.sync_log.fields.calaccess).toBe("string")
  })

  it("declares the google-calendar oauth2 connection with the narrow calendar scopes", async () => {
    const conn = (calendarAppManifest as any).connections["google-calendar"]
    expect(conn).toBeDefined()
    expect(conn.type).toBe("oauth2")
    // Events CRUD + watch, and the calendar list: nothing wider than the code calls.
    expect(conn.scopes).toEqual([
      "openid",
      "email",
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    ])
    expect(conn.revocationUrl).toBe("https://oauth2.googleapis.com/revoke")
    expect(conn.extraParams).toEqual({ access_type: "offline", prompt: "consent" })
  })

  it("registers the shared google oauth client resolver keyed on google-calendar", async () => {
    const resolver = (calendarAppManifest as any)._oauthClientResolvers["google-calendar"]
    expect(resolver).toBeDefined()
    expect(typeof resolver).toBe("function")
  })

  it("declares the manifest jobs block with onDemand and scheduled entries", async () => {
    const jobs = (calendarAppManifest as any).jobs
    for (const onDemand of [
      "calendar-import",
      "calendar-initial-sync",
      "calendar-incremental-sync",
      "calendar-push",
    ]) {
      expect(jobs[onDemand]).toBeDefined()
      expect(jobs[onDemand].onDemand).toBe(true)
    }
    expect(jobs["calendar-watch-renewal"].schedule).toBe("0 */3 * * *")
    expect(jobs["calendar-poll-fallback"].schedule).toBe("*/30 * * * *")
  })

  it("declares the manifest webhooks block with handler + verify", async () => {
    const webhooks = (calendarAppManifest as any).webhooks
    expect(webhooks["google-push"]).toEqual({ handler: "onGooglePush", verify: "verifyGooglePush" })
  })

  it("declares member and admin roles", async () => {
    const roles = (calendarAppManifest as any).roles
    expect(roles.member.scopes).toContain("calendar:events:read")
    expect(roles.member.scopes).toContain("calendar:events:write")
    expect(roles.admin.extends).toBe("member")
  })

  it("declares the event entity for search", async () => {
    const entities = (calendarAppManifest as any).entities
    expect(entities.event.tableName).toBe("events")
    expect(entities.event.readScope).toBe("calendar:events:read")
  })

  it("update_event is offered to the agent exactly like create_event (same scope, gating, discovery)", async () => {
    const { toolRegistry } = await import("~/modules/apps/app-registries")
    const create = toolRegistry.get([TEST_ORG_ID, "calendar", "create_event"]) as any
    const update = toolRegistry.get([TEST_ORG_ID, "calendar", "update_event"]) as any
    expect(create).toBeDefined()
    expect(update).toBeDefined()
    for (const key of [
      "requiredScopes",
      "gated",
      "conditionalGate",
      "agentVisible",
      "deferLoading",
    ]) {
      expect(update[key]).toEqual(create[key])
    }
    expect(update.agentVisible).not.toBe(false)

    const { handleToolSearch } = await import("~/modules/agent/tools/tool-search")
    const { runContextStore } = await import("~/modules/agent/runtime/run-context")
    const memberScopes = (calendarAppManifest as any).roles.member.scopes as string[]
    const frame = {
      runId: crypto.randomUUID(),
      parentRunId: null,
      rootRunId: crypto.randomUUID(),
      nestingDepth: 0,
      discoveredTools: new Set<string>(),
    }
    const res = await runContextStore.run(frame as any, () =>
      handleToolSearch(
        { query: "add a Google Meet link to an existing meeting", maxResults: 5 },
        {
          orgId: TEST_ORG_ID,
          userId: "00000000-0000-0000-0000-000000000302",
          scopes: memberScopes,
        },
      ),
    )
    const match = res.matches.find((m: any) => m.name === "calendar__update_event") as any
    expect(match).toBeDefined()
    expect(match.locked).toBeFalsy()
    expect(frame.discoveredTools.has("calendar__update_event")).toBe(true)
  })

  it("the calendar tool descriptions steer the agent to real conferencing and to editing meetings itself", async () => {
    const m = calendarAppManifest as any
    const create = m.tools.create_event
    const update = m.tools.update_event
    expect(create.params.properties.conference.enum).toEqual(["google_meet", "none"])
    expect(update.params.properties.conference.enum).toEqual(["google_meet", "none"])
    expect(create.description).toContain('conference: "google_meet"')
    expect(create.description).toContain("Never write")
    expect(create.description).toContain("meetLink")
    expect(update.description).toContain('conference: "google_meet"')
    expect(update.description).toContain('conference: "none"')
    expect(update.description).toContain("search_events or list_events")
    expect(update.params.properties.scope.enum).toEqual(["occurrence", "series"])
    expect(update.params.properties.occurrenceStart.type).toBe("string")
    expect(update.description).toContain("recurring")
    expect(update.description).toContain('scope: "occurrence"')
    expect(update.description).toContain("ask the user")
    const del = m.tools.delete_event
    expect(del.params.properties.scope.enum).toEqual(["occurrence", "series"])
    expect(del.params.properties.occurrenceStart.type).toBe("string")
    expect(del.description).toContain('scope: "occurrence"')
    expect(del.description).toContain("ask the user")
    expect(del.requiredScopes).toEqual(create.requiredScopes)
    const instructions = m.agentInstructions as string
    expect(instructions).toContain('conference: "google_meet"')
    expect(instructions).toContain("Never put a conferencing product name")
    expect(instructions).toContain("update_event")
    expect(instructions).toContain("Never tell the user to do it themselves in Google Calendar")
    expect(instructions).toContain("Microsoft Teams")
    expect(instructions).toContain("RECURRING MEETINGS")
    expect(instructions).toContain("only this occurrence or the whole series")
    expect(instructions).toContain("delete_event takes the same scope")
  })

  it("registering twice is idempotent (no duplicate rows / errors)", async () => {
    await expect(registerCalendarAppForTest()).resolves.toBeUndefined()
    const [tableCheck] = await sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'app_calendar' AND table_name = 'accounts'
      ) AS "exists"
    `
    expect(tableCheck.exists).toBe(true)
  })

  it("calendar is reachable through the real initAppsForOrg startup path (apps_installed row created)", async () => {
    const { initAppsForOrg, getDefaultApps } = await import("~/modules/apps/init")

    const defaultApps = await getDefaultApps()
    expect(defaultApps.some((a: any) => a.name === "calendar")).toBe(true)

    await initAppsForOrg(TEST_ORG_ID, defaultApps)

    const [tableCheck] = await sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'app_calendar' AND table_name = 'accounts'
      ) AS "exists"
    `
    expect(tableCheck.exists).toBe(true)

    const installedRows = await sql`
      SELECT * FROM kernel.apps WHERE org_id = ${TEST_ORG_ID} AND name = 'calendar'
    `
    expect(installedRows.length).toBeGreaterThan(0)

    const kernelEmits = getDeclaredEmits("*", "kernel")
    expect(kernelEmits?.has("connected_account:create")).toBe(true)
    expect(kernelEmits?.has("connected_account:disconnect")).toBe(true)
  })
})
