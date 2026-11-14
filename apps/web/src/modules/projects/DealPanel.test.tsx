// SPDX-License-Identifier: FSL-1.1-ALv2
// The deal panel on a deal's task page: the amount only with deal access,
// company and contact always, buttons only with deal write, the routine line
// only when a deal follow-up routine is active, and its own error state.
import { fireEvent, render, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import type { DealRead } from "~/modules/projects/deal-api"

const mocks = vi.hoisted(() => ({
  scopes: [] as string[],
  openTab: vi.fn(),
}))

vi.mock("~/modules/auth/auth-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/auth/auth-store")>()),
  hasScope: (scope: string) => mocks.scopes.some((s) => scope === s || scope.startsWith(`${s}:`)),
}))
vi.mock("~/modules/shell/tab-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/shell/tab-store")>()),
  openTab: mocks.openTab,
}))

import { DealPanel } from "./DealPanel"

function dealRead(over: Partial<DealRead["deal"]> = {}, withValues = true): DealRead {
  return {
    task: {
      id: "t14",
      key: "SALES-14",
      title: "Maison Arlon, 4 more hotels",
      projectId: "p1",
      stage: "Proposal",
      ownerId: "u-tom",
    },
    deal: {
      companyId: "c-arlon",
      companyName: "Maison Arlon",
      contactId: "k-claire",
      outcome: "open",
      nextStep: "Tom to confirm the rollout date",
      lostReason: null,
      closedAt: null,
      closedBy: null,
      ...over,
    },
    ...(withValues
      ? {
          values: {
            amountMinor: 1_740_000,
            currency: "EUR",
            amountPeriod: "year" as const,
            probability: null,
          },
        }
      : {}),
  }
}

interface Routes {
  deal?: DealRead | Error
  routines?: Array<{ name: string; templateKey: string | null; enabled: boolean; status: string }>
}

function makeApi(routes: Routes) {
  const post = vi.fn().mockImplementation(async (path: string, body: { toolName?: string }) => {
    if (path === "/apps/run-tool" && body.toolName === "projects:deals_search") {
      if (routes.deal instanceof Error) throw routes.deal
      return { items: routes.deal ? [routes.deal] : [], count: routes.deal ? 1 : 0 }
    }
    if (path === "/apps/run-tool" && body.toolName === "projects:deals_update") return {}
    throw new ApiError("Not found", 404)
  })
  const get = vi.fn().mockImplementation(async (path: string) => {
    if (path === "/contacts/k-claire") return { id: "k-claire", name: "Claire Vidal" }
    if (path.startsWith("/agent/routines")) {
      return path.includes("shared") ? [] : (routes.routines ?? [])
    }
    throw new ApiError("Not found", 404)
  })
  return { post, get }
}

beforeEach(() => {
  mocks.scopes = []
  mocks.openTab.mockReset()
})

