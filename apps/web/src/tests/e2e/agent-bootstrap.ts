// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Shared E2E bootstrap helper for the agent app scenarios — handles
 * authenticated nav + opening the agent activity-bar entry.
 *
 * Shared by `agent-skills.scenario.test.ts` and
 * `agent-routines.scenario.test.ts` per plan-review P6-4 split.
 */

import type { WorkerEnv } from "@liaison/test-helpers"
import type { Locator, Page } from "@playwright/test"
import { loginAs } from "./fixtures/test"

/**
 * Force the app into dark mode for visual baselines — the rest of the app's
 * screenshots are captured dark. Sets `localStorage["liaison:theme"]` before
 * first paint via an init script (runs before page scripts on every nav) and
 * emulates the OS dark color scheme so `theme: "system"` also resolves dark.
 * Call before the first `page.goto`.
 */
export async function forceDarkMode(page: Page): Promise<void> {
  await page.emulateMedia({ colorScheme: "dark" })
  await page.addInitScript(() => {
    try {
      localStorage.setItem("liaison:theme", "dark")
    } catch {
      /* localStorage unavailable — emulateMedia still covers system theme */
    }
  })
}

export async function loginAsAmina(page: Page, env: WorkerEnv): Promise<void> {
  // QA seed user — amina@resonantaudiolabs.example / QaPass1!
  await loginAs(page, env, "amina@resonantaudiolabs.example", "QaPass1!")
}

export async function loginAsAdmin(page: Page, env: WorkerEnv): Promise<void> {
  // QA admin — owns most seeded skills/routines, so the surfaces render full.
  await loginAs(page, env, "admin@test.com", "12345678")
}

// The agent tab components (AgentSidebar, SkillsList, RoutinesList) are
// individually `lazy()`-split — first navigation pays an on-demand Vite chunk
// compile. Under the suite's CPU contention that can exceed 10s, so these
// structural waits use a load-tolerant 30s budget (same rationale the agent
// visual scenarios already document for their row waits).
//
// The SAME budget MUST apply to the `.click()` calls below. A bare `click()`
// uses Playwright's default 10s `actionTimeout` for its visible/enabled/stable
// actionability wait — under load the lazy chunk + render can leave the nav
// button briefly non-actionable past 10s, so the click (not the waitFor) is
// the real weak link. Passing `{ timeout: NAV_TIMEOUT }` makes the click as
// load-tolerant as the waits; it still fails fast on a genuine regression (a
// button that never renders / a permanent overlay).
const NAV_TIMEOUT = 30_000
const NAV_CLICK = { timeout: NAV_TIMEOUT } as const

/**
 * Open the Agents app: its activity-bar entry opens the agents directory, and
 * the sidebar (one row per agent since P4c-T33) is what every caller waits on.
 */
export async function openAgentApp(page: Page): Promise<void> {
  await page.getByTestId("activity-agents").click(NAV_CLICK)
  await page.getByTestId("agent-sidebar").waitFor({ state: "visible", timeout: NAV_TIMEOUT })
}

/**
 * The skills and routines surfaces have no sidebar nav any more: they are
 * reached by their own URLs, which stay registered until P4c-T39 moves them
 * onto the agent page.
 */
async function openAgentUrl(page: Page, path: string, testId: string): Promise<void> {
  // Navigates right away, even while the previous load's session refresh is in
  // flight: the refresh is sent keepalive, so the navigation cannot drop its
  // rotated cookie (it used to, and the page ended on /login).
  await page.goto(new URL(path, page.url()).toString())
  await page.getByTestId(testId).waitFor({ state: "visible", timeout: NAV_TIMEOUT })
}

export async function openAgentSkills(page: Page): Promise<void> {
  await openAgentUrl(page, "/agent/skills", "skills-list")
}

export async function openAgentRoutines(page: Page): Promise<void> {
  await openAgentUrl(page, "/agent/routines", "routines-list")
}

/** The agent page's own tabs (`/agents/:handle/<tab>`). */
export type AgentPageTab =
  | "overview"
  | "skills"
  | "routines"
  | "memory"
  | "knowledge"
  | "activity"
  | "settings"

/**
 * The workspace tab the user is looking at.
 *
 * Every open tab stays MOUNTED in the tab content area, so a page-wide
 * `getByTestId` sees the surfaces behind the one on screen too and a scenario
 * that opened two agent pages fails strict mode on its first query. Assertions
 * about "the page I am on" go through this.
 */
