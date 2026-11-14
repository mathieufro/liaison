// SPDX-License-Identifier: FSL-1.1-ALv2
import { api } from "@liaison/test-helpers"
import { expect, loginAs, test } from "./fixtures/test"
import { seedSharedInboxClaimCase } from "./helpers/mail-fixtures"

async function freshLoginToken(serverUrl: string, email: string, password: string) {
  const res = await api(serverUrl, "/api/auth/login", { body: { email, password } })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body.data.accessToken as string
}

test("shared inbox: Amina reassigns to Lucas via assignee picker", async ({
  page,
  env,
  world,
  qa,
}) => {
  const shared = await seedSharedInboxClaimCase(env, world.admin.id, world.org.id, [
    qa.amina.id,
    qa.lucas.id,
  ])

  // QA tokens are minted at user creation, before mail:inbox grants exist; refresh Amina's token
  // so RLS sees her shared-inbox dimension grant.
  const aminaFreshToken = await freshLoginToken(env.serverUrl, qa.amina.email, "QaPass1!")

  // Pre-claim the conversation as Amina via API
  const claimRes = await api(env.serverUrl, `/api/mail/conversations/${shared.conversationId}`, {
    method: "PATCH",
    token: aminaFreshToken,
    body: { assignedTo: qa.amina.id },
  })
  expect(claimRes.status, JSON.stringify(claimRes.body)).toBe(200)

  await loginAs(page, env, qa.amina.email, "QaPass1!")
  await page.goto(`http://localhost:${env.ports[1]}/mail/${shared.conversationId}`)
  await expect(page.getByTestId("mail-conversation")).toBeVisible({ timeout: 10000 })

  const assigneesPromise = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/mail/accounts/${shared.accountId}/assignees`) &&
      response.request().method() === "GET",
  )
  await page.getByTestId("assignee-picker-trigger").click()
  const assigneesResponse = await assigneesPromise
  expect(assigneesResponse.status()).toBe(200)
  const assigneesBody = (await assigneesResponse.json()) as { data: any[] }
  const assignees = Array.isArray(assigneesBody.data) ? assigneesBody.data : []
  expect(assignees.length).toBeGreaterThan(0)
  // Exactly the picker's fields: email rides along so two assignable people
  // sharing a name can be told apart (name-collision disambiguation); away says
  // until when a colleague is away today (null when present), and nothing more.
  for (const row of assignees) {
    const keys = new Set(Object.keys(row))
    expect([...keys].sort()).toEqual(["avatarUrl", "away", "email", "id", "name"])
    if (row.away !== null) expect(Object.keys(row.away)).toEqual(["until"])
  }

  const reassignPromise = page.waitForResponse(
    (response) =>
      response.url().includes(`/mail/conversations/${shared.conversationId}`) &&
      response.request().method() === "PATCH",
  )
  await page.getByTestId(`assignee-picker-option-${qa.lucas.id}`).click()
  const reassignResponse = await reassignPromise
  expect(reassignResponse.request().postDataJSON()).toEqual({ assignedTo: qa.lucas.id })
  expect(reassignResponse.status()).toBe(200)

  await expect
    .poll(async () => {
      const rows = (await env.db.sql.unsafe(
        `SELECT assigned_to FROM ${env.schemaPrefix ? `"${env.schemaPrefix}app_mail"` : "app_mail"}.conversations WHERE id = $1`,
        [shared.conversationId],
      )) as Array<{ assigned_to: string | null }>
      return rows[0]?.assigned_to
    })
    .toBe(qa.lucas.id)

  await expect(page.getByTestId("assignee-picker-trigger")).toContainText(qa.lucas.name, {
    timeout: 10000,
  })
})
