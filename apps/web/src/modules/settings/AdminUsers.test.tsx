// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { registerManifestAppData, resetRegistry } from "~/framework/app-registry"
import AdminUsers from "~/modules/settings/AdminUsers"
import { ApiProvider } from "~/modules/shell/ApiContext"

const USER_A = "11111111-1111-4111-8111-111111111111"
const ROLE_SUPPORT = "33333333-3333-4333-8333-333333333333"

function WrappedAdminUsers() {
  return (
    <ApiProvider>
      <AdminUsers />
    </ApiProvider>
  )
}

function renderAdminUsers() {
  render(() => (
    <Router>
      <Route path="*" component={WrappedAdminUsers} />
    </Router>
  ))
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

interface FetchMockOptions {
  users?: any[]
  /** Import placeholders, served under `?kind=imported` (and mixed in without a kind, as before). */
  imported?: any[]
  roles?: any[]
  inviteResponse?: { status: number; body: any }
  /** Answers of the admin deactivate route, one per call (the last repeats). */
  deactivate?: Array<{ status: number; body?: any }>
  reactivate?: { status: number; body?: any }
}

function mockFetch(opts: FetchMockOptions = {}): ReturnType<typeof vi.fn> {
  const users = opts.users ?? []
  const imported = opts.imported ?? []
  const roles = opts.roles ?? []
  let deactivateCalls = 0
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    if (typeof url === "string") {
      if (url.match(/\/admin\/users\/[^/]+\/deactivate/) && method === "POST") {
        const answers = opts.deactivate ?? [{ status: 200, body: { data: { id: USER_A } } }]
        const r = answers[Math.min(deactivateCalls++, answers.length - 1)]!
        return jsonResp(r.body ?? {}, r.status)
      }
      if (url.match(/\/admin\/users\/[^/]+\/reactivate/) && method === "POST") {
        const r = opts.reactivate ?? { status: 200, body: { data: { id: USER_A } } }
        return jsonResp(r.body ?? {}, r.status)
      }
      if (url.includes("/admin/invites") && method === "POST") {
        const r = opts.inviteResponse ?? { status: 200, body: { data: { id: "new" } } }
        return jsonResp(r.body, r.status)
      }
      if (url.includes("/admin/users") && method === "GET") {
        const kind = new URL(url, "http://x").searchParams.get("kind")
        const data =
          kind === "imported" ? imported : kind === "people" ? users : [...imported, ...users]
        return jsonResp({ data, meta: { page: 1, limit: 100, total: data.length } })
      }
      if (url.includes("/admin/roles") && method === "GET") {
        return jsonResp({ data: roles })
      }
    }
    return jsonResp({})
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

beforeEach(() => {
  resetRegistry()
  registerManifestAppData("kernel", {
    bulk: {
      deactivateUsers: {
        label: "Deactivate users",
        underlyingTool: "deactivateUser",
        dispatchMode: "perItem",
        perItemParam: "userId",
        agentTool: "bulkDeactivateUsers",
      },
    },
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe("AdminUsers", () => {
  it("renders users heading", async () => {
    mockFetch()
    renderAdminUsers()
    expect(await screen.findByText("Users")).toBeInTheDocument()
  })

  it("renders role chips per row", async () => {
    mockFetch({
      users: [
        {
          id: USER_A,
          email: "alice@test.com",
          name: "Alice",
          status: "active",
          roles: [{ id: ROLE_SUPPORT, name: "Support" }],
        },
      ],
    })
    renderAdminUsers()
    expect(await screen.findByText("Support")).toBeInTheDocument()
  })

  it("invite dialog loads roles", async () => {
    mockFetch({ roles: [{ id: ROLE_SUPPORT, name: "Support" }] })
    renderAdminUsers()
    const inviteBtn = await screen.findByTestId("admin-users-invite-button")
    fireEvent.click(inviteBtn)
    await waitFor(() => {
      expect(screen.getByTestId("admin-users-invite-role")).toBeInTheDocument()
    })
    await waitFor(() => {
      expect(screen.getByText("Support")).toBeInTheDocument()
    })
  })

  it("surfaces 409 invite errors inline without closing", async () => {
    mockFetch({
      roles: [{ id: ROLE_SUPPORT, name: "Support" }],
      inviteResponse: {
        status: 409,
        body: {
          error: { code: "USER_EXISTS", message: "Email already in use", existingUserId: USER_A },
        },
      },
    })
    renderAdminUsers()
    fireEvent.click(await screen.findByTestId("admin-users-invite-button"))
    await waitFor(() => {
      expect(screen.getByTestId("admin-users-invite-role")).toBeInTheDocument()
    })
    fireEvent.change(screen.getByTestId("admin-users-invite-role"), {
      target: { value: ROLE_SUPPORT },
    })
    const email = screen.getByPlaceholderText("user@example.com") as HTMLInputElement
    fireEvent.input(email, { target: { value: "x@y.com" } })
    fireEvent.submit(email.closest("form")!)
    expect(await screen.findByTestId("admin-users-invite-error")).toHaveTextContent(
      "Email already in use",
    )
  })

  it("an invite refused at the seat limit says so in the reader's language, not the server's text", async () => {
    mockFetch({
      roles: [{ id: ROLE_SUPPORT, name: "Support" }],
      inviteResponse: {
        status: 409,
        body: {
          error: {
            code: "SEAT_LIMIT_REACHED",
            message: "server text",
            details: { limit: 3, used: 3 },
          },
        },
      },
    })
    renderAdminUsers()
    fireEvent.click(await screen.findByTestId("admin-users-invite-button"))
    await waitFor(() => {
      expect(screen.getByTestId("admin-users-invite-role")).toBeInTheDocument()
    })
    fireEvent.change(screen.getByTestId("admin-users-invite-role"), {
      target: { value: ROLE_SUPPORT },
    })
    const email = screen.getByPlaceholderText("user@example.com") as HTMLInputElement
    fireEvent.input(email, { target: { value: "x@y.com" } })
    fireEvent.submit(email.closest("form")!)
    const shown = await screen.findByTestId("admin-users-invite-error")
    expect(shown).toHaveTextContent("This organization uses all of its seats")
    expect(shown).not.toHaveTextContent("server text")
  })

  it("BulkActionToolbar appears when rows are checked", async () => {
    mockFetch({
      users: [
        {
          id: USER_A,
          email: "alice@test.com",
          name: "Alice",
          status: "active",
          roles: [],
        },
      ],
    })
    renderAdminUsers()
    const checkbox = await screen.findByTestId(`admin-users-checkbox-${USER_A}`)
    fireEvent.click(checkbox)
    expect(await screen.findByTestId("bulk-toolbar")).toBeInTheDocument()
  })

  const alice = { id: USER_A, email: "alice@test.com", name: "Alice", status: "active", roles: [] }
  const BOB = "22222222-2222-4222-8222-222222222222"
  const bob = { id: BOB, email: "bob@test.com", name: "Bob", status: "active", roles: [] }

  /** Each deactivate call as the person in its path plus its body. */
  function deactivateBodies(fetchMock: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
    return fetchMock.mock.calls.flatMap((c) => {
      const m = /\/admin\/users\/([^/]+)\/deactivate/.exec(String(c[0]))
      if (!m) return []
      return [{ userId: m[1], ...JSON.parse(String((c[1] as RequestInit).body ?? "{}")) }]
    })
  }

  it("deactivating someone who manages no company asks nothing and deactivates them", async () => {
    const fetchMock = mockFetch({ users: [alice] })
    renderAdminUsers()
    fireEvent.click(await screen.findByTestId(`admin-users-deactivate-${USER_A}`))
    fireEvent.click(await screen.findByTestId("admin-users-deactivate-confirm"))
    await waitFor(() => expect(deactivateBodies(fetchMock)).toEqual([{ userId: USER_A }]))
    expect(screen.queryByTestId("admin-users-deactivate-accounts")).toBeNull()
  })

  it("deactivating an account manager asks who takes their companies, then sends the answer", async () => {
    const fetchMock = mockFetch({
      users: [alice, bob],
      deactivate: [
        {
          status: 409,
          body: {
            error: {
              code: "accounts_to_required",
              message: "Alice manages 3 companies (A, B, C). Say who takes them over.",
            },
          },
        },
        { status: 200, body: { data: { id: USER_A } } },
      ],
    })
    renderAdminUsers()
    fireEvent.click(await screen.findByTestId(`admin-users-deactivate-${USER_A}`))
    const confirm = await screen.findByTestId("admin-users-deactivate-confirm")
    fireEvent.click(confirm)
    const question = await screen.findByTestId("admin-users-deactivate-accounts")
    expect(question.textContent).toContain("3")
    expect(confirm).toBeDisabled()
    const pick = screen.getByTestId("admin-users-deactivate-accounts-to") as HTMLSelectElement
    // The person leaving is not offered.
    expect([...pick.options].map((o) => o.value)).not.toContain(USER_A)
    fireEvent.change(pick, { target: { value: BOB } })
    fireEvent.click(confirm)
    await waitFor(() =>
      expect(deactivateBodies(fetchMock)).toEqual([
        { userId: USER_A },
        { userId: USER_A, accountsTo: BOB },
      ]),
    )
  })

  it("leaving the companies without an account manager sends null", async () => {
    const fetchMock = mockFetch({
      users: [alice, bob],
      deactivate: [
        {
          status: 409,
          body: { error: { code: "accounts_to_required", message: "Alice manages 1 company." } },
        },
        { status: 200, body: { data: { id: USER_A } } },
      ],
    })
    renderAdminUsers()
    fireEvent.click(await screen.findByTestId(`admin-users-deactivate-${USER_A}`))
    const confirm = await screen.findByTestId("admin-users-deactivate-confirm")
    fireEvent.click(confirm)
    const pick = (await screen.findByTestId(
      "admin-users-deactivate-accounts-to",
    )) as HTMLSelectElement
    fireEvent.change(pick, { target: { value: [...pick.options].at(-1)!.value } })
    fireEvent.click(confirm)
    await waitFor(() =>
      expect(deactivateBodies(fetchMock).at(-1)).toEqual({ userId: USER_A, accountsTo: null }),
    )
  })

  describe("import placeholders", () => {
    const REAL_ID = "44444444-4444-4444-8444-444444444444"
    const LEAVER_ID = "55555555-5555-4555-8555-555555555555"
    const PLACEHOLDER_ID = "66666666-6666-4666-8666-666666666666"
    const people = [
      {
        id: REAL_ID,
        email: "sam@test.com",
        name: "Sam Colleague",
        status: "active",
        roles: [{ id: ROLE_SUPPORT, name: "Support" }],
      },
      {
        id: LEAVER_ID,
        email: "bea@test.com",
        name: "Bea Leaver",
        status: "deactivated",
        roles: [],
      },
    ]
    const imported = [
      {
        id: PLACEHOLDER_ID,
        email: "slack-import+sam@import.invalid",
        name: "Sam Colleague",
        status: "deactivated",
        roles: [],
      },
    ]

    it("lists people only by default and counts the imported accounts apart", async () => {
      mockFetch({ users: people, imported })
      renderAdminUsers()
      expect(await screen.findByTestId(`admin-users-row-${REAL_ID}`)).toBeInTheDocument()
      expect(screen.queryByTestId(`admin-users-row-${PLACEHOLDER_ID}`)).toBeNull()
      await waitFor(() => {
        expect(screen.getByTestId("admin-users-view-imported")).toHaveTextContent("Imported (1)")
      })
    })

    it("offers Reactivate to a real deactivated person", async () => {
      mockFetch({ users: people, imported })
      renderAdminUsers()
      expect(await screen.findByTestId(`admin-users-reactivate-${LEAVER_ID}`)).toBeInTheDocument()
    })

    it("shows placeholders under Imported, labelled, without Reactivate", async () => {
      mockFetch({ users: people, imported })
      renderAdminUsers()
      fireEvent.click(await screen.findByTestId("admin-users-view-imported"))
      expect(await screen.findByTestId(`admin-users-row-${PLACEHOLDER_ID}`)).toBeInTheDocument()
      expect(screen.getByTestId("admin-users-imported-note")).toHaveTextContent("cannot sign in")
      expect(screen.getByTestId(`admin-users-status-${PLACEHOLDER_ID}`)).toHaveTextContent(
        "Imported",
      )
      expect(screen.queryByTestId(`admin-users-reactivate-${PLACEHOLDER_ID}`)).toBeNull()
      expect(screen.queryByTestId(`admin-users-row-${REAL_ID}`)).toBeNull()
    })

    // Finding 7 (design audit 2026-09-30): an imported author can be linked to
    // the real person, previewed first, merged only on confirmation.
    it("links an imported author to a real person: preview, then merge", async () => {
      const fetchMock = mockFetch({ users: people, imported })
      const mergeCalls: any[] = []
      const base = fetchMock.getMockImplementation() as (
        u: string,
        i?: RequestInit,
      ) => Promise<Response>
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (typeof url === "string" && url.includes(`/admin/users/${PLACEHOLDER_ID}/merge`)) {
          const body = JSON.parse(String(init?.body ?? "{}"))
          mergeCalls.push(body)
          return jsonResp({
            data: {
              dryRun: body.dryRun === true,
              alreadyMerged: false,
              target: { id: REAL_ID, name: "Real Person" },
              counts: {
                messagesAuthored: 42,
                messagesMentioning: 3,
                reactionsMoved: 5,
                filesMoved: 1,
                participationsMoved: 2,
              },
            },
          })
        }
        return base(url, init)
      })
      renderAdminUsers()
      fireEvent.click(await screen.findByTestId("admin-users-view-imported"))
      fireEvent.click(await screen.findByTestId(`admin-users-merge-${PLACEHOLDER_ID}`))
      const select = (await screen.findByTestId("merge-imported-target")) as HTMLSelectElement
      // Only real, active people are offered: never a placeholder.
      await waitFor(() => expect(select.querySelectorAll("option").length).toBeGreaterThan(1))
      const offered = Array.from(select.querySelectorAll("option")).map((o) => o.value)
      expect(offered).not.toContain(PLACEHOLDER_ID)
      expect(offered).toContain(REAL_ID)
      fireEvent.change(select, { target: { value: REAL_ID } })
      await waitFor(() =>
        expect(screen.getByTestId("merge-imported-preview")).toHaveTextContent("42 messages"),
      )
      expect(mergeCalls).toEqual([{ targetUserId: REAL_ID, dryRun: true }])
      fireEvent.click(screen.getByTestId("merge-imported-confirm"))
      await waitFor(() => expect(mergeCalls.length).toBe(2))
      expect(mergeCalls[1]).toEqual({ targetUserId: REAL_ID })
    })

    it("offers no link action for a real person", async () => {
      mockFetch({ users: people, imported })
      renderAdminUsers()
      expect(await screen.findByTestId(`admin-users-row-${REAL_ID}`)).toBeInTheDocument()
      expect(screen.queryByTestId(`admin-users-merge-${REAL_ID}`)).toBeNull()
    })
  })

  it("keeps Roles, Status and Actions apart at any width", async () => {
    mockFetch({
      users: [
        { id: USER_A, email: "alice@test.com", name: "Alice", status: "deactivated", roles: [] },
      ],
    })
    renderAdminUsers()
    const status = await screen.findByTestId(`admin-users-status-${USER_A}`)
    // A narrow screen scrolls the table sideways instead of squeezing columns together.
    expect(screen.getByTestId("admin-users-table-scroll")).toHaveClass("overflow-x-auto")
    // Every column but the last keeps a gutter; status and actions never wrap into each other.
    const cells = Array.from(screen.getByTestId(`admin-users-row-${USER_A}`).children)
    for (const cell of cells.slice(0, -1)) expect(cell.className).toMatch(/\bpr-\d/)
    expect(status.closest("td")).toHaveClass("whitespace-nowrap")
    expect(cells[cells.length - 1]).toHaveClass("whitespace-nowrap")
    // An empty Roles cell says so rather than collapsing.
    expect(screen.getByTestId(`admin-users-roles-${USER_A}`)).toHaveTextContent("No role")
  })
})
