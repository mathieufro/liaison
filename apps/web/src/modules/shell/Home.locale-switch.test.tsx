// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Changing the language re-renders the open tabs' text: it must not dispose
// and mount again what a tab holds. Home's Activity groups were rebuilt as new
// objects whenever the locale changed (their labels were translated into the
// group objects), and `For` keys on identity, so a group the reader had folded
// came back open, as a new element.
import type { AttentionItem } from "@liaison/shared"
import { render, screen } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("~/modules/auth/auth-store", () => ({
  onAuthCleared: () => () => {},
  hasScope: () => true,
  userFromToken: () => ({ userId: "u-1", name: "Tester" }),
}))

const apiGet = vi.fn()
const apiGetEnvelope = vi.fn()
const apiPost = vi.fn(async () => ({}))
const apiPatch = vi.fn(async () => ({}))
const apiPut = vi.fn(async () => ({}))
vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => ({
    get: apiGet,
    getEnvelope: apiGetEnvelope,
    post: apiPost,
    patch: apiPatch,
    put: apiPut,
  }),
  useOptionalApi: () => ({
    get: apiGet,
    getEnvelope: apiGetEnvelope,
    post: apiPost,
    patch: apiPatch,
    put: apiPut,
  }),
}))

import { registerManifestAppData, resetRegistry } from "~/framework/app-registry"
import { I18nProvider, type I18nValue, useI18n } from "~/modules/i18n/i18n-context"
import { attentionStore } from "~/modules/shell/attention-store"
import { resetHomeCardLayout } from "~/modules/shell/home-card-layout"
import { resetThreadStore } from "~/modules/threads/thread-store"
import Home from "./Home"

function item(over: Partial<AttentionItem>): AttentionItem {
  return {
    id: over.id ?? "att-1",
    app: over.app ?? "tickets",
    entity: over.entity ?? "ticket",
    entityId: over.entityId ?? "T1",
    kind: over.kind ?? "unassigned",
    summary: over.summary ?? "Sujet",
    urgency: over.urgency ?? 30,
    occurredAt: over.occurredAt ?? "2026-05-06T12:00:00.000Z",
    action: over.action ?? {
      type: "open_entity",
      tabType: `${over.app ?? "tickets"}:${over.entity ?? "ticket"}`,
      entityId: over.entityId ?? "T1",
    },
    persisted: over.persisted ?? true,
  }
}

let i18n: I18nValue | undefined
function GrabI18n() {
  i18n = useI18n()
  return null
}

beforeEach(() => {
  attentionStore._setForTest({ items: [], errors: [], loading: false })
  resetRegistry()
  // The tickets app declares its Home heading in its manifest.
  registerManifestAppData("tickets", {
    attention: { groupLabel: { label: "Support", labelKey: "kernel.homeGroupSupport" } },
  })
  resetHomeCardLayout()
  resetThreadStore()
  apiGet.mockReset().mockResolvedValue([])
  apiGetEnvelope.mockReset().mockResolvedValue({ data: { items: [], errors: [] } })
  apiPost.mockReset().mockResolvedValue({})
})

describe("a language switch re-renders the Home feed, it does not remount it", () => {
  it("keeps every Activity group's element, and the reader's open or closed choice", () => {
    attentionStore._setForTest({
      items: [
        item({ id: "t1" }),
        item({ id: "t2", entityId: "T2" }),
        item({
          id: "n1",
          app: "kernel",
          entity: "routine",
          entityId: "R1",
          kind: "agent_notification",
          urgency: 10,
        }),
      ],
      errors: [],
    })
    render(() => (
      <I18nProvider initialLocale="en">
        <GrabI18n />
        <Home entityId="home" />
      </I18nProvider>
    ))
    const keys = ["tickets", "kernel::notifications"]
    const before = new Map(keys.map((k) => [k, screen.getByTestId(`home-group-${k}`)]))
    // The reader folds the notifications group away.
    const notifications = before.get("kernel::notifications") as HTMLDetailsElement
    notifications.open = false
    expect(notifications.textContent).toContain("Notifications")

    i18n?.setLocale("fr")

    expect(screen.getByTestId("home-group-tickets").textContent).toContain("Assistance")
    for (const [key, el] of before) expect(screen.getByTestId(`home-group-${key}`)).toBe(el)
    expect(
      (screen.getByTestId("home-group-kernel::notifications") as HTMLDetailsElement).open,
    ).toBe(false)
  })
})
