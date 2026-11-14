// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { DEFAULT_ROLES, KERNEL_MEMBER_SCOPES } from "~/modules/permissions/default-roles"

describe("DEFAULT_ROLES", () => {
  it("declares at least admin / member / viewer as ship-with defaults", () => {
    const names = DEFAULT_ROLES.map((r) => r.name)
    expect(names).toContain("admin")
    expect(names).toContain("member")
    expect(names).toContain("viewer")
  })

  it("requires every default role to ship with a non-empty description", () => {
    for (const role of DEFAULT_ROLES) {
      expect(role.description.length).toBeGreaterThan(0)
    }
  })

  it("flags exactly one default role as the owner", () => {
    const owners = DEFAULT_ROLES.filter((r) => r.isOwner)
    expect(owners.length).toBe(1)
    expect(owners[0]?.name).toBe("admin")
  })

  it("grants the owner role full wildcard access", () => {
    const owner = DEFAULT_ROLES.find((r) => r.isOwner)
    expect(owner?.scopes).toContain("*")
  })

  it("only references kernel scopes (apps register their scopes post-bootstrap)", () => {
    for (const role of DEFAULT_ROLES) {
      for (const scope of role.scopes) {
        if (scope === "*") continue
        expect(scope.startsWith("kernel:")).toBe(true)
      }
    }
  })

  it("member gets the parent kernel:agent:memory scope (covers REST + agent-tool gate)", async () => {
    const { hasScope } = await import("~/modules/permissions/permissions")
    const member = DEFAULT_ROLES.find((r) => r.name === "member")
    expect(member).toBeDefined()
    const memberScopes = member!.scopes
    expect(hasScope("kernel:agent:memory", memberScopes)).toBe(true)
    expect(hasScope("kernel:agent:memory:read", memberScopes)).toBe(true)
    expect(hasScope("kernel:agent:memory:write", memberScopes)).toBe(true)
  })

  it("grants kernel:files:analyze to member but NOT viewer (paid spend off the read-only role)", () => {
    const member = DEFAULT_ROLES.find((r) => r.name === "member")
    const viewer = DEFAULT_ROLES.find((r) => r.name === "viewer")
    expect(member).toBeDefined()
    expect(viewer).toBeDefined()
    // Positive: the agent-capable member role holds the analyze scope.
    expect(member!.scopes).toContain("kernel:files:analyze")
    // Negative: the read-only viewer role must NOT (it would trigger paid Gemini spend).
    expect(viewer!.scopes).not.toContain("kernel:files:analyze")
  })

  it("viewer gets only the leaf :read scope (no agent-tool gate, no write)", async () => {
    const { hasScope } = await import("~/modules/permissions/permissions")
    const viewer = DEFAULT_ROLES.find((r) => r.name === "viewer")
    expect(viewer).toBeDefined()
    const viewerScopes = viewer!.scopes
    expect(hasScope("kernel:agent:memory:read", viewerScopes)).toBe(true)
    expect(hasScope("kernel:agent:memory:write", viewerScopes)).toBe(false)
    expect(hasScope("kernel:agent:memory", viewerScopes)).toBe(false)
  })

  // The kernel member tier reaches an existing org's `member` preset only through a forward
  // migration (the seed covers new orgs, extendFullMemberRole covers Full Member). Each scope is
  // listed with the migration that delivered it to existing orgs ("seed" = held since the
  // preset's first release). A scope added to KERNEL_MEMBER_SCOPES without a migration leaves
  // every older org without it, the way dashboards were (0275 -> 0284): add the migration, then
  // its line here.
  it("every kernel member-tier scope is delivered to existing orgs by a named migration", () => {
    const DELIVERED: Record<string, string> = {
      "kernel:threads:read": "seed",
      "kernel:threads:write": "seed",
      "kernel:contacts:read": "seed",
      "kernel:contacts:write": "seed",
      "kernel:companies:read": "0314_companies",
      "kernel:companies:write": "0314_companies",
      "kernel:products:read": "seed",
      "kernel:products:write": "seed",
      "kernel:approvals:read": "seed",
      "kernel:approvals:write": "seed",
      "kernel:files:read": "seed",
      "kernel:files:analyze": "seed",
      "kernel:saved_views:share": "seed",
      "kernel:data:read": "0284_kernel_member_tier_dashboards",
      "kernel:data:write": "0284_kernel_member_tier_dashboards",
      "kernel:dashboards:write": "0284_kernel_member_tier_dashboards",
      "kernel:dashboards:share": "0284_kernel_member_tier_dashboards",
      "kernel:agent:memory": "seed",
      "kernel:agents:spawn": "seed",
    }
    expect([...KERNEL_MEMBER_SCOPES].sort()).toEqual(Object.keys(DELIVERED).sort())
    for (const [scope, migration] of Object.entries(DELIVERED)) {
      if (migration === "seed") continue
      const text = readFileSync(
        new URL(`../../db/migrations/${migration}.sql`, import.meta.url),
        "utf8",
      )
      expect(text).toContain(`'${scope}'`)
    }
  })

  it("the member preset is exactly the kernel member tier", () => {
    expect(DEFAULT_ROLES.find((r) => r.name === "member")?.scopes).toEqual([
      ...KERNEL_MEMBER_SCOPES,
    ])
  })
})
