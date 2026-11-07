// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Every command the `liaison` CLI accepts, as data. The single source of the
 * top-level usage text (`cli/main.ts` builds `USAGE` from it), of the command
 * dispatch (main.ts keys its handlers by `CommandName`, so a command without a
 * handler, or a handler without a command, does not typecheck) and of the
 * generated reference page (`scripts/docs/gen-reference.ts` writes
 * `docs/reference/cli.md` from it).
 *
 * Pure data: this module reads no environment, so `cli/index.ts` (the offline
 * entry) and the docs generator can import it from a bare checkout.
 *
 * Summaries are taken from the commands' own usage constants, module comments
 * and docs/provisioning-cli.md. A positional argument is listed among `flags`
 * with its placeholder as the name (`<adapter file>`); a literal value a
 * positional accepts (`mail/gmail`) is listed by itself, and the top-level
 * usage prints it under its command.
 */

export interface CliFlag {
  /** `--org`, or a positional placeholder such as `<userId>`. */
  name: string
  /** The value placeholder (`<slug>`); absent for a boolean switch. */
  arg?: string
  summary: string
  required?: boolean
}

export interface CliCommand {
  /** The words that select the command, e.g. `config apply`. */
  name: string
  /** One usage line, starting with `liaison`. */
  usage: string
  summary: string
  flags: CliFlag[]
}

const ORG_SLUG: CliFlag = {
  name: "--org",
  arg: "<slug>",
  summary: "The org to act on; needed when the instance has several orgs.",
}
const DRY_RUN_IMPORT: CliFlag = {
  name: "--dry-run",
  summary: "Validate and report without writing anything.",
}

const TRANSFER_ID: CliFlag = {
  name: "--transfer",
  arg: "<id>",
  summary: "The move's id (a uuid); the same on both sides.",
  required: true,
}
const ORG_ID: CliFlag = { name: "<org id>", summary: "The org to move, by its id.", required: true }
const TRANSFER_KEYS_NOTE =
  "The first line of stdin holds the transfer keys (`org transfer keys`), never an argument or a file."

