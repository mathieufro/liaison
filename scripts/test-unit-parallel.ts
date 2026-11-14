// SPDX-License-Identifier: FSL-1.1-ALv2
// scripts/test-unit-parallel.ts
//
// The `unit` suite of scripts/test-run.ts when it runs unfiltered: the apps/api
// unit directories sharded across N databases, in batches of --batch files
// (default 8) per bun:test process. A batch shares one module-graph import, the
// largest fixed cost of a file; cross-file singleton bleed (the in-process
// app/tool registry and scheduled-job handlers a few files tear down) is handled
// by running the files that cannot share a process alone and rerunning any file
// that fails inside a batch alone before it counts (see "Work units" below).
// --batch=1 is one process per file.
//
//   bun run scripts/test-unit-parallel.ts [--shards=N] [--batch=N] [--retries=0|1] [--bail] [--keep-dbs] -- <dir|file>...
//
// Paths are relative to apps/api. Run through test-run.ts, which sets the run
// namespace (LIAISON_TEST_NS), the memory budget (TEST_UNIT_SHARDS) and the
// test slot; run bare, it works in the namespace of this checkout.
//
// Per-file isolation knobs (all honored by the app config):
//   DATABASE_URL       -> liaison_test_<ns>_s<shard>        (db/connection.ts)
//   REDIS_PREFIX       -> "<ns>:s<shard>_<token>:" PER PROCESS (lib/redis.ts keyPrefix + BullMQ prefix)
//   MEILI_INDEX_PREFIX -> "<ns>-s<shard>_"                   (infra/search/client.ts)
//   WORKER_ID          -> the shard id (the cross-file advisory lock needs no offset: each shard has its own database)
//
// REDIS_PREFIX is per PROCESS (not just per shard) on purpose: BullMQ *repeat*
// (cron) jobs persist in Redis under the prefix, so a shared per-shard prefix
// lets a scheduled job registered by one file (slaCheck, imap-sync) keep firing
// against a later file's torn-down org ("app not installed for that org"). A
// unique prefix per process gives each its own BullMQ namespace; inside a batch,
// route-test-setup clears `bull:*` between files.
//
// Shard databases are copies of the namespace's migrated template
// (scripts/lib/test-template.ts), made fresh every run: a file-level copy per
// shard, not a migration replay.
//
// Load-sensitive files (shared /tmp staging, bootstrap races) can still flake
// under N-way concurrency even though they pass in isolation; the runner gives
// such failures ONE retry, in parallel across fresh shard databases, and says
// which files only passed on the retry. A file whose failure already reproduced
// alone (failed in a batch, then failed again in its own process) is not
// retried: a deterministic failure fails the same way a third time
// (scripts/lib/unit-retry.ts).
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  namespaceForCheckout,
  resolveTestCoordinates,
} from "../packages/test-helpers/src/test-namespace"
import { cloneDatabase, dropTestDatabase, dropTrash, ensureTemplate } from "./lib/test-template"
import { formatFailures, type JunitFailure, parseJunitSuites } from "./lib/unit-junit"
import { formatPhaseSplit, planRetries } from "./lib/unit-retry"
import { mergeTimings, readTimings, timingsHistoryPath } from "./lib/unit-timings"
import { silenceLimitMs, tailLines, watchSilence, withoutQuietBunVars } from "./lib/unit-watchdog"

const ROOT = path.resolve(import.meta.dir, "..")
const API = path.join(ROOT, "apps/api")
const ENV_FILE = path.join(ROOT, ".env.test")

const argv = process.argv.slice(2)
const flag = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1]
const dashDash = argv.indexOf("--")
const targets = (
  dashDash === -1 ? argv.filter((a) => !a.startsWith("--")) : argv.slice(dashDash + 1)
).filter((a) => a.length > 0)

