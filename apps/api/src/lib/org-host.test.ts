// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What a host that names no org (the cell's own BASE_URL host, under host
// binding) still serves. The Workers app bridge is one of them: its isolates
// call back to the cell's own origin, and the run token is the route's only
// credential, so a 404 HOST_NOT_ORG there would fail every Workers run.
import { describe, expect, it } from "bun:test"
import { isNonOrgHostPath } from "~/lib/org-host"

describe("isNonOrgHostPath", () => {
  it("serves the Workers app bridge on a non-org host", () => {
    expect(isNonOrgHostPath("/api/app-bridge/run-1/call")).toBe(true)
    expect(isNonOrgHostPath("/api/app-bridge/")).toBe(true)
  })

  it("keeps the rest of the API off a non-org host", () => {
    expect(isNonOrgHostPath("/api/app-bridge")).toBe(false)
    expect(isNonOrgHostPath("/api/app-bridgex/run-1")).toBe(false)
    expect(isNonOrgHostPath("/api/apps/wparity/tools/create")).toBe(false)
    expect(isNonOrgHostPath("/api/auth/login")).toBe(false)
  })

  it("still serves health, diagnostics, the control API and inbound webhooks", () => {
    for (const p of [
      "/healthz",
      "/readyz",
      "/diag",
      "/diag/x",
      "/api/cloud",
      "/api/cloud/x",
      "/webhooks/x",
    ]) {
      expect(isNonOrgHostPath(p)).toBe(true)
    }
  })
})
