// SPDX-License-Identifier: FSL-1.1-ALv2
//
// tool_search must SURFACE scope-locked tools (flagged `locked` + `requiredScope`) rather than
// silently omitting them — otherwise a weak agent that lacks a scope never learns the capability
// exists and FABRICATES that it acted (the BL-254 / l499 convert-vip failure: the agent lacked
// tickets:tickets:write, the ungated create/addNote tools never appeared in tool_search, and it
// claimed it logged a note it never could). A visible locked match is the truthful "this exists
// but I lack permission" signal — which flows to the chat UI / persona / judge via the agent reply.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import {
  compactToolSearchResult,
  handleToolSearch,
  scoreDeferredTools,
  TOOL_SEARCH_BYTE_BUDGET,
  TOOL_SEARCH_MAX_RESULTS,
  toolSynopsis,
} from "~/modules/agent/tools/tool-search"
import { toolRegistry } from "~/modules/apps/app-registries"

const ORG = "00000000-0000-0000-0000-000000000a17"

// Holds the READ scope but NOT the write scope — the convert-vip shape (tomas had tickets:read only).
const ACTOR = {
  actorType: "agent" as const,
  userId: "00000000-0000-0000-0000-000000000a18",
  orgId: ORG,
  scopes: ["widgets:widgets:read"],
  dimensionGrants: {},
} as any

beforeAll(() => {
  toolRegistry.set([ORG, "widgets", "search"], {
    appName: "widgets",
    name: "search",
    description: "Search widgets.",
    requiredScopes: ["widgets:widgets:read"],
    handler: async () => ({ ok: true }),
    deferLoading: true,
  } as any)
  toolRegistry.set([ORG, "widgets", "create"], {
    appName: "widgets",
    name: "create",
    description: "Create a widget.",
    requiredScopes: ["widgets:widgets:write"], // actor LACKS this
    handler: async () => ({ ok: true }),
    deferLoading: true,
  } as any)
  // A routine-only tool: CALLABLE only inside a routine tick (NOT deferLoading), but it MUST
  // be discoverable via tool_search so the routine-authoring agent learns it exists. Mirrors the
  // real kernel web_watch / watch_state registration shape (the ines-weekly-review-watch surface).
  toolRegistry.set([ORG, "widgets", "watch_widget"], {
    appName: "widgets",
    name: "watch_widget",
    description: "Watch a widget page and diff it across ticks.",
    requiredScopes: ["widgets:widgets:read"], // actor HOLDS this — routine-only, not scope-locked
    handler: async () => ({ ok: true }),
    routineOnly: true,
  } as any)
})

afterAll(() => {
  toolRegistry.delete([ORG, "widgets", "search"])
  toolRegistry.delete([ORG, "widgets", "create"])
  toolRegistry.delete([ORG, "widgets", "watch_widget"])
})

describe("tool_search on a tool declared with requiredScopes only", () => {
  const MULTI_ORG = "00000000-0000-0000-0000-000000000a19"

  beforeAll(() => {
    // The manifest projection shape: requiredScopes only, no `scope`.
    toolRegistry.set([MULTI_ORG, "gadgets", "rebuild"], {
      appName: "gadgets",
      name: "rebuild",
      description: "Rebuild the gadget index.",
      requiredScopes: ["gadgets:index:read", "gadgets:index:write"],
      handler: async () => ({ ok: true }),
      deferLoading: true,
    } as any)
  })

  afterAll(() => {
    toolRegistry.deleteByPrefix([MULTI_ORG])
  })

  it("names the missing scope instead of a question mark", async () => {
    const actor = { ...ACTOR, orgId: MULTI_ORG, scopes: ["gadgets:index:read"] }
    const res = await handleToolSearch(
      { query: "gadget" },
      { orgId: MULTI_ORG, userId: actor.userId, scopes: actor.scopes },
    )
    const rebuild = res.matches.find((m) => m.name === "gadgets__rebuild")
    expect(rebuild?.locked).toBe(true)
    expect(rebuild?.requiredScope).toBe("gadgets:index:write")
    expect(rebuild?.description).toContain("gadgets:index:write")
    expect(rebuild?.description).not.toContain("?")
  })
})

