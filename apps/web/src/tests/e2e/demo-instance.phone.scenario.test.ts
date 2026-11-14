// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The entry screen at 390x844, because it is the first thing a phone visitor
// sees and a jsdom test cannot measure a layout. Runs ONLY in the `iphone`
// project (playwright.config.ts). See demo-instance.scenario.test.ts for why
// the three demo reads are intercepted.
import { api } from "@liaison/test-helpers"
import { serveDemoOrgRead } from "./demo-welcome-routes"
import { expect, test } from "./fixtures/test"
import { expectNoHorizontalClipping } from "./phone-helpers"

const DEMO_ORG_ID = "11111111-1111-4111-8111-111111111111"

test.describe("the demo entry on a phone", () => {
  test("the signup card fills the viewport, and a workspace lands in the phone shell", async ({
    page,
    env,
  }) => {
    const vitePort = env.ports[1]
    const login = await api(env.serverUrl, "/api/auth/login", {
      method: "POST",
      body: { email: "admin@test.com", password: "12345678" },
    })
    expect(login.status).toBe(200)
    const tokens = login.body?.data as { accessToken: string; refreshToken?: string }
    const expiresAt = new Date(Date.now() + 72 * 3600 * 1000).toISOString()

    await serveDemoOrgRead(page)
    await page.route("**/api/settings/branding", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            orgName: "Resonant Audio Labs",
            logoUrl: null,
            flags: { demo: true },
            byokModelIds: [],
          },
        }),
      }),
    )
    await page.route(`**/api/demo/orgs/${DEMO_ORG_ID}/status`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            orgId: DEMO_ORG_ID,
            state: "ready",
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            expiresAt,
          },
        }),
      }),
    )
    await page.route("**/api/demo/orgs", (route) => {
      if (route.request().method() !== "POST") return route.continue()
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            orgId: DEMO_ORG_ID,
            orgSlug: "demo-acme-audio-a1b2c3",
            userId: "00000000-0000-4000-8000-000000000001",
            state: "ready",
            statusUrl: `/api/demo/orgs/${DEMO_ORG_ID}/status`,
            expiresAt,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
          },
        }),
      })
    })

    await page.goto(`http://localhost:${vitePort}/login`)
    await expect(page.getByTestId("demo-entry")).toBeVisible({ timeout: 30000 })

    // Three pages: what to see, the company, the details. Nothing on any of
    // them hangs off the right edge of a 390px viewport.
    await expectNoHorizontalClipping(page)
    // The company question adds no step: its answer picks the scenarios, and the
    // bar with Continue stays on screen however long the page gets.
    await page.getByTestId("demo-entry-other").click()
    await page.getByTestId("demo-entry-other-text").fill("A bakery")
    await expectNoHorizontalClipping(page)
    await page.getByTestId("demo-entry-products").click()
    await expect(page.getByTestId("demo-needs-rank-commerce")).toBeVisible()
    await page.mouse.wheel(0, -2000)
    await expect(page.getByTestId("demo-entry-products")).toBeInViewport()
    await expect(page.getByTestId("demo-continue")).toBeInViewport({ ratio: 1 })
    await page.getByTestId("demo-continue").click()
    await expect(page.getByTestId("demo-company-step")).toBeVisible()
    await expect(page.getByTestId("demo-example-line")).toContainText("example company")
    await expectNoHorizontalClipping(page)
    await page.getByTestId("demo-company-continue").click()

    // The details form spans essentially the full content width at this tier.
    const viewport = page.viewportSize()
    const signupBox = await page.getByTestId("demo-signup-door").boundingBox()
    expect(signupBox).not.toBeNull()
    expect(signupBox?.width).toBeGreaterThan((viewport?.width ?? 390) * 0.8)
    await expectNoHorizontalClipping(page)

    await page.getByTestId("demo-name").fill("Jane Doe")
    await page.getByTestId("demo-email").fill("visitor@example.com")
    await page.getByTestId("demo-create").click()

    // The phone shell, with the banner above the content and nothing clipped.
    await expect(page.locator("[data-shell]")).toHaveAttribute("data-shell-tier", "phone", {
      timeout: 30000,
    })
    await expect(page.getByTestId("demo-banner")).toBeVisible()
    await expect(page.getByTestId("phone-tab-bar")).toBeVisible()
    await expectNoHorizontalClipping(page)

    // The limits panel is readable at phone width too.
    await page.getByTestId("demo-limits-open").click()
    await expect(page.getByTestId("demo-limits")).toBeVisible()
    await expectNoHorizontalClipping(page)
  })
})
