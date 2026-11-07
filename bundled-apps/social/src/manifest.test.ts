// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { packageManifestSchema } from "@liaison/app-sdk"

const MANIFEST_PATH = join(import.meta.dir, "..", "app.manifest.json")
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"))

describe("social manifest (B1)", () => {
  test("validates against packageManifestSchema (freeze-time zod)", () => {
    const r = packageManifestSchema.safeParse(manifest)
    if (!r.success) console.error(JSON.stringify(r.error.issues, null, 2))
    expect(r.success).toBe(true)
  })

  test("is name 'social', version 0.6.41, packageFormat 1", () => {
    expect(manifest.name).toBe("social")
    // 0.6.38: settings move to the declarative page (manifest `settings`).
    // 0.6.39: store listing (manifest `listing`: category, icon, summary, source repository).
    // 0.6.40: Facebook and Instagram connections name the account (displayNameUrl).
    // 0.6.41: the Google (YouTube) connection names the account by its channel.
    // 0.6.42: the manifest declares its host API range (`host: "^1"`) instead of sdkVersion.
    // 0.6.43: reply_to_finding and send_dm declare their outbound text (outboundTextParams).
    // 0.6.45: the icon as data (`iconName`), drawn when the UI runs framed; the UI reads the page's path with `currentPath()`.
    // 0.6.49: Graph API v26.0 (v21.0 ends 2027-01-21); `instagram_unified` (Unified login) declared as a preview.
    // 0.6.50: every HUMAN setup step says its own minutes.
    // 0.6.53: reply, DM and like approvals use their summarizers again (the comment, the post, a link).
    // 0.6.54: an upstream timeout during the DM sync logs a warning with a reason, not an error;
    // six deferred syncs in a row log one error.
    // 0.6.55: in the managed edition, Meta webhook setup points at the server-level callback routed per org.
    // 0.6.56: the app's own install resolves the control-plane contract through an override
    // (the shared package depends on it by workspace protocol); no change to what it does.
    // 0.6.57: the same number (0.6.56) carried different content on two lines of work; this one has both.
    // 0.6.58: above both lines of work, which each changed it under the number before; no change of its own.
    // 0.6.60: the shared host package gained the discussion panel hooks; no change of its own.
    expect(manifest.version).toBe("0.6.62")
    expect(manifest.packageFormat).toBe(1)
  })

  test("every gated tool with a summarizer export declares it, with its context read", async () => {
    const handlers = (await import("../handlers")) as Record<string, unknown>
    const exported = Object.keys(handlers).filter((k) => k.startsWith("summarize") && typeof handlers[k] === "function")
    const tools = manifest.tools as Record<string, { summarizer?: string; summarizerContext?: { tool: string } }>
    const declared = Object.values(tools).map((t) => t.summarizer).filter((s): s is string => typeof s === "string")
    expect(exported.length).toBeGreaterThan(0)
    expect(declared.sort()).toEqual(exported.sort())
    for (const t of Object.values(tools)) {
      if (t.summarizerContext) expect(tools[t.summarizerContext.tool]).toBeDefined()
    }
  })

  test("judges its webhooks by the upstream probe job", () => {
    expect((manifest as { webhookHealth?: unknown }).webhookHealth).toEqual({ probe: "probe-webhook-upstream" })
    expect(typeof manifest.jobs?.["probe-webhook-upstream"]?.schedule).toBe("string")
  })

  test("declares the six app tables", () => {
    expect(Object.keys(manifest.schema)).toEqual(
      expect.arrayContaining([
        "finding",
        "watched_object",
        "dm_conversation",
        "dm_message",
        "monitor_term",
        "sync_state",
      ]),
    )
  })

  test("emits finding:created", () => {
    expect(manifest.events.emits).toContain("finding:created")
  })

  test("every scope and tool scope is social-prefixed", () => {
    for (const s of manifest.scopes as string[]) {
      expect(s.startsWith("social:")).toBe(true)
    }
    for (const tool of Object.values(manifest.tools ?? {}) as Array<{ requiredScopes: string[] }>) {
      for (const scope of tool.requiredScopes) expect(scope.startsWith("social:")).toBe(true)
    }
  })

  test("tabTypes keys are findings/messages/watched (B9 ui.tsx must match)", () => {
    expect(Object.keys(manifest.views.tabTypes).sort()).toEqual([
      "findings",
      "messages",
      "watched",
    ])
  })

  test("dm_message.conversation_id FK cascades on delete", () => {
    const fk = manifest.schema.dm_message.fields.conversation_id.references
    expect(fk.table).toBe("dm_conversation")
    expect(fk.onDelete).toBe("cascade")
  })

  test("inbound-content read tools declare taintSource (reading external posts/DMs taints the thread)", () => {
    // findings_*/dm_* return third-party posts/comments and inbound DMs — reading
    // them must mark the thread tainted so the containment story holds (hardened
    // orgs can then block downstream escalation). watched_list hands back each
    // watched post's title, which its author wrote, so it is one of them. The
    // write/internal tools and metadata-only reads (terms/counts) do NOT return
    // external content.
    const tools = manifest.tools as Record<string, { taintSource?: boolean }>
    for (const id of ["findings_list", "findings_get", "dm_list", "dm_get", "watched_list"]) {
      expect(tools[id]?.taintSource, `${id} must declare taintSource`).toBe(true)
    }
    for (const id of ["monitor_terms_list", "counts", "set_triage"]) {
      expect(tools[id]?.taintSource ?? false, `${id} must NOT declare taintSource`).toBe(false)
    }
  })

  test("every gated post-back tool declares a preflight that resolves to a real export", async () => {
    // Gated tools park a pending approval before the handler runs, so validation that lives only in
    // the handler reaches the human as an error only the agent could have fixed. Each of the three
    // post-back tools must refuse at staging instead.
    const handlers = (await import("./handlers")) as Record<string, unknown>
    const tools = manifest.tools as Record<string, { gated?: boolean; preflight?: string }>
    for (const id of ["reply_to_finding", "send_dm", "like_item"]) {
      expect(tools[id]?.gated, `${id} is expected to be gated`).toBe(true)
      const name = tools[id]?.preflight
      expect(name, `${id} must declare a preflight`).toBeTruthy()
      expect(typeof handlers[name!], `${name} must be exported from handlers`).toBe("function")
    }
  })
})

