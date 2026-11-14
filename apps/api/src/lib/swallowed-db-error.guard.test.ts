// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Ratchet: every `catch` in apps/api/src that inspects a unique violation
// (SQLSTATE 23505) must be a reviewed site on the allowlist below.
//
// The bug class. Postgres aborts the WHOLE transaction on the first failed
// statement. A helper that runs inside its caller's transaction, catches the
// 23505 and returns a typed result (`{ added: false }`, `name_exists`, ...)
// hands back a transaction on which every later statement fails with 25P02
// "current transaction is aborted" (prod: grantUserScope caught 23505, then
// decideScopeRequest's UPDATE on the same tx answered 500).
//
// A catch that inspects 23505 is only correct when one of these holds:
//   - savepoint: the failing statement ran inside its own nested
//     `tx.transaction(...)` (a SAVEPOINT), and the catch sits OUTSIDE it, so
//     only the savepoint rolled back;
//   - own-tx-ends: the catch sits outside a transaction the same function
//     opened (withRlsContext / withPrivilegedDb / withSystemDb / withRequestRls),
//     so that transaction is already over;
//   - rethrows: the catch only maps the error and throws, so no caller keeps
//     using the transaction.
// Better still is not raising the error at all: `.onConflictDoNothing()` /
// `ON CONFLICT DO NOTHING` on the real unique index, then branch on the
// empty RETURNING.
//
// The behavioural proof for the fixed sites is swallowed-db-error.tx.test.ts.

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import ts from "typescript"

const SRC = resolve(import.meta.dir, "..")

type Why = "savepoint" | "own-tx-ends" | "rethrows"

interface AllowlistEntry {
  file: string
  function: string
  why: Why
  note: string
}

