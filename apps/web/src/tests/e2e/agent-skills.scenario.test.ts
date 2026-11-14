// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Agent App: Skills — end-to-end UI scenarios.
 *
 * Run via Strobe:
 *   debug_test projectRoot=... suite=e2e test="Agent App: Skills"
 *
 * The describe title is metachar-free (per the Strobe regex memory rule) so
 * it survives unescaped `--grep` matching.
 */

import { api } from "@liaison/test-helpers"
import type { Page } from "@playwright/test"
import {
  activeTabScope,
  expandToolRollups,
  loginAsAdmin,
  loginAsAmina,
  openAgentApp,
  openAgentConversation,
  openAgentSkills,
  openAgentTabByHandle,
  openOwnAgentTab,
  sendInConversation,
} from "./agent-bootstrap"
import { agentDmThreadId, scriptAgentTurn, turnToolCalls, waitForTurnEnd } from "./agent-turn"
import { expect, test } from "./fixtures/test"
import { seedModelPricingAndCredits } from "./helpers/agent-seed"
import {
  clearAgentAppTables,
  getSkillByName,
  pollUntil,
  ROLE_AGENT_HANDLE,
  restoreAgentAppBaseline,
} from "./helpers/agent-test-fixtures"

/**
 * P4c-T21b — THE FOUR AGENT-LOOP SCENARIOS IN THIS FILE (S1, S2, S5, S5b) RUN
 * ON A SERVER-SCRIPTED TURN.
 *
 * They used to drive the retired right-rail `agent-panel` against a LIVE model,
 * with a 150s budget and an 80s Stop -> Send gate, and assert a marker string in
 * whatever prose came back. Two things were wrong with that once the panel went:
 * the surface does not exist, and "the model said the marker" was a proxy for
 * "the skill registry served the right body".
 *
 * Now only the MODEL is scripted (`agent-turn.ts`): `skill_read` / `create_skill`
 * execute FOR REAL through the tool bridge, against the rows these tests author
 * through the real UI and the real API. So S1/S2 assert the BODY the tool
 * returned (read off the turn's persisted `metadata.toolCalls`) rather than the
 * model's paraphrase of it, and S5/S5b still answer a real approval the real
 * gate created.
 */
const S1_ANSWER = "S1: loaded the echo-test skill."
const S2_ANSWER = "S2: loaded the summarize-ticket skill."
const S5_ANSWER = "S5: staged the greeting-skill for your approval."
const S5B_ANSWER = "S5b: staged the rejected-skill for your approval."

/**
 * P4c FX-C4 — THE SKILLS SURFACE IS A TAB OF AN AGENT'S PAGE.
 *
 * The scenarios below used to reach it through the retired flat `/agent/skills`
 * screen and assert that screen's affordances: the provenance sub-tab rail
 * (`skills-subtab-built-in|org|personal`) and the flat create surface
 * (`skill-create` / `skills-new-*`). Neither exists on the agent page, and
 * neither is a behaviour: an agent-scoped list has ONE provenance by
 * construction (SkillsList renders the rail only when it is unscoped), and the
 * create form beside the list is the tab's own (`agent-skill-create-*`, T36).
 *
 * So the navigation moved to `openOwnAgentTab` / `openAgentTabByHandle` and the
 * testids to the tab's, while every behaviour under test stayed: the empty
 * state, authoring a skill that shows up in the list AND persists, a skill's
 * domain round-tripping, and who may edit a shared skill in place. ONE scenario
 * still goes through `/agent/skills`, because the legacy redirect is itself a
 * behaviour worth pinning.
 *
 * WHERE AN ORG SKILL LIVES. A shared skill belongs to no person, so on the
 * agent pages it belongs to a ROLE agent (`skills_select`, 0047: a row whose
 * owner is a role agent is readable by the whole org, and A15 lets only a
 * `kernel:agents:admin` write it). The standard world seeds `triage-bug-report`
 * on its role agent (`ROLE_AGENT_HANDLE`), and the two org scenarios ask their
 * question on THAT agent's page.
 */

/**
 * Fill and save the agent tab's create form, and SURFACE a refusal instead of
 * letting the assertion after it time out on a mystery: an A15 "no" renders in
 * place, in the form (`agent-skill-create-error`).
 */
