// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Manifest consistency tests (build round-trip, boxtal convention):
//   • the manifest parses under the SDK's packageManifestSchema
//   • every handler/verify export the manifest references exists in the bundle
//   • every event a handler emits is declared in events.emits
//   • every attention translation maps a declared event and carries a template
//     that reads fields the webhook handler actually puts on the event
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { packageManifestSchema } from "@liaison/app-sdk"
import * as handlers from "./handlers"

const MANIFEST = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "app.manifest.json"), "utf8"),
) as {
  name: string
  tools?: Record<
    string,
    {
      handler: string
      description?: string
      readOnly?: boolean
      requiredScopes?: string[]
      writesToTable?: string
      params?: { properties?: Record<string, { type?: string; description?: string }>; required?: string[] }
    }
  >
  agentInstructions?: string
  capabilities?: string[]
  schema?: {
    incidents?: { fields?: Record<string, unknown>; constraints?: { unique?: unknown[] } }
    incident_comments?: { rlsScope?: string; fields?: Record<string, unknown>; indexes?: unknown[] }
  }
  jobs?: Record<
    string,
    { handler: string; schedule?: string; atomic?: boolean; timeoutMs?: number; runsFor?: unknown }
  >
  webhooks?: Record<string, { handler: string; verify: string }>
  webhookHealth?: { probe: string | null; reason?: string }
  events?: { emits?: string[] }
  attention?: {
    filterableAxes?: string[]
    translations?: Array<{
      event: string
      kind: string
      urgency: number
      summary: string
      recipients: { kind: string; scope?: string }
      when?: { path?: string; value?: unknown }
      resolveWhen?: unknown
    }>
  }
  scopes: string[]
  version: string
}

