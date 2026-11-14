// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The owner's Morning brief, computed from the plan: at the board date it
// reads the board's text, and at any anchor of a year it holds no relative
// day word or literal year.
import { describe, expect, it } from "bun:test"
import { scanPackProse } from "~/seed/worlds/prose-guard"
import { saasMorningBrief } from "./brief"

const BOARD_DATE = new Date("2026-11-09T08:30:00Z")

describe("software world morning brief", () => {
  it("at the board date it reads the board's brief, every figure summed from the seeded rows", () => {
    expect(saasMorningBrief(BOARD_DATE)).toBe(
      [
        "Monthly recurring revenue is €84,708, up €2,281 since 1 Nov: 6 new on Team, 1 upgrade to Group, 1 downgrade, 4 cancellations.",
        "7 subscriptions are past due, €3,367 of MRR. Maison Arlon is the largest, and it also has ticket-412 open with Inès and a proposal with Tom.",
        "4 trials end within the week, Auberge Tilleul first, in 3 days.",
        "9 deals are open, €68,660. Hôtels Sauvan answered, so the follow-up drafted for Marc will not go out.",
        "Sources: card payments, Projects, Tickets, Mail.",
      ].join("\n\n"),
    )
  })

  it("at anchors across a year the brief says no relative day and no year", () => {
    for (let w = 0; w < 56; w++) {
      const anchor = new Date(BOARD_DATE.getTime() + w * 7 * 86_400_000)
      const hits = scanPackProse({ brief: saasMorningBrief(anchor) }).filter(
        (h) => h.kind !== "date",
      )
      expect(hits).toEqual([])
    }
  })
})