async function createSkillOnAgentTab(
  page: Page,
  skill: { name: string; description: string; body: string },
): Promise<void> {
  await page.getByTestId("skills-new-skill").click({ timeout: 30_000 })
  await page.getByTestId("agent-skill-create").waitFor({ state: "visible", timeout: 30_000 })
  await page.getByTestId("agent-skill-create-name").fill(skill.name)
  await page.getByTestId("agent-skill-create-description").fill(skill.description)
  await page.getByTestId("agent-skill-create-body").fill(skill.body)
  await page.getByTestId("agent-skill-create-save").click()
  const createError = page.getByTestId("agent-skill-create-error")
  await expect
    .poll(
      async () =>
        (await createError.isVisible().catch(() => false))
          ? await createError.innerText()
          : await page
              .getByTestId("agent-skill-create")
              .isVisible()
              .then((open) => (open ? "still-open" : "saved"))
              .catch(() => "saved"),
      { timeout: 20_000, intervals: [400] },
    )
    .toBe("saved")
}

/** The skill body `skill_read` returned, whatever envelope it came in. */
function readSkillBody(calls: Array<{ toolName: string; result?: unknown }>): string {
  const result = calls.find((c) => c.toolName === "kernel__skill_read")?.result
  return typeof result === "string" ? result : JSON.stringify(result ?? null)
}

