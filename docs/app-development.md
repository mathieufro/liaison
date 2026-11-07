# Building a Liaison App

This is the end-to-end guide for developers extending Liaison with their own
app. You will: scaffold an app, develop it in-tree with fast feedback, package
it into a distributable `.liaisonapp`, and install it on a deployed Liaison
instance.

If you are pairing with Claude inside this repo, the `creating-an-app` skill
walks the same path interactively.

---

## 1. What you're building

A Liaison **app** is a plugin: a self-contained bundle of backend tool handlers,
an optional frontend panel, an entity schema, events, and scheduled jobs. Apps
extend the kernel without modifying it.

There are three kinds of app, and they differ in where they live, how much the
platform trusts them, and how they get installed:

- **In-tree kernel apps** live at `apps/api/src/apps/<name>/`. They ship with the
  platform and, if the repo maintainers mark them `trusted`, can run in the
  faster in-process sandbox. `mail`, `contacts`, `tickets` are in-tree kernel
  apps.
- **Bundled apps** live at `bundled-apps/<name>/` (for example `shopify`,
  `invoicing`, `boxtal`, `ads`, `social`, `calls`, `monitoring`,
  `pennylane`). They may only import `@liaison/app-sdk`, are frozen into
  `.liaisonapp` packages baked into the image's app catalog at build time, and
  install through the same route as a third-party package.
- **Installed apps** are `.liaisonapp` packages installed at runtime onto a
  deployed instance, whether from the baked-in catalog or from an external URL.
  They are **always** process-isolated (sandboxed worker), never trusted, and
  can only call kernel-mediated APIs with the scopes an admin explicitly
  grants.

The **trust boundary** is the `AppContext` your handlers receive. An app cannot
touch the database, emit events, call external APIs, or run agent chats except
through `ctx`. The kernel enforces scopes on every call.

When you fork Liaison to build your own app, you develop it **in-tree** (the fast
path, the same feedback loop the in-tree kernel apps enjoy), then **freeze** it
into a `.liaisonapp` and **install** it onto your production instance.

---

## 2. Quickstart (5 minutes)

```bash
git clone <your-fork> && cd liaison
bun install
bun run app:create my-app          # scaffolds backend + frontend skeletons
bun dev                            # auto-discovers my-app — no kernel edits
bun test apps/api/src/apps/my-app/ # runs the scaffolded handler test
```

`bun run app:create my-app` generates:

```
apps/api/src/apps/my-app/
  app.manifest.json        app metadata, schema, tools, scopes
  manifest-descriptor.ts   TS descriptor wrapping the manifest + bundle path
  handlers.ts              tool handler implementations
  handlers.test.ts         a passing handler test
  README.md
apps/web/src/modules/my-app/
  Panel.tsx                the frontend panel
  index.ts
```

The new app is picked up automatically by filesystem auto-discovery — there are
no kernel files to edit.

---

## 3. Anatomy of an app

The reference app at `apps/api/src/apps/example/` demonstrates every SDK surface
in the smallest possible code. Read it alongside this section — each of its five
handlers teaches exactly one thing.

### Backend (`apps/api/src/apps/<name>/`)

