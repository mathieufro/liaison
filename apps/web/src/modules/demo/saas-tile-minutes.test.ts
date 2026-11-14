// SPDX-License-Identifier: FSL-1.1-ALv2
// The software world's tiles say the minutes the board says, and Everything is
// about 22 minutes: the sum of its seven.

import { DEMO_WORLD_NEEDS } from "@liaison/shared"
import { describe, expect, it } from "vitest"
import { NEED_MINUTES, needsMinutes } from "./NeedsPicker"

describe("the software world's tile minutes", () => {
  it("tile minutes match the board and everything is about 22 minutes", () => {
    expect(DEMO_WORLD_NEEDS.saas.map((need) => [need, NEED_MINUTES[need]])).toEqual([
      ["support", 3],
      ["projects", 3],
      ["chat", 3],
      ["sales", 4],
      ["money", 3],
      ["dev", 3],
      ["knowledge", 3],
    ])
    expect(needsMinutes(DEMO_WORLD_NEEDS.saas)).toBe(22)
  })
})
