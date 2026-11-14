// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Stripe screens read in the reader's language: every tr() string has a French entry,
// no copy bypasses tr(), and French keeps each placeholder and uses no dash punctuation.
import { afterEach, describe, expect, it } from "bun:test"
import {
  badFrenchEntries,
  copyBypassingTr,
  rawTableReads,
  trStringsWithoutFrench,
  uiFiles,
} from "../../../../packages/app-ui/test-support/ui-copy-guard"
import { tr } from "./i18n"
import { FR } from "./i18n-fr"

const UI_DIR = import.meta.dir

afterEach(() => {
  ;(globalThis as any).__liaisonHost = undefined
})

describe("Stripe UI copy is translated", () => {
  it("every tr() string has a French entry", () => {
    expect(trStringsWithoutFrench(UI_DIR, FR)).toEqual([])
  })
  it("no copy bypasses tr()", () => {
    expect(uiFiles(UI_DIR).length).toBeGreaterThan(3)
    expect(copyBypassingTr(UI_DIR, FR)).toEqual([])
    expect(rawTableReads(UI_DIR)).toEqual([])
  })
  it("French keeps every placeholder and uses no dash punctuation", () => {
    expect(badFrenchEntries(FR)).toEqual([])
  })
  it("follows the host's locale, English without one", () => {
    expect(tr("Open Stripe")).toBe("Open Stripe")
    ;(globalThis as any).__liaisonHost = { locale: () => "fr" }
    expect(tr("Open Stripe")).toBe("Ouvrir Stripe")
  })
})
