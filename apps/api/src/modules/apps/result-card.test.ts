// SPDX-License-Identifier: FSL-1.1-ALv2
//
// resolveToolCard: one tool result and the tool's template in, a card or null out. Pure, bounded,
// and never throwing, so a tool whose card does not fit still answers and the chat draws the
// ordinary row.

import { describe, expect, it } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import type { CardTemplate } from "@liaison/shared"
import { resolveToolCard } from "~/modules/apps/result-card"

const plain = (v: unknown) => JSON.parse(JSON.stringify(v))
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length
const resolved = (t: unknown, r: unknown) => resolveToolCard(t as CardTemplate, r)

const ENTITY: CardTemplate = {
  kind: "entity",
  pill: { label: "Invoice", labelKey: "cards.invoice" },
  icon: "wallet",
  ref: "#{{result.number}}",
  title: "{{result.name}}",
  sub: "{{result.company}}",
  end: "{{result.absent}}",
  foot: { label: "From Invoicing" },
  open: { view: "invoice", idPath: "result.id" },
  status: {
    path: "result.state",
    map: {
      paid: { label: { label: "Paid" }, tone: "success" },
      open: { label: { label: "Open" }, tone: "warning" },
    },
  },
  rows: [
    { label: { label: "Total" }, value: "{{result.total}}", format: "money", mono: true },
    {
      label: { label: "Due" },
      value: "{{result.due}}",
      format: "date",
      warnWhen: { path: "result.late", equals: "true" },
    },
    { label: { label: "Note" }, value: "{{result.note}}" },
  ],
  actions: [
    { kind: "open", label: { label: "Open" }, view: "invoice", idPath: "result.id" },
    {
      kind: "tool",
      label: { label: "Send" },
      tool: "send_invoice",
      params: { id: "result.id" },
      confirm: { label: "Send it?" },
      primary: true,
    },
    {
      kind: "external",
      label: { label: "Pay page" },
      urlTemplate: "https://pay.example.com/i/{{result.id}}",
    },
  ],
}

const INVOICE = {
  id: "inv_1",
  number: 42,
  name: "Acme",
  company: "Acme Ltd",
  state: "paid",
  total: { minor: 12500, currency: "eur" },
  due: "2026-11-20",
  late: true,
}

describe("resolveToolCard", () => {
  it("resolves an entity card to the exact JSON", () => {
    expect(plain(resolved(ENTITY, INVOICE))).toEqual({
      kind: "entity",
      pill: { label: "Invoice", labelKey: "cards.invoice" },
      icon: "wallet",
      ref: "#42",
      title: "Acme",
      sub: "Acme Ltd",
      foot: { label: "From Invoicing" },
      open: { view: "invoice", id: "inv_1" },
      status: { label: { label: "Paid" }, tone: "success" },
      rows: [
        {
          label: { label: "Total" },
          value: { t: "money", minor: 12500, currency: "EUR" },
          mono: true,
        },
        { label: { label: "Due" }, value: { t: "date", iso: "2026-11-20" }, warn: true },
      ],
      actions: [
        { kind: "open", label: { label: "Open" }, view: "invoice", id: "inv_1" },
        {
          kind: "tool",
          label: { label: "Send" },
          tool: "send_invoice",
          params: { id: "inv_1" },
          confirm: { label: "Send it?" },
          primary: true,
        },
        { kind: "external", label: { label: "Pay page" }, url: "https://pay.example.com/i/inv_1" },
      ],
    })
  })

  it("resolves a list card to the exact JSON", () => {
    const list: CardTemplate = {
      kind: "list",
      pill: { label: "Deals" },
      title: "{{result.title}}",
      items: {
        path: "result.deals",
        label: "{{item.name}}",
        meta: "{{item.stage}}",
        num: "{{item.amount}}",
        numFormat: "money",
        open: { view: "deal", idPath: "item.id" },
        limit: 2,
      },
      more: { label: { label: "All deals" }, open: { view: "deals" } },
    }
    const result = {
      title: "Open deals",
      deals: [
        { id: "d1", name: "A", stage: "won", amount: { minor: 100, currency: "usd" } },
        { id: "d2", name: "B" },
        { id: "d3", name: "C" },
      ],
    }
    expect(plain(resolved(list, result))).toEqual({
      kind: "list",
      pill: { label: "Deals" },
      title: "Open deals",
      items: [
        {
          label: "A",
          meta: "won",
          num: { t: "money", minor: 100, currency: "USD" },
          open: { view: "deal", id: "d1" },
        },
        { label: "B", open: { view: "deal", id: "d2" } },
      ],
      more: { label: { label: "All deals" }, view: "deals" },
    })
  })

  it("resolves a number card to the exact JSON", () => {
    const number: CardTemplate = {
      kind: "number",
      pill: { label: "Revenue" },
      title: "Monthly revenue",
      value: "{{result.mrr}}",
      valueFormat: "money",
      delta: "{{result.change}}",
      how: { label: "Active subscriptions, monthly" },
      source: "{{result.source}}",
    }
    const result = { mrr: { minor: 540000, currency: "EUR" }, change: "+4%", source: "Ledger" }
    expect(plain(resolved(number, result))).toEqual({
      kind: "number",
      pill: { label: "Revenue" },
      title: "Monthly revenue",
      value: { t: "money", minor: 540000, currency: "EUR" },
      delta: "+4%",
      how: { label: "Active subscriptions, monthly" },
      source: "Ledger",
    })
  })

  it("a number with no source is not a card", () => {
    const number = {
      kind: "number",
      pill: { label: "Revenue" },
      value: "{{result.mrr}}",
      how: { label: "How" },
      source: "{{result.source}}",
    }
    expect(resolved(number, { mrr: 5 })).toBeNull()
  })
})

