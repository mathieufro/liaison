// SPDX-License-Identifier: FSL-1.1-ALv2

import { describe, expect, it } from "bun:test"
import { formatDuration, parseDuration } from "./parse-duration"

const DAY = 420

describe("parseDuration", () => {
  it("reads every form shown on the task and the French forms", () => {
    const table: Array<[string, number]> = [
      ["2 h", 120],
      ["1h30", 90],
      ["half a day", 210],
      ["half day", 210],
      ["1/2 day", 210],
      ["0.5 d", 210],
      ["2 days", 840],
      ["2 d", 840],
      ["90 m", 90],
      ["2 j", 840],
      ["2 jours", 840],
      ["demi-journée", 210],
      ["1,5 j", 630],
      ["  1,5 H ", 90],
      ["1 h 30", 90],
    ]
    for (const [text, minutes] of table)
      expect([text, parseDuration(text, DAY)]).toEqual([text, minutes])
  })

  it("returns nothing for text it cannot read", () => {
    for (const text of [
      "",
      "  ",
      "soon",
      "2",
      "h",
      "-2 h",
      "0 h",
      "1h75",
      "2 weeks",
      "1.2.3 h",
      "2 h later",
    ]) {
      expect([text, parseDuration(text, DAY)]).toEqual([text, null])
    }
  })

  it("half a day follows the org's hours in a day", () => {
    expect(parseDuration("half a day", 420)).toBe(210)
    expect(parseDuration("half a day", 480)).toBe(240)
    expect(parseDuration("2 d", 480)).toBe(960)
  })
})

describe("formatDuration", () => {
  it("writes whole, half and approximate days, and hours otherwise", () => {
    expect(formatDuration(3 * DAY, "d", DAY)).toBe("3 d")
    expect(formatDuration(7.5 * DAY, "d", DAY)).toBe("7.5 d")
    expect(formatDuration(Math.round(0.9 * DAY), "d", DAY)).toBe("~1 d")
    expect(formatDuration(120, "h")).toBe("2 h")
    expect(formatDuration(90, "h")).toBe("1 h 30")
    expect(formatDuration(45, "h")).toBe("45 m")
  })
})