// The declarative settings page (/settings/apps/social): connections, the
// monitor terms as a list bound to the term tools, the quota read-out as the one
// custom block. No views.settings page remains.
describe("social declarative settings", () => {
  const sections = manifest.settings?.sections ?? []
  const blocks = sections.flatMap((s: { blocks: Array<Record<string, unknown>> }) => s.blocks)

  test("names each connection the connections block lists", () => {
    const purposes = Object.fromEntries(
      Object.entries(manifest.connections as Record<string, { purpose?: string }>).map(([n, c]) => [n, c.purpose]),
    )
    expect(purposes).toEqual({
      instagram: "Instagram account",
      instagram_unified: "Instagram account (Unified login, preview)",
      facebook: "Facebook Page",
      google: "Google account (YouTube)",
    })
  })

  test("declares settings and no views.settings", () => {
    expect(sections.map((s: { id: string }) => s.id)).toEqual(["connections", "terms", "quota"])
    expect(manifest.views.settings).toBeUndefined()
  })

  test("the terms list is bound to the term tools and removes in the destructive style", () => {
    const list = blocks.find((b: Record<string, unknown>) => b.block === "list") as {
      ops: Record<string, string>
      archiveLabel?: string
    }
    expect(list.ops).toEqual({
      list: "monitor_terms_list",
      create: "monitor_terms_add",
      archive: "monitor_terms_remove",
    })
    expect(list.archiveLabel).toBe("Remove")
    for (const tool of Object.values(list.ops)) expect(manifest.tools[tool]).toBeDefined()
  })

  test("the quota block is exported from the UI barrel", () => {
    const custom = blocks.filter((b: Record<string, unknown>) => b.block === "custom")
    expect(custom.map((b: Record<string, unknown>) => b.component)).toEqual(["SocialQuota"])
    const barrel = readFileSync(join(import.meta.dir, "ui", "index.tsx"), "utf8")
    expect(barrel).toContain("SocialQuota")
  })
})

