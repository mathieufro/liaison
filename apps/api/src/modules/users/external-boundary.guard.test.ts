// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Privileged code is not narrowed by the policy that hides an external user from
// members, so a job that walks kernel.users on a privileged handle would mail, list
// or assign a client without a word. Every file that reaches the table that way
// says here what it does about external rows. A new one fails until it does.

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

type Treatment =
  /** Filters user_type or refuses an external row itself. */
  | "member-filter"
  /** Rows by an id the flow already holds, or checks that ids exist. Lists nobody. */
  | "one-row"
  /** Joins for a name or a status on ids a stored record names. */
  | "stored-ids"
  /** A member sign-in door: filters user_type where the portal's sign-in lands. */
  | "sign-in-door"
  /** Finds a person by address: a client's address must not resolve to a member action. */
  | "by-address"
  /** Walks the org's people: needs the member filter before a real client row exists. */
  | "walks-org"
  /** Writes new member rows (the column's default) for an org being set up. */
  | "creates-member"

const SRC = join(import.meta.dir, "..", "..")

const TREATED: Record<string, [Treatment, string]> = {
  "apps/database/domain-access-store.ts": [
    "one-row",
    "checks that configured ids exist in the org",
  ],
  "apps/knowledge/import-kind.ts": ["by-address", "an imported document's author"],
  "apps/projects/import-kind.ts": [
    "by-address",
    "an import's assignee, through imports/authority.ts",
  ],
  "apps/tickets/backlog-health.ts": ["stored-ids", "the name of a ticket's assignee"],
  "apps/tickets/close-silent.ts": ["one-row", "checks a closer's id"],
  "apps/tickets/create.ts": ["one-row", "checks a named id"],
  "apps/tickets/import-kind.ts": ["by-address", "an imported ticket's assignee"],
  "apps/tickets/search.ts": ["stored-ids", "a ticket assignee's name"],
  "apps/tickets/sla-report.ts": ["stored-ids", "the name of a ticket's assignee"],
  "apps/tickets/tools.ts": ["one-row", "the id a tool names"],
  "cli/agent/ask.ts": ["member-filter", "refuses an external row before it mints"],
  "cli/approval-reminders.ts": ["one-row", "the id an operator names"],
  "cli/connect/index.ts": ["walks-org", "the oldest active row as a connection's owner"],
  "cli/contacts/privatize-mailbox-senders.ts": ["stored-ids", "a mailbox owner's name"],
  "cli/invoicing/import.ts": ["walks-org", "the oldest active row as an import's actor"],
  "cli/lib/resolve-member.ts": [
    "by-address",
    "the address an operator names; ask refuses a client",
  ],
  "cli/projects/attach-files.ts": ["by-address", "the address an operator's file names"],
  "cli/projects/import.ts": ["by-address", "an imported task's assignee"],
  "cli/provisioners/admin.ts": ["by-address", "the admin address of the org's config file"],
  "cli/provisioners/database-domain-access.ts": [
    "by-address",
    "the addresses of the org's config file",
  ],
  "cli/provisioners/users.ts": ["by-address", "the addresses of the org's config file"],
  "cli/slack/import.ts": [
    "by-address",
    "an import's mapped people, placeholders created as members",
  ],
  "cli/tickets/backfill-attachments.ts": [
    "walks-org",
    "the oldest active row as a backfill's actor",
  ],
  "cli/tickets/import.ts": ["walks-org", "the oldest active row as an import's actor"],
  "cli/tickets/inbox.ts": ["walks-org", "the oldest active row as an inbox's creator"],
  "cli/tour/run.ts": ["one-row", "the locale of the id an operator names"],
  "lib/server.ts": ["one-row", "the name of the socket's own user"],
  "lib/settings.ts": ["one-row", "one user's settings"],
  "modules/agent/context/context.ts": ["stored-ids", "the actor's own row and an agent's owner"],
  "modules/agent/context/shared-thread-audience.ts": ["stored-ids", "a thread's participants"],
  "modules/agent/credits/credit-routes.ts": ["stored-ids", "the names on usage rows"],
  "modules/agent/credits/managed-side-call.ts": [
    "member-filter",
    "the member a system side call is billed to",
  ],
  "modules/agent/directory/definition-routes.ts": ["stored-ids", "a thread's participants"],
  "modules/agent/directory/personal-agent.ts": ["one-row", "the caller's own agent"],
  "modules/agent/local-sessions/local-session-routes.ts": [
    "stored-ids",
    "a holder's or a run's names",
  ],
  "modules/agent/memory/memory-search.ts": ["stored-ids", "a message author's name"],
  "modules/agent/routines/routine-worker.ts": [
    "walks-org",
    "a shared routine's thread adds every active row",
  ],
  "modules/agent/runtime/turn-resume.ts": ["one-row", "the turn's actor"],
  "modules/agent/scopes/known-guests.ts": [
    "by-address",
    "an address on the org's rows reads as known",
  ],
  "modules/agent/scopes/taint-approval-audience.ts": [
    "walks-org",
    "loads every row's permissions for an audience",
  ],
  "modules/agent/subruns/spawn-agent.ts": ["walks-org", "any one row as a fallback actor"],
  "modules/agent/subruns/subrun-worker.ts": ["walks-org", "any one row as a fallback actor"],
  "modules/agent/tools/admin-tools.ts": ["one-row", "the id or invited address an admin names"],
  "modules/agent/tools/chat-tools.ts": [
    "stored-ids",
    "message authors and a thread's participants",
  ],
  "modules/agent/tools/connection-tools.ts": ["one-row", "the actor's name"],
  "modules/agent/tools/kernel-tools.ts": ["one-row", "the merge tool's declared write table"],
  "modules/agent/tools/setup-guide-tools.ts": ["one-row", "the caller's locale"],
  "modules/agent/tools/skills-routines-tools.ts": ["one-row", "a routine's own actor"],
  "modules/approvals/attention.ts": [
    "stored-ids",
    "the names of the people a routed approval names",
  ],
  "modules/approvals/event-data.ts": ["stored-ids", "the decider's and requester's names"],
  "modules/approvals/list.ts": ["stored-ids", "the people an approval names"],
  "modules/approvals/prompt-materialize.ts": ["stored-ids", "an approval's notify list"],
  "modules/approvals/reminders.ts": ["stored-ids", "an approval's notify list"],
  "modules/approvals/routed-reminders.ts": ["stored-ids", "an approval's notify list"],
  "modules/approvals/route-world.ts": [
    "member-filter",
    "who on an approval's route is an active member; next in line by stored ids",
  ],
  "modules/apps/connections/connect-links.ts": ["by-address", "the address a connect link goes to"],
  "modules/apps/connections/disconnect-account.ts": ["stored-ids", "a connected account's owner"],
  "modules/apps/connections/service.ts": ["stored-ids", "a connected account's owner"],
  "modules/apps/kernel-bulk.ts": ["one-row", "the deactivation target an admin names"],
  "modules/apps/org-app-admin.ts": ["one-row", "checks that named ids exist in the org"],
  "modules/apps/outbound-placeholder-refusal.ts": ["one-row", "the caller's timezone"],
  "modules/apps/runtime.ts": ["walks-org", "an app's owner id, or the oldest row of the org"],
  "modules/apps/sandbox/bridge/tickets.ts": ["stored-ids", "an approval's requester"],
  "modules/apps/ui-bundle-routes.ts": [
    "one-row",
    "the org of the admin who approved an app's full access",
  ],
  "modules/attention/digest-jobs.ts": ["walks-org", "the org's admins by grant, for a digest"],
  "modules/attention/state-materializer.ts": ["walks-org", "materializes every active row"],
  "modules/attention/translator.ts": ["stored-ids", "the preferences of a recipient"],
  "modules/auth/admin-second-factor.ts": [
    "walks-org",
    "bumps every row's permission version, shows nothing",
  ],
  "modules/auth/auth-state.ts": ["one-row", "the token's user"],
  "modules/auth/auth.ts": ["sign-in-door", "login's lookup; every mint chooses by user_type"],
  "modules/auth/magic-link.ts": ["sign-in-door", "resolves a bare address"],
  "modules/auth/oauth-routes.ts": ["sign-in-door", "resolves a provider's address"],
  "modules/auth/routes.ts": [
    "sign-in-door",
    "password reset by address, and the session's own row",
  ],
  "modules/bug-reports/service.ts": ["one-row", "the reporter"],
  "modules/cloud/handoff.ts": ["member-filter", "the org's earliest active member admin"],
  "modules/cloud/lookup.ts": ["member-filter", "the workspaces an address is an active member of"],
  "modules/contacts/erasure.ts": ["walks-org", "who to tell of an erasure, by role"],
  "modules/database/routes.ts": ["walks-org", "the people a domain may be opened to"],
  "modules/demo/demo-pool.ts": ["one-row", "a demo org's own owner"],
  "modules/demo/demo-verification.ts": ["one-row", "a demo org's own visitor"],
  "modules/erasure/erase-user.ts": ["one-row", "the row being erased"],
  "modules/export/data-subject-export-tool.ts": ["by-address", "the subject's own personal agent"],
  "modules/export/org-archive/store.ts": ["stored-ids", "who asked for an export"],
  "modules/files/media-analysis-job.ts": ["walks-org", "any one row as a fallback actor"],
  "modules/files/origin.ts": ["stored-ids", "who uploaded a file"],
  "modules/imports/authority.ts": ["by-address", "an import's named people"],
  "modules/imports/kernel-kinds/agents.ts": ["by-address", "an imported agent's named owner"],
  "modules/imports/kernel-kinds/chat.ts": ["stored-ids", "the rows a run records for its undo"],
  "modules/imports/undo.ts": ["stored-ids", "the rows a run recorded"],
  "modules/liaison-team/payloads.ts": ["walks-org", "reports the instance's people"],
  "modules/mailbox-crypto/attachment-derivatives.ts": ["one-row", "the mailbox's own user"],
  "modules/mailbox-keys/encryption-mode-routes.ts": ["one-row", "the caller's own row"],
  "modules/mcp-client/env-bootstrapper.ts": ["walks-org", "any one row as a fallback owner"],
  "modules/mcp/connection-service.ts": ["member-filter", "refuses an external row at the mint"],
  "modules/nodes/attachments.ts": ["one-row", "checks that named ids exist in the org"],
  "modules/nodes/job-routes.ts": ["one-row", "a job holder's name"],
  "modules/nodes/routing.ts": ["one-row", "a computer owner's name"],
  "modules/notifications/mail-producer.ts": ["stored-ids", "a notification's recipient"],
  "modules/notifications/on-call.ts": ["stored-ids", "the on-call ids in the org's settings"],
  "modules/notifications/router.ts": ["stored-ids", "a notification's recipient"],
  "modules/notifications/routes.ts": ["walks-org", "the on-call picker lists active rows"],
  "modules/notifications/settings.ts": ["one-row", "the caller's own timezone"],
  "modules/org/caps.ts": ["member-filter", "seats count members only"],
  "modules/permissions/eligible-approvers.ts": ["member-filter", "approvers are members only"],
  "modules/permissions/permissions.ts": [
    "member-filter",
    "every-member grants are for members only",
  ],
  "modules/permissions/scope-holders.ts": ["walks-org", "resolves everyone holding a scope"],
  "modules/provisioning/config-export.ts": ["walks-org", "exports people with their roles"],
  "modules/provisioning/ensure-user.ts": ["creates-member", "the config file's people"],
  "modules/provisioning/legal-identity-grounding.ts": ["walks-org", "reads the org's addresses"],
  "modules/provisioning/setup-kickoff.ts": ["one-row", "the admin signing in"],
  "modules/provisioning/setup-state.ts": ["walks-org", "counts the org's people"],
  "modules/push/fanout-consumer.ts": ["stored-ids", "a push's recipients"],
  "modules/scope-requests/service.ts": ["one-row", "the requester's name"],
  "modules/secret-requests/service.ts": ["stored-ids", "the requester's name"],
  "modules/security/security-events.ts": ["one-row", "the org of a signal's user"],
  "modules/threads/entity-discussion.ts": [
    "member-filter",
    "seats active members only; a portal account is never enrolled",
  ],
  "modules/threads/message.ts": ["stored-ids", "authors and participants"],
  "modules/threads/participant.ts": ["one-row", "the ids a caller adds"],
  "modules/threads/routes.ts": ["one-row", "the id a caller names"],
  "modules/threads/thread.ts": ["one-row", "the ids a caller adds"],
  "modules/users/avatar-service.ts": ["one-row", "the caller's own row, or a public key"],
  "modules/users/external-user.ts": [
    "member-filter",
    "writes the external row, refuses a member's address",
  ],
  "modules/users/merge-placeholder.ts": ["one-row", "the placeholder being merged"],
  "modules/users/away.ts": [
    "member-filter",
    "people named by id, refused when external; the deciders list skips external users",
  ],
  "modules/users/service.ts": ["one-row", "reads run on RLS; the merge target by id"],
  "modules/webhooks/routes.ts": ["one-row", "the org of a verified webhook"],
  "seed/factories/org/rows.ts": ["creates-member", "seed data"],
  "seed/factories/people/people.ts": ["creates-member", "seed data"],
  "seed/tiers/demo/seed-org.ts": ["creates-member", "seed data"],
  "seed/tiers/lively/seed-lively.ts": ["creates-member", "seed data"],
  "seed/tiers/minimal.ts": ["creates-member", "seed data"],
  "seed/tiers/standard/people.ts": ["creates-member", "seed data"],
  "seed/tiers/standard/seed-standard.ts": ["creates-member", "seed data"],
  "seed/world/people.ts": ["creates-member", "seed data"],
}

