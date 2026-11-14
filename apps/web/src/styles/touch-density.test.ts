// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The 44px touch floor is a TIER rule, not a per-component one: it lives in
// index.css so that a control added anywhere inherits it. jsdom computes no
// layout, so the geometry itself is judged by the responsive oracle against a
// real browser; what is pinned here is that
// the rule exists, covers both compact tiers, and keeps desktop out of it.
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, test } from "vitest"

describe("compact tier touch density", () => {
  const css = readFileSync(resolve(__dirname, "..", "index.css"), "utf-8")
  const block = css.slice(css.indexOf('[data-shell-tier="tablet"]'))

  test("declares a 44px floor for the tablet and phone tiers", () => {
    expect(block).toContain('[data-shell-tier="tablet"]')
    expect(block).toContain('[data-shell-tier="phone"]')
    expect(block).toMatch(/min-height:\s*44px/)
    expect(block).toMatch(/min-width:\s*44px/)
  })

  test("covers buttons, roles and form controls", () => {
    for (const selector of ["button", '[role="button"]', '[role="tab"]', "select", "input"]) {
      expect(block).toContain(selector)
    }
  })

  // A checkbox is a GLYPH, not a slab. The floor listed `input` flatly, so at
  // tablet width every checkbox in the app grew to a 44px square: the tickets
  // list row drew a checkbox four times its desktop size. The hit area belongs
  // to a wrapper around the control, never to the control's own box.
  test("exempts checkboxes and radios from the 44px box, and sizes them as glyphs", () => {
    expect(block).toMatch(/input:not\(\[type="hidden"\]\)[^)]*:not\(\[type="checkbox"\]\)/)
    expect(block).toContain(':not([type="radio"])')
    expect(block).toMatch(/input\[type="checkbox"\]/)
    expect(block).toMatch(/width:\s*22px/)
    expect(block).toMatch(/height:\s*22px/)
  })

  // A result card's disclosure ("How this number is worked out") and its links are targets the
  // floor above does not list (a summary, a plain anchor): at 390 px the disclosure was 15 px
  // tall. Inside a card they get the same 44px floor, without losing the disclosure's marker.
  test("gives a result card's summaries and links the 44px floor", () => {
    const at = css.indexOf("[data-tool-card]")
    expect(at).toBeGreaterThan(-1)
    const rule = css.slice(
      css.lastIndexOf(":is(", at),
      css.indexOf("}", css.indexOf("a[href]", at)),
    )
    expect(rule).toContain('[data-shell-tier="phone"]')
    expect(rule).toContain('[data-shell-tier="tablet"]')
    expect(rule).toContain("summary")
    expect(rule).toContain("a[href]")
    expect(rule).toMatch(/min-height:\s*44px/)
  })

  test("never applies at the desktop tier", () => {
    expect(css).not.toContain('[data-shell-tier="desktop"]')
  })

  test("leaves a documented opt out for a control that must stay dense", () => {
    expect(block).toContain("data-touch-dense")
  })

  // A mention chip is a WORD in a sentence. Its preview anchor is a
  // role="button", so the floor gave it min-height 44px and, as an inline-flex
  // box, the chip stretched into a two-line slab on the iPhone that pushed the
  // rest of the paragraph a line down. The anchor opts out (data-touch-dense)
  // and the chip keeps a finger-sized target through an invisible ::after hit
  // area, which enlarges the tap area without moving any text.
  test("gives an inline mention chip a hit area instead of the 44px box", () => {
    const rule = css.slice(css.indexOf(".mention-actionable::after"))
    expect(rule.slice(0, 200)).toMatch(/position:\s*absolute/)
    expect(rule.slice(0, 200)).toMatch(/inset:\s*-10px/)
    const pill = css.slice(css.indexOf(".mention-pill {"), css.indexOf(".mention-pill {") + 400)
    expect(pill).toMatch(/display:\s*inline;/)
    expect(pill).toMatch(/position:\s*relative/)
    expect(pill).not.toMatch(/min-height|line-height|height:/)
  })
})
