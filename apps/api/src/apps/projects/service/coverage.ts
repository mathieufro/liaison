// SPDX-License-Identifier: FSL-1.1-ALv2
// Pure rules of a project's budget: which planned time counts, which tasks make up coverage.
// Nothing here knows a person: a task has minutes and entries, never an author.

export interface BudgetTask {
  id: string
  parentId: string | null
  name: string
  position: number
  number: number
  /** The task's own timebox in minutes, if it has one. */
  timebox: number | null
  isMilestone: boolean
  archived: boolean
  /** Done or otherwise closed. */
  closed: boolean
  /** Past the project's first column, or closed. */
  started: boolean
}

export interface Coverage {
  withEntries: number
  total: number
}

/** The tasks a budget counts: archived ones never are. */
export function liveTasks(tasks: readonly BudgetTask[]): BudgetTask[] {
  return tasks.filter((t) => !t.archived)
}

function childrenOf(tasks: readonly BudgetTask[]): Map<string | null, BudgetTask[]> {
  const ids = new Set(tasks.map((t) => t.id))
  const by = new Map<string | null, BudgetTask[]>()
  for (const t of tasks) {
    // A task whose parent is archived or elsewhere is a root of what is counted.
    const key = t.parentId && ids.has(t.parentId) ? t.parentId : null
    const list = by.get(key) ?? []
    list.push(t)
    by.set(key, list)
  }
  return by
}

/**
 * Planned minutes per task: a task's own timebox counts and its descendants' do not add to it;
 * a task without one is the sum of what its children plan.
 */
export function plannedByTask(live: readonly BudgetTask[]): Map<string, number> {
  const kids = childrenOf(live)
  const out = new Map<string, number>()
  const walk = (t: BudgetTask, seen: Set<string>): number => {
    const known = out.get(t.id)
    if (known !== undefined) return known
    if (seen.has(t.id)) return 0
    seen.add(t.id)
    const planned =
      t.timebox !== null
        ? t.timebox
        : (kids.get(t.id) ?? []).reduce((sum, c) => sum + walk(c, seen), 0)
    out.set(t.id, planned)
    return planned
  }
  for (const t of live) walk(t, new Set())
  return out
}

/** The project line's planned minutes: the sum over the roots of what is counted. */
export function plannedOfLine(live: readonly BudgetTask[]): number {
  const planned = plannedByTask(live)
  return (childrenOf(live).get(null) ?? []).reduce((sum, t) => sum + (planned.get(t.id) ?? 0), 0)
}

/** Real minutes of a task and everything under it. */
export function realByTask(
  live: readonly BudgetTask[],
  own: ReadonlyMap<string, number>,
): Map<string, number> {
  const kids = childrenOf(live)
  const out = new Map<string, number>()
  const walk = (t: BudgetTask, seen: Set<string>): number => {
    const known = out.get(t.id)
    if (known !== undefined) return known
    if (seen.has(t.id)) return 0
    seen.add(t.id)
    const total =
      (own.get(t.id) ?? 0) + (kids.get(t.id) ?? []).reduce((s, c) => s + walk(c, seen), 0)
    out.set(t.id, total)
    return total
  }
  for (const t of live) walk(t, new Set())
  return out
}

/** Leaf tasks, started or closed, archived excluded: N of them hold at least one entry. */
export function coverageOf(live: readonly BudgetTask[], hasEntries: ReadonlySet<string>): Coverage {
  const parents = new Set(live.map((t) => t.parentId).filter((p): p is string => p !== null))
  const scope = live.filter((t) => !parents.has(t.id) && (t.started || t.closed))
  return { withEntries: scope.filter((t) => hasEntries.has(t.id)).length, total: scope.length }
}
