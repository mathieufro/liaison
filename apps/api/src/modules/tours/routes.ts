// SPDX-License-Identifier: FSL-1.1-ALv2
//
// /api/tours: the guided tour catalogue and the caller's own progress
// (packages/shared/src/tours/api.ts is the wire contract). Every read and write
// runs under the caller's RLS context: kernel.tour_progress lets a person reach
// only their own rows in their own org.
//
//   GET   /api/tours               tours for the org's installed apps and the caller's scopes
//   POST  /api/tours/:id/start     start or restart the tour (first effective beat)
//   PATCH /api/tours/:id           pause/resume/abandon, Next, Skip, go back (CAS on fromBeatId)
//   GET   /api/tours/:id/progress  the caller's progress, or null

import {
  type ListToursResponse,
  StartTourRequestSchema,
  scenarioNeedOf,
  type Tour,
  type TourListItem,
  type TourProgressResponse,
  UpdateTourRequestSchema,
} from "@liaison/shared"
import type { Context } from "hono"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import type { AppEnv } from "~/app"
import { withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { isVisitorDemoOrgId } from "~/modules/demo/demo-org"
import { prepareDemoScenario } from "~/modules/demo/demo-seeder"
import { withBeatStatus } from "~/modules/tours/beat-status"
import { reconcileCurrentBeat } from "~/modules/tours/consumer"
import { runConversationId } from "~/modules/tours/conversation"
import {
  availableTours,
  findServerTour,
  isPlayedSingleRun,
  listProgressRows,
  loadTourOrgContext,
  progressOf,
  readProgressRow,
  serverTourCatalogue,
  startTour,
  type TourMoveRefusal,
  TourPlayedError,
  TourWorldBeatRefusedError,
  tourBeats,
  updateTour,
} from "~/modules/tours/service"

const REFUSAL_MESSAGES: Record<TourMoveRefusal, string> = {
  tour_not_active: "The tour is not active",
  tour_finished: "The tour is finished; start it again",
  tour_event_beat: "This step moves on when it happens, not on Next",
  tour_forward_move: "A tour only goes back to an earlier step",
  tour_empty: "The tour has no steps in this workspace",
}

/** The tour, when it exists and this caller may be offered it; 404 otherwise. */
async function resolveTour(c: Context<AppEnv>): Promise<{
  tour: Tour
  ctx: Awaited<ReturnType<typeof loadTourOrgContext>>
}> {
  const tour = findServerTour(c.req.param("id") ?? "")
  const ctx = await loadTourOrgContext(c.get("orgId"))
  if (
    !tour ||
    availableTours([tour], {
      installedApps: ctx.installedApps,
      scopes: c.get("scopes") ?? [],
      // A demo scenario (demoOnly) exists only in a demo org: elsewhere it is not found.
      isDemo: ctx.isDemo,
      worldId: ctx.worldId,
    }).length === 0
  ) {
    throw new HTTPException(404, { message: "Tour not found" })
  }
  return { tour, ctx }
}

export const tourRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    const ctx = await loadTourOrgContext(orgId)
    const tours = availableTours(serverTourCatalogue(), {
      installedApps: ctx.installedApps,
      scopes: c.get("scopes") ?? [],
      isDemo: ctx.isDemo,
      worldId: ctx.worldId,
    })
    const rows = await withRequestRls(c, (tx) => listProgressRows(tx, { orgId, userId }))
    const byTour = new Map(rows.map((r) => [r.tourId, r]))
    const items: TourListItem[] = await Promise.all(
      tours.map(async (tour) => {
        const beats = tourBeats(tour, ctx)
        const row = byTour.get(tour.id)
        return {
          tourId: tour.id,
          app: tour.app,
          title: tour.title,
          summary: tour.summary,
          beatCount: beats.length,
          ...(tour.singleRun ? { singleRun: true as const } : {}),
          // An active run carries its step's status (only active runs compute one).
          progress: row
            ? await withBeatStatus(orgId, userId, progressOf(tour, row, beats), beats)
            : null,
        }
      }),
    )
    const body: ListToursResponse = { tours: items }
    return success(c, body)
  })
  .post("/:id/start", zValidator("json", StartTourRequestSchema), async (c) => {
    const { tour, ctx } = await resolveTour(c)
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    // A played single-run scenario (a stale tab's start or Next) changes
    // nothing: refused before its scenario brings anything in.
    const played = (tourId: string) =>
      c.json({ error: { message: new TourPlayedError(tourId).message, code: "tour_played" } }, 409)
    if (
      tour.singleRun &&
      isPlayedSingleRun(
        tour,
        await withRequestRls(c, (tx) => readProgressRow(tx, { orgId, userId, tourId: tour.id })),
      )
    ) {
      return played(tour.id)
    }
    // A visitor's scenario brings its own seeded approvals in as it starts:
    // the workspace opened with none waiting.
    const need = tour.demoOnly ? scenarioNeedOf(tour.id) : null
    // What it brings is its own world's, never another world's.
    if (need && (await isVisitorDemoOrgId(orgId))) {
      await prepareDemoScenario(orgId, userId, need, tour.world ?? ctx.worldId)
    }
    // A tour that asks the agent does so in the person's DM with it.
    const conversationId = await runConversationId(orgId, userId, tour)
    const beats = tourBeats(tour, ctx)
    let started: Awaited<ReturnType<typeof startTour>>
    try {
      started = await withRequestRls(c, (tx) =>
        startTour(tx, {
          orgId,
          userId,
          tour,
          beats,
          source: c.req.valid("json").source ?? "help",
          actor: { userId, actorType: "user" },
          conversationId,
        }),
      )
    } catch (err) {
      if (err instanceof TourPlayedError) return played(tour.id)
      throw err
    }
    const body: TourProgressResponse = {
      progress: await withBeatStatus(orgId, userId, started, beats),
    }
    return success(c, body)
  })
  .patch("/:id", zValidator("json", UpdateTourRequestSchema), async (c) => {
    const { tour, ctx } = await resolveTour(c)
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    const beats = tourBeats(tour, ctx)
    let outcome: Awaited<ReturnType<typeof updateTour>>
    try {
      outcome = await withRequestRls(c, (tx) =>
        updateTour(tx, {
          orgId,
          userId,
          tour,
          beats,
          request: c.req.valid("json"),
          actor: { userId, actorType: "user" },
        }),
      )
    } catch (err) {
      if (err instanceof TourWorldBeatRefusedError) {
        throw new HTTPException(403, { message: err.message })
      }
      throw err
    }
    switch (outcome.kind) {
      case "ok": {
        const progress = await reconcileCurrentBeat(
          { orgId, userId, tour, beats },
          outcome.progress,
        )
        const body: TourProgressResponse = {
          progress: await withBeatStatus(orgId, userId, progress, beats),
        }
        return success(c, body)
      }
      case "not_found":
        throw new HTTPException(404, { message: "Tour not started" })
      case "conflict": {
        // The fresh progress rides along so the client re-renders without a second read.
        const data: TourProgressResponse = {
          progress: await withBeatStatus(orgId, userId, outcome.progress, beats),
        }
        return c.json(
          { error: { message: "The tour moved on meanwhile", code: "tour_beat_moved" }, data },
          409,
        )
      }
      case "refused":
        return c.json(
          { error: { message: REFUSAL_MESSAGES[outcome.code], code: outcome.code } },
          409,
        )
    }
  })
  .get("/:id/progress", async (c) => {
    const { tour, ctx } = await resolveTour(c)
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    const row = await withRequestRls(c, (tx) =>
      readProgressRow(tx, { orgId, userId, tourId: tour.id }),
    )
    const beats = tourBeats(tour, ctx)
    // A reload or a deploy may have missed the step's event: it is looked for
    // among the events that already happened before the step's status is read.
    const progress = row
      ? await reconcileCurrentBeat({ orgId, userId, tour, beats }, progressOf(tour, row, beats))
      : null
    const body: TourProgressResponse = {
      progress: progress ? await withBeatStatus(orgId, userId, progress, beats) : null,
    }
    return success(c, body)
  })
