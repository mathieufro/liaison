# example — Liaison reference app

The canonical "every-feature" sample app. It exists to be read: each handler
demonstrates exactly one SDK surface in the smallest possible code. Both
`docs/app-development.md` and the `creating-an-app` Claude skill point here.

It is a real in-tree app — auto-discovered at startup, packageable with
`bun run app:freeze example`.

## What each handler teaches

| Handler | SDK surface | What to copy from it |
|---|---|---|
| `item_notes_count` | manifest `feature` | A tool that exists only where its feature is on: top-level `features` declares it, `kernel.org_app_features` switches it per org |
| `item_context` | manifest `contextProviders` | A read-only tool that gives the agent a few lines about the item in view: it returns `{lines, source}` or null, and the host fences the lines, keeps them under 2 KB and records the scope |
| `items_list` | `ctx.db.findMany` | Reading your app's entity rows, scoped to the org |
| `items_create` | `ctx.db.insert` + `ctx.emit` | Persisting a row and emitting a domain event |
| `external_fetch` | `ctx.connections` + `ctx.fetch` | Calling an external API with a connection token |
| `resolve_contact` | `ctx.resolveContact` | The contacts integration surface |
| `nightly_summary` | manifest `jobs` + `ctx.emit` | A scheduled (cron) background job |
| (no handler) | manifest `slots` | A panel or action on each host slot (task tabs and actions, project, contact, ticket panel and actions), shown only to holders of `example:items:read` and only where the `slot_panels` feature is on |
| (no handler) | `entities.items.discussion` + `views.tabTypes.items` | One discussion per item, readable by whoever can read the item: `POST /api/threads/entity-discussion`, or `host.mountEntityDiscussion` in a UI bundle. Delete it with the item through `threads_deleteEntityDiscussion`, and prune its seats through `threads_pruneEntityDiscussion` when an item's sharing narrows |

## Layout

| File | Purpose |
|---|---|
| `app.manifest.json` | Entity schema, tools, events, the `nightly_summary` job, scopes |
| `manifest-descriptor.ts` | TS descriptor — wraps the manifest + handler bundle path |
| `handlers.ts` | The five teaching handlers |
| `handlers.test.ts` | One test per handler, driven by `mockAppContext` |

The matching frontend panel lives at `apps/web/src/modules/example/`.

See [docs/app-development.md](../../../../../docs/app-development.md) for the
full developer guide.

## Connecting

**No connection required** — the example app declares no `connections` block; its
`external_fetch` handler demonstrates the outbound-fetch surface without a
stored credential. For the shared connection machinery real connectors use, see
[docs/connecting-apps.md](../../../../../docs/connecting-apps.md).
