// SPDX-License-Identifier: FSL-1.1-ALv2
// A feature switched off inside an app: its settings section and tab type leave the
// shell, a tab already open resolves to no component (the shell's unavailable notice),
// and the feature coming back needs no reload.
import { createRoot } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  getActivityBarEntries,
  getSettingsSections,
  getTabType,
  resetRegistry,
} from "~/framework/app-registry"
import {
  type AppManifest,
  registerAppFromManifest,
  registerAppSettingsRoute,
  resetAppIndex,
  unregisterApp,
} from "~/framework/define-app"
import { isFeatureOff, loadOrgFeatures, setEnabledOrgFeatures } from "~/framework/org-features"
import { setUnavailableApps } from "~/framework/unavailable-apps"
import {
  canAccessSettingsSection,
  visibleSettingsSections,
} from "~/modules/settings/visible-settings-sections"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

vi.mock("~/modules/auth/auth-store", () => ({ canAccessScope: () => true }))

const View = () => null

function manifest(): AppManifest {
  return {
    name: "budgeting",
    kind: "app",
    version: "1.0.0",
    settings: {
      sections: [
        {
          id: "budgets",
          title: "Budgets",
          scope: "org",
          feature: "budgets",
          blocks: [{ block: "custom", component: "View", reason: "computed view" }],
        },
      ],
    },
    views: {
      tabTypes: {
        board: { component: "View", label: "Board", feature: "budgets" },
        list: { component: "View", label: "List" },
      },
      activityBar: { icon: "View", label: "Budgeting", order: 10 },
    },
  } as unknown as AppManifest
}

describe("a feature switched off inside an app", () => {
  beforeEach(() => {
    resetRegistry()
    resetAppIndex()
    setEnabledOrgFeatures([])
    setUnavailableApps([])
    registerAppSettingsRoute({ page: () => null, registerPage: vi.fn(), unregisterPage: vi.fn() })
    registerAppFromManifest(manifest(), { View })
  })

  afterEach(() => {
    unregisterApp("budgeting")
    setEnabledOrgFeatures([])
    vi.unstubAllGlobals()
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    })
  })

  const page = () => getSettingsSections().find((s) => s.appId === "budgeting" && s.pageSections)

  it("a settings section and a tab type of a switched-off feature are absent, an open tab shows the notice", () => {
    createRoot((dispose) => {
      const section = page()
      expect(section).toBeDefined()
      expect(canAccessSettingsSection(section as never)).toBe(false)
      expect(visibleSettingsSections().some((s) => s.appId === "budgeting")).toBe(false)
      // The rail entry opens the first tab type, which is the switched-off one.
      expect(getActivityBarEntries().some((e) => e.appId === "budgeting")).toBe(false)
      // Resolves to nothing: MainPanel's fallback for a registered app's tab with no
      // component is the unavailable notice. A type with no feature is unaffected.
      expect(getTabType("budgeting:board")).toBeUndefined()
      expect(getTabType("budgeting:list")).toBeDefined()

      setEnabledOrgFeatures([{ app: "budgeting", feature: "budgets" }])
      expect(canAccessSettingsSection(page() as never)).toBe(true)
      expect(getActivityBarEntries().some((e) => e.appId === "budgeting")).toBe(true)
      expect(getTabType("budgeting:board")).toBeDefined()
      dispose()
    })
  })

  it("a feature of another app does not open this one's", () => {
    setEnabledOrgFeatures([{ app: "other", feature: "budgets" }])
    expect(isFeatureOff("budgeting", "budgets")).toBe(true)
    expect(isFeatureOff("budgeting", undefined)).toBe(false)
  })

  it("the feed replaces the set, and a failed read keeps the last answer", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ app: "budgeting", feature: "budgets" }, { bad: 1 }] }),
    }))
    vi.stubGlobal("fetch", fetchMock)
    await loadOrgFeatures("/api/apps/features", "token")
    expect(isFeatureOff("budgeting", "budgets")).toBe(false)

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    )
    await loadOrgFeatures("/api/apps/features", "token")
    expect(isFeatureOff("budgeting", "budgets")).toBe(false)

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) })),
    )
    await loadOrgFeatures("/api/apps/features", "token")
    expect(isFeatureOff("budgeting", "budgets")).toBe(true)
  })
})
