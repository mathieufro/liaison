// SPDX-License-Identifier: FSL-1.1-ALv2
import { createHash } from "node:crypto"
import { api } from "@liaison/test-helpers"
import { expect, loginAs, test } from "./fixtures/test"

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 07: Settings
// ALL 10 flows (A–J). All primary-actor actions via UI.
// ─────────────────────────────────────────────────────────────────────────────

function labeledInput(page: import("@playwright/test").Page, labelText: string) {
  return page.locator(`div:has(> label:text-is("${labelText}")) input`).first()
}

test.describe("Flow A: Navigate to Settings", () => {
  test("Elodie opens settings, sees all sections including admin", async ({
    authenticatedPage,
  }) => {
    await authenticatedPage.getByTestId("activity-settings").click()
    await authenticatedPage.waitForURL(/\/settings/, { timeout: 10000 })

    await expect(authenticatedPage.getByRole("heading", { name: "Profile" })).toBeVisible({
      timeout: 5000,
    })

    // User sections
    await expect(authenticatedPage.getByTestId("settings-link-kernel:profile")).toBeVisible()
    await expect(authenticatedPage.getByTestId("settings-link-kernel:security")).toBeVisible()

    // Admin sections (Elodie is admin). SSO providers live on Security
    // (Sign-in methods) since the settings overhaul: no row of their own.
    await expect(authenticatedPage.getByTestId("settings-link-kernel:users")).toBeVisible()
    await expect(authenticatedPage.getByTestId("settings-link-kernel:org")).toBeVisible()
  })
})

test.describe("Flow B: Update Profile Settings", () => {
  test("update display name, verify toast, restore", async ({ authenticatedPage, env, qa }) => {
    await authenticatedPage.getByTestId("activity-settings").click()
    await authenticatedPage.waitForURL(/\/settings/, { timeout: 10000 })

    const nameInput = labeledInput(authenticatedPage, "Display name")
    await expect(nameInput).toBeVisible({ timeout: 5000 })

    await nameInput.clear()
    await nameInput.fill("Elodie Updated")
    await authenticatedPage.getByRole("button", { name: /save changes/i }).click()
    await expect(authenticatedPage.getByText("Profile updated")).toBeVisible({ timeout: 5000 })

    // Verify persistence via API
    const loginRes = await api(env.serverUrl, "/api/auth/login", {
      body: { email: "admin@test.com", password: "12345678" },
    })
    const meRes = await api(env.serverUrl, "/api/users/me", {
      token: loginRes.body.data.accessToken,
      method: "GET",
    })
    expect(meRes.body.data.name).toBe("Elodie Updated")

    // Restore original name, once the first toast has gone (it stays 5 s), so
    // the toast checked below is the restore's own.
    await expect(authenticatedPage.getByText("Profile updated")).toBeHidden({ timeout: 10000 })
    await nameInput.clear()
    await nameInput.fill("Elodie Vasseur")
    await authenticatedPage.getByRole("button", { name: /save changes/i }).click()
    await expect(authenticatedPage.getByText("Profile updated")).toBeVisible({ timeout: 5000 })
  })
})

test.describe("Flow C: Update Timezone", () => {
  test("change timezone dropdown and save", async ({ authenticatedPage }) => {
    await authenticatedPage.getByTestId("activity-settings").click()
    await authenticatedPage.waitForURL(/\/settings/, { timeout: 10000 })
    await expect(labeledInput(authenticatedPage, "Display name")).toBeVisible({ timeout: 5000 })

    await authenticatedPage
      .locator("select[aria-label='Timezone']")
      .selectOption("America/New_York")
    await authenticatedPage.getByRole("button", { name: /save changes/i }).click()
    await expect(authenticatedPage.getByText("Profile updated")).toBeVisible({ timeout: 5000 })
  })
})

test.describe("Flow D: Update Locale", () => {
  test("change locale dropdown and save", async ({ authenticatedPage }) => {
    await authenticatedPage.getByTestId("activity-settings").click()
    await authenticatedPage.waitForURL(/\/settings/, { timeout: 10000 })
    await expect(labeledInput(authenticatedPage, "Display name")).toBeVisible({ timeout: 5000 })

    const localeSelect = authenticatedPage.locator("select[aria-label='Locale']")
    if (await localeSelect.isVisible().catch(() => false)) {
      await localeSelect.selectOption({ index: 1 })
      await authenticatedPage.getByRole("button", { name: /save changes/i }).click()
      await expect(authenticatedPage.getByText("Profile updated")).toBeVisible({ timeout: 5000 })
    }
  })
})

