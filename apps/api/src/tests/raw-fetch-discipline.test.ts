// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Outbound-call discipline guard. Every server-side outbound HTTP call should
// go through the SSRF-safe helper in `lib/outbound-fetch.ts`
// (validateOutboundUrl / fetchWithPinnedHost / fetchWithRedirectValidation),
// which enforces scheme, blocks private/loopback/link-local targets, pins DNS,
// and re-validates redirects. A bare `fetch(` in production code bypasses all
// of that and is how SSRF holes creep back in.
//
// This test fails when a raw `fetch(` call appears in `apps/api/src` outside
// the helper itself, unless the file is on the allowlist below. The allowlist
// captures today's legitimate raw fetches; each entry must have a technical
// justification. When adding a new outbound call, route it through the helper
// rather than extending this list.

import { describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"

const srcDir = path.resolve(__dirname, "..")

// Directory segments that hold test scaffolding / fixtures (Bun.serve handlers,
// mock servers). Their `fetch(` occurrences are server handler methods or test
// stubs, not production outbound calls.
const EXCLUDED_SEGMENTS = [
  "/tests/",
  "/__test-helpers__/",
  "/fixtures/",
  "/__fixtures__/",
  "/test-helpers/",
]

function findProductionTsFiles(dir: string): string[] {
  const results: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue
      results.push(...findProductionTsFiles(full))
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      const normalized = `/${path.relative(srcDir, full).split(path.sep).join("/")}`
      if (EXCLUDED_SEGMENTS.some((seg) => normalized.includes(seg))) continue
      results.push(full)
    }
  }
  return results
}

