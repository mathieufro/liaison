// SPDX-License-Identifier: FSL-1.1-ALv2
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Route, Router } from "@solidjs/router"
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  getActivityBarEntries,
  registerActivityBarEntry,
  resetRegistry,
  resolveRegisteredTabType,
} from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { setUnavailableApps } from "~/framework/unavailable-apps"
import { installFakeBridge, uninstallFakeBridge } from "~/modules/desktop/fake-bridge"
import { ActivityBar } from "~/modules/shell/ActivityBar"
import { appIconColor } from "~/modules/shell/app-color"
import { attentionStore } from "~/modules/shell/attention-store"
import { makeTabId, openTab, tabStore } from "~/modules/shell/tab-store"
import { closeTabletSidebar, tabletSidebarOpen } from "~/modules/shell/tablet-sidebar-store"
import { WsProvider } from "~/modules/shell/WsContext"

const [mockWsStatus] = createSignal<"connected" | "disconnected">("connected")
const mockWsSend = vi.fn()

function TestWrapper(props: { children: any }) {
  return (
    <WsProvider send={mockWsSend} status={mockWsStatus}>
      {props.children}
    </WsProvider>
  )
}

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

describe("ActivityBar", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn())
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("activity-bar.overflow draws every app while the column is unmeasured", () => {
    // With 15 apps installed the rail was one clipped column: on a laptop the
    // entries past the viewport's height (Projects among them) were cut off
    // with no way to reach them (2026-09-30). The column now draws what fits
    // and ends on a "+N" control (ActivityBar.overflow.test.tsx); with no
    // height to go on it hides nothing.
    render(() => (
      <Router>
        <Route
          path="*"
          component={() => (
            <TestWrapper>
              <ActivityBar />
            </TestWrapper>
          )}
        />
      </Router>
    ))
    const column = screen.getByTestId("activity-bar-apps")
    expect(screen.queryByTestId("activity-bar-more")).toBeNull()
    const top = getActivityBarEntries().filter((e) => e.position !== "bottom")
    expect(top.length).toBeGreaterThan(0)
    for (const entry of top) {
      expect(column.contains(screen.getByLabelText(entry.label))).toBe(true)
    }
  })

  it("activity-bar.icon carries the app's own colour, not one grey for all", () => {
    // A rail of a dozen identical monochrome glyphs is read label by label.
    // The phone Work list already coloured its squares per app; the rail, the
    // tablet rail and the tab strip drew everything in text-tertiary.
    render(() => (
      <Router>
        <Route
          path="*"
          component={() => (
            <TestWrapper>
              <ActivityBar />
            </TestWrapper>
          )}
        />
      </Router>
    ))
    const entries = getActivityBarEntries()
    const home = entries.find((e) => e.label === "Home")
    expect(home).toBeDefined()
    const glyph = screen.getByLabelText("Home").querySelector<HTMLElement>("[data-app-glyph]")
    expect(glyph).not.toBeNull()
    // jsdom re-serialises colours, so compare through the same parser.
    const asRendered = (css: string): string => {
      const probe = document.createElement("span")
      probe.style.color = css
      return probe.style.color
    }
    expect(glyph!.style.color).toBe(asRendered(appIconColor(home!.appId)))
    expect(glyph!.style.color).not.toBe("")
    // Two apps do not share the rail's one grey.
    const other = entries.find((e) => e.appId !== home!.appId)
    if (other) {
      const otherGlyph = screen
        .getByLabelText(other.label)
        .querySelector<HTMLElement>("[data-app-glyph]")
      expect(otherGlyph!.style.color).not.toBe(glyph!.style.color)
    }
  })

  it("renders home icon", () => {
    render(() => (
      <Router>
        <Route
          path="*"
          component={() => (
            <TestWrapper>
              <ActivityBar />
            </TestWrapper>
          )}
        />
      </Router>
    ))
    expect(screen.getByLabelText("Home")).toBeInTheDocument()
  })

  it("renders settings icon at bottom", () => {
    render(() => (
      <Router>
        <Route
          path="*"
          component={() => (
            <TestWrapper>
              <ActivityBar />
            </TestWrapper>
          )}
        />
      </Router>
    ))
    expect(screen.getByLabelText("Settings")).toBeInTheDocument()
  })

  it("the activity bar shows Agents in place of the agent app", () => {
    render(() => (
      <Router>
        <Route
          path="*"
          component={() => (
            <TestWrapper>
              <ActivityBar />
            </TestWrapper>
          )}
        />
      </Router>
    ))
    expect(screen.getByLabelText("Agents")).toBeInTheDocument()
    expect(screen.queryByLabelText("Agent")).toBeNull()
  })

  it("renders logout button", () => {
    render(() => (
      <Router>
        <Route
          path="*"
          component={() => (
            <TestWrapper>
              <ActivityBar />
            </TestWrapper>
          )}
        />
      </Router>
    ))
    expect(screen.getByLabelText("Log out")).toBeInTheDocument()
  })
})

