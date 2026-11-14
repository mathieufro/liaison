// SPDX-License-Identifier: FSL-1.1-ALv2
//
// deploy/rolling-deploy.sh against a `docker` shim that records every call and
// answers from a small state directory: which containers each service has
// before and after the scale-up, each container's health, the migration's exit
// code. The deploy's guarantee is its ORDER (migrate, start new beside old,
// wait until every new one is ready, only then drain the old ones) and what it
// never touches (no bare `up`, no recreate, no infrastructure service).
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const SCRIPT = path.join(import.meta.dir, "rolling-deploy.sh")
/** Step 4b's plain compose calls to the sandbox service, outside the deploy's profiles. */
const SANDBOX_STEP = /^compose (config --services|ps -a -q sandbox|up -d --no-deps sandbox)$/

const SHIM = `#!/bin/sh
S="$SHIM_STATE"
printf '%s\\n' "$*" >> "$S/calls.log"
[ "$1" = compose ] && printf '%s %s\\n' "\${API_REPLICAS:-unset}" "\${WORKER_REPLICAS:-unset}" >> "$S/replicas.log"
phase=before
[ -f "$S/up_done" ] && phase=after
if [ "$1" = compose ]; then
  shift
  while [ "$1" = --profile ]; do shift 2; done
  case "$1" in
    ps)
      svc=""; for a in "$@"; do svc="$a"; done
      f="$S/ps_\${svc}_$phase"
      case " $* " in *" -a "*) [ -f "\${f}_all" ] && f="\${f}_all" ;; esac
      [ -f "$f" ] || exit 0
      while read -r id; do [ -n "$id" ] && [ ! -f "$S/gone_$id" ] && echo "$id"; done < "$f"
      exit 0 ;;
    run) exit "$(cat "$S/migrate_exit" 2>/dev/null || echo 0)" ;;
    config) case " $* " in *" --services "*) cat "$S/config_services" 2>/dev/null ;; *) cat "$S/config_full" 2>/dev/null ;; esac; exit 0 ;;
    up) case "$*" in *--scale*) touch "$S/up_done" ;; *--wait*) exit "$(cat "$S/up_wait_exit" 2>/dev/null || echo 0)" ;; esac; exit 0 ;;
    *) exit 0 ;;
  esac
fi
case "$1" in
  inspect)
    fmt="$3"; id="$4"
    [ -f "$S/gone_$id" ] && exit 1
    case "$fmt" in
      *Health*) cat "$S/health_$id" 2>/dev/null || echo healthy ;;
      *ExitCode*) cat "$S/exitcode_$id" 2>/dev/null || echo 0 ;;
      *) cat "$S/status_$id" 2>/dev/null || echo running ;;
    esac
    exit 0 ;;
  rm) shift; for a in "$@"; do case "$a" in -*) ;; *) touch "$S/gone_$a" ;; esac; done; exit 0 ;;
  stop) exit 0 ;;
esac
exit 0
`

let dir: string
let state: string
let shim: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "rolling-deploy-test-"))
  state = path.join(dir, "state")
  mkdirSync(state)
  shim = path.join(dir, "docker")
  writeFileSync(shim, SHIM)
  chmodSync(shim, 0o755)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function setPs(service: string, before: string[], after: string[] = before): void {
  writeFileSync(path.join(state, `ps_${service}_before`), before.map((id) => `${id}\n`).join(""))
  writeFileSync(path.join(state, `ps_${service}_after`), after.map((id) => `${id}\n`).join(""))
}

/** Two old api + one old worker; the scale-up adds two api + one worker. */
function standardWorld(): void {
  setPs("api", ["old1", "old2"], ["old1", "old2", "new1", "new2"])
  setPs("worker", ["oldw"], ["oldw", "neww"])
  setPs("app", [])
}

function scriptEnv(env: Record<string, string>): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    DOCKER: shim,
    SHIM_STATE: state,
    LIAISON_IMAGE: "example/liaison:new",
    LIAISON_ROLLING_STATE_DIR: path.join(dir, "rolling"),
    EDGE_SETTLE_S: "0",
    READY_TIMEOUT_S: "5",
    ...env,
  }
}

function readCalls(): string[] {
  const log = path.join(state, "calls.log")
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []
}

