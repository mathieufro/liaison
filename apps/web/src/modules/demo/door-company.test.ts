// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The door describes the seeded company in words, and the web bundle cannot
// import the seed. So every fact it states is pinned here to the seed itself:
// the company, its price range, its dealers, its people and its desk agents.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import en from "../../../../../packages/shared/src/i18n/locales/en/kernel.json"
import fr from "../../../../../packages/shared/src/i18n/locales/fr/kernel.json"
import {
  DEMO_CATALOG,
  DEMO_COMPANY,
  DEMO_DEALERS,
  DEMO_ROLE_AGENTS,
  DEMO_TEAM,
} from "../../../../api/src/seed/world/fiction"
import { SAAS_COMPANY, SAAS_PLANS, SAAS_TEAM } from "../../../../api/src/seed/worlds/saas/fiction"
import { DEMO_COMPANY_NAME, DEMO_DOOR, DEMO_DOOR_TEAM, doorCompanyOf } from "./door-company"

const copy = en.demo

describe("the company page states the seed's facts", () => {
  it("names the seeded company, its city and its headcount", () => {
    expect(DEMO_COMPANY_NAME).toBe(DEMO_COMPANY.name)
    expect(copy.companyAbout.startsWith(DEMO_COMPANY.name)).toBe(true)
    expect(copy.companyFacts).toBe(
      `Fictional company · ${DEMO_COMPANY.city} · ${DEMO_TEAM.length} people`,
    )
  })

  it("calls the company an example, by its seeded name", () => {
    expect(copy.companyExample).toContain(DEMO_COMPANY.name)
    expect(fr.demo.companyExample).toContain(DEMO_COMPANY.name)
  })

  it("gives the flagship price range of the catalog", () => {
    const flagships = DEMO_CATALOG.filter((sku) => sku.tier === "flagship").map(
      (sku) => sku.priceMinor / 100,
    )
    const euros = (n: number) => `€${n.toLocaleString("en-US")}`
    expect(copy.companyAbout).toContain(
      `from ${euros(Math.min(...flagships))} to ${euros(Math.max(...flagships))}`,
    )
    expect(copy.companyAbout).toContain("the Kestrel line")
    expect(
      DEMO_CATALOG.filter((sku) => sku.tier === "flagship").every((sku) =>
        sku.title.startsWith("Kestrel"),
      ),
    ).toBe(true)
  })

  it("counts the dealers and the territories they cover", () => {
    expect(DEMO_DEALERS).toHaveLength(6)
    expect(copy.companyAbout).toContain("six dealers in Europe, North America and Japan")
    const countries = new Set(DEMO_DEALERS.map((d) => d.country))
    expect(countries.has("US") && countries.has("JP")).toBe(true)
  })

  it("lists every seeded teammate but the founder, with a title taken from theirs", () => {
    const seeded = DEMO_TEAM.filter((p) => p.role !== "founder_admin")
    expect(DEMO_DOOR_TEAM.map((p) => [p.key, p.name])).toEqual(seeded.map((p) => [p.key, p.name]))
    const roles: Record<string, string> = copy.teamRole
    for (const person of seeded) {
      const short = roles[person.key]
      expect(short, person.key).toBeTruthy()
      expect(person.jobTitle, person.key).toContain(short)
    }
  })

  it("names the desk agents the seed creates", () => {
    const desks = DEMO_ROLE_AGENTS.map((a) => a.displayName)
    for (const desk of ["Support Desk", "Operations Desk", "Finance Desk"]) {
      expect(desks).toContain(desk)
    }
    expect(copy.companyOps.support.body).toContain("The Support Desk agent")
    expect(copy.companyOps.orders.body).toContain("The Operations Desk agent")
    expect(copy.companyOps.invoicing.body).toContain("The Finance Desk agent")
  })
})

describe("the software company's page states its pack's facts", () => {
  const saas = en.demo.world.saas

  it("names the pack's company, its city and its headcount", () => {
    expect(DEMO_DOOR.saas.name).toBe(SAAS_COMPANY.name)
    expect(saas.companyExample).toContain(SAAS_COMPANY.name)
    expect(fr.demo.world.saas.companyExample).toContain(SAAS_COMPANY.name)
    expect(saas.companyFacts).toBe(
      `Fictional company · ${SAAS_COMPANY.city} · ${SAAS_TEAM.length + 1} people`,
    )
  })

  it("gives the plan price range and the paying count of the pack", () => {
    const monthly = Object.values(SAAS_PLANS).map((plan) => plan.monthlyMinor / 100)
    const euros = (n: number) => `€${n.toLocaleString("en-US")}`
    expect(saas.companyAbout).toContain(
      `from ${euros(Math.min(...monthly))} to ${euros(Math.max(...monthly))} a month`,
    )
    // The pack's plan module reads through the api's path aliases, which this
    // bundle's test runner does not resolve: its source is read for the count.
    const planSource = readFileSync(
      join(process.cwd(), "../api/src/seed/worlds/saas/plan.ts"),
      "utf8",
    )
    const paying = Number(/\bpaying: (\d+)/.exec(planSource)?.[1])
    expect(paying).toBeGreaterThan(0)
    expect(saas.companyAbout).toContain(`${paying} customers pay by card`)
    expect(saas.companyOps.payments.body).toContain(`${paying} customers`)
  })

  it("lists every teammate of the pack, with a title taken from theirs", () => {
    expect(DEMO_DOOR.saas.team.map((p) => [p.key, p.name])).toEqual(
      SAAS_TEAM.map((p) => [p.key, p.name]),
    )
    const roles: Record<string, string> = saas.teamRole
    for (const person of SAAS_TEAM) {
      expect(roles[person.key], person.key).toBeTruthy()
      expect(person.jobTitle, person.key).toContain(roles[person.key])
    }
  })

  it("has a line for every operations row, in both languages, and reads as products for any other world", () => {
    for (const op of DEMO_DOOR.saas.opsList) {
      expect(saas.companyOps[op.key as keyof typeof saas.companyOps].body, op.key).toBeTruthy()
      expect(
        fr.demo.world.saas.companyOps[op.key as keyof typeof saas.companyOps].body,
      ).toBeTruthy()
    }
    expect(doorCompanyOf("studio")).toBe(DEMO_DOOR.products)
    expect(doorCompanyOf(null)).toBe(DEMO_DOOR.products)
  })
})
