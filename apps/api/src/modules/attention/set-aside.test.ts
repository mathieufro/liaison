// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { nextMondayStart } from "./set-aside"

const PARIS = "Europe/Paris"

describe("Not now: next Monday 00:00 in the person's zone", () => {
  // [now (UTC), expected (UTC), why]
  const table: Array<[string, string, string]> = [
    // A Sunday afternoon in Paris (winter, UTC+1): the next day.
    ["2026-11-08T15:00:00Z", "2026-11-08T23:00:00Z", "set on a Sunday"],
    // A Monday morning in Paris: the Monday after, never that day.
    ["2026-11-09T08:00:00Z", "2026-11-15T23:00:00Z", "set on a Monday"],
    // Monday 00:30 Paris is still Sunday 23:30 UTC: the zone decides, so the Monday after.
    ["2026-11-08T23:30:00Z", "2026-11-15T23:00:00Z", "a Monday in Paris that is a Sunday in UTC"],
    // Sunday 23:30 Paris is Sunday 22:30 UTC: the very next midnight.
    ["2026-11-08T22:30:00Z", "2026-11-08T23:00:00Z", "the last half hour of a Sunday"],
    // Spring forward on Sunday 29 March 2026: set the Thursday before (UTC+1), lands at UTC+2.
    ["2026-03-26T10:00:00Z", "2026-03-29T22:00:00Z", "across the spring clock change"],
    // Fall back on Sunday 25 October 2026: set the Thursday before (UTC+2), lands at UTC+1.
    ["2026-10-22T10:00:00Z", "2026-10-25T23:00:00Z", "across the autumn clock change"],
    // On the day of each change itself.
    ["2026-03-29T12:00:00Z", "2026-03-29T22:00:00Z", "on the spring change Sunday"],
    ["2026-10-25T12:00:00Z", "2026-10-25T23:00:00Z", "on the autumn change Sunday"],
    // Month and year ends.
    ["2026-12-30T12:00:00Z", "2027-01-03T23:00:00Z", "across a year end"],
  ]
  for (const [now, expected, why] of table) {
    it(`${why}: ${now} gives ${expected}`, () => {
      expect(nextMondayStart(new Date(now), PARIS).toISOString()).toBe(
        new Date(expected).toISOString(),
      )
    })
  }

  it("an unknown or missing zone reads as UTC", () => {
    expect(nextMondayStart(new Date("2026-11-09T08:00:00Z"), null).toISOString()).toBe(
      "2026-11-16T00:00:00.000Z",
    )
    expect(nextMondayStart(new Date("2026-11-09T08:00:00Z"), "Not/AZone").toISOString()).toBe(
      "2026-11-16T00:00:00.000Z",
    )
  })
})
