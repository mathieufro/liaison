// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every governed calendar table must be reachable by a scope the app lets an
// org grant, or least-privilege calendar roles are RLS-denied on it. Before the
// fix the runtime warned "App declares governed tables no grantable scope can
// reach" for calendar at every boot: the guard only read a top-level `scopes`
// array (which bundled apps do not declare, their grantable surface is their
// roles and tool scopes), and `sync_log` gated on `calendar:sync_log`, a scope
// no role or tool carries.
import { describe, expect, it } from "bun:test"
import calendarManifest from "~/apps/calendar/app.manifest.json"
import {
  declaredGrantableScopes,
  tablesUnreachableByGrantableScopes,
} from "~/modules/permissions/rls-generator"

describe("calendar manifest governance", () => {
  it("declares event_type on events, optional, so a new instance's registration creates it", () => {
    const field = calendarManifest.schema.events.fields.eventType
    expect(field.type).toBe("string")
    expect(field.required).toBe(false)
  })

  it("counts role and tool scopes as grantable", () => {
    const grantable = declaredGrantableScopes(calendarManifest)
    expect(grantable).toContain("calendar:events:read")
    expect(grantable).toContain("calendar:events:write")
    expect(grantable).toContain("calendar:calendars:read")
    expect(grantable).toContain("calendar:accounts:read")
    expect(grantable).toContain("calendar:accounts:admin")
  })

  it("leaves no governed table unreachable", () => {
    expect(
      tablesUnreachableByGrantableScopes(
        "calendar",
        calendarManifest.schema as Record<string, { rlsScope?: unknown }>,
        declaredGrantableScopes(calendarManifest),
      ),
    ).toEqual([])
  })
})
