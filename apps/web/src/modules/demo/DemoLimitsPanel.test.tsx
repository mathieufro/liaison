// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The limits panel by world: it states the limits that apply to the company on
// screen, and only those. Asserted through the shared strings, not literals.
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DemoLimitsPanel } from "~/modules/demo/DemoLimitsPanel"
import { _resetDemoWorld, _setDemoWorld } from "~/modules/demo/demo-world"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import kernelEn from "../../../../../packages/shared/src/i18n/locales/en/kernel.json"
import kernelFr from "../../../../../packages/shared/src/i18n/locales/fr/kernel.json"

const open = (locale: "en" | "fr" = "en") =>
  render(() => (
    <I18nProvider initialLocale={locale}>
      <DemoLimitsPanel open onClose={() => {}} />
    </I18nProvider>
  ))

beforeEach(() => _resetDemoWorld())
afterEach(() => cleanup())

describe("the limits panel", () => {
  it("the software world names the payments stand-in and never the store", () => {
    _setDemoWorld("saas")
    open()
    const text = screen.getByTestId("demo-limits").textContent ?? ""
    expect(text).toContain(kernelEn.demo.world.saas.limitConnectors)
    expect(text).not.toContain(kernelEn.demo.limitConnectors)
    expect(text).toContain(kernelEn.demo.limitMail)
    expect(text).toContain(kernelEn.demo.limitExpiry)
  })

  it("says the same in French", () => {
    _setDemoWorld("saas")
    open("fr")
    expect(screen.getByTestId("demo-limits").textContent).toContain(
      kernelFr.demo.world.saas.limitConnectors,
    )
  })

  it("the products world is unchanged", () => {
    _setDemoWorld("products")
    open()
    const text = screen.getByTestId("demo-limits").textContent ?? ""
    expect(text).toContain(kernelEn.demo.limitConnectors)
    expect(text).not.toContain(kernelEn.demo.world.saas.limitConnectors)
  })

  it("an unknown world states the generic limits, naming no world's connectors", () => {
    open()
    const text = screen.getByTestId("demo-limits").textContent ?? ""
    expect(text).toContain(kernelEn.demo.limitMail)
    expect(text).toContain(kernelEn.demo.limitAgents)
    expect(text).not.toContain(kernelEn.demo.limitConnectors)
    expect(text).not.toContain(kernelEn.demo.world.saas.limitConnectors)
  })
})
