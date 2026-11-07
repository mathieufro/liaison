// SPDX-License-Identifier: FSL-1.1-ALv2
//
// M1-A T3: the phone Work screen. Its rows ARE the activity-bar registry, so
// an app the user cannot reach must not appear and an installed one must not
// need a code change here.
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  getActivityBarEntries,
  getTabType,
  registerActivityBarEntry,
  registerTabType,
  resetRegistry,
} from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import {
  _resetBranding,
  ensureBrandingLoaded,
  ensureSignedInOrgNameLoaded,
} from "~/modules/shell/branding-store"
import { resetTabStore, tabStore } from "~/modules/shell/tab-store"
import { Work } from "~/modules/shell/Work"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})
vi.stubGlobal("fetch", vi.fn())

// G3 — Work's fixed Approvals row counts off attentionStore.items filtered to
// approval items — the SAME source Home's approvals card counts from — not a
// copy computed here. Mocked so the test drives the exact count rendered
// without booting the real feed poller.
const approvalsState = vi.hoisted(() => ({ items: [] as any[] }))
vi.mock("~/modules/shell/attention-store", () => ({
  attentionStore: {
    get items() {
      return approvalsState.items
    },
    attentionForApp: (app: string) => approvalsState.items.filter((i) => i.app === app),
  },
  // Pull-to-refresh reloads the feed through this; the suite binds none.
  getAttentionApi: () => null,
}))

function registerModule(appId: string, label: string, external?: boolean) {
  registerTabType(`${appId}:home`, {
    component: () => <div>{label}</div>,
    sidebar: null,
    icon: () => null,
    urlPattern: `/${appId}`,
    defaultLabel: label,
    singleton: true,
  })
  registerActivityBarEntry({
    id: appId,
    icon: () => null,
    label,
    order: 10,
    appId,
    external,
    tabAction: { type: `${appId}:home`, entityId: appId, label },
  })
}

const renderWork = () =>
  render(() => (
    <Router>
      <Route path="/*" component={() => <Work />} />
    </Router>
  ))

