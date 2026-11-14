// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHAT THIS GUARD PROTECTS
//
// Liaison's OWN billing stays extracted from the product, and no payment
// vendor SDK enters it. The product's billing, credits and edition code is
// vendor-neutral: the managed edition's billing lives behind a control client,
// and the kernel schema carries no vendor columns.
//
// It does NOT ban the vendor's name everywhere. A bundled connector app that
// talks to the vendor's HTTP API through `ctx.fetch` is a customer-facing
// feature, not Liaison's billing, so its identifiers (scopes, tables, tool
// names, event names) and its test, harness, i18n and bench-corpus files may
// name the vendor. What is forbidden, and pinned below:
//   (a) the vendor's SDK in any package manifest or lockfile;
//   (b) an import of the vendor's SDK anywhere in the code;
//   (c) the vendor's name at all in the billing modules, the kernel credits
//       and organizations schema and the edition code;
//   (d) the vendor's name anywhere else, except as a connector identifier or
//       inside the connector's own test, harness, i18n and corpus files.
import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path, { resolve } from "node:path"

const REPO_ROOT = resolve(new URL("../../../..", import.meta.url).pathname)

// The extraction acceptance pattern. It is assembled at runtime from
// non-matching fragments so this test file itself does not contain a
// matching literal that would make the repo-wide grep red.
const FORBIDDEN = ["s", "t", "r", "i", "p", "e"].join("")
const FORBIDDEN_UPPER = FORBIDDEN.toUpperCase()

/**
 * CASE-SENSITIVE, and that is the whole fix.
 *
 * The first version of this grep ran `-i` on a bare six-letter alternative, so
 * it matched the first six characters of ANY identifier beginning with those
 * letters in any casing. `stripElements` (the desktop feature-detection test's
 * own DOM helper) is such an identifier, and the guard reported four matches in
 * a file that has nothing to do with billing. A guard that cries wolf on an
 * unrelated word is a guard people stop reading.
 *
 * Three alternatives replace the one, and together they are NOT weaker than
 * what they replace: the word on its own in either casing, the camelCase and
 * PascalCase compounds, and the screaming-case constants. What they no longer
 * do is match a lowercase `e` against an uppercase one, which is the only way
 * `stripElements` ever got in.
 */
// The ordinary English words that begin with the same six letters and are NOT
// the payment processor. Everything else the word is glued to is.
//
// Naming the compounds instead (client, key, api, secret, webhook, customer,
// charge, payment) was the wrong way round: it is an eight item guess at an
// open set, and every compound nobody thought of (checkout, invoice, token,
// elements, account, subscription, price, connect, refund) walked straight
// past the acceptance check. The set of benign English forms is closed and
// short, so it is the one worth enumerating.
const BENIGN_FORMS = ["d", "s", "r", "rs", "y"]

/**
 * A POSIX ERE fragment matching one or more lowercase letters EXCEPT the exact
 * strings in `benign`. `git grep -E` has no lookahead, so "anything but these"
 * is spelled out: a first letter that starts no benign ending, or a benign
 * ending that does not stop where the benign word does.
 */
function benignExcludingSuffixes(benign: string[]): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz".split("")
  const alts: string[] = []
  // A first letter that no benign ending starts with: already a compound.
  const heads = new Set(benign.map((w) => w[0]))
  alts.push(`[${alphabet.filter((c) => !heads.has(c)).join("")}]`)
  // A benign PREFIX followed by a letter that does not continue into a longer
  // benign ending: `stripers` is a fish, `stripersx` is the payment processor.
  const prefixes = new Set<string>()
  for (const word of benign) {
    for (let i = 1; i <= word.length; i++) prefixes.add(word.slice(0, i))
  }
  for (const prefix of [...prefixes].sort()) {
    const next = alphabet.filter((c) => !benign.includes(prefix + c))
    if (next.length === 0) continue
    alts.push(`${prefix}[${next.join("")}]`)
  }
  return `(${alts.join("|")})`
}

const V3_PATTERN = [
  // The word itself, in either casing, not glued to more letters:
  // `stripe`, `Stripe.`, `@stripe/stripe-js`, `"stripe"`, end of line.
  `[s${FORBIDDEN_UPPER[0]}]${FORBIDDEN.slice(1)}([^a-zA-Z]|$)`,
  // camelCase / PascalCase compounds: stripeCustomerId, StripeClient.
  `[s${FORBIDDEN_UPPER[0]}]${FORBIDDEN.slice(1)}[A-Z]`,
  // Screaming case: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET.
  FORBIDDEN_UPPER,
  // ALL-LOWERCASE GLUED COMPOUNDS: `stripeclient`, `stripecheckout`,
  // `stripeinvoice`, the payment processor glued to whatever follows it in a
  // file name, a package name or a snake-less identifier. With only the three
  // alternatives above, the word followed by a LOWERCASE letter matched
  // nothing at all.
  //
  // A bare "any lowercase letter" was too wide in the other direction: it read
  // the CSS and prose word for a band (`table-striped`, `zebra stripes`,
  // `pinstriped`) as the payment processor. So this alternative is the INVERSE
  // rule: the word followed by letters matches unless what follows is exactly
  // one of the benign English endings above. The band survives; a compound
  // nobody listed does not.
  `${FORBIDDEN}${benignExcludingSuffixes(BENIGN_FORMS)}`,
].join("|")

