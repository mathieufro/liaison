// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `liaison` privileged CLI. Runs api internals directly, no HTTP. Every
 * subcommand is listed in `cli/commands.ts` (which `USAGE` and `HANDLERS` follow); docs/provisioning-cli.md is the
 * reference. The entry is `cli/index.ts`, which runs the offline subcommands
 * (`api-connector validate`) itself and loads this module, and with it the
 * validated environment, for everything else.
 *
 * I/O DISCIPLINE (the new provisioning subcommands break the legacy
 * export/erase pattern, deliberately): `config apply`'s STDOUT carries ONLY the
 * machine-readable report (`formatJson` / `formatEnv`); ALL human progress,
 * warnings, and pending notices go to STDERR. `config verify` follows the same
 * split (JSON report to STDOUT, progress to STDERR) and additionally NEVER
 * writes a credential value to either stream — only a probe's non-secret
 * `identity`. `export`/`erase-user` keep their legacy stdout writes (an
 * intentional carve-out — do not change them).
 *
 * Exit codes: 0 success (incl. a no-op re-run and an OAuth-pending mailbox), 2
 * usage/validation (an invalid or missing environment included: `~/lib/env`
 * exits 2 under the CLI), 1 runtime failure, 3 `config apply` left a
 * conflicting path unwritten (changed in the product since the last apply).
 */
// FIRST import — sets LIAISON_CLI=1 before the logger module is evaluated (ESM
// imports are hoisted depth-first; the logger reads the flag at module load to
// choose a synchronous fd-2 destination so the CLI flushes before process.exit()).
import "~/cli/cli-env"
import { statSync, writeFileSync } from "node:fs"
import { hostname, userInfo } from "node:os"
import { dirname } from "node:path"
import { AGENT_ASK_USAGE, formatPendingApprovals, runAgentAsk } from "~/cli/agent/ask"
import {
  type CommandName,
  groupUsage,
  resolveCommand,
  topLevelUsage,
  usageOf,
} from "~/cli/commands"
import { CONFLICT_EXIT_CODE, runConfigApply } from "~/cli/config/apply"
import { parsePrefer } from "~/cli/config/drift"
import { interpolateEnv, literalSecretPaths, parseConfigFile } from "~/cli/config/parse"
import { runConfigPull } from "~/cli/config/pull"
import {
  buildReport,
  formatEnv,
  formatJson,
  type ReportApiKeyInput,
  type ReportInput,
} from "~/cli/config/report"
import { validateConfig } from "~/cli/config/schema"
import { runConfigVerify } from "~/cli/config/verify"
import { CONNECT_USAGE, runConnect } from "~/cli/connect"
import { DISCONNECT_USAGE, runDisconnect } from "~/cli/disconnect"
import { exportFull } from "~/cli/export-full"
import { runGuide } from "~/cli/guide"
import { runInvoicingImport } from "~/cli/invoicing/import"
import { runProjectsAttachFiles } from "~/cli/projects/attach-files"
import { runProjectsImport } from "~/cli/projects/import"
import { runSearchReindexCli } from "~/cli/search/reindex"
import { runSeedCli } from "~/cli/seed/run"
import { runSetupState } from "~/cli/setup/state"
import { runSlackImport } from "~/cli/slack/import"
import { runTicketsBackfillAttachments } from "~/cli/tickets/backfill-attachments"
import { runTicketsImport } from "~/cli/tickets/import"
import { runTicketsInbox } from "~/cli/tickets/inbox"
import { eraseUser } from "~/modules/erasure/erase-user"

const USAGE = topLevelUsage()

const PROJECTS_IMPORT_USAGE = `usage: liaison projects import --file <path> [--org <slug>] [--dry-run] [--placeholder-unknown-users]
  --placeholder-unknown-users  an unknown reporter/assignee/comment-author email becomes a
      DEACTIVATED org user (exact attribution, cannot log in, never a thread participant).
      The placeholder holds that (org, email) slot: to onboard the person later, an admin
      must reactivate the placeholder (and give it a role); re-inviting the email fails.`

const PROJECTS_ATTACH_FILES_USAGE = `usage: liaison projects attach-files --file <path> --files-dir <dir> [--org <slug>] [--dry-run] [--placeholder-unknown-users]
  Attaches local files to tasks already imported by \`projects import\` (matched by externalRef)
  as the task's files, backdated, under their original uploader. Notifies nobody; a re-run skips
  the files already attached (per sourceId).
  --files-dir  every file path of the NDJSON is relative to it and may not leave it.
  --placeholder-unknown-users  an unknown uploader email becomes a DEACTIVATED org user;
      without it such a batch fails (a historical file is never attributed to the importer).`

