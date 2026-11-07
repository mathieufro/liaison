// SPDX-License-Identifier: FSL-1.1-ALv2
//
// tool_search is the DISCOVERY step of the deferred-tool flow: any tool it
// returns as a usable match must be added to the current run's discovered set
// (RunContext.discoveredTools) so the next agent step can actually call it.
// Locked matches are surfaced but NOT unlocked — the actor lacks the scope.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { handleToolSearch, TOOL_SEARCH_LIMIT_PER_TURN } from "~/modules/agent/tools/tool-search"
import { toolRegistry } from "~/modules/apps/app-registries"

const ORG = "00000000-0000-0000-0000-000000000d41"

const ACTOR = {
  actorType: "agent" as const,
  userId: "00000000-0000-0000-0000-000000000d42",
  orgId: ORG,
  scopes: ["sprockets:sprockets:read"],
  dimensionGrants: {},
} as any

function freshFrame() {
  return {
    runId: crypto.randomUUID(),
    parentRunId: null,
    rootRunId: crypto.randomUUID(),
    nestingDepth: 0,
    discoveredTools: new Set<string>(),
  }
}

beforeAll(() => {
  toolRegistry.set([ORG, "sprockets", "search"], {
    appName: "sprockets",
    name: "search",
    description: "Search sprockets by name.",
    requiredScopes: ["sprockets:sprockets:read"],
    handler: async () => ({ ok: true }),
  } as any)
  toolRegistry.set([ORG, "sprockets", "create"], {
    appName: "sprockets",
    name: "create",
    description: "Create a sprocket.",
    requiredScopes: ["sprockets:sprockets:write"], // actor LACKS this — locked
    handler: async () => ({ ok: true }),
  } as any)
})

afterAll(() => {
  toolRegistry.delete([ORG, "sprockets", "search"])
  toolRegistry.delete([ORG, "sprockets", "create"])
  toolRegistry.delete([ORG, "kernel", "memory_view"])
})

