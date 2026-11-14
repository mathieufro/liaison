// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The deep rules for a tool's `resultCard`. Before them, the manifest schema accepted any object
// there, so a template with a script in a label, a missing title or a path outside the result
// reached the registry and was drawn from data.

import { describe, expect, it } from "bun:test"
import { validateAppManifest } from "~/modules/apps/contract"

const APP = "card-app"

/** A well-formed manifest with a read tool carrying `card`, and two write tools to point at. */
function manifestWith(card: unknown, extraTools: Record<string, unknown> = {}) {
  return {
    name: APP,
    version: "1.0.0",
    scopes: [`${APP}:items:read`, `${APP}:items:write`],
    schema: { items: { fields: { title: "string" } } },
    tools: {
      show_item: {
        description: "Show one item",
        requiredScopes: [`${APP}:items:read`],
        handler: "show_item",
        returns: {
          schema: {
            name: "string",
            status: "string",
            total: "object",
            lines: "object",
            deals: "object",
            groups: "object",
            totals: "object",
            notes: "object",
            id: "string",
            revision: "number",
            host: "string",
            cover: "string",
          },
        },
        resultCard: card,
      },
      rename_item: {
        description: "Rename an item",
        requiredScopes: [`${APP}:items:write`],
        handler: "rename_item",
        params: {
          type: "object",
          properties: { id: { type: "string" }, name: { type: "string" } },
        },
      },
      delete_item: {
        description: "Delete an item",
        requiredScopes: [`${APP}:items:write`],
        handler: "delete_item",
        gated: true,
        params: { type: "object", properties: { id: { type: "string" } } },
      },
      ...extraTools,
    },
  }
}

function judge(card: unknown, extraTools: Record<string, unknown> = {}): string {
  const out = validateAppManifest(manifestWith(card, extraTools))
  return out.success ? "" : (out.error ?? "")
}

const ENTITY = { kind: "entity", pill: { label: "Item" }, title: "{{result.name}}" }

const COLUMNS = [
  { key: "planned", label: { label: "Planned" }, format: "hours" },
  { key: "bill", label: { label: "Billed" }, format: "hours" },
]
function groupsCard(over: Record<string, unknown> = {}) {
  return {
    kind: "groups",
    pill: { label: "Lines" },
    title: "{{result.name}}",
    columns: COLUMNS,
    groups: {
      path: "result.groups",
      label: "{{group.label}}",
      rows: {
        path: "group.rows",
        id: "row.id",
        name: "{{row.name}}",
        cells: { planned: "row.planned", bill: "row.bill" },
      },
    },
    ...over,
  }
}

