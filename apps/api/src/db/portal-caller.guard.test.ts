// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The portal context runs on the request login today, and on that login a statement can
// RESET ROLE back to the login's own rights: no in-transaction guard holds (portal-rls.test.ts
// records it). Only a session whose login is liaison_portal refuses the step back, so the portal
// gets its own login and pool before anything serves a client through it. Until that pool exists
// in connection.ts, this guard is the control: no product file may run withPortalContext, and a
// portal token is minted at the one session mint site only (auth.ts, for an external row, which
// only createExternalUser writes; external-boundary.guard.test.ts keeps that one uncalled).

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const SRC = join(import.meta.dir, "..")

/** Whole-line comments only, as the other source guards read code. */
function withoutComments(source: string): string {
  return source.replace(/^\s*\/\*[\s\S]*?\*\//gm, "").replace(/^\s*\/\/.*$/gm, "")
}

/** True when this source runs, or can reach, the portal transaction. */
export function reachesPortalContext(source: string): boolean {
  return /\bwithPortalContext\b|["'][^"']*\/portal-rls["']/.test(withoutComments(source))
}

/** True when this source mints a portal token. */
export function mintsPortalToken(source: string): boolean {
  return /\bsignPortalToken\b/.test(withoutComments(source))
}

/** True when connection.ts builds a pool on the liaison_portal login. */
export function hasPortalPool(connectionSource: string): boolean {
  return /\bexport const __portal_pool_db__\b/.test(withoutComments(connectionSource))
}

function productionFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      if (!["node_modules", "__fixtures__", "migrations"].includes(entry))
        productionFiles(path, out)
    } else if (
      entry.endsWith(".ts") &&
      !entry.endsWith(".test.ts") &&
      !entry.includes("test-fixtures") &&
      !entry.includes("test-helpers")
    ) {
      out.push(path)
    }
  }
  return out
}

const files = productionFiles(SRC).map((path) => ({
  file: relative(SRC, path),
  source: readFileSync(path, "utf8"),
}))
const portalPool = hasPortalPool(readFileSync(join(SRC, "db", "connection.ts"), "utf8"))

/** The one place a session token is chosen by the row's type. */
const MINT_SITES = ["modules/auth/jwt.ts", "modules/auth/auth.ts"]

describe("the portal context before its own login", () => {
  it("no product file runs the portal context while the portal pool does not exist", () => {
    const callers = files
      .filter(({ file, source }) => file !== "db/portal-rls.ts" && reachesPortalContext(source))
      .map(
        ({ file }) =>
          `${file} reaches withPortalContext, which runs on the request login: add the liaison_portal login and pool (connection.ts, __portal_pool_db__) first`,
      )
    expect(portalPool ? [] : callers).toEqual([])
  })

  it("once the portal pool exists, the portal context runs on it and not on the request pool", () => {
    const source = withoutComments(readFileSync(join(SRC, "db", "portal-rls.ts"), "utf8"))
    if (!portalPool) {
      expect(source).toContain("__request_pool_db__")
      return
    }
    expect(source).toContain("__portal_pool_db__")
    expect(source).not.toContain("__request_pool_db__")
  })

  it("a portal token is minted at the session mint site only", () => {
    const minters = files
      .filter(({ file, source }) => !MINT_SITES.includes(file) && mintsPortalToken(source))
      .map(({ file }) => file)
    expect(minters).toEqual([])
    const auth = files.find(({ file }) => file === "modules/auth/auth.ts")?.source ?? ""
    // The import and the one call in signSessionToken.
    expect(withoutComments(auth).match(/\bsignPortalToken\b/g)?.length).toBe(2)
  })

  describe("what counts", () => {
    it.each([
      ["a call", "await withPortalContext(ctx, fn)"],
      ["an aliased import", 'import { withPortalContext as run } from "~/db/portal-rls"'],
      ["a dynamic import", 'const m = await import("~/db/portal-rls")'],
      ["a relative import", 'import * as portal from "../../db/portal-rls"'],
    ])("%s reaches the portal context", (_label, source) => {
      expect(reachesPortalContext(source)).toBe(true)
    })

    it("a comment does not, nor does another module", () => {
      expect(reachesPortalContext("// withPortalContext later\nf()")).toBe(false)
      expect(reachesPortalContext('import { withRlsContext } from "~/db/rls"')).toBe(false)
    })

    it("the pool counts only as an export of connection.ts", () => {
      expect(hasPortalPool("export const __portal_pool_db__ = createPool(plan).db")).toBe(true)
      expect(hasPortalPool("// export const __portal_pool_db__ = later")).toBe(false)
      expect(hasPortalPool("export const __request_pool_db__ = x")).toBe(false)
    })
  })
})