const PRIVILEGED_HANDLE =
  /\b(withPrivilegedDb|withSystemDb|withSchemaAdmin|withElevatableRlsFrom|PrivilegedDb)\b|\bctx\.sys\(|import \{[^}]*\bsql\b[^}]*\} from "~\/db(\/connection)?"/

/** Whole-line comments only: a path like "/api/*" in a string is no comment. */
function withoutComments(source: string): string {
  return source.replace(/^\s*\/\*[\s\S]*?\*\//gm, "").replace(/^\s*\/\/.*$/gm, "")
}

const RAW_REFERENCE =
  /\bkernel\.users\b|\$\{\s*\w+\s*\}\.users\b|\$\{\s*schemaRef\(\s*"kernel"\s*\)\s*\}\.users\b|\bkernelRel\(\s*"users"\s*\)|\brel\(\s*"kernel",\s*"users"\s*\)/

/** True when this source reaches kernel.users and holds a handle that RLS does not narrow. */
export function reachesUsersPrivileged(source: string): boolean {
  const code = withoutComments(source)
  if (!PRIVILEGED_HANDLE.test(code)) return false
  if (RAW_REFERENCE.test(code)) return true
  // The drizzle table under its own name or the name it is imported as.
  const aliases = [...code.matchAll(/\busers(?: as |: )(\w+)/g)].map((m) => m[1] as string)
  const names = ["users", ...aliases].join("|")
  return new RegExp(
    `\\.(from|join|leftJoin|innerJoin|rightJoin|fullJoin|update|insert|delete)\\(\\s*(${names})\\b`,
  ).test(code)
}

function isProductionSource(entry: string): boolean {
  return (
    entry.endsWith(".ts") &&
    !entry.endsWith(".test.ts") &&
    !entry.includes("test-fixtures") &&
    entry !== "test-helpers.ts"
  )
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      const skip = ["tests", "__fixtures__", "migrations", "test-helpers", "node_modules"]
      if (!skip.includes(entry)) sourceFiles(path, out)
    } else if (isProductionSource(entry)) {
      out.push(path)
    }
  }
  return out
}

