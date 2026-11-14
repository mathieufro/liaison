// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The notes under a person's load: over by more than 3 h, free by 5 h or more.

export const OVER_NOTE_THRESHOLD_MINUTES = 180
export const FREE_NOTE_THRESHOLD_MINUTES = 300

function hours(minutes: number): string {
  return String(Math.round((minutes / 60) * 10) / 10)
}

/** "N h more than fits" or "N h free", else null: no note near balance. */
export function overNote(plannedMinutes: number, availableMinutes: number): string | null {
  const over = plannedMinutes - availableMinutes
  if (over > OVER_NOTE_THRESHOLD_MINUTES) return `${hours(over)} h more than fits`
  const free = availableMinutes - plannedMinutes
  if (free >= FREE_NOTE_THRESHOLD_MINUTES) return `${hours(free)} h free`
  return null
}
