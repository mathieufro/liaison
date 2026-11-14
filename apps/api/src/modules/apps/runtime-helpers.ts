// SPDX-License-Identifier: FSL-1.1-ALv2
import type { ActorContext } from "~/db/rls"
import { hasScope } from "~/modules/permissions/permissions"

/**
 * Per-app scope alias provider registry.
 *
 * An app may register a function here (keyed by its app name) that receives
 * the current scope array and returns an augmented copy. This is the
 * extension point for apps that maintain historical scope aliases — e.g. an
 * app whose legacy schema uses a different scope name from the one declared
 * in the manifest. The kernel runtime calls the registered provider for an
 * app before invoking any of its handlers.
 *
 * Using this registry instead of inline `appName === "..."` branches in
 * `withAppDimensionAliases` keeps the kernel free of app-specific logic.
 * Each app registers its own aliases in its manifest descriptor or at
 * install time.
 *
 * TODO (app-side follow-up): move the tickets scope alias registration below
 * into the tickets app's manifest-descriptor.ts once descriptor install hooks
 * support scope alias registration.
 */
export const appScopeAliasProviders = new Map<string, (scopes: string[]) => string[]>()

// Built-in tickets scope aliases: `tickets:tickets:read` → `tickets:messages:read`
// and `tickets:tickets:write` → `tickets:messages:write`. These exist because the
// messages sub-resource historically shared permissions with the parent tickets
// scope. The tickets app owns this mapping; this kernel-side registration is
// temporary pending an app-side descriptor hook (see TODO above).
appScopeAliasProviders.set("tickets", (scopes: string[]): string[] => {
  const out = [...scopes]
  if (hasScope("tickets:tickets:read", out) && !hasScope("tickets:messages:read", out)) {
    out.push("tickets:messages:read")
  }
  if (hasScope("tickets:tickets:write", out) && !hasScope("tickets:messages:write", out)) {
    out.push("tickets:messages:write")
  }
  return out
})

// Built-in shopify scope alias: any shopify-scoped actor also gets `shopify:internal:read`.
// EVERY shopify tool calls getShopifyClient, which reads the app-internal `install_metadata` row
// (its `rlsScope: "internal"` → the generated RLS read policy gates on `shopify:internal` /
// `:internal:read` / `shopify:*`) to resolve the shop domain + API version + connection. A user
// holding only granular shopify scopes (e.g. `shopify:orders:read`) could NOT read that infra row,
// so every shopify tool failed closed with "install_metadata row not found" — a real gap masked in
// practice by the admin's `*`. The `internal` tables are app infrastructure (install metadata, staff
// mirror, webhook log); aliasing READ is safe, while WRITES stay gated (`shopify:internal:write` /
// the system actor). Mirrors the tickets sub-resource alias above.
appScopeAliasProviders.set("shopify", (scopes: string[]): string[] => {
  const out = [...scopes]
  const hasAnyShopify = out.some((s) => s === "*" || s === "shopify" || s.startsWith("shopify:"))
  if (hasAnyShopify && !hasScope("shopify:internal:read", out)) {
    out.push("shopify:internal:read")
  }
  return out
})

