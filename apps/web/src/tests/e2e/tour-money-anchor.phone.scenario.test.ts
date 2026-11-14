// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The money tour's first beat points at the reminder the visitor holds on Home
// (the row placed `standing_in`). At 390x844 the collapsed chat dock sits over
// the bottom of the page; a partial overlap is intended, but the row the
// spotlight rings must not be FULLY hidden behind it. A jsdom test cannot
// measure that. Runs ONLY in the `iphone` project (playwright.config.ts). The
// attention feed is stubbed with the one row, so the check needs no payments
// app and no seeded world: it is about where the row lands on a phone.
import { MONEY_REMINDER_ROW } from "@liaison/shared"
import type { Page } from "@playwright/test"
import { expect, loginAs, test } from "./fixtures/test"

const ADMIN_EMAIL = "admin@test.com"
const ADMIN_PASSWORD = "12345678"
const APPROVAL_ID = "11111111-aaaa-4aaa-8aaa-000000000461"

/** A reminder waiting on the owner for someone away: the row the tour rings. */
const REMINDER_ITEM = {
  id: `kernel:approval_pending:${APPROVAL_ID}`,
  app: "kernel",
  entity: "approval_request",
  entityId: APPROVAL_ID,
  kind: "approval_pending",
  summary: "Payment reminder to Maison Arlon, past due",
  urgency: 70,
  occurredAt: new Date(Date.now() - 3_600_000).toISOString(),
  action: { type: "decide_approval", approvalId: APPROVAL_ID },
  metadata: {
    toolName: "mail:reply",
    actionLabel: "Mail: reply",
    placement: "standing_in",
    requestHandle: "request-1",
    requesterName: "Claire's agent",
    summaryLines: ["The card on the subscription failed twice."],
    expiresInSeconds: 5 * 86_400,
  },
}

/** The anchor's selector as the tour resolves it: a testid prefix plus an attribute pin. */
function anchorSelector(anchor: string): string {
  const m = /^(.+)\*\[(data-[a-z-]+)=([^\]]+)\]$/.exec(anchor)
  if (!m) throw new Error(`not a prefix anchor with a pin: ${anchor}`)
  return `[data-testid^="${m[1]}"][${m[2]}="${m[3]}"]`
}

/**
 * How many of a grid of points over the anchor's visible part (inside the
 * viewport) land on the anchor itself rather than on something above it.
 */
async function visiblePoints(
  page: Page,
  selector: string,
): Promise<{ hit: number; total: number }> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return { hit: 0, total: 0 }
    const r = el.getBoundingClientRect()
    const left = Math.max(r.left, 0)
    const right = Math.min(r.right, window.innerWidth)
    const top = Math.max(r.top, 0)
    const bottom = Math.min(r.bottom, window.innerHeight)
    if (right <= left || bottom <= top) return { hit: 0, total: 0 }
    let hit = 0
    let total = 0
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 5; j++) {
        const x = left + ((right - left) * (i + 0.5)) / 5
        const y = top + ((bottom - top) * (j + 0.5)) / 5
        total++
        const at = document.elementFromPoint(x, y)
        if (at && el.contains(at)) hit++
      }
    }
    return { hit, total }
  }, selector)
}

test.describe("the money tour's first beat on a phone", () => {
  test("the first beat's spotlight anchor is not fully hidden at 390 px", async ({ page, env }) => {
    await page.route("**/api/attention-items", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { items: [REMINDER_ITEM], errors: [] } }),
      }),
    )
    await loginAs(page, env, ADMIN_EMAIL, ADMIN_PASSWORD)
    await page.goto(`http://localhost:${env.ports[1]}/`)

    const selector = anchorSelector(MONEY_REMINDER_ROW)
    const row = page.locator(selector)
    await expect(row).toHaveCount(1, { timeout: 30_000 })
    await row.scrollIntoViewIfNeeded()
    await expect(row).toBeVisible()

    const { hit, total } = await visiblePoints(page, selector)
    expect(total, "the anchor has no box inside the viewport").toBeGreaterThan(0)
    // Partly under the dock is intended; entirely under it, or off screen, is not.
    expect(hit, "every sampled point of the anchor is covered by something else").toBeGreaterThan(0)
  })
})
