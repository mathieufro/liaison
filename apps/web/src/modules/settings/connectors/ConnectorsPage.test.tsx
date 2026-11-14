// SPDX-License-Identifier: FSL-1.1-ALv2
// Connectors page (S11, S16, D12): one card per connector the viewer can
// administer (never an app), one expanded at a time, `?open=<app>` expands it,
// the MCP servers block for kernel:org:admin only.
import { Route, Router } from "@solidjs/router"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createFakeApi, type FakeApi } from "../app-page/__fixtures__/fake-api"
import type { AppSettingsManifest } from "../app-page/types"

const state = vi.hoisted(() => ({ api: null as unknown, scopes: ["*"] as string[] }))
vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => state.api,
  useOptionalApi: () => state.api,
}))
vi.mock("~/modules/auth/auth-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/auth/auth-store")>()
  const has = (s: string) => state.scopes.includes("*") || state.scopes.includes(s)
  return { ...actual, hasScope: has, canAccessScope: (s?: string | null) => !s || has(s) }
})
vi.mock("~/modules/mcp-manager/McpConnectionsList", () => ({
  McpConnectionsList: (p: { onSelect?: (c: { id: string }) => void }) => (
    <button type="button" data-testid="mcp-list-stub" onClick={() => p.onSelect?.({ id: "m1" })}>
      list
    </button>
  ),
}))
vi.mock("~/modules/mcp-manager/McpAddFlow", () => ({
  McpAddFlow: (p: { onDone?: (c: { id: string }) => void }) => (
    <button type="button" data-testid="mcp-add-flow-stub" onClick={() => p.onDone?.({ id: "m2" })}>
      add flow
    </button>
  ),
}))

import { registerAppSettingsPage, resetAppSettingsPages } from "../app-page/app-settings-pages"
import { appsStore } from "../apps-store"
import { ConnectorsPage } from "./ConnectorsPage"

let api: FakeApi

function connector(name: string, displayName: string): AppSettingsManifest {
  return {
    name,
    displayName,
    kind: "connector",
    settings: {
      sections: [
        { id: "connection", title: "Connection", scope: "org", blocks: [{ block: "connections" }] },
      ],
    },
  }
}

function renderPage(search = "") {
  window.history.pushState({}, "", `/settings/connectors${search}`)
  return render(() => (
    <Router>
      <Route path="*" component={() => <ConnectorsPage />} />
    </Router>
  ))
}

beforeEach(() => {
  api = createFakeApi()
  state.api = api
  state.scopes = ["*"]
  appsStore.reset()
  resetAppSettingsPages()
  registerAppSettingsPage({ appId: "gitlab", manifest: connector("gitlab", "GitLab") })
  registerAppSettingsPage({ appId: "database", manifest: connector("database", "Database") })
  registerAppSettingsPage({
    appId: "tickets",
    manifest: {
      name: "tickets",
      kind: "app",
      settings: {
        sections: [
          {
            id: "s",
            title: "S",
            scope: "user",
            blocks: [{ block: "field", key: "a", type: "text", label: "A" }],
          },
        ],
      },
    },
  })
  for (const app of ["gitlab", "database"]) {
    api.on("get", `/apps/${app}/connections`, () => [
      {
        name: app,
        type: "credentials",
        credentialFields: [{ name: "token", label: "Token", type: "password" }],
        accounts: { active: app === "gitlab" ? 1 : 0, error: 0 },
      },
    ])
    api.on("get", `/connections/${app}/${app}/accounts`, () => [])
    api.on("get", `/apps/${app}/settings/org`, () => ({ values: {} }))
  }
})

afterEach(() => resetAppSettingsPages())

describe("ConnectorsPage", () => {
  it("renders one card per connector, never an app", async () => {
    renderPage()
    expect(await screen.findByTestId("connector-card-gitlab")).toBeTruthy()
    expect(screen.getByTestId("connector-card-database")).toBeTruthy()
    expect(screen.queryByTestId("connector-card-tickets")).toBeNull()
  })

  it("says whether each connector is connected", async () => {
    renderPage()
    await waitFor(() =>
      expect(screen.getByTestId("connector-status-gitlab").textContent).toContain("Connected"),
    )
    expect(screen.getByTestId("connector-status-database").textContent).toContain("Not connected")
  })

  // A connection made in the open card (its Connection block reloads the
  // app's connections) turns the card's header to Connected at once, not
  // after a reload of the page.
  it("the header follows a connection made in the card, without a reload", async () => {
    renderPage()
    await waitFor(() =>
      expect(screen.getByTestId("connector-status-database").textContent).toContain(
        "Not connected",
      ),
    )
    // What the card's Connection block does after a connect: reload the app's connections.
    appsStore.setConnections({
      ...appsStore.connections(),
      database: [
        {
          name: "database",
          type: "credentials",
          credentialFields: [{ name: "token", label: "Token", type: "password" }],
          accounts: { active: 1, error: 0 },
        },
      ],
    })
    await waitFor(() =>
      expect(screen.getByTestId("connector-status-database").textContent).toBe("Connected"),
    )
  })

  it("expands the card `?open=` names, and only one at a time", async () => {
    renderPage("?open=gitlab")
    expect(await screen.findByTestId("connector-body-gitlab")).toBeTruthy()
    expect(screen.queryByTestId("connector-body-database")).toBeNull()
    expect(screen.getByTestId("connector-toggle-gitlab").getAttribute("aria-expanded")).toBe("true")
    fireEvent.click(screen.getByTestId("connector-toggle-database"))
    expect(await screen.findByTestId("connector-body-database")).toBeTruthy()
    expect(screen.queryByTestId("connector-body-gitlab")).toBeNull()
    expect(window.location.search).toBe("?open=database")
  })

  it("hides a connector the viewer cannot administer", async () => {
    state.scopes = ["kernel:org:admin"]
    renderPage()
    expect(await screen.findByTestId("connectors-mcp")).toBeTruthy()
    expect(screen.queryByTestId("connector-card-gitlab")).toBeNull()
  })

  it("shows the MCP servers block to kernel:org:admin only", async () => {
    state.scopes = ["kernel:apps:admin"]
    renderPage()
    await screen.findByTestId("connector-card-gitlab")
    expect(screen.queryByTestId("connectors-mcp")).toBeNull()
  })

  it("adds an MCP server with the stepped flow, which ends on the new server's page; Open opens one", async () => {
    renderPage()
    fireEvent.click(await screen.findByTestId("connectors-mcp-add"))
    expect(await screen.findByTestId("mcp-add-flow-stub")).toBeTruthy()
    fireEvent.click(screen.getByTestId("connectors-mcp-back"))
    fireEvent.click(await screen.findByTestId("mcp-list-stub"))
    await waitFor(() => expect(window.location.pathname).toBe("/settings/connectors/mcp/m1"))
  })

  it("a finished add opens the new server's page", async () => {
    renderPage()
    fireEvent.click(await screen.findByTestId("connectors-mcp-add"))
    fireEvent.click(await screen.findByTestId("mcp-add-flow-stub"))
    await waitFor(() => expect(window.location.pathname).toBe("/settings/connectors/mcp/m2"))
  })

  it("Add connector goes to the store filtered to connectors", async () => {
    renderPage()
    fireEvent.click(await screen.findByTestId("connectors-add"))
    await waitFor(() => expect(window.location.pathname).toBe("/settings/store"))
    expect(window.location.search).toBe("?kind=connector")
  })
})
