// SPDX-License-Identifier: FSL-1.1-ALv2
// The software world's six guided tours besides money: each in its own world,
// every copy key in English and French, no literal of another world in their
// copy, the sales tour on native records behind one request, the developer
// tour ending with a reply draft behind an approval.
import { describe, expect, it } from "bun:test"
import { DEMO_WORLD_NEEDS, demoScenarioTourId } from "../../../../demo/worlds"
import en from "../../../../i18n/locales/en/tours.json"
import fr from "../../../../i18n/locales/fr/tours.json"
import { findTour } from "../../../index"
import { effectiveBeats, isTourAvailable, type Tour, tourCopyKeys } from "../../../schema"
import { scenarioSaasChatTour } from "./chat"
import { SAAS_DEV_CFG, SAAS_TELL_TOOL, scenarioSaasDevTour } from "./dev"
import { scenarioSaasKnowledgeTour } from "./knowledge"
import { scenarioSaasProjectsTour } from "./projects"
import { SAAS_SALES_CFG, scenarioSaasSalesTour } from "./sales"
import { scenarioSaasSupportTour } from "./support"

const TOURS: Record<string, Tour> = {
  support: scenarioSaasSupportTour,
  projects: scenarioSaasProjectsTour,
  chat: scenarioSaasChatTour,
  sales: scenarioSaasSalesTour,
  dev: scenarioSaasDevTour,
  knowledge: scenarioSaasKnowledgeTour,
}

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

/** What the other worlds' copy names: nothing of it may stand in a software tour. */
const FOREIGN = [
  /Resonant/i,
  /Kestrel/i,
  /RAL-/,
  /Tobias/,
  /Lena Hart/,
  /Northwind/i,
  /Inês/,
  /Lucas/,
  /Shopify/i,
  /Boxtal/i,
  /battery/i,
  /dealer/i,
  /Firmware/i,
  /Marlin/i,
  /Pauline/,
  /statement of work/i,
]

describe("the software world's tours", () => {
  it("each software tour is its world's scenario for its need, played in a demo org of that world only", () => {
    for (const [need, tour] of Object.entries(TOURS)) {
      expect(tour.id).toBe(demoScenarioTourId("saas", need as never))
      expect(DEMO_WORLD_NEEDS.saas).toContain(need as never)
      expect(findTour(tour.id)).toBe(tour)
      expect(tour.world).toBe("saas")
      expect(tour.demoOnly).toBe(true)
      const base = { installedApps: tour.requires?.apps ?? [], scopes: ["*"], isDemo: true }
      expect(isTourAvailable(tour, { ...base, worldId: "saas" })).toBe(true)
      expect(isTourAvailable(tour, { ...base, worldId: "products" })).toBe(false)
      expect(effectiveBeats(tour, { ...base, worldId: "saas" }).length).toBeGreaterThan(0)
    }
  })

  it("every software tour key exists in English and French and holds no products or studio literal", () => {
    for (const [need, tour] of Object.entries(TOURS)) {
      for (const key of tourCopyKeys(tour)) {
        // The tour's own copy namespace, never the products world's.
        if (!key.startsWith("tours.scenarios.common.")) {
          expect(
            key.startsWith(`tours.scenarios.saas${need[0]?.toUpperCase()}${need.slice(1)}.`),
          ).toBe(true)
        }
        for (const [lang, dict] of [
          ["en", en],
          ["fr", fr],
        ] as const) {
          const text = lookup(dict, key)
          expect({ key, lang, type: typeof text }).toEqual({ key, lang, type: "string" })
          for (const literal of FOREIGN) {
            expect({ key, lang, hit: literal.test(text as string) }).toEqual({
              key,
              lang,
              hit: false,
            })
          }
        }
      }
    }
  })

  it("the sales tour writes a native company, contact and quote behind one request, with no connector tool", () => {
    const head = SAAS_SALES_CFG.bundleHeadTools ?? []
    expect(head).toEqual(["kernel:companies_write", "invoicing:quote_create_and_issue"])
    expect(JSON.stringify(scenarioSaasSalesTour)).not.toMatch(/connector/)
    expect(scenarioSaasSalesTour.requires?.apps).not.toContain("api-connector")
    const ids = scenarioSaasSalesTour.beats.map((b) => b.id)
    // One request, opened once, approved once: the bundle beats appear once each.
    expect(ids.filter((id) => id === "approve")).toHaveLength(1)
    expect(ids).toContain("bundle-steps")
    const approve = scenarioSaasSalesTour.beats.find((b) => b.id === "approve")
    expect(approve?.event?.match).toMatchObject({ toolName: "mail:reply" })
  })

  it("the dev tour plays the recorded node, says recorded, and ends with a reply draft behind an approval", () => {
    const beats = scenarioSaasDevTour.beats.map((b) => b.id)
    // The recorded laptop's own session beats, then the customer told.
    expect(beats.slice(beats.indexOf("dispatch"), beats.indexOf("report") + 1)).toEqual([
      "dispatch",
      "approve-dispatch",
      "stream",
      "permission",
      "result",
      "report",
    ])
    expect(beats.slice(beats.indexOf("report") + 1, beats.indexOf("report") + 4)).toEqual([
      "ask-tell",
      "reply-draft",
      "approve-reply",
    ])
    expect(SAAS_DEV_CFG.world).toBe("saas")
    const draft = scenarioSaasDevTour.beats.find((b) => b.id === "reply-draft")
    expect(draft?.event).toMatchObject({
      entity: "approval_request",
      match: { toolName: SAAS_TELL_TOOL },
    })
    const approve = scenarioSaasDevTour.beats.find((b) => b.id === "approve-reply")
    expect(approve?.event?.sameEntityAs).toBe("reply-draft")
    // Where a person reads the node's name, it says recorded.
    for (const dict of [en, fr]) {
      expect(JSON.stringify(lookup(dict, "tours.scenarios.saasDev.computers"))).toContain(
        "recorded",
      )
    }
  })

  it("the knowledge tour opens the document the pack restricts and the chat tour sends to a fictional page", () => {
    const open = scenarioSaasKnowledgeTour.beats.find((b) => b.id === "open-pl")
    expect(JSON.stringify(open)).toContain("Refund policy")
    for (const dict of [en, fr]) {
      expect(JSON.stringify(lookup(dict, "tours.scenarios.saasChat.askAgent"))).toMatch(
        /fictional|fictive/,
      )
    }
  })
})
