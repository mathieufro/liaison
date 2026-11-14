// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE AGENT CAN OPEN ANY TAB A PERSON CAN. This walks every manifest in the tree and the
// kernel's own tab list, so a new app, or a new kernel tab, cannot ship a tab the agent cannot
// reach: a tab that takes an id must name a record with a way to read its label, or say why its
// id is not a record. What each one does under real row security is
// `tests/integration/open-any-tab.test.ts`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import {
  DETAIL_PANELS_WITH_NO_SINGLE_ID,
  KERNEL_OPEN_VIEWS,
  type OpenView,
  openViewsOf,
  TABS_WHOSE_ID_IS_NOT_A_RECORD,
  uiEffectRequester,
} from "~/modules/agent/tools/open-targets"
import { entityRegistry, viewRegistry } from "~/modules/apps/app-registries"
import { resolveEntityLabel } from "~/modules/threads/reference-display"

const ROOT = join(import.meta.dir, "../../../../../..")
const ORG = "00000000-0000-4000-8000-0000000000aa"

interface Manifest {
  name: string
  entities?: Record<string, Record<string, unknown>>
  views?: {
    tabTypes?: Record<string, { urlPattern?: string; label?: string; entity?: string }>
    detail?: Record<string, { component?: string; externalLink?: unknown }>
  }
}

function manifests(): Manifest[] {
  const out: Manifest[] = []
  for (const base of ["apps/api/src/apps", "bundled-apps"]) {
    for (const name of readdirSync(join(ROOT, base))) {
      try {
        out.push(JSON.parse(readFileSync(join(ROOT, base, name, "app.manifest.json"), "utf8")))
      } catch {
        // No manifest here.
      }
    }
  }
  return out
}

function load(m: Manifest): void {
  viewRegistry.set([ORG, m.name], (m.views ?? {}) as never)
  for (const [entity, decl] of Object.entries(m.entities ?? {})) {
    entityRegistry.set([ORG, m.name, entity], decl as never)
  }
}

function unload(m: Manifest): void {
  viewRegistry.delete([ORG, m.name])
  for (const entity of Object.keys(m.entities ?? {})) entityRegistry.delete([ORG, m.name, entity])
}

/** The kernel entities `resolveEntityLabel` reads by name, proved below with a fake reader. */
const KERNEL_READERS = new Set([
  "thread",
  "contact",
  "company",
  "routine",
  "skill",
  "agent",
  "session",
])

function hasReader(record: NonNullable<OpenView["record"]>): boolean {
  if (record.app === "kernel") return KERNEL_READERS.has(record.entityType)
  const decl = entityRegistry.get([ORG, record.app, record.entityType]) as
    | { tableName?: string; external?: boolean; labelField?: string }
    | undefined
  // A table to read the label from, or a record that lives in another system.
  return !!decl && (!!decl.tableName || decl.external === true)
}

/** Every tab or panel of `m` the agent could not open. */
function unreachable(m: Manifest): string[] {
  const views = openViewsOf(ORG, m.name) ?? []
  const byView = new Map(views.map((v) => [v.view, v]))
  const out: string[] = []
  for (const tab of Object.keys(m.views?.tabTypes ?? {})) {
    const view = byView.get(tab)
    const qualified = `${m.name}:${tab}`
    if (!view) out.push(qualified)
    else if (view.needsId && !TABS_WHOSE_ID_IS_NOT_A_RECORD.has(qualified)) {
      if (!view.record || !hasReader(view.record)) out.push(qualified)
    }
  }
  for (const entity of Object.keys(m.views?.detail ?? {})) {
    const qualified = `${m.name}:${entity}`
    if (DETAIL_PANELS_WITH_NO_SINGLE_ID.has(qualified)) continue
    const view = byView.get(entity)
    if (!view?.record || !hasReader(view.record)) out.push(qualified)
  }
  return out
}

