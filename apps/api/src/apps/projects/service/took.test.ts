// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { checkPersonStatement, durationInQuote, enteredViaOf, todayIn } from "./took"

const HPD = 420
const inApp = { origin: "in-app-agent" as const, frame: {}, actingAgentId: null }
const mcpOwn = { origin: "mcp" as const, frame: { mcpGateway: true }, actingAgentId: null }

describe("Took reads only the person's own statement", () => {
  it("finds the duration inside the person's words, in English and French", () => {
    expect(durationInQuote("log 2h on ATLAS-12", HPD)).toBe(120)
    expect(durationInQuote("this took half a day, thanks", HPD)).toBe(210)
    expect(durationInQuote("j'ai passé 1,5 j dessus", HPD)).toBe(630)
    expect(durationInQuote("it took a while", HPD)).toBeNull()
  })

  it("the person in the app needs no quote", () => {
    expect(
      checkPersonStatement({
        place: { origin: "human-ui", frame: undefined, actingAgentId: null },
        minutes: 120,
        quote: undefined,
        hoursPerDayMinutes: HPD,
        latestHumanMessage: null,
      }),
    ).toBeNull()
  })

  it("an in-app agent needs the quote in the latest message with the same figure", () => {
    const base = { place: inApp, minutes: 120, hoursPerDayMinutes: HPD }
    expect(
      checkPersonStatement({ ...base, quote: "took 2 h", latestHumanMessage: "That took 2 h." }),
    ).toBeNull()
    expect(
      checkPersonStatement({ ...base, quote: undefined, latestHumanMessage: "That took 2 h." })
        ?.code,
    ).toBe("needs_person_statement")
    expect(
      checkPersonStatement({ ...base, quote: "took 2 h", latestHumanMessage: "Thanks!" })?.code,
    ).toBe("needs_person_statement")
    expect(
      checkPersonStatement({
        ...base,
        minutes: 180,
        quote: "took 2 h",
        latestHumanMessage: "That took 2 h.",
      })?.code,
    ).toBe("needs_person_statement")
  })

  it("a quote that is only part of a different figure in the person's words is refused", () => {
    const check = (latest: string, quote: string, minutes: number) =>
      checkPersonStatement({
        place: inApp,
        minutes,
        quote,
        hoursPerDayMinutes: HPD,
        latestHumanMessage: latest,
      })?.code ?? null
    expect(check("it took 12 hours", "2 hours", 120)).toBe("needs_person_statement")
    expect(check("it took 1h30", "1h", 60)).toBe("needs_person_statement")
    expect(check("it took 1 h 30", "1 h", 60)).toBe("needs_person_statement")
    expect(check("about 15 minutes", "5 minutes", 5)).toBe("needs_person_statement")
    expect(check("not 2 hours, more like 4", "2 hours", 120)).toBe("needs_person_statement")
    expect(check("it took 12 hours", "12 hours", 720)).toBeNull()
    expect(check("It took 1h30, thanks!", "1h30", 90)).toBeNull()
    expect(check("It took 1 h 30 in the end.", "took 1 h 30", 90)).toBeNull()
  })

  it("a routine or a sub-run never records time, whatever it quotes", () => {
    for (const frame of [{ routineId: "r1" }, { background: true }]) {
      expect(
        checkPersonStatement({
          place: { ...inApp, frame },
          minutes: 120,
          quote: "2 h",
          hoursPerDayMinutes: HPD,
          latestHumanMessage: "2 h",
        })?.code,
      ).toBe("needs_person_statement")
    }
  })

  it("over MCP the person's own connection needs only a matching quote, with no thread", () => {
    const base = { minutes: 90, hoursPerDayMinutes: HPD, latestHumanMessage: null }
    expect(checkPersonStatement({ ...base, place: mcpOwn, quote: "1h30 on it" })).toBeNull()
    expect(checkPersonStatement({ ...base, place: mcpOwn, quote: "2 h" })?.code).toBe(
      "needs_person_statement",
    )
    expect(
      checkPersonStatement({
        ...base,
        place: { origin: "mcp", frame: { mcpGateway: true, agentId: "a1" }, actingAgentId: null },
        quote: "1h30",
      })?.code,
    ).toBe("needs_person_statement")
  })

  it("names how each entry was made", () => {
    expect(enteredViaOf("human-ui")).toBe("field")
    expect(enteredViaOf("in-app-agent")).toBe("agent")
    expect(enteredViaOf("mcp")).toBe("mcp")
  })

  it("today is the org's day on both sides of midnight and of a month end", () => {
    // 23:30 and 00:30 in Paris around the end of October, with the clock in UTC.
    expect(todayIn("Europe/Paris", new Date(Date.UTC(2026, 9, 31, 22, 30)))).toBe("2026-10-31")
    expect(todayIn("Europe/Paris", new Date(Date.UTC(2026, 9, 31, 23, 30)))).toBe("2026-11-01")
    expect(todayIn("UTC", new Date(Date.UTC(2026, 9, 31, 23, 30)))).toBe("2026-10-31")
  })
})
