// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Contacts at phone width (M2-3 T19): 64px touch rows with a swipe rail built
// from the contact's own fields, and a detail page that is not a 760px column
// squeezed into 390px.
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const ALICE = {
  id: "c1",
  handle: "alice",
  name: "Alice Chen",
  email: "alice@test.local",
  phone: "+33600000000",
  company: "Acme",
  externalIds: {},
  metadata: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  lastContactedAt: new Date(Date.now() - 3600_000).toISOString(),
}

const mocks = vi.hoisted(() => ({
  api: { get: vi.fn(async () => ({ panels: [] })), getEnvelope: vi.fn(async () => ({ data: [] })) },
  listStore: { byId: {} as Record<string, any>, ids: [] as string[] },
  detailStore: {
    contacts: {} as Record<string, any>,
    optOuts: {} as Record<string, any>,
    discussions: { c1: "t-c1" } as Record<string, string>,
  },
  openTab: vi.fn(),
  loadContacts: vi.fn(),
}))

vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => mocks.api,
  useOptionalApi: () => mocks.api,
}))
vi.mock("~/modules/shell/entity-preview/EntityPreview", () => ({
  default: (props: any) => <span data-testid="entity-preview">{props.children}</span>,
}))
vi.mock("~/modules/shell/SlotPanels", () => ({ SlotPanels: () => null }))
vi.mock("~/modules/shell/tab-store", () => ({
  openTab: mocks.openTab,
  closeTab: vi.fn(),
  makeTabId: (a: string, b: string) => `${a}:${b}`,
}))
vi.mock("~/modules/contacts/contact-list-store", () => ({
  contactListStore: mocks.listStore,
  loadContacts: mocks.loadContacts,
  loadMoreContacts: vi.fn(),
  hasMore: () => false,
  loading: () => false,
  loadingMore: () => false,
  mode: () => "people" as const,
  query: () => "",
  groupFilter: () => null,
  setGroupFilter: vi.fn(),
  setMode: vi.fn(),
  setQuery: vi.fn(),
  total: () => mocks.listStore.ids.length,
}))
vi.mock("~/modules/contacts/contact-detail-store", () => ({
  contactDetailStore: mocks.detailStore,
  loadContact: vi.fn(async () => undefined),
  loadOptOut: vi.fn(async () => undefined),
  openContactDiscussion: vi.fn(async () => "t-c1"),
  updateContact: vi.fn(),
  deleteContact: vi.fn(),
}))
// The discussion itself (the task's own, docked composer included) is covered
// by its own tests: here only where the page puts it.
vi.mock("~/modules/threads/EntityDiscussion", () => ({
  default: (props: any) => <div data-testid={props.testId} data-thread-id={props.threadId} />,
}))
vi.mock("~/modules/contacts/contact-merge-store", () => ({
  mergeStore: { open: false, step: "search", targetCandidates: [], resolvedFields: {} },
  openMerge: vi.fn(),
  closeMerge: vi.fn(),
  loadSourceConversations: vi.fn(),
  searchTargets: vi.fn(),
  selectTarget: vi.fn(),
  setFieldChoice: vi.fn(),
  confirmMerge: vi.fn(),
}))

import { ContactDetail } from "~/modules/contacts/ContactDetail"
import { ContactList, phoneActions } from "~/modules/contacts/ContactList"
import { setShellTier } from "~/tests/helpers/shell-tier"