const GROUPS: CardTemplate = {
  kind: "groups",
  pill: { label: "Plan" },
  title: "{{result.name}}",
  cover: "{{result.cover}}",
  columns: [
    { key: "planned", label: { label: "Planned" }, format: "hours" },
    { key: "bill", label: { label: "Billed" }, format: "hours" },
    {
      key: "hidden",
      label: { label: "Hidden" },
      when: { path: "result.showHidden", exists: true },
    },
  ],
  groups: {
    path: "result.groups",
    label: "{{group.label}}",
    rows: {
      path: "group.rows",
      id: "row.id",
      name: "{{row.name}}",
      tag: "{{row.tag}}",
      flag: "row.late",
      cells: { planned: "row.planned", bill: "row.bill", hidden: "row.hidden" },
      links: {
        path: "row.proof",
        label: "{{item.title}}",
        open: { view: "note", idPath: "item.ref" },
        urlPath: "item.url",
      },
      act: {
        kind: "ask",
        label: { label: "Why" },
        prompt: "Why {{row.name}}?",
        when: { path: "row.late", exists: true },
      },
    },
  },
  tot: { path: "result.totals", k: "{{item.k}}", v: "{{item.v}}", format: "hours" },
  notes: { path: "result.notes", text: "{{item.text}}" },
  edit: {
    openLabel: { label: "Edit" },
    doneLabel: { label: "Done" },
    tool: "update_line",
    params: { recordId: "result.id", revision: "result.revision" },
    rowParam: "lineId",
    fields: [
      { param: "bill", label: { label: "Billed" }, kind: "quantity", valuePath: "row.bill" },
    ],
  },
  latestKey: "plan:{{result.id}}",
}

const PLAN = {
  id: "rec1",
  revision: 3,
  name: "Plan",
  cover: "2 of 3 lines",
  groups: [
    {
      label: "Design",
      rows: [
        {
          id: "l1",
          name: "Wireframes",
          tag: "new",
          late: true,
          planned: 180,
          bill: 120,
          hidden: "x",
          proof: [
            { title: "Notes", ref: "n1", url: "https://x.example.com/a" },
            { title: "Bad", url: "http://x.example.com/b" },
          ],
        },
        { id: "l2", name: "Review", planned: 60 },
      ],
    },
  ],
  totals: [{ k: "Planned", v: 240 }],
  notes: [{ text: "Draft" }],
}

