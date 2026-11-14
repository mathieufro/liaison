// SPDX-License-Identifier: FSL-1.1-ALv2
//
// CLOSURE ORACLE: the question "what scope decides this approval?" has exactly
// ONE exported answerer — `decidingScope` / `decidingScopeForToolDef` in the
// shared authority module (packages/shared/src/approvals/authority.ts). Every
// surface (list, feed, decide, edit, web card/store, gate paths) calls it.
//
// Four prod failures in one week (2026-08-05/06) were the same defect: a read
// site RECOMPUTING `<app>:approve` from the tool name instead of reading the
// row's persisted `approve_scope`. Each fix wired the correct answer into one
// call site and left the others divergent. This oracle fails CI on the NEXT
// divergence instead of letting it surface as a prod report.
//
// Two source patterns constitute a recompute:
//   1. a template literal ending `}:approve\`` — deriving the scope from an
//      interpolated app name (`` `${appName}:approve` ``);
//   2. `approve_scope ?? \`` / `approveScope ?? \`` — a local fallback
//      derivation instead of `decidingScope`.
// Comment lines are skipped (the pattern is legitimately DISCUSSED in prose).
// Test files are skipped (fixtures legitimately spell out scope strings; tests
// are not answerers).
//
// If you hit this oracle with a legitimate new helper: do NOT weaken the
// patterns — either call the authority module (almost always the right move)
// or add your file to EXCEPTIONS with a reason. Every exception is asserted to
// still match, so stale entries fail too (gestalt contract: extend the
// documented exception surface, never the blind spot).

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const REPO = join(import.meta.dir, "..", "..", "..", "..", "..")
const SCAN_ROOTS = [
  join(REPO, "apps", "api", "src"),
  join(REPO, "apps", "web", "src"),
  join(REPO, "packages", "shared", "src"),
]

/** repo-relative path → why this file is allowed to derive the scope. */
const EXCEPTIONS: Record<string, string> = {
  "packages/shared/src/approvals/authority.ts":
    "the answerer itself — decidingScope/decidingScopeForToolDef own the derivation",
}

const RECOMPUTE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "template-derived `${…}:approve`", re: /\$\{[^}`]*\}:approve`/ },
  { name: "local fallback `approve[_sS]cope ?? `…``", re: /approve_?[sS]cope\s*\?\?\s*`/ },
]

function walkSources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      // Test trees are fixture territory, not answerers.
      if (name === "tests" || name === "e2e" || name === "migrations") continue
      out.push(...walkSources(full))
      continue
    }
    if (!/\.(ts|tsx)$/.test(name)) continue
    if (/\.(test|spec)\.tsx?$/.test(name) || name.endsWith(".d.ts")) continue
    out.push(full)
  }
  return out
}

/** Code lines only: strip line comments and block-comment lines so prose that
 *  QUOTES the pattern (docs of the bug class) does not trip the oracle. */
function codeLines(source: string): string[] {
  return source
    .split("\n")
    .map((line) => {
      const t = line.trim()
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return ""
      const slashes = line.indexOf("//")
      return slashes >= 0 ? line.slice(0, slashes) : line
    })
    .filter(Boolean)
}

describe("approval authority closure — one answerer for the deciding scope", () => {
  const files = SCAN_ROOTS.flatMap(walkSources)

  it("no file outside the authority module recomputes the deciding scope", () => {
    const offenders: string[] = []
    for (const file of files) {
      const rel = relative(REPO, file)
      if (EXCEPTIONS[rel]) continue
      const code = codeLines(readFileSync(file, "utf8")).join("\n")
      for (const p of RECOMPUTE_PATTERNS) {
        if (p.re.test(code)) offenders.push(`${rel} [${p.name}]`)
      }
    }
    expect(offenders).toEqual([])
  })

  it("every exception entry still matches a pattern (no stale exceptions)", () => {
    for (const [rel, reason] of Object.entries(EXCEPTIONS)) {
      const code = codeLines(readFileSync(join(REPO, rel), "utf8")).join("\n")
      const hit = RECOMPUTE_PATTERNS.some((p) => p.re.test(code))
      expect(hit, `${rel} (${reason}) no longer derives the scope — remove the exception`).toBe(
        true,
      )
    }
  })

  it("sanity: the scan actually visits the known consumer surfaces", () => {
    const rels = new Set(files.map((f) => relative(REPO, f)))
    for (const must of [
      "apps/api/src/modules/approvals/list.ts",
      "apps/api/src/modules/approvals/attention.ts",
      "apps/api/src/modules/approvals/decide.ts",
      "apps/api/src/modules/approvals/edit.ts",
      "apps/api/src/modules/apps/execute-tool.ts",
      "apps/web/src/modules/approvals/ApprovalCard.tsx",
      "apps/web/src/modules/approvals/approvals-store.ts",
      "packages/shared/src/approvals/authority.ts",
    ]) {
      expect(rels.has(must), `scan missed ${must}`).toBe(true)
    }
  })
})

// WHO A ROW IS FOR has the same shape of answer: the person on the item and a company's manager
// decide a row's placement only in the shared authority module and its two API adapters. A
// fourth reader would be a second answer to "whose is this", free to drift from the first.
const ROUTE_READERS: Record<string, string> = {
  "packages/shared/src/approvals/authority.ts": "the answerer: routeApproval and homePlacement",
  "apps/api/src/modules/approvals/attention.ts": "the feed and badge adapter",
  "apps/api/src/modules/approvals/route-world.ts": "the reader of the routing world",
}
/** Files that name a routing input without deciding a placement from it. */
const ROUTE_NON_READERS: Record<string, string> = {
  "apps/api/src/db/schema/kernel/agent-memory.ts": "the column's definition",
  "apps/api/src/modules/users/merge-references.ts": "repoints the column when two accounts merge",
  "apps/api/src/modules/erasure/erase-user.ts": "clears the column when a person is erased",
  "apps/api/src/modules/contacts/companies.ts":
    "repoints the column when two companies merge, and names the kept company's manager",
  "apps/api/src/modules/agent/tools/company-tools.ts":
    "the merge result names the kept company's manager",
  "apps/api/src/seed/worlds/saas/layer.ts":
    "the demo seed stores the person one seeded request routes to, as a proposal would; it reads no placement",
}
const ROUTE_INPUT = /\b(route_person_id|routePersonId|route_company_id|routeCompanyId|managerId)\b/

describe("approval routing closure: one answerer for whose a row is", () => {
  const files = SCAN_ROOTS.flatMap(walkSources)

  it("a read of the person on the item or a manager outside the routing module and its adapters fails", () => {
    const offenders: string[] = []
    for (const file of files) {
      const rel = relative(REPO, file)
      if (ROUTE_READERS[rel] || ROUTE_NON_READERS[rel]) continue
      if (ROUTE_INPUT.test(codeLines(readFileSync(file, "utf8")).join("\n"))) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })

  it("every listed file still names a routing input (no stale entries)", () => {
    for (const [rel, reason] of Object.entries({ ...ROUTE_READERS, ...ROUTE_NON_READERS })) {
      const code = codeLines(readFileSync(join(REPO, rel), "utf8")).join("\n")
      expect(ROUTE_INPUT.test(code), `${rel} (${reason}) no longer names one: remove it`).toBe(true)
    }
  })

  it("sanity: the oracle sees a planted read", () => {
    expect(ROUTE_INPUT.test("const p = row.route_person_id")).toBe(true)
    expect(ROUTE_INPUT.test("const p = row.routePersonIds")).toBe(false)
  })
})