describe("ActivityBar — tab integration", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn())
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("clicking Home activates the Home tab", () => {
    openTab({ type: "thread", entityId: "t1", label: "Thread" })

    render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <TestWrapper>
              <ActivityBar />
            </TestWrapper>
          )}
        />
      </Router>
    ))

    const homeBtn = screen.getByLabelText("Home")
    fireEvent.click(homeBtn)
    expect(tabStore.activeTabId).toBe(makeTabId("kernel:home", "home"))
  })

  it("activity-bar.attention-dot renders for non-kernel entry with items", () => {
    const TicketsIcon = () => null
    registerActivityBarEntry({
      id: "tickets",
      icon: TicketsIcon,
      label: "Tickets",
      order: 10,
      appId: "tickets",
      tabAction: { type: "tickets:inbox", entityId: "tickets-inbox", label: "Tickets" },
    })
    attentionStore._setForTest({
      items: [
        {
          id: "tickets:sla:t1",
          app: "tickets",
          entity: "ticket",
          entityId: "t1",
          kind: "sla_risk",
          summary: "x",
          urgency: 70,
          occurredAt: "2026-05-06T00:00:00Z",
          action: { type: "open_entity", tabType: "tickets:ticket", entityId: "t1" },
        },
      ],
      errors: [],
    })

    render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <TestWrapper>
              <ActivityBar />
            </TestWrapper>
          )}
        />
      </Router>
    ))

    expect(screen.getByTestId("activity-bar-attention-tickets")).toBeInTheDocument()
    attentionStore._setForTest({ items: [], errors: [] })
  })

  it("clicking Settings opens a Settings tab", () => {
    render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <TestWrapper>
              <ActivityBar />
            </TestWrapper>
          )}
        />
      </Router>
    ))

    const settingsBtn = screen.getByLabelText("Settings")
    fireEvent.click(settingsBtn)
    expect(tabStore.tabs.find((t) => t.type === resolveRegisteredTabType("settings"))).toBeTruthy()
  })

  it("activity-bar tabs open permanent (not ephemeral previews)", () => {
    // Deliberate app navigation anchors the app home — opening an entity from
    // inside the app must not replace it under the one-preview-tab policy.
    render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <TestWrapper>
              <ActivityBar />
            </TestWrapper>
          )}
        />
      </Router>
    ))

    fireEvent.click(screen.getByLabelText("Settings"))
    const settingsTab = tabStore.tabs.find((t) => t.type === resolveRegisteredTabType("settings"))
    expect(settingsTab?.isPreview).toBe(false)

    // A subsequent ephemeral preview must not evict the activity-bar tab.
    openTab({ type: "thread", entityId: "t-preview", label: "Glance" })
    expect(tabStore.tabs.find((t) => t.type === resolveRegisteredTabType("settings"))).toBeTruthy()
  })
})

describe("ActivityBar - tablet sidebar toggle", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn())
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    closeTabletSidebar()
  })
  afterEach(() => {
    closeTabletSidebar()
    vi.restoreAllMocks()
  })

  const renderBar = (tier: "desktop" | "tablet" | "phone") =>
    render(() => (
      <Router>
        <Route
          path="*"
          component={() => (
            <TestWrapper>
              <ActivityBar tier={tier} />
            </TestWrapper>
          )}
        />
      </Router>
    ))

  it("renders the sidebar toggle at tablet tier", () => {
    renderBar("tablet")
    expect(screen.getByTestId("activity-sidebar-toggle")).toBeInTheDocument()
  })

  it("hides the sidebar toggle at desktop tier", () => {
    renderBar("desktop")
    expect(screen.queryByTestId("activity-sidebar-toggle")).not.toBeInTheDocument()
  })

  it("clicking the toggle flips tabletSidebarOpen from false to true", () => {
    renderBar("tablet")
    expect(tabletSidebarOpen()).toBe(false)
    fireEvent.click(screen.getByTestId("activity-sidebar-toggle"))
    expect(tabletSidebarOpen()).toBe(true)
  })
})

