// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { KERNEL_ADMIN_SCOPES } from "~/modules/auth/admin-scopes"
import { hasScope } from "~/modules/permissions/permissions"
import {
  assertNoAdminScopesInRoleCeiling,
  CeilingPrefixScopeError,
  CeilingUnknownScopeError,
  RoleAgentAdminScopeError,
  RoleAgentInvalidScopeError,
  scopesMissingFromCeiling,
} from "./ceiling-guard"

describe("CEILING GUARD", () => {
  it("CEILING GUARD: assertNoAdminScopesInRoleCeiling throws for a role agent ceiling containing an admin scope", () => {
    expect(() =>
      assertNoAdminScopesInRoleCeiling("role", ["kernel:contacts:read", "kernel:roles:admin"]),
    ).toThrow(RoleAgentAdminScopeError)
  })

  it("CEILING GUARD: the portal administration scope is an admin scope, rejected for a role agent", () => {
    expect(() =>
      assertNoAdminScopesInRoleCeiling("role", ["kernel:contacts:read", "kernel:portal:admin"]),
    ).toThrow(RoleAgentAdminScopeError)
  })

  for (const wildcard of ["*", "kernel:*", "kernel:users:*"]) {
    it(`CEILING GUARD: role ceiling entry ${wildcard} covers an admin scope, rejected`, () => {
      expect(() =>
        assertNoAdminScopesInRoleCeiling("role", ["kernel:contacts:read", wildcard]),
      ).toThrow(RoleAgentAdminScopeError)
    })
  }

  // The database splits the joined scope list on ',', so one "entry" holding a
  // comma would become two grants, one of them an admin scope.
  for (const smuggled of ["tickets:x,kernel:users:admin", "tickets:*,kernel:*"]) {
    it(`CEILING GUARD: role ceiling entry ${smuggled} is not a single scope, rejected`, () => {
      expect(() =>
        assertNoAdminScopesInRoleCeiling("role", ["kernel:contacts:read", smuggled]),
      ).toThrow(RoleAgentInvalidScopeError)
    })
  }

  for (const malformed of [
    " kernel:users:admin",
    "KERNEL:users:admin",
    "kernel::admin",
    "kernel:*:admin",
  ]) {
    it(`CEILING GUARD: role ceiling entry ${JSON.stringify(malformed)} is not a scope, rejected`, () => {
      expect(() => assertNoAdminScopesInRoleCeiling("role", [malformed])).toThrow(
        RoleAgentInvalidScopeError,
      )
    })
  }

  it("CEILING GUARD: a non-admin wildcard and plain reads are accepted for a role agent", () => {
    expect(() =>
      assertNoAdminScopesInRoleCeiling("role", [
        "invoicing:*",
        "kernel:users:read",
        "kernel:policies:read",
      ]),
    ).not.toThrow()
  })

  for (const adminScope of KERNEL_ADMIN_SCOPES) {
    it(`CEILING GUARD: ${adminScope} needs a second factor for a person, so a role agent may not hold it`, () => {
      expect(() =>
        assertNoAdminScopesInRoleCeiling("role", ["kernel:contacts:read", adminScope]),
      ).toThrow(RoleAgentAdminScopeError)
    })
  }

  it("CEILING GUARD: an app's own admin scope is refused for a role agent too", () => {
    expect(() =>
      assertNoAdminScopesInRoleCeiling("role", ["tickets:read", "tickets:settings:admin"]),
    ).toThrow(RoleAgentAdminScopeError)
  })

  it("CEILING GUARD: a personal agent may still hold its owner's admin scopes", () => {
    expect(() =>
      assertNoAdminScopesInRoleCeiling("personal", ["kernel:org:admin", "kernel:apps:admin"]),
    ).not.toThrow()
  })

  // T26 F1: three well formed strings that named nothing shipped in a role
  // ceiling and read as generous grants. A tool the actor holds no scope for is
  // not in its catalog at all, so an inert entry is a missing capability.
  for (const inert of ["mail:reply", "mail:compose", "shopify:draft_orders:read"]) {
    it(`CEILING GUARD: role ceiling entry ${inert} names no real scope, rejected`, () => {
      expect(() => assertNoAdminScopesInRoleCeiling("role", [inert])).toThrow(
        CeilingUnknownScopeError,
      )
    })
  }

  it("CEILING GUARD: a hyphenated app scope is a scope, accepted", () => {
    // shopify ships `draft-orders`, which the old grammar refused as malformed.
    expect(() =>
      assertNoAdminScopesInRoleCeiling("role", [
        "shopify:draft-orders:read",
        "shopify:draft-orders:*",
      ]),
    ).not.toThrow()
  })

  it("CEILING GUARD: scopesMissingFromCeiling reads wildcards the way grants do", () => {
    expect(scopesMissingFromCeiling(["boxtal:shipments:read"], ["boxtal:*"])).toEqual([])
    expect(scopesMissingFromCeiling(["ads:campaigns:write"], ["boxtal:*"])).toEqual([
      "ads:campaigns:write",
    ])
  })

  // P8-FX2, SK-5. `hasScope` matches a grant with FEWER segments than the
  // requirement, so a bare family entry widens silently: no wildcard to read,
  // no admin scope to catch, and it reaches exactly the app level `:admin`
  // scopes F5 spent a commit narrowing away.
  it("CEILING GUARD: a bare family entry is refused", () => {
    expect(() => assertNoAdminScopesInRoleCeiling("role", ["tickets"])).toThrow(
      CeilingPrefixScopeError,
    )
    // And the reason it matters, stated as the test it is: that entry grants
    // the three admin scopes the support ceiling names none of.
    for (const admin of [
      "tickets:settings:admin",
      "tickets:inboxes:admin",
      "tickets:categories:admin",
    ]) {
      expect(hasScope(admin, ["tickets"])).toBe(true)
    }
  })

  it("CEILING GUARD: the leaf and the explicit family wildcard are both accepted", () => {
    expect(() => assertNoAdminScopesInRoleCeiling("role", ["tickets:tickets:read"])).not.toThrow()
    expect(() => assertNoAdminScopesInRoleCeiling("role", ["tickets:*"])).not.toThrow()
  })

  it("CEILING GUARD: a two segment prefix of a real scope is refused too", () => {
    // `tickets:tickets` reaches read, write, reply and close in one string.
    expect(() => assertNoAdminScopesInRoleCeiling("role", ["tickets:tickets"])).toThrow(
      CeilingPrefixScopeError,
    )
  })

  it("CEILING GUARD: kernel:agent:memory is a declared scope, not a prefix entry", () => {
    // Every memory tool declares exactly this string (`kernel-tools.ts`), so it
    // is the leaf the base grants, not a shortcut to the read/write pair.
    expect(() => assertNoAdminScopesInRoleCeiling("role", ["kernel:agent:memory"])).not.toThrow()
  })

  it("CEILING GUARD: the same ceiling is ACCEPTED for a personal agent", () => {
    expect(() =>
      assertNoAdminScopesInRoleCeiling("personal", ["kernel:contacts:read", "kernel:roles:admin"]),
    ).not.toThrow()
  })
})
