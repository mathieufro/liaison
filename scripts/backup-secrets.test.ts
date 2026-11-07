// SPDX-License-Identifier: FSL-1.1-ALv2
//
// deploy/backup.sh copies the keys stored data cannot be read without into the
// archive (secrets.env), with the deployment's OAuth clients and push settings,
// and deploy/restore.sh writes them into the target's .env. A key the list
// forgets is a backup that restores into an instance whose connected accounts,
// model keys and 2FA secrets no longer open, found only on the day the backup
// is needed. This guard keeps the lists in step with the code:
//   1. every variable whose value keys a cryptographic call anywhere in the
//      product source (node:crypto, WebCrypto, jose, the product's wrappers;
//      directly, through process.env, or through a binding) is a data key, or
//      is listed as keyed-but-never-stored with the reason;
//   2. every secret-ish variable the product reads (the server's env schema and
//      every process.env / Bun.env / import.meta.env read in apps/, packages/
//      and bundled-apps/) is carried, per host, or allowlisted with the reason;
//   3. every carried variable exists and reaches the app container through
//      deploy/docker-compose.yml.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { type Classes, classify, keyingVars, type Source } from "./lib/secret-env-scan"

const ROOT = path.resolve(import.meta.dir, "..")
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8")

function backupList(name: string): string[] {
  const m = read("deploy/backup.sh").match(new RegExp(`^${name}=\\(([^)]*)\\)`, "m"))
  if (!m) throw new Error(`${name} not found in deploy/backup.sh`)
  return (m[1] as string).split(/\s+/).filter(Boolean)
}
const REQUIRED = backupList("DATA_SECRETS_REQUIRED")
const OPTIONAL = backupList("DATA_SECRETS_OPTIONAL")
/** Data keys: what stored data cannot be read without. */
const DATA = new Set([...REQUIRED, ...OPTIONAL])
/** Carried configuration: OAuth clients and push settings, which decrypt nothing. */
const CONFIG = new Set(backupList("CARRIED_CONFIG"))

/** Deployment settings that stay with the host, and why. */
const HOST_SETTINGS: Record<string, string> = {
  DATABASE_REQUEST_PASSWORD: "this host's database login; the migration step sets it",
  LIAISON_SETUP_TOKEN: "first registration only; a restored instance already has its org",
  LIAISON_DEMO_REVIEWER_PASSWORD: "demo instance setting",
  LIAISON_DEMO_MAIL_RESEND_API_KEY: "demo instance mail provider",
  TURNSTILE_SECRET_KEY: "demo signup captcha, per site",
  TURNSTILE_SITE_KEY: "demo signup captcha, per site (public)",
  SMTP_PASS: "this host's mail relay",
  LIAISON_ANTHROPIC_API_KEY: "platform model key, a host choice, nothing stored under it",
  OPENAI_API_KEY: "platform model key, a host choice, nothing stored under it",
  GOOGLE_API_KEY: "platform model key, a host choice, nothing stored under it",
  MISTRAL_API_KEY: "platform model key, a host choice, nothing stored under it",
  CONTROL_PLANE_API_KEY: "managed-edition control plane credential",
  MONITOR_TOKEN: "this host's monitoring bearer token",
  MEILISEARCH_API_KEY: "this host's search service; the index is rebuilt on restore",
  OBJECT_STORAGE_ACCESS_KEY: "this host's object store login; objects are copied, not the store",
  OBJECT_STORAGE_SECRET_KEY: "this host's object store login; objects are copied, not the store",
  RESEND_API_KEY: "this host's mail provider",
  SYSTEM_RESEND_API_KEY: "this host's mail provider",
  EXPOSE_REFRESH_TOKEN_IN_BODY: "a behaviour switch, not a secret",
  CHAOS_DEBUG_TOKEN: "debug route guard for a test harness, never set in production",
  OPENROUTER_API_KEY: "platform model key, a host choice, nothing stored under it",
  LIAISON_DEMO_RESERVED_TOKEN_CEILING: "demo instance spend limit, a number",
  LIAISON_DEMO_STEP_OUTPUT_TOKENS: "demo instance spend limit, a number",
  LOAD_HARNESS_KEY: "demo box load harness request signing; the new host sets its own",
  AGENT_HISTORY_BUDGET_TOKENS: "a conversation history size, a number",
  OPENROUTER_HOST_MIN_TOKENS_PER_SECOND: "a model routing threshold, a number",
  LIAISON_EDGE_SECRET: "shared with this host's edge proxy; the new host's edge sets its own",
  LIAISON_APP_LOADER_KEY:
    "signs this host's requests to its app loader, set with that loader; nothing stored is signed with it",
}

