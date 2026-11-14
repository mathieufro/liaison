// SPDX-License-Identifier: FSL-1.1-ALv2
// The Companies list: search by name or domain, the loading, error, empty and
// no-match states, each row's one line, and the empty state's count of
// companies the reader's contacts already name (hidden when there are none).
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CompanyList } from "./CompanyList"
import { resetCompanyStores } from "./company-store"

const mocks = vi.hoisted(() => ({
  list: [] as unknown[],
  listError: false,
  pending: null as Promise<void> | null,
  proposalGroups: [] as unknown[],
  clusters: [] as unknown[],
  openTab: vi.fn(),
}))

const api = {
  get: vi.fn(),
  getEnvelope: vi.fn(async (_path: string) => {
    if (mocks.pending) await mocks.pending
    if (mocks.listError) throw new Error("boom")
    return { data: mocks.list, meta: { total: mocks.list.length } }
  }),
  post: vi.fn(async (_path: string, body: { toolName: string }) => {
    if (body.toolName === "kernel:companies_propose_from_contacts") {
      return { groups: mocks.proposalGroups }
    }
    if (body.toolName === "kernel:companies_find_duplicates") return { clusters: mocks.clusters }
    return {}
  }),
}

vi.mock("~/modules/shell/ApiContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/shell/ApiContext")>()),
  useApi: () => api,
}))
vi.mock("~/modules/shell/tab-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/shell/tab-store")>()),
  openTab: mocks.openTab,
}))
vi.mock("~/modules/auth/auth-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/auth/auth-store")>()),
  hasScope: () => true,
}))

const arlon = {
  id: "co-1",
  name: "Maison Arlon",
  domain: "maison-arlon.example",
  description: null,
  peopleCount: 3,
  openDeal: { taskId: "d1", stage: "Proposal", amountMinor: 1740000, currency: "EUR" },
  updatedAt: new Date().toISOString(),
}
const kora = {
  id: "co-2",
  name: "Kora Hospitality",
  domain: "kora-hospitality.example",
  description: null,
  peopleCount: 1,
  // A reader without deal access gets the stage only.
  openDeal: { taskId: "d2", stage: "Lead", amountMinor: null, currency: null },
  updatedAt: new Date().toISOString(),
}

beforeEach(() => {
  vi.clearAllMocks()
  resetCompanyStores()
  mocks.list = [arlon, kora]
  mocks.listError = false
  mocks.pending = null
  mocks.proposalGroups = []
  mocks.clusters = []
})
afterEach(() => cleanup())

describe("CompanyList", () => {
  it("the list filters by name and domain and shows its empty, loading and error states", async () => {
    // Loading: skeleton rows while the first read is out.
    let release!: () => void
    mocks.pending = new Promise<void>((r) => {
      release = r
    })
    render(() => <CompanyList entityId="list" />)
    expect(screen.getByTestId("company-list.loading")).toBeTruthy()
    release()
    mocks.pending = null

    // Populated: one line per company; amount only where the reader may see it.
    await screen.findByTestId("company-row-co-1")
    expect(screen.getByTestId("company-row-co-1.summary").textContent).toBe(
      "maison-arlon.example · Deal in Proposal, €17,400.00 · 3 people",
    )
    expect(screen.getByTestId("company-row-co-2.summary").textContent).toBe(
      "kora-hospitality.example · Deal in Lead · 1 person",
    )
    expect(screen.getByTestId("company-list.count").textContent).toBe(
      "2 companies, latest activity first",
    )

    // Search: name or domain goes to the list route as the query.
    mocks.list = [kora]
    fireEvent.input(screen.getByTestId("company-list.search"), {
      target: { value: "kora-hospitality.example" },
    })
    await waitFor(() =>
      expect(api.getEnvelope).toHaveBeenLastCalledWith(
        "/contacts/companies?limit=50&query=kora-hospitality.example",
      ),
    )
    await waitFor(() => expect(screen.queryByTestId("company-row-co-1")).toBeNull())
    expect(screen.getByTestId("company-row-co-2")).toBeTruthy()

    // No match.
    mocks.list = []
    fireEvent.input(screen.getByTestId("company-list.search"), { target: { value: "zzz" } })
    expect((await screen.findByTestId("company-list.no-match")).textContent).toContain("zzz")

    // Error, then Retry reads again.
    mocks.listError = true
    fireEvent.input(screen.getByTestId("company-list.search"), { target: { value: "" } })
    await screen.findByTestId("company-list.error")
    mocks.listError = false
    mocks.list = []
    fireEvent.click(screen.getByTestId("company-list.retry"))

    // Empty: no company at all.
    await screen.findByTestId("company-list.empty")
    expect(screen.queryByTestId("company-list.error")).toBeNull()
  })

  it("the empty state's count is hidden when contacts name no company", async () => {
    mocks.list = []
    mocks.proposalGroups = []
    render(() => <CompanyList entityId="list" />)
    await screen.findByTestId("company-list.empty")
    expect(screen.queryByTestId("company-list.empty-proposal")).toBeNull()
    cleanup()

    resetCompanyStores()
    mocks.proposalGroups = [
      { name: "Maison Arlon", existingCompanyId: null },
      { name: "Hotel Ondine", existingCompanyId: null },
      { name: "Kora", existingCompanyId: "co-2" },
    ]
    render(() => <CompanyList entityId="list" />)
    expect((await screen.findByTestId("company-list.empty-proposal")).textContent).toContain(
      "Your contacts already name 2 companies.",
    )
  })

  it("a company that looks like another carries the duplicate badge", async () => {
    mocks.clusters = [{ ids: ["co-2", "co-9"] }]
    render(() => <CompanyList entityId="list" />)
    await screen.findByTestId("company-row-co-2.duplicate")
    expect(screen.queryByTestId("company-row-co-1.duplicate")).toBeNull()
  })
})
