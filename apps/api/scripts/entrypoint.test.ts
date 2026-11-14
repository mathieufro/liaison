// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The image entrypoint (apps/api/scripts/entrypoint.sh), run with `bun`
// replaced by a shim on PATH that records each call, so the steps, their
// order, their environment and the signal path are checked without a
// database.
import { afterEach, describe, expect, it } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ENTRYPOINT = join(import.meta.dir, "entrypoint.sh")
const DOCKERFILE = join(import.meta.dir, "..", "Dockerfile")

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A fake app dir and a `bun` shim that logs `<step>|MIG=<url or unset>` per call. */
function sandbox(): { root: string; log: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), "entrypoint-"))
  dirs.push(root)
  mkdirSync(join(root, "app", "apps", "api"), { recursive: true })
  mkdirSync(join(root, "bin"))
  const log = join(root, "calls.log")
  const shim = join(root, "bin", "bun")
  writeFileSync(
    shim,
    `#!/bin/sh
step="$*"
case "$step" in
  *migrate.ts*) step=migrate ;;
  *schema-guard.ts*) step=guard ;;
  *reconcile-catalog-boot.ts*) step=reconcile ;;
  *index.ts*) step=server ;;
  *embedder-main.ts*) step=embedder ;;
esac
echo "$step|MIG=\${MIGRATION_DATABASE_URL-unset}" >> "${log}"
if [ "$step" = server ] && [ -n "\${PROBE:-}" ]; then exec "\${REAL_BUN}" "\${PROBE}"; fi
if [ "$step" = migrate ] && [ -n "\${PROBE_MIGRATE:-}" ]; then exec "\${REAL_BUN}" "\${PROBE_MIGRATE}"; fi
if [ "$step" = migrate ] && [ -n "\${FAIL_MIGRATE:-}" ]; then exit 3; fi
if [ "$step" = guard ] && [ -n "\${FAIL_GUARD:-}" ]; then exit 1; fi
if [ "$step" = reconcile ] && [ -n "\${FAIL_RECONCILE:-}" ]; then
  case "$*" in *--strict*) exit 1 ;; *) exit 0 ;; esac
fi
exit 0
`,
  )
  chmodSync(shim, 0o755)
  const env: NodeJS.ProcessEnv = {
    PATH: `${join(root, "bin")}:/usr/bin:/bin`,
    LIAISON_APP_DIR: join(root, "app"),
    DATABASE_URL: "postgres://app@db/liaison",
    MIGRATION_DATABASE_URL: "postgres://migrator@db/liaison",
    REAL_BUN: process.execPath,
  }
  return { root, log, env }
}

function runEntrypoint(env: NodeJS.ProcessEnv, args: string[] = []) {
  return spawnSync("sh", [ENTRYPOINT, ...args], { env, encoding: "utf8" })
}

const calls = (log: string) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [])

