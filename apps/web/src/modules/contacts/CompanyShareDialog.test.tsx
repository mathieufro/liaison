// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"
import { ApiContext } from "~/modules/shell/ApiContext"
import { CompanyShareDialog } from "./CompanyShareDialog"

// The signed-in person is the company's creator.
vi.mock("~/modules/auth/auth-store", async (orig) => ({
  ...(await orig<typeof import("~/modules/auth/auth-store")>()),
  userFromToken: () => ({ userId: "u-self" }),
}))

function makeApi(sharing: () => Promise<unknown>) {
  return {
    get: vi.fn(async (path: string) => {
      if (path === "/contacts/companies/co1/sharing") return sharing()
      if (path === "/sharing/members") {
        return [
          { userId: "u-self", name: "Elodie Creator", email: "elodie@corp.test" },
          { userId: "u-bob", name: "Bob Builder", email: "bob@corp.test" },
        ]
      }
      if (path === "/sharing/roles") return []
      throw new Error(`Unexpected GET ${path}`)
    }),
    put: vi.fn(async (_path: string, body: unknown) => body),
  }
}

function renderDialog(api: ReturnType<typeof makeApi>, onSaved = vi.fn()) {
  const onOpenChange = vi.fn()
  render(() => (
    <ApiContext.Provider value={api as never}>
      <CompanyShareDialog
        companyId="co1"
        companyName="Studio Bleu"
        open
        onOpenChange={onOpenChange}
        onSaved={onSaved}
      />
    </ApiContext.Provider>
  ))
  return { onOpenChange, onSaved }
}

describe("CompanyShareDialog", () => {
  it("whoever manages the company restricts it and shares it with one person: Save sends the change", async () => {
    const api = makeApi(async () => ({
      orgAccess: "editor",
      canManage: true,
      users: [],
      roles: [],
      dimensions: [],
    }))
    const { onOpenChange, onSaved } = renderDialog(api)

    fireEvent.click(await screen.findByTestId("company-share-access-none"))
    const add = screen.getByTestId("company-share-add-person")
    fireEvent.click(add)
    fireEvent.click(await screen.findByTestId("company-share-add-option-u-bob"))
    fireEvent.click(screen.getByTestId("company-share-save"))

    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/contacts/companies/co1/sharing", {
        orgAccess: "none",
        users: [{ userId: "u-bob", role: "viewer" }],
        roles: [],
        dimensions: [],
      }),
    )
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(onSaved).toHaveBeenCalled()
  })

  it("opens with General access in reach, not covered by the people list, and never offers the person themselves", async () => {
    // Mutations caught: the list opened on the input's focus when the dialog opened, over
    // General access; and it offered the creator to herself.
    const api = makeApi(async () => ({
      orgAccess: "editor",
      canManage: true,
      users: [],
      roles: [],
      dimensions: [],
    }))
    renderDialog(api)
    const none = await screen.findByTestId("company-share-access-none")
    const add = screen.getByTestId("company-share-add-person")
    fireEvent.focus(add)
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/sharing/members"))
    expect(screen.queryByTestId("company-share-add-option-u-bob")).toBeNull()
    fireEvent.click(none)
    expect(none.getAttribute("aria-pressed") ?? none.getAttribute("aria-checked")).toBe("true")

    fireEvent.click(add)
    expect(await screen.findByTestId("company-share-add-option-u-bob")).toBeTruthy()
    expect(screen.queryByTestId("company-share-add-option-u-self")).toBeNull()
    fireEvent.input(add, { target: { value: "elodie" } })
    expect(screen.queryByTestId("company-share-add-option-u-self")).toBeNull()
  })

  it("someone who may not manage the company's sharing sees it read only, with no Save", async () => {
    const api = makeApi(async () => ({
      orgAccess: "editor",
      canManage: false,
      users: [],
      roles: [],
      dimensions: [],
    }))
    renderDialog(api)

    expect(await screen.findByTestId("company-share-read-only")).toBeInTheDocument()
    expect(screen.queryByTestId("company-share-save")).toBeNull()
    expect(screen.queryByTestId("company-share-add-person")).toBeNull()
    const view = screen.getByTestId("company-share-access-viewer")
    expect(view).toBeDisabled()
    fireEvent.click(view)
    expect(view.getAttribute("aria-pressed") ?? view.getAttribute("aria-checked")).not.toBe("true")
    expect(api.put).not.toHaveBeenCalled()
  })

  it("shows the company's real general access, not Private, once the sharing read answers", async () => {
    renderDialog(
      makeApi(async () => ({
        orgAccess: "viewer",
        canManage: false,
        users: [],
        roles: [],
        dimensions: [],
      })),
    )

    expect(await screen.findByTestId("company-share-read-only")).toBeInTheDocument()
    expect(screen.queryByTestId("company-share-load-error")).toBeNull()
    expect(screen.getByTestId("company-share-access-viewer").getAttribute("aria-pressed")).toBe(
      "true",
    )
    expect(screen.getByTestId("company-share-access-none").getAttribute("aria-pressed")).toBe(
      "false",
    )
    expect(screen.getByTestId("company-share-access-editor").getAttribute("aria-pressed")).toBe(
      "false",
    )
  })

  it("a sharing read that fails says so and never shows an editable form", async () => {
    renderDialog(
      makeApi(async () => {
        throw new Error("Company not found")
      }),
    )

    expect(await screen.findByTestId("company-share-load-error")).toBeInTheDocument()
    expect(screen.queryByTestId("company-share-save")).toBeNull()
    expect(screen.queryByTestId("company-share-add-person")).toBeNull()
  })
})