test.describe("Flow E: Settings Navigation Between Sections", () => {
  test("navigate all 6 sections: Profile, Security, Users, Org, OAuth, back", async ({
    authenticatedPage: page,
    env,
  }) => {
    const vitePort = env.ports[1]
    const base = `http://localhost:${vitePort}`

    // Navigate via direct URL to each settings section — validates that
    // the sidebar renders and the correct heading appears for each.
    // Direct navigation avoids SolidJS Router's referrer accumulation
    // that occurs with rapid sequential <A> clicks.

    // 1. Profile (default)
    await page.goto(`${base}/settings`)
    await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible({ timeout: 10000 })
    await expect(page.getByRole("link", { name: "Security" })).toBeVisible()

    // 2. Security
    await page.goto(`${base}/settings/security`)
    await expect(page.getByRole("heading", { name: "Security" })).toBeVisible({ timeout: 10000 })

    // 3. Users
    await page.goto(`${base}/settings/admin/users`)
    await expect(page.getByRole("heading", { name: "Users" })).toBeVisible({ timeout: 10000 })

    // 4. Organization
    await page.goto(`${base}/settings/admin/org`)
    await expect(page.getByRole("heading", { name: "Organization" }).first()).toBeVisible({
      timeout: 10000,
    })

    // 5. SSO Providers: the former page lands on Security, where they now live.
    await page.goto(`${base}/settings/admin/oauth`)
    await expect(page).toHaveURL(/\/settings\/security/, { timeout: 10000 })
    await expect(page.getByTestId("sso-providers")).toBeVisible({ timeout: 10000 })

    // 6. Back to Profile
    await page.goto(`${base}/settings`)
    await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible({ timeout: 10000 })
  })
})

test.describe("Flow F: Admin — Invite User", () => {
  test("invite dialog renders, sends invitation with Member role", async ({
    authenticatedPage,
  }) => {
    await authenticatedPage.getByTestId("activity-settings").click()
    await authenticatedPage.waitForURL(/\/settings/, { timeout: 10000 })
    await authenticatedPage.getByRole("link", { name: "Users" }).click()
    await authenticatedPage.waitForURL(/\/settings\/admin\/users/, { timeout: 10000 })

    await expect(authenticatedPage.getByRole("heading", { name: "Users" })).toBeVisible()

    await authenticatedPage.getByRole("button", { name: /invite user/i }).click()
    await expect(authenticatedPage.getByText("Send an invitation email")).toBeVisible({
      timeout: 10000,
    })

    await expect(labeledInput(authenticatedPage, "Email address")).toBeVisible()
    await expect(authenticatedPage.locator("select[aria-label='Role']")).toBeVisible()
    await expect(authenticatedPage.getByRole("button", { name: /send invitation/i })).toBeVisible()

    await labeledInput(authenticatedPage, "Email address").fill(
      `invite-${Date.now()}@resonantaudiolabs.example`,
    )
    // Wait for roles to load from API (async fetch when dialog opens): the
    // select holds only its placeholder until they arrive.
    await expect
      .poll(() => authenticatedPage.locator("select[aria-label='Role'] option").count(), {
        timeout: 10000,
      })
      .toBeGreaterThan(1)
    await authenticatedPage.locator("select[aria-label='Role']").selectOption({ index: 1 })
    await authenticatedPage.getByRole("button", { name: /send invitation/i }).click()
    await expect(authenticatedPage.getByText(/Invitation sent/i)).toBeVisible({ timeout: 10000 })
  })
})

test.describe("Flow G: Admin — Invite with Admin Role", () => {
  test("invite with Admin role selected", async ({ authenticatedPage }) => {
    await authenticatedPage.getByTestId("activity-settings").click()
    await authenticatedPage.waitForURL(/\/settings/, { timeout: 10000 })
    await authenticatedPage.getByRole("link", { name: "Users" }).click()
    await authenticatedPage.waitForURL(/\/settings\/admin\/users/, { timeout: 10000 })

    await authenticatedPage.getByRole("button", { name: /invite user/i }).click()
    await expect(authenticatedPage.getByText("Send an invitation email")).toBeVisible({
      timeout: 10000,
    })

    await labeledInput(authenticatedPage, "Email address").fill(
      `admin-${Date.now()}@resonantaudiolabs.example`,
    )
    // Wait for roles to populate, then select the admin role by visible text
    const roleSelect = authenticatedPage.locator("select[aria-label='Role']")
    await expect
      .poll(() => roleSelect.locator("option").count(), { timeout: 10000 })
      .toBeGreaterThan(1)
    // Get all option texts and find one containing "admin" (case-insensitive)
    const options = await roleSelect.locator("option").allTextContents()
    const adminOption = options.find(
      (o) => o.toLowerCase().includes("admin") && o !== "Select a role…",
    )
    if (adminOption) {
      await roleSelect.selectOption({ label: adminOption })
    } else {
      // Fallback: select the last option (usually admin)
      await roleSelect.selectOption({ index: options.length - 1 })
    }
    await authenticatedPage.getByRole("button", { name: /send invitation/i }).click()
    await expect(authenticatedPage.getByText(/Invitation sent/i)).toBeVisible({ timeout: 10000 })
  })
})

