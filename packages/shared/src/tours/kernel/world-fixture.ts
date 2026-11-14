// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Test fixture (not in the shipped catalogue): a scenario that belongs to the
 * software world, so the routes and the registry are tested against a tour no
 * other world may be offered. Built from the support builder, so it never
 * drifts from the shape a world's real scenario has.
 */
import { buildSupportTour } from "../demo/support"
import type { Tour } from "../schema"

export const kernelWorldFixtureTour: Tour = {
  ...buildSupportTour({ world: "saas" }),
  id: "kernel.world-fixture",
}
