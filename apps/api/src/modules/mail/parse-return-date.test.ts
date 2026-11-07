// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { parseReturnDate } from "~/modules/mail/parse-return-date"

const SENT = new Date("2026-11-06T10:00:00.000Z")
const SEVEN_DAYS = new Date("2026-11-13T10:00:00.000Z")

const returnDate = (text: string | null, sentAt = SENT, locale?: string) =>
  parseReturnDate(text, sentAt, locale, "UTC").returnDate

describe("parseReturnDate: what it reads", () => {
  for (const [text, expected] of [
    ["I am away until 16 November.", "2026-11-16"],
    ["I am away until Monday 16 November.", "2026-11-16"],
    ["I am away until Monday, 16th November 2026.", "2026-11-16"],
    ["Away until November 16, 2026.", "2026-11-16"],
    ["Away until Nov 16.", "2026-11-16"],
    ["UNTIL 16 NOVEMBER", "2026-11-16"],
    ["I will be back on 16/11", "2026-11-16"],
    ["I will be back on 16/11/2026", "2026-11-16"],
    ["I will be back on 16/11/26", "2026-11-16"],
    ["I will be back on Monday 16 November", "2026-11-16"],
    ["Returning on 16 November", "2026-11-16"],
    ["Absent jusqu'au 16 novembre", "2026-11-16"],
    ["Absent jusqu’au lundi 16 novembre", "2026-11-16"],
    ["Absente jusqu'au 1er décembre", "2026-12-01"],
    ["Absente jusqu'au 1er decembre 2026", "2026-12-01"],
    ["Je serai de retour le 16/11", "2026-11-16"],
    ["Je serai de retour le lundi 16 novembre", "2026-11-16"],
    ["Back on 2026-11-16", "2026-11-16"],
    ["Absent. Date de retour : 2026-11-16", "2026-11-16"],
    ["Away from 2026-11-10 to 2026-11-16", "2026-11-16"],
    ["I am away\nuntil 16\nNovember", "2026-11-16"],
  ] as const) {
    it(`"${text}" reads ${expected}`, () => {
      expect(returnDate(text)).toBe(expected)
    })
  }

  it("a date with no year rolls to the next year when its day has passed", () => {
    expect(returnDate("Away until 5 January", new Date("2026-12-20T10:00:00.000Z"))).toBe(
      "2027-01-05",
    )
  })

  it("a slash date reads day first", () => {
    expect(returnDate("Back on 03/12")).toBe("2026-12-03")
  })

  it("a slash date reads month first on a US locale", () => {
    expect(returnDate("Back on 12/03", SENT, "en-US")).toBe("2026-12-03")
  })

  it("a slash date impossible in the locale's order reads the other way", () => {
    expect(returnDate("Back on 16/11", SENT, "en-US")).toBe("2026-11-16")
    expect(returnDate("Back on 11/16", SENT, "fr-FR")).toBe("2026-11-16")
  })

  it("the first acceptable date wins over a refused one", () => {
    expect(returnDate("Back on 01/11, sorry, I mean back on 16/11")).toBe("2026-11-16")
  })
})

