// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"
import { ApiContext } from "~/modules/shell/ApiContext"
import { DashboardShareDialog } from "./DashboardShareDialog"

vi.mock("~/modules/auth/auth-store", async (orig) => ({
  ...(await orig<typeof import("~/modules/auth/auth-store")>()),
  userFromToken: () => ({ userId: "u-me" }),
}))

const ROLE = "22222222-2222-4222-8222-222222222222"

function makeApi(sharing: Record<string, unknown>) {
  return {
    get: vi.fn(async (path: string) => {
      if (path === "/dashboards/d1/sharing") return { data: sharing }
      if (path === "/sharing/members") {
        return [
          { userId: "u-me", name: "Mia Owner", email: "mia@corp.test" },
          { userId: "u-bob", name: "Bob Builder", email: "bob@corp.test" },
        ]
      }
      if (path === "/sharing/roles") return [{ roleId: ROLE, name: "Board", memberCount: 3 }]
      throw new Error(`Unexpected GET ${path}`)
    }),
    put: vi.fn(async (_path: string, body: unknown) => body),
  }
}

function renderDialog(api: ReturnType<typeof makeApi>, onSaved = vi.fn()) {
  render(() => (
    <ApiContext.Provider value={api as never}>
      <DashboardShareDialog
        dashboardId="d1"
        dashboardTitle="Board view"
        open
        onOpenChange={vi.fn()}
        onSaved={onSaved}
      />
    </ApiContext.Provider>
  ))
  return { onSaved }
}

describe("DashboardShareDialog", () => {
  it("restricts an org dashboard to a role: PUT orgAccess none with the role, no dimensions", async () => {
    const api = makeApi({
      orgAccess: "viewer",
      ownerUserId: "u-me",
      ownerName: "Mia Owner",
      canManage: true,
      users: [],
      roles: [{ roleId: ROLE, role: "viewer", name: "Board" }],
      dimensions: [],
    })
    const { onSaved } = renderDialog(api)
    expect(await screen.findByTestId("dashboard-share-access-viewer")).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    fireEvent.click(screen.getByTestId("dashboard-share-access-none"))
    fireEvent.click(screen.getByTestId("dashboard-share-save"))
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/dashboards/d1/sharing", {
        orgAccess: "none",
        users: [],
        roles: [{ roleId: ROLE, role: "viewer" }],
      }),
    )
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
  })

  it("someone who cannot manage it sees who has access but cannot change it", async () => {
    const api = makeApi({
      orgAccess: "none",
      ownerUserId: "u-bob",
      ownerName: "Bob Builder",
      canManage: false,
      users: [{ userId: "u-me", role: "viewer", name: "Mia Owner" }],
      roles: [],
      dimensions: [],
    })
    renderDialog(api)
    expect(await screen.findByTestId("dashboard-share-read-only")).toBeInTheDocument()
    // Read only: the shared dialog offers no Save at all, so nothing can look saved.
    expect(screen.queryByTestId("dashboard-share-save")).toBeNull()
    expect(api.put).not.toHaveBeenCalled()
  })
})
