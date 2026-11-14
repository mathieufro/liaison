// SPDX-License-Identifier: FSL-1.1-ALv2
// `dock.prefill` opens the person's conversation with their own agent and leaves the words in
// its composer for them to send: it never posts a message.
import { beforeEach, describe, expect, it, vi } from "vitest"

const dm = vi.hoisted(() => ({
  personalAgentDmFor: vi.fn(async () => "dm-1"),
  revealPersonalAgentDm: vi.fn(),
  sendMessage: vi.fn(),
}))
vi.mock("~/modules/threads/personal-dm-store", () => ({
  personalAgentDmFor: dm.personalAgentDmFor,
  revealPersonalAgentDm: dm.revealPersonalAgentDm,
}))
vi.mock("~/modules/threads/message-store", () => ({ sendMessage: dm.sendMessage }))

import { consumePrefill, dock, pendingPrefill, resetDockPrefill } from "./dock-prefill"

beforeEach(() => {
  resetDockPrefill()
  vi.clearAllMocks()
})

describe("dock.prefill", () => {
  it("opens the agent conversation with the words waiting in its composer, and sends nothing", async () => {
    const id = await dock.prefill("Maison Delorme: Does the rest still fit?")
    expect(id).toBe("dm-1")
    expect(dm.revealPersonalAgentDm).toHaveBeenCalledWith("dm-1")
    expect(pendingPrefill("dm-1")?.text).toBe("Maison Delorme: Does the rest still fit?")
    expect(pendingPrefill("another")).toBeNull()
    expect(dm.sendMessage).not.toHaveBeenCalled()
  })

  it("is taken once: a consumed prefill is not given again, a new one is", async () => {
    await dock.prefill("First")
    const first = pendingPrefill("dm-1")!
    consumePrefill(first.n)
    expect(pendingPrefill("dm-1")).toBeNull()
    await dock.prefill("First")
    expect(pendingPrefill("dm-1")?.n).toBeGreaterThan(first.n)
  })
})
