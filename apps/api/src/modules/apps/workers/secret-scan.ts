// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Test helper: no fixture secret appears in what crossed to the isolate (a
// bridge-route response body, a guest-visible fetch answer, a run's output).
// Used by the parity and isolation tests of the Workers executor. Each secret
// is looked for as given, base64-encoded, and JSON-string-escaped; a failure
// names the secret by its label, never its value.

export type SecretList = readonly string[] | Readonly<Record<string, string>>

function forms(secret: string): string[] {
  const out = new Set<string>([secret])
  out.add(Buffer.from(secret, "utf8").toString("base64"))
  out.add(JSON.stringify(secret).slice(1, -1))
  return [...out]
}

/** The labels of the secrets found in `text` (empty when clean). */
export function findSecretsIn(text: string, secrets: SecretList): string[] {
  const entries: Array<[string, string]> = Array.isArray(secrets)
    ? secrets.map((s, i) => [`secret #${i}`, s] as [string, string])
    : Object.entries(secrets)
  const found: string[] = []
  for (const [label, secret] of entries) {
    if (typeof secret !== "string" || secret.length < 6) {
      throw new Error(`assertNoSecretsIn: ${label} is too short to scan for (6 characters minimum)`)
    }
    if (forms(secret).some((f) => text.includes(f))) found.push(label)
  }
  return found
}

/** Throws when any of `secrets` occurs in `text` (non-string text is JSON-encoded). */
export function assertNoSecretsIn(text: unknown, secrets: SecretList): void {
  const haystack = typeof text === "string" ? text : (JSON.stringify(text) ?? "")
  const found = findSecretsIn(haystack, secrets)
  if (found.length > 0) {
    throw new Error(`secret leaked to the guest: ${found.join(", ")}`)
  }
}