describe("resolveToolCard, groups", () => {
  it("resolves a groups card to the exact JSON", () => {
    expect(plain(resolved(GROUPS, PLAN))).toEqual({
      kind: "groups",
      pill: { label: "Plan" },
      title: "Plan",
      cover: "2 of 3 lines",
      columns: [
        { key: "planned", label: { label: "Planned" }, format: "hours" },
        { key: "bill", label: { label: "Billed" }, format: "hours" },
      ],
      groups: [
        {
          label: "Design",
          rows: [
            {
              id: "l1",
              name: "Wireframes",
              tag: "new",
              flag: true,
              cells: { planned: { t: "hours", minutes: 180 }, bill: { t: "hours", minutes: 120 } },
              links: [
                {
                  label: "Notes",
                  open: { view: "note", id: "n1" },
                  url: "https://x.example.com/a",
                },
                { label: "Bad" },
              ],
              act: { kind: "ask", label: { label: "Why" }, prompt: "Why Wireframes?" },
              edit: { bill: { value: 120 } },
            },
            {
              id: "l2",
              name: "Review",
              cells: { planned: { t: "hours", minutes: 60 } },
              links: [],
            },
          ],
        },
      ],
      tot: [{ k: "Planned", v: { t: "hours", minutes: 240 } }],
      notes: [{ text: "Draft" }],
      edit: {
        openLabel: { label: "Edit" },
        doneLabel: { label: "Done" },
        tool: "update_line",
        params: { recordId: "rec1", revision: 3 },
        rowParam: "lineId",
        fields: [{ param: "bill", label: { label: "Billed" }, kind: "quantity" }],
      },
      latestKey: "plan:rec1",
    })
  })

  it("draws a summary line instead of the groups when its condition holds", () => {
    const template = {
      ...GROUPS,
      summary: {
        when: { path: "result.done", equals: "true" },
        text: "Nothing left in {{result.name}}",
        actions: [{ kind: "open", label: { label: "Open" }, view: "plan", idPath: "result.id" }],
      },
    } as CardTemplate
    const card = resolved(template, { ...PLAN, done: true })
    expect(plain(card).summary).toEqual({
      text: "Nothing left in Plan",
      actions: [{ kind: "open", label: { label: "Open" }, view: "plan", id: "rec1" }],
    })
    expect(card?.groups).toBeUndefined()
    expect(resolved(template, { ...PLAN, done: false })?.groups).toHaveLength(1)
  })

  it("leaves the edit out when the revision it applies to is missing", () => {
    const { revision: _revision, ...noRevision } = PLAN
    const card = resolved(GROUPS, noRevision)
    expect(card?.edit).toBeUndefined()
    expect(card?.groups?.[0]?.rows[0]?.edit).toBeUndefined()
  })
})

describe("resolveToolCard, results that do not fit", () => {
  it("a missing required path gives null", () => {
    const { name: _name, ...noName } = INVOICE
    expect(resolved(ENTITY, noName)).toBeNull()
  })

  it("a result that is not an object gives null", () => {
    for (const result of ["text", 12, null, undefined, [INVOICE], true]) {
      expect(resolved(ENTITY, result)).toBeNull()
    }
  })

  it("a template condition that does not hold gives null", () => {
    const template = { ...ENTITY, when: { path: "result.state", equals: "open" } }
    expect(resolved(template, INVOICE)).toBeNull()
    expect(resolved(template, { ...INVOICE, state: "open" })).not.toBeNull()
  })

  it("a value of the wrong type for its format gives null", () => {
    expect(resolved(ENTITY, { ...INVOICE, total: "12500" })).not.toBeNull()
    // An optional row whose value has the wrong type is left out; the card stands.
    expect(resolved(ENTITY, { ...INVOICE, total: "12500" })?.rows).toHaveLength(1)
    const single: CardTemplate = {
      kind: "number",
      pill: { label: "P" },
      value: "{{result.total}}",
      valueFormat: "money",
      how: { label: "h" },
      source: "s",
    }
    expect(resolved(single, { total: { minor: 1.5, currency: "EUR" } })).toBeNull()
    expect(resolved(single, { total: { minor: 150, currency: "EURO" } })).toBeNull()
    expect(resolved(single, { total: { minor: 150, currency: "EUR" } })).not.toBeNull()
  })

  it("reads own properties only", () => {
    const template = { ...ENTITY, title: "{{result.constructor}}" }
    expect(resolved(template, {})).toBeNull()
    expect(resolved({ ...ENTITY, title: "{{result.__proto__}}" }, {})).toBeNull()
  })

  it("never throws on a template that is not one", () => {
    for (const template of [null, undefined, 5, {}, { kind: "carousel", pill: { label: "x" } }]) {
      expect(() => resolved(template, INVOICE)).not.toThrow()
      expect(resolved(template, INVOICE)).toBeNull()
    }
    const cyclic: Record<string, unknown> = { name: "x" }
    cyclic.self = cyclic
    expect(() => resolved(ENTITY, cyclic)).not.toThrow()
  })

  it("a status the map does not name shows no status", () => {
    expect(resolved(ENTITY, { ...INVOICE, state: "constructor" })?.status).toBeUndefined()
    expect(resolved(ENTITY, { ...INVOICE, state: "void" })?.status).toBeUndefined()
  })

  it("an https link from data is a link, any other scheme is text", () => {
    const rows = (url: string) =>
      resolved(GROUPS, {
        ...PLAN,
        groups: [{ label: "G", rows: [{ id: "a", name: "A", proof: [{ title: "T", url }] }] }],
      })?.groups?.[0]?.rows[0]?.links[0]
    expect(rows("https://ok.example.com/p")?.url).toBe("https://ok.example.com/p")
    expect(rows("http://ok.example.com/p")?.url).toBeUndefined()
    expect(rows("javascript:alert(1)")?.url).toBeUndefined()
  })

  it("encodes a value placed in an external link", () => {
    const action = resolved(ENTITY, { ...INVOICE, id: "a b/../c?x=1" })?.actions?.[2]
    expect(action).toEqual({
      kind: "external",
      label: { label: "Pay page" },
      url: "https://pay.example.com/i/a%20b%2F..%2Fc%3Fx%3D1",
    })
  })
})