describe("a card template is checked when the manifest is registered", () => {
  it("accepts a plain entity card", () => {
    expect(judge(ENTITY)).toBe("")
  })

  it("an unknown kind is refused, naming the tool", () => {
    const error = judge({ ...ENTITY, kind: "carousel" })
    expect(error).toContain("tools.show_item.resultCard.kind")
    expect(error).toContain("carousel")
  })

  it("a script in a fixed label is refused, naming the tool", () => {
    const error = judge({ ...ENTITY, pill: { label: "Item <script>alert(1)</script>" } })
    expect(error).toContain("tools.show_item.resultCard.pill.label")
  })

  it("an entity card without a title is refused, naming the tool", () => {
    const { title: _title, ...noTitle } = ENTITY
    expect(judge(noTitle)).toContain(
      "tools.show_item.resultCard.title: is required on a entity card",
    )
  })

  it("a path that does not start with result is refused, naming the tool", () => {
    const error = judge({ ...ENTITY, title: "{{name}}" })
    expect(error).toContain("tools.show_item.resultCard.title")
    expect(error).toContain("'name' is not a path")
  })

  it("markup in a template literal is refused", () => {
    expect(judge({ ...ENTITY, sub: "<b>{{result.name}}</b>" })).toContain(
      "tools.show_item.resultCard.sub: must be plain text, with no HTML",
    )
  })

  it("a key the kind does not have is refused", () => {
    expect(judge({ ...ENTITY, items: { path: "result.deals", label: "{{item.n}}" } })).toContain(
      "resultCard.items: is not a key of this card",
    )
  })

  it("a path the tool does not declare in returns is refused", () => {
    expect(judge({ ...ENTITY, title: "{{result.nickname}}" })).toContain(
      "'result.nickname' is not in the tool's returns.schema",
    )
  })

  it("a card on a tool that declares no returns is refused", () => {
    const manifest = manifestWith(ENTITY)
    const tool = manifest.tools.show_item as { returns?: unknown }
    tool.returns = undefined
    const out = validateAppManifest(manifest)
    expect(out.success ? "" : out.error).toContain("needs the tool to declare returns.schema")
  })

  it("a path that goes into a scalar the tool returns is refused", () => {
    expect(judge({ ...ENTITY, title: "{{result.name.first}}" })).toContain("returns as string")
  })

  it("a number card needs its method and its source", () => {
    const number = {
      kind: "number",
      pill: { label: "Revenue" },
      value: "{{result.total}}",
      valueFormat: "money",
      how: { label: "Paid invoices, this month" },
      source: "Invoicing",
    }
    expect(judge(number)).toBe("")
    const { how: _how, ...noHow } = number
    const { source: _source, ...noSource } = number
    expect(judge(noHow)).toContain("resultCard.how: is required on a number card")
    expect(judge(noSource)).toContain("resultCard.source: is required on a number card")
  })

  it("a formatted value is one placeholder", () => {
    const row = { label: { label: "Total" }, value: "about {{result.total}}", format: "money" }
    expect(judge({ ...ENTITY, rows: [row] })).toContain("must be one {{path}} and nothing else")
  })

  it("a card holds at most 8 rows and 3 actions", () => {
    const rows = (n: number) =>
      Array.from({ length: n }, (_v, i) => ({
        label: { label: `R${i}` },
        value: "{{result.name}}",
      }))
    expect(judge({ ...ENTITY, rows: rows(8) })).toBe("")
    expect(judge({ ...ENTITY, rows: rows(9) })).toContain("has 9 entries, at most 8")
    const ask = { kind: "ask", label: { label: "Ask" }, prompt: "Look at this one" }
    expect(judge({ ...ENTITY, actions: [ask, ask, ask] })).toBe("")
    expect(judge({ ...ENTITY, actions: [ask, ask, ask, ask] })).toContain(
      "has 4 entries, at most 3",
    )
  })

  it("a list holds at most 20 items", () => {
    const list = (limit: number) => ({
      kind: "list",
      pill: { label: "Deals" },
      title: "Deals",
      items: { path: "result.deals", label: "{{item.name}}", limit },
    })
    expect(judge(list(20))).toBe("")
    expect(judge(list(21))).toContain("must be a whole number from 1 to 20")
  })

  it("a placeholder may name alternatives, and each one is checked as a path", () => {
    const list = (label: string) => ({
      kind: "list",
      pill: { label: "Deals" },
      title: "Deals",
      items: { path: "result.deals", label },
    })
    expect(judge(list("{{item.name|item.title}}"))).toBe("")
    expect(judge(list("{{item.name | item.title}}"))).toBe("")
    expect(judge(list("{{item.name|row.title}}"))).toContain("starts with row")
    expect(judge(list("{{item.name|}}"))).toContain("is not a path")
    // On a result path, each alternative must be one the tool returns.
    expect(judge({ ...ENTITY, title: "{{result.name|result.status}}" })).toBe("")
    expect(judge({ ...ENTITY, title: "{{result.name|result.nope}}" })).toContain(
      "'result.nope' is not in the tool's returns.schema",
    )
  })
})

describe("what a card action can reach", () => {
  const act = (action: unknown) => judge({ ...ENTITY, actions: [action] })

  it("an ask posts fixed text as the person's own words, never a value from the result", () => {
    // A result field can hold text someone outside the org wrote (a subject, a mail body).
    expect(act({ kind: "ask", label: { label: "Ask" }, prompt: "Why {{result.name}}?" })).toContain(
      "must be fixed text",
    )
    expect(
      act({ kind: "ask", label: { label: "Ask" }, prompt: "Why {{result.name|result.status}}?" }),
    ).toContain("must be fixed text")
    expect(act({ kind: "ask", label: { label: "Ask" }, prompt: "Why <b>this</b>?" })).toContain(
      "plain text",
    )
  })

  it("opens a page, calls a tool of the same app, asks the agent or opens a literal https host", () => {
    expect(act({ kind: "open", label: { label: "Open" }, view: "item", idPath: "result.id" })).toBe(
      "",
    )
    expect(
      act({
        kind: "tool",
        label: { label: "Rename" },
        tool: "rename_item",
        params: { id: "result.id" },
      }),
    ).toBe("")
    expect(act({ kind: "ask", label: { label: "Ask" }, prompt: "Why is this one late?" })).toBe("")
    expect(
      act({
        kind: "external",
        label: { label: "Docs" },
        urlTemplate: "https://docs.example.com/items/{{result.id}}",
      }),
    ).toBe("")
  })

  it("refuses any other kind of action", () => {
    expect(act({ kind: "script", label: { label: "Run" } })).toContain(
      "must be open, tool, ask or external",
    )
  })

  it("refuses a tool of another app", () => {
    const error = act({
      kind: "tool",
      label: { label: "Go" },
      tool: "other:rename_item",
      params: { id: "result.id" },
    })
    expect(error).toContain("tools.show_item.resultCard.actions[0].tool")
    expect(error).toContain("not a tool of this app")
  })

  it("refuses a tool action whose params are not ids from the result", () => {
    const literal = act({
      kind: "tool",
      label: { label: "Go" },
      tool: "rename_item",
      params: { id: "typed text" },
    })
    expect(literal).toContain("actions[0].params.id")
    const stranger = act({
      kind: "tool",
      label: { label: "Go" },
      tool: "rename_item",
      params: { colour: "result.id" },
    })
    expect(stranger).toContain("'colour' is not a parameter of the tool")
  })

  it("refuses an https template whose host is not literal", () => {
    const external = (urlTemplate: string) =>
      act({ kind: "external", label: { label: "Go" }, urlTemplate })
    expect(external("https://{{result.host}}/x")).toContain("literal host")
    expect(external("https://docs.{{result.host}}.com/x")).toContain("literal host")
    expect(external("https://docs.example.com?id={{result.id}}")).toContain("continue with a path")
    expect(external("http://docs.example.com/x")).toContain("must start with https://")
    expect(external("https://user@docs.example.com/x")).toContain("literal host name")
    expect(external("https://192.0.2.1/x")).toContain("literal host name")
  })

  it("refuses a gated tool without a confirm, and accepts it with one", () => {
    const click = {
      kind: "tool",
      label: { label: "Delete" },
      tool: "delete_item",
      params: { id: "result.id" },
    }
    expect(act(click)).toContain("calls the gated tool 'delete_item' and needs a confirm label")
    expect(act({ ...click, confirm: { label: "Delete this item?" } })).toBe("")
  })
})

