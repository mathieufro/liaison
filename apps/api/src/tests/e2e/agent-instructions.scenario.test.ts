// SPDX-License-Identifier: FSL-1.1-ALv2
//
// E2E — Module K: per-app `agentInstructions` coverage + starter skill library,
// reached END-TO-END over the running `index.e2e.ts` server (spawned by
// `setupScenario`). This is the wire-level counterpart to the unit
// manifest-coverage assertion (`agent-instructions.test.ts`): there we read the
// JSON; here the REAL boot path runs — `getDefaultApps` → `registerApps`
// populates `agentInstructionsRegistry` + `skillRegistry` for the org, and the
// REAL context assembler (`assembleContext`, the same seam `/api/agent/chat`
// uses to build the system prompt) emits them.
//
// Two surfaces are exercised:
//   1. The assembled system prompt's `## Apps` block — every installed app
//      contributes its non-empty `agentInstructions` paragraph under a
//      `### <appName>` header. Reached via the NODE_ENV=test debug route
//      `GET /api/agent/_debug/system-prompt?threadId=<id>` which runs the real
//      assembler for the caller and returns the concatenated system text.
//   2. The starter skill library — discoverable via the `kernel:skill_search`
//      tool and readable via `kernel:skill_read`, both driven through the real
//      `executeTool` pipeline over `POST /api/apps/tools/kernel:<tool>`, and
//      visible in the assembled `## Skills available` block + the assembler's
//      `/api/agent/_debug/manifest` skills-manifest (assembler parity).
//
// Host apps (knowledge, mail, tickets, projects, social, contacts, …) are
// auto-registered for every org at boot — no install needed. The pennylane
// bundled app is installed via its `_test/install-for-test` route (the same
// server-side install dance a third-party app uses); invoicing via its own.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { api, createUserWithScopes } from "@liaison/test-helpers"
import { setupScenario, teardownScenario } from "./setup"

// Distinctive substrings of each app's authored `agentInstructions` paragraph
// (verified against the live manifests 2026-09-17). Asserting a stable phrase,
// not a length — proves the SPECIFIC app's instructions reached the prompt, not
// merely that *some* `## Apps` block exists.
/**
 * An app reaches the `## Apps` block either as a full `### app` block (a tool
 * of the app is loaded) or as its routing summary line (`- **app**: ...`, the
 * core's first line). Either form proves THIS app's instructions reached the
 * prompt, which is what these scenarios pin.
 */
function expectAppInPrompt(appsPart: string | undefined, app: string, phrase: string): void {
  expect(appsPart).toBeDefined()
  const text = appsPart ?? ""
  expect(text.includes(`### ${app}`) || text.includes(`**${app}**:`), `${app} missing`).toBe(true)
  expect(text).toContain(phrase.slice(0, 60))
}

const KNOWLEDGE_PHRASE = "Knowledge is the org's shared memory"
const MAIL_PHRASE = "Mail is email send and receive."
const TICKETS_PHRASE = "Tickets is the support inbox"
const PROJECTS_PHRASE = "Projects tracks assignable work"
const PENNYLANE_PHRASE = "Pennylane is the accounting system of record"
// GAP 4 — the remaining host app that ships authored `agentInstructions` and
// auto-registers for every org at boot (no install needed): contacts. Asserting it
// at the assembled-prompt level closes the hole where S1 only covered
// knowledge/mail/tickets/projects. (Google Drive is a catalog app now.)
const CONTACTS_PHRASE = "Contacts is the people-and-companies directory"
// GAP 4 — the remaining BUNDLED apps with authored `agentInstructions` that must
// reach the `## Apps` block once installed/enabled for the org. Substrings taken
// verbatim from each app's `app.manifest.json` `agentInstructions` (the registry
// value is `desc.agentInstructions`, whose CORE is what the block renders when no
// tool of the app is loaded), verified against the live manifests 2026-09-17.
const SOCIAL_PHRASE = "Use the Social tools to triage findings"
const BOXTAL_PHRASE = "Boxtal is shipping: carrier rates, labels, shipments, and tracking."
const INVOICING_PHRASE =
  "Invoicing issues and reconciles invoices, quotes, proformas, purchase orders"

