// SPDX-License-Identifier: FSL-1.1-ALv2
// The Home row that tells a person a colleague set their days per week. The kernel copies the
// event's `capacityNamed` marker onto the row's metadata; the row offers "Back to 5 days" only
// when the marker names a count below five. One reader, so the server's row and the button agree.

/** The days per week a colleague set, when the row carries that marker and it is below 5; else null. */
export function capacityNamedDays(item: {
  metadata?: Record<string, unknown> | null
}): number | null {
  const named = item.metadata?.capacityNamed as { daysPerWeek?: unknown } | undefined
  const d = named?.daysPerWeek
  return typeof d === "number" && d >= 1 && d < 5 ? d : null
}
