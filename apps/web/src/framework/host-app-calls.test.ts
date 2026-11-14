// SPDX-License-Identifier: FSL-1.1-ALv2
// The typed host calls an app's screens make (host API 1.3), answered by the
// page with the person's session and limited to the calling app.
import { afterEach, describe, expect, it, vi } from "vitest"

const confirm = vi.hoisted(() => ({
  answer: true,
  asked: [] as unknown[],
  /** Runs while the dialog is open (an edit made meanwhile). */
  during: null as null | (() => void),
}))
vi.mock("~/modules/shell/app-approval-confirm", () => ({
  confirmAppApproval: vi.fn(async (request: unknown) => {
    confirm.asked.push(request)
    confirm.during?.()
    return confirm.answer
  }),
}))
const desktop = vi.hoisted(() => ({ native: false, opened: [] as string[] }))
vi.mock("~/modules/desktop/desktop-store", () => ({
  canOpenDownloadedFile: () => desktop.native,
  openDownloadedFile: vi.fn(async (_bytes: Uint8Array, name: string) => {
    desktop.opened.push(name)
    return true
  }),
}))

import {
  buildAppHostCalls,
  externalTarget,
  hostDeclared,
  setAppExternalHosts,
} from "./host-app-calls"

function deps(answers: Record<string, unknown> = {}) {
  // What the host fetched (a spy beside the generic fetch, which a mock would not keep generic).
  const calls = vi.fn((_path: string, _init?: RequestInit) => {})
  const fetch = <T>(path: string, init?: RequestInit): Promise<T> => {
    if (init === undefined) calls(path)
    else calls(path, init)
    return Promise.resolve((answers[path.split("?")[0] as string] ?? answers[path]) as T)
  }
  return {
    fetch,
    calls,
    fetchBlob: vi.fn(async (_path: string) => new Blob(["%PDF"], { type: "application/pdf" })),
    navigate: vi.fn((_path: string) => {}),
    // The decision queue's seam: what the host hands it to send.
    decide: vi.fn(
      async (
        _id: string,
        _body: { decision: "approve" | "deny"; payloadHash?: string },
        _label: { title: string } | null,
      ) => ({ ok: true }),
    ),
  }
}

afterEach(() => {
  confirm.answer = true
  confirm.asked = []
  confirm.during = null
  desktop.native = false
  desktop.opened = []
  vi.restoreAllMocks()
})

describe("openExternal", () => {
  const declared = ["*.myshopify.com", "admin.shopify.com"]
  const page = "https://acme.liaison.test"

  it("opens only https pages of declared hosts, never the page's own origin", () => {
    expect(externalTarget("https://shop.myshopify.com/admin", declared, page)).toBe(
      "https://shop.myshopify.com/admin",
    )
    expect(externalTarget("https://admin.shopify.com/store/x", declared, page)).not.toBeNull()
    expect(externalTarget("javascript:alert(1)", declared, page)).toBeNull()
    expect(externalTarget("http://shop.myshopify.com/", declared, page)).toBeNull()
    expect(externalTarget("https://evil.test/", declared, page)).toBeNull()
    expect(externalTarget("https://myshopify.com/", declared, page)).toBeNull()
    expect(externalTarget(`${page}/approvals`, [...declared, "acme.liaison.test"], page)).toBeNull()
    expect(externalTarget("https://u:p@shop.myshopify.com/", declared, page)).toBeNull()
    expect(hostDeclared("a.b.myshopify.com", declared)).toBe(true)
  })

  it("opens with noopener and noreferrer, and refuses an undeclared host", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null)
    setAppExternalHosts("shopify", ["*.myshopify.com"])
    const calls = buildAppHostCalls(deps())
    await calls.openExternal("shopify", "https://shop.myshopify.com/admin/orders")
    expect(open).toHaveBeenCalledWith(
      "https://shop.myshopify.com/admin/orders",
      "_blank",
      "noopener,noreferrer",
    )
    await expect(calls.openExternal("shopify", "javascript:alert(1)")).rejects.toThrow()
    await expect(calls.openExternal("boxtal", "https://shop.myshopify.com/")).rejects.toThrow()
    expect(open).toHaveBeenCalledTimes(1)
  })
})