describe("tool_search feeds the run's discovered set", () => {
  it("select: query adds the matched tool to RunContext.discoveredTools", async () => {
    const frame = freshFrame()
    await runContextStore.run(frame, () =>
      handleToolSearch(
        { query: "select:sprockets__search" },
        { orgId: ORG, userId: ACTOR.userId, scopes: ACTOR.scopes },
      ),
    )
    expect(frame.discoveredTools.has("sprockets__search")).toBe(true)
  })

  it("a tool it loads was asked for: its schema is requested, even if an earlier turn listed it by name", async () => {
    const requested: string[] = []
    const frame = {
      ...freshFrame(),
      fixedToolList: {
        listed: new Set<string>(),
        requestSchemas: (names: readonly string[]) => requested.push(...names),
      },
    }
    await runContextStore.run(frame as never, () =>
      handleToolSearch(
        { query: "select:sprockets__search" },
        { orgId: ORG, userId: ACTOR.userId, scopes: ACTOR.scopes },
      ),
    )
    expect(frame.discoveredTools.has("sprockets__search")).toBe(true)
    expect(requested).toEqual(["sprockets__search"])
  })

  it("keyword query adds scored matches; locked matches are NOT unlocked", async () => {
    const frame = freshFrame()
    const res = await runContextStore.run(frame, () =>
      handleToolSearch(
        { query: "sprockets" },
        { orgId: ORG, userId: ACTOR.userId, scopes: ACTOR.scopes },
      ),
    )
    expect(res.matches.some((m) => m.name === "sprockets__search")).toBe(true)
    expect(frame.discoveredTools.has("sprockets__search")).toBe(true)
    // The locked write tool is surfaced in matches but never unlocked.
    expect(res.matches.some((m) => m.name === "sprockets__create" && m.locked)).toBe(true)
    expect(frame.discoveredTools.has("sprockets__create")).toBe(false)
  })

  it("a zero-score query names the apps and unlocks NOTHING", async () => {
    const frame = freshFrame()
    const res = await runContextStore.run(frame, () =>
      handleToolSearch(
        { query: "zzz-no-such-term" },
        { orgId: ORG, userId: ACTOR.userId, scopes: ACTOR.scopes },
      ),
    )
    expect(res.fellBackToCatalog).toBe(true)
    expect(res.matches).toEqual([])
    expect(res.apps?.some((a) => a.name === "sprockets")).toBe(true)
    expect(frame.discoveredTools.size).toBe(0)
  })

  it("app:tool separator queries resolve — keyword and select forms", async () => {
    // Models write "tickets:reply"-style names; whitespace-only tokenization
    // scored these 0 and select: matched nothing (observed in prod).
    const kw = freshFrame()
    const kwRes = await runContextStore.run(kw, () =>
      handleToolSearch(
        { query: "sprockets:search" },
        { orgId: ORG, userId: ACTOR.userId, scopes: ACTOR.scopes },
      ),
    )
    expect(kwRes.fellBackToCatalog).toBeUndefined()
    expect(kwRes.matches[0]?.name).toBe("sprockets__search")
    expect(kw.discoveredTools.has("sprockets__search")).toBe(true)

    const sel = freshFrame()
    const selRes = await runContextStore.run(sel, () =>
      handleToolSearch(
        { query: "select:sprockets:search" },
        { orgId: ORG, userId: ACTOR.userId, scopes: ACTOR.scopes },
      ),
    )
    expect(selRes.matches.length).toBe(1)
    expect(sel.discoveredTools.has("sprockets__search")).toBe(true)
  })

  it("a bare app-name query returns ALL of that app's tools, not a 5-slice of a tie", async () => {
    // Six same-score tools would previously crowd the one you need out of the
    // default maxResults=5 cap (prod: tickets__reply lost the tie-slice).
    const extraNames = ["alpha", "beta", "gamma", "delta", "epsilon", "reply"]
    for (const n of extraNames) {
      toolRegistry.set([ORG, "sprockets", n], {
        appName: "sprockets",
        name: n,
        description: `Sprocket ${n} operation.`,
        requiredScopes: ["sprockets:sprockets:read"],
        handler: async () => ({ ok: true }),
      } as any)
    }
    try {
      const frame = freshFrame()
      const res = await runContextStore.run(frame, () =>
        handleToolSearch(
          { query: "sprockets" },
          { orgId: ORG, userId: ACTOR.userId, scopes: ACTOR.scopes },
        ),
      )
      // 7 usable + 1 locked registered under the app — the cap must not hide any.
      expect(res.matches.length).toBeGreaterThanOrEqual(8)
      expect(frame.discoveredTools.has("sprockets__reply")).toBe(true)
    } finally {
      for (const n of extraNames) toolRegistry.delete([ORG, "sprockets", n])
    }
  })

  it("a keyword query loads only the matches that satisfy every term; weaker hits are listed, not loaded", async () => {
    // The prod DM: a search for `mail:read` returned mail__read and then four
    // padded `read` tools from other apps, and unlocked all five, so four more
    // apps' full guides rode in the prefix for the life of the thread.
    toolRegistry.set([ORG, "gadgets", "search"], {
      appName: "gadgets",
      name: "search",
      description: "Search gadgets by name.",
      requiredScopes: ["sprockets:sprockets:read"],
      handler: async () => ({ ok: true }),
    } as any)
    try {
      const frame = freshFrame()
      const res = await runContextStore.run(frame, () =>
        handleToolSearch(
          { query: "sprockets search" },
          { orgId: ORG, userId: ACTOR.userId, scopes: ACTOR.scopes },
        ),
      )
      // Both are LISTED: the weak hit is still one call away.
      expect(res.matches.some((m) => m.name === "sprockets__search")).toBe(true)
      expect(res.matches.some((m) => m.name === "gadgets__search")).toBe(true)
      // Only the strong match is LOADED.
      expect(frame.discoveredTools.has("sprockets__search")).toBe(true)
      expect(frame.discoveredTools.has("gadgets__search")).toBe(false)
      expect(res.note).toContain("LOADED: sprockets__search")
      expect(res.note).toContain("NOT loaded: gadgets__search")
    } finally {
      toolRegistry.delete([ORG, "gadgets", "search"])
    }
  })

  it("outside any run frame (MCP gateway path), the handler still works without a set", async () => {
    const res = await handleToolSearch(
      { query: "select:sprockets__search" },
      { orgId: ORG, userId: ACTOR.userId, scopes: ACTOR.scopes },
    )
    expect(res.matches.length).toBe(1)
  })
})

