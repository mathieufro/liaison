// SPDX-License-Identifier: FSL-1.1-ALv2
//
// callerHasScope: a read tool asks whether THIS call's actor holds one of the app's own scopes,
// so its UI offers only the actions the person can take. Wildcards and parents count like
// everywhere else; a scope outside the app's namespace always answers false.
import { describe, expect, it } from "bun:test"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { createIdentityMethods } from "~/modules/apps/sandbox/bridge/identity"

const has = (callerScopes: string[] | undefined, scope: string, appName = "invoicing") =>
  (
    createIdentityMethods({
      appName,
      callerScopes,
      manifest: { name: appName },
      orgId: "org",
      userId: "u",
    } as unknown as BridgeContext) as { callerHasScope: (s: string) => boolean }
  ).callerHasScope(scope)

describe("callerHasScope", () => {
  it("answers from the caller's own grants, wildcards and parents included", () => {
    expect(has(["invoicing:received:read"], "invoicing:received:write")).toBe(false)
    expect(
      has(["invoicing:received:read", "invoicing:received:write"], "invoicing:received:write"),
    ).toBe(true)
    expect(has(["invoicing:received"], "invoicing:received:write")).toBe(true)
    expect(has(["invoicing:*"], "invoicing:received:write")).toBe(true)
    expect(has(["*"], "invoicing:received:write")).toBe(true)
    expect(has(undefined, "invoicing:received:write")).toBe(false)
  })

  it("never answers about another app's scopes", () => {
    expect(has(["*"], "kernel:admin")).toBe(false)
    expect(has(["shopify:orders:read"], "shopify:orders:read")).toBe(false)
    expect(has(["*"], "invoicingx:a:b")).toBe(false)
  })
})
