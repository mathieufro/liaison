// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it, vi } from "vitest"

const originalMatchMedia = window.matchMedia

type Listener = () => void

function mockMatchMedia(
  matchesFor: (query: string) => boolean,
  subscriptions?: Array<{ query: string; listener: Listener }>,
) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: matchesFor(query),
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: Listener) =>
        subscriptions?.push({ query, listener }),
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

afterEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  })
  vi.resetModules()
})

describe("shell-tier", () => {
  it("resolves each tier from its own media query", async () => {
    mockMatchMedia((q) => q.includes("max-width: 639px"))
    vi.resetModules()
    const phone = await import("./shell-tier")
    expect(phone.resolveShellTier()).toBe("phone")
    expect(phone.shellTier()).toBe("phone")

    mockMatchMedia((q) => q.includes("min-width: 640px") && q.includes("max-width: 1023px"))
    vi.resetModules()
    const tablet = await import("./shell-tier")
    expect(tablet.shellTier()).toBe("tablet")

    mockMatchMedia((q) => q.includes("min-width: 1024px"))
    vi.resetModules()
    const desktop = await import("./shell-tier")
    expect(desktop.shellTier()).toBe("desktop")
  })

  it("a media query change republishes the tier", async () => {
    const subscriptions: Array<{ query: string; listener: Listener }> = []
    let tier: "desktop" | "tablet" | "phone" = "desktop"
    mockMatchMedia((q) => {
      if (q.includes("max-width: 639px")) return tier === "phone"
      if (q.includes("min-width: 1024px")) return tier === "desktop"
      return tier === "tablet"
    }, subscriptions)
    vi.resetModules()
    const mod = await import("./shell-tier")
    expect(mod.shellTier()).toBe("desktop")
    // One subscription per tier query, attached at import: the tier follows
    // the viewport without any component being mounted.
    expect(subscriptions).toHaveLength(3)

    vi.useFakeTimers()
    try {
      tier = "phone"
      for (const { listener } of subscriptions) listener()
      // It follows where the viewport settles.
      expect(mod.shellTier()).toBe("desktop")
      vi.advanceTimersByTime(mod.SHELL_TIER_SETTLE_MS)
      expect(mod.shellTier()).toBe("phone")
    } finally {
      vi.useRealTimers()
    }
  })

  it("a viewport narrowed for a moment and restored keeps the tier", async () => {
    // Chromium resizes the viewport to the capture area while it screenshots an
    // element taller than the window, then restores it: the queries fire twice.
    const subscriptions: Array<{ query: string; listener: Listener }> = []
    let tier: "desktop" | "tablet" | "phone" = "desktop"
    mockMatchMedia((q) => {
      if (q.includes("max-width: 639px")) return tier === "phone"
      if (q.includes("min-width: 1024px")) return tier === "desktop"
      return tier === "tablet"
    }, subscriptions)
    vi.resetModules()
    const mod = await import("./shell-tier")
    const seen: string[] = []
    const { createRoot, createEffect } = await import("solid-js")
    vi.useFakeTimers()
    try {
      createRoot(() => createEffect(() => seen.push(mod.shellTier())))
      tier = "phone"
      for (const { listener } of subscriptions) listener()
      vi.advanceTimersByTime(mod.SHELL_TIER_SETTLE_MS / 2)
      tier = "desktop"
      for (const { listener } of subscriptions) listener()
      vi.advanceTimersByTime(mod.SHELL_TIER_SETTLE_MS * 2)
      expect(seen).toEqual(["desktop"])
    } finally {
      vi.useRealTimers()
    }
  })
})