describe("editApproval", () => {
  it("edits only this app's pending approval, through the approvals route", async () => {
    const d = deps({
      "/api/approvals/a1": { id: "a1", status: "pending", toolName: "invoicing:issue" },
      "/api/approvals/a2": { id: "a2", status: "pending", toolName: "boxtal:create_shipment" },
      "/api/approvals/a2/payload": { payloadHash: "h2", currentPayload: { amountMinor: "500" } },
    })
    await expect(
      buildAppHostCalls(d).editApproval("boxtal", "a1", { amountMinor: "500" }),
    ).rejects.toThrow(/not an approval of this app/)
    expect(d.calls).not.toHaveBeenCalledWith("/api/approvals/a1/payload", expect.anything())
    const edited = await buildAppHostCalls(d).editApproval("boxtal", "a2", { amountMinor: "500" })
    expect(edited).toEqual({ payloadHash: "h2", currentPayload: { amountMinor: "500" } })
    expect(d.calls).toHaveBeenCalledWith("/api/approvals/a2/payload", {
      method: "POST",
      body: JSON.stringify({ fields: { amountMinor: "500" } }),
    })
  })
})

describe("decideApproval", () => {
  it("refuses another app's approval, before any dialog", async () => {
    const d = deps({
      "/api/approvals/a1": { id: "a1", status: "pending", toolName: "invoicing:issue" },
    })
    await expect(
      buildAppHostCalls(d).decideApproval("boxtal", "a1", "approve", "h"),
    ).rejects.toThrow(/not an approval of this app/)
    expect(confirm.asked).toHaveLength(0)
    expect(d.calls).toHaveBeenCalledTimes(1)
    expect(d.decide).not.toHaveBeenCalled()
  })

  it("asks the person in the host's dialog, and sends nothing when they cancel", async () => {
    const d = deps({
      "/api/approvals/a1": {
        id: "a1",
        status: "pending",
        toolName: "boxtal:create_shipment",
        payloadHash: "h",
        summary: { title: "Buy a label", lines: ["Colissimo, 12.40 EUR"] },
      },
    })
    confirm.answer = false
    await expect(
      buildAppHostCalls(d).decideApproval("boxtal", "a1", "approve", "h"),
    ).rejects.toThrow(/cancelled/)
    expect(confirm.asked).toEqual([
      { app: "boxtal", decision: "approve", title: "Buy a label", lines: ["Colissimo, 12.40 EUR"] },
    ])
    expect(d.calls).toHaveBeenCalledTimes(1)
    expect(d.decide).not.toHaveBeenCalled()
  })

  it("decides after the confirm, bound to the payload fingerprint the host read", async () => {
    const d = deps({
      "/api/approvals/a1": {
        id: "a1",
        status: "pending",
        toolName: "boxtal:create_shipment",
        payloadHash: "hash-1",
      },
    })
    // The app may pass nothing: the host's own reading is what is approved.
    await buildAppHostCalls(d).decideApproval("boxtal", "a1", "approve")
    expect(d.decide).toHaveBeenCalledTimes(1)
    expect(d.decide).toHaveBeenLastCalledWith(
      "a1",
      { decision: "approve", payloadHash: "hash-1" },
      { title: "boxtal:create_shipment" },
    )
  })

  it("refuses an app fingerprint that is not the one the host read, before any dialog", async () => {
    const d = deps({
      "/api/approvals/a1": {
        id: "a1",
        status: "pending",
        toolName: "boxtal:create_shipment",
        payloadHash: "hash-shown",
      },
    })
    await expect(
      buildAppHostCalls(d).decideApproval("boxtal", "a1", "approve", "hash-newer"),
    ).rejects.toThrow(/changed since the app showed it/)
    expect(confirm.asked).toHaveLength(0)
    expect(d.calls).toHaveBeenCalledTimes(1)
    expect(d.decide).not.toHaveBeenCalled()
  })

  it("refuses the approve when the payload is edited while the dialog is open", async () => {
    const answers: Record<string, unknown> = {
      "/api/approvals/a1": {
        id: "a1",
        status: "pending",
        toolName: "boxtal:create_shipment",
        payloadHash: "hash-shown",
      },
    }
    const d = deps(answers)
    confirm.during = () => {
      answers["/api/approvals/a1"] = {
        id: "a1",
        status: "pending",
        toolName: "boxtal:create_shipment",
        payloadHash: "hash-edited",
      }
    }
    await expect(
      buildAppHostCalls(d).decideApproval("boxtal", "a1", "approve", "hash-shown"),
    ).rejects.toThrow(/changed while you were deciding/)
    // Read, re-read, and no decide.
    expect(d.calls).toHaveBeenCalledTimes(2)
    expect(d.decide).not.toHaveBeenCalled()
  })

  it("denies without a fingerprint", async () => {
    const d = deps({
      "/api/approvals/a1": { id: "a1", status: "pending", toolName: "boxtal:create_shipment" },
    })
    await buildAppHostCalls(d).decideApproval("boxtal", "a1", "deny")
    expect(d.decide).toHaveBeenCalledTimes(1)
    expect(d.decide).toHaveBeenLastCalledWith(
      "a1",
      { decision: "deny" },
      { title: "boxtal:create_shipment" },
    )
  })
})

