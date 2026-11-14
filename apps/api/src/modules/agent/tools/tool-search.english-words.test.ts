// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An English word is never read as a French verb form: "met" is not "mettre"
// and "define" is not "définir", so a request that says them loads no write it
// never asked for. Ranked over the catalog the tool bench reads from source.
import { describe, expect, it } from "bun:test"
import { loadBenchCatalog } from "./tool-bench/catalog"
import { rankDeferredTools } from "./tool-rank"

const CATALOG = loadBenchCatalog()
const APPS = new Set(CATALOG.map((t) => t.appName))

const ranking = (query: string) => {
  const r = rankDeferredTools(CATALOG, query, { cap: 5, appNames: APPS })
  return { listed: r.ranked.map((s) => s.tool.sdkName), loaded: [...r.strongNames].sort() }
}

describe("English words beside French verb forms", () => {
  it("English words that look like French verb forms rank as they did before French forms were read", () => {
    expect(ranking("customers we met")).toEqual({
      listed: [
        "shopify__customers_email_marketing_consent_update",
        "shopify__customers_get",
        "shopify__customers_get_by_external_id",
        "shopify__customers_search",
        "shopify__customers_segment_search",
      ],
      loaded: [],
    })
    const metTools = [
      "ads__metrics_list",
      "ads__metrics_run",
      "shopify__metafields_delete",
      "shopify__metafields_list",
      "shopify__metafields_set",
    ]
    expect(ranking("met")).toEqual({ listed: metTools, loaded: metTools })
    expect(ranking("define")).toEqual({
      listed: ["kernel__grant_dimension_value", "kernel__list_dimensions"],
      loaded: [],
    })
    expect(ranking("il met la campagne en pause")).toEqual({
      listed: [
        "ads__google_pause",
        "ads__pause",
        "ads__campaigns_list",
        "ads__create_campaign",
        "ads__google_campaigns_list",
      ],
      loaded: [],
    })
  })

  it("no set or update tool is listed or loaded when a request says define or met", () => {
    const writes = /(^|_)(set|update)(_|$)/
    for (const q of ["how do we define churn", "who did we met at the trade show"]) {
      const { listed, loaded } = ranking(q)
      expect(
        [...listed, ...loaded].filter((n) => writes.test(n.split("__")[1] ?? "")),
        q,
      ).toEqual([])
    }
  })

  it("a French verb form still reads as its infinitive", () => {
    expect(ranking("réponds au client sur ce ticket").listed[0]).toBe("tickets__reply")
  })
})
