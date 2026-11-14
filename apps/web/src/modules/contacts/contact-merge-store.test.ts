// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it, vi } from "vitest"

describe("contact-merge-store", () => {
  beforeEach(() => vi.resetModules())

  it("openMerge initializes source and search step", async () => {
    const { mergeStore, openMerge } = await import("./contact-merge-store")

    openMerge("source-1")

    expect(mergeStore.open).toBe(true)
    expect(mergeStore.sourceId).toBe("source-1")
    expect(mergeStore.step).toBe("search")
  })

  it("searchTargets loads target candidates", async () => {
    const api = {
      getEnvelope: vi.fn().mockResolvedValue({ data: [{ id: "target-1", name: "Target" }] }),
    }
    const { mergeStore, searchTargets } = await import("./contact-merge-store")

    await searchTargets(api as any, "Target")

    expect(api.getEnvelope).toHaveBeenCalledWith("/contacts?query=Target&page=1&limit=20")
    expect(mergeStore.targetCandidates[0].id).toBe("target-1")
  })

  it("loadSourceConversations counts the source contact's mail conversations", async () => {
    const api = { getEnvelope: vi.fn().mockResolvedValue({ data: [{ id: "c1" }, { id: "c2" }] }) }
    const { loadSourceConversations, mergeStore, openMerge } = await import("./contact-merge-store")

    openMerge("source-1")
    await loadSourceConversations(api as any)

    expect(api.getEnvelope).toHaveBeenCalledWith("/mail/conversations?contactId=source-1&limit=100")
    expect(mergeStore.sourceConversations).toBe(2)
  })

  it("loadSourceConversations counts none when mail cannot be read", async () => {
    const api = { getEnvelope: vi.fn().mockRejectedValue(new Error("forbidden")) }
    const { loadSourceConversations, mergeStore, openMerge } = await import("./contact-merge-store")

    openMerge("source-1")
    await loadSourceConversations(api as any)

    expect(mergeStore.sourceConversations).toBe(0)
  })

  it("selectTarget and setFieldChoice advance comparison state", async () => {
    const { mergeStore, selectTarget, setFieldChoice } = await import("./contact-merge-store")

    selectTarget("target-1")
    setFieldChoice("name", "Target Name")

    expect(mergeStore.targetId).toBe("target-1")
    expect(mergeStore.step).toBe("compare")
    expect(mergeStore.resolvedFields.name).toBe("Target Name")
  })

  it("confirmMerge posts merge and closes state", async () => {
    const api = { post: vi.fn().mockResolvedValue({ data: { contact: { id: "target-1" } } }) }
    const { confirmMerge, mergeStore, openMerge, selectTarget, setFieldChoice } = await import(
      "./contact-merge-store"
    )

    openMerge("source-1")
    selectTarget("target-1")
    setFieldChoice("name", "Merged")
    const result = await confirmMerge(api as any)

    expect(api.post).toHaveBeenCalledWith("/contacts/merge", {
      sourceId: "source-1",
      targetId: "target-1",
      resolvedFields: { name: "Merged" },
    })
    expect(result.contact.id).toBe("target-1")
    expect(mergeStore.open).toBe(false)
    expect(mergeStore.sourceId).toBeNull()
    expect(mergeStore.targetId).toBeNull()
    expect(mergeStore.targetCandidates).toEqual([])
    expect(mergeStore.resolvedFields).toEqual({})
  })
})
