// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Manifest consistency tests (monitoring/boxtal convention):
//   • parses under the SDK's packageManifestSchema
//   • every handler/verify export the manifest references exists in the bundle
//   • the ONE NON-NEGOTIABLE constraint of this connector: NO schema block,
//     NO entities — spec §2 "no custom entity model" verbatim. All state lives
//     in per-call knowledge documents.
//   • every cross-app call the handlers perform is declared in cross_app_calls
//   • the webhook requires a user actor (knowledge create/update write
//     created_by/owner_user_id as real-user uuids — U4.12 precedent)
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { packageManifestSchema } from "@liaison/app-sdk"
import * as handlers from "./handlers"

const MANIFEST = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "app.manifest.json"), "utf8"),
) as {
  name: string
  scopes: string[]
  schema?: unknown
  entities?: unknown
  tools?: Record<string, { handler: string; requiredScopes?: string[] }>
  webhooks?: Record<
    string,
    { handler: string; verify: string; bodyLimitBytes?: number; requiresUserActor?: boolean }
  >
  connections?: Record<string, { type: string; webhookSecretConfigKey?: string }>
  cross_app_calls?: Array<{ target: string; reason: string }>
}

describe("calls app.manifest.json", () => {
  // The UI bundle URL is version keyed and immutable, so any manifest change
  // must arrive on a new version; this pins the two in step.
  it("is version 0.2.11", () => {
    // 0.2.10: a connector card on Settings > Connectors (declarative settings).
    // 0.2.11: store listing (manifest `listing`: category, icon, summary, source repository).
    // 0.2.12: the manifest declares its host API range (`host: "^1"`) instead of sdkVersion.
    // 0.2.13: the icon as data (`iconName`), drawn when the UI runs framed.
    // 0.2.15: every HUMAN setup step says its own minutes.
    // 0.2.17: the app's own install resolves the control-plane contract through an override
    // (the shared package depends on it by workspace protocol); no change to what it does.
    // 0.2.18: the same number (0.2.17) carried different content on two lines of work; this one has both.
    expect((MANIFEST as unknown as { version: string }).version).toBe("0.2.19")
  })

  // Settings overhaul P2: a connector without a UI bundle; the kernel renders
  // its settings card from the manifest alone.
  it("is a connector whose settings card is its transcript-source connection", () => {
    const m = MANIFEST as unknown as {
      kind?: string
      views?: unknown
      settings?: {
        sections: Array<{
          scope: string
          adminScope?: string
          titleKey?: string
          blocks: Array<Record<string, unknown>>
        }>
      }
    }
    expect(m.kind).toBe("connector")
    expect(m.views).toBeUndefined()
    const [section] = m.settings?.sections ?? []
    expect(section?.scope).toBe("org")
    expect(section?.adminScope).toBe("calls:admin")
    expect(section?.titleKey).toBe("kernel.appSettings.calls.connectionTitle")
    expect(section?.blocks).toEqual([{ block: "connections", names: ["transcript-source"] }])
  })

  // Settings > Apps labels each connection with its purpose and demotes the
  // optional ones (a bare "Connect" made a working app look uninstalled).
  it("declares what each connection connects, and which ones are optional", () => {
    const c = (MANIFEST as unknown as {
      connections: Record<string, { purpose?: string; optional?: boolean }>
    }).connections
    expect(c["transcript-source"]?.purpose).toBe("Transcript webhook")
    expect(c["transcript-source"]?.optional === true).toBe(true)
  })

  it("validates against packageManifestSchema (freeze-time zod)", () => {
    const r = packageManifestSchema.safeParse(MANIFEST)
    if (!r.success) console.error(JSON.stringify(r.error.issues, null, 2))
    expect(r.success).toBe(true)
  })

  it("declares ZERO schema and ZERO entities — all state lives in knowledge documents (spec §2)", () => {
    expect(MANIFEST.schema).toBeUndefined()
    expect(MANIFEST.entities).toBeUndefined()
  })

  it("exports every referenced tool handler, webhook handler, and verifier", () => {
    const exported = new Set(Object.keys(handlers))
    const missing: string[] = []
    for (const [name, t] of Object.entries(MANIFEST.tools ?? {})) {
      if (!exported.has(t.handler)) missing.push(`tools.${name}.handler=${t.handler}`)
    }
    for (const [topic, w] of Object.entries(MANIFEST.webhooks ?? {})) {
      if (!exported.has(w.handler)) missing.push(`webhooks.${topic}.handler=${w.handler}`)
      if (!exported.has(w.verify)) missing.push(`webhooks.${topic}.verify=${w.verify}`)
    }
    expect(missing).toEqual([])
  })

  it("declares the calls scope family and scopes every tool", () => {
    expect(MANIFEST.scopes).toEqual([
      "calls:transcripts:read",
      "calls:transcripts:write",
      "calls:admin",
    ])
    for (const [name, t] of Object.entries(MANIFEST.tools ?? {})) {
      expect(t.requiredScopes?.length, `tools.${name} requiredScopes`).toBeGreaterThan(0)
      for (const scope of t.requiredScopes ?? []) {
        expect(MANIFEST.scopes, `tools.${name} scope`).toContain(scope)
      }
    }
  })

  it("declares the segment webhook with requiresUserActor (knowledge writes need a real user uuid)", () => {
    const wh = MANIFEST.webhooks?.segment
    expect(wh).toBeDefined()
    expect(wh!.requiresUserActor).toBe(true)
    expect(wh!.bodyLimitBytes).toBe(65536)
  })

  it("declares the transcript-source secret-mint connection (3rd instance of the sdk-gaps.md webhook-secret workaround)", () => {
    const conn = MANIFEST.connections?.["transcript-source"]
    expect(conn).toBeDefined()
    expect(conn!.type).toBe("credentials")
    expect(conn!.webhookSecretConfigKey).toBe("callsWebhookSecret")
  })

  it("declares every knowledge tool the handlers invoke under cross_app_calls", () => {
    const targets = new Set((MANIFEST.cross_app_calls ?? []).map((c) => c.target))
    for (const needed of [
      "knowledge:create",
      "knowledge:update",
      "knowledge:get",
      "knowledge:search",
      "knowledge:find_by_title",
    ]) {
      expect(targets.has(needed), `cross_app_calls missing ${needed}`).toBe(true)
    }
  })
})
