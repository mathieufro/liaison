// SPDX-License-Identifier: FSL-1.1-ALv2
// The Work section of a company's page: its work projects and their open
// tasks (deals are the Deals section's), and its own line when the read fails.
import { fireEvent, render } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  openEntity: vi.fn(),
}))

vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => ({ post: mocks.post }) }))
vi.mock("~/modules/shell/entity-opener", () => ({ openEntity: mocks.openEntity }))

import { CompanyWorkPanel } from "./CompanyWorkPanel"

beforeEach(() => {
  mocks.post.mockReset()
  mocks.openEntity.mockReset()
})

describe("CompanyWorkPanel", () => {
  it("shows the company's projects with their open tasks, each one opening", async () => {
    mocks.post.mockResolvedValueOnce({
      projects: [
        {
          id: "p9",
          name: "Lumen fit-out",
          key: "LUM",
          openTasks: 3,
          tasks: [{ id: "t4", key: "LUM-4", title: "Install the lamps", status: "In progress" }],
        },
      ],
    })
    const view = render(() => <CompanyWorkPanel entityId="co-lumen" />)
    const open = await view.findByTestId("company-work-panel.project-p9.open")
    expect(open.textContent).toBe("Open: 3")
    expect(view.getByTestId("company-work-panel.task-t4").textContent).toContain(
      "LUM-4 Install the lamps",
    )
    fireEvent.click(view.getByTestId("company-work-panel.task-t4"))
    expect(mocks.openEntity).toHaveBeenCalledWith(
      expect.anything(),
      "projects",
      "task",
      "t4",
      "LUM-4 Install the lamps",
    )
    fireEvent.click(view.getByTestId("company-work-panel.project-p9"))
    expect(mocks.openEntity).toHaveBeenCalledWith(
      expect.anything(),
      "projects",
      "project",
      "p9",
      "Lumen fit-out",
    )
  })

  it("says so when there is nothing, and has its own line when the read fails", async () => {
    mocks.post.mockResolvedValueOnce({ projects: [] })
    const empty = render(() => <CompanyWorkPanel entityId="co-quiet" />)
    expect((await empty.findByTestId("company-work-panel.empty")).textContent).toBe(
      "No project for this company yet.",
    )
    empty.unmount()
    mocks.post.mockRejectedValueOnce(new Error("down"))
    const failed = render(() => <CompanyWorkPanel entityId="co-lumen" />)
    expect((await failed.findByTestId("company-work-panel.error")).textContent).toBe(
      "Could not read this company's projects.",
    )
  })
})