describe("listMyApprovals, print, records", () => {
  it("lists only the calling app's tools", async () => {
    const d = deps({
      "/api/approvals": [
        { id: "a", toolName: "boxtal:create_shipment" },
        { id: "b", toolName: "invoicing:issue" },
      ],
    })
    expect(await buildAppHostCalls(d).listMyApprovals("boxtal")).toEqual([
      { id: "a", toolName: "boxtal:create_shipment" },
    ])
    expect(d.calls).toHaveBeenCalledWith(
      "/api/approvals?status=pending&decidableByMe=true&app=boxtal",
    )
  })

  it("prints with the calling app pinned", async () => {
    const d = deps()
    await buildAppHostCalls(d).printDocuments("boxtal", {
      entity: "shipment",
      id: "s1",
      templateIds: ["t1", "../x"],
    })
    expect(d.calls).toHaveBeenCalledWith("/api/documents/print", {
      method: "POST",
      body: JSON.stringify({
        app: "boxtal",
        entity: "shipment",
        recordId: "s1",
        templateIds: ["t1"],
      }),
    })
  })

  it("opens a record of another app through its tab, or its detail page", () => {
    const d = deps()
    buildAppHostCalls(d).openRecord("shopify", "invoicing", "document", "doc-1")
    expect(d.navigate).toHaveBeenCalledWith("/detail/invoicing/document/doc-1")
    expect(() =>
      buildAppHostCalls(d).openRecord("shopify", "invoicing", "document", "../x"),
    ).toThrow()
    buildAppHostCalls(d).openApprovals()
    expect(d.navigate).toHaveBeenLastCalledWith("/approvals")
  })
})

describe("openFileById", () => {
  it("hands the bytes to the desktop viewer, never to the app", async () => {
    desktop.native = true
    const d = deps()
    await buildAppHostCalls(d).openFileById("boxtal", "file-0001", "label.pdf")
    expect(d.fetchBlob).toHaveBeenCalledWith("/api/files/file-0001/inline")
    expect(desktop.opened).toEqual(["label.pdf"])
  })

  it("opens a browser tab it pre-opened, and refuses a path-shaped id", async () => {
    const tab = { location: { href: "" }, closed: false, close: vi.fn(), opener: {} }
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window)
    URL.createObjectURL = vi.fn(() => "blob:x")
    URL.revokeObjectURL = vi.fn()
    const d = deps()
    await buildAppHostCalls(d).openFileById("boxtal", "file-0001", "label.pdf")
    expect(tab.location.href).toBe("blob:x")
    expect(tab.opener).toBeNull()
    await expect(buildAppHostCalls(d).openFileById("boxtal", "../x", "a")).rejects.toThrow()
  })
})
