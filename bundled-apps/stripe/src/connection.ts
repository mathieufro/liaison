// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The connection's life and its key check.
//
// STATE. One row in `install_metadata` holds where the connection stands:
//   not_connected -> key_stored -> waiting_first_event -> importing -> connected
// with an overlay that can sit on any of them: `partial` (some permission is
// missing, the rest works), `key_invalid` (Stripe refuses the key), `stalled`
// (no event for too long), `different_account` (Stripe answered 404 for a known
// object and the same account could not be confirmed: nothing is written until a
// person checks the key). The text column holds `<base>` or `<base>+<overlay>`.
//
// THE CHECK. One read per permission of the default key, in a fixed order, and
// a refund probe on a charge that cannot exist (`ch_liaison_probe`): Stripe
// answers 404 when the key may write refunds and 403 when it may not, so
// nothing is ever created. The key itself never enters this code: the host adds
// it to each request (`stripeFetch`).
//
// ANOTHER ACCOUNT. When the mirror already holds rows, up to 3 of their ids are
// read back first. If every one answers 404, the key belongs to another account
// (or the other mode): the check refuses with `different_account` and changes
// nothing, so the mirror is never mixed with a second account's data. The same
// holds for a key of the other mode (`mode_changed`).
import { refuseTool, type ToolRefusal } from "@liaison/app-sdk/errors"
import { StripeApiError, type StripeHttpCtx, stripeFetch } from "./http"
import { isStandInInstall, STANDIN_MARKER } from "./standin"

export const BASE_STATES = [
  "not_connected",
  "key_stored",
  "waiting_first_event",
  "importing",
  "connected",
] as const
export type BaseState = (typeof BASE_STATES)[number]

export const OVERLAYS = ["partial", "key_invalid", "stalled", "different_account"] as const
export type Overlay = (typeof OVERLAYS)[number]

export interface ConnectionState {
  base: BaseState
  overlay: Overlay | null
}

export function encodeState(s: ConnectionState): string {
  return s.overlay ? `${s.base}+${s.overlay}` : s.base
}

export function decodeState(text: unknown): ConnectionState {
  if (typeof text !== "string") return { base: "not_connected", overlay: null }
  const [base, overlay] = text.split("+")
  return {
    base: (BASE_STATES as readonly string[]).includes(base ?? "")
      ? (base as BaseState)
      : "not_connected",
    overlay: (OVERLAYS as readonly string[]).includes(overlay ?? "") ? (overlay as Overlay) : null,
  }
}

export type ConnectionEvent =
  | { kind: "key_checked"; missing: number }
  | { kind: "key_refused" }
  | { kind: "permission_refused" }
  | { kind: "account_unconfirmed" }
  | { kind: "webhook_secret_stored" }
  | { kind: "first_event" }
  | { kind: "import_done" }
  | { kind: "stalled" }
  | { kind: "event_received" }
  | { kind: "disconnected" }

const ORDER: Record<BaseState, number> = {
  not_connected: 0,
  key_stored: 1,
  waiting_first_event: 2,
  importing: 3,
  connected: 4,
}

/** The state after `event`. The base only moves forward; a disconnect starts over. */
export function transition(s: ConnectionState, event: ConnectionEvent): ConnectionState {
  const forward = (to: BaseState): BaseState => (ORDER[to] > ORDER[s.base] ? to : s.base)
  switch (event.kind) {
    case "key_checked":
      return { base: forward("key_stored"), overlay: event.missing > 0 ? "partial" : null }
    case "key_refused":
      return { base: s.base, overlay: "key_invalid" }
    case "permission_refused":
      return s.overlay === "key_invalid" || s.overlay === "different_account"
        ? s
        : { base: s.base, overlay: "partial" }
    case "account_unconfirmed":
      return { base: s.base, overlay: "different_account" }
    case "webhook_secret_stored":
      return { base: forward("waiting_first_event"), overlay: s.overlay }
    case "first_event":
      return { base: forward("importing"), overlay: s.overlay === "stalled" ? null : s.overlay }
    case "import_done":
      return { base: forward("connected"), overlay: s.overlay === "stalled" ? null : s.overlay }
    case "stalled":
      return s.overlay === "key_invalid" ? s : { base: s.base, overlay: "stalled" }
    case "event_received":
      return { base: s.base, overlay: s.overlay === "stalled" ? null : s.overlay }
    case "disconnected":
      return { base: "not_connected", overlay: null }
  }
}