describe("Work screen", () => {
  beforeEach(() => {
    resetTabStore()
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    approvalsState.items = []
  })
  afterEach(() => cleanup())

  // G3 — Approvals was registered as a phone tab type but reachable only by
  // typing /approvals: no activity-bar entry (by design) and no Work row.
  it("Approvals is the fixed first row, with the pending count from the attention feed", () => {
    approvalsState.items = [
      { id: "a-1", kind: "approval_pending", urgency: 0, action: { type: "decide_approval" } },
      { id: "a-2", kind: "approval_pending", urgency: 0, action: { type: "decide_approval" } },
    ]
    renderWork()
    const rows = [...document.querySelectorAll("[data-testid^='work-row-']")]
    expect(rows[0]?.getAttribute("data-testid")).toBe("work-row-approvals")
    expect(screen.getByTestId("work-row-approvals")).toHaveTextContent("Approvals")
    expect(screen.getByTestId("work-row-count-approvals").textContent).toBe("2")
  })

  // Work counts what Home's card counts: the viewer's own rows, never a row for someone else.
  it("the Approvals count leaves out rows for others, as Home's card does", () => {
    approvalsState.items = [
      { id: "a-1", kind: "approval_pending", urgency: 0, action: { type: "decide_approval" } },
      {
        id: "a-2",
        kind: "approval_pending",
        urgency: 0,
        action: { type: "decide_approval" },
        metadata: { placement: "others", peerSelfApprovable: true },
      },
      {
        id: "a-3",
        kind: "approval_pending",
        urgency: 0,
        action: { type: "decide_approval" },
        metadata: { peerSelfApprovable: true },
      },
    ]
    renderWork()
    expect(screen.getByTestId("work-row-count-approvals").textContent).toBe("2")
  })

  // This root printed "Default Organization": the deployment's PUBLIC branding
  // name, which resolves by Host slug and otherwise answers with the oldest org
  // on the box. The screen never asked for the signed-in one because the read
  // it used needed an api client that is not registered yet at mount.
  it("names the SIGNED IN org under the title, not the deployment's public name", async () => {
    _resetBranding()
    await ensureBrandingLoaded((async () => ({
      ok: true,
      json: async () => ({ data: { orgName: "Default Organization" } }),
    })) as never)
    await ensureSignedInOrgNameLoaded(async () => ({ data: { name: "Resonant Audio Labs" } }))
    renderWork()
    expect(screen.getByTestId("work-title-org").textContent).toBe("Resonant Audio Labs")
    _resetBranding()
  })

  it("no badge when nothing is pending, and tapping opens the approvals tab", () => {
    renderWork()
    expect(screen.queryByTestId("work-row-count-approvals")).toBeNull()
    fireEvent.click(screen.getByTestId("work-row-approvals"))
    const opened = tabStore.tabs.find((tab) => tab.type === "kernel:approvals")
    expect(opened).toBeDefined()
    expect(tabStore.activeTabId).toBe(opened?.id)
  })

  // F3: Work owns its own large title (matching Chats' phone-dock title
  // shape) and hides the phone top bar entirely, instead of the previous
  // layout where the bar's own small "Work" label AND the workspace name
  // both showed above this screen's content.
  it("carries its own large title and hides the phone top bar", () => {
    renderWork()
    expect(screen.getByTestId("work-title").textContent).toBe("Work")
    expect(getTabType("kernel:work")?.hidePhoneTopBar).toBe(true)
  })

  it("offers Show me how (the phone entry to the guided tours) in a bottom sheet", async () => {
    renderWork()
    fireEvent.click(screen.getByTestId("work-row-tours"))
    expect(await screen.findByTestId("tours-sheet")).toBeInTheDocument()
  })

  it("lists a registered module and nothing that is not registered", () => {
    registerModule("tickets", "Tickets")
    renderWork()
    expect(screen.getByTestId("work-row-tickets")).toBeInTheDocument()
    expect(screen.getByText("Tickets")).toBeInTheDocument()
    expect(screen.queryByTestId("work-row-boxtal")).toBeNull()
  })

  it("groups installed app bundles under their own heading, modules above them", () => {
    registerModule("tickets", "Tickets")
    registerModule("boxtal", "Boxtal", true)
    renderWork()

    const modules = screen.getByTestId("work-group-modules")
    const apps = screen.getByTestId("work-group-apps")
    expect(modules.querySelector('[data-testid="work-row-tickets"]')).not.toBeNull()
    expect(apps.querySelector('[data-testid="work-row-boxtal"]')).not.toBeNull()
    expect(modules.querySelector('[data-testid="work-row-boxtal"]')).toBeNull()
    expect(
      modules.compareDocumentPosition(apps) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeGreaterThan(0)
  })

  it("leaves out the surfaces that already own a fixed seat in the phone bar", () => {
    renderWork()
    // Home, Search and Settings are seats, not rows.
    const labels = [...document.querySelectorAll("[data-testid^='work-row-']")].map((row) =>
      row.getAttribute("aria-label"),
    )
    expect(labels).not.toContain("Home")
    expect(labels).not.toContain("Search")
    expect(labels).not.toContain("Settings")
    // ... and Settings IS a registered bar entry, so this is a real exclusion.
    expect(getActivityBarEntries().some((e) => e.label === "Settings")).toBe(true)
  })

  // Final walk F8: the Sessions row read "98" with nothing waiting: it counted
  // every kernel attention item. A row whose entry has its own badge (Sessions:
  // the sessions waiting on you) shows that badge, and nothing at zero.
  it("the Sessions row shows only what waits on you, not the kernel's attention items", () => {
    approvalsState.items = [
      { id: "k-1", app: "kernel", action: { type: "open" } },
      { id: "k-2", app: "kernel", action: { type: "open" } },
    ]
    renderWork()
    const row = screen.getByRole("button", { name: "Sessions" })
    expect(row.querySelector("[data-testid^='work-row-count-']")).toBeNull()
  })

  it("tapping a row opens that app's tab", () => {
    registerModule("tickets", "Tickets")
    renderWork()
    fireEvent.click(screen.getByTestId("work-row-tickets"))
    const opened = tabStore.tabs.find((tab) => tab.type === "tickets:home")
    expect(opened).toBeDefined()
    expect(tabStore.activeTabId).toBe(opened?.id)
  })

  it("rows are 46px with 16px text and uppercase group labels", () => {
    registerModule("tickets", "Tickets")
    renderWork()
    const row = screen.getByTestId("work-row-tickets")
    expect(row.className).toContain("h-[46px]")
    expect(row.className).toContain("text-[16px]")
    const heading = screen.getByTestId("work-group-modules").querySelector("h2") as HTMLElement
    expect(heading.className).toContain("uppercase")
    expect(heading.className).toContain("text-[12px]")
  })
})
