// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { slotRegistry } from "~/modules/apps/app-registries"
import { forgetOrgApps, rememberOrgAppStates } from "~/modules/apps/org-apps"
import { listSlotPanels, registerAppSlots } from "./registry"

describe("slot registry — listSlotPanels (B9)", () => {
  const ORG = "org-slots-1"
  const OTHER = "org-slots-2"

  beforeEach(() => {
    slotRegistry.deleteByPrefix([ORG])
    slotRegistry.deleteByPrefix([OTHER])
  })
  afterEach(() => {
    slotRegistry.deleteByPrefix([ORG])
    slotRegistry.deleteByPrefix([OTHER])
  })

  test("an app the org admin hid contributes no panel, top level or nested (S14)", () => {
    slotRegistry.set([ORG, "invoicing", "contact_detail"], {
      panels: [
        { id: "invoicing-documents", label: "Documents", component: "ContactDocumentsPanel" },
      ],
    })
    slotRegistry.set([ORG, "shopify", "contact_detail"], {
      panels: [{ id: "shopify-orders", label: "Orders", component: "ContactOrdersPanel" }],
    })
    slotRegistry.set([ORG, "boxtal", "invoicing"], {
      document_detail: { tabs: [{ id: "boxtal-shipping", label: "Shipping", component: "Tab" }] },
    })
    rememberOrgAppStates(ORG, [
      { app: "invoicing", status: "disabled" },
      { app: "boxtal", status: "removed" },
    ])
    try {
      const top = listSlotPanels({ orgId: ORG, scopes: ["*"], slot: "contact_detail" })
      expect(top.map((p) => p.app)).toEqual(["shopify"])
      expect(
        listSlotPanels({ orgId: ORG, scopes: ["*"], slot: "invoicing.document_detail.tabs" }),
      ).toEqual([])
      // Another org is not affected by this org's setting.
      slotRegistry.set([OTHER, "invoicing", "contact_detail"], {
        panels: [{ id: "invoicing-documents", label: "Documents", component: "C" }],
      })
      expect(listSlotPanels({ orgId: OTHER, scopes: ["*"], slot: "contact_detail" })).toHaveLength(
        1,
      )
    } finally {
      forgetOrgApps(ORG)
    }
  })

  test("re-registering an app replaces its contributions: each panel once, a dropped one gone", () => {
    registerAppSlots(ORG, "crm", undefined, {
      "ticket:detail:panel": { label: "Customer", component: "CustomerCard" },
      "mail:conversation:banner": { label: "Banner", component: "CrmBanner" },
    })
    // The next version keeps the card and drops the banner.
    registerAppSlots(ORG, "crm", undefined, {
      "ticket:detail:panel": { label: "Customer", component: "CustomerCard" },
    })
    const ticket = listSlotPanels({ orgId: ORG, scopes: ["*"], slot: "ticket:detail:panel" })
    expect(ticket.map((p) => p.id)).toEqual(["CustomerCard"])
    // A slot the app also declares in `slots` keeps those panels and gains the contribution once.
    registerAppSlots(
      ORG,
      "crm",
      { contact_detail: { panels: [{ id: "crm-own", label: "Own", component: "Own" }] } },
      { contact_detail: { label: "Card", component: "CrmContact" } },
    )
    registerAppSlots(
      ORG,
      "crm",
      { contact_detail: { panels: [{ id: "crm-own", label: "Own", component: "Own" }] } },
      { contact_detail: { label: "Card", component: "CrmContact" } },
    )
    expect(
      listSlotPanels({ orgId: ORG, scopes: ["*"], slot: "contact_detail" }).map((p) => p.id),
    ).toEqual(["crm-own", "CrmContact"])
  })

  test("a person the app is restricted away from gets none of its panels; a person allowed does", () => {
    slotRegistry.set([ORG, "crm", "ticket:detail:panel"], {
      panels: [{ id: "CustomerCard", label: "Customer", component: "CustomerCard" }],
    })
    slotRegistry.set([ORG, "crm", "invoicing"], {
      document_detail: { tabs: [{ id: "crm-tab", label: "CRM", component: "Tab" }] },
    })
    rememberOrgAppStates(ORG, [
      { app: "crm", status: "active", accessMode: "restricted", allowedUserIds: new Set(["u-in"]) },
    ])
    try {
      const of = (userId: string | null, slot: string) =>
        listSlotPanels({ orgId: ORG, scopes: ["*"], slot, userId }).map((p) => p.id)
      expect(of("u-out", "ticket:detail:panel")).toEqual([])
      expect(of("u-out", "invoicing.document_detail.tabs")).toEqual([])
      expect(of(null, "ticket:detail:panel")).toEqual([])
      expect(of("u-in", "ticket:detail:panel")).toEqual(["CustomerCard"])
      expect(of("u-in", "invoicing.document_detail.tabs")).toEqual(["crm-tab"])
    } finally {
      forgetOrgApps(ORG)
    }
  })

  test("enumerates contact_detail panels contributed by all installed apps in the org", () => {
    slotRegistry.set([ORG, "invoicing", "contact_detail"], {
      panels: [
        {
          id: "invoicing-documents",
          label: "Documents",
          component: "ContactDocumentsPanel",
          visibility_scope: "invoicing:documents:read",
        },
      ],
    })
    slotRegistry.set([ORG, "shopify", "contact_detail"], {
      panels: [
        {
          id: "shopify-orders",
          label: "Orders",
          component: "ContactOrdersPanel",
          visibility_scope: "shopify:orders:read",
        },
      ],
    })

    const panels = listSlotPanels({
      orgId: ORG,
      scopes: ["*"],
      slot: "contact_detail",
    })

    expect(panels).toHaveLength(2)
    expect(panels).toContainEqual(
      expect.objectContaining({
        id: "invoicing-documents",
        app: "invoicing",
        label: "Documents",
      }),
    )
    expect(panels).toContainEqual(
      expect.objectContaining({
        id: "shopify-orders",
        app: "shopify",
        label: "Orders",
      }),
    )
  })

  test("hides panels whose visibility_scope the user lacks", () => {
    slotRegistry.set([ORG, "invoicing", "contact_detail"], {
      panels: [
        {
          id: "invoicing-documents",
          label: "Documents",
          component: "ContactDocumentsPanel",
          visibility_scope: "invoicing:documents:read",
        },
      ],
    })
    slotRegistry.set([ORG, "shopify", "contact_detail"], {
      panels: [
        {
          id: "shopify-orders",
          label: "Orders",
          component: "ContactOrdersPanel",
          visibility_scope: "shopify:orders:read",
        },
      ],
    })

    // User only has the invoicing scope.
    const panels = listSlotPanels({
      orgId: ORG,
      scopes: ["invoicing:documents:read"],
      slot: "contact_detail",
    })

    expect(panels.map((p) => p.id)).toEqual(["invoicing-documents"])
  })

  test("returns empty array when no apps contribute the slot", () => {
    const panels = listSlotPanels({
      orgId: ORG,
      scopes: ["*"],
      slot: "contact_detail",
    })
    expect(panels).toEqual([])
  })

  test("never returns panels from other orgs (cross-tenant isolation)", () => {
    slotRegistry.set([OTHER, "invoicing", "contact_detail"], {
      panels: [
        {
          id: "leak",
          label: "Leak",
          component: "X",
          visibility_scope: "invoicing:documents:read",
        },
      ],
    })

    const panels = listSlotPanels({
      orgId: ORG,
      scopes: ["*"],
      slot: "contact_detail",
    })
    expect(panels).toEqual([])
  })

  test("panels without visibility_scope are visible to everyone", () => {
    slotRegistry.set([ORG, "invoicing", "contact_detail"], {
      panels: [{ id: "public-panel", label: "Public", component: "P" }],
    })

    const panels = listSlotPanels({
      orgId: ORG,
      scopes: [],
      slot: "contact_detail",
    })
    expect(panels.map((p) => p.id)).toEqual(["public-panel"])
  })

  test("respects panel.order when sorting (lower first)", () => {
    slotRegistry.set([ORG, "invoicing", "contact_detail"], {
      panels: [
        { id: "second", label: "Second", component: "S", order: 20 },
        { id: "first", label: "First", component: "F", order: 10 },
      ],
    })

    const panels = listSlotPanels({
      orgId: ORG,
      scopes: ["*"],
      slot: "contact_detail",
    })
    expect(panels.map((p) => p.id)).toEqual(["first", "second"])
  })

  // — K1a: nested `<host>.<slot_id>.tabs` enumeration (Phase 18) —

  test("enumerates nested invoicing.document_detail.tabs contributed by other apps", () => {
    slotRegistry.set([ORG, "invoicing", "invoicing"], {
      document_detail: {
        tabs: [{ id: "overview", label: "Overview", component: "OverviewTab", order: 10 }],
      },
    })
    slotRegistry.set([ORG, "boxtal", "invoicing"], {
      document_detail: {
        tabs: [{ id: "shipment", label: "Shipment", component: "BoxtalShipmentTab", order: 25 }],
      },
    })
    const tabs = listSlotPanels({
      orgId: ORG,
      scopes: ["*"],
      slot: "invoicing.document_detail.tabs",
    })
    expect(tabs.map((t) => t.id)).toEqual(["overview", "shipment"])
    const shipment = tabs.find((t) => t.id === "shipment")!
    expect(shipment.component).toBe("BoxtalShipmentTab")
    expect(shipment.app).toBe("boxtal")
    expect(shipment.order).toBe(25)
  })

  test("nested tabs are cross-org isolated", () => {
    slotRegistry.set([OTHER, "boxtal", "invoicing"], {
      document_detail: {
        tabs: [{ id: "shipment", label: "Shipment", component: "BoxtalShipmentTab", order: 25 }],
      },
    })
    expect(
      listSlotPanels({ orgId: ORG, scopes: ["*"], slot: "invoicing.document_detail.tabs" }),
    ).toEqual([])
  })

  test("nested tabs honor visibility_scope filtering", () => {
    slotRegistry.set([ORG, "boxtal", "invoicing"], {
      document_detail: {
        tabs: [
          {
            id: "shipment",
            label: "Shipment",
            component: "BoxtalShipmentTab",
            order: 25,
            visibility_scope: "boxtal:shipments:read",
          },
        ],
      },
    })
    expect(
      listSlotPanels({
        orgId: ORG,
        scopes: ["other:scope"],
        slot: "invoicing.document_detail.tabs",
      }),
    ).toEqual([])
    const granted = listSlotPanels({
      orgId: ORG,
      scopes: ["boxtal:shipments:read"],
      slot: "invoicing.document_detail.tabs",
    })
    expect(granted.map((t) => t.id)).toEqual(["shipment"])
  })

  test("a nested-slot request with no matching entry → [] (not a throw)", () => {
    expect(
      listSlotPanels({ orgId: ORG, scopes: ["*"], slot: "invoicing.document_detail.tabs" }),
    ).toEqual([])
  })

  test("a malformed slot string (two-part / four-part) → [] gracefully", () => {
    slotRegistry.set([ORG, "boxtal", "invoicing"], {
      document_detail: {
        tabs: [{ id: "shipment", label: "Shipment", component: "BoxtalShipmentTab", order: 25 }],
      },
    })
    expect(listSlotPanels({ orgId: ORG, scopes: ["*"], slot: "a.b" })).toEqual([])
    expect(listSlotPanels({ orgId: ORG, scopes: ["*"], slot: "a.b.c.d" })).toEqual([])
  })
})