const reaching = sourceFiles(SRC)
  .filter((path) => reachesUsersPrivileged(readFileSync(path, "utf8")))
  .map((path) => relative(SRC, path))
  .sort()

describe("privileged readers of kernel.users", () => {
  it("a new privileged reader of kernel.users not listed fails", () => {
    expect(reaching.filter((file) => !(file in TREATED))).toEqual([])
  })

  it("the list names no file that stopped reaching the table", () => {
    expect(Object.keys(TREATED).filter((file) => !reaching.includes(file))).toEqual([])
  })

  it("a file treated as filtering really reads the person's type", () => {
    const unfiltered = Object.entries(TREATED)
      .filter(([, [treatment]]) => treatment === "member-filter")
      .map(([file]) => file)
      .filter((file) => !/userType|user_type/.test(readFileSync(join(SRC, file), "utf8")))
    expect(unfiltered).toEqual([])
  })

  it("every treatment gives its reason", () => {
    expect(Object.entries(TREATED).filter(([, [, reason]]) => reason.trim() === "")).toEqual([])
  })

  describe("what counts as reaching the table", () => {
    const privileged = `import { withSystemDb } from "~/db/privileged"\n`
    it.each([
      ["a drizzle read", `withSystemDb("x", (db) => db.select().from(users))`],
      ["a drizzle join", `tx.select().from(a).innerJoin(users, eq(a.id, users.id))`],
      ["a table under another name", `import { users as people } from "x"\ndb.update(people)`],
      ["a raw statement", "tx.execute(sql`SELECT id FROM kernel.users`)"],
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the source text under test
      ["a schema variable", "tx.execute(sql`SELECT id FROM ${K}.users u`)"],
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the source text under test
      ["a schema helper", 'tx.execute(sql`SELECT id FROM ${kernelRel("users")}`)'],
      ["a schema helper with two names", 'const u = rel("kernel", "users")'],
      ["a dynamic import's name", `const { users: people } = await x\ndb.select().from(people)`],
    ])("%s on a privileged handle reaches it", (_label, body) => {
      expect(reachesUsersPrivileged(privileged + body)).toBe(true)
    })

    it("the raw connection is a privileged handle too", () => {
      expect(
        reachesUsersPrivileged(`import { sql } from "~/db"\nsql\`SELECT * FROM kernel.users\``),
      ).toBe(true)
    })

    it("a path in a string is no comment that hides what follows", () => {
      const source = `${privileged}const a = "/api/*"\ndb.select().from(users)\nconst b = "*/"`
      expect(reachesUsersPrivileged(source)).toBe(true)
    })

    it("a read with no privileged handle does not, nor does a comment", () => {
      expect(reachesUsersPrivileged(`rlsTx.select().from(users)`)).toBe(false)
      expect(reachesUsersPrivileged(`${privileged}// reads kernel.users later\nf()`)).toBe(false)
    })
  })
})
