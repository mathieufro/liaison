// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Stripe customers list and one customer page on a desktop: search, the Not linked section that
// suggests and never links by itself, the Subscriptions filter, and a customer with its masked card.
import { expect, loginAs, test } from "./fixtures/test"
import {
  assertStripeBundle,
  customersMocks,
  installStripeApp,
  installToolMocks,
} from "./stripe/_stripe-fixtures"

test.describe("Stripe customers", () => {
  test.setTimeout(120_000)

  test.beforeAll(async ({ env, world, qa }) => {
    assertStripeBundle()
    await installStripeApp({ serverUrl: env.serverUrl, token: qa.admin.token, orgId: world.org.id })
  })

  test("the list shows customers, the Not linked section and the filters", async ({
    page,
    env,
    qa,
  }) => {
    await installToolMocks(page, customersMocks())
    await loginAs(page, env, qa.admin.email, "12345678")
    await page.goto(`http://localhost:${env.ports[1]}/stripe/customers`)
    await expect(page.getByTestId("stripe-customers")).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId("stripe-customer-row-cus_ArlonHotels")).toBeVisible()
    // The past-due customer is listed first; its status is words, not a count.
    await expect(page.getByTestId("stripe-customer-status-cus_ArlonHotels")).toHaveText("Past due")
    // A customer with no company waits for a person to confirm one: nothing links by itself.
    await expect(page.getByTestId("stripe-unlinked")).toBeVisible()
    await expect(page.getByTestId("stripe-customers-search")).toBeVisible()
    for (const chip of ["all", "subscriptions", "unlinked", "past_due", "trial", "cancelled"]) {
      await expect(page.getByTestId(`stripe-chip-${chip}`)).toBeVisible()
    }
    await page.getByTestId("stripe-chip-subscriptions").click()
    await expect(page.getByTestId("stripe-chip-subscriptions")).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    await expect(page.getByTestId("stripe-plan-totals")).toBeVisible()
  })

  test("a customer page shows the masked card, invoices and a dispute-free history", async ({
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
    await expect(page.getByTestId("stripe-customer-card-line")).toContainText("Visa 4242, 10/26")
    await expect(page.getByTestId("stripe-customer-invoice-in_1")).toContainText(
      "Issued by Liaison, collected by Stripe",
    )
    await expect(page.getByTestId("stripe-customer-refund")).toBeVisible()
    await expect(page.getByTestId("stripe-customer-cancel")).toBeVisible()
    // No full card number anywhere on the page.
    const text = await page.getByTestId("stripe-customer").innerText()
    expect(text).not.toMatch(/\d{13,19}/)
  })
})
