// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Org-link discipline guard. Every absolute link the server builds for an org
// takes its base from `orgPublicBaseUrl` / `orgAppBaseUrl` (lib/org-public-url.ts),
// so that with LIAISON_ORG_HOST_TEMPLATE set it carries the org's own host. A raw
// read of `env.BASE_URL` or `env.ALLOWED_ORIGINS` (the web origin links used to be
// built on) in production code is how a link to the instance's shared host creeps
// back in.
//
// This test fails on any code read of either outside the helper and the allowlist
// below. Each allowlisted file names how many reads it may hold and why they are
// not org links; a new read in the same file fails too.

import { describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"

const srcDir = path.resolve(__dirname, "..")

const EXCLUDED_SEGMENTS = ["/tests/", "/__test-helpers__/", "/fixtures/", "/test-helpers/"]

/** The helper itself: the one place allowed to read them for links. */
const HELPER = "lib/org-public-url.ts"

const DEMO_DOOR =
  "demo door page: served by the demo deployment, which has no org hosts; the visitor has no org yet"

/**
 * file → { reads, reason }. `reads` is the exact number of `.BASE_URL` reads the
 * file may hold. Never add an org-facing link here: build it from the helper.
 */
const ALLOWLIST: Record<string, { reads: number; reason: string }> = {
  "lib/env.ts": {
    reads: 3,
    reason:
      "the variable's own boot checks, the fake Shopify admin gate's public-host refusal among them",
  },
  "lib/app-frame-host.ts": {
    reads: 2,
    reason:
      "boot check of the app frame origin: refuses a frame domain that shares BASE_URL's host or registrable domain, builds no link",
  },
  "app.ts": {
    reads: 3,
    reason:
      "CORS allowlist of the instance's web origins, not a link (org-origin CORS is separate)",
  },
  "modules/connection-guides/server-setup.ts": {
    reads: 1,
    reason:
      "operator's server checklist: describes this server's own BASE_URL setting, no org link",
  },
  "modules/demo/demo-verification.ts": { reads: 1, reason: DEMO_DOOR },
  "modules/demo/demo-leads.ts": { reads: 1, reason: DEMO_DOOR },
  "modules/apps/sandbox/bridge/shopify-fake-admin.ts": {
    reads: 1,
    reason:
      "the fake Shopify admin gate: refuses the hook when BASE_URL is a public host, builds no link",
  },
  "modules/demo/demo-mode.ts": {
    reads: 1,
    reason:
      "is BASE_URL loopback: a private demo box is reached only through a tunnel, builds no link",
  },
  "modules/apps/instance-config-defaults.ts": {
    reads: 1,
    reason: "the server's own Meta callback: one subscription URL for the shared Meta app",
  },
  "modules/apps/sandbox/bridge/shared.ts": {
    reads: 2,
    reason: "origin binding: the server's own hosts an app fetch must not reach, builds no link",
  },
  "modules/apps/workers/config.ts": {
    reads: 2,
    reason:
      "the instance's own address for the Workers executor's and the sandbox service's bridge calls, not a link shown to anyone",
  },
  "modules/notifications/devices.ts": {
    reads: 2,
    reason: "origin binding: the server identity a device registers against, not a link",
  },
  "modules/push/sender.ts": {
    reads: 1,
    reason: "origin binding: the server identity a push carries, not a link",
  },
  "modules/provisioning/setup-kickoff.ts": {
    reads: 1,
    reason: "origin binding: compares the instance with the demo host, builds no link",
  },
  "modules/demo/demo-turnstile.ts": {
    reads: 1,
    reason: "origin binding: the hostname a captcha answer must name, not a link",
  },
  "modules/liaison-team/bug-report-payload.ts": {
    reads: 1,
    reason: "origin binding: scrubs the instance host out of a report, builds no link",
  },
}

function productionTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue
      out.push(...productionTsFiles(full))
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.includes(".test-fixtures.")
    ) {
      const rel = path.relative(srcDir, full).split(path.sep).join("/")
      if (EXCLUDED_SEGMENTS.some((seg) => `/${rel}`.includes(seg))) continue
      out.push(full)
    }
  }
  return out
}

