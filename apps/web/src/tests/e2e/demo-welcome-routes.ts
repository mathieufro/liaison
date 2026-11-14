// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The demo reads the welcome popup scenarios serve in the browser. The API in
// the Playwright harness boots with demo mode off, so the demo routes are not
// mounted in that process (demo-instance.scenario.test.ts says why): the
// branding flag, the signup, the readiness poll, the visitor's scenario queue,
// the welcome answer, the budget read and the code check are served here, and
// everything else is the real product behind a real session. The contracts
// stubbed are pinned by the API's own tests (apps/api/src/modules/demo/
// demo-door.test.ts).
import { api } from "@liaison/test-helpers"
import type { Page } from "@playwright/test"
import { expect } from "./fixtures/test"

const DEMO_ORG_ID = "11111111-1111-4111-8111-111111111111"

export interface DemoWelcomeServer {
  /** Every welcome answer the page sent, in order. */
  welcomePosts: unknown[]
  /** The code the page sent, if any. */
  verifyPosts: unknown[]
}

/** Serve the demo for one visitor who picked support, then chat, then sales. */
export async function serveDemoWelcome(page: Page, serverUrl: string): Promise<DemoWelcomeServer> {
  const login = await api(serverUrl, "/api/auth/login", {
    method: "POST",
    body: { email: "admin@test.com", password: "12345678" },
  })
  expect(login.status).toBe(200)
  const tokens = login.body?.data as { accessToken: string; refreshToken?: string }
  const expiresAt = new Date(Date.now() + 72 * 3600 * 1000).toISOString()
  const state: DemoWelcomeServer = { welcomePosts: [], verifyPosts: [] }
  let choice: string | null = null
  let verified = false
  const json = (data: unknown, status = 200) => ({
    status,
    contentType: "application/json",
    body: JSON.stringify({ data }),
  })

  await serveDemoOrgRead(page)
  await page.route("**/api/settings/branding", (route) =>
    route.fulfill(
      json({
        orgName: "Resonant Audio Labs",
        logoUrl: null,
        flags: { demo: true },
        byokModelIds: [],
      }),
    ),
  )
  await page.route(`**/api/demo/orgs/${DEMO_ORG_ID}/status`, (route) =>
    route.fulfill(
      json({
        orgId: DEMO_ORG_ID,
        state: "ready",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        expiresAt,
      }),
    ),
  )
  await page.route("**/api/demo/orgs", (route) => {
    if (route.request().method() !== "POST") return route.continue()
    return route.fulfill(
      json(
        {
          orgId: DEMO_ORG_ID,
          orgSlug: "demo-acme-audio-a1b2c3",
          userId: "00000000-0000-4000-8000-000000000001",
          state: "ready",
          statusUrl: `/api/demo/orgs/${DEMO_ORG_ID}/status`,
          expiresAt,
          needs: ["support", "chat", "sales"],
          verification: { sent: true, emailMasked: "j•••@example.com" },
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
        },
        201,
      ),
    )
  })
  await page.route("**/api/demo/scenarios", (route) =>
    route.fulfill(
      json(
        (["support", "chat", "sales"] as const).map((need) => ({
          need,
          tourId: `kernel.scenario-${need}`,
          status: "new",
          beatIndex: 0,
          beatCount: 8,
        })),
      ),
    ),
  )
  await page.route("**/api/demo/scenarios/welcome", (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as { choice: string }
      state.welcomePosts.push(body)
      choice = body.choice
    }
    return route.fulfill(json({ choice }))
  })
  await page.route("**/api/demo/budget", (route) =>
    route.fulfill(
      json({
        verified,
        emailMasked: "j•••@example.com",
        notifyManaged: false,
        budget: { usedMicroEur: 0, capMicroEur: 2_000_000 },
        box: { exhausted: false },
        byok: [],
        codeSent: true,
      }),
    ),
  )
  await page.route("**/api/demo/verify", (route) => {
    if (route.request().method() !== "POST") return route.continue()
    state.verifyPosts.push(route.request().postDataJSON())
    verified = true
    return route.fulfill(json({ verified: true }))
  })
  return state
}

/**
 * The signed-in org reads as a demo one. The harness signs in to an ordinary org,
 * and the demo's in-product surfaces need the server to say the org is a demo.
 */
export async function serveDemoOrgRead(page: Page): Promise<void> {
  await page.route("**/api/org", async (route) => {
    if (route.request().method() !== "GET") return route.fallback()
    const response = await route.fetch()
    const body = (await response.json()) as { data?: Record<string, unknown> }
    return route.fulfill({ response, json: { ...body, data: { ...body.data, demo: true } } })
  })
  // The visitor workspace's world: the products world, as a start from the
  // products door creates. The example line and the limits panel name it.
  await page.route("**/api/demo/world", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { worldId: "products" } }),
    }),
  )
}

/** The door to the product: three picks, the company page, the name and address. */
export async function signUpForDemo(page: Page, vitePort: number): Promise<void> {
  await page.goto(`http://localhost:${vitePort}/login`)
  await expect(page.getByTestId("demo-entry")).toBeVisible({ timeout: 30000 })
  await page.getByTestId("demo-needs-support").click()
  await page.getByTestId("demo-needs-chat").click()
  await page.getByTestId("demo-needs-sales").click()
  await page.getByTestId("demo-continue").click()
  await page.getByTestId("demo-company-continue").click()
  await page.getByTestId("demo-name").fill("Jane Doe")
  await page.getByTestId("demo-email").fill("visitor@example.com")
  await page.getByTestId("demo-create").click()
  await expect(page.locator("[data-shell]")).toBeVisible({ timeout: 30000 })
}

/**
 * The popup's own-key form, open: the key field is wide enough to see what is
 * pasted, and nothing sits on top of it (walk D72: at 1280 the field was a
 * 26 px sliver under Save key, the row laid out for the screen's width rather
 * than the popup's).
 */
export async function expectKeyFormLaidOut(page: Page): Promise<void> {
  const form = await page.getByTestId("demo-byok").boundingBox()
  const field = await page.getByTestId("demo-byok-key").boundingBox()
  const save = await page.getByTestId("demo-byok-save").boundingBox()
  const provider = await page.getByTestId("demo-byok-provider").boundingBox()
  if (!form || !field || !save || !provider) throw new Error("the key form is not on screen")
  // Most of the form's width, whatever the screen.
  expect(field.width).toBeGreaterThan(form.width * 0.6)
  for (const other of [save, provider]) {
    const overlapX =
      Math.min(field.x + field.width, other.x + other.width) - Math.max(field.x, other.x)
    const overlapY =
      Math.min(field.y + field.height, other.y + other.height) - Math.max(field.y, other.y)
    expect(overlapX > 0.5 && overlapY > 0.5, "nothing covers the key field").toBe(false)
  }
  // Inside the form, not past its edge.
  expect(field.x + field.width).toBeLessThanOrEqual(form.x + form.width + 0.5)
  expect(save.x + save.width).toBeLessThanOrEqual(form.x + form.width + 0.5)
}