// Starter skills authored/grown in Module K's catalog (verified app skills).
const PROJECTS_SKILL = "diagnose-routine-state" // projects (host) app skill, no requiredScopes
const INVOICING_SKILL = "vendor-invoice-to-pennylane" // invoicing (bundled) app skill

interface SystemPromptResponse {
  systemText: string
  parts: string[]
}

interface SkillSearchHit {
  name: string
  description: string
  source: "personal" | "org" | "app"
  appName: string | null
  requiredScopes: string[]
}

interface SkillReadResult {
  name: string
  description: string
  body: string
  requiredScopes: string[]
  source: "personal" | "org" | "app"
  appName: string | null
}

interface SkillManifestRow {
  name: string
  description: string
  source: string
  appName: string | null
}

describe("Agent Instructions E2E — Module K (## Apps coverage + starter skills, install → reach)", () => {
  let env: WorkerEnv
  let world: TestWorld
  let url: string
  let prefix: string

  // A driving user with thread + skills read scopes (enough to assemble a prompt
  // and search/read the catalog). Pennylane/invoicing app scopes are NOT needed
  // for the `## Apps` block or for the no-requiredScope starter skills.
  let agentUser: { id: string; token: string }
  // A thread the assembler runs against (any real thread id works — the system
  // prompt is org/actor-scoped, not thread-content-scoped, for the Apps block).
  let threadId: string

  function kernelSchema(): string {
    return prefix ? `"${prefix}kernel"` : "kernel"
  }

  async function seedAgentThread(userId: string): Promise<string> {
    const ks = kernelSchema()
    const id = crypto.randomUUID()
    await env.db.sql.unsafe(
      `INSERT INTO ${ks}.threads (id, org_id, handle, type, created_by) VALUES ($1, $2, $3, 'agent_chat', $4)`,
      [id, world.org.id, `agent-${id.slice(0, 8)}`, userId],
    )
    await env.db.sql.unsafe(
      `INSERT INTO ${ks}.thread_participants (thread_id, user_id, org_id) VALUES ($1, $2, $3)`,
      [id, userId, world.org.id],
    )
    return id
  }

  async function getSystemPrompt(token: string, tid: string): Promise<SystemPromptResponse> {
    const res = await api(url, `/api/agent/_debug/system-prompt?threadId=${tid}`, { token })
    expect(res.status).toBe(200)
    return res.body.data as SystemPromptResponse
  }

  async function callKernelTool(
    token: string,
    tool: string,
    params: Record<string, unknown>,
  ): Promise<{ status: number; body: { data?: unknown; error?: unknown } }> {
    const res = await api(url, `/api/apps/tools/kernel:${tool}`, {
      method: "POST",
      token,
      body: { params },
    })
    return { status: res.status, body: res.body }
  }

  function buildBundle(appName: string): void {
    const liaisonRoot = `${import.meta.dir}/../../../../..`
    const r = spawnSync("bash", ["scripts/build-bundled-app.sh", appName, "--skip-sign"], {
      cwd: liaisonRoot,
      stdio: "pipe",
      encoding: "utf8",
    })
    if (r.status !== 0) {
      throw new Error(`build ${appName} bundle failed (${r.status}): ${r.stderr ?? r.stdout}`)
    }
  }

  function buildPennylaneBundle(): void {
    buildBundle("pennylane")
  }

  async function installPennylane(): Promise<string> {
    const res = await api(url, "/api/_test/pennylane/install-for-test", {
      method: "POST",
      token: world.admin.token,
      body: { orgId: world.org.id },
    })
    if (res.status !== 200) {
      throw new Error(`pennylane install failed: ${res.status} ${JSON.stringify(res.body)}`)
    }
    return res.body.connectionId as string
  }

  async function installInvoicing(): Promise<void> {
    const res = await api(url, "/api/_test/invoicing/install-for-test", {
      method: "POST",
      token: world.admin.token,
      body: { orgId: world.org.id },
    })
    if (res.status !== 200) {
      throw new Error(`invoicing install failed: ${res.status} ${JSON.stringify(res.body)}`)
    }
  }

  // GAP 4 — install the bundled `social` app for the org via the same
  // server-side install dance a third-party app uses. The route registers the
  // app + its agentInstructions into the live registry (reloadInstalledApps →
  // registerApps → agentInstructionsRegistry). Requires the pre-built tarball
  // (built hermetically in `beforeAll` via `buildBundle("social")`).
  async function installSocial(): Promise<void> {
    const res = await api(url, "/api/_test/social/install-for-test", {
      method: "POST",
      token: world.admin.token,
      body: { orgId: world.org.id },
    })
    if (res.status !== 200) {
      throw new Error(`social install failed: ${res.status} ${JSON.stringify(res.body)}`)
    }
  }

  // GAP 4 — install the bundled `boxtal` app. The route drives the full
  // install + mock-backed credential-connection dance (mock literals by default,
  // no live creds needed in NODE_ENV=test — same call shape `longtail.scenario`
  // uses) and registers boxtal's agentInstructions into the live registry.
  async function installBoxtal(): Promise<void> {
    const res = await api(url, "/api/_test/boxtal/install-for-test", {
      method: "POST",
      token: world.admin.token,
      body: { orgId: world.org.id },
    })
    if (res.status !== 200) {
      throw new Error(`boxtal install failed: ${res.status} ${JSON.stringify(res.body)}`)
    }
  }

  // Org-wide enable of a default-off (`enabledByDefault:false`) app skill. The
  // starter playbooks ship opt-in: registration seeds an org-wide
  // `disabled_app_skills` row, so they are NOT in the resolved catalog until an
  // admin enables them. The org-scope toggle (admin-only) deletes that seed row.
  async function enableAppSkillOrgWide(appName: string, skillName: string): Promise<void> {
    const res = await api(url, `/api/agent/app-skills/${appName}/${skillName}/toggle`, {
      method: "POST",
      token: world.admin.token,
      body: { scope: "org" },
    })
    if (res.status !== 200) {
      throw new Error(
        `enable ${appName}/${skillName} failed: ${res.status} ${JSON.stringify(res.body)}`,
      )
    }
    const data = res.body.data as { enabled?: boolean }
    if (data.enabled !== true) {
      throw new Error(
        `enable ${appName}/${skillName} did not flip on (already enabled?): ${JSON.stringify(data)}`,
      )
    }
  }

  beforeAll(async () => {
    const result = await setupScenario({
      seed: 91,
      org: { name: "Agent Instructions E2E Org" },
      populate: { users: { count: 2 } },
    })
    env = result.env
    world = result.world
    url = env.serverUrl
    prefix = env.schemaPrefix ?? ""

    // Hermetic: build the bundled tarballs so each install never depends on a
    // stale on-disk artifact. Pennylane (S2), social + boxtal (S7, GAP 4).
    buildPennylaneBundle()
    buildBundle("social")
    buildBundle("boxtal")

    agentUser = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: [
        "kernel:threads:read",
        "kernel:threads:write",
        "kernel:skills:read",
        "kernel:routines:read",
      ],
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })

    threadId = await seedAgentThread(agentUser.id)
  }, 240_000)

  afterAll(async () => {
    await teardownScenario(env, world)
  }, 15_000)

  // ═══════════════════════════════════════════════════════════════
  //  S1: host apps' agentInstructions reach the assembled ## Apps block
  // ═══════════════════════════════════════════════════════════════

  it("S1: every auto-installed host app contributes its agentInstructions to the ## Apps block", async () => {
    const { systemText, parts } = await getSystemPrompt(agentUser.token, threadId)

    // The block exists and is a distinct system part.
    expect(systemText).toContain("## Apps")
    const appsPart = parts.find((p) => p.includes("## Apps"))
    expect(appsPart).toBeDefined()

    // Each host app's SPECIFIC authored instructions are present — keyed under
    // its `### <appName>` header (the assembler's per-app block shape). The
    // newly-authored `knowledge` instructions (Module K's net-new) are the
    // load-bearing assertion: knowledge previously had no agentInstructions at
    // all, so a missing `### knowledge` block would prove K1 never reached the
    // prompt.
    expectAppInPrompt(appsPart, "knowledge", KNOWLEDGE_PHRASE)
    expectAppInPrompt(appsPart, "mail", MAIL_PHRASE)
    expectAppInPrompt(appsPart, "tickets", TICKETS_PHRASE)
    expectAppInPrompt(appsPart, "projects", PROJECTS_PHRASE)
    // GAP 4 — contacts also auto-registers for every org at boot (proven by
    // `init.final-wiring.test.ts` / `discover-apps.test.ts`), so its authored
    // instructions must be in the ## Apps block with no install.
    expectAppInPrompt(appsPart, "contacts", CONTACTS_PHRASE)

    // Pennylane is NOT yet installed — its block must be absent (proves the
    // block reflects the live registry, not a static list). S2 installs it.
    expect(appsPart).not.toContain(PENNYLANE_PHRASE)
    // The bundled social/boxtal/invoicing apps are likewise not yet installed —
    // their blocks must be absent here. S7 installs them and asserts they appear.
    expect(appsPart).not.toContain(SOCIAL_PHRASE)
    expect(appsPart).not.toContain(BOXTAL_PHRASE)
    expect(appsPart).not.toContain(INVOICING_PHRASE)
  }, 60_000)

  // ═══════════════════════════════════════════════════════════════
  //  S2: an installed BUNDLED app's agentInstructions reach the ## Apps block
  // ═══════════════════════════════════════════════════════════════

  it("S2: installing the pennylane bundled app makes its agentInstructions appear in the ## Apps block", async () => {
    // Before: absent.
    const before = await getSystemPrompt(agentUser.token, threadId)
    expect(before.systemText).not.toContain(PENNYLANE_PHRASE)

    await installPennylane()

    // After: the bundled app's authored instructions reached the live registry
    // (reloadInstalledApps → registerApps → agentInstructionsRegistry) and the
    // assembler emits them — end-to-end, through the same path the chat stream
    // uses. The host apps remain present (install is additive, not a reset).
    const after = await getSystemPrompt(agentUser.token, threadId)
    const appsPart = after.parts.find((p) => p.includes("## Apps"))
    expect(appsPart).toBeDefined()
    expectAppInPrompt(appsPart, "pennylane", PENNYLANE_PHRASE)
    expect(appsPart).toContain(KNOWLEDGE_PHRASE.slice(0, 60))
  }, 120_000)

  // ═══════════════════════════════════════════════════════════════
  //  S3: a host-app starter skill is discoverable via skill_search and
  //      readable via skill_read (driven through the real executeTool pipeline)
  // ═══════════════════════════════════════════════════════════════

  it("S3: starter skill (projects/diagnose-routine-state) is default-off, then discoverable + readable once enabled", async () => {
    // Default-off invariant: the opt-in starter playbook is NOT in the catalog
    // before an admin enables it (registration seeded an org-wide disabled row).
    const preSearch = await callKernelTool(agentUser.token, "skill_search", { query: "routine" })
    expect(preSearch.status).toBe(200)
    const preHits = (preSearch.body.data as { hits: SkillSearchHit[] }).hits
    expect(preHits.find((h) => h.name === PROJECTS_SKILL)).toBeUndefined()
    // skill_read before enable → typed not-found (it is registered but off).
    const preRead = await callKernelTool(agentUser.token, "skill_read", { name: PROJECTS_SKILL })
    expect((preRead.body.error as { code?: string } | undefined)?.code).toBe("skill_not_found")

    // Enable it org-wide (the admin action that activates a starter skill).
    await enableAppSkillOrgWide("projects", PROJECTS_SKILL)

    // skill_search by keyword — through the real executeTool path — now finds it.
    const search = await callKernelTool(agentUser.token, "skill_search", { query: "routine" })
    expect(search.status).toBe(200)
    const hits = (search.body.data as { hits: SkillSearchHit[] }).hits
    const hit = hits.find((h) => h.name === PROJECTS_SKILL)
    expect(hit).toBeDefined()
    expect(hit?.source).toBe("app")
    expect(hit?.appName).toBe("projects")
    // search returns NO bodies — that is what skill_read is for.
    expect(hit).not.toHaveProperty("body")

    // skill_read by exact name — loads the real body from the registry.
    const read = await callKernelTool(agentUser.token, "skill_read", { name: PROJECTS_SKILL })
    expect(read.status).toBe(200)
    const skill = read.body.data as SkillReadResult
    expect(skill.name).toBe(PROJECTS_SKILL)
    expect(skill.source).toBe("app")
    expect(skill.appName).toBe("projects")
    // A real, non-trivial playbook body (not a stub).
    expect(typeof skill.body).toBe("string")
    expect(skill.body.length).toBeGreaterThan(80)
  }, 60_000)

  // ═══════════════════════════════════════════════════════════════
  //  S4: a BUNDLED-app starter skill becomes discoverable after install
  //      (vendor-invoice-to-pennylane, shipped by the invoicing app)
  // ═══════════════════════════════════════════════════════════════

  it("S4: installing invoicing + enabling makes its vendor-invoice-to-pennylane starter skill discoverable", async () => {
    // Before install: the invoicing app skill is not in the catalog at all.
    const before = await callKernelTool(agentUser.token, "skill_search", { query: "pennylane" })
    expect(before.status).toBe(200)
    const beforeHits = (before.body.data as { hits: SkillSearchHit[] }).hits
    expect(beforeHits.find((h) => h.name === INVOICING_SKILL)).toBeUndefined()

    await installInvoicing()

    // Installed but default-off: registration populated skillRegistry AND seeded
    // the org-wide disabled row, so it is still absent until enabled.
    const afterInstall = await callKernelTool(agentUser.token, "skill_search", {
      query: "pennylane",
    })
    const afterInstallHits = (afterInstall.body.data as { hits: SkillSearchHit[] }).hits
    expect(afterInstallHits.find((h) => h.name === INVOICING_SKILL)).toBeUndefined()

    await enableAppSkillOrgWide("invoicing", INVOICING_SKILL)

    // Enabled: discoverable + readable end-to-end.
    const after = await callKernelTool(agentUser.token, "skill_search", { query: "pennylane" })
    expect(after.status).toBe(200)
    const afterHits = (after.body.data as { hits: SkillSearchHit[] }).hits
    const hit = afterHits.find((h) => h.name === INVOICING_SKILL)
    expect(hit).toBeDefined()
    expect(hit?.source).toBe("app")
    expect(hit?.appName).toBe("invoicing")

    const read = await callKernelTool(agentUser.token, "skill_read", { name: INVOICING_SKILL })
    expect(read.status).toBe(200)
    const skill = read.body.data as SkillReadResult
    expect(skill.name).toBe(INVOICING_SKILL)
    expect(skill.body.length).toBeGreaterThan(80)
  }, 120_000)

  // ═══════════════════════════════════════════════════════════════
  //  S5: the assembled ## Skills available block + manifest list the starter
  //      skills (assembler parity — what the agent actually sees in its prompt)
  // ═══════════════════════════════════════════════════════════════

  it("S5: starter skills surface in the assembled ## Skills block and the assembler skills-manifest", async () => {
    // The assembled system prompt carries the discoverability scaffolding +
    // the starter skills by name (this is the prompt the live agent reads).
    const { systemText, parts } = await getSystemPrompt(agentUser.token, threadId)
    const skillsPart = parts.find((p) => p.includes("## Skills available"))
    expect(skillsPart).toBeDefined()
    // The preamble teaches the weak model the skill_read/skill_search mechanism.
    expect(skillsPart).toContain("skill_read")
    expect(skillsPart).toContain("skill_search")
    // Both starter skills are listed by name in the prompt (projects host skill
    // + invoicing bundled skill installed in S4).
    expect(systemText).toContain(PROJECTS_SKILL)
    expect(systemText).toContain(INVOICING_SKILL)

    // Assembler parity: the `/_debug/manifest` route reproduces the exact
    // skills-manifest line shape the assembler emits, sourced from the same
    // `resolveAllSkills` seam — both starter skills are present.
    const manifest = await api(url, "/api/agent/_debug/manifest", { token: agentUser.token })
    expect(manifest.status).toBe(200)
    const rows = (manifest.body.data as { skills: SkillManifestRow[] }).skills
    const names = rows.map((r) => r.name)
    expect(names).toContain(PROJECTS_SKILL)
    expect(names).toContain(INVOICING_SKILL)
    const projectsRow = rows.find((r) => r.name === PROJECTS_SKILL)
    expect(projectsRow?.source).toBe("app")
    expect(projectsRow?.appName).toBe("projects")
  }, 60_000)

  // ═══════════════════════════════════════════════════════════════
  //  S6: edge — skill_read for a non-existent skill degrades to a typed
  //      not-found error (never a throw / 500)
  // ═══════════════════════════════════════════════════════════════

  it("S6: skill_read for an unknown name surfaces a typed skill_not_found error envelope, not a generic crash", async () => {
    const res = await callKernelTool(agentUser.token, "skill_read", {
      name: "no-such-skill-anywhere-xyz",
    })
    // The handler returns { error: { code: "skill_not_found" } }; executeTool
    // normalizes that to an error envelope and the route surfaces it as a typed
    // error body — NOT a generic INTERNAL_ERROR. The agent sees a precise,
    // reasoned-about failure (the skill does not exist), not an opaque 500.
    const errBody = res.body.error as { code?: string; message?: string } | undefined
    expect(errBody).toBeDefined()
    expect(errBody?.code).toBe("skill_not_found")
    // It is the typed code, not the unhandled-error fallback.
    expect(errBody?.code).not.toBe("INTERNAL_ERROR")
  }, 30_000)

  // ═══════════════════════════════════════════════════════════════
  //  S7 (GAP 4): the remaining BUNDLED apps' agentInstructions reach the
  //      assembled ## Apps block once installed — social, boxtal, invoicing.
  //      Closes the hole where only knowledge/mail/tickets/projects/pennylane
  //      were asserted at the assembled-system-prompt level.
  // ═══════════════════════════════════════════════════════════════

  it("S7: installing social + boxtal + invoicing makes each app's agentInstructions appear in the ## Apps block", async () => {
    // Before installing this scenario's apps, social + boxtal are absent (S4 may
    // already have installed invoicing — order-independent, we re-install all
    // three below and assert post-state).
    const before = await getSystemPrompt(agentUser.token, threadId)
    expect(before.systemText).not.toContain(SOCIAL_PHRASE)
    expect(before.systemText).not.toContain(BOXTAL_PHRASE)

    // Install all three through the same server-side install dance a third-party
    // app uses. Each route runs reloadInstalledApps → registerApps, which writes
    // `desc.agentInstructions` (the manifest field verbatim) into
    // agentInstructionsRegistry keyed by [orgId, appName] — the exact map the
    // assembler walks to build the ## Apps block.
    await installSocial()
    await installBoxtal()
    await installInvoicing()

    // After: each bundled app's authored instructions reached the live registry
    // and the REAL assembler emits them under its `### <appName>` header —
    // end-to-end, through the same `assembleContext` seam `/api/agent/chat` uses.
    const after = await getSystemPrompt(agentUser.token, threadId)
    const appsPart = after.parts.find((p) => p.includes("## Apps"))
    expect(appsPart).toBeDefined()

    // social
    expectAppInPrompt(appsPart, "social", SOCIAL_PHRASE)
    // boxtal
    expectAppInPrompt(appsPart, "boxtal", BOXTAL_PHRASE)
    // invoicing
    expectAppInPrompt(appsPart, "invoicing", INVOICING_PHRASE)

    // Install is additive, not a reset: the host apps + pennylane (S2) remain.
    expect(appsPart).toContain(KNOWLEDGE_PHRASE.slice(0, 60))
    expect(appsPart).toContain(CONTACTS_PHRASE.slice(0, 60))
    expect(appsPart).toContain(PENNYLANE_PHRASE.slice(0, 60))
  }, 180_000)
})
