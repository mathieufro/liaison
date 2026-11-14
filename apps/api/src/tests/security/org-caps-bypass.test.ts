// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Per-org caps hold on every path that adds what they count, enumerated.
//
// The caps (modules/org/caps.ts) count seats (active `kernel.users`), mailboxes
// (mailbox `kernel.connected_accounts`) and storage (the bytes of
// `kernel.files`); jobs per hour only delay, never refuse (org-job-cap.ts), so
// there is no write to guard. Every source site that inserts a row of a counted
// table is found here (drizzle `.insert(table)` or SQL `INSERT INTO ...table`),
// with the function that encloses it, and must either check the cap in that
// function or be reviewed below with the reason it adds nothing the cap counts
// or is not reachable by an org member (operator CLIs, inbound mail from
// outside, demo seeding, erasure). An agent tool, a sandbox bridge method or an
// import that adds rows past a cap fails here, as does any new insert site.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const SRC = join(import.meta.dir, "..", "..")

type Cap = "seats" | "mailboxes" | "storage"

const TABLES: Record<Cap, { drizzle: string; sql: string }> = {
  seats: { drizzle: "users", sql: "users" },
  mailboxes: { drizzle: "connectedAccounts", sql: "connected_accounts" },
  storage: { drizzle: "files", sql: "files" },
}

