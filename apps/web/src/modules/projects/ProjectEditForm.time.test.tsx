// SPDX-License-Identifier: FSL-1.1-ALv2
// The project's own Time and budgets switch in the edit form: per project, off by default, and
// never an organisation switch.
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  updateProjectFields: vi.fn(async (..._args: unknown[]) => ({})),
  granted: new Set<string>(),
}))

vi.mock("~/modules/projects/project-edit", () => ({
  updateProjectFields: state.updateProjectFields,
}))
vi.mock("~/modules/projects/projects-store", () => ({
  projectsStore: { items: [], archivedItems: [] },
}))
vi.mock("~/modules/auth/auth-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/auth/auth-store")>()),
  hasScope: (s: string) => state.granted.has(s),
}))

import type { ApiClient } from "~/lib/api-client"
import { ProjectEditForm } from "~/modules/projects/ProjectEditForm"
import type { ProjectDetail } from "~/modules/projects/project-store"

const project = (over: Partial<ProjectDetail> = {}): ProjectDetail => ({
  id: "p1",
  key: "ATLAS",
  keyLocked: false,
  name: "Maison Delorme",
  description: null,
  icon: null,
  color: null,
  ownerId: "u1",
  archivedAt: null,
  createdAt: "2026-05-01T09:00:00.000Z",
  updatedAt: "2026-05-01T09:00:00.000Z",
  statuses: [],
  ...over,
})

const apiWith = (post = vi.fn(async () => ({}))) =>
  ({
    post,
    getEnvelope: vi.fn(async () => ({ data: [{ id: "u2", name: "Ada" }] })),
  }) as unknown as ApiClient

beforeEach(() => {
  state.updateProjectFields.mockClear()
  state.granted = new Set(["projects:projects:write", "projects:money:write"])
})

describe("ProjectEditForm time and budgets", () => {
  it("is off by default and saves nothing for it until the switch is turned", async () => {
    const onDone = vi.fn()
    render(() => <ProjectEditForm api={apiWith()} project={project()} onDone={onDone} />)
    const sw = screen.getByTestId("project-edit.time-budgets-switch") as HTMLInputElement
    expect(sw.checked).toBe(false)
    expect(screen.getByTestId("project-edit.time-budgets").textContent).toContain(
      "Nothing is deleted",
    )
    expect(screen.queryByTestId("project-edit.time-plan")).toBeNull()
    fireEvent.click(screen.getByTestId("project-edit.save"))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(state.updateProjectFields).not.toHaveBeenCalled()
  })

  it("turning it on sends the switch for this project only", async () => {
    render(() => <ProjectEditForm api={apiWith()} project={project()} onDone={() => {}} />)
    fireEvent.click(screen.getByTestId("project-edit.time-budgets-switch"))
    fireEvent.click(screen.getByTestId("project-edit.save"))
    await waitFor(() =>
      expect(state.updateProjectFields).toHaveBeenCalledWith(expect.anything(), "p1", {
        timeBudgets: true,
      }),
    )
  })

  it("a project that is on says since when and by whom, and shows its plan", async () => {
    const post = vi.fn(async () => ({ message: "saved" }))
    render(() => (
      <ProjectEditForm
        api={apiWith(post)}
        project={project({
          timeBudgets: true,
          timeBudgetsChangedAt: "2026-11-02T09:00:00.000Z",
          timeBudgetsChangedBy: { id: "u9", name: "Claire Lambert" },
        })}
        onDone={() => {}}
      />
    ))
    const since = screen.getByTestId("project-edit.time-budgets-since").textContent ?? ""
    expect(since).toMatch(/^On since .*2026.*, turned on by Claire Lambert$/)
    fireEvent.change(screen.getByTestId("project-edit.time-plan-basis"), {
      target: { value: "fixed" },
    })
    fireEvent.click(screen.getByTestId("project-edit.time-plan-dated"))
    fireEvent.input(screen.getByTestId("project-edit.time-plan-rate"), {
      target: { value: "95,5" },
    })
    fireEvent.click(screen.getByTestId("project-edit.save"))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
    const bodies = post.mock.calls.map((c) => (c as unknown as [string, unknown])[1])
    expect(bodies).toContainEqual({
      toolName: "projects:time_plan_set",
      params: { projectId: "p1", datedHours: true, basis: "fixed" },
    })
    expect(bodies).toContainEqual({
      toolName: "projects:billing_terms_set",
      params: { projectId: "p1", rate: 95.5 },
    })
    expect(state.updateProjectFields).not.toHaveBeenCalled()
  })

  it("the plan fields start from the plan the server holds, and only a change is sent", async () => {
    const post = vi.fn(async () => ({ message: "saved" }))
    const get = vi.fn(async (path: string) =>
      path === "/projects/p1/time-plan"
        ? {
            projectId: "p1",
            basis: "hourly",
            billerId: "u7",
            billerName: "Noor Kaya",
            datedHours: true,
            rate: 95,
            fixedPrice: null,
            currency: "EUR",
          }
        : {},
    )
    const api = { ...apiWith(post), get } as unknown as ApiClient
    render(() => (
      <ProjectEditForm api={api} project={project({ timeBudgets: true })} onDone={() => {}} />
    ))
    const basis = screen.getByTestId("project-edit.time-plan-basis") as HTMLSelectElement
    await waitFor(() => expect(basis.value).toBe("hourly"))
    expect((screen.getByTestId("project-edit.time-plan-rate") as HTMLInputElement).value).toBe("95")
    expect((screen.getByTestId("project-edit.time-plan-dated") as HTMLInputElement).checked).toBe(
      true,
    )
    const biller = screen.getByTestId("project-edit.time-plan-biller") as HTMLSelectElement
    await waitFor(() => expect(biller.value).toBe("u7"))
    expect(biller.selectedOptions[0]?.textContent).toBe("Noor Kaya")
    expect(basis.textContent).not.toContain("Keep as is")

    fireEvent.change(basis, { target: { value: "daily" } })
    fireEvent.click(screen.getByTestId("project-edit.save"))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect((post.mock.calls[0] as unknown as [string, unknown])[1]).toEqual({
      toolName: "projects:time_plan_set",
      params: { projectId: "p1", basis: "daily" },
    })
  })

  it("the rate field is absent without the money scope", () => {
    state.granted = new Set(["projects:projects:write"])
    render(() => (
      <ProjectEditForm api={apiWith()} project={project({ timeBudgets: true })} onDone={() => {}} />
    ))
    expect(screen.queryByTestId("project-edit.time-plan-rate")).toBeNull()
  })

  it("a sales pipeline has no switch", () => {
    render(() => (
      <ProjectEditForm api={apiWith()} project={project({ kind: "pipeline" })} onDone={() => {}} />
    ))
    expect(screen.queryByTestId("project-edit.time-budgets")).toBeNull()
  })
})
