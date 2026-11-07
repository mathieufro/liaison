// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Surface 80: with Language = Français the feed's ITEMS came back translated
// from the server-side translator while the feed's own CHROME stayed English.
// The greeting, the count line, the section and group labels and the row and
// group controls were literals in the component, so no locale could reach
// them. Item titles and bodies are the translator's job and are not asserted
// here.
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
import { I18nProvider } from "~/modules/i18n/i18n-context"
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

function renderHome(locale: "en" | "fr") {
  return render(() => (
    <I18nProvider initialLocale={locale}>
      <Home entityId="home" />
    </I18nProvider>
  ))
}

beforeEach(() => {
  attentionStore._setForTest({ items: [], errors: [], loading: false })
  resetRegistry()
  registerManifestAppData("tickets", {
    attention: { groupLabel: { label: "Support", labelKey: "kernel.homeGroupSupport" } },
  })
  registerManifestAppData("knowledge", {
    attention: { groupLabel: { label: "Knowledge", labelKey: "kernel.homeGroupKnowledge" } },
  })
  resetHomeCardLayout()
  resetThreadStore()
  apiGet.mockReset().mockResolvedValue([])
  apiGetEnvelope.mockReset().mockResolvedValue({ data: { items: [], errors: [] } })
  apiPost.mockReset().mockResolvedValue({})
})