describe("image entrypoint", () => {
  it("serve (the default) migrates, reconciles, then starts the server without the privileged URL", () => {
    const { log, env } = sandbox()
    const r = runEntrypoint(env)
    expect(r.status).toBe(0)
    expect(calls(log)).toEqual([
      "migrate|MIG=postgres://migrator@db/liaison",
      "reconcile|MIG=postgres://migrator@db/liaison",
      "server|MIG=unset",
    ])
  })

  it("LIAISON_MIGRATE_ON_START=false skips the migration, still checks the schema, reconciles and serves", () => {
    const { log, env } = sandbox()
    const r = runEntrypoint({ ...env, LIAISON_MIGRATE_ON_START: "false" })
    expect(r.status).toBe(0)
    expect(calls(log)[0]).toBe("guard|MIG=postgres://migrator@db/liaison")
    expect(calls(log).map((l) => l.split("|")[0])).toEqual(["guard", "reconcile", "server"])
  })

  it("an image older than the schema stops a start without the migration: no reconcile, no server", () => {
    const { log, env } = sandbox()
    const r = runEntrypoint({ ...env, LIAISON_MIGRATE_ON_START: "false", FAIL_GUARD: "1" })
    expect(r.status).not.toBe(0)
    expect(calls(log).map((l) => l.split("|")[0])).toEqual(["guard"])
  })

  it("`embedder` starts only the embedding process, without migrating and without the privileged URL", () => {
    const { log, env } = sandbox()
    const r = runEntrypoint(env, ["embedder"])
    expect(r.status).toBe(0)
    expect(calls(log)).toEqual(["embedder|MIG=unset"])
  })

  it("`migrate` migrates and reconciles, then exits without starting the server", () => {
    const { log, env } = sandbox()
    const r = runEntrypoint({ ...env, LIAISON_MIGRATE_ON_START: "false" }, ["migrate"])
    expect(r.status).toBe(0)
    expect(calls(log).map((l) => l.split("|")[0])).toEqual(["migrate", "reconcile"])
  })

  it("`migrate` fails when a catalog app does not install (strict); a server start does not", () => {
    const { log, env } = sandbox()
    const r = runEntrypoint({ ...env, FAIL_RECONCILE: "1" }, ["migrate"])
    expect(r.status).not.toBe(0)
    expect(calls(log).map((l) => l.split("|")[0])).toEqual(["migrate", "reconcile"])

    const served = sandbox()
    const s = runEntrypoint({ ...served.env, FAIL_RECONCILE: "1" })
    expect(s.status).toBe(0)
    expect(calls(served.log).map((l) => l.split("|")[0])).toEqual([
      "migrate",
      "reconcile",
      "server",
    ])
  })

  it("a failed migration stops the start: no reconcile, no server, non-zero exit", () => {
    const { log, env } = sandbox()
    const r = runEntrypoint({ ...env, FAIL_MIGRATE: "1" })
    expect(r.status).not.toBe(0)
    expect(calls(log).map((l) => l.split("|")[0])).toEqual(["migrate"])
  })

  it("migrate falls back to DATABASE_URL when MIGRATION_DATABASE_URL is unset", () => {
    const { log, env } = sandbox()
    const { MIGRATION_DATABASE_URL: _drop, ...rest } = env
    const r = runEntrypoint(rest, ["migrate"])
    expect(r.status).toBe(0)
    expect(calls(log)[0]).toBe("migrate|MIG=postgres://app@db/liaison")
  })

  it("any other command runs as given (one-off CLI containers)", () => {
    const { log, env } = sandbox()
    const r = runEntrypoint(env, ["bun", "apps/api/bin/liaison", "config", "apply"])
    expect(r.status).toBe(0)
    expect(calls(log)).toEqual([
      "apps/api/bin/liaison config apply|MIG=postgres://migrator@db/liaison",
    ])
  })

  it("the image runs this entrypoint", () => {
    const src = readFileSync(DOCKERFILE, "utf8")
    expect(src).toContain('ENTRYPOINT ["sh", "/app/apps/api/scripts/entrypoint.sh"]')
    expect(src).toContain('CMD ["serve"]')
  })

  // `docker stop` on the migrate one-shot signals the shell. The migration
  // must get it too, so it releases its lease instead of leaving it held
  // until the TTL, and the shell must stop there (no reconcile after).
  for (const [mode, args] of [
    ["the migrate one-shot", ["migrate"]],
    ["serve's migrate step", []],
  ] as const) {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      it(`${mode} forwards ${signal} to the migration and stops`, async () => {
        const { root, log, env } = sandbox()
        const ready = join(root, "ready")
        const got = join(root, "got-signal")
        const probe = join(root, "migrate-probe.ts")
        writeFileSync(
          probe,
          `import { writeFileSync } from "node:fs"
for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => { writeFileSync(${JSON.stringify(got)}, s); process.exit(1) })
writeFileSync(${JSON.stringify(ready)}, "1")
setInterval(() => {}, 1000)
`,
        )
        const child = spawn("sh", [ENTRYPOINT, ...args], {
          env: { ...env, PROBE_MIGRATE: probe },
          detached: true,
          stdio: "ignore",
        })
        const exited = new Promise<number | null>((done) => child.on("exit", (code) => done(code)))
        try {
          const until = async (path: string, ms: number) => {
            const end = Date.now() + ms
            while (Date.now() < end && !existsSync(path)) await Bun.sleep(25)
            return existsSync(path)
          }
          expect(await until(ready, 10_000)).toBe(true)
          if (child.pid === undefined) throw new Error("entrypoint did not start")
          process.kill(child.pid, signal)
          expect(await until(got, 3_000)).toBe(true)
          // SIGINT goes on as SIGTERM (a background job starts with SIGINT ignored).
          expect(readFileSync(got, "utf8")).toBe("SIGTERM")
          const code = await Promise.race([exited, Bun.sleep(3_000).then(() => "hung" as const)])
          expect(code).not.toBe("hung")
          expect(code).not.toBe(0)
          expect(calls(log).map((l) => l.split("|")[0])).toEqual(["migrate"])
        } finally {
          try {
            if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL")
          } catch {}
        }
      })
    }
  }

  // Docker sends SIGTERM to the top process. A shell there does not forward
  // it, so the server must be `exec`ed: the app IS the process Docker signals.
  it("the server receives SIGTERM sent to the top process", async () => {
    const { root, env } = sandbox()
    const ready = join(root, "ready")
    const got = join(root, "got-sigterm")
    const probe = join(root, "probe.ts")
    writeFileSync(
      probe,
      `import { writeFileSync } from "node:fs"
process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(got)}, "1"); process.exit(0) })
writeFileSync(${JSON.stringify(ready)}, "1")
setInterval(() => {}, 1000)
`,
    )
    const child = spawn("sh", [ENTRYPOINT], {
      env: { ...env, PROBE: probe },
      detached: true,
      stdio: "ignore",
    })
    try {
      const until = async (path: string, ms: number) => {
        const end = Date.now() + ms
        while (Date.now() < end && !existsSync(path)) await Bun.sleep(25)
        return existsSync(path)
      }
      expect(await until(ready, 10_000)).toBe(true)
      if (child.pid === undefined) throw new Error("entrypoint did not start")
      process.kill(child.pid, "SIGTERM")
      expect(await until(got, 3_000)).toBe(true)
    } finally {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL")
      } catch {}
    }
  })
})