describe("tool_search surfaces scope-locked tools", () => {
  it("returns a write tool the actor lacks scope for, flagged locked + requiredScope", async () => {
    const res = await handleToolSearch(
      { query: "widgets" },
      { orgId: ORG, userId: ACTOR.userId, scopes: ACTOR.scopes },
    )
    const create = res.matches.find((m) => m.name === "widgets__create")
    const search = res.matches.find((m) => m.name === "widgets__search")

    // The usable read tool is present and NOT flagged locked.
    expect(search).toBeDefined()
    expect(search?.locked).toBeUndefined()

    // The locked write tool is SURFACED (not silently omitted), flagged with the exact scope.
    expect(create).toBeDefined()
    expect(create?.locked).toBe(true)
    expect(create?.requiredScope).toBe("widgets:widgets:write")
    // Description steers the agent away from fabrication and toward request_scope.
    expect(create?.description).toContain("🔒")
    expect(create?.description).toContain("widgets:widgets:write")
    expect(create?.description.toLowerCase()).toContain("request_scope")
  })

  it("available tools rank before locked ones (a locked match never crowds out a usable one)", async () => {
    const res = await handleToolSearch(
      { query: "widgets", maxResults: 2 },
      { orgId: ORG, userId: ACTOR.userId, scopes: ACTOR.scopes },
    )
    expect(res.matches[0]?.name).toBe("widgets__search") // usable first
    expect(res.matches[0]?.locked).toBeUndefined()
  })

  it("select: also surfaces a locked tool by exact name (so the agent can't miss it)", async () => {
    const res = await handleToolSearch(
      { query: "select:widgets__create" },
      { orgId: ORG, userId: ACTOR.userId, scopes: ACTOR.scopes },
    )
    expect(res.matches).toHaveLength(1)
    expect(res.matches[0]?.locked).toBe(true)
    expect(res.matches[0]?.requiredScope).toBe("widgets:widgets:write")
  })

  it("an actor WITH the write scope sees the tool unlocked (no locked flag)", async () => {
    const privileged = { ...ACTOR, scopes: ["widgets:widgets:read", "widgets:widgets:write"] }
    const res = await handleToolSearch(
      { query: "widgets" },
      { orgId: ORG, userId: privileged.userId, scopes: privileged.scopes },
    )
    const create = res.matches.find((m) => m.name === "widgets__create")
    expect(create).toBeDefined()
    expect(create?.locked).toBeUndefined()
    expect(create?.description).not.toContain("🔒")
  })
})

// Regression (ines-weekly-review-watch — tool-surface gap). The routine-only kernel tools
// (web_watch / watch_state) are NOT deferLoading — they are core tools merely execution-gated to
// routine ticks — so the OLD listDeferredTools (which only walked deferLoading tools) NEVER surfaced
// them. A routine-AUTHORING agent doing tool_search("web_watch") fell back to catalog (the judge's
// confirmed root cause: `fellBackToCatalog:true`, only an unrelated tool matched), never learned the
// real stateful-diff path existed, and improvised a manual knowledge-doc dedup. tool_search must
// surface a routine-only tool, flagged `routineOnly` with the ⏱ "reference it in a routine prompt"
// steer, so the authoring agent learns the capability and authors the right routine prompt.
describe("tool_search surfaces routine-only tools (discoverable to the authoring agent)", () => {
  it("returns a routine-only tool by keyword, flagged routineOnly + ⏱ reference-in-routine steer", async () => {
    const res = await handleToolSearch(
      { query: "watch widget" },
      { orgId: ORG, userId: ACTOR.userId, scopes: ACTOR.scopes },
    )
    const watch = res.matches.find((m) => m.name === "widgets__watch_widget")
    expect(watch).toBeDefined()
    // It is NOT scope-locked (the actor holds widgets:read) — it is routine-only.
    expect(watch?.locked).toBeUndefined()
    expect(watch?.routineOnly).toBe(true)
    // The description steers the agent to REFERENCE it in a create_routine prompt, not call it here.
    expect(watch?.description).toContain("⏱")
    expect(watch?.description.toLowerCase()).toContain("routine")
  })

  it("select: surfaces a routine-only tool by exact name (so the agent can't miss it)", async () => {
    const res = await handleToolSearch(
      { query: "select:widgets__watch_widget" },
      { orgId: ORG, userId: ACTOR.userId, scopes: ACTOR.scopes },
    )
    expect(res.matches).toHaveLength(1)
    expect(res.matches[0]?.routineOnly).toBe(true)
    expect(res.matches[0]?.description).toContain("⏱")
  })
})