// The one path the repo-wide grep does not read. Kept beside the case that
// checks the claim it rests on.
const BENCH_FIXTURES = ":!apps/api/src/tests/bench/**/fixtures/**"

/**
 * A path, once resolved, that lands inside one of the excluded corpora.
 *
 * The first shape of this guard matched the SPECIFIER text and required the
 * word `bench` inside it, which is exactly what a specifier written from inside
 * the corpora never says: `./fixtures/mini/messages.jsonl` from a module in
 * `src/tests/bench/long-context` reaches the corpus and matched nothing. Where a
 * specifier points is a property of the importing file's directory, so the
 * resolution happens first and the match happens on the result.
 *
 * It matches exactly what the pathspec excludes, `bench/**\/fixtures/**`: ANY
 * number of directories between `bench` and `fixtures`, zero included. Pinning
 * one level meant a corpus one directory deeper was unread by the billing grep
 * and unseen by this guard at the same time, which is the pair that has to
 * agree or the exclusion stops being safe.
 */
const BENCH_FIXTURE_PATH = /(^|\/)apps\/api\/src\/tests\/bench\/(?:[^/]+\/)*fixtures\//

/** The tree whose import lines are ALL resolved, whatever they say. */
const BENCH_TREE = "apps/api/src/tests/bench"

/**
 * Candidate lines for the repo-wide sweep: import-shaped and naming a fixtures
 * path.
 *
 * `import` alone is one of the shapes, because a SIDE-EFFECT import writes no
 * `from`, no `require(` and no `import(`: `import "./fixtures/mini/seed"` runs
 * the module for what it does, not for what it returns, and reaches every byte
 * of the corpus exactly as a named import would. Requiring one of the other
 * three read it as prose. A comment that merely says the word is selected too
 * and then carries no quoted specifier, which costs nothing.
 */
const FIXTURE_IMPORT_LINE = "(from|require\\(|import)[^;]*fixtures"

/**
 * Candidate lines INSIDE the bench tree: import-shaped, full stop.
 *
 * The word filter is what a specifier written beside its own data never says.
 * `./messages.jsonl`, from a module sitting in the corpus directory itself,
 * reaches the corpus and carries the word `fixtures` nowhere on the line, so
 * the line was dropped before anything could resolve it. Inside this tree every
 * import line is resolved instead of being pre-selected by what it spells.
 */
const ANY_IMPORT_LINE = "(from|require\\(|import)"

/**
 * Every quoted specifier on one import-shaped line.
 *
 * The parenthesis after `import` is OPTIONAL, which is what admits the
 * side-effect form `import "./fixtures/mini/seed"` alongside the dynamic
 * `import("./x")`. Without it the line was selected and then yielded no
 * specifier, so an import straight into a corpus resolved to nothing and read
 * as a clean repo.
 */
