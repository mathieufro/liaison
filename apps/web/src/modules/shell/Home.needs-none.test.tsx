// SPDX-License-Identifier: FSL-1.1-ALv2
import type { AttentionItem } from "@liaison/shared"
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("~/modules/auth/auth-store", () => ({
  onAuthCleared: () => () => {},
  hasScope: () => true,
  userFromToken: () => ({ userId: "u-1", name: "Tester" }),
}))

const apiGet = vi.fn()
const apiGetEnvelope = vi.fn()
const apiPost = vi.fn(async () => ({}))
const apiPatch = vi.fn(async () => ({}))
const apiPut = vi.fn(async () => ({}))
vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => ({
    get: apiGet,
    getEnvelope: apiGetEnvelope,
    post: apiPost,
    patch: apiPatch,
    put: apiPut,
  }),
  useOptionalApi: () => ({
    get: apiGet,
    getEnvelope: apiGetEnvelope,
    post: apiPost,
    patch: apiPatch,
    put: apiPut,
  }),
}))

import { attentionStore } from "~/modules/shell/attention-store"
import { resetHomeCardLayout } from "~/modules/shell/home-card-layout"
import Home from "./Home"

const makeOpenEntityItem = (over: Partial<AttentionItem>): AttentionItem => ({
  id: over.id ?? "att-1",
  app: over.app ?? "projects",
  entity: over.entity ?? "task",
  entityId: over.entityId ?? "T1",
  kind: over.kind ?? "task_overdue",
  summary: over.summary ?? "Task is overdue",
  urgency: over.urgency ?? 60,
  occurredAt: over.occurredAt ?? "2026-05-06T12:00:00.000Z",
  action: over.action ?? {
    type: "open_entity",
    tabType: `${over.app ?? "projects"}:${over.entity ?? "task"}`,
    entityId: over.entityId ?? "T1",
  },
  metadata: over.metadata,
})

beforeEach(() => {
  attentionStore._setForTest({ items: [], errors: [], loading: false })
  resetHomeCardLayout()
  apiGet.mockReset().mockResolvedValue([])
  apiGetEnvelope.mockReset().mockResolvedValue({ data: { items: [], errors: [] } })
  apiPost.mockReset().mockResolvedValue({})
  apiPatch.mockReset().mockResolvedValue({})
  apiPut.mockReset().mockResolvedValue({})
})

const makeApprovalItem = (over: Partial<AttentionItem>): AttentionItem => ({
  id: over.id ?? "att-approval-1",
  app: "invoicing",
  entity: "document",
  entityId: over.entityId ?? "doc-1",
  kind: "approval_pending",
  summary: over.summary ?? "Mark invoice paid",
  urgency: 40,
  occurredAt: "2026-05-06T12:00:00.000Z",
  action: { type: "decide_approval", approvalId: over.entityId ?? "doc-1" },
})

const queueItem = (id: string): AttentionItem =>
  makeOpenEntityItem({
    id,
    entityId: id,
    app: "tickets",
    entity: "ticket",
    kind: "ticket_awaiting_reply" as AttentionItem["kind"],
    urgency: 20,
  })

describe("Home when nothing needs you", () => {
  it("says nothing needs you now, shows Needs you at 0 and says that is everything", () => {
    attentionStore._setForTest({ items: [queueItem("q-1"), queueItem("q-2")], errors: [] })
    render(() => <Home entityId="home" />)
    const status = screen.getByTestId("home-status").textContent ?? ""
    expect(status).toContain("NOTHING NEEDS YOU NOW")
    expect(status).toMatch(/2\s*IN YOUR OTHER WORK/)
    const none = screen.getByTestId("home-needs-none")
    expect(none.textContent).toContain("Needs you")
    expect(screen.getByTestId("home-needs-none-count").textContent).toBe("0")
    expect(screen.getByTestId("home-needs-none-closing").textContent).toBe(
      "That is everything for now. Your agents will bring the next one here.",
    )
    // The rest of the work still shows below.
    expect(screen.getByTestId("home-feed")).toBeTruthy()
  })

  it("with nothing at all, Needs you at 0 is the whole page", () => {
    render(() => <Home entityId="home" />)
    expect(screen.getByTestId("home-empty-state").textContent).toContain("Needs you")
    expect(screen.getByTestId("home-needs-none-closing")).toBeTruthy()
    expect(screen.queryByTestId("home-feed")).toBeNull()
  })

  it("a decision waiting: no Needs you at 0", () => {
    attentionStore._setForTest({ items: [makeApprovalItem({ entityId: "ap-1" })], errors: [] })
    render(() => <Home entityId="home" />)
    expect(screen.queryByTestId("home-needs-none")).toBeNull()
  })

  it("a source that did not answer gets its own row with Retry, the rest still shows, and Home does not say that is everything", () => {
    attentionStore._setForTest({
      items: [queueItem("q-1")],
      errors: [{ app: "projects", reason: "error", message: "boom" }],
    })
    render(() => <Home entityId="home" />)
    const failed = screen.getByTestId("home-source-failed-projects")
    expect(failed.textContent).toContain("Could not load what Projects has for you")
    expect(screen.getByTestId("home-source-failed-projects-retry").textContent).toBe("Retry")
    expect(screen.getByTestId("home-feed")).toBeTruthy()
    expect(screen.getByTestId("home-needs-none")).toBeTruthy()
    expect(screen.queryByTestId("home-needs-none-closing")).toBeNull()
    apiGetEnvelope.mockClear()
    fireEvent.click(screen.getByTestId("home-source-failed-projects-retry"))
    expect(apiGetEnvelope).toHaveBeenCalledWith("/attention-items")
  })
})