export function activeTabScope(page: Page): Locator {
  return page.locator('[data-testid="tab-content-area"] > [data-tab-active="true"]')
}

/** One agent row in the sidebar -> that agent's page, on the tab named. */
async function openAgentRowTab(page: Page, row: Locator, tab: AgentPageTab): Promise<void> {
  await row.click(NAV_CLICK)
  // Scoped to the ACTIVE tab, not the page: a scenario that visits two agents
  // leaves both pages mounted in the tab content area, and a page-wide query
  // for `agent-profile` then resolves to two elements and fails strict mode.
  const activeTab = activeTabScope(page)
  await activeTab.getByTestId("agent-profile").waitFor({ state: "visible", timeout: NAV_TIMEOUT })
  // `data-agent-tab` is the one spelling every tab button carries; the testid
  // is not (Memory's is `agent-profile-tab-memory`).
  await activeTab.locator(`[data-agent-tab="${tab}"]`).click(NAV_CLICK)
}

/**
 * THE VIEWER'S OWN AGENT PAGE, on the tab named.
 *
 * P4c-T39 retired the flat `/agent/skills` and `/agent/routines` screens: every
 * artifact is a TAB of an agent's page now (`/agents/:handle/skills`), because
 * the flat screens named no agent. `openAgentSkills` above still points at the
 * old URL and is left alone for the scenarios that have not moved yet; this is
 * the way there for the ones that have.
 *
 * Navigated the way a person does — the Agents entry, then the row marked as
 * the viewer's own (`[data-agent-mine]`) — rather than by composing a URL from
 * a handle the test would have to look up.
 */
export async function openOwnAgentTab(page: Page, tab: AgentPageTab): Promise<void> {
  await openAgentApp(page)
  await openAgentRowTab(page, page.locator("[data-agent-mine]").first(), tab)
}

/**
 * ANOTHER agent's page, named by its handle, on the tab named.
 *
 * The same gesture as `openOwnAgentTab` for an agent that is NOT the viewer's:
 * a role agent owns the org's shared skills and routines, so "what does an
 * ordinary member see on a shared artifact" is a question asked on that
 * agent's page, not on the viewer's own (P4c FX-C4). The handle is the
 * sidebar's own row key (`agent-sidebar-row-@support-desk`), so a row the
 * directory does not return to this viewer fails here rather than silently
 * landing somewhere else.
 */
export async function openAgentTabByHandle(
  page: Page,
  handle: string,
  tab: AgentPageTab,
): Promise<void> {
  await openAgentApp(page)
  await openAgentRowTab(page, page.getByTestId(`agent-sidebar-row-${handle}`), tab)
}

/**
 * THE AGENT CONVERSATION, since P4c-T17 retired the panel.
 *
 * There is one conversation with the personal agent and one surface for it.
 * `mod+.` (togglePersonalAgentChat, personal-dm-store) resolves that DM and
 * brings it up: as a thread tab off a Home surface, as an expanded dock tab
 * anywhere else. Either way the active tab holds a ThreadView and its
 * ComposeBar, so the returned locator scopes assertions the way
 * `getByTestId("agent-panel")` used to.
 *
 * Idempotent: a conversation already in front of the user is reused rather
 * than toggled away.
 */
