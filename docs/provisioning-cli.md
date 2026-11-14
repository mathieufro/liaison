# Provisioning CLI (`liaison`)

`liaison` is the privileged operator CLI. It runs the API internals in process
(no HTTP) against the database of a running instance. Its main job is
config-as-code: one YAML or JSON file describes an org (admin, roles, members,
AI keys, API keys, email identity, mailboxes, ticket inboxes, apps, knowledge,
role agents, invoicing) and `liaison config apply` makes it so, idempotently.

To have Claude Code or Codex do the whole setup for you (interview, deploy,
knowledge gathering, this config, a smoke test), open a clone's folder in
Claude Code or Codex and ask "set up Liaison for my company"; the playbook is
[.claude/skills/setup-liaison/SKILL.md](../.claude/skills/setup-liaison/SKILL.md).

## Mail app mailboxes vs ticket inboxes

Liaison has two different products that both read an email account. Pick by
the outcome you want; the CLI keeps them apart on purpose.

| You want | Config section | Connect command | What it creates |
|---|---|---|---|
| People read and send mail in the **Mail** app | `mail.mailboxes` | `liaison connect mail/gmail` | A Mail app mailbox. Never a ticket, never a ticket inbox. |
| Customer mail becomes **tickets** | `tickets.inboxes` | `liaison connect tickets/gmail` | A ticket inbox, backed by a connection the Tickets app owns. |

A ticket inbox never rides on a Mail app mailbox: the Tickets app only syncs
connections it owns, so an inbox attached to a Mail app connection looks fine
and never receives a ticket. The old top-level `mailboxes` section did exactly
that and is now refused with a message telling you which section to use.

The same address can be both (two connections, two apps with full access to
the mailbox). Do that on purpose only.

## Commands

Canonical invocation inside the app container (the image puts the `liaison`
shim on `PATH`; `bun run --cwd apps/api liaison ...` works from a checkout):

```sh
docker compose exec -T app liaison <command>
```

`deploy/docker-compose.yml` mounts the host's `deploy/setup/` (gitignored) read
only at `/setup` in the app container: put the config file and the knowledge
files it loads there and pass `--config /setup/liaison-config.yaml`. Never put
secrets in that folder (the long-running app sees it): the config names them as
`${VAR}` references, the values live outside it (the setup playbook uses the
gitignored `deploy/.setup-secrets.env`), and they reach the container per
command (`docker compose exec -T -e OPENROUTER_API_KEY app ...`).

```
liaison config apply --config <path> [--format json|env] [--dry-run] [--only <path>]... [--prefer file|server[=<path>]]... [--applied-by <label>] [--no-validate-byok] [--echo-supplied]
liaison config pull --config <path> [--out <path>] [--only <path>]...
liaison config verify --config <path> [--app <name>]
liaison api-connector validate <adapter file>
liaison api-connector test <identifier> <operation> [--param name=value ...] [--org <slug>] [--app <name>]
liaison app status [name]
liaison app rollback <name>
liaison app run-job <app> <job> [--org <slug|id>] [--params-json <json>] [--wait] [--timeout <seconds>]
liaison app verify <file|dir>
liaison connect <app>/<connection> [--config <path>] [--org <slug|id>] [--email <addr>] [--for <member email> [--send]]
liaison connect <app>/<connection> --token-env <VAR> [--account <id>] [--client-secret-env <VAR>] [--scopes <a,b>] [--org <slug|id>]
liaison disconnect <app>/<connection> <account> [--force] [--yes] [--org <slug>]
liaison guide <google|shopify|imap|server|<app>/<connection>> [--email <addr>] [--account-type <type>] [--org <slug>] [--locale en|fr] [--json]
liaison setup state [--org <slug>] [--json]
liaison agent ask --as <member email> [--org <slug>] [--agent <@handle>] [--new-conversation | --thread <id>] [--timeout <seconds>] "<question>"
liaison tour start <tourId> --user <member email> [--org <slug>] [--timeout <seconds>]
liaison tour list [--org <slug>]
liaison tickets import --file <ndjson> [--org <slug>] [--dry-run] [--lenient-attachments]
liaison tickets inbox list [--org <slug>]
liaison tickets inbox create --name <name> [--kind api] [--org <slug>] [flags]
liaison tickets inbox update --id <inboxId> [--org <slug>] [flags]
liaison tickets inbox move --ticket <id> --to-inbox <inboxId> [--org <slug>]
liaison tickets backfill-attachments [--org <slug>] [--days <n>] [--dry-run]
liaison projects import --file <ndjson> [--org <slug>] [--dry-run]
liaison invoicing import --manifest <documents.json> --pdf-dir <dir> [--org <slug>] [--dry-run]
liaison slack import --export-dir <path> --user-map <path.json> [--org <slug>] [--channels a,b] [--skip-channels a,b] [--files-cache <dir>] [--dry-run] [--skip-files] [--limit <n>]
liaison search reindex
liaison export --full --output <path>
liaison org export <org slug or id> [--wait] [--timeout <seconds>]
liaison org caps <org slug or id> [--seats <n>] [--mailboxes <n>] [--storage-gb <n>] [--jobs-per-hour <n>] [--custom-apps <n>] [--audit-days <n>] [--app-runs-per-day <n>] [--app-bridge-calls-per-day <n>] [--app-cpu-ms-per-day <n>] [--unset <cap>]
liaison org delete <org slug or id> [--dry-run] [--yes <slug>] [--export-to <path>] [--no-legal-archive] [--abort]
liaison mailbox verify-attachment --file-id <kernel.files id>
liaison mailbox purge --user <uuid> --org <uuid> [--execute --confirm <same user uuid>]
liaison files purge-deleted-message-attachments [--org <uuid>] [--dry-run]
liaison seed --tier demo|lively|load|standard [--admin <email>] [--now <instant>] [--only agent-app] [--variant reserved|visitor] [--slug <slug>] [--name <org name>] [--locale <locale>] [--reset|--no-reset] [--passwords <password>|--passwords-env <VAR>] [--replace] [--warehouse] [--no-commerce] [--people <file>] [--orgs <n>] [--prefix <prefix>] [--shape demo] [--volume] [--threads <n>] [--contacts <n>] [--tickets <n>] [--projects <n>] [--no-reindex] [--ttl-hours <hours>] [--concurrency <n>]
liaison keys rotate --family encryption|byok --from-env <VAR> --to-env <VAR> [--execute] [--skip-undecryptable]
liaison erase-user <userId>
```

- **`config apply`**: non-interactive, idempotent "ensure" over the whole
  config file (details below). Never prompts. Connections that need a browser
  consent are reported as `pending`, not as errors.
- **`config verify`**: read only. For each connector app in the config (or
  only `--app <name>`), runs the app's own `provisioning.verify` handler: one
  cheap authenticated call through the app's connection, the credential STORED
  for the org (the encrypted row the connector really reads, not the
  environment) added by the server, never read by the CLI. Prints a JSON
  report (app, connection, `PASS` / `FAIL` / `SKIPPED`, the remote identity,
  never the secret) and exits `1` when any connector fails, so it can gate a
  deploy. Apps that declare no `verify` handler report `SKIPPED` (GitLab
  declares one). The `api-connector` app's own check probes each
  connection with a read operation that takes no required params and is not
  `customer.lookup` (an unfiltered lookup may return every customer; skipped
  when there is none). Like `api-connector test`, it calls the API from the
  CLI process: a loopback or private host needs
  `LIAISON_ALLOW_PRIVATE_API_CONNECTOR_HOSTS=true` in the CLI's environment.
- **`api-connector validate`**: checks an adapter document (JSON or YAML)
  offline against the adapter schema and the role rules. It reads no
  environment (no secrets, database or Redis), so it runs from a bare
  checkout. Prints the adapter's operations, or the issues with their exact
  path, and exits `1` when invalid (`2` for an unreadable file).