describe("the groups card", () => {
  it("validates with its groups", () => {
    expect(judge(groupsCard())).toBe("")
  })

  it("needs groups", () => {
    const { groups: _groups, ...without } = groupsCard()
    expect(judge(without)).toContain("resultCard.groups: is required on a groups card")
  })

  it("holds at most 5 columns", () => {
    const columns = (n: number) =>
      Array.from({ length: n }, (_v, i) => ({ key: `c${i}`, label: { label: `C${i}` } }))
    expect(judge(groupsCard({ columns: columns(5) }))).toContain("cells.planned")
    expect(judge(groupsCard({ columns: columns(6) }))).toContain("has 6 entries, at most 5")
  })

  it("keeps every path inside result, group or row", () => {
    const rows = (over: Record<string, unknown>) => {
      const card = groupsCard() as { groups: { rows: Record<string, unknown> } }
      Object.assign(card.groups.rows, over)
      return card
    }
    expect(judge(rows({ name: "{{env.SECRET}}" }))).toContain("'env.SECRET' is not a path")
    expect(judge(rows({ id: "group.id" }))).toBe("")
    expect(judge(rows({ path: "row.rows" }))).toContain(
      "starts with row, which is not available here",
    )
    expect(judge(groupsCard({ cover: "{{row.name}}" }))).toContain("which is not available here")
  })

  const edit = (over: Record<string, unknown> = {}) => ({
    openLabel: { label: "Edit" },
    doneLabel: { label: "Done" },
    tool: "rename_item",
    params: { id: "result.id" },
    rowParam: "id",
    fields: [{ param: "name", label: { label: "Name" }, kind: "text", valuePath: "row.name" }],
    ...over,
  })

  it("accepts an edit on an ungated tool of the same app", () => {
    expect(judge(groupsCard({ edit: edit() }))).toBe("")
  })

  it("refuses an edit on a gated tool", () => {
    expect(judge(groupsCard({ edit: edit({ tool: "delete_item" }) }))).toContain(
      "an edit cannot call a gated tool",
    )
  })

  it("refuses an edit on a tool of another app", () => {
    expect(judge(groupsCard({ edit: edit({ tool: "other:rename_item" }) }))).toContain(
      "not a tool of this app",
    )
  })

  it("refuses an edit of a field outside the tool's params", () => {
    const fields = [{ param: "colour", label: { label: "C" }, kind: "text", valuePath: "row.name" }]
    expect(judge(groupsCard({ edit: edit({ fields }) }))).toContain(
      "edit.fields[0].param: 'colour' is not a parameter of the tool",
    )
  })

  it("a row's ask takes neither a value of the row in its prompt nor a label from the data", () => {
    const card = groupsCard() as { groups: { rows: Record<string, unknown> } }
    card.groups.rows.act = { kind: "ask", label: { label: "Why" }, prompt: "Why is it late?" }
    expect(judge(card)).toBe("")
    card.groups.rows.act = { kind: "ask", label: { label: "Why" }, prompt: "Why {{row.name}}?" }
    expect(judge(card)).toContain("groups.rows.act.prompt: must be fixed text")
    card.groups.rows.act = {
      kind: "ask",
      label: { label: "Why" },
      prompt: "Why is it late?",
      labelPath: "row.name",
    }
    expect(judge(card)).toContain("labelPath")
  })

  it("refuses a row action on a gated tool without a confirm", () => {
    const card = groupsCard() as { groups: { rows: Record<string, unknown> } }
    card.groups.rows.act = {
      kind: "tool",
      label: { label: "Delete" },
      tool: "delete_item",
      params: { id: "row.id" },
    }
    expect(judge(card)).toContain("groups.rows.act: calls the gated tool 'delete_item'")
    card.groups.rows.act = {
      ...(card.groups.rows.act as object),
      confirm: { label: "Delete this line?" },
    }
    expect(judge(card)).toBe("")
  })

  it("refuses a cell for a column the card does not have", () => {
    const card = groupsCard() as { groups: { rows: { cells: Record<string, string> } } }
    card.groups.rows.cells.price = "row.price"
    expect(judge(card)).toContain("groups.rows.cells.price: is not a column of the card")
  })
})