const ALLOWLIST: AllowlistEntry[] = [
  // --- savepoint: the fallible statement runs in its own nested tx.transaction() ---
  {
    file: "modules/agent/directory/personal-agent.ts",
    function: "insertPersonalAgentWithFreeHandle",
    why: "savepoint",
    note: "Each handle attempt inserts inside tx.transaction(); the retry runs on the live outer tx.",
  },
  {
    file: "apps/projects/service/create-project.ts",
    function: "insertProjectWithKey",
    why: "savepoint",
    note: "Each key candidate inserts inside tx.transaction(); the retry runs on the live outer tx.",
  },
  {
    file: "modules/threads/participant.ts",
    function: "addParticipant",
    why: "savepoint",
    note: "Callers pass a tx (withRequestRls), so db.transaction() is a savepoint; the catch sits outside it.",
  },
  {
    file: "modules/threads/participant.ts",
    function: "joinDiscoverableChannel",
    why: "savepoint",
    note: "Callers pass a tx (withRequestRls), so db.transaction() is a savepoint; the catch sits outside it.",
  },
  {
    file: "modules/auth/oauth.ts",
    function: "autoProvisionUser",
    why: "savepoint",
    note: "The users INSERT runs in its own tx.transaction(); the catch turns its 23505 into a typed refusal on a live tx.",
  },
  {
    file: "modules/contacts/service.ts",
    function: "resolveContact",
    why: "savepoint",
    note: "The contact INSERT runs in db.transaction(); the 409 leaves the caller's tx usable (mail sync catches it).",
  },
  {
    file: "modules/contacts/sharing.ts",
    function: "setContactSharing",
    why: "savepoint",
    note: "The org_access UPDATE runs in tx.transaction(); a 23505 (the org already has the address) becomes a thrown 409.",
  },
  {
    file: "apps/tickets/admin.ts",
    function: "templatesCreate",
    why: "savepoint",
    note: "The INSERT runs in tx.transaction(); a lost name race answers name_exists on a live tx.",
  },
  {
    file: "apps/tickets/admin.ts",
    function: "inboxesCreate",
    why: "savepoint",
    note: "Both INSERT branches run in tx.transaction(); inbox_email_taken / default_inbox_conflict on a live tx.",
  },
  {
    file: "apps/tickets/admin.ts",
    function: "inboxesUpdate",
    why: "savepoint",
    note: "Only default_inbox_conflict is answered, and only the savepointed set-default branch can raise it; other clashes rethrow.",
  },
  {
    file: "apps/tickets/create.ts",
    function: "createTicket",
    why: "savepoint",
    note: "Each attempt (ticket + initial message) runs in tx.transaction(); retries and the typed drop run on a live tx.",
  },
  // --- own-tx-ends: the catch sits outside a transaction this function opened ---
  {
    file: "modules/attention/subscriptions-routes.ts",
    function: "POST /",
    why: "own-tx-ends",
    note: "withRequestRls ended before the catch; maps to 409.",
  },
  {
    file: "modules/attention/subscriptions-routes.ts",
    function: "PUT /:id",
    why: "own-tx-ends",
    note: "withRequestRls ended before the catch; maps to 409.",
  },
  {
    file: "modules/auth/device-flow-routes.ts",
    function: "POST /initiate",
    why: "own-tx-ends",
    note: "Each attempt is its own withSystemDb; the retry opens a fresh transaction.",
  },
  {
    file: "modules/agent/tools/org-config-tools.ts",
    function: "handleCreateRole",
    why: "own-tx-ends",
    note: "withRlsContext ended before the catch.",
  },
  {
    file: "modules/agent/tools/admin-tools.ts",
    function: "handleEditRole",
    why: "own-tx-ends",
    note: "withRlsContext ended before the catch.",
  },
  {
    file: "modules/agent/tools/skills-routines-tools.ts",
    function: "handleCreateSkill",
    why: "own-tx-ends",
    note: "withPrivilegedDb ended before the catch.",
  },
  {
    file: "modules/agent/tools/skills-routines-tools.ts",
    function: "handleUpdateSkill",
    why: "own-tx-ends",
    note: "withPrivilegedDb ended before the catch.",
  },
  {
    file: "modules/agent/tools/skills-routines-tools.ts",
    function: "handleCreateRoutine",
    why: "own-tx-ends",
    note: "withPrivilegedDb ended before the catch.",
  },
  {
    file: "modules/agent/credits/credit-service.ts",
    function: "addCredits",
    why: "own-tx-ends",
    note: "withPrivilegedDb ended before the catch; the dedup reads open fresh transactions.",
  },
  {
    file: "modules/files/attach.ts",
    function: "attachFileToParent",
    why: "own-tx-ends",
    note: "deps.privileged insert tx ended before the catch; the winner re-read opens a fresh one.",
  },
  {
    file: "modules/webhooks/tickets-public.ts",
    function: "handleTicketCreate",
    why: "own-tx-ends",
    note: "withPrivilegedDb ended before the catch; the idempotent lookup opens a fresh one.",
  },
  {
    file: "modules/apps/execute-tool.ts",
    function: "executeToolCore",
    why: "own-tx-ends",
    note: "Maps a handler's DB error after the handler's transaction wrapper has rolled back.",
  },
  {
    file: "apps/mcp-manager/routes.ts",
    function: "POST /connections",
    why: "own-tx-ends",
    note: "withRlsContext ended before the catch; maps to 409 slug_conflict.",
  },
  {
    file: "modules/node-sessions/import.ts",
    function: "importStart",
    why: "own-tx-ends",
    note: "createNodeJob's withPrivilegedDb ended before the catch; the holder re-read opens a fresh one.",
  },
  {
    file: "modules/org/delete/ledger.ts",
    function: "createOrgDeletion",
    why: "own-tx-ends",
    note: "withSystemDb ended before the catch; maps to OrgDeletionOpenError and throws.",
  },
  {
    file: "modules/export/org-archive/store.ts",
    function: "createOrgExport",
    why: "own-tx-ends",
    note: "withPrivilegedDb ended before the catch; the active-export read opens a fresh one, then OrgExportRunningError is thrown.",
  },
  // --- rethrows: the catch only maps the error and throws ---
  {
    file: "modules/auth/auth.ts",
    function: "inviteRegisterTx",
    why: "rethrows",
    note: "Throws a sentinel so withSystemDb rolls back (the invite claim is undone); inviteRegister maps it.",
  },
  {
    file: "apps/projects/service/update-project.ts",
    function: "updateProjectWithOutcome",
    why: "rethrows",
    note: "Maps a key collision to ProjectsServiceError(409) and throws; the caller's tx rolls back.",
  },
  {
    file: "modules/app-builder/drafts.ts",
    function: "createDraft",
    why: "rethrows",
    note: "The insert runs in withReleasedSavepoint(); a live-base-name clash maps to DraftError(base_name_taken) and throws.",
  },
  {
    file: "modules/contacts/groups.ts",
    function: "createGroup",
    why: "rethrows",
    note: "The insert runs in db.transaction() (a savepoint under a caller's tx); a name clash maps to duplicateName and throws.",
  },
  {
    file: "modules/contacts/groups.ts",
    function: "renameGroup",
    why: "rethrows",
    note: "The update runs in db.transaction() (a savepoint under a caller's tx); a name clash maps to duplicateName and throws.",
  },
]

const EXCLUDED_DIRS = new Set(["node_modules", "tests"])

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue
      out.push(...sourceFiles(join(dir, entry.name)))
      continue
    }
    if (!/\.ts$/.test(entry.name) || /\.test\.ts$/.test(entry.name)) continue
    if (entry.name === "test-helpers.ts" || entry.name.endsWith(".d.ts")) continue
    out.push(join(dir, entry.name))
  }
  return out
}

/** Calls that classify a DB error as a unique violation (local helpers included). */
const UNIQUE_CLASSIFIER = /^(isUniqueViolation\w*|inboxUniqueViolation|callerSafeDbError)$/