// Built-in boxtal scope alias — same shape as shopify above. Every boxtal tool resolves the app's
// connection via the `install_metadata` / internal infra rows (`rlsScope: "internal"` → the RLS read
// policy gates on `boxtal:internal` / `:internal:read` / `boxtal:*`). A user holding only granular
// boxtal scopes (e.g. `boxtal:shipments:write`) could not read that infra row, so every boxtal tool
// failed closed. Aliasing READ is safe (app infrastructure); writes stay gated.
appScopeAliasProviders.set("boxtal", (scopes: string[]): string[] => {
  const out = [...scopes]
  const hasAnyBoxtal = out.some((s) => s === "*" || s === "boxtal" || s.startsWith("boxtal:"))
  if (hasAnyBoxtal && !hasScope("boxtal:internal:read", out)) {
    out.push("boxtal:internal:read")
  }
  // Alias the CATALOG READ to any boxtal-scoped actor, same rationale as internal:read above. The
  // shipping catalog (`shipping_profile` / `pack` / `pack_component`, `rlsScope: "catalog"`) is shipping
  // INFRA the resolver consults on EVERY draft/quote/to_prepare/create_shipment: shipment_draft_create,
  // quote, and to_prepare_list all `findMany("shipping_profile")` to pack each line into a parcel. An
  // actor holding only `boxtal:shipments:read`/`:write` (e.g. ops_lead Nadia, who AUTHORS+OWNS the
  // fulfillment-prep routines — a routine runs as its owner, so the tick reads the catalog under her
  // scopes) could NOT read those rows, so the resolver saw ZERO profiles and reported EVERY shippable
  // line as `no_profile` ("Unresolved pack") — a degenerate prepare queue (the end-of-day-handoff
  // runtime gate's intermittent FAIL). Reading the pack-template catalog is required to ship at all;
  // aliasing READ is safe (it's reference data, like internal infra), while catalog WRITE
  // (`settings_*`/profile edits) stays gated on `boxtal:catalog:write`.
  if (hasAnyBoxtal && !hasScope("boxtal:catalog:read", out)) {
    out.push("boxtal:catalog:read")
  }
  // boxtal:catalog:write OR boxtal:shipments:write grants boxtal:internal:write. Unlike shopify/pennylane
  // (whose `internal` tables are connection INFRA — install_metadata/credentials, host-managed, never
  // agent-writable), boxtal's only agent-writable `internal` entity is `app_config` (rlsScope:internal),
  // which stores USER CONFIG: the ship-from `sender_address` (set via `settings_sender_address_set`, scope
  // boxtal:catalog:write) and the `draft_override:*` rows. Without this, those INSERT/UPDATEs on app_config
  // fail closed — "new row violates row-level security policy for app_config (42501)".
  //
  // The `draft_override:*` rows are SHIPMENT-DRAFT state: `shipment_draft_set_package` (ad-hoc carton /
  // parcel dims) and `shipment_draft_set_customs` (per-line HS-code edits) persist deltas that the GATED
  // create_shipment re-merges onto the re-derived draft. That flow is authorized by boxtal:shipments:write
  // (the scope that gates create_shipment), so an actor holding shipments:write but NOT catalog:write — e.g.
  // a SUPPORT agent staging a warranty RETURN label (mason-reed-rma-firmware-warranty-flow) — must also get
  // internal:write, else set_package 42501s and the draft can never resolve (the missing_weight block can
  // never be lifted), dead-ending the return-label staging the RMA exists to produce. Catalog:write alone
  // (no shipments:write) still grants it too, so the sender-address onboarding path (l378) is unchanged.
  // The connection/credential rows are NOT boxtal manifest entities, and no agent TOOL writes
  // webhook_delivery/subscription, so this only authorizes the user-config + draft-override writes the
  // settings/draft tools legitimately make.
  if (
    (hasScope("boxtal:catalog:write", out) || hasScope("boxtal:shipments:write", out)) &&
    !hasScope("boxtal:internal:write", out)
  ) {
    out.push("boxtal:internal:write")
  }
  return out
})

// Built-in pennylane scope alias — same shape as shopify/boxtal above. Pennylane's `app_config`
// (`rlsScope: "internal"`) holds the connect-probe verdict (connection_scope / cash_status) that
// every reports/cash read tool consults via `getConfig`, but those tools hold only granular
// `pennylane:reports:read` / `:cash:read` — so the internal `app_config` RLS (gated on
// `pennylane:internal` / `:internal:read` / `pennylane:*`) failed closed and the scope/cash-descope
// check silently defaulted ([[BL-189]]). Alias READ so any pennylane-scoped actor can read the app's
// own infra row; writes (the connect-probe persist) run privileged in the connection event handler,
// so they stay gated.
appScopeAliasProviders.set("pennylane", (scopes: string[]): string[] => {
  const out = [...scopes]
  const hasAnyPennylane = out.some(
    (s) => s === "*" || s === "pennylane" || s.startsWith("pennylane:"),
  )
  if (hasAnyPennylane && !hasScope("pennylane:internal:read", out)) {
    out.push("pennylane:internal:read")
  }
  return out
})

