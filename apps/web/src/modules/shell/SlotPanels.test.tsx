// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { ErrorBoundary } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  registerContribution,
  resetRegistry,
  unregisterContributions,
} from "~/framework/app-registry"
import { type AppManifest, registerAppFromManifest, unregisterApp } from "~/framework/define-app"
import { setTokens } from "~/modules/auth/auth-store"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { SlotPanels, type SlotPosition } from "~/modules/shell/SlotPanels"
import { mockApiClient } from "~/tests/helpers/mock-api"
import exampleManifest from "../../../../api/test-support/apps/example/app.manifest.json"

function makeJwt(): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = btoa(
    JSON.stringify({
      userId: "u1",
      orgId: "o1",
      name: "U",
      roles: ["admin"],
      scopes: ["*"],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  )
  return `${header}.${body}.fake`
}

function renderSlotPanels(slot: string, entityId?: string, position?: SlotPosition) {
  return render(() => (
    <Router>
      <Route
        path="*"
        component={() => (
          <ApiProvider>
            {/* The host page's own boundary: a slot that throws would replace the page. */}
            <ErrorBoundary fallback={<div data-testid="host-crashed" />}>
              <div data-testid="host-page">
                <SlotPanels slot={slot} entityId={entityId} position={position} />
                <button type="button" data-testid="host-action">
                  Host
                </button>
              </div>
            </ErrorBoundary>
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

// The host each slot sits on and how it draws it (TaskDetail, ProjectWorkspace,
// ContactDetail, TicketDetail).
const SIX_SLOTS: Array<[string, SlotPosition]> = [
  ["project:task:tabs", "tabs"],
  ["project:task:actions", "actions"],
  ["project:detail:panel", "panel"],
  ["contact_detail", "panel"],
  ["ticket:detail:panel", "panel"],
  ["ticket:detail:actions", "actions"],
]

type ManifestSlotEntry = { id: string; label: string; component: string }

/** The example app's slot entries, as its manifest declares them. */
function exampleSlotEntries(): Record<string, ManifestSlotEntry[]> {
  const out: Record<string, ManifestSlotEntry[]> = {}
  for (const [slot, def] of Object.entries(
    exampleManifest.slots as Record<
      string,
      { panels?: ManifestSlotEntry[]; actions?: ManifestSlotEntry[] }
    >,
  )) {
    out[slot] = [...(def.panels ?? []), ...(def.actions ?? [])]
  }
  return out
}

describe("SlotPanels (B10)", () => {
  beforeEach(() => {
    setTokens(makeJwt(), "refresh")
    resetRegistry()
  })
  afterEach(() => {
    unregisterContributions("invoicing")
    unregisterContributions("ghost-app")
    unregisterContributions("fixture-app")
    unregisterApp("example")
    vi.unstubAllGlobals()
    cleanup()
  })

  it("renders panels returned by the server, looking up component from the local registry", async () => {
    // Server says: invoicing contributes a panel with id "invoicing-documents"
    // to the contact_detail slot.
    mockApiClient({
      "/api/v1/slots/contact_detail": {
        panels: [
          {
            id: "invoicing-documents",
            app: "invoicing",
            label: "Documents",
            component: "ContactDocumentsPanel",
          },
        ],
      },
    })
    // Local registry: the invoicing app already registered its contribution.
    registerContribution("contact_detail", {
      appId: "invoicing",
      id: "invoicing-documents",
      label: "Documents",
      component: (props) => (
        <div data-testid="invoicing-documents-panel">Documents for {props.entityId}</div>
      ),
    })

    renderSlotPanels("contact_detail", "contact-1")
    await waitFor(() => {
      expect(screen.getByTestId("invoicing-documents-panel")).toBeInTheDocument()
    })
    expect(screen.getByTestId("invoicing-documents-panel").textContent).toContain("contact-1")
  })

  it("shows 'Panel unavailable' placeholder when the local registry has no matching component", async () => {
    mockApiClient({
      "/api/v1/slots/contact_detail": {
        panels: [
          {
            id: "missing-panel",
            app: "ghost-app",
            label: "Ghost",
            component: "GhostPanel",
          },
        ],
      },
    })
    // No registerContribution() call — bundle load effectively failed,
    // so the contribution registry has nothing for (ghost-app, missing-panel).

    renderSlotPanels("contact_detail")
    await waitFor(() => {
      expect(
        screen.getByTestId("slot-panel-unavailable-ghost-app-missing-panel"),
      ).toBeInTheDocument()
    })
  })

  it("renders nothing when the server returns an empty panel list (no skeleton noise)", async () => {
    mockApiClient({
      "/api/v1/slots/contact_detail": { panels: [] },
    })

    renderSlotPanels("contact_detail")
    await waitFor(() => {
      // The wrapper div is omitted entirely when the list is empty.
      expect(screen.queryByTestId("slot-panels-contact_detail")).not.toBeInTheDocument()
    })
  })

  it("example declares a panel on each of the six slots, each appears with entityId", async () => {
    const entries = exampleSlotEntries()
    expect(Object.keys(entries).sort()).toEqual(SIX_SLOTS.map(([slot]) => slot).sort())
    // Its UI: one component per declared export, drawing the record it was given.
    const exports: Record<string, unknown> = {}
    for (const list of Object.values(entries)) {
      for (const e of list) {
        exports[e.component] = (props: { entityId?: string }) => (
          <div data-testid={`example-${e.component}`}>{props.entityId}</div>
        )
      }
    }
    registerAppFromManifest(
      { name: "example", slots: exampleManifest.slots } as unknown as AppManifest,
      exports,
    )
    // The server's list for each slot is the manifest's entries, as the api lists them.
    const routes: Record<string, unknown> = {}
    for (const [slot, list] of Object.entries(entries)) {
      routes[`/api/v1/slots/${slot}`] = { panels: list.map((e) => ({ ...e, app: "example" })) }
    }
    mockApiClient(routes)
    for (const [slot, position] of SIX_SLOTS) {
      const view = renderSlotPanels(slot, `record-${slot}`, position)
      const component = (entries[slot] ?? [])[0]?.component
      const panel = await screen.findByTestId(`example-${component}`)
      expect(panel.textContent).toBe(`record-${slot}`)
      expect(screen.getByTestId(`slot-panels-${slot}`).dataset.position).toBe(position)
      view.unmount()
    }
  })

  it("visibility_scope the viewer lacks: absent from the route and the DOM", async () => {
    // The route filtered the panel out: the component is registered, nothing is drawn.
    registerContribution("ticket:detail:panel", {
      appId: "fixture-app",
      id: "fixture-panel",
      label: "Fixture",
      component: () => <div data-testid="fixture-panel" />,
    })
    mockApiClient({ "/api/v1/slots/ticket:detail:panel": { panels: [] } })
    renderSlotPanels("ticket:detail:panel", "t1")
    await screen.findByTestId("host-action")
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByTestId("fixture-panel")).toBeNull()
    expect(screen.queryByTestId("slot-panels-ticket:detail:panel")).toBeNull()
  })

  it("a panel naming a switched-off feature is absent from the route and the DOM", async () => {
    registerContribution("project:detail:panel", {
      appId: "fixture-app",
      id: "fixture-feature-panel",
      label: "Fixture",
      component: () => <div data-testid="fixture-feature-panel" />,
    })
    mockApiClient({ "/api/v1/slots/project:detail:panel": { panels: [] } })
    renderSlotPanels("project:detail:panel", "p1")
    await screen.findByTestId("host-action")
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByTestId("fixture-feature-panel")).toBeNull()
  })

  it("an unregistered slot key is empty, no error", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    mockApiClient({ "/api/v1/slots/company_detail": { panels: [] } })
    renderSlotPanels("company_detail", "c1")
    await screen.findByTestId("host-action")
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByTestId("slot-panels-company_detail")).toBeNull()
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  it("a throwing panel shows slot-panel-unavailable, host stands", async () => {
    registerContribution("contact_detail", {
      appId: "fixture-app",
      id: "broken",
      label: "Broken",
      component: () => {
        throw new Error("bad data")
      },
    })
    registerContribution("contact_detail", {
      appId: "fixture-app",
      id: "fine",
      label: "Fine",
      component: (props) => <div data-testid="fine-panel">{props.entityId}</div>,
    })
    mockApiClient({
      "/api/v1/slots/contact_detail": {
        panels: [
          { id: "broken", app: "fixture-app", label: "Broken", component: "Broken" },
          { id: "fine", app: "fixture-app", label: "Fine", component: "Fine" },
        ],
      },
    })
    renderSlotPanels("contact_detail", "contact-1")
    await screen.findByTestId("slot-panel-unavailable-fixture-app-broken")
    expect(screen.queryByTestId("host-crashed")).toBeNull()
    expect(screen.getByTestId("fine-panel").textContent).toBe("contact-1")
    expect(screen.getByTestId("host-action")).toBeInTheDocument()
  })

  it("a failed list route renders nothing and does not throw", async () => {
    let calls = 0
    vi.stubGlobal("fetch", async () => {
      calls++
      return new Response(JSON.stringify({ error: { message: "forbidden", code: "forbidden" } }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })
    })
    renderSlotPanels("contact_detail", "contact-1")
    await screen.findByTestId("host-action")
    await waitFor(() => expect(calls).toBeGreaterThan(0))
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByTestId("host-crashed")).toBeNull()
    expect(screen.queryByTestId("slot-panels-contact_detail")).toBeNull()
    expect(screen.getByTestId("host-page")).toBeInTheDocument()
  })

  it("a tab strip shows one panel at a time and switches on click", async () => {
    for (const id of ["one", "two"]) {
      registerContribution("project:task:tabs", {
        appId: "fixture-app",
        id,
        label: id,
        component: () => <div data-testid={`tab-body-${id}`} />,
      })
    }
    mockApiClient({
      "/api/v1/slots/project:task:tabs": {
        panels: ["one", "two"].map((id) => ({ id, app: "fixture-app", label: id, component: id })),
      },
    })
    renderSlotPanels("project:task:tabs", "task-1", "tabs")
    await screen.findByTestId("tab-body-one")
    expect(screen.queryByTestId("tab-body-two")).toBeNull()
    screen.getByTestId("slot-tab-fixture-app-two").click()
    await screen.findByTestId("tab-body-two")
    expect(screen.queryByTestId("tab-body-one")).toBeNull()
  })
})