const SHARDS_REQUESTED = Number(flag("shards") ?? process.env.TEST_UNIT_SHARDS ?? 4)
// One retry round at most: a second round only ever re-ran deterministic failures.
const RETRY_ROUNDS = Math.min(1, Math.max(0, Number(flag("retries") ?? 1) || 0))
const KEEP_DBS = argv.includes("--keep-dbs")
const BAIL = argv.includes("--bail")
const TIMEOUT_MS = process.env.BUN_TEST_TIMEOUT_MS ?? "60000"
// Files per bun:test process (1 = every file alone, the old behaviour).
const BATCH = Math.max(
  1,
  Math.floor(Number(flag("batch") ?? process.env.TEST_UNIT_BATCH ?? 8)) || 1,
)
const SILENCE_LIMIT_MS = silenceLimitMs(Number(TIMEOUT_MS), process.env.TEST_UNIT_SILENCE_MS)
const REPORT_DIR = mkdtempSync(path.join(tmpdir(), "liaison-unit-junit-"))
// Per-file wall times from earlier runs, shared by every worktree of the
// checkout (scripts/lib/unit-timings.ts): they order the queue longest first and
// run the slowest files alone. Every run merges its own.
const HISTORY_FILE = timingsHistoryPath(ROOT)
const SLOW_SOLO_MS = 20_000
const UNKNOWN_FILE_MS = 3_000
const HISTORY = readTimings(HISTORY_FILE)
const LOG_DIR = process.env.LOG_DIR

const DEFAULT_TARGETS = [
  "src/modules",
  "src/infra",
  "src/middleware",
  "src/lib",
  "src/db",
  "src/apps",
  "src/services",
  "src/cli",
  "test-support",
]

const NS = namespaceForCheckout(ROOT)
const COORDS = resolveTestCoordinates({ ...process.env, LIAISON_TEST_NS: NS })

// ── 1. Discover test files (relative to apps/api) ──
const files: string[] = []
for (const target of targets.length > 0 ? targets : DEFAULT_TARGETS) {
  const abs = path.resolve(API, target)
  if (!existsSync(abs)) {
    console.error(`No such path under apps/api: ${target}`)
    process.exit(1)
  }
  if (statSync(abs).isFile()) {
    files.push(path.relative(API, abs))
    continue
  }
  for await (const f of new Bun.Glob("**/*.test.{ts,tsx}").scan(abs)) {
    // Soak tests (LIAISON_SOAK=1, minutes each) are run by hand, never by a lane.
    if (f.endsWith(".soak.test.ts")) continue
    files.push(path.relative(API, path.join(abs, f)))
  }
}
// TEST_UNIT_PART=k/n keeps every n-th file from the k-th (1-based) of the sorted list, so n
// CI jobs split the suite between them with no file run twice or left out.
const PART = process.env.TEST_UNIT_PART
const partMatch = PART ? /^(\d+)\/(\d+)$/.exec(PART) : null
if (
  PART &&
  (!partMatch || Number(partMatch[1]) < 1 || Number(partMatch[1]) > Number(partMatch[2]))
) {
  console.error(`TEST_UNIT_PART must be k/n with 1 <= k <= n, got "${PART}".`)
  process.exit(1)
}
const unique = [...new Set(files)]
  .sort()
  .filter((_, i) => !partMatch || i % Number(partMatch[2]) === Number(partMatch[1]) - 1)
if (partMatch) console.log(`Part ${PART} of the suite: ${unique.length} file(s).`)
if (unique.length === 0) {
  console.error("No test files matched.")
  process.exit(1)
}
const SHARDS = Math.max(1, Math.min(Math.floor(SHARDS_REQUESTED) || 1, unique.length))
console.log(`Discovered ${unique.length} unit test files; ${SHARDS} shard(s) in namespace ${NS}.`)

const shardDb = (n: number) => `${COORDS.dbName}_s${n}`

// ── 2. Provision shard databases from the template ──
const template = await ensureTemplate({ root: ROOT, coords: COORDS })
async function provisionShard(n: number): Promise<void> {
  await cloneDatabase({ coords: COORDS, template, dbName: shardDb(n) })
}
const t0 = Date.now()
await Promise.all(Array.from({ length: SHARDS }, (_, n) => provisionShard(n)))
console.log(`Cloned ${SHARDS} shard database(s) from ${template.name} in ${Date.now() - t0}ms.`)

// ── 3. Run ──
type Result = {
  file: string
  shard: number
  token: number
  exitCode: number
  out: string
  err: string
  ms: number
  /** Files in the process that ran it (1 = alone). */
  batch: number
  /** The other files of the process that ran it (empty = alone). */
  batchmates: string[]
  /** Failing tests from bun's junit report (empty when the file passed, or died before reporting). */
  failures: JunitFailure[]
  retried?: boolean
  aloneAfterBatch?: boolean
  /**
   * Earlier failed attempts this verdict replaced (the batch run, then the alone
   * rerun), oldest first: a file that passes on the second try still reports what
   * failed on the first, and with which files it shared the process.
   */
  earlier?: Result[]
}
/** Replaces a file's verdict with a later attempt, keeping the failed one. */
function supersede(previous: Result, next: Result): Result {
  next.earlier = [...(previous.earlier ?? []), previous]
  return next
}
const results: Result[] = []
let completed = 0
let bailed = false