/** An entity card whose JSON is exactly `target` bytes, padded through the title. */
function entityOfSize(target: number, filler = "x") {
  const template: CardTemplate = { kind: "entity", pill: { label: "P" }, title: "{{result.name}}" }
  const base = bytes(resolved(template, { name: "" }))
  const width = new TextEncoder().encode(filler).length
  const count = Math.floor((target - base) / width)
  const result = { name: filler.repeat(count) }
  return { template, result, size: base + count * width }
}

describe("resolveToolCard, size bounds", () => {
  it("keeps a card of 4095 and 4096 bytes and refuses 4097", () => {
    for (const target of [4095, 4096, 4097]) {
      const { template, result, size } = entityOfSize(target)
      expect(size).toBe(target)
      expect(resolved(template, result) !== null).toBe(target <= 4096)
    }
  })

  it("counts bytes, not characters", () => {
    const { template, result, size } = entityOfSize(4096, "é")
    expect(size).toBeGreaterThanOrEqual(4095)
    expect(size).toBeLessThanOrEqual(4096)
    expect(resolved(template, result)).not.toBeNull()
    const over = { name: `${result.name}é` }
    expect(over.name.length).toBeLessThan(4096)
    expect(resolved(template, over)).toBeNull()
  })

  /** 40 rows in 4 groups, the cover padded so the card's JSON is exactly `target` bytes. */
  function planOfSize(target: number, rowsPerGroup = 10) {
    const rows = (g: number) =>
      Array.from({ length: rowsPerGroup }, (_v, i) => ({
        id: `r${g}-${i}`,
        name: `Line ${g}-${i}`,
        planned: 60,
        bill: 30,
      }))
    const base = {
      ...PLAN,
      cover: "",
      groups: [0, 1, 2, 3].map((g) => ({ label: `Group ${g}`, rows: rows(g) })),
    }
    const empty = bytes(resolved(GROUPS, base))
    return { ...base, cover: "c".repeat(target - empty), empty }
  }

  it("keeps 40 rows up to 24576 bytes and refuses 24577", () => {
    expect(planOfSize(24_575).cover.length).toBeGreaterThan(0)
    for (const [target, kept] of [
      [24_575, true],
      [24_576, true],
      [24_577, false],
    ] as const) {
      const plan = planOfSize(target)
      const card = resolved(GROUPS, plan)
      expect(card !== null).toBe(kept)
      if (card) expect(bytes(card)).toBe(target)
    }
  })

  it("holds 40 rows and gives null for 41", () => {
    const plan = planOfSize(20_000)
    const groups = plan.groups.map((g) => ({ ...g }))
    expect(resolved(GROUPS, { ...plan, groups })).not.toBeNull()
    groups[3]?.rows.push({ id: "extra", name: "One more", planned: 1, bill: 1 })
    expect(resolved(GROUPS, { ...plan, groups })).toBeNull()
  })
})

describe("resolveToolCard, what it can read", () => {
  it("takes only a template and a result", () => {
    expect(resolveToolCard.length).toBe(2)
  })

  it("reaches no database module", () => {
    const root = resolve(import.meta.dir, "../../..")
    const pending = [resolve(import.meta.dir, "result-card.ts")]
    const seen = new Set<string>()
    const forbidden: string[] = []
    while (pending.length > 0) {
      const file = pending.pop() as string
      if (seen.has(file)) continue
      seen.add(file)
      const source = readFileSync(file, "utf8")
      // A type-only import is erased and reaches nothing.
      const specifiers = [
        ...source.matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gms),
      ].map((m) => m[1] as string)
      for (const spec of specifiers) {
        if (/(^|\/)db(\/|$)|drizzle|postgres|bun:sql|^pg$|~\/lib\/env/.test(spec)) {
          forbidden.push(`${file}: ${spec}`)
        }
        const target = spec.startsWith("~/")
          ? resolve(root, "src", spec.slice(2))
          : spec.startsWith(".")
            ? resolve(dirname(file), spec)
            : null
        const found = target && [`${target}.ts`, `${target}/index.ts`].find((f) => existsSync(f))
        if (found) pending.push(found)
      }
    }
    expect(forbidden).toEqual([])
    expect(seen.size).toBe(1)
  })
})
