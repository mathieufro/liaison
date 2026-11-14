// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An access request in the approvals list: the approval row's anatomy, the
// "Access request" pill in the colour of the app whose scope is asked for (no
// amber lock), Grant and Deny on the collapsed row itself (desktop and phone),
// Details opening the request's facts.
import type { AttentionItem } from "@liaison/shared"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"

const queued = vi.hoisted(() => ({ calls: [] as unknown[][] }))
vi.mock("~/modules/approvals/decision-queue", () => ({
  isDecisionInFlight: () => false,
  isDecisionNotSent: (_kind: string, id: string) => id === "8c41e0d2-0000-4000-8000-0000000000aa",
  isDecisionUndone: () => false,
  queueDecision: vi.fn(async (...args: unknown[]) => {
    queued.calls.push(args)
  }),
}))

import AccessRequestRow, { accessRequestOf } from "~/modules/admin-scope-requests/AccessRequestRow"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { ApiContext } from "~/modules/shell/ApiContext"
import AttentionRow from "~/modules/shell/AttentionRow"
import { setShellTier } from "~/tests/helpers/shell-tier"

function scopeItem(over: Record<string, unknown> = {}): AttentionItem {
  return {
    id: "kernel:scope_request:sr-1",
    app: "kernel",
    entity: "scope_request",
    entityId: "8c41e0d2-0000-4000-8000-000000000001",
    kind: "scope_request",
    summary: "Sales agent requested access: shopify:orders:read",
    urgency: 60,
    occurredAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    persisted: true,
    action: { type: "open_entity", tabType: "admin:scope-requests", entityId: "sr-1" },
    metadata: {
      agentName: "Sales agent",
      requesterLabel: "Sales agent",
      requestedScopes: ["shopify:orders:read"],
      reason: "To check order status before answering.",
      ...over,
    },
  } as AttentionItem
}

const api = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } as never

function renderRow(it: AttentionItem, viaAttentionRow = false) {
  return render(() => (
    <I18nProvider initialLocale="en">
      <ApiContext.Provider value={api}>
        <ul>
          {viaAttentionRow ? (
            <AttentionRow item={it} />
          ) : (
            <AccessRequestRow item={it} facts={accessRequestOf(it)!} />
          )}
        </ul>
      </ApiContext.Provider>
    </I18nProvider>
  ))
}

const T = "attention-row-kernel-scope_request-8c41e0d2-0000-4000-8000-000000000001"

afterEach(() => {
  cleanup()
  queued.calls = []
  vi.unstubAllGlobals()
  setShellTier("desktop")
})

describe("an access request in the approvals list", () => {
  it("is what AttentionRow renders for a scope request", () => {
    setShellTier("desktop")
    renderRow(scopeItem(), true)
    expect(screen.getByTestId(T).getAttribute("data-kind")).toBe("scope_request")
    expect(screen.getByTestId(`${T}-grant`)).toBeTruthy()
  })

  it("takes the colour of the app whose scope is asked for", () => {
    setShellTier("desktop")
    renderRow(scopeItem())
    const pill = screen.getByTestId(`${T}-pill`)
    expect(pill.textContent).toBe("Access request")
    expect(pill.getAttribute("data-app")).toBe("shopify")
    expect(pill.getAttribute("data-app-tone")).toBe("app")
    expect(pill.getAttribute("style") ?? "").toContain("--app-pill-bg-light")
    // Another app's scope, another colour; a kernel scope reads neutral.
    cleanup()
    renderRow(scopeItem({ requestedScopes: ["calendar:events:read"] }))
    expect(screen.getByTestId(`${T}-pill`).getAttribute("data-app")).toBe("calendar")
    cleanup()
    renderRow(scopeItem({ requestedScopes: ["kernel:users:read"] }))
    expect(screen.getByTestId(`${T}-pill`).getAttribute("data-app-tone")).toBe("system")
  })

  it("says who asks, for what, and why", () => {
    setShellTier("desktop")
    renderRow(scopeItem())
    expect(screen.getByTestId(`${T}-title`).textContent).toContain(
      "Sales agent asks for access to Shopify",
    )
    const lines = screen.getByTestId(`${T}-lines`).textContent ?? ""
    expect(lines).toContain("Allows: ")
    expect(lines).toContain("Why: “To check order status before answering.”")
    expect(screen.getByTestId(`${T}-meta`).textContent).toContain("Sales agent")
  })

  it("a decision dropped at boot as too old says on its row that it was not sent", () => {
    setShellTier("desktop")
    renderRow({ ...scopeItem(), entityId: "8c41e0d2-0000-4000-8000-0000000000aa" })
    const T2 = "attention-row-kernel-scope_request-8c41e0d2-0000-4000-8000-0000000000aa"
    expect(screen.getByTestId(`${T2}-lines`).textContent).toContain(
      "Not sent: this decision was more than 15 minutes old. Decide again.",
    )
  })

  it("shows Grant (primary) and Deny on the collapsed desktop row", () => {
    setShellTier("desktop")
    renderRow(scopeItem())
    const grant = screen.getByTestId(`${T}-grant`)
    const deny = screen.getByTestId(`${T}-deny`)
    expect(grant.textContent).toBe("Grant")
    expect(deny.textContent).toBe("Deny")
    expect(grant.className).toContain("bg-accent")
    expect(deny.className).not.toContain("bg-accent")
    // Never the approval verbs.
    expect(screen.queryByText("Approve")).toBeNull()
    expect(screen.queryByText("Reject")).toBeNull()
    expect(screen.getByTestId(T).getAttribute("data-expanded")).toBe("false")
  })

  it("shows Grant and Deny on the collapsed phone row", () => {
    setShellTier("phone")
    renderRow(scopeItem())
    expect(screen.getByTestId(T).getAttribute("data-compact")).toBe("true")
    const actions = screen.getByTestId(`${T}-actions`)
    expect(actions.textContent).toContain("Grant")
    expect(actions.textContent).toContain("Deny")
    expect(screen.getByTestId(`${T}-grant`).className).toContain("bg-accent")
  })

  it("Grant and Deny decide the access request (not an approval)", () => {
    setShellTier("desktop")
    renderRow(scopeItem())
    fireEvent.click(screen.getByTestId(`${T}-grant`))
    expect(queued.calls[0]?.slice(1, 4)).toEqual([
      "scope-request",
      "8c41e0d2-0000-4000-8000-000000000001",
      { decision: "approve" },
    ])
    cleanup()
    renderRow(scopeItem())
    fireEvent.click(screen.getByTestId(`${T}-deny`))
    expect(queued.calls[1]?.[3]).toEqual({ decision: "deny" })
  })

  it("Details opens the request's facts, with Grant / Deny in the card", () => {
    setShellTier("desktop")
    renderRow(scopeItem())
    expect(screen.queryByTestId(`${T}-card`)).toBeNull()
    fireEvent.click(screen.getByTestId(`${T}-details`))
    expect(screen.getByTestId(`${T}-card`)).toBeTruthy()
    expect(screen.getByTestId(`${T}-fact-allows-1`)).toBeTruthy()
    expect(screen.getByTestId(`${T}-fact-why`).textContent).toContain("To check order status")
    expect(screen.getByTestId(`${T}-card`).textContent).toContain("shopify:orders:read")
    expect(screen.getByTestId(`${T}-grant-in-card`).textContent).toBe("Grant")
    expect(screen.getByTestId(`${T}-deny-in-card`).textContent).toBe("Deny")
  })
})
