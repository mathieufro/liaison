// SPDX-License-Identifier: FSL-1.1-ALv2
// The company page: its sections in their set order, Waiting only when the
// reader has approvals linked to the company, no access for a company not
// shared with them, no actions for a reader who cannot write, Add person
// linking through the company route, and the tab labelled by the company.
// Then its states: the duplicate panel (keep apart with Undo, a merge held 8
// seconds), the timeline's notices and lines, and the account manager changed
// in place.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import { ActivityPanel } from "./ActivityPanel"
import { CompanyDetail } from "./CompanyDetail"
import { duplicateIds, loadCompany, resetCompanyStores } from "./company-store"
import { resolveCompanyTabLabel } from "./exports"

const mocks = vi.hoisted(() => ({
  routes: {} as Record<string, unknown>,
  posts: [] as Array<{ path: string; body: unknown }>,
  postResult: {} as Record<string, unknown>,
  scopes: ["*"] as string[],
  items: [] as Array<Record<string, unknown>>,
  slots: [] as Array<{ panel: Record<string, unknown>; component: unknown }>,
  openTab: vi.fn(),
}))

function respond(path: string): unknown {
  const key = Object.keys(mocks.routes).find((k) => path === k || path.startsWith(`${k}?`))
  if (!key) throw new ApiError("Not found", 404)
  const value = mocks.routes[key]
  if (value instanceof Error) throw value
  return value
}

const api = {
  get: vi.fn(async (path: string) => respond(path)),
  getEnvelope: vi.fn(async (path: string) => respond(path)),
  post: vi.fn(async (path: string, body?: unknown) => {
    mocks.posts.push({ path, body })
    if (path === "/apps/run-tool") {
      const tool = (body as { toolName: string }).toolName
      return mocks.postResult[tool] ?? {}
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
  userFromToken: () => ({ userId: "u-me", name: "Me", scopes: mocks.scopes }),
  hasScope: (scope: string) =>
    mocks.scopes.includes("*") || mocks.scopes.some((s) => scope.startsWith(s)),
}))
vi.mock("~/modules/shell/tab-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/shell/tab-store")>()),
  openTab: mocks.openTab,
}))
vi.mock("~/modules/shell/attention-store", () => ({
  attentionStore: {
    get items() {
      return mocks.items
    },
  },
}))
vi.mock("~/modules/shell/AttentionRow", () => ({
  default: (props: { item: { action: { approvalId: string } } }) => (
    <div data-testid={`waiting-row-${props.item.action.approvalId}`} />
  ),
}))
vi.mock("~/modules/shell/SlotPanels", () => ({
  createSlotPanels: () => () => mocks.slots,
  SlotEntryView: (props: { entry: { panel: { id: string } } }) => (
    <div data-testid={`slot-entry-${props.entry.panel.id}`} />
  ),
}))
vi.mock("~/modules/shell/entity-opener", () => ({ openEntity: vi.fn() }))
// Flatten PopupMenu: trigger and content inline, open from the start, so a
// menu's items are clicked as plain elements.
vi.mock("~/ui/PopupMenu", () => {
  const Root = (props: any) => {
    props.onOpenChange?.(true)
    return <>{props.children}</>
  }
  const Trigger = (props: any) => <>{props.children}</>
  const Content = (props: any) => <div role="menu">{props.children}</div>
  const Item = (props: any) => (
    <button
      type="button"
      role="menuitem"
      data-testid={props["data-testid"]}
      onClick={() => props.onSelect?.()}
    >
      {props.children}
    </button>
  )
  const Separator = () => <hr />
  return { PopupMenu: Object.assign(Root, { Trigger, Content, Item, Separator }) }
})
vi.mock("~/modules/threads/EntityDiscussion", () => ({
  default: (props: { prefill?: { text: string } | null }) => (
    <div data-testid="company-discussion-thread" data-prefill={props.prefill?.text ?? ""} />
  ),
}))

