// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Containment for the request login. Request transactions (withRlsContext)
// run on the request pools, which log in as `liaison_request` when
// DATABASE_REQUEST_PASSWORD is set (db/connection.ts): a member of liaison_rls
// only, so no statement run from one can `SET ROLE` to a BYPASSRLS role, a
// table owner or a policy owner (request-login.test.ts proves it on the live
// database). The writes request transactions used to make elevated, and that
// must commit with them, are SECURITY DEFINER functions owned by
// liaison_definer (migration 0178); reads and idempotent ensures go to the
// privileged pool (privilegedFrom).
//
// Elevation by `SET ROLE` remains only where the LOGIN is the privileged one
// (DATABASE_URL). This test pins those files: a new `SET LOCAL ROLE
// liaison_admin` / `liaison_schema_admin` anywhere else needs a review, which
// means adding its file here with the reason.
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const SRC = join(import.meta.dir, "..")

const ELEVATION_SITES: Record<string, string> = {
  "db/privileged.ts":
    "withPrivilegedDb / withSystemDb / withSchemaAdmin on the privileged pool; privilegedFrom elevating in place only when the transaction's login can",
  "infra/events/outbox-worker.ts":
    "outbox claim / complete / cleanup, short transactions on the main pool (the privileged login)",
  "modules/sharing/service.ts":
    "asAdmin: in place on a login that can elevate only (the contact merge in withElevatableRlsFrom); refused on the request login",
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "tests" || name === "__fixtures__") continue
      sourceFiles(full, out)
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$|test-helpers|test-fixtures/.test(name)) {
      out.push(full)
    }
  }
  return out
}

// Roles a request may switch DOWN to: anything else set through set_config,
// including a target that is not a string literal, counts as an elevation.
const DROP_ROLES = new Set(["liaison_rls", "liaison_portal"])

function elevates(code: string): boolean {
  if (/SET\s+(LOCAL\s+|SESSION\s+)?ROLE\s+"?liaison_(admin|schema_admin)\b/i.test(code)) return true
  for (const m of code.matchAll(/set_config\(\s*'role'\s*,\s*([^,)]*)/gi)) {
    const target = /^'([a-z_][a-z0-9_]*)'$/i.exec((m[1] ?? "").trim())?.[1]
    if (!target || !DROP_ROLES.has(target)) return true
  }
  return false
}

describe("role elevation sites", () => {
  test("only the reviewed files elevate to liaison_admin or liaison_schema_admin", () => {
    const found = new Set<string>()
    for (const file of sourceFiles(SRC)) {
      const code = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n")
      if (elevates(code)) found.add(relative(SRC, file))
    }
    expect([...found].sort()).toEqual(Object.keys(ELEVATION_SITES).sort())
  })

  test("the matcher tells a drop to liaison_rls from an elevation", () => {
    // Drops: the RLS entry point switches to the RLS role in the same round trip.
    expect(elevates("set_config('role', 'liaison_rls', true)")).toBe(false)
    expect(elevates("set_config('role', 'liaison_portal', true)")).toBe(false)
    expect(elevates("SET LOCAL ROLE liaison_rls")).toBe(false)
    // Elevations, literal or not.
    expect(elevates("set_config('role', 'liaison_admin', true)")).toBe(true)
    expect(elevates("set_config( 'role' , 'liaison_schema_admin', true)")).toBe(true)
    expect(elevates(`set_config('role', \${target}, true)`)).toBe(true)
    expect(elevates("SELECT set_config('role', $1, true)")).toBe(true)
    expect(elevates('SET LOCAL ROLE "liaison_admin"')).toBe(true)
    expect(elevates("SET ROLE liaison_schema_admin")).toBe(true)
  })

  test("request transactions draw from the request pools, never a privileged-login pool", () => {
    const rls = readFileSync(join(SRC, "db/rls.ts"), "utf8")
    const imports = /import \{([^}]*)\} from "\.\/connection"/.exec(rls)?.[1] ?? ""
    expect(imports).toContain("__request_pool_db__")
    expect(imports).toContain("__jobs_pool_db__")
    expect(imports).not.toMatch(/__privileged(_pool|_jobs_pool)?_db__/)
  })
})