const SPECIFIERS = /(?:\bfrom|\brequire\(|\bimport\(?)\s*["'`]([^"'`]+)["'`]/g

/** A specifier whose target cannot be worked out from the repo alone. */
const UNRESOLVABLE = "<unresolvable>"

/** The package a file belongs to: its manifest and the dir that manifest sits in. */
function nearestPackage(importer: string): { dir: string; pkg: Record<string, any> } | null {
  let dir = path.posix.dirname(importer)
  for (;;) {
    const manifest = path.join(REPO_ROOT, dir, "package.json")
    if (existsSync(manifest)) {
      return { dir, pkg: JSON.parse(readFileSync(manifest, "utf8")) }
    }
    if (dir === "." || dir === "/" || dir === "") return null
    dir = path.posix.dirname(dir)
  }
}

/** A `./`-relative target from a package manifest, as a repo-relative path. */
function fromManifest(dir: string, target: unknown): string {
  if (typeof target !== "string" || !target.startsWith("./")) return UNRESOLVABLE
  return path.posix.normalize(path.posix.join(dir, target))
}

/** Where `specifier`, written in `importer`, points, as a repo-relative path. */
function resolveSpecifier(importer: string, specifier: string): string {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier))
  }
  // apps/api's own alias, the one a test inside it would reach for.
  if (specifier.startsWith("~/")) return `apps/api/src/${specifier.slice(2)}`
  const owner = nearestPackage(importer)
  // A subpath import (`#corpus/mini`) is whatever the package's own `imports`
  // map says it is. No map, no entry, no answer.
  if (specifier.startsWith("#")) {
    if (!owner) return UNRESOLVABLE
    return fromManifest(owner.dir, (owner.pkg.imports as Record<string, unknown>)?.[specifier])
  }
  // A package SELF-reference (`@liaison/api/...` from inside apps/api) reaches
  // the package's own files through its `exports` map, so it can point into the
  // corpora while looking like an ordinary dependency.
  const name = typeof owner?.pkg.name === "string" ? owner.pkg.name : null
  if (owner && name && (specifier === name || specifier.startsWith(`${name}/`))) {
    const subpath = specifier === name ? "." : `./${specifier.slice(name.length + 1)}`
    return fromManifest(owner.dir, (owner.pkg.exports as Record<string, unknown>)?.[subpath])
  }
  // Anything else is a dependency: it resolves into node_modules, never a corpus.
  return specifier
}

/**
 * What an import reaches: a corpus, nothing this repo can work out, or code.
 *
 * An unresolvable specifier is a VIOLATION, not a pass. The exclusion rests on
 * the claim that nothing imports the corpora, and a specifier whose target
 * cannot be named is a specifier that may well reach one; reading it as clean
 * would be the guard asserting exactly what it failed to check.
 */
function classifyImport(
  importer: string,
  specifier: string,
): "reaches-corpus" | "unresolvable" | "elsewhere" {
  const resolved = resolveSpecifier(importer, specifier)
  if (resolved === UNRESOLVABLE) return "unresolvable"
  // The trailing slash lets a specifier that names the corpus DIRECTORY itself
  // (`./fixtures`) match the same rule as one that names a file inside it.
  return BENCH_FIXTURE_PATH.test(`/${resolved}/`) ? "reaches-corpus" : "elsewhere"
}

function importsBenchFixture(importer: string, specifier: string): boolean {
  return classifyImport(importer, specifier) !== "elsewhere"
}

/** `git grep -nE` over `pathspecs`, as `[importer, code]` pairs. */
function importLines(pattern: string, pathspecs: string[]): Array<[string, string]> {
  const result = spawnSync("git", ["grep", "-nE", pattern, "--", ...pathspecs], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  // git grep exits 1 for "no matches", which is fine; anything above that is
  // a broken sweep and must not read as a clean repo.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git grep failed (exit ${result.status}): ${result.stderr}`)
  }
  const out: Array<[string, string]> = []
  for (const line of (result.stdout ?? "").split("\n")) {
    if (!line.trim()) continue
    const firstColon = line.indexOf(":")
    const secondColon = line.indexOf(":", firstColon + 1)
    if (firstColon === -1 || secondColon === -1) continue
    out.push([line.slice(0, firstColon), line.slice(secondColon + 1)])
  }
  return out
}

/** Files the billing neutrality guard reads with the whole word forbidden. */
const BILLING_PATHS = [
  "apps/api/src/modules/billing-*/**",
  "apps/api/src/modules/credits/**",
  "apps/api/src/db/schema/kernel/credits.ts",
  "apps/api/src/db/schema/kernel/organizations.ts",
  "apps/api/src/lib/edition.ts",
]

/**
 * Files that may name the vendor freely: the connector's own test, harness,
 * i18n strings and the tool bench corpus. Everything else may only use the
 * connector identifiers below.
 */
const CONNECTOR_PATHS = [
  "apps/api/test-support/harness/@@-*",
  "**/@@-*.test.ts",
  "**/@@-*.e2e.test.ts",
  "apps/api/src/tests/relations/@@-world.ts",
  // The shared pieces of the connector's own page scenarios (its bundle, its
  // test install, its tool mocks), next to the `@@-*` scenario files.
  "apps/web/src/tests/e2e/@@/**",
  "**/i18n/**",
  "**/*i18n*",
  "apps/api/src/modules/agent/tools/tool-bench/corpus.json",
  // The corpus's typed forms, as the bench last ranked them.
  "apps/api/src/modules/agent/tools/tool-bench/baseline.json",
  // The connector's registrations (D129: "its registrations may name the
  // vendor"): its setup label and timing, its tables' import coverage and
  // export redaction, its settings alias, its scope alias and capability
  // label, and the test server's mock and install-route wiring.
  "apps/api/src/modules/connection-guides/setup-features.ts",
  "apps/api/src/modules/connection-guides/setup-timings.ts",
  "apps/api/src/modules/imports/coverage-registry.ts",
  "apps/api/src/modules/export/org-archive/redaction.ts",
  "apps/api/src/modules/apps/runtime-helpers.ts",
  "apps/web/src/modules/settings/settings-aliases.ts",
  "packages/shared/src/capability-categories.ts",
  "apps/api/test-support/index.e2e.ts",
  "apps/api/test-support/qa-seed-routes.ts",
  // The connector's contract fixtures (its harness): the bridge calls each of
  // its entries makes when woken, recorded for replay.
  "apps/api/src/modules/apps/contract/fixtures/@@/**",
  // Another app's entries the connector wakes, named for it (its event, the job
  // that reconciles against it), recorded with the connector's own replies.
  "apps/api/src/modules/apps/contract/fixtures/*/*@@*.json",
].map((g) => g.replace(/@@/g, FORBIDDEN))

/** A path glob (`*` within a segment, `**` across segments) as a RegExp. */
function globToRegExp(glob: string): RegExp {
  let out = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string
    if (c === "*" && glob[i + 1] === "*") {
      out += glob[i + 2] === "/" ? "(?:.*/)?" : ".*"
      i += glob[i + 2] === "/" ? 2 : 1
    } else if (c === "*") out += "[^/]*"
    else out += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${out}$`)
}

function matchesAny(file: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(file))
}

const isBillingPath = (file: string) => matchesAny(file, BILLING_PATHS)
const isConnectorPath = (file: string) => matchesAny(file, CONNECTOR_PATHS)

/**
 * What the connector's own bundle declares under its name: the names in its
 * manifest's schema (tables and columns: `<app>_id`, `created_at_<app>`), the
 * hosts its connection may reach, its views' labels and routes, and the test
 * ids its screens carry. Read from the bundle itself, so a name the bundle does
 * not declare is still caught, and each is matched whole.
 */
function connectorDeclaredNames(): { bare: string[]; quoted: string[] } {
  const appDir = path.join(REPO_ROOT, "bundled-apps", FORBIDDEN)
  const manifestPath = path.join(appDir, "app.manifest.json")
  if (!existsSync(manifestPath)) return { bare: [], quoted: [] }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    schema?: unknown
    connections?: Record<string, { allowedDomains?: string[] }>
    views?: {
      activityBar?: { label?: string }
      tabTypes?: Record<string, { label?: string; urlPattern?: string }>
    }
  }
  const named = (v: unknown): v is string =>
    typeof v === "string" && v.toLowerCase().includes(FORBIDDEN)
  const schemaNames = [manifest.schema, ...otherAppSchemas()]
    .flatMap((schema) => [...JSON.stringify(schema ?? {}).matchAll(/"([a-z_]+)"/g)])
    .map((m) => m[1] as string)
    .filter((n) => n !== FORBIDDEN && n.includes(FORBIDDEN))
  const hosts = Object.values(manifest.connections ?? {})
    .flatMap((c) => c.allowedDomains ?? [])
    .filter(named)
  const views = [
    manifest.views?.activityBar?.label,
    ...Object.values(manifest.views?.tabTypes ?? {}).flatMap((t) => [t.label, t.urlPattern]),
  ].filter(named)
  const testIds: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.tsx?$/.test(entry.name))
        for (const m of readFileSync(full, "utf8").matchAll(/data-testid="([a-z0-9-]+)"/g))
          if (named(m[1])) testIds.push(m[1] as string)
    }
  }
  if (existsSync(path.join(appDir, "src"))) walk(path.join(appDir, "src"))
  return {
    bare: [...new Set([...schemaNames, ...hosts])],
    quoted: [...new Set([...views, ...testIds])],
  }
}

/**
 * The schemas the other bundled apps declare. A table another app keeps for the
 * connector it feeds (`<app>_streams` in invoicing) is already an identifier in
 * its qualified form (`app_invoicing.<app>_streams`); read from the manifests,
 * its bare name is one too, and a name no manifest declares is still caught.
 */
function otherAppSchemas(): unknown[] {
  const root = path.join(REPO_ROOT, "bundled-apps")
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== FORBIDDEN)
    .map((d) => path.join(root, d.name, "app.manifest.json"))
    .filter((p) => existsSync(p))
    .map((p) => (JSON.parse(readFileSync(p, "utf8")) as { schema?: unknown }).schema)
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const DECLARED = connectorDeclaredNames()

/**
 * The connector's identifiers: an `<app>:` scope, an `app_<app>.<table>` table, an
 * `<app>__` tool name, an `<app>/` event name, the bundled app folder and the
 * app's own name in quotes. Removing them leaves what is NOT an identifier.
 */
const CONNECTOR_IDENTIFIERS = new RegExp(
  [
    `bundled-apps/${FORBIDDEN}`,
    // A path to a file inside any bundled app: bundled apps are not swept for the
    // name, so the file names they choose are identifiers here.
    `bundled-apps/[a-z0-9-]+/[A-Za-z0-9_./-]*${FORBIDDEN}[A-Za-z0-9_.-]*\\.tsx?`,
    // The schema and its table together: app_<app>.<app>_customers is one identifier.
    `app_${FORBIDDEN}\\.[a-z_]+`,
    // Another app's table named for the connector it feeds: app_invoicing.<app>_streams.
    `app_[a-z_]+\\.${FORBIDDEN}_[a-z_]+`,
    `(?<![A-Za-z@/])${FORBIDDEN}__`,
    `(?<![A-Za-z@/])${FORBIDDEN}/`,
    `(?<![A-Za-z])${FORBIDDEN}:`,
    `"${FORBIDDEN}"`,
    // A path to one of the connector's own test files (`**/<app>-*.test.ts`).
    `[A-Za-z0-9_./-]*(?<![A-Za-z])${FORBIDDEN}-[A-Za-z0-9_.-]*\\.test\\.ts`,
    // What its bundle declares: schema names and hosts whole, view labels,
    // routes and test ids as quoted strings.
    ...DECLARED.bare.map((n) => `(?<![A-Za-z0-9_])${escapeRe(n)}(?![A-Za-z0-9_])`),
    ...DECLARED.quoted.map((n) => `"${escapeRe(n)}"`),
  ].join("|"),
  "g",
)

/** The word on a line, once the connector identifiers are taken out. */
function nameOutsideConnector(line: string): boolean {
  return new RegExp(V3_PATTERN).test(line.replace(CONNECTOR_IDENTIFIERS, ""))
}

/** Whether `line`, found in `file`, breaks rule (c) or (d). */
function nameViolation(file: string, line: string): boolean {
  if (isBillingPath(file)) return new RegExp(V3_PATTERN).test(line)
  if (isConnectorPath(file)) return false
  return nameOutsideConnector(line)
}

/** A package manifest or lockfile entry for the vendor's SDK. */
const SDK_DEPENDENCY = new RegExp(
  `"(?:${FORBIDDEN}|@${FORBIDDEN}/[^"]*)"\\s*:|npm:(?:${FORBIDDEN}|@${FORBIDDEN}/)`,
)
const dependsOnSdk = (manifestText: string) => SDK_DEPENDENCY.test(manifestText)