export const COMMANDS = [
  {
    name: "config apply",
    usage:
      "liaison config apply --config <path> [--format json|env] [--dry-run] [--only <path>]... [--prefer file|server[=<path>]]... [--applied-by <label>] [--no-validate-byok] [--echo-supplied]",
    summary:
      'Non-interactive, idempotent "ensure" over the whole config file: org, admin, roles, users, AI keys, API keys, email identity, mailboxes, ticket inboxes, apps, knowledge, role agents and invoicing. Never prompts. Connections that need a browser consent are reported as `pending`, not as errors. A value changed in the product since the last apply is a conflict: it is not overwritten, and the command exits 3. STDOUT carries only the machine-readable report; progress and warnings go to STDERR.',
    flags: [
      {
        name: "--config",
        arg: "<path>",
        summary: "The YAML or JSON config file.",
        required: true,
      },
      {
        name: "--format",
        arg: "json|env",
        summary: "Report format on STDOUT (default `json`).",
      },
      {
        name: "--dry-run",
        summary:
          "Validate and plan without persisting changes; the report's `drift` lists each tracked path as create, update, unchanged or conflict.",
      },
      {
        name: "--only",
        arg: "<path>",
        summary:
          "Apply and check just this path or section (e.g. `apps.database.domainAccess`); repeatable. The rest of the file is ignored.",
      },
      {
        name: "--prefer",
        arg: "file|server[=<path>]",
        summary:
          "Settle conflicts: `file` overwrites the server's value, `server` keeps it and records it as applied. `=<path>` limits it to that path; repeatable.",
      },
      {
        name: "--applied-by",
        arg: "<label>",
        summary: "Who applies, stored on the last-applied record (default `cli:<user>@<host>`).",
      },
      { name: "--no-validate-byok", summary: "Skip validating the BYOK AI provider keys." },
      {
        name: "--echo-supplied",
        summary: "Include the API keys the config supplied in the report (omitted by default).",
      },
    ],
  },
  {
    name: "config pull",
    usage: "liaison config pull --config <path> [--out <path>] [--only <path>]...",
    summary:
      "Read only. Rewrites the config file's drift-tracked values with the server's current ones, keeping its layout, its comments and its environment variable references, so a change made in the product goes back into git. Never writes a secret. Prints the updated file to STDOUT, or writes it to `--out`.",
    flags: [
      { name: "--config", arg: "<path>", summary: "The config file to read.", required: true },
      {
        name: "--out",
        arg: "<path>",
        summary: "Write the updated file there (it may be the same file) instead of STDOUT.",
      },
      { name: "--only", arg: "<path>", summary: "Pull just this path or section; repeatable." },
    ],
  },
  {
    name: "config verify",
    usage: "liaison config verify --config <path> [--app <name>]",
    summary:
      "Read only. For each connector app in the config, resolves the credential stored for the org and drives one cheap authenticated call through the app's own adapter. Prints a JSON report (app, connection, `PASS` / `FAIL` / `SKIPPED`, the remote identity, never the secret) and exits 1 when any connector fails, so it can gate a deploy.",
    flags: [
      { name: "--config", arg: "<path>", summary: "The config file.", required: true },
      { name: "--app", arg: "<name>", summary: "Verify only this connector app." },
    ],
  },
  {
    name: "api-connector validate",
    usage: "liaison api-connector validate <adapter file>",
    summary:
      "Checks an adapter document (JSON or YAML) offline against the adapter schema and the role rules. Reads no environment (no secrets, database or Redis), so it runs from a bare checkout. Prints the adapter's operations, or the issues with their exact path; exits 1 when invalid, 2 for an unreadable file.",
    flags: [
      {
        name: "<adapter file>",
        summary: "The adapter document to check.",
        required: true,
      },
    ],
  },
  {
    name: "api-connector test",
    usage:
      "liaison api-connector test <identifier> <operation> [--param name=value ...] [--pages N | --all-pages] [--dry-run] [--org <slug>]",
    summary:
      "Runs one page (or more, with --pages/--all-pages) of a READ operation of a stored connection and prints `{ok, status, items, truncated, pages, ms}`, or `{ok: false, code, message}` with exit 1 on a connector error. A write operation is refused before any request, unless --dry-run, which sends nothing for any operation and prints the rendered request.",
    flags: [
      { name: "<identifier>", summary: "The connector identifier.", required: true },
      { name: "<operation>", summary: "The operation name.", required: true },
      {
        name: "--param",
        arg: "name=value",
        summary:
          "An operation parameter; repeats. Values are typed by the operation's params schema (numbers, booleans, comma-separated arrays).",
      },
      {
        name: "--pages",
        arg: "<N>",
        summary: "Fetch up to N pages (1 to 5) of a paginated read; the report counts `pages`.",
      },
      {
        name: "--all-pages",
        summary: "Fetch every page the operation's pagination allows (its maxPages, at most 5).",
      },
      {
        name: "--dry-run",
        summary:
          "Send nothing: print the rendered request (method, URL, headers with the auth value REDACTED, body), for a write too. Reads no credential.",
      },
      ORG_SLUG,
    ],
  },
  {
    name: "app status",
    usage: "liaison app status [name]",
    summary:
      "Read only. The installed apps (or one) with their state, as the App store shows it: `running`, `failed_to_load` (the orgs where it did not load, and why) or `upgrade_failed` (the version that was switched back from, and why; the app still runs `version`), the previous version a rollback returns to and whether the active version is a security release (`noRollback`). Prints JSON; exits 1 when the named app is not installed.",
    flags: [{ name: "[name]", summary: "One app; all installed apps when omitted." }],
  },
  {
    name: "app rollback",
    usage: "liaison app rollback <name>",
    summary:
      "Makes the app's previous version the active one again, through the same health gate as an upgrade (the version that fails it is switched back from), for the whole instance. Refused when there is no previous version or the active version is a security release (`noRollback`). Running server processes follow without a restart. Prints JSON; exits 1 when refused or switched back.",
    flags: [{ name: "<name>", summary: "The app to roll back.", required: true }],
  },
  {
    name: "app run-job",
    usage:
      "liaison app run-job <app> <job> [--org <slug|id>] [--params-json <json>] [--wait] [--timeout <seconds>]",
    summary:
      "Runs one job of an installed app for one org now, the way an on-demand job runs: the org's apps are set up in the CLI process (an unknown job is refused), the job is queued with `{ ...params, orgId }` and one attempt, and the server's job worker runs it (the CLI never hosts a job). Refused when the app is Off for the org. Prints `{ jobId }`; with --wait, polls until the job finishes and prints `{ jobId, ok, ms, error? }` (`ms`: the run itself), exit 1 when it failed or did not finish in time.",
    flags: [
      { name: "<app>", summary: "The app.", required: true },
      { name: "<job>", summary: "The job, as the app's manifest names it.", required: true },
      {
        name: "--org",
        arg: "<slug|id>",
        summary: "The org to run it for; needed when the instance has several orgs.",
      },
      {
        name: "--params-json",
        arg: "<json>",
        summary:
          "The job's params, a JSON object. It may not set `orgId` or a key starting with `_`.",
      },
      { name: "--wait", summary: "Wait for the job to finish and print its outcome." },
      {
        name: "--timeout",
        arg: "<seconds>",
        summary:
          "With --wait: how long to wait (default 600). The job keeps its place on the queue after it.",
      },
    ],
  },
  {
    name: "app verify",
    usage: "liaison app verify <file|dir>",
    summary:
      "Checks an app package (`.liaisonapp`), an `app.manifest.json` or a signed artifact directory offline, the way an install does: the package's files and limits, the manifest schema, the host API range this build provides, and the icon. When `statement.json` and `statement.sig` sit beside the package, also checks the signed statement against the app-signing keys built into this release and reports the key id and whether the name, version and the ui.js, manifest and package hashes match (`signature.status`: `verified`, `refused` or `unsigned`). Reads no environment. Prints JSON; exits 1 when a check fails or the statement is refused, 2 for an unreadable file or a directory without exactly one package.",
    flags: [
      {
        name: "<file|dir>",
        summary:
          "The package or manifest to check, or a directory holding one package and its statement.",
        required: true,
      },
    ],
  },
  {
    name: "connect",
    usage:
      "liaison connect <app>/<connection> [--config <path>] [--org <slug|id>] [--email <address>] [--for <member email> [--send]] [--token-env <VAR> [--account <id>] [--client-secret-env <VAR>] [--scopes <a,b>]]",
    summary:
      "The one interactive command, for OAuth connections (`mail/gmail`, `tickets/gmail`, `social/google`, `social/meta`, `shopify/shop`). Saves the per-org Google OAuth client from `--config` when present, prints an authorize URL to STDERR and waits for a new connection to land. With `--token-env` it is not interactive: an OAuth connection whose provider issues an access token without a consent screen (a Shopify custom app's Admin API token) is connected from that token, stored as an OAuth callback stores one (encrypted, the same account's earlier connection replaced, the app told the connection exists), as the org's connection.",
    flags: [
      {
        name: "<app>/<connection>",
        summary:
          "The connection to authorize: `mail/gmail`, `tickets/gmail`, `social/google`, `social/meta` or `shopify/shop`.",
        required: true,
      },
      {
        name: "mail/gmail",
        summary: "connect a Mail app mailbox (read and send in Mail; creates no ticket inbox)",
      },
      { name: "tickets/gmail", summary: "connect a ticket inbox (its mail becomes tickets)" },
      {
        name: "--config",
        arg: "<path>",
        summary: "Config file supplying the org, the Google OAuth client and inbox settings.",
      },
      {
        name: "--for",
        arg: "<member email>",
        summary:
          "Connect that member's OWN account (a personal connection): prints a one-time link instead of an authorize URL. It works once, for 30 minutes, only when that member is signed in as themselves (it never signs anyone in), and waits for a connection they own. A mailbox's standard or private choice is theirs, on that page.",
      },
      { name: "--send", summary: "With --for: also email the member their link." },
      {
        name: "--org",
        arg: "<slug|id>",
        summary: "The org to act on; else the config's `org.slug`, else the single org.",
      },
      {
        name: "--token-env",
        arg: "<VAR>",
        summary:
          "Connect from the access token held in this environment variable, no browser. The token is read from the environment only, never from the command line, and never printed. Refused for a connection that is not OAuth.",
      },
      {
        name: "--account",
        arg: "<id>",
        summary:
          "With --token-env: the account the token is for. Required when the connection is identified by a value such as the shop domain (`acme.myshopify.com` for `shopify/shop`).",
      },
      {
        name: "--client-secret-env",
        arg: "<VAR>",
        summary:
          "With --token-env: the environment variable holding the app's client secret, saved encrypted where the app checks webhook signatures (Shopify signs its webhooks with it).",
      },
      {
        name: "--scopes",
        arg: "<a,b>",
        summary:
          "With --token-env: the scopes the token holds, comma-separated, recorded as its granted scopes.",
      },
    ],
  },
  {
    name: "disconnect",
    usage: "liaison disconnect <app>/<connection> <account> [--force] [--yes] [--org <slug>]",
    summary:
      "Disconnects one account, as Settings' Disconnect button does (the app's cleanup, tokens cleared, grant revoked at the provider). Prints what gets deleted (what Liaison imported from the account; the provider keeps the original) and asks to confirm. An organization connection is the operator's to remove; a member's personal connection only with --force, recorded in the audit log.",
    flags: [
      { name: "<app>/<connection>", summary: "The connection, e.g. `mail/gmail`.", required: true },
      {
        name: "<account>",
        summary: "The account's address or identifier, or the connection id when several match.",
        required: true,
      },
      {
        name: "--force",
        summary: "Disconnect a member's personal connection (an audit entry names its owner).",
      },
      { name: "--yes", summary: "Confirm without asking, for scripts." },
      { name: "--org", arg: "<slug>", summary: "The organization, when the server has several." },
    ],
  },
  {
    name: "guide",
    usage:
      "liaison guide <google|shopify|imap|server|<app>/<connection>> [--email <addr>] [--account-type <type>] [--project <id>] [--feature <app>] [--cli] [--org <slug>] [--locale en|fr] [--json]",
    summary:
      "Read only. Prints the setup guide the in-product agent and the client card give, computed by the same code: for Google, the address's account type and connect path (`trusted`, `consent`, `consumer_imap`, `own_client`, `imap`, `ask`) with its steps; for Shopify, the Shopify Dev Dashboard steps with this server's URLs, scopes and API version; for IMAP, a provider's app-password steps and servers; for `server`, what the person who runs the server sets up (domain and https, mail sender and its SPF/DKIM/DMARC records, Sign in with Google, server OAuth clients, push, storage, keys, backups), each with its state; for `<app>/<connection>`, any connection's steps with its redirect URI, scopes and webhook URLs. Each step says whether a person does it (`HUMAN`) or the setup agent (`AGENT`). `--json` prints the values and steps as JSON for a script or a setup skill to follow.",
    flags: [
      {
        name: "<google|shopify|imap|server|<app>/<connection>>",
        summary:
          "What to guide: `google`, `shopify`, `imap`, `server`, or a connection such as `social/facebook`.",
        required: true,
      },
      {
        name: "--email",
        arg: "<addr>",
        summary: "The address to connect: decides the Google path, or the IMAP provider.",
      },
      {
        name: "--account-type",
        arg: "<type>",
        summary:
          "Google: who hosts the mailbox when the person says it differs from what its domain shows (`google_workspace`, `google_consumer`, `microsoft`, `other`).",
      },
      {
        name: "--project",
        arg: "<id>",
        summary:
          "Google: the Cloud project's ID, so every API page link opens with that project selected.",
      },
      {
        name: "--feature",
        arg: "<app>",
        summary:
          "Google: the one feature being set up (`mail`, `tickets`, `calendar`, `google-drive`, `ads`, `social`): only its APIs and scopes, the other apps' APIs as an optional aside.",
      },
      {
        name: "--cli",
        summary:
          "Shopify: the Shopify CLI steps for a coding agent (it writes `shopify.app.toml`, deploys and reads the client back; you run only the login and the link), with the file's content, instead of the Dev Dashboard steps.",
      },
      ORG_SLUG,
      {
        name: "--locale",
        arg: "en|fr",
        summary: "The language of the steps (default: the org's).",
      },
      { name: "--json", summary: "Print JSON instead of text." },
    ],
  },
  {
    name: "setup state",
    usage: "liaison setup state [--org <slug>] [--json]",
    summary:
      "Read only. What is set up and what is left, read like the in-product agent's `kernel__setup_state`: the workspace checklist, every connection of the apps that are on (connected or not, with the command that prints its steps) and the server surfaces with their state. Ends with a `Left:` list (the required items and the open steps of the features chosen in `setup.features`, the basics until then) and a menu of the other features with their times.",
    flags: [ORG_SLUG, { name: "--json", summary: "Print JSON instead of text." }],
  },
  {
    name: "agent ask",
    usage:
      'liaison agent ask --as <member email> [--org <slug>] [--agent <@handle>] [--new-conversation | --thread <id>] [--timeout <seconds>] "<question>"',
    summary:
      "Ask one agent one question as a member and print the answer, the model, the tools the agent called and how long it took, as JSON. The turn runs in the server through its HTTP API, under the member's permissions. An approval the turn opens is listed in `pendingApprovals` (and as a `Pending approval: request-N (<tool>)` line on STDERR) and does not end the wait: the answer is the agent's own reply. Exit 0 on an answer, 1 on a failure or timeout.",
    flags: [
      {
        name: "--as",
        arg: "<member email>",
        summary: "The member to ask as. There is no default member.",
        required: true,
      },
      ORG_SLUG,
      {
        name: "--agent",
        arg: "<@handle>",
        summary: "The agent to ask (default: the member's personal agent).",
      },
      {
        name: "--new-conversation",
        summary:
          "Ask in a fresh conversation instead of the member's DM with the agent, so an earlier ask's answer is not in its context (use it for a repeated smoke test).",
      },
      {
        name: "--thread",
        arg: "<id>",
        summary:
          "Follow up in the conversation an earlier ask answered in (its `threadId`), so the agent sees that exchange.",
      },
      { name: "--timeout", arg: "<seconds>", summary: "How long to wait (default 120)." },
      { name: '"<question>"', summary: "The question.", required: true },
    ],
  },
  {
    name: "tickets import",
    usage:
      "liaison tickets import --file <ndjson> [--org <slug>] [--dry-run] [--lenient-attachments]",
    summary:
      "Bulk ticket import from canonical NDJSON (transform your export first), idempotent by `externalRef`. JSON report on STDOUT, progress on STDERR.",
    flags: [
      { name: "--file", arg: "<ndjson>", summary: "The NDJSON file.", required: true },
      ORG_SLUG,
      DRY_RUN_IMPORT,
      {
        name: "--lenient-attachments",
        summary:
          "Skip a bad attachment and report it in `attachmentsSkipped[]` instead of failing its whole record (the default).",
      },
    ],
  },
  {
    name: "tickets inbox list",
    usage: "liaison tickets inbox list [--org <slug>]",
    summary: "List the org's ticket inboxes as JSON.",
    flags: [ORG_SLUG],
  },
  {
    name: "tickets inbox create",
    usage:
      "liaison tickets inbox create --name <name> [--org <slug>] [--kind api] [--reply-via <inboxId> | --reply-from <email>] [--default-team <team>] [--default-audience <audience>] [--mint-key] [--reply-to <email>] [--from-name <name>] [--signature-html <html>] [--signature-text <text>] [--ack-enabled true|false] [--ack-body <text>] [--sla-promise <phrase>] [--notify-new-ticket true|false]",
    summary:
      "Create an API inbox: a receiving bucket (bug reports, website contact, a per-tenant endpoint) with no connected mailbox; replies go through a reply-via mailbox. Mailbox inboxes are not created here: they come from `tickets.inboxes` or `connect tickets/gmail`.",
    flags: [
      { name: "--name", arg: "<name>", summary: "The inbox name.", required: true },
      ORG_SLUG,
      { name: "--kind", arg: "api", summary: "Only `api` is accepted." },
      { name: "--reply-via", arg: "<inboxId>", summary: "The mailbox inbox replies go through." },
      { name: "--reply-from", arg: "<email>", summary: "The address replies are sent from." },
      { name: "--default-team", arg: "<team>", summary: "The team new tickets go to." },
      { name: "--default-audience", arg: "<audience>", summary: "The inbox's default audience." },
      { name: "--mint-key", summary: "Also mint an ingest API key for the inbox." },
      { name: "--reply-to", arg: "<email>", summary: "The reply-to base address." },
      { name: "--from-name", arg: "<name>", summary: "The From display name." },
      { name: "--signature-html", arg: "<html>", summary: "The HTML signature." },
      { name: "--signature-text", arg: "<text>", summary: "The plain-text signature." },
      {
        name: "--ack-enabled",
        arg: "true|false",
        summary: "Turn the acknowledgement email on or off.",
      },
      { name: "--ack-body", arg: "<text>", summary: "The acknowledgement body." },
      {
        name: "--sla-promise",
        arg: "<phrase>",
        summary: "The SLA promise phrase used in the acknowledgement.",
      },
      {
        name: "--notify-new-ticket",
        arg: "true|false",
        summary: "Raise an attention item for the inbox admins on each new ticket (default false).",
      },
    ],
  },
  {
    name: "tickets inbox update",
    usage:
      "liaison tickets inbox update --id <inboxId> [--org <slug>] [--reply-via <mailboxInboxId>] [--from-name <name>] [--reply-to <email>] [--signature-html <html>] [--signature-text <text>] [--ack-enabled true|false] [--ack-body <text>] [--sla-promise <phrase>] [--attention-cutoff <iso>|now|none] [--notify-new-ticket true|false]",
    summary:
      'Configure an inbox\'s email identity ("virtual mailbox"): From display name, reply-to base address, signature, acknowledgement on/off and body, and the SLA promise phrase, the same fields as Settings > Tickets > Inboxes. Needs at least one of them.',
    flags: [
      { name: "--id", arg: "<inboxId>", summary: "The inbox to update.", required: true },
      ORG_SLUG,
      {
        name: "--reply-via",
        arg: "<mailboxInboxId>",
        summary: "The mailbox inbox replies go through.",
      },
      { name: "--from-name", arg: "<name>", summary: "The From display name." },
      { name: "--reply-to", arg: "<email>", summary: "The reply-to base address." },
      { name: "--signature-html", arg: "<html>", summary: "The HTML signature." },
      { name: "--signature-text", arg: "<text>", summary: "The plain-text signature." },
      {
        name: "--ack-enabled",
        arg: "true|false",
        summary: "Turn the acknowledgement email on or off.",
      },
      { name: "--ack-body", arg: "<text>", summary: "The acknowledgement body." },
      {
        name: "--sla-promise",
        arg: "<phrase>",
        summary: "The SLA promise phrase used in the acknowledgement.",
      },
      {
        name: "--attention-cutoff",
        arg: "<iso>|now|none",
        summary: "The attention cutoff date (`now`, or `none` to clear it).",
      },
      {
        name: "--notify-new-ticket",
        arg: "true|false",
        summary: "Raise an attention item for the inbox admins on each new ticket (default false).",
      },
    ],
  },
  {
    name: "tickets inbox move",
    usage: "liaison tickets inbox move --ticket <id> --to-inbox <inboxId> [--org <slug>]",
    summary: "Move a ticket to another inbox.",
    flags: [
      { name: "--ticket", arg: "<id>", summary: "The ticket to move.", required: true },
      { name: "--to-inbox", arg: "<inboxId>", summary: "The destination inbox.", required: true },
      ORG_SLUG,
    ],
  },
  {
    name: "tickets backfill-attachments",
    usage: "liaison tickets backfill-attachments [--org <slug>] [--days <n>] [--dry-run]",
    summary:
      "Re-fetch Gmail attachments missing from inbound ticket messages (ingested before the sync layer hydrated provider-id attachments) and persist them the way live sync does. Idempotent: a re-run resumes where it left off.",
    flags: [
      ORG_SLUG,
      { name: "--days", arg: "<n>", summary: "The window, in days (default 90)." },
      { name: "--dry-run", summary: "Report without fetching or writing." },
    ],
  },
  {
    name: "projects import",
    usage:
      "liaison projects import --file <ndjson> [--org <slug>] [--dry-run] [--placeholder-unknown-users]",
    summary: "Bulk task import from canonical NDJSON, idempotent by `externalRef`.",
    flags: [
      { name: "--file", arg: "<ndjson>", summary: "The NDJSON file.", required: true },
      ORG_SLUG,
      DRY_RUN_IMPORT,
      {
        name: "--placeholder-unknown-users",
        summary:
          "An unknown reporter, assignee or comment-author email becomes a DEACTIVATED org user (exact attribution, cannot log in, never a thread participant). The placeholder holds that (org, email) slot: to onboard the person later, an admin must reactivate the placeholder (and give it a role); re-inviting the email fails.",
      },
    ],
  },
  {
    name: "projects attach-files",
    usage:
      "liaison projects attach-files --file <ndjson> --files-dir <dir> [--org <slug>] [--dry-run] [--placeholder-unknown-users]",
    summary:
      "Attaches local files to tasks already imported by `projects import` (matched by externalRef) as the task's files, backdated, under their original uploader. Notifies nobody; a re-run skips the files already attached (per sourceId).",
    flags: [
      { name: "--file", arg: "<ndjson>", summary: "The NDJSON file.", required: true },
      {
        name: "--files-dir",
        arg: "<dir>",
        summary: "Every file path of the NDJSON is relative to it and may not leave it.",
        required: true,
      },
      ORG_SLUG,
      DRY_RUN_IMPORT,
      {
        name: "--placeholder-unknown-users",
        summary:
          "An unknown uploader email becomes a DEACTIVATED org user; without it such a batch fails (a historical file is never attributed to the importer).",
      },
    ],
  },
  {
    name: "invoicing import",
    usage:
      "liaison invoicing import --manifest <documents.json> --pdf-dir <dir> [--org <slug>] [--dry-run]",
    summary:
      "Import historical invoicing documents with their original numbers, dates, totals and original PDF, idempotent by source filename. Each document sequence is then raised past the highest imported number.",
    flags: [
      {
        name: "--manifest",
        arg: "<documents.json>",
        summary: "The JSON manifest: an array of parsed documents.",
        required: true,
      },
      {
        name: "--pdf-dir",
        arg: "<dir>",
        summary: "The directory holding the source PDFs.",
        required: true,
      },
      ORG_SLUG,
      DRY_RUN_IMPORT,
    ],
  },
  {
    name: "slack import",
    usage:
      "liaison slack import --export-dir <path> --user-map <path.json> [--org <slug>] [--channels a,b,c] [--skip-channels a,b,c] [--files-cache <dir>] [--dry-run] [--skip-files] [--max-file-mb <n>] [--download-concurrency <n>] [--limit <n>] [--index-search] [--search-vectors]",
    summary:
      "Bulk-import a Slack export (channels.json, users.json, per-channel daily message files) into Liaison channels, so the imported history reads the way Slack did: channels, members, messages and thread replies, mentions, reactions, pins and files.",
    flags: [
      {
        name: "--export-dir",
        arg: "<path>",
        summary: "The unpacked Slack export.",
        required: true,
      },
      {
        name: "--user-map",
        arg: "<path.json>",
        summary: "JSON map of Slack user ids to Liaison users.",
        required: true,
      },
      ORG_SLUG,
      { name: "--channels", arg: "a,b,c", summary: "Import only these channels." },
      { name: "--skip-channels", arg: "a,b,c", summary: "Skip these channels." },
      { name: "--files-cache", arg: "<dir>", summary: "Where downloaded files are cached." },
      DRY_RUN_IMPORT,
      { name: "--skip-files", summary: "Do not download or re-host files." },
      {
        name: "--max-file-mb",
        arg: "<n>",
        summary: 'Files larger than this are linked as "too large", not re-hosted (default 50).',
      },
      {
        name: "--download-concurrency",
        arg: "<n>",
        summary: "Parallel file downloads per channel (default 8).",
      },
      { name: "--limit", arg: "<n>", summary: "Import at most this many messages." },
      {
        name: "--index-search",
        summary: "After importing, backfill the imported channels into the search index.",
      },
      {
        name: "--search-vectors",
        summary: "Embed the backfilled documents with the org's key (provider cost).",
      },
    ],
  },
  {
    name: "search reindex",
    usage: "liaison search reindex",
    summary:
      "Full reindex of the unified search index for every org. Builds a shadow index and swaps it in atomically, so search keeps serving the old index until the new one is complete.",
    flags: [],
  },
  {
    name: "export",
    usage: "liaison export --full --output <path>",
    summary:
      "Full instance export (database, files, search) to a tar.gz, renamed onto `--output` only on success. Needs a DDL-privileged database connection.",
    flags: [
      { name: "--full", summary: "Export the whole instance (required).", required: true },
      { name: "--output", arg: "<path>", summary: "The tar.gz to write.", required: true },
    ],
  },
  {
    name: "contacts privatize-mailbox-senders",
    usage:
      "liaison contacts privatize-mailbox-senders --org <uuid> [--print-sql | --execute --backup <new file>]",
    summary:
      "One-time cleanup: org contacts that personal mailboxes created become their owner's private contacts again, without deleting anything. A dry run (read-only transaction) unless `--execute`.",
    flags: [
      { name: "--org", arg: "<uuid>", summary: "The org id.", required: true },
      {
        name: "--print-sql",
        summary: "Print the classification statement for a read-only run elsewhere.",
      },
      { name: "--execute", summary: "Apply the changes (requires `--backup`)." },
      {
        name: "--backup",
        arg: "<new file>",
        summary:
          "A file that does not exist yet; each changed row's previous sharing is written there (mode 0600) before anything changes.",
      },
    ],
  },
  {
    name: "contacts restore-privatized-senders",
    usage: "liaison contacts restore-privatized-senders --org <uuid> --backup <path>",
    summary:
      "Put back what `privatize-mailbox-senders` changed, skipping a contact whose address has an org contact again.",
    flags: [
      { name: "--org", arg: "<uuid>", summary: "The org id.", required: true },
      {
        name: "--backup",
        arg: "<path>",
        summary: "The backup file the privatize run wrote.",
        required: true,
      },
    ],
  },
  {
    name: "contacts apply-provenance",
    usage:
      "liaison contacts apply-provenance --org <uuid> --delete-unused-created-by <uuid> --orphans-to <uuid> [--actor <uuid>] [--plan-out <new file> | --execute --plan <json> --backup <new file>]",
    summary:
      "Applies the owner's decisions on a contacts provenance report in one transaction: deletes unused contacts created by one person, makes orphaned ones private to another, and privatizes every personal-source contact to its mailbox's owner. A dry run (read only, prints the plan) unless `--execute`.",
    flags: [
      { name: "--org", arg: "<uuid>", summary: "The org id.", required: true },
      {
        name: "--delete-unused-created-by",
        arg: "<uuid>",
        summary:
          'Delete the contacts classified "created by a person, not used by any team object" whose creator is this user.',
        required: true,
      },
      {
        name: "--orphans-to",
        arg: "<uuid>",
        summary:
          'Make the contacts classified "creator no longer exists, not used by any team object" private, owned by this user.',
        required: true,
      },
      { name: "--actor", arg: "<uuid>", summary: "The user the changes are recorded as." },
      { name: "--plan-out", arg: "<new file>", summary: "Also write the dry-run plan there." },
      {
        name: "--execute",
        summary:
          "Apply the plan. Recomputes it under row locks and refuses unless it is identical to `--plan`.",
      },
      { name: "--plan", arg: "<json>", summary: "The reviewed dry-run plan." },
      {
        name: "--backup",
        arg: "<new file>",
        summary: "Written (0600, never overwritten) before anything changes.",
      },
    ],
  },
  {
    name: "contacts restore-provenance",
    usage: "liaison contacts restore-provenance --org <uuid> --backup <path>",
    summary: "Put back everything `apply-provenance` changed, from its backup.",
    flags: [
      { name: "--org", arg: "<uuid>", summary: "The org id.", required: true },
      {
        name: "--backup",
        arg: "<path>",
        summary: "The backup file the apply run wrote.",
        required: true,
      },
    ],
  },
  {
    name: "mailbox verify-attachment",
    usage: "liaison mailbox verify-attachment --file-id <id>",
    summary:
      "Check that an encrypted mailbox attachment is really sealed in object storage. Read only: it fetches a head range through the app's own storage client and prints.",
    flags: [{ name: "--file-id", arg: "<id>", summary: "The kernel.files id.", required: true }],
  },
  {
    name: "org export",
    usage: "liaison org export <org slug or id> [--wait] [--timeout <seconds>]",
    summary:
      "Export a whole organization: every table row (secrets left out) and every file, as one zip archive in object storage at `orgs/<org id>/exports/<export id>-<run id>.zip`, kept 7 days. The server's worker builds it; the command queues it and prints the export id, or with `--wait` follows it and prints the object key and size. Refused while another export of the org runs.",
    flags: [
      { name: "<org slug or id>", summary: "The org to export.", required: true },
      { name: "--wait", summary: "Wait for the archive and print where it is." },
      {
        name: "--timeout",
        arg: "<seconds>",
        summary:
          "With `--wait`, give up waiting after this long (default 3600). The export keeps running.",
      },
    ],
  },
  {
    name: "org delete",
    usage:
      "liaison org delete <org slug or id> [--dry-run] [--yes <slug>] [--export-to <path>] [--no-legal-archive] [--without-export-i-accept-losing-the-org-data] [--abort] [--timeout <seconds>]",
    summary:
      "Irreversibly delete an organization and everything it owns, in every store. Refused (exit 2, with the fix) for the instance's own organization, while an export of it runs, without a completed export under 24 h old that was downloaded or is saved with `--export-to`, and without `LEGAL_ARCHIVE_RECIPIENT` unless `--no-legal-archive`. Writes the deletion ledger, marks the org deleting, then the server's worker writes the encrypted legal archive and purges the org; the command follows it and prints the ledger as JSON. Run it again to resume a deletion that stopped.",
    flags: [
      {
        name: "<org slug or id>",
        summary: "The org to delete (its id also finds a deletion whose org row is gone).",
        required: true,
      },
      {
        name: "--dry-run",
        summary: "Print the gates and what the org holds in every store; change nothing.",
      },
      {
        name: "--yes",
        arg: "<slug>",
        summary: "Confirm without the prompt by typing the org slug.",
      },
      {
        name: "--export-to",
        arg: "<path>",
        summary:
          "Save the org's latest completed export (under 24 h old) to this new local file first; meets the export gate.",
      },
      {
        name: "--no-legal-archive",
        summary:
          "Delete without a legal archive when `LEGAL_ARCHIVE_RECIPIENT` is unset (a warning; the waiver goes on the ledger).",
      },
      {
        name: "--without-export-i-accept-losing-the-org-data",
        summary: "Delete without an export (a warning; the waiver goes on the ledger).",
      },
      {
        name: "--abort",
        summary: "Cancel a deletion whose purge has not started, and restore the org.",
      },
      {
        name: "--timeout",
        arg: "<seconds>",
        summary:
          "Stop following after this long (default 21600). The deletion keeps running on the server.",
      },
    ],
  },
  {
    name: "org transfer keys",
    usage: "liaison org transfer keys",
    summary:
      "Print one line of fresh one-time transfer keys (one per key family) for a move: feed it as the first stdin line of both the export and the import, and keep it nowhere else.",
    flags: [],
  },
  {
    name: "org transfer export",
    usage:
      "liaison org transfer export <org id> --transfer <id> [--since <file>] [--fingerprint-out <file>]",
    summary: `Write one org's whole state (every table it owns, its search documents, its webhook replay marks) to stdout as a checksummed bundle, read in one snapshot, its stored secrets re-encrypted under the transfer keys. Read only. Refuses a demo org, an org being deleted, and a secret this instance's key cannot open. ${TRANSFER_KEYS_NOTE}`,
    flags: [
      ORG_ID,
      TRANSFER_ID,
      {
        name: "--since",
        arg: "<file>",
        summary:
          "A delta: only rows changed, added or deleted since the export that wrote this fingerprint.",
      },
      {
        name: "--fingerprint-out",
        arg: "<file>",
        summary:
          "Save this export's fingerprint (primary keys and row versions, no content) for a later `--since`.",
      },
    ],
  },
  {
    name: "org transfer import",
    usage: "liaison org transfer import [--dry-run]",
    summary: `Apply a bundle from stdin to this instance in one transaction: the org arrives \`incoming\` (it serves nothing until the move commits), its secrets re-encrypted under this instance's keys. Refused, with nothing written, when the schema, an app version or a table's columns differ, when another org here holds one of its unique keys (a sign-in, the slug), or when the org already exists here (except its own \`moved\` copy on a move back). Prints a JSON report. ${TRANSFER_KEYS_NOTE}`,
    flags: [
      { name: "--dry-run", summary: "Run every check and write nothing: the move's precheck." },
    ],
  },
  {
    name: "org transfer estimate",
    usage: "liaison org transfer estimate <org id>",
    summary:
      "Print the org's rows and bytes per table and the estimated write pause of a move, as JSON.",
    flags: [ORG_ID],
  },
  {
    name: "org transfer purge-source",
    usage: "liaison org transfer purge-source <org id> --transfer <id>",
    summary:
      "Delete this instance's copy of an org that was moved away, in every store. Refused unless the org is `moved` by that transfer, the move proved the two instances' stores differ, and a fresh storage probe of the target (the line `org transfer probe-write` printed there, on stdin) is not visible here: a target rebuilt during the hold with this instance's object store, search index or Redis is caught before anything is deleted. Run `org transfer probe-clear` on the target afterwards.",
    flags: [ORG_ID, TRANSFER_ID],
  },
  {
    name: "org transfer probe-write",
    usage: "liaison org transfer probe-write <org id> --transfer <id>",
    summary:
      "On the instance an org moved to: write a storage probe (an object, a search document and a Redis key) and print it as one JSON line, for `org transfer purge-source` on the source to look for.",
    flags: [ORG_ID, TRANSFER_ID],
  },
  {
    name: "org transfer probe-clear",
    usage: "liaison org transfer probe-clear",
    summary: "Remove the storage probe whose line (from `org transfer probe-write`) is on stdin.",
    flags: [],
  },
  {
    name: "org transfer agent",
    usage:
      "liaison org transfer agent --role target | agent --role source <org id> --transfer <id> --target-cmd <command> [--fail-at <step>]",
    summary:
      'Run one side of a live move. The target agent reads the source\'s commands on stdin and answers on stdout (make it an ssh forced command). The source agent starts the target agent with `--target-cmd`, copies the org twice while it is live, drains it, freezes its writes for the last changes (each step under a time limit, past which it aborts), and commits with the control plane, which holds the move\'s lease. Its first stdin line is `{"operator":{"control":"<webhook base>","operatorKey":"<key>"}}`. Exit 0 committed, 1 aborted (the org stays here), 3 no decision reachable (the org stays frozen until the control plane answers).',
    flags: [
      {
        name: "--role",
        arg: "<source|target>",
        summary: "`source` (drives the move) or `target` (receives it).",
        required: true,
      },
      { ...ORG_ID, required: false },
      { ...TRANSFER_ID, required: false },
      {
        name: "--target-cmd",
        arg: "<command>",
        summary:
          "Source only: the command that starts the target agent (e.g. an ssh to the target).",
      },
      {
        name: "--fail-at",
        arg: "<precopy|draining|frozen|after-cas>",
        summary:
          "Source only, for rehearsals on test servers: stop on the spot at that step (no abort, no more heartbeats), as a crash would.",
      },
    ],
  },
  {
    name: "org caps",
    usage:
      "liaison org caps <org slug or id> [--seats <n>] [--mailboxes <n>] [--storage-gb <n>] [--jobs-per-hour <n>] [--custom-apps <n>] [--audit-days <n>] [--unset <cap>]",
    summary:
      "Show or set an organization's caps: seats (active people), mailboxes (connected Gmail or IMAP addresses), storage in GB, and background jobs per hour. Without a change flag it prints the caps and the usage; a change keeps the caps it does not name. A missing cap is unlimited, which is how every org starts. Each cap is a whole number of at least 1: 0 is refused, and `--unset` makes a cap unlimited. Only the operator sets caps: org admins see them read only in Settings → Organization. A cap below current usage removes nothing; new seats and mailboxes are refused until usage drops, and background jobs over the hourly cap wait for the next hour.",
    flags: [
      { name: "<org slug or id>", summary: "The org.", required: true },
      { name: "--seats", arg: "<n>", summary: "Most active people in the org." },
      {
        name: "--mailboxes",
        arg: "<n>",
        summary: "Most connected mailboxes (distinct addresses).",
      },
      { name: "--storage-gb", arg: "<n>", summary: "Most stored file bytes, in GB." },
      {
        name: "--jobs-per-hour",
        arg: "<n>",
        summary: "Most background jobs started per clock hour; the rest wait for the next hour.",
      },
      { name: "--custom-apps", arg: "<n>", summary: "Most custom apps installed for the org." },
      { name: "--audit-days", arg: "<n>", summary: "Most days of audit log the org keeps." },
      {
        name: "--unset",
        arg: "<seats|mailboxes|storage-gb|jobs-per-hour|custom-apps|audit-days>",
        summary: "Make that cap unlimited again. Repeatable.",
      },
    ],
  },
  {
    name: "mailbox purge",
    usage:
      "liaison mailbox purge --user <uuid> --org <uuid> [--execute --confirm <same user uuid>]",
    summary:
      "Irreversible purge of one member's personal mailbox plaintext. A dry run unless `--execute --confirm <same user uuid>`, and it refuses without a valid client acknowledgement.",
    flags: [
      { name: "--user", arg: "<uuid>", summary: "The member.", required: true },
      { name: "--org", arg: "<uuid>", summary: "The org id.", required: true },
      { name: "--execute", summary: "Purge for real (requires `--confirm`)." },
      { name: "--confirm", arg: "<same user uuid>", summary: "The same user id, typed out." },
    ],
  },
  {
    name: "files purge-deleted-message-attachments",
    usage: "liaison files purge-deleted-message-attachments [--org <uuid>] [--dry-run]",
    summary:
      "Delete the attachments of messages that were deleted before deleting a message took its files along (rows now, objects through the server's object-deletion job). Every org, or only `--org`; idempotent.",
    flags: [
      { name: "--org", arg: "<uuid>", summary: "Only this org." },
      { name: "--dry-run", summary: "Only count." },
    ],
  },
  {
    name: "routines reconcile",
    usage:
      "liaison routines reconcile [--since <iso date>] [--days <n>] [--org <slug>] [--routine <uuid>] [--max-per-routine <n>] [--execute]",
    summary:
      "Run the event routine reconciler once, over a window of your choosing: fire event routines again for the events they never handled. The scheduled job looks back 14 days; this is the one-shot backfill after an outage. A dry run unless `--execute`.",
    flags: [
      { name: "--since", arg: "<iso date>", summary: "Start of the window." },
      { name: "--days", arg: "<n>", summary: "Length of the window, in days." },
      { name: "--org", arg: "<slug>", summary: "Only this org." },
      { name: "--routine", arg: "<uuid>", summary: "Only this routine." },
      {
        name: "--max-per-routine",
        arg: "<n>",
        summary: "Retries started per routine in one pass (default 5).",
      },
      {
        name: "--execute",
        summary:
          "Enqueue the retries for the server's routine-tick worker and raise or resolve the routines' incidents.",
      },
    ],
  },
  {
    name: "approval-reminders run",
    usage: "liaison approval-reminders run --user <member email|uuid> [--org <slug>] [--force]",
    summary:
      "Remind one member now, instead of at the hourly sweep, of the requests their own agent proposed for them that have waited longer than their reminder interval (a day by default) for a decision: posts the reminder in their conversation with their agent and queues the agent's turn that writes it. Does nothing when no such request waits, or when the member turned approval reminders off or was reminded within their interval (unless `--force`).",
    flags: [
      { name: "--user", arg: "<member email|uuid>", summary: "The member.", required: true },
      ORG_SLUG,
      {
        name: "--force",
        summary:
          "Send even if the member was reminded within their interval or turned approval reminders off.",
      },
    ],
  },
  {
    name: "tour start",
    usage: "liaison tour start <tourId> --user <member email> [--org <slug>] [--timeout <seconds>]",
    summary:
      "Start a guided tour for one member and wait while they play it. Prints the deep link (`<BASE_URL>/?tour=<tourId>`) and one line per step reached. Exit 0 completed, 3 abandoned, 4 timed out, 2 for an unknown tour or member.",
    flags: [
      { name: "<tourId>", summary: "The tour to start.", required: true },
      { name: "--user", arg: "<member email>", summary: "The member.", required: true },
      ORG_SLUG,
      { name: "--timeout", arg: "<seconds>", summary: "How long to wait (default 1800)." },
    ],
  },
  {
    name: "tour list",
    usage: "liaison tour list [--org <slug>]",
    summary: "The tours the org can play, one per line: id, number of steps, title.",
    flags: [ORG_SLUG],
  },
  {
    name: "seed",
    usage:
      "liaison seed --tier demo|lively|load|standard [--admin <email>] [--now <instant>] [--only agent-app] [--variant reserved|visitor] [--slug <slug>] [--name <org name>] [--locale <locale>] [--reset|--no-reset] [--passwords <password>|--passwords-env <VAR>] [--replace] [--warehouse] [--no-commerce] [--people <file>] [--orgs <n>] [--prefix <prefix>] [--shape demo] [--volume] [--threads <n>] [--contacts <n>] [--tickets <n>] [--projects <n>] [--no-reindex] [--ttl-hours <hours>] [--concurrency <n>]",
    summary:
      "Fill an org from the seed engine. Tier `demo` seeds the Resonant Audio Labs demo world (people, agents, tickets, mail, knowledge, projects, invoices, shipments, routines) into the org `--slug` names, creating it as a demo org; it refuses an existing org that is not one. Tier `lively` seeds the same world with ten people and fourteen days of activity up to now (conversations, chats with agents, tickets that moved, routine and sub agent runs, attention and its delivery log), for private servers; it needs `--slug`, or `--admin` to seed an org that exists already, and `--people` puts your own people in the world's seats. Tier `load` seeds `--orgs` disposable demo orgs for a load run (`<prefix><i>`), each marked synthetic with an expiry so the demo reaper deletes them, flagged as load orgs when `LOAD_HARNESS_KEY` is set, and with `--volume` adds thousands of threads, contacts, tickets and projects to each, checks that the org's admin reads every one of them back and re-indexes the org's search; it prints one `[load-seed] result <json>` line. Tier `standard` seeds the QA world the test lanes and the dev server start from (four teammates, channels, contacts, knowledge, tickets, approvals, mail) into the org of the admin `--admin` names, and prints the seeded ids as one JSON line; `--only agent-app` puts its agent-app rows back in an org it already seeded. Exit 0 seeded in full, 1 a layer failed.",
    flags: [
      {
        name: "--tier",
        arg: "demo|lively|load|standard",
        summary: "The world to seed.",
        required: true,
      },
      {
        name: "--admin",
        arg: "<email>",
        summary:
          "`standard`: the admin whose org is seeded; the org must have no other people yet. `lively`: seed the org of this admin, an org that exists already, instead of one under `--slug`: it is not marked as a demo org, its settings stay as they are, and a member already at a seat's address keeps their password and roles and is given the seat's role.",
      },
      {
        name: "--now",
        arg: "<instant>",
        summary: "`standard`: the instant the world's times are relative to (default: now).",
      },
      {
        name: "--only",
        arg: "agent-app",
        summary:
          "`standard`: re-run only the agent-app part (skills, routines, agent chats, past runs) in an org it already seeded.",
      },
      {
        name: "--variant",
        arg: "reserved|visitor",
        summary:
          "`reserved` (default): the demo instance's review org, owned by the account `LIAISON_DEMO_REVIEWER_PASSWORD` signs into; `visitor`: an org with no owner.",
      },
      {
        name: "--slug",
        arg: "<slug>",
        summary: "The org to seed (default: the reserved org's slug).",
      },
      { name: "--name", arg: "<org name>", summary: "The org's name for a new org." },
      { name: "--locale", arg: "<locale>", summary: "The language the world is written in." },
      {
        name: "--reset",
        summary: "Clear the org's seeded content first (the default for `reserved`).",
      },
      { name: "--no-reset", summary: "Top up: adopt what is there, clear nothing." },
      {
        name: "--passwords",
        arg: "<password>",
        summary:
          "Give the seeded people this password so a tester can sign in as them; refused in demo mode.",
      },
      {
        name: "--passwords-env",
        arg: "<VAR>",
        summary:
          "`lively` and `load`: read that password from this environment variable, so it never shows in a process list.",
      },
      {
        name: "--replace",
        summary:
          "`lively`: delete the earlier demo org under `--slug` first, so the activity ends now; refused in demo mode.",
      },
      {
        name: "--no-commerce",
        summary:
          "`lively`: leave out the shop, invoices, carrier and books, for an org without the commerce apps installed.",
      },
      {
        name: "--people",
        arg: "<file>",
        summary:
          "`lively`: a JSON array of your own people in the world's seats (`seat`, `name`, `email`, optional `jobTitle` and `bio`); everything the world writes for that seat is written for them.",
      },
      {
        name: "--warehouse",
        summary: "`lively`: also seed the analytics warehouse part (off unless given).",
      },
      { name: "--orgs", arg: "<n>", summary: "`load`: how many load orgs to seed (1 to 1000)." },
      {
        name: "--prefix",
        arg: "<prefix>",
        summary: "`load`: org `i` gets the slug `<prefix><i>` (default `load-`).",
      },
      { name: "--shape", arg: "demo", summary: "`load`: the world each load org holds." },
      {
        name: "--volume",
        summary:
          "`load`: add bulk rows to each org (default 1100 threads, 5000 contacts, 3000 tickets, 1000 projects).",
      },
      { name: "--threads", arg: "<n>", summary: "`load --volume`: threads per org." },
      { name: "--contacts", arg: "<n>", summary: "`load --volume`: contacts per org." },
      { name: "--tickets", arg: "<n>", summary: "`load --volume`: tickets per org." },
      { name: "--projects", arg: "<n>", summary: "`load --volume`: projects per org." },
      {
        name: "--no-reindex",
        summary: "`load --volume`: skip the search re-index of each org at the end.",
      },
      {
        name: "--ttl-hours",
        arg: "<hours>",
        summary:
          "`load`: hours until a load org expires and the demo reaper deletes it (default 6).",
      },
      { name: "--concurrency", arg: "<n>", summary: "`load`: orgs seeded at once (default 1)." },
    ],
  },
  {
    name: "keys rotate",
    usage:
      "liaison keys rotate --family encryption|byok --from-env <VAR> --to-env <VAR> [--execute] [--skip-undecryptable]",
    summary:
      "Re-encrypt every stored secret from the key in one environment variable to the key in another, in one transaction, and print a per-column report. A dry run unless `--execute`; safe to run again. Run it with the app stopped (docs/runbooks/key-rotation.md).",
    flags: [
      {
        name: "--family",
        arg: "encryption|byok",
        summary: "`encryption` for `ENCRYPTION_KEY`, `byok` for `BYOK_ENCRYPTION_KEY`.",
        required: true,
      },
      {
        name: "--from-env",
        arg: "<VAR>",
        summary: "The environment variable holding the old key.",
        required: true,
      },
      {
        name: "--to-env",
        arg: "<VAR>",
        summary: "The environment variable holding the new key.",
        required: true,
      },
      { name: "--execute", summary: "Re-encrypt for real." },
      {
        name: "--skip-undecryptable",
        summary: "Proceed even when a value opens with neither key.",
      },
    ],
  },
  {
    name: "team identity mint",
    usage: "liaison team identity mint [--force]",
    summary:
      "Managed edition only. Mint this server's identity with its control plane: a new random instance id, state `pending`, printed as JSON for the operator to pin on the control plane. Nothing is sent. Refuses when an identity exists unless `--force`.",
    flags: [
      {
        name: "--force",
        summary:
          "Replace an existing identity (re-keying); its waiting outbox messages are cancelled.",
      },
    ],
  },
  {
    name: "team identity install",
    usage: "liaison team identity install --key-file <path>",
    summary:
      "Managed edition only. Install the instance key the control plane derived for the minted id, read from a file only its owner can read (0600). The key is stored encrypted under `ENCRYPTION_KEY` and the identity becomes `registered`. Prints the instance id and the key fingerprint (first 16 hex characters of its SHA-256).",
    flags: [
      {
        name: "--key-file",
        arg: "<path>",
        summary: "The file holding the 64-hex-character instance key, mode 0600.",
        required: true,
      },
    ],
  },
  {
    name: "erase-user",
    usage: "liaison erase-user <userId>",
    summary:
      "GDPR erasure of one user, in one transaction: each app's declared per-field strategy, a tombstoned user row and one `user.erased` audit entry.",
    flags: [{ name: "<userId>", summary: "The user to erase.", required: true }],
  },
] as const satisfies readonly CliCommand[]