- **`api-connector test`**: runs one page of a READ operation of a stored
  connection and prints `{ok, status, items, truncated, ms}` (the operation's
  fields only), or `{ok: false, code, message}` with exit `1` on a connector
  error. `--org <slug>` picks the org when there are several; `--app <name>` picks the app when two apps hold a connection of that slug. A write operation is refused before any request (`write_not_testable`,
  exit `1`): writes only ever run through the approval-gated agent tool.
  `--param name=value` repeats; values are typed by the operation's params
  schema (numbers, booleans, comma-separated arrays).
- **`connect <app>/<connection>`**: the one interactive command, for OAuth
  connections (`mail/gmail`, `tickets/gmail`, `social/google`, `social/meta`,
  `shopify/shop`). It saves the per-org Google OAuth client from `--config` when
  present, prints an authorize URL to stderr, and waits (up to 5 minutes) for a
  new connection to land. Before the URL it prints the same guide as
  `liaison guide` for the Gmail address being connected: `--email`, or the
  config's only Gmail entry (with several, it asks for `--email` and exits `2`)
  (the Trusted steps for a
  Google Workspace address, or the Google Cloud steps when there is no client;
  the Dev Dashboard steps for `shopify/shop` without a client; for any other
  connection, the steps its client card shows, with the redirect URI and
  scopes). A credentials connection (GitLab, Boxtal, Pennylane, ...) has no
  browser sign-in: `connect` prints its steps and exits `2`, and its values go
  in the config's `apps[].connection.credentials`. `config apply` stores such a
  connection under `apps[].connection.identifier` when the config names one,
  else under the field the manifest names (Google Ads settings: the customer
  id), so a config that names its identifier keeps updating the same account.
  With neither, it uses the key the settings form uses: an `email` or
  `identifier` credential, else the org (the person, for `ownerType: user`). A
  connection that holds several accounts by slug always needs `identifier`. It refuses
  (exit `2`) a personal Gmail address while the instance's Google client is not
  verified for the restricted scopes, and points to `liaison guide imap`.
  - `mail/gmail` connects a Mail app mailbox and nothing else.
  - `tickets/gmail` connects a ticket inbox. The server creates the inbox for
    the authorized address; the command then applies the matching
    `tickets.inboxes` entry's `name`, `fromDisplayName`, `defaultTeam`,
    `notifyNewTicket` and `default`. If the inbox has not appeared yet, re-run `config apply`.
- **`connect <app>/<connection> --token-env <VAR>`**: connects an OAuth
  connection without a browser, from an access token the provider gave you
  directly. For example, a Shopify custom app made in the store's admin shows
  its Admin API access token once. Put the token in an environment variable
  and name the variable: the command reads the token from there, never from
  the command line, and never prints it. The token is stored as a finished
  OAuth sign-in stores one: encrypted, as the organization's connection,
  replacing an earlier connection of the same account, and the app is told
  the connection exists (Shopify then registers its webhooks).
  - `--account <id>`: the account the token is for. Required when the
    connection is identified by a value: the store domain for `shopify/shop`
    (`acme` or `acme.myshopify.com`).
  - `--client-secret-env <VAR>`: the variable holding the app's client
    secret. Shopify signs its webhooks with it; it is saved encrypted where the
    app checks them. Without it, the secret saved before (if any) stays.
  - `--scopes <a,b>`: the scopes the token holds, recorded like the scopes an
    OAuth sign-in grants.
  - `--org <slug|id>`: the organization, when the server has several.

  A credentials connection is refused (exit `2`): its values go in the
  config. Nothing refreshes such a token; connect again with a new one when it
  changes.

  ```sh
  export SHOP_TOKEN=...        # the Admin API access token
  export SHOP_SECRET=...       # the app's client secret
  liaison connect shopify/shop --token-env SHOP_TOKEN --account acme \
    --client-secret-env SHOP_SECRET --org acme
  ```