// A keyword query that scores 0 against every deferred tool must not leave the catalog
// invisible: the agent would conclude the capability does not exist. It used to list a
// sample of five deferred tools, and a weak model called one of them as the answer. It
// now names the apps, with how many tools each has, and lists and loads no tool.
describe("a search nothing matches names the apps, never a sample of tools", () => {
  it("answers with each app by name and its tool count, and no tool", async () => {
    const privileged = { ...ACTOR, scopes: ["widgets:widgets:read", "widgets:widgets:write"] }
    const res = await handleToolSearch(
      { query: "zzznomatch totallyunrelated" },
      { orgId: ORG, userId: privileged.userId, scopes: privileged.scopes },
    )
    expect(res.totalDeferredTools).toBeGreaterThan(0)
    expect(res.matches).toEqual([])
    expect(res.fellBackToCatalog).toBe(true)
    expect(res.apps).toContainEqual({ name: "widgets", tools: 3 })
    expect(res.note).toContain("nothing was loaded")
    expect(res.note).toContain("widgets (3)")
  })

  it("does NOT fall back when the query DOES match (keyword hits win, no catalog dump)", async () => {
    const res = await handleToolSearch(
      { query: "widgets" },
      { orgId: ORG, userId: ACTOR.userId, scopes: ACTOR.scopes },
    )
    expect(res.matches.length).toBeGreaterThan(0)
    expect(res.fellBackToCatalog).toBeUndefined()
    expect(res.apps).toBeUndefined()
  })
})

describe("select: with a bare name two apps share", () => {
  const DUP_ORG = "00000000-0000-0000-0000-000000000a1a"
  const DUP = {
    userId: "00000000-0000-0000-0000-000000000a1b",
    scopes: ["shop:x:write", "pay:x:write"],
  }
  const tool = (app: string, name: string, description: string) =>
    toolRegistry.set([DUP_ORG, app, name], {
      appName: app,
      name,
      description,
      requiredScopes: [`${app}:x:write`],
      handler: async () => ({ ok: true }),
      deferLoading: true,
    } as any)

  beforeAll(() => {
    tool("shop", "refunds_create", "Refund an order in the shop.")
    tool("pay", "refunds_create", "Refund a card payment.")
    tool("shop", "orders_get", "Read one order.")
  })
  afterAll(() => toolRegistry.deleteByPrefix([DUP_ORG]))

  it("select:refunds_create loads none and lists both, each with its app", async () => {
    const frame = { discoveredTools: new Set<string>() } as any
    const { runContextStore } = await import("~/modules/agent/runtime/run-context")
    const res = await runContextStore.run(frame, () =>
      handleToolSearch({ query: "select:refunds_create" }, { orgId: DUP_ORG, ...DUP }),
    )
    expect(res.matches.map((m) => [m.name, m.appName]).sort()).toEqual([
      ["pay__refunds_create", "pay"],
      ["shop__refunds_create", "shop"],
    ])
    expect(frame.discoveredTools.size).toBe(0)
    expect(res.note).toContain("Not loaded")
    expect(res.note).toContain("more than one app")
  })

  it("a name in one app loads", async () => {
    const frame = { discoveredTools: new Set<string>() } as any
    const { runContextStore } = await import("~/modules/agent/runtime/run-context")
    await runContextStore.run(frame, () =>
      handleToolSearch(
        { query: "select:orders_get,shop__refunds_create" },
        { orgId: DUP_ORG, ...DUP },
      ),
    )
    expect([...frame.discoveredTools].sort()).toEqual(["shop__orders_get", "shop__refunds_create"])
  })
})

