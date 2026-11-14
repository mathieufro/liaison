// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one day a month's closing line shows: the last working day strictly before the month's last
// calendar day. Pure: it reads no time entries, commits, calendar or mail.

import { addDays, isoWeekdayOf } from "./dates"
import { type DaysOffRow, expandDaysOff } from "./days-off"

/** `YYYY-MM-DD` of the close day for `month` (1 to 12), skipping weekends and company days off. */
export function monthCloseDay(
  year: number,
  month: number,
  daysOff: readonly DaysOffRow[] = [],
): string {
  const last = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
  const first = `${last.slice(0, 8)}01`
  const off = new Set(expandDaysOff(daysOff, first, last))
  for (let d = addDays(last, -1); d >= first; d = addDays(d, -1)) {
    if (isoWeekdayOf(d) <= 5 && !off.has(d)) return d
  }
  return first
}
