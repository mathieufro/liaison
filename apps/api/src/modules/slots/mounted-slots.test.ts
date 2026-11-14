// SPDX-License-Identifier: FSL-1.1-ALv2
// Mounted slots: one list for manifest slot panels, slot actions and
// `contributions`, filtered by scope, app state and feature.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import ticketsManifest from "~/apps/tickets/app.manifest.json"
import { slotRegistry } from "~/modules/apps/app-registries"
import { forgetOrgApps, rememberOrgAppStates } from "~/modules/apps/org-apps"
import type { Scope } from "~/modules/permissions/types"
import apiConnectorManifest from "../../../../../bundled-apps/api-connector/app.manifest.json"
import invoicingManifest from "../../../../../bundled-apps/invoicing/app.manifest.json"
import exampleManifest from "../../../test-support/apps/example/app.manifest.json"
import { APPROVAL_DETAIL_PANEL_SLOT, listSlotPanels, registerAppSlots } from "./registry"
import { slotsRoutes } from "./routes"

const ORG = "org-mounted-slots-1"

const SIX_SLOTS = [
  "project:task:tabs",
  "project:task:actions",
  "project:detail:panel",
  "contact_detail",
  "ticket:detail:panel",
  "ticket:detail:actions",
] as const

function registerExample(): void {
  registerAppSlots(ORG, "example", exampleManifest.slots as Record<string, unknown>, undefined)
}

function exampleOn(features: string[] = ["slot_panels"]): void {
  rememberOrgAppStates(ORG, [{ app: "example", status: "active" }], {
    features: { example: features },
  })
}

function makeApp(scopes: string[]) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("orgId", ORG)
    c.set("scopes", scopes as Scope[])
    await next()
  })
  app.route("/api/v1/slots", slotsRoutes)
  return app
}

async function routePanels(scopes: string[], slot: string): Promise<Array<{ id: string }>> {
  const res = await makeApp(scopes).request(`/api/v1/slots/${encodeURIComponent(slot)}`)
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: { panels: Array<{ id: string }> } }).data.panels
}

