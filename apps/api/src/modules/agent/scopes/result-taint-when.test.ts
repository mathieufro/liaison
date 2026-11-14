// SPDX-License-Identifier: FSL-1.1-ALv2
// `resultTaintWhen`: a read whose result carries a part classified by a narrower read scope adds
// that scope to the turn's taint. The result walk, and the manifest rule that the scopes are read
// scopes of the declaring app.
import { describe, expect, it } from "bun:test"
import { resultHoldsField } from "~/modules/agent/scopes/scope-taint"
import { resultTaintWhenErrors } from "~/modules/apps/contract"

describe("resultHoldsField", () => {
  it("finds a named field with a value at any depth", () => {
    expect(resultHoldsField({ money: { price: 1 } }, ["money"])).toBe(true)
    expect(resultHoldsField({ lines: [{ amount: { minor: 5 } }] }, ["amount"])).toBe(true)
    expect(resultHoldsField([{ a: { b: { terms: 0 } } }], ["terms"])).toBe(true)
  })

  it("a null or absent field holds nothing", () => {
    expect(resultHoldsField({ money: null, line: "4 h of 10 h" }, ["money"])).toBe(false)
    expect(resultHoldsField({ rateMinor: null, lines: [] }, ["rateMinor", "amount"])).toBe(false)
    expect(resultHoldsField("money", ["money"])).toBe(false)
  })

  it("a result nested past the walk counts as holding one", () => {
    let deep: Record<string, unknown> = { leaf: 1 }
    for (let i = 0; i < 12; i++) deep = { next: deep }
    expect(resultHoldsField(deep, ["money"])).toBe(true)
  })
})

describe("resultTaintWhen in a manifest", () => {
  const manifest = (scopes: string[]) => ({
    name: "ledger",
    tools: { read: { readOnly: true, resultTaintWhen: { fields: ["amount"], scopes } } },
  })

  it("accepts a read scope of the app itself", () => {
    expect(resultTaintWhenErrors(manifest(["ledger:money:read"]))).toEqual([])
  })

  it("refuses another app's scope, a write scope and a malformed one", () => {
    for (const scope of ["other:money:read", "ledger:money:write", "ledger:read"]) {
      expect(resultTaintWhenErrors(manifest([scope])).length).toBe(1)
    }
  })
})
