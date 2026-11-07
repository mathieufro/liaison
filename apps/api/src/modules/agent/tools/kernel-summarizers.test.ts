// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  summarizeCaptureBusinessKnowledge,
  summarizeContactsExport,
  summarizeSetAway,
} from "~/modules/agent/tools/kernel-summarizers"

const ctx = {} as Parameters<typeof summarizeContactsExport>[1]

describe("kernel approval summaries", () => {
  it("names a contacts export's scope", async () => {
    const tagged = await summarizeContactsExport({ tag: "dealers" }, ctx)
    expect(tagged.title).toBe('Export contacts tagged "dealers"')
    const all = await summarizeContactsExport({}, ctx)
    expect(all.title).toBe("Export contacts to a CSV file")
    expect(all.lines[0]).toContain("every contact you can see")
  })

  it("titles a knowledge capture by the document", async () => {
    const s = await summarizeCaptureBusinessKnowledge(
      { title: "Support inbox", body: "Write to support@example.com." },
      ctx,
    )
    expect(s.title).toBe("Add to company knowledge: Support inbox")
    expect(s.lines).toContain("Write to support@example.com.")
  })

  it("says whose away days a parked set_away changes, and which dates", async () => {
    const own = await summarizeSetAway({ from: "2026-12-07", to: "2026-12-11" }, ctx)
    expect(own.title).toBe("Mark yourself away")
    expect(own.lines).toEqual(["From Mon 7 Dec 2026 to Fri 11 Dec 2026."])
    const other = await summarizeSetAway(
      { userId: "00000000-0000-4000-8000-000000000001", everyWeekday: [3] },
      ctx,
    )
    expect(other.title).toBe("Mark someone else away")
    expect(other.lines).toEqual(["Every week on Wed."])
    expect((await summarizeSetAway({ end: true }, ctx)).title).toBe(
      "End your away days running today",
    )
  })
})
