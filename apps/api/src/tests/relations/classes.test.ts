// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Each relation class passes on the right behaviour and fails on a seeded wrong one, so a cell
// that goes green says something about the product, not about a lenient assertion.

import { describe, expect, it } from "bun:test"
import { CLASSES, type ClassInput, ClassViolation, type Reading } from "./classes"

function input(over: Partial<ClassInput> & { facts?: ClassInput["facts"] }): ClassInput {
  return {
    before: {},
    after: {},
    whoIsTold: [],
    visibleState: [],
    copiedNameAt: [],
    facts: {},
    ...over,
  }
}

function fails(cls: keyof typeof CLASSES, i: ClassInput): void {
  expect(() => CLASSES[cls](i)).toThrow(ClassViolation)
}

function passes(cls: keyof typeof CLASSES, i: ClassInput): void {
  expect(() => CLASSES[cls](i)).not.toThrow()
}

const seen = (over: Partial<Reading[string]> = {}) => ({ visible: true, points: "a", ...over })
const none = { visible: false }

describe("relation classes against seeded wrong behaviour", () => {
  it("keep fails when the link stops pointing at its end or shows the old copied name", () => {
    const ok = input({
      before: { r: seen() },
      after: { r: seen({ label: "New" }) },
      copiedNameAt: ["r"],
      facts: { newName: "New" },
    })
    passes("K", ok)
    fails("K", { ...ok, after: { r: seen({ points: "b", label: "New" }) } })
    fails("K", { ...ok, after: { r: seen({ label: "Old" }) } })
    fails("K", { ...ok, after: { r: none } })
  })

  it("repoint fails when a read still points at the merged-away id", () => {
    const ok = input({
      after: { r: seen({ points: "s" }) },
      whoIsTold: ["r"],
      facts: { survivor: "s", goneId: "g" },
    })
    passes("P", ok)
    fails("P", { ...ok, after: { r: seen({ points: "g" }) } })
    fails("P", { ...ok, after: { r: none } })
  })

  it("snapshot fails when a frozen record takes the new text", () => {
    const ok = input({
      before: { r: seen({ label: "Old" }) },
      after: { r: seen({ label: "Old" }) },
      facts: { oldName: "Old" },
    })
    passes("S", ok)
    fails("S", { ...ok, after: { r: seen({ label: "New" }) } })
  })

  it("close fails when nothing shows a closed state, a read points at what left without saying so, or whoever must be told lost the item", () => {
    const ok = input({
      before: { d: seen() },
      after: { d: seen({ points: null, state: "left" }) },
      whoIsTold: ["d"],
      visibleState: ["left"],
      facts: { goneId: "a" },
    })
    passes("C", ok)
    fails("C", { ...ok, after: { d: seen() } })
    fails("C", { ...ok, after: { d: { visible: false, state: "left" } } })
    // Pointing at what left is wrong unless the read says it left.
    fails("C", {
      ...ok,
      after: { d: seen({ state: "away" }), x: seen({ points: null, state: "left" }) },
    })
    passes("C", { ...ok, after: { d: seen({ state: "left" }) } })
  })

  it("hide fails when the reader who lost access still sees a title or a count", () => {
    const ok = input({
      after: { lost: none, never: none, keeps: seen() },
      whoIsTold: ["keeps"],
      facts: { lostAccess: "lost", neverHad: "never" },
    })
    passes("H", ok)
    fails("H", { ...ok, after: { ...ok.after, lost: { visible: false, label: "Secret" } } })
    fails("H", { ...ok, after: { ...ok.after, lost: { visible: false, count: 1 } } })
    fails("H", { ...ok, after: { ...ok.after, keeps: none } })
  })

  it("refuse fails without a sentence or when the link changed anyway", () => {
    const ok = input({
      before: { r: seen() },
      after: { r: seen() },
      facts: { refusal: "This cannot be removed while it is linked." },
    })
    passes("R", ok)
    fails("R", { ...ok, facts: { refusal: null } })
    fails("R", { ...ok, after: { r: none } })
  })

  it("export fails when the export misses the link's row", () => {
    passes("E", input({ facts: { linkRowId: "x", exported: ["x"] } }))
    fails("E", input({ facts: { linkRowId: "x", exported: ["y"] } }))
  })

  it("migrate fails when an old row reads differently from today's", () => {
    const ok = input({
      after: { r: seen({ placement: "mine" }) },
      facts: { asToday: { r: seen({ placement: "mine" }) } },
    })
    passes("M", ok)
    fails("M", { ...ok, after: { r: seen({ placement: "others" }) } })
  })

  it("reset fails when a row of the link is left", () => {
    passes("Z", input({ facts: { leftAfterReset: 0 } }))
    fails("Z", input({ facts: { leftAfterReset: 2 } }))
  })

  it("return fails when the way back reads differently or duplicates a row", () => {
    const ok = input({
      before: { r: seen({ placement: "mine" }) },
      after: { r: seen({ placement: "mine" }) },
      facts: { rowsBefore: 1, rowsAfter: 1 },
    })
    passes("V", ok)
    fails("V", { ...ok, after: { r: seen({ placement: "others" }) } })
    fails("V", { ...ok, facts: { rowsBefore: 1, rowsAfter: 2 } })
  })

  it("pass on fails when the next in line misses it, holds it for nobody, or someone gains a right", () => {
    const ok = input({
      before: { p: seen(), n: none, x: none },
      after: { p: seen(), n: seen({ forPerson: "p" }), x: none },
      facts: { person: "p", nextInLine: "n", mustNotGain: ["x"] },
    })
    passes("W", ok)
    fails("W", { ...ok, after: { ...ok.after, n: none } })
    fails("W", { ...ok, after: { ...ok.after, n: seen({ forPerson: null }) } })
    fails("W", { ...ok, after: { ...ok.after, x: seen() } })
    fails("W", { ...ok, after: { ...ok.after, p: none } })
  })
})