describe("mounted slots", () => {
  beforeEach(() => slotRegistry.deleteByPrefix([ORG]))
  afterEach(() => {
    slotRegistry.deleteByPrefix([ORG])
    forgetOrgApps(ORG)
  })

  test("example declares a panel on each of the six slots, each is listed on its slot", () => {
    registerExample()
    exampleOn()
    for (const slot of SIX_SLOTS) {
      const panels = listSlotPanels({ orgId: ORG, scopes: ["example:items:read"], slot })
      expect(panels.map((p) => `${p.app}:${p.id}`)).toEqual([
        `example:example-${slot.replaceAll(":", "-").replaceAll("_", "-")}`,
      ])
    }
  })

  test("visibility_scope the viewer lacks: absent from the route and the DOM", async () => {
    registerExample()
    exampleOn()
    for (const slot of SIX_SLOTS) {
      expect(await routePanels(["example:items:write"], slot)).toEqual([])
      expect(await routePanels(["example:items:read"], slot)).toHaveLength(1)
    }
  })

  test("app Off: absent", async () => {
    registerExample()
    rememberOrgAppStates(ORG, [{ app: "example", status: "disabled" }], {
      features: { example: ["slot_panels"] },
    })
    for (const slot of SIX_SLOTS) expect(await routePanels(["*"], slot)).toEqual([])
  })

  test("a panel naming a switched-off feature is absent from the route and the DOM", async () => {
    registerExample()
    // Another feature of the same app on, the panels' own off: still absent, admin included.
    exampleOn(["item_notes"])
    for (const slot of SIX_SLOTS) expect(await routePanels(["*"], slot)).toEqual([])
    exampleOn()
    for (const slot of SIX_SLOTS) expect(await routePanels(["*"], slot)).toHaveLength(1)
  })

  test("an unregistered slot key is empty, no error", async () => {
    registerExample()
    exampleOn()
    expect(await routePanels(["*"], "company_detail")).toEqual([])
  })

  test("contributions from api-connector and tickets go through the one list, by component name", () => {
    registerAppSlots(
      ORG,
      "api-connector",
      undefined,
      apiConnectorManifest.contributions as Record<string, unknown>,
    )
    registerAppSlots(
      ORG,
      "tickets",
      ticketsManifest.slots as Record<string, unknown>,
      ticketsManifest.contributions as Record<string, unknown>,
    )
    rememberOrgAppStates(ORG, [
      { app: "api-connector", status: "active" },
      { app: "tickets", status: "active" },
    ])
    const at = (slot: string) =>
      listSlotPanels({ orgId: ORG, scopes: [], slot }).map((p) => `${p.app}:${p.id}`)
    expect(at("ticket:detail:panel")).toEqual(["api-connector:TicketCustomerCard"])
    // Same order, then app name.
    expect(at("mail:conversation:banner")).toEqual([
      "api-connector:MailCustomerCard",
      "tickets:MailConvertToTicketBanner",
    ])
    expect(at("mail:conversation:actions")).toEqual(["tickets:MailConvertToTicketAction"])
    // The host's own `position` declaration lists nothing.
    expect(at("ticket:detail:actions")).toEqual([])
  })

  test("a contribution's visibility_scope hides it like a panel's", () => {
    registerAppSlots(ORG, "crm-fixture", undefined, {
      "ticket:detail:panel": {
        label: "Customer",
        component: "CustomerCard",
        visibility_scope: "crm-fixture:customers:read",
      },
    })
    rememberOrgAppStates(ORG, [{ app: "crm-fixture", status: "active" }])
    const slot = "ticket:detail:panel"
    expect(listSlotPanels({ orgId: ORG, scopes: [], slot })).toEqual([])
    expect(
      listSlotPanels({ orgId: ORG, scopes: ["crm-fixture:customers:read"], slot }).map((p) => p.id),
    ).toEqual(["CustomerCard"])
  })

  test("an approval card mounts the panel contributed for its tool and only for that tool, hidden without the scope", async () => {
    registerAppSlots(ORG, "billing-fixture", undefined, {
      [APPROVAL_DETAIL_PANEL_SLOT]: {
        label: "Run",
        component: "RunPanel",
        for_tool: "billing-fixture:run_issue",
        visibility_scope: "billing-fixture:documents:read",
      },
    })
    rememberOrgAppStates(ORG, [{ app: "billing-fixture", status: "active" }])
    const reader = ["billing-fixture:documents:read"]
    const at = (forTool: string | undefined, scopes: string[]) =>
      listSlotPanels({ orgId: ORG, scopes, slot: APPROVAL_DETAIL_PANEL_SLOT, forTool }).map(
        (p) => `${p.app}:${p.id}`,
      )
    expect(at("billing-fixture:run_issue", reader)).toEqual(["billing-fixture:RunPanel"])
    // Another tool's card, or a card that names no tool, mounts nothing.
    expect(at("billing-fixture:other_tool", reader)).toEqual([])
    expect(at(undefined, reader)).toEqual([])
    // Without the scope, nothing either.
    expect(at("billing-fixture:run_issue", [])).toEqual([])
    // The route takes the tool as a query.
    const res = await makeApp(reader).request(
      `/api/v1/slots/${encodeURIComponent(APPROVAL_DETAIL_PANEL_SLOT)}?for_tool=${encodeURIComponent("billing-fixture:run_issue")}`,
    )
    const body = (await res.json()) as { data: { panels: Array<{ id: string }> } }
    expect(body.data.panels.map((p) => p.id)).toEqual(["RunPanel"])
    expect(await routePanels(reader, APPROVAL_DETAIL_PANEL_SLOT)).toEqual([])
  })

  test("invoicing contributes its month-end panel to the run's approval card for readers of documents", () => {
    const contribution = (
      invoicingManifest as { contributions?: Record<string, Record<string, unknown>> }
    ).contributions?.[APPROVAL_DETAIL_PANEL_SLOT]
    expect(contribution).toMatchObject({
      component: "MonthEndRunPanel",
      for_tool: "invoicing:recurring_run_issue",
      visibility_scope: "invoicing:documents:read",
    })
  })
})
