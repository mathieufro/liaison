// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Minimal line-level diff (LCS) for rendering a git-style old -> new comparison
 * in the approval card and a node session's Files changed (web and API). No dependency: the inputs are bounded skill bodies (a
 * few KB), so an O(n*m) LCS over lines is cheap. A guard falls back to
 * "whole block replaced" for pathologically large inputs so a giant paste can
 * never lock the UI thread.
 */

export type DiffType = "same" | "add" | "del"
export interface DiffLine {
  type: DiffType
  text: string
}
/** A collapsed run of unchanged lines, rendered as a single "N unchanged" marker. */
export interface DiffGap {
  type: "gap"
  count: number
}
export type DiffRow = DiffLine | DiffGap

/** Above this combined line count we skip the O(n*m) LCS and just show the old
 *  block removed then the new block added. Correct, only non-minimal. */
const MAX_LINES = 4000

/** Line-level LCS diff. Returns one row per line in reading order. */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.length === 0 ? [] : oldText.split("\n")
  const b = newText.length === 0 ? [] : newText.split("\n")

  if (a.length + b.length > MAX_LINES) {
    return [
      ...a.map((text): DiffLine => ({ type: "del", text })),
      ...b.map((text): DiffLine => ({ type: "add", text })),
    ]
  }

  const n = a.length
  const m = b.length
  // lcs(i, j) = length of the LCS of a[i:] and b[j:], one flat row-major table.
  const width = m + 1
  const dp = new Array<number>((n + 1) * width).fill(0)
  const lcs = (i: number, j: number): number => dp[i * width + j] ?? 0
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[i] === b[j] ? lcs(i + 1, j + 1) + 1 : Math.max(lcs(i + 1, j), lcs(i, j + 1))
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    const left = a[i] ?? ""
    const right = b[j] ?? ""
    if (left === right) {
      out.push({ type: "same", text: left })
      i++
      j++
    } else if (lcs(i + 1, j) >= lcs(i, j + 1)) {
      out.push({ type: "del", text: left })
      i++
    } else {
      out.push({ type: "add", text: right })
      j++
    }
  }
  for (const text of a.slice(i)) out.push({ type: "del", text })
  for (const text of b.slice(j)) out.push({ type: "add", text })
  return out
}

/** Count of added / removed lines, for the "+N -M" diff header. */
export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const l of lines) {
    if (l.type === "add") added++
    else if (l.type === "del") removed++
  }
  return { added, removed }
}

/**
 * Collapse long runs of unchanged lines into a single `gap` marker, keeping
 * `context` lines on each side of every change — the git-hunk look. Runs at the
 * very start/end keep no leading/trailing context (nothing to anchor to).
 */
export function withCollapsedContext(lines: DiffLine[], context = 3): DiffRow[] {
  const rows: DiffRow[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line && line.type !== "same") {
      rows.push(line)
      i++
      continue
    }
    let j = i
    while (j < lines.length && lines[j]?.type === "same") j++
    const run = lines.slice(i, j)
    const lead = i === 0 ? 0 : context
    const trail = j === lines.length ? 0 : context
    if (run.length <= lead + trail + 1) {
      rows.push(...run)
    } else {
      rows.push(...run.slice(0, lead))
      rows.push({ type: "gap", count: run.length - lead - trail })
      rows.push(...run.slice(run.length - trail))
    }
    i = j
  }
  return rows
}
