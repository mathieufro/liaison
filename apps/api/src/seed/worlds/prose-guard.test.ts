// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A world pack's prose is seeded once and read later, so a relative day word or a
// literal date in it turns false as soon as the pool hands the org out a day later.
// Dates enter prose through the story clock's formatter, never as literals.
import { afterAll, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { scanPackProse, scanWorldPackDir } from "~/seed/worlds/prose-guard"

describe("pack prose guard", () => {
  it("a pack string holding a weekday, a year or a relative day word fails and names the field", () => {
    const pack = {
      briefs: [
        { title: "Renewal call", body: "Marc calls the client on Tuesday." },
        { title: "Budget", body: "The plan for 2027 is signed." },
      ],
      notes: { followUp: "Answered this morning, so the reminder will not go out." },
      fr: { relance: "Le client a répondu hier." },
    }
    const found = scanPackProse(pack)
    expect(found.map((v) => v.field)).toEqual([
      "briefs[0].body",
      "briefs[1].body",
      "notes.followUp",
      "fr.relance",
    ])
    expect(found.map((v) => v.kind)).toEqual(["weekday", "year", "relative-day", "relative-day"])
    expect(found[0]?.match).toBe("Tuesday")
  })

  it("a literal day and month or a numeric date fails", () => {
    const found = scanPackProse({
      a: "Invoice sent on 3 Nov.",
      b: "Signed November 3.",
      c: "Paid 12/03.",
      d: "Due 2026-11-30",
      e: "Envoyée le 3 novembre.",
    })
    expect(found.map((v) => v.field)).toEqual(["a", "b", "c", "d", "e"])
    expect(found.every((v) => v.kind === "date" || v.kind === "year")).toBe(true)
  })

  it("plain prose passes, and so does a field on the allow-list", () => {
    const pack = {
      summary: "Maison Arlo answered, so the follow-up queued for Marc will not go out.",
      plans: "Sold by subscription from 149 to 1,450 a month, 30 monthly and 139 yearly.",
      maybe: "The team may hire a second engineer.",
      support: "Rated 4.8 by clients, with 24/7 cover for the Group plan.",
      invoice: { number: "F-2026-0362", title: "Monthly plan" },
      contact: { email: "lea@studio.example" },
    }
    expect(scanPackProse(pack)).toEqual([])
    expect(scanPackProse({ invoice: { number: "F-2026-0362" } }, { allowFields: [] })).toHaveLength(
      1,
    )
  })

  it("skips functions and survives a cycle", () => {
    const pack: Record<string, unknown> = { layer: () => "today", label: "Quiet week" }
    pack.self = pack
    expect(scanPackProse(pack)).toEqual([])
  })

  describe("over a world directory", () => {
    const root = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "prose-guard-"))
    afterAll(() => rmSync(root, { recursive: true, force: true }))

    it("reads every module's exports and names the file and the field", async () => {
      const world = path.join(root, "maison")
      mkdirSync(path.join(world, "copy"), { recursive: true })
      writeFileSync(
        path.join(world, "people.ts"),
        'export const PEOPLE = [{ name: "Léa Fontaine", bio: "Co-founder." }]\n',
      )
      writeFileSync(
        path.join(world, "copy", "briefs.ts"),
        'export const BRIEFS = { opening: "Due tomorrow at noon." }\n',
      )
      // A test beside the pack is not pack prose.
      writeFileSync(path.join(world, "people.test.ts"), 'export const X = "Monday"\n')
      const found = await scanWorldPackDir(world)
      expect(found).toEqual([
        {
          file: "copy/briefs.ts",
          field: "BRIEFS.opening",
          kind: "relative-day",
          match: "tomorrow",
          value: "Due tomorrow at noon.",
        },
      ])
    })
  })
})
