// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Stripe connector's registration: every table reachable by a grantable
// scope (so members are not silently served empty reads), the internal tables
// readable by any holder of an app scope, and the connection's egress limited
// to the API host.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { grantableScopesWithAppAliases } from "~/modules/apps/runtime-helpers"
import { validateSandboxFetchUrl } from "~/modules/apps/sandbox/bridge/shared"
import {
  declaredGrantableScopes,
  tablesUnreachableByGrantableScopes,
} from "~/modules/permissions/rls-generator"

const MANIFEST = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "..",
  "bundled-apps",
  "stripe",
  "app.manifest.json",
)
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"))

function allowedDomains(m: {
  network?: { allowedDomains?: string[] }
  connections?: Record<string, { allowedDomains?: string[] }>
}) {
  return [
    ...(m.network?.allowedDomains ?? []),
    ...Object.values(m.connections ?? {}).flatMap((c) => c.allowedDomains ?? []),
  ]
}

describe("stripe connector registration", () => {
  it("every app_stripe table is reachable by a grantable scope", () => {
    const grantable = grantableScopesWithAppAliases("stripe", declaredGrantableScopes(manifest))
    expect(tablesUnreachableByGrantableScopes("stripe", manifest.schema, grantable)).toEqual([])
  })

  it("the member tier alone reaches the mirror and the internal tables, and no write table", () => {
    const member: string[] = manifest.roles.member.scopes
    const withAlias = grantableScopesWithAppAliases("stripe", member)
    expect(withAlias).toContain("stripe:internal:read")
    expect(withAlias).not.toContain("stripe:internal")
    expect(
      withAlias.some(
        (s) => s.startsWith("stripe:refunds") || s.startsWith("stripe:subscriptions:write"),
      ),
    ).toBe(false)
  })

  it("the connection refuses a request to another host", () => {
    const domains = allowedDomains(manifest)
    expect(
      validateSandboxFetchUrl("https://api.stripe.com/v1/customers", domains, false, "stripe")
        .hostname,
    ).toBe("api.stripe.com")
    for (const url of [
      "https://files.stripe.com/v1/files",
      "https://dashboard.stripe.com/",
      "https://attacker.example/v1/customers",
      "https://api.stripe.com.attacker.example/v1/customers",
    ]) {
      expect(() => validateSandboxFetchUrl(url, domains, false, "stripe")).toThrow(
        /not in allowlist/,
      )
    }
  })
})