/** Read by test, QA or developer tooling only: never deployment configuration. */
const NOT_DEPLOYMENT: Record<string, string> = {
  QA_DRIVE_REFRESH_TOKEN: "a developer's own Drive token, read by the standard seed tier only",
  QA_GMAIL_REFRESH_TOKEN: "a developer's own Gmail token, read by the standard seed tier only",
}

/** Keys a call, but nothing stored depends on it surviving a move. */
const KEYED_NOT_STORED: Record<string, string> = {
  MONITOR_TOKEN: "compared to a request's bearer token; the new host sets its own",
  MEILISEARCH_API_KEY: "authenticates to this host's search service, rebuilt on restore",
  LOAD_HARNESS_KEY: "verifies the load harness's signed requests; nothing stored is signed with it",
  LIAISON_EDGE_SECRET:
    "verifies the edge's signed host headers per request; nothing stored is signed with it",
  QA_DRIVE_REFRESH_TOKEN:
    "the seed encrypts it as data under ENCRYPTION_KEY; it keys nothing, a dev-only token",
}

const CLASSES: Classes = {
  data: DATA,
  config: CONFIG,
  host: HOST_SETTINGS,
  allow: NOT_DEPLOYMENT,
  keyedNotStored: KEYED_NOT_STORED,
}

const envTs = read("apps/api/src/lib/env.ts")
const SCHEMA_VARS = new Set(
  [...envTs.matchAll(/^ {4}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1] as string),
)

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "dist-native",
  "target",
  "gen",
  "vendor",
  "ios",
  "android",
  "__fixtures__",
  "tests",
  "e2e",
  "test-results",
  "logs",
  // Developer and probe scripts inside a package (apps/api/scripts,
  // bundled-apps/*/scripts): run by hand, never by a deployment.
  "scripts",
])
/** Test infrastructure packages: their variables configure test runs, not deployments. */
const SKIP_PATHS = ["packages/test-helpers/"]
const SOURCE_FILE = /\.(ts|tsx|js|mjs|cjs)$/
const TEST_FILE = /\.(test|spec|live|scenario)\.[cm]?[jt]sx?$|playwright\.config\./

function walk(dir: string, acc: Source[]): Source[] {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") || SKIP_DIRS.has(entry)) continue
    const full = path.join(dir, entry)
    const rel = path.relative(ROOT, full)
    if (SKIP_PATHS.some((p) => `${rel}/`.startsWith(p))) continue
    if (statSync(full).isDirectory()) walk(full, acc)
    else if (SOURCE_FILE.test(entry) && !TEST_FILE.test(entry) && !entry.endsWith(".d.ts"))
      acc.push({ path: rel, text: readFileSync(full, "utf8") })
  }
  return acc
}
const SOURCES = ["apps", "packages", "bundled-apps"].flatMap((d) => walk(path.join(ROOT, d), []))
const SHARED: Source[] = [{ path: "apps/api/src/lib/env.ts", text: envTs }]
// One scan for every test below (a few seconds over the whole tree).
const KEYING = keyingVars(SOURCES, SCHEMA_VARS, SHARED)
const FINDINGS = classify(SOURCES, SCHEMA_VARS, SHARED, CLASSES)

