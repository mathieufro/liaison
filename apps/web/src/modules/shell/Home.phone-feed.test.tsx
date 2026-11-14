// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The phone tier used to render the DESKTOP attention feed unchanged at 390px:
// a 32px hero, an all-caps status line that wrapped, wrapping filter chips, and
// rows whose 40px icon rail plus `min-w-[300px]` body could not share a line,
// so the kind glyph landed alone on its own row above a title that repeated the
// kind badge word for word. These lock the phone feed down as a real phone
// feed: compact greeting, plain-sentence status, a single scrollable chip row,
// and one compact row per item with one action row.
import type { AttentionItem } from "@liaison/shared"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("~/modules/auth/auth-store", () => ({
  onAuthCleared: () => () => {},
  hasScope: () => true,
  userFromToken: () => ({ userId: "u-1", name: "Tester" }),
}))

const apiGet = vi.fn()
const apiGetEnvelope = vi.fn()
const apiPost = vi.fn(async () => ({}))
const apiStub = {
  get: apiGet,
  getEnvelope: apiGetEnvelope,
  post: apiPost,
  patch: vi.fn(async () => ({})),
  put: vi.fn(async () => ({})),
}
vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => apiStub,
  useOptionalApi: () => apiStub,
  ApiContext: { Provider: (p: { children: unknown }) => p.children },
}))

import { resetRegistry } from "~/framework/app-registry"
import { appHue } from "~/modules/shell/app-color"
import { attentionStore } from "~/modules/shell/attention-store"
import Home from "~/modules/shell/Home"
import { resetHomeCardLayout } from "~/modules/shell/home-card-layout"
import { resetTabStore } from "~/modules/shell/tab-store"
import { resetThreadStore } from "~/modules/threads/thread-store"
import { setShellTier } from "~/tests/helpers/shell-tier"

/** An approval whose summarizer title repeats its own action badge, the exact
 *  "Knowledge Create" twice case from the screenshot. */
const duplicateTitleApproval = (id: string): AttentionItem => ({
  id,
  app: "knowledge",
  entity: "approval_request",
  entityId: id,
  kind: "approval_pending",
  summary: "Knowledge Create",
  urgency: 60,
  occurredAt: "2026-05-06T12:00:00.000Z",
  action: { type: "decide_approval", approvalId: id },
  metadata: {
    actionLabel: "Knowledge: create",
    requestHandle: "request-42",
    requesterName: "Alice Chen",
    expiresInSeconds: 2640,
  },
})

const distinctTitleApproval = (id: string): AttentionItem => ({
  ...duplicateTitleApproval(id),
  summary: "Publish the return policy article",
})

const rowId = (id: string) => `attention-row-knowledge-approval_request-${id}`

/** Alert rows for the Messages card's Alerts section. Distinct kinds so they
 *  never cluster into one row. */
const alerts = (): AttentionItem[] =>
  ["sla_risk", "system_alert", "task_overdue", "admin_action", "dm_window_closing"].map(
    (kind, i) => ({
      id: `al-${i}`,
      app: "tickets",
      entity: "ticket",
      entityId: `t-${i}`,
      kind,
      summary: `Alert ${i}`,
      urgency: 90,
      occurredAt: "2026-05-06T12:00:00.000Z",
      action: { type: "open_entity", tabType: "tickets:ticket", entityId: `t-${i}` },
      metadata: {},
    }),
  ) as AttentionItem[]

