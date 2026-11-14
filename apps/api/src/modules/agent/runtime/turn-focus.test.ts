// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The request's own app (turn-focus.ts): which app and entity a view or a
// routine event names, which evidence is hard and which only fills headroom,
// which of its tools act on that entity, and which go back to the catalog
// when the turn is over its tool schema budget.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { estimateToolSchemaTokens } from "~/modules/agent/context/context"
import { entityRegistry, viewRegistry } from "~/modules/apps/app-registries"
import {
  actsOnEntity,
  entityRank,
  FOCUS_ENTITY_TOOLS_CEILING_FACTOR,
  type FocusApp,
  focusCorePreload,
  focusHeadroomFill,
  focusOverflow,
  isRegisteredEntityType,
  parseQualifiedName,
  resolveTurnFocus,
} from "./turn-focus"

const ORG = "00000000-0000-0000-0000-00000000f0c5"

const schema = (...props: string[]) => ({
  jsonSchema: {
    type: "object",
    properties: Object.fromEntries(props.map((p) => [p, { type: "string" }])),
  },
})

const focusOf = (app: string, f: Partial<FocusApp>) =>
  new Map<string, FocusApp>([
    [
      app,
      {
        hard: f.hard ?? true,
        verifiedEntityTypes: f.verifiedEntityTypes ?? new Set(),
        viewEntityTypes: f.viewEntityTypes ?? new Set(),
      },
    ],
  ])

beforeAll(() => {
  entityRegistry.set([ORG, "tickets", "ticket"], { labelField: "subject", handlePrefix: "T" })
  entityRegistry.set([ORG, "invoicing", "document"], { labelField: "number", handlePrefix: "D" })
})
afterAll(() => {
  entityRegistry.delete([ORG, "tickets", "ticket"])
  entityRegistry.delete([ORG, "invoicing", "document"])
})

describe("the app and entity a view or an event names", () => {
  it("a tab named for the page counts as the entity it declares", async () => {
    viewRegistry.set([ORG, "invoicing"], { tabTypes: { detail: { entity: "document" } } } as never)
    try {
      const focus = await resolveTurnFocus({
        orgId: ORG,
        threadId: crypto.randomUUID(),
        currentView: { tabType: "invoicing:detail", entityId: crypto.randomUUID() },
        appsWithTools: new Set(["invoicing"]),
      })
      expect([...(focus.get("invoicing")?.viewEntityTypes ?? [])]).toEqual(["document"])
    } finally {
      viewRegistry.delete([ORG, "invoicing"])
    }
  })

  it("reads app:entity and app:entity:action, never the kernel", () => {
    expect(parseQualifiedName("tickets:ticket")).toEqual({ app: "tickets", entityType: "ticket" })
    expect(parseQualifiedName("tickets:ticket:create")).toEqual({
      app: "tickets",
      entityType: "ticket",
    })
    expect(parseQualifiedName("kernel:thread")).toBeNull()
    expect(parseQualifiedName("thread")).toBeNull()
    expect(parseQualifiedName(null)).toBeNull()
  })

  it("an entity type counts only when the app registered it and it is not a stub", () => {
    expect(isRegisteredEntityType(ORG, "tickets", "ticket")).toBe(true)
    expect(isRegisteredEntityType(ORG, "invoicing", "_")).toBe(false)
    expect(isRegisteredEntityType(ORG, "invoicing", "id")).toBe(false)
    expect(isRegisteredEntityType(ORG, "invoicing", "anything")).toBe(false)
  })
})

