---
title: Back up and restore
description: Back up a self-hosted Liaison into one archive, schedule it, copy it off the host, restore it, and export your organization's data.
---

One script backs up the whole instance into one archive, and the same archive restores it on this host or another. This page covers the Docker Compose stack in `deploy/docker-compose.yml`.

## Take a backup

From the root of your checkout, run:

```bash
./deploy/backup.sh
```

It writes `deploy/backups/liaison-backup-<UTC timestamp>.tar.gz` (mode 600, in a mode 700 directory), checks that it reads back, and prints its path. The host needs only Docker, `tar` and `gzip`.

| Flag | What it does |
|---|---|
| `--keep N` | After a good backup, delete all but the N newest archives. Hand-named archives are never removed. |
| `--project NAME` | Docker Compose project name (default `liaison`) |
| `--dir PATH` | Where archives go (default `deploy/backups`). A directory other users can read is refused. |
| `-h`, `--help` | Show the help |

The archive holds:

| Part | What |
|---|---|
| `db.dump` | Postgres, one consistent snapshot (`pg_dump`, custom format) |
| `roles.sql` | The database roles and memberships, without passwords |
| `objects/` | Every object in the object-store bucket, with an index |
| `data.tar.gz` | The app's data directory, `deploy/data` (installed app packages, push key files) |
| `secrets.env` | `JWT_SECRET`, `ENCRYPTION_KEY`, `BYOK_ENCRYPTION_KEY`, `VAPID_*` when set, and the deployment's OAuth clients, Meta app and iOS push settings when set |
| `manifest.json` | Image and version, migration highwater, timestamp, counts and checksums |

The search index is not copied: a restore rebuilds it from the database. Everything else in `deploy/.env` (URLs, ports, database and object-store passwords, SMTP, platform model keys) belongs to the host and stays there.

**The archive holds the data keys.** Anyone with it can read every stored secret. Keep it as private as `deploy/.env`, and encrypt it when it leaves the host. Never keep a database dump apart from the keys it was written under: without them, connected accounts, model keys and two-factor secrets cannot be opened.

## Back up every night

1. Add a cron line, for example nightly at 03:15, keeping two weeks:

   ```cron
   15 3 * * * cd /opt/liaison && ./deploy/backup.sh --keep 14 >>/var/log/liaison-backup.log 2>&1
   ```

   The script needs no prompt, prints the archive path alone on stdout, exits non-zero on any failure, and two runs never overlap.