- **`app.manifest.json`** — declares the app's `name`, `version`, entity
  `schema`, `tools` (each with `requiredScopes`, a non-empty list of scopes, and a `handler` export name), `events`
  it emits, `jobs` it schedules, and the `scopes` it requests.
  A job with a `schedule` (a cron expression) runs once per workspace that has
  the app on, at each fire time. The runs are spread over min(80 % of the
  interval, 5 minutes), 2 s per workspace, so a run may start up to 5 minutes
  after the cron time. A workspace whose previous run has not started yet gets
  no second one. A scheduled job's name may use only letters, digits, `-` and
  `_`.
  A dimension a person must be granted to see data is declared on a table, under
  `schema.<table>.dimensions`, and is named `<app>:<dimension>`. A tool that
  filters its response by dimension (`returns.dimensions`), the `export`
  `dimensions` and an import kind's `dimension` may name only those: any other
  key fails validation with `"<key>" is not a dimension of "<app>"`, because no
  admin could grant it.
  Give a scheduled job a `runsFor` so a workspace with nothing for it to do
  gets no run: `{ "connection": "shop" }` (the workspace has an active account
  for that connection; another app's is `"<app>:<connection>"`),
  `{ "rows": { "entity": "parked", "where": { "status": "open" } } }` (the
  app's entity has a matching row; a value is matched as is, `null` means
  empty, `{ "in": [...] }` is a list and `{ "not": null }` means set), or
  `{ "everyOrg": "<why>" }`. Give `connection` and `rows` together, or as
  lists, and any one is enough. A demo workspace's sample connection does not
  count. If the check itself fails, every workspace gets its run. Keep it as
  narrow as the handler allows: each run sets the workspace up in the process
  that runs it, and a workspace an hourly job reaches every hour stays set up
  there for good.
  A job marked `atomic: true`, an event-subscription handler and an import
  batch hold one database connection for their whole run, so each waits for
  a free slot before it starts, first come first served (the slots come from
  the process's [pool plan](self-hosting/pools.md)). A busy worker delays
  them; it does not fail them. An event handler stops waiting when the event
  bus gives up on it (60 seconds).
- **`manifest-descriptor.ts`** — a thin TS module that imports the JSON manifest,
  tags it `_format: "manifest"`, and points `_bundlePath` at `handlers.ts`.
- **`handlers.ts`** — the tool handler functions. Each is `(params, ctx)` and is
  resolved by the `handler` string in the manifest.
- **`import`** (optional) — the records the app accepts from an import. Each
  entry of `import.kinds` gives a record `schema` (a JSON Schema of
  `type: "object"`), the `handler` export that writes a batch of records, the
  `dedupKey` field holding the source's stable id, the `tables` the kind writes
  and the `writeScopes` a person needs to run it (optionally a `dimension`
  checked per record and a `parent` kind imported first). The handler receives
  `{ runId, kind, sourceLabel, records: [{ record, dedupValue }] }`, stores
  `dedupValue` in the row's `external_ref` (skipping a record whose value is
  already there) and returns one `{ status, rows: [{ table, id }] }` per
  record, so the run can be undone. A kind writes only its app's own tables.
  Declared kinds are also what lets an agent tell a workspace that your app
  provides a kind it lacks: a catalog app is named only when its packaged
  manifest declares that kind.
  Two more things a result may carry, both checked by the host: `rows` may
  name a `kernel.files` row your handler made in that same call through the
  files bridge (`files_attachToParent`, `files_importAttachment`; a copied
  PDF, say), and `sequenceFloors: [{ key, value }]` raises one of your app's
  sequences (`<app>:` keys) to at least `value`, never lowering it. A record
  naming any other file, or another app's key, fails. To keep a file the
  person uploaded with the import (an invoice's original PDF, say), return
  `attachments: [{ fileId, parent, rowId }]`: the host checks that the person
  can read the file, that `parent` is one of your app's `fileParents` whose
  `writeScope` they hold and that `rowId` is a row the same record created,
  then copies the file onto that row and records the copy for undo
  (`ref: "<key>"` also writes the copy's id into the row's `external_refs`).
  Every row a result names must be one the run wrote: a row older than the
  run, or on another run's ledger, fails the record. A record that fails
  after writing returns the rows it wrote, so undo removes them.
  A preview (a dry run) checks each record against the schema only, unless
  the kind names a `check` export: the preview then calls it with the same
  batch, in a read-only transaction, and counts the `{ status, error? }` it
  returns per record. Share one function between `check` and `handler` for
  everything checked before the first insert, so a preview refuses what the
  run would.
  A value one record may hold for the whole run (an invoice number) is a
  claim: a result may return `claims: string[]` for a record it passed or
  created, and every later batch of the run receives the run's claims so far
  as `claimed`, so a duplicate in another batch is refused even by a preview.
  The built-in kinds that write tasks, tickets and ticket categories do the
  same: their preview runs the run's own checks (a parent that is not
  imported, a category that does not exist, a team outside the person's
  grant), and remembers what earlier records of the preview would create.
- **Formats.** An import reads canonical NDJSON (`{"kind", "record"}` per
  line). A standard file is read by the host into its one kind's records:
  `format: "ics"` gives `calendar.event` records. Chat history imports as the
  kernel kinds `chat.thread` (a channel, `private: true` for a members-only
  one) and `chat.message` (its messages, with replies, reactions and files).
  Messages go only into a channel an import created (this run or an earlier
  one); a CLI import may also name existing channels (`existingChannels`), and
  each such write is recorded in the audit log.
- **Legal records.** A table declared `immutable` (`retentionYears`, optional
  `writeOnceColumns`) holds legal originals: the kernel refuses to change its
  write-once columns or delete its rows within the retention period. When the
  operator deletes an organization, every row of each `immutable` table, and
  the rows a table's `legalRetention` marker selects, go into the encrypted
  legal archive with the files attached to them
  ([Delete an organization](admin/backups.md#delete-an-organization)).
  `legalRetention: true` keeps every row; `{ "where": { "status": { "in":
  ["issued", "paid"] } } }` keeps the rows whose columns hold one of the
  listed values (columns combined with AND); `{ "parent": { "table":
  "documents", "column": "document_id" } }` keeps the rows whose parent, in
  another marked table of the app, is kept.

### Frontend (`apps/web/src/modules/<name>/`)

- **`Panel.tsx`** — a SolidJS component, the app's UI surface.
- **`index.ts`** — re-exports the panel.

The frontend app registry (`apps/web/src/framework/app-registry.ts`) is how a
panel slots into the shell.

An installed app whose interface runs in the sandboxed frame cannot draw into
the page, so give it an icon as manifest data: `iconSvg` (plain SVG markup, at
most 8 KB) or `iconName` (an icon of Liaison's set). The rules are in
[App package format](app-package-format.md#app-icon-iconsvg-iconname).

---

## 4. Writing a tool

A tool is a function in `handlers.ts` whose name matches a `handler` string in
`app.manifest.json`. It receives `(params, ctx)`:

```typescript
import type { AppContext } from "@liaison/app-sdk"

export async function items_create(
  params: { text: string },
  ctx: AppContext,
): Promise<{ id: string }> {
  const id = crypto.randomUUID()
  await ctx.db.insert("items", { id, text: params.text, orgId: ctx.orgId })
  await ctx.emit({ entity: "item", action: "created", entityId: id })
  return { id }
}
```

`AppContext` gives you:

| Surface | Use |
|---|---|
| `ctx.db` | Read/write your app's entity rows, scoped to the org |
| `ctx.emit` | Emit a domain event other apps can subscribe to |
| `ctx.enqueueJob` | Enqueue a background job |
| `ctx.connections` | Per-connection OAuth/credential tokens |
| `ctx.fetch` | Call an external API (kernel-mediated, allowlist-checked) |
| `ctx.time.civil` | The date and clock of an instant in a named IANA zone. The sandbox has no `Intl`, so `new Date()` only knows UTC. `UTC`, the column default, follows the organization's zone; `Etc/UTC` is UTC exactly; an unknown zone rejects with `invalid_timezone` |
| `ctx.resolveContact` | Resolve or create a contact |
| `ctx.logger` | Structured logging |

**Refusing a call.** When a tool declines a call on purpose (a check failed,
nothing was written, and the caller can fix it), return `refuseTool(code,
message)` from `@liaison/app-sdk`. Write the message for the agent: what was
wrong and the next step.

```typescript
import { refuseTool } from "@liaison/app-sdk"

if (!params.vatId) {
  return refuseTool("vat_id_required", "The buyer has no VAT number. Nothing was created. Find it, then call again with vatId.")
}
```

The agent gets the message as the tool's error. The server answers with a
4xx status (the code's own one when the server knows the code, otherwise 422)
and logs it as a warning, not as an error. A refusal can never be a 5xx. Use it
only for refusals: a crash or an unexpected failure is thrown, and an
unclassified one stays a 500 logged as an error. To pass a message safely
when you throw, use `ToolError`.

**Amounts in minor units.** A field named `*_minor` holds a whole number: 41940
for 419.40. Read one with `readMinorAmount` from `@liaison/app-sdk`, which
returns null for anything else, and answer null with `minorAmountRefusal(field,
value)`, which names the amount it read and what to send. Never guess a unit
from a decimal point. The server refuses a decimal in a declared `*_minor`
parameter the same way.

**Scopes.** Every tool declares `requiredScopes`, a non-empty list
(`["my-app:resource:action"]`). A tool only runs if the caller holds every scope
in it; a manifest tool carrying the old single `scope` key is refused. Scopes are hierarchical: granting
`my-app:items` implicitly grants `my-app:items:read` and `my-app:items:write`.

**Agent guide.** `agentInstructions` in the manifest is what the agent reads
about your app. Keep it in two parts: a short `core` (the rules that apply to
every call, about 1,000 tokens at most) and `sections`, each keyed by the
tools it is about. The core rides in the agent's cached prefix as soon as one
of your tools is loaded; a section rides only while one of its tools is
loaded, and it is delivered the step its first tool is discovered. A plain
string is still accepted and is treated as a core with no sections.

```json
"agentInstructions": {
  "core": "Items is the shared to-do list. Key handles: item id, owner.",
  "sections": [
    { "tools": ["items_create", "items_update"], "text": "Writes: ..." },
    { "tools": ["items_export"], "text": "Exports: ..." }
  ]
}
```

A section naming a tool the manifest does not declare fails registration.

**Pinned params.** A gated tool's `preflight` may answer
`{ ok: true, pinnedParams: { ... } }` to set server-computed params on the
staged call, which the approval card shows and the handler checks at
execution. Declare those param names in `pinnedParams` on the tool. A value
the caller passes for one is dropped before the preflight runs, and a call
that carries an `@ref:` token to an earlier step (which skips the preflight)
is refused at staging with "this tool can't take a reference to an earlier
step; call it after that step completes". A pinned name is a top-level
param, never a dotted path. No `editableFields` entry may reach a pinned param
(the param itself, a field under it or above it): the manifest is refused,
and an edit of such a field is refused too. A handler cannot park an approval
for a tool with pinned params through `ctx.requestApproval`; call the tool
itself so its preflight pins them.

**Outbound text.** A tool that sends text to a person outside the org (an
email, a reply, a direct message) lists those params in `outboundTextParams`,
for example `["subject", "textBody", "htmlBody"]` (top-level names; a name
containing `html` is read as HTML). A call from an agent whose text there still
holds an unfilled placeholder (`[DATE]`, `[Name]`, `{{firstName}}`,
`<insert date>`, `XX/XX`, `TBD`) is refused before any gate stages an
approval, and the agent is told today's date in the person's timezone. Quoted
lines, code and markdown links are not judged. The same check applies to an
approval a handler parks with `ctx.requestApproval` and to an agent's edit of
a pending payload; a person's own call from the UI is not checked.

**References to a parked call.** A tool that declares `referenceableOutputs`
hands the agent an `@ref:<approval id>:<key>` token for each key while its call
waits for approval, and a later call that cites one is staged as the next step
of the same request. This holds when the handler parks the approval itself
(`ctx.requestApproval`, returning `{ status: "pending_approval", approval_id }`):
the result gains the same `outputs`, so the agent can chain on it. An agent's
gated call that holds a near-miss reference (`{{step1.record_id}}`,
`@ref:<approval1>:id`, a token without its uuid) is refused with the exact form
expected, so a placeholder never reaches a record or a customer.

**Patterns in params and settings.** A `pattern` in a tool's params, a settings
field's `validation.pattern` and a connection's template variable or authorize
parameter pattern run on the server. The install refuses a pattern longer than
512 characters or one whose matching time is not linear, such as `^(a|a)+$`:
a repeated part must not match the same text in two ways. A pattern whose check
takes too long is refused too, so keep patterns short. See
[the package format](app-package-format.md#regular-expressions-in-a-manifest).


### Let people find it

An agent finds most tools by searching. Add the words people use for what the
tool does, when its name and description do not carry them, in
`searchKeywords`: single words, in any language, the words on your screens
included. They are read only by the search, never sent to a model, so they cost
no tokens. Accents do not matter: `clôturer` also answers to `cloturer`.

```json
"close": {
  "description": "Close a ticket.",
  "searchKeywords": ["fermer", "clôturer", "résoudre"]
}
```

---

## 5. Writing a panel

`Panel.tsx` is a SolidJS leaf component. Keep state in a small store
(`<name>-store.ts`), following the pattern in an existing module, for example
`apps/web/src/modules/settings/apps-store.ts`. The scaffolded `Panel.tsx` from
`bun run app:create` does not include a store file yet, so you'll add one as
your panel's state grows. Use the design-system primitives from
`apps/web/src/ui/` (`Button`, `Dialog`, ...) rather than raw Kobalte.

Your app's UI may run in a sandboxed frame (in the desktop and phone apps, and
in a browser for an app that is not first-party), where each view is its own
frame. Write it so that it works there too:

- Read the page's path with `currentPath()` from `@liaison/host`, never
  `window.location` (a frame's location is its own document's), and read it
  again on `popstate`, which the host fires on every route change. A sidebar
  marks its active row this way. A framed app is told the path only while the
  page is on one of its own routes (`/<app>/...`, its own tab patterns,
  `/detail/<app>/...`, `/settings/apps/<app>`); elsewhere `currentPath()` is `""`.
- A page that opens a record inside its tab (a list beside a detail, an expanded
  row, a drawer) says which one, so a person who asks the agent about "this" gets
  that record: `app.trackOpenRecord("shipment", () => selectedId())` from
  `@liaison/host`, in the component body, with an entity of your manifest. Return
  the record the person opened (a click, a deep link), never a first row your list
  shows by default, and null while no record is on screen, a phone layout that hides
  the pane included.
  An entity in another system (`"external": true`, no local table) works the same:
  the agent is told its id. A tab whose own id is the record needs none of this:
  when the tab is not named for its entity, it declares it instead
  (`"entity": "document"`, or `"entity": "kernel:contact"`, in `views.tabTypes.<tab>`).
- Keep every tab `urlPattern` under a first segment your app owns
  (`/<app>/...`): a pattern under another app, a Liaison page or a leading
  parameter is refused at install (see "Tab routes" in `app-package-format.md`).
- Link to your own routes with a plain `<a href="/<app>/...">` or `navigate()`;
  never `location.assign` or `location.href = ...`, which would send the frame
  away from its document and stop the app.
- Hand state from one view to another through the route (an id in the path, a
  query), never a module-level signal: two framed views do not share modules.
- Declare your icon as data in the manifest (`iconName` or `iconSvg`): a framed
  app's icon is drawn from it.

---

## 6. Connections

If your app talks to an external service, declare a `connection` in the manifest
(`oauth2` or `credential`). The kernel owns the token lifecycle; your handler
reads a fresh token via `ctx.connections.<name>.getToken()` and never sees the
client secret.

### Let the host hold the secret

An app can send a connection's credential without ever reading it: pass `auth`
to `ctx.fetch` and the host adds it to the request, only for a host in that
connection's `allowedDomains`, and redacts it from the answer.

```ts
await ctx.fetch(`https://${shop}/admin/api/graphql.json`, {
  method: "POST",
  body,
  auth: { connection: "shop", scheme: "header:X-Shopify-Access-Token" },
})
```

`scheme` is `"header:<Name>"` (the oauth2 token, or one credentials field named
in `fields`), `"bearer"` (with `exchange`, a client-credentials token the host
obtains, caches and drops on a 401), or `"basic"` (two credentials fields).
`configSecrets: { "<placeholder>": "<config key>" }` writes a declared config
secret into the string body where its placeholder stands, and `ctx.config.has(key)`
tells whether a secret is set without reading it. For the non-secret part of a
credentials connection, `ctx.connections.<name>.getSettings()` returns the fields
the manifest marks `readable: true` and names the missing ones.

Secret-returning calls (`getToken`, `getCredentials`, reading a secret config
key) work on the local sandbox but are refused when the app runs on a remote
isolate executor, so an app that should run on both sends its secrets with
`auth`. `@liaison/app-sdk/connection-credentials` reads a credentials
connection's fields whichever shape `ctx.connections` has, for code that still
needs them locally.

### Call out once

A job can run twice: a restart hands it back, or a stalled run is run again on
another worker. When a job's call changes something outside (a deposit, a
payment, a mail), wrap it in `appEffectOnce` from `@liaison/app-sdk/effects`
with a key that names that one effect:

```ts
import { appEffectOnce } from "@liaison/app-sdk/effects"

const out = await appEffectOnce(ctx.effects, `deposit:${invoice.id}`, () => depositAt(platform, invoice), {
  // A run that died after claiming the key may or may not have called out.
  onUnknown: async () => {
    const found = await lookUp(platform, invoice)
    if (found) return { outcome: "done", result: found } // it did: keep its answer
    if (found === null) return { outcome: "retry" } // it did not: call out now
    return { outcome: "skip" } // cannot tell: leave it for a later run
  },
})
// out.status: "ran" | "replayed" (an earlier run's answer) | "unknown" | "in_flight"
```

The first run claims the key, calls out and stores the answer; a later run with
the same key gets that answer back without calling out. A call that throws
releases the key, so the next run tries again. When the call was made but its
outcome is in doubt (a timeout, a server error from the other side), throw
`EffectOutcomeUnknown` from `@liaison/app-sdk/effects` instead: the key is kept
as unknown, so the next run goes through `onUnknown` and asks the other side
before calling again. While another run holds the key
the answer is `in_flight`: try again later. The answer is stored as JSON. Keys
are your app's own: no other app can read or settle them.

---

## 7. Testing

Test handlers with `mockAppContext` — a deterministic `AppContext` substitute
that captures emitted events, enqueued jobs, and db writes:

```typescript
import { mockAppContext } from "~/modules/apps/test-helpers"

const ctx = mockAppContext({ orgId: "test-org" })
await items_create({ text: "hi" }, ctx)
expect(ctx.emit).toHaveBeenCalled()
```

Run tests with `bun test apps/api/src/apps/my-app/`; see
`.claude/skills/run-tests/SKILL.md` for the lock and the env.

---

## 8. Packaging for distribution

When the app works in-tree, freeze it into a `.liaisonapp`:

```bash
bun run app:freeze my-app
# → dist/apps/my-app-0.0.1.liaisonapp
bun run app:sign dist/apps/my-app-0.0.1.liaisonapp
```

`app:freeze` bundles `handlers.ts` (and the panel) into an isolated staging dir
and tars the manifest + bundle — your source tree is never polluted with build
artifacts. `app:sign` adds a cosign keyless signature.

The `.liaisonapp` format is specified in
[`docs/app-package-format.md`](app-package-format.md). In CI, run `app:freeze`
then `app:sign` and publish the artifact at a stable `updateUrl`.

---

## 9. Installing on a deployed Liaison

All install paths go through the same authenticated HTTP API
(`apps/api/src/modules/apps/install-routes.ts`, mounted at `/api/apps`):
`POST /api/apps/install`, `POST /api/apps/:name/upgrade/preview`,
`POST /api/apps/:name/upgrade/apply`, `POST /api/apps/:name/rollback` (back
to the previous version, through the same checks as an upgrade),
`DELETE /api/apps/:name`, and `GET /api/apps` to list. Every route requires the
`kernel:apps:admin` scope.

An installed app is shared by every org on the instance. On a single-org
self-host any admin with `kernel:apps:admin` manages apps. On a multi-tenant
instance (demo mode or the managed edition) the routes that change the installs
(install, upgrade, rollback, uninstall, interface approval) are also confined to the
instance operator's org: `LIAISON_OPERATOR_ORG_ID`, or the instance's first org
when it is unset. The one exception is a custom app in the managed edition,
below.

**Custom apps (managed edition).** An org admin with `kernel:apps:admin`
installs their own app for their own organization only, with
`POST /api/apps/custom/install` (same body as `/install`: `url` and the grants).
No other organization on the server sees or runs it. The rules:

- The app's `name` ends with your organization's key: `<name>-o<key>`, where the
  key is the first 8 hex characters of the SHA-256 of the organization id.
  `GET /api/apps/custom/namespace` returns the key and an example name. A
  package without it is refused (422 `custom_app_name`) with the name it should
  have. `<name>` cannot be the name of an app the server provides. Users see
  the manifest's `displayName`.
- It may declare only the capabilities an ordinary org app holds: `agent.run`,
  `realtime.publish`, `bulk.fetch`, `messages.post`, `pdf.render`,
  `sequences.allocate`, `contacts.addToOrganisation`. Anything else
  (`agent.spawn`, `grants.setUserScopes`), `trusted`, `rlsManagedBy`, `routes`,
  `network.allowPrivateHostsInTest`, or a `timeoutMs` / `bodyLimitBytes` above
  the defaults (tool and search 5 s, job 60 s, webhook body 1 MB) is refused
  (422 `custom_app_capability`, naming it).
- Its tables stay in its own schema: a foreign key (`references`) may name
  only one of its own tables (no `schema`), and it may not declare database
  triggers (422 `custom_app_capability`, naming
  `schema.<table>.fields.<field>.references` or `schema.<table>.triggers`).
- Each one counts toward the plan's custom apps (409 `CUSTOM_APP_LIMIT_REACHED`
  with `{limit, used}` at the limit). Installing a newer version of the same
  app takes no extra one.
- Its `ctx.fetch` goes through the same guard as every app: private, loopback,
  link-local and metadata addresses are refused. On top of that it never
  reaches the server itself: its own addresses and host names (the server's
  base URL, web origins and organization hosts) are refused, and the
  operator's private hosts (`LIAISON_APP_PRIVATE_HOSTS`) do not apply to it.
- It shares the server's app sandbox with every other organization: your
  organization's custom apps run at most 2 handlers at once (tools, webhooks,
  events, jobs together). Up to 8 more wait their turn for up to 5 s; past
  that the call is refused with 429 `custom_app_busy` and `Retry-After`. Its
  webhooks accept 120 deliveries a minute each; past that they answer 429
  `custom_app_rate_limited` with `Retry-After` before any of its code runs.
- `ctx.bulk.fetchToBlob` keeps its downloads apart from your organization's
  other apps: 256 MiB per custom app, a shared limit for all custom apps on the
  server, and a download not used for an hour is deleted.
- Its interface (`ui.js`) loads only on your organization's own address, after
  an admin of your organization approved it at install, and always in a
  sandboxed frame: its code never runs in Liaison's page and never holds a
  member's session.
- The operator of the server can disable it during an incident. A disabled app
  stays installed with its data, but nothing of it runs and it cannot be
  upgraded or uninstalled (409 `custom_app_disabled`) until the operator
  enables it again. Both are recorded in your organization's audit log.
- Upgrade, rollback, interface approval and uninstall work on the usual routes,
  for your organization only; any other organization gets 404. No signature is
  needed.
- Its scheduled jobs and event subscriptions run for your organization only.
  While the organization is suspended, the app is refused like the rest.
  Deleting the organization removes the app with its data.

On a self-hosted server none of this applies: there is no custom install route,
and installs follow the rule above.

**Admin UI** (the primary path): Settings -> Apps -> "Install app...". Enter the
URL, click Preflight, review the requested scopes (each is a checkbox you can
deselect), and install. Installed apps are always sandboxed, the dialog says so
explicitly.

**`liaison config apply`** (declarative provisioning): a config file's `apps`
section installs first-party catalog apps and enables in-tree apps
idempotently (`apps/api/src/cli/provisioners/apps.ts`), useful for scripted
first-boot setup.

**The agent**: `enable_app`, and the agent's `config_apps`, install a catalog
app the instance does not have yet through the same one-click catalog install
(`installFromCatalog` in `apps/api/src/modules/apps/catalog-sources.ts`), under
the same rules: the instance operator's org only on a multi-tenant instance, and
never a registry app. A name that is neither installed nor in the catalog is
refused with the catalog's app names.

**Approved calls that fail**: an app tool approved by a person that answers
with an error, either `{ error: { code, message } }` or `{ error: "..." }`, is
recorded as failed with no effect. The approval goes back to pending with the
reason on its card; it is never reported as executed. A tool declared
`readOnly` (no table written, no side effect) is the exception: its error is
what the call returned, so the approval is done and the error goes to the agent
as the call's result.

The install service downloads the package, verifies its cosign signature against
the trusted publisher set (`LIAISON_TRUSTED_APP_PUBLISHERS`), unpacks it to the
install root, records the grant, and makes it live without a restart, in every
server process. The new version must pass a health check first; one that fails
it is replaced by the version that ran before (see "Versions on the server" in
[the package format](app-package-format.md)).

**Several server processes.** Each process (an API replica, a job worker) has
its own install root, so the instance keeps one copy of every installed package
in object storage, at `instance/apps/<name>/<version>.liaisonapp`, next to the
sha256 and signature recorded at install. A process that does not have a version
on disk fetches it, checks it against that record, and unpacks it before it
registers the app; one whose bytes do not match is refused and the process keeps
what it ran. Install, upgrade, rollback and uninstall reach every process within
seconds, with no restart: an uninstalled app is removed from every process, its
local files included, and a new app is registered in the orgs each process runs
and its jobs start at once. Every process also checks the installed apps every
10 minutes, so one that missed the news catches up. The setup step before a
server start fetches every active version missing from its install root.
Removing an old version, or uninstalling the app, deletes its stored packages.
A version installed before the package store existed is stored from the
server image's catalog when it is that catalog's own package; any other one
is logged with "reinstall it to make it available to every process": reinstall
it once so every process can fetch it.

**Instance-wide parts of your manifest.** Every org on an instance runs the same
apps, so two things your entities declare are built once for the instance, from
the installed apps, not from the orgs a server process has set up: each
`fileParent` joins the `kernel.files` read policy, and each searchable entity's
permission fields become filterable in the search index. The setup step that
runs before every server start (`apps/api/src/db/reconcile-catalog-boot.ts`)
applies both, and does nothing when the installed apps have not changed. An
install, upgrade or version switch applies them again at once. A `fileParent`
whose table does not exist yet (no org has set up that version of your app)
joins the policy as soon as the first org creates the table. Both record the
app versions they were built from: during a rolling deploy, a process still on
an older version of your app leaves them as the newer release built them, so
raise your app's version whenever you change these declarations.

**What the search index holds for an entity.** A searchable entity's
`indexFields` names the columns its search document is built from: `title`,
`handle`, `labelSecondary` and `body`. Two keys add more text to the body.
`bodyFields` lists more columns of the entity's own row; `"column.key"` reads
one key of a JSON column. `bodyFrom` reads child rows of the same app schema:
`{ "tableName", "foreignKey", "columns" }` takes `columns` from the rows of
`tableName` whose `foreignKey` is the entity's id (an invoice's line
descriptions). The extra text is deduplicated and capped. A change to
`indexFields` rebuilds the search index at the next server start.

A `fileParent` may also name a `deleteScope`. Removing a file from such a
parent then takes its uploader, or a holder of that scope, on top of the
`writeScope`; without it, the `writeScope` is enough.

**Print a record through the organisation's templates.** An entity that
declares a `fileParent` can also declare `print`, so people and agents print
its records onto the organisation's document templates:

```json
"print": {
  "recordTool": "print_record_get",
  "idParam": "shipment_id",
  "label": "Shipment",
  "fields": [
    { "path": "order.name", "label": "Order", "type": "string" },
    { "path": "lines.sku", "label": "SKU", "type": "string", "repeat": "lines" }
  ]
}
```

`recordTool` is one of your app's own tools, `readOnly` and never gated (not
`gated`, not `conditionalGate`): the kernel calls it with `{ <idParam>: <record
id> }` under the authorization of the person printing, and its result is the
record. A manifest that breaks this is refused with `print_record_tool_invalid`.
`fields` lists the paths a template may map, with a label and a type (`string`,
`number`, `boolean`, `date`). A field with `repeat` is one per row of the list
at that path; a template maps its rows as `lines.0.sku`, `lines.1.sku`. Printing
needs your fileParent's `writeScope`, stores one PDF per template on the record,
prints a missing value as a grey placeholder and reports it, and refuses a list
with more rows than the template has room for (`too_many_rows`) instead of
cutting it. The REST API: `GET /api/documents/record-types`,
`GET /api/documents/templates?app=&entity=`, and `POST /api/documents/print`
with `{ app, entity, recordId, templateIds, merge? }`.

In your app UI, drop the shared control on a record instead of building your own:
`import { PrintDocuments } from "@liaison/app-ui/print-documents"` and render
`<PrintDocuments app entity recordId neededTemplateIds? />`. It opens as an inline
panel, lists the templates, offers "Print" (and "Print as one PDF" with two or
more ticked), opens the files, and warns which fields printed as blanks.

---

## 10. Upgrading the platform under your app

Your app declares the host API range it needs as `host` in its manifest (`"^1"`
when absent). Install, upgrade and every server start check it against the
server's host API version; an app the server cannot satisfy is refused with a
message naming both versions (see "Host API version" in
[the package format](app-package-format.md)).

To ship a new app version: publish a new `.liaisonapp` at your `updateUrl`,
then re-fetch it via the admin UI's upgrade action or
`POST /api/apps/:name/upgrade/preview` followed by `.../upgrade/apply`. If the new
version requests new scopes, the upgrade surfaces them and you must re-grant
before it applies, no silent privilege escalation.

Every change ships under a new version number. A version, once installed, is
never rewritten: installing a package with different files under a version the
server already has is refused, because a running process may be loading those
files. Reinstalling the same files is a no-op.

Each new version may only add to your app's data: new tables, columns and enum
values. An upgrade that drops, renames or narrows something is refused, because
the server keeps the previous version ready to run again on the same data (the
additive data rule in [the package format](app-package-format.md)).

---

## 11. When the SDK isn't enough

If `@liaison/app-sdk` can't express something your app needs, **do not reach
around it**. File a row in [`docs/sdk-gaps.md`](sdk-gaps.md) and extend the SDK
instead. This is a hard rule: the SDK gets extended, the app does not get a back
door. The gap log is how Phases 16-18 (Shopify, Invoicing, Boxtal) drive SDK
growth, and it is how your app should too.

---

## 12. Tell people about an event

An app raises items in the attention feed from its own events, in `attention.translations` of the manifest. Each person's notification settings then decide the channels.

```json
{
  "event": "ticket:create",
  "kind": "tickets:ticket.created",
  "urgency": 40,
  "when": { "op": "eq", "path": "data.notifyNewTicket", "value": true },
  "summary": "New ticket in {{data.inboxName}}: {{data.subject}}",
  "recipients": { "kind": "scope_holders", "scope": "tickets:inboxes:admin", "excludeActor": true }
}
```

- `when` keeps the translation to the events that match it (`eq`, `in`, `exists`, `and`, `or`, `not` on a path of the event).
- `recipients.kind` is `field`, `participants`, `mentions`, `actor` or `scope_holders`. `excludeActor` (on `participants` and `scope_holders`) leaves out the person who caused the event.
- `resolveWhen` makes the translation end an item instead of raising one, for an event that means the condition is over: `{ "always": true }`, or `{ "field": ..., "equals": ... }`.

## See also

- [`docs/app-package-format.md`](app-package-format.md) — the `.liaisonapp` spec
- [`docs/app-sandbox.md`](app-sandbox.md) — the sandbox runtime internals
- [`docs/sdk-gaps.md`](sdk-gaps.md) — the SDK gap log
- [`docs/database-connector.md`](database-connector.md) — the `database` connector (read-only DB access for the agent) — a host-side bridge-extension app in the same in-tree shape as `gitlab`, built because raw DB sockets are a structural SDK gap (see the gap log entry)
- [`docs/api-connector.md`](api-connector.md): the `api-connector` app (an HTTP API described by an adapter file, for a CRM or ERP), same in-tree host-side bridge shape; adapters are written with the `api-connector-authoring` skill
- `apps/api/src/apps/example/` — the reference app