export async function openAgentConversation(page: Page): Promise<Locator> {
  // Two shapes, one gesture: on a Home surface the DM is the active main-panel
  // tab, anywhere else it is an expanded dock tab (which lives OUTSIDE the
  // `[data-tab-active]` wrappers, floating over the main panel cell). Matching
  // both keeps this the single way a scenario reaches the conversation, on
  // whichever surface it happens to be standing.
  const conversation = page
    .locator('[data-tab-active="true"], [data-dock-tab][data-expanded="true"]')
    .filter({ has: page.getByTestId("compose-editor") })
    .first()
  // Retried, not pressed once (P4c-T21b): the shortcut only lands after the
  // shell has bound its keymap, and on a cold worker the Vite compile of the
  // conversation chunk can push that past the first press — which then toggles
  // nothing and the wait burns its whole budget on a shell that never got the
  // gesture. Three presses with a short budget each beat one long wait, and a
  // conversation already in front of the user is still never toggled away.
  //
  // The shortcut is a TOGGLE: on a dock surface it puts the personal agent's
  // window away when that window is already open. After a reload the dock
  // restores an expanded window from its saved state, and its conversation
  // chunk can still be loading when the first check runs, so a press then
  // folds the window the reload just restored (it stays "visible" through the
  // fold, and the scenario then acts on a closing window). So: wait for the
  // shell to bind its keymap, and press only while no dock window is open.
  const openDockWindow = page.locator('[data-dock-tab][data-expanded="true"]')
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await conversation.isVisible().catch(() => false)) break
    await page
      .locator("[data-shell][data-shell-ready='true']")
      .waitFor({ state: "attached", timeout: NAV_TIMEOUT })
    const restored = (await readDockState(page))?.tabs.some((t) => t.expanded) ?? false
    if (restored || (await openDockWindow.count()) > 0) {
      await conversation.waitFor({ state: "visible", timeout: NAV_TIMEOUT })
      break
    }
    await page.keyboard.press("ControlOrMeta+Period")
    const appeared = await conversation
      .waitFor({ state: "visible", timeout: NAV_TIMEOUT / 3 })
      .then(() => true)
      .catch(() => false)
    if (appeared) break
  }
  await conversation.waitFor({ state: "visible", timeout: NAV_TIMEOUT })
  await conversation
    .getByTestId("compose-editor")
    .waitFor({ state: "visible", timeout: NAV_TIMEOUT })
  return conversation
}

/** The dock's persisted state (`liaison.dock.v1`), as the browser holds it.
 *  The dock animates open and a tab never reaches zero size, so this is what a
 *  scenario asserts restoration against; the DOM says what is on screen. */
export interface PersistedDockState {
  tabs: Array<{ threadId: string; expanded: boolean }>
  activeThreadId: string | null
  chatsOpen: boolean
}

export async function readDockState(page: Page): Promise<PersistedDockState | null> {
  return page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem("liaison.dock.v1") ?? "null") as {
        tabs: Array<{ threadId: string; expanded: boolean }>
        activeThreadId: string | null
        chatsOpen: boolean
      } | null
    } catch {
      return null
    }
  })
}

/** A spot inside `target`, relative to its box, where a real pointer reaches
 *  the element itself, or null when something covers all of it. The chat
 *  dock's open window may partly cover a main-panel composer (intended: the
 *  layout never moves for it), so a person clicks the part they can see. */
async function uncoveredSpot(target: Locator): Promise<{ x: number; y: number } | null> {
  return target.evaluate((el) => {
    const r = el.getBoundingClientRect()
    for (const fy of [0.5, 0.25, 0.75]) {
      for (const fx of [0.5, 0.25, 0.1, 0.75, 0.9]) {
        const hit = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy)
        if (hit && el.contains(hit)) return { x: r.width * fx, y: r.height * fy }
      }
    }
    return null
  })
}

/** Type one message into a conversation surface (dock tab or main-panel tab)
 *  and send it, exactly as a person does: click the composer where it can be
 *  seen, type, Enter. */
export async function sendInConversation(
  page: Page,
  conversation: Locator,
  text: string,
): Promise<void> {
  const editor = conversation.getByTestId("compose-editor")
  await editor.waitFor({ state: "visible", timeout: NAV_TIMEOUT })
  const spot = await uncoveredSpot(editor)
  if (!spot) throw new Error("The composer is fully covered: nothing a person could click")
  await editor.click({ ...NAV_CLICK, position: spot })
  await page.keyboard.type(text)
  await page.keyboard.press("Enter")
}

/**
 * Opens every collapsed roll-up of consecutive app reads in `scope`, so each
 * call's own row (`data-tool-name`) is on screen. A roll-up already open is left
 * open: its toggle would close it.
 */
export async function expandToolRollups(scope: Locator): Promise<void> {
  const rollups = scope.getByTestId("tool-rollup")
  const n = await rollups.count()
  for (let i = 0; i < n; i++) {
    const rollup = rollups.nth(i)
    if ((await rollup.getByTestId("tool-call-row").count()) > 0) continue
    await rollup.getByTestId("tool-rollup-toggle").click()
    await rollup.getByTestId("tool-call-row").first().waitFor({ state: "visible" })
  }
}