/** What a function must call (or write) for its insert to count as cap-checked. */
const GUARDS: Record<Cap, RegExp> = {
  // An active seat checks the cap; an import placeholder or erasure sentinel
  // is inserted `deactivated` and counts as no seat.
  seats: /assertSeatRoom(Soft)?\(|'deactivated'|"deactivated"/,
  mailboxes: /assertMailboxRoom\(/,
  storage: /wouldExceedOrgQuota\(|orgQuotaBytes\(|attachFilesToParent\(|attachFileToParent\(/,
}

/** Reviewed insert sites (`file#function`) that need no cap check, and why. */
const REVIEWED: Record<string, string> = {
  // Operator command-line tools: the operator sets the caps.
  // Inbound mail and public ticket forms: content from outside the org, which
  // the org does not choose to store; counted in usage, never refused.
  "apps/tickets/inbound.ts#*": "inbound customer mail, never refused",
  "apps/tickets/link-ingest-job.ts#*": "inbound customer mail links, never refused",
  "modules/webhooks/tickets-public.ts#*": "public ticket form upload, never refused",
  // Demo instance seeding of its own throwaway orgs.
  "modules/demo/boxtal/connection.ts#*": "demo org seeding",
  "modules/demo/shopify/connection.ts#*": "demo org seeding",
  "modules/demo/api-connector/connection.ts#*": "demo org seeding",
  "modules/demo/warehouse/connection.ts#*": "demo org seeding",
  "modules/demo/worlds/saas/payments/connection.ts#*":
    "demo org seeding: a card-payments sentinel connection, not a mailbox",
  // The sign-up that CREATES an org: its first admin is the first seat of an
  // org that has no caps yet (caps are set by the operator afterwards).
  "modules/auth/auth.ts#bootstrapRegister":
    "first admin of the instance's first org, before any cap exists",
  // The check sits one step earlier: both callers store the object through
  // putTemplateObject, which refuses at the cap before the row is written.
  // modules/documents/templates.test.ts proves it for a new template and a new file.
  "modules/documents/service.ts#insertTemplateFile":
    "putTemplateObject checks the cap before this row",
  // A row written by the test harness's seed factory, with no object behind it.
  "seed/factories/files/file-row.ts#*": "test seed data, no org member reaches it",
  // A client's portal account (user_type external): countSeats counts members only,
  // so it takes no seat. modules/org/caps.test.ts proves it at a full cap.
  "modules/users/external-user.ts#createExternalUser":
    "a portal account, user_type external, counted as no seat",
  // Test seed factories: bare rows with a known id for a test, never a person's
  // or an agent's write (the product's paths are the ones under test).
  "seed/factories/org/rows.ts#seedUserRows": "test seed rows, not a product write",
  "seed/factories/org/platform-rows.ts#seedConnectedAccountRow":
    "test seed rows, not a product write",
}

/**
 * Open: sites that add storage without the cap check, pending their fix. The
 * list may only shrink; the test below asserts the whole set.
 */
const KNOWN_OPEN_STORAGE = new Set<string>([])

/**
 * Sites that check the storage cap but let some writes through it, through the
 * one exemption decision (`storageQuotaExemption`, modules/files/service.ts):
 * system work with no person and no agent acting, and a legal record's file.
 * Both signals come from the host (the bridge's own actor, the file parent's
 * registered retention), so an app or an agent cannot claim them. Any other
 * caller of the exemption, or a hand-written exemption value, fails below.
 */
const EXEMPTING_STORAGE_SITES: Record<string, string> = {
  "modules/apps/sandbox/bridge/files.ts":
    "inbound attachments stored by mail sync / system ingest, and legal-record files",
  "modules/pdf/render.ts": "PDFs rendered by system work, and legal originals (invoicing)",
}
const EXEMPTION_DECIDER = "modules/files/service.ts"

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (["node_modules", "tests", "__tests__", "__fixtures__", "test-helpers"].includes(name))
        continue
      sourceFiles(full, out)
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$|test-fixtures|test-helpers/.test(name)) {
      out.push(full)
    }
  }
  return out
}

const FUNCTION_START =
  /^\s*(export\s+)?(async\s+)?function\s*\*?\s*(\w+)|^\s*(export\s+)?const\s+(\w+)\s*=\s*(async\s*)?(\([^)]*\)\s*(:\s*[^=]+)?=>|function\b)|^\s{2,10}(\w+):\s*(\(\(\)\s*=>|async\s*\(|\(\s*\)\s*=>|async\s+function)|^\s{2,10}(async\s+)?(?!(?:if|for|while|switch|catch|return|await|else)\b)(\w+)\s*\([^)]*\)\s*(:\s*[^={]+)?\{\s*$/

interface Site {
  cap: Cap
  id: string
  guarded: boolean
}

/** Every insert site of a counted table, with its enclosing function and whether it checks the cap. */
function insertSites(): Site[] {
  const sites: Site[] = []
  for (const file of sourceFiles(SRC)) {
    const rel = relative(SRC, file)
    const lines = readFileSync(file, "utf8").split("\n")
    for (const [cap, t] of Object.entries(TABLES) as Array<
      [Cap, { drizzle: string; sql: string }]
    >) {
      const insert = new RegExp(
        `\\.insert\\(${t.drizzle}\\)|INSERT INTO\\s+[^\\s(]*?["\`.)}]?${t.sql}\\b|INSERT INTO\\s+${t.sql}\\b`,
      )
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line) || !insert.test(line)) return
        // The enclosing function: the nearest function start above whose block
        // is still open at the insert (braces opened minus closed > 0).
        let start = 0
        let name = "<module>"
        let balance = 0
        for (let j = i - 1; j >= 0; j--) {
          const l = lines[j] ?? ""
          balance += (l.match(/\{/g)?.length ?? 0) - (l.match(/\}/g)?.length ?? 0)
          const m = balance > 0 ? FUNCTION_START.exec(l) : null
          if (m) {
            start = j
            name = m[3] ?? m[5] ?? m[9] ?? m[12] ?? "<anonymous>"
            break
          }
        }
        // Code only: a guard named in a comment checks nothing.
        const body = lines
          .slice(start, Math.min(lines.length, i + 40))
          .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
          .map((l) => l.replace(/\s\/\/ .*$/, ""))
          .join("\n")
        sites.push({ cap, id: `${rel}#${name}`, guarded: GUARDS[cap].test(body) })
      })
    }
  }
  return sites
}

function reviewed(id: string): boolean {
  return id in REVIEWED || `${id.split("#")[0]}#*` in REVIEWED
}

function unguarded(cap: Cap): string[] {
  return [
    ...new Set(
      insertSites()
        .filter((s) => s.cap === cap && !s.guarded && !reviewed(s.id))
        .map((s) => s.id),
    ),
  ].sort()
}

describe("per-org caps hold on every path that adds what they count", () => {
  it("finds the insert sites of every counted table, guarded ones included", () => {
    const sites = insertSites()
    for (const cap of Object.keys(TABLES) as Cap[]) {
      expect(sites.filter((s) => s.cap === cap).length, cap).toBeGreaterThan(0)
      expect(sites.filter((s) => s.cap === cap && s.guarded).length, cap).toBeGreaterThan(0)
    }
  })

  it("every site that adds a seat checks the seat cap or adds no seat", () => {
    expect(unguarded("seats")).toEqual([])
  })

  it("every site that adds a mailbox checks the mailbox cap", () => {
    expect(unguarded("mailboxes")).toEqual([])
  })

  it("no reviewed entry is stale (each covers an insert site that has no cap check)", () => {
    const open = insertSites().filter((s) => !s.guarded)
    const files = new Set(open.map((s) => s.id.split("#")[0]))
    const ids = new Set(open.map((s) => s.id))
    for (const key of Object.keys(REVIEWED)) {
      const [file, fn] = key.split("#")
      expect(fn === "*" ? files.has(file ?? "") : ids.has(key), key).toBe(true)
    }
  })

  it("every site that adds storage outside the open list checks the storage cap", () => {
    expect(unguarded("storage").filter((id) => !KNOWN_OPEN_STORAGE.has(id))).toEqual([])
  })

  it("the open storage list holds only sites still open", () => {
    const open = new Set(unguarded("storage"))
    for (const id of KNOWN_OPEN_STORAGE) expect(open.has(id), id).toBe(true)
  })

  it("every site that adds storage checks the storage cap", () => {
    expect(KNOWN_OPEN_STORAGE.size).toBe(0)
    expect(unguarded("storage")).toEqual([])
  })

  it("storage cap exemptions are decided in one place and used only by reviewed sites", () => {
    const callers = new Set<string>()
    const literals: string[] = []
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file)
      const code = readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n")
      if (rel === EXEMPTION_DECIDER) continue
      if (/storageQuotaExemption\(/.test(code)) callers.add(rel)
      // An exemption value written by hand bypasses the decision.
      if (/["'`](system_ingest|legal_record)["'`]/.test(code)) literals.push(rel)
    }
    expect([...callers].sort()).toEqual(Object.keys(EXEMPTING_STORAGE_SITES).sort())
    expect(literals).toEqual([])
    // An exempting site still refuses everything else at the cap.
    for (const rel of callers) {
      expect(/wouldExceedOrgQuota\(/.test(readFileSync(join(SRC, rel), "utf8")), rel).toBe(true)
    }
  })
})
