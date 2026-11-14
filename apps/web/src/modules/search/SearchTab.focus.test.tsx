// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  dispatchKeybinding,
  getTabType,
  registerKeybinding,
  resetRegistry,
} from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import SearchTab from "~/modules/search/SearchTab"
import { resetSearchStore } from "~/modules/search/search-store"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { TabVisibilityProvider } from "~/modules/shell/TabVisibilityContext"
import { resetTabStore } from "~/modules/shell/tab-store"

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [], meta: { total: 0, limit: 25, offset: 0 } }), {
          headers: { "Content-Type": "application/json" },
        }),
    ),
  )
}

function renderTab(active: () => boolean = () => true) {
  return render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <ApiProvider>
            <TabVisibilityProvider value={active}>
              <SearchTab entityId="search" />
            </TabVisibilityProvider>
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

describe("SearchTab focus", () => {
  beforeEach(() => {
    resetRegistry()
    resetTabStore()
    resetSearchStore()
    stubFetch()
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("puts the cursor in the search box when the tab opens", async () => {
    renderTab()
    const input = screen.getByTestId("search-input")
    await waitFor(() => expect(document.activeElement).toBe(input))
  })

  it("focuses the search box again each time the hidden tab is shown", async () => {
    const [active, setActive] = createSignal(false)
    renderTab(active)
    const input = screen.getByTestId("search-input")
    await Promise.resolve()
    expect(document.activeElement).not.toBe(input)
    setActive(true)
    await waitFor(() => expect(document.activeElement).toBe(input))
    ;(input as HTMLInputElement).blur()
    setActive(false)
    setActive(true)
    await waitFor(() => expect(document.activeElement).toBe(input))
  })

  it("typing a letter into the search box fires no one-letter shortcut", async () => {
    const newMessage = vi.fn()
    registerKeybinding({ id: "new-message", key: "n", label: "New message", handler: newMessage })
    renderTab()
    const input = screen.getByTestId("search-input")
    await waitFor(() => expect(document.activeElement).toBe(input))
    const typed = new KeyboardEvent("keydown", { key: "n", bubbles: true })
    input.dispatchEvent(typed)
    expect(dispatchKeybinding(typed)).toBeNull()
    expect(newMessage).not.toHaveBeenCalled()

    // The same key outside a field still opens the dialog.
    const outside = new KeyboardEvent("keydown", { key: "n", bubbles: true })
    document.body.dispatchEvent(outside)
    expect(dispatchKeybinding(outside)?.id).toBe("new-message")
    expect(newMessage).toHaveBeenCalledTimes(1)
  })
})

describe("Search tab registration", () => {
  it("has no sidebar, so the page shows one search box", () => {
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    const reg = getTabType("kernel:search")
    expect(reg).toBeDefined()
    expect(reg?.sidebar).toBeNull()
  })
})