// Meta's Instagram API with Unified login, for Meta apps that no longer offer
// API setup with Instagram login: declared, marked as a preview, never a
// replacement of `instagram`.
describe("instagram_unified connection (preview)", () => {
  const conn = manifest.connections.instagram_unified
  const legacy = manifest.connections.instagram

  test("signs in with Facebook Login for Business and the deployment's configuration id", () => {
    expect(conn.type).toBe("oauth2")
    expect(conn.authorizationUrl).toBe("https://www.facebook.com/v26.0/dialog/oauth")
    expect(conn.tokenUrl).toBe("https://graph.facebook.com/v26.0/oauth/access_token")
    // The configuration carries the permissions: no `scope` is sent.
    expect(conn.scopes).toEqual([])
    expect(conn.extraParams).toEqual({ override_default_response_type: "true" })
    expect(conn.authorizeConfigParams).toEqual({
      config_id: { configKey: "instagramLoginConfigurationId", pattern: "^[0-9]{1,30}$" },
    })
    expect(manifest.configKeys).toContainEqual(
      expect.objectContaining({ key: "instagramLoginConfigurationId", type: "string" }),
    )
  })

  test("takes the Instagram account from the assigned accounts, never one of several silently", () => {
    expect(conn.userinfoUrl).toBe("https://graph.facebook.com/v26.0/me/assigned_instagram_accounts?fields=id,username")
    expect(conn.identifierFromUserinfoPath).toBe("data[].id")
    expect(conn.accountNameField).toBe("username")
    // System-user token: no long-lived exchange, no refresh.
    expect(conn.longLivedTokenUrl).toBeUndefined()
    expect(conn.refreshTokenUrl).toBeUndefined()
  })

  test("is an optional preview whose guide says so, picks Never and how to revoke", () => {
    expect(conn.optional).toBe(true)
    expect(conn.description).toStartWith("Preview: reads pending verification.")
    expect(conn.setupGuide.summary).toContain("Preview: reads pending verification")
    expect(conn.setupGuide.summary).toContain("remove the app from the business portfolio")
    const text = conn.setupGuide.steps.map((s: { text: string }) => s.text).join("\n")
    expect(text).toContain("**Business settings > Accounts > Instagram accounts**")
    expect(text).toContain("**Manage messaging & content on Instagram**")
    expect(text).toContain("**API setup with Unified login**")
    expect(text).toContain("**Create new configuration**")
    expect(text).toContain("choose **Never**")
    expect(text).toContain("**Configuration ID**")
    for (const step of conn.setupGuide.steps as Array<{ who: string; minutes?: number; url?: string; place?: string }>) {
      expect(typeof step.minutes).toBe("number")
      if (step.who === "human") expect(step.url ?? step.place).toBeTruthy()
    }
  })

  test("leaves the Instagram-login connection as it was", () => {
    expect(legacy.authorizationUrl).toBe("https://www.instagram.com/oauth/authorize")
    expect(legacy.identifierFromTokenField).toBe("user_id")
    expect(legacy.scopes).toEqual([
      "instagram_business_basic",
      "instagram_business_manage_comments",
      "instagram_business_manage_messages",
    ])
  })

  test("is read by no job: nothing syncs through it yet", () => {
    for (const job of Object.values(manifest.jobs as Record<string, { runsFor?: { connection?: string[] } }>)) {
      expect(job.runsFor?.connection ?? []).not.toContain("instagram_unified")
    }
  })
})
