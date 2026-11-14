// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The demo's first view at 1280: the welcome popup opens on arrival, step 1
// takes the email code, step 2 offers the visitor's picks, Browse closes it
// and records the answer, and the banner's "Scenarios 0/3" brings it back. demo-welcome-routes.ts serves the demo reads.

import { expectKeyFormLaidOut, serveDemoWelcome, signUpForDemo } from "./demo-welcome-routes"
import { expect, test } from "./fixtures/test"

test.describe("the demo welcome popup", () => {
  test("step 1, the code, step 2, Browse, then the banner brings it back", async ({
    page,
    env,
  }) => {
    await page.setViewportSize({ width: 1280, height: 860 })
    const server = await serveDemoWelcome(page, env.serverUrl)
    await signUpForDemo(page, env.ports[1])

    // ── Step 1: turn on your agents ──────────────────────────────────────────
    const dialog = page.getByTestId("demo-welcome")
    await expect(dialog).toBeVisible({ timeout: 30000 })
    await expect(dialog).toHaveAttribute("data-step", "agents")
    await expect(dialog).toHaveAttribute("data-variant", "dialog")
    await expect(page.getByTestId("demo-verify")).toContainText("j•••@example.com")
    await expect(page.getByTestId("demo-welcome-own-key")).toBeVisible()
    await expect(page.getByTestId("demo-welcome-browse")).toBeVisible()
    await expect(page.getByTestId("demo-welcome").getByTestId("demo-example-line")).toContainText(
      "example company",
    )
    await page.screenshot({ path: test.info().outputPath("welcome-step1-1280.png") })

    // The key form opens in place, and the code comes back.
    await page.getByTestId("demo-welcome-own-key").click()
    await expect(page.getByTestId("demo-byok")).toBeVisible()
    await expectKeyFormLaidOut(page)
    await page.screenshot({ path: test.info().outputPath("welcome-keyform-1280.png") })
    await page.getByTestId("demo-welcome-back-to-code").click()

    // ── The code moves it to step 2 ──────────────────────────────────────────
    await page.getByTestId("demo-verify-code").fill("123456")
    await page.getByTestId("demo-verify-submit").click()
    await expect(dialog).toHaveAttribute("data-step", "choose")
    expect(server.verifyPosts).toEqual([{ code: "123456" }])
    await expect(page.getByTestId("demo-welcome-confirmed")).toBeVisible()
    const featured = page.getByTestId("demo-welcome-featured")
    await expect(featured).toHaveAttribute("data-need", "support")
    await expect(featured).toContainText("Agentic customer support")
    await expect(page.getByTestId("demo-welcome-row-chat")).toContainText("Agentic team chat")
    await expect(page.getByTestId("demo-welcome-row-chat-desc")).toBeVisible()
    await expect(page.getByTestId("demo-welcome-row-sales")).toContainText("Agentic sales")
    await page.screenshot({ path: test.info().outputPath("welcome-step2-1280.png") })

    // ── Browse closes it, and the answer is recorded ─────────────────────────
    await page.getByTestId("demo-welcome-browse").click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(() => server.welcomePosts).toEqual([{ choice: "browse" }])

    // ── The banner brings it back, on step 2 now the agents can run ──────────
    // (Not opening by itself after a reload is the server's answer: covered
    // by DemoWelcome.test.tsx and the API's own tests.)
    await expect(page.getByTestId("demo-scenarios-open")).toContainText("0/3")
    await page.getByTestId("demo-scenarios-open").click()
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveAttribute("data-step", "choose")
    // Escape counts as browsing too.
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
  })
})