function run(args: string[] = ["--wait-drain"], env: Record<string, string> = {}) {
  const proc = Bun.spawnSync(["sh", SCRIPT, ...args], {
    env: scriptEnv(env),
    stdout: "pipe",
    stderr: "pipe",
  })
  return { code: proc.exitCode, stderr: proc.stderr.toString(), calls: readCalls() }
}

const HOST = Bun.spawnSync(["hostname"]).stdout.toString().trim()
const rolling = (...p: string[]) => path.join(dir, "rolling", ...p)

/** A pid that is not running: a child that already exited. */
function deadPid(): number {
  const p = Bun.spawnSync(["sh", "-c", "echo $$"])
  return Number(p.stdout.toString().trim())
}

const indexOf = (calls: string[], pred: (c: string) => boolean): number => calls.findIndex(pred)
const lastIndexOf = (calls: string[], pred: (c: string) => boolean): number => {
  for (let i = calls.length - 1; i >= 0; i--) if (pred(calls[i] ?? "")) return i
  return -1
}

describe("rolling-deploy.sh", () => {
  it("takes the replica counts from deploy/.env and hands the same numbers to every compose call", () => {
    // The processes budget their pools from LIAISON_API_REPLICAS, which compose
    // interpolates from API_REPLICAS: the scale and the budget must agree.
    setPs("api", ["old1", "old2"], ["old1", "old2", "new1", "new2", "new3"])
    setPs("worker", ["oldw"], ["oldw", "neww"])
    setPs("app", [])
    const composeFile = path.join(dir, "docker-compose.yml")
    writeFileSync(composeFile, "services: {}\n")
    // Five api ports (2 old + 3 new): the range comes from deploy/.env too.
    writeFileSync(
      path.join(dir, ".env"),
      "POSTGRES_MAX_CONNECTIONS=200\nAPI_REPLICAS=3\nAPI_PORT_RANGE='3001-3006'\n",
    )
    const { code, calls, stderr } = run(["--wait-drain"], { COMPOSE_FILE: composeFile })
    expect(stderr).toContain("deploy done")
    expect(code).toBe(0)
    const up = calls.find((c) => c.startsWith("compose --profile rolling up")) ?? ""
    expect(up).toContain("--scale api=5")
    expect(up).toContain("--scale worker=2")
    const seen = new Set(readFileSync(path.join(state, "replicas.log"), "utf8").trim().split("\n"))
    expect([...seen]).toEqual(["3 1"])
  })

  it("an API_REPLICAS in the environment wins over deploy/.env", () => {
    standardWorld()
    const composeFile = path.join(dir, "docker-compose.yml")
    writeFileSync(composeFile, "services: {}\n")
    writeFileSync(path.join(dir, ".env"), "API_REPLICAS=3\n")
    const { code, calls } = run(["--wait-drain"], { COMPOSE_FILE: composeFile, API_REPLICAS: "2" })
    expect(code).toBe(0)
    expect(calls.find((c) => c.startsWith("compose --profile rolling up"))).toContain("--scale api=4")
    expect(readFileSync(path.join(state, "replicas.log"), "utf8").trim().split("\n")).not.toContain("3 1")
  })

  it("COMPOSE_PROFILES=meaning in deploy/.env adds its profile and brings the embedder up, never recreated", () => {
    standardWorld()
    const composeFile = path.join(dir, "docker-compose.yml")
    writeFileSync(composeFile, "services: {}\n")
    writeFileSync(path.join(dir, ".env"), "LIAISON_TOOL_MEANING=on\nCOMPOSE_PROFILES=meaning\n")
    const { code, calls, stderr } = run(["--wait-drain"], { COMPOSE_FILE: composeFile })
    expect(stderr).toContain("deploy done")
    expect(code).toBe(0)
    // The sandbox step (4b) reaches the service with a plain compose call; the rest go under the deploy's profiles.
    const compose = calls.filter((c) => c.startsWith("compose ") && !SANDBOX_STEP.test(c))
    for (const c of compose) expect(c.startsWith("compose --profile rolling --profile meaning ")).toBe(true)
    const embedder = indexOf(calls, (c) => c.endsWith(" up -d --no-recreate --no-deps embedder"))
    const migrate = indexOf(calls, (c) => c.includes(" run --rm --no-deps migrate"))
    const scale = indexOf(calls, (c) => c.includes(" up ") && c.includes("--scale"))
    expect(embedder).toBeGreaterThan(migrate)
    expect(scale).toBeGreaterThan(embedder)
    expect(calls.filter((c) => c.includes("embedder"))).toHaveLength(1)
  })

  it("COMPOSE_PROFILES in the environment wins over deploy/.env; several profiles each pass, rolling once", () => {
    standardWorld()
    const composeFile = path.join(dir, "docker-compose.yml")
    writeFileSync(composeFile, "services: {}\n")
    writeFileSync(path.join(dir, ".env"), "COMPOSE_PROFILES=other\n")
    const { code, calls } = run(["--wait-drain"], {
      COMPOSE_FILE: composeFile,
      COMPOSE_PROFILES: "rolling, meaning,extra",
    })
    expect(code).toBe(0)
    // The sandbox step (4b) reaches the service with a plain compose call; the rest go under the deploy's profiles.
    const compose = calls.filter((c) => c.startsWith("compose ") && !SANDBOX_STEP.test(c))
    for (const c of compose) {
      expect(c.startsWith("compose --profile rolling --profile meaning --profile extra ")).toBe(true)
      expect(c).not.toContain("other")
    }
    expect(calls.some((c) => c.endsWith(" up -d --no-recreate --no-deps embedder"))).toBe(true)
  })

  it("without the meaning profile the embedder is never started", () => {
    standardWorld()
    const { code, calls } = run()
    expect(code).toBe(0)
    expect(calls.some((c) => c.includes("embedder"))).toBe(false)
  })

  it("recreates a running sandbox service on the new image once the new processes are ready, before the old ones stop", () => {
    standardWorld()
    setPs("sandbox", ["sbx1"])
    const { code, calls } = run()
    expect(code).toBe(0)
    const ready = lastIndexOf(calls, (c) => c.startsWith("inspect") && c.includes("Health"))
    const recreate = indexOf(calls, (c) => c === "compose up -d --no-deps sandbox")
    const firstStop = indexOf(calls, (c) => c.startsWith("stop"))
    expect(recreate).toBeGreaterThan(ready)
    expect(firstStop).toBeGreaterThan(recreate)
  })

  it("leaves the sandbox service alone when the compose file has none", () => {
    standardWorld()
    const { code, calls } = run()
    expect(code).toBe(0)
    expect(calls.some((c) => c.includes("up -d --no-deps sandbox"))).toBe(false)
  })

  it("starts the sandbox service the compose file defines when none runs yet (a first rolling deploy)", () => {
    standardWorld()
    writeFileSync(path.join(state, "config_services"), "app\nsandbox\npostgres\n")
    const { code, calls } = run()
    expect(code).toBe(0)
    const ready = lastIndexOf(calls, (c) => c.startsWith("inspect") && c.includes("Health"))
    const start = indexOf(calls, (c) => c === "compose up -d --no-deps sandbox")
    const firstStop = indexOf(calls, (c) => c.startsWith("stop"))
    expect(start).toBeGreaterThan(ready)
    expect(firstStop).toBeGreaterThan(start)
  })

  it("does not start a missing sandbox service while LIAISON_APP_RUNTIME=quickjs", () => {
    standardWorld()
    writeFileSync(path.join(state, "config_services"), "app\nsandbox\n")
    writeFileSync(path.join(state, "config_full"), "services:\n  api:\n    environment:\n      LIAISON_APP_RUNTIME: quickjs\n")
    const { code, calls } = run()
    expect(code).toBe(0)
    expect(calls.some((c) => c.includes("up -d --no-deps sandbox"))).toBe(false)
  })

  it("the order is migrate → scale up → readyz wait on the new ids → stop old ids", () => {
    standardWorld()
    const { code, calls, stderr } = run()
    expect(stderr).toContain("deploy done")
    expect(code).toBe(0)

    const migrate = indexOf(calls, (c) => c.startsWith("compose --profile rolling run --rm --no-deps migrate"))
    const up = indexOf(calls, (c) => c.startsWith("compose --profile rolling up"))
    const lastHealth = lastIndexOf(calls, (c) => c.startsWith("inspect") && c.includes("Health"))
    const stop = indexOf(calls, (c) => c.startsWith("stop"))
    expect(migrate).toBeGreaterThanOrEqual(0)
    expect(up).toBeGreaterThan(migrate)
    expect(lastHealth).toBeGreaterThan(up)
    expect(stop).toBeGreaterThan(lastHealth)

    // The scale is old + new for each service, and the new ids are what it waited on.
    expect(calls[up]).toBe(
      "compose --profile rolling up -d --no-recreate --no-deps --scale api=4 --scale worker=2 api worker",
    )
    const waited = calls
      .filter((c) => c.startsWith("inspect") && c.includes("Health"))
      .map((c) => c.split(" ").at(-1))
    expect(new Set(waited)).toEqual(new Set(["new1", "new2", "neww"]))

    // Only the old ids are stopped, with the full drain budget, then removed.
    expect(calls[stop]).toBe("stop -t 660 old1 old2 oldw")
    expect(calls.filter((c) => c.startsWith("stop"))).toHaveLength(1)
    expect(calls).toContain("rm old1 old2 oldw")
  })

  it("never runs a bare up, never recreates, never touches app or the infrastructure services", () => {
    standardWorld()
    const { code, calls } = run()
    expect(code).toBe(0)
    const compose = calls.filter((c) => c.startsWith("compose "))
    for (const c of compose) {
      const words = c.split(" ")
      const verb = words[3]
      if (verb === "up") {
        expect(words).toContain("--no-recreate")
        expect(words).toContain("--no-deps")
        expect(words.slice(-2)).toEqual(["api", "worker"])
      }
      if (verb === "run") expect(c).toBe("compose --profile rolling run --rm --no-deps migrate")
      expect(words).not.toContain("--force-recreate")
      if (verb === "up" || verb === "run" || verb === "start" || verb === "restart") {
        for (const infra of ["app", "postgres", "redis", "meilisearch", "objectstore"]) {
          expect(words.slice(4)).not.toContain(infra)
        }
      }
    }
    expect(compose.filter((c) => c.split(" ")[3] === "up")).toHaveLength(1)
  })

  it("a draining container refuses the deploy", () => {
    standardWorld()
    mkdirSync(path.join(dir, "rolling"))
    writeFileSync(path.join(dir, "rolling", "draining"), "old9\n")
    // The drain that owns it is alive (this test process stands in for it).
    writeFileSync(path.join(dir, "rolling", "drain.pid"), `${process.pid}\n`)
    const { code, calls, stderr } = run()
    expect(code).toBe(75)
    expect(stderr).toContain("still draining")
    expect(calls.some((c) => c.includes(" run ") || c.includes(" up "))).toBe(false)
    expect(calls.some((c) => c.startsWith("stop"))).toBe(false)
  })

  it("a draining list whose containers are gone is cleared and the deploy runs", () => {
    standardWorld()
    mkdirSync(path.join(dir, "rolling"))
    writeFileSync(path.join(dir, "rolling", "draining"), "old9\n")
    writeFileSync(path.join(state, "gone_old9"), "")
    const { code } = run()
    expect(code).toBe(0)
  })

  it("a second deploy while one holds the lock is refused", () => {
    standardWorld()
    mkdirSync(path.join(dir, "rolling", "lock"), { recursive: true })
    const { code, calls } = run()
    expect(code).toBe(1)
    expect(calls).toHaveLength(0)
  })

  it("a new container that never gets ready rolls back: new ids stopped, old keep serving, exit 1", () => {
    standardWorld()
    writeFileSync(path.join(state, "health_new2"), "starting\n")
    const { code, calls, stderr } = run(["--wait-drain"], { READY_TIMEOUT_S: "1" })
    expect(code).toBe(1)
    expect(stderr).toContain("ROLLBACK")
    const stops = calls.filter((c) => c.startsWith("stop"))
    expect(stops).toEqual(["stop -t 660 new1 new2 neww"])
    expect(calls).toContain("rm -f new1 new2 neww")
    for (const c of calls) {
      if (c.startsWith("stop") || c.startsWith("rm")) expect(c).not.toMatch(/old/)
    }
    expect(existsSync(path.join(dir, "rolling", "lock"))).toBe(false)
  })

  it("a new container that exits during boot rolls back at once", () => {
    standardWorld()
    writeFileSync(path.join(state, "status_neww"), "exited\n")
    const { code, stderr, calls } = run()
    expect(code).toBe(1)
    expect(stderr).toContain("neww is exited")
    expect(calls.some((c) => c.startsWith("stop") && c.includes("old"))).toBe(false)
  })

  it("a failed migration changes nothing", () => {
    standardWorld()
    writeFileSync(path.join(state, "migrate_exit"), "3")
    const { code, calls } = run()
    expect(code).toBe(1)
    expect(calls.some((c) => c.includes(" up "))).toBe(false)
    expect(calls.some((c) => c.startsWith("stop"))).toBe(false)
  })

  it("a first run beside the single app container stops app only after the new processes are ready", () => {
    setPs("api", [], ["new1", "new2"])
    setPs("worker", [], ["neww"])
    setPs("app", ["app1"])
    const { code, calls } = run()
    expect(code).toBe(0)
    expect(calls).toContain(
      "compose --profile rolling up -d --no-recreate --no-deps --scale api=2 --scale worker=1 api worker",
    )
    const lastHealth = lastIndexOf(calls, (c) => c.startsWith("inspect") && c.includes("Health"))
    const stop = indexOf(calls, (c) => c.startsWith("stop"))
    expect(stop).toBeGreaterThan(lastHealth)
    expect(calls[stop]).toBe("stop -t 660 app1")
  })

  it("refuses before migrating when old + new api processes do not fit the port range", () => {
    standardWorld()
    const { code, calls, stderr } = run(["--wait-drain"], { API_PORT_RANGE: "3001-3003" })
    expect(code).toBe(1)
    expect(stderr).toContain("API_PORT_RANGE")
    expect(calls.some((c) => c.includes(" run "))).toBe(false)
  })

  it("drains in the background by default and clears the draining list when done", async () => {
    standardWorld()
    const { code } = run([])
    expect(code).toBe(0)
    const drainLog = path.join(dir, "rolling", "drain.log")
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (existsSync(drainLog) && readFileSync(drainLog, "utf8").includes("old containers removed")) break
      await Bun.sleep(100)
    }
    expect(readFileSync(drainLog, "utf8")).toContain("old containers removed: old1 old2 oldw")
    expect(existsSync(path.join(dir, "rolling", "draining"))).toBe(false)
    const calls = readFileSync(path.join(state, "calls.log"), "utf8")
    expect(calls).toContain("stop -t 660 old1 old2 oldw")
  })

  it("SIGTERM before the switch rolls back what the run started, releases the lock, exits non-zero", async () => {
    standardWorld()
    writeFileSync(path.join(state, "health_new2"), "starting\n")
    const proc = Bun.spawn(["sh", SCRIPT, "--wait-drain"], {
      env: scriptEnv({ READY_TIMEOUT_S: "60" }),
      stdout: "pipe",
      stderr: "pipe",
    })
    const deadline = Date.now() + 10_000
    while (!readCalls().some((c) => c.includes("Health")) && Date.now() < deadline) await Bun.sleep(50)
    proc.kill("SIGTERM")
    const code = await proc.exited
    const stderr = await new Response(proc.stderr).text()
    expect(code).toBe(143)
    expect(stderr).toContain("interrupted by SIGTERM")
    const calls = readCalls()
    expect(calls.filter((c) => c.startsWith("stop"))).toEqual(["stop -t 660 new1 new2 neww"])
    for (const c of calls) if (c.startsWith("stop") || c.startsWith("rm")) expect(c).not.toMatch(/old/)
    expect(existsSync(rolling("lock"))).toBe(false)
    expect(existsSync(rolling("pending"))).toBe(false)
  })

  it("SIGHUP (a dropped SSH session) is handled the same way", async () => {
    standardWorld()
    writeFileSync(path.join(state, "health_new2"), "starting\n")
    const proc = Bun.spawn(["sh", SCRIPT, "--wait-drain"], {
      env: scriptEnv({ READY_TIMEOUT_S: "60" }),
      stdout: "pipe",
      stderr: "pipe",
    })
    const deadline = Date.now() + 10_000
    while (!readCalls().some((c) => c.includes("Health")) && Date.now() < deadline) await Bun.sleep(50)
    proc.kill("SIGHUP")
    expect(await proc.exited).toBe(129)
    expect(readCalls()).toContain("rm -f new1 new2 neww")
    expect(existsSync(rolling("lock"))).toBe(false)
  })

  it("a lock held by a live deploy refuses; a lock whose owner is gone is taken over", () => {
    standardWorld()
    mkdirSync(rolling("lock"), { recursive: true })
    writeFileSync(rolling("lock", "owner"), `${process.pid} ${HOST}\n`)
    const held = run()
    expect(held.code).toBe(1)
    expect(held.stderr).toContain(`another deploy is running (pid ${process.pid})`)
    expect(held.calls).toHaveLength(0)

    writeFileSync(rolling("lock", "owner"), `${deadPid()} ${HOST}\n`)
    const stale = run()
    expect(stale.stderr).toContain("taking over a stale lock")
    expect(stale.code).toBe(0)
    expect(existsSync(rolling("lock"))).toBe(false)
  })

  it("the lock names its owner while a deploy runs", () => {
    standardWorld()
    writeFileSync(path.join(state, "migrate_exit"), "0")
    // The shim's migrate step copies the owner file aside.
    writeFileSync(
      shim,
      readFileSync(shim, "utf8").replace(
        "run) exit",
        `run) cp "${rolling("lock", "owner")}" "$S/owner_seen"; exit`,
      ),
    )
    expect(run().code).toBe(0)
    const [pid, host] = readFileSync(path.join(state, "owner_seen"), "utf8").trim().split(" ")
    expect(Number(pid)).toBeGreaterThan(0)
    expect(host).toBe(HOST)
  })

  it("an exited container in the draining list is removed and no longer blocks the deploy", () => {
    standardWorld()
    mkdirSync(rolling())
    writeFileSync(rolling("draining"), "old9\n")
    writeFileSync(path.join(state, "status_old9"), "exited\n")
    const { code, calls } = run()
    expect(code).toBe(0)
    expect(calls).toContain("rm old9")
  })

  it("a running drained container with no drain process behind it is drained again", async () => {
    standardWorld()
    mkdirSync(rolling())
    writeFileSync(rolling("draining"), "old9\n")
    writeFileSync(rolling("drain.pid"), `${deadPid()}\n`)
    const { code, stderr } = run()
    expect(code).toBe(75)
    expect(stderr).toContain("draining them again")
    const deadline = Date.now() + 10_000
    while (!readCalls().includes("stop -t 660 old9") && Date.now() < deadline) await Bun.sleep(50)
    expect(readCalls()).toContain("stop -t 660 old9")
    expect(readCalls().some((c) => c.includes(" run "))).toBe(false)
  })

  it("a deploy killed before its switch is rolled back by the next run, then the deploy goes on", () => {
    // The killed run left new1/new2/neww beside old1/old2/oldw and its record.
    setPs("api", ["old1", "old2", "new1", "new2"], ["old1", "old2", "new3", "new4"])
    setPs("worker", ["oldw", "neww"], ["oldw", "neww2"])
    setPs("app", [])
    mkdirSync(rolling())
    writeFileSync(rolling("pending"), "image=example/liaison:killed\nold=old1 old2 oldw\n")
    const { code, calls, stderr } = run()
    expect(stderr).toContain("was interrupted before its switch")
    expect(code).toBe(0)
    const rollbackStop = calls.findIndex((c) => c === "stop -t 660 new1 new2 neww")
    const migrate = calls.findIndex((c) => c.includes(" run "))
    expect(rollbackStop).toBeGreaterThanOrEqual(0)
    expect(migrate).toBeGreaterThan(rollbackStop)
    expect(calls).toContain(
      "compose --profile rolling up -d --no-recreate --no-deps --scale api=4 --scale worker=2 api worker",
    )
    expect(calls).toContain("stop -t 660 old1 old2 oldw")
    expect(existsSync(rolling("pending"))).toBe(false)
  })

  it("the pending record exists from the scale-up until the switch", () => {
    standardWorld()
    writeFileSync(
      shim,
      readFileSync(shim, "utf8").replace(
        "up) case",
        `up) cp "${rolling("pending")}" "$S/pending_seen" 2>/dev/null; case`,
      ),
    )
    expect(run().code).toBe(0)
    expect(readFileSync(path.join(state, "pending_seen"), "utf8")).toBe(
      "image=example/liaison:new\nold=old1 old2 oldw\n",
    )
    expect(existsSync(rolling("pending"))).toBe(false)
  })

  it("a crash-looping new container (not in `ps` without -a) is caught and rolled back too", () => {
    setPs("api", ["old1", "old2"], ["old1", "old2", "new1"])
    writeFileSync(path.join(state, "ps_api_after_all"), "old1\nold2\nnew1\nnew2\n")
    writeFileSync(path.join(state, "status_new2"), "restarting\n")
    setPs("worker", ["oldw"], ["oldw", "neww"])
    setPs("app", [])
    const { code, calls, stderr } = run()
    expect(code).toBe(1)
    expect(stderr).toContain("new2 is restarting")
    expect(calls).toContain("rm -f new1 new2 neww")
    expect(calls.some((c) => c.startsWith("stop") && c.includes("old"))).toBe(false)
  })

  it("refuses a non-numeric DRAIN_TIMEOUT_S or EDGE_SETTLE_S", () => {
    standardWorld()
    expect(run(["--wait-drain"], { DRAIN_TIMEOUT_S: "11m" }).stderr).toContain("DRAIN_TIMEOUT_S")
    expect(run(["--wait-drain"], { EDGE_SETTLE_S: "x" }).stderr).toContain("EDGE_SETTLE_S")
  })

  it("a failed catalog app in the migrate step stops the deploy with a message that says so", () => {
    standardWorld()
    writeFileSync(path.join(state, "migrate_exit"), "1")
    const { code, stderr, calls } = run()
    expect(code).toBe(1)
    expect(stderr).toContain("a catalog app that did not install")
    expect(calls.some((c) => c.includes(" up "))).toBe(false)
  })

  it("--infra brings the infrastructure up first and says it is not zero-downtime", () => {
    standardWorld()
    const { code, calls, stderr } = run(["--wait-drain", "--infra"])
    expect(code).toBe(0)
    expect(stderr).toContain("NOT zero-downtime")
    expect(calls[indexOf(calls, (c) => c.includes(" up "))]).toBe(
      "compose --profile rolling up -d --wait postgres redis meilisearch objectstore objectstore-init data-init",
    )
  })

  it("--infra accepts a compose --wait that failed only on a one-shot's exit 0", () => {
    standardWorld()
    writeFileSync(path.join(state, "up_wait_exit"), "1\n")
    const services = ["postgres", "redis", "meilisearch", "objectstore", "objectstore-init", "data-init"]
    for (const svc of services) {
      writeFileSync(path.join(state, `ps_${svc}_before_all`), `c-${svc}\n`)
      writeFileSync(path.join(state, `ps_${svc}_after_all`), `c-${svc}\n`)
    }
    for (const svc of ["objectstore-init", "data-init"]) {
      writeFileSync(path.join(state, `status_c-${svc}`), "exited\n")
    }
    const ok = run(["--wait-drain", "--infra"])
    expect(ok.code).toBe(0)
    expect(ok.stderr).toContain("every infrastructure service runs or exited 0")
  })

  it("--infra refuses a compose --wait failure when a one-shot exited non-zero", () => {
    standardWorld()
    writeFileSync(path.join(state, "up_wait_exit"), "1\n")
    const services = ["postgres", "redis", "meilisearch", "objectstore", "objectstore-init", "data-init"]
    for (const svc of services) writeFileSync(path.join(state, `ps_${svc}_before_all`), `c-${svc}\n`)
    writeFileSync(path.join(state, "status_c-data-init"), "exited\n")
    writeFileSync(path.join(state, "exitcode_c-data-init"), "3\n")
    const bad = run(["--wait-drain", "--infra"])
    expect(bad.code).not.toBe(0)
    expect(bad.stderr).toContain("the infrastructure services did not come up")
  })

  it("requires LIAISON_IMAGE", () => {
    standardWorld()
    const { code, stderr } = run(["--wait-drain"], { LIAISON_IMAGE: "" })
    expect(code).not.toBe(0)
    expect(stderr).toContain("LIAISON_IMAGE")
  })
})
