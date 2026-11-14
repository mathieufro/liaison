// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every path that can CREATE a contact, enumerated from the source, with the
// audience it creates for. Adding a contact to the organisation is a person's
// choice (modules/sharing): no automated path (mail or calendar sync, ticket
// intake, an agent acting on its own, an import) may create an organisation
// contact. A new call site, or a changed audience, fails here until it is
// reviewed and listed.

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

const SRC = path.resolve(import.meta.dir, "../..")
const BUNDLED = path.resolve(SRC, "../../../bundled-apps")

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (name === "node_modules" || name === "tests" || name === "migrations") continue
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !/test-/.test(name)) {
      out.push(full)
    }
  }
  return out
}

/** The argument list of each call to `fn(` in `text`, as raw source. */
function callArgs(text: string, fn: string): string[][] {
  const calls: string[][] = []
  const re = new RegExp(`\\b${fn}\\(`, "g")
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (/function\s+$/.test(text.slice(Math.max(0, m.index - 16), m.index))) continue
    let depth = 1
    let i = m.index + m[0].length
    const args: string[] = []
    let start = i
    let quote: string | null = null
    for (; i < text.length && depth > 0; i++) {
      const c = text[i]
      if (quote) {
        if (c === "\\") i++
        else if (c === quote) quote = null
        continue
      }
      if (c === '"' || c === "'" || c === "`") quote = c
      else if ("([{".includes(c)) depth++
      else if (")]}".includes(c)) depth--
      if ((c === "," && depth === 1) || depth === 0) {
        const arg = text.slice(start, i).trim()
        if (arg) args.push(arg.replace(/\s+/g, " "))
        start = i + 1
      }
    }
    calls.push(args)
  }
  return calls
}

describe("contact creation paths", () => {
  const files = sourceFiles(SRC).map((f) => ({
    rel: path.relative(SRC, f),
    text: readFileSync(f, "utf8"),
  }))

  it("every resolveContact call names its audience, and only an explicit choice creates for the organisation", () => {
    const found: Record<string, string[]> = {}
    for (const { rel, text } of files) {
      if (rel === "modules/contacts/service.ts") continue
      const aliases = new Set<string>()
      const imp = /import\s*\{([^}]*)\}\s*from\s*"~\/modules\/contacts\/service"/g
      for (let m = imp.exec(text); m; m = imp.exec(text)) {
        for (const part of m[1].split(",")) {
          const [name, alias] = part.trim().split(/\s+as\s+/)
          if (name === "resolveContact") aliases.add(alias ?? name)
        }
      }
      for (const alias of aliases) {
        for (const args of callArgs(text, alias)) {
          found[rel] = [...(found[rel] ?? []), args[4] ?? "(missing)"]
        }
      }
    }
    expect(found).toEqual({
      // A person mail-discovered by the sync: the mailbox owner's alone.
      "modules/mail/sender-contacts.ts": [
        '{ audience: "owner", ownerUserId: account.ownerId as string }',
      ],
      // POST /api/contacts/resolve: the caller's own unless they choose "org".
      "modules/contacts/routes.ts": [
        'audience === "org" ? { audience: "org" } : { audience: "owner", ownerUserId: userId }',
      ],
      // contacts_write: the acting person's own (sharing is contacts_share).
      "modules/agent/tools/contact-tools.ts": ['{ audience: "owner", ownerUserId: ctx.userId }'],
      // Ticket intake (inbound mail, public form): link only, never create.
      "apps/tickets/inbound.ts": ['{ audience: "none" }'],
      "modules/webhooks/tickets-public.ts": ['{ audience: "none" }'],
      // Apps: link only, unless the admin-installed app declares
      // contacts.addToOrganisation (its customers are the team's).
      "modules/apps/sandbox/bridge/db.ts": ["appContactAudience(manifest.capabilities)"],
      "modules/apps/context.ts": [
        "appContactAudience(appBridgeManifest(orgId, appName)?.capabilities)",
      ],
      // The seed engine's contact factory: the audience its caller names. Test and demo data.
      "seed/factories/people/contacts.ts": ["target"],
    })
  })

  it("rows are inserted only by resolveContact, the shared-mailbox sender path and a ticket's audience contact", () => {
    const inserters = files
      .filter(({ text }) =>
        /\.insert\((contacts|contactsTable)\b|INSERT INTO[^\n;]*\bcontacts\b/.test(text),
      )
      .map(({ rel }) => rel)
      .sort()
    expect(inserters).toEqual(
      [
        // The contacts import kind (modules/imports): a person holding
        // kernel:imports:run and the kind's write scope chose to bring these
        // contacts into the organisation; create-only and undoable (A14).
        "apps/contacts/import-kind.ts",
        "modules/contacts/service.ts",
        "modules/mail/sender-contacts.ts",
        // The seed engine's volume writer: load data on a private box, never a real org.
        "seed/bulk/volume.ts",
        // Seeds fixtures for demo orgs only (never a real org).
        ...inserters.filter((f) => f.startsWith("modules/demo/")),
      ].sort(),
    )
    // A ticket's audience contact is inserted by kernel.ensure_audience_contact
    // (migration 0178), a SECURITY DEFINER function on the ticket's transaction.
    const audienceContact = files.find(({ rel }) => rel === "modules/contacts/audience-contact.ts")
    expect(audienceContact?.text).toContain(".ensure_audience_contact(")
    // The shared-mailbox path creates a RESTRICTED contact (granted to the
    // mailbox's members), never an organisation one.
    const sender = files.find((f) => f.rel === "modules/mail/sender-contacts.ts")!.text
    expect(sender).toMatch(/orgAccess: "none",\s+ownerUserId: null,\s+audienceKey: inbox/)
    // A ticket's address-only customer: restricted, owned, shared with the
    // ticket's team (kernel.ensure_audience_contact, migration 0178).
    const migration = readFileSync(
      path.join(SRC, "db/migrations/0178_request_login_split.sql"),
      "utf8",
    )
    const ensure = migration.slice(migration.indexOf("FUNCTION kernel.ensure_audience_contact("))
    expect(ensure).toMatch(/INSERT INTO kernel\.contacts[^;]*VALUES \([^;]*'none',/)
  })

  it("only the store, payments and invoicing apps may add their customers to the organisation", () => {
    const declaring = readdirSync(BUNDLED)
      .filter((app) => {
        try {
          const manifest = JSON.parse(
            readFileSync(path.join(BUNDLED, app, "app.manifest.json"), "utf8"),
          ) as { capabilities?: string[] }
          return manifest.capabilities?.includes("contacts.addToOrganisation")
        } catch {
          return false
        }
      })
      .sort()
    expect(declaring).toEqual(["invoicing", "shopify", "stripe"])
    for (const app of ["mail", "tickets", "calendar"]) {
      const manifest = JSON.parse(
        readFileSync(path.join(SRC, "apps", app, "app.manifest.json"), "utf8"),
      ) as { capabilities?: string[] }
      expect(manifest.capabilities ?? []).not.toContain("contacts.addToOrganisation")
    }
  })
})
