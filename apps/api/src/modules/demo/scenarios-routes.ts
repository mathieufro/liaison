// SPDX-License-Identifier: FSL-1.1-ALv2
//
// /api/demo/scenarios: a demo visitor's guided scenarios, one per need they
// picked, in pick order, and the retry of a scenario's world beat.
//
//   GET  /api/demo/scenarios                 [{need, tourId, status, beatIndex, beatCount}]
//   POST /api/demo/scenarios/:tourId/retry   re-run the caller's current world beat
//   GET  /api/demo/scenarios/welcome         {choice}: the welcome popup's recorded answer
//   POST /api/demo/scenarios/welcome         {choice: browse|start}: record it
//
// Mounted under the demo routes, so it exists only in demo mode. Every route
// needs the visitor's session (and refuses an expired workspace, like every
// authenticated route of a demo box), and answers 404 outside a VISITOR demo
// org: a regular org and the reserved review org alike. Progress is the tour engine's own
// (kernel.tour_progress, read under the caller's RLS). The welcome popup's
// answer rides on the org's demo marker, like the picks: one visitor owns a
// visitor org, so the popup opens by itself only until they have answered it.
import {
  DEMO_WORLD_NEEDS,
  type DemoNeed,
  type DemoWelcomeState,
  demoNeedsSchema,
  demoScenarioTourId,
  demoWelcomeChoiceSchema,
  demoWorldIdOf,
  type TourStatus,
} from "@liaison/shared"
import { Hono } from "hono"
import { every } from "hono/combine"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { env } from "~/lib/env"
import { withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { authMiddleware } from "~/middleware/auth"
import { demoExpiryMiddleware } from "~/modules/demo/demo-expiry"
import { isDemoModeEnabled } from "~/modules/demo/demo-mode"
import {
  demoWelcomeChoiceOf,
  loadDemoMarker,
  recordDemoWelcomeChoice,
} from "~/modules/demo/demo-org"
import { runWorldBeatOnce, type WorldBeatOutcome } from "~/modules/demo/world/registry"
import {
  findServerTour,
  listProgressRows,
  loadTourOrgContext,
  progressOf,
  readProgressRow,
  tourBeats,
} from "~/modules/tours/service"

/** One scenario in the visitor's queue. `new` = never started. */
export interface DemoScenarioItem {
  need: DemoNeed
  tourId: string
  status: TourStatus | "new"
  beatIndex: number
  beatCount: number
  /** Played once: the visitor starts it over with the workspace, never again on its own. */
  singleRun?: true
}

export interface DemoScenarioRetryResponse {
  outcome: WorldBeatOutcome
}

/**
 * The needs the visitor picked, in pick order, from the org's demo marker (a
 * UI hint the signup copies there; nothing security-relevant reads it). An
 * org without picks gets every need, as "Everything" would.
 */
export function pickedNeeds(marker: Record<string, unknown> | null): DemoNeed[] {
  const parsed = demoNeedsSchema.safeParse(marker?.needs)
  return parsed.success ? parsed.data : [...DEMO_WORLD_NEEDS[demoWorldIdOf(marker?.worldId)]]
}

/** The session org's visitor marker, else 404 (a regular org, the reserved org). */
async function visitorMarkerOr404(orgId: string) {
  if (!isDemoModeEnabled()) throw new HTTPException(404, { message: "Not found" })
  const marker = await loadDemoMarker(orgId)
  if (marker?.variant !== "visitor") throw new HTTPException(404, { message: "Not found" })
  return marker
}

const welcomeBodySchema = z.strictObject({ choice: demoWelcomeChoiceSchema })

export const demoScenariosRoutes = new Hono<AppEnv>()
  .use("*", every(authMiddleware(env.JWT_SECRET), demoExpiryMiddleware()))
  .get("/", async (c) => {
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    const marker = await visitorMarkerOr404(orgId)
    const ctx = await loadTourOrgContext(orgId)
    const rows = await withRequestRls(c, (tx) => listProgressRows(tx, { orgId, userId }))
    const byTour = new Map(rows.map((r) => [r.tourId, r]))
    const items: DemoScenarioItem[] = []
    for (const need of pickedNeeds(marker)) {
      // The scenario of the need in the org's own world.
      const tourId = demoScenarioTourId(demoWorldIdOf(marker.worldId), need)
      const tour = findServerTour(tourId)
      if (!tour) continue
      const beats = tourBeats(tour, ctx)
      const row = byTour.get(tourId)
      const progress = row ? progressOf(tour, row, beats) : null
      items.push({
        need,
        tourId,
        status: progress?.status ?? "new",
        beatIndex: progress?.beatIndex ?? 0,
        beatCount: beats.length,
        ...(tour.singleRun ? { singleRun: true as const } : {}),
      })
    }
    return success(c, items)
  })
  .get("/welcome", async (c) => {
    const marker = await visitorMarkerOr404(c.get("orgId"))
    const body: DemoWelcomeState = { choice: demoWelcomeChoiceOf(marker) }
    return success(c, body)
  })
  .post("/welcome", zValidator("json", welcomeBodySchema), async (c) => {
    const orgId = c.get("orgId")
    await visitorMarkerOr404(orgId)
    const { choice } = c.req.valid("json")
    await recordDemoWelcomeChoice(orgId, choice)
    const body: DemoWelcomeState = { choice }
    return success(c, body)
  })
  .post("/:tourId/retry", async (c) => {
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    await visitorMarkerOr404(orgId)
    const tourId = c.req.param("tourId")
    const tour = findServerTour(tourId)
    if (!tour?.demoOnly) throw new HTTPException(404, { message: "Scenario not found" })
    // The caller's own row (RLS): only its owner retries a scenario's world beat.
    const row = await withRequestRls(c, (tx) => readProgressRow(tx, { orgId, userId, tourId }))
    if (!row) throw new HTTPException(404, { message: "Scenario not started" })
    const outcome = await runWorldBeatOnce(orgId, userId, tourId)
    const body: DemoScenarioRetryResponse = { outcome }
    return success(c, body)
  })
