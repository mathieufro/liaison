// SPDX-License-Identifier: FSL-1.1-ALv2
// e2e-own-server: the subject is the lane's own seeded world, so this file
// boots a lane of its own (createE2eLane) and reads its schemas back.
//
// The `standard` tier's output, pinned. A Playwright lane is booted the way
// pw-lanes.ts boots one (org, admin, the standard world, outbox drained, search
// idle), then every table of the lane's schemas is read back, normalised for
// what legitimately differs between two runs (ids, write-time clocks, salted
// hashes and ciphertexts, login sessions) and compared with
// `standard-seed-snapshot.expected.json`: the row count and a content digest
// per table.
//
// Timestamps the world places relative to its `now` (an approval that expired
// an hour ago, a mail received 36 hours ago) are kept as their offset from the
// moment the seed started, rounded to five minutes; a timestamp taken while the
// lane was being built reads `<written>`.
//
// A change that is MEANT to change the world rewrites the expected file:
//
//   SEED_SNAPSHOT_WRITE=1 bun run scripts/test-run.ts e2e \
//     --file src/tests/e2e/standard-seed-snapshot.scenario.test.ts
//
// SEED_SNAPSHOT_DUMP=<dir> also writes each table's normalised rows there, so
// two runs can be diffed row by row.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  createDbClient,
  createE2eLane,
  DATABASE_URL,
  type E2eLane,
  seedStandardWorld,
} from "@liaison/test-helpers"

const EXPECTED_FILE = path.join(import.meta.dir, "standard-seed-snapshot.expected.json")
const ADMIN = { email: "admin@test.com", password: "12345678", name: "Elodie Vasseur" }
const ROUND_MS = 5 * 60_000

/**
 * Login state, not world: every sign-in (the lane's, the seed driver's) adds a
 * session and a refresh token, and the number of sign-ins is the driver's
 * business, not the world's.
 */
const LOGIN_TABLES = /^kernel\.(sessions|refresh_tokens|auth_sessions|login_attempts)$/

/**
 * Derived state, not world: the apps' stored attention lists are recomputed
 * from the world's rows by queued refresh jobs (attention-store.ts), so which
 * of them exist when the lane is read is a matter of which jobs ran by then.
 * The rows they are computed from are pinned in their own tables.
 */
const DERIVED_TABLES = /^kernel\.app_attention_items$/

/** A sign-in's outbox event (`auth` / `login`): login state too. */
function isSignIn(name: string, row: Record<string, unknown>): boolean {
  const p = row.payload as { entity?: string; action?: string } | null
  return name === "kernel.pending_events" && p?.entity === "auth" && p.action === "login"
}

/**
 * Columns whose value is random per run by design: salted hashes, ciphertexts,
 * per-row secrets and one-time tokens. Their presence is kept, their value is not.
 */
const VOLATILE_COLUMN =
  /(^|_)(hash|salt|iv|nonce|secret|token|ciphertext|encrypted|signature|key_material|wrapped_key|fingerprint)(_|$)/
/** The process that claimed an outbox row: whichever server instance ran. */
const PROCESS_COLUMN = /^claimed_by$/
/**
 * When a notification may join a digest: the attention pipeline pushes it past
 * the recipient's quiet hours, so it depends on the hour the lane was built.
 */
const SCHEDULE_COLUMN = /^digest_eligible_at$/
/**
 * The org's setup stamp: a hash of the build id and every app's version
 * (setup-stamp.ts), so it differs between two checkouts, or a runner and a
 * laptop, for the same world. Its presence is kept, its value is not.
 */
const BUILD_COLUMN = /^app_setup_stamp$/
/** Values handed out in arrival order by a counter. */
const ARRIVAL_ORDER_COLUMN = /^(seq|avatar_color)$/
const COUNTER_HANDLE = /-[0-9a-f-]*\d[0-9a-f-]*$/
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
/** A user id's first eight characters inside an address (`elodie.personal+1a2b3c4d@`). */
const ID_PREFIX_IN_ADDRESS = /\+[0-9a-f]{8}@/g
/** The QA roles' names carry the instant they were made. */
const QA_ROLE_NAME = /^e2e-role-\d+-[a-z0-9]+$/
/** An epoch-milliseconds stamp inside a value (a burst's `notifyId`, `burst:<user>:<ms>`). */
const EPOCH_MS = /\b\d{13}\b/g
const ISO_TS = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)?$/

interface TableSnapshot {
  rows: number
  digest: string
}
type Snapshot = Record<string, TableSnapshot>

interface Clock {
  /** The lane's build: anything stamped inside it reads `<written>`. */
  from: number
  to: number
  /** The seed's start: the world's `now`. */
  seedStart: number
}

/** A value naming a lane schema (`w57_app_knowledge.documents`) names it without the lane's
 *  prefix, which is the lane's worker id: the snapshot is the same whichever lane ran it. */
function stripLanePrefix(value: string, prefix: string): string {
  return prefix === "" ? value : value.split(prefix).join("")
}