test.describe("Agent App: Skills", () => {
  // This file calls clearAgentAppTables, which truncates the worker-shared
  // skills/routines seed. Restore the baseline so later files in the reused
  // Playwright worker (e.g. the skills/routines visual scenarios) still see it.
  test.afterAll(async ({ env }) => {
    await restoreAgentAppBaseline(env)
  })

  test("activity bar shows the Agents entry and opens the agents sidebar", async ({
    page,
    env,
  }) => {
    await loginAsAmina(page, env)
    await page.goto(`http://localhost:${env.ports[1]}/`)
    await page.getByTestId("activity-bar").waitFor({ state: "visible" })
    await openAgentApp(page)
    // The sidebar's box searches agents, skills, routines and memory; it is
    // not a chat search, and the agents app is not a chat surface any more.
    await expect(page.getByTestId("agent-sidebar-chat-list")).toHaveCount(0)
    // The sidebar is the org's agent list since P4c-T33, with the viewer's own
    // agent pinned first. `@base` is a kind='system' row the listing never
    // returns to an ordinary member (A1), so it is absent here by design.
    await expect(page.locator("[data-agent-mine]")).toHaveCount(1)
    await expect(page.getByTestId("agent-sidebar-row-@base")).toHaveCount(0)
    // And there is no directory screen beside the sidebar repeating it.
    await expect(page.getByTestId("agents-directory")).toHaveCount(0)
    await page.screenshot({ path: "test-results/agent-app-open.png" })
  })

  test("the legacy skills link opens the agent page Skills tab, with no sub-tabs and an empty state", async ({
    page,
    env,
  }) => {
    // THE ONE SCENARIO THAT STILL GOES THROUGH `/agent/skills`. The flat screen
    // is retired but its URL is not: `legacyRedirectFor` rewrites it onto the
    // viewer's own agent page, and a bookmark that lands nowhere is exactly the
    // regression this pins.
    // The baseline is restored first so the empty state is a FACT about this
    // agent (the seeded skills belong to no agent) rather than an accident of
    // which files this Playwright worker ran before.
    await restoreAgentAppBaseline(env)
    await loginAsAmina(page, env)
    await page.goto(`http://localhost:${env.ports[1]}/`)
    await openAgentSkills(page)
    await expect(page.getByTestId("agent-skills-tab")).toBeVisible({ timeout: 30_000 })
    // NO PROVENANCE SUB-TABS. The rail sorted a flat listing by where a skill
    // came from; an agent-scoped list is one agent's own, so there is nothing
    // to sort (SkillsList.tsx renders the rail only when it is unscoped).
    await expect(page.getByTestId("skills-subtabs")).toHaveCount(0)
    for (const source of ["built-in", "org", "personal"] as const) {
      await expect(page.getByTestId(`skills-subtab-${source}`)).toHaveCount(0)
    }
    // Empty state visible for an agent that owns no skills yet.
    await expect(page.getByTestId("skills-empty-state")).toBeVisible()
    await page.screenshot({ path: "test-results/agent-skills-empty.png" })
  })

  test("skill authoring (manual) — create a skill on the agent page's Skills tab", async ({
    page,
    env,
    qa,
  }) => {
    // A15 after P4c FX-F4: the OWNER of a personal agent authors its skills,
    // ceiling or no ceiling (a skill is a document, read into a turn that
    // already runs at the reader's own scopes), so this is Amina on her own
    // agent — the person the surface is for.
    await loginAsAmina(page, env)
    await page.goto(`http://localhost:${env.ports[1]}/`)
    await openOwnAgentTab(page, "skills")
    await expect(page.getByTestId("agent-skills-tab")).toBeVisible({ timeout: 30_000 })
    await createSkillOnAgentTab(page, {
      name: "test-skill",
      description: "Hello world skill",
      body: "# Test skill body",
    })
    // On save the form closes and the new skill's detail opens beside the list.
    await expect(page.getByTestId("skill-detail")).toBeVisible({ timeout: 10_000 })
    // The list rail is the same surface, so the row is there without leaving.
    await expect(page.getByTestId("skill-row-test-skill")).toBeVisible({ timeout: 10_000 })
    // And it is a REAL row, not just a list the client is holding.
    const row = await pollUntil(() => getSkillByName(env, qa.amina.token, "test-skill"), {
      timeout: 10_000,
      label: "test-skill-row",
    })
    expect(row.createdByActorType).toBe("user")
    await page.screenshot({ path: "test-results/agent-skills-created.png" })
  })

  test("skill authoring: a skill's domain round-trips to the list and the row", async ({
    page,
    env,
    qa,
  }) => {
    await loginAsAmina(page, env)
    await page.goto(`http://localhost:${env.ports[1]}/`)
    await openOwnAgentTab(page, "skills")
    await expect(page.getByTestId("agent-skills-tab")).toBeVisible({ timeout: 30_000 })
    await createSkillOnAgentTab(page, {
      name: "shipping-skill",
      description: "Handles shipping questions",
      body: "# Shipping skill body",
    })
    await expect(page.getByTestId("skill-detail")).toBeVisible({ timeout: 10_000 })

    // THE DOMAIN IS AUTHORED ON THE ROW, through the detail's own Edit form:
    // the agent tab's create form carries name, description and body, and the
    // domain field lives in `SkillFormFields` beside them on edit. The
    // behaviour under test is the round trip, not which of the two forms
    // typed it.
    await page.getByTestId("skill-edit").click({ timeout: 10_000 })
    await page.getByTestId("skill-edit-domain").fill("shipping")
    await page.getByTestId("skill-edit-save").click()

    // Detail shows the domain badge.
    await expect(page.getByTestId("skill-detail-domain")).toHaveText("shipping", {
      timeout: 10_000,
    })
    // And the list row beside it carries the same badge.
    await expect(page.getByTestId("skill-row-shipping-skill")).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId("skill-domain-shipping-skill")).toHaveText("shipping")

    // API-side: the domain persisted on the row. Polled on the DOMAIN, not on
    // the row: the row is already there (the create made it) and the edit's
    // PUT is still in flight when the optimistic list renders the badge, so
    // "wait until a row exists" would read the pre-edit value and call it the
    // answer.
    await expect
      .poll(
        async () => (await getSkillByName(env, qa.amina.token, "shipping-skill"))?.domain ?? null,
        { timeout: 10_000, intervals: [250] },
      )
      .toBe("shipping")
  })

  // ─── E2E plan smoke (step 2 in plan) ──────────────────────────────────────
  test("smoke — skills surface mounts with credits + pricing seeded", async ({
    page,
    env,
    world,
  }) => {
    await seedModelPricingAndCredits(env, world.org.id)
    await clearAgentAppTables(env)
    await loginAsAmina(page, env)
    await page.goto(`http://localhost:${env.ports[1]}/`)
    await openAgentSkills(page)
    await expect(page.getByTestId("skills-list")).toBeVisible()
  })

  // ─── S1 — agent invokes personal skill in a fresh chat ────────────────────
  test("S1 — user-created personal skill is invoked by the agent in a fresh chat", async ({
    page,
    env,
    world,
    qa,
  }) => {
    // Real LLM turn + the 80s terminal-state wait need headroom over the 90s
    // suite default so a slow-but-recovering turn isn't cut by the test cap.
    test.setTimeout(150_000)
    await seedModelPricingAndCredits(env, world.org.id)
    await clearAgentAppTables(env)
    await loginAsAdmin(page, env)
    await page.goto(`http://localhost:${env.ports[1]}/`)

    // 1. Navigate to the viewer's own agent page, Skills tab. P4c-T39 moved the
    //    skills surface off the flat `/agent/skills` screen and onto the agent
    //    it belongs to, so this is where a person authors one now.
    await openOwnAgentTab(page, "skills")
    await expect(page.getByTestId("agent-skills-tab")).toBeVisible({ timeout: 30_000 })

    // 2. Author the personal skill through that surface. The list rail is the
    //    same `SkillsList` as before (same row/subtab testids); the create form
    //    beside it is the agent tab's own. The list has no source sub-tabs when
    //    it is scoped to one agent: everything on it already belongs to that
    //    agent, so there is nothing to filter by source.
    await page.getByTestId("skills-new-skill").click({ timeout: 30_000 })
    await page.getByTestId("agent-skill-create").waitFor({ state: "visible", timeout: 30_000 })
    await page.getByTestId("agent-skill-create-name").fill("echo-test")
    await page
      .getByTestId("agent-skill-create-description")
      .fill("Echoes the marker token verbatim.")
    await page
      .getByTestId("agent-skill-create-body")
      .fill(
        'When asked to use this skill, respond with the literal text "ECHO-MARKER-7Z9" and nothing else.',
      )
    await page.getByTestId("agent-skill-create-save").click()

    // 3. The form closes on success. A refusal renders in place, so surface it
    //    rather than letting the poll below time out on a mystery.
    const createError = page.getByTestId("agent-skill-create-error")
    await expect
      .poll(
        async () =>
          (await createError.isVisible().catch(() => false))
            ? await createError.innerText()
            : await page
                .getByTestId("agent-skill-create")
                .isVisible()
                .then((open) => (open ? "still-open" : "saved"))
                .catch(() => "saved"),
        { timeout: 20_000, intervals: [400] },
      )
      .toBe("saved")

    // 4. API-side: poll until row exists for Amina.
    const skill = await pollUntil(() => getSkillByName(env, qa.admin.token, "echo-test"), {
      timeout: 15_000,
      label: "echo-test-row",
    })
    expect(skill.createdByActorType).toBe("user")

    // 5. Script the turn: the agent loads the skill Amina just authored. Only
    //    the CHOICE of tool is scripted — `skill_read` runs for real against the
    //    registry row created through the UI above.
    // Elodie, not Amina: authoring a skill FOR an agent needs the caller's
    // scopes to cover that agent's scope ceiling (`callerMayWriteForAgent`),
    // and an ordinary member does not cover their OWN personal agent's ceiling
    // in this world - see the stuck note in the P4c-T21b-b report.
    const token = qa.admin.token
    const threadId = await agentDmThreadId(env, token)
    await scriptAgentTurn(env, {
      threadId,
      steps: [
        { toolCalls: [{ name: "kernel__skill_read", args: { name: "echo-test" } }] },
        { text: S1_ANSWER },
      ],
    })

    // 6. Drive the one conversation surface.
    const conversation = await openAgentConversation(page)
    await sendInConversation(page, conversation, "use the echo-test skill")
    await waitForTurnEnd(env, { threadId, token, contains: S1_ANSWER })

    const turnRow = conversation
      .locator('[data-testid="message-row"]')
      .filter({ hasText: S1_ANSWER })
      .last()
    await expect(turnRow).toBeVisible({ timeout: 30_000 })
    await expandToolRollups(turnRow)
    await expect(turnRow.locator('[data-tool-name="kernel__skill_read"]').first()).toBeVisible({
      timeout: 20_000,
    })

    // 7. THE MARKER, in the body the tool returned — the personal skill Amina
    //    authored is what the registry served the agent.
    const calls = await turnToolCalls(env, {
      threadId,
      token,
      contains: S1_ANSWER,
      expect: "kernel__skill_read",
    })
    const body = readSkillBody(calls)
    expect(body, `skill_read returned: ${body.slice(0, 400)}`).toContain("ECHO-MARKER-7Z9")
  })

  // ─── S2 — fork a built-in skill, edit body, fork shadows in fresh chat ────
  test("S2 — fork of built-in skill shadows the built-in body", async ({
    page,
    env,
    world,
    qa,
  }) => {
    // Real LLM turn + the 80s terminal-state wait need headroom over the 90s
    // suite default so a slow-but-recovering turn isn't cut by the test cap.
    test.setTimeout(150_000)
    await seedModelPricingAndCredits(env, world.org.id)
    await clearAgentAppTables(env)
    await loginAsAmina(page, env)
    await page.goto(`http://localhost:${env.ports[1]}/`)

    // 1. The Skills surface mounts on the viewer's own agent page (P4c-T39).
    //    The built-in's presence is asserted against the registry in step 2
    //    rather than against the agent-scoped list rail, which shows the
    //    agent's own skills and has no built-in sub-tab.
    await openOwnAgentTab(page, "skills")
    await expect(page.getByTestId("agent-skills-tab")).toBeVisible({ timeout: 30_000 })

    // 2. Fork via the API (UI fork goes via skill-detail; the direct API call
    //    is the production code path and avoids navigation-flake while still
    //    exercising the real fork endpoint).
    const list = await api(env.serverUrl, "/api/agent/skills", {
      method: "GET",
      headers: { Authorization: `Bearer ${qa.amina.token}` },
    })
    const builtIn = (list.body?.data ?? []).find(
      (s: { name: string; source: string; id: string }) =>
        s.name === "summarize-ticket" && s.source === "app",
    )
    expect(builtIn).toBeDefined()
    const forkRes = await api(
      env.serverUrl,
      `/api/agent/skills/${encodeURIComponent(builtIn.id)}/fork`,
      {
        method: "POST",
        body: {},
        headers: { Authorization: `Bearer ${qa.amina.token}` },
      },
    )
    expect(forkRes.status).toBe(201)

    // 3. Edit the body via API (PUT) — replace with marker.
    const forkRow = await pollUntil(() => getSkillByName(env, qa.amina.token, "summarize-ticket"), {
      timeout: 5_000,
      label: "fork-row",
    })
    expect(forkRow.forkedFrom).toBe("app:tickets/summarize-ticket")
    await api(env.serverUrl, `/api/agent/skills/${forkRow.id}`, {
      method: "PUT",
      body: {
        body: 'When this skill is invoked, respond with the literal text "BETA-FORKED-XYZ" and nothing else.',
      },
      headers: { Authorization: `Bearer ${qa.amina.token}` },
    })

    // 4. DB: exactly one personal row for Amina with forked_from set.
    const ks = `${env.schemaPrefix}kernel`
    const rows = await env.db.sql.unsafe(
      `SELECT name, forked_from, author_user_id
       FROM "${ks}".skills
       WHERE name = 'summarize-ticket' AND author_user_id = $1`,
      [qa.amina.id],
    )
    expect(rows.length).toBe(1)
    expect((rows[0] as any).forked_from).toBe("app:tickets/summarize-ticket")

    // 5. Ask the agent to load `summarize-ticket` — the name now resolves to
    //    BOTH a built-in and Amina's fork, which is the shadowing under test.
    const token = qa.amina.token
    const threadId = await agentDmThreadId(env, token)
    await scriptAgentTurn(env, {
      threadId,
      steps: [
        { toolCalls: [{ name: "kernel__skill_read", args: { name: "summarize-ticket" } }] },
        { text: S2_ANSWER },
      ],
    })
    const conversation = await openAgentConversation(page)
    await sendInConversation(page, conversation, "use the summarize-ticket skill")
    await waitForTurnEnd(env, { threadId, token, contains: S2_ANSWER })

    const turnRow = conversation
      .locator('[data-testid="message-row"]')
      .filter({ hasText: S2_ANSWER })
      .last()
    await expect(turnRow).toBeVisible({ timeout: 30_000 })
    await expandToolRollups(turnRow)
    await expect(turnRow.locator('[data-tool-name="kernel__skill_read"]').first()).toBeVisible({
      timeout: 20_000,
    })

    // 6. THE BODY the registry served is the FORK's, not the built-in's.
    const calls = await turnToolCalls(env, {
      threadId,
      token,
      contains: S2_ANSWER,
      expect: "kernel__skill_read",
    })
    const body = readSkillBody(calls)
    expect(body, `skill_read returned: ${body.slice(0, 400)}`).toContain("BETA-FORKED-XYZ")
    expect(body).not.toContain("ALPHA-BUILT-IN")
  })

  // ─── S3 — disable a built-in skill; manifest excludes it ──────────────────
  test("S3 — disabling a built-in skill removes it from the assembler manifest", async ({
    page,
    env,
    world,
    qa,
  }) => {
    await seedModelPricingAndCredits(env, world.org.id)
    await clearAgentAppTables(env)
    await loginAsAmina(page, env)
    await page.goto(`http://localhost:${env.ports[1]}/`)

    // 1. Pre-condition: manifest contains `summarize-ticket` for Amina.
    const before = await api(env.serverUrl, "/api/agent/_debug/manifest", {
      method: "GET",
      headers: { Authorization: `Bearer ${qa.amina.token}` },
    })
    expect(before.status).toBe(200)
    const beforeNames = (before.body?.data?.skills ?? []).map((s: { name: string }) => s.name)
    expect(beforeNames).toContain("summarize-ticket")

    // 2. Disable the built-in skill via POST /api/agent/app-skills/:app/:name/toggle
    //    (scope: "user" — personal-only disable; doesn't affect org-mates).
    //    Driven by the API rather than the UI because SkillsList does not yet
    //    expose a per-row toggle (only SkillDetail does); this exercises the
    //    same backend code path the SkillDetail UI calls.
    const toggleRes = await api(
      env.serverUrl,
      "/api/agent/app-skills/tickets/summarize-ticket/toggle",
      {
        method: "POST",
        body: { scope: "user" },
        headers: { Authorization: `Bearer ${qa.amina.token}` },
      },
    )
    expect(toggleRes.status).toBe(200)

    // 3. Manifest now excludes summarize-ticket.
    const after = await api(env.serverUrl, "/api/agent/_debug/manifest", {
      method: "GET",
      headers: { Authorization: `Bearer ${qa.amina.token}` },
    })
    expect(after.status).toBe(200)
    const afterNames = (after.body?.data?.skills ?? []).map((s: { name: string }) => s.name)
    expect(afterNames).not.toContain("summarize-ticket")

    // 4. DB: exactly one row in disabled_app_skills for (amina, tickets, summarize-ticket).
    const ks = `${env.schemaPrefix}kernel`
    const rows = await env.db.sql.unsafe(
      `SELECT user_id, app_name, skill_name
       FROM "${ks}".disabled_app_skills
       WHERE user_id = $1 AND app_name = 'tickets' AND skill_name = 'summarize-ticket'`,
      [qa.amina.id],
    )
    expect(rows.length).toBe(1)
  })

  // ─── S5 — agent authors a skill via `create_skill`; user approves; row appears ──
  test("S5 — agent-authored skill is materialized on approval", async ({
    page,
    env,
    world,
    qa,
  }) => {
    test.setTimeout(120_000)
    await seedModelPricingAndCredits(env, world.org.id)
    await clearAgentAppTables(env)
    await loginAsAdmin(page, env)
    await page.goto(`http://localhost:${env.ports[1]}/`)

    // 1. Script the turn: the agent calls the GATED `create_skill`. The call
    //    itself is real, so the real gate stages a real approval — nothing is
    //    written until a human decides it. It gets its own turn with no scoped
    //    read before it (scope taint refuses a write behind scoped reads).
    // Elodie, not Amina: `create_skill`'s approval is decided by
    // `kernel:skills:approve` holders, and an ordinary member is not one
    // (`selfApproveEligible: false`), so an Amina-driven card has no Approve
    // button to click. The scenario is "a human who may decide, decides".
    const token = qa.admin.token
    const threadId = await agentDmThreadId(env, token)
    await scriptAgentTurn(env, {
      threadId,
      steps: [
        // `create_skill` is a DEFERRED tool (`deferLoading: true`), absent from
        // the turn's active tool set until `tool_search` loads it, so discovery
        // is part of the behaviour under test. It is not a SCOPED read, so it
        // does not taint the gated write that follows.
        { toolCalls: [{ name: "kernel__tool_search", args: { query: "create a skill" } }] },
        {
          toolCalls: [
            {
              name: "kernel__create_skill",
              args: {
                name: "greeting-skill",
                description: "Says hello",
                body: "# Say Hello",
                visibility: "personal",
              },
            },
          ],
        },
        { text: S5_ANSWER },
      ],
    })
    const conversation = await openAgentConversation(page)
    await sendInConversation(page, conversation, "make me a personal greeting-skill")
    await waitForTurnEnd(env, { threadId, token, contains: S5_ANSWER })

    // 2. The REAL gate staged a REAL approval rather than writing the row.
    const calls = await turnToolCalls(env, {
      threadId,
      token,
      contains: S5_ANSWER,
      expect: "kernel__create_skill",
    })
    const gated = (calls.find((c) => c.toolName === "kernel__create_skill")?.result ?? {}) as {
      blocked?: boolean
      approvalRequestId?: string
    }
    expect(
      gated.blocked === true && Boolean(gated.approvalRequestId),
      `create_skill did not stage an approval: ${JSON.stringify(gated).slice(0, 600)}`,
    ).toBe(true)

    // 3. The approval card lands inline, in the gated tool's own row.
    // Scoped to THIS turn's row: the DM is worker-scoped, so an earlier
    // scenario's approval card is still on screen above this one.
    const approvalCard = conversation
      .locator('[data-testid="message-row"]')
      .filter({ hasText: S5_ANSWER })
      .last()
      .getByTestId("approval-card")
      .first()
    await expect(approvalCard).toBeVisible({ timeout: 60_000 })
    await expect(approvalCard).toContainText(/greeting-skill/i, { timeout: 10_000 })

    // 3. Approve via the card's approve button. Wait for the executing state
    //    so we know the click took effect before polling for the row.
    await approvalCard.getByTestId("approval-card-action-approve").first().click()

    // 4. Poll until the API confirms the row exists. The approval handler runs
    //    server-side after the click; allow generous time on slow CI.
    const row = await pollUntil(() => getSkillByName(env, qa.admin.token, "greeting-skill"), {
      timeout: 30_000,
      label: "greeting-skill-row",
    })
    expect(row.createdByActorType).toBe("agent")
  })

  // ─── S5b — user rejects the agent skill approval; no row is created ──────
  test("S5b — denying the agent skill approval creates no row", async ({
    page,
    env,
    world,
    qa,
  }) => {
    test.setTimeout(120_000)
    await seedModelPricingAndCredits(env, world.org.id)
    await clearAgentAppTables(env)
    await loginAsAdmin(page, env)
    await page.goto(`http://localhost:${env.ports[1]}/`)

    // 1. Script a turn that calls the GATED `create_skill` for real.
    // Elodie, not Amina: `create_skill`'s approval is decided by
    // `kernel:skills:approve` holders, and an ordinary member is not one
    // (`selfApproveEligible: false`), so an Amina-driven card has no Approve
    // button to click. The scenario is "a human who may decide, decides".
    const token = qa.admin.token
    const threadId = await agentDmThreadId(env, token)
    await scriptAgentTurn(env, {
      threadId,
      steps: [
        // `create_skill` is a DEFERRED tool (`deferLoading: true`), absent from
        // the turn's active tool set until `tool_search` loads it, so discovery
        // is part of the behaviour under test. It is not a SCOPED read, so it
        // does not taint the gated write that follows.
        { toolCalls: [{ name: "kernel__tool_search", args: { query: "create a skill" } }] },
        {
          toolCalls: [
            {
              name: "kernel__create_skill",
              args: {
                name: "rejected-skill",
                description: "Should be denied",
                body: "# Nope",
                visibility: "personal",
              },
            },
          ],
        },
        { text: S5B_ANSWER },
      ],
    })
    const conversation = await openAgentConversation(page)
    await sendInConversation(page, conversation, "make me a personal rejected-skill")

    // 2. The turn has to SETTLE before the deny interaction. The approval card
    //    first mounts inside the *streaming* tool-call row; when the gated
    //    assistant message finalizes into the message list it becomes a separate
    //    ToolCallRow instance, so the ApprovalCard remounts and its local
    //    `denying` signal resets. Deny is a two-step interaction (click Deny ->
    //    reason input appears -> fill -> submit) that would otherwise span that
    //    remount and lose the inline reason input mid-way (S5's single approve
    //    click is atomic, so it is immune). The persisted final text is the
    //    honest settled signal — see `agent-turn.ts` on why not the DOM.
    await waitForTurnEnd(env, { threadId, token, contains: S5B_ANSWER })
    // Scoped to THIS turn's row: the DM is worker-scoped, so an earlier
    // scenario's approval card is still on screen above this one.
    const approvalCard = conversation
      .locator('[data-testid="message-row"]')
      .filter({ hasText: S5B_ANSWER })
      .last()
      .getByTestId("approval-card")
      .first()
    await expect(approvalCard).toBeVisible({ timeout: 60_000 })
    await expect(approvalCard).toContainText(/rejected-skill/i, { timeout: 10_000 })

    // 3. Click Deny (opens the reason input).
    await approvalCard.getByTestId("approval-card-action-deny").first().click()

    // 4. Fill the reason input and submit.
    const reasonInput = approvalCard.getByTestId("approval-card-deny-reason").first()
    await expect(reasonInput).toBeVisible({ timeout: 10_000 })
    await reasonInput.fill("test rejection")
    await approvalCard.getByTestId("approval-card-action-deny-submit").first().click()

    // 5. Wait for the approval pipeline to complete. The card transitions
    //    away from the deny inputs — give the server-side write a moment.
    await page.waitForTimeout(1500)

    // 6. The API confirms no `rejected-skill` row exists.
    const skill = await getSkillByName(env, qa.admin.token, "rejected-skill")
    expect(skill).toBeNull()
  })

  // ─── Org-skill edit gating — Edit/Delete only for an agents-admin ──────────
  // Regression: SkillDetail showed Edit/Delete for org-shared skills to EVERY
  // member, but the backend lets only an admin edit one, so a non-admin's save
  // 403'd. On the agent page the answer is the SERVER'S (`canWrite`, A15/T32b)
  // and the web never recomputes it, which is the stronger version of the same
  // guarantee. Both tests restore the baseline first so they see the seeded org
  // skill on its role agent regardless of the order Playwright reuses this
  // worker (earlier tests truncate the table).
  test("org skill: a non-admin sees Fork but not Edit or Delete on the owning agent's page", async ({
    page,
    env,
  }) => {
    await restoreAgentAppBaseline(env)
    // Amina, an ordinary member: the whole point of the scenario, and what the
    // fixture sweep's rename quietly turned into a second admin run.
    await loginAsAmina(page, env)
    await page.goto(`http://localhost:${env.ports[1]}/`)
    await openAgentTabByHandle(page, ROLE_AGENT_HANDLE, "skills")
    // Two agent pages are open by now (the viewer's own and this role agent's)
    // and both stay mounted, so every question is asked of the tab in front of
    // the user.
    const agentTab = activeTabScope(page)
    await expect(agentTab.getByTestId("agent-skills-tab")).toBeVisible({ timeout: 30_000 })
    // THE ORG SKILL IS ON ITS OWNING AGENT'S PAGE, in a list with no provenance
    // sub-tabs to find it under.
    await expect(agentTab.getByTestId("skills-subtabs")).toHaveCount(0)
    await agentTab.getByTestId("skill-row-triage-bug-report").click({ timeout: 30_000 })
    await expect(agentTab.getByTestId("skill-detail")).toBeVisible({ timeout: 10_000 })
    await expect(agentTab.getByTestId("skill-detail-source-org")).toBeVisible()
    // Non-admin: no in-place edit of a shared skill; fork to a personal copy instead.
    await expect(agentTab.getByTestId("skill-fork")).toBeVisible()
    await expect(agentTab.getByTestId("skill-edit")).toHaveCount(0)
    await expect(agentTab.getByTestId("skill-delete")).toHaveCount(0)
    // Nor may a member author a NEW skill for a role agent (A15), so the tab
    // offers no create action either.
    await expect(agentTab.getByTestId("skills-new-skill")).toHaveCount(0)
    await page.screenshot({ path: "test-results/agent-skills-org-nonadmin.png" })
  })

  test("org skill: an admin sees Edit + Delete on the owning agent's page", async ({
    page,
    env,
  }) => {
    await restoreAgentAppBaseline(env)
    await loginAsAdmin(page, env)
    await page.goto(`http://localhost:${env.ports[1]}/`)
    await openAgentTabByHandle(page, ROLE_AGENT_HANDLE, "skills")
    const agentTab = activeTabScope(page)
    await expect(agentTab.getByTestId("agent-skills-tab")).toBeVisible({ timeout: 30_000 })
    await expect(agentTab.getByTestId("skills-subtabs")).toHaveCount(0)
    await agentTab.getByTestId("skill-row-triage-bug-report").click({ timeout: 30_000 })
    await expect(agentTab.getByTestId("skill-detail")).toBeVisible({ timeout: 10_000 })
    await expect(agentTab.getByTestId("skill-detail-source-org")).toBeVisible()
    await expect(agentTab.getByTestId("skill-edit")).toBeVisible()
    await expect(agentTab.getByTestId("skill-delete")).toBeVisible()
    await page.screenshot({ path: "test-results/agent-skills-org-admin.png" })
  })
})
