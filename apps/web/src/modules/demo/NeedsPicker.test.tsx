// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The needs picker: a grid of tiles (each need's short name, its minutes and,
// from lg up, one line on what it shows); picked tiles show their rank;
// "Everything" is set apart (inverted, with a "Select all" pill) and, once
// every need is picked, reads as selected too.
import { DEMO_WORLD_NEEDS, type DemoNeed, type DemoWorldId } from "@liaison/shared"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it } from "vitest"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { NeedsPicker, needsMinutes } from "./NeedsPicker"

afterEach(() => cleanup())

describe("NeedsPicker", () => {
  it("Everything shows as selected when every need is picked, and not before", () => {
    const { unmount } = render(() => (
      <NeedsPicker value={["support", "chat"] as DemoNeed[]} onChange={() => {}} />
    ))
    expect(screen.getByTestId("demo-needs-all").getAttribute("aria-pressed")).toBe("false")
    expect(screen.queryByTestId("demo-needs-all-check")).toBeNull()
    unmount()
    render(() => <NeedsPicker value={[...DEMO_WORLD_NEEDS.products]} onChange={() => {}} />)
    expect(screen.getByTestId("demo-needs-all").getAttribute("aria-pressed")).toBe("true")
    expect(screen.getByTestId("demo-needs-all-check")).toBeTruthy()
  })

  // Owner redesign (2026-10-25): tiles with the app's icon and colour, short
  // names (the heading says "agents" once), the minutes, and a one-line
  // description from lg up. Replaces walk 6's rows of "Agentic ..." names.
  it("lists each need as a tile: its short name, its minutes and a one-line description", () => {
    render(() => (
      <I18nProvider initialLocale="en">
        <NeedsPicker value={["chat"] as DemoNeed[]} onChange={() => {}} />
      </I18nProvider>
    ))
    const list = screen.getByTestId("demo-needs-list")
    expect(list.tagName).toBe("UL")
    for (const need of DEMO_WORLD_NEEDS.products) {
      const tile = screen.getByTestId(`demo-needs-${need}`)
      expect(list.contains(tile)).toBe(true)
      expect(screen.getByTestId(`demo-needs-name-${need}`).textContent).not.toMatch(/^Agentic /)
      expect(tile.textContent).toMatch(/about \d min/)
      expect(screen.getByTestId(`demo-needs-desc-${need}`).textContent?.length).toBeGreaterThan(10)
    }
    expect(screen.getByTestId("demo-needs-name-sales").textContent).toBe("Sales & CRM")
    expect(screen.getByTestId("demo-needs-all").textContent).toContain("about 22 min")
    expect(screen.getByTestId("demo-needs-chat").getAttribute("aria-pressed")).toBe("true")
  })

  it("sets Everything apart with a Select all pill, and the pill says when all are picked", () => {
    const { unmount } = render(() => (
      <I18nProvider initialLocale="en">
        <NeedsPicker value={["support"] as DemoNeed[]} onChange={() => {}} />
      </I18nProvider>
    ))
    const tile = () => screen.getByTestId("demo-needs-all")
    const pill = () => screen.getByTestId("demo-needs-all-pill")
    expect(tile().contains(pill())).toBe(true)
    expect(pill().textContent).toBe("Select all")
    // Not selected, it looks like any tile that is off, never the filled, selected look.
    expect(tile().className.split(" ")).toEqual(expect.arrayContaining(["bg-bg", "text-text"]))
    expect(tile().className.split(" ")).not.toContain("bg-text")
    unmount()

    render(() => (
      <I18nProvider initialLocale="en">
        <NeedsPicker value={[...DEMO_WORLD_NEEDS.products]} onChange={() => {}} />
      </I18nProvider>
    ))
    expect(pill().textContent).toBe("All selected")
    expect(pill().contains(screen.getByTestId("demo-needs-all-check"))).toBe(true)
    expect(tile().className.split(" ")).toEqual(
      expect.arrayContaining(["bg-accent", "text-accent-foreground"]),
    )
    expect(tile().className.split(" ")).not.toContain("bg-text")
  })

  it("picks every need from Select all, and clears them from All selected", () => {
    const seen: DemoNeed[][] = []
    const { unmount } = render(() => (
      <NeedsPicker value={["dev"] as DemoNeed[]} onChange={(next) => seen.push(next)} />
    ))
    fireEvent.click(screen.getByTestId("demo-needs-all"))
    unmount()
    render(() => (
      <NeedsPicker value={[...DEMO_WORLD_NEEDS.products]} onChange={(next) => seen.push(next)} />
    ))
    fireEvent.click(screen.getByTestId("demo-needs-all"))
    expect(seen).toEqual([[...DEMO_WORLD_NEEDS.products], []])
  })
})

describe("NeedsPicker by world", () => {
  const worlds: DemoWorldId[] = ["products", "saas", "studio"]

  it("each world lists seven tiles with its own commerce seat and Everything picks those seven", () => {
    for (const world of worlds) {
      const seen: DemoNeed[][] = []
      const { unmount } = render(() => (
        <I18nProvider initialLocale="en">
          <NeedsPicker world={world} value={[]} onChange={(next) => seen.push(next)} />
        </I18nProvider>
      ))
      const listed = screen
        .getAllByTestId(/^demo-needs-(?!list|name-|desc-|rank-|all)/)
        .map((tile) => tile.getAttribute("data-testid")?.replace("demo-needs-", ""))
      expect(listed).toEqual([...DEMO_WORLD_NEEDS[world]])
      expect(listed).toHaveLength(7)
      // Commerce's seat holds the world's own need, and no other world's.
      const seat = DEMO_WORLD_NEEDS[world][4]
      expect(screen.getByTestId(`demo-needs-${seat}`)).toBeTruthy()
      for (const other of worlds.filter((w) => w !== world)) {
        const foreign = DEMO_WORLD_NEEDS[other][4]
        if (foreign !== seat) expect(screen.queryByTestId(`demo-needs-${foreign}`)).toBeNull()
      }
      expect(screen.getByTestId("demo-needs-all").textContent).toContain(
        `about ${needsMinutes(DEMO_WORLD_NEEDS[world])} min`,
      )
      fireEvent.click(screen.getByTestId("demo-needs-all"))
      expect(seen).toEqual([[...DEMO_WORLD_NEEDS[world]]])
      unmount()
    }
  })

  it("names the software world's own tile in the shared strings", () => {
    render(() => (
      <I18nProvider initialLocale="en">
        <NeedsPicker world="saas" value={["money"]} onChange={() => {}} />
      </I18nProvider>
    ))
    expect(screen.getByTestId("demo-needs-name-money").textContent).toBe("Subscriptions & payments")
    expect(screen.getByTestId("demo-needs-money").getAttribute("aria-pressed")).toBe("true")
  })
})