function normalise(value: unknown, column: string, clock: Clock, prefix = ""): unknown {
  if (value === null || value === undefined) return value
  if (VOLATILE_COLUMN.test(column)) return "<volatile>"
  if (ARRIVAL_ORDER_COLUMN.test(column)) return "<counter>"
  if (PROCESS_COLUMN.test(column)) return "<process>"
  if (BUILD_COLUMN.test(column)) return "<build>"
  if (SCHEDULE_COLUMN.test(column)) return "<scheduled>"
  if (column === "handle" && typeof value === "string") return value.replace(COUNTER_HANDLE, "-<n>")
  if (typeof value === "string") {
    if (ISO_TS.test(value)) {
      const t = Date.parse(value)
      if (Number.isNaN(t)) return value
      if (t >= clock.from && t <= clock.to) return "<written>"
      const steps = Math.round((t - clock.seedStart) / ROUND_MS) || 0
      return `now${steps >= 0 ? "+" : ""}${steps * 5}m`
    }
    if (QA_ROLE_NAME.test(value)) return "e2e-role-<n>"
    return stripLanePrefix(value, prefix)
      .replace(EPOCH_MS, (ms) => {
        const t = Number(ms)
        return t >= clock.from && t <= clock.to ? "<written>" : ms
      })
      .replace(UUID, "<uuid>")
      .replace(ID_PREFIX_IN_ADDRESS, "+<id>@")
  }
  if (Array.isArray(value)) {
    return value
      .map((v) => normalise(v, column, clock, prefix))
      .map((v) => JSON.stringify(v))
      .sort()
      .map((v) => JSON.parse(v) as unknown)
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key.replace(UUID, "<uuid>")] = normalise(
        (value as Record<string, unknown>)[key],
        key,
        clock,
        prefix,
      )
    }
    return out
  }
  return value
}

async function snapshotLane(
  schemaPrefix: string,
  clock: Clock,
  dumpDir: string | null,
): Promise<Snapshot> {
  const db = createDbClient(DATABASE_URL)
  try {
    const tables = (await db.sql.unsafe(
      `SELECT table_schema AS schema, table_name AS table FROM information_schema.tables
       WHERE table_type = 'BASE TABLE' AND table_schema LIKE $1 ORDER BY 1, 2`,
      [`${schemaPrefix.replace(/_/g, "\\_")}%`],
    )) as unknown as Array<{ schema: string; table: string }>
    const snapshot: Snapshot = {}
    for (const { schema, table } of tables) {
      const name = `${schema.slice(schemaPrefix.length)}.${table}`
      if (LOGIN_TABLES.test(name) || DERIVED_TABLES.test(name)) continue
      const rows = (await db.sql.unsafe(
        `SELECT to_jsonb(x) AS r FROM "${schema}"."${table}" x`,
      )) as unknown as Array<{ r: Record<string, unknown> }>
      if (rows.length === 0) continue
      const lines = rows
        .filter(({ r }) => !isSignIn(name, r))
        .map(({ r }) => {
          const out: Record<string, unknown> = {}
          for (const col of Object.keys(r).sort())
            out[col] = normalise(r[col], col, clock, schemaPrefix)
          return JSON.stringify(out)
        })
        .sort()
      snapshot[name] = {
        rows: lines.length,
        digest: createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16),
      }
      if (dumpDir) writeFileSync(path.join(dumpDir, `${name}.jsonl`), `${lines.join("\n")}\n`)
    }
    return snapshot
  } finally {
    await db.close()
  }
}

function diff(expected: Snapshot, actual: Snapshot): string[] {
  const out: string[] = []
  for (const name of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
    const e = expected[name]
    const a = actual[name]
    if (!e) out.push(`${name}: new (${a?.rows} rows)`)
    else if (!a) out.push(`${name}: gone (was ${e.rows} rows)`)
    else if (e.rows !== a.rows) out.push(`${name}: ${e.rows} -> ${a.rows} rows`)
    else if (e.digest !== a.digest)
      out.push(`${name}: content changed (${a.rows} rows, ${e.digest} -> ${a.digest})`)
  }
  return out
}

const workerId = 40 + Number(process.env.WORKER_ID ?? 0)

async function bootAndSnapshot(tag: string): Promise<Snapshot> {
  const logDir = mkdtempSync(path.join(tmpdir(), "standard-seed-snapshot-"))
  const from = Date.now() - 1_000
  let seedStart = 0
  let lane: E2eLane | null = null
  try {
    const t0 = performance.now()
    lane = await createE2eLane(workerId, logDir, {
      admin: ADMIN,
      // Read back as built: no minute sweep runs between the build and the read.
      keepScheduledTicksHeld: true,
      seed: async (env) => {
        seedStart = Date.now()
        return seedStandardWorld(env, ADMIN, { now: new Date(seedStart) })
      },
    })
    console.log(
      `[standard-seed-snapshot] ${tag}: lane built in ${((performance.now() - t0) / 1000).toFixed(1)}s`,
    )
    const clock = { from, to: Date.now() + 1_000, seedStart }
    const root = process.env.SEED_SNAPSHOT_DUMP
    const dumpDir = root ? path.join(root, tag) : null
    if (dumpDir) mkdirSync(dumpDir, { recursive: true })
    return await snapshotLane(lane.info.schemaPrefix, clock, dumpDir)
  } finally {
    await lane?.close()
  }
}

describe("the standard tier's lane world", () => {
  let first: Snapshot
  let second: Snapshot | null = null

  beforeAll(async () => {
    first = await bootAndSnapshot("first")
    if (process.env.SEED_SNAPSHOT_TWICE === "1") second = await bootAndSnapshot("second")
  }, 900_000)

  afterAll(() => {})

  it("is the same world twice in a row (the normalisation hides nothing real)", () => {
    if (second) expect(diff(first, second)).toEqual([])
  })

  it("matches the pinned snapshot, table by table", () => {
    if (process.env.SEED_SNAPSHOT_WRITE === "1" || !existsSync(EXPECTED_FILE)) {
      writeFileSync(EXPECTED_FILE, `${JSON.stringify(first, null, 2)}\n`)
      console.log(`[standard-seed-snapshot] wrote ${EXPECTED_FILE}`)
    }
    const expected = JSON.parse(readFileSync(EXPECTED_FILE, "utf8")) as Snapshot
    expect(diff(expected, first)).toEqual([])
  })
})