function shardEnv(shardId: number, token: number): Record<string, string> {
  const db = shardDb(shardId)
  const childEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    LIAISON_TEST_NS: NS,
    WORKER_ID: String(shardId),
    DATABASE_URL: COORDS.appUrl(db),
    DATABASE_URL_SUPERUSER: COORDS.superuserUrl(db),
    E2E_DATABASE_URL: COORDS.superuserUrl(db),
    REDIS_PREFIX: `${NS}:s${shardId}_${token}:`,
    MEILI_INDEX_PREFIX: `${NS}-s${shardId}_`,
    DB_POOL_MAX: "8",
    // The pool is capped at 8 so N shards fit Postgres' connection budget; a
    // capped pool QUEUES, and the acquire timeout has to let it. A local
    // .env.test may pin it at a few hundred ms (once for two fast-fail tests that
    // now build their own pool and timeout), which turned a test making 50
    // concurrent calls on purpose (approvals/decide.test.ts) into pool-exhausted
    // failures on a shard and nowhere else. Well under the per-test timeout.
    DB_ACQUIRE_TIMEOUT_MS: "10000",
    BUN_TEST_TIMEOUT_MS: TIMEOUT_MS,
  }
  // Let `--env-file=.env.test` set NODE_ENV=test; the parent's auto-loaded .env
  // (NODE_ENV=development) would otherwise leak in and win over the file.
  delete childEnv.NODE_ENV
  // The watchdog reads a shard's progress as its proof of life, so bun must print it.
  return withoutQuietBunVars(childEnv)
}

/**
 * Runs `files` in ONE bun:test process on the shard and returns one result per
 * file. A lone file is judged by the exit code, as before. A batch is judged per
 * file from bun's junit report: a file whose suite records a failure or an
 * error, or that has no suite at all (the process died before reaching it), has
 * failed; so has every file of a batch that exited non-zero while its report
 * blames nobody (a hook or an unhandled error outside any test). The output is
 * the batch's, shared by its files.
 */
async function runUnitOnShard(files: string[], shardId: number, token: number): Promise<Result[]> {
  const report = path.join(REPORT_DIR, `s${shardId}_${token}.xml`)
  // Always the junit report, alone too: it is where the failing tests' names and
  // errors come from, kept per file even when the batch's stdout is shared.
  const reporter = ["--reporter=junit", `--reporter-outfile=${report}`]
  const t = Date.now()
  // To files, not pipes: a child a test leaves behind cannot hold the run open on
  // a pipe it inherited, and a passing process's output never comes into memory.
  const outFile = path.join(REPORT_DIR, `s${shardId}_${token}.out`)
  const errFile = path.join(REPORT_DIR, `s${shardId}_${token}.err`)
  const proc = Bun.spawn({
    cmd: [
      "bun",
      "test",
      `--env-file=${ENV_FILE}`,
      "--timeout",
      TIMEOUT_MS,
      ...reporter,
      ...files.map((f) => `./${f}`),
    ],
    cwd: API,
    env: shardEnv(shardId, token),
    stdin: "ignore",
    stdout: Bun.file(outFile),
    stderr: Bun.file(errFile),
  })
  const readOutput = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "")
  const outputBytes = () =>
    [outFile, errFile].reduce((sum, f) => sum + (existsSync(f) ? statSync(f).size : 0), 0)
  const watch = watchSilence(SILENCE_LIMIT_MS, (silentMs) => {
    const said = tailLines(`${readOutput(outFile)}\n${readOutput(errFile)}`, 20)
    process.stdout.write(
      `\n! wedged: no output for ${Math.round(silentMs / 1000)}s, killing shard ${shardId}'s process ` +
        `(${files.join(" ")}). It last said:\n${said}\n`,
    )
    proc.kill("SIGKILL")
  })
  let seenBytes = 0
  const sizePoll = setInterval(() => {
    const bytes = outputBytes()
    if (bytes !== seenBytes) watch.touch()
    seenBytes = bytes
  }, 1000)
  const exitCode = await proc.exited
  clearInterval(sizePoll)
  watch.stop()
  const ms = Date.now() - t
  // A passing process's output is never shown, so it never comes into memory.
  const out = exitCode === 0 ? "" : readOutput(outFile)
  const err = exitCode === 0 ? "" : readOutput(errFile)
  rmSync(outFile, { force: true })
  rmSync(errFile, { force: true })
  const base = { shard: shardId, token, out, err, batch: files.length }
  const suites = existsSync(report)
    ? parseJunitSuites(readFileSync(report, "utf8"), (f) =>
        path.relative(API, path.resolve(API, f)),
      )
    : new Map()
  rmSync(report, { force: true })
  const extras = (file: string) => ({
    batchmates: files.filter((f) => f !== file),
    failures: suites.get(file)?.failures ?? [],
  })
  if (files.length === 1) {
    const file = files[0] as string
    return [{ ...base, ...extras(file), file, exitCode, ms }]
  }
  const blamed = files.some((f) => (suites.get(f)?.failed ?? true) === true)
  return files.map((file) => {
    const suite = suites.get(file)
    const failed = exitCode !== 0 && (!blamed || !suite || suite.failed)
    return {
      ...base,
      ...extras(file),
      file,
      exitCode: failed ? exitCode || 1 : 0,
      ms: suite ? Math.round(suite.seconds * 1000) : ms,
    }
  })
}