// Payments connector scope alias, same shape as pennylane's: its internal tables (`sync_state`,
// `install_metadata`, `webhook_deliveries`, `rlsScope: "internal"`) hold the connection state and
// the sync progress every read surface shows, so any holder of one of the app's scopes reads them.
// Writes to them stay with `stripe:internal` (webhook, sync and connection handlers).
appScopeAliasProviders.set("stripe", (scopes: string[]): string[] => {
  const out = [...scopes]
  const hasAny = out.some((s) => s === "*" || s === "stripe" || s.startsWith("stripe:"))
  if (hasAny && !hasScope("stripe:internal:read", out)) out.push("stripe:internal:read")
  return out
})

// Built-in invoicing scope alias — same shape as shopify/pennylane above. The deferred parks
// (`deferred_events`, `rlsScope: "internal"`) say why an order or a credit note waits (a missing
// e-invoicing identity, a tax decision); the readiness view and `deferred_list` show them to the
// issuer, who holds only granular invoicing scopes. Alias READ only: parks are written by the
// system actor (event handlers and the retry job), so `invoicing:internal:write` stays gated.
appScopeAliasProviders.set("invoicing", (scopes: string[]): string[] => {
  const out = [...scopes]
  const hasAnyInvoicing = out.some(
    (s) => s === "*" || s === "invoicing" || s.startsWith("invoicing:"),
  )
  if (hasAnyInvoicing && !hasScope("invoicing:internal:read", out)) {
    out.push("invoicing:internal:read")
  }
  return out
})

/**
 * The scopes an app's grantable scopes reach in the RLS context once the app's
 * scope alias provider is applied, each grantable scope taken alone (a role may
 * hold any one of them). The registration's reachability check reads this, so
 * a table an alias makes reachable is not reported as unreachable.
 */
export function grantableScopesWithAppAliases(appName: string, scopes: string[]): string[] {
  const provider = appScopeAliasProviders.get(appName)
  if (!provider) return scopes
  return [...new Set(scopes.flatMap((s) => provider([s])))]
}

/**
 * Apply per-app dimension and scope aliases the runtime expects when invoking
 * an app-scoped handler with a user actor.
 *
 * - Mirrors bare dimension keys (no `:`) under `<appName>:<key>` so app handlers
 *   can look up dimension grants without re-parsing.
 * - Applies any scope alias provider registered in `appScopeAliasProviders` for
 *   the given app. Apps that maintain historical scope aliases register their
 *   provider there; the kernel code here remains app-agnostic.
 *
 * Returns a new ActorContext (does not mutate). Non-user actors are returned
 * unchanged since their permission model does not use dimension grants.
 */
export function withAppDimensionAliases(actor: ActorContext, appName: string): ActorContext {
  if (actor.actorType !== "user") return actor
  const dimensionGrants = { ...actor.dimensionGrants }
  for (const [key, values] of Object.entries(actor.dimensionGrants)) {
    if (!key.includes(":")) dimensionGrants[`${appName}:${key}`] = values
  }
  const scopeAliasProvider = appScopeAliasProviders.get(appName)
  const scopes = scopeAliasProvider ? scopeAliasProvider([...actor.scopes]) : [...actor.scopes]
  return { ...actor, scopes, dimensionGrants }
}

/**
 * The scopes a non-core app acts with when it runs as itself (a system or
 * cross-app event, a poll, a reconcile, a search, a knowledge sync): its own
 * namespace plus the scopes its manifest declares, which its install granted.
 * The same for every app, first-party or not: an RLS session, never a handle
 * that bypasses row-level security.
 */
export function appSelfScopes(appName: string, declared: readonly string[] | undefined): string[] {
  return [...new Set([`${appName}:*`, ...(declared ?? [])])]
}