export type CommandName = (typeof COMMANDS)[number]["name"]

/** Commands `cli/index.ts` runs before loading the environment. */
export const OFFLINE_COMMANDS: readonly CommandName[] = ["api-connector validate", "app verify"]

/** The command named `name`. */
export function commandByName(name: CommandName): CliCommand {
  const found = COMMANDS.find((c) => c.name === name)
  if (!found) throw new Error(`unknown CLI command '${name}'`)
  return found
}

/** `usage: liaison …` for one command, as printed on a usage error. */
export function usageOf(name: CommandName): string {
  return `usage: ${commandByName(name).usage}`
}

/**
 * The command `argv` selects: the longest table name whose words start
 * `argv`. Null when none does.
 */
export function resolveCommand(argv: readonly string[]): CommandName | null {
  let best: CommandName | null = null
  let bestLen = 0
  for (const c of COMMANDS) {
    const words = c.name.split(" ")
    if (words.length <= bestLen) continue
    if (words.every((w, i) => argv[i] === w)) {
      best = c.name
      bestLen = words.length
    }
  }
  return best
}

/**
 * The usage of every command whose name starts with the longest known prefix
 * of `argv` (`tickets inbox frob` → the four `tickets inbox` commands), each
 * followed by its flags, or null when `argv[0]` names no command group.
 */