describe("monitoring app.manifest.json", () => {
  // The UI bundle is served at a version keyed, immutable URL, so a UI change
  // shipped without a bump leaves every browser on the stale bundle forever.
  // Pinning the literal here makes the omission a failing test, not a support
  // ticket.
  it("is version 0.4.5", () => {
    // 0.4.5: French copy (detailed monitoring link, number spacing).
    // 0.4.4: sync of upstream 0.3.7-0.3.9 (store listing, `host: "^1"`, `iconName`,
    // `currentPath()` in the framed UI) over the fork's 0.4.3.
    // 0.4.3: sidebar rows open their tab through the host navigate (a sidebar
    // drawn in its own frame no longer loads the href inside the frame).
    // 0.4.2: the fork's incident refs and comments (0.4.1) with the declarative
    // settings page (manifest `settings`, upstream 0.3.6).
    // 0.4.8: every HUMAN setup step says its own minutes.
    // 0.4.11: the app's own install resolves the control-plane contract through an override
    // (the shared package depends on it by workspace protocol); no change to what it does.
    // 0.4.12: the same number (0.4.11) carried different content on two lines of work; this one has both.
    // 0.4.14: the shared host package gained the discussion panel hooks; no change of its own.
    expect(MANIFEST.version).toBe("0.4.15")
  })

  // The declarative settings page (/settings/apps/monitoring): the detailed
  // monitoring link as a config field, the ordered sources as the one custom
  // block, the alert-source connection. The sidebar gear leads there.
  it("declares its settings page: link field, sources block, alert source", () => {
    const m = MANIFEST as unknown as {
      views: { settings?: unknown }
      configKeys: Array<{ key: string; type: string }>
      settings: { sections: Array<{ id: string; blocks: Array<Record<string, unknown>> }> }
    }
    expect(m.views.settings).toBeUndefined()
    expect(m.settings.sections.map((s) => s.id)).toEqual(["link", "sources", "alert-source"])
    const blocks = m.settings.sections.flatMap((s) => s.blocks)
    const field = blocks.find((b) => b.block === "field")
    expect(field).toMatchObject({ key: "monitoringUrl", type: "url", source: "config" })
    expect(m.configKeys.some((k) => k.key === "monitoringUrl" && k.type === "url")).toBe(true)
    expect(blocks.find((b) => b.block === "custom")?.component).toBe("MonitoringSources")
    expect(blocks.find((b) => b.block === "connections")).toEqual({ block: "connections", names: ["alert-source"] })
    const barrel = readFileSync(join(import.meta.dir, "ui", "index.tsx"), "utf8")
    expect(barrel).toContain("MonitoringSources")
    const sidebar = readFileSync(join(import.meta.dir, "ui", "sidebar.tsx"), "utf8")
    expect(sidebar).toContain('navigate("/settings/apps/monitoring")')
  })

  // incident refs (INC-<n>) come from the sequences capability; comments live in their own table
  // that gates on the incidents scopes (no monitoring scope grants monitoring:incident_comments:*).
  it("declares the sequences capability, the ref column with its unique, the comments table and the assign-refs job", () => {
    expect(MANIFEST.capabilities).toContain("sequences.allocate")
    expect(MANIFEST.schema?.incidents?.fields?.ref_number).toEqual({ type: "integer", required: false })
    expect(MANIFEST.schema?.incidents?.constraints?.unique).toContainEqual(["ref_number"])
    expect(MANIFEST.schema?.incident_comments?.rlsScope).toBe("incidents")
    // A short run budget: the job holds the org's ref lock until it commits (see jobs.ts).
    expect(MANIFEST.jobs?.["assign-refs"]).toEqual({
      handler: "assignRefsJobHandler",
      // Only for orgs with an incident still waiting for its ref (manifest runsFor).
      runsFor: { rows: { entity: "incidents", where: { ref_number: null } } },
      schedule: "*/5 * * * *",
      atomic: true,
      timeoutMs: 20000,
    })
  })

  // GDPR: an erased user's comments keep their text and lose the author (userRef + anonymize).
  it("declares the comment author as an erasable user ref, the kind enum and the incident index", () => {
    const fields = MANIFEST.schema?.incident_comments?.fields ?? {}
    expect(fields.author_id).toEqual({ type: "uuid", required: false, userRef: true, onErase: "anonymize" })
    expect(fields.kind).toEqual({ type: "string", default: "comment", enum: ["comment", "episode"] })
    expect(fields.incident_id).toEqual({
      type: "uuid",
      references: { table: "incidents", column: "id", onDelete: "cascade" },
    })
    expect(MANIFEST.schema?.incident_comments?.indexes).toEqual([["incident_id"]])
  })

  it("declares incidents_comment and the optional incidents_ack note", () => {
    const comment = MANIFEST.tools?.incidents_comment
    expect(comment?.requiredScopes).toEqual(["monitoring:incidents:write"])
    expect(comment?.writesToTable).toBe("app_monitoring.incident_comments")
    expect(comment?.readOnly).not.toBe(true)
    expect(comment?.params?.required).toEqual(["incidentId", "body"])
    const ack = MANIFEST.tools?.incidents_ack
    expect(ack?.params?.properties?.note?.type).toBe("string")
    expect(ack?.params?.required).toEqual(["incidentId"])
    expect(ack?.params?.properties?.note?.description).toMatch(/stays acknowledged/)
  })

  it("names refs in the tool descriptions and the agent guidance", () => {
    const t = MANIFEST.tools ?? {}
    expect(t.incidents_list?.description).toMatch(/\bref\b/)
    for (const name of ["incidents_get", "incidents_ack", "incidents_resolve", "incidents_comment"]) {
      expect(t[name]?.description, name).toMatch(/INC-<n>|\bref\b/)
    }
    const guide = MANIFEST.agentInstructions ?? ""
    expect(guide).toContain("INC-<n>")
    expect(guide).toContain("incidents_comment")
  })

  // The summaries render the ref through the pre-formatted refLabel (a raw ref placeholder would
  // render "[]" for an incident that is not numbered yet).
  it("pins the exact notification summaries", () => {
    const expected: Record<string, string> = {
      "incident:created|monitoring:incident.critical":
        "Critical alert: {{payload.data.refLabel}}{{payload.data.title}} ({{payload.data.source}})",
      "incident:created|monitoring:incident.warning":
        "Warning alert: {{payload.data.refLabel}}{{payload.data.title}} ({{payload.data.source}})",
      "incident:reopened|monitoring:incident.critical":
        "Re-fired after resolve: {{payload.data.refLabel}}{{payload.data.title}} ({{payload.data.source}})",
      "incident:reopened|monitoring:incident.warning":
        "Re-fired after resolve: {{payload.data.refLabel}}{{payload.data.title}} ({{payload.data.source}})",
      "incident:escalated|monitoring:incident.critical":
        "Escalated to critical: {{payload.data.refLabel}}{{payload.data.title}} ({{payload.data.source}})",
      "incident:resolved|monitoring:incident.critical":
        "Resolved: {{payload.data.refLabel}}{{payload.data.title}} ({{payload.data.source}})",
      "incident:resolved|monitoring:incident.warning":
        "Resolved: {{payload.data.refLabel}}{{payload.data.title}} ({{payload.data.source}})",
    }
    const actual = Object.fromEntries(
      (MANIFEST.attention?.translations ?? []).map((t) => [`${t.event}|${t.kind}`, t.summary]),
    )
    expect(actual).toEqual(expected)
  })

  it("declares incident:commented without an attention translation (comments never ping the feed)", () => {
    expect(MANIFEST.events?.emits).toContain("incident:commented")
    expect((MANIFEST.attention?.translations ?? []).some((t) => t.event === "incident:commented")).toBe(false)
  })

  // the kernel marks a row urgent (it pushes outside work hours) from urgency
  // >= 70 (`t.isUrgent ?? urgency >= 70`, apps/api attention/translator.ts). Critical
  // incidents sit at 90 so they stay urgent with margin; warnings sit at 60, below it.
  it("critical alerts are urgent, warnings are not", () => {
    const notifying = ["incident:created", "incident:reopened", "incident:escalated"]
    const translations = (MANIFEST.attention?.translations ?? []).filter((t) =>
      notifying.includes(t.event),
    )
    const critical = translations.filter((t) => t.kind === "monitoring:incident.critical")
    const warning = translations.filter((t) => t.kind === "monitoring:incident.warning")
    // Not vacuous: every notifying event has a critical translation.
    for (const event of notifying) expect(critical.some((t) => t.event === event)).toBe(true)
    expect(warning.length).toBeGreaterThan(0)
    for (const t of critical) expect(t.urgency, t.event).toBe(90)
    for (const t of warning) expect(t.urgency, t.event).toBe(60)
    // A critical kind is only ever written for critical severity, and warning for warning.
    for (const t of translations) {
      expect(t.when?.path).toBe("data.severity")
      expect(t.when?.value).toBe(t.kind.split(".").pop())
    }
  })

  // Resolved rows mark the unread rows read and never route or push: urgency 0, no alert.
  it("resolved translations clear the row and never notify", () => {
    const translations = MANIFEST.attention?.translations ?? []
    const resolved = translations.filter((t) => t.event === "incident:resolved")
    expect(resolved.map((t) => t.kind).sort()).toEqual([
      "monitoring:incident.critical",
      "monitoring:incident.warning",
    ])
    for (const t of resolved) {
      expect(t.urgency).toBe(0)
      expect(t.resolveWhen).toBeDefined()
    }
    for (const t of translations.filter((x) => x.event !== "incident:resolved")) {
      expect(t.resolveWhen).toBeUndefined()
    }
  })

  // A source tab is named after its source (profile label, else raw id), not
  // the generic "Source": the tab type resolves its label from the UI bundle.
  it("names a source tab through a resolveLabel the UI bundle exports", async () => {
    const views = (MANIFEST as unknown as {
      views: { tabTypes: Record<string, { resolveLabel?: string }> }
    }).views
    expect(views.tabTypes.source?.resolveLabel).toBe("resolveSourceTabLabel")
    const ui = await import("./ui/tab-labels")
    expect(typeof ui.resolveSourceTabLabel).toBe("function")
  })

  // Settings > Apps labels each connection with its purpose and demotes the
  // optional ones (a bare "Connect" made a working app look uninstalled).
  it("declares what each connection connects, and which ones are optional", () => {
    const c = (MANIFEST as unknown as {
      connections: Record<string, { purpose?: string; optional?: boolean }>
    }).connections
    expect(c["alert-source"]?.purpose).toBe("Alert webhook")
    expect(c["alert-source"]?.optional === true).toBe(true)
  })

  // The alert webhook only receives a delivery when the watchdog has something critical
  // to say, so a healthy day is a silent day. Its sender is our own watchdog, whose
  // liveness the heartbeat already covers, so there is no upstream to probe.
  it("declares a probe-less webhook-health contract with its reason", () => {
    expect(MANIFEST.webhookHealth?.probe).toBeNull()
    expect(MANIFEST.webhookHealth?.reason).toContain("watchdog")
  })

  it("validates against packageManifestSchema (freeze-time zod)", () => {
    const r = packageManifestSchema.safeParse(MANIFEST)
    if (!r.success) console.error(JSON.stringify(r.error.issues, null, 2))
    expect(r.success).toBe(true)
  })

  it("exports every referenced tool handler, webhook handler, and verifier", () => {
    const exported = new Set(Object.keys(handlers))
    const missing: string[] = []
    for (const [name, t] of Object.entries(MANIFEST.tools ?? {})) {
      if (!exported.has(t.handler)) missing.push(`tools.${name}.handler=${t.handler}`)
    }
    for (const [name, j] of Object.entries(MANIFEST.jobs ?? {})) {
      if (!exported.has(j.handler)) missing.push(`jobs.${name}.handler=${j.handler}`)
    }
    for (const [topic, w] of Object.entries(MANIFEST.webhooks ?? {})) {
      if (!exported.has(w.handler)) missing.push(`webhooks.${topic}.handler=${w.handler}`)
      if (!exported.has(w.verify)) missing.push(`webhooks.${topic}.verify=${w.verify}`)
    }
    expect(missing).toEqual([])
  })

  it("declares every incident lifecycle event the handlers emit", () => {
    const emits = new Set(MANIFEST.events?.emits ?? [])
    for (const ev of [
      "incident:created",
      "incident:reopened",
      "incident:escalated",
      "incident:repeated",
      "incident:acknowledged",
      "incident:resolved",
      "incident:commented",
    ]) {
      expect(emits.has(ev)).toBe(true)
    }
  })

  it("attention translations reference declared events, use scope_holders recipients with a declared scope, and read payload.data fields", () => {
    const emits = new Set(MANIFEST.events?.emits ?? [])
    const scopes = new Set(MANIFEST.scopes)
    const translations = MANIFEST.attention?.translations ?? []
    expect(translations.length).toBeGreaterThan(0)
    for (const t of translations) {
      expect(emits.has(t.event)).toBe(true)
      expect(t.recipients.kind).toBe("scope_holders")
      expect(scopes.has(t.recipients.scope ?? "")).toBe(true)
      // Kernel translator resolves `{{payload.data.*}}` (see kernel-translations.ts).
      // Bare `{{data.*}}` silently renders empty — guard against that regression.
      expect(t.summary).toMatch(/\{\{\s*payload\.data\./)
      expect(t.summary).not.toMatch(/\{\{\s*data\./)
    }
    // Both critical and warning creation paths surface in the feed.
    const kinds = translations.filter((t) => t.event === "incident:created").map((t) => t.kind)
    expect(kinds).toContain("monitoring:incident.critical")
    expect(kinds).toContain("monitoring:incident.warning")
    // The flood-control invariant: repeats never translate to attention.
    expect(translations.some((t) => t.event === "incident:repeated")).toBe(false)
  })
})
