// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Stripe Home on a phone (390 by 844): one column, nothing sliced off the right edge, no
// horizontal scroll, and no control under 44 px.
import type { Page } from "@playwright/test"
import { expect, loginAs, test } from "./fixtures/test"
import { SHOT_DIR } from "./helpers/shot-dir"
import { expectNoHorizontalClipping } from "./phone-helpers"
import {
  assertStripeBundle,
  homeMocks,
  installStripeApp,
  installToolMocks,
} from "./stripe/_stripe-fixtures"

/** Neither the page, nor any container around Home, nor anything inside it is wider than the phone. */
async function expectNothingScrollsSideways(page: Page): Promise<void> {
  const wide = await page.evaluate(() => {
    const out: string[] = []
    const home = document.querySelector('[data-testid="stripe-home"]')
    for (let el = home?.parentElement ?? null; el; el = el.parentElement) {
      if (el.scrollWidth > el.clientWidth + 1)
        out.push(`ancestor ${el.tagName} scrolls ${el.scrollWidth} > ${el.clientWidth}`)
    }
    for (const el of Array.from(home?.querySelectorAll("*") ?? [])) {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.right > window.innerWidth + 1)
        out.push(`${el.tagName} right edge ${Math.round(r.right)}`)
    }
    return out.slice(0, 5)
  })
  expect(wide).toEqual([])
}

test.describe("Stripe Home at phone width", () => {
  test.setTimeout(120_000)

  test.beforeAll(async ({ env, world, qa }) => {
    assertStripeBundle()
    await installStripeApp({ serverUrl: env.serverUrl, token: qa.admin.token, orgId: world.org.id })
  })

  test("the phone home has no horizontal scroll at 390 by 844", async ({ page, env, qa }) => {
    await installToolMocks(page, homeMocks())
    await loginAs(page, env, qa.admin.email, "12345678")
    await page.goto(`http://localhost:${env.ports[1]}/stripe`)
    await page.waitForLoadState("networkidle")

    await expect(page.getByTestId("stripe-home")).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId("stripe-attention")).toBeVisible()
    await expect(page.getByTestId("stripe-mrr")).toBeVisible()
    // One block per currency, never converted.
    await expect(page.getByTestId("stripe-mrr-line-eur")).toBeVisible()
    await expect(page.getByTestId("stripe-mrr-line-usd")).toBeVisible()

    const widths = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      inner: window.innerWidth,
    }))
    expect(widths.inner).toBe(390)
    expect(widths.scroll).toBeLessThanOrEqual(widths.inner)
    await expectNoHorizontalClipping(page)
    await expectNothingScrollsSideways(page)

    // Every control on the page is at least 44 px tall.
    const home = page.getByTestId("stripe-home")
    for (const control of [
      ...(await home.getByRole("button").all()),
      ...(await home.getByRole("link").all()),
    ]) {
      const box = await control.boundingBox()
      expect(box, "control has a box").not.toBeNull()
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
    }
    // The rule lives one tap away and wraps inside the phone too.
    await page.getByTestId("stripe-mrr-how-toggle").click()
    await expect(page.getByTestId("stripe-mrr-how")).toBeVisible()
    await expectNoHorizontalClipping(page)
    await expectNothingScrollsSideways(page)

    await page.screenshot({ path: `${SHOT_DIR}/stripe-home-phone.png`, fullPage: true })
  })
})
