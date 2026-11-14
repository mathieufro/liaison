// SPDX-License-Identifier: FSL-1.1-ALv2
// List block: rows from the list tool, create with the declared fields and a
// one-time reveal of the generated secret, a gated create that reveals nothing
// (§R1 P2-6), archive behind an in-page confirm, row actions. Creates and
// archives are staged behind ONE dirty Save/Discard bar (S10): nothing is
// written before Save, Discard puts the stored rows back.
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createFakeApi, type FakeApi } from "./__fixtures__/fake-api"
import { fixtureManifest } from "./__fixtures__/settings-fixture"
import type { SettingsListBlock } from "./types"

const state = vi.hoisted(() => ({ api: null as unknown }))
vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => state.api,
  useOptionalApi: () => state.api,
}))

import { ListBlock } from "./ListBlock"

const block = fixtureManifest.settings?.sections
  .flatMap((s) => s.blocks)
  .find((b): b is SettingsListBlock => b.block === "list") as SettingsListBlock

let api: FakeApi
let rows: Array<Record<string, unknown>>

beforeEach(() => {
  api = createFakeApi()
  state.api = api
  rows = [{ id: "k1", label: "CI", prefix: "lk_ab" }]
  api.tool("fixture:keys.list", () => rows)
  api.tool("fixture:keys.create", (p) => {
    const r = { id: "k2", label: (p as { label: string }).label, prefix: "lk_cd" }
    rows = [...rows, r]
    return { ...r, key: "lk_cd_secret" }
  })
  api.tool("fixture:keys.revoke", (p) => {
    rows = rows.filter((r) => r.id !== (p as { id: string }).id)
    return { ok: true }
  })
  api.tool("fixture:keys.test", () => ({ ok: true }))
})

function renderList() {
  return render(() => <ListBlock app="fixture" block={block} blockId="keys-0" />)
}