describe("the attention feed chrome follows the reader's language", () => {
  it("greets in French and counts in French", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-05-06T09:00:00.000Z"))
    try {
      attentionStore._setForTest({
        items: [item({ id: "a1", app: "kernel", kind: "system_alert", urgency: 90 })],
        errors: [],
        lastFetchedAt: Date.now(),
      })
      renderHome("fr")
      expect(screen.getByTestId("home-greeting").textContent).toContain("Bonjour")
      const status = screen.getByTestId("home-status").textContent ?? ""
      expect(status).toContain("REQUIERT VOTRE ATTENTION")
      expect(status).not.toContain("NEEDS YOU NOW")
      expect(status).toContain("MIS À JOUR")
    } finally {
      vi.useRealTimers()
    }
  })

  it("says nothing is urgent, in French, when only grouped work is left", () => {
    attentionStore._setForTest({
      items: [item({ id: "g1" }), item({ id: "g2", entityId: "T2" })],
      errors: [],
    })
    renderHome("fr")
    const status = screen.getByTestId("home-status").textContent ?? ""
    expect(status).toContain("RIEN D'URGENT")
    expect(status).toContain("DANS VOS AUTRES TÂCHES")
  })

  // D21: the card holds the alerts only (conversations left Home), so its
  // title is the French "Alertes" and there is no Unread section.
  it("titles the Alerts card in French", () => {
    attentionStore._setForTest({
      items: [item({ id: "a1", app: "kernel", kind: "system_alert", urgency: 90 })],
      errors: [],
    })
    renderHome("fr")
    expect(screen.getByTestId("home-card-messages").textContent).toContain("Alertes")
    expect(screen.queryByTestId("home-unread-label")).toBeNull()
  })

  it("names the Activity groups and their mark-all-read control in French", () => {
    attentionStore._setForTest({
      items: [
        item({ id: "t1" }),
        item({ id: "t2", entityId: "T2" }),
        item({ id: "k1", app: "knowledge", entity: "article", entityId: "K1", kind: "nudge_due" }),
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
    renderHome("fr")
    expect(screen.getByTestId("home-group-tickets").textContent).toContain("Assistance")
    expect(screen.getByTestId("home-group-knowledge").textContent).toContain("Connaissances")
    expect(screen.getByTestId("home-group-kernel::notifications").textContent).toContain(
      "Notifications",
    )
    expect(screen.getByTestId("home-group-tickets-mark-read").textContent).toBe(
      "Tout marquer comme lu",
    )
  })

  it("folds the approvals list with a French Show more control", () => {
    attentionStore._setForTest({
      items: Array.from({ length: 10 }, (_v, i) =>
        item({
          id: `ap-${i}`,
          app: "invoicing",
          entity: "document",
          entityId: `doc-${i}`,
          kind: "approval_pending",
          urgency: 40,
          action: { type: "decide_approval", approvalId: `doc-${i}` },
        }),
      ),
      errors: [],
    })
    renderHome("fr")
    const fold = screen.getByTestId("home-approvals-fold").textContent ?? ""
    expect(fold).toContain("Afficher")
    expect(fold).toContain("de plus")
    expect(fold).not.toContain("Show")
  })

  it("translates the row actions", () => {
    attentionStore._setForTest({
      items: [item({ id: "t1" })],
      errors: [],
    })
    renderHome("fr")
    const row = screen.getByTestId("home-group-tickets").textContent ?? ""
    expect(row).toContain("Ouvrir")
    expect(row).not.toContain("Open")
  })

  it("says how long ago in French, instead of a hand built English phrase", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-05-06T12:00:00.000Z"))
    try {
      attentionStore._setForTest({
        items: [item({ id: "a1", app: "kernel", kind: "system_alert", urgency: 90 })],
        errors: [],
        lastFetchedAt: Date.now(),
      })
      renderHome("fr")
      const status = screen.getByTestId("home-status").textContent ?? ""
      // "MIS A JOUR JUST NOW": the label translated, the figure beside it did not.
      expect(status).toContain("à l'instant")
      expect(status).not.toContain("just now")
      expect(status).not.toContain("ago")
    } finally {
      vi.useRealTimers()
    }
  })

  it("counts an hours old feed in French", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-05-06T12:00:00.000Z"))
    try {
      attentionStore._setForTest({
        items: [item({ id: "a1", app: "kernel", kind: "system_alert", urgency: 90 })],
        errors: [],
        lastFetchedAt: Date.now() - 5 * 3600 * 1000,
      })
      renderHome("fr")
      const status = screen.getByTestId("home-status").textContent ?? ""
      expect(status).toContain("il y a 5")
      expect(status).not.toContain("5h ago")
      // The narrow French form is "-5 h": a signed quantity, not an age.
      expect(status).not.toContain("-5")
    } finally {
      vi.useRealTimers()
    }
  })

  it("writes each section count line in French, with the French plural rule", () => {
    attentionStore._setForTest({
      items: [
        item({ id: "b1", app: "projects", entity: "task", entityId: "P1", kind: "task_blocked" }),
        item({ id: "b2", app: "projects", entity: "task", entityId: "P2", kind: "task_blocked" }),
        item({
          id: "k1",
          app: "knowledge",
          entity: "article",
          entityId: "K1",
          kind: "knowledge:knowledge_review",
        } as never),
        item({
          id: "k2",
          app: "knowledge",
          entity: "article",
          entityId: "K2",
          kind: "knowledge:knowledge_review",
        } as never),
      ],
      errors: [],
    })
    renderHome("fr")
    const projects = screen.getByTestId("home-group-projects-kinds").textContent ?? ""
    expect(projects).toBe("2 bloqués")
    const knowledge = screen.getByTestId("home-group-knowledge-kinds").textContent ?? ""
    expect(knowledge).toBe("2 revues de connaissances")
  })

  it("cites a row's source in French", () => {
    attentionStore._setForTest({
      items: [
        item({ id: "t1" }),
        item({ id: "t2", entityId: "T2" }),
        item({ id: "k1", app: "knowledge", entity: "article", entityId: "K1", kind: "nudge_due" }),
        item({ id: "k2", app: "knowledge", entity: "article", entityId: "K2", kind: "nudge_due" }),
      ],
      errors: [],
    })
    renderHome("fr")
    const tickets = screen.getByTestId("home-group-tickets").textContent ?? ""
    const knowledge = screen.getByTestId("home-group-knowledge").textContent ?? ""
    expect(knowledge).toContain("Connaissances")
    expect(knowledge).not.toContain("Knowledge ·")
    expect(tickets).toContain("Tickets")
  })

  it("writes the alert cluster in French, control and age included", () => {
    attentionStore._setForTest({
      items: [
        item({ id: "s1", app: "tickets", kind: "sla_risk", urgency: 90, entityId: "T1" }),
        item({ id: "s2", app: "tickets", kind: "sla_risk", urgency: 90, entityId: "T2" }),
      ],
      errors: [],
    })
    renderHome("fr")
    const cluster = screen.getByTestId("alert-cluster-tickets::sla_risk").textContent ?? ""
    expect(cluster).toContain("tickets proches du SLA")
    expect(cluster).toContain("Afficher")
    expect(cluster).not.toContain("Show")
    expect(cluster).toContain("la plus ancienne")
    expect(cluster).not.toContain("oldest")
    expect(cluster).not.toContain(" ago")
  })

  it("leaves the same alert cluster in English for an English reader", () => {
    attentionStore._setForTest({
      items: [
        item({ id: "s1", app: "tickets", kind: "sla_risk", urgency: 90, entityId: "T1" }),
        item({ id: "s2", app: "tickets", kind: "sla_risk", urgency: 90, entityId: "T2" }),
      ],
      errors: [],
    })
    renderHome("en")
    const cluster = screen.getByTestId("alert-cluster-tickets::sla_risk").textContent ?? ""
    expect(cluster).toContain("2 tickets approaching SLA")
    expect(cluster).toContain("Show")
    expect(cluster).toContain("oldest")
  })

  it("keeps the English chrome English", () => {
    attentionStore._setForTest({
      items: [item({ id: "a1", app: "kernel", kind: "system_alert", urgency: 90 })],
      errors: [],
    })
    renderHome("en")
    expect(screen.getByTestId("home-status").textContent).toContain("NEEDS YOU NOW")
  })
})