describe("parseReturnDate: what it refuses", () => {
  it("a date before sentAt is refused", () => {
    expect(returnDate("Back on 2026-11-01")).toBeNull()
  })

  it("a date with no year already passed rolls past the window and is refused", () => {
    expect(returnDate("Back on 1 November")).toBeNull()
  })

  it("the day of sentAt is refused", () => {
    expect(returnDate("Back on 2026-11-06")).toBeNull()
  })

  it("the day after sentAt is accepted", () => {
    expect(returnDate("Back on 2026-11-07")).toBe("2026-11-07")
  })

  it("60 days after sentAt is accepted", () => {
    expect(returnDate("Back on 2027-01-05")).toBe("2027-01-05")
  })

  it("61 days after sentAt is refused", () => {
    expect(returnDate("Back on 2027-01-06")).toBeNull()
  })

  it("a date years ahead is refused and the default is used", () => {
    const parsed = parseReturnDate("Away until 16 November 2031", SENT, undefined, "UTC")
    expect(parsed.returnDate).toBeNull()
    expect(parsed.holdUntil).toEqual(SEVEN_DAYS)
  })

  it("a date that does not exist is refused", () => {
    expect(returnDate("Back on 31/11")).toBeNull()
    expect(returnDate("Back on 2026-11-31")).toBeNull()
    expect(returnDate("Back on 31 November")).toBeNull()
  })

  it("a time of day is not a date", () => {
    expect(returnDate("Away until 16.30 today")).toBeNull()
    expect(returnDate("Away until 10.30 today")).toBeNull()
  })

  it("a date with no lead word is not read, other than an ISO one", () => {
    expect(returnDate("Your order of 16 November has shipped")).toBeNull()
  })

  it("a date in a quoted line is not read", () => {
    expect(returnDate("I am away.\n> The offer is valid until 16 November")).toBeNull()
  })
})

describe("parseReturnDate: holdUntil", () => {
  it("holdUntil is the day after the date at 00:00 in the requester's zone, before a clock change", () => {
    const parsed = parseReturnDate(
      "Back on 2026-10-24",
      new Date("2026-10-20T10:00:00.000Z"),
      undefined,
      "Europe/Paris",
    )
    expect(parsed.holdUntil.toISOString()).toBe("2026-10-24T22:00:00.000Z")
  })

  it("holdUntil is the day after the date at 00:00 in the requester's zone, after a clock change", () => {
    const parsed = parseReturnDate(
      "Back on 2026-10-25",
      new Date("2026-10-20T10:00:00.000Z"),
      undefined,
      "Europe/Paris",
    )
    expect(parsed.holdUntil.toISOString()).toBe("2026-10-25T23:00:00.000Z")
  })

  it("holdUntil holds across the spring clock change too", () => {
    const sent = new Date("2026-03-20T10:00:00.000Z")
    const before = parseReturnDate("Back on 2026-03-28", sent, undefined, "Europe/Paris")
    const after = parseReturnDate("Back on 2026-03-29", sent, undefined, "Europe/Paris")
    expect(before.holdUntil.toISOString()).toBe("2026-03-28T23:00:00.000Z")
    expect(after.holdUntil.toISOString()).toBe("2026-03-29T22:00:00.000Z")
  })

  it("no zone gives UTC", () => {
    expect(parseReturnDate("Back on 2026-11-16", SENT).holdUntil.toISOString()).toBe(
      "2026-11-17T00:00:00.000Z",
    )
  })

  it("an unreadable zone gives UTC", () => {
    expect(
      parseReturnDate(
        "Back on 2026-11-16",
        SENT,
        undefined,
        "Mars/Olympus",
      ).holdUntil.toISOString(),
    ).toBe("2026-11-17T00:00:00.000Z")
  })

  it("the window is counted in the requester's zone", () => {
    // Still 6 November in Los Angeles, already 7 November in UTC.
    const sent = new Date("2026-11-07T02:00:00.000Z")
    expect(
      parseReturnDate("Back on 2026-11-07", sent, undefined, "America/Los_Angeles").returnDate,
    ).toBe("2026-11-07")
    expect(parseReturnDate("Back on 2026-11-07", sent, undefined, "UTC").returnDate).toBeNull()
  })

  it("no date gives sentAt plus 7 days", () => {
    const parsed = parseReturnDate("I am away.", SENT, undefined, "Europe/Paris")
    expect(parsed).toEqual({ returnDate: null, holdUntil: SEVEN_DAYS })
  })

  it("a sealed body gives sentAt plus 7 days", () => {
    expect(parseReturnDate(null, SENT)).toEqual({ returnDate: null, holdUntil: SEVEN_DAYS })
  })

  it("an unreadable sentAt throws rather than reading as no hold", () => {
    expect(() => parseReturnDate("Back on 2026-11-16", new Date("nonsense"))).toThrow(RangeError)
  })
})
