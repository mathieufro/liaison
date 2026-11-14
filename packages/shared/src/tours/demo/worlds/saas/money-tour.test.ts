// SPDX-License-Identifier: FSL-1.1-ALv2
// The software world's money scenario: six beats played once, the payments app
// and invoicing required, the reminder's row ringed on Home, and the figures
// of its last beat read from the MRR query rather than written into its copy.
import { describe, expect, it } from "bun:test"
import en from "../../../../i18n/locales/en/tours.json"
import fr from "../../../../i18n/locales/fr/tours.json"
import { findTour } from "../../../index"
import { effectiveBeats, isTourAvailable, pickTourFigures, tourCopyKeys } from "../../../schema"
import { MONEY_FIGURES_TOOL, MONEY_REMINDER_ROW } from "../../money"
import { PAYMENTS_RAIL_APP } from "../../shared"
import { SAAS_MONEY_CFG, scenarioSaasMoneyTour } from "./money"

const tour = scenarioSaasMoneyTour

function lookup(dict: unknown, key: string): unknown {
  return key
    .replace(/^tours\./, "")
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        typeof node === "object" && node !== null
          ? (node as Record<string, unknown>)[part]
          : undefined,
      dict,
    )
}

const beat = (id: string) => {
  const found = tour.beats.find((b) => b.id === id)
  if (!found) throw new Error(`no beat ${id}`)
  return found
}

describe("the money scenario", () => {
  it("the money tour has six beats, plays once and needs the payments app and invoicing", () => {
    expect(tour.id).toBe("kernel.scenario-saas-money")
    expect(findTour(tour.id)).toBe(tour)
    expect(tour.world).toBe("saas")
    expect(tour.singleRun).toBe(true)
    expect(tour.demoOnly).toBe(true)
    expect(tour.requires?.apps).toEqual(["stripe", "invoicing"])
    expect(tour.beats.map((b) => [b.id, b.kind])).toEqual([
      ["card-failed", "show"],
      ["ask-standing", "do"],
      ["open-company", "show"],
      ["approve-note", "do"],
      ["card-updated", "world"],
      ["figures-moved", "show"],
    ])
    const ctx = { installedApps: ["stripe", "invoicing"], scopes: ["*"], isDemo: true }
    expect(isTourAvailable(tour, { ...ctx, worldId: "saas" })).toBe(true)
    expect(isTourAvailable(tour, { ...ctx, worldId: "products" })).toBe(false)
    expect(isTourAvailable(tour, { ...ctx, installedApps: ["invoicing"], worldId: "saas" })).toBe(
      false,
    )
    expect(effectiveBeats(tour, { ...ctx, worldId: "saas" })).toHaveLength(6)
  })

  it("the first beat rings the row the visitor holds for the away account manager, on Home", () => {
    const first = beat("card-failed")
    expect(first.anchor).toBe(MONEY_REMINDER_ROW)
    expect(first.route).toBe("/")
    // Approve rings the Approve of that same row, never another reminder's.
    expect(beat("approve-note").anchor).toBe(
      "approval-card-action-approve[data-placement=standing_in]",
    )
  })

  it("the first two beats say what the board says", () => {
    const say = (key: string) => lookup(en, key)
    expect(say(beat("card-failed").title)).toBe("Maison Arlon's card failed")
    expect(say(beat("card-failed").role as string)).toBe(
      "You run Tideform. Their Visa expired, so €1,740.00 did not go through. Your agent noticed and drafted a note to Claire.",
    )
    expect(say(beat("card-failed").body)).toBe(
      "Read the highlighted row, then press Next. Nothing has gone out.",
    )
    expect(say(beat("ask-standing").title)).toBe("Ask where you stand")
    expect(say(beat("ask-standing").role as string)).toBe(
      "Before you approve, you want the whole picture: what they pay, what they are waiting for, what is on the table.",
    )
    expect(say(beat("ask-standing").body)).toBe(
      `Ask your agent from Chats. It reads ${PAYMENTS_RAIL_APP}, invoices, tickets and deals, and answers on one card.`,
    )
    expect(say(beat("ask-standing").say?.text as string)).toBe(
      "Where do we stand with Maison Arlon?",
    )
  })

  it("every copy key exists in English and French", () => {
    for (const key of tourCopyKeys(tour)) {
      expect({ key, en: typeof lookup(en, key) }).toEqual({ key, en: "string" })
      expect({ key, fr: typeof lookup(fr, key) }).toEqual({ key, fr: "string" })
    }
  })

  it("the last beat's figures are variables read from the MRR query", () => {
    const last = beat("figures-moved")
    expect(last.route).toBe("/stripe")
    expect(last.figures?.tool).toBe(MONEY_FIGURES_TOOL)
    expect(Object.keys(last.figures?.vars ?? {}).sort()).toEqual(["mrr", "pastDue"])
    // The copy names each variable and holds no figure of its own, in both languages.
    for (const dict of [en, fr]) {
      const body = lookup(dict, last.body) as string
      expect(body).toContain("{{pastDue}}")
      expect(body).toContain("{{mrr}}")
      expect(body).not.toMatch(/\d/)
      expect(lookup(dict, last.title) as string).not.toMatch(/\d/)
      expect(lookup(dict, last.role as string) as string).not.toMatch(/\d/)
    }
    // What the query answers is what the copy says: change the answer, the figure follows.
    const answer = (pastDueMinor: number) => ({
      partial: false,
      lines: [{ currency: "eur", mrrMinor: 8_470_800, pastDueMinor, activeCount: 169 }],
    })
    const figures = last.figures
    if (!figures) throw new Error("no figures")
    expect(pickTourFigures(figures, answer(191_700))).toEqual({
      pastDue: { kind: "money", minor: 191_700, currency: "EUR" },
      mrr: { kind: "money", minor: 8_470_800, currency: "EUR" },
    })
    expect(pickTourFigures(figures, answer(336_700))?.pastDue).toEqual({
      kind: "money",
      minor: 336_700,
      currency: "EUR",
    })
    // An empty answer names no figure rather than a wrong one.
    expect(pickTourFigures(figures, { partial: true, lines: [] })).toBeNull()
  })

  it("an unverified visitor meets the code step before the agent beats, and the world beat needs no verification", () => {
    // The agent beats come first and talk to the visitor's own agent: an
    // unverified visitor's turn is refused with the verification code step.
    expect(tour.talksToAgent).toBe(true)
    const kinds = tour.beats.map((b) => b.kind)
    expect(kinds.indexOf("do")).toBeLessThan(kinds.indexOf("world"))
    // The world beat's injector is the payment recovery (its injector spends
    // nothing, checked where it is registered), and it waits on no agent.
    expect(beat("card-updated").injector).toBe(SAAS_MONEY_CFG.injector)
    expect(beat("card-updated").waitsOn).toBeUndefined()
  })

  it("the approve beat completes on an approved reminder to the customer about a payments invoice", () => {
    const event = beat("approve-note").event
    expect(event?.entity).toBe("approval_request")
    expect(event?.match).toEqual({
      status: "approved",
      toolName: "mail:compose",
      "currentPayload.to.0": SAAS_MONEY_CFG.reminderTo,
      "currentPayload.followUp.refs.0.kind": "stripe:invoice",
    })
  })
})