describe("tool_search judges a match against the turn's scope, not the actor's alone", () => {
  it("a tool the user holds but the acting agent's ceiling lacks is locked, never loaded", async () => {
    // The live QA: @finance's ceiling has no database scope, its user does, and
    // tool_search answered `LOADED: database__db_query` for a tool the call-time
    // check (ceiling ∩ grants) then refused.
    const actor = { ...ACTOR, scopes: ["sprockets:sprockets:read", "sprockets:sprockets:write"] }
    const frame = { ...freshFrame(), effectiveScope: ["sprockets:sprockets:read"] }
    const res = await runContextStore.run(frame, () =>
      handleToolSearch(
        { query: "select:sprockets__create" },
        { orgId: ORG, userId: actor.userId, scopes: actor.scopes },
      ),
    )
    const hit = res.matches.find((m) => m.name === "sprockets__create")
    expect(hit?.locked).toBe(true)
    expect(hit?.requiredScope).toBe("sprockets:sprockets:write")
    // The scope string is for request_scope, never for the person.
    expect(hit?.description).not.toContain("tell the user it needs the")
    expect(hit?.description).toContain("never the scope string")
    expect(frame.discoveredTools.has("sprockets__create")).toBe(false)
    expect(res.note ?? "").not.toContain("LOADED")
  })

  it("outside an agent turn (no effective scope) the actor's own scopes still decide", async () => {
    const actor = { ...ACTOR, scopes: ["sprockets:sprockets:read", "sprockets:sprockets:write"] }
    const frame = freshFrame()
    const res = await runContextStore.run(frame, () =>
      handleToolSearch(
        { query: "select:sprockets__create" },
        { orgId: ORG, userId: actor.userId, scopes: actor.scopes },
      ),
    )
    expect(res.matches.find((m) => m.name === "sprockets__create")?.locked).toBeUndefined()
    expect(frame.discoveredTools.has("sprockets__create")).toBe(true)
  })
})