/** Code reads: `env.BASE_URL`, `process.env.BASE_URL`, `e.BASE_URL`, `["BASE_URL"]`, same for ALLOWED_ORIGINS. */
const READ_RE = /\.(?:BASE_URL|ALLOWED_ORIGINS)\b|\[\s*["'`](?:BASE_URL|ALLOWED_ORIGINS)["'`]\s*\]/g

/** Blanks the contents of "..." and '...' literals, keeping every column where it was. */
function blankQuoted(line: string): string {
  const blank = (m: string) => m[0] + " ".repeat(m.length - 2) + m[m.length - 1]
  return line.replace(/"(?:[^"\\]|\\.)*"/g, blank).replace(/'(?:[^'\\]|\\.)*'/g, blank)
}

/**
 * Each line's code with comments cut away (whole-line, block, trailing `//`),
 * so prose never counts as a read. Comment markers are looked for with quoted
 * strings blanked, so `"https://"` or `"image/*"` open no comment.
 */
export function codeLines(source: string): { line: number; code: string }[] {
  const out: { line: number; code: string }[] = []
  let inBlock = false
  source.split("\n").forEach((raw, i) => {
    const masked = blankQuoted(raw)
    let kept = ""
    let at = 0
    while (at < raw.length) {
      if (inBlock) {
        const end = masked.indexOf("*/", at)
        if (end === -1) {
          at = raw.length
          break
        }
        at = end + 2
        inBlock = false
        continue
      }
      const open = masked.indexOf("/*", at)
      const line = masked.indexOf("//", at)
      if (line !== -1 && (open === -1 || line < open)) {
        kept += raw.slice(at, line)
        break
      }
      if (open === -1) {
        kept += raw.slice(at)
        break
      }
      kept += raw.slice(at, open)
      at = open + 2
      inBlock = true
    }
    if (kept.trim().startsWith("*")) return
    out.push({ line: i + 1, code: kept })
  })
  return out
}

export function baseUrlReads(source: string): number[] {
  const lines: number[] = []
  for (const { line, code } of codeLines(source)) {
    for (const _ of code.matchAll(READ_RE)) lines.push(line)
  }
  return lines
}

describe("no raw BASE_URL / ALLOWED_ORIGINS link building", () => {
  const found = new Map<string, number[]>()
  for (const file of productionTsFiles(srcDir)) {
    const rel = path.relative(srcDir, file).split(path.sep).join("/")
    if (rel === HELPER) continue
    const reads = baseUrlReads(fs.readFileSync(file, "utf8"))
    if (reads.length > 0) found.set(rel, reads)
  }

  it("every read outside the helper is allowlisted, with its count", () => {
    const violations: string[] = []
    for (const [rel, lines] of found) {
      const allowed = ALLOWLIST[rel]
      if (!allowed) {
        violations.push(
          ...lines.map(
            (l) =>
              `${rel}:${l} reads BASE_URL/ALLOWED_ORIGINS: build the link with orgPublicBaseUrl`,
          ),
        )
      } else if (lines.length > allowed.reads) {
        violations.push(
          `${rel}: ${lines.length} reads (lines ${lines.join(", ")}), allowlisted ${allowed.reads}: build the link with orgPublicBaseUrl`,
        )
      }
    }
    expect(violations).toEqual([])
  })

  it("the allowlist holds no stale entry", () => {
    const stale = Object.entries(ALLOWLIST)
      .filter(([rel, { reads }]) => (found.get(rel)?.length ?? 0) !== reads)
      .map(
        ([rel, { reads }]) => `${rel}: allowlisted ${reads}, found ${found.get(rel)?.length ?? 0}`,
      )
    expect(stale).toEqual([])
  })

  it("every allowlist entry gives a reason", () => {
    for (const { reason } of Object.values(ALLOWLIST)) expect(reason.length).toBeGreaterThan(10)
  })

  it("catches a raw link and ignores prose", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source text under test
    expect(baseUrlReads("const u = `${env.BASE_URL}/x`")).toEqual([1])
    expect(baseUrlReads('const u = new URL("/x", env.BASE_URL)')).toEqual([1])
    expect(baseUrlReads('const u = process.env["BASE_URL"]')).toEqual([1])
    expect(baseUrlReads("// built from env.BASE_URL\n/* env.BASE_URL */\n * env.BASE_URL")).toEqual(
      [],
    )
    expect(baseUrlReads('const a = "https://x"; const b = env.BASE_URL // env.BASE_URL')).toEqual([
      1,
    ])
    expect(baseUrlReads('const t = "image/*"\nconst u = env.BASE_URL')).toEqual([2])
    expect(baseUrlReads('const o = env.ALLOWED_ORIGINS.split(",")[0]')).toEqual([1])
  })
})
