// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The `saas` world's agent native layer: the owner's personal agent, the
// three desks (`fiction.ts`) and the three routines the company runs, read
// from the product's own templates so their text is the product's, not the
// pack's. The routines are seeded on, by the pack's layer, inside the seed
// (`runAsSeed`), so no event the seed queues ever ticks one.
import type { DemoAgentNativeSpecs } from "~/seed/tiers/demo/seed-agent-native"
import { SAAS_CHANNEL_TITLES } from "./threads-specs"

/** A routine the company runs, instantiated from a product template. */
export interface SaasRoutineSpec {
  /** The name the routines list shows. */
  name: string
  /** The template it is read from: an app's, or the kernel's. */
  template: { appName: string; templateKey: string }
  /** Its cron, in the org's time zone (Paris). */
  cron: string
  /** The person it runs as: `owner` for the workspace's owner. */
  ownerKey: string
  /** The desk it is attributed to; `personal` for the owner's own agent. */
  ownerHandle: string
}

export const SAAS_ROUTINES: readonly SaasRoutineSpec[] = [
  {
    name: "Deal follow-ups",
    template: { appName: "kernel", templateKey: "deal-followups" },
    cron: "0 8 * * 1-5",
    ownerKey: "owner",
    ownerHandle: "@sales",
  },
  {
    name: "Failed payments",
    template: { appName: "stripe", templateKey: "failed-payments" },
    cron: "0 7 * * *",
    ownerKey: "sara",
    ownerHandle: "@finance",
  },
  {
    name: "Morning brief",
    template: { appName: "kernel", templateKey: "morning-brief" },
    cron: "30 7 * * 1-5",
    ownerKey: "owner",
    ownerHandle: "personal",
  },
]

export const SAAS_AGENT_NATIVE_SPECS: DemoAgentNativeSpecs = {
  skills: [],
  routines: [],
  subAgents: [],
  memory: [],
  episodes: [],
  knowledgePointers: [],
  activity: [],
  ownerAgentPurpose:
    "Keeps the owner's day in order: what needs a decision, what is waiting on " +
    "somebody else and what can wait.",
  ownerAgentChannelTitles: [SAAS_CHANNEL_TITLES.pipeline, SAAS_CHANNEL_TITLES.handover],
  scenarioRoutines: false,
  layerRoutineNames: SAAS_ROUTINES.map((r) => r.name),
}
