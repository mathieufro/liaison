// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Two tools say days in the same forms: the away tool and the company days-off tool. Both read
// them with the same rules, so the same words give the same dates from either.

import { describe, expect, it } from "bun:test"
import { type DayFormInput, resolveDayForm } from "@liaison/shared"
import { type AwayForm, resolveAwayDates } from "~/modules/users/away"

const TODAY = "2026-11-06"

const AGREE: Array<{ name: string; form: DayFormInput & AwayForm; from: string; to: string }> = [
  { name: "week 52 with no year", form: { week: 52 }, from: "2026-12-21", to: "2026-12-27" },
  { name: "week 53 of 2026", form: { week: 53 }, from: "2026-12-28", to: "2027-01-03" },
  {
    name: "a week that has ended this year",
    form: { week: 10 },
    from: "2027-03-08",
    to: "2027-03-14",
  },
  {
    name: "a week with its year",
    form: { week: 2, weekYear: 2027 },
    from: "2027-01-11",
    to: "2027-01-17",
  },
  { name: "25 Dec with no year", form: { on: "12-25" }, from: "2026-12-25", to: "2026-12-25" },
  {
    name: "a day already passed this year",
    form: { on: "01-15" },
    from: "2027-01-15",
    to: "2027-01-15",
  },
  { name: "29 Feb with no year", form: { on: "02-29" }, from: "2028-02-29", to: "2028-02-29" },
  { name: "a full date", form: { on: "2026-12-01" }, from: "2026-12-01", to: "2026-12-01" },
  {
    name: "a range over the new year",
    form: { from: "12-24", to: "01-02" },
    from: "2026-12-24",
    to: "2027-01-02",
  },
  {
    name: "a range of full dates",
    form: { from: "2026-11-09", to: "2026-11-13" },
    from: "2026-11-09",
    to: "2026-11-13",
  },
]

const REFUSED: Array<{ name: string; form: DayFormInput & AwayForm }> = [
  { name: "week 53 of 2027", form: { week: 53, weekYear: 2027 } },
  { name: "week 54", form: { week: 54 } },
  { name: "a last day before the first", form: { from: "2026-12-10", to: "2026-12-01" } },
  { name: "a day that does not exist", form: { on: "2026-02-30" } },
  { name: "two forms at once", form: { on: "2026-12-10", week: 3 } },
]

describe("day forms read by the away tool and the days-off tool", () => {
  for (const c of AGREE) {
    it(`give the same dates for ${c.name}`, () => {
      const away = resolveAwayDates(c.form, TODAY)
      const off = resolveDayForm(c.form, TODAY, "Europe/Paris")
      expect(away).toMatchObject({ kind: "range", startsOn: c.from, endsOn: c.to })
      expect(off).toMatchObject({ ok: true, from: c.from, to: c.to })
    })
  }

  for (const c of REFUSED) {
    it(`both refuse ${c.name}`, () => {
      expect(() => resolveAwayDates(c.form, TODAY)).toThrow()
      expect(resolveDayForm(c.form, TODAY, "Europe/Paris")).toMatchObject({ ok: false })
    })
  }
})