function arg(flag: string, argv: string[]): string | undefined {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

/** Every value of a repeatable flag, in order. */
function args(flag: string, argv: string[]): string[] {
  const out: string[] = []
  argv.forEach((a, i) => {
    const next = argv[i + 1]
    if (a === flag && next !== undefined) out.push(next)
  })
  return out
}

/** The default `--applied-by`: the OS account and host running the CLI. */
function defaultAppliedBy(): string {
  try {
    return `cli:${userInfo().username}@${hostname()}`
  } catch {
    return `cli:@${hostname()}`
  }
}

function err(msg: string): void {
  process.stderr.write(`${msg}\n`)
}

/** Read a property off an unknown value without a cast (`in`-narrowed). */
function prop(obj: unknown, key: string): unknown {
  if (typeof obj !== "object" || obj === null || !(key in obj)) return undefined
  return Reflect.get(obj, key)
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}
function asBool(v: unknown): boolean {
  return v === true
}

// ──────────────────────────────────────────────────────────────────────────
// config apply
// ──────────────────────────────────────────────────────────────────────────

/**
 * Warn (to STDERR) when the config file is group/world-accessible AND holds a
 * secret literally (a credential, key, token or password that is not a
 * `${VAR}` reference): those values could leak. A file of `${VAR}`
 * references only is safe to leave readable, so it gets no warning. SKIP
 * paths under a secrets tmpfs mount (`/run/secrets`, `/tmp`), whose
 * permissions the platform manages.
 */
function warnIfConfigPermsLoose(configPath: string, raw: unknown): void {
  if (configPath.startsWith("/run/secrets") || configPath.startsWith("/tmp")) return
  try {
    const mode = statSync(configPath).mode
    // group (0o070) or world (0o007) read/write/execute bits set.
    if ((mode & 0o077) === 0) return
    const literal = literalSecretPaths(raw)
    if (literal.length === 0) return
    const shown = literal.slice(0, 5).join(", ") + (literal.length > 5 ? ", ..." : "")
    err(
      `warning: config file '${configPath}' is group/world-accessible (mode ` +
        `${(mode & 0o777).toString(8)}) and holds secret values literally (${shown}): ` +
        `replace them with \${VAR} references, or chmod 600 the file and make it owned by ` +
        "the user this CLI runs as (uid 1000 in the Docker image, or the CLI cannot read it)",
    )
  } catch {
    // stat failure is surfaced later by the parse step; don't double-report.
  }
}

/**
 * Project the driver's aggregated report (sections keyed by provisioner key)
 * into the report builder's `ReportInput`, threading the SUPPLIED apiKeys[].key
 * plaintext from the config into each entry's `suppliedKey` (the provisioner
 * omits it) so the echo policy can apply. Read everything with `in`-narrowing —
 * no casts.
 */
function projectReportInput(
  sections: Record<string, unknown>,
  pending: unknown[],
  changed: string[],
  unchanged: string[],
  suppliedKeyByLabel: Map<string, string>,
): ReportInput {
  const input: ReportInput = { pending, changed, unchanged }

  const org = sections.org
  if (org !== undefined) {
    const id = asString(prop(org, "id"))
    const slug = asString(prop(org, "slug"))
    if (id !== undefined && slug !== undefined) {
      input.org = { id, slug, created: asBool(prop(org, "created")) }
    }
  }

  const admin = sections.admin
  if (admin !== undefined) {
    const id = asString(prop(admin, "id"))
    const email = asString(prop(admin, "email"))
    if (id !== undefined && email !== undefined) {
      input.admin = { id, email, created: asBool(prop(admin, "created")) }
    }
  }

  const users = prop(sections.users, "users")
  if (Array.isArray(users)) input.users = users

  const providers = prop(sections.byok, "providers")
  if (Array.isArray(providers)) {
    const byok: Record<string, { set: boolean; validated: boolean }> = {}
    for (const p of providers) {
      const name = asString(prop(p, "provider"))
      if (name === undefined) continue
      byok[name] = { set: asBool(prop(p, "set")), validated: asBool(prop(p, "validated")) }
    }
    input.byok = byok
  }

  const keys = prop(sections.apiKeys, "keys")
  if (Array.isArray(keys)) {
    const apiKeys: ReportApiKeyInput[] = []
    for (const k of keys) {
      const label = asString(prop(k, "label"))
      const keyPrefix = asString(prop(k, "keyPrefix"))
      if (label === undefined || keyPrefix === undefined) continue
      const generated = asString(prop(k, "key"))
      const supplied = suppliedKeyByLabel.get(label)
      apiKeys.push({
        label,
        created: asBool(prop(k, "created")),
        keyPrefix,
        ...(generated !== undefined ? { key: generated } : {}),
        ...(supplied !== undefined ? { suppliedKey: supplied } : {}),
      })
    }
    input.apiKeys = apiKeys
  }

  const email = sections.email
  if (email !== undefined) {
    input.email = {
      ...(asString(prop(email, "from")) !== undefined
        ? { from: asString(prop(email, "from")) }
        : {}),
      ...(asString(prop(email, "replyTo")) !== undefined
        ? { replyTo: asString(prop(email, "replyTo")) }
        : {}),
      set: asBool(prop(email, "set")),
    }
  }

  const mailMailboxes = prop(sections.mail, "mailboxes")
  if (Array.isArray(mailMailboxes)) input.mail = { mailboxes: mailMailboxes }

  const ticketInboxes = prop(sections.tickets, "inboxes")
  if (Array.isArray(ticketInboxes)) input.tickets = { inboxes: ticketInboxes }

  const apps = prop(sections.apps, "apps")
  if (Array.isArray(apps)) input.apps = apps

  const knowledge = sections.knowledge
  if (knowledge !== undefined) {
    const collections = prop(knowledge, "collections")
    const documents = prop(knowledge, "documents")
    const sources = prop(knowledge, "sources")
    if (
      typeof collections === "number" &&
      typeof documents === "number" &&
      typeof sources === "number"
    ) {
      const skipped = prop(knowledge, "skipped")
      input.knowledge = {
        collections,
        documents,
        sources,
        ...(Array.isArray(skipped) ? { skipped } : {}),
      }
    }
  }

  const agentList = prop(sections.agents, "agents")
  if (Array.isArray(agentList)) input.agents = agentList

  const invoicing = sections.invoicing
  if (invoicing !== undefined) {
    const issuerProfiles = prop(invoicing, "issuerProfiles")
    const taxRegimes = prop(invoicing, "taxRegimes")
    const hsCodes = prop(invoicing, "hsCodes")
    if (Array.isArray(issuerProfiles) && Array.isArray(taxRegimes) && Array.isArray(hsCodes)) {
      input.invoicing = { issuerProfiles, taxRegimes, hsCodes }
    }
  }

  return input
}

async function configApply(argv: string[]): Promise<number> {
  const configPath = arg("--config", argv)
  if (!configPath) {
    err(usageOf("config apply"))
    return 2
  }
  const formatArg = arg("--format", argv) ?? "json"
  if (formatArg !== "json" && formatArg !== "env") {
    err(`config apply: --format must be 'json' or 'env' (got '${formatArg}')`)
    return 2
  }
  const dryRun = argv.includes("--dry-run")
  const validateByok = !argv.includes("--no-validate-byok")
  const echoSupplied = argv.includes("--echo-supplied")
  const only = args("--only", argv)
  const prefer = parsePrefer(args("--prefer", argv))
  if (typeof prefer === "string") {
    err(`config apply: ${prefer}`)
    return 2
  }
  const appliedBy = arg("--applied-by", argv) ?? defaultAppliedBy()

  // Parse + validate (the driver consumes the typed config; the env/secret
  // interpolation + schema both live in cli/config). Errors → exit 2 (stderr).
  const parsed = parseConfigFile(configPath)
  if (!parsed.ok) {
    err(`config apply: ${parsed.message}`)
    return 2
  }
  warnIfConfigPermsLoose(configPath, parsed.raw)
  // interpolate ${ENV} before schema validation; an unresolved var → exit 2.
  let interpolated: unknown
  try {
    interpolated = interpolateEnv(parsed.raw)
  } catch (e) {
    err(`config apply: ${e instanceof Error ? e.message : String(e)}`)
    return 2
  }
  const validated = validateConfig(interpolated)
  if (!validated.ok) {
    err(`config apply: ${validated.message}`)
    return 2
  }

  // Map supplied plaintext keys by label so the report can apply the echo policy.
  const suppliedKeyByLabel = new Map<string, string>()
  for (const entry of validated.config.apiKeys ?? []) {
    if (entry.key) suppliedKeyByLabel.set(entry.label, entry.key)
  }

  const { exitCode, report, drift } = await runConfigApply({
    config: validated.config,
    format: formatArg,
    dryRun,
    validateByok,
    echoSupplied,
    configDir: dirname(configPath),
    log: (msg) => err(msg), // all progress → stderr
    only,
    prefer,
    appliedBy,
  })

  // A conflict (exit 3) still prints the report: what was written and the
  // conflicting paths that were not.
  if (exitCode !== 0 && exitCode !== CONFLICT_EXIT_CODE) {
    // Validation/runtime error already logged to stderr by the driver. Still
    // emit the partial report to stdout if one was built, so a consumer parsing
    // stdout never sees human text — but a non-zero exit signals the failure.
    return exitCode
  }

  const input = projectReportInput(
    report.sections,
    report.pending,
    report.changed,
    report.unchanged,
    suppliedKeyByLabel,
  )
  if (drift.length > 0) input.drift = drift
  const built = buildReport(input, { echoSupplied })
  const out = formatArg === "env" ? formatEnv(built) : formatJson(built)
  // STDOUT carries ONLY the machine-readable output.
  process.stdout.write(`${out}\n`)
  return exitCode
}

// ──────────────────────────────────────────────────────────────────────────
// config pull
// ──────────────────────────────────────────────────────────────────────────

async function configPull(argv: string[]): Promise<number> {
  const configPath = arg("--config", argv)
  if (!configPath) {
    err(usageOf("config pull"))
    return 2
  }
  const outPath = arg("--out", argv)
  const { exitCode, text } = await runConfigPull({
    configPath,
    only: args("--only", argv),
    log: (msg) => err(msg),
  })
  if (exitCode !== 0 || text === undefined) return exitCode || 1
  if (outPath) writeFileSync(outPath, text)
  else process.stdout.write(text)
  return 0
}

// ──────────────────────────────────────────────────────────────────────────
// config verify
// ──────────────────────────────────────────────────────────────────────────

async function configVerify(argv: string[]): Promise<number> {
  const configPath = arg("--config", argv)
  if (!configPath) {
    err(usageOf("config verify"))
    return 2
  }
  const appFilter = arg("--app", argv)

  const parsed = parseConfigFile(configPath)
  if (!parsed.ok) {
    err(`config verify: ${parsed.message}`)
    return 2
  }
  warnIfConfigPermsLoose(configPath, parsed.raw)
  let interpolated: unknown
  try {
    interpolated = interpolateEnv(parsed.raw)
  } catch (e) {
    err(`config verify: ${e instanceof Error ? e.message : String(e)}`)
    return 2
  }
  const validated = validateConfig(interpolated)
  if (!validated.ok) {
    err(`config verify: ${validated.message}`)
    return 2
  }

  const { exitCode, report } = await runConfigVerify({
    config: validated.config,
    ...(appFilter !== undefined ? { appFilter } : {}),
    log: (msg) => err(msg), // all progress → stderr, same discipline as `config apply`
  })

  // STDOUT carries ONLY the machine-readable report — never a secret value.
  process.stdout.write(`${JSON.stringify(report)}\n`)
  return exitCode
}

// ──────────────────────────────────────────────────────────────────────────
// dispatch
// ──────────────────────────────────────────────────────────────────────────

/** A command's handler. It receives the FULL argv (command words included). */
type Handler = (argv: string[]) => Promise<number>

async function apiConnectorTest(argv: string[]): Promise<number> {
  const { runApiConnectorTest } = await import("~/cli/api-connector/run")
  const { API_CONNECTOR_USAGE } = await import("~/cli/api-connector/validate")
  const res =
    argv[2] && argv[3] && !argv[2].startsWith("--") && !argv[3].startsWith("--")
      ? await runApiConnectorTest({
          identifier: argv[2],
          operation: argv[3],
          argv: argv.slice(4),
          ...(arg("--org", argv) !== undefined ? { orgSlug: arg("--org", argv) } : {}),
        })
      : null
  if (!res) {
    err(API_CONNECTOR_USAGE)
    return 2
  }
  if (res.message) err(res.message)
  process.stdout.write(`${JSON.stringify(res.report)}\n`)
  return res.exitCode
}

/** Normally run offline by cli/index.ts; here for a direct `main()` call. */
async function apiConnectorValidate(argv: string[]): Promise<number> {
  const { runApiConnectorOffline } = await import("~/cli/api-connector/validate")
  const res = runApiConnectorOffline(argv.slice(1))
  if (!res) return 2
  if (res.message) err(res.message)
  if (res.report !== null) process.stdout.write(`${JSON.stringify(res.report)}\n`)
  return res.exitCode
}

// A guided tour for one member: start it, print the deep link, wait while
// they play it (exit 0 completed, 3 abandoned, 4 timed out).
async function tour(argv: string[]): Promise<number> {
  const { runTourCli } = await import("~/cli/tour/run")
  return runTourCli(argv.slice(1))
}

async function agentAsk(argv: string[]): Promise<number> {
  const rest = argv.slice(2)
  const valued = new Set(["--org", "--as", "--agent", "--timeout", "--thread"])
  const positional = rest.filter((a, i) => !a.startsWith("--") && !valued.has(rest[i - 1] ?? ""))
  const question = positional.join(" ").trim()
  const newConversation = rest.includes("--new-conversation")
  const timeoutRaw = arg("--timeout", rest)
  const timeoutSeconds = timeoutRaw !== undefined ? Number.parseInt(timeoutRaw, 10) : 120
  const asEmail = arg("--as", rest)
  if (question === "" || !asEmail || asEmail.startsWith("--") || !Number.isFinite(timeoutSeconds)) {
    err(AGENT_ASK_USAGE)
    return 2
  }
  const orgSlug = arg("--org", rest)
  const agentHandle = arg("--agent", rest)
  const threadId = arg("--thread", rest)
  if (threadId !== undefined && (newConversation || threadId.startsWith("--"))) {
    err(AGENT_ASK_USAGE)
    return 2
  }
  const { exitCode, report } = await runAgentAsk({
    question,
    timeoutSeconds,
    baseUrl: `http://127.0.0.1:${process.env.PORT ?? "3000"}`,
    asEmail,
    ...(orgSlug !== undefined ? { orgSlug } : {}),
    ...(agentHandle !== undefined ? { agentHandle } : {}),
    ...(newConversation ? { newConversation } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
  })
  if (report.error) err(`agent ask: ${report.error}`)
  for (const line of formatPendingApprovals(report)) err(line)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  return exitCode
}

async function connect(argv: string[]): Promise<number> {
  const ref = argv[1]
  if (!ref) {
    err(CONNECT_USAGE)
    return 2
  }
  const configPath = arg("--config", argv)
  const email = arg("--email", argv)
  const forEmail = arg("--for", argv)
  if (forEmail !== undefined && (forEmail.startsWith("--") || !forEmail.includes("@"))) {
    err(CONNECT_USAGE)
    return 2
  }
  const org = arg("--org", argv)
  const tokenEnv = arg("--token-env", argv)
  const account = arg("--account", argv)
  const clientSecretEnv = arg("--client-secret-env", argv)
  const scopes = arg("--scopes", argv)
  // Variable NAMES only: a value that looks like a flag, or a token pasted in
  // its place, is refused before anything runs.
  const envName = /^[A-Za-z_][A-Za-z0-9_]*$/
  const tokenFlagsWithoutToken =
    tokenEnv === undefined &&
    (account !== undefined || clientSecretEnv !== undefined || scopes !== undefined)
  if (
    (argv.includes("--token-env") && tokenEnv === undefined) ||
    (tokenEnv !== undefined && (!envName.test(tokenEnv) || forEmail !== undefined)) ||
    (clientSecretEnv !== undefined && !envName.test(clientSecretEnv)) ||
    tokenFlagsWithoutToken
  ) {
    err(CONNECT_USAGE)
    return 2
  }
  const res = await runConnect({
    ref,
    ...(configPath !== undefined ? { configPath } : {}),
    ...(email !== undefined ? { email } : {}),
    ...(forEmail !== undefined ? { forEmail, send: argv.includes("--send") } : {}),
    ...(org !== undefined ? { org } : {}),
    ...(tokenEnv !== undefined ? { tokenEnv } : {}),
    ...(account !== undefined ? { account } : {}),
    ...(clientSecretEnv !== undefined ? { clientSecretEnv } : {}),
    ...(scopes !== undefined ? { scopes } : {}),
  })
  return res.exitCode
}

async function disconnect(argv: string[]): Promise<number> {
  const ref = argv[1]
  const account = argv[2]
  if (!ref || !account || account.startsWith("--")) {
    err(DISCONNECT_USAGE)
    return 2
  }
  const orgSlug = arg("--org", argv)
  const res = await runDisconnect({
    ref,
    account,
    force: argv.includes("--force"),
    yes: argv.includes("--yes"),
    ...(orgSlug !== undefined ? { orgSlug } : {}),
  })
  return res.exitCode
}

async function guide(argv: string[]): Promise<number> {
  const email = arg("--email", argv)
  const accountType = arg("--account-type", argv)
  const orgSlug = arg("--org", argv)
  const locale = arg("--locale", argv)
  const project = arg("--project", argv)
  const feature = arg("--feature", argv)
  const res = await runGuide({
    provider: argv[1],
    ...(email !== undefined ? { email } : {}),
    ...(accountType !== undefined ? { accountType } : {}),
    ...(project !== undefined ? { project } : {}),
    ...(feature !== undefined ? { feature } : {}),
    cli: argv.includes("--cli"),
    ...(orgSlug !== undefined ? { orgSlug } : {}),
    ...(locale !== undefined ? { locale } : {}),
    json: argv.includes("--json"),
  })
  return res.exitCode
}

async function setupState(argv: string[]): Promise<number> {
  const orgSlug = arg("--org", argv)
  const res = await runSetupState({
    ...(orgSlug !== undefined ? { orgSlug } : {}),
    json: argv.includes("--json"),
  })
  return res.exitCode
}

async function ticketsInbox(argv: string[]): Promise<number> {
  const res = await runTicketsInbox(argv.slice(2))
  if (res.exitCode !== 0 && res.message) err(res.message)
  // Machine-readable report to STDOUT (same I/O discipline as `config apply`).
  process.stdout.write(`${JSON.stringify(res.report)}\n`)
  return res.exitCode
}

async function ticketsBackfillAttachments(argv: string[]): Promise<number> {
  const daysRaw = arg("--days", argv)
  const days = daysRaw !== undefined ? Number.parseInt(daysRaw, 10) : undefined
  if (daysRaw !== undefined && (!Number.isFinite(days) || (days as number) <= 0)) {
    err(usageOf("tickets backfill-attachments"))
    return 2
  }
  const orgSlug = arg("--org", argv)
  const res = await runTicketsBackfillAttachments({
    ...(orgSlug !== undefined ? { orgSlug } : {}),
    ...(days !== undefined ? { days } : {}),
    dryRun: argv.includes("--dry-run"),
  })
  if (res.exitCode !== 0 && res.message) err(res.message)
  process.stdout.write(`${JSON.stringify(res.report)}\n`)
  return res.exitCode
}

async function ticketsImport(argv: string[]): Promise<number> {
  const file = arg("--file", argv)
  if (!file) {
    err(usageOf("tickets import"))
    return 2
  }
  const orgSlug = arg("--org", argv)
  const dryRun = argv.includes("--dry-run")
  // Default STRICT: an attachment failure fails its whole record (rollback).
  // --lenient-attachments downgrades those to loud `attachmentsSkipped[]`
  // entries in the report; the record still imports.
  const lenientAttachments = argv.includes("--lenient-attachments")
  const res = await runTicketsImport({
    file,
    ...(orgSlug !== undefined ? { orgSlug } : {}),
    dryRun,
    lenientAttachments,
  })
  // The machine-readable JSON report goes to STDOUT (same I/O discipline as
  // `config apply`): STDOUT carries ONLY the parseable report; human progress
  // text stays on STDERR (the runner already writes its progress there).
  process.stdout.write(`${JSON.stringify(res.report)}\n`)
  return res.exitCode
}

async function projectsAttachFiles(argv: string[]): Promise<number> {
  const file = arg("--file", argv)
  const filesDir = arg("--files-dir", argv)
  if (!file || !filesDir) {
    err(PROJECTS_ATTACH_FILES_USAGE)
    return 2
  }
  const orgSlug = arg("--org", argv)
  const res = await runProjectsAttachFiles({
    file,
    filesDir,
    ...(orgSlug !== undefined ? { orgSlug } : {}),
    dryRun: argv.includes("--dry-run"),
    placeholderUnknownUsers: argv.includes("--placeholder-unknown-users"),
  })
  // STDOUT carries ONLY the machine-readable JSON report (as for import).
  process.stdout.write(`${JSON.stringify(res.report)}\n`)
  return res.exitCode
}

async function projectsImport(argv: string[]): Promise<number> {
  const file = arg("--file", argv)
  if (!file) {
    err(PROJECTS_IMPORT_USAGE)
    return 2
  }
  const orgSlug = arg("--org", argv)
  const res = await runProjectsImport({
    file,
    ...(orgSlug !== undefined ? { orgSlug } : {}),
    dryRun: argv.includes("--dry-run"),
    placeholderUnknownUsers: argv.includes("--placeholder-unknown-users"),
  })
  // Same I/O discipline as `tickets import`: STDOUT carries ONLY the
  // machine-readable JSON report; human progress stays on STDERR.
  process.stdout.write(`${JSON.stringify(res.report)}\n`)
  return res.exitCode
}

async function invoicingImport(argv: string[]): Promise<number> {
  const manifestPath = arg("--manifest", argv)
  const pdfDir = arg("--pdf-dir", argv)
  if (!manifestPath || !pdfDir) {
    err(usageOf("invoicing import"))
    return 2
  }
  const orgSlug = arg("--org", argv)
  const res = await runInvoicingImport({
    manifestPath,
    pdfDir,
    ...(orgSlug !== undefined ? { orgSlug } : {}),
    dryRun: argv.includes("--dry-run"),
  })
  process.stdout.write(`${JSON.stringify(res.report)}\n`)
  return res.exitCode
}

async function slackImport(argv: string[]): Promise<number> {
  const exportDir = arg("--export-dir", argv)
  const userMapPath = arg("--user-map", argv)
  if (!exportDir || !userMapPath) {
    err(usageOf("slack import"))
    return 2
  }
  const orgSlug = arg("--org", argv)
  const channelsArg = arg("--channels", argv)
  const skipChannelsArg = arg("--skip-channels", argv)
  const filesCacheDir = arg("--files-cache", argv)
  const intArg = (flag: string): number | undefined | null => {
    const v = arg(flag, argv)
    if (v === undefined) return undefined
    const n = Number.parseInt(v, 10)
    if (Number.isNaN(n) || n < 0) {
      err(`slack import: ${flag} must be a non-negative integer (got '${v}')`)
      return null
    }
    return n
  }
  const limit = intArg("--limit")
  const maxFileMb = intArg("--max-file-mb")
  const downloadConcurrency = intArg("--download-concurrency")
  if (limit === null || maxFileMb === null || downloadConcurrency === null) return 2
  const res = await runSlackImport({
    exportDir,
    userMapPath,
    ...(orgSlug !== undefined ? { orgSlug } : {}),
    ...(channelsArg !== undefined ? { channels: channelsArg.split(",").filter(Boolean) } : {}),
    ...(skipChannelsArg !== undefined
      ? { skipChannels: skipChannelsArg.split(",").filter(Boolean) }
      : {}),
    ...(filesCacheDir !== undefined ? { filesCacheDir } : {}),
    dryRun: argv.includes("--dry-run"),
    skipFiles: argv.includes("--skip-files"),
    ...(limit !== undefined ? { limit } : {}),
    ...(maxFileMb !== undefined ? { maxFileMb } : {}),
    ...(downloadConcurrency !== undefined ? { downloadConcurrency } : {}),
    indexSearch: argv.includes("--index-search"),
    searchVectors: argv.includes("--search-vectors"),
  })
  process.stdout.write(`${JSON.stringify(res.report)}\n`)
  return res.exitCode
}

async function searchReindex(): Promise<number> {
  const res = await runSearchReindexCli()
  process.stdout.write(`${JSON.stringify(res.report)}\n`)
  return res.exitCode
}

async function seed(argv: string[]): Promise<number> {
  const res = await runSeedCli(argv.slice(1))
  if (res.message) err(res.message)
  return res.exitCode
}

async function exportCmd(argv: string[]): Promise<number> {
  if (!argv.includes("--full")) {
    err(usageOf("export"))
    return 2
  }
  const output = arg("--output", argv)
  if (!output) {
    err("export --full requires --output <path>")
    return 2
  }
  const res = await exportFull({ output })
  if (res.exitCode !== 0 && res.message) err(res.message)
  else if (res.exitCode === 0) process.stdout.write(`Wrote ${output}\n`)
  return res.exitCode
}

// One-time cleanup: org contacts that personal mailboxes created become
// their owner's private contacts again. A dry run (read-only transaction)
// unless --execute, which writes a restorable backup before it changes anything.
async function contactsPrivatize(argv: string[]): Promise<number> {
  const { runPrivatizeMailboxSendersCli } = await import("~/cli/contacts/privatize-mailbox-senders")
  return await runPrivatizeMailboxSendersCli(
    argv[1] === "privatize-mailbox-senders" ? "privatize" : "restore",
    argv.slice(2),
  )
}

async function contactsProvenance(argv: string[]): Promise<number> {
  const { runProvenanceCli } = await import("~/cli/contacts/apply-provenance")
  return await runProvenanceCli(argv[1] === "apply-provenance" ? "apply" : "restore", argv.slice(2))
}

async function mailboxVerifyAttachment(argv: string[]): Promise<number> {
  const { runVerifyAttachmentCli } = await import("~/cli/mailbox-verify-attachment")
  return await runVerifyAttachmentCli(argv.slice(2))
}

// `mailbox purge` is spec section 7 step 7, and it is IRREVERSIBLE. It is a
// dry run unless `--execute --confirm <the same user uuid>` is spelled out,
// and it still refuses without the client acknowledgement. Imported lazily so
// the destructive module is not in every CLI invocation's import graph.
async function mailboxPurge(argv: string[]): Promise<number> {
  const { runMailboxPurgeCli } = await import("~/cli/mailbox-purge")
  return await runMailboxPurgeCli(argv.slice(2))
}

// A whole-org export archive, built by the server's worker (cli/org-export.ts).
async function orgExport(argv: string[]): Promise<number> {
  const { runOrgExportCli } = await import("~/cli/org-export")
  const res = await runOrgExportCli(argv.slice(2))
  if (res.report) process.stdout.write(`${JSON.stringify(res.report, null, 2)}\n`)
  if (res.message) err(res.message)
  return res.exitCode
}

// An operator's org deletion, run by the server's worker (cli/org-delete.ts).
// IRREVERSIBLE; imported lazily like `mailbox purge`.
async function orgDelete(argv: string[]): Promise<number> {
  const { runOrgDeleteCli } = await import("~/cli/org-delete")
  const res = await runOrgDeleteCli(argv.slice(2))
  if (res.report) process.stdout.write(`${JSON.stringify(res.report, null, 2)}\n`)
  if (res.message) err(res.message)
  return res.exitCode
}

// Moving one org between instances (cli/org-transfer.ts); stdout carries the
// bundle (export) or one JSON report.
async function orgTransfer(argv: string[]): Promise<number> {
  const { runOrgTransferCli } = await import("~/cli/org-transfer")
  const res = await runOrgTransferCli(argv.slice(2))
  if (res.report) process.stdout.write(`${JSON.stringify(res.report, null, 2)}\n`)
  if (res.message) err(res.message)
  return res.exitCode
}

// The operator's per-org caps (cli/org-caps.ts).
async function orgCaps(argv: string[]): Promise<number> {
  const { runOrgCapsCli } = await import("~/cli/org-caps")
  const res = await runOrgCapsCli(argv.slice(2))
  if (res.report) process.stdout.write(`${JSON.stringify(res.report, null, 2)}\n`)
  if (res.message) err(res.message)
  return res.exitCode
}

// Removes the attachments messages deleted before deletion took them along.
async function filesPurgeDeletedMessageAttachments(argv: string[]): Promise<number> {
  const { runPurgeDeletedMessageAttachmentsCli } = await import(
    "~/cli/files-purge-deleted-message-attachments"
  )
  return await runPurgeDeletedMessageAttachmentsCli(argv.slice(2))
}

// Fire event routines again for the events they never handled (a dry run
// unless --execute): the scheduled reconciler's one shot backfill.
async function routinesReconcile(argv: string[]): Promise<number> {
  const { runRoutinesReconcileCli } = await import("~/cli/routines/reconcile")
  const res = await runRoutinesReconcileCli(argv.slice(2))
  process.stdout.write(`${JSON.stringify(res.report, null, 2)}\n`)
  if (res.message) err(res.message)
  return res.exitCode
}

async function approvalReminders(argv: string[]): Promise<number> {
  const { runApprovalRemindersCli } = await import("~/cli/approval-reminders")
  const res = await runApprovalRemindersCli(argv.slice(2))
  process.stdout.write(`${JSON.stringify(res.report, null, 2)}\n`)
  if (res.message) err(res.message)
  return res.exitCode
}

// Re-encrypt every stored secret from one key to another (a dry run unless
// --execute). The keys are read from the named environment variables, never
// from the command line. docs/runbooks/key-rotation.md.
async function keysRotate(argv: string[]): Promise<number> {
  const { runKeysRotateCli } = await import("~/cli/keys-rotate")
  const res = await runKeysRotateCli(argv.slice(2))
  if (res.report) process.stdout.write(`${JSON.stringify(res.report, null, 2)}\n`)
  if (res.message) err(res.message)
  return res.exitCode
}

// `app status` / `app rollback` / `app run-job` (`app verify` runs offline in cli/index.ts; this
// handler only answers when that entry is bypassed).
async function appCmd(argv: string[]): Promise<number> {
  const manage = await import("~/cli/app/manage")
  const sub = argv[1]
  let res: Awaited<ReturnType<typeof manage.runAppStatus>> | null
  if (sub === "status") {
    res = await manage.runAppStatus(argv.slice(2), await manage.defaultAppManageDeps())
  } else if (sub === "rollback") {
    res = await manage.runAppRollback(argv.slice(2), await manage.defaultAppManageDeps())
  } else if (sub === "run-job") {
    const runJob = await import("~/cli/app/run-job")
    res = await runJob.runAppRunJob(argv.slice(2), await runJob.defaultAppRunJobDeps())
  } else {
    const { runAppOffline } = await import("~/cli/app/verify")
    res = await runAppOffline(argv.slice(1))
  }
  if (!res) return 2
  if (res.report !== null) process.stdout.write(`${JSON.stringify(res.report, null, 2)}\n`)
  if (res.message) err(res.message)
  return res.exitCode
}

// The managed edition's identity with its control plane: minted here, pinned by
// the operator, its key installed from a 0600 file (cli/team-identity.ts).
async function teamIdentity(argv: string[]): Promise<number> {
  const { runTeamIdentityCli } = await import("~/cli/team-identity")
  const res = await runTeamIdentityCli(argv.slice(2))
  if (res.report) process.stdout.write(`${JSON.stringify(res.report, null, 2)}\n`)
  if (res.message) err(res.message)
  return res.exitCode
}

async function eraseUserCmd(argv: string[]): Promise<number> {
  const userId = argv[1]
  if (!userId) {
    err(usageOf("erase-user"))
    return 2
  }
  const res = await eraseUser(userId)
  if (res.exitCode !== 0 && res.message) err(res.message)
  else if (res.exitCode === 0) process.stdout.write(`Erased ${userId}\n`)
  return res.exitCode
}

/**
 * One handler per command of `cli/commands.ts`. Keyed by `CommandName`, so a
 * table entry without a handler, or a handler for no table entry, fails to
 * typecheck (and `commands.test.ts`).
 */
export const HANDLERS: Record<CommandName, Handler> = {
  "config apply": (argv) => configApply(argv.slice(2)),
  "config pull": (argv) => configPull(argv.slice(2)),
  "config verify": (argv) => configVerify(argv.slice(2)),
  "api-connector validate": apiConnectorValidate,
  "api-connector test": apiConnectorTest,
  "app status": appCmd,
  "app rollback": appCmd,
  "app run-job": appCmd,
  "app verify": appCmd,
  connect,
  disconnect,
  guide,
  "setup state": setupState,
  "agent ask": agentAsk,
  "tickets import": ticketsImport,
  "tickets inbox list": ticketsInbox,
  "tickets inbox create": ticketsInbox,
  "tickets inbox update": ticketsInbox,
  "tickets inbox move": ticketsInbox,
  "tickets backfill-attachments": ticketsBackfillAttachments,
  "projects import": projectsImport,
  "projects attach-files": projectsAttachFiles,
  "invoicing import": invoicingImport,
  "slack import": slackImport,
  "search reindex": searchReindex,
  export: exportCmd,
  "contacts privatize-mailbox-senders": contactsPrivatize,
  "contacts restore-privatized-senders": contactsPrivatize,
  "contacts apply-provenance": contactsProvenance,
  "contacts restore-provenance": contactsProvenance,
  "mailbox verify-attachment": mailboxVerifyAttachment,
  "mailbox purge": mailboxPurge,
  "org export": orgExport,
  "org delete": orgDelete,
  "org caps": orgCaps,
  "org transfer keys": orgTransfer,
  "org transfer export": orgTransfer,
  "org transfer import": orgTransfer,
  "org transfer estimate": orgTransfer,
  "org transfer purge-source": orgTransfer,
  "org transfer probe-write": orgTransfer,
  "org transfer probe-clear": orgTransfer,
  "org transfer agent": orgTransfer,
  "files purge-deleted-message-attachments": filesPurgeDeletedMessageAttachments,
  "routines reconcile": routinesReconcile,
  "approval-reminders run": approvalReminders,
  "tour start": tour,
  "tour list": tour,
  seed,
  "keys rotate": keysRotate,
  "team identity mint": teamIdentity,
  "team identity install": teamIdentity,
  "erase-user": eraseUserCmd,
}

export async function main(argv: string[]): Promise<number> {
  const name = resolveCommand(argv)
  if (name) return HANDLERS[name](argv)
  // `tickets inbox <missing|unknown>`: the inbox runner answers with its JSON
  // usage report on stdout (exit 2), like every other `tickets inbox` outcome.
  if (argv[0] === "tickets" && argv[1] === "inbox") return ticketsInbox(argv)
  // A known group with a missing or unknown subcommand: that group's usage.
  err(groupUsage(argv) ?? USAGE)
  return 2
}
