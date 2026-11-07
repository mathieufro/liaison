// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { AssigneePicker } from "./AssigneePicker"

const mocks = vi.hoisted(() => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: [{ id: "user-2", name: "User Two", avatarUrl: null }] }),
  },
  onReassign: vi.fn(),
}))

vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => mocks.api }))

describe("AssigneePicker", () => {
  beforeEach(() => {
    mocks.onReassign.mockClear()
    mocks.api.get.mockClear()
  })

  it("loads assignable users and exposes unassign plus user choices", async () => {
    render(() => (
      <AssigneePicker assignedTo="user-1" accountId="acc-1" onReassign={mocks.onReassign} />
    ))

    await fireEvent.pointerDown(screen.getByRole("button", { name: /Assigned to/i }))

    expect(mocks.api.get).toHaveBeenCalledWith("/mail/accounts/acc-1/assignees")
    expect(await screen.findByText("Unassign")).toBeInTheDocument()
    expect(await screen.findByText("User Two")).toBeInTheDocument()
    const userItem = screen.getByRole("menuitem", { name: /User Two/ })
    userItem.focus()
    fireEvent.keyDown(userItem, { key: "Enter" })
    await waitFor(() => expect(mocks.onReassign).toHaveBeenCalledWith("user-2"))
    const unassignItem = screen.getByRole("menuitem", { name: "Unassign" })
    unassignItem.focus()
    fireEvent.keyDown(unassignItem, { key: "Enter" })
    await waitFor(() => expect(mocks.onReassign).toHaveBeenCalledWith(null))
  })

  it("shows the email only for two assignable users sharing a display name", async () => {
    mocks.api.get.mockResolvedValue({
      data: [
        { id: "user-2", name: "Dana Reyes", email: "dana@north.example", avatarUrl: null },
        { id: "user-3", name: "Dana Reyes", email: "dana@south.example", avatarUrl: null },
        { id: "user-4", name: "Priya Nair", email: "priya@example.test", avatarUrl: null },
      ],
    })

    render(() => (
      <AssigneePicker assignedTo="user-1" accountId="acc-1" onReassign={mocks.onReassign} />
    ))
    await fireEvent.pointerDown(screen.getByRole("button", { name: /Assigned to/i }))

    expect(await screen.findByText("Dana Reyes (dana@north.example)")).toBeInTheDocument()
    expect(await screen.findByText("Dana Reyes (dana@south.example)")).toBeInTheDocument()
    expect(await screen.findByText("Priya Nair")).toBeInTheDocument()
    expect(screen.queryByText("Priya Nair (priya@example.test)")).not.toBeInTheDocument()
  })

  it("shows away until a date beside someone away; who can be picked does not change", async () => {
    mocks.api.get.mockResolvedValue({
      data: [
        { id: "user-2", name: "Élodie Renard", avatarUrl: null, away: { until: "2099-12-20" } },
        { id: "user-3", name: "Tom Reyes", avatarUrl: null, away: null },
      ],
    })
    render(() => (
      <AssigneePicker assignedTo="user-1" accountId="acc-1" onReassign={mocks.onReassign} />
    ))
    await fireEvent.pointerDown(screen.getByRole("button", { name: /Assigned to/i }))
    expect(await screen.findByTestId("assignee-picker-away-user-2")).toHaveTextContent(
      /away until (20 Dec|Dec 20)/,
    )
    expect(screen.queryByTestId("assignee-picker-away-user-3")).toBeNull()
    expect(screen.getByTestId("assignee-picker-option-user-2")).toBeInTheDocument()
    expect(screen.getByTestId("assignee-picker-option-user-3")).toBeInTheDocument()
  })
})