describe("ListBlock", () => {
  it("renders the declared columns of each row", async () => {
    renderList()
    const row = await screen.findByTestId("settings-list-row-k1")
    expect(row.textContent).toContain("CI")
    expect(row.textContent).toContain("lk_ab")
  })

  it("creates a row on Save and reveals the generated secret once", async () => {
    renderList()
    fireEvent.click(await screen.findByTestId("settings-list-add"))
    fireEvent.input(screen.getByTestId("settings-list-create-label"), {
      target: { value: "Deploy" },
    })
    fireEvent.click(screen.getByTestId("settings-list-create-submit"))
    // Staged: the row shows as New, the bar counts it, nothing is written yet.
    expect(screen.getByTestId("settings-list-new-new-1")).toBeTruthy()
    expect(screen.getByTestId("settings-list-row-new-1").textContent).toContain("Deploy")
    expect(screen.getByTestId("settings-list-dirty-count").textContent).toBe("1 unsaved change")
    expect(api.toolCalls().some((c) => c.toolName === "fixture:keys.create")).toBe(false)
    fireEvent.click(screen.getByTestId("settings-list-save"))
    const reveal = await screen.findByTestId("settings-list-reveal")
    expect(reveal.textContent).toContain("lk_cd_secret")
    expect(api.toolCalls().find((c) => c.toolName === "fixture:keys.create")?.params).toEqual({
      label: "Deploy",
    })
    await screen.findByTestId("settings-list-row-k2")
    fireEvent.click(screen.getByTestId("settings-list-reveal-done"))
    expect(screen.queryByTestId("settings-list-reveal")).toBeNull()
    expect(document.body.textContent).not.toContain("lk_cd_secret")
  })

  it("a create that waits for approval reveals nothing", async () => {
    api.tool("fixture:keys.create", () => ({ blocked: { approvalRequestId: "ar-9" } }))
    renderList()
    fireEvent.click(await screen.findByTestId("settings-list-add"))
    fireEvent.input(screen.getByTestId("settings-list-create-label"), {
      target: { value: "Deploy" },
    })
    fireEvent.click(screen.getByTestId("settings-list-create-submit"))
    fireEvent.click(screen.getByTestId("settings-list-save"))
    expect((await screen.findByTestId("settings-list-pending")).textContent).toContain(
      "Waiting for approval",
    )
    expect(screen.queryByTestId("settings-list-reveal")).toBeNull()
  })

  it("archives a row after the in-page confirm, on Save", async () => {
    renderList()
    fireEvent.click(await screen.findByTestId("settings-list-archive-k1"))
    expect(api.toolCalls().some((c) => c.toolName === "fixture:keys.revoke")).toBe(false)
    const confirm = screen.getByTestId("settings-list-confirm-k1")
    fireEvent.click(within(confirm).getByTestId("settings-list-archive-confirm-k1"))
    // Staged: marked for removal, still listed, nothing written.
    expect(screen.getByTestId("settings-list-removing-k1")).toBeTruthy()
    expect(api.toolCalls().some((c) => c.toolName === "fixture:keys.revoke")).toBe(false)
    fireEvent.click(screen.getByTestId("settings-list-save"))
    await waitFor(() => expect(screen.queryByTestId("settings-list-row-k1")).toBeNull())
    expect(screen.queryByTestId("settings-list-dirty-bar")).toBeNull()
    expect(api.toolCalls().find((c) => c.toolName === "fixture:keys.revoke")?.params).toEqual({
      id: "k1",
    })
  })

  it("Discard puts the stored rows back and writes nothing", async () => {
    renderList()
    await screen.findByTestId("settings-list-row-k1")
    fireEvent.click(screen.getByTestId("settings-list-add"))
    fireEvent.input(screen.getByTestId("settings-list-create-label"), {
      target: { value: "Deploy" },
    })
    fireEvent.click(screen.getByTestId("settings-list-create-submit"))
    fireEvent.click(screen.getByTestId("settings-list-archive-k1"))
    fireEvent.click(screen.getByTestId("settings-list-archive-confirm-k1"))
    expect(screen.getByTestId("settings-list-dirty-count").textContent).toBe("2 unsaved changes")
    fireEvent.click(screen.getByTestId("settings-list-discard"))
    expect(screen.queryByTestId("settings-list-dirty-bar")).toBeNull()
    expect(screen.queryByTestId("settings-list-row-new-1")).toBeNull()
    expect(screen.queryByTestId("settings-list-removing-k1")).toBeNull()
    expect(screen.getByTestId("settings-list-row-k1")).toBeTruthy()
    expect(
      api
        .toolCalls()
        .some((c) => c.toolName === "fixture:keys.create" || c.toolName === "fixture:keys.revoke"),
    ).toBe(false)
  })

  it("Undo takes back a staged removal, and a staged row can be dropped", async () => {
    renderList()
    fireEvent.click(await screen.findByTestId("settings-list-archive-k1"))
    fireEvent.click(screen.getByTestId("settings-list-archive-confirm-k1"))
    fireEvent.click(screen.getByTestId("settings-list-undo-k1"))
    expect(screen.queryByTestId("settings-list-removing-k1")).toBeNull()
    fireEvent.click(screen.getByTestId("settings-list-add"))
    fireEvent.input(screen.getByTestId("settings-list-create-label"), {
      target: { value: "Deploy" },
    })
    fireEvent.click(screen.getByTestId("settings-list-create-submit"))
    fireEvent.click(screen.getByTestId("settings-list-unstage-new-1"))
    expect(screen.queryByTestId("settings-list-row-new-1")).toBeNull()
    expect(screen.queryByTestId("settings-list-dirty-bar")).toBeNull()
  })

  it("a create the server refuses stays staged with its message", async () => {
    api.tool("fixture:keys.create", () => {
      throw new Error("Label already used")
    })
    renderList()
    fireEvent.click(await screen.findByTestId("settings-list-add"))
    fireEvent.input(screen.getByTestId("settings-list-create-label"), {
      target: { value: "CI" },
    })
    fireEvent.click(screen.getByTestId("settings-list-create-submit"))
    fireEvent.click(screen.getByTestId("settings-list-save"))
    expect(await screen.findByTestId("settings-list-row-error-new-1")).toBeTruthy()
    expect(screen.getByTestId("settings-list-dirty-bar")).toBeTruthy()
  })

  describe("inline edit through the declared update op", () => {
    const editable: SettingsListBlock = { ...block, ops: { ...block.ops, update: "keys.update" } }
    const renderEditable = () =>
      render(() => <ListBlock app="fixture" block={editable} blockId="keys-0" />)

    beforeEach(() => {
      rows = [
        { id: "k1", label: "CI", prefix: "lk_ab" },
        { id: "k3", label: "Ops", prefix: "lk_ef" },
      ]
      api.tool("fixture:keys.update", (p) => {
        const { id, label } = p as { id: string; label: string }
        rows = rows.map((r) => (r.id === id ? { ...r, label } : r))
        return { ok: true }
      })
    })

    async function editLabel(id: string, value: string): Promise<void> {
      fireEvent.click(await screen.findByTestId(`settings-list-edit-${id}`))
      const input = screen.getByTestId("settings-list-edit-field-label") as HTMLInputElement
      fireEvent.input(input, { target: { value } })
      fireEvent.click(screen.getByTestId(`settings-list-edit-apply-${id}`))
    }

    it("offers no Edit when the block declares no update", async () => {
      renderList()
      await screen.findByTestId("settings-list-row-k1")
      expect(screen.queryByTestId("settings-list-edit-k1")).toBeNull()
    })

    it("stages the edit in the row, then updates it on Save", async () => {
      renderEditable()
      fireEvent.click(await screen.findByTestId("settings-list-edit-k1"))
      // The form opens filled from the row.
      expect((screen.getByTestId("settings-list-edit-field-label") as HTMLInputElement).value).toBe(
        "CI",
      )
      fireEvent.input(screen.getByTestId("settings-list-edit-field-label"), {
        target: { value: "CI runner" },
      })
      fireEvent.click(screen.getByTestId("settings-list-edit-apply-k1"))
      expect(screen.getByTestId("settings-list-edited-k1")).toBeTruthy()
      expect(screen.getByTestId("settings-list-cell-k1-label").textContent).toBe("CI runner")
      expect(screen.getByTestId("settings-list-dirty-count").textContent).toBe("1 unsaved change")
      expect(api.toolCalls().some((c) => c.toolName === "fixture:keys.update")).toBe(false)
      fireEvent.click(screen.getByTestId("settings-list-save"))
      await waitFor(() =>
        expect(api.toolCalls().find((c) => c.toolName === "fixture:keys.update")?.params).toEqual({
          id: "k1",
          label: "CI runner",
        }),
      )
      await waitFor(() => expect(screen.queryByTestId("settings-list-dirty-bar")).toBeNull())
      expect(screen.queryByTestId("settings-list-edited-k1")).toBeNull()
      // The reloaded list carries the saved value.
      await waitFor(() =>
        expect(screen.getByTestId("settings-list-cell-k1-label").textContent).toBe("CI runner"),
      )
    })

    it("Undo and Discard put the stored value back, and an unchanged form stages nothing", async () => {
      renderEditable()
      await editLabel("k1", "CI runner")
      fireEvent.click(screen.getByTestId("settings-list-edit-undo-k1"))
      expect(screen.getByTestId("settings-list-cell-k1-label").textContent).toBe("CI")
      expect(screen.queryByTestId("settings-list-dirty-bar")).toBeNull()
      await editLabel("k1", "CI")
      expect(screen.queryByTestId("settings-list-edited-k1")).toBeNull()
      await editLabel("k1", "CI runner")
      fireEvent.click(screen.getByTestId("settings-list-discard"))
      expect(screen.getByTestId("settings-list-cell-k1-label").textContent).toBe("CI")
      expect(api.toolCalls().some((c) => c.toolName === "fixture:keys.update")).toBe(false)
    })

    it("Save runs archives, then updates, then creates", async () => {
      renderEditable()
      await editLabel("k1", "CI runner")
      fireEvent.click(screen.getByTestId("settings-list-archive-k3"))
      fireEvent.click(screen.getByTestId("settings-list-archive-confirm-k3"))
      fireEvent.click(screen.getByTestId("settings-list-add"))
      fireEvent.input(screen.getByTestId("settings-list-create-label"), {
        target: { value: "Deploy" },
      })
      fireEvent.click(screen.getByTestId("settings-list-create-submit"))
      expect(screen.getByTestId("settings-list-dirty-count").textContent).toBe("3 unsaved changes")
      fireEvent.click(screen.getByTestId("settings-list-save"))
      await screen.findByTestId("settings-list-reveal")
      const writes = api
        .toolCalls()
        .map((c) => c.toolName)
        .filter((n) => n !== "fixture:keys.list")
      expect(writes).toEqual(["fixture:keys.revoke", "fixture:keys.update", "fixture:keys.create"])
    })

    it("a refused update stays staged with its message; a gated one says it waits", async () => {
      api.tool("fixture:keys.update", () => {
        throw new Error("Label already used")
      })
      renderEditable()
      await editLabel("k1", "Ops")
      fireEvent.click(screen.getByTestId("settings-list-save"))
      expect((await screen.findByTestId("settings-list-row-error-k1")).textContent).toContain(
        "Label already used",
      )
      expect(screen.getByTestId("settings-list-edited-k1")).toBeTruthy()
      expect(screen.getByTestId("settings-list-dirty-bar")).toBeTruthy()

      api.tool("fixture:keys.update", () => ({ blocked: { approvalRequestId: "ar-1" } }))
      fireEvent.click(screen.getByTestId("settings-list-save"))
      expect((await screen.findByTestId("settings-list-pending")).textContent).toContain(
        "Waiting for approval",
      )
      await waitFor(() => expect(screen.queryByTestId("settings-list-dirty-bar")).toBeNull())
    })
  })

  // L7: a row without a name never puts its UUID in the confirm.
  it("an unnamed row's archive confirm names no id", async () => {
    rows = [{ id: "3f2a9c1e-0000-4000-8000-000000000001", label: "", prefix: "lk_zz" }]
    renderList()
    fireEvent.click(
      await screen.findByTestId("settings-list-archive-3f2a9c1e-0000-4000-8000-000000000001"),
    )
    const confirm = screen.getByTestId("settings-list-confirm-3f2a9c1e-0000-4000-8000-000000000001")
    expect(confirm.textContent).not.toContain("3f2a9c1e")
    expect(confirm.textContent).toContain("Archive this item?")
  })

  it("runs a row action with the row id", async () => {
    renderList()
    fireEvent.click(await screen.findByTestId("settings-list-action-0-k1"))
    await waitFor(() =>
      expect(api.toolCalls().find((c) => c.toolName === "fixture:keys.test")?.params).toEqual({
        id: "k1",
      }),
    )
  })

  it("names the archive action as declared, styled as a destructive action", async () => {
    render(() => (
      <ListBlock app="fixture" block={{ ...block, archiveLabel: "Remove" }} blockId="keys-0" />
    ))
    const trigger = await screen.findByTestId("settings-list-archive-k1")
    expect(trigger.textContent).toBe("Remove")
    expect(trigger.className).toContain("text-error")
    fireEvent.click(trigger)
    const confirm = screen.getByTestId("settings-list-confirm-k1")
    expect(within(confirm).getByTestId("settings-list-archive-confirm-k1").textContent).toBe(
      "Remove",
    )
  })

  it("a declared title heads the list, so the reader knows what Add adds", async () => {
    render(() => (
      <ListBlock app="fixture" block={{ ...block, title: "Company days off" }} blockId="keys-0" />
    ))
    expect((await screen.findByTestId("settings-list-title")).textContent).toBe("Company days off")
  })

  it("reads rows from the one array a list tool answers under its own name", async () => {
    api.tool("fixture:keys.list", () => ({ terms: rows }))
    renderList()
    expect((await screen.findByTestId("settings-list-row-k1")).textContent).toContain("CI")
  })

  // A secondary column with no value (a keyword monitor term has no platform)
  // shows no "Label:" line with nothing after it.
  it("omits a secondary column whose value is empty", async () => {
    rows = [
      { id: "k1", label: "CI", prefix: null },
      { id: "k3", label: "Ops", prefix: "" },
      { id: "k4", label: "Web", prefix: "lk_ef" },
    ]
    renderList()
    await screen.findByTestId("settings-list-row-k4")
    for (const id of ["k1", "k3"]) {
      expect(screen.getByTestId(`settings-list-cell-${id}-label`)).toBeTruthy()
      expect(screen.queryByTestId(`settings-list-cell-${id}-prefix`)).toBeNull()
      expect(screen.getByTestId(`settings-list-row-${id}`).textContent).not.toContain("Key:")
    }
    expect(screen.getByTestId("settings-list-cell-k4-prefix").textContent).toBe("Key: lk_ef")
  })

  it("shows an empty state", async () => {
    rows = []
    renderList()
    expect(await screen.findByTestId("settings-list-empty")).toBeTruthy()
  })
})

