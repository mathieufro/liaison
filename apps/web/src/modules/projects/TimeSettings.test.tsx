// SPDX-License-Identifier: FSL-1.1-ALv2
// The "Time and budgets" settings section: its days-off list on the section the projects
// manifest declares, and the note beside it.
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createFakeApi, type FakeApi } from "~/modules/settings/app-page/__fixtures__/fake-api"
import type { SettingsListBlock } from "~/modules/settings/app-page/types"
import manifest from "../../../../api/src/apps/projects/app.manifest.json"

const state = vi.hoisted(() => ({ api: null as unknown, scopes: new Set<string>() }))
vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => state.api,
  useOptionalApi: () => state.api,
}))
vi.mock("~/modules/auth/auth-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/auth/auth-store")>()),
  hasScope: (s: string) => state.scopes.has(s),
}))
const prefill = vi.hoisted(() => vi.fn(async () => "t1"))
vi.mock("~/modules/shell/dock-prefill", () => ({ dock: { prefill } }))

import { TimeSettingsNote } from "~/modules/projects/TimeSettingsNote"
import { ListBlock } from "~/modules/settings/app-page/ListBlock"

const section = manifest.settings.sections.find((s) => s.id === "time")
const daysOff = section?.blocks.find((b) => b.block === "list") as unknown as SettingsListBlock

let api: FakeApi
let rows: Array<Record<string, unknown>>

beforeEach(() => {
  api = createFakeApi()
  state.api = api
  state.scopes = new Set()
  prefill.mockClear()
  rows = []
  api.tool("projects:days_off_list", () => rows)
  api.tool("projects:days_off_set", (p) => {
    const { from, to, label } = p as { from: string; to: string; label?: string }
    rows = [...rows, { id: "d1", from, to, label: label ?? null }]
    return { ok: true }
  })
  api.tool("projects:time_settings_get", () => ({ projectsUsing: 3 }))
})

describe("time settings", () => {
  it("days off are empty until someone adds one and no country appears", async () => {
    render(() => <ListBlock app="projects" block={daysOff} blockId="time-2" />)
    await screen.findByTestId("settings-list-add")
    expect(screen.queryAllByTestId(/^settings-list-row-/)).toHaveLength(0)
    expect(JSON.stringify(section).toLowerCase()).not.toContain("country")
    expect(document.body.textContent?.toLowerCase()).not.toContain("country")
    expect(api.toolCalls().map((c) => c.toolName)).toEqual(["projects:days_off_list"])
  })

  it("a row added here is the row the tool lists", async () => {
    render(() => <ListBlock app="projects" block={daysOff} blockId="time-2" />)
    fireEvent.click(await screen.findByTestId("settings-list-add"))
    fireEvent.change(screen.getByTestId("settings-input-from"), {
      target: { value: "2026-12-25" },
    })
    fireEvent.change(screen.getByTestId("settings-input-to"), {
      target: { value: "2026-12-25" },
    })
    fireEvent.click(screen.getByTestId("settings-list-create-submit"))
    fireEvent.click(screen.getByTestId("settings-list-save"))
    await waitFor(() => expect(screen.getAllByTestId(/^settings-list-row-/)).toHaveLength(1))
    const call = api.toolCalls().find((c) => c.toolName === "projects:days_off_set")
    expect(call?.params).toMatchObject({ from: "2026-12-25", to: "2026-12-25" })
    expect(rows).toHaveLength(1)
  })

  it("a day read from the shared calendar is marked and shows no event title", async () => {
    rows = [
      { id: "typed", from: "2026-12-25", to: "2026-12-25", label: "Christmas", source: null },
      { id: "cal", from: "2026-12-31", to: "2026-12-31", label: null, source: "calendar" },
    ]
    render(() => <ListBlock app="projects" block={daysOff} blockId="time-2" />)
    await waitFor(() => expect(screen.getAllByTestId(/^settings-list-row-/)).toHaveLength(2))
    expect(screen.getByTestId("settings-list-cell-cal-source").textContent).toContain(
      "The shared calendar",
    )
    expect(screen.queryByTestId("settings-list-cell-typed-source")).toBeNull()
    expect(screen.getByTestId("settings-list-cell-typed-label").textContent).toContain("Christmas")
    expect(screen.queryByTestId("settings-list-cell-cal-label")).toBeNull()
  })

  it("the note says how many projects use it, with no switch and no list of projects", async () => {
    render(() => <TimeSettingsNote />)
    const using = await screen.findByTestId("time-settings-note.using")
    expect(using.textContent).toContain("3 projects use time and budgets")
    expect(screen.getByTestId("time-settings-note").querySelector("input, select")).toBeNull()
  })

  it("the cost rates row is drawn for finance only", async () => {
    const view = render(() => <TimeSettingsNote />)
    await screen.findByTestId("time-settings-note.using")
    expect(screen.queryByTestId("time-settings-note.rates")).toBeNull()
    view.unmount()
    state.scopes = new Set(["projects:cost_rates:write"])
    render(() => <TimeSettingsNote />)
    fireEvent.click(await screen.findByTestId("time-settings-note.rates-ask"))
    expect(prefill).toHaveBeenCalledTimes(1)
  })
})
