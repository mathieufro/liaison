// SPDX-License-Identifier: FSL-1.1-ALv2
//
// M2-3 T20: the You seat and the work surfaces that had never been looked at
// on a phone. Before this batch the settings tab opened onto the Profile form,
// an admin table painted its desktop columns at 390px, contacts and knowledge
// painted desktop reading columns, the calendar painted a 7 column month grid,
// and search painted a 720px column.
//
// It runs ONLY in the `iphone` project (see playwright.config.ts).
import { expect, test } from "./fixtures/test"
import { seedContactPair } from "./helpers/contacts-seed"
import { createKnowledgeDocument } from "./helpers/knowledge-seed"
import { SHOT_DIR } from "./helpers/shot-dir"
import { expectNoHorizontalClipping } from "./phone-helpers"

test.describe("the You seat and the work surfaces at phone width", () => {
  test("You: profile, the agent's own group, the notification settings row and the admin notice", async ({
    authenticatedPage: page,
  }) => {
    await expect(page.locator("[data-shell]")).toHaveAttribute("data-shell-tier", "phone")

    await page.getByTestId("phone-tab-you").tap()
    await expect(page.getByTestId("you-screen")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId("you-title")).toContainText("You")

    // The profile row names the viewer and says which workspace and server
    // this is, which nothing on the phone said before. A role ID is never
    // printed there: the token carries ids, not role names.
    await expect(page.getByTestId("you-profile-name")).not.toBeEmpty()
    const identity = page.getByTestId("you-profile-identity")
    await expect(identity).not.toBeEmpty()
    await expect(identity).not.toContainText(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
    )

    // One link into the Agents app, unheaded. Skills and routines, memory and
    // connectors belong to that app and are reached there, not restated here.
    const agentGroup = page.getByTestId("you-group-agent")
    await expect(agentGroup).toBeVisible()
    await expect(agentGroup.locator("h2")).toHaveCount(0)
    await expect(page.getByTestId("you-row-agent-app")).toBeVisible()
    await expect(page.getByTestId("you-row-agent-skills")).toHaveCount(0)
    await expect(page.getByTestId("you-row-agent-memory")).toHaveCount(0)

    // Notifications: one row of the You group into the notification settings
    // (the digest and push switches moved there), a full-width row a thumb can hit.
    await expect(page.getByTestId("you-group-you")).toBeVisible({ timeout: 15_000 })
    const notifRow = page.getByTestId("you-row-you-notifications")
    await expect(notifRow).toBeVisible()
    await expect(page.locator("[data-testid^='you-toggle-notifications-']")).toHaveCount(0)
    const viewportWidth = await page.evaluate(() => window.innerWidth)
    // The rows are rebuilt while the sections and apps load, so measure once one holds a box.
    await expect.poll(() => notifRow.boundingBox()).not.toBeNull()
    const box = await notifRow.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewportWidth)
    // 44px is the floor for anything a finger has to hit.
    expect(box!.height).toBeGreaterThanOrEqual(44)

    await expect(page.getByTestId("you-group-workspace")).toBeVisible()
    await expectNoHorizontalClipping(page)
    await page.screenshot({ path: `${SHOT_DIR}/m2-you.png`, fullPage: true })
    await page.screenshot({ path: `${SHOT_DIR}/m2fx3-you.png`, fullPage: true })

    // The workspace (admin) sections are last, and an admin table warns rather than
    // blanking: Continue anyway puts the viewer through to the real section.
    const adminRow = page.getByTestId("you-row-workspace-users")
    await expect(adminRow).toBeVisible()
    await adminRow.tap()
    await expect(page.getByTestId("settings-admin-notice")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId("settings-admin-notice")).toContainText("larger screen")
    // The table under it was never hidden.
    await expect(page.getByTestId("settings-content")).toBeVisible()
    await page.getByTestId("settings-admin-continue").tap()
    await expect(page.getByTestId("settings-admin-notice")).toHaveCount(0)
    await expect(page.getByTestId("settings-content")).toBeVisible()

    // Back lands on You, not on the Profile form.
    await page.getByTestId("settings-phone-back").tap()
    await expect(page.getByTestId("you-screen")).toBeVisible()
    await expectNoHorizontalClipping(page)
  })

  test("Contacts and Knowledge read as phone lists", async ({
    authenticatedPage: page,
    env,
    qa,
  }) => {
    const pair = await seedContactPair(env, qa.admin.token, "phone")
    await createKnowledgeDocument(env, qa.admin.token, {
      title: `Phone reading doc ${Date.now()}`,
      body: "# Heading\n\nSome body text.",
    })

    await page.reload()
    await expect(page.locator("[data-shell]")).toHaveAttribute("data-shell-tier", "phone")

    // ── Contacts ──
    await page.getByTestId("phone-tab-work").tap()
    await expect(page.getByTestId("work-screen")).toBeVisible()
    await page.getByTestId("work-row-contacts").tap()
    await expect(page.getByTestId("contacts-list")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId("contacts-title")).toContainText("Contacts")

    const row = page.getByTestId(`contact-row-${pair.primary.id}`)
    await expect(row).toBeVisible({ timeout: 15_000 })
    // 64px is the row height the phone tier uses, not the desktop 3 line row.
    const rowBox = await row.boundingBox()
    expect(rowBox?.height ?? 0).toBeGreaterThanOrEqual(56)
    await expectNoHorizontalClipping(page)
    await page.screenshot({ path: `${SHOT_DIR}/m2-contacts.png`, fullPage: false })

    // A row inside a SwipeRow is TAPPED, never clicked: a click is a press and
    // a release with no pointer stream, which the rail never sees.
    await row.tap()
    await expect(page.getByTestId("contact-detail")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId("contact-detail-title")).toContainText("Primary")
    await expect(page.getByTestId("contact-detail-fields")).toBeVisible()
    await expectNoHorizontalClipping(page)

    // ── Knowledge ──
    await page.getByTestId("phone-tab-work").tap()
    await expect(page.getByTestId("work-screen")).toBeVisible()
    await page.getByTestId("work-row-knowledge").tap()
    await expect(page.getByTestId("knowledge-home")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId("knowledge-title")).toContainText("Knowledge")
    await expect(page.getByTestId("knowledge-home-recently-touched")).toBeVisible()
    await expectNoHorizontalClipping(page)
    await page.screenshot({ path: `${SHOT_DIR}/m2-knowledge.png`, fullPage: false })
  })

  test("the calendar is an agenda, and search rows carry their entity mark", async ({
    authenticatedPage: page,
  }) => {
    // The calendar reads a connected Google account, which no e2e worker has:
    // the tool responses are served here so the REAL agenda renders real rows
    // rather than the not-connected empty state.
    const day = new Date()
    day.setHours(9, 0, 0, 0)
    const end = new Date(day.getTime() + 30 * 60 * 1000)
    await page.route("**/apps/calendar/tools/list_calendars", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [{ id: "cal-phone", summary: "Work", color: "#2563eb", selected: true }],
        }),
      }),
    )
    await page.route("**/apps/calendar/tools/list_events", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [
            {
              eventId: "evt-phone-1",
              calendarId: "cal-phone",
              title: "Phone agenda standup",
              start: { dateTime: day.toISOString() },
              end: { dateTime: end.toISOString() },
              allDay: false,
              recurrence: null,
              recurringEventId: null,
              originalStartTime: null,
              status: "confirmed",
            },
          ],
        }),
      }),
    )

    await page.reload()
    await expect(page.locator("[data-shell]")).toHaveAttribute("data-shell-tier", "phone")

    await page.getByTestId("phone-tab-work").tap()
    await expect(page.getByTestId("work-screen")).toBeVisible()
    await page.getByTestId("work-row-calendar").tap()
    await expect(page.getByTestId("calendar-agenda")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId("calendar-agenda-strip")).toBeVisible()
    await expect(page.getByTestId("calendar-agenda-event-evt-phone-1")).toContainText(
      "Phone agenda standup",
    )
    await expectNoHorizontalClipping(page)
    await page.screenshot({ path: `${SHOT_DIR}/m2-calendar.png`, fullPage: false })

    // ── Search ──
    await page.getByTestId("phone-tab-search").tap()
    await expect(page.getByTestId("search-tab")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId("search-title")).toContainText("Search")
    await page.getByTestId("search-input").fill("a")
    await expect(page.getByTestId("search-results")).toBeVisible({ timeout: 20_000 })
    await expect(page.locator("[data-testid^='search-result-icon-']").first()).toBeVisible()
    await expect(page.getByTestId("search-filter-chips")).toBeVisible()
    await expectNoHorizontalClipping(page)
    await page.screenshot({ path: `${SHOT_DIR}/m2-search.png`, fullPage: false })
  })
})