2. Copy each archive off the host. For example, encrypted with [age](https://age-encryption.org):

   ```bash
   f=$(./deploy/backup.sh --keep 14)
   age -r <your age public key> -o "$f.age" "$f"
   rclone copy "$f.age" offsite:liaison-backups/
   rm "$f.age"
   ```

If your object storage is a managed S3 service rather than the bundled SeaweedFS, turn on the provider's versioning or replication as well.

## Restore a backup

Run a restore drill before you go live, then every few months.

1. Prepare a fresh stack: a checkout of the same release or newer, with its own `deploy/.env` (`./deploy/quickstart.sh` creates one for a local test).
2. Copy the archive into its `deploy/backups/` and run:

   ```bash
   ./deploy/restore.sh deploy/backups/liaison-backup-<ts>.tar.gz
   ```

| Flag | What it does |
|---|---|
| `--base-url URL` | The URL people reach this instance at. Sets `BASE_URL` and `ALLOWED_ORIGINS`. Without it, the host's values are kept. |
| `--force` | Replace a database that already holds organizations |
| `--project NAME` | Docker Compose project name (default `liaison`) |

`restore.sh` checks the archive's checksums, refuses a backup newer than the stack's image (upgrade first; an older backup is migrated up on boot), and refuses a stack that already holds organizations unless you pass `--force`. It writes the archive's keys into `deploy/.env` (keeping the old file as `deploy/.env.before-restore-<timestamp>`), restores the roles, database, objects and data directory, starts the app, rebuilds the search index and verifies: `/healthz`, organization and file counts, and one object read back against its checksum.

3. Do what it prints for outside the host: DNS, the new redirect URI in each OAuth client, and the webhooks external services call (Gmail push, Shopify, Facebook, ticket intake).
4. Sign in and open a few conversations and files.

To move a trial to a server in one step, use `./deploy/move.sh` (see [Install Liaison](../getting-started/install.md#move-a-trial-to-a-server)).

## Export an organization's data

An export is a copy of your data, not a backup you can restore. For one organization's complete archive, see [Export a whole organization](#export-a-whole-organization).

An agent can also export everything held on one contact, for a data-subject request (`data_subject_export`, scope `kernel:data_subject:export`). The contact's export says when and how they opted out of commercial mail, if they did, and carries the recurring invoice schedules that bill them (ended ones too) and the Stripe customers linked to them with their subscriptions. Of a card it carries the brand, the last 4 digits and the expiry, never more. The same tool exports a member of the organization: their profile and preferences, roles, the messages they wrote, the conversations they started, the files they uploaded (details and links), the approvals they requested or decided, the routines they own, the dashboards they own or made, the dashboard tables they own, made or changed rows of (names and counts, not the rows), the data store documents they wrote and the app drafts they made (their details, not their contents), the app runs their actions started that left log lines (counts and times, not what the app wrote), even after they lost the permission to build apps or read app logs, audit entries about them, their connected accounts, the opt-outs they recorded (when and how, never an address), the time they entered on tasks (never anyone else's, and not who changed an entry; when someone else runs the export, only the entries that person can already read on a project's dated sheet), their away days (not who is next in line) and their days per week, and their agent's memory. Tokens, passwords and credentials are never in it. Every member may export their own data this way; exporting another member needs `kernel:data_subject:export`. The export is saved as a file of the organization, so it counts toward the storage limit: when the organization is at its limit, the agent gets **STORAGE_QUOTA_EXCEEDED** and no file is saved. Only the person who ran the export can open the file: not the person it is about, another member, or an administrator.

Erasing a member (`liaison erase-user`) also clears every inbound webhook delivery still stored with a payload that names them (their id or email): waiting deliveries are dropped instead of run later. A backup taken before the erasure still holds them until it rolls over.

- **From the app:** open **Settings › Organization › Export your data**, pick the apps and the format (**JSON** or **CSV**), and click **Export**. The zip's `manifest.json` names each app's version (for a catalog app, the version active on the server). It needs `kernel:users:admin`. See [Find your way around Settings](settings.md#export-the-organizations-data).
- **From the CLI:** `liaison export --full --output <path>` writes the whole instance (database, files, search) to a `.tar.gz`, renamed onto `--output` only when it succeeds. It needs a database connection allowed to run DDL. See the [CLI reference](../reference/cli.md).

## Export a whole organization

A whole-org export is one zip archive with every record and every file of one organization: what you take with you when you move or close it. It is not a backup you can restore.

- **From the app:** open **Settings › Organization › Export organization** and click **Export organization**. It needs `kernel:org:admin`. The archive is built in the background; you get a notification when it is ready, and it appears in the list with its size and a **Download** button. Each download link is valid 5 minutes, and where each org has its own address, it works on that address only; ask for a new one any time. The link points at the object store only when browsers can reach it (`OBJECT_STORAGE_BROWSER_DIRECT=true`); otherwise, the default, the server streams the archive itself.
- **From the CLI:** `liaison org export <org slug or id> [--wait]`. See [Provisioning CLI](../provisioning-cli.md).

Only one export of an organization runs at a time. An archive is kept 7 days, then deleted.

What is in the archive:

- `manifest.json`: the format version (1), the organization, the tables with their row counts, the files, what was left out and why.
- `data/<schema>.<table>.ndjson`: one JSON line per row, for every table that holds the organization's data, including empty ones. Binary values are base64, large numbers are strings, times are ISO-8601 in UTC.
- `files/<file id>/<name>`: every file, byte for byte; `files.ndjson` gives each file's original name.

What is left out: passwords and password hashes, two-step secrets and recovery codes, a recovery phrase's verifier, connection tokens and credentials, mailbox key wraps, API key hashes, browser push subscriptions' keys, pending command line sign-in codes, OAuth client secrets, AI provider keys, the payment card details mirrored from Stripe (brand, last four digits, expiry), and every secret the server encrypted inside app settings and connection details. They are written as `null` and listed in the manifest. Encrypted mail and sealed files are exported as stored, still encrypted, and counted in the manifest.

The archive holds what an admin may read of people's time, no more. A person's own time entries are left out, except those on a project's dated sheet (entered while the project used dated hours), and each entry's cost is written as `null`. People's cost rates and proposed reconciliations, with their lines and proofs, are left out too. The manifest lists these tables under `withheld`. A full copy moves only with an instance transfer, from operator to operator.

The archive is read while the organization keeps working, so it is not a point-in-time snapshot. Without ZIP64, one archive holds at most 4 GB and 65,000 entries: a larger organization's export fails and says so.

## Delete an organization

Deleting an organization removes it and everything it owns from every store: database rows (issued invoices included), search, files, Redis and scheduled jobs. It cannot be undone. Only the operator can do it, on the server, with the CLI:

```
liaison org delete <org slug or id>
```

Before anything changes, the command checks these gates. If one fails, it stops with exit code 2 and says how to fix it:

- **Not the instance's own organization.** The organization that runs the server cannot be deleted, whatever the flags.
- **No export running.** Wait for a running export of the organization to finish.
- **Export first.** You need a completed [whole-org export](#export-a-whole-organization) less than 24 hours old that has left the server: it was downloaded, or you pass `--export-to <path>` and the command saves it to that new local file first. `--without-export-i-accept-losing-the-org-data` deletes without one.
- **Legal archive.** `LEGAL_ARCHIVE_RECIPIENT` must be set to an age recipient (`age1...`). If it is not set, the command refuses unless you pass `--no-legal-archive`; it then prints a warning and records the waiver.
- **Confirmation.** You type the organization's slug, or pass `--yes <slug>` in a script.

`--dry-run` prints the gates and what the organization holds in each store, and changes nothing.

Then the command records the deletion in a ledger and marks the organization as being deleted: from that moment every request for it gets `410 ORG_DELETED` and its background jobs are dropped. The server's worker writes the legal archive and deletes the rest. The command follows it and prints the ledger as JSON: who ran it, the steps done, the waivers, the archive's key and the counts.

If the deletion stops (a crash, a timeout), run the same command again: it resumes where it stopped, also by the organization's id once its row is gone. `liaison org delete <org> --abort` cancels a deletion and restores the organization, as long as the deletion of its data has not started.

### The legal archive

Some records must be kept for years after an organization is gone. Before deleting, the server writes them to one archive:

- the rows of the legal tables: every row of each app table declared `immutable` (legal originals, received e-invoices) and the rows an app marks `legalRetention`: issued invoices and credit notes with their lines (never drafts, quotes or proformas), and e-invoicing transmissions;
- the files attached to those rows (the invoice PDFs); a file whose object is missing from storage is listed in `manifest.json` instead of stopping the deletion;
- the organization's audit log;
- `manifest.json`: the organization's id, name and slug, when it was deleted, the counts, and the date the archive is kept until.

The archive is a tar file encrypted with [age](https://age-encryption.org) to `LEGAL_ARCHIVE_RECIPIENT`. It is stored in object storage at `legal-archives/<org id>/<time>.tar.age`, outside the organization's own files. The server holds only the recipient, a public key: it can write archives but never read them. Keep the matching identity off the server.

An archive is kept `LEGAL_ARCHIVE_RETENTION_YEARS` years (default 10), then a daily job deletes it. The same job deletes, a day later, an archive whose deletion stopped before recording it, so no archive is kept without its index row.

To set it up and read an archive:

1. Create an identity on a machine you trust: `age-keygen -o legal-identity.txt`. It prints the recipient (`age1...`).
2. Set `LEGAL_ARCHIVE_RECIPIENT` to that recipient on the server and restart it. With Docker Compose, put it (and `LEGAL_ARCHIVE_RETENTION_YEARS` if you want other than 10) in `deploy/.env`: `deploy/docker-compose.yml` passes both to the app and worker containers. Recreate them with `docker compose -p liaison -f deploy/docker-compose.yml up -d`.
3. To read an archive, download it from object storage and run `age -d -i legal-identity.txt <archive>.tar.age | tar -x`.

## Keep the keys safe

`ENCRYPTION_KEY` (exactly 64 hex characters, 32 bytes) encrypts every stored secret: connected account tokens, OAuth client secrets, TOTP secrets, MCP connection secrets and encrypted app settings. `BYOK_ENCRYPTION_KEY` encrypts organizations' own model keys. `JWT_SECRET` signs access tokens, file links and MCP tokens. Lose them and stored secrets cannot be read. To change them, follow [Rotate keys](../runbooks/key-rotation.md).
