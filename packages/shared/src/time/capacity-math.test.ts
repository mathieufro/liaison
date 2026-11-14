// SPDX-License-Identifier: FSL-1.1-ALv2

import { describe, expect, it } from "bun:test"
import { overNote } from "./capacity-math"

describe("overNote", () => {
  it("3 h over has no note and 3 h 01 has", () => {
    expect(overNote(35 * 60 + 180, 35 * 60)).toBeNull()
    expect(overNote(35 * 60 + 181, 35 * 60)).toBe("3 h more than fits")
    expect(overNote(44 * 60, 35 * 60)).toBe("9 h more than fits")
  })

  it("4 h 59 free has no note and 5 h has", () => {
    expect(overNote(35 * 60 - 299, 35 * 60)).toBeNull()
    expect(overNote(30 * 60, 35 * 60)).toBe("5 h free")
    expect(overNote(15 * 60, 35 * 60)).toBe("20 h free")
  })

  it("a balanced week has no note", () => {
    expect(overNote(35 * 60, 35 * 60)).toBeNull()
  })
})
