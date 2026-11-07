// SPDX-License-Identifier: FSL-1.1-ALv2
//
// @liaison/app-sdk/connection-credentials: read a credentials connection's key
// map from `ctx.connections`, whichever runtime shape it has.
//
// `ctx.connections` has two runtime shapes:
//   - FLAT   `{ getCredentials(name, id?) }`: the sandbox bridge group.
//   - RECORD `{ [name]: { getCredentials(id?) } }`: the SDK type and unit-test mocks.
// The raw value may arrive as a JSON string (the sandbox shim's raw path for a
// primitive arg) or as an object.

export type CredentialsAccessor = () => Promise<Record<string, string>>

/** Normalize both `ctx.connections` shapes to one accessor, or null when absent. */
export function resolveCredentialsAccessor(
  connections: unknown,
  name: string,
): CredentialsAccessor | null {
  const flat = connections as {
    getCredentials?: (name: string, identifier?: string) => Promise<unknown>
  }
  if (typeof flat.getCredentials === "function") {
    return async () => {
      const raw = await flat.getCredentials!(name)
      return (typeof raw === "string" ? JSON.parse(raw) : (raw ?? {})) as Record<string, string>
    }
  }
  const record = connections as Record<
    string,
    { getCredentials?: (identifier?: string) => Promise<unknown> } | undefined
  >
  const entry = record?.[name]
  if (entry && typeof entry.getCredentials === "function") {
    return async () => {
      const raw = await entry.getCredentials!()
      return (typeof raw === "string" ? JSON.parse(raw) : (raw ?? {})) as Record<string, string>
    }
  }
  return null
}

export type ConnectionCredentialsResult<K extends string> =
  | { ok: true; credentials: Record<string, string> }
  | {
      ok: false
      /**
       * not_connected: no accessor for the connection; unreadable: the accessor
       * threw (its text is never surfaced); empty: no keys stored; incomplete:
       * some `requiredKeys` are missing or empty (listed in `missing`).
       */
      reason: "not_connected" | "unreadable" | "empty" | "incomplete"
      missing: K[]
    }

/**
 * Read the credential map of connection `name` and check `requiredKeys`. Never
 * throws for a connection problem: the caller maps each reason to its own error
 * and message.
 */
export async function readConnectionCredentials<K extends string>(
  connections: unknown,
  name: string,
  requiredKeys: readonly K[],
): Promise<ConnectionCredentialsResult<K>> {
  const accessor = resolveCredentialsAccessor(connections, name)
  if (!accessor) return { ok: false, reason: "not_connected", missing: [] }
  let map: Record<string, string>
  try {
    map = await accessor()
  } catch {
    return { ok: false, reason: "unreadable", missing: [] }
  }
  if (!map || Object.keys(map).length === 0) return { ok: false, reason: "empty", missing: [] }
  const missing = requiredKeys.filter((k) => !map[k])
  if (missing.length > 0) return { ok: false, reason: "incomplete", missing }
  return { ok: true, credentials: map }
}

export type ConnectionSettingsResult<K extends string> =
  | { ok: true; values: Record<string, string> }
  | {
      ok: false
      /** As `readConnectionCredentials`: the secrets are checked for presence only. */
      reason: "not_connected" | "unreadable" | "empty" | "incomplete"
      missing: K[]
    }

/**
 * Read the NON-SECRET settings of credentials connection `name`
 * (`getSettings`: readable values plus the names of the empty fields) and
 * check that every one of `requiredKeys` holds a value, without the secrets
 * entering the app. Both `ctx.connections` shapes; never throws for a
 * connection problem. The secrets go to the provider through `ctx.fetch` auth.
 */
export async function readConnectionSettings<K extends string>(
  connections: unknown,
  name: string,
  requiredKeys: readonly K[],
): Promise<ConnectionSettingsResult<K>> {
  let call: (() => Promise<unknown>) | null = null
  const flat = connections as {
    getSettings?: (name: string, identifier?: string) => Promise<unknown>
  }
  if (typeof flat?.getSettings === "function") {
    call = () => flat.getSettings!(name)
  } else {
    const entry = (
      connections as Record<string, { getSettings?: () => Promise<unknown> } | undefined>
    )?.[name]
    if (entry && typeof entry.getSettings === "function") call = () => entry.getSettings!()
  }
  if (!call) return { ok: false, reason: "not_connected", missing: [] }
  let settings: { values?: Record<string, string>; missing?: string[] }
  try {
    const raw = await call()
    settings = (typeof raw === "string" ? JSON.parse(raw) : (raw ?? {})) as typeof settings
  } catch {
    return { ok: false, reason: "unreadable", missing: [] }
  }
  const values = settings.values ?? {}
  const empty = new Set(settings.missing ?? [])
  const missing = requiredKeys.filter((k) => empty.has(k))
  if (missing.length === requiredKeys.length && requiredKeys.length > 0) {
    return { ok: false, reason: "empty", missing: [] }
  }
  if (missing.length > 0) return { ok: false, reason: "incomplete", missing }
  return { ok: true, values }
}