const CO = "co-1"
const company = (extra: Record<string, unknown> = {}) => ({
  id: CO,
  name: "Maison Arlon",
  domain: "maison-arlon.example",
  description: "Hotel group, 6 hotels",
  orgAccess: "editor",
  createdBy: "u-other",
  peopleCount: 2,
  openDeal: { taskId: "deal-1", stage: "Proposal", amountMinor: 1740000, currency: "EUR" },
  ...extra,
})

const approvalItem = (approvalId: string) => ({
  id: `kernel:approval_pending:${approvalId}`,
  action: { type: "decide_approval", approvalId },
})

function seedWorld(): void {
  mocks.routes = {
    [`/contacts/companies/${CO}`]: company(),
    [`/contacts/companies/${CO}/waiting`]: { approvalIds: ["a-company", "a-person", "a-deal"] },
    [`/contacts/companies/${CO}/sharing`]: { users: [], roles: [] },
    "/contacts": {
      data: [
        { id: "p-new", name: "Julien Ferrand", email: "julien@maison-arlon.example" },
        { id: "p-in", name: "Claire Vidal", email: "claire@maison-arlon.example", companyId: CO },
      ],
    },
  }
  mocks.postResult = {
    "kernel:companies_read": {
      people: [
        {
          id: "p-1",
          name: "Claire Vidal",
          email: "c@x.example",
          role: null,
          isMain: true,
          lastInboundAt: "2026-11-01",
        },
        {
          id: "p-2",
          name: "Amandine Roux",
          email: "a@x.example",
          role: null,
          isMain: false,
          lastInboundAt: "2026-11-05",
        },
      ],
      accountManager: { id: "u-elodie", name: "Elodie Renard", away: null },
    },
    [`/contacts/companies/${CO}/discussion`]: { threadId: "t-co" },
  }
  mocks.items = [
    approvalItem("a-company"),
    approvalItem("a-person"),
    approvalItem("a-deal"),
    approvalItem("a-other-company"),
    { id: "kernel:alert:x", action: { type: "open_entity" } },
  ]
  mocks.slots = [
    {
      panel: { id: "work-projects", app: "projects", group: "work", label: "Work" },
      component: null,
    },
    {
      panel: { id: "money-invoices", app: "invoicing", group: "money", label: "Money" },
      component: null,
    },
    {
      panel: { id: "support-tickets", app: "tickets", group: "support", label: "Support" },
      component: null,
    },
  ]
}

beforeEach(() => {
  vi.clearAllMocks()
  resetCompanyStores()
  mocks.posts = []
  mocks.scopes = ["*"]
  seedWorld()
})
afterEach(() => cleanup())

/** The page's sections, by test id, in document order. */
function sectionOrder(): string[] {
  const all = Array.from(document.querySelectorAll("[data-testid]")).map(
    (el) => el.getAttribute("data-testid") ?? "",
  )
  const wanted = [
    "company-detail.actions",
    "company-detail.waiting",
    "company-detail.people",
    "company-detail.deals",
    "company-detail.section-money",
    "company-detail.section-support",
    "company-detail.section-work",
    "company-detail.timeline",
    "company-detail.discussion",
  ]
  return all.filter((id) => wanted.includes(id))
}

