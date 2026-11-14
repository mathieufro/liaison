// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A manifest key is only real once it is declared in the schema AND copied onto the registry
// entry: runtime.ts builds that entry by copying named fields one at a time, so a key whose
// copy line is missing reads undefined for every app in every org (runtime.ts says so next to
// `pinnedParams`). This table walks each tool key the manifest accepts and fails for the key
// whose copy is missing, naming it.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db/connection"
import {
  appBridgeManifestRegistry,
  resetAppRegistries,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { validateAppManifest } from "~/modules/apps/contract"
import { registerApps } from "~/modules/apps/runtime"
import { insertSql } from "~/seed/factories/org/test-rows"

const TEST_ORG = "00000000-0000-0000-0000-000000120004"
const APP = "carried-keys-app"
const SCHEMA = `app_${APP.replace(/-/g, "_")}`

/** A tool declaring one new key; `registry` is where the key lands on the registry entry. */
interface KeyCase {
  key: string
  tool: Record<string, unknown>
  registry: string
  expected: unknown
}

const CARD = { kind: "entity", pill: { label: "Item" }, title: "{{result.name}}" }
const WHEN = { field: "origin", equals: "outside" }

const CASES: KeyCase[] = [
  {
    key: "resultCard",
    tool: { resultCard: CARD, returns: { schema: { name: "string" } } },
    registry: "resultCard",
    expected: CARD,
  },
  {
    key: "editWith",
    tool: { gated: true, editWith: ["visible"] },
    registry: "editWith",
    expected: ["visible"],
  },
  {
    key: "runningLabel",
    tool: { runningLabel: "Reading items" },
    registry: "runningLabel",
    expected: "Reading items",
  },
  {
    key: "runningLabelKey",
    tool: { runningLabelKey: "carried.reading" },
    registry: "runningLabelKey",
    expected: "carried.reading",
  },
  {
    key: "pinnedOptionalOnRefs",
    tool: { gated: true, pinnedParams: ["guard"], pinnedOptionalOnRefs: true },
    registry: "pinnedOptionalOnRefs",
    expected: true,
  },
  {
    key: "approvalCard.pill",
    tool: { gated: true, approvalCard: { pill: { label: "Check first" } } },
    registry: "approvalCard",
    expected: { pill: { label: "Check first" } },
  },
  {
    key: "sinkReadersSelf",
    tool: { sinkReadersSelf: true },
    registry: "sinkReadersSelf",
    expected: true,
  },
  {
    key: "contentParams",
    tool: { contentParams: ["note"], params: { type: "object", properties: { note: {} } } },
    registry: "contentParams",
    expected: ["note"],
  },
  {
    key: "humanTurnOnly",
    tool: { humanTurnOnly: true },
    registry: "humanTurnOnly",
    expected: true,
  },
  { key: "dmOnly", tool: { dmOnly: true }, registry: "dmOnly", expected: true },
  { key: "feature", tool: { feature: "budgets" }, registry: "feature", expected: "budgets" },
  { key: "focusCore", tool: { focusCore: true }, registry: "focusCore", expected: true },
  {
    key: "focusCore (entity type)",
    tool: { focusCore: "document" },
    registry: "focusCore",
    expected: "document",
  },
  {
    key: "taintSourceWhen",
    tool: { taintSource: true, taintSourceWhen: WHEN },
    registry: "taintSourceWhenRow",
    expected: WHEN,
  },
  {
    key: "useInstead",
    tool: { agentVisible: false, useInstead: "visible" },
    registry: "useInstead",
    expected: "visible",
  },
]

function appWith(
  tools: Record<string, Record<string, unknown>>,
  extra: Record<string, unknown> = {},
) {
  return {
    name: APP,
    version: "1.0.0",
    _format: "manifest" as const,
    _bundlePath: `/apps/${APP}/handlers.js`,
    scopes: [`${APP}:items:read`],
    schema: { items: { fields: { title: "string" } } },
    tools: Object.fromEntries(
      Object.entries(tools).map(([name, tool]) => [
        name,
        {
          description: `Tool ${name}`,
          requiredScopes: [`${APP}:items:read`],
          handler: name,
          ...tool,
        },
      ]),
    ),
    ...extra,
  }
}

const toolName = (c: KeyCase) => c.key.replace(/[^A-Za-z]/g, "_")

async function cleanup() {
  await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
  await sql`DELETE FROM kernel.apps WHERE name = ${APP}`
}

describe("manifest keys carried onto the registry", () => {
  beforeAll(async () => {
    await sql.unsafe(
      insertSql(
        "kernel.organizations",
        { id: TEST_ORG, name: "Carried Keys Org", slug: "carried-keys" },
        { onConflictDoNothing: true },
      ),
    )
  })

  afterEach(async () => {
    resetAppRegistries()
    await cleanup()
  })

  afterAll(async () => {
    await cleanup()
    await sql`DELETE FROM kernel.organizations WHERE id = ${TEST_ORG}`
  })

  it("each new tool key on a fixture manifest reaches the registry entry", async () => {
    const tools = Object.fromEntries(CASES.map((c) => [toolName(c), c.tool]))
    tools.visible = {}
    const manifest = appWith(tools)
    // The fixture is a well-formed manifest: the schema accepts every key under test.
    const { _format, _bundlePath, ...declared } = manifest
    const judged = validateAppManifest(JSON.parse(JSON.stringify(declared)))
    expect(judged.success ? "" : judged.error).toBe("")

    // Some keys under test count only for an app the platform vouches for (contract.ts).
    await registerApps([{ ...manifest, _firstParty: true }], TEST_ORG)

    const missing: string[] = []
    for (const c of CASES) {
      const entry = toolRegistry.get([TEST_ORG, APP, toolName(c)]) as
        | Record<string, unknown>
        | undefined
      if (JSON.stringify(entry?.[c.registry]) !== JSON.stringify(c.expected)) {
        missing.push(`${c.key} -> entry.${c.registry}`)
      }
    }
    expect(missing).toEqual([])
  })

  it("a row condition carries the app's outside text fields, which say where text beside the rows comes from", async () => {
    const manifest = appWith(
      { reads: { taintSource: true, taintSourceWhen: WHEN } },
      { outsideTextFields: ["title"] },
    )
    await registerApps([manifest], TEST_ORG)
    const entry = toolRegistry.get([TEST_ORG, APP, "reads"]) as Record<string, unknown> | undefined
    expect(entry?.taintSourceWhenRow).toEqual({ ...WHEN, outsideFields: ["title"] })
  })

  it("activitySources reaches the registry entry", async () => {
    const sources = [
      {
        tool: "timeline",
        scope: `${APP}:items:read`,
        label: "Items",
        labelKey: "carried.items",
        filterKey: "items",
      },
    ]
    const manifest = appWith({ timeline: { readOnly: true } }, { activitySources: sources })
    const { failedApps } = await registerApps([manifest], TEST_ORG)
    expect(failedApps).toEqual([])
    expect(appBridgeManifestRegistry.get([TEST_ORG, APP])?.activitySources).toEqual(sources)
  })

  it("a malformed activitySources entry is refused naming the app", async () => {
    const source = {
      tool: "timeline",
      scope: `${APP}:items:read`,
      label: "Items",
      filterKey: "items",
    }
    // A tool that writes, a tool the app lacks, and a scope the tool does not check.
    for (const [tools, entry, says] of [
      [{ timeline: {} }, source, "activitySources[0].tool: 'timeline' must be declared readOnly"],
      [{ visible: {} }, source, "activitySources[0].tool: 'timeline' is not a tool of this app"],
      [
        { timeline: { readOnly: true } },
        { ...source, scope: `${APP}:items:write` },
        "activitySources[0].scope",
      ],
      [{ timeline: { readOnly: true } }, { ...source, filterKey: undefined }, "filterKey"],
    ] as Array<[Record<string, Record<string, unknown>>, Record<string, unknown>, string]>) {
      const manifest = appWith(tools, { activitySources: [entry] })
      const { _format, _bundlePath, ...declared } = manifest
      const judged = validateAppManifest(JSON.parse(JSON.stringify(declared)))
      expect(judged.success ? "" : judged.error).toContain(says)
      const { failedApps } = await registerApps([manifest], TEST_ORG)
      expect(failedApps).toEqual([APP])
      expect(appBridgeManifestRegistry.get([TEST_ORG, APP])).toBeUndefined()
      resetAppRegistries()
      await cleanup()
    }
  })

  it("a sink-reader declaration refuses an app nobody vouched for, so nothing is carried", async () => {
    const manifest = appWith({
      put: {
        sinkReadersSelf: true,
        contentParams: ["note"],
        params: { type: "object", properties: { note: {} } },
      },
    })
    const { failedApps } = await registerApps([manifest], TEST_ORG)
    expect(failedApps).toEqual([APP])
    expect(toolRegistry.get([TEST_ORG, APP, "put"])).toBeUndefined()
  })

  it("a call-place declaration refuses an app nobody vouched for, so nothing is carried", async () => {
    for (const key of ["humanTurnOnly", "dmOnly"]) {
      const manifest = appWith({ put: { readOnly: true, [key]: true } })
      const { failedApps } = await registerApps([manifest], TEST_ORG)
      expect({ key, failedApps }).toEqual({ key, failedApps: [APP] })
      expect(toolRegistry.get([TEST_ORG, APP, "put"])).toBeUndefined()
      resetAppRegistries()
    }
  })
})

describe("slot declarations", () => {
  const manifestWithSlots = (slots: Record<string, unknown>) => ({
    name: "slot-keys-app",
    version: "1.0.0",
    slots,
  })

  it("a colon slot key with panels and no position validates", () => {
    const judged = validateAppManifest(
      manifestWithSlots({
        "ticket:detail:panel": {
          panels: [
            {
              id: "customer",
              label: "Customer",
              component: "CustomerPanel",
              visibility_scope: "slot-keys-app:customers:read",
              order: 2,
              group: "carried.group",
            },
          ],
        },
        "ticket:detail:actions": {
          actions: [{ id: "refund", label: "Refund", component: "RefundAction" }],
        },
      }),
    )
    expect(judged.success ? "" : judged.error).toBe("")
  })

  it("a slot key that only names a position still validates", () => {
    const judged = validateAppManifest(
      manifestWithSlots({ "ticket:detail:tabs": { position: "tabs" } }),
    )
    expect(judged.success ? "" : judged.error).toBe("")
  })

  it("a slot key with neither fails naming it", () => {
    const judged = validateAppManifest(manifestWithSlots({ "ticket:detail:panel": {} }))
    expect(judged.success).toBe(false)
    expect(judged.success ? "" : judged.error).toContain("ticket:detail:panel")
  })
})

describe("manifest key shapes", () => {
  const base = { name: "shape-keys-app", version: "1.0.0" }
  const tool = (extra: Record<string, unknown>) => ({
    ...base,
    tools: {
      get: {
        description: "Get",
        requiredScopes: ["shape-keys-app:items:read"],
        handler: "get",
        ...extra,
      },
    },
  })
  const errorOf = (m: unknown) => {
    const judged = validateAppManifest(m)
    return judged.success ? "" : judged.error
  }

  it("accepts the app-level keys with their declared shapes", () => {
    expect(
      errorOf({
        ...tool({ readOnly: true }),
        contextProviders: [
          {
            on: ["tickets:ticket"],
            tool: "get",
            scope: "shape-keys-app:items:read",
            loadTools: ["get"],
          },
        ],
        sendGuardProviders: {
          invoice: { tool: "guard", serviceMessage: true, pill: { label: "Check" } },
        },
        features: {
          budgets: {
            adminScope: "shape-keys-app:items:write",
            labelKey: "shape.budgets",
            offMessageKey: "shape.off",
            offNextKey: "shape.next",
          },
        },
        outsideTextFields: ["customer_name"],
        approvalRoute: { invoice: "get" },
        entities: { items: { labelField: "title", discussion: true } },
        attention: { groupLabel: { label: "Items", labelKey: "shape.items" }, translations: [] },
        routines: {
          digest: {
            description: "Digest",
            kind: "recurring",
            cron: "0 8 * * 1",
            timezone: "UTC",
            promptTemplate: "Send the digest",
            scopes: [],
            enabledByDefault: false,
            followUp: true,
          },
        },
      }),
    ).toBe("")
  })

  it("accepts a tool key declaring a feature and a hidden tool's replacement", () => {
    expect(errorOf(tool({ feature: "budgets", agentVisible: false, useInstead: "get" }))).toBe("")
  })

  it("refuses a pinned-optional flag without pinned params", () => {
    expect(errorOf(tool({ gated: true, pinnedOptionalOnRefs: true }))).toContain("pinnedParams")
  })

  it("refuses a result card that is not an object", () => {
    expect(errorOf(tool({ resultCard: "entity" }))).toContain("resultCard")
  })
})
