// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every claim the door makes about a world maps to the tests that prove it, every door
// string is a claim or the frame around them, and the figures the door states
// equal the world's plan.
import { describe, expect, it } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { SAAS_PLANS, SAAS_TEAM } from "./saas/fiction"
import { saasMoneyPlan } from "./saas/plan"
import { DOOR_FRAME_KEYS, WORLD_CLAIMS, type WorldClaim } from "./world-claims"

const KERNEL_EN = path.join(
  import.meta.dir,
  "../../../../../packages/shared/src/i18n/locales/en/kernel.json",
)
const API_SRC = path.join(import.meta.dir, "../..")
const BOARD_DATE = new Date("2026-11-09T08:30:00Z")

/** The door strings of a world, by key path under `kernel.demo.world.<world>.`. */
function doorStrings(world: string): Record<string, string> {
  const kernel = JSON.parse(readFileSync(KERNEL_EN, "utf8")) as {
    demo?: { world?: Record<string, unknown> }
  }
  const out: Record<string, string> = {}
  const walk = (node: unknown, at: string) => {
    if (typeof node === "string") out[at] = node
    else if (node && typeof node === "object")
      for (const [k, v] of Object.entries(node)) walk(v, at ? `${at}.${k}` : k)
  }
  walk(kernel.demo?.world?.[world], "")
  return out
}

/** Door keys with no claim row and not in the frame, and claim rows with no proof. */
function unmapped(
  door: Record<string, string>,
  claims: readonly WorldClaim[],
  frame: readonly string[],
): string[] {
  const covers = (claimKey: string, key: string) =>
    claimKey.endsWith(".*") ? key.startsWith(claimKey.slice(0, -1)) : claimKey === key
  const keys = Object.keys(door)
  return [
    ...keys
      .filter((k) => !claims.some((c) => covers(c.key, k)) && !frame.includes(k))
      .map((k) => `door string with no claim: ${k}`),
    ...claims.filter((c) => c.provenBy.length === 0).map((c) => `claim with no proof: ${c.claim}`),
    ...claims
      .flatMap((c) => c.provenBy)
      .filter(
        (f) => !existsSync(path.join(import.meta.dir, f)) && !existsSync(path.join(API_SRC, f)),
      )
      .map((f) => `proof file missing: ${f}`),
    ...claims
      .filter((c) => !keys.some((k) => covers(c.key, k)))
      .map((c) => `claim on no door string: ${c.key}`),
  ]
}

describe("the software world's door claims", () => {
  const door = doorStrings("saas")
  const claims = WORLD_CLAIMS.saas ?? []
  const frame = DOOR_FRAME_KEYS.saas ?? []

  it("every door string is a claim with the tests that prove it, or the frame around them", () => {
    expect(Object.keys(door).length).toBeGreaterThan(10)
    expect(unmapped(door, claims, frame)).toEqual([])
  })

  it("a door string added with no claim, or a claim with no proof, is refused", () => {
    expect(unmapped({ ...door, newLine: "A new claim" }, claims, frame)).toEqual([
      "door string with no claim: newLine",
    ])
    const bare = [...claims, { key: "companyAbout", claim: "x", mustBeTrue: "y", provenBy: [] }]
    expect(unmapped(door, bare, frame)).toEqual(["claim with no proof: x"])
  })

  it("the door names each of the pack's people, and only them", () => {
    const roles = Object.keys(door)
      .filter((k) => k.startsWith("teamRole."))
      .map((k) => k.slice("teamRole.".length))
    expect(roles.sort()).toEqual(SAAS_TEAM.map((p) => p.key).sort())
  })

  it("the card customers and plan prices the door states are the plan's", () => {
    const money = saasMoneyPlan(BOARD_DATE)
    const counted = money.subscriptions.filter(
      (s) => s.status === "active" || s.status === "past_due",
    ).length
    const euros = (minor: number) => `€${(minor / 100).toLocaleString("en-US")}`
    const about = door.companyAbout ?? ""
    expect(about).toContain(`${counted} customers pay by card`)
    expect(about).toContain(
      `from ${euros(SAAS_PLANS.starter.monthlyMinor)} to ${euros(SAAS_PLANS.group.monthlyMinor)} a month`,
    )
    expect(door["companyOps.payments.body"]).toContain(`${counted} customers pay by card`)
  })
})