/** An import specifier that is the vendor's SDK, or a subpath of it. */
function importsSdk(line: string): boolean {
  for (const m of line.matchAll(SPECIFIERS)) {
    const spec = m[1] as string
    if (spec === FORBIDDEN || spec.startsWith(`${FORBIDDEN}/`) || spec.startsWith(`@${FORBIDDEN}/`))
      return true
  }
  return false
}

// Where the word is swept: the product, its packages and its deploy files. The
// bundled apps are swept for SDK imports only (CODE_ROOTS), since a connector
// folder is where the vendor's name belongs.
const NAME_ROOTS = ["apps/**", "packages/**", "deploy/**"]
const CODE_ROOTS = [...NAME_ROOTS, "bundled-apps/**", "scripts/**"]
// Docs and the negative-assertion surface: test files that assert the ABSENCE
// of vendor-named symbols, and the setup CLI's key scanner (a detection
// pattern, not an integration). Bench corpora are data (see BENCH_FIXTURES).
const NOT_PRODUCTION = [
  ":!docs/**",
  ":!**/CHANGELOG.md",
  `:!apps/api/src/tests/${import.meta.file}`,
  ":!apps/api/src/tests/db-schema-billing-neutral.test.ts",
  ":!apps/web/src/modules/settings/UsageSettings.test.tsx",
  ":!apps/api/src/cli/setup/collect-repo-docs.ts",
  BENCH_FIXTURES,
]