/** The permissions of the default key, in the order the check reads them (the restricted-key permission list). */
export const PERMISSION_READS = [
  { resource: "customers", label: "Customers", path: "/v1/customers" },
  { resource: "subscriptions", label: "Subscriptions", path: "/v1/subscriptions" },
  { resource: "invoices", label: "Invoices", path: "/v1/invoices" },
  { resource: "charges", label: "Charges", path: "/v1/charges" },
  { resource: "disputes", label: "Disputes", path: "/v1/disputes" },
  { resource: "payment_methods", label: "Payment methods", path: "/v1/payment_methods" },
  { resource: "products", label: "Products", path: "/v1/products" },
  { resource: "prices", label: "Prices", path: "/v1/prices" },
  { resource: "events", label: "Events", path: "/v1/events" },
] as const

/** A charge id Stripe can never hold: the refund probe on it creates nothing. */
export const REFUND_PROBE_CHARGE = "ch_liaison_probe"

export type CheckRowState = "ok" | "missing" | "error"

export interface CheckRow {
  label: string
  level: "Read" | "Write"
  state: CheckRowState
  meta: string
}

export interface StoredPermissions {
  mode: "live" | "test" | null
  checks: Array<{ resource: string; level: "read" | "write"; state: CheckRowState }>
  checkedAt: string
  /** Set by the demo seeder on a stand-in install only (standin.ts). */
  demoStandIn?: true
}

export interface ConnectionCheckResult {
  mode: "live" | "test" | "unknown"
  account: { id: null; name: null; note: string }
  state: string
  checks: CheckRow[]
  summary: string
  next?: string
}

/** The slice of the app's db bridge the check uses. */
export interface ConnectionDb {
  findMany(
    entity: string,
    opts?: { where?: Record<string, unknown>; limit?: number },
  ): Promise<unknown[]>
  insert(entity: string, data: Record<string, unknown>): Promise<{ id: string }>
  update(entity: string, id: string, data: Record<string, unknown>): Promise<void>
}

export interface ConnectionCtx extends StripeHttpCtx {
  db: ConnectionDb
}

export interface InstallRow {
  id: string
  state?: unknown
  permissions?: unknown
  livemode?: unknown
  connected_at?: unknown
}

export async function readInstall(db: ConnectionDb): Promise<InstallRow | null> {
  const rows = (await db.findMany("install_metadata", { limit: 1 })) as InstallRow[]
  return rows[0] ?? null
}

