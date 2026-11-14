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
  They **always** run sandboxed (only the platform's core apps run as server
  code, and no manifest field changes that: a `trusted` field is refused), and
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

The reference app at `apps/api/test-support/apps/example/` demonstrates every SDK surface
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
  A job marked `atomic: true` runs in one database transaction from start to
  end, so it may not call outside: `ctx.fetch`, `ctx.executeTool`, a contract
  call, an agent run and the other outside calls fail with
  `atomic_run_egress_refused`. Read, call the provider, then write in one
  `ctx` call (or use `ctx.steps.run`) instead. A tool marked `atomic: true`
  gets the same refusal; the bundled apps declare no atomic tool, and a tool
  whose writes must land together commits them in one `ctx.db.batch`.
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

**Every table needs a scope that reaches it.** A table's rows are read with `<app>:<rlsScope or table name>:read`, so a scope your app declares (in `scopes`, a role or a tool) must cover that name. Give a table an `rlsScope` that one of your scopes covers, for example `"rlsScope": "items"` on a table read with `myapp:items:read`. An app with a table no declared scope reaches is refused at registration: on a development or test server registration stops with an error naming the table, and on a production server the app is not loaded and shows as needing attention, with the table named.

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
| `ctx.db` | Read/write your app's entity rows, scoped to the org. `insertNow` / `updateNow` commit at once, for a record written before an outside call you cannot undo ([Sandboxing](app-sandbox.md#commit-an-intent-row-before-an-outside-call-ctxdbinsertnow)). `batch` commits several writes, and optionally a sequence value, together, can append to or merge into json fields of a row as it is at commit, and can guard an update, delete or updateMany with `expect: { minRows?, maxRows? }` so a write that matched no row (or too many) rolls the whole batch back with a `precondition_failed` error that `batchPreconditionFailure(err)` reads ([Sandboxing](app-sandbox.md#commit-several-writes-together-ctxdbbatch)) |
| `ctx.emit` | Emit a domain event other apps can subscribe to |
| `ctx.jobs.enqueue` | Enqueue a background job (`delay` up to 15 min, `jobId` to deduplicate); `ctx.enqueueJob` is the same call |
| `ctx.timers.wakeIn` | Run a job in N seconds instead of waiting inside a run |
| `ctx.steps.run` | Long work in bounded chunks across runs, the cursor saved for you ([Sandboxing](app-sandbox.md#long-work-come-back-later-ctxsteps-ctxtimers-ctxjobs)) |
| `ctx.connections` | Per-connection OAuth/credential tokens |
| `ctx.api` | Call an HTTP API the platform holds the connection to (one credentials connection of your app with an `api` block: each account an adapter document, stored by the platform for your app and that connection): list operations, read, write (gated), test, and manage the adapters; the platform checks the caller against the block's read, write and admin scopes and never hands back a credential, and adds `connector_adapter_save` / `connector_adapter_restore` under your app ([Sandboxing](app-sandbox.md)). The block may also declare what the platform reads through it: `customerContext` (your list, read and write tools: the agent's customer block on tickets and mail), `importSource: true` (import transforms may pull from your connections) and `provisionKey` (the provisioning field `config export` writes your adapters to); see [API connector](api-connector.md) |
| `ctx.sql` | Query a database the platform holds the connection to: named reads (listed with each catalog domain's access tier) or a read-only `SELECT`, rows only, never the credentials ([Sandboxing](app-sandbox.md#query-a-database-ctxsql)) |
| `ctx.accounts` | Your app's own connected accounts and their metadata ([Sandboxing](app-sandbox.md#read-your-own-accounts-ctxaccounts)) |
| `ctx.kernel` | Directory reads of the caller's organization: a user or contact by id, who the run acts for and which scopes they hold (`caller`: a person, or the system for the platform's own runs and jobs; any other caller is refused), the roles, people by email, for access rules of your own ([Sandboxing](app-sandbox.md#read-your-own-accounts-ctxaccounts)) |
| `ctx.fetch` | Call an external API (kernel-mediated, allowlist-checked). `timeoutMs` shortens the 10 s deadline; a write may ask for up to 30 s |
| `ctx.time.civil` | The date and clock of an instant in a named IANA zone. The sandbox has no `Intl`, so `new Date()` only knows UTC. `UTC`, the column default, follows the organization's zone; `Etc/UTC` is UTC exactly; an unknown zone rejects with `invalid_timezone` |
| `ctx.resolveContact` | Resolve or create a contact |
| `ctx.turn.get()` | The turn the handler runs in: `agentId` (null for a job, a webhook or a person's own click) and `hasPerson` (false for a routine, a background turn and a job) |
| `ctx.approvals.restagePayload` | Rewrite fields of one of your app's own approvals still waiting for a decision, after the records it describes changed. Recorded sign-offs reset and the approval's conversation gets one note. Another app's approval answers `forbidden`; a decided one `not_pending` |
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

**An approval's deadline.** A handler that parks an approval with
`ctx.requestApproval` can set `expiry_hours`, a whole number from 1 to 720,
when it knows its own deadline. It wins over the tool's `approvalExpiryHours`
and the 168-hour default; any other value is refused (`expiry_hours_invalid`)
and nothing is staged.

**Changing an approval through other tools.** A tool whose approval takes no
edit, because what it carries is changed through other tools of the app, lists
them in `editWith` (for example `["drafts_update", "drafts_create"]`). An edit
refused on its approval names those tools, so the editor goes there instead.

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
Other forms of a word, a misspelling of five letters or more, and common French
words for the English words of tool names are found without a keyword:
`factures` finds `facturer`, `refnud` finds `refunds_create`, `rembourser`
finds it too. Add a keyword for a word that is none of these.

```json
"close": {
  "description": "Close a ticket.",
  "searchKeywords": ["fermer", "clôturer", "résoudre"]
}
```

A `bulk` action with an `agentTool` takes `searchKeywords` too. They go to that
agent tool; one agent tool shared by several actions answers to the words of
each.

---

### More tool and app keys

The manifest accepts these keys. Each is checked for its shape when the app registers. A few
are read by nothing yet; declaring one is safe, and it takes effect where its reader lands.

Keys on a tool:

| Key | Value | What it says |
|---|---|---|
| `resultCard` | object | How the tool's result is drawn as a card in chat |
| `runningLabel`, `runningLabelKey` | string | The line shown while the tool runs, and its catalog key |
| `pinnedOptionalOnRefs` | boolean | A call that chains `@ref` tokens stages without the pinned value; needs `pinnedParams` |
| `approvalCard.pill` | `{label, labelKey?}` | A short tag on the approval card |
| `feature` | string | A feature the app declares under `features` |
| `focusCore` | `true` or an entity type | The tool is loaded when the app has the focus, or when that entity is in focus |
| `taintSourceWhen` | `{field, equals}` | Narrows `taintSource` to the rows whose field has that value: a result with one such row marks the turn, rows that all carry another value leave it clean, and a result with no row carrying the field marks it |
| `useInstead` | string | On a hidden tool (`agentVisible: false`): the visible tool of the same app to use |
| `trustBoundary: "internal"` | string | Only code calls the tool: the app's own jobs, event handlers and tools through `ctx.executeTool`, or another app that declares it in `cross_app_calls`. A person (the REST tool route), an agent and an MCP client are refused with `forbidden`. Give a step that must run in one transaction (`atomic: true`) this mark, and call it from a tool or job that holds no transaction while it talks to another service |
| `sinkReadersSelf` | boolean | First-party apps only: what the tool writes (its `writesToTable`) is read only by the person writing it, so a turn that read other data may still write there when that person holds it. Any other app declaring it is not loaded |
| `contentParams` | string list | First-party apps only: the only parameters through which a call carries what the turn read; a call with all of them blank is not held back by what the turn read. Each must be in `params.properties`. Any other app declaring it is not loaded |
| `humanTurnOnly` | boolean | First-party apps only: the tool runs only on a person's own turn (a chat turn they typed, the app, their own MCP client). From a routine, a sub-run or a job it is refused with `human_turn_only` (409) before any approval. Any other app declaring it is not loaded |
| `dmOnly` | boolean | First-party apps only: an agent runs the tool only in its DM with the person. In a shared thread or an approval thread it is refused with `dm_only` (409), whose next step is "Continue in a DM". A person in the app and an MCP client pass. Any other app declaring it is not loaded |

Keys on the app:

| Key | Value | What it says |
|---|---|---|
| `contextProviders` | list of `{on, tool, scope, loadTools?}` | A tool that adds a few lines about a record to the agent's context, while that record is open or is what the conversation is about. `on` lists `<app>:<entityType>` kinds. The tool must be `readOnly`, and `scope` one of its `requiredScopes`. It gets `{subject: {app, entityType, entityId}}` and returns `{lines, source: {label, syncedAt?}}` or null. It runs as the person, only when the turn holds `scope` and the person can read the record, and it may not write. Every provider of a turn shares 1.5 seconds and 2 KB, and keeps at most 10 lines: read your own rows, never a remote API. `loadTools` are loaded for the turn. `CONTEXT_PROVIDERS_DISABLED=1` turns them all off |
| `sendGuardProviders` | `{<kind>: {tool, serviceMessage?, pill?}}` | A read-only tool that can stop an outbound message of that kind |
| `activitySources` | list of `{tool, scope, label, labelKey?, filterKey}` | A tool that lists this app's activity about a set of contacts or a company. The tool must be `readOnly`, ungated and write no table, and `scope` one of its `requiredScopes`. `label` names the source, `filterKey` is its filter value, unique within the app |
| `features` | `{<name>: {adminScope, labelKey, offMessageKey?, offNextKey?}}` | Features an org can switch off. A tool, tab type, slot panel or settings section names one with `feature`; while it is off they are absent, and a call that still names the tool reads `feature_off` with `message` and `next` |
| `outsideTextFields` | string list | Fields a person outside the org can set. A read-only tool whose `returns` names one must declare `taintSource` or `taintSourceWhen` |
| `approvalRoute` | `{<entityType>: <tool>}` | The read-only tool that says who an approval for that entity is for |
| `entities.<type>.discussion` | boolean | One conversation per row, read and written by whoever can read the row; needs a `labelField` and a page (a `views.tabTypes` entry for the type). Open it with `POST /api/threads/entity-discussion`, draw it in a UI bundle with `host.mountEntityDiscussion(node, { entityType, entityId })` (`prefill` puts text in its box, never sent by itself), and delete it with the row through the bridge's `threads_deleteEntityDiscussion` |
| `attention.groupLabel` | `{label, labelKey?}` | The heading over the app's attention items |
| `attention.translations[].label`, `labelKey` | string | The words for an item |
| `attentionItems.passesOn` | boolean | The provider's items may be passed on |
| `routines.<name>.followUp` | boolean | The routine is a follow-up routine |
| `slots.<key>.panels`, `.actions` | list | What an app adds to a slot: each takes `id`, `label`, `component`, `visibility_scope`, `order`, `group`, `feature` |

A slot key takes `position` (the host declaring the slot) or `panels` / `actions` (an app
contributing to it); a key with none of them is refused.

The slots a page offers today, each giving its panel `entityId` (the record on the page):

| Slot | Where it shows |
|---|---|
| `project:task:tabs` | A tab strip on a task, above its discussion |
| `project:task:actions` | The task's meta row |
| `project:detail:panel` | The project page, under its header |
| `contact_detail` | The contact page |
| `ticket:detail:panel` | The ticket's details panel; on a phone, the Customer row under More |
| `ticket:detail:actions` | The ticket's header; on a phone, under More |

`GET /api/v1/slots/<key>` is the one list a page reads: a panel the viewer lacks the
`visibility_scope` for, from an app the org turned off, or naming a feature that is off, is
not in it. `contributions.<key>` (`label`, `component`, `visibility_scope`, `order`) goes
through the same list, with its component name as its id.

`approval:detail:panel` draws a panel inside the approval card of one of the app's own tools:
the contribution names the tool with `for_tool` (`<app>:<tool>`), and the card asks
`GET /api/v1/slots/approval:detail:panel?for_tool=<app>:<tool>`, so the panel shows on that
tool's cards and no other. It receives `approvalId`, `toolName`, `status`, `payload`,
`payloadHash`, `threadId`, `canDecide` and `viewerScopes`. The list is sorted by `order`,
then app name. A panel that throws shows "Panel unavailable" and the page stands; an app
that runs in a sandboxed frame draws its panel inside its frame.

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

- In a frame, `fetch` reaches only your own `/api/apps/<app>/...` routes, and the
  frame has no popups, no token and no network of its own. Use the host calls
  instead (host API 1.5): `getContext()` for the org and the person (never the
  token), `app.openFile(fileId, filename)` to show a file your own tool returned,
  `app.listDocumentTemplates` and `app.printDocuments` for templates and prints,
  `app.listMyApprovals` and `app.decideApproval` for your tools' approvals (the
  host asks the person in its own dialog), `app.editApproval(id, fields)` to change a
  pending approval's editable fields, `app.openExternal(url)` for an https
  page on a host your manifest declares (list outside pages you only link to in
  `network.linkHosts`, image hosts in `network.imageHosts`), and
  `app.openRecord(app, entity, id)` or `app.openApprovals()` for another app's
  record or the approvals queue. Each one also works in the page. Ask in your own
  dialog (the `ConfirmDialog` of `@liaison/app-ui`), never `window.confirm`. The
  limits are in [Sandboxing](app-sandbox.md#host-calls-a-framed-screen-makes).
- Ask for one account's credentials with `app.openConnectDialog({ connectionName,
  identifier, fields })` from `@liaison/host`: the host's own dialog, for that
  account of a multiInstance credentials connection and only those declared
  fields, so what the person types never passes through the app.
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
- A tab that shows one record can be named after it: `app.tabLabel(() => customerName())`
  in the component body. Until the label is known (null) the tab keeps the view's
  `label`. A host without this call keeps the view's label too.
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
(`oauth2` or `credential`). The kernel owns the token lifecycle (refresh
included), and your code never reads the token, the API key or the client
secret: it names the connection on `ctx.fetch` and the host adds the credential
(below). App code that reads a secret fails on the Workers and workerd
executors, the default ones.

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
obtains, caches and drops on a 401), `"basic"` (two credentials fields) or
`"query:<param>"` (the value as a query parameter of the URL that goes out; the
app's own URL never carries it). `grant: "client_credentials"` with `"bearer"`
sends an app token of an oauth2 connection's own OAuth client instead of an
account's: the host posts the client id and secret to the connection's
`tokenUrl` (RFC 6749 client credentials), caches the token and drops it on a 401,
for calls a provider takes from the app itself (an app-level webhook
subscription).

| Provider wants | `auth` |
|---|---|
| An OAuth account's token (refreshed host-side) | `{ connection, identifier?, scheme: "bearer" }` |
| An API key or token field as a bearer | `{ connection, scheme: "bearer", fields: ["apiToken"] }` |
| A key in a named header | `{ connection, scheme: "header:X-Api-Key", fields: ["apiKey"] }` |
| A key as a query parameter | `{ connection, scheme: "query:api_key", fields: ["apiKey"] }` |
| HTTP Basic | `{ connection, scheme: "basic", fields: ["user", "password"] }` |
| A token exchanged from a key pair | `{ connection, scheme: "bearer", exchange: { url, fields: [key, secret] } }` |
| The app's own token (OAuth client credentials) | `{ connection, scheme: "bearer", grant: "client_credentials" }` |

One request carries one connection's credential. A non-secret header a provider
also wants (a customer id) comes from the connection's readable settings.
`identifier` picks the account by its identifier; for an oauth2 connection,
`account` names exactly one account by the id `ctx.accounts.list` gave (the
organization's, or the acting person's own; any other is refused with
`unknown_account`), for when one identifier has both an organization and a
personal account. What your app keeps on an account (`ctx.accounts.setMetadata`) stays
on it when the same owner reconnects the same account. `files_importFromUrl` takes the same `auth` to download a file
with a connection's token the app never holds.
`convert: "xlsx-text"` answers an Excel workbook (up to 10 MB) as text, each sheet
under `Sheet: <name>` then its rows as CSV. A `{ multipart }` body takes `related: true`
(multipart/related, each part only its Content-Type: a JSON metadata part then the
media, as Google's upload API takes them) and parts carrying `base64` bytes.
`configSecrets: { "<placeholder>": "<config key>" }` writes a declared config
secret where the manifest's `secrets` map places it (below), and `ctx.config.has(key)`
tells whether a secret is set without reading it. For the non-secret part of a
credentials connection, `ctx.connections.<name>.getSettings()` returns the fields
the manifest marks `readable: true` and names the missing ones.

Secret-returning calls (`getToken`, `getCredentials`, `ctx.config.get` of a
secret config key) are refused on the Workers and workerd executors, and for
every organization's custom app on any executor
(`secret_not_available_on_workers`). Only the legacy QuickJS executor still
answers them, so they pass its tests and fail in production: never use them.
Instead:

- Mark the non-secret fields of a credentials connection `"readable": true` in
  the manifest (an account id, a scope, a base URL) and read them with
  `readConnectionSettings(ctx.connections, "<name>", [required fields])` from
  `@liaison/app-sdk/connection-credentials` (it checks that a secret field is
  set without reading it).
- Send the secret ones with `ctx.fetch` `auth` (the table above).
- Ask whether an OAuth connection has an account with
  `ctx.connections.<name>.getAccounts()`.
- Verify a webhook with `ctx.config.has(key)` and
  `crypto_verifyHmacForConfig(key, data, signature, "base64" | "hex")`
  ([webhooks](app-webhooks.md)); sign with `crypto_hmacSha256Base64ForConfig`.
- Hand an operator a platform-minted webhook secret (to paste into the sender)
  from a tool: list the key in the tool's `"revealsSecrets"` and answer
  `configSecretReveal(key)` from `@liaison/app-sdk` where the value goes; the host
  writes the value in after the run. Only a connection's
  `webhookSecretConfigKey` may be revealed, never by a custom app; any other
  marker fails with `secret_reveal_refused`.

```ts
import { readConnectionSettings } from "@liaison/app-sdk/connection-credentials"

const settings = await readConnectionSettings(ctx.connections, "billing", ["apiToken", "accountId"])
if (!settings.ok) return { error: { code: "not_connected", message: settings.reason } }
const res = await ctx.fetch(`https://api.billing.example/v1/accounts/${settings.values.accountId}`, {
  auth: { connection: "billing", scheme: "bearer", fields: ["apiToken"] },
})
```

The contract test runs every bundled app's entries on a secret-free bridge (the
Workers executor in process; `SECRET_FREE_EXECUTOR=workerd` runs them in the
workerd sandbox) and fails on any refused read, and no bundled app's source may
name a secret-returning method (`apps/api/src/modules/apps/contract/secret-free.contract.test.ts`).

### Declare where a secret goes

A config secret goes only where the manifest says. Declare each secret config
key that `configSecrets` writes, with the hosts and the one place it goes:

```json
"secrets": {
  "carrierWebhookSecret": {
    "hosts": ["api.carrier.example"],
    "in": "body:subscription.webhookSecret"
  }
}
```

```ts
const placeholder = "__LIAISON_CONFIG_SECRET__carrierWebhookSecret__"
await ctx.fetch("https://api.carrier.example/v1/subscriptions", {
  method: "POST",
  body: JSON.stringify({ subscription: { webhookSecret: placeholder } }),
  configSecrets: { [placeholder]: "carrierWebhookSecret" },
})
```

- `in` is `"header:<Name>"`, `"query:<param>"` or `"body:<json.path>"` (keys joined
  by dots, `[n]` for an array index; the body must be JSON).
- The key must be a secret one of the app's connections declares, and each host
  one of that connection's `allowedDomains` (or of `network.allowedDomains` when the
  connection names none).
- At the call, the placeholder must be the whole value of that header, parameter
  or path, and appear nowhere else: not in another header, field or key, nor in
  the URL. The URL's host, and every redirect hop, must be in `hosts`.
- Anything else fails with `secret_placement_refused` (403) before anything is
  sent. A key with no entry is placed nowhere: an app without `secrets` cannot use
  `configSecrets`.

Connection credentials (`auth`) need no entry: they go only in a request header,
to a host of their own connection. A custom app's connection must name its
`allowedDomains`.

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

### Hash or sign a value

Use WebCrypto, the global `crypto` (`crypto.subtle.digest`, HMAC `sign` and `verify`,
`crypto.getRandomValues`, `crypto.randomUUID`). It works on every executor. Pass text through
`utf8Bytes` and read answers with `bytesToHex` from `@liaison/app-sdk/bytes`, or call
`digestHex("SHA-256", text)` / `hmacHex("SHA-256", key, text)`: the local sandbox has no typed
arrays, and these helpers hide that. What is available: [Hash, sign and draw random values](app-sandbox.md#hash-sign-and-draw-random-values-crypto).

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

A bundled app's egress is also pinned by contract fixtures
(`apps/api/src/modules/apps/contract/fixtures/<app>/`): recorded once against
a provider's sandbox account, replayed in CI. The recorder scrubs each fixture
before writing it: secrets, emails, IPs and phone numbers, then the store's
identity (product titles, SKUs, vendors, handles, customer and company names,
street addresses), each replaced by a stable stand-in derived from its hash,
so a re-recording neither publishes a real catalogue nor churns the fixture.
Read what a recording wrote before you commit it.

A fixture records the entry working. A run that ends in an error or a refusal
(it threw, or answered with an `error`) is not written, and its replay fails
the contract, unless the plan marks it a deliberate negative case:
`expectError: { reason: "..." }` on the step's input, saying why that refusal
is the path worth pinning. A marked fixture whose replay succeeds fails too.
A gated tool is recorded on its approved path: the step's input carries the
`approval` the run re-enters with, and the replay answers `ctx.approval` from
it.

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
when it is unset. The one exception is a custom app, below.

**Custom apps (every edition).** An org admin with `kernel:apps:admin`
installs their own app for their own organization only, with
`POST /api/apps/custom/install` (same body as `/install`: `url` and the grants).
No other organization on the server sees or runs it: not its tools, jobs,
webhooks, events, interface, dashboard sources or MCP tools. This holds on a
self-hosted server too, so on a server with several organizations an app one
of them installs this way stays theirs. An app installed with `/install` (by
the instance operator) is an instance app, shared by every organization, as
before; its name cannot carry an organization key. The rules:

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
- Each one counts toward the organization's custom apps cap (409
  `CUSTOM_APP_LIMIT_REACHED` with `{limit, used}` at the limit). In the managed
  edition the plan sets the cap; on a self-hosted server there is none unless
  the operator sets one (`liaison org caps <org> --custom-apps <n>`).
  Installing a newer version of the same app takes no extra one.
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
- On a server that runs apps on a remote isolate loader, an app built with
  the app builder runs there too, as the Worker module its publish built:
  the package carries it as `worker.js`, and the install checks it against
  the sha256 the publish approved and records it. The loader fetches that
  module from the server with a signed request when it has no copy.
- `ctx.bulk.fetchToBlob` keeps its downloads apart from your organization's
  other apps: 256 MiB per custom app, a shared limit for all custom apps on the
  server, and a download not used for an hour is deleted.
- Its interface (`ui.js`) loads only on your organization's own address, after
  an admin of your organization approved it at install, and always in a
  sandboxed frame: its code never runs in Liaison's page and never holds a
  member's session. A server without organization addresses
  (`LIAISON_ORG_HOST_TEMPLATE` unset) serves no custom app interface; its
  tools, jobs and webhooks still run.
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
- What its handlers write with `ctx.logger` is kept for your organization:
  `GET /api/apps/<name>/logs` returns the newest lines first, for holders of
  `kernel:apps:logs` (admins by default). Query: `since` (an ISO time),
  `level` (the lowest level returned: `debug`, `info`, `warn` or `error`),
  `runId` and `limit` (1 to 200, default 100). One run keeps at most 200 lines
  and 256 KiB, the last line saying when more were dropped; a message is cut
  at 4 KiB and its fields at 8 KiB. Lines are kept 7 days, and at most 10,000
  per app. A line is shown only to a reader whose permissions cover what its
  run had read, and the lines of an app builder preview only to the person who
  ran it. The route still answers an admin while the app is off.

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

**Let people pick a record your search does not index.** A dashboard table's
link cell picks a record of an app ([Keep data in tables](agents/dashboard-tables.md)).
An entity the search index does not hold (a record of an outside service) can
declare `pick: { "tool", "queryParam", "idField", "labelField", "itemsPath"? }`:
`tool` is one of your app's own read tools, `readOnly` and never gated, run as
the person with `{ [queryParam]: <what they typed> }`. Each item of its result
(at `itemsPath`, else the result itself or its only list) gives the record's id
(`idField`) and label (`labelField`). Registration refuses a pick tool that is
not yours, not read-only, gated, or takes no `queryParam`.
`params` (up to 5) are fixed parameters passed beside the query, for a read
that answers several kinds of records (`{ "kind": "task" }`); each must be a
parameter of the tool, never the `queryParam`.

**Back a dashboard table with your records.** A core app (its handlers are
server code) can let a dashboard table's rows be the records of one parent
record, such as a project's tasks: declare `tableBacking: { "parent",
"provider" }` on the entity, where `parent` is another entity of your app and
`provider` an export of your handler module implementing `TableBackingProvider`
(`apps/api/src/modules/dashboards/tables/backing.ts`): the columns a parent
offers, its records the reader can read, a write as the writer, and a stamp
that moves when they change. Each call runs on the reader's own transaction.

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

A preview of a real record needs the record's fileParent row. When your app
writes that row only once a first file is stored on it, declare
`"parentMadeOnPrint": true` in `print`: a person holding the fileParent's
`readScope` can then preview a record that has no row yet. It is accepted only
when the fileParent is a table of your own schema whose rows every holder of
that scope sees (no `dimensions`, `personalScope` or `rlsGovernedByMigration`,
and `readScope` is the table's own `<app>:<rlsScope or table>:read`); otherwise
the manifest is refused with `print_record_tool_invalid`.

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

An item raised this way is stored for each person, so on **Home** it offers **Not now** (`POST /api/attention-items/set-aside` with its `eventId`: it leaves the feed until next Monday at 00:00 in the person's time zone) and **Ask agent to draft**. A `sendGuardProviders` entry's `pill` (`{label, labelKey?}`) names Home's row for a mail about a record of that kind, over the tool's own `approvalCard.pill`.

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

### Ship a routine template

An app ships routine templates in `routines` of the manifest, keyed by template id: `description`, `kind` (`event` or a schedule), `event`, `promptTemplate` and `scopes`. A template can also be a flow: `flow` holds its steps and `eventFilter` its trigger filter, with `{{projectId}}` and `{{status:<label>}}` placeholders filled for the project chosen when the template is enabled. The filled flow is checked against the flow schema then. The Projects app's templates are the worked example; [Routines](agents/routines.md) describes flows, waits and outcomes.

A flow acts on the record that triggered it only when the record's entity declares itself a flow record, in `entities.<entity>.routineFlow`:

- `filterEvents`: the entity's events that take an event filter (container, from and to status, field values). `uncoalescedEvents`: the events that start one run each time, never merged.
- `updateTool` and `commentTool`: this app's write tools behind the flow's actions. `assign`, `set_status` and `set_field` call `updateTool` with `assigneeId`, `statusId` or `fields`; `comment` calls `commentTool` with `body`. Both take the record id as `recordParam`.
- `notifyScope`: a scope of this app, needed to notify anyone but the routine's owner about the record.
- `tabType` and `urlPath` (with `{id}`): where a link to the record opens, and its `{{task.url}}`.
- `readRecords` and `leastLoaded`: exports of the app's server module that read the records and count each person's open records in a container.

The readers run as server code, so only a core app can declare a flow record; registration refuses the declaration of any other app. An entity with no declaration has no flow record: its conditions read nothing and its record actions fail. The Projects task entity is the worked example.

## 13. List what needs attention

An app can also list what needs a person's attention right now (their overdue
tasks, the tickets close to their SLA), with an attention provider: an export
named in `views.attentionItems` of the manifest, `{ "handler": "...", "scope": "..." }`.
It returns attention items for the person in `ctx.actor`.

The feed never calls the provider. Liaison runs it in the background when what
it lists may have changed, and stores what it returns, one list per person:

- after a run of the app that may write (an event handler, a job, a webhook, a
  tool not declared `readOnly`); a read-only tool, a search, an export or a
  preview wakes nothing,
- after an event of the app is delivered,
- on the attention minute tick: the next minute in a workspace where something
  changed, at least every 10 minutes otherwise. Items that only time changes
  (a deadline coming closer) appear on that tick.

These runs are background jobs on their own queue, never part of a request.
Wakes of one app in one workspace are grouped: the provider runs at most once
every 15 seconds for them, after the writes they follow, and a workspace runs a
limited number of refreshes and provider runs a minute. A newer list is never
replaced by an older run that finished later.

A refresh runs the provider only for the people who are around: online now, or
who read their feed in the last 30 minutes. When someone comes back, their
first feed read recomputes their lists. A stored list older than 30 minutes is
not shown meanwhile, since it may no longer be true (a dated item past its day,
a task done since): the feed shows the app's items once the new list is stored,
and the person's devices reload it then.

Each run replaces the person's whole list, so an item the provider no longer
returns is cleared. A person without the provider's scope gets an empty list. A
failed run keeps the last list and shows the error in the feed.

## 14. Approval card summaries

A gated tool's `summarizer` builds the approval card. It runs once when the
request is made, and again when the request's parameters are edited
(`approval_update_payload` or the card's editor). The summary is stored with the
request; the card, the approvals list, Home and the agent read the stored text
and never run the summarizer. A request with no stored summary (an older one)
shows a generic summary of its parameters. While it still awaits a decision,
the server stores the real one in the background, a few at a time; a decided
request keeps the generic summary.

A summarizer is pure: it reads the call's parameters, never a record. To show
the record a call acts on, declare `summarizerContext` on the tool:
`{"tool": "<an ungated read tool of your app>", "params": {"<read param>":
"<dot-path in the call's params>"}}`. Liaison runs that read as the person who
asked, just before the summarizer, and passes its result as `meta.context`
(the third argument); a failed read passes `null`, so the card degrades to the
parameters. Add `"when": "<dot-path>"` to run the read only when that path of
the call's parameters holds a value.

## 15. Serve a page of your own

Some screens cannot sit in the app's panel: a provider's picker that loads the
provider's own scripts, a page opened in a popup or the system browser. Declare
it as a page, with the routes it calls:

```json
"pages": {
  "picker": {
    "source": "pages/picker.ts",
    "title": "Choose files",
    "scope": "my-app:files:read",
    "routes": ["savePicks"],
    "hosts": { "script": ["apis.example.com"], "frame": ["docs.example.com"] }
  }
},
"pageRoutes": {
  "savePicks": { "handler": "savePicks", "scope": "my-app:files:write" }
}
```

- Open it for one person who holds the page's `scope`. From a handler acting for them
  (a tool), `ctx.pages.link("picker", params)` answers a handle (`lpg_...`), not a
  URL: return it to the person, and their signed-in app turns it into a link with
  `POST /api/apps/<app>/pages/open` `{ "handle": "lpg_..." }`. Your app's code never
  holds a link it could open as the person. A tool that answers a handle shows an Open button under its call
  in a conversation; your own screen opens one with `POST /api/apps/<app>/pages/open`
  through `@liaison/host` `fetch`, then opens the returned URL in a new window. From your panel, the person's browser can
  also ask `POST /api/apps/<app>/pages/<page>/link` (no `params`: it refuses them).
  A handle and a link each work once, for 5 minutes; a person gets at most 20 per app
  every 10 minutes.
- `pages/picker.ts` is built for the browser into `pages/picker.js` in the package.
  It runs once the document is parsed, so its `#root` element exists.
  The page reads `window.liaisonPage.params` and calls a route with
  `await window.liaisonPage.call("savePicks", body)`.
- A route runs your handler as that person, with their scopes, under the route's
  `scope` too: `savePicks({ body, params, page }, ctx)`. `body` comes from the
  browser, `params` from your own `ctx.pages.link` call. Check every id in either
  against what the person may read or change: the route acts as them. The page may
  call only the routes it lists, at most 60 calls a minute; bodies and answers are
  capped at 1 MiB. A page session lasts 20 minutes, and each call is audited.
- A route can tell the conversation the page was opened from what happened: add
  `pageResult: { summary, data }` to its answer (`summary` 1 to 500 characters,
  `data` a JSON object of at most 8 KiB). When a tool minted the page during an
  agent's turn, Liaison posts `summary` in that conversation as a line from the
  person, gives the agent `data`, and runs one turn of that agent so it carries
  on. The page itself never receives `pageResult`; a page opened from Settings or
  your panel posts nothing.
- A page that needs a provider widget in the person's browser with their own grant
  (Google's file picker) ships no script: it declares
  `"widget": { "kind": "google-picker", "connection": "<oauth2 connection>", "route": "<its route>", "tokenScopes": [...] }`
  and Liaison serves the page itself. Mint its link with
  `ctx.pages.link(page, { account: "<account id>", apiKey, appId })`. Your code never
  receives the account's token: Liaison's own script runs the widget and your route
  receives only what the person chose (`{ add: [{ id, name, mimeType }] }`).
  The account must be the person's own, or the organization's when they hold the
  connection's admin scope; its granted scopes must all be in `tokenScopes` (plus
  sign-in scopes), else the page answers 403 and does not open. `tokenScopes` must be
  scopes of the connection and none of its restricted ones. The page opens only on the
  workspace's own address, each opening is audited, and the install screen lists it
  under the pages that put a connected account's access in your browser.
- A route call carries the page session's key, which only the page's bootstrap
  holds (it is never in `liaisonPage` or the document), so a session id copied out of
  the page calls nothing.
- The page's policy allows only the hosts it declares (`script`, `frame`, `connect`,
  `image`, `style`), narrowed to the domains the install was granted. With app frame
  origins it runs on the app's own origin; without, in an opaque origin: it never
  sees the workspace's cookies or storage.

## 16. Set your app up from a config file

An admin sets your app up with `liaison config apply` when you declare
`provisioning`:

```json
"provisioning": {
  "schema": { "type": "object", "properties": { "folders": { "type": "array" } } },
  "handler": "provision",
  "verify": "verifySetup"
}
```

The config file then carries the block under the app:

```yaml
apps:
  - name: my-app
    enable: true
    provision:
      folders: ["Contracts", "Invoices"]
```

- `config apply` checks the block against `schema` (a mismatch stops the run before
  anything is written), then runs `provision({ config, dryRun: false }, ctx)` once the
  app's connection is set up. Store what you set up in your own data
  (`ctx.store`, your schema) and return `{ changed: [...] }`, one line per change;
  an empty list reads as already set.
- `config verify` runs `provision` with `dryRun: true` (write nothing, return what
  would change: any line is DRIFT), then `verify({ config }, ctx)` when declared,
  which answers `{ ok, problems?, identity? }` from a live check, such as one call
  through your connection.
- `verify` is also your connection's health check: `config verify` and
  `config apply` run it for an app whose connection the config file sets, even
  with no `provision` block (`config` is then `{}`). An app without `verify`
  reports `SKIPPED` there.
- Both run as your app (its own scopes), like a job.

## 17. Bring your own OAuth client

An `oauth2` connection's client is found by its key, `<app>:<connection>`:
the workspace's own client first (Settings, or `config apply`), then one the
server provides in `LIAISON_OAUTH_<KEY>_CLIENT_ID` and `LIAISON_OAUTH_<KEY>_CLIENT_SECRET`
(the key upper-cased, `-` and `_` as `_`, the `:` as `__`: `my-app:crm` reads
`LIAISON_OAUTH_MY_APP__CRM_CLIENT_ID`; a key with an uppercase letter, a doubled
separator or a separator at either end of a part has no such pair). Two connections share one client by naming
the same key, in your app's own namespace:

```json
"connections": {
  "read": { "type": "oauth2", "oauthClient": { "key": "my-app:google" }, "...": "..." },
  "write": { "type": "oauth2", "oauthClient": { "key": "my-app:google" }, "...": "..." }
}
```

## 18. Offer a knowledge source

An app can feed Knowledge: a person adds a synced source of the app's kind, and
Liaison keeps its documents up to date. Declare the kind in the manifest:

```json
"knowledgeSources": {
  "notes": {
    "title": "Notes",
    "handler": "syncNotes",
    "readScope": "my-app:notes:read",
    "configSchema": {
      "type": "object",
      "properties": { "folder": { "type": "string" } },
      "required": ["folder"]
    },
    "timeoutMs": 30000
  }
}
```

- `handler`: the export Liaison wakes for each page of a sync.
- `readScope`: a scope of your app the person must hold to add the source.
  Liaison checks it again before every sync, for the source's owner.
- `configSchema`: the JSON Schema of a source's settings, checked when the
  source is added (`POST /api/knowledge/synced-sources` with `appName`,
  `sourceKind` and `sourceConfig`; `GET /api/knowledge/synced-sources/kinds`
  lists the kinds a person may add). An agent adds one with
  `knowledge__add_folder_source` (`source`: your app, `kind`); the `ref` it
  passes becomes the config `{ ref }`, and the same ref finds the same source.
- `timeoutMs`: one page's time limit, 60 s when absent, at most 120 s.

The handler gets `{ sourceId, kind, config, cursor, scope }` (`scope`: `personal`
for one person's source, the run then acting for them, or `organization`) and
returns one page:

```ts
import type { KnowledgeSyncInput, KnowledgeSyncResult } from "@liaison/app-sdk"

export async function syncNotes(input: KnowledgeSyncInput<string>, ctx): Promise<KnowledgeSyncResult<string>> {
  const res = await ctx.fetch(`https://api.example.com/notes?after=${input.cursor ?? ""}`, {
    method: "GET",
    auth: { connection: "main", scheme: "bearer", fields: ["token"] },
  })
  return {
    documents: {
      upsert: res.notes.map((n) => ({ externalId: n.id, title: n.title, body: n.text, rev: n.version })),
      delete: res.deletedIds,
    },
    nextCursor: res.next ?? null,
    done: !res.next,
  }
}
```

- Liaison writes the page and `nextCursor` together, then wakes the handler
  again with that cursor until `done`. Keep nothing between pages in module
  state: the cursor is the only memory.
- A sync job runs up to 25 pages or 60 s, then hands the rest to a new job. A
  page that fails is retried from the same cursor: the documents already
  written stay, nothing is written twice.
- The cursor of the last page is kept. The next sync starts from it, so an
  incremental cursor (a change token, an "updated after" date) syncs only what
  changed. Return `nextCursor: null` on the last page to start over each time.
- `documents.delete` archives documents by `externalId`. `prune: true` on the
  last page archives every document of the source that this pass did not
  return, for a source that lists everything each time.
- Per page: at most 200 documents, 1000 deletes, a body of 1,000,000 characters
  and a cursor of 16 KB of JSON. A page past these limits is refused, nothing of
  it is written, and the source shows the reason.

Documents land in the source's collection, owned like any synced document: an
organization source's documents follow its sensitivity, a personal source's
stay with its owner.

### File documents in folders

A source can keep its own folder tree: each folder is a collection under the
source's collection. Declare folders in the page, and file a document with
`folderId` (a declared folder) or `folderPath` (a path of names):

```ts
return {
  folders: {
    upsert: [
      { externalId: "f-12", name: "Guides" },
      { externalId: "f-34", name: "Setup", parentExternalId: "f-12" },
    ],
    delete: ["f-56"],
  },
  documents: {
    upsert: [
      { externalId: "n-1", title: "Install", body: "...", folderId: "f-34" },
      { externalId: "n-2", title: "API", body: "...", folderPath: "reference/api" },
    ],
  },
  nextCursor: null,
  done: true,
}
```

- A folder is found again by its `externalId`: a new `name` renames it, a new
  `parentExternalId` moves it with everything inside. Without a parent, it sits
  directly in the source's collection. A parent must be a folder of the same
  source, declared in this page or an earlier one, and a folder never moves
  into its own subfolder.
- `folderPath: "reference/api"` makes the folders `reference` and
  `reference/api` (their external ids are the path up to them). A page may
  declare one of those ids itself to give it another name.
- A document with a new `folderId` or `folderPath` moves; without either, it
  sits in the source's collection.
- `folders.delete` archives a folder, its subfolders and the source's
  documents still filed in them.
- A folder that loses its last document or subfolder is archived, unless the
  same page declares it. Filing something in it again brings it back. With
  `prune: true`, the last page also archives the empty folders the pass
  neither declared nor filed anything in. A folder that holds something a
  person filed there is kept.
- Folders are written with the page, in the same transaction: a page that is
  refused, or that another run got to first, changes no folder.
- Per page: at most 500 folders (those paths add included), 1000 folder
  deletes, and paths 32 folders deep.


Your own code manages your sources with `ctx.knowledge_appSource` (reads: `get` one by
`kind`, `ref`, `scope` and `account`, `list` the ones the run may see) and
`ctx.knowledge_appSourceWrite` (`ensure` one, created with the acting person's Knowledge
rights or reactivated; `sync` one now; `purgeAccount` the content your sources synced
through a disconnected account of your app, read from the kernel row), each a JSON string in
and out, pinned to your app. A folder `add_folder_source` names (`ref`) goes to your `folder`
kind when you declare one, with config `{ ref }`.

### Search and live links without a sync

An app can also let Knowledge reach its items without copying them: in
federated search, as live source links, and when an agent reads a remote hit.
Declare `knowledgeItems` in the manifest:

```json
"knowledgeItems": {
  "search": "searchNotes",
  "resolve": "resolveNote",
  "readScope": "my-app:notes:read",
  "searchByDefault": true,
  "timeoutMs": 10000
}
```

- `search` gets `{ query, limit, cursor }` and returns
  `{ results: [{ id, title, entity, snippet, url, modifiedAt }], nextCursor }`.
  Each `id` is the item's reference.
- `resolve` gets `{ ref, content }` (a reference `search` returned, or one a
  source link stored) and returns `{ found: true, title, url, modifiedAt }`,
  plus `text` when `content` is true and the item has text. Return
  `{ found: false }` when the item is gone or the person cannot see it. Throw
  for anything else (an outage, a revoked token): a link then stays as it was
  instead of going stale.
- Both run for the person searching or linking, through their own account of
  your app's connection, and only for people who hold `readScope`.
- `searchByDefault: false` keeps your app out of federated search until an
  admin turns it on (`PATCH /api/knowledge/sources/<your app>` with
  `{ "broadSearchEnabled": true }`).
- `knowledge__source_link_create` with `source` set to your app's name and
  `externalId` set to a reference stores a live link; verify and refresh ask
  `resolve` again.
- `timeoutMs`: one run's time limit, 5 s when absent, at most 10 s.


## See also

- [`docs/app-package-format.md`](app-package-format.md) — the `.liaisonapp` spec
- [`docs/app-sandbox.md`](app-sandbox.md) — the sandbox runtime internals
- [`docs/sdk-gaps.md`](sdk-gaps.md) — the SDK gap log
- [`docs/database-connector.md`](database-connector.md) — the `database` connector (read-only DB access for the agent), a catalog app reading through platform-held SQL connections (`ctx.sql`)
- [`docs/api-connector.md`](api-connector.md): the `api-connector` app (an HTTP API described by an adapter file, for a CRM or ERP), same in-tree host-side bridge shape; adapters are written with the `api-connector-authoring` skill
- `apps/api/test-support/apps/example/` — the reference app
