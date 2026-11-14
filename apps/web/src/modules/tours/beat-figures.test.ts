// SPDX-License-Identifier: FSL-1.1-ALv2
// A step's copy names its figures as the tool the screen reads answers them,
// formatted in the person's language: never a figure written into the copy,
// and an ellipsis (not a wrong figure) until the answer is in.
import { type EffectiveBeat, findTour } from "@liaison/shared"
import { createRoot } from "solid-js"
import { afterEach, describe, expect, it } from "vitest"
import { createBeatFigures, formatTourFigure } from "./beat-figures"
import type { TourApi } from "./tour-api"
import { resetTourStore, setTourApi } from "./tour-store"

afterEach(() => resetTourStore())

const lastBeat = findTour("kernel.scenario-saas-money")?.beats.find(
  (b) => b.id === "figures-moved",
) as unknown as EffectiveBeat

function withAnswer(answer: unknown, calls: string[]): void {
  setTourApi({
    list: async () => [],
    progress: async () => null,
    start: async () => null,
    update: async () => null,
    readTool: async (tool: string) => {
      calls.push(tool)
      return answer
    },
  } as TourApi)
}

const settle = () => new Promise((r) => setTimeout(r, 0))

describe("a step's figures", () => {
  it("formats money in the person's language", () => {
    const fig = { kind: "money", minor: 191_700, currency: "EUR" } as const
    expect(formatTourFigure(fig, "en")).toBe("€1,917.00")
    expect(formatTourFigure(fig, "fr").replace(/\s/g, " ")).toBe("1 917,00 €")
  })

  it("the last money step names what the MRR query answers now", async () => {
    const calls: string[] = []
    withAnswer(
      { partial: false, lines: [{ currency: "eur", mrrMinor: 8_470_800, pastDueMinor: 191_700 }] },
      calls,
    )
    await createRoot(async (dispose) => {
      const figures = createBeatFigures(() => lastBeat)
      expect(figures()).toEqual({ pastDue: "…", mrr: "…" })
      await settle()
      await settle()
      expect(figures()).toEqual({ pastDue: "€1,917.00", mrr: "€84,708.00" })
      dispose()
    })
    expect(calls).toEqual(["stripe:mrr_query"])
  })

  it("an answer without the figures shows an ellipsis, never another figure", async () => {
    withAnswer({ partial: true, lines: [] }, [])
    await createRoot(async (dispose) => {
      const figures = createBeatFigures(() => lastBeat)
      await settle()
      await settle()
      expect(figures()).toEqual({ pastDue: "…", mrr: "…" })
      dispose()
    })
  })
})