/** Tracked files matching `pathspecs`. */
function trackedFiles(pathspecs: string[]): string[] {
  const result = spawnSync("git", ["ls-files", "--", ...pathspecs], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr}`)
  return result.stdout.split("\n").filter(Boolean)
}

describe("extracted billing surface stays out of the repo", () => {
  // The pattern, exercised directly. A repo-wide grep that returns nothing is
  // the same result whether the surface is gone or the pattern is broken, so
  // the pattern gets its own assertions.
  test("the pattern matches every real form of the extracted name", () => {
    const re = new RegExp(V3_PATTERN)
    for (const line of [
      `import ${FORBIDDEN} from "${FORBIDDEN}"`,
      `const key = process.env.${FORBIDDEN_UPPER}_SECRET_KEY`,
      `row.${FORBIDDEN}CustomerId`,
      `@${FORBIDDEN}/${FORBIDDEN}-js`,
      `new ${FORBIDDEN_UPPER[0]}${FORBIDDEN.slice(1)}Client()`,
      `${FORBIDDEN}_payment_intent`,
      // All-lowercase glued compounds: the alternative added after the
      // case-sensitivity fix left them unmatched.
      `import { ${FORBIDDEN}client } from "./billing"`,
      `const ${FORBIDDEN}key = env.SECRET`,
      `await ${FORBIDDEN}api.charges.create()`,
      // The compounds the eight noun guess never named. Each of these was a
      // false negative: the guard reported a clean repo while the word sat in
      // a file name or an identifier.
      `import { ${FORBIDDEN}checkout } from "./billing"`,
      `const doc = ${FORBIDDEN}invoice.retrieve(id)`,
      `const t = ${FORBIDDEN}token.create()`,
      `import "@acme/${FORBIDDEN}elements"`,
      `const acct = ${FORBIDDEN}account.id`,
      `const sub = ${FORBIDDEN}subscription.status`,
      `const p = ${FORBIDDEN}price.unit_amount`,
      `import { ${FORBIDDEN}connect } from "./oauth"`,
      `await ${FORBIDDEN}refund.create({})`,
    ]) {
      expect(re.test(line), line).toBe(true)
    }
  })

  test("the pattern leaves an unrelated word that merely starts the same alone", () => {
    const re = new RegExp(V3_PATTERN)
    // The four lines that made this guard red: a DOM helper in the desktop
    // feature-detection test, whose first six letters are the forbidden word
    // only if an uppercase E is allowed to match a lowercase one.
    for (const line of [
      "const el = stripElements(node)",
      "function stripEmptyKeys(input: object) {",
      "await stripEnvelope(message)",
      // Still not the payment processor, with the lowercase-glued alternative
      // in place: the letter after `strip` is an uppercase E in every one.
      "const s = stripEmoji(title)",
      // The CSS and prose word for a band is not the payment processor: the
      // lowercase-glued alternative names the nouns instead of taking any
      // lowercase letter.
      `<table className="table-${FORBIDDEN}d">`,
      `/* zebra ${FORBIDDEN}s on alternate rows */`,
      `const shirt = "pin${FORBIDDEN}d"`,
      // Every benign English form the inverse rule exempts, each one written
      // where the guard would see it: the fish, the verb, the adjective.
      `const fish = "${FORBIDDEN}r"`,
      `const fishes = ["${FORBIDDEN}rs"]`,
      `const shirt = "${FORBIDDEN}y"`,
      `const shirts = "pin${FORBIDDEN}s"`,
      `// ${FORBIDDEN}d down to the essentials`,
    ]) {
      expect(re.test(line), line).toBe(false)
    }
  })

  // The exclusion above is only safe while the corpora stay data. The moment a
  // file imports one, its contents are on a code path again and the grep that
  // no longer reads them is no longer an acceptance check.
  test("nothing imports a bench fixture, so excluding the corpora excludes only data", () => {
    // A guard that matches nothing reads the same whether the repo is clean or
    // the resolution is broken, so the resolution gets its own assertions first.
    for (const [importer, specifier] of [
      // Written from OUTSIDE the corpora, the shapes the first guard caught.
      [
        "apps/api/src/tests/integration/x.test.ts",
        "../../tests/bench/long-context/fixtures/mini/messages.jsonl",
      ],
      ["scripts/x.ts", "./apps/api/src/tests/bench/long-context/fixtures/sample/threads.jsonl"],
      ["apps/api/src/modules/x.ts", "~/tests/bench/long-context/fixtures/mini/index"],
      // Written from INSIDE them, the two shapes the first guard could not see:
      // neither specifier contains the word `bench` at all.
      ["apps/api/src/tests/bench/long-context/run.ts", "./fixtures/mini/messages.jsonl"],
      ["apps/api/src/tests/bench/long-context/oracle/check.ts", "../fixtures/sample/threads.jsonl"],
      // The corpus DIRECTORY, named without a file: a bare `./fixtures` reaches
      // every byte under it, and a rule that needed a slash after the word read
      // it as ordinary code.
      ["apps/api/src/tests/bench/long-context/run.ts", "./fixtures"],
      // A corpus one directory deeper than the rule allowed. The PATHSPEC
      // excludes it from the billing grep (`bench/**/fixtures/**`), so a guard
      // that cannot see it leaves that exclusion resting on nothing.
      ["apps/api/src/tests/bench/a/b/run.ts", "./fixtures/mini/messages.jsonl"],
      ["scripts/x.ts", "./apps/api/src/tests/bench/a/b/fixtures/mini/messages.jsonl"],
      ["apps/api/src/tests/bench/run.ts", "./fixtures/mini/messages.jsonl"],
      // A SIBLING import from inside a corpus: the line says `fixtures`
      // nowhere, so the word filter dropped it before anything resolved it.
      ["apps/api/src/tests/bench/long-context/fixtures/mini/index.ts", "./messages.jsonl"],
      // Neither of these can be worked out from the repo alone, and an import
      // nobody can resolve is not an import anybody has checked.
      ["apps/api/src/tests/bench/long-context/run.ts", "#corpus/mini"],
      ["apps/api/src/tests/bench/long-context/run.ts", "@liaison/api/tests/bench/mini"],
    ] as Array<[string, string]>) {
      expect(importsBenchFixture(importer, specifier), `${importer} -> ${specifier}`).toBe(true)
    }
    // The two unresolvable shapes are reported AS unresolvable, not guessed at.
    expect(classifyImport("apps/api/src/tests/bench/long-context/run.ts", "#corpus/mini")).toBe(
      "unresolvable",
    )
    expect(
      classifyImport(
        "apps/api/src/tests/bench/long-context/run.ts",
        "@liaison/api/tests/bench/mini",
      ),
    ).toBe("unresolvable")

    // Code beside the corpora is still code, and importing it is fine.
    for (const [importer, specifier] of [
      ["apps/api/src/tests/bench/long-context/report.ts", "./run"],
      ["apps/api/src/tests/bench/long-context/run.ts", "../../helpers/app-schema-lock"],
      ["apps/api/src/modules/x.ts", "./fixtures/mini/messages.jsonl"],
      // A dependency resolves into node_modules, never into a corpus.
      ["apps/api/src/tests/bench/long-context/run.ts", "zod"],
      // A directory that merely STARTS with the word is not the corpus.
      ["apps/api/src/tests/bench/long-context/run.ts", "./fixtures-readme.md"],
    ] as Array<[string, string]>) {
      expect(importsBenchFixture(importer, specifier), `${importer} -> ${specifier}`).toBe(false)
    }

    // Two sweeps, because two different questions. Repo-wide, the candidates are
    // import lines that name a fixtures path. Inside the bench tree, EVERY
    // import line is resolved, because a specifier written beside its own data
    // names nothing the repo-wide filter could select on.
    const candidates = [
      ...importLines(FIXTURE_IMPORT_LINE, [
        "apps/**",
        "packages/**",
        "deploy/**",
        "scripts/**",
        // This file spells the shapes out to prove the resolution is live.
        `:!apps/api/src/tests/${import.meta.file}`,
      ]),
      // Source files only: the corpora themselves are frozen transcripts in
      // which the word `from` beside a quoted string is prose, not an import.
      ...importLines(ANY_IMPORT_LINE, [
        `${BENCH_TREE}/**/*.ts`,
        `${BENCH_TREE}/**/*.tsx`,
        `${BENCH_TREE}/**/*.js`,
        `${BENCH_TREE}/**/*.mjs`,
      ]),
    ]
    const offenders: string[] = []
    for (const [importer, code] of candidates) {
      for (const match of code.matchAll(SPECIFIERS)) {
        const verdict = classifyImport(importer, match[1])
        if (verdict === "elsewhere") continue
        offenders.push(`${importer}: ${match[1]} (${verdict})`)
      }
    }
    if (offenders.length > 0) {
      throw new Error(
        `a bench fixture is imported, or an import could not be resolved, so the corpora are ` +
          `code again and the billing grep must read them (${BENCH_FIXTURES}). Offenders:\n` +
          offenders.join("\n"),
      )
    }
  })

  test("a side-effect import is an import: no from, no require, no parenthesis", () => {
    // `import "./x"` runs the module for what it DOES. It reaches every byte of
    // the corpus exactly as a named import would, and it writes none of the
    // three words the candidate filters and the specifier reader were keyed on,
    // so an import straight into a corpus was selected by nothing and read by
    // nothing: the guard reported a clean repo over it.
    const line = `import "./fixtures/mini/messages.jsonl"`
    expect(new RegExp(FIXTURE_IMPORT_LINE).test(line)).toBe(true)
    expect(new RegExp(ANY_IMPORT_LINE).test(line)).toBe(true)
    const found = [...line.matchAll(SPECIFIERS)].map((m) => m[1])
    expect(found).toEqual(["./fixtures/mini/messages.jsonl"])
    expect(
      importsBenchFixture("apps/api/src/tests/bench/long-context/run.ts", found[0] as string),
    ).toBe(true)

    // The three shapes that already worked still yield exactly one specifier
    // each: the optional parenthesis widened the reader, it did not blur it.
    for (const [shape, expected] of [
      [`import { a } from "./fixtures/mini/index"`, "./fixtures/mini/index"],
      [`const a = require("./fixtures/mini/index")`, "./fixtures/mini/index"],
      [`await import("./fixtures/mini/index")`, "./fixtures/mini/index"],
    ] as Array<[string, string]>) {
      expect(
        [...shape.matchAll(SPECIFIERS)].map((m) => m[1]),
        shape,
      ).toEqual([expected])
    }
  })

  test("a dependency on the processor's SDK in any package manifest fails the guard", () => {
    // The check itself, on shapes a manifest and a lockfile really carry.
    for (const text of [
      `{ "dependencies": { "${FORBIDDEN}": "^14.0.0" } }`,
      `{ "devDependencies": { "@${FORBIDDEN}/${FORBIDDEN}-js": "^3" } }`,
      `{ "dependencies": { "billing": "npm:${FORBIDDEN}@14.0.0" } }`,
      `    "${FORBIDDEN}": ["${FORBIDDEN}@14.0.0", "", {}, "sha512-x"],`,
    ]) {
      expect(dependsOnSdk(text), text).toBe(true)
    }
    // A workspace that merely carries the connector's name is not the SDK.
    for (const text of [
      `{ "name": "@liaison/bundled-${FORBIDDEN}", "dependencies": { "zod": "^3" } }`,
      `    "bundled-apps/${FORBIDDEN}": { "name": "@liaison/app-${FORBIDDEN}" },`,
    ]) {
      expect(dependsOnSdk(text), text).toBe(false)
    }
    const manifests = trackedFiles(["**/package.json", "package.json", "bun.lock*"]).filter(
      (file) => existsSync(path.join(REPO_ROOT, file)),
    )
    expect(manifests.length, "no manifests found means the sweep reads nothing").toBeGreaterThan(0)
    const offenders = manifests.filter((file) =>
      dependsOnSdk(readFileSync(path.join(REPO_ROOT, file), "utf8")),
    )
    expect(offenders, "package manifests or lockfiles that depend on the SDK").toEqual([])
  })

  test("an import of the processor's SDK from api code fails the guard", () => {
    for (const line of [
      `import ${FORBIDDEN_UPPER[0]}${FORBIDDEN.slice(1)} from "${FORBIDDEN}"`,
      `import { loadClient } from "@${FORBIDDEN}/${FORBIDDEN}-js"`,
      `const c = require("${FORBIDDEN}")`,
      `const c = await import("${FORBIDDEN}/lib/x")`,
      `import "@${FORBIDDEN}/react-${FORBIDDEN}-js"`,
    ]) {
      expect(importsSdk(line), line).toBe(true)
    }
    for (const line of [
      `import { x } from "./${FORBIDDEN}-client"`,
      `import { y } from "~/modules/billing-managed/usage"`,
      `import { z } from "${FORBIDDEN}-utils"`,
    ]) {
      expect(importsSdk(line), line).toBe(false)
    }
    const pattern = `(from|require\\(|import)[^;]*["'\`](@${FORBIDDEN}/|${FORBIDDEN}["'\`/])`
    const offenders = importLines(pattern, [...CODE_ROOTS, ...NOT_PRODUCTION])
      .filter(([, code]) => importsSdk(code))
      .map(([file, code]) => `${file}: ${code.trim()}`)
    expect(offenders, "imports of the SDK").toEqual([])
  })

  test("the word in the billing module fails the guard", () => {
    const line = `const customer = ${FORBIDDEN}CustomerId`
    for (const file of [
      "apps/api/src/modules/billing-managed/usage.ts",
      "apps/api/src/modules/billing-state/index.ts",
      "apps/api/src/modules/credits/ledger.ts",
      "apps/api/src/db/schema/kernel/credits.ts",
      "apps/api/src/db/schema/kernel/organizations.ts",
      "apps/api/src/lib/edition.ts",
    ]) {
      expect(isBillingPath(file), file).toBe(true)
      expect(nameViolation(file, line), file).toBe(true)
      // Even a connector identifier is out of place in the product's billing.
      expect(nameViolation(file, `scope: "${FORBIDDEN}:read"`), file).toBe(true)
    }
    // Code beside them is not billing.
    expect(isBillingPath("apps/api/src/modules/billing/x.ts")).toBe(false)
    expect(isBillingPath("apps/api/src/lib/edition-flags.ts")).toBe(false)

    // The repo: every file under the billing paths, read whole.
    const files = trackedFiles([
      "apps/api/src/modules/billing-*",
      "apps/api/src/modules/credits",
      "apps/api/src/db/schema/kernel/credits.ts",
      "apps/api/src/db/schema/kernel/organizations.ts",
      "apps/api/src/lib/edition.ts",
    ]).filter((file) => isBillingPath(file) && existsSync(path.join(REPO_ROOT, file)))
    expect(files.length, "the billing paths must exist or this reads nothing").toBeGreaterThan(0)
    const offenders: string[] = []
    for (const file of files) {
      const lines = readFileSync(path.join(REPO_ROOT, file), "utf8").split("\n")
      for (const [i, text] of lines.entries()) {
        if (nameViolation(file, text)) offenders.push(`${file}:${i + 1}`)
      }
    }
    expect(offenders, "the vendor's name in billing, credits or edition code").toEqual([])
  })

  test("the connector's scope, table and tool names pass the guard", () => {
    const other = "apps/api/src/modules/agent/scopes.ts"
    for (const line of [
      `"${FORBIDDEN}:read": "Read payment data"`,
      `FROM app_${FORBIDDEN}.customers WHERE org_id = $1`,
      `"${FORBIDDEN}__list_invoices"`,
      `emit("${FORBIDDEN}/invoice.paid")`,
      `import { run } from "bundled-apps/${FORBIDDEN}/handlers"`,
      `"bundled-apps/invoicing/src/handlers/${FORBIDDEN}-refund-created.ts",`,
      `{ name: "${FORBIDDEN}", enabled: true }`,
      // What the connector's bundle declares: its columns, its host, its route,
      // its rail label and its screens' test ids; and a path to its own test file.
      `    ${FORBIDDEN}_id: c.id,`,
      `    created_at_${FORBIDDEN}: iso(c.createdAt),`,
      `const HOSTS = ["api.${FORBIDDEN}.com"]`,
      `const ROUTE = "/${FORBIDDEN}"`,
      `  | "${FORBIDDEN_UPPER[0]}${FORBIDDEN.slice(1)}"`,
      `anchor: "${FORBIDDEN}-home",`,
      `const READS = "saas/${FORBIDDEN}-world-reads.saas.integration.test.ts"`,
    ]) {
      expect(nameViolation(other, line), line).toBe(false)
    }
    // The vendor's name in any other form is still caught outside the connector.
    for (const line of [
      `const ${FORBIDDEN}Client = makeClient()`,
      `process.env.${FORBIDDEN_UPPER}_SECRET_KEY`,
      `row.${FORBIDDEN}_customer_id`,
      `import x from "@${FORBIDDEN}/${FORBIDDEN}-js"`,
      `"apps/api/src/billing/${FORBIDDEN}-refund.ts"`,
      // Not declared by the bundle: a made-up column, host, test id or label.
      `row.${FORBIDDEN}_secret_key`,
      `fetch("https://dashboard.${FORBIDDEN}.com")`,
      `anchor: "${FORBIDDEN}-checkout-button",`,
      `It reads ${FORBIDDEN_UPPER[0]}${FORBIDDEN.slice(1)}, invoices and deals`,
    ]) {
      expect(nameViolation(other, line), line).toBe(true)
    }
    // The connector's own test, harness, i18n and corpus files may name it freely.
    for (const file of [
      `apps/api/test-support/harness/${FORBIDDEN}-mock-fetch.ts`,
      `apps/api/src/tests/e2e/${FORBIDDEN}-sync.e2e.test.ts`,
      `apps/api/src/tests/${FORBIDDEN}-scopes.test.ts`,
      `apps/api/src/tests/relations/${FORBIDDEN}-world.ts`,
      `apps/web/src/tests/e2e/${FORBIDDEN}/_${FORBIDDEN}-fixtures.ts`,
      "apps/web/src/modules/i18n/fr.ts",
      "apps/api/src/modules/agent/tools/tool-bench/corpus.json",
      // The corpus's typed forms, as the bench last ranked them.
      "apps/api/src/modules/agent/tools/tool-bench/baseline.json",
      // Its contract fixtures, and another app's entries it wakes.
      `apps/api/src/modules/apps/contract/fixtures/${FORBIDDEN}/tool_connection_check.json`,
      `apps/api/src/modules/apps/contract/fixtures/invoicing/job_reconcile-${FORBIDDEN}-payments.json`,
    ]) {
      expect(isConnectorPath(file), file).toBe(true)
      expect(nameViolation(file, `const ${FORBIDDEN}Client = 1`), file).toBe(false)
    }

    // The repo: the word outside billing and connector files, identifiers taken out.
    const result = spawnSync(
      "git",
      [
        "grep",
        "-nIE",
        V3_PATTERN,
        "--",
        ...NAME_ROOTS,
        "package.json",
        "bun.lock*",
        ...NOT_PRODUCTION,
      ],
      { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    )
    if (result.status !== 0 && result.status !== 1) {
      throw new Error(`git grep failed (exit ${result.status}): ${result.stderr}`)
    }
    const offenders: string[] = []
    for (const hit of (result.stdout ?? "").split("\n")) {
      const [file, lineNo] = hit.split(":")
      if (!file || !lineNo) continue
      const code = hit.slice(file.length + lineNo.length + 2)
      if (nameViolation(file, code)) offenders.push(`${file}:${lineNo}`)
    }
    expect(offenders, "the vendor's name outside a connector identifier").toEqual([])
  })
})
