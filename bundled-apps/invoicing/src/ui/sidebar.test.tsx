// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Sidebar smoke tests — bundled-app suites use `bun:test` (no jsdom).
// Full DOM-render assertions live in apps/web's Vitest layer (B10 pattern).
// Here we pin: (a) the component module imports cleanly under the host
// shim used at install time, (b) the Pending-Approval data source is the
// app's own `invoicing:pending_approvals.list` tool (per F1 compliance
// note), and (c) the sidebar's section list matches spec §"Visual
// Structure" so a copy-paste drift in the source file is caught early.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import manifest from "../../app.manifest.json"
import { InvoicingAppIcon } from "./icon"
import { InvoicingSidebar, NEW_DOC_TYPES } from "./sidebar"

const sidebarSource = readFileSync(join(import.meta.dir, "sidebar.tsx"), "utf-8")

describe("InvoicingSidebar (Phase 17 F1)", () => {
  it("exports a Component with no required props", () => {
    expect(typeof InvoicingSidebar).toBe("function")
    expect(InvoicingSidebar.length).toBeLessThanOrEqual(1)
  })

  it("exports the InvoicingAppIcon as a Component", () => {
    expect(typeof InvoicingAppIcon).toBe("function")
  })

  it("declares the focused Views section (Awaiting payment only — no separate customs view)", () => {
    // All-sales / B2B / By-market collapsed into the unified Documents view's
    // Group-by switch; export documents are just invoices with extra fields, so
    // there's no separate customs view either. Only Awaiting payment remains.
    expect(sidebarSource).toContain("Awaiting payment")
    expect(sidebarSource).toContain("Views")
    expect(sidebarSource).not.toContain("All sales")
    expect(sidebarSource).not.toContain("B2B sales")
    expect(sidebarSource).not.toContain("By market")
    // No customs nav link (the route is gone from FOCUSED_VIEWS).
    expect(sidebarSource).not.toContain("dashboards/customs")
  })

  it("declares the Documents-list items and NO Drafts tab (draft is not a user-facing category)", () => {
    expect(sidebarSource).toContain("Invoices")
    expect(sidebarSource).toContain("Quotes")
    expect(sidebarSource).toContain("Proformas")
    expect(sidebarSource).toContain("Purchase Orders")
    expect(sidebarSource).toContain("Credit notes")
    // The Drafts tab is gone: drafts never surface as their own category.
    expect(sidebarSource).not.toContain("/invoicing/documents/drafts")
    expect(sidebarSource).not.toContain('label: "Drafts"')
  })

  it("wires the sidebar search box to the shared document-search signal (no longer a dead input)", () => {
    expect(sidebarSource).toContain("setDocumentSearch")
    expect(sidebarSource).toContain("value={documentSearch()}")
  })

  it("declares the Pending Approval section, and no Settings row (settings live in the Settings app)", () => {
    expect(sidebarSource).toContain("Pending Approval")
    expect(sidebarSource).not.toContain('href="/settings/invoicing"')
    expect(sidebarSource).not.toContain('tr("Settings")')
  })

  it("the footer opens this app's settings page for a viewer who may read them, and is plain text otherwise", () => {
    expect(sidebarSource).toContain('SETTINGS_PATH = "/settings/apps/invoicing"')
    expect(sidebarSource).toContain("onClick={() => navigate(SETTINGS_PATH)}")
    expect(sidebarSource).toContain("when={access().settings_read}")
    expect(sidebarSource).toContain('tr("Invoicing settings")')
  })

  it("the New-document menu offers exactly quote, proforma and purchase order", () => {
    // Invoices come from orders or from converting a quote/proforma; credit
    // notes come from refunds. Neither can be started by hand.
    expect(NEW_DOC_TYPES).toEqual(["quote", "proforma", "purchase_order"])
    expect(sidebarSource).toContain("New quote")
    expect(sidebarSource).toContain("New proforma")
    expect(sidebarSource).toContain("New purchase order")
    expect(sidebarSource).not.toContain("New invoice")
    expect(sidebarSource).not.toContain("New credit note")
  })

  it("defaults the New-document CTA to quote", () => {
    expect(sidebarSource).toMatch(/createSignal<NewDocType>\("quote"\)/)
  })

  it("encodes the doc type IN the entityId segment (new:<type>), not a ?type= query param", () => {
    // The kernel's tab router only forwards the `entityId` path segment to a
    // tab's component — a `?type=` query string is silently dropped, and
    // InvoicingEditor previously read `window.location.search` directly,
    // which breaks under keep-alive tab rendering (reads whichever tab is
    // current in the address bar, not the tab actually being opened).
    expect(sidebarSource).toContain("/invoicing/editor/new:${t}")
    expect(sidebarSource).toContain("/invoicing/editor/new:${type()}")
    expect(sidebarSource).not.toContain("editor/new?type=")
  })

  it("hides Deferred section when count is zero (sticky-only when > 0)", () => {
    // Source-grep invariant: the Deferred row is gated on a positive count.
    // We accept any reasonable predicate shape (`deferredCount() > 0`,
    // `> 0 &&`, etc.) so this catches the unconditional-render regression
    // without over-pinning the implementation shape.
    expect(sidebarSource).toMatch(/Deferred/)
    expect(sidebarSource).toMatch(
      /deferred[A-Z][a-zA-Z]*\s*\(\s*\)\s*>\s*0|deferred[A-Z][a-zA-Z]*\s*>\s*0/,
    )
  })

  it("loads Pending-Approval count via the app's own pending_approvals.list tool (F1 compliance note)", () => {
    // The sidebar's data loader must read from
    // `invoicing:pending_approvals.list` (the same tool the agent calls),
    // not from a kernel approvals service directly. This keeps the
    // operator-visible count consistent with the agent-visible count.
    expect(sidebarSource).toContain("pending_approvals_list")
  })

  it("documents the Pending-Approval data source in the loader docstring", () => {
    expect(sidebarSource).toMatch(/pending[_-]?approvals?\.list[\s\S]{0,400}(invoicing:%|sidebar)/i)
  })

  it("manifest declares views.activityBar with InvoicingAppIcon + label Invoicing", () => {
    const m = manifest as unknown as {
      views?: {
        activityBar?: { icon?: string; label?: string; order?: number; tabAction?: unknown }
      }
    }
    expect(m.views?.activityBar?.icon).toBe("InvoicingAppIcon")
    expect(m.views?.activityBar?.label).toBe("Invoicing")
    expect(typeof m.views?.activityBar?.order).toBe("number")
    expect(m.views?.activityBar?.tabAction).toBeDefined()
  })

  it("manifest declares views.tabTypes for home, dashboard, documents, and none for settings", () => {
    const m = manifest as unknown as {
      views?: { tabTypes?: Record<string, { component?: string; sidebar?: string }> }
    }
    const tabTypes = m.views?.tabTypes ?? {}
    expect(tabTypes.home).toBeDefined()
    expect(tabTypes.dashboard).toBeDefined()
    expect(tabTypes.documents).toBeDefined()
    // /settings/invoicing is an old path of the Settings app page (manifest `settings`), not an
    // app tab: a tab type on the same path would open it outside Settings.
    expect(tabTypes.settings).toBeUndefined()
    expect(
      Object.values(tabTypes).some(
        (t) => (t as { urlPattern?: string }).urlPattern === "/settings/invoicing",
      ),
    ).toBe(false)
    // every tabType must mount the InvoicingSidebar
    for (const [, def] of Object.entries(tabTypes)) {
      expect(def.sidebar).toBe("InvoicingSidebar")
    }
  })

  it("links the e-invoicing readiness tab from the Admin section", () => {
    expect(sidebarSource).toContain('href="/invoicing/readiness"')
    expect(sidebarSource).toContain('tr("E-invoicing readiness")')
  })

  it("puts a Recurring group with Schedules and its count before Views, and the three recurring tabs exist", () => {
    const recurring = sidebarSource.indexOf('label={tr("Recurring")}')
    const views = sidebarSource.indexOf('label={tr("Views")}')
    expect(recurring).toBeGreaterThan(-1)
    expect(recurring).toBeLessThan(views)
    expect(sidebarSource).toContain('{ href: "/invoicing/recurring", label: "Schedules" }')
    expect(sidebarSource).toContain("badge={scheduleCount()}")
    // The count is the app's own list, the same the agent reads.
    expect(sidebarSource).toContain('"recurring_list"')
    const tabs = (manifest as any).views.tabTypes
    expect(tabs.recurring).toMatchObject({
      component: "InvoicingRecurringList",
      urlPattern: "/invoicing/recurring",
      singleton: true,
    })
    expect(tabs.schedule).toMatchObject({
      component: "InvoicingScheduleEditor",
      urlPattern: "/invoicing/schedule/:scheduleId",
    })
    expect(tabs.recurring_run).toMatchObject({
      entity: "recurring_run",
      component: "InvoicingRunDetail",
      urlPattern: "/invoicing/run/:runId",
    })
  })
})