// A weak model looped on tool_search (a live demo turn: eight searches, two of
// them `select:` with a near-miss name, then no write and the turn's steps
// gone). The search answers the near misses, and it is bounded per turn.
describe("tool_search does not loop", () => {
  const ctx = { orgId: ORG, userId: ACTOR.userId, scopes: ACTOR.scopes }

  it("select: takes the app and the tool joined by any separator, a single underscore included", async () => {
    for (const spelled of ["sprockets_search", "sprockets.search", "Sprockets:Search"]) {
      const frame = freshFrame()
      const res = await runContextStore.run(frame, () =>
        handleToolSearch({ query: `select:${spelled}` }, ctx),
      )
      expect(res.matches.map((m) => m.name)).toEqual(["sprockets__search"])
      expect(frame.discoveredTools.has("sprockets__search")).toBe(true)
    }
  })

  it("select: of a tool the turn already has says it is loaded instead of matching nothing", async () => {
    toolRegistry.set([ORG, "kernel", "memory_view"], {
      appName: "kernel",
      name: "memory_view",
      description: "View a memory file.",
      requiredScopes: ["kernel:threads:read"],
      handler: async () => ({ ok: true }),
    } as any)
    const res = await runContextStore.run(
      { ...freshFrame(), turnToolNames: new Set(["kernel__memory_view", "sprockets__search"]) },
      () => handleToolSearch({ query: "select:memory_view" }, ctx),
    )
    expect(res.matches).toEqual([])
    expect(res.note).toContain("ALREADY LOADED: kernel__memory_view")
  })

  it("never says ALREADY LOADED for a tool outside the turn's own tool set", async () => {
    // Registered for the org, but this turn's scopes (a routine's, say) left it out.
    const outside = await runContextStore.run(
      { ...freshFrame(), turnToolNames: new Set(["sprockets__search"]) },
      () => handleToolSearch({ query: "select:memory_view" }, ctx),
    )
    expect(outside.note ?? "").not.toContain("ALREADY LOADED")
    // No tool set on the frame, no claim either.
    const noSet = await runContextStore.run(freshFrame(), () =>
      handleToolSearch({ query: "select:memory_view" }, ctx),
    )
    expect(noSet.note ?? "").not.toContain("ALREADY LOADED")
  })

  it(`a demo visitor's turn past ${TOOL_SEARCH_LIMIT_PER_TURN} searches loads no more, yet still names what is locked`, async () => {
    const frame = { ...freshFrame(), visitorTurn: true }
    for (let i = 0; i < TOOL_SEARCH_LIMIT_PER_TURN; i++) {
      // Each search loads the tool anew (a re-search of a loaded tool is not counted).
      frame.discoveredTools.delete("sprockets__search")
      const res = await runContextStore.run(frame, () =>
        handleToolSearch({ query: "select:sprockets__search" }, ctx),
      )
      expect(res.note ?? "").not.toContain("Search limit reached")
    }
    frame.discoveredTools.delete("sprockets__search")
    const over = await runContextStore.run(frame, () =>
      handleToolSearch({ query: "sprockets" }, ctx),
    )
    expect(over.note).toContain("Search limit reached")
    // Nothing usable is loaded past the limit...
    expect(over.matches.some((m) => !m.locked)).toBe(false)
    expect(frame.discoveredTools.has("sprockets__search")).toBe(false)
    // ...but the tool that exists without the scope is still named as such.
    expect(over.matches.find((m) => m.name === "sprockets__create")?.locked).toBe(true)
    expect(over.note).toContain("LOCKED")
    // And the catalog size is the real one.
    expect(over.totalDeferredTools).toBeGreaterThan(0)
    // A new turn starts with its own allowance.
    const fresh = await runContextStore.run({ ...freshFrame(), visitorTurn: true }, () =>
      handleToolSearch({ query: "sprockets" }, ctx),
    )
    expect(fresh.matches.some((m) => !m.locked)).toBe(true)
  })

  it("a search for tools already loaded answers with their exact names and does not count toward the limit", async () => {
    // Live: a weak model loaded the tools it needed, then searched for them
    // again until the limit, and answered that it could not run them.
    const frame: ReturnType<typeof freshFrame> & { visitorTurn: true; toolSearchCount?: number } = {
      ...freshFrame(),
      visitorTurn: true,
    }
    const first = await runContextStore.run(frame, () =>
      handleToolSearch({ query: "select:sprockets__search" }, ctx),
    )
    expect(first.note).toContain("LOADED: sprockets__search. Call it now by this exact name")
    for (let i = 0; i < TOOL_SEARCH_LIMIT_PER_TURN * 2; i++) {
      for (const query of [
        "select:sprockets__search",
        "sprockets search",
        "select:sprockets_search",
      ]) {
        const again = await runContextStore.run(frame, () => handleToolSearch({ query }, ctx))
        expect(again.note).toContain("ALREADY LOADED: sprockets__search. Call it now")
        expect(again.note).not.toContain("Search limit reached")
      }
    }
    expect(frame.toolSearchCount).toBe(1)
    // A search that does load something new still counts.
    frame.discoveredTools.delete("sprockets__search")
    await runContextStore.run(frame, () => handleToolSearch({ query: "sprockets search" }, ctx))
    expect(frame.toolSearchCount).toBe(2)
  })

  it("a loaded match the run cannot hold is never announced as callable", async () => {
    // The run's tool set refuses it (admitTools): e.g. its connection went unreachable.
    const frame = {
      ...freshFrame(),
      admitTools: (names: readonly string[]) =>
        new Set(names.filter((n) => n !== "sprockets__search")),
    }
    const res = await runContextStore.run(frame, () =>
      handleToolSearch({ query: "select:sprockets__search" }, ctx),
    )
    expect(res.note ?? "").not.toContain("LOADED")
    expect(res.note).toContain("Not available to you in this turn: sprockets__search")
    expect(frame.discoveredTools.has("sprockets__search")).toBe(false)
  })

  it("any other turn has no search limit: a request across many apps searches once per app", async () => {
    const frame = freshFrame()
    for (let i = 0; i < TOOL_SEARCH_LIMIT_PER_TURN * 2; i++) {
      const res = await runContextStore.run(frame, () =>
        handleToolSearch({ query: "sprockets" }, ctx),
      )
      expect(res.note ?? "").not.toContain("Search limit reached")
      expect(res.matches.some((m) => m.name === "sprockets__search")).toBe(true)
    }
  })
})
