// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql } from "~/db/connection"
import { resolveRequiredScopes } from "~/modules/agent/scopes/required-scopes"
import { resolveAllSkills } from "~/modules/agent/tools/skills-routines-tools"
import {
  entityRegistry,
  manifestRegistry,
  resetAppRegistries,
  skillRegistry,
  toolRegistry,
  webhookHandlers,
} from "~/modules/apps/app-registries"
import { validateParamsForTool } from "~/modules/apps/execute-tool"
import { registerApps, teardownAppRegistrations } from "~/modules/apps/runtime"
import {
  resetWebhookIngestHealth,
  webhookProbeJob,
  webhookUpstreamProbeApps,
} from "~/modules/webhooks/ingest-health"

const TEST_ORG = "00000000-0000-0000-0000-000000120001"

describe("registerApps — manifest format", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${TEST_ORG}, 'Manifest Test Org', 'manifest-test')
      ON CONFLICT (id) DO NOTHING`
  })

  afterEach(() => resetAppRegistries())

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "app_manifest_app" CASCADE`)
    await sql.unsafe(`DROP SCHEMA IF EXISTS "app_manifest_app_untrusted" CASCADE`)
    await sql.unsafe(`DROP SCHEMA IF EXISTS "app_ui_app" CASCADE`)
    await sql.unsafe(`DROP SCHEMA IF EXISTS "app_ui_app_noui" CASCADE`)
    await sql`DELETE FROM kernel.apps WHERE name = 'manifest-app'`
    await sql`DELETE FROM kernel.apps WHERE name = 'manifest-app-untrusted'`
    await sql`DELETE FROM kernel.apps WHERE name = 'manifest-app-probe'`
    await sql`DELETE FROM kernel.organizations WHERE id = ${TEST_ORG}`
  })

  it("registers a manifest-format app and populates tool registry with handler tuples", async () => {
    const manifest = {
      name: "manifest-app",
      version: "1.0.0",
      _format: "manifest" as const,
      _bundlePath: "/apps/manifest-app/handlers.js",
      schema: {
        items: {
          fields: { title: "string", status: "string" },
        },
      },
      tools: {
        listItems: {
          description: "List items",
          requiredScopes: ["manifest-app:items:read"],
          handler: "listItems",
        },
      },
      webhooks: {
        inbound: {
          verify: "verifyInbound",
          handler: "handleInbound",
        },
      },
      webhookHealth: { probe: null, reason: "test fixture" },
      entities: {
        items: { labelField: "title", handlePrefix: "item" },
      },
      events: { emits: ["items:created"] },
    }

    await registerApps([manifest as any], TEST_ORG)

    // Tool registered with handler tuple
    const tool = toolRegistry.get([TEST_ORG, "manifest-app", "listItems"])
    expect(tool).toBeDefined()
    expect(tool!.handler).toEqual({
      bundlePath: "/apps/manifest-app/handlers.js",
      exportName: "listItems",
      core: false,
    })
    expect(tool!.requiredScopes).toEqual(["manifest-app:items:read"])

    const webhook = webhookHandlers.get([TEST_ORG, "manifest-app", "inbound"])
    expect(webhook).toBeDefined()
    expect(webhook!.handler).toEqual({
      bundlePath: "/apps/manifest-app/handlers.js",
      exportName: "handleInbound",
      core: false,
    })
    expect(webhook!.verify).toEqual({
      bundlePath: "/apps/manifest-app/handlers.js",
      exportName: "verifyInbound",
      core: false,
    })

    // Entity registered
    const entity = entityRegistry.get([TEST_ORG, "manifest-app", "items"])
    expect(entity).toBeDefined()
    expect(entity!.labelField).toBe("title")
  })

  it("declares the app's webhook-health probe job to ingest health, and forgets it on unregister", async () => {
    resetWebhookIngestHealth()
    const manifest = {
      name: "manifest-app-probe",
      version: "1.0.0",
      _format: "manifest" as const,
      _bundlePath: "/apps/manifest-app-probe/handlers.js",
      jobs: { "probe-upstream": { handler: "probeUpstream", schedule: "*/15 * * * *" } },
      webhooks: { inbound: { verify: "verifyInbound", handler: "handleInbound" } },
      webhookHealth: { probe: "probe-upstream" },
    }
    await registerApps([manifest as any], TEST_ORG)
    expect(webhookHandlers.get([TEST_ORG, "manifest-app-probe", "inbound"])).toBeDefined()
    expect(webhookProbeJob("manifest-app-probe")).toBe("probe-upstream")
    expect(webhookUpstreamProbeApps()).toEqual(["manifest-app-probe"])
    await teardownAppRegistrations(TEST_ORG, "manifest-app-probe")
    expect(webhookUpstreamProbeApps()).toEqual([])
  })

  it("I9 — carries the manifest's declared scopes into the bridge manifest on every tool", async () => {
    // Without this, `manifestForBridge.scopes` is undefined and the bridge's
    // grants_setUserScopes intersection against the app's declared ceiling is
    // inert (an app could grant any in-namespace scope).
    const declaredScopes = ["scopes-app:items:read", "scopes-app:items:write"]
    const manifest = {
      name: "scopes-app",
      version: "1.0.0",
      _format: "manifest" as const,
      _bundlePath: "/apps/scopes-app/handlers.js",
      scopes: declaredScopes,
      schema: { items: { fields: { title: "string" } } },
      tools: {
        listItems: {
          description: "List items",
          requiredScopes: ["scopes-app:items:read"],
          handler: "listItems",
        },
      },
      events: { emits: ["items:created"] },
    }
    await registerApps([manifest as never], TEST_ORG)
    const tool = toolRegistry.get([TEST_ORG, "scopes-app", "listItems"]) as
      | { _manifest?: { scopes?: string[] } }
      | undefined
    expect(tool?._manifest?.scopes).toEqual(declaredScopes)

    await sql.unsafe(`DROP SCHEMA IF EXISTS "app_scopes_app" CASCADE`)
    await sql`DELETE FROM kernel.apps WHERE name = 'scopes-app'`
  })

  it("copies a manifest tool's requiredScopes onto its registry entry", async () => {
    const required = ["reqscopes-app:items:read", "reqscopes-app:items:write"]
    const manifest = {
      name: "reqscopes-app",
      version: "1.0.0",
      _format: "manifest" as const,
      _bundlePath: "/apps/reqscopes-app/handlers.js",
      scopes: required,
      schema: { items: { fields: { title: "string" } } },
      tools: {
        syncItems: {
          description: "Sync items",
          requiredScopes: required,
          handler: "syncItems",
        },
      },
      events: { emits: ["items:created"] },
    }
    try {
      await registerApps([manifest as never], TEST_ORG)
      const tool = toolRegistry.get([TEST_ORG, "reqscopes-app", "syncItems"])
      expect(tool).toBeDefined()
      expect(tool?.requiredScopes).toEqual(required)
      expect(resolveRequiredScopes(tool!)).toEqual(required)
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "app_reqscopes_app" CASCADE`)
      await sql`DELETE FROM kernel.apps WHERE name = 'reqscopes-app'`
    }
  })

  // One app whose tools carry the scope-taint declarations.
  const taintDeclApp = (
    trusted?: boolean,
    vouch: { _firstParty?: boolean; _publisherSigned?: boolean } = {},
  ) => ({
    name: "taintdecl-app",
    version: "1.0.0",
    _format: "manifest" as const,
    _bundlePath: "/apps/taintdecl-app/handlers.js",
    ...(trusted === undefined ? {} : { trusted }),
    ...vouch,
    scopes: ["taintdecl-app:items:read", "taintdecl-app:items:write"],
    schema: { items: { fields: { title: "string" } } },
    tools: {
      writeItems: {
        description: "Write items",
        requiredScopes: ["taintdecl-app:items:write"],
        writesToTable: "app_taintdecl_app.items",
        handler: "writeItems",
      },
      readItems: {
        description: "Read items",
        requiredScopes: ["taintdecl-app:items:read"],
        readOnly: true,
        handler: "readItems",
      },
      claimsKernelSink: {
        description: "Claims a sink outside its own schema",
        requiredScopes: ["taintdecl-app:items:write"],
        writesToTable: "kernel.messages",
        handler: "claimsKernelSink",
      },
      claimsKernelTable: {
        description: "Claims a kernel table that is not an enforcing sink",
        requiredScopes: ["taintdecl-app:items:write"],
        writesToTable: "kernel.files",
        handler: "claimsKernelTable",
      },
      claimsOtherApp: {
        description: "Claims another app's table",
        requiredScopes: ["taintdecl-app:items:write"],
        writesToTable: "app_projects.tasks",
        handler: "claimsOtherApp",
      },
    },
  })
  const cleanupTaintDeclApp = async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "app_taintdecl_app" CASCADE`)
    await sql`DELETE FROM kernel.apps WHERE name = 'taintdecl-app'`
  }

  it("copies a manifest tool's writesToTable and readOnly onto its registry entry", async () => {
    try {
      // An in-tree app, as discovery registers it: first party (init.ts), not core.
      await registerApps([taintDeclApp(undefined, { _firstParty: true }) as never], TEST_ORG)
      const get = (name: string) => toolRegistry.get([TEST_ORG, "taintdecl-app", name])
      expect(get("writeItems")?.writesToTable).toBe("app_taintdecl_app.items")
      expect(get("writeItems")?.readOnly).toBeUndefined()
      expect(get("readItems")?.readOnly).toBe(true)
      expect(get("readItems")?.writesToTable).toBeUndefined()
      // An in-tree app is first party: the platform vouches for its declarations, so it
      // may name a kernel ENFORCING sink it really writes through a kernel bridge.
      expect(get("claimsKernelSink")?.writesToTable).toBe("kernel.messages")
      // Any other table outside its own schema is dropped: a non-enforcing kernel table or
      // another app's table would describe a write the app cannot vouch for.
      expect(get("claimsKernelTable")?.writesToTable).toBeUndefined()
      expect(get("claimsOtherApp")?.writesToTable).toBeUndefined()
    } finally {
      await cleanupTaintDeclApp()
    }
  })

  it("a third-party app can never pass itself off as a kernel sink, signed or not", async () => {
    for (const vouch of [{}, { _publisherSigned: true }]) {
      try {
        await registerApps([taintDeclApp(false, vouch) as never], TEST_ORG)
        const get = (name: string) => toolRegistry.get([TEST_ORG, "taintdecl-app", name])
        // Dropped, so the tool counts as an undeclared write, refused on a tainted turn.
        expect({ vouch, w: get("claimsKernelSink")?.writesToTable }).toEqual({
          vouch,
          w: undefined,
        })
        expect(get("claimsKernelTable")?.writesToTable).toBeUndefined()
        expect(get("claimsOtherApp")?.writesToTable).toBeUndefined()
        expect(get("writeItems")?.writesToTable).toBe("app_taintdecl_app.items")
      } finally {
        await cleanupTaintDeclApp()
      }
    }
  })

  it("a sandboxed first-party app (the image's own catalog tarball) may name a kernel enforcing sink", async () => {
    try {
      await registerApps([taintDeclApp(false, { _firstParty: true }) as never], TEST_ORG)
      const get = (name: string) => toolRegistry.get([TEST_ORG, "taintdecl-app", name])
      expect(get("claimsKernelSink")?.writesToTable).toBe("kernel.messages")
      expect(get("claimsKernelTable")?.writesToTable).toBeUndefined()
    } finally {
      await cleanupTaintDeclApp()
    }
  })

  it("ignores readOnly on a sandboxed (untrusted) app, whose self-declaration proves nothing", async () => {
    try {
      await registerApps([taintDeclApp(false) as never], TEST_ORG)
      const get = (name: string) => toolRegistry.get([TEST_ORG, "taintdecl-app", name])
      expect(get("readItems")?.readOnly).toBeUndefined()
      expect(get("writeItems")?.writesToTable).toBe("app_taintdecl_app.items")
    } finally {
      await cleanupTaintDeclApp()
    }
  })

  it("a custom app's readOnly counts only as an enforced read-only run, and only when it has no outside host of its own", async () => {
    // A custom app of the test org itself (another org's key never registers here).
    const name = `roread-o${crypto.createHash("sha256").update(TEST_ORG).digest("hex").slice(0, 8)}`
    const customApp = (extra: Record<string, unknown> = {}) => ({
      name,
      version: "1.0.0",
      _format: "manifest" as const,
      _bundlePath: `/apps/${name}/handlers.js`,
      trusted: false,
      _installed: true,
      scopes: [`${name}:items:read`, `${name}:items:write`],
      ...extra,
      tools: {
        listItems: {
          description: "List items",
          requiredScopes: [`${name}:items:read`],
          readOnly: true,
          handler: "listItems",
        },
        addItem: {
          description: "Add an item",
          requiredScopes: [`${name}:items:write`],
          handler: "addItem",
        },
      },
    })
    const cases: Array<[Record<string, unknown>, boolean]> = [
      [{}, true],
      [{ network: { allowedDomains: ["api.example.com"] } }, false],
      [{ connections: { crm: { allowedDomains: ["crm.example.com"] } } }, false],
      [{ cross_app_calls: [{ target: "tickets__search" }] }, false],
    ]
    for (const [extra, honoured] of cases) {
      try {
        await registerApps([customApp(extra) as never], TEST_ORG)
        const get = (tool: string) => toolRegistry.get([TEST_ORG, name, tool])
        expect({ extra, readOnly: get("listItems")?.readOnly === true }).toEqual({
          extra,
          readOnly: honoured,
        })
        // Honoured only together with the enforcement: every run gets a read-only bridge.
        expect(get("listItems")?.readOnlyEnforced === true).toBe(honoured)
        // A tool that does not claim to read stays a write.
        expect(get("addItem")?.readOnly).toBeUndefined()
        expect(get("addItem")?.readOnlyEnforced).toBeUndefined()
      } finally {
        resetAppRegistries()
        await sql.unsafe(`DROP SCHEMA IF EXISTS "app_${name.replace(/-/g, "_")}" CASCADE`)
        await sql`DELETE FROM kernel.apps WHERE name = ${name}`
      }
    }
  })

  it("never takes taintFree from a manifest, trusted or not: only kernel code sets it", async () => {
    for (const trusted of [true, false]) {
      const app = taintDeclApp(trusted) as ReturnType<typeof taintDeclApp> & {
        tools: Record<string, unknown>
      }
      app.tools.claimsTaintFree = {
        description: "Claims to be taint-free",
        requiredScopes: ["taintdecl-app:items:read"],
        readOnly: true,
        taintFree: true,
        handler: "claimsTaintFree",
      }
      try {
        await registerApps([app as never], TEST_ORG)
        const entry = toolRegistry.get([TEST_ORG, "taintdecl-app", "claimsTaintFree"])
        expect(entry).toBeDefined()
        expect(entry?.taintFree).toBeUndefined()
      } finally {
        resetAppRegistries()
        await cleanupTaintDeclApp()
      }
    }
  })

  // One app at a given version whose single tool requires `requiredField`.
  const reparamAt = (version: string, requiredField: string) => ({
    name: "reparam-app",
    version,
    _format: "manifest" as const,
    _bundlePath: `/apps/reparam-app/${version}/handlers.js`,
    schema: { items: { fields: { title: "string" } } },
    tools: {
      send: {
        description: "Send",
        requiredScopes: ["reparam-app:items:write"],
        handler: "send",
        params: {
          type: "object",
          properties: { [requiredField]: { type: "string" } },
          required: [requiredField],
        },
      },
    },
  })
  const validateReparam = (params: unknown) => {
    const tool = toolRegistry.get([TEST_ORG, "reparam-app", "send"])
    if (!tool) throw new Error("reparam-app:send is not registered")
    return validateParamsForTool(tool, TEST_ORG, "reparam-app", "send", params)
  }

  it("validates params against the new schema after an in-process re-register at a new version", async () => {
    // A catalog upgrade re-registers in the same process, with no registry
    // reset. The compiled param validator must follow the new version's schema,
    // not stay on the one compiled for the previous version under the same
    // org/app/tool name.
    const at = reparamAt
    const validateNow = validateReparam
    try {
      await registerApps([at("1.0.0", "recipient") as never], TEST_ORG)
      expect(validateNow({ recipient: "a" })).toEqual({ recipient: "a" })

      // Same process, no resetAppRegistries: the live-upgrade path.
      await registerApps([at("1.1.0", "channel") as never], TEST_ORG)
      expect(validateNow({ channel: "email" })).toEqual({ channel: "email" })
      expect(() => validateNow({})).toThrow('"channel" is required')
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "app_reparam_app" CASCADE`)
      await sql`DELETE FROM kernel.apps WHERE name = 'reparam-app'`
    }
  })

  it("frees the replaced versions' param validators after in-process re-registers", async () => {
    // Each re-register installs a new schema object and validating compiles its
    // validator. Once replaced, neither may stay reachable: one shared Ajv kept
    // every schema it had compiled (and its validator, which points back at it)
    // alive from its code-generation scope. Only WeakRefs are held here.
    const versions = 6
    const registerAndValidate = async (i: number): Promise<WeakRef<object>> => {
      await registerApps([reparamAt(`2.0.${i}`, `field${i}`) as never], TEST_ORG)
      expect(validateReparam({ [`field${i}`]: "x" })).toEqual({ [`field${i}`]: "x" })
      const tool = toolRegistry.get([TEST_ORG, "reparam-app", "send"])
      return new WeakRef(tool?.params as object)
    }
    try {
      const schemas: WeakRef<object>[] = []
      for (let i = 0; i < versions; i++) schemas.push(await registerAndValidate(i))
      for (let k = 0; k < 5; k++) {
        Bun.gc(true)
        await Bun.sleep(10)
      }
      const replacedStillAlive = schemas.slice(0, -1).filter((r) => r.deref() !== undefined)
      expect(replacedStillAlive.length).toBe(0)
      // The registered version's schema is still in use, so still alive.
      expect(schemas[versions - 1].deref()).toBeDefined()
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "app_reparam_app" CASCADE`)
      await sql`DELETE FROM kernel.apps WHERE name = 'reparam-app'`
    }
  })

  it("validates manifest format and rejects invalid manifests", async () => {
    const badManifest = {
      name: "BAD NAME",
      version: "1.0.0",
      _format: "manifest" as const,
    }
    // Should not throw — just logs error and skips
    await registerApps([badManifest as any], TEST_ORG)
    // Nothing registered
    expect(toolRegistry.get([TEST_ORG, "BAD NAME", "anything"])).toBeUndefined()
  })

  it("marks a non-core app's manifest webhook handlers core: false", async () => {
    const manifest = {
      name: "manifest-app-untrusted",
      version: "1.0.1",
      _format: "manifest" as const,
      _bundlePath: "/apps/manifest-app-untrusted/handlers.js",
      trusted: false,
      scopes: ["manifest-app-untrusted:items:read"],
      schema: {
        items: {
          fields: { title: "string" },
        },
      },
      events: { emits: ["items:created"] },
      webhooks: {
        inbound: {
          verify: "verifyInbound",
          handler: "handleInbound",
        },
      },
      webhookHealth: { probe: null, reason: "test fixture" },
    }

    await registerApps([manifest as any], TEST_ORG)

    const webhook = webhookHandlers.get([TEST_ORG, "manifest-app-untrusted", "inbound"])
    expect(webhook!.handler).toEqual({
      bundlePath: "/apps/manifest-app-untrusted/handlers.js",
      exportName: "handleInbound",
      core: false,
    })
    expect(webhook!.verify).toEqual({
      bundlePath: "/apps/manifest-app-untrusted/handlers.js",
      exportName: "verifyInbound",
      core: false,
    })
  })

  it("sets uiBundleUrl to /api/apps/<name>/<version>/ui.js when descriptor has _uiBundlePath", async () => {
    const manifest = {
      name: "ui-app",
      version: "1.0.0",
      _format: "manifest" as const,
      _bundlePath: "/fake/bundle.js",
      _uiBundlePath: "/fake/installRoot/ui-app/1.0.0/ui.js",
      trusted: false,
      scopes: ["ui-app:items:read"],
      schema: { items: { fields: { title: "string" } } },
      events: { emits: ["items:created"] },
    }
    await registerApps([manifest as any], TEST_ORG)

    const entry = manifestRegistry.get([TEST_ORG, "ui-app"])
    expect(entry?.uiBundleUrl).toBe("/api/apps/ui-app/1.0.0/ui.js")

    // cleanup
    await sql`DELETE FROM kernel.apps WHERE name = 'ui-app' AND org_id = ${TEST_ORG}`
  })

  it("leaves uiBundleUrl null when descriptor lacks _uiBundlePath", async () => {
    const manifest = {
      name: "ui-app-noui",
      version: "1.0.0",
      _format: "manifest" as const,
      _bundlePath: "/fake/bundle.js",
      trusted: false,
      scopes: ["ui-app-noui:items:read"],
      schema: { items: { fields: { title: "string" } } },
      events: { emits: ["items:created"] },
    }
    await registerApps([manifest as any], TEST_ORG)

    const entry = manifestRegistry.get([TEST_ORG, "ui-app-noui"])
    expect(entry?.uiBundleUrl).toBeNull()

    await sql`DELETE FROM kernel.apps WHERE name = 'ui-app-noui' AND org_id = ${TEST_ORG}`
  })

  // End-to-end coverage of the real path a bundled app uses in production:
  // a manifest OBJECT (not a hand-populated skillRegistry entry) goes through
  // registerApps -> validateAppManifest -> registerSingleApp, and the
  // manifest's skills.<name>.autoAttach keyword must survive that whole trip
  // into resolveAllSkills's SkillRecord. This is the path
  // skill-autosurface.test.ts and skills-routines-tools.test.ts skip by
  // calling skillRegistry.set() directly.
  it("carries skills.<name>.autoAttach keywords from a manifest through registration into resolveAllSkills", async () => {
    const manifest = {
      name: "autoattach-app",
      version: "1.0.0",
      _format: "manifest" as const,
      skills: {
        "rush-parcel": {
          description: "Boxtal automation for outbound parcel labels",
          body: "x",
          autoAttach: { keywords: ["hurry the courier"], apps: ["boxtal"] },
        },
      },
    }

    await registerApps([manifest as any], TEST_ORG)

    try {
      const entry = skillRegistry.get([TEST_ORG, "autoattach-app", "rush-parcel"])
      expect(entry?.autoAttach).toEqual({ keywords: ["hurry the courier"], apps: ["boxtal"] })

      const userId = crypto.randomUUID()
      const resolved = await resolveAllSkills(TEST_ORG, userId, ["*"])
      const skill = resolved.find((r) => r.name === "rush-parcel")
      expect(skill?.autoAttachKeywords).toEqual(["hurry the courier"])
      expect(skill?.autoAttachApps).toEqual(["boxtal"])
    } finally {
      await sql`DELETE FROM kernel.apps WHERE name = 'autoattach-app' AND org_id = ${TEST_ORG}`
    }
  })
})