// M2: declared column formats; a list never shows raw ISO timestamps, slugs,
// untranslated enum tokens or a bare status code, and a failed sync says why.
describe("ListBlock column formats", () => {
  const formatted: SettingsListBlock = {
    block: "list",
    ops: { list: "sources.list" },
    columns: [
      { key: "displayName", label: "Source" },
      {
        key: "appName",
        label: "From",
        format: "enum",
        options: [
          {
            value: "google-drive",
            label: "Google Drive",
            labelKey: "knowledge.settingsPage.syncedSources.app.googleDrive",
          },
        ],
      },
      {
        key: "scope",
        label: "Shared with",
        format: "enum",
        options: [
          {
            value: "personal",
            label: "Just the owner",
            labelKey: "knowledge.settingsPage.syncedSources.scopeValue.personal",
          },
        ],
      },
      { key: "lastSyncAt", label: "Last sync", format: "datetime" },
      {
        key: "lastSyncStatus",
        label: "Status",
        format: "status",
        options: [
          {
            value: "error",
            label: "Failed",
            labelKey: "knowledge.settingsPage.syncedSources.statusValue.error",
          },
        ],
        errorKey: "lastError",
      },
    ],
  }

  it("renders relative time, enum labels and a status badge carrying the error", async () => {
    const iso = new Date(Date.now() - 2 * 3600_000).toISOString()
    api.tool("fixture:sources.list", () => [
      {
        id: "s1",
        displayName: "Manuals",
        appName: "google-drive",
        scope: "personal",
        lastSyncAt: iso,
        lastSyncStatus: "error",
        lastError: "Drive folder not found (404)",
      },
    ])
    render(() => <ListBlock app="fixture" block={formatted} blockId="src-0" />)
    const row = await screen.findByTestId("settings-list-row-s1")
    const text = row.textContent ?? ""
    expect(text).not.toContain(iso)
    expect(text).not.toContain("google-drive")
    expect(text).not.toMatch(/\bpersonal\b/)
    expect(text).toMatch(/2\s?h/)
    expect(text).toContain("Google Drive")
    const badge = within(row).getByTestId("settings-list-status-s1-lastSyncStatus")
    expect(badge.getAttribute("data-status")).toBe("error")
    expect(within(row).getByTestId("settings-list-error-s1-lastSyncStatus").textContent).toContain(
      "Drive folder not found (404)",
    )
  })

  it("a datetime that never happened reads Never", async () => {
    api.tool("fixture:sources.list", () => [
      {
        id: "s2",
        displayName: "Repo",
        appName: "gitlab",
        lastSyncAt: null,
        lastSyncStatus: "idle",
      },
    ])
    render(() => <ListBlock app="fixture" block={formatted} blockId="src-0" />)
    const row = await screen.findByTestId("settings-list-row-s2")
    expect(row.textContent).toContain("Never")
  })
})