describe("which evidence is hard", () => {
  const appsWithTools = new Set(["tickets", "invoicing"])
  const threadId = crypto.randomUUID()

  it("a person's view in a regular org is soft; a visitor's is hard", async () => {
    const view = { tabType: "tickets:ticket", entityId: crypto.randomUUID() }
    const regular = await resolveTurnFocus({
      orgId: ORG,
      threadId,
      currentView: view,
      appsWithTools,
    })
    expect(regular.get("tickets")?.hard).toBe(false)
    expect([...(regular.get("tickets")?.viewEntityTypes ?? [])]).toEqual(["ticket"])
    expect(regular.get("tickets")?.verifiedEntityTypes.size).toBe(0)
    const visitor = await resolveTurnFocus({
      orgId: ORG,
      threadId,
      currentView: view,
      appsWithTools,
      visitorTurn: true,
    })
    expect(visitor.get("tickets")?.hard).toBe(true)
    // Still the client's word: the entity is not one the server read.
    expect(visitor.get("tickets")?.verifiedEntityTypes.size).toBe(0)
  })

  it("a made-up entity type or an app the turn has no tools of names nothing", async () => {
    const stub = await resolveTurnFocus({
      orgId: ORG,
      threadId,
      currentView: { tabType: "invoicing:_", entityId: "x" },
      appsWithTools,
      visitorTurn: true,
    })
    expect(stub.get("invoicing")?.viewEntityTypes.size).toBe(0)
    const absent = await resolveTurnFocus({
      orgId: ORG,
      threadId,
      currentView: { tabType: "shopify:order", entityId: "x" },
      appsWithTools,
    })
    expect(absent.size).toBe(0)
  })
})

describe("a tool acting on the entity", () => {
  it("has an input naming the entity's id, a parent's included", () => {
    expect(actsOnEntity(schema("ticketId", "body"), new Set(["ticket"]))).toBe(true)
    expect(actsOnEntity(schema("title", "parentTaskId"), new Set(["task"]))).toBe(true)
    expect(actsOnEntity({ properties: { ticket_id: {} } }, new Set(["ticket"]))).toBe(true)
    expect(actsOnEntity(schema("query", "limit"), new Set(["ticket"]))).toBe(false)
    expect(actsOnEntity(schema("ticketId"), new Set())).toBe(false)
  })

  it("a stub entity type matches no input", () => {
    expect(actsOnEntity(schema("documentId", "contactId"), new Set(["_"]))).toBe(false)
  })
})

const tools = {
  tickets__reply: { description: "Reply.", inputSchema: schema("ticketId", "body") },
  tickets__search: {
    description: `Search. ${"filters ".repeat(400)}`,
    inputSchema: schema("query"),
  },
  tickets__inboxes_create: {
    description: `Create an inbox. ${"field ".repeat(200)}`,
    inputSchema: schema("name"),
  },
  tickets__categories_list: { description: "List categories.", inputSchema: schema() },
}
const names = Object.keys(tools)
const cost = (name: string) => estimateToolSchemaTokens(name, tools[name as keyof typeof tools])
const total = names.reduce((n, name) => n + cost(name), 0)

describe("a hard focus app over the tool schema budget", () => {
  const verified = focusOf("tickets", { verifiedEntityTypes: new Set(["ticket"]) })
  const viewed = focusOf("tickets", { viewEntityTypes: new Set(["ticket"]) })

  it("keeps everything when it fits", () => {
    expect(
      focusOverflow({
        candidates: names,
        tools,
        focus: verified,
        visibleTokens: total,
        cap: total,
      }),
    ).toEqual([])
  })

  it("sends its largest other tools back first, the ones acting on the entity last", () => {
    const out = focusOverflow({
      candidates: names,
      tools,
      focus: verified,
      visibleTokens: total,
      cap: total - cost("tickets__search") - 1,
    })
    expect(out).toEqual(["tickets__search", "tickets__inboxes_create"])
    const all = focusOverflow({
      candidates: names,
      tools,
      focus: verified,
      visibleTokens: total,
      cap: 0,
    })
    expect(all).toContain("tickets__categories_list")
    // cap 0: the bound is 0 too, so even the entity's tools go.
    expect(all).toContain("tickets__reply")
  })

  it("keeps a server-read entity's tools up to the bound, never past it", () => {
    const others = total - cost("tickets__reply")
    // Over the cap, under the bound once the others went: reply stays.
    const cap = Math.ceil(cost("tickets__reply") / FOCUS_ENTITY_TOOLS_CEILING_FACTOR) + 1
    const kept = focusOverflow({
      candidates: names,
      tools,
      focus: verified,
      visibleTokens: total,
      cap,
    })
    expect(kept).not.toContain("tickets__reply")
    expect(kept.length).toBe(3)
    expect(others).toBeGreaterThan(0)
    // A view-named entity's tools have no such pass: they go to fit the cap.
    const view = focusOverflow({
      candidates: names,
      tools,
      focus: viewed,
      visibleTokens: total,
      cap,
    })
    expect(view).toContain("tickets__reply")
  })
})

