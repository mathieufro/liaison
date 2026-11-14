// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The stand-in's one QA route: write outside objects for a demo org, so a mock
// world can make an outside fact (a renewal, a failed payment, a cancellation
// made "in the dashboard") readable by id BEFORE it posts the signed event to
// the app's real webhook route.
//
//   POST /api/demo-payments/outside   { orgId, objects: [ {id, object, ...}, ... ] }
//
// Signed with the box's LOAD_HARNESS_KEY (lib/load-harness.ts). It answers the
// same 404 as a route that does not exist unless LIAISON_DEMO_PAYMENTS_FIXTURES
// is set on this box, the request carries a valid signature, and the org holds
// the demo marker, so a scanner never learns it is there and no real org can
// be written to. The objects are checked (kinds, size, no key-shaped string)
// before anything is stored.
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { env } from "~/lib/env"
import { verifyHarnessContext } from "~/lib/load-harness"
import { rootLogger } from "~/lib/logger"
import { success } from "~/lib/response"
import { loadDemoOrg } from "~/modules/demo/demo-org"
import { OutsideStateError, putOutsideObjects } from "./overlay"

const log = rootLogger.child({ module: "demo-payments-standin" })

/** Most objects one request writes. */
export const OUTSIDE_WRITE_MAX = 50

const bodySchema = z
  .object({
    orgId: z.string().uuid(),
    objects: z.array(z.record(z.string(), z.unknown())).min(1).max(OUTSIDE_WRITE_MAX),
  })
  .strict()

const notFound = () => new HTTPException(404, { message: "Not found" })

export const demoPaymentsHarnessRoutes = new Hono<AppEnv>().post("/outside", async (c) => {
  if (!env.LIAISON_DEMO_PAYMENTS_FIXTURES) throw notFound()
  const harness = await verifyHarnessContext(c)
  if (harness.kind !== "valid") {
    if (harness.kind === "refused")
      log.warn({ reason: harness.reason }, "stand-in QA write with a refused signature")
    throw notFound()
  }
  let raw: unknown
  try {
    raw = JSON.parse(await c.req.text())
  } catch {
    throw notFound()
  }
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) throw notFound()
  const { orgId, objects } = parsed.data
  const { marker } = await loadDemoOrg(orgId)
  if (!marker) throw notFound()
  try {
    await putOutsideObjects(orgId, objects)
  } catch (err) {
    if (err instanceof OutsideStateError) {
      return c.json({ error: { message: err.message, code: "outside_object_refused" } }, 400)
    }
    throw err
  }
  return success(c, { orgId, written: objects.map((o) => String(o.id)) })
})
