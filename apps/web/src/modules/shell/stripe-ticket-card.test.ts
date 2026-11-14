// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The ticket page mounts a bundled app's card through the filtered `ticket:detail:panel` slot: the
// server lists the card only for a viewer holding the scope the app's manifest names, the page hands it
// the ticket id, and the card draws only the masked card. A viewer the server does not list sees nothing.
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { createComponent } from "solid-js"
import { insert } from "solid-js/web"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  registerContribution,
  resetRegistry,
  unregisterContributions,
} from "~/framework/app-registry"
import { setTokens } from "~/modules/auth/auth-store"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { SlotPanels } from "~/modules/shell/SlotPanels"
import { mockApiClient } from "~/tests/helpers/mock-api"
import stripeManifest from "../../../../../bundled-apps/stripe/app.manifest.json"

const invoke = vi.fn(async (_app: string, tool: string, args: Record<string, unknown>) => {
  if (tool === "customer_context") return { customerIds: ["cus_a"], lines: [] }
  if (tool === "customers_get" && args.id === "cus_a") {
    return {
      customer: {
        id: "cus_a",
        rowId: "row-a",
        name: "Maison Arlon",
        email: "claire@maison-arlon.example",
        companyId: "co1",
        contactId: null,
      },
      subscriptions: [
        {
          id: "sub_a",
          customerId: "cus_a",
          status: "past_due",
          plan: "Group",
          mrrMinor: 145000,
          currency: "eur",
          trialEnd: null,
          pastDueSince: "2026-11-03T00:00:00Z",
          card: { brand: "visa", last4: "4242", exp: "10/26" },
        },
      ],
      openInvoices: [],
    }
  }
  throw new Error(`unexpected ${tool}`)
})

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

function renderTicketPanelSlot() {
  const page = () =>
    createComponent(ApiProvider, {
      get children() {
        const panel = document.createElement("div")
        panel.setAttribute("data-testid", "tickets-detail-panel")
        insert(
          panel,
          createComponent(SlotPanels, {
            slot: "ticket:detail:panel",
            entityId: "t1",
            panelProps: { ticketId: "t1" },
          }),
        )
        return panel
      },
    })
  return render(() =>
    createComponent(Router, { children: createComponent(Route, { path: "*", component: page }) }),
  )
}

describe("the ticket page and the Stripe card", () => {
  beforeEach(() => {
    setTokens(makeJwt(), "refresh")
    resetRegistry()
    invoke.mockClear()
    // The page's host: the app's UI reads it from the window, as it does in the real shell.
    ;(globalThis as { __liaisonHost?: unknown }).__liaisonHost = {
      invokeTool: invoke,
      locale: () => "en",
    }
    ;(globalThis as { __LIAISON_TEST_APP_NAME?: string }).__LIAISON_TEST_APP_NAME = "stripe"
  })
  afterEach(() => {
    unregisterContributions("stripe")
    ;(globalThis as { __liaisonHost?: unknown }).__liaisonHost = undefined
    ;(globalThis as { __LIAISON_TEST_APP_NAME?: string }).__LIAISON_TEST_APP_NAME = undefined
    vi.unstubAllGlobals()
    cleanup()
  })

  it("the ticket page mounts the app's card through the filtered slot", async () => {
    const entry = (
      stripeManifest as {
        contributions: Record<
          string,
          { component: string; label: string; visibility_scope: string }
        >
      }
    ).contributions["ticket:detail:panel"]
    expect(entry?.visibility_scope).toBe("stripe:customers:read")
    const { TicketStripeCard } = await import(
      "../../../../../bundled-apps/stripe/src/ui/TicketStripeCard"
    )
    // The server lists the panel for a viewer holding the scope, by the component name.
    mockApiClient({
      "/v1/slots/ticket": {
        panels: [{ id: entry?.component, app: "stripe", label: entry?.label }],
      },
    })
    registerContribution("ticket:detail:panel", {
      appId: "stripe",
      id: entry?.component ?? "",
      label: "Stripe",
      component: TicketStripeCard as never,
    })
    renderTicketPanelSlot()
    const card = await screen.findByTestId("ticket-stripe-card")
    expect(screen.getByTestId("tickets-detail-panel").contains(card)).toBe(true)
    await waitFor(() => expect(card.textContent).toContain("Visa 4242, 10/26"))
    expect(card.textContent).toContain("Past due")
    expect(invoke).toHaveBeenCalledWith("stripe", "customer_context", {
      subject: { app: "tickets", entityType: "ticket", entityId: "t1" },
    })
  })

  it("a viewer the server does not list sees no Stripe card and the app reads nothing", async () => {
    const { TicketStripeCard } = await import(
      "../../../../../bundled-apps/stripe/src/ui/TicketStripeCard"
    )
    mockApiClient({ "/v1/slots/ticket": { panels: [] } })
    registerContribution("ticket:detail:panel", {
      appId: "stripe",
      id: "TicketStripeCard",
      label: "Stripe",
      component: TicketStripeCard as never,
    })
    renderTicketPanelSlot()
    await new Promise((r) => setTimeout(r, 100))
    expect(screen.queryByTestId("ticket-stripe-card")).toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })
})
