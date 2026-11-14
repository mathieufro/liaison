// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The seeded roles must already be what the kernel's own migrations make of
// them. Migration 0254 gave `kernel:products:read` / `:write` to every custom
// role holding the matching contacts scope; the seed lists did not follow, so a
// re-seed of a migrated demo box found five roles "changed on the server since
// the last apply" and the config pass refused (exit 3) without writing anything.
// Migration 0313 does the same for the opt-out list's scopes.
import { describe, expect, it } from "bun:test"
import type { DemoRole } from "~/seed/world/fiction"
import { QA_MEMBER_SCOPES } from "~/seed/world/qa"
import { demoScopesForRole } from "./role-scopes"

/** The scope pairs a migration backfills onto roles that hold the first one. */
const BACKFILLED_PAIRS: ReadonlyArray<readonly [have: string, add: string]> = [
  ["kernel:contacts:read", "kernel:products:read"],
  ["kernel:contacts:write", "kernel:products:write"],
  ["mail:conversations:read", "mail:suppressions:read"],
  ["mail:accounts:admin", "mail:suppressions:write"],
]

const ROLES: readonly DemoRole[] = [
  "ops_lead",
  "support",
  "fulfillment",
  "engineering",
  "finance",
  "sales",
]

function missingBackfills(scopes: readonly string[]): string[] {
  return BACKFILLED_PAIRS.filter(
    ([have, add]) => scopes.includes(have) && !scopes.includes(add),
  ).map(([, add]) => add)
}

describe("seeded role scopes match the migrated server", () => {
  for (const role of ROLES) {
    it(`${role} holds every scope a migration backfills onto it`, () => {
      expect(missingBackfills(demoScopesForRole(role))).toEqual([])
    })
  }

  it("the QA teammate role holds every scope a migration backfills onto it", () => {
    expect(missingBackfills(QA_MEMBER_SCOPES)).toEqual([])
  })
})

describe("seeded desks that own deals can work them", () => {
  // The world assigns its deals to the sales and operations desks: without the
  // deal scopes their owners read "Needs deal access" on their own deals.
  for (const role of ["sales", "ops_lead"] as const) {
    it(`${role} reads and edits deal amounts`, () => {
      const scopes = demoScopesForRole(role)
      expect(scopes).toContain("projects:deals:read")
      expect(scopes).toContain("projects:deals:write")
    })
  }
})

describe("seeded desks and the payments connector", () => {
  const writes = [
    "stripe:refunds:write",
    "stripe:subscriptions:write",
    "stripe:admin:connection",
    "stripe:customers:write",
  ]
  for (const role of ["support", "finance"] as const) {
    it(`${role} reads customers, subscriptions, invoices and payments and holds no payments write`, () => {
      const scopes = demoScopesForRole(role)
      for (const s of [
        "stripe:customers:read",
        "stripe:subscriptions:read",
        "stripe:invoices:read",
        "stripe:payments:read",
      ]) {
        expect(scopes).toContain(s)
      }
      for (const s of writes) expect(scopes).not.toContain(s)
    })
  }
  it("no desk holds a payments write scope", () => {
    for (const role of ROLES)
      for (const s of writes) expect(demoScopesForRole(role)).not.toContain(s)
  })
})

describe("a developer's desk", () => {
  it("reads the bug reports and the projects, and no invoice, order or shipment", () => {
    const scopes = demoScopesForRole("engineering")
    expect(scopes).toContain("tickets:tickets:read")
    expect(scopes).toContain("projects:tasks:write")
    const money = ["invoicing:", "shopify:", "boxtal:", "stripe:"]
    expect(scopes.filter((s) => money.some((p) => s.startsWith(p)))).toEqual([])
  })
})