// Matches a real `fetch(` call: `fetch` preceded by start-of-token (not a
// member access like `.fetch(` and not part of a longer identifier such as
// `fetchWithPinnedHost`). `(?<![.\w])fetch\s*\(` would be ideal but lookbehind
// support varies; emulate by capturing the preceding char.
const RAW_FETCH_RE = /(^|[^.\w])fetch\s*\(/

// The bare-`fetch(` regex above deliberately excludes a leading `.`, which means
// it skips member-access forms. `globalThis.fetch(` is exactly such a form yet is
// the same un-pinned global egress as `fetch(` — without this second pass a call
// written as `globalThis.fetch(userUrl)` would silently evade the guard. Catch it
// explicitly so the bypass pattern cannot reintroduce SSRF holes.
const GLOBALTHIS_FETCH_RE = /globalThis\.fetch\s*\(/

// PROSE IS NOT A CALL. A log message reading "made ZERO web_fetch calls -
// re-prompting once to fetch (anti-fabrication)" tripped this guard for an
// entire epic: the regex saw `fetch (` and could not tell a sentence from a
// call, so the only real oracle in the file was drowned by a false positive.
// Quoted strings are where prose lives, so their CONTENTS are blanked before
// matching; the quotes stay, so `fetch("http://x")` is still a call with an
// empty-looking argument. Backtick templates are deliberately left alone: they
// carry real code in `${...}`, and the one file that serves `fetch(` inside a
// template is browser script, allowlisted above for that reason.
//
// ORDER MATTERS, and it was wrong. Blanking single-quoted spans FIRST lets an
// apostrophe inside a DOUBLE-quoted string open a phantom span that runs to
// the next apostrophe anywhere on the line, swallowing whatever sits between
// them: `const a = "don't"; await fetch(u); const b = 'z'` came back with the
// call eaten and the guard read the line as clean. Double quotes are blanked
// first, so a `'` inside one is gone before it can open anything.
function stripStringLiterals(line: string): string {
  return line.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''")
}

// A line is a comment if its trimmed form starts with a comment marker. Block
// comments spanning lines are handled by the `*` / `/*` cases.
function isCommentLine(line: string): boolean {
  const t = line.trim()
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
}

describe("raw fetch discipline", () => {
  // Allowlist: files permitted to call `fetch(` directly. Each entry is a
  // deliberate, reviewed exception — extend only with a technical reason.
  const allowlist = new Set([
    // Public exchange-rate + model-pricing feeds (ECB, LiteLLM). Fixed,
    // operator-trusted public hosts pulled on a schedule; not user-influenced.
    "infra/jobs/sync-model-pricing.ts",
    // Provider API-key validation pings the LLM provider's own fixed base URL
    // to verify a key the operator just entered; host is provider-controlled.
    "modules/settings/ai-keys-routes.ts",
    // GitHub releases version check — fixed api.github.com (or operator-set
    // mirror) on a cached schedule; not request-influenced.
    "modules/admin/version-check.ts",
    // The `fetch(` occurrences here are inside an HTML/JS string SERVED TO THE
    // BROWSER (the OAuth consent page script) — they run client-side in the
    // user's browser against same-origin paths, not as a server outbound call.
    "modules/mcp/oauth-server-routes.ts",
    // `fetch(url, optsJson): Promise<string>` is the sandbox host-bridge
    // INTERFACE method signature, not an outbound call. The actual egress is
    // implemented in the carved-out rpc-bridge with its own allowlist guard.
    "apps/mail/handlers.ts",
    // Wraps `globalThis.fetch` only to attach a 30s timeout for the Gmail API
    // client (fixed provider host gmail.googleapis.com, reached with an OAuth
    // bearer); the request URL is constructed by the Gmail client against that
    // fixed base, not from user-controlled input. Reviewed exception — if this
    // ever takes a caller-supplied URL, route it through fetchWithPinnedHost.
    "apps/tickets/tools.ts",
    // The Patroni leader probe (SINGLETON_LEADER_URL). It dials the cluster's
    // own REST endpoint, which is a PRIVATE address by design: the SSRF helper
    // exists to refuse exactly that, so routing this through it would refuse
    // the probe and every process would read itself as not-leader.
    "infra/leadership.ts",
    // The Workers app executor posts each signed run to the operator's app loader
    // (LIAISON_APP_LOADER_URL + "/run"), a fixed deployment endpoint that may sit on
    // a private address beside the server; no app, org or user input reaches the URL.
    "modules/apps/workers/executor.ts",
    // APNs and FCM. `fetch` under Bun speaks HTTP/2, which APNs REQUIRES; the
    // pinned-host helper dials undici's fetch by resolved IP, which drops to
    // HTTP/1.1 and would break push outright. Fixed provider hosts, URLs built
    // internally from the token row, never from user input.
    "modules/push/transport.ts",
    // `fetch(url, optsJson): Promise<string>` is the sandbox host-bridge
    // INTERFACE method signature, exactly as in apps/mail/handlers.ts above:
    // the egress is the rpc-bridge's, with its own allowlist guard.
    "apps/calendar/handlers.ts",
    // A debug-only passthrough, gated on LIAISON_DEBUG_GEMINI_REQ: it logs the
    // request the AI SDK built and hands the SDK's own input straight back to
    // `fetch`. Same reviewed shape as the Gmail wrapper above, one step
    // smaller: it constructs no URL of its own at all.
    "modules/agent/providers/provider.ts",
    // The demo box key guard (boxKeyGuardedFetch) is the `fetch` the AI SDK's
    // OpenRouter provider calls: it checks the JSON body and hands the SDK's
    // own request on. The URL is the SDK's, built from openRouterBaseURL()
    // (OPENROUTER_BASE_URL, operator env, or the fixed openrouter.ai default),
    // and the guard only wraps the deployment's own box key; no user or org
    // setting reaches it. The file's other egress goes through fetchWithPinnedHost.
    "modules/agent/providers/openrouter.ts",
    // ResendEmailProvider's default fetch impl posts to the fixed managed
    // transactional API host (api.resend.com) with an operator-configured key;
    // the URL is built internally against that fixed base, not user-influenced.
    "infra/email.ts",
    // The setup CLI's site crawler, run by the operator on their own machine
    // (not by the server). Each hop, redirects included, goes through its own
    // assertPublicHost check, and private hosts need --allow-private-network.
    "cli/setup/crawl-site.ts",
    // A mailbox answer forwarded to the process that owns the request, at that
    // process's own internal listener URL (its instance-registry record, written
    // by the process itself at boot from its internal listener). A private
    // address by design, like the leader probe above, and signed with the
    // deployment's internal secret; no user or org input reaches the URL.
    "modules/agent/mailbox-plaintext/mailbox-forward.ts",
    // `fetch(range, query, options)` is the ImapFlow client INTERFACE method
    // (an IMAP FETCH command over the open client), not an HTTP call.
    "modules/apps/sandbox/imap-mailbox.ts",
    // The `fetch(` here is inside the Google Picker page's script SERVED TO THE
    // BROWSER, as in mcp/oauth-server-routes.ts: it posts the picked items to
    // the same-origin save URL from the user's browser, not from the server.
    "apps/google-drive/picker-page.ts",
  ])

  const files = findProductionTsFiles(srcDir)

  it("scanned a meaningful number of production source files", () => {
    // Sanity floor so a broken walk can't make the guard pass vacuously.
    expect(files.length).toBeGreaterThan(200)
  })

  it("no raw fetch( in apps/api/src outside outbound-fetch.ts and the allowlist", () => {
    const violations: Array<{ file: string; line: number; text: string }> = []
    for (const file of files) {
      const rel = path.relative(srcDir, file).split(path.sep).join("/")
      if (rel === "lib/outbound-fetch.ts") continue
      if (allowlist.has(rel)) continue
      const lines = fs.readFileSync(file, "utf-8").split("\n")
      lines.forEach((line, idx) => {
        if (isCommentLine(line)) return
        const code = stripStringLiterals(line)
        if (RAW_FETCH_RE.test(code) || GLOBALTHIS_FETCH_RE.test(code)) {
          violations.push({ file: rel, line: idx + 1, text: line.trim() })
        }
      })
    }
    if (violations.length > 0) {
      const detail = violations.map((v) => `  ${v.file}:${v.line}  ${v.text}`).join("\n")
      throw new Error(
        `Raw fetch( found in production code — route through lib/outbound-fetch.ts ` +
          `or add to the reviewed allowlist:\n${detail}`,
      )
    }
    expect(violations).toEqual([])
  })

  // STALENESS. "No raw fetch outside the list" is only half a guard: an entry
  // whose file no longer calls fetch at all is a standing permission nobody
  // reviewed, and the day that file dials out again the list waves it through.
  // The sibling oracles assert this (approvals/authority-closure,
  // threads/message-writes-tagged); this one now does too.
  const rawFetchLines = (rel: string): number[] => {
    const lines = fs.readFileSync(path.join(srcDir, rel), "utf-8").split("\n")
    const hits: number[] = []
    lines.forEach((line, idx) => {
      if (isCommentLine(line)) return
      const code = stripStringLiterals(line)
      if (RAW_FETCH_RE.test(code) || GLOBALTHIS_FETCH_RE.test(code)) hits.push(idx + 1)
    })
    return hits
  }

  it("every allowlisted file still exists", () => {
    const missing = [...allowlist].filter((rel) => !fs.existsSync(path.join(srcDir, rel)))
    expect(missing).toEqual([])
  })

  it("every allowlisted file still calls fetch( (no stale exemptions)", () => {
    const stale: string[] = []
    for (const rel of allowlist) {
      if (!fs.existsSync(path.join(srcDir, rel))) continue
      if (rawFetchLines(rel).length === 0) stale.push(rel)
    }
    expect(stale).toEqual([])
  })

  it("the guard catches globalThis.fetch( (the member-access bypass)", () => {
    const matches = (line: string) => RAW_FETCH_RE.test(line) || GLOBALTHIS_FETCH_RE.test(line)

    // The exact bypass form must be flagged.
    expect(matches("const r = globalThis.fetch(url)")).toBe(true)
    expect(matches("  await globalThis.fetch(input, init)")).toBe(true)
    expect(matches("globalThis.fetch (url)")).toBe(true)

    // Bare raw fetch( still flagged (regression guard for the original regex).
    expect(matches("const r = await fetch(url)")).toBe(true)
    expect(matches("fetch(url)")).toBe(true)
  })

  it("the guard reads prose inside a string as prose, not as a call", () => {
    const matches = (line: string) => {
      const code = stripStringLiterals(line)
      return RAW_FETCH_RE.test(code) || GLOBALTHIS_FETCH_RE.test(code)
    }

    // The real line that made this guard red for an epic.
    expect(
      matches(
        '        "routine guard: tick made ZERO web_fetch calls - re-prompting to fetch (x)",',
      ),
    ).toBe(false)
    expect(matches("      const message = 'ask it to fetch (once)'")).toBe(false)

    // AN APOSTROPHE INSIDE A DOUBLE-QUOTED STRING DOES NOT EAT THE CALL AFTER
    // IT. Both lines are measured: with the single-quote pass running first,
    // the apostrophe opened a span that ran to the next `'` on the line and
    // the `fetch(` between them disappeared.
    expect(matches(`const a = "don't"; await fetch(u); const b = 'z'`)).toBe(true)
    expect(matches(`if (x) { log("user's url"); return fetch(u) } else { return 'no' }`)).toBe(true)

    // And a real call whose argument is a string is still a call.
    expect(matches('const r = await fetch("https://example.com")')).toBe(true)
    expect(matches("const r = await fetch('https://example.com')")).toBe(true)
  })

  it("the guard does not flag the SSRF-safe helper or unrelated .fetch members", () => {
    const matches = (line: string) => RAW_FETCH_RE.test(line) || GLOBALTHIS_FETCH_RE.test(line)

    // Helper calls and longer identifiers are not raw fetch.
    expect(matches("await fetchWithPinnedHost(url)")).toBe(false)
    expect(matches("await fetchWithRedirectValidation(url)")).toBe(false)
    // Non-globalThis member access (a wrapped client) is allowed — only the
    // global egress is the SSRF surface this guard polices.
    expect(matches("await client.fetch(url)")).toBe(false)
    expect(matches("await this.fetch(url)")).toBe(false)
  })
})
