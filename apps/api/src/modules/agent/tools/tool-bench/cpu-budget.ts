// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The bench's CPU bound, scaled to the machine it runs on. A fixed number of milliseconds fails
 * on a loaded or slow runner with no change to the ranker, so the bound is a ratio: the ranking's
 * CPU time over the CPU time of a small fixed workload measured in the same process, before and
 * after it. Slow hardware and a busy machine stretch both alike; a ranker that does more work
 * per form does not stretch the workload, so the ratio still catches it.
 */

/** The ranking's CPU time over the workload's, as measured on a quiet laptop: about 20. */
export const REFERENCE_CPU_RATIO = 20

/** How many times the reference ratio the ranking may cost before it fails. */
export const CPU_RATIO_TOLERANCE = 4

export function cpuMs(since?: NodeJS.CpuUsage): number {
  const c = process.cpuUsage(since)
  return (c.user + c.system) / 1000
}

/**
 * A fixed workload of the same kind as ranking (folding, counting and sorting strings), never
 * more than a few hundred milliseconds. Returns its CPU time in milliseconds.
 */
export function calibrationMs(): number {
  const before = process.cpuUsage()
  const words: string[] = []
  for (let i = 0; i < 60_000; i++) words.push(`mot${(i * 7919) % 1031}é${i % 13}`)
  const counts = new Map<string, number>()
  for (let round = 0; round < 6; round++) {
    for (const w of words) {
      const key = w.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  if (sorted.length === 0) throw new Error("the calibration workload produced nothing")
  return cpuMs(before)
}

/** Within budget: the ranking cost at most the tolerated multiple of the reference ratio. */
export function withinCpuBudget(rankingMs: number, workloadMs: number): boolean {
  return rankingMs < REFERENCE_CPU_RATIO * CPU_RATIO_TOLERANCE * Math.max(workloadMs, 1)
}