export function storedPermissions(row: InstallRow | null): StoredPermissions | null {
  const raw = typeof row?.permissions === "string" ? safeParse(row.permissions) : row?.permissions
  if (!raw || typeof raw !== "object") return null
  const p = raw as Partial<StoredPermissions>
  return Array.isArray(p.checks) ? (p as StoredPermissions) : null
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const NO_ACCOUNT_NAME = "Stripe does not let a restricted key show the account name."

const KEY_INVALID_NEXT =
  "Next step: in Stripe, open Developers, API keys, create a restricted key with the permissions of the connect guide, and save it in the Stripe key card. Nothing was changed."

/** Up to 3 ids the mirror already holds, with the path that reads each back. */
async function knownMirrorIds(db: ConnectionDb): Promise<string[]> {
  const out: string[] = []
  const sources = [
    ["stripe_customers", "/v1/customers/"],
    ["stripe_subscriptions", "/v1/subscriptions/"],
    ["stripe_invoices", "/v1/invoices/"],
  ] as const
  for (const [entity, path] of sources) {
    if (out.length >= 3) break
    const rows = (await db.findMany(entity, { limit: 3 - out.length })) as Array<{
      stripe_id?: unknown
    }>
    for (const r of rows)
      if (typeof r.stripe_id === "string" && r.stripe_id) out.push(`${path}${r.stripe_id}`)
  }
  return out
}

type Probe = { status: number; livemode: boolean | null }

async function probe(
  ctx: StripeHttpCtx,
  path: string,
  init: Parameters<typeof stripeFetch>[2],
): Promise<Probe> {
  try {
    const body = await stripeFetch<{ livemode?: unknown; data?: Array<{ livemode?: unknown }> }>(
      ctx,
      path,
      init,
    )
    const lm = typeof body?.livemode === "boolean" ? body.livemode : body?.data?.[0]?.livemode
    return { status: 200, livemode: typeof lm === "boolean" ? lm : null }
  } catch (err) {
    if (err instanceof StripeApiError) return { status: err.status, livemode: null }
    throw err
  }
}

const modeWord = (live: boolean) => (live ? "live" : "test")

/**
 * Run the key check and record its outcome in `install_metadata`. Returns the
 * rows for the card, or a refusal (wrong key, another account, the other mode)
 * that changed nothing.
 */
export async function runConnectionCheck(
  ctx: ConnectionCtx,
  opts: {
    now?: Date
    /** The check of a key not stored yet: answers the same, records nothing. */
    dryRun?: boolean
  } = {},
): Promise<ConnectionCheckResult | ToolRefusal> {
  const now = opts.now ?? new Date()
  const install = await readInstall(ctx.db)
  const previous = storedPermissions(install)
  const current = decodeState(install?.state)

  // 1. The same account? Read back what the mirror holds.
  const known = await knownMirrorIds(ctx.db)
  if (known.length > 0) {
    const answers: Probe[] = []
    for (const path of known) answers.push(await probe(ctx, path, {}))
    if (answers.some((a) => a.status === 401))
      return await keyRefused(ctx, install, current, opts.dryRun)
    if (answers.every((a) => a.status === 404)) {
      return refuseTool(
        "different_account",
        `This key belongs to another Stripe account: none of the ${known.length} records Liaison already holds exists there. Nothing was replaced: the mirror and the connection's settings are as they were. Next step: save the key of the account Liaison is connected to, or have a person disconnect Stripe fully first to connect another account.`,
      )
    }
  }

  // 2. One read per permission, then the refund probe.
  const reads: Array<Probe & { resource: string; label: string }> = []
  for (const r of PERMISSION_READS) {
    const p = await probe(ctx, r.path, { params: { limit: 1 } })
    if (p.status === 401) return await keyRefused(ctx, install, current, opts.dryRun)
    reads.push({ ...p, resource: r.resource, label: r.label })
  }
  const refund = await probe(ctx, "/v1/refunds", {
    method: "POST",
    params: { charge: REFUND_PROBE_CHARGE },
  })
  if (refund.status === 401) return await keyRefused(ctx, install, current, opts.dryRun)

  // 3. The mode, from any object Stripe returned.
  const seen = reads.find((r) => r.livemode !== null)?.livemode ?? null
  const mode = seen === null ? null : modeWord(seen)
  if (mode && previous?.mode && previous.mode !== mode) {
    return refuseTool(
      "mode_changed",
      `This is a ${mode}-mode key, and the connection holds ${previous.mode}-mode data. Nothing was replaced. Next step: save the ${previous.mode}-mode restricted key (it starts with rk_${previous.mode}_), or have a person disconnect Stripe fully first to switch to ${mode} mode.`,
    )
  }

  const rows: CheckRow[] = reads.map((r) => readRow(r.label, r.status))
  rows.push(refundRow(refund.status))
  const missing = rows.filter((r) => r.state === "missing")
  const failed = rows.filter((r) => r.state === "error")
  const next = transition(current, { kind: "key_checked", missing: missing.length })
  const permissions: StoredPermissions = {
    mode: mode ?? previous?.mode ?? null,
    checks: [
      ...reads.map((r, i) => ({
        resource: r.resource,
        level: "read" as const,
        state: (rows[i] as CheckRow).state,
      })),
      {
        resource: "refunds",
        level: "write" as const,
        state: (rows[rows.length - 1] as CheckRow).state,
      },
    ],
    checkedAt: now.toISOString(),
    // A stand-in install keeps its mark through a check; the check never adds it.
    ...(isStandInInstall(install) ? { [STANDIN_MARKER]: true } : {}),
  }
  const data = {
    state: encodeState(next),
    permissions,
    livemode: (mode ?? previous?.mode) === "live",
  }
  if (opts.dryRun) {
    // Nothing recorded: the key is not stored yet.
  } else if (install) await ctx.db.update("install_metadata", install.id, data)
  else await ctx.db.insert("install_metadata", { ...data, connected_at: now.toISOString() })

  const ok = rows.length - missing.length - failed.length
  const summaryParts = [`${ok} of ${rows.length} permissions work.`]
  if (missing.length > 0) {
    summaryParts.push(
      `Missing: ${missing.map((r) => `${r.label} (${r.level})`).join(", ")}. The connection stays usable; what those permissions cover is not read until the key has them.`,
    )
  }
  if (failed.length > 0) {
    summaryParts.push(
      `Stripe did not answer for ${failed.map((r) => r.label).join(", ")}; run the check again later.`,
    )
  }
  return {
    mode: mode ?? "unknown",
    account: { id: null, name: null, note: NO_ACCOUNT_NAME },
    state: encodeState(next),
    checks: rows,
    summary: summaryParts.join(" "),
    ...(missing.length > 0
      ? {
          next: `Next step: in Stripe, edit the restricted key and set ${missing
            .map((r) => `${r.label} to ${r.level}`)
            .join(", ")}, then run the check again.`,
        }
      : {}),
  }
}

function readRow(label: string, status: number): CheckRow {
  if (status === 200) return { label, level: "Read", state: "ok", meta: "Read works" }
  if (status === 403)
    return { label, level: "Read", state: "missing", meta: `Missing: give Read to ${label}` }
  return { label, level: "Read", state: "error", meta: `Stripe answered ${status}` }
}

function refundRow(status: number): CheckRow {
  // 404 (no such charge) and 400 mean the key may create refunds; nothing was created.
  if (status === 404 || status === 400) {
    return {
      label: "Refunds",
      level: "Write",
      state: "ok",
      meta: "Write allowed (probe, nothing created)",
    }
  }
  if (status === 403)
    return {
      label: "Refunds",
      level: "Write",
      state: "missing",
      meta: "Missing: give Write to Refunds",
    }
  return { label: "Refunds", level: "Write", state: "error", meta: `Stripe answered ${status}` }
}

async function keyRefused(
  ctx: ConnectionCtx,
  install: InstallRow | null,
  current: ConnectionState,
  dryRun = false,
): Promise<ToolRefusal> {
  // A key not stored yet says nothing about the stored one: only a stored key's refusal moves the state.
  if (install && !dryRun) {
    await ctx.db.update("install_metadata", install.id, {
      state: encodeState(transition(current, { kind: "key_refused" })),
    })
  }
  // A key checked before it is stored (dry run, or no install yet) was never saved: say "this key".
  const which = install && !dryRun ? "the saved key" : "this key, so it was not saved"
  return refuseTool(
    "key_invalid",
    `Stripe refused ${which} (401): it was revoked, rolled or mistyped. ${KEY_INVALID_NEXT}`,
  )
}