describe("CompanyDetail", () => {
  it("sections render in their set order and Waiting only when it has rows", async () => {
    render(() => <CompanyDetail entityId={CO} />)
    await screen.findByTestId("company-detail.waiting")
    await screen.findByTestId("company-person-p-1")
    expect(sectionOrder()).toEqual([
      "company-detail.actions",
      "company-detail.waiting",
      "company-detail.people",
      "company-detail.deals",
      "company-detail.section-money",
      "company-detail.section-support",
      "company-detail.section-work",
      "company-detail.timeline",
      "company-detail.discussion",
    ])
    // People: the most recent mail first.
    const people = screen.getAllByTestId(/^company-person-/).map((el) => el.dataset.testid)
    expect(people).toEqual(["company-person-p-2", "company-person-p-1"])
    expect(screen.getByTestId("company-detail.manager").textContent).toContain("Elodie Renard")
    expect(screen.getByTestId(`company-deal-deal-1`).textContent).toContain("Proposal")

    cleanup()
    resetCompanyStores()
    mocks.routes[`/contacts/companies/${CO}/waiting`] = { approvalIds: [] }
    render(() => <CompanyDetail entityId={CO} />)
    await screen.findByTestId("company-person-p-1")
    expect(screen.queryByTestId("company-detail.waiting")).toBeNull()
  })

  it("Waiting lists the viewer's pending approvals linked to this company, its people or its deals, and not another company's", async () => {
    render(() => <CompanyDetail entityId={CO} />)
    await screen.findByTestId("company-detail.waiting")
    const rows = screen.getAllByTestId(/^waiting-row-/).map((el) => el.dataset.testid)
    expect(rows).toEqual(["waiting-row-a-company", "waiting-row-a-person", "waiting-row-a-deal"])
    expect(screen.queryByTestId("waiting-row-a-other-company")).toBeNull()
  })

  it("a company not shared with me shows no access", async () => {
    mocks.routes[`/contacts/companies/${CO}`] = new ApiError("Company not found", 404)
    render(() => <CompanyDetail entityId={CO} />)
    await screen.findByTestId("company-detail.no-access")
    expect(screen.queryByTestId("company-detail.title")).toBeNull()
    expect(mocks.posts.find((p) => p.path === "/apps/run-tool")).toBeUndefined()
  })

  it("a reader without write sees no action buttons", async () => {
    mocks.scopes = ["kernel:contacts:read", "kernel:companies:read"]
    render(() => <CompanyDetail entityId={CO} />)
    await screen.findByTestId("company-detail.title")
    expect(screen.queryByTestId("company-detail.actions")).toBeNull()
    expect(screen.queryByTestId("company-detail.add-person")).toBeNull()
    expect(screen.queryByTestId("company-detail.merge")).toBeNull()
  })

  it("a private company of mine with nobody else says only I see it", async () => {
    mocks.routes[`/contacts/companies/${CO}`] = company({ orgAccess: "none", createdBy: "u-me" })
    render(() => <CompanyDetail entityId={CO} />)
    await waitFor(() =>
      expect(screen.getByTestId("company-detail.visibility").dataset.visibility).toBe("only-you"),
    )
    expect(screen.getByTestId("company-detail.visibility").textContent).toContain(
      "Only you see this company",
    )
  })

  it("adding a person links them and writes the company name", async () => {
    render(() => <CompanyDetail entityId={CO} />)
    fireEvent.click(await screen.findByTestId("company-detail.add-person"))
    fireEvent.input(screen.getByTestId("company-detail.add-search"), {
      target: { value: "Julien" },
    })
    // Someone already at the company is not offered again.
    fireEvent.click(await screen.findByTestId("company-detail.add-hit-p-new"))
    expect(screen.queryByTestId("company-detail.add-hit-p-in")).toBeNull()
    await waitFor(() =>
      expect(mocks.posts).toContainEqual({
        path: `/contacts/companies/${CO}/contacts`,
        body: { contactIds: ["p-new"] },
      }),
    )
    expect((await screen.findByTestId("company-detail.add-message")).textContent).toBe(
      "Julien Ferrand now works at Maison Arlon.",
    )
  })
})

describe("company tab label", () => {
  it("a company tab is labelled with the company's name and an unshared one opens as no access", async () => {
    expect(resolveCompanyTabLabel(CO)).toBeUndefined()
    await loadCompany(api as never, CO)
    expect(resolveCompanyTabLabel(CO)).toBe("Maison Arlon")
    mocks.routes["/contacts/companies/co-hidden"] = new ApiError("Company not found", 404)
    await loadCompany(api as never, "co-hidden")
    expect(resolveCompanyTabLabel("co-hidden")).toBe("No access")
  })
})