describe("a soft focus app fills the room left, and only that", () => {
  const viewed = focusOf("tickets", { hard: false, viewEntityTypes: new Set(["ticket"]) })

  it("nothing when the turn is already at the cap", () => {
    expect(
      focusHeadroomFill({
        candidates: names,
        tools,
        focus: viewed,
        visibleTokens: 1000,
        cap: 1000,
      }),
    ).toEqual([])
  })

  it("the tools acting on the entity first, then the smallest that fit", () => {
    const room = cost("tickets__reply") + cost("tickets__categories_list")
    const out = focusHeadroomFill({
      candidates: names,
      tools,
      focus: viewed,
      visibleTokens: 500,
      cap: 500 + room,
    })
    expect(out).toEqual(["tickets__reply", "tickets__categories_list"])
  })
})

describe("a hard focus app with a core list", () => {
  const coreTools = {
    invoicing__documents_search: { description: "Search documents.", inputSchema: schema("q") },
    invoicing__documents_get: {
      description: "Get one document.",
      inputSchema: schema("id"),
      focusCore: true,
    },
    invoicing__drafts_update: {
      description: "Edit a draft.",
      inputSchema: schema("draft_id"),
      focusCore: "document",
    },
    invoicing__vat_lookup: { description: "Look up a VAT number.", inputSchema: schema("vat") },
    tickets__reply: { description: "Reply.", inputSchema: schema("ticketId") },
    tickets__search: { description: "Search tickets.", inputSchema: schema("q") },
  }
  const invoicing = Object.keys(coreTools).filter((n) => n.startsWith("invoicing__"))
  const tickets = Object.keys(coreTools).filter((n) => n.startsWith("tickets__"))

  it("loads its core list and lists its other tools by name only", () => {
    const focus = focusOf("invoicing", { verifiedEntityTypes: new Set(["document"]) })
    expect(focusCorePreload({ candidates: invoicing, tools: coreTools, focus })).toEqual({
      preload: ["invoicing__documents_get", "invoicing__drafts_update"],
      indexOnly: ["invoicing__documents_search", "invoicing__vat_lookup"],
    })
  })

  it("loads a tool named for an entity type only when the server read that entity", () => {
    const viewed = focusOf("invoicing", { viewEntityTypes: new Set(["document"]) })
    expect(
      focusCorePreload({ candidates: invoicing, tools: coreTools, focus: viewed }).preload,
    ).toEqual(["invoicing__documents_get"])
    const other = focusOf("invoicing", { verifiedEntityTypes: new Set(["pdf"]) })
    expect(
      focusCorePreload({ candidates: invoicing, tools: coreTools, focus: other }).preload,
    ).toEqual(["invoicing__documents_get"])
  })

  it("an app with no core list loads every tool, as before", () => {
    const focus = focusOf("tickets", { verifiedEntityTypes: new Set(["ticket"]) })
    expect(focusCorePreload({ candidates: tickets, tools: coreTools, focus })).toEqual({
      preload: tickets,
      indexOnly: [],
    })
  })

  it("ranks a tool named for the entity the server read as acting on it, whatever its input", () => {
    const verified = focusOf("invoicing", { verifiedEntityTypes: new Set(["document"]) })
    const viewed = focusOf("invoicing", { viewEntityTypes: new Set(["document"]) })
    expect(entityRank("invoicing__drafts_update", coreTools, verified)).toBe(2)
    expect(entityRank("invoicing__drafts_update", coreTools, viewed)).toBe(0)
    expect(entityRank("invoicing__documents_get", coreTools, verified)).toBe(0)
  })
})
