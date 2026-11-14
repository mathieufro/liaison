// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Stripe rail exists only where the app is installed: an org that has not enabled it sees no
// Stripe entry, and the entry opens Home once it is.
import { expect, loginAs, test } from "./fixtures/test"
import {
  assertStripeBundle,
  homeMocks,
  installStripeApp,
  installToolMocks,
} from "./stripe/_stripe-fixtures"

test.describe("Stripe in the rail", () => {
  test.setTimeout(120_000)

  test("a self-hosted org without the app sees no Stripe rail", async ({ page, env, qa }) => {
    await loginAs(page, env, qa.admin.email, "12345678")
    await page.goto(`http://localhost:${env.ports[1]}/`)
    await expect(page.getByTestId("activity-bar")).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId("activity-stripe")).toHaveCount(0)
  })

  test("once the app is enabled the rail opens the Stripe Home", async ({
    page,
    env,
    world,
    qa,
  }) => {
    assertStripeBundle()
    await installStripeApp({ serverUrl: env.serverUrl, token: qa.admin.token, orgId: world.org.id })
    await installToolMocks(page, homeMocks())
    await loginAs(page, env, qa.admin.email, "12345678")
    await page.goto(`http://localhost:${env.ports[1]}/`)
    const entry = page.getByTestId("activity-stripe")
    await expect(entry).toBeVisible({ timeout: 20_000 })
    await entry.click()
    await expect(page.getByTestId("stripe-home")).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId("stripe-sidebar")).toBeVisible()
  })
})
