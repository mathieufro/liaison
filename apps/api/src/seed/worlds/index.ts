// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The seed packs of the demo worlds (`DEMO_WORLDS` in `@liaison/shared`): each
 * world's company, people, desks and the specs every shared layer writes for
 * it. `seedDemoWorld` reads one pack and runs the same layers for every world:
 *
 *   org (the pack's people, role agents, desk teams and mail domain)
 *   -> support (the pack's support, knowledge and thread specs)
 *   -> the world's own layer: `products` its commerce and warehouse, any
 *      other world `pack.layer`
 *   -> agent native (the pack's)
 *   -> accounts
 *
 * `products` is built from the files it always had (`seed/world/fiction.ts`,
 * `seed/tiers/demo/support-specs.ts`, `sales-specs.ts`); nothing of it moved.
 * A world with no pack registered here cannot be seeded yet.
 */
import { DEMO_WORLDS, type DemoWorldId } from "@liaison/shared"
import type { DemoSeedPlan } from "~/seed/tiers/demo/demo-apps"
import type { DemoAgentNativeSpecs } from "~/seed/tiers/demo/seed-agent-native"
import type { DemoDeskTeams, SeedDemoOrgResult } from "~/seed/tiers/demo/seed-org"
import type {
  DemoKnowledgeSpecs,
  DemoSupportSpecs,
  DemoThreadSpecs,
} from "~/seed/tiers/demo/seed-support"
import type { DemoPerson, DemoRole, DemoRoleAgent, DemoWorld } from "~/seed/world/fiction"
import { PRODUCTS_WORLD_PACK } from "./products"
import { SAAS_WORLD_PACK } from "./saas"
import { STUDIO_WORLD_PACK } from "./studio"

/** What a world's own layer is handed: the org the shared layers seeded, at the seed's base time. */
export interface DemoWorldLayerInput {
  org: SeedDemoOrgResult
  baseTime: Date
  plan: DemoSeedPlan
  log: (msg: string) => void
}

export interface DemoWorldPack {
  id: DemoWorldId
  /** The company, its team and its customers, in the shape `seedDemoOrg` takes. */
  world: DemoWorld
  /** The workspace's display name when the caller names none. */
  orgName: string
  /** The reserved `.example` domain the people live under, one label per org below it. */
  emailDomain: string
  roleAgents: readonly DemoRoleAgent[]
  deskTeams: DemoDeskTeams
  supportSpecs: DemoSupportSpecs
  knowledgeSpecs: DemoKnowledgeSpecs
  threadSpecs: DemoThreadSpecs
  agentNative: DemoAgentNativeSpecs
  /**
   * The world's own rows after support (payments, schedules, companies and
   * deals, client work). Absent: the world seeds its org, support and agent
   * native layers only. `products` has none: its commerce and warehouse
   * layers run as they always have.
   */
  layer?: (input: DemoWorldLayerInput) => Promise<void>
  /** The fictional staff, for an activity plan built on the world (`seed-lively`). */
  people: readonly DemoPerson[]
  /** The staff by role: what a driver outside the seed acts as. Read only. */
  personas: Readonly<Partial<Record<DemoRole, readonly DemoPerson[]>>>
  /** Rows a test or a driver names by key, with their exact values. Read only. */
  namedRows: Readonly<Record<string, unknown>>
}

const PACKS: Readonly<Partial<Record<DemoWorldId, DemoWorldPack>>> = {
  products: PRODUCTS_WORLD_PACK,
  saas: SAAS_WORLD_PACK,
  studio: STUDIO_WORLD_PACK,
}

/** The worlds with a seed pack, in `DEMO_WORLDS` order. */
export function seedableDemoWorlds(): DemoWorldId[] {
  return DEMO_WORLDS.filter((id) => PACKS[id] !== undefined)
}

/** The world's pack, or null when the world has none yet. */
export function findDemoWorldPack(id: DemoWorldId): DemoWorldPack | null {
  return PACKS[id] ?? null
}

/** The world's pack. Throws, naming the world, when it has none. */
export function demoWorldPack(id: DemoWorldId): DemoWorldPack {
  const pack = findDemoWorldPack(id)
  if (!pack) throw new Error(`demo seed: the '${id}' world has no seed pack yet`)
  return pack
}
