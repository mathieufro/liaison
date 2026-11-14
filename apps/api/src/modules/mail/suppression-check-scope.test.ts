// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The opt-out check reads the opt-out list and nothing of any conversation, so it requires the
// scope of the list (`mail:suppressions:read`), and that is the scope its call marks the turn
// with. Nobody who could run it before loses it: every shipped role or tier that reads
// conversations also reads the opt-out list.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import mailManifest from "~/apps/mail/app.manifest.json"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { baselineMemberScopes, flattenRoleScopes } from "~/modules/apps/runtime"
import { DEFAULT_ROLES } from "~/modules/permissions/default-roles"
import { hasScope } from "~/modules/permissions/permissions"

const CONVERSATIONS_READ = "mail:conversations:read"
const SUPPRESSIONS_READ = "mail:suppressions:read"

type ManifestRoles = Record<string, { extends?: string; scopes: string[] }>

const API_APPS_DIR = join(import.meta.dir, "..", "..", "apps")
const BUNDLED_DIR = join(import.meta.dir, "..", "..", "..", "..", "..", "bundled-apps")

/** Every shipped app's declared roles, in-tree and bundled, by app name. */
function shippedRoles(): Array<{ app: string; roles: ManifestRoles }> {
  const out: Array<{ app: string; roles: ManifestRoles }> = []
  for (const dir of [API_APPS_DIR, BUNDLED_DIR]) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      let raw: string
      try {
        raw = readFileSync(join(dir, entry.name, "app.manifest.json"), "utf8")
      } catch {
        continue
      }
      const manifest = JSON.parse(raw) as { name?: string; roles?: ManifestRoles }
      if (manifest.roles) out.push({ app: manifest.name ?? entry.name, roles: manifest.roles })
    }
  }
  return out
}

/** A scope set that runs a conversation read but not the opt-out list. */
const losesTheCheck = (scopes: readonly string[]): boolean =>
  hasScope(CONVERSATIONS_READ, [...scopes]) && !hasScope(SUPPRESSIONS_READ, [...scopes])

describe("the opt-out check's scope", () => {
  it("requires the opt-out list's read scope and no conversation scope", () => {
    expect(mailManifest.tools.suppression_check.requiredScopes).toEqual([SUPPRESSIONS_READ])
  })

  it("marks the turn with the opt-out list's read scope", () => {
    const turn = createTurnScopeAccumulator()
    turn.record(mailManifest.tools.suppression_check)
    expect(turn.snapshot()).toEqual([SUPPRESSIONS_READ])
  })

  it("every app tier that reads conversations also reads the opt-out list", () => {
    const losing: string[] = []
    for (const { app, roles } of shippedRoles()) {
      for (const role of Object.keys(roles)) {
        if (losesTheCheck(flattenRoleScopes(roles, role))) losing.push(`${app}.${role}`)
      }
    }
    expect(losing).toEqual([])
  })

  it("every default role that reads conversations also reads the opt-out list", () => {
    const losing = DEFAULT_ROLES.filter((r) => losesTheCheck(r.scopes)).map((r) => r.name)
    expect(losing).toEqual([])
  })

  it("the Full Member role, built from every app's base tier, reads the opt-out list", () => {
    const fullMember = shippedRoles().flatMap(({ roles }) => baselineMemberScopes(roles))
    expect(hasScope(SUPPRESSIONS_READ, fullMember)).toBe(true)
    expect(losesTheCheck(fullMember)).toBe(false)
  })
})
