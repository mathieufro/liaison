// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  api: {},
  searchTargets: vi.fn(),
  selectTarget: vi.fn(),
  setFieldChoice: vi.fn(),
  setStep: vi.fn(),
  confirmMerge: vi.fn().mockResolvedValue({ contact: { id: "target-1" } }),
  closeMerge: vi.fn(),
  loadSourceConversations: vi.fn(),
  mergeStore: {
    open: true,
    step: "search",
    sourceId: "source-1",
    targetId: null as string | null,
    targetCandidates: [] as any[],
    resolvedFields: {} as Record<string, string>,
    sourceConversations: 0,
    loading: false,
  },
}))

vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => mocks.api }))
vi.mock("~/modules/contacts/contact-merge-store", () => ({
  mergeStore: mocks.mergeStore,
  searchTargets: mocks.searchTargets,
  selectTarget: mocks.selectTarget,
  setFieldChoice: mocks.setFieldChoice,
  setStep: mocks.setStep,
  confirmMerge: mocks.confirmMerge,
  closeMerge: mocks.closeMerge,
  loadSourceConversations: mocks.loadSourceConversations,
}))
vi.mock("~/modules/contacts/contact-detail-store", () => ({
  contactDetailStore: {
    contacts: {
      "source-1": { id: "source-1", name: "Source Name", email: "source@example.com" },
      "target-1": { id: "target-1", name: "Target Name", email: "target@example.com" },
    },
  },
}))

describe("ContactMergeDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mergeStore.open = true
    mocks.mergeStore.step = "search"
    mocks.mergeStore.targetId = null
    mocks.mergeStore.targetCandidates = []
    mocks.mergeStore.resolvedFields = {}
  })

  it("counts the source contact's conversations when it opens", async () => {
    const { ContactMergeDialog } = await import("./ContactMergeDialog")

    render(() => <ContactMergeDialog />)

    expect(mocks.loadSourceConversations).toHaveBeenCalledWith(mocks.api)
  })

  it("searches target candidates from the search step", async () => {
    const { ContactMergeDialog } = await import("./ContactMergeDialog")

    render(() => <ContactMergeDialog />)
    fireEvent.input(screen.getByTestId("merge-target-search"), { target: { value: "Alice" } })
    fireEvent.click(screen.getByRole("button", { name: "Search" }))

    expect(mocks.searchTargets).toHaveBeenCalledWith(mocks.api, "Alice")
  })

  it("renders candidates and selects a target", async () => {
    mocks.mergeStore.targetCandidates = [{ id: "target-1", name: "Target", email: "t@x.com" }]
    const { ContactMergeDialog } = await import("./ContactMergeDialog")

    render(() => <ContactMergeDialog />)
    fireEvent.click(screen.getByRole("button", { name: /Target/ }))

    expect(mocks.selectTarget).toHaveBeenCalledWith("target-1")
  })

  it("continues from compare step after resolving fields", async () => {
    mocks.mergeStore.step = "compare"
    mocks.mergeStore.targetId = "target-1"
    const { ContactMergeDialog } = await import("./ContactMergeDialog")

    render(() => <ContactMergeDialog />)
    fireEvent.click(screen.getByLabelText("Source Name"))
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))

    expect(mocks.setFieldChoice).toHaveBeenCalledWith("name", "Source Name")
    expect(mocks.setStep).toHaveBeenCalledWith("confirm")
  })

  it("confirms merge from confirm step", async () => {
    mocks.mergeStore.step = "confirm"
    mocks.mergeStore.targetId = "target-1"
    const { ContactMergeDialog } = await import("./ContactMergeDialog")

    render(() => <ContactMergeDialog />)
    fireEvent.click(screen.getByRole("button", { name: "Confirm Merge" }))

    expect(mocks.confirmMerge).toHaveBeenCalledWith(mocks.api)
  })
})