/** True when the catch block (code only, comments ignored) inspects a unique violation. */
function inspectsUniqueViolation(block: ts.Block): boolean {
  let hit = false
  const visit = (n: ts.Node): void => {
    if (hit) return
    if (
      (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) &&
      (n.text === "23505" || n.text.includes("duplicate key") || n.text === "unique_violation")
    ) {
      hit = true
      return
    }
    if (ts.isCallExpression(n)) {
      const callee = ts.isIdentifier(n.expression)
        ? n.expression.text
        : ts.isPropertyAccessExpression(n.expression)
          ? n.expression.name.text
          : ""
      if (UNIQUE_CLASSIFIER.test(callee)) {
        hit = true
        return
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(block)
  return hit
}

const ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete"])

function enclosingFunctionName(node: ts.Node): string {
  for (let p: ts.Node | undefined = node; p; p = p.parent) {
    if ((ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p)) && p.name) return p.name.text
    if (ts.isMethodDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text
    if (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) {
      const parent = p.parent
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text
      if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text
    }
    if (
      ts.isCallExpression(p) &&
      ts.isPropertyAccessExpression(p.expression) &&
      ROUTE_METHODS.has(p.expression.name.text) &&
      p.arguments.length > 0 &&
      ts.isStringLiteral(p.arguments[0])
    ) {
      return `${p.expression.name.text.toUpperCase()} ${p.arguments[0].text}`
    }
  }
  return "<module scope>"
}

interface Site {
  file: string
  function: string
  line: number
}

/** Every catch clause in `text` that inspects a unique violation. */
export function scanSource(text: string, rel: string): Site[] {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const found: Site[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isCatchClause(n) && inspectsUniqueViolation(n.block)) {
      found.push({
        file: rel,
        function: enclosingFunctionName(n),
        line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1,
      })
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return found
}

function census(): Site[] {
  return sourceFiles(SRC).flatMap((f) => scanSource(readFileSync(f, "utf8"), relative(SRC, f)))
}

const key = (s: { file: string; function: string }) => `${s.file}::${s.function}`
const ALLOWED = new Set(ALLOWLIST.map(key))

const CLASS_EXPLAINED =
  "A catch that inspects a unique violation (23505) and then lets execution continue leaves the " +
  "transaction ABORTED: every later statement on it fails with 25P02 'current transaction is " +
  "aborted' (prod: grantUserScope -> decideScopeRequest 500). Fix it with ONE of: " +
  "(1) `.onConflictDoNothing()` / `ON CONFLICT DO NOTHING` on the real unique index and branch on " +
  "the empty RETURNING, so no error is raised; or (2) run the fallible statement in its own " +
  "SAVEPOINT (`await tx.transaction(async (sp) => ...)`, see personal-agent.ts) with the catch " +
  "OUTSIDE it. Then prove it in swallowed-db-error.tx.test.ts (conflict, then another statement " +
  "on the same tx) and add the site to ALLOWLIST in this file with why = savepoint | own-tx-ends | " +
  "rethrows."

describe("swallowed unique-violation ratchet", () => {
  it("every catch that inspects 23505 is a reviewed, allowlisted site", () => {
    const unlisted = census().filter((s) => !ALLOWED.has(key(s)))
    const report = unlisted.map((s) => `  ${s.file}:${s.line} (${s.function})`).join("\n")
    expect(unlisted, `${CLASS_EXPLAINED}\n\nUnlisted sites:\n${report}`).toEqual([])
  })

  it("every allowlist entry still matches a live site (the list only shrinks)", () => {
    const live = new Set(census().map(key))
    const stale = ALLOWLIST.filter((e) => !live.has(key(e))).map(key)
    expect(stale, "Remove allowlist entries whose catch is gone").toEqual([])
  })

  it("never allowlists the permission-grant helpers (they must use ON CONFLICT)", () => {
    expect(ALLOWLIST.filter((e) => e.file === "modules/permissions/roles.ts")).toEqual([])
    expect(census().filter((s) => s.file === "modules/permissions/roles.ts")).toEqual([])
  })

  it("bites: a planted catch-and-continue site is found and is not allowlisted", () => {
    const planted = `
      export async function grantThing(tx: any) {
        try {
          await tx.insert(things).values({ id: 1 })
        } catch (err: any) {
          // a comment naming 23505 must not be what makes this match
          if (err?.cause?.code === "23505") return { added: false }
          throw err
        }
        return { added: true }
      }
      export const viaHelper = async (tx: any) => {
        try { await tx.execute("x") } catch (e) { if (isUniqueViolationOn(e, ["i"])) return null; throw e }
      }
      export async function commentOnly(tx: any) {
        try { await tx.execute("x") } catch (e) { /* 23505 */ throw e }
      }
    `
    const sites = scanSource(planted, "modules/fake/planted.ts")
    expect(sites.map((s) => s.function)).toEqual(["grantThing", "viaHelper"])
    expect(sites.filter((s) => !ALLOWED.has(key(s))).length).toBe(2)
  })
})
