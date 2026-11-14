// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "Who issues what" in the issuer settings: without Stripe only the two other streams show, each
// always not billed from Stripe; the card stream's issuer reads as decided or not; and the word
// Checked shows only after a person said Stripe's own emails are off.
import { afterEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import manifest from "../../app.manifest.json"
import {
  createStandingOff,
  emailsLine,
  InvoicingIssuerStreams,
  STANDING_UNDO_MS,
  standingLine,
  standingOnCall,
  streamRow,
} from "./IssuerStreams"

afterEach(() => {
  ;(globalThis as any).__liaisonHost = undefined
})

describe("who issues what, in the issuer settings", () => {
  it("without Stripe the section shows the two other streams, each always not billed from Stripe", () => {
    // What issuer_stream_get returns for an org with no Stripe connection.
    const streams = [
      { stream: "transfer" as const, issuer: "liaison" as const, notBilledFromStripe: true },
      { stream: "one_off" as const, issuer: "liaison" as const, notBilledFromStripe: true },
    ]
    expect(streams.map(streamRow)).toEqual([
      { name: "Recurring by transfer", who: "Always: not billed from Stripe" },
      { name: "One-off invoices", who: "Always: not billed from Stripe" },
    ])
    expect(streamRow({ stream: "card", issuer: "undecided" }).who).toBe("Not decided yet")
    expect(streamRow({ stream: "card", issuer: "stripe" }).who).toBe("Stripe invoices")
    // A block of the existing issuer settings section, not a page or a sidebar row.
    const section = (manifest as any).settings.sections.find((s: any) => s.id === "issuers")
    expect(section.blocks.map((b: any) => b.component)).toContain("InvoicingIssuerStreams")
    expect(typeof InvoicingIssuerStreams).toBe("function")
    // French readers get the same lines.
    ;(globalThis as any).__liaisonHost = { locale: () => "fr" }
  })

  it("the word Checked never shows without a person's click", () => {
    expect(emailsLine(null)).toBeNull()
    const unknown = emailsLine({ state: "unknown", confirmedBy: null, confirmedAt: null })
    expect(unknown).toContain("Please check in Stripe")
    expect(unknown).not.toMatch(/checked/i)
    // A confirmed state with no time is not a person's statement.
    expect(emailsLine({ state: "confirmed", confirmedBy: "u1", confirmedAt: null })).not.toMatch(
      /^Checked/,
    )
    expect(
      emailsLine(
        { state: "confirmed", confirmedBy: "u1", confirmedAt: "2026-11-03T09:30:00.000Z" },
        "en-GB",
      ),
    ).toMatch(/^Checked by a person on 3 Nov 2026/)
    // No other string of the block says Checked.
    const source = readFileSync(join(import.meta.dir, "IssuerStreams.tsx"), "utf8")
    expect(source.match(/"Checked[^"]*"/g)).toEqual([
      '"Checked by a person on {{day}}. Liaison cannot read this setting, so check again if someone changes it."',
    ])
  })
})

describe("the standing e-invoice authorization of a stream", () => {
  /** A clock the test moves by hand. */
  function manualClock() {
    let now = 0
    let next = 1
    const timers = new Map<number, { at: number; fn: () => void }>()
    return {
      set: (fn: () => void, ms: number) => {
        const id = next++
        timers.set(id, { at: now + ms, fn })
        return id
      },
      clear: (id: unknown) => {
        timers.delete(id as number)
      },
      advance(ms: number) {
        now += ms
        for (const [id, t] of [...timers]) {
          if (t.at <= now) {
            timers.delete(id)
            t.fn()
          }
        }
      },
    }
  }

  it("turning it on asks for a person's approval through the stream setting", () => {
    expect(standingOnCall("issuer-1", "transfer")).toEqual({
      tool: "issuer_stream_set",
      params: { issuerProfileId: "issuer-1", stream: "transfer", einvoiceStanding: true },
    })
  })

  it("turning it off waits 8 seconds; Undo inside them calls nothing", () => {
    expect(STANDING_UNDO_MS).toBe(8000)
    const clock = manualClock()
    const calls: Array<{ tool: string; params: Record<string, unknown> }> = []
    const off = createStandingOff({
      run: (tool, params) => void calls.push({ tool, params }),
      setTimer: clock.set,
      clearTimer: clock.clear,
    })

    off.request("issuer-1", "card")
    expect(off.pending()).toEqual({ issuerProfileId: "issuer-1", stream: "card" })
    clock.advance(7999)
    expect(calls).toEqual([])
    off.undo()
    expect(off.pending()).toBeNull()
    clock.advance(60_000)
    expect(calls).toEqual([])

    off.request("issuer-1", "card")
    clock.advance(8000)
    expect(calls).toEqual([
      { tool: "einvoice_standing_off", params: { issuerProfileId: "issuer-1", stream: "card" } },
    ])
    expect(off.pending()).toBeNull()
    // Undo after the call has gone changes nothing.
    off.undo()
    clock.advance(60_000)
    expect(calls).toHaveLength(1)
  })

  it("says off, or who turned it on, when and until when", () => {
    expect(standingLine({ on: false, turnedOnBy: null, turnedOnAt: null, until: null }, null)).toBe(
      "Off: e-invoices issued with no person wait for the daily send card.",
    )
    expect(
      standingLine(
        { on: true, turnedOnBy: "u1", turnedOnAt: "2026-11-03T09:30:00.000Z", until: "2027-02-01" },
        "Claire Dubois",
        "en-GB",
      ),
    ).toBe("On: turned on by Claire Dubois on 3 Nov 2026, until 1 Feb 2027.")
  })
})

describe("turning the standing authorization on", () => {
  it("is offered only with a platform, says what it does, and never promises an approval it does not file", () => {
    const src = readFileSync(join(import.meta.dir, "IssuerStreams.tsx"), "utf8")
    expect(src).not.toContain("after a person approves")
    expect(src).toContain("window.confirm(tr(STANDING_ON_CONFIRM))")
    expect(src).toContain("standing-needs-platform-")
    // The Undo window counts down instead of a fixed "8 seconds".
    expect(src).toContain('tr("Turning off in {{n}} seconds.", { n: left() })')
  })
})
