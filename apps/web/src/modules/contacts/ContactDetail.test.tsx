// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  // ContactDetail mounts SlotPanels, which calls `api.get('/v1/slots/:slot')`
  // on mount. Without a `get` stub the resource rejects outside any assertion
  // and surfaces as an unhandled rejection. No panels are registered in this
  // suite, so an empty list is the realistic payload.
  api: { get: vi.fn(async () => ({ panels: [] })) },
  loadContact: vi.fn(async () => undefined),
  loadOptOut: vi.fn(async (..._args: unknown[]) => undefined),
  scopes: [] as string[],
  companyStore: { companies: {} as Record<string, any> },
  loadCompany: vi.fn(async (..._args: unknown[]) => null),
  openCompanyTab: vi.fn(),
  openContactDiscussion: vi.fn(async (..._args: unknown[]) => "t-c1"),
  updateContact: vi.fn(),
  deleteContact: vi.fn(),
  openMerge: vi.fn(),
  mergeStore: { open: false, step: "search", targetCandidates: [], resolvedFields: {} },
  contactDetailStore: {
    contacts: {} as Record<string, any>,
    optOuts: {} as Record<string, any>,
    discussions: {} as Record<string, string>,
  },
}))

vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => mocks.api }))
vi.mock("~/modules/auth/auth-store", () => ({
  userFromToken: () => ({ userId: "u-me" }),
  hasScope: (scope: string) => mocks.scopes.includes(scope),
}))
vi.mock("~/modules/contacts/ActivityPanel", () => ({
  ActivityPanel: (props: any) => <div data-testid={props.testId} data-path={props.path} />,
}))
vi.mock("~/modules/contacts/company-store", () => ({
  companyStore: mocks.companyStore,
  loadCompany: mocks.loadCompany,
}))
vi.mock("~/modules/contacts/company-visuals", () => ({
  openCompanyTab: mocks.openCompanyTab,
  dealText: (deal: any) => `Deal in ${deal.stage}`,
}))
vi.mock("~/modules/contacts/contact-detail-store", () => ({
  contactDetailStore: mocks.contactDetailStore,
  loadContact: mocks.loadContact,
  loadOptOut: mocks.loadOptOut,
  openContactDiscussion: mocks.openContactDiscussion,
  updateContact: mocks.updateContact,
  deleteContact: mocks.deleteContact,
}))
vi.mock("~/modules/threads/EntityDiscussion", () => ({
  default: (props: any) => (
    <div
      data-testid={props.testId}
      data-thread-id={props.threadId}
      data-placeholder={props.placeholder}
    />
  ),
}))
vi.mock("~/modules/contacts/contact-merge-store", () => ({
  mergeStore: mocks.mergeStore,
  openMerge: mocks.openMerge,
  closeMerge: vi.fn(),
  searchTargets: vi.fn(),
  selectTarget: vi.fn(),
  setFieldChoice: vi.fn(),
  confirmMerge: vi.fn(),
}))