describe("ActivityBar - touch tiers", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn())
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // The phone bottom bar is no longer this component: it is PhoneTabBar's five
  // fixed seats (see PhoneTabBar.test.tsx). What is left here is the rail, and
  // the tablet rail is the only touch-sized one.
  it("the tablet rail sizes its controls for touch", () => {
    render(() => (
      <Router>
        <Route
          path="*"
          component={() => (
            <TestWrapper>
              <ActivityBar tier="tablet" />
            </TestWrapper>
          )}
        />
      </Router>
    ))
    const buttons = screen.getByTestId("activity-bar").querySelectorAll("button")
    expect(buttons.length).toBeGreaterThan(0)
    for (const button of buttons) {
      expect(button.classList.contains("min-h-11")).toBe(true)
      expect(button.classList.contains("min-w-11")).toBe(true)
    }
  })

  it("the desktop rail keeps its pointer density", () => {
    render(() => (
      <Router>
        <Route
          path="*"
          component={() => (
            <TestWrapper>
              <ActivityBar tier="desktop" />
            </TestWrapper>
          )}
        />
      </Router>
    ))
    const button = screen.getByTestId("activity-bar").querySelector("button") as HTMLElement
    expect(button.classList.contains("h-[34px]")).toBe(true)
  })

  it("renders a vertical rail, never a bottom row", () => {
    render(() => (
      <Router>
        <Route
          path="*"
          component={() => (
            <TestWrapper>
              <ActivityBar tier="desktop" />
            </TestWrapper>
          )}
        />
      </Router>
    ))
    const bar = screen.getByTestId("activity-bar")
    expect(bar.classList.contains("flex-col")).toBe(true)
    expect(bar.classList.contains("border-r")).toBe(true)
    // The overflow sheet went with the bar layout.
    expect(screen.queryByTestId("activity-more")).toBeNull()
  })

  describe("the desktop app offer", () => {
    const renderBar = () =>
      render(() => (
        <Router>
          <Route
            path="*"
            component={() => (
              <TestWrapper>
                <ActivityBar />
              </TestWrapper>
            )}
          />
        </Router>
      ))

    afterEach(() => {
      delete (globalThis as Record<string, unknown>).__LIAISON_SERVER_ADDRESS__
      vi.unstubAllGlobals()
    })

    it("sits directly below Settings in a browser", () => {
      renderBar()
      const settings = screen.getByLabelText("Settings")
      const offer = screen.getByTestId("activity-desktop-app")
      expect(offer.getAttribute("aria-label")).toBe("Get the desktop app")
      const buttons = [
        ...screen.getByTestId("activity-bar").querySelectorAll("button"),
      ] as HTMLElement[]
      expect(buttons.indexOf(offer)).toBe(buttons.indexOf(settings) + 1)
    })

    it("opens onto four real links, the visitor's own system first", async () => {
      vi.stubGlobal("navigator", {
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0",
        platform: "Win32",
        maxTouchPoints: 0,
      })
      renderBar()
      const offer = screen.getByTestId("activity-desktop-app")
      fireEvent.pointerDown(offer, { button: 0, pointerType: "mouse" })
      fireEvent.click(offer)
      const menu = await screen.findByTestId("desktop-app-menu")
      const links = [...menu.querySelectorAll("a")]
      expect(links.map((a) => a.getAttribute("href"))).toEqual([
        "https://downloads.liaison.sh/desktop/latest/Liaison-windows-setup.exe",
        "https://downloads.liaison.sh/desktop/latest/Liaison-macos.dmg",
        "https://downloads.liaison.sh/desktop/latest/Liaison-linux.AppImage",
        "https://downloads.liaison.sh/desktop/latest/Liaison-linux.deb",
      ])
      for (const link of links) expect(link.hasAttribute("download")).toBe(true)
      // A row that swallows its own click is four inert labels: the browser
      // must be left to follow the link, by pointer and by Space alike.
      const followed: boolean[] = []
      const first = links[0] as HTMLAnchorElement
      first.addEventListener("click", (event) => {
        followed.push(!event.defaultPrevented)
        event.preventDefault() // jsdom cannot navigate; the check is above
      })
      fireEvent.keyDown(first, { key: " " })
      expect(followed).toEqual([true])
      expect(links[0]?.textContent).toContain("Recommended for this computer")
      expect(links[1]?.textContent).not.toContain("Recommended")
    })

    it("is absent inside a shell, where the app is already installed", () => {
      ;(globalThis as Record<string, unknown>).__LIAISON_SERVER_ADDRESS__ =
        "https://liaison.example.com"
      renderBar()
      expect(screen.getByLabelText("Settings")).toBeInTheDocument()
      expect(screen.queryByTestId("activity-desktop-app")).toBeNull()
    })
  })

  // Windows and Linux have no menu bar, and the shell no longer draws a menu
  // strip in the window: the server switcher is the sidebar's own.
  describe("the desktop server switcher", () => {
    const renderBar = () =>
      render(() => (
        <Router>
          <Route
            path="*"
            component={() => (
              <TestWrapper>
                <ActivityBar />
              </TestWrapper>
            )}
          />
        </Router>
      ))

    afterEach(() => uninstallFakeBridge())

    it("sits just above Log out when the desktop shell publishes servers", () => {
      installFakeBridge(
        {},
        {
          platform: "windows",
          servers: {
            list: async () => ({ current: null, servers: [] }),
            add: async () => {},
            switchTo: async () => {},
            remove: async () => {},
            signOut: async () => {},
            beginAdd: () => {},
            confirmsRemoval: true,
          },
        },
      )
      renderBar()
      const switcher = screen.getByTestId("activity-servers")
      const buttons = [
        ...screen.getByTestId("activity-bar").querySelectorAll("button"),
      ] as HTMLElement[]
      expect(buttons.indexOf(screen.getByTestId("activity-log-out"))).toBe(
        buttons.indexOf(switcher) + 1,
      )
    })

    it("is not there in a browser", () => {
      renderBar()
      expect(screen.queryByTestId("activity-servers")).toBeNull()
    })
  })
})

