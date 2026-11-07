// SPDX-License-Identifier: FSL-1.1-ALv2
// Reference app — demonstrates every Liaison SDK surface in the smallest
// possible code. Each handler is a teaching artifact; see README.md for what
// each one demonstrates.
//
// Handlers receive `(params, ctx)` where `ctx` is the real `AppContext` from
// `@liaison/app-sdk` — the exact contract a sandboxed app runs against. Each
// tool in app.manifest.json maps to a named export here by its `handler` string.
// Type-only: an app that runs in the sandbox from source has no module loader,
// so its handler file imports nothing at run time.
import type { AppContext } from "@liaison/app-sdk"

interface Item {
  id: string
  text: string
  orgId: string
}

/** SDK surface: ctx.db — list persisted items. */
async function items_list(
  _params: Record<string, unknown>,
  ctx: AppContext,
): Promise<{ data: Item[] }> {
  const rows = await ctx.db.findMany("items", { where: { orgId: ctx.orgId } })
  return { data: rows as Item[] }
}

/** Manifest `feature`: this tool exists only in an org where `item_notes` is on. */
async function item_notes_count(
  _params: Record<string, unknown>,
  ctx: AppContext,
): Promise<{ count: number }> {
  const rows = await ctx.db.findMany("items", { where: { orgId: ctx.orgId } })
  return { count: rows.length }
}

/**
 * Manifest `contextProviders`: a read-only tool the agent's context calls while
 * an item is in view. It returns a few short lines and where they came from,
 * or null; the host fences them and keeps the total small.
 */
async function item_context(
  params: { subject: { entityId: string } },
  ctx: AppContext,
): Promise<{ lines: string[]; source: { label: string } } | null> {
  const [row] = (await ctx.db.findMany("items", {
    where: { id: params.subject.entityId, orgId: ctx.orgId },
  })) as Item[]
  if (!row) return null
  const all = await ctx.db.findMany("items", { where: { orgId: ctx.orgId } })
  return {
    lines: [`Item text: ${row.text}`, `Items in this workspace: ${all.length}`],
    source: { label: "Example items" },
  }
}

/** SDK surface: ctx.db + ctx.emit — persist an item and emit a domain event. */
async function items_create(params: { text: string }, ctx: AppContext): Promise<{ id: string }> {
  const { id } = await ctx.db.insert("items", { text: params.text, orgId: ctx.orgId })
  await ctx.emit({ entity: "item", action: "created", entityId: id, data: { text: params.text } })
  return { id }
}

/** SDK surface: ctx.connections + ctx.fetch — call an external API with a token. */
async function external_fetch(
  _params: Record<string, unknown>,
  ctx: AppContext,
): Promise<{ ok: boolean; status: number }> {
  const token = await ctx.connections.exampleApi?.getToken()
  const res = await ctx.fetch("https://api.example.com/ping", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
  return { ok: res.status >= 200 && res.status < 300, status: res.status }
}

/** SDK surface: ctx.resolveContact — resolve or create a contact by email. */
async function resolve_contact(
  params: { email: string },
  ctx: AppContext,
): Promise<{ contact: unknown }> {
  const contact = await ctx.resolveContact({ email: params.email })
  return { contact }
}

/**
 * SDK surface: scheduled job — declared in the manifest with a cron schedule.
 * Counts items, records a summary, emits a `summary:computed` event, and uses
 * the structured logger.
 */
async function nightly_summary(
  _params: Record<string, unknown>,
  ctx: AppContext,
): Promise<{ itemCount: number }> {
  const items = await ctx.db.findMany("items", { where: { orgId: ctx.orgId } })
  const itemCount = items.length
  await ctx.db.insert("summaries", { orgId: ctx.orgId, itemCount, computedAt: new Date() })
  await ctx.emit({ entity: "summary", action: "computed", data: { itemCount } })
  ctx.logger.info("nightly summary computed", { itemCount })
  return { itemCount }
}

/** Handler bundle keyed by the manifest's `handler` strings. */
const handlers = {
  item_context,
  item_notes_count,
  items_list,
  items_create,
  external_fetch,
  resolve_contact,
  nightly_summary,
}

// One export block at the end: the sandbox runs this file from source as a
// script, and turns this block (and only this shape) into its named handlers.
export {
  external_fetch,
  handlers,
  item_context,
  item_notes_count,
  items_create,
  items_list,
  nightly_summary,
  resolve_contact,
}
