// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Stripe customers list and one customer page on a phone (390 by 844): one column, no horizontal
// scroll, and no control under 44 px.
import type { Page } from "@playwright/test"
import { expect, loginAs, test } from "./fixtures/test"
import { expectNoHorizontalClipping } from "./phone-helpers"
import {
  assertStripeBundle,
  customersMocks,
  installStripeApp,
  installToolMocks,
} from "./stripe/_stripe-fixtures"

async function expectPhoneFit(page: Page, rootTestId: string): Promise<void> {
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    inner: window.innerWidth,
  }))
  expect(widths.inner).toBe(390)
  expect(widths.scroll).toBeLessThanOrEqual(widths.inner)
  await expectNoHorizontalClipping(page)
  const wide = await page.evaluate((id) => {
    const root = document.querySelector(`[data-testid="${id}"]`)
    const out: string[] = []
    for (const el of Array.from(root?.querySelectorAll("*") ?? [])) {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.right > window.innerWidth + 1)
        out.push(`${el.tagName} right edge ${Math.round(r.right)}`)
    }
    return out.slice(0, 5)
  }, rootTestId)
  expect(wide).toEqual([])
  // Every control the screen draws is at least 44 px tall. The shell's own chrome is not this app's.
  const root = page.getByTestId(rootTestId)
  for (const control of [
    ...(await root.getByRole("button").all()),
    ...(await root.getByRole("link").all()),
  ]) {
    const box = await control.boundingBox()
    if (!box) continue
    expect(
      box.height,
      `${await control.innerText()} is at least 44 px tall`,
    ).toBeGreaterThanOrEqual(44)
  }
}

test.describe("Stripe customers at phone width", () => {
  test.setTimeout(120_000)

  test.beforeAll(async ({ env, world, qa }) => {
    assertStripeBundle()
    await installStripeApp({ serverUrl: env.serverUrl, token: qa.admin.token, orgId: world.org.id })
  })

  test("the phone customers list has no horizontal scroll and no small control", async ({
    page,
    env,
    qa,
  }) => {
    await installToolMocks(page, customersMocks())
    await loginAs(page, env, qa.admin.email, "12345678")
    await page.goto(`http://localhost:${env.ports[1]}/stripe/customers`)
    await expect(page.getByTestId("stripe-customer-row-cus_ArlonHotels")).toBeVisible({
      timeout: 20_000,
    })
    await expect(page.getByTestId("stripe-unlinked")).toBeVisible()
    await expectPhoneFit(page, "stripe-customers")
  })

  test("the phone customer page has no horizontal scroll and no small control", async ({
    page,
    env,
    qa,
  }) => {
    await installToolMocks(page, customersMocks())
    await loginAs(page, env, qa.admin.email, "12345678")
    await page.goto(
      `http://localhost:${env.ports[1]}/stripe/customers/5b1f0c2e-7a64-4f0e-9d0a-2f0a1b7c9e01`,
    )
    await expect(page.getByTestId("stripe-customer")).toBeVisible({ timeout: 20_000 })
    await expectPhoneFit(page, "stripe-customer")
  })
})