describe("the rail's order", () => {
  // The in-tree apps' own manifests, read as they ship: the order is theirs to declare.
  const manifestRail = (app: string) => {
    // Tests run from apps/web.
    const path = join(process.cwd(), "..", "api", "src", "apps", app, "app.manifest.json")
    const manifest = JSON.parse(readFileSync(path, "utf8")) as {
      views: { activityBar: { label: string; order: number } }
    }
    return manifest.views.activityBar
  }
  const seat = (appId: string, label: string, order: number) =>
    registerActivityBarEntry({
      id: appId,
      icon: () => null,
      label,
      order,
      appId,
      position: "top",
      tabAction: { type: `${appId}:home`, entityId: appId, label },
    })
  const railIds = () =>
    getActivityBarEntries()
      .filter((e) => e.position !== "bottom")
      .sort((a, b) => a.order - b.order)
      .map((e) => e.id)

  beforeEach(() => {
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    setUnavailableApps([])
    for (const app of ["contacts", "projects", "calendar", "tickets", "knowledge", "mail"]) {
      seat(app, manifestRail(app).label, manifestRail(app).order)
    }
  })
  afterEach(() => setUnavailableApps([]))

  it("order by manifest, a new app gets a seat by declaration, an Off app none", () => {
    const fixed = ["home", "messages", "search", "mail", "knowledge", "tickets"]
    const middle = ["calendar", "projects", "contacts"]
    let ids = railIds()
    const at = (id: string) => ids.indexOf(id)
    for (const [a, b] of [...fixed, ...middle]
      .slice(1)
      .map((id, i) => [[...fixed, ...middle][i], id])) {
      expect(at(a!)).toBeLessThan(at(b!))
    }
    // Terminal closes the rail.
    expect(ids[ids.length - 1]).toBe("sessions")

    // A world's app is seated by its own declaration, after Contacts and before Terminal.
    seat("studio", "Studio", 62)
    ids = railIds()
    expect(ids.indexOf("studio")).toBeGreaterThan(ids.indexOf("contacts"))
    expect(ids.indexOf("studio")).toBeLessThan(ids.indexOf("sessions"))

    // An app that is Off has no seat.
    setUnavailableApps(["studio"])
    expect(railIds()).not.toContain("studio")
  })
})
