// SPDX-License-Identifier: FSL-1.1-ALv2
import { api } from "@liaison/test-helpers"
import { expect, loginAs, test } from "./fixtures/test"
import { attachMailToContact, resolveContact } from "./helpers/contacts-seed"
import { freshAccessToken } from "./helpers/fresh-token"
import { seedMailBaseline } from "./helpers/mail-fixtures"

// The contact page lists a person's conversations in its timeline (rows open the
// conversation; the old hover backlinks were removed with it). The mail
// conversation preview is reached where entity previews live: a mention of the
// conversation in a message.
test("EntityPreview: mail conversation mention hover, and the contact's timeline opens it", async ({
  page,
  env,
  world,
  qa,
}, testInfo) => {
  const baseline = await seedMailBaseline(env, qa.admin.id, world.org.id)
  const unique = `backlink-${testInfo.workerIndex}-${Date.now()}`
  // Permission_version drift from earlier tests in the same worker would 401
  // this seed via the cached `qa.admin.token`.
  const adminToken = await freshAccessToken(env.serverUrl, qa.admin.email, "12345678")
  const contact = await resolveContact(env, adminToken, {
    email: `${unique}@e2e.test`,
    name: "Backlink Contact",
    company: "Backlink Co",
    externalId: { e2e: unique },
  })
  const subject = `Backlink Subject ${unique}`
  const { conversationId } = await attachMailToContact(
    env,
    world.org.id,
    contact.id,
    baseline.account.id,
    subject,
  )
  const ref = `mail:conversation:${conversationId}`
  const threadRes = await api(env.serverUrl, "/api/threads", {
    token: adminToken,
    body: {
      forceCreate: true,
      participantIds: [qa.admin.id],
      title: `Mail preview ${unique}`,
      initialMessage: { content: `See @[${subject}](${ref}) before replying.` },
    },
  })
  expect(threadRes.status, JSON.stringify(threadRes.body)).toBe(200)
  const threadId = threadRes.body.data.id as string

  await loginAs(page, env, qa.admin.email, "12345678")

  // The contact's timeline lists the conversation; its row opens it.
  await page.goto(`http://localhost:${env.ports[1]}/contacts/${contact.id}`)
  await expect(page.getByTestId("contact-detail")).toBeVisible({ timeout: 10000 })
  const row = page.getByTestId("contact-activity").locator("button", { hasText: subject })
  await expect(row).toBeVisible({ timeout: 15000 })
  await row.click()
  await page.waitForURL(new RegExp(`/mail/${conversationId}`), { timeout: 10000 })
  await expect(page.getByTestId("mail-conversation")).toBeVisible({ timeout: 10000 })

  // The mention previews the conversation on hover; pinned, its Open button opens it.
  await page.goto(`http://localhost:${env.ports[1]}/threads/${threadId}`)
  const mention = page
    .locator('[data-testid="entity-preview"]')
    .filter({ has: page.locator(`[data-mention-ref="${ref}"]`) })
  await expect(mention).toBeVisible({ timeout: 15000 })

  const fetchPromise = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/mail/conversations/${conversationId}`) &&
      response.url().includes("messageLimit=0"),
  )
  await mention.hover()
  const fetchResponse = await fetchPromise
  expect(fetchResponse.status()).toBe(200)
  const fetchBody = await fetchResponse.json()
  expect(fetchBody.data?.conversation?.subject).toBe(subject)

  const previewContent = page.getByTestId("entity-preview-content")
  await expect(previewContent).toBeVisible({ timeout: 2500 })
  await expect(previewContent).toContainText(subject)

  // Leaving the mention closes a hover preview; a click pins it open.
  await mention.click()
  await page.getByTestId("entity-preview-open").click()
  await page.waitForURL(new RegExp(`/mail/${conversationId}`), {
    timeout: 10000,
  })
  await expect(page.getByTestId("mail-conversation")).toBeVisible({ timeout: 10000 })
})