export function groupUsage(argv: readonly string[]): string | null {
  for (let n = Math.min(argv.length, 3); n >= 1; n--) {
    const prefix = argv.slice(0, n)
    const matches = COMMANDS.filter((c) => {
      const words = c.name.split(" ")
      return words.length > n && prefix.every((w, i) => words[i] === w)
    })
    if (matches.length === 0) continue
    return matches
      .flatMap((c: CliCommand, i) => [
        `${i === 0 ? "usage: " : "       "}${c.usage}`,
        ...c.flags.map((f) => `         ${flagLabel(f)}  ${f.summary}`),
      ])
      .join("\n")
  }
  return null
}

/** `--org <slug>`, `<userId>`. */
export function flagLabel(f: CliFlag): string {
  return f.arg ? `${f.name} ${f.arg}` : f.name
}

/** A literal value a positional accepts (`mail/gmail`), not a flag or placeholder. */
export function isLiteralValue(f: CliFlag): boolean {
  return !f.name.startsWith("-") && !f.name.startsWith("<") && !f.name.startsWith('"')
}

/** The top-level usage text: every command, one line each. */
export function topLevelUsage(): string {
  return [
    "usage: liaison <command>",
    ...COMMANDS.flatMap((c: CliCommand) => [
      `  ${c.usage.replace(/^liaison /, "")}`,
      ...c.flags.filter(isLiteralValue).map((f) => `      ${f.name.padEnd(13)}  ${f.summary}`),
    ]),
  ].join("\n")
}