describe("a whole-app query", () => {
  const BIG_ORG = "00000000-0000-0000-0000-000000000a1c"
  const USER = { userId: "00000000-0000-0000-0000-000000000a1d", scopes: ["bigapp:x:read"] }
  beforeAll(() => {
    for (let i = 0; i < 26; i++) {
      toolRegistry.set([BIG_ORG, "bigapp", `step_${i}`], {
        appName: "bigapp",
        name: `step_${i}`,
        description: `Step ${i}.`,
        requiredScopes: ["bigapp:x:read"],
        handler: async () => ({ ok: true }),
        deferLoading: true,
      } as any)
    }
  })
  afterAll(() => toolRegistry.deleteByPrefix([BIG_ORG]))

  it("names how many tools it left out", async () => {
    const frame = { discoveredTools: new Set<string>() } as any
    const { runContextStore } = await import("~/modules/agent/runtime/run-context")
    const res = await runContextStore.run(frame, () =>
      handleToolSearch({ query: "bigapp" }, { orgId: BIG_ORG, ...USER }),
    )
    expect(res.matches).toHaveLength(20)
    expect(res.note).toContain("6 more bigapp tools were left out")
  })
})

describe("one ranker", () => {
  it("handleToolSearch and rankDeferredTools return the same names on a fixture", async () => {
    const { rankDeferredTools } = await import("~/modules/agent/tools/tool-rank")
    const { listDeferredTools } = await import("~/modules/agent/tools/tool-bridge")
    const privileged = { ...ACTOR, scopes: ["widgets:widgets:read", "widgets:widgets:write"] }
    const catalog = listDeferredTools(ORG, privileged, "agent", true)
    for (const query of ["widgets", "search widgets", "create a widget", "watch page", "diff"]) {
      const res = await handleToolSearch(
        { query },
        { orgId: ORG, userId: privileged.userId, scopes: privileged.scopes },
      )
      const ranked = rankDeferredTools(catalog, query, { cap: 5, appNames: ["widgets"] }).ranked
      expect(
        res.matches.map((m) => m.name),
        query,
      ).toEqual(ranked.map((s) => s.tool.sdkName))
    }
  })
})

describe("scoreDeferredTools -- tokenized keyword scoring (shared with the MCP gateway)", () => {
  const T = (toolName: string, appName: string, description: string) => ({
    toolName,
    appName,
    description,
  })
  const CATALOG = [
    T("create_skill", "kernel", "Create a personal or org-shared SKILL"),
    T("update_skill", "kernel", "Update an existing skill"),
    T("quote_batch", "boxtal", "Price a batch of orders"),
  ]

  it("a spaced query matches an underscored tool name: 'create skill' finds create_skill", () => {
    const hits = scoreDeferredTools(CATALOG, "create skill")
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
    expect(hits[0]!.tool.toolName).toBe("create_skill")
    expect(hits[0]!.score).toBeGreaterThan(
      hits.find((h) => h.tool.toolName === "update_skill")!.score,
    )
  })

  it("separator variants score identically: 'create_skill', 'create-skill', 'create:skill'", () => {
    for (const q of ["create_skill", "create-skill", "create:skill"]) {
      const hits = scoreDeferredTools(CATALOG, q).filter((s) => s.score > 0)
      expect(hits[0]!.tool.toolName).toBe("create_skill")
    }
  })

  it("no term hit scores zero", () => {
    const hits = scoreDeferredTools(CATALOG, "calendar events").filter((s) => s.score > 0)
    expect(hits).toHaveLength(0)
  })
})