describe("DealPanel", () => {
  it("with deal access the amount shows; without it Needs deal access with company and contact still linked", async () => {
    mocks.scopes = ["projects:deals:read"]
    const withAccess = render(() => <DealPanel api={makeApi({ deal: dealRead() })} taskId="t14" />)
    await waitFor(() =>
      expect(withAccess.getByTestId("deal-panel.amount").textContent).toContain("17,400"),
    )
    expect(withAccess.getByTestId("deal-panel.amount").textContent).toContain("per year")
    withAccess.unmount()

    mocks.scopes = []
    const without = render(() => (
      <DealPanel api={makeApi({ deal: dealRead({}, false) })} taskId="t14" />
    ))
    await waitFor(() =>
      expect(without.getByTestId("deal-panel.amount").textContent).toBe("Needs deal access"),
    )
    expect(without.getByTestId("deal-panel.company-link").textContent).toBe("Maison Arlon")
    await waitFor(() =>
      expect(without.getByTestId("deal-panel.contact-link").textContent).toBe("Claire Vidal"),
    )
    fireEvent.click(without.getByTestId("deal-panel.company-link"))
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: "company-detail", entityId: "c-arlon" }),
    )
    fireEvent.click(without.getByTestId("deal-panel.contact-link"))
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: "contact-detail", entityId: "k-claire" }),
    )
  })

  it("a failed deal read shows its own error line", async () => {
    const { findByTestId, queryByTestId } = render(() => (
      <DealPanel api={makeApi({ deal: new ApiError("down", 503) })} taskId="t14" />
    ))
    expect((await findByTestId("deal-panel.error")).textContent).toBe(
      "Could not read the deal. The task below is not affected.",
    )
    expect(queryByTestId("deal-panel")).toBeNull()
  })

  it("without deal write the buttons are hidden", async () => {
    mocks.scopes = ["projects:deals:read"]
    const view = render(() => <DealPanel api={makeApi({ deal: dealRead() })} taskId="t14" />)
    await view.findByTestId("deal-panel")
    expect(view.queryByTestId("deal-panel.mark-won")).toBeNull()
    expect(view.queryByTestId("deal-panel.mark-lost")).toBeNull()
    expect(view.queryByTestId("deal-panel.reopen")).toBeNull()
  })

  it("with deal write, Mark lost asks an optional reason inline and sends it; a lost deal offers Reopen", async () => {
    mocks.scopes = ["projects:deals:read", "projects:deals:write"]
    const api = makeApi({ deal: dealRead() })
    const view = render(() => <DealPanel api={api} taskId="t14" />)
    fireEvent.click(await view.findByTestId("deal-panel.mark-lost"))
    fireEvent.input(view.getByTestId("deal-panel.lost-reason"), {
      target: { value: "Chose another tool" },
    })
    fireEvent.click(view.getByTestId("deal-panel.lost-confirm"))
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/apps/run-tool", {
        toolName: "projects:deals_update",
        params: { taskId: "t14", outcome: "lost", reason: "Chose another tool" },
      }),
    )
    view.unmount()

    const lost = render(() => (
      <DealPanel
        api={makeApi({
          deal: dealRead({
            outcome: "lost",
            closedAt: "2026-11-02T10:00:00Z",
            lostReason: "Chose another tool",
          }),
        })}
        taskId="t14"
      />
    ))
    expect(await lost.findByTestId("deal-panel.reopen")).toBeTruthy()
    expect(lost.queryByTestId("deal-panel.mark-won")).toBeNull()
    expect(lost.getByTestId("deal-panel.lost-reason-text").textContent).toBe("Chose another tool")
  })

  it("the routine line shows only when a routine covers the pipeline", async () => {
    const none = render(() => (
      <DealPanel
        api={makeApi({
          deal: dealRead(),
          routines: [
            {
              name: "Morning brief",
              templateKey: "morning-brief",
              enabled: true,
              status: "active",
            },
            {
              name: "Deal follow-ups",
              templateKey: "deal-followups",
              enabled: false,
              status: "active",
            },
          ],
        })}
        taskId="t14"
        ownerName="Tom Reyes"
      />
    ))
    await none.findByTestId("deal-panel")
    // Give the routine read its turn before asserting the line stays absent.
    await new Promise((r) => setTimeout(r, 0))
    expect(none.queryByTestId("deal-panel.routine-line")).toBeNull()
    none.unmount()

    const covered = render(() => (
      <DealPanel
        api={makeApi({
          deal: dealRead(),
          routines: [
            {
              name: "Deal follow-ups",
              templateKey: "deal-followups",
              enabled: true,
              status: "active",
            },
          ],
        })}
        taskId="t14"
        ownerName="Tom Reyes"
      />
    ))
    expect((await covered.findByTestId("deal-panel.routine-line")).textContent).toBe(
      "Routine Deal follow-ups drafts follow-ups for quiet deals here, and Tom Reyes approves each before it goes out.",
    )
  })
})
