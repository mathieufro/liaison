// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The demo's welcome popup at 390x844 (the `iphone` project): a bottom sheet
// with a grab handle, the code input filling its row, a sticky footer with a
// full-width Browse, list rows with names only, and nothing past the right
// edge. demo-welcome-routes.ts serves the demo reads.

import { expectKeyFormLaidOut, serveDemoWelcome, signUpForDemo } from "./demo-welcome-routes"
import { expect, test } from "./fixtures/test"
import { expectNoHorizontalClipping } from "./phone-helpers"

test.describe("the demo welcome popup on a phone", () => {
  test("a bottom sheet: step 1 then step 2, Browse full width and always in reach", async ({
    page,
    env,
  }) => {
    const server = await serveDemoWelcome(page, env.serverUrl)
    await signUpForDemo(page, env.ports[1])
    await expect(page.locator("[data-shell]")).toHaveAttribute("data-shell-tier", "phone")

    const dialog = page.getByTestId("demo-welcome")
    await expect(dialog).toBeVisible({ timeout: 30000 })
    await expect(dialog).toHaveAttribute("data-variant", "sheet")
    await expect(dialog).toHaveAttribute("data-step", "agents")
    await expect(page.getByTestId("demo-welcome-handle")).toBeVisible()
    await expect(page.getByTestId("demo-welcome").getByTestId("demo-example-line")).toContainText(
      "example company",
    )
    const viewport = page.viewportSize() ?? { width: 390, height: 844 }

    // The sheet sits on the bottom edge, full width.
    const sheet = await dialog.boundingBox()
    expect(sheet?.width ?? 0).toBeGreaterThan(viewport.width - 2)
    expect(Math.round((sheet?.y ?? 0) + (sheet?.height ?? 0))).toBeGreaterThanOrEqual(
      viewport.height - 2,
    )
    // The code input fills its row: most of the row, beside Confirm.
    const input = await page.getByTestId("demo-verify-code").boundingBox()
    expect(input?.width ?? 0).toBeGreaterThan(viewport.width * 0.5)
    // Browse spans the footer.
    const browse = await page.getByTestId("demo-welcome-browse").boundingBox()
    expect(browse?.width ?? 0).toBeGreaterThan(viewport.width * 0.8)
    await expectNoHorizontalClipping(page)
    await page.screenshot({ path: test.info().outputPath("welcome-step1-390.png") })

    // The own-key form, in place: the key field fills its row.
    await page.getByTestId("demo-welcome-own-key").click()
    await expect(page.getByTestId("demo-byok")).toBeVisible()
    await expectKeyFormLaidOut(page)
    await expectNoHorizontalClipping(page)
    await page.screenshot({ path: test.info().outputPath("welcome-keyform-390.png") })
    await page.getByTestId("demo-welcome-back-to-code").click()

    await page.getByTestId("demo-verify-code").fill("123456")
    await page.getByTestId("demo-verify-submit").click()
    await expect(dialog).toHaveAttribute("data-step", "choose")
    await expect(page.getByTestId("demo-welcome-featured")).toContainText(
      "Agentic customer support",
    )
    await expect(page.getByTestId("demo-welcome-row-chat")).toContainText("Agentic team chat")
    // Names only on a phone.
    await expect(page.getByTestId("demo-welcome-row-chat-desc")).toHaveCount(0)
    // The featured Start is above the fold, and Browse stays on screen.
    const start = await page.getByTestId("demo-welcome-featured-start").boundingBox()
    expect((start?.y ?? 0) + (start?.height ?? 0)).toBeLessThanOrEqual(viewport.height)
    const browse2 = await page.getByTestId("demo-welcome-browse").boundingBox()
    expect((browse2?.y ?? 0) + (browse2?.height ?? 0)).toBeLessThanOrEqual(viewport.height)
    await expectNoHorizontalClipping(page)
    await page.screenshot({ path: test.info().outputPath("welcome-step2-390.png") })

    await page.getByTestId("demo-welcome-browse").click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(() => server.welcomePosts).toEqual([{ choice: "browse" }])
  })
})