describe("ContactDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.contactDetailStore.contacts = {
      c1: {
        id: "c1",
        name: "Alice",
        email: "a@x.com",
        phone: "+1",
        company: "Acme",
        externalIds: {},
        metadata: null,
      },
    }
    mocks.contactDetailStore.optOuts = {}
    mocks.companyStore.companies = {}
    mocks.scopes = []
    mocks.contactDetailStore.discussions = {}
  })

  it("loads the contact and asks the opt-out list about its address on mount", async () => {
    const { ContactDetail } = await import("./ContactDetail")

    render(() => <ContactDetail entityId="c1" />)

    expect(mocks.loadContact).toHaveBeenCalledWith(mocks.api, "c1")
    expect(mocks.loadOptOut).toHaveBeenCalledWith(mocks.api, "c1", "a@x.com")
  })

  it("opens the contact's discussion and draws it in the side rail, named for the contact", async () => {
    mocks.contactDetailStore.discussions.c1 = "t-c1"
    const { ContactDetail } = await import("./ContactDetail")
    render(() => <ContactDetail entityId="c1" />)
    expect(mocks.openContactDiscussion).not.toHaveBeenCalled()
    const discussion = await screen.findByTestId("contact-discussion")
    expect(discussion).toHaveAttribute("data-thread-id", "t-c1")
    expect(discussion).toHaveAttribute("data-placeholder", "Write about Alice, or @ an agent")
    const pane = screen.getByTestId("contact-detail.discussion-pane")
    expect(pane.contains(discussion)).toBe(true)
    expect(pane).toHaveTextContent("Discussion")
    // Side by side where both fit, as on a task.
    expect(screen.getByTestId("contact-detail.layout").className).toContain(
      "@[860px]:grid-cols-[minmax(480px,1fr)_380px]",
    )
    // The Notes list and its box are gone.
    expect(screen.queryByTestId("contact-notes")).toBeNull()
  })

  it("asks for the discussion when the page has none yet, and says so when it cannot open", async () => {
    mocks.openContactDiscussion.mockRejectedValueOnce(new Error("nope"))
    const { ContactDetail } = await import("./ContactDetail")
    render(() => <ContactDetail entityId="c1" />)
    expect(mocks.openContactDiscussion).toHaveBeenCalledWith(mocks.api, "c1")
    expect(await screen.findByTestId("contact-discussion.unavailable")).toHaveTextContent(
      "The discussion could not be opened.",
    )
    expect(screen.queryByTestId("contact-discussion")).toBeNull()
  })

  it("says who can see the contact: the organisation, only me, or shared with me", async () => {
    const { ContactDetail } = await import("./ContactDetail")
    const cases: Array<[Record<string, unknown>, string]> = [
      [{}, "organisation"],
      [{ orgAccess: "editor", ownerUserId: "u-me" }, "organisation"],
      [{ orgAccess: "none", ownerUserId: "u-me" }, "private"],
      [{ orgAccess: "none", ownerUserId: null }, "shared"],
    ]
    for (const [sharing, expected] of cases) {
      mocks.contactDetailStore.contacts.c1 = { ...mocks.contactDetailStore.contacts.c1, ...sharing }
      const { unmount } = render(() => <ContactDetail entityId="c1" />)
      expect(screen.getByTestId("contact-visibility")).toHaveAttribute("data-visibility", expected)
      expect(screen.getByTestId("contact-share-open")).toBeInTheDocument()
      unmount()
    }
  })

  it("opens merge flow from header button", async () => {
    const { ContactDetail } = await import("./ContactDetail")

    render(() => <ContactDetail entityId="c1" />)
    fireEvent.click(screen.getByRole("button", { name: "Merge with..." }))

    expect(mocks.openMerge).toHaveBeenCalledWith("c1")
  })

  it("Add to group: ticks the groups the contact is in, adds to another and removes from one (S15)", async () => {
    const { resetContactGroupsStore } = await import("./contact-groups-store")
    resetContactGroupsStore()
    const get = mocks.api.get
    get.mockImplementation((async (path: string) => {
      if (path === "/contacts/groups")
        return {
          data: [
            { id: "g1", name: "VIP", memberCount: 1 },
            { id: "g2", name: "Press", memberCount: 0 },
          ],
        }
      if (path === "/contacts/c1/groups") return { data: [{ id: "g1", name: "VIP" }] }
      return { panels: [] }
    }) as any)
    const post = vi.fn(async (path: string) => ({
      data: { groupId: path.split("/")[3], groupName: "x", changed: 1, unchanged: 0, notFound: [] },
    }))
    ;(mocks.api as any).post = post
    const { ContactDetail } = await import("./ContactDetail")

    render(() => <ContactDetail entityId="c1" />)
    fireEvent.click(screen.getByTestId("contact-add-to-group"))
    await vi.waitFor(() =>
      expect(screen.getByTestId("add-to-group-g1").getAttribute("aria-checked")).toBe("true"),
    )
    expect(screen.getByTestId("add-to-group-g2").getAttribute("aria-checked")).toBe("false")

    fireEvent.click(screen.getByTestId("add-to-group-g2"))
    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith("/contacts/groups/g2/members", { contactIds: ["c1"] }),
    )
    await vi.waitFor(() =>
      expect(screen.getByTestId("add-to-group-g2").getAttribute("aria-checked")).toBe("true"),
    )

    fireEvent.click(screen.getByTestId("add-to-group-g1"))
    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith("/contacts/groups/g1/members/remove", {
        contactIds: ["c1"],
      }),
    )
    get.mockImplementation((async () => ({ panels: [] })) as any)
    delete (mocks.api as any).post
  })
  describe("follow-ups, company and timeline", () => {
    const stateOf = () => screen.getByTestId("contact-follow-ups-state")

    it("an opted-out person shows Opted out with since when and by what", async () => {
      mocks.contactDetailStore.optOuts.c1 = {
        state: "opted_out",
        since: "2026-11-06T09:00:00.000Z",
        by: "link",
      }
      mocks.contactDetailStore.contacts.c1.lawfulBasis = "customer"
      const { ContactDetail } = await import("./ContactDetail")
      render(() => <ContactDetail entityId="c1" />)
      expect(stateOf()).toHaveAttribute("data-state", "opted_out")
      expect(stateOf()).toHaveTextContent("Opted out")
      expect(screen.getByTestId("contact-follow-ups-detail")).toHaveTextContent(
        "Since Nov 6, 2026, by the link in an earlier message.",
      )
      expect(screen.getByTestId("contact-follow-ups")).not.toHaveTextContent("allowed")
    })

    it("an opt-out recorded since the page was open shows on the next load, never the old Allowed", async () => {
      // The page asks on every load; the answer it gets after the proposal was approved wins.
      mocks.contactDetailStore.contacts.c1.lawfulBasis = "customer"
      mocks.contactDetailStore.optOuts.c1 = { state: "allowed" }
      const first = await import("./ContactDetail")
      const view = render(() => <first.ContactDetail entityId="c1" />)
      expect(stateOf()).toHaveAttribute("data-state", "allowed")
      view.unmount()
      mocks.contactDetailStore.optOuts.c1 = { state: "opted_out" }
      render(() => <first.ContactDetail entityId="c1" />)
      expect(mocks.loadOptOut).toHaveBeenLastCalledWith(mocks.api, "c1", "a@x.com")
      expect(stateOf()).toHaveAttribute("data-state", "opted_out")
      expect(screen.queryByTestId("contact-follow-ups-detail")).toBeNull()
    })

    it("a recorded basis reads Allowed with its basis and date", async () => {
      mocks.contactDetailStore.optOuts.c1 = { state: "allowed" }
      mocks.contactDetailStore.contacts.c1.lawfulBasis = "professional_interest"
      mocks.contactDetailStore.contacts.c1.lawfulBasisAt = "2025-03-12T10:00:00.000Z"
      const { ContactDetail } = await import("./ContactDetail")
      render(() => <ContactDetail entityId="c1" />)
      expect(stateOf()).toHaveTextContent("Sales follow-ups allowed: professional interest.")
      expect(screen.getByTestId("contact-follow-ups-detail")).toHaveTextContent(
        "Recorded Mar 12, 2025.",
      )
    })

    it("no basis shows the skipped line and never Allowed", async () => {
      mocks.contactDetailStore.optOuts.c1 = { state: "allowed" }
      mocks.contactDetailStore.contacts.c1.lawfulBasis = null
      const { ContactDetail } = await import("./ContactDetail")
      render(() => <ContactDetail entityId="c1" />)
      expect(stateOf()).toHaveAttribute("data-state", "no_basis")
      expect(stateOf()).toHaveTextContent(
        "No recorded basis. Commercial follow-ups skip this person.",
      )
      expect(screen.getByTestId("contact-follow-ups")).not.toHaveTextContent("allowed")
    })

    it("an opt-out check that could not run never reads Allowed", async () => {
      mocks.contactDetailStore.optOuts.c1 = { state: "unavailable" }
      mocks.contactDetailStore.contacts.c1.lawfulBasis = "customer"
      const { ContactDetail } = await import("./ContactDetail")
      render(() => <ContactDetail entityId="c1" />)
      expect(stateOf()).toHaveAttribute("data-state", "unknown")
      expect(screen.getByTestId("contact-follow-ups")).not.toHaveTextContent("allowed")
    })

    it("the timeline reads only this contact's route, and only with the companies scope", async () => {
      const { ContactDetail } = await import("./ContactDetail")
      const without = render(() => <ContactDetail entityId="c1" />)
      expect(screen.queryByTestId("contact-activity")).toBeNull()
      without.unmount()
      mocks.scopes = ["kernel:companies:read"]
      render(() => <ContactDetail entityId="c1" />)
      expect(screen.getByTestId("contact-activity")).toHaveAttribute(
        "data-path",
        "/contacts/c1/activity",
      )
      // The mail and ticket lists the timeline replaced are gone.
      expect(screen.queryByTestId("contact-ticket-backlinks")).toBeNull()
    })

    it("a readable company shows as a link with its line and opens its page", async () => {
      mocks.scopes = ["kernel:companies:read"]
      mocks.contactDetailStore.contacts.c1.companyId = "co1"
      mocks.companyStore.companies.co1 = {
        id: "co1",
        name: "Maison Arlon",
        domain: "maison-arlon.example",
        openDeal: { stage: "Proposal" },
      }
      const { ContactDetail } = await import("./ContactDetail")
      render(() => <ContactDetail entityId="c1" />)
      fireEvent.click(screen.getByTestId("contact-company-link"))
      expect(mocks.openCompanyTab).toHaveBeenCalledWith("co1", "Maison Arlon")
      expect(screen.getByTestId("contact-company-line")).toHaveTextContent("Deal in Proposal")
      expect(screen.getByTestId("contact-activity.scope-note")).toHaveTextContent(
        "Everything at the company is on Maison Arlon.",
      )
    })

    it("a restricted company shows the company text with no link and no error", async () => {
      mocks.scopes = ["kernel:companies:read"]
      mocks.contactDetailStore.contacts.c1.companyId = "co1"
      mocks.companyStore.companies.co1 = null
      const { ContactDetail } = await import("./ContactDetail")
      render(() => <ContactDetail entityId="c1" />)
      expect(screen.queryByTestId("contact-company-link")).toBeNull()
      expect(screen.getByTestId("contact-company-input")).toBeInTheDocument()
      expect(screen.queryByRole("alert")).toBeNull()
    })
  })
})
