// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

// GUARD ORACLE
//
// Contract: sandbox execution (runApp / executeInSandbox / getWorkerPool().execute) must not
// receive an AMBIENT-transaction bridge (createRpcBridge). Ambient bridges hold a
// Postgres connection open across the whole sandbox call, which can deadlock the
// pool and silently changes commit semantics (the tx spans multiple RPC calls
// instead of one-commit-per-call). Session bridges (createSessionRpcBridge) are the
// supported replacement: each RPC call opens and commits its own transaction.
//
// This test scans PRODUCTION source under apps/api/src (never test files) for call
// sites where a file constructs an ambient bridge AND also drives sandbox execution.
// Any match must be in the EXCEPTION_LIST below with a reason, or the test fails and
// tells the author to convert the call site or add a justified exception.

const SRC_ROOT = path.resolve(__dirname, "../../../")

const AMBIENT_BRIDGE_MARKER = "createRpcBridge("
// `runApp(` is the funnel every app-code dispatch site goes through
// (sandbox/run-app.ts): a site calling it drives sandbox execution.
const SANDBOX_EXEC_MARKERS = ["executeInSandbox(", "getWorkerPool().execute", "runApp("]

interface ExceptionEntry {
  file: string
  reason: string
}

// Explicit, reviewed exception list. Every entry here is a known, intentional use of
// an ambient bridge alongside sandbox execution. Adding a new entry requires a reason
// and should be treated as a deliberate architectural decision, not a quick fix.
const EXCEPTION_LIST: ExceptionEntry[] = [
  {
    file: "modules/apps/execute-tool.ts",
    reason:
      "Hosts BOTH paths: the session bridge (default) and the legacy ambient path for " +
      "atomic: true tools, preflights, and post-approval re-entry.",
  },
  {
    file: "modules/apps/runtime.ts",
    reason:
      "DEFERRED jobs-pool paths (scheduled jobs + event handlers) still use the ambient " +
      'wrap by design (isolated "jobs" pool); the search handler is already converted.',
  },
  {
    file: "infra/jobs/webhook-worker.ts",
    reason: "DEFERRED jobs-pool path.",
  },
]

const EXCEPTION_FILES = new Set(EXCEPTION_LIST.map((entry) => entry.file))

function shouldSkip(relPath: string): boolean {
  if (!relPath.endsWith(".ts")) return true
  if (relPath.endsWith(".test.ts")) return true
  if (relPath.includes("__test-helpers__")) return true
  if (relPath.includes("node_modules")) return true
  return false
}

function listSourceFiles(root: string): string[] {
  const out: string[] = []
  const stack: string[] = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "__test-helpers__") continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile()) {
        const rel = path.relative(root, full)
        if (!shouldSkip(rel)) out.push(rel)
      }
    }
  }
  return out
}

function readSources(): Map<string, string> {
  const out = new Map<string, string>()
  for (const rel of listSourceFiles(SRC_ROOT)) {
    out.set(rel, fs.readFileSync(path.join(SRC_ROOT, rel), "utf8"))
  }
  return out
}

function findViolations(sources: Map<string, string> = readSources()): string[] {
  const violations: string[] = []

  for (const [rel, content] of sources) {
    const hasAmbientBridge = content.includes(AMBIENT_BRIDGE_MARKER)
    const hasSandboxExec = SANDBOX_EXEC_MARKERS.some((marker) => content.includes(marker))

    if (hasAmbientBridge && hasSandboxExec && !EXCEPTION_FILES.has(rel)) {
      violations.push(rel)
    }
  }

  return violations
}

describe("guard: no ambient bridge across sandbox execution", () => {
  test("every call site combining createRpcBridge with sandbox execution is an explicit, justified exception", () => {
    const violations = findViolations()

    if (violations.length > 0) {
      const list = violations.map((f) => `  - ${f}`).join("\n")
      throw new Error(
        "New call site(s) construct an AMBIENT-transaction bridge (createRpcBridge) and " +
          "then drive sandbox execution (executeInSandbox / getWorkerPool().execute):\n" +
          `${list}\n\n` +
          "Ambient bridges hold a Postgres connection open across the whole sandbox call " +
          "(can deadlock the pool) and change commit semantics from one-commit-per-RPC-call " +
          "to one-transaction-spanning-the-whole-handler.\n\n" +
          "Fix: convert the call site to createSessionRpcBridge (see " +
          "modules/mail/service.ts for a converted example), OR, if this is a genuinely " +
          "deferred/isolated-pool path by design, add it to EXCEPTION_LIST in " +
          "no-ambient-bridge-across-sandbox.test.ts with a specific reason.",
      )
    }

    expect(violations).toEqual([])
  })

  test("an ambient bridge handed to runApp in a non-excepted file is caught", () => {
    const offender = [
      'import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"',
      'import { runApp } from "~/modules/apps/sandbox/run-app"',
      "await withRlsContext(actor, (tx) =>",
      "  runApp({ trusted: false, appName, orgId, bundlePath, exportName, params,",
      "    bridge: createRpcBridge(appName, userId, orgId, tx, manifest), holdsTx: true }),",
      ")",
    ].join("\n")
    const sources = new Map([
      ["modules/some-feature/dispatch.ts", offender],
      // The same code in an excepted file stays allowed.
      ["modules/apps/runtime.ts", offender],
      // A session bridge into runApp is the supported shape.
      [
        "modules/other/dispatch.ts",
        "runApp({ bridge: createSessionRpcBridge(appName, userId, orgId, session, m), holdsTx: false })",
      ],
    ])
    expect(findViolations(sources)).toEqual(["modules/some-feature/dispatch.ts"])
  })

  test("the funnel marker is live: the dispatch sites call runApp", () => {
    // If the funnel were renamed, the marker would silently match nothing.
    const sources = readSources()
    for (const rel of [
      "modules/apps/execute-tool.ts",
      "modules/apps/runtime.ts",
      "modules/webhooks/manifest-execution.ts",
    ]) {
      expect(sources.get(rel)?.includes("runApp(")).toBe(true)
    }
  })

  test("exception list only contains the documented, reviewed entries", () => {
    // Guards against silently growing the exception list without review: this pins the
    // exact set of files currently allowed to combine ambient bridge + sandbox exec.
    const expected = new Set([
      "modules/apps/execute-tool.ts",
      "modules/apps/runtime.ts",
      "infra/jobs/webhook-worker.ts",
    ])
    expect(EXCEPTION_FILES).toEqual(expected)
    for (const entry of EXCEPTION_LIST) {
      expect(entry.reason.length).toBeGreaterThan(0)
    }
  })
})

describe("guard: mail service is converted off the ambient bridge", () => {
  const MAIL_SERVICE_REL = "modules/mail/service.ts"

  test("mail/service.ts is not in the exception list", () => {
    expect(EXCEPTION_FILES.has(MAIL_SERVICE_REL)).toBe(false)
  })

  test("mail/service.ts does not construct createRpcBridge (ambient) at all", () => {
    const full = path.join(SRC_ROOT, MAIL_SERVICE_REL)
    const content = fs.readFileSync(full, "utf8")

    // Must not call the ambient constructor. Matching "createRpcBridge(" (with the
    // open paren) avoids false positives from the "createSessionRpcBridge(" substring
    // partially matching, since that name does not contain "createRpcBridge(".
    expect(content.includes(AMBIENT_BRIDGE_MARKER)).toBe(false)

    // It should use the session bridge instead (positive assertion that the
    // conversion actually happened, not just that the old call disappeared).
    expect(content.includes("createSessionRpcBridge(")).toBe(true)
  })
})
