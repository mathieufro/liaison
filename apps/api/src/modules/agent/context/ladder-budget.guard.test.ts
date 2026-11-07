// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The tool ladder's budget, measured with no server and no database: the
// announcement the real builder writes, the tools listed, the
// summary lines and each app's schema total through the product's own meter
// (the kernel's from the registry entries its registration builds), for a
// neutral set of worlds. The numbers are targets. A number over its target
// fails only until `ladder-budget.reasons.json` holds a line naming the
// capability that needs it; every number and every reason is printed. Nothing
// here forbids a tool, and no outcome edits a description.
//
// Needs only the placeholder environment the product's modules read at import,
// so the product's modules are imported after it is set: a static import would
// be evaluated first and find no environment.
process.env.JWT_SECRET ||= "ladder-guard-placeholder-".padEnd(48, "0")
process.env.ENCRYPTION_KEY ||= "0123456789abcdef".repeat(4)

import { beforeAll, describe, expect, it } from "bun:test"
import { join } from "node:path"
import type { LadderMeasure, LadderReason, LadderTargets, LadderWorld } from "./ladder-budget"

const { estimateTokens } = await import("./compaction")
const { renderClientSurfaceLine } = await import("./context")
const { ladderReport, loadLadderTools, measureLadder, overTarget, readLadderReasons, unexplained } =
  await import("./ladder-budget")

const REASONS_FILE = join(import.meta.dir, "ladder-budget.reasons.json")

/** A few scopes: one support role, the shape of a person who can only answer tickets. */
const FEW_SCOPES = ["tickets:tickets:read", "tickets:tickets:write"]

const WORLDS: LadderWorld[] = [
  { name: "all-apps", scopes: ["*"], surface: "web" },
  { name: "few-scopes", scopes: FEW_SCOPES, surface: "web" },
  { name: "phone", scopes: ["*"], surface: "mobile" },
]

/** Targets, not caps. Moving one needs a decision on record. */
const EVERY_APP: LadderTargets = {
  visibleTools: 700,
  announcementTokens: 3_500,
  appSchemaTokens: {
    projects: 16_500,
    invoicing: 29_500,
    mail: 7_800,
    agreements: 2_500,
    github: 800,
  },
}
const TARGETS: Record<string, LadderTargets> = {
  "all-apps": EVERY_APP,
  "few-scopes": { announcementTokens: 900, appSchemaTokens: {} },
  // The phone is the same catalog (asserted below), so only the prompt is its own number.
  phone: { visibleTools: EVERY_APP.visibleTools, appSchemaTokens: {} },
}

/** A world measured over its target by a known amount. */
const OVER: LadderMeasure = {
  world: "w",
  visibleTools: 10,
  announcedTools: 10,
  announcementTokens: 1_001,
  summaryLines: 0,
  summaryTokens: 0,
  appSchemaTokens: { app: 5_000 },
  surfaceLineTokens: 0,
}
const OVER_TARGETS: Record<string, LadderTargets> = {
  w: { announcementTokens: 1_000, appSchemaTokens: { app: 4_000 } },
}

describe("the ladder budget report", () => {
  it("a number over target with no reason fails naming it", () => {
    const { failures } = ladderReport([OVER], OVER_TARGETS, [])
    expect(failures).toHaveLength(2)
    expect(failures.join("\n")).toContain("w:announcementTokens is 1001 against a target of 1000")
    expect(failures.join("\n")).toContain("w:app is 5000 against a target of 4000")
  })

  it("with a reason passes and prints it", () => {
    const reasons: LadderReason[] = [
      { key: "w:announcementTokens", capability: "a capability that needs the room" },
      { key: "w:app", capability: "another capability" },
    ]
    const { failures, lines } = ladderReport([OVER], OVER_TARGETS, reasons)
    expect(failures).toEqual([])
    const text = lines.join("\n")
    expect(text).toContain(
      "OVER w:announcementTokens: 1001 against 1000; reason: a capability that needs the room",
    )
    expect(text).toContain("OVER w:app: 5000 against 4000; reason: another capability")
  })

  it("a reason with no capability named does not clear a number", () => {
    const { failures } = ladderReport([OVER], OVER_TARGETS, [{ key: "w:app", capability: "  " }])
    expect(failures.join("\n")).toContain("w:app")
  })

  it("no number forbids a tool: a reason always clears it", async () => {
    const tools = await loadLadderTools()
    const before = measureLadder(tools, { name: "all", scopes: ["*"] })
    // A target of zero everywhere is the worst case: every number is over.
    const zero: LadderTargets = {
      visibleTools: 0,
      announcementTokens: 0,
      appSchemaTokens: Object.fromEntries(Object.keys(before.appSchemaTokens).map((a) => [a, 0])),
    }
    const over = overTarget({ ...before, world: "all" }, zero)
    expect(over.length).toBeGreaterThan(5)
    const reasons = over.map((o) => ({ key: o.key, capability: "needed" }))
    expect(unexplained(over, reasons)).toEqual([])
    expect(ladderReport([{ ...before, world: "all" }], { all: zero }, reasons).failures).toEqual([])
    // The measure only reads: the catalog is the same after as before.
    expect(measureLadder(tools, { name: "all", scopes: ["*"] }).visibleTools).toBe(
      before.visibleTools,
    )
  })
})

describe("the neutral worlds", () => {
  let measures: LadderMeasure[] = []
  beforeAll(async () => {
    const tools = await loadLadderTools()
    measures = WORLDS.map((w) => measureLadder(tools, w))
  })

  it("every number is under its target or has a reason, and every number is printed", () => {
    const reasons = readLadderReasons(REASONS_FILE)
    const { lines, failures } = ladderReport(measures, TARGETS, reasons)
    console.log(`\nladder budget\n${lines.join("\n")}`)
    expect(failures).toEqual([])
  })

  it("every reason names a capability and a number that exists", () => {
    const known = new Set(
      measures.flatMap((m) => [
        `${m.world}:visibleTools`,
        `${m.world}:announcementTokens`,
        ...Object.keys(m.appSchemaTokens).map((a) => `${m.world}:${a}`),
      ]),
    )
    for (const r of readLadderReasons(REASONS_FILE)) {
      expect(r.capability.trim().length).toBeGreaterThan(0)
      expect(known.has(r.key)).toBe(true)
    }
  })

  it("a world with few scopes announces fewer tools than every app on", () => {
    const [all, few] = measures
    expect(few.announcedTools).toBeGreaterThan(0)
    expect(few.announcedTools).toBeLessThan(all.announcedTools)
  })

  it("same catalog on a phone, prompt +40 at most", () => {
    const [all, , phone] = measures
    expect(phone.visibleTools).toBe(all.visibleTools)
    expect(phone.announcedTools).toBe(all.announcedTools)
    expect(phone.announcementTokens).toBe(all.announcementTokens)
    expect(phone.appSchemaTokens).toEqual(all.appSchemaTokens)
    const web = estimateTokens(renderClientSurfaceLine("web"))
    const mobile = estimateTokens(renderClientSurfaceLine("mobile"))
    expect(mobile - web).toBeLessThanOrEqual(40)
  })
})