- **`guide <google|shopify|imap>`**: read only. Prints the setup steps the
  agent gives for this server and workspace, with the values computed here
  (redirect URIs, scopes, client IDs): `google --email <addr>` classifies the
  address and prints its path (`consent`, `trusted`, `consumer_imap`,
  `own_client`, `imap` or `ask`, see `docs/connecting-apps.md` §2); `shopify`
  prints the Shopify Dev Dashboard steps; `imap --email <addr>` the provider's
  servers and app-password steps; a step with a link (Gmail's 2-Step
  Verification and app-password pages) prints it as `label: url`. `--json` prints the structured guide,
  `--locale fr` the French copy. With Google Drive on, `google --email` also
  prints the Drive mode (`driveMode`: `full`, or `picked` for a personal
  account on the server's unverified client). The CLI cannot run Google's
  file picker: in picked mode it prints the link to the Drive page in
  Settings (`drivePicker.url`), where **Choose files** opens it, and says when
  the server lacks `GOOGLE_PICKER_API_KEY` / `GOOGLE_CLOUD_PROJECT_NUMBER` (an
  organization may set the google-drive app's config `pickerApiKey` / `pickerAppId` instead).
  `server` prints what the person who runs the server sets up (address and
  https, the mail sender and its SPF, DKIM and DMARC records, model keys,
  backups, Sign in with Google, the server's OAuth clients, the Google Picker,
  browser and phone push, file storage, web search), each with its state and
  numbered steps marked `HUMAN` (a console or a browser) or `AGENT` (a command
  or a `deploy/.env` edit). `<app>/<connection>` (for example
  `social/facebook`, `gitlab/gitlab`) prints that connection's steps, the
  redirect URI to register, the scopes, the webhook URLs this server receives,
  and how the values reach Liaison; a Google, Shopify or IMAP connection prints
  that guide instead. The same steps for every connection are in the
  [setup reference](reference/setup.md).
- **`setup state`**: read only. What is set up and what is left, read like the
  in-product agent's checklist: the workspace items (model key, apps, mail,
  team, knowledge, and the optional import, roles and API connector), every
  connection of the apps that are on (connected or not, with the `liaison
  guide` command for its steps), and the server items. It ends with a `Left:`
  list: the required checklist and server items, and the open steps of the
  features the person chose ([`setup.features`](#setupfeatures); until they
  answer, the basics: email and the support inbox). A step with alternatives
  (Gmail or an IMAP mailbox, the Instagram login or Instagram with Unified
  login) is done once one of them is connected. A feature partly done (Facebook
  connected, Instagram not yet) names what is connected and what is left. Every
  other feature that works here follows as a menu with its time, to offer, not
  to owe. With nothing left it says `Nothing left.` `--json` prints it as JSON.
- **`agent ask`**: ask an agent one question as the member named by `--as`
  (required; default agent: that member's personal agent) and print JSON with
  the answer, the model, the tools the agent called, the time it took, and
  `error` when the turn failed (a missing or out-of-credit AI key shows up
  here). The turn runs in the server through its HTTP API on
  `127.0.0.1:$PORT`, under the member's permissions. The CLI uses a bare access
  token that expires with the command and opens no session, so the member's
  own sessions are never evicted, and it writes a `cli_agent_ask` audit row
  naming the operator (`LIAISON_CLI_OPERATOR`, else the OS user). When the
  agent's turn opens an approval, the answer is still the agent's own reply:
  the approval is listed under `pendingApprovals` (handle and tool) and printed
  as `Pending approval: request-N (<tool>)` on STDERR. Exit 0 on an
  answer, 1 on a failure or timeout. It is the smoke test at the end of a
  setup. By default the question goes to the member's one conversation with
  the agent, so a second ask sees the first one's answer; `--new-conversation`
  asks in a fresh conversation instead (titled `liaison agent ask <time>`, the
  agent added and mentioned), which is what a repeated smoke test needs.
  `--thread <id>` follows up in the conversation an earlier ask returned as
  `threadId`, mentioning the agent, so a walk can answer the agent turn by turn.
- **`tour start`**: start a guided tour for the member named by `--user` and
  wait while they play it. It resets the member's progress on that tour to the
  first step and tells their open tabs (through the running server's outbox),
  always prints the link that opens the tour (`<BASE_URL>/?tour=<tourId>`),
  notes when a tab or the desktop app is open, then prints one
  `beat k/n <title>` line per step reached (titles in the member's language).
  Exit 0 when completed (`completed, skipped k`), 3 when abandoned, 4 after
  `--timeout` seconds (default 1800), 2 for an unknown tour or member, or a
  tour the org cannot play (its app is not installed or the member lacks a
  required scope).
- **`tour list`**: the tours the org can play, one per line: id, number of
  steps, title.
- **`tickets import`**: bulk ticket import from canonical NDJSON (transform your
  export first), idempotent by `externalRef`. An attachment failure fails its
  record unless `--lenient-attachments`.
- **`tickets inbox`**: list inboxes, create API inboxes (receiving buckets for a
  web form or another system, with `--mint-key` for an ingest key), update an
  inbox's email identity (`--reply-via`, `--from-name`, `--reply-to`,
  `--signature-html`, `--signature-text`, `--ack-enabled`, `--ack-body`,
  `--sla-promise`, `--attention-cutoff`), switch `--notify-new-ticket` on or
  off, or move a ticket. Mailbox inboxes are
  not created here: they come from `tickets.inboxes` or `connect tickets/gmail`.
- **`tickets backfill-attachments`**: re-fetch Gmail attachments missing from
  inbound ticket messages of the last `--days` (default 90).
- **`projects import`**: bulk task import from canonical NDJSON, idempotent by
  `externalRef`.
- **`invoicing import`**: historical invoicing documents with their original
  numbers and PDFs, idempotent by source filename. Invoices are imported before
  credit notes, so a credit note links to its original invoice.
- **`slack import`**: a Slack export into threads (one per channel), with
  replies, reactions and files. Each selected channel's history goes into its
  Liaison channel even when that channel already exists (an earlier import or
  tool made it); each such write is recorded in the audit log.
- **`search reindex`**: full search reindex of every org.
- **`export --full`**: full instance export (database, files, search) to a
  tar.gz; needs a DDL-privileged database connection.
- **`org export`**: one organization's whole-org archive (every record and
  file, secrets left out), the same one an admin starts in **Settings ›
  Organization › Export organization**. The server builds it into
  `orgs/<org id>/exports/<export id>-<run id>.zip` in object storage, kept 7 days. The
  command prints the export id; with `--wait` it waits and prints the object
  key and size. Refused while another export of the org runs. See
  [Export a whole organization](admin/backups.md#export-a-whole-organization).
- **`org delete`**: deletes an organization and everything it owns, after
  its gates: not the instance's own organization, no export running, a
  downloaded export under 24 hours old (or `--export-to <path>`), and a legal
  archive recipient (or `--no-legal-archive`). The server keeps an encrypted
  archive of its legal records. Irreversible; `--dry-run` changes nothing,
  `--abort` cancels before its data is touched, and running it again resumes
  a stopped deletion. See
  [Delete an organization](admin/backups.md#delete-an-organization).
- **`org caps`**: show or set an organization's limits. See
  [Limit an organization](#limit-an-organization).
- **`mailbox verify-attachment`**: check that an encrypted mailbox attachment
  is really sealed in object storage. Read only.
- **`mailbox purge`**: irreversible purge of one member's personal mailbox
  plaintext. A dry run unless `--execute --confirm <same user uuid>`.
- **`files purge-deleted-message-attachments`**: delete the attachments of
  messages that were deleted before deleting a message took its files along
  (rows now, objects through the server's object-deletion job). Every org, or
  only `--org`; idempotent; `--dry-run` only counts.
- **`seed --tier demo`**: fills an org with the demo world: the fictional
  company Resonant Audio Labs, its seven people and their agents, tickets,
  mail, knowledge, projects, invoices, shipments and routines. `--slug` names
  the org; a new slug creates it as a demo org, and an existing org that is not
  a demo org is refused. With no `--variant` it seeds the `reserved` review org
  and clears its seeded content first (`--no-reset` keeps what is there);
  `--variant visitor` seeds an org with no owner. `--passwords` gives the
  seeded people a password so a tester can sign in as them (refused on a public
  demo instance; see `LIAISON_PRIVATE_DEMO_BOX`). Exit `0` when every layer landed, `1` when one failed. A seed that
  stopped half way (the process was killed) is picked up by the next run.
- **`seed --tier lively --slug <slug>`**: the same company with ten people
  and two weeks of work up to now: team channels and each person's chats with
  their agent, about sixty tickets that moved, routine runs, sub agent runs,
  notifications (each person's newest few still unread) and the tickets'
  change history. For a private server or a trial: `--passwords` (or
  `--passwords-env <VAR>`, which reads it from that environment variable)
  lets you sign in as any of the ten. Run again, it adds nothing; `--replace`
  deletes the earlier org under the slug first so the two weeks end now
  (refused on a public demo instance, and for an org that is not a demo org). The
  analytics warehouse is seeded only with `--warehouse`.
- **Seeding from a source checkout.** `demo`, `lively` and `load` install the
  catalog apps. The runtime image has their catalog built in; outside it, an
  unset `LIAISON_APP_CATALOG_DIR` means the checkout's own `app-catalog/` (build
  it with `bun run scripts/build-app-catalog.ts`) and an unset
  `LIAISON_APPS_DIR` means `.liaison-apps/apps` in the checkout. With no
  catalog there, a seed that writes the shop and invoices (every one but
  `lively --no-commerce`) stops before writing anything and names the variable
  to set (exit `2`).
- **`seed --tier lively --admin <email>`**: the same two weeks in an org that
  exists already, the org of that admin, instead of one under `--slug`. The
  org is not made a demo org and keeps its name, language, time zone and
  credits; `--replace` is refused. `--people <file>` puts your own people in
  the world's seats: a JSON array of `{ "seat": "amina", "name": "...",
  "email": "..." }` (optional `jobTitle`, `bio`), where `seat` is one of the
  ten people of the world. Everything the world writes for that seat is
  written for them. Someone already in the org at that address keeps their
  password and roles, and is given the seat's role as well. `--no-commerce`
  leaves out the shop, invoices, carrier and books, for an org without the
  commerce apps installed.
- **`seed --tier load --orgs <n>`**: busy workspaces for a load run, named
  `<prefix><i>` (`--prefix`, default `load-`), each holding the demo company.
  Each is a demo workspace marked synthetic that expires after `--ttl-hours`
  (default 6), so the demo reaper deletes it; when `LOAD_HARNESS_KEY` is set
  it is also a load workspace (scripted agent replies, mail counted instead of
  sent). `--volume` adds 1,100 threads, 5,000 contacts, 3,000 tickets and 1,000
  projects to each (`--threads`, `--contacts`, `--tickets`, `--projects` change
  a count), checks that the workspace's admin reads every one of them back and
  re-indexes its search (`--no-reindex` skips that). `--concurrency` seeds
  several at once. Run again, it adds nothing and keeps each expiry. It prints
  one `[load-seed] result <json>` line with each workspace's slug, id, admin
  address and expiry.
- **`seed --tier standard --admin <email>`**: the test world, for a development
  or test server: four teammates (Amina Cherif, Lucas Pereira, Tobias Braun,
  Margot Dufour at `<first name>@resonantaudiolabs.example`, password
  `QaPass1!`), team channels and chats, contacts, knowledge, agent skills and
  routines, tickets, approvals, saved views and mail, in the org of that admin.
  An org that already holds the teammates is refused, so it runs once per
  org. `--now`
  sets the instant every timestamp is counted from (default: now). `--only
  agent-app` puts the skills, routines, agent chats and past runs back in an
  org it already seeded. It prints the seeded ids as one JSON line.
- **`keys rotate`**: re-encrypts every stored secret from the key in one
  environment variable to the key in another (`--family encryption` for
  `ENCRYPTION_KEY`, `byok` for `BYOK_ENCRYPTION_KEY`), in one transaction, and
  prints a per-column report. A dry run unless `--execute`; refuses while any
  value opens with neither key unless `--skip-undecryptable`; safe to run
  again. Run it with the app stopped: `docs/runbooks/key-rotation.md`.
- **`erase-user`**: GDPR erasure of one user.
- **`app status [name]`**: read only. Each installed app (or one) with its
  state as the App store shows it: `running`, `failed_to_load` (the workspaces
  where it did not load, and why) or `upgrade_failed` (the version Liaison went
  back from, and why), the previous version a rollback returns to, and
  `noRollback` when the running version is a security release.
- **`app rollback <name>`**: makes the app's previous version the active one
  again for the whole server, with the same checks as an upgrade. Refused when
  there is no previous version or the running version is a security release.
  The running server follows without a restart. Exits `1` when refused.
- **`app run-job <app> <job>`**: runs one job of an installed app for one
  organization now, the way the app's own on-demand jobs run: it is queued
  with the given `--params-json` (a JSON object; it may not set `orgId` or a
  key starting with `_`) and the server runs it. One attempt, no retry. An
  unknown job, or an app that is off for the organization, is refused and
  nothing is queued. It prints `{ "jobId": ... }`. With `--wait` it waits for
  the job to finish (at most `--timeout` seconds, 600 by default) and prints
  `{ "jobId", "ok", "ms", "error" }`, `ms` being the run itself; it exits `1`
  when the job failed or did not finish in time (the job then stays queued).

  ```sh
  liaison app run-job shopify backfill-customers --org acme --wait
  ```
- **`app verify <file|dir>`**: checks an app package (`.liaisonapp`), an
  `app.manifest.json` or a signed artifact directory offline, like
  `api-connector validate`: the package's files, the manifest, the host API
  range and the icon. When `statement.json` and `statement.sig` sit beside the
  package (a directory must hold exactly one package), it also checks the
  [signed statement](app-package-format.md#signed-first-party-artifacts)
  against the app-signing keys built into this release. The report's
  `signature.status` is `verified` (with the `keyId` and which of name,
  version, ui.js, manifest and package match), `refused` (with the `reason`) or
  `unsigned`. A refused statement exits `1`.

Every machine-readable report goes to **stdout**; progress and errors go to
**stderr**. Server log lines are off below `warn` in a CLI run, whatever the
server's `LOG_LEVEL`; set `LIAISON_CLI_LOG_LEVEL` (for example `info`) to see
them, on stderr. Exit codes: `0` success (including a no-op re-run and `pending`
connections), `2` usage, config validation or environment error (a missing or
invalid `JWT_SECRET`, `ENCRYPTION_KEY`, ...), `1` runtime failure (and, for
`api-connector validate`, adapter issues).

The CLI needs the live server for anything event driven (a ticket inbox is
created by the server when its connection lands). Required container env:
`DATABASE_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`, `BYOK_ENCRYPTION_KEY` (all set on
the `app` service of `deploy/docker-compose.yml`).

## Headless first boot

On a brand new instance, `config apply` with `org` and `admin` does what the
browser's first **Register** does: it creates the org with its default roles
and `@base` agent, and the owner with the admin role and a personal agent. No
browser step is needed. Leave `admin.password` out and the owner signs in
passwordless, with an emailed code. Without SMTP nobody receives that email;
only with `LIAISON_CONSOLE_EMAIL_BODIES=true` (the quickstart's local trial) is
its body, code included, written to the app's log
(`docker compose logs app | grep 'sign-in code'`).
This is not a way into a live instance: the CLI runs inside the app container
with the database credentials, so only whoever operates the instance can run
it.

## Minimal config for a new company

```yaml
org:
  slug: acme            # stable idempotency key; determines LIAISON_ORG_ID
  name: "Acme"

admin:
  email: owner@acme.example
  name: "Owner Name"     # no password: sign-in by emailed code

users:
  - { email: alice@acme.example, name: "Alice", role: member }

byok:
  openrouter: { apiKey: "${OPENROUTER_API_KEY}" }

tickets:
  inboxes:
    - address: support@acme.example
      provider: gmail
      # The Gmail client, never the sign-in client (GOOGLE_OAUTH_*), which needs another redirect URI.
      google: { clientId: "${GMAIL_CLIENT_ID}", clientSecret: "${GMAIL_CLIENT_SECRET}" }
      name: "Support"
      fromDisplayName: "Acme Support"
      default: true

mail:
  mailboxes:
    - address: team@acme.example
      provider: gmail
```

Then:

```sh
docker compose exec -T app liaison config apply --config /setup/liaison-config.yaml --format env
docker compose exec app liaison connect tickets/gmail --config /setup/liaison-config.yaml
docker compose exec app liaison connect mail/gmail --config /setup/liaison-config.yaml
```

Run them from `deploy/` (or add `-f deploy/docker-compose.yml`). The stack
mounts `deploy/setup/` read-only at `/setup` in the app container, so the
config goes in `deploy/setup/liaison-config.yaml`. The CLI runs as uid 1000
there: a mode 600 config must be owned by that uid
(`chown 1000:1000 deploy/setup/liaison-config.yaml`), or the CLI cannot read
it. With every secret written as a `${VAR}` reference the file holds none, and
each key reaches the CLI as `-e NAME` on `docker compose exec`. `config apply`
and `config verify` warn about a group- or world-readable config only when it
holds a secret literally (a credential, key, token, secret or password value
that is not a `${VAR}` reference, or a non-empty `${VAR:-default}`); the
warning names those values' paths. A file of references only gets no warning.

The annotated full example is
[deploy/liaison-config.example.yaml](../deploy/liaison-config.example.yaml).

## Config file

- Only `org` is required. Every other section is optional and applied only if
  present. The top level is strict: an unknown section name is exit 2.
- `${VAR}` and `${VAR:-default}` interpolate from the environment, so secrets
  live in env or in this mode 0600 file, never on the command line. An unset
  `${VAR}` without a default is exit 2. Quote a reference inside a YAML flow
  map (`{ apiKey: "${KEY}" }`), where a bare `${` does not parse.
- Sections run in this order: `org`, `admin`, `roles`, `email`, `byok`,
  `apiKeys`, `users`, `mail`, `tickets`, `apps`, `knowledge`,
  `agents`, `invoicing`.
  `users[].role` names are checked before anything is written. A role is
  valid when the org has it or the same apply creates it: a role declared under
  `roles`, an app role such as `Full Member` or `tickets.support` on a new org's
  first apply, or a role of an app enabled under `apps` (for a catalog app, read
  from its package before the install). A member whose role comes from a
  catalog app that `apps` installs is invited once `apps` has run. An unknown
  role is refused with the list of valid ones, before anything is written.
- `--dry-run` plans without writing.

| Section | What it ensures |
|---|---|
| `org` | The org (`slug`, `name`, optional `timezone`, `defaultLocale`, `credits`, `requireAdminSecondFactor`). `requireAdminSecondFactor: true` makes two-step verification mandatory for administrators: one without it signs in to a screen that only sets it up. Absent leaves the org's setting unchanged. |
| `admin` | The owner account, with a personal agent. `password` is optional (passwordless sign-in). An existing admin's password is never reset. Without this section, the run acts as the org's earliest active admin (for example, as the person who connected an API connector's credentials). With no active admin, any step that would store a connection (an `apps` connection or account, an IMAP tickets inbox or shared mailbox) is refused before writing, with a message naming the step and saying to add an `admin` section. A catalog app install fails the same way (exit `2`). An org-owned connection that already exists unchanged needs no admin. |
| `roles` | Custom roles: a name plus the exact scope set, reconciled on every apply. |
| `users` | Members by email with a role name; `mode: invite` (default) or `mode: create` with `password`. A re-run that gives an existing `mode: create` user a role they do not hold yet grants it and reports the user under `changed` (the plan says `exists: grant role <name>`); an identical re-run reports them `unchanged`, and so does an invite to a user who already holds the role or already has an invite waiting. The password of an existing user is never changed. |
| `byok` | Per-org AI provider keys (`openrouter`, `anthropic`, `openai`, `google`, `mistral`), validated live unless `validate: false` or `--no-validate-byok`. One `openrouter` key is the recommended single key: when the org has no other usable model key, the apply adds OpenRouter's default model (DeepSeek V4.1 Flash 1017) and makes it Auto, so the org can chat without a dashboard step (reported as `byok.openRouterAuto`). |
| `apiKeys` | Org API keys by `label`: supply `key` for an idempotent upsert, or omit it to generate one (printed once). |
| `email` | The org's transactional `from` and `replyTo`. |
| `mail.mailboxes` | Mail app mailboxes (below). |
| `tickets.inboxes` | Ticket inboxes (below). |
| `tickets.approveRepliesFromHome` | `true` lets a pending customer reply be approved, edited or rejected from its Home card; `false` (the default) keeps it decidable only from the ticket. Omit it to leave the stored value unchanged. |
| `apps` | Install (catalog apps), enable, and connect: credentials connections headlessly, OAuth connections reported `pending`. An app's own setup goes in its `provision` block, more accounts of one connection in `connections` (the API connector's connections, below). |
| `knowledge` | Knowledge collections (by name), documents from one `contentFile` or a whole `dir` (relative to the config file), written inline in `content`, or read from an uploaded file (`contentFileId`), sources. |
| `agents` | Role agents (support, sales...) by `handle`: display name, purpose, system prompt, extra scopes. |
| `invoicing` | Issuer profiles, tax regimes, HS codes (below). |

### `mail.mailboxes`

```yaml
mail:
  mailboxes:
    - address: team@acme.example        # shared (org-owned) Gmail mailbox
      provider: gmail
      google: { clientId: ..., clientSecret: ... }   # optional per-org Google client
    - address: alice@acme.example       # personal IMAP mailbox of a member
      provider: imap
      owner: alice@acme.example         # omit for a shared mailbox
      imap: { email: alice@acme.example, imapHost: imap.acme.example, imapPort: 993,
              smtpHost: smtp.acme.example, smtpPort: 587, username: alice@acme.example,
              password: "${ALICE_IMAP_PASSWORD}" }
```

- **Gmail**: saves the Google client when given and reports `pending` for
  `liaison connect mail/gmail`. Only shared Gmail mailboxes can be provisioned:
  the Google consent of a personal Gmail mailbox must be its owner's. Run
  `liaison connect mail/gmail --for <their email>` (see "Connect a member's own
  account" below): it prints the one-time link they open.
- **IMAP**: creates the `mail/imap` connection, shared or owned by `owner` (who
  must already be a member). The server's Mail app then creates the mailbox.
- Who can open a shared mailbox is the Mail app's inbox access setting, managed
  in Settings; this file does not set it.

### `tickets.inboxes`

```yaml
tickets:
  inboxes:
    - address: support@acme.example
      provider: gmail                   # gmail | imap
      google: { clientId: ..., clientSecret: ... }   # optional per-org Google client
      name: "Support"                   # optional; inbox display name
      fromDisplayName: "Acme Support"   # optional; sender name on replies
      defaultTeam: "Tier 1"             # optional; team every inbound ticket gets
      notifyNewTicket: true             # optional; alert inbox admins on each new ticket
      default: true                     # optional; where tickets without an inbox land
    - address: sales-desk@acme.example
      provider: imap
      imap: { email: ..., imapHost: ..., imapPort: 993, smtpHost: ..., smtpPort: 587,
              username: ..., password: "${DESK_IMAP_PASSWORD}" }
```

- **Gmail**: saves the Google client when given. If the inbox already exists on
  a Tickets connection, its settings converge; otherwise it is `pending` for
  `liaison connect tickets/gmail`. An inbox still bound to a Mail app connection
  (the old `mailboxes` shape) is reported `pending` with the instruction to
  reconnect it through `tickets/gmail`, which rebinds the same inbox.
- **IMAP**: creates the org-owned `tickets/imap` connection, waits up to 30
  seconds for the server to create the inbox, then applies the settings. If the
  server has not created it yet, the inbox is `pending` and a re-run applies
  them.
- Settings converge on every apply. `default: false` never clears the flag: to
  move the default, mark another inbox `default: true`. At most one entry may be
  the default.
- At most one personal IMAP entry per owner in a section: a second IMAP
  connection for the same person in the same app replaces the first. An org holds
  several shared IMAP mailboxes, one per address.
- A ticket source such as an API key needs a default inbox, otherwise ticket
  creation returns `422 inbox_required`. For a pure receiving bucket without a
  mailbox, use `liaison tickets inbox create --kind api`.

Migrating an old `mailboxes` entry that fed tickets: move it under
`tickets.inboxes`, lift `inbox.name`, `inbox.fromDisplayName`,
`inbox.defaultTeam` and `inbox.default` to direct fields, then run
`liaison connect tickets/gmail` once (Gmail) or `config apply` (IMAP).

### `tickets.approveRepliesFromHome`

```yaml
tickets:
  approveRepliesFromHome: true
```

By default a pending ticket reply shows on Home with only an "Open ticket"
action, so the reviewer reads the conversation before the reply goes out. Set
to `true`, its Home card offers Approve, Edit and Reject like any other
approval (the decision runs the same server path as from the ticket). It writes
`settings.tickets.approveRepliesFromHome`, the same key as the switch under
Settings > Tickets.

### `apps`

`apps[]` enables apps and stores their connections. Through the agent's
`config_apps`, an app that is already on (registered and active) is not
enabled again: the plan leaves it out, and the result lists for each app what
changed (`apps[].changed`). First-party catalog apps
(baked into the image, for example `pennylane`, `boxtal`, `invoicing`,
`shopify`, `social`) are installed on `enable: true` and registered in the same
run; in-tree apps are enabled only. A `credentials` connection is created
headlessly from `connection.credentials`. A re-run compares every declared
field with the stored connection, its settings (a base URL, a host, an
account id) and its secrets alike: all equal is a no-op reported `unchanged`
(`apps.<app>.connection`); any drift replaces the connection and is reported
`changed` once per field that moved (`apps.<app>.connection.baseUrl`). The
app's report entry lists the moved fields under `connectionChanges`, and the
log line names them: a setting the manifest does not mark `password` shows its
stored and new values (`baseUrl "https://old.example.com" ->
"https://new.example.com"`), a secret shows its name only (`apiKey (secret)`),
never a value. `--dry-run` prints the same comparison as a plan line for an
org that already exists, and writes nothing. So a renamed host is corrected by
editing the config and applying it again.

Before a new or changed key is stored, `config apply` runs the connection's own
check of it, as the settings page does (Stripe, for example, reads its account
with the new key). A refused key stops the run (exit `2`) with the reason, and
nothing is stored: the connection keeps the key it had.

After the connection is applied, changed or not, `config apply` runs the app's
`config verify` check (its `provisioning.verify` handler) against the stored
connection when the app has one. The result is the entry's `health`
(`PASS`, `FAIL` or `SKIPPED` for an app without one). A failure does not
stop the run or change its exit code: it is reported as a `pending` item
(`kind: "credentials"`, with the error) so a dead connection that the config
still matches is visible. An `oauth2` connection stores
`connection.oauthClient` when given and is reported `pending` for
`liaison connect <app>/<connection>`. A credentials connection whose values are
all empty `${VAR:-}` references is reported `pending` too, so a config can list
every app before every secret exists.

Through the agent's `config_apps` tool, the same section installs catalog apps
only where the App store may (on a multi-tenant instance, only the instance
operator's organization installs or upgrades), and refuses a name that is
neither installed nor in the catalog instead of enabling nothing.

A catalog app is installed when the server does not have it yet, and upgraded
when this release's catalog carries a newer version. When the server already
runs a newer version than this release's catalog (a newer release installed it,
and this one was rolled back to), nothing is installed: the app is enabled at
the version the server runs, and the server logs `app_version_ahead`.

The `mail` entry also takes `providers`, the per-org mail provider switches of
Settings > Mail > Providers (today only `gmail`):

```yaml
apps:
  - name: mail
    enable: true
    providers:
      gmail:
        enabled: true
```

The switch is applied after the app is enabled, is reported `changed` or
`unchanged` (`apps.mail.providers.gmail.enabled`), and touches nothing else in
the mail app's settings. Omitting `providers`, or a provider in it, leaves the
current switch as it is. Enabling Gmail before Google credentials exist (Mail
Setup in Settings > Mail, a `google` client on a gmail mailbox or ticket inbox,
or the Google client the server provides for every workspace, `GMAIL_OAUTH_CLIENT_ID` / `GMAIL_OAUTH_CLIENT_SECRET`) still
records the switch; the provider is reported `available: false` with a
`pending` item until they do. `providers` is rejected on any other app, on an
`enable: false` entry, and for an unknown provider id.

Any app entry also takes `config`, a map of the app's non-secret config keys
(the store the app reads with `ctx.config.get`). Only keys the app's manifest
declares in `configKeys` are accepted, each checked against its declared type
(`json`, `string`, or `url`, which must be http or https); `null` clears a key.
For example, the monitoring app's source profiles and its detailed-monitoring
link:

```yaml
apps:
  - name: monitoring
    enable: true
    config:
      monitoringUrl: https://status.acme.example/dashboards
      monitoringSources:
        - { source: uptime, label: "Uptime probes", rank: 1 }
        - { source: errors, label: "Error tracker", rank: 2 }
```

Each key is reported `changed` or `unchanged` (`apps.monitoring.config.monitoringUrl`);
an equal stored value is not rewritten. A key the manifest does not declare, a
value of the wrong type, and any connection secret key (a webhook secret or an
OAuth client secret, which only the kernel writes) are a usage error (exit `2`)
before anything is written. `config verify` compares every `config` key with
the stored value and reports `PASS` or `DRIFT` (key only, never the value); a
drift exits `1`. The same allowlist backs the admin route
`PUT /api/apps/<app>/config/<key>` (body `{ "value": ... }`, scope
`kernel:apps:admin`), and `GET /api/apps/<app>/config` lists the declared keys
with their values.

An app entry also takes `settings`, the org fields of the app's settings page
by path, written as the page writes them. For example, the Shopify app's
**Full order history** toggle:

```yaml
apps:
  - name: shopify
    enable: true
    settings:
      fullOrderHistory: true
```

Each field is reported `changed` or `unchanged`
(`apps.shopify.settings.fullOrderHistory`). A path the settings page does not
declare, a value of the wrong type, and a field kept in the app's config (set
it under `config`) or saved by the app's own tools are a usage error (exit `2`)
before anything is written. Through the agent's `config_apps` tool, the person
who approves needs the field's section admin scope as well.

The `database` app sets up who may run each catalog domain's curated reads
(see [Restrict reports by domain](database-connector.md#restrict-reports-by-domain))
through its `provision` block. Roles are named, people are given by email:

```yaml
apps:
  - name: database
    enable: true
    provision:
      domainAccess:
        revenue: { tier: confidential, roles: [finance] }
        customers: { tier: restricted, users: [ceo@acme.example] }
        returns: { tier: internal }
```

`domainAccess` replaces the stored map; without it the map stays as it is. An
unknown role or person fails the apply before anything is written. A file that
still puts `domainAccess` directly on the app entry is refused with where it
moved.

An app that declares `provisioning` in its manifest takes a `provision` block:
its own setup, in the shape the app's schema defines
([Set your app up from a config file](app-development.md#16-set-your-app-up-from-a-config-file)):

```yaml
apps:
  - name: my-app
    enable: true
    provision:
      folders: [Contracts, Invoices]
```

A block that does not match the app's schema is a usage error (exit `2`) before
anything is written. `config apply` runs the app's provisioning handler once the
app's connection is set up and reports each line it changed
(`apps.my-app.provision: <line>`), or `unchanged`. `config verify` runs the
handler without writing: a line it would change is `DRIFT`; then the app's own
check, when it has one, is `PASS` or `FAIL`.

### API connections (`apps[].provision` of `api-connector`)

The removed top-level `apiConnectors` section is refused (exit 2) with where it
moved: each connection's adapter goes in the `api-connector` app's
`provision.connectors`, its credentials in the app entry's `connections`.

```yaml
apps:
  - name: api-connector
    enable: true
    provision:
      connectors:
        - identifier: crm                              # slug: lowercase letters, digits, -
          adapter: { $file: adapters/crm.adapter.yaml }  # relative to this file (or an inline object)
        - identifier: erp
          adapter: { $file: adapters/erp.adapter.yaml }
    connections:
      - { name: api, identifier: crm, credentials: { apiKey: "${CRM_API_KEY}" } }
      - { name: api, identifier: erp, credentials: { clientId: "${ERP_CLIENT_ID}", clientSecret: "${ERP_CLIENT_SECRET}" } }
```

- `{ $file: <path> }` anywhere in a `provision` block is replaced by that
  file's text; the path may not leave the config file's directory. The agent's
  config tools take content inline only.
- The adapter is validated before anything is written: an invalid one is
  exit 2 with each issue's path. Only a changed adapter is written, and a
  change of its API address or auth deletes the stored credentials (the plan
  says so).
- `connections` (several accounts of one multiInstance connection, each by its
  `identifier`) are applied after the app's `provision`. For an API connection,
  `credentials` holds exactly the fields of the adapter's auth type: `apiKey`
  (apiKey), `token` (bearer), `username` + `password` (basic), `clientId` +
  `clientSecret` (oauth2ClientCredentials; the token URL is part of the
  adapter). Values all empty (`${VAR:-}`) report the account `pending`.
- Re-applying is idempotent: adapters and credentials are rewritten only when
  they differ from what is stored (compared decrypted, never printed).
- Demo orgs refuse credentials, like every connector.

### `knowledge`

```yaml
knowledge:
  collections:
    - name: Website
    - name: Manuals
  documents:
    - { title: "Refund policy", collection: Manuals, contentFile: ./kb/refunds.md }
    - dir: knowledge/website          # one document per file under it
      collection: Website
      include: ["**/*.md"]            # optional; default: md, markdown, mdx, txt, rst, adoc
      exclude: ["drafts/**"]          # optional
```

- Paths are relative to the config file and may not leave its directory.
- A document can also be written inline (`content`, at most 1 MB, stored as
  written) or read from a file already uploaded to the org
  (`contentFileId`), read with the applying person's own access.
- A `dir` entry reads every matching text file below it, except dot files,
  `node_modules` and symlinks that lead outside it; the folder itself must
  resolve inside the config file's directory, and a file is size-checked
  before it is read. Each file's title is its
  front matter `title`, else its first Markdown heading, else its file name;
  a `source` (or `url`) front matter value becomes a "Source:" line at the top
  of the document so agents can cite it. Empty files and files over 1,000,000
  characters are skipped and listed under `knowledge.skipped` in the report.
- Documents are idempotent by (collection, title): a re-run adds only new ones
  and never changes an existing document. When two files of one collection
  would share a title, each gets its path appended.
- Convert PDFs and office files to Markdown or text before loading them.

### `agents`

```yaml
agents:
  - handle: support                 # becomes @support; the idempotency key
    displayName: Support
    purpose: Answers customer questions from the knowledge base.
    systemPrompt: |
      Search the knowledge base first and cite the document you used.
    scopes: ["tickets:tickets:read"]   # optional, on top of the common agent base
    model: claude-sonnet-4-6         # optional: pin a model instead of auto mode
```

Role agents only (personal agents come with each member, `@base` with the
org). An existing role agent converges to the declared fields, and each
creation or change writes an audit row (`agent.created`, `agent.updated`). The
ceiling is the common agent base (tool search, threads, knowledge read and
create, memory, contacts, files, projects tasks) plus `scopes`; an
organization administration scope, or a scope that neither this build nor an
app installed on the instance declares, is refused, and a handle already used
by a personal or system agent is an error. A created agent gets the avatar
color the org's agents use least, so it looks different from the others; an
existing agent keeps the color it has. `model` must be in the model
catalog. Without it the agent uses auto mode: the cheapest auto-eligible model
among the providers the org has a key for. Each provider has one (Anthropic:
Claude Haiku; OpenAI: GPT nano; Google: Gemini Flash Lite; Mistral: Small), so
a single key of any of them is enough. With an OpenRouter key and no other
usable key, auto mode runs on OpenRouter's default model (DeepSeek V4.1 Flash 1017),
which the `byok` section makes Auto. An operator can turn a model's
`auto_eligible` flag off in the catalog; auto mode then skips it.

### `invoicing`

Runs after `apps`, so one apply can enable the `invoicing` app and configure it;
it fails with an actionable error when the app is not enabled.

- `issuerProfiles` key on `(org, legalName)`; a re-run updates only the fields
  you supply. `shopifyShop: auto` copies the shop domain from the org's active
  `shopify` connection (reported `pending` until `liaison connect shopify/shop`
  completes), an explicit string sets it, omitted or `null` leaves it alone.
  This mapping is what the order-paid auto invoice flow uses to pick the issuer.
- `logoPath` uploads a PNG or JPEG (at most 2 MB) resolved relative to the config
  file; absolute paths and `../` are rejected. `logoFileId` takes a PNG or JPEG
  already uploaded to the org instead (never both). A byte-identical re-run does not
  re-upload; a bad file is reported as `logoError` on that profile without
  failing the run.
- `taxRegimes` key on `(issuerCountry, treatment)`; `hsCodes` key on `code`.

### `limits`

The organization's caps, the same ones `liaison org caps` sets. A cap you name
is set, `null` makes it unlimited again, a cap you leave out is kept. Each cap
is a whole number of at least 1: 0 is refused (leave the cap out, or set `null`,
for unlimited). Only this CLI sets them: there is no agent tool for this section.

```yaml
limits:
  seats: 25          # active people
  mailboxes: 10      # connected mailboxes
  storageGb: 100     # stored files, in GB
  jobsPerHour: 5000  # background jobs per clock hour
  customApps: 5      # custom apps installed for the org
  auditDays: 365     # days of audit log kept
  appRunsPerDay: 20000         # app runs per UTC day
  appBridgeCallsPerDay: 200000 # calls apps on Workers make back, per UTC day
  appCpuMsPerDay: 3600000      # CPU ms of apps on Workers, per UTC day
```

### `liaisonTeam`

The two opt-ins to share with the Liaison team, for the whole server (see
[Share with the Liaison team](self-hosting/liaison-team.md)): `register` sends a
random server id, the version, the edition and the active user count;
`forwardBugReports` allows a bug report to go to the Liaison team when the
reporter ticks the box, and needs `register: true` (otherwise the section is
refused). Both default to off, and a named `false` is an answer too: it is
recorded, so the setup checklist stops asking. The section calls the same
service as **Settings > System**, so it is for the operator's org only: on a
shared server (demo or managed) another org's admin is refused. It is refused
too when `LIAISON_TEAM_ENDPOINT` is empty. The in-app setup agent records the
answer with `kernel__config_liaisonTeam` (gated).
The third switch, **Send bug reports only to the Liaison team**, is set in
**Settings > System** only; turning `forwardBugReports` or `register` off here
turns it off too.

```yaml
liaisonTeam:
  register: true
  forwardBugReports: false
```

### `setup.features`

The features the person chose to set up, as the onboarding asks before any
connector. `liaison setup state` and the agent's `setup_state` count only
these as left; the others are a menu. The list replaces the stored one; an
unknown id is refused with the ids that exist. The in-app agent records the
same answer with `kernel__config_setup` (gated).

```yaml
setup:
  features: [email, support, import]
```

Ids: `email`, `support`, `import`, `calendar`, `drive`, `shopify`, `social`
(Facebook Pages and Instagram), `youtube`, `google-ads`, `merchant`,
`meta-ads`, `gitlab`, `boxtal`, `pennylane`, `database`, `api-connector`,
`call-transcripts`, `monitoring-alerts`, `ci-status`.

### `roles`

A role is a name plus the exact scope set; missing scopes are granted and extra
ones revoked on every apply. Scopes are `app:resource:action` strings: granting
`<app>:*` includes an app, omitting its scopes withholds it, which hides the
app's tools and its icon for members holding only that role. The default roles
(`admin`, `member`, `viewer`) are untouched unless you redeclare them.

## Output and captured values

`--format json` (default) prints one JSON report on stdout with a section per
provisioner (`org`, `admin`, `users`, `byok`, `apiKeys`, `email`, `mail`,
`tickets`, `apps`, `knowledge`, `invoicing`), plus `pending`, `changed`,
`unchanged` and `env`. `--format env` prints only sourceable `KEY="VALUE"`
lines:

```sh
eval "$(docker compose exec -T app liaison config apply --config /setup/liaison-config.yaml --format env)"
echo "$LIAISON_ORG_ID" "$LIAISON_API_KEY"
```

A generated API key is printed once (it is stored hashed). A supplied key is
not echoed unless `--echo-supplied`.

## Changes made in the product (drift)

The config file stays the source of truth, but `config apply` never silently
overwrites a value someone changed in the product (a settings page, an agent)
since the last apply.

Each apply records, per org and per config path it wrote or found already in
place, a hash of the stored value (never the value), when, and who applied
it (`--applied-by <label>`, default `cli:<user>@<host>`). The next apply
compares, for each path:

| Server vs last apply | File vs server | Action |
|---|---|---|
| any | same | `unchanged` |
| no record yet, or same | different | `update` (`create` when the server has no value or the org is new) |
| different (changed in the product) | different | `conflict` |

A conflicting path is not written. Everything else in the file still applies,
the report lists the path under `conflicts` and in `drift` (file value, server
value, when and by whom it was last applied), and the command exits **3**.
Settle it one of three ways:

- `--prefer file` writes the file's value.
- `--prefer server` keeps the server's value and records it as applied, so the
  next apply sees an ordinary `update` if the file still differs.
- `liaison config pull` writes the server's values into the file (below), so
  you can commit them.

`--prefer file=<path>` and `--prefer server=<path>` settle just that path or
section; the flag repeats, and the most specific one wins. The first apply after
upgrading has no record yet: it checks nothing and behaves as before, then
records.

Tracked paths: `org.name`, `org.timezone`, `org.defaultLocale`,
`org.requireAdminSecondFactor`, `limits.<cap>`, `email.from`, `email.replyTo`,
`setup.features`, `roles.<name>`, `apps.<name>.enable`,
`apps.<name>.config.<key>`, `apps.<name>.settings.<path>`,
`agents.<handle>.<field>` (handle without `@`)
and `invoicing.issuerProfiles.<legalName>.<field>`. Credentials, keys, tokens
and passwords are never tracked or hashed; users, mail, tickets, knowledge,
BYOK, API keys and API connectors apply exactly as before.

`--dry-run` prints the plan: the report's `drift` gives each tracked path with
its action, and for a changed or conflicting path a short file, server and
last-applied summary (secret-like values masked). A dry run with a conflict
also exits 3, so a pipeline can stop on it.

### Apply part of a file

`--only <path>` (repeatable) applies and checks just that path or section, for
example `--only apps.mail.enable` or `--only roles`. The rest of the
file is ignored for writes and for conflict checks. The `org` block still names
the org but is not written unless `--only org` (or `--only org.timezone`, ...)
selects it.

### Pull server values into the file

```sh
liaison config pull --config /setup/liaison-config.yaml --out /setup/liaison-config.yaml
```

`config pull` reads the server's current value of every tracked path the file
sets and rewrites just those values, keeping the file's layout, its comments
and every `${VAR}` reference as written. It never writes a secret. Without
`--out` it prints the updated file on stdout; `--only` limits it to some paths.
It changes nothing on the server: a `config apply` of the pulled file reports
every pulled path unchanged.

Exit codes for `config apply`: 0 done, 1 runtime failure, 2 invalid config or
usage, 3 a conflicting path was left unwritten.

## Importing tickets

`liaison tickets import --file <ndjson>` reads one canonical record per line:

```json
{ "subject": "Order late", "externalRef": "freshdesk-12345", "contactEmail": "c@x.com",
  "contactName": "C", "priority": "normal", "status": "open", "createdAt": "2026-01-02T10:00:00Z",
  "messages": [ { "kind": "inbound", "fromEmail": "c@x.com", "textBody": "Hello",
                  "sentAt": "2026-01-02T10:00:00Z" } ] }
```

`tickets import`, `projects import`, `invoicing import` and `slack import`
write through the import framework: each run is recorded with every row it
created, so it appears under **Settings › Organization › Imports** and can be
undone there. `slack import` makes two runs, one for the channels and one for
their messages. External refs are stored as given.

Re-importing the same `externalRef` is a no-op. Message `sentAt` is kept, and
the ticket's creation time and SLA clock follow `createdAt` when given.

To import another tool's own export (a Freshdesk XML backup, a Jira site, any
file or API) without converting it yourself, ask the agent: it writes a
transform from a shipped example and previews it before anything is written
(see [Import from another tool](agents/tools.md#import-from-another-tool)).

## Limit an organization

Every organization starts with no limits. Whoever runs the server can cap these
things per organization, with `liaison org caps` or the `limits` section above:

- **Seats**: people whose account is active. Agents, deactivated people and
  import placeholders take no seat. At the limit, accepting an invitation,
  signing in for the first time with an organization's single sign-on,
  creating a person from the config and reactivating someone answer
  `SEAT_LIMIT_REACHED` (409) with the limit and the count. Sending an
  invitation is refused too, so the admin learns before it goes out.
- **Mailboxes**: connected Gmail or IMAP addresses, for Mail or Tickets, that
  are not disconnected. The same address counts once. At the limit, connecting
  a new address answers `MAILBOX_LIMIT_REACHED` (409); reconnecting a connected
  one always works.
- **Storage**: the size of the organization's files, in GB. At the limit an
  upload answers `STORAGE_QUOTA_EXCEEDED` (409). This replaces the old
  `storageQuotaGb` organization setting: an organization that had a value
  other than the default 10 keeps it as its cap, rounded up to a whole GB.
- **Background jobs per hour**: work the server runs in the background (syncs,
  indexing, scheduled tasks). Past the limit, a job waits for the next hour
  with room, up to a day; nothing is dropped. Work a person started and waits
  on (agent replies, approvals, sending mail, a routine's Run now, imports,
  exports, thumbnails and link previews of an upload) is never held back.
- **App runs, app calls and app CPU per day**: the organization's app runs
  (`appRunsPerDay`), the calls apps running on Workers make back to the
  server (`appBridgeCallsPerDay`) and their CPU milliseconds
  (`appCpuMsPerDay`), per UTC day. Only runs on Workers make counted calls:
  a run on the local sandbox (an app not on Workers, or one the server moved
  back to it after loader failures) counts 0 calls, so `appBridgeCallsPerDay`
  does not limit it; `appRunsPerDay` does. Runs and calls are counted as each run
  ends; CPU is what the Workers loader measured, pulled every hour, so that
  cap applies from the first run after the pull that shows it reached. Past
  a limit, until midnight UTC:
  - a tool answers `APP_RUNS_LIMIT_REACHED`, `APP_BRIDGE_CALLS_LIMIT_REACHED`
    or `APP_CPU_LIMIT_REACHED` (429) with the limit and the count;
  - a webhook is still verified and answered 2xx; its handler runs after
    midnight, with the same payload;
  - an event an app subscribes to, and an app's own job, run after midnight; a
    scheduled app job skips its ticks until then;
  - a poll of an awaited output answers "not ready" and asks again later;
  - an app's search returns no results, with the reason;
  - a run started from inside another app's run is counted but never refused,
    and the platform's own built-in code is never limited.
  The daily totals per app are in `kernel.app_usage_daily`.

```bash
liaison org caps acme --seats 25 --storage-gb 100
liaison org caps acme --unset storage-gb
liaison org caps acme            # print the caps and the usage
```

Each cap is a whole number of at least 1; `--unset` makes it unlimited (0 is
refused). A cap below the current usage removes nothing; new seats and mailboxes are
refused until usage drops. The organization's admins see each cap read only in
**Settings › Organization › Usage and limits**, and get a notification when a
cap reaches 80 % and 100 %.

## From the agent

An admin can also ask the agent to change a section. The agent uses the
`config_<section>` tools (roles, email, users, mail, tickets, apps,
knowledge, agents, invoicing), which take the same data as the
section here and run the same provisioners.

- Each change is an approval card listing its plan; it runs only once a
  person approves it, with that person's own permissions. The approver must
  hold the scopes the change needs, for example `kernel:roles:admin` for roles.
- A change can not remove the approver's own admin scopes, nor leave the
  organization with nobody holding `kernel:org:admin`.
- Secrets are never part of a tool call: a mailbox, inbox or connection is
  saved without its password or credentials and reported pending until the
  person enters them.
- Files are uploaded first and passed by id (`contentFileId`, `logoFileId`);
  paths on the server are refused.
- `config_export` shows the current configuration in this format, without
  secrets; `config_plan` shows what a change would do. The `org` and `admin`
  sections, BYOK keys, API keys and `limits` stay with this CLI.

## Connect a member's own account

`liaison connect <app>/<connection> --for <member email>` connects a member's
own mailbox, calendar or Drive as their personal connection, without anyone
clicking through Settings for them:

```
docker compose exec app liaison connect mail/gmail --for ana@acme.example --send
```

- It prints a one-time Liaison link (`--send` also emails it to the member) and
  waits for a connection that member owns.
- The link never signs anyone in. It works only when the member is signed in as
  themselves; anyone else who opens it (the admin, a colleague it was forwarded
  to) is told to sign in as that member, and the link stays usable.
- It works once and expires after 30 minutes. If the member has not opened it
  by then, the command stops with exit code 1, says the link expired and prints
  the command for a new one. Once the member has opened it, the command keeps
  waiting while they finish the provider's consent.
- If the member's connect is refused (the account is already the
  organization's, its domain is not allowed, the provider said no), the command
  stops at once with the reason and exit code 1, and the member's browser shows
  **Nothing was connected.** with the same reason on the link's page.
- The provider's consent runs in the member's browser, bound to it like the
  Connect button. For a mailbox, the member chooses a transparent or private
  mailbox on the link's page; a private mailbox asks for its mailbox password in
  the same browser. The command says the trade-off: standard (transparent)
  mailboxes are read server-side and routines run unattended; routines and
  agents can't read private mail while its owner is offline, so those runs wait
  for them (Run now).
- Only an admin of the connection (its admin scope) or the server's CLI can make
  a link for somebody else. In Liaison, the agent's `kernel__connect_link_send`
  sends one after an approval.

## Disconnect an account

`liaison disconnect <app>/<connection> <account>` disconnects one account by its
address, the way Disconnect in Settings does:

```
docker compose exec app liaison disconnect mail/gmail support@acme.example
```

- It prints what gets deleted (what Liaison imported from the account; the
  provider keeps the original) and asks to confirm. `--yes` confirms for a script.
- An organization connection is disconnected by the operator. A member's personal
  connection is theirs: the command refuses it unless you pass `--force`, which
  writes an audit entry naming its owner.
- To move an account between personal and organization, disconnect it, then
  connect it again the right way.
- In Liaison, the agent's `kernel__connection_disconnect` does the same after an
  approval: the organization's connections for an admin of the connection, a
  personal connection only for its owner. The approval names one connection
  (whose, which address, its id, what gets deleted) and the approved call removes
  that id. An address that matches several connections is refused with each
  listed: pass the id of the one meant.