// A broad query over a big catalog must return a COMPACT index, never a schema/
// description dump: the MCP gateway once returned every score>0 match with its
// full description (~100KB for "update knowledge document"), blowing the
// client's tool-result token cap. The result is capped by count AND bytes, with
// an honest "N more" note; full schemas arrive via tools/list after discovery.
describe("accents in a tool search", () => {
  const CATALOG = [
    {
      toolName: "close",
      appName: "tickets",
      description: "Close a ticket.",
      keywords: ["clôturer", "fermer"],
    },
    { toolName: "archive", appName: "mail", description: "Résumé d'une conversation à archiver." },
  ]
  const top = (query: string) =>
    scoreDeferredTools(CATALOG, query)
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)[0]?.tool.toolName

  it("a word finds a keyword with or without its accent, in any case", () => {
    expect(top("clôturer")).toBe("close")
    expect(top("cloturer")).toBe("close")
    expect(top("CLÔTURER")).toBe("close")
  })

  it("a keyword declared without an accent is found by the accented word", () => {
    expect(top("férmer")).toBe("close")
  })

  it("a description is matched folded too", () => {
    expect(top("resume")).toBe("archive")
    expect(top("résumé")).toBe("archive")
  })

  it('a word under 3 letters stays as typed: "à" is not the letter a', () => {
    const scoreOf = (query: string) =>
      scoreDeferredTools(CATALOG, query).find((s) => s.tool.toolName === "close")?.score
    expect(scoreOf("à")).toBe(0)
  })
})

describe("a search keyword never reaches the model", () => {
  const KW_ORG = "00000000-0000-0000-0000-000000000a1a"

  beforeAll(() => {
    toolRegistry.set([KW_ORG, "gadgets", "rebuild"], {
      appName: "gadgets",
      name: "rebuild",
      description: "Rebuild the gadget index.",
      requiredScopes: ["widgets:widgets:read"],
      searchKeywords: ["motcherche", "motcache"],
      handler: async () => ({ ok: true }),
      deferLoading: true,
    } as any)
  })

  afterAll(() => {
    toolRegistry.delete([KW_ORG, "gadgets", "rebuild"])
  })

  it("the search finds the tool by the keyword and answers without the list", async () => {
    const res = await handleToolSearch(
      { query: "motcherche" },
      { orgId: KW_ORG, scopes: ["widgets:widgets:read"] },
    )
    expect(res.matches.map((m) => m.name)).toEqual(["gadgets__rebuild"])
    expect(JSON.stringify(res)).not.toContain("motcache")
  })
})

describe("compactToolSearchResult caps a broad query", () => {
  const bigCatalog = Array.from({ length: 300 }, (_, i) => ({
    tool: {
      sdkName: `app${i}__update_document_${i}`,
      description:
        `Update a knowledge document (tool ${i}). ` + "Long parameter documentation. ".repeat(150), // ~4.5KB each, ~1.3MB total
    },
    score: 300 - i,
  }))

  it("stays under the byte budget and still returns names", () => {
    const result = compactToolSearchResult(bigCatalog)
    expect(result.tools.length).toBeGreaterThan(0)
    expect(result.tools.length).toBeLessThanOrEqual(TOOL_SEARCH_MAX_RESULTS)
    expect(JSON.stringify(result).length).toBeLessThan(TOOL_SEARCH_BYTE_BUDGET + 500)
    // Best-scored hit first, addressable by exact name.
    expect(result.tools[0]!.name).toBe("app0__update_document_0")
    for (const t of result.tools) {
      expect(t.description.length).toBeLessThanOrEqual(140)
      expect(t.score).toBeGreaterThan(0)
    }
  })

  it("reports the omitted count honestly", () => {
    const result = compactToolSearchResult(bigCatalog)
    expect(result.totalMatches).toBe(300)
    expect(result.note).toContain(`${300 - result.tools.length} more`)
    expect(result.note).toContain("refine your query")
  })

  it("small result set has no note and keeps full short descriptions", () => {
    const small = [
      { tool: { sdkName: "a__b", description: "Short one." }, score: 10 },
      { tool: { sdkName: "c__d", description: "Another short one." }, score: 5 },
    ]
    const result = compactToolSearchResult(small)
    expect(result.tools).toHaveLength(2)
    expect(result.note).toBeUndefined()
    expect(result.tools[0]!.description).toBe("Short one.")
  })

  it("toolSynopsis flattens whitespace and hard-caps length", () => {
    expect(toolSynopsis("line one\n  line two")).toBe("line one line two")
    const long = "x".repeat(500)
    const cut = toolSynopsis(long)
    expect(cut.length).toBeLessThanOrEqual(140)
    expect(cut.endsWith("...")).toBe(true)
  })
})
