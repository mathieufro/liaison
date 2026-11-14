// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The company page at phone width: three tabs (Overview, Timeline, Discussion),
// an ask box at the bottom that leads into the discussion, 44px targets, and
// nothing with a fixed width wider than a 390px screen.
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import { setShellTier } from "~/tests/helpers/shell-tier"
import { CompanyDetail } from "./CompanyDetail"
import { resetCompanyStores } from "./company-store"

const CO = "co-1"

const mocks = vi.hoisted(() => ({
  routes: {} as Record<string, unknown>,
  postResult: {} as Record<string, unknown>,
}))

function respond(path: string): unknown {
  const key = Object.keys(mocks.routes).find((k) => path === k || path.startsWith(`${k}?`))
  if (!key) throw new ApiError("Not found", 404)
  return mocks.routes[key]
}

const api = {
  get: vi.fn(async (path: string) => respond(path)),
  getEnvelope: vi.fn(async (path: string) => respond(path)),
  post: vi.fn(async (path: string, body?: unknown) => {
    if (path === "/apps/run-tool") {
      return mocks.postResult[(body as { toolName: string }).toolName] ?? {}
    }
    return mocks.postResult[path] ?? {}
  }),
  patch: vi.fn(),
  delete: vi.fn(),
}

vi.mock("~/modules/shell/ApiContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/shell/ApiContext")>()),
  useApi: () => api,
  useOptionalApi: () => api,
}))
vi.mock("~/modules/auth/auth-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/auth/auth-store")>()),
  userFromToken: () => ({ userId: "u-me", name: "Me", scopes: ["*"] }),
  hasScope: () => true,
}))
vi.mock("~/modules/shell/attention-store", () => ({
  attentionStore: {
    get items() {
      return [
        { id: "kernel:approval_pending:a1", action: { type: "decide_approval", approvalId: "a1" } },
      ]
    },
  },
}))
vi.mock("~/modules/shell/AttentionRow", () => ({
  default: (props: { item: { action: { approvalId: string } } }) => (
    <div data-testid={`waiting-row-${props.item.action.approvalId}`} />
  ),
}))
vi.mock("~/modules/shell/SlotPanels", () => ({
  createSlotPanels: () => () => [],
  SlotEntryView: () => null,
}))
vi.mock("~/modules/shell/entity-opener", () => ({ openEntity: vi.fn() }))
vi.mock("~/modules/threads/EntityDiscussion", () => ({
  default: (props: { prefill?: { text: string } | null }) => (
    <div data-testid="company-discussion-thread" data-prefill={props.prefill?.text ?? ""} />
  ),
}))

beforeEach(() => {
  vi.clearAllMocks()
  resetCompanyStores()
  setShellTier("phone")
  mocks.routes = {
    [`/contacts/companies/${CO}`]: {
      id: CO,
      name: "Maison Arlon",
      domain: "maison-arlon.example",
      description: "Hotel group, 6 hotels",
      orgAccess: "editor",
      createdBy: "u-other",
      peopleCount: 1,
      openDeal: null,
    },
    [`/contacts/companies/${CO}/waiting`]: { approvalIds: ["a1"] },
    [`/contacts/companies/${CO}/activity`]: {
      items: [
        {
          id: "mail:m1",
          at: "2026-11-06T09:00:00Z",
          source: "mail",
          title: "Can we go live before spring?",
          who: "Claire Vidal",
          contactId: null,
          href: null,
        },
      ],
      unavailable: [],
      nextBefore: null,
    },
  }
  mocks.postResult = {
    "kernel:companies_read": {
      people: [
        {
          id: "p-1",
          name: "Claire Vidal",
          email: "claire@maison-arlon.example",
          role: "Operations director",
          isMain: true,
          lastInboundAt: "2026-11-06",
        },
      ],
      accountManager: null,
    },
    [`/contacts/companies/${CO}/discussion`]: { threadId: "t-co" },
  }
})
afterEach(() => {
  cleanup()
  setShellTier("desktop")
})

/** Classes that set a fixed width (or minimum width) wider than the screen, outside a breakpoint. */
function widerThan(px: number): string[] {
  const out: string[] = []
  for (const el of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
    for (const cls of (el.getAttribute("class") ?? "").split(/\s+/)) {
      if (cls.includes(":")) continue
      const m = /^(?:min-)?w-\[(\d+)px\]$/.exec(cls)
      if (m && Number(m[1]) > px) out.push(cls)
    }
  }
  return out
}

describe("Company page at phone width", () => {
  it("the phone page has three tabs and the ask box and no wider element than the screen", async () => {
    render(() => <CompanyDetail entityId={CO} />)
    await screen.findByTestId("company-person-p-1")
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent)
    expect(tabs).toEqual(["Overview", "Timeline", "Discussion"])
    for (const tab of screen.getAllByRole("tab")) expect(tab.className).toContain("min-h-11")
    expect(screen.getByTestId("company-detail.ask-input").className).toContain("min-h-11")
    expect(screen.getByTestId("company-detail.ask-send").className).toContain("h-11")
    // Overview: Waiting (approve and reject are Home's own row), people; no
    // timeline, no discussion pane.
    expect(screen.getByTestId("waiting-row-a1")).toBeTruthy()
    expect(screen.queryByTestId("company-detail.timeline")).toBeNull()
    expect(screen.queryByTestId("company-detail.discussion-pane")).toBeNull()
    expect(widerThan(390)).toEqual([])

    fireEvent.click(screen.getByTestId("company-detail.tab-timeline"))
    await screen.findByTestId("company-activity.row-mail:m1")
    expect(screen.queryByTestId("company-detail.people")).toBeNull()
    expect(screen.getByTestId("company-detail.ask-box")).toBeTruthy()
    expect(widerThan(390)).toEqual([])

    fireEvent.click(screen.getByTestId("company-detail.tab-discussion"))
    expect(await screen.findByTestId("company-discussion-thread")).toBeTruthy()
    expect(screen.queryByTestId("company-detail.ask-box")).toBeNull()
    expect(screen.queryByTestId("company-detail.people")).toBeNull()
    expect(widerThan(390)).toEqual([])
  })

  it("asking from the bottom box opens the discussion with the question in its box", async () => {
    render(() => <CompanyDetail entityId={CO} />)
    await screen.findByTestId("company-person-p-1")
    fireEvent.input(screen.getByTestId("company-detail.ask-input"), {
      target: { value: "What does Claire wait for?" },
    })
    fireEvent.submit(screen.getByTestId("company-detail.ask-box"))
    const thread = await screen.findByTestId("company-discussion-thread")
    expect(thread.getAttribute("data-prefill")).toBe("What does Claire wait for?")
    expect(screen.getByTestId("company-detail.tab-discussion").getAttribute("aria-selected")).toBe(
      "true",
    )
  })

  it("keeps the desktop page as one column with the discussion rail and no tabs", async () => {
    setShellTier("desktop")
    render(() => <CompanyDetail entityId={CO} />)
    await screen.findByTestId("company-person-p-1")
    expect(screen.queryByTestId("company-detail.phone-tabs")).toBeNull()
    expect(screen.queryByTestId("company-detail.ask-box")).toBeNull()
    expect(screen.getByTestId("company-detail.timeline")).toBeTruthy()
    expect(screen.getByTestId("company-detail.discussion-pane")).toBeTruthy()
  })
})
