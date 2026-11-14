// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Verify a first-party app artifact against the pinned keys: the signed
 * statement (statement.ts) and the files it names. WebCrypto Ed25519 only, so
 * the same code runs in Bun (server, build, CLI) and in the shells' web views.
 * Where WebCrypto has no Ed25519 the import throws and the result is a failure:
 * the app then runs in the sandbox frame.
 */
import { ab, base64ToBytes, sha256Hex, utf8 } from "./encoding"
import type { AppSigningKey } from "./keys"
import { type AppStatement, canonicalJson, parseStatement } from "./statement"

export type StatementVerification =
  | { ok: true; statement: AppStatement }
  | {
      ok: false
      reason: "no_keys" | "malformed_statement" | "unknown_key" | "bad_signature" | "unsupported"
    }

/**
 * Check `sig` (base64, or raw bytes) over `bytes` with the key the statement
 * names. An empty key list verifies nothing.
 */
export async function verifySignedBytes(
  bytes: Uint8Array,
  sig: string | Uint8Array,
  keyId: string,
  keys: readonly AppSigningKey[],
): Promise<"ok" | "no_keys" | "unknown_key" | "bad_signature" | "unsupported"> {
  if (keys.length === 0) return "no_keys"
  const key = keys.find((k) => k.keyId === keyId)
  if (!key) return "unknown_key"
  const raw = base64ToBytes(key.publicKey)
  const sigBytes = typeof sig === "string" ? base64ToBytes(sig) : sig
  if (raw?.length !== 32 || sigBytes?.length !== 64) return "bad_signature"
  let publicKey: CryptoKey
  try {
    publicKey = await crypto.subtle.importKey("raw", ab(raw), { name: "Ed25519" }, false, [
      "verify",
    ])
  } catch {
    return "unsupported"
  }
  try {
    const ok = await crypto.subtle.verify("Ed25519", publicKey, ab(sigBytes), ab(bytes))
    return ok ? "ok" : "bad_signature"
  } catch {
    return "bad_signature"
  }
}

export async function verifyStatement(
  bytes: Uint8Array,
  sig: string | Uint8Array,
  keys: readonly AppSigningKey[],
): Promise<StatementVerification> {
  if (keys.length === 0) return { ok: false, reason: "no_keys" }
  const statement = parseStatement(bytes)
  // One byte string per statement: anything but the canonical form is refused.
  if (!statement || utf8.decode(bytes) !== canonicalJson(statement)) {
    return { ok: false, reason: "malformed_statement" }
  }
  const result = await verifySignedBytes(bytes, sig, statement.keyId, keys)
  return result === "ok" ? { ok: true, statement } : { ok: false, reason: result }
}

export interface ArtifactFiles {
  /** The app name the caller is about to register or serve (from the URL / entry). */
  name: string
  /** The version the caller is about to register or serve. */
  version: string
  uiBytes: Uint8Array
  manifestBytes: Uint8Array
  /** The `.liaisonapp` tarball, when the caller has it. */
  packageBytes?: Uint8Array
}

export type ArtifactProblem =
  | "name"
  | "version"
  | "ui_hash"
  | "manifest_hash"
  | "package_hash"
  | "manifest_identity"
  | "not_single_file"

/** What differs between a verified statement and the files at hand; [] when they match. */
export async function checkArtifact(
  statement: AppStatement,
  files: ArtifactFiles,
): Promise<ArtifactProblem[]> {
  const problems: ArtifactProblem[] = []
  if (statement.name !== files.name) problems.push("name")
  if (statement.version !== files.version) problems.push("version")
  if ((await sha256Hex(files.uiBytes)) !== statement.sha256.ui) problems.push("ui_hash")
  if ((await sha256Hex(files.manifestBytes)) !== statement.sha256.manifest) {
    problems.push("manifest_hash")
  }
  if (files.packageBytes && (await sha256Hex(files.packageBytes)) !== statement.sha256.package) {
    problems.push("package_hash")
  }
  let manifest: { name?: unknown; version?: unknown; host?: unknown } | null = null
  try {
    manifest = JSON.parse(utf8.decode(files.manifestBytes))
  } catch {
    manifest = null
  }
  if (
    !manifest ||
    manifest.name !== statement.name ||
    manifest.version !== statement.version ||
    manifest.host !== statement.hostApi
  ) {
    problems.push("manifest_identity")
  }
  let source: string | null = null
  try {
    source = utf8.decode(files.uiBytes)
  } catch {
    source = null
  }
  if (source === null || singleFileBundleProblems(source).length > 0) {
    problems.push("not_single_file")
  }
  return problems
}

export type ArtifactVerification =
  | { ok: true; statement: AppStatement }
  | { ok: false; reason: Exclude<StatementVerification, { ok: true }>["reason"] }
  | { ok: false; reason: "artifact_mismatch"; statement: AppStatement; problems: ArtifactProblem[] }

/** The signed statement AND the files it names, in one call. */
export async function verifyArtifact(
  statementBytes: Uint8Array,
  sig: string | Uint8Array,
  files: ArtifactFiles,
  opts: { keys: readonly AppSigningKey[] },
): Promise<ArtifactVerification> {
  const verified = await verifyStatement(statementBytes, sig, opts.keys)
  if (!verified.ok) return verified
  const problems = await checkArtifact(verified.statement, files)
  if (problems.length > 0) {
    return { ok: false, reason: "artifact_mismatch", statement: verified.statement, problems }
  }
  return verified
}

/** Bare specifiers a first-party UI bundle may import: the host's import map. */
export const APP_BUNDLE_BARE_IMPORTS: readonly string[] = [
  "solid-js",
  "solid-js/web",
  "solid-js/store",
]

/**
 * Why a UI bundle is not a single-file ESM module (A8), or [] when it is: no
 * dynamic `import()`, no `import.meta`, and every static import or re-export
 * names one of `APP_BUNDLE_BARE_IMPORTS` (so no relative, absolute, URL or CSS
 * specifier). The executed bytes are then exactly the verified bytes.
 */
export function singleFileBundleProblems(source: string): string[] {
  const problems: string[] = []
  if (/\bimport\s*\(/.test(source)) problems.push("dynamic import()")
  if (/\bimport\s*\.\s*meta\b/.test(source)) problems.push("import.meta")
  const specifiers = [
    // import x from "s", import {a} from "s", export {a} from "s", export * from "s"
    ...source.matchAll(
      /(?:^|[;}])\s*(?:import|export)\b[\w\s{},*$]*?\bfrom\s*["']([^"'\n]*)["']/gm,
    ),
    // import "s" (side effect only)
    ...source.matchAll(/(?:^|[;}])\s*import\s*["']([^"'\n]*)["']/gm),
  ].flatMap((m) => (m[1] === undefined ? [] : [m[1]]))
  for (const spec of new Set(specifiers)) {
    if (!APP_BUNDLE_BARE_IMPORTS.includes(spec)) problems.push(`import "${spec}"`)
  }
  return problems
}