describe("deploy/backup.sh carries every key and configuration a move needs", () => {
  it("carries the three keys every instance has", () => {
    for (const k of ["JWT_SECRET", "ENCRYPTION_KEY", "BYOK_ENCRYPTION_KEY"]) {
      expect(REQUIRED).toContain(k)
    }
  })

  it("scans the whole product source and still sees the known key users", () => {
    expect(SOURCES.length).toBeGreaterThan(500)
    expect(SOURCES.some((s) => s.path.startsWith("bundled-apps/"))).toBe(true)
    expect(SOURCES.some((s) => s.path.startsWith("packages/"))).toBe(true)
    expect([...KEYING.keys()]).toEqual(
      expect.arrayContaining(["ENCRYPTION_KEY", "BYOK_ENCRYPTION_KEY", "JWT_SECRET"]),
    )
  })

  it("every variable that keys a cryptographic call is a carried data key", () => {
    expect(FINDINGS.keyedNotCarried).toEqual([])
  })

  it("every secret-ish variable the product reads is carried, per host, or allowlisted", () => {
    expect(FINDINGS.unclassified).toEqual([])
  })

  it("carries OAuth clients as whole id + secret pairs", () => {
    for (const v of CONFIG) {
      if (!/_CLIENT_(ID|SECRET)$/.test(v)) continue
      const pair = v.endsWith("_ID") ? v.replace(/_ID$/, "_SECRET") : v.replace(/_SECRET$/, "_ID")
      expect(CONFIG.has(pair)).toBe(true)
    }
    for (const k of CONFIG) expect(DATA.has(k)).toBe(false)
  })

  it("lists only variables compose passes to the app, and classifies nothing twice", () => {
    const compose = read("deploy/docker-compose.yml")
    for (const k of [...DATA, ...CONFIG]) {
      expect(compose).toMatch(new RegExp(`^ {6}${k}: \\$\\{${k}[:}]`, "m"))
      expect(k in HOST_SETTINGS || k in NOT_DEPLOYMENT).toBe(false)
    }
  })
})

describe("the scanner cannot be walked around", () => {
  const schema = new Set(["JWT_SECRET", "FILE_SIGNING_KEY", "NODE_ENV"])
  const none: Classes = {
    data: new Set(),
    config: new Set(),
    host: {},
    allow: {},
    keyedNotStored: {},
  }

  it("flags a schema key used through jose / WebCrypto", () => {
    const src: Source = {
      path: "apps/api/src/modules/files/link.ts",
      text: `import { SignJWT } from "jose"
import { env } from "~/lib/env"
export async function link(id: string) {
  return await new SignJWT({ id }).setProtectedHeader({ alg: "HS256" })
    .sign(new TextEncoder().encode(env.FILE_SIGNING_KEY))
}`,
    }
    const f = classify([src], schema, [], { ...none, data: new Set(["JWT_SECRET"]) })
    expect(f.unclassified).toContain("FILE_SIGNING_KEY")
    expect(f.keyedNotCarried).toContain("FILE_SIGNING_KEY")
  })

  it("flags a key read with process.env outside env.ts", () => {
    const src: Source = {
      path: "bundled-apps/links/src/handlers.ts",
      text: `import { createHmac } from "node:crypto"
export const mac = (v: string) => createHmac("sha256", process.env.LINK_HMAC_SECRET ?? "").update(v).digest("hex")`,
    }
    const f = classify([src], schema, [], none)
    expect(f.unclassified).toContain("LINK_HMAC_SECRET")
    expect(f.keyedNotCarried).toContain("LINK_HMAC_SECRET")
  })

  it("flags a key wrapped in a helper binding before subtle.importKey", () => {
    const src: Source = {
      path: "packages/sealer/src/key.ts",
      text: `const raw = process.env["SEAL_WRAP_KEY"]
const keyBytes = Buffer.from(raw ?? "", "hex")

export async function sealKey() {
  return crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"])
}`,
    }
    expect(classify([src], schema, [], none).keyedNotCarried).toContain("SEAL_WRAP_KEY")
  })

  it("resolves env.ts aliases and ignores the conditions they read", () => {
    const shared: Source = {
      path: "apps/api/src/lib/env.ts",
      text: `export const fileKey =
  env.FILE_SIGNING_KEY ?? (env.NODE_ENV !== "production" ? "dev" : "")

export const other = 1`,
    }
    const src: Source = {
      path: "apps/api/src/x.ts",
      text: `createHmac("sha256", fileKey).update("a")`,
    }
    expect(classify([src], schema, [shared], none).keyedNotCarried).toEqual(["FILE_SIGNING_KEY"])
  })
})
