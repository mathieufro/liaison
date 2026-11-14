// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it, vi } from "vitest"

const contact = {
  id: "c1",
  handle: "@c1",
  name: "Alice",
  email: "a@x.com",
  phone: null,
  company: "Acme",
  externalIds: {},
  metadata: null,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
}

describe("contact-detail-store", () => {
  beforeEach(() => vi.resetModules())

  it("loadContact stores contact by id", async () => {
    const api = { get: vi.fn().mockResolvedValue({ data: contact }) }
    const { contactDetailStore, loadContact } = await import("./contact-detail-store")

    await loadContact(api as any, "c1")

    expect(api.get).toHaveBeenCalledWith("/contacts/c1")
    expect(contactDetailStore.contacts.c1).toEqual(contact)
  })

  it("loadContact resolves a 404 (another org's contact) to null instead of throwing", async () => {
    const { ApiError } = await import("~/lib/api-error")
    const api = { get: vi.fn().mockRejectedValue(new ApiError("Contact not found", 404)) }
    const { contactDetailStore, loadContact } = await import("./contact-detail-store")

    await expect(loadContact(api as any, "foreign")).resolves.toBeNull()
    expect(contactDetailStore.contacts.foreign).toBeUndefined()
  })

  it("loadContact still throws a failure that is not a missing contact", async () => {
    const { ApiError } = await import("~/lib/api-error")
    const api = { get: vi.fn().mockRejectedValue(new ApiError("boom", 500)) }
    const { loadContact } = await import("./contact-detail-store")

    await expect(loadContact(api as any, "c1")).rejects.toThrow("boom")
  })

  it("openContactDiscussion opens the contact's thread once, and again after a share", async () => {
    const api = {
      get: vi.fn(),
      post: vi.fn().mockResolvedValue({ data: { threadId: "t1" } }),
    }
    const { contactDetailStore, handleContactEvent, openContactDiscussion } = await import(
      "./contact-detail-store"
    )
    await expect(openContactDiscussion(api as any, "c1")).resolves.toBe("t1")
    await expect(openContactDiscussion(api as any, "c1")).resolves.toBe("t1")
    expect(api.post).toHaveBeenCalledTimes(1)
    expect(api.post).toHaveBeenCalledWith("/contacts/c1/discussion")
    expect(contactDetailStore.discussions.c1).toBe("t1")
    // Who is in it follows the contact's sharing: the page opens it again.
    handleContactEvent("share", { id: "c1" })
    expect(contactDetailStore.discussions.c1).toBeUndefined()
  })

  it("openContactDiscussion throws when the contact is out of reach", async () => {
    const { ApiError } = await import("~/lib/api-error")
    const api = { get: vi.fn(), post: vi.fn().mockRejectedValue(new ApiError("nope", 404)) }
    const { contactDetailStore, openContactDiscussion } = await import("./contact-detail-store")
    await expect(openContactDiscussion(api as any, "c2")).rejects.toThrow("nope")
    expect(contactDetailStore.discussions.c2).toBeUndefined()
  })

  it("loadOptOut keeps when and by what for a reader of the opt-out list", async () => {
    const api = {
      post: vi.fn().mockResolvedValue({
        results: [
          { email: "a@x.com", optedOut: true, since: "2026-11-06T09:00:00.000Z", by: "link" },
        ],
      }),
    }
    const { contactDetailStore, loadOptOut } = await import("./contact-detail-store")
    await loadOptOut(api as any, "c1", "a@x.com")
    expect(api.post).toHaveBeenCalledWith("/apps/mail/tools/suppression_check", {
      params: { emails: ["a@x.com"] },
    })
    expect(contactDetailStore.optOuts.c1).toEqual({
      state: "opted_out",
      since: "2026-11-06T09:00:00.000Z",
      by: "link",
    })
  })

  it("loadOptOut says allowed for an address that did not opt out and for a contact with no address", async () => {
    const api = {
      post: vi.fn().mockResolvedValue({ results: [{ email: "a@x.com", optedOut: false }] }),
    }
    const { contactDetailStore, loadOptOut } = await import("./contact-detail-store")
    await loadOptOut(api as any, "c1", "a@x.com")
    expect(contactDetailStore.optOuts.c1).toEqual({ state: "allowed" })
    await loadOptOut(api as any, "c2", null)
    expect(contactDetailStore.optOuts.c2).toEqual({ state: "allowed" })
    expect(api.post).toHaveBeenCalledTimes(1)
  })

  it("loadOptOut is unavailable, never allowed, when the check fails or answers with an error", async () => {
    const { contactDetailStore, loadOptOut } = await import("./contact-detail-store")
    await loadOptOut(
      { post: vi.fn().mockRejectedValue(new Error("forbidden")) } as any,
      "c1",
      "a@x.com",
    )
    expect(contactDetailStore.optOuts.c1).toEqual({ state: "unavailable" })
    await loadOptOut(
      { post: vi.fn().mockResolvedValue({ error: { code: "x" } }) } as any,
      "c2",
      "b@x.com",
    )
    expect(contactDetailStore.optOuts.c2).toEqual({ state: "unavailable" })
  })

  it("updateContact patches and stores the updated contact", async () => {
    const updated = { ...contact, name: "Alice Updated" }
    const api = { patch: vi.fn().mockResolvedValue({ data: updated }) }
    const { contactDetailStore, updateContact } = await import("./contact-detail-store")

    await updateContact(api as any, "c1", { name: "Alice Updated" })

    expect(api.patch).toHaveBeenCalledWith("/contacts/c1", { name: "Alice Updated" })
    expect(contactDetailStore.contacts.c1.name).toBe("Alice Updated")
  })

  it("handleContactEvent update and delete mutate cached contacts", async () => {
    const { contactDetailStore, handleContactEvent } = await import("./contact-detail-store")

    handleContactEvent("update", contact)
    expect(contactDetailStore.contacts.c1.name).toBe("Alice")
    handleContactEvent("delete", { id: "c1" })
    expect(contactDetailStore.contacts.c1).toBeUndefined()
  })
})