describe("phone attention feed", () => {
  beforeEach(() => {
    resetRegistry()
    resetTabStore()
    resetThreadStore()
    resetHomeCardLayout()
    attentionStore._setForTest({ items: [], errors: [], loading: false })
    apiGet.mockReset().mockResolvedValue([])
    apiGetEnvelope.mockReset().mockResolvedValue({ data: { items: [], errors: [] } })
  })
  afterEach(() => {
    cleanup()
    setShellTier("desktop")
  })

  it("home-phone.header keeps the greeting compact and the status line a plain sentence", () => {
    setShellTier("phone")
    attentionStore._setForTest({ items: [distinctTitleApproval("k-1")], errors: [] })
    render(() => <Home entityId="home" />)
    const greeting = screen.getByTestId("home-greeting")
    // No 32px hero eating a third of a 390px screen.
    expect(greeting.className).not.toContain("text-[32px]")
    expect(greeting.className).toContain("text-[22px]")
    const status = screen.getByTestId("home-status")
    expect(status.className).not.toContain("uppercase")
    expect(status.className).not.toContain("tracking-[0.04em]")
  })

  // The per-action filter chips are gone: one list, and each row's pill names its action.
  it("home.approvals: no filter chips, the pill stays on each row in its app's colour", () => {
    setShellTier("phone")
    attentionStore._setForTest({
      items: [
        {
          ...distinctTitleApproval("k-1"),
          metadata: { toolName: "tickets:reply", actionLabel: "Tickets: reply" },
        },
        {
          ...distinctTitleApproval("k-2"),
          metadata: { toolName: "kernel:update_skill", actionLabel: "Kernel: update skill" },
        },
      ],
      errors: [],
    })
    render(() => <Home entityId="home" />)
    expect(screen.queryByTestId("home-approval-facets")).toBeNull()
    expect(screen.queryByTestId("home-approval-facet-all")).toBeNull()
    const chip = screen.getByTestId(`${rowId("k-1")}-action-chip`)
    expect(chip).toHaveAttribute("data-app", "tickets")
    expect(chip.style.getPropertyValue("--app-pill-bg-light")).toBe(
      `hsl(${appHue("tickets")} 60% 94%)`,
    )
  })

  it("home-phone.row renders one compact row: inline glyph, one action row, chevron details", () => {
    setShellTier("phone")
    attentionStore._setForTest({ items: [distinctTitleApproval("k-1")], errors: [] })
    render(() => <Home entityId="home" />)
    const row = screen.getByTestId(rowId("k-1"))
    expect(row.getAttribute("data-compact")).toBe("true")
    // The kind glyph sits on the title line, not alone on a wrapped row above it.
    expect(
      screen.getByTestId(`${rowId("k-1")}-title-line`).contains(row.querySelector("svg")),
    ).toBe(true)
    // One secondary line carrying who / when / time left as plain text.
    const secondary = screen.getByTestId(`${rowId("k-1")}-secondary`)
    expect(secondary.textContent).toContain("Alice Chen")
    expect(secondary.textContent).toContain("44")
    // The deadline is its own non-shrinking element, so the byline can run out
    // of room without taking it with it: the row read "by Amina Cherif - 2..."
    // on the box and never showed the "3d left" it exists to convey.
    const deadline = screen.getByTestId(`${rowId("k-1")}-deadline`)
    expect(deadline.className).toContain("shrink-0")
    expect(deadline.className).not.toContain("truncate")
    expect(deadline.textContent).toContain("44")
    const byline = secondary.querySelector("span.truncate")
    expect(byline?.textContent).toContain("Alice Chen")
    expect(byline?.textContent).not.toContain("44")
    expect(secondary.className).not.toContain("font-mono")
    expect(secondary.className).not.toContain("text-warning")
    // Approve / Reject side by side, each a 44px touch target, not a 90px slab.
    const approve = screen.getByTestId(`${rowId("k-1")}-approve`)
    expect(approve.className).toContain("min-h-11")
    expect(screen.getByTestId(`${rowId("k-1")}-reject`).className).toContain("min-h-11")
    // Details is a chevron at the row end, not an orphaned right-aligned link.
    const details = screen.getByTestId(`${rowId("k-1")}-details`)
    expect(details.textContent?.trim()).not.toContain("Details")
    expect(details.getAttribute("aria-expanded")).toBe("false")
  })

  it("home-phone.row does not print the kind twice when the title IS the badge", () => {
    setShellTier("phone")
    attentionStore._setForTest({ items: [duplicateTitleApproval("k-1")], errors: [] })
    render(() => <Home entityId="home" />)
    // The badge stays; the title text that merely repeats it is dropped.
    expect(screen.getByTestId(`${rowId("k-1")}-action-chip`).textContent).toContain(
      "Knowledge: create",
    )
    expect(screen.queryByTestId(`${rowId("k-1")}-title`)).toBeNull()
    expect(screen.getByTestId(`${rowId("k-1")}-title-line`).textContent).not.toContain(
      "Knowledge Create",
    )
  })

  it("home-phone.row keeps the title when it says something the badge does not", () => {
    setShellTier("phone")
    attentionStore._setForTest({ items: [distinctTitleApproval("k-1")], errors: [] })
    render(() => <Home entityId="home" />)
    const title = screen.getByTestId(`${rowId("k-1")}-title`)
    expect(title.textContent).toContain("Publish the return policy article")
    expect(title.className).toContain("truncate")
  })

  it("home-desktop.row is untouched by the phone compaction", () => {
    setShellTier("desktop")
    attentionStore._setForTest({ items: [distinctTitleApproval("k-1")], errors: [] })
    render(() => <Home entityId="home" />)
    const row = screen.getByTestId(rowId("k-1"))
    expect(row.getAttribute("data-compact")).toBeNull()
    expect(screen.getByTestId(`${rowId("k-1")}-details`).textContent).toContain("Details")
    expect(screen.getByTestId("home-greeting").className).toContain("text-[24px]")
  })

  // The alerts card sliced a row's "Open" button in half at the card edge. The
  // 285px cap is a desktop device: there the cards sit side by side and the
  // inner scrollbar is visible. On a phone the cards are one column the page
  // already scrolls, the inner scrollbar is invisible, and the taller phone row
  // meant the cap landed mid-button, which reads as a broken card.
  it("home-phone.alerts let the card grow with its rows instead of slicing one", () => {
    setShellTier("phone")
    attentionStore._setForTest({ items: alerts(), errors: [] })
    render(() => <Home entityId="home" />)
    const list = screen.getByTestId("home-alerts-list")
    expect(list.getAttribute("data-capped")).toBe("false")
    expect(list.style.maxHeight).toBe("")
    expect(list.style.overflowY).toBe("")
  })

  it("home-phone.alerts keep the desktop cap, which is where it earns its keep", () => {
    setShellTier("desktop")
    attentionStore._setForTest({ items: alerts(), errors: [] })
    render(() => <Home entityId="home" />)
    const list = screen.getByTestId("home-alerts-list")
    expect(list.getAttribute("data-capped")).toBe("true")
    expect(list.style.maxHeight).toBe("285px")
    expect(list.style.overflowY).toBe("auto")
  })

  // Expanding a phone approval row rendered the full ApprovalCard underneath
  // while the row kept its own Approve / Reject: two live pairs, different
  // wording, one screen. The row's pair stands down while the card is open.
  it("home-phone.row hands the decision to the expanded card, keeping one pair", () => {
    setShellTier("phone")
    attentionStore._setForTest({ items: [distinctTitleApproval("k-1")], errors: [] })
    render(() => <Home entityId="home" />)
    expect(screen.getByTestId(`${rowId("k-1")}-approve`)).toBeTruthy()

    fireEvent.click(screen.getByTestId(`${rowId("k-1")}-details`))

    expect(screen.getByTestId(`${rowId("k-1")}-expanded`)).toBeTruthy()
    expect(screen.queryByTestId(`${rowId("k-1")}-approve`)).toBeNull()
    expect(screen.queryByTestId(`${rowId("k-1")}-reject`)).toBeNull()
  })

  // F6 polish. The last chip was cut mid word at the screen edge with nothing
  // to say the row continued sideways. Re-walk 2026-10-20: the fade was a box
  // painted in the page colour, dark over the lighter approvals card. The row
  // now masks its own edge, so the chips fade over whatever is behind them,
  // and only while there is more to scroll.
  it("home-phone.header is opaque, so rows never show through the greeting", () => {
    setShellTier("phone")
    attentionStore._setForTest({ items: [distinctTitleApproval("k-1")], errors: [] })
    render(() => <Home entityId="home" />)

    const header = screen.getByTestId("home-header")
    expect(header.className).toContain("bg-bg")
    expect(header.className).toContain("sticky")
    expect(header.className).toContain("top-0")
    // The greeting and the status line are both inside it.
    expect(header.contains(screen.getByTestId("home-greeting"))).toBe(true)
    expect(header.contains(screen.getByTestId("home-status"))).toBe(true)
  })

  // The pixels (390 px wide, 44 px targets) are read on a real phone screen; here, the classes.
  it("home-phone: every row action is a 44px touch target", () => {
    setShellTier("phone")
    const notice: AttentionItem = {
      id: "ev-1",
      app: "kernel",
      entity: "notification",
      entityId: "n-1",
      kind: "system_alert",
      summary: "A deal went quiet",
      urgency: 90,
      occurredAt: "2026-05-06T12:00:00.000Z",
      action: { type: "open_entity", tabType: "kernel:notification", entityId: "n-1" },
      persisted: true,
    }
    attentionStore._setForTest({ items: [distinctTitleApproval("k-1"), notice], errors: [] })
    render(() => <Home entityId="home" />)
    const ids = [
      `${rowId("k-1")}-approve`,
      `${rowId("k-1")}-reject`,
      "attention-row-kernel-notification-n-1-ask-draft",
      "attention-row-kernel-notification-n-1-not-now",
    ]
    for (const id of ids) expect(screen.getByTestId(id).className).toContain("min-h-11")
    expect(screen.getByTestId(`${rowId("k-1")}-details`).className).toContain("h-11")
  })
})