describe("every tab a person can open, the agent can open", () => {
  const all = manifests()
  beforeAll(() => {
    for (const m of all) load(m)
  })
  afterAll(() => {
    for (const m of all) unload(m)
  })

  test("the walk found the apps it is about", () => {
    const names = new Set(all.map((m) => m.name))
    for (const app of ["invoicing", "tickets", "projects", "boxtal", "shopify", "contacts"]) {
      expect(names.has(app)).toBe(true)
    }
  })

  for (const m of manifests()) {
    const tabs = Object.keys(m.views?.tabTypes ?? {})
    const panels = Object.keys(m.views?.detail ?? {})
    if (tabs.length + panels.length === 0) continue
    test(`${m.name}: ${[...new Set([...tabs, ...panels])].join(", ")}`, () => {
      expect(unreachable(m)).toEqual([])
    })
  }

  test("a new app's tab with an id and no way to read it fails this walk", () => {
    const fixture: Manifest = {
      name: "fixture-no-reader",
      views: { tabTypes: { widget: { urlPattern: "/fixture/:id", label: "Widget" } } },
    }
    load(fixture)
    expect(unreachable(fixture)).toEqual(["fixture-no-reader:widget"])
    unload(fixture)
  })

  test("a new app's detail panel with no entity behind it fails this walk", () => {
    const fixture: Manifest = {
      name: "fixture-no-entity",
      views: { detail: { gadget: { component: "GadgetPanel" } } },
    }
    load(fixture)
    expect(unreachable(fixture)).toEqual(["fixture-no-entity:gadget"])
    unload(fixture)
  })

  test("a new app's tab naming a record with a table is reachable with no declaration of its own", () => {
    const fixture: Manifest = {
      name: "fixture-deal",
      entities: { deal: { tableName: "deals", labelField: "name" } },
      views: { tabTypes: { deal: { urlPattern: "/deals/:id", label: "Deal" } } },
    }
    load(fixture)
    expect(unreachable(fixture)).toEqual([])
    expect(openViewsOf(ORG, "fixture-deal")?.[0]?.target).toEqual({
      kind: "tab",
      type: "fixture-deal:deal",
    })
    unload(fixture)
  })

  const NAMED: Array<[string, string, string, OpenView["target"]["kind"]]> = [
    ["an invoice", "invoicing", "detail", "tab"],
    ["a ticket", "tickets", "ticket", "tab"],
    ["a task", "projects", "task", "tab"],
    ["a project", "projects", "project", "tab"],
    ["a contact", "contacts", "contact-detail", "tab"],
    ["a company", "contacts", "company-detail", "tab"],
    ["a channel or a direct conversation", "kernel", "thread", "tab"],
    ["a mail conversation", "mail", "conversation", "tab"],
    ["a knowledge document", "knowledge", "document", "tab"],
    ["a calendar event", "calendar", "event", "calendar-event"],
    ["a routine", "kernel", "routine", "agent-item"],
    ["a skill", "kernel", "skill", "agent-item"],
    ["a shipment", "boxtal", "shipment", "detail"],
    ["an order, whose only page is in the shop's admin", "shopify", "order", "outside"],
  ]
  for (const [what, app, view, kind] of NAMED) {
    test(`${what} is ${app} ${view}`, () => {
      const found = openViewsOf(ORG, app)?.find((v) => v.view === view)
      expect(found?.needsId).toBe(true)
      expect(found?.record).not.toBeNull()
      expect(found?.target.kind).toBe(kind)
    })
  }
})

describe("the kernel's own tabs are declared", () => {
  /** The tab keys of a `registerApp` literal: the object directly under `tabTypes:`. */
  function tabKeys(file: string, after: string): string[] {
    const text = readFileSync(join(ROOT, file), "utf8")
    const from = text.indexOf("tabTypes: {", text.indexOf(after))
    const lines = text.slice(from).split("\n")
    const indent = (lines[1]?.match(/^ */)?.[0] ?? "").length
    const keys: string[] = []
    for (const line of lines.slice(1)) {
      const own = line.match(/^ */)?.[0].length === indent
      if (line.trim() === "}," && (line.match(/^ */)?.[0].length ?? 0) < indent) break
      const key = own ? /^\s*"?([\w-]+)"?: \{$/.exec(line)?.[1] : undefined
      if (key) keys.push(key)
    }
    return keys
  }

  const kernelTabs = tabKeys("apps/web/src/framework/bootstrap.ts", 'name: "kernel"')

  test("the parse found the kernel's tabs", () => {
    expect(kernelTabs).toContain("thread")
    expect(kernelTabs).toContain("home")
    expect(kernelTabs.length).toBeGreaterThan(8)
  })

  for (const tab of kernelTabs) {
    test(`kernel:${tab}`, () => {
      // `detail` hosts apps' panels: its id is `<app>/<entity>/<id>`, reached through the app.
      if (tab === "detail") return
      expect(KERNEL_OPEN_VIEWS.some((v) => v.view === tab)).toBe(true)
    })
  }

  test("the agent page is declared", () => {
    expect(tabKeys("apps/web/src/modules/agent/agent-app.ts", 'name: "agents"')).toEqual(["agent"])
    expect(KERNEL_OPEN_VIEWS.find((v) => v.view === "agent")?.target).toEqual({
      kind: "tab",
      type: "agents:agent",
    })
  })

  test("every kernel record the walk relies on has a label reader", async () => {
    const row = { title: "Named", name: "Named", handle: "named", email: null }
    const fake = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [row] }) }) }),
      execute: async () => [],
    }
    for (const view of KERNEL_OPEN_VIEWS) {
      if (!view.record) continue
      const label = await resolveEntityLabel(fake as never, {
        orgId: ORG,
        app: view.record.app,
        entityType: view.record.entityType,
        entityId: "00000000-0000-4000-8000-000000000001",
      })
      expect(label).toBe("Named")
    }
  })
})

describe("whose screen an open_app frame may move", () => {
  test("it names the requester on the tool's own call", () => {
    expect(uiEffectRequester("kernel__open_app", "u1")).toEqual({ requesterId: "u1" })
  })

  test("a routine's run names nobody, so its frames move no one's screen", () => {
    runContextStore.run({ routineId: "routine-1" } as never, () => {
      expect(uiEffectRequester("kernel__open_app", "u1")).toEqual({})
    })
  })

  test("another tool's frames carry nothing extra", () => {
    expect(uiEffectRequester("kernel__threads_read", "u1")).toEqual({})
  })
})