test.describe("Flow H: Member Cannot See Admin Settings", () => {
  test("Amina sees only user sections, no admin", async ({ browser, env, qa }) => {
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")

    await page.getByTestId("activity-settings").click()
    await page.waitForURL(/\/settings/, { timeout: 10000 })

    await expect(page.getByRole("link", { name: "Security" })).toBeVisible()
    await expect(page.getByRole("link", { name: "Users" })).not.toBeVisible({ timeout: 2000 })
    await expect(page.getByRole("link", { name: "Organization" })).not.toBeVisible()

    await ctx.close()
  })
})

test.describe("Flow I: Member Cannot Access Admin Routes Directly", () => {
  test("Amina navigating to /settings/admin/users is blocked", async ({ browser, env, qa }) => {
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")

    const vitePort = env.ports[1]
    await page.goto(`http://localhost:${vitePort}/settings/admin/users`)

    // Should redirect to /settings or show no admin content
    await expect(page.getByRole("heading", { name: "Users" })).not.toBeVisible({ timeout: 3000 })

    await ctx.close()
  })
})

test.describe("Flow J: Settings Profile Loading State", () => {
  test("Amina sees her profile data after loading", async ({ browser, env, qa }) => {
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")

    await page.getByTestId("activity-settings").click()
    await page.waitForURL(/\/settings/, { timeout: 10000 })

    await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible({ timeout: 5000 })

    // Display name should show Amina's name
    const nameInput = labeledInput(page, "Display name")
    await expect(nameInput).toBeVisible({ timeout: 5000 })
    await expect(nameInput).toHaveValue("Amina Cherif")

    await ctx.close()
  })
})

test.describe("Settings — Security", () => {
  test("TOTP setup with QR code and recovery codes", async ({ authenticatedPage, env, qa }) => {
    await authenticatedPage.getByTestId("activity-settings").click()
    await authenticatedPage.waitForURL(/\/settings/, { timeout: 10000 })
    await authenticatedPage.getByRole("link", { name: "Security" }).click()
    await authenticatedPage.waitForURL(/\/settings\/security/, { timeout: 10000 })

    await expect(authenticatedPage.getByRole("heading", { name: "Security" })).toBeVisible()

    await authenticatedPage.getByRole("button", { name: /enable 2fa/i }).click()
    await expect(authenticatedPage.getByText("Set up two-factor authentication")).toBeVisible({
      timeout: 5000,
    })

    // Step-up confirmation is an EMAILED 6-digit code, not a password. The
    // code itself only ever reaches the mailbox, so the test asks for one and
    // then overwrites the stored hash with a code it knows.
    const stepUpSent = authenticatedPage.waitForResponse(
      (r) => r.url().includes("/api/auth/totp/step-up") && r.request().method() === "POST",
    )
    await authenticatedPage.getByRole("button", { name: /email me a code/i }).click()
    // Wait for the server to store ITS code first: overwriting the key before
    // that write lands would just be replaced by it.
    await stepUpSent
    const stepUpCode = "123456"
    await env.redis.redis.set(
      `${env.redisPrefix}totp:stepup:${qa.admin.id}`,
      createHash("sha256").update(stepUpCode).digest("hex"),
      "EX",
      600,
    )
    await authenticatedPage.getByPlaceholder("000000").fill(stepUpCode)
    await authenticatedPage.getByRole("button", { name: "Continue" }).click()

    // Wait for QR step to appear
    await expect(authenticatedPage.getByText("Scan this QR code")).toBeVisible({ timeout: 5000 })

    const canvas = authenticatedPage.locator("#totp-qr")
    await expect(canvas).toBeVisible({ timeout: 3000 })
    // Wait for the QR code to render pixels on the canvas
    await authenticatedPage.waitForFunction(
      () => {
        const el = document.querySelector("#totp-qr") as HTMLCanvasElement
        if (!el) return false
        const ctx = el.getContext("2d")
        if (!ctx) return false
        const data = ctx.getImageData(0, 0, el.width, el.height).data
        return data.some((v) => v !== 0)
      },
      null,
      { timeout: 5000 },
    )
    const hasPixels = await canvas.evaluate((el: HTMLCanvasElement) => {
      const ctx = el.getContext("2d")
      if (!ctx) return false
      const data = ctx.getImageData(0, 0, el.width, el.height).data
      return data.some((v) => v !== 0)
    })
    expect(hasPixels).toBe(true)

    const recoveryGrid = authenticatedPage.getByTestId("recovery-codes-grid")
    await expect(recoveryGrid).toBeVisible()
    const codes = await recoveryGrid.locator("span").count()
    expect(codes).toBeGreaterThanOrEqual(8)

    await authenticatedPage.keyboard.press("Escape")
  })

  test("password change form renders all fields", async ({ authenticatedPage }) => {
    await authenticatedPage.getByTestId("activity-settings").click()
    await authenticatedPage.waitForURL(/\/settings/, { timeout: 10000 })
    await authenticatedPage.getByRole("link", { name: "Security" }).click()
    await authenticatedPage.waitForURL(/\/settings\/security/, { timeout: 10000 })

    await expect(authenticatedPage.getByText("Change password")).toBeVisible()
    await expect(labeledInput(authenticatedPage, "Current password")).toBeVisible()
    await expect(labeledInput(authenticatedPage, "New password")).toBeVisible()
    await expect(labeledInput(authenticatedPage, "Confirm new password")).toBeVisible()
    await expect(authenticatedPage.getByRole("button", { name: /update password/i })).toBeVisible()
  })
})

