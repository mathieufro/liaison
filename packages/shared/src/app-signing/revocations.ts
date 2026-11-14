// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Revoked first-party app versions (A2). Two sources, either one suffices:
 *  - `apps/revocations.json` + `apps/revocations.json.sig` on the downloads
 *    host, signed by a key in `APP_SIGNING_KEYS`: canonical JSON (statement.ts
 *    rules) of `{v:1, seq, issuedAt, entries:[{name, below?, versions?}]}`.
 *    `seq` only grows; a client keeps the highest it has seen and refuses an
 *    older list, so a replayed list cannot un-revoke a version.
 *  - `REVOCATION_FLOOR` compiled into each client release (keys.ts).
 * A revoked or below-floor version never runs in-page.
 */
import { utf8 } from "./encoding"
import { type AppRevocationEntry, type AppSigningKey, REVOCATION_FLOOR } from "./keys"
import { canonicalJson } from "./statement"
import { verifySignedBytes } from "./verify"

export interface RevocationList {
  v: 1
  seq: number
  issuedAt: string
  entries: AppRevocationEntry[]
}

export function revocationBytes(list: RevocationList): Uint8Array {
  return utf8.encode(canonicalJson(list))
}

const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0

function parseEntry(raw: unknown): AppRevocationEntry | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null
  const { name, below, versions, ...rest } = raw as Record<string, unknown>
  if (Object.keys(rest).length > 0 || !isString(name)) return null
  if (below !== undefined && !isString(below)) return null
  if (versions !== undefined && !(Array.isArray(versions) && versions.every(isString))) return null
  if (below === undefined && versions === undefined) return null
  return {
    name,
    ...(below !== undefined ? { below } : {}),
    ...(versions !== undefined ? { versions } : {}),
  }
}

export function parseRevocationList(bytes: Uint8Array): RevocationList | null {
  let raw: unknown
  try {
    raw = JSON.parse(utf8.decode(bytes))
  } catch {
    return null
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null
  const { v, seq, issuedAt, entries, ...rest } = raw as Record<string, unknown>
  if (Object.keys(rest).length > 0 || v !== 1 || !isString(issuedAt)) return null
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) return null
  if (!Array.isArray(entries)) return null
  const parsed = entries.map(parseEntry)
  if (parsed.some((e) => e === null)) return null
  return { v: 1, seq, issuedAt, entries: parsed.filter((e): e is AppRevocationEntry => e !== null) }
}

export type RevocationVerification =
  | { ok: true; list: RevocationList }
  | { ok: false; reason: "no_keys" | "malformed_list" | "bad_signature" | "unsupported" }

/** Check the list's signature against every pinned key (the list names no key). */
export async function verifyRevocationList(
  bytes: Uint8Array,
  sig: string | Uint8Array,
  keys: readonly AppSigningKey[],
): Promise<RevocationVerification> {
  if (keys.length === 0) return { ok: false, reason: "no_keys" }
  const list = parseRevocationList(bytes)
  if (!list || utf8.decode(bytes) !== canonicalJson(list)) {
    return { ok: false, reason: "malformed_list" }
  }
  let unsupported = false
  for (const key of keys) {
    const result = await verifySignedBytes(bytes, sig, key.keyId, [key])
    if (result === "ok") return { ok: true, list }
    if (result === "unsupported") unsupported = true
  }
  return { ok: false, reason: unsupported ? "unsupported" : "bad_signature" }
}

/** True when `list` may replace what the client holds: its seq is not older. */
export function acceptRevocationList(highestSeenSeq: number | null, list: RevocationList): boolean {
  return highestSeenSeq === null || list.seq >= highestSeenSeq
}

function parseVersion(v: string): { nums: number[]; pre: string | null } {
  const [core = "", ...pre] = v.split("-")
  return {
    nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0),
    pre: pre.join("-") || null,
  }
}

/** Semver-style order: numeric core, then a pre-release sorts before its release. */
export function compareAppVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0)
    if (d !== 0) return d
  }
  if (pa.pre === pb.pre) return 0
  if (pa.pre === null) return 1
  if (pb.pre === null) return -1
  return comparePreRelease(pa.pre, pb.pre)
}

const NUMERIC_ID = /^\d+$/

/**
 * Semver pre-release order: dot-separated identifiers left to right, numeric
 * ones numerically, a numeric one before an alphanumeric one, and a shorter
 * list first when every identifier it has is equal ("rc.9" < "rc.10").
 */
function comparePreRelease(a: string, b: string): number {
  const left = a.split(".")
  const right = b.split(".")
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i]
    const y = right[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNum = NUMERIC_ID.test(x)
    const yNum = NUMERIC_ID.test(y)
    let order: number
    if (xNum && yNum) {
      const bx = BigInt(x)
      const by = BigInt(y)
      order = bx === by ? 0 : bx < by ? -1 : 1
    } else if (xNum) order = -1
    else if (yNum) order = 1
    else order = x === y ? 0 : x < y ? -1 : 1
    if (order !== 0) return order
  }
  return 0
}

function matches(entries: readonly AppRevocationEntry[], name: string, version: string): boolean {
  return entries.some(
    (e) =>
      e.name === name &&
      ((e.below !== undefined && compareAppVersions(version, e.below) < 0) ||
        (e.versions?.includes(version) ?? false)),
  )
}

/**
 * Why `name@version` must not run in-page, or null. `list` is the verified
 * downloaded list (null when none); `floor` defaults to the compiled floor.
 */
export function revocationFor(
  name: string,
  version: string,
  opts: { list: RevocationList | null; floor?: readonly AppRevocationEntry[] },
): "below_floor" | "revoked" | null {
  if (matches(opts.floor ?? REVOCATION_FLOOR, name, version)) return "below_floor"
  if (opts.list && matches(opts.list.entries, name, version)) return "revoked"
  return null
}