describe("Contacts at phone width", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listStore.byId = { c1: { ...ALICE } }
    mocks.listStore.ids = ["c1"]
    mocks.detailStore.contacts = { c1: { ...ALICE } }
    mocks.detailStore.optOuts = {}
  })

  afterEach(() => {
    cleanup()
    setShellTier("desktop")
  })

  it("builds the swipe rail from the fields the contact actually has", () => {
    const t = (key: string) => key
    expect(phoneActions(ALICE as never, t).map((a) => a.label)).toEqual([
      "kernel.contactsActionEmail",
      "kernel.contactsActionCall",
    ])
    expect(phoneActions({ ...ALICE, phone: null } as never, t).map((a) => a.label)).toEqual([
      "kernel.contactsActionEmail",
    ])
    expect(phoneActions({ ...ALICE, phone: null, email: null } as never, t)).toEqual([])
  })

  it("owns a large title at phone and leaves the desktop list without one", () => {
    setShellTier("phone")
    render(() => <ContactList entityId="contacts" />)
    expect(screen.getByTestId("contacts-title")).toHaveTextContent("Contacts")
    cleanup()

    setShellTier("desktop")
    render(() => <ContactList entityId="contacts" />)
    expect(screen.queryByTestId("contacts-title")).toBeNull()
  })

  it("wraps every phone row in a swipe rail, and no desktop row in one", () => {
    setShellTier("phone")
    render(() => <ContactList entityId="contacts" />)
    expect(screen.getByTestId("contact-swipe-c1")).toBeInTheDocument()
    expect(screen.getByTestId("contact-row-c1")).toHaveClass("h-16")
    // A hover preview has no meaning on a touch screen.
    expect(screen.queryByTestId("entity-preview")).toBeNull()
    cleanup()

    setShellTier("desktop")
    render(() => <ContactList entityId="contacts" />)
    expect(screen.queryByTestId("contact-swipe-c1")).toBeNull()
    expect(screen.getByTestId("entity-preview")).toBeInTheDocument()
  })

  it("shows company or address and the last activity on the phone row", () => {
    setShellTier("phone")
    render(() => <ContactList entityId="contacts" />)
    const row = screen.getByTestId("contact-row-c1")
    expect(row).toHaveTextContent("Alice Chen")
    expect(row).toHaveTextContent("Acme")
    expect(screen.getByTestId("contact-row-last-contacted").textContent).not.toBe("")
  })

  it("opens the contact from the phone row", () => {
    setShellTier("phone")
    render(() => <ContactList entityId="contacts" />)
    fireEvent.click(screen.getByTestId("contact-row-c1"))
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: "contact-detail", entityId: "c1" }),
    )
  })

  it("keeps the search field and the mode toggle at phone width", () => {
    setShellTier("phone")
    render(() => <ContactList entityId="contacts" />)
    expect(screen.getByTestId("contacts-search")).toBeInTheDocument()
    expect(screen.getByTestId("contacts-mode-people")).toBeInTheDocument()
  })

  it("gives the detail page the phone reading column, not the 760px one", () => {
    setShellTier("phone")
    render(() => <ContactDetail entityId="c1" />)
    const body = screen.getByTestId("contact-detail-body")
    expect(body.className).not.toContain("max-w-[760px]")
    expect(body.className).not.toContain("px-8")
    expect(body.className).toContain("px-4")
    expect(screen.getByTestId("contact-detail-title")).toHaveTextContent("Alice Chen")
    expect(screen.getByTestId("contact-detail-fields")).toBeInTheDocument()
  })

  it("on the phone the discussion follows the contact's details, in the page's own scroll", async () => {
    setShellTier("phone")
    render(() => <ContactDetail entityId="c1" />)
    const body = screen.getByTestId("contact-detail-body")
    const discussion = await screen.findByTestId("contact-discussion")
    expect(discussion).toHaveAttribute("data-thread-id", "t-c1")
    expect(body.contains(discussion)).toBe(false)
    expect(body.compareDocumentPosition(discussion) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // One column below the side-rail width: the rail's own scroll and border
    // apply only where the page is wide enough for both.
    const layout = screen.getByTestId("contact-detail.layout")
    expect(layout.className).toContain("grid-cols-1")
    expect(layout.className).toContain("overflow-y-auto")
    const pane = screen.getByTestId("contact-detail.discussion-pane")
    expect(pane.className).toContain("border-t")
    expect(pane.className).toContain("@[860px]:overflow-hidden")
  })

  it("keeps the desktop detail column exactly as it was", () => {
    setShellTier("desktop")
    render(() => <ContactDetail entityId="c1" />)
    const body = screen.getByTestId("contact-detail-body")
    expect(body.className).toContain("max-w-[760px]")
    expect(body.className).toContain("px-8")
  })
})