const ACTIVITY = `/contacts/companies/${CO}/activity`
const row = (id: string, source: string, at: string, title: string) => ({
  id: `${source}:${id}`,
  at,
  source,
  title,
  who: null,
  contactId: null,
  href: null,
})

function postsTo(tool: string): unknown[] {
  return mocks.posts
    .filter(
      (p) => p.path === "/apps/run-tool" && (p.body as { toolName: string }).toolName === tool,
    )
    .map((p) => (p.body as { params: unknown }).params)
}

function seedDuplicate(): void {
  mocks.postResult["kernel:companies_find_duplicates"] = {
    clusters: [
      {
        ids: [CO, "co-2"],
        names: ["Maison Arlon", "MAISON ARLON SAS"],
        signal: "same_domain",
        confidence: "needs_confirmation",
      },
    ],
  }
  mocks.routes["/contacts/companies/co-2"] = company({
    id: "co-2",
    name: "MAISON ARLON SAS",
    peopleCount: 1,
    openDeal: null,
  })
}

describe("CompanyDetail states", () => {
  it("opening the page reads the timeline once", async () => {
    // Each extra read asks every source again, the slow ones included.
    mocks.routes[ACTIVITY] = {
      rows: [row("t1", "tickets", "2026-11-05T10:00:00Z", "Ticket opened")],
      nextBefore: null,
      unavailable: [],
    }
    render(() => <CompanyDetail entityId={CO} />)
    await screen.findByTestId("company-detail.people")
    await waitFor(() => expect(api.get.mock.calls.some(([p]) => p.startsWith(ACTIVITY))).toBe(true))
    await new Promise((r) => setTimeout(r, 50))
    expect(api.get.mock.calls.filter(([p]) => p.startsWith(ACTIVITY)).length).toBe(1)
  })

  it("the Deals section names the newest open deal and opens its board", async () => {
    mocks.routes[`/contacts/companies/${CO}`] = company({
      openDeal: {
        taskId: "deal-1",
        title: "Rooms refit",
        projectId: "pipe-1",
        stage: "Proposal",
        amountMinor: 1740000,
        currency: "EUR",
      },
    })
    render(() => <CompanyDetail entityId={CO} />)
    const deal = await screen.findByTestId("company-deal-deal-1")
    expect(deal.textContent).toContain("Rooms refit")
    fireEvent.click(screen.getByTestId("company-detail.open-board"))
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: "projects:project", entityId: "pipe-1" }),
    )
  })

  it("two views of one timeline opened together share one read", async () => {
    // Measured in the browser: every company open read its timeline twice at
    // once, doubling the load on the slow sources until one timed out.
    let release: (v: unknown) => void = () => {}
    mocks.routes[ACTIVITY] = new Promise((r) => {
      release = r
    })
    render(() => (
      <>
        <ActivityPanel path={ACTIVITY} testId="a1" title="A" emptyText="none" />
        <ActivityPanel path={ACTIVITY} testId="a2" title="B" emptyText="none" />
      </>
    ))
    release({
      items: [row("t1", "tickets", "2026-11-05T10:00:00Z", "Ticket opened")],
      unavailable: [],
    })
    await screen.findAllByText("Ticket opened")
    expect(api.get.mock.calls.filter(([p]) => p.startsWith(ACTIVITY)).length).toBe(1)
    expect(screen.getAllByText("Ticket opened")).toHaveLength(2)
  })

  it("Not the same removes the duplicate badge, and Undo brings it back", async () => {
    seedDuplicate()
    render(() => <CompanyDetail entityId={CO} />)
    await screen.findByTestId("company-detail.duplicate")
    expect([...duplicateIds()].sort()).toEqual([CO, "co-2"])

    fireEvent.click(screen.getByTestId("company-detail.duplicate-keep"))
    await screen.findByTestId("company-detail.kept-apart")
    expect(postsTo("kernel:companies_mark_not_same")).toEqual([
      { aId: CO, bId: "co-2", undo: false },
    ])
    expect(screen.queryByTestId("company-detail.duplicate")).toBeNull()
    expect(duplicateIds().size).toBe(0)

    fireEvent.click(screen.getByTestId("company-detail.kept-apart-undo"))
    await screen.findByTestId("company-detail.duplicate")
    expect(postsTo("kernel:companies_mark_not_same")[1]).toEqual({
      aId: CO,
      bId: "co-2",
      undo: true,
    })
    expect([...duplicateIds()].sort()).toEqual([CO, "co-2"])
  })

  it("closing the page inside the 8 seconds merges nothing", async () => {
    seedDuplicate()
    const { unmount } = render(() => <CompanyDetail entityId={CO} />)
    await screen.findByTestId("company-detail.duplicate-merge")
    vi.useFakeTimers()
    try {
      fireEvent.click(screen.getByTestId("company-detail.duplicate-merge"))
      expect(screen.getByTestId("company-detail.duplicate-holding")).toBeTruthy()
      await vi.advanceTimersByTimeAsync(7999)
      expect(postsTo("kernel:companies_merge")).toEqual([])
      unmount()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(postsTo("kernel:companies_merge")).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it("Undo inside the 8 seconds merges nothing; left alone, the other company is merged into this one", async () => {
    seedDuplicate()
    render(() => <CompanyDetail entityId={CO} />)
    await screen.findByTestId("company-detail.duplicate-merge")
    vi.useFakeTimers()
    try {
      fireEvent.click(screen.getByTestId("company-detail.duplicate-merge"))
      fireEvent.click(screen.getByTestId("company-detail.duplicate-undo"))
      await vi.advanceTimersByTimeAsync(10_000)
      expect(postsTo("kernel:companies_merge")).toEqual([])

      fireEvent.click(screen.getByTestId("company-detail.duplicate-merge"))
      await vi.advanceTimersByTimeAsync(8000)
      expect(postsTo("kernel:companies_merge")).toEqual([{ sourceId: "co-2", targetId: CO }])
    } finally {
      vi.useRealTimers()
    }
    expect((await screen.findByTestId("company-detail.duplicate-note")).textContent).toBe(
      "MAISON ARLON SAS is merged into Maison Arlon.",
    )
  })

  it("on a new copy's page, Merge keeps the established company and merges the copy into it", async () => {
    // The minute-old copy has nobody and no deal; the other one has both.
    seedDuplicate()
    mocks.routes[`/contacts/companies/${CO}`] = company({ peopleCount: 0, openDeal: null })
    mocks.routes["/contacts/companies/co-2"] = company({
      id: "co-2",
      name: "MAISON ARLON SAS",
      peopleCount: 3,
    })
    render(() => <CompanyDetail entityId={CO} />)
    await waitFor(() =>
      expect(screen.getByTestId("company-detail.duplicate-merge").textContent).toContain(
        "MAISON ARLON SAS",
      ),
    )
    vi.useFakeTimers()
    try {
      fireEvent.click(screen.getByTestId("company-detail.duplicate-merge"))
      expect(screen.getByTestId("company-detail.duplicate-holding").textContent).toContain(
        "Maison Arlon merges into MAISON ARLON SAS",
      )
      await vi.advanceTimersByTimeAsync(8000)
      expect(postsTo("kernel:companies_merge")).toEqual([{ sourceId: CO, targetId: "co-2" }])
    } finally {
      vi.useRealTimers()
    }
  })

  it("one source failing shows one notice with Retry and the rest", async () => {
    mocks.routes[ACTIVITY] = {
      items: [
        row("m1", "mail", "2026-11-06T09:00:00Z", "Can we go live before spring?"),
        row("t1", "tickets", "2026-11-04T09:00:00Z", "TICK-412 opened"),
      ],
      unavailable: [{ source: "invoicing", label: "Invoicing", reason: "timeout" }],
      nextBefore: null,
    }
    render(() => <CompanyDetail entityId={CO} />)
    const notice = await screen.findByTestId("company-activity.unavailable-invoicing")
    expect(notice.textContent).toContain("Invoicing did not answer")
    expect(screen.getAllByTestId(/^company-activity\.unavailable-/)).toHaveLength(1)
    expect(screen.getByTestId("company-activity.row-mail:m1")).toBeTruthy()
    expect(screen.getByTestId("company-activity.row-tickets:t1")).toBeTruthy()
    // The filter offers only the sources that returned rows.
    expect(screen.getByTestId("company-activity.filter-mail")).toBeTruthy()
    expect(screen.getByTestId("company-activity.filter-tickets")).toBeTruthy()
    expect(screen.queryByTestId("company-activity.filter-invoicing")).toBeNull()

    mocks.routes[ACTIVITY] = {
      items: [row("i1", "invoicing", "2026-11-03T09:00:00Z", "F-2026-0418 issued")],
      unavailable: [],
      nextBefore: null,
    }
    fireEvent.click(screen.getByTestId("company-activity.retry-invoicing"))
    await screen.findByTestId("company-activity.row-invoicing:i1")
    expect(api.get).toHaveBeenCalledWith(`${ACTIVITY}?limit=30&source=invoicing`)
    expect(screen.queryByTestId("company-activity.unavailable-invoicing")).toBeNull()
    const order = screen.getAllByTestId(/^company-activity\.row-/).map((el) => el.dataset.testid)
    expect(order).toEqual([
      "company-activity.row-mail:m1",
      "company-activity.row-tickets:t1",
      "company-activity.row-invoicing:i1",
    ])

    fireEvent.click(screen.getByTestId("company-activity.filter-tickets"))
    expect(screen.getAllByTestId(/^company-activity\.row-/)).toHaveLength(1)
  })

  it("a source that ran out of time is asked once more on its own and its rows replace the notice", async () => {
    mocks.routes[ACTIVITY] = {
      items: [row("m1", "mail", "2026-11-06T09:00:00Z", "Can we go live before spring?")],
      unavailable: [{ source: "invoicing", label: "Invoicing", reason: "timeout" }],
      nextBefore: null,
    }
    render(() => <CompanyDetail entityId={CO} />)
    const notice = await screen.findByTestId("company-activity.unavailable-invoicing")
    expect(notice.textContent).toContain("Invoicing did not answer")
    // The slow source answers on the second ask, with no click.
    mocks.routes[ACTIVITY] = {
      items: [row("i1", "invoicing", "2026-11-03T09:00:00Z", "F-2026-0418 issued")],
      unavailable: [],
      nextBefore: null,
    }
    await screen.findByTestId("company-activity.row-invoicing:i1", {}, { timeout: 3000 })
    expect(screen.queryByTestId("company-activity.unavailable-invoicing")).toBeNull()
    expect(screen.queryByTestId("company-activity.error")).toBeNull()
    const asks = api.get.mock.calls.filter(([p]) => p === `${ACTIVITY}?limit=30&source=invoicing`)
    expect(asks).toHaveLength(1)
    expect(screen.getAllByTestId(/^company-activity\.row-/).map((el) => el.dataset.testid)).toEqual(
      ["company-activity.row-mail:m1", "company-activity.row-invoicing:i1"],
    )
  })

  it("a source still silent on the second ask keeps its notice and is not asked a third time", async () => {
    mocks.routes[ACTIVITY] = {
      items: [row("m1", "mail", "2026-11-06T09:00:00Z", "Hello")],
      unavailable: [{ source: "invoicing", label: "Invoicing", reason: "timeout" }],
      nextBefore: null,
    }
    render(() => <CompanyDetail entityId={CO} />)
    await screen.findByTestId("company-activity.unavailable-invoicing")
    const asked = () =>
      api.get.mock.calls.filter(([p]) => p === `${ACTIVITY}?limit=30&source=invoicing`).length
    await waitFor(() => expect(asked()).toBe(1), { timeout: 3000 })
    await new Promise((r) => setTimeout(r, 1500))
    expect(asked()).toBe(1)
    expect(screen.getByTestId("company-activity.unavailable-invoicing")).toBeTruthy()
    expect(screen.getByTestId("company-activity.row-mail:m1")).toBeTruthy()
  })

  it("the timeline says it shows the 50 most recently active people when more are linked", async () => {
    mocks.routes[ACTIVITY] = {
      items: [row("m1", "mail", "2026-11-06T09:00:00Z", "Hello")],
      unavailable: [],
      nextBefore: null,
      truncatedContacts: 10,
    }
    render(() => <CompanyDetail entityId={CO} />)
    expect((await screen.findByTestId("company-activity.truncated-people")).textContent).toBe(
      "Showing activity for the 50 most recently active people",
    )
    cleanup()
    mocks.routes[ACTIVITY] = { items: [], unavailable: [], nextBefore: null }
    render(() => <CompanyDetail entityId={CO} />)
    await screen.findByTestId("company-activity.empty")
    expect(screen.queryByTestId("company-activity.truncated-people")).toBeNull()
  })

  it("a writer changes the manager in place; a reader sees the name only; the picker shows away dates", async () => {
    mocks.routes[ACTIVITY] = { items: [], unavailable: [], nextBefore: null }
    mocks.routes["/mentions/members"] = {
      data: [
        { id: "u-tom", name: "Tom Reyes", email: "tom@x.example", away: null },
        {
          id: "u-ines",
          name: "Ines Caron",
          email: "ines@x.example",
          away: { until: "2099-12-20" },
        },
      ],
      meta: { total: 2 },
    }
    mocks.postResult["kernel:companies_write"] = {
      accountManager: { id: "u-tom", name: "Tom Reyes", away: null },
      moved: [{ id: CO, name: "Maison Arlon" }],
      skipped: [],
    }
    render(() => <CompanyDetail entityId={CO} />)
    await waitFor(() =>
      expect(screen.getByTestId("company-manager.trigger").textContent).toContain("Elodie Renard"),
    )
    expect(screen.getByTestId("company-manager.none").textContent).toBe("No account manager")
    expect((await screen.findByTestId("company-manager.away-u-ines")).textContent).toContain("Dec")
    expect(screen.queryByTestId("company-manager.away-u-tom")).toBeNull()
    const timelineReads = () =>
      api.get.mock.calls.filter(([p]) => String(p).startsWith(ACTIVITY)).length
    const before = timelineReads()

    fireEvent.click(screen.getByTestId("company-manager.option-u-tom"))
    await waitFor(() =>
      expect(screen.getByTestId("company-manager.trigger").textContent).toContain("Tom Reyes"),
    )
    expect(postsTo("kernel:companies_write")).toEqual([{ companyId: CO, ownerUserId: "u-tom" }])
    // No dialog, no Save: the pick saved, and the timeline was read again.
    expect(screen.queryByRole("dialog")).toBeNull()
    await waitFor(() => expect(timelineReads()).toBe(before + 1))

    cleanup()
    resetCompanyStores()
    mocks.scopes = ["kernel:contacts:read", "kernel:companies:read"]
    render(() => <CompanyDetail entityId={CO} />)
    await waitFor(() =>
      expect(screen.getByTestId("company-detail.manager").textContent).toContain("Elodie Renard"),
    )
    expect(screen.queryByTestId("company-manager.trigger")).toBeNull()
  })

  it("a new company with nobody linked offers the two agent prompts, which fill the discussion box", async () => {
    mocks.postResult["kernel:companies_read"] = { people: [], accountManager: null }
    render(() => <CompanyDetail entityId={CO} />)
    fireEvent.click(await screen.findByTestId("company-detail.ask-link-mail"))
    expect(screen.getByTestId("company-detail.ask-find-people")).toBeTruthy()
    expect(
      (await screen.findByTestId("company-discussion-thread")).getAttribute("data-prefill"),
    ).toBe("Link the people who wrote to us from maison-arlon.example to Maison Arlon.")
  })
})