/**
 * Work units. Every file in its own process costs every file the whole module
 * graph import (1.5 to 3 s of the 2 to 8 s a typical file takes); a batch of
 * BATCH files shares one import. A file runs alone when it
 *   - replaces modules process-wide (`mock.module`, which bun cannot undo for
 *     the files after it), or
 *   - asserts that a process-global registry starts empty
 *     (`_getGlobalHandlerCount()`), which any earlier file in the process breaks, or
 *   - bounds the process's RSS growth (`memoryUsage().rss`): what earlier files
 *     allocated and the heap they left fragmented count against the bound
 *     (org-archive/writer.test.ts grew 200 MB after export/orchestrator.test.ts
 *     and its neighbours, 6 MB alone), or
 *   - bounds CPU time (`process.cpuUsage()`): the counter is the whole process's,
 *     so what earlier files left running and the GC of the heap they grew count
 *     against the bound (tool-bench/bench.test.ts measured 6.9 s of ranking CPU
 *     in a batch of 8 on CI, 1.8 s alone in the same run).
 * A file that fails inside a batch is rerun alone before it counts as failed
 * (cross-file bleed is the batch's fault, not the file's), and the report names
 * every file that only passed alone.
 */
const SOLO_PATTERN =
  /\bmock\.module\(|\b_getGlobalHandlerCount\(\)|\bmemoryUsage\(\)\.rss\b|\bcpuUsage\(/
function isSolo(file: string): boolean {
  if (BATCH <= 1) return true
  if ((HISTORY[file] ?? 0) >= SLOW_SOLO_MS) return true
  try {
    return SOLO_PATTERN.test(readFileSync(path.join(API, file), "utf8"))
  } catch {
    return true
  }
}
const units: string[][] = []
{
  let current: string[] = []
  for (const file of unique) {
    if (isSolo(file)) {
      units.push([file])
      continue
    }
    current.push(file)
    if (current.length >= BATCH) {
      units.push(current)
      current = []
    }
  }
  if (current.length > 0) units.push(current)
}
// Longest first (LPT): the run ends when its slowest shard does, and one 80 s
// file picked up last decides the whole wall clock. Estimates come from the
// previous runs' timings; a file never timed counts as UNKNOWN_FILE_MS.
const estimate = (unit: string[]) =>
  unit.reduce((sum, f) => sum + (HISTORY[f] ?? UNKNOWN_FILE_MS), 0)
units.sort((a, b) => estimate(b) - estimate(a))
const solos = units.filter((u) => u.length === 1).length
if (BATCH > 1) {
  console.log(
    `${units.length} process(es): batches of up to ${BATCH} files, ${solos} file(s) alone.`,
  )
}

const queue = units.map((files, i) => ({ files, token: i }))
async function runShard(shardId: number): Promise<void> {
  for (;;) {
    if (bailed) return
    const next = queue.shift()
    if (!next) return
    const rs = await runUnitOnShard(next.files, shardId, next.token)
    for (const r of rs) {
      results.push(r)
      completed++
      if (r.exitCode !== 0) {
        process.stdout.write(
          `\n✗ ${r.file} (shard ${shardId}, exit ${r.exitCode}${r.batch > 1 ? `, in a batch of ${r.batch}` : ""})\n`,
        )
        if (BAIL && r.batch === 1) bailed = true
      }
    }
    process.stdout.write(`\r${completed}/${unique.length} done`)
  }
}

const started = Date.now()
await Promise.all(Array.from({ length: SHARDS }, (_, i) => runShard(i)))
const mainMs = Date.now() - started

// ── 3a. Files that failed inside a batch, rerun alone (in parallel) ──
// A batch failure may be another file's bleed. Rerun each such file in its own
// process; its verdict alone replaces the batch's. Not a retry: a file that
// fails alone fails here exactly as it would have without batching.
const aloneStarted = Date.now()
const batchFailures = results.filter((r) => r.exitCode !== 0 && r.batch > 1)
if (batchFailures.length > 0) {
  console.log(`\n\n${batchFailures.length} file(s) failed in a batch; rerunning each alone…`)
  const aloneQueue = batchFailures.map((r) => r.file)
  let aloneToken = units.length
  await Promise.all(
    Array.from({ length: SHARDS }, async (_, shardId) => {
      for (;;) {
        const file = aloneQueue.shift()
        if (!file) return
        const [alone] = await runUnitOnShard([file], shardId, aloneToken++)
        if (!alone) continue
        alone.aloneAfterBatch = true
        const i = results.findIndex((x) => x.file === file)
        results[i] = supersede(results[i] as Result, alone)
        process.stdout.write(
          alone.exitCode === 0 ? `  ✓ ${file} (alone)\n` : `  ✗ ${file} (alone, still failing)\n`,
        )
      }
    }),
  )
}

const aloneMs = Date.now() - aloneStarted

// ── 3b. One retry, in parallel on fresh shard databases ──
// Only for failures that have not already reproduced alone (planRetries): a
// solo file that failed once under concurrency, or a batch failure left without
// an alone verdict. Every shard database is recloned from the template first, so
// a retry sees a clean database as before, but the retries share the shards
// instead of queueing on one.
const retryStarted = Date.now()
const plan = planRetries(results)
if (!BAIL && RETRY_ROUNDS > 0 && plan.reproducedAlone.length > 0) {
  console.log(
    `\n${plan.reproducedAlone.length} file(s) failed alone after failing in a batch; not retried.`,
  )
}
if (!BAIL && RETRY_ROUNDS > 0 && plan.retry.length > 0) {
  const retryShards = Math.min(SHARDS, plan.retry.length)
  console.log(
    `\n\nRetry: ${plan.retry.length} file(s), in parallel on ${retryShards} fresh shard database(s)…`,
  )
  await Promise.all(Array.from({ length: retryShards }, (_, n) => provisionShard(n)))
  const retryQueue = [...plan.retry]
  let retryToken = units.length + unique.length
  await Promise.all(
    Array.from({ length: retryShards }, async (_, shardId) => {
      for (;;) {
        const file = retryQueue.shift()
        if (!file) return
        const [retry] = await runUnitOnShard([file], shardId, retryToken++)
        if (!retry) continue
        retry.retried = true
        const i = results.findIndex((x) => x.file === file)
        results[i] = supersede(results[i] as Result, retry)
        process.stdout.write(
          retry.exitCode === 0 ? `  ✓ ${file} (retry)\n` : `  ✗ ${file} (retry, still failing)\n`,
        )
      }
    }),
  )
}
const retryMs = Date.now() - retryStarted
const elapsedS = ((Date.now() - started) / 1000).toFixed(1)

// ── 4. Report ──
const logName = (file: string, suffix = "") =>
  path.join(LOG_DIR ?? REPORT_DIR, `${file.replaceAll("/", "__")}${suffix}.log`)
function writeLog(r: Result, suffix = ""): string | undefined {
  if (!LOG_DIR) return undefined
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    const header =
      `# ${r.file}: exit ${r.exitCode}, shard ${r.shard}, ${(r.ms / 1000).toFixed(1)}s` +
      (r.batchmates.length > 0
        ? `, in a batch with:\n${r.batchmates.map((f) => `#   ${f}`).join("\n")}`
        : ", alone") +
      "\n"
    const out = logName(r.file, suffix)
    writeFileSync(out, `${header}\n${r.out}\n${r.err}`)
    return out
  } catch {
    return undefined /* best effort */
  }
}
/**
 * What an earlier failed attempt of a file saw: its failing tests and errors,
 * and the files it shared the process with (to rebuild the batch). The full
 * output of each attempt goes to LOG_DIR as <file>.attempt-<n>.log.
 */
function reportEarlier(r: Result): void {
  console.log(`  ${r.file}`)
  for (const [n, e] of (r.earlier ?? []).entries()) {
    const where = e.batchmates.length > 0 ? `in a batch of ${e.batch}` : "alone"
    console.log(`    attempt ${n + 1} (${where}, shard ${e.shard}, exit ${e.exitCode}):`)
    if (e.failures.length > 0) console.log(formatFailures(e.failures))
    else {
      const lines = `${e.out}\n${e.err}`.split("\n").filter((l) => FAIL_LINE.test(l))
      console.log(
        lines
          .slice(0, 20)
          .map((l) => `    ${l}`)
          .join("\n") || "    (no failing test reported)",
      )
    }
    if (e.batchmates.length > 0) console.log(`    batchmates: ${e.batchmates.join(" ")}`)
    const log = writeLog(e, `.attempt-${n + 1}`)
    if (log) console.log(`    log: ${log}`)
  }
}
const FAIL_LINE = /\(fail\)|error:|Error:|Expected:|Received:|✗|not registered|violates/
const failures = results.filter((r) => r.exitCode !== 0)
const flaky = results.filter((r) => r.exitCode === 0 && r.retried)
console.log(
  `\n\n── unit (sharded): ${results.length} files in ${elapsedS}s across ${SHARDS} shards ──`,
)
console.log(
  `wall clock: ${formatPhaseSplit([
    { name: "main pass", ms: mainMs },
    { name: "alone reruns", ms: aloneMs },
    { name: "retry", ms: retryMs },
  ])}`,
)
{
  const sumMs = results.reduce((a, r) => a + r.ms, 0)
  const slowest = [...results].sort((a, b) => b.ms - a.ms).slice(0, 10)
  console.log(
    `per-file wall: mean ${(sumMs / Math.max(1, results.length) / 1000).toFixed(2)}s, ` +
      `sum ${(sumMs / 1000).toFixed(1)}s; slowest:`,
  )
  for (const r of slowest) console.log(`  ${(r.ms / 1000).toFixed(2)}s  ${r.file}`)
  try {
    mergeTimings(HISTORY_FILE, Object.fromEntries(results.map((r) => [r.file, r.ms])))
  } catch {
    /* best effort: ordering only */
  }
  // TEST_UNIT_TIMINGS=<file>: every file's wall time as JSON, for tuning shards.
  const timingsOut = process.env.TEST_UNIT_TIMINGS
  if (timingsOut) {
    writeFileSync(
      timingsOut,
      JSON.stringify(
        results.map((r) => ({
          file: r.file,
          ms: r.ms,
          exitCode: r.exitCode,
          shard: r.shard,
          batch: r.batch,
        })),
        null,
        2,
      ),
    )
  }
}
const bleed = results.filter((r) => r.exitCode === 0 && r.aloneAfterBatch && !r.retried)
if (bleed.length > 0) {
  console.log(
    `! ${bleed.length} file(s) failed in a batch but pass alone (cross-file bleed: ` +
      "fix the file or the one before it, or make it solo):",
  )
  for (const f of bleed) reportEarlier(f)
}
if (flaky.length > 0) {
  console.log(`! ${flaky.length} file(s) passed only on the retry (load-sensitive):`)
  for (const f of flaky) reportEarlier(f)
}
if (failures.length === 0) {
  console.log(`✓ ALL ${results.length} files passed.`)
} else {
  console.log(`✗ ${failures.length} file(s) failed:\n`)
  for (const f of failures) {
    console.log(`\n========== ${f.file} (exit ${f.exitCode}) ==========`)
    if (f.failures.length > 0) console.log(formatFailures(f.failures))
    else {
      const lines = `${f.out}\n${f.err}`.split("\n").filter((l) => FAIL_LINE.test(l))
      console.log(lines.slice(0, 40).join("\n"))
    }
    if (f.earlier?.length) reportEarlier(f)
    writeLog(f)
  }
}

// ── 5. Cleanup ──
rmSync(REPORT_DIR, { recursive: true, force: true })
if (!KEEP_DBS) {
  await Promise.all(
    Array.from({ length: SHARDS }, async (_, n) => {
      await dropTestDatabase(COORDS, shardDb(n)).catch(() => {})
      await dropTrash(COORDS, shardDb(n)).catch(() => 0)
    }),
  )
}

process.exit(failures.length > 0 ? 1 : 0)
