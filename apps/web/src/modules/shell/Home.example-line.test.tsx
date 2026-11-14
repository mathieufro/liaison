// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Home says the company is an example, once, for a demo visitor's workspace:
// in its own world's words, and nowhere else (not in an ordinary org, and not
// where the world is unknown, which is also how the reserved review org reads).
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import kernelEn from "../../../../../packages/shared/src/i18n/locales/en/kernel.json"

vi.mock("~/modules/auth/auth-store", () => ({
  onAuthCleared: () => () => {},
  hasScope: () => true,
  userFromToken: () => ({ userId: "u-1", name: "Tester" }),
}))

const apiGet = vi.fn()
const apiGetEnvelope = vi.fn()
const api = {
  get: apiGet,
  getEnvelope: apiGetEnvelope,
  post: vi.fn(async () => ({})),
  patch: vi.fn(async () => ({})),
  put: vi.fn(async () => ({})),
}
vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => api, useOptionalApi: () => api }))

let demoOrg = false
vi.mock("~/modules/shell/branding-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/shell/branding-store")>()),
  demoOrgSurfaces: () => demoOrg,
}))

import { _resetDemoWorld, _setDemoWorld } from "~/modules/demo/demo-world"
import { attentionStore } from "~/modules/shell/attention-store"
import { resetHomeCardLayout } from "~/modules/shell/home-card-layout"
import Home from "./Home"

beforeEach(() => {
  attentionStore._setForTest({ items: [], errors: [], loading: false })
  resetHomeCardLayout()
  apiGet.mockReset().mockResolvedValue([])
  apiGetEnvelope.mockReset().mockResolvedValue({ data: { items: [], errors: [] } })
  _resetDemoWorld()
  demoOrg = false
})
afterEach(() => cleanup())

describe("Home's example line", () => {
  it("shows in each world's own words for a visitor workspace and nowhere else", () => {
    demoOrg = true
    _setDemoWorld("products")
    render(() => <Home entityId="home" />)
    expect(screen.getByTestId("demo-example-line").textContent).toBe(kernelEn.demo.companyExample)
    cleanup()

    _setDemoWorld("saas")
    render(() => <Home entityId="home" />)
    expect(screen.getByTestId("demo-example-line").textContent).toBe(
      kernelEn.demo.world.saas.companyExample,
    )
    cleanup()

    // An ordinary org, even with a world left over in the page's memory.
    demoOrg = false
    render(() => <Home entityId="home" />)
    expect(screen.queryByTestId("demo-example-line")).toBeNull()
  })

  it("is absent where the world is unknown: a failed read, or the reserved review org", () => {
    demoOrg = true
    render(() => <Home entityId="home" />)
    expect(screen.queryByTestId("demo-example-line")).toBeNull()
  })
})