test.describe("Settings — Admin Org", () => {
  test("org settings update with toast", async ({ authenticatedPage }) => {
    await authenticatedPage.getByTestId("activity-settings").click()
    await authenticatedPage.waitForURL(/\/settings/, { timeout: 10000 })
    await authenticatedPage.getByTestId("settings-link-kernel:org").click()
    await authenticatedPage.waitForURL(/\/settings\/admin\/org/, { timeout: 10000 })

    await expect(
      authenticatedPage.getByRole("heading", { name: "Organization" }).first(),
    ).toBeVisible()
    const nameInput = labeledInput(authenticatedPage, "Organization name")
    await expect(nameInput).toBeVisible({ timeout: 5000 })

    // Use a unique org name so the form is dirty even when re-running in the
    // same worker (env persists across tests, so reusing "QA Test Org" would
    // make `dirty()` return false on second invocations).
    const newName = `QA Test Org ${Date.now()}`
    await nameInput.clear()
    await nameInput.fill(newName)
    // Phase 9 introduced ContextualSaveBar; both the bar's Save button
    // (data-testid=save-bar-save) and the bottom Save button trigger the same handler.
    await authenticatedPage.getByTestId("save-bar-save").click()
    await expect(authenticatedPage.getByText("Organization updated")).toBeVisible({ timeout: 5000 })
  })
})

test.describe("Settings — Admin OAuth", () => {
  test("OAuth provider creation", async ({ authenticatedPage }) => {
    await authenticatedPage.getByTestId("activity-settings").click()
    await authenticatedPage.waitForURL(/\/settings/, { timeout: 10000 })
    // SSO providers are a section of Security (Sign-in methods).
    await authenticatedPage.getByTestId("settings-link-kernel:security").click()
    await authenticatedPage.waitForURL(/\/settings\/security/, { timeout: 10000 })

    const sso = authenticatedPage.getByTestId("sso-providers")
    await expect(sso).toBeVisible({ timeout: 10000 })
    await sso.getByTestId("sso-provider-add").click()
    await expect(authenticatedPage.getByText("Add SSO Provider")).toBeVisible({ timeout: 3000 })

    await labeledInput(authenticatedPage, "Provider name").fill("QA Provider")
    await labeledInput(authenticatedPage, "Issuer URL").fill("http://localhost:4580")
    await labeledInput(authenticatedPage, "Client ID").fill("test-client")
    await labeledInput(authenticatedPage, "Client secret").fill("test-secret")
    // Two buttons carry this name once the dialog is open (the header trigger and the form submit).
    await authenticatedPage.locator("form").getByRole("button", { name: "Add provider" }).click()
    await expect(authenticatedPage.getByText("SSO provider added")).toBeVisible({ timeout: 5000 })
  })
})
