// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One `now` and no randomness: every timestamp a seed writes is an offset from
// the tier's base time, and every id and choice is a pure function of its
// inputs, so a fixed base time reproduces the exact world (tests, visual
// baselines, the demo pool's identical workspaces). A bare `Date.now()`, a
// `new Date()` without an argument or a `Math.random` under seed/ breaks that.
//
// A ratchet: the counts below are the uses the demo tier carried when it moved
// here (the tier's own base-time defaults and a few `updatedAt` stamps). A new
// use fails; removing one fails too, until its count here goes down with it.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

const SEED_DIR = import.meta.dir

/** Uses per file, relative to seed/. A file not listed may have none. */
const ALLOWED: Record<string, number> = {
  "tiers/demo/seed-demo.ts": 1,
  // The tier's base-time default.
  "tiers/lively/seed-lively.ts": 1,
  "tiers/load/seed-load.ts": 1,
  "tiers/standard/seed-standard.ts": 1,
  // A test factory's follow-up: the snooze service refuses a past time, so a
  // follow-up already due is moved an hour past the wall clock.
  "factories/support/ticket.ts": 2,
  // The timeline speed test's large customer: its history is laid out from the
  // database clock in SQL, and its people go through the contact factory at the
  // same wall clock.
  "factories/timeline/activity-scale-world.ts": 1,
  // A test factory's default billing period end, 20 days past the wall clock
  // as a fresh billing push would set it; tiers pass their own.
  "factories/billing/billing.ts": 1,
}

const FORBIDDEN = /\bDate\.now\(\)|\bnew Date\(\s*\)|\bMath\.random\b/g

const isTest = (name: string) => /\.test\.tsx?$/.test(name)

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(abs))
    else if (/\.tsx?$/.test(entry.name) && !isTest(entry.name)) out.push(abs)
  }
  return out
}

/** The source without comments, so prose naming the rule does not count. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1")
}

function forbiddenUses(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const abs of sourceFiles(SEED_DIR)) {
    const n = code(readFileSync(abs, "utf8")).match(FORBIDDEN)?.length ?? 0
    if (n > 0) counts[path.relative(SEED_DIR, abs).split(path.sep).join("/")] = n
  }
  return counts
}

describe("the seed engine has one `now` and no randomness", () => {
  it("uses Date.now(), new Date() or Math.random only where the ratchet allows", () => {
    expect(forbiddenUses()).toEqual(ALLOWED)
  })

  it("counts a bare clock read and ignores one in a comment", () => {
    expect(code("const a = Date.now() // Math.random\n").match(FORBIDDEN)).toEqual(["Date.now()"])
    expect(code("/* new Date() */ const b = new Date(base)").match(FORBIDDEN)).toBeNull()
  })
})
