// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * GET /api/v1/slots/:slot — enumerate panels contributed to the named slot
 * for the calling org, filtered by the caller's scopes. `?for_tool=<app>:<tool>` names the tool
 * an approval card is about, for panels contributed to one tool's card.
 *
 * Phase 17, Task B9. The web shell calls this from `SlotPanels.tsx` to
 * decide which panels to mount on a slot host page (e.g. contact_detail).
 */
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { success } from "~/lib/response"
import { primeOrgApps } from "~/modules/apps/org-apps"
import { listSlotPanels } from "./registry"

export const slotsRoutes = new Hono<AppEnv>()

slotsRoutes.get("/:slot", async (c) => {
  const slot = c.req.param("slot")
  const orgId = c.get("orgId")
  await primeOrgApps(orgId)
  const scopes = c.get("scopes") as string[]
  const forTool = c.req.query("for_tool") || undefined
  const panels = listSlotPanels({ orgId, scopes, slot, userId: c.get("userId"), forTool })
  return success(c, { panels })
})
