// SPDX-License-Identifier: FSL-1.1-ALv2
import { isPublicDemoInstance } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, loadDemoMarker } from "~/modules/demo/demo-org"
import { purgeOrg } from "~/modules/org/purge/purge-org"
import { findOrgIdBySlug } from "~/seed/factories/org/org"

/**
 * Delete the demo org under `slug`, when there is one, so a seed starts it
 * fresh on a private box. Refused for an org without the demo marker (a real
 * workspace never goes this way) and on a public demo box (`isPublicDemoInstance`), where demo orgs belong to
 * visitors and the reaper (there, a content reset keeps the org instead).
 */
export async function replaceSeededDemoOrg(
  slug: string,
  log: (msg: string) => void,
  opts: { who: string; tier: string },
): Promise<boolean> {
  const orgId = await findOrgIdBySlug(slug)
  if (!orgId) return false
  if (isPublicDemoInstance()) {
    throw new Error(
      `${opts.who}: refusing to replace '${slug}' on a public demo box: its demo orgs belong to visitors.`,
    )
  }
  const guard = async (id: string) => {
    await invalidateDemoMarker(id)
    if (!(await loadDemoMarker(id))) {
      throw new Error(
        `${opts.who}: refusing to replace '${slug}': it is not a demo org, and replacing deletes it.`,
      )
    }
  }
  await guard(orgId)
  const { deleted } = await purgeOrg(orgId, {
    reason: `seed-${opts.tier}-replace`,
    assertAllowed: guard,
    settle: false,
    // As the demo reaper does: the marker check above bumps a Redis key of the
    // org that a residue scan would count, and a re-run is the retry.
    verify: false,
    regenerateTriggers: false,
  })
  const rows = Object.values(deleted).reduce((n, v) => n + v, 0)
  log(`${opts.tier}: replaced the earlier org '${slug}' (${rows} rows deleted)`)
  return true
}
