// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The `products` world's pack: Resonant Audio Labs, read from the files it was
 * always seeded from. Nothing here is a copy: every value is today's constant,
 * so a seed through this pack writes exactly what the demo tier always wrote.
 */
import { PRODUCTS_AGENT_NATIVE_SPECS } from "~/seed/tiers/demo/seed-agent-native"
import { PRODUCTS_SUPPORT_WORLD } from "~/seed/tiers/demo/seed-support"
import {
  DEMO_DESK_TEAMS,
  DEMO_EMAIL_DOMAIN,
  DEMO_FIXED_CUSTOMER,
  DEMO_FIXED_ORDER,
  DEMO_QUOTE_DEALER,
  DEMO_ROLE_AGENTS,
  DEMO_WORLD,
  type DemoPerson,
  type DemoRole,
} from "~/seed/world/fiction"
import type { DemoWorldPack } from "../index"

/** The staff grouped by role, in team order. */
function personas(): DemoWorldPack["personas"] {
  const out: Partial<Record<DemoRole, DemoPerson[]>> = {}
  for (const person of DEMO_WORLD.team) out[person.role] = [...(out[person.role] ?? []), person]
  return out
}

export const PRODUCTS_WORLD_PACK: DemoWorldPack = {
  id: "products",
  world: DEMO_WORLD,
  orgName: DEMO_WORLD.company.legalName,
  emailDomain: DEMO_EMAIL_DOMAIN,
  roleAgents: DEMO_ROLE_AGENTS,
  deskTeams: DEMO_DESK_TEAMS,
  supportSpecs: PRODUCTS_SUPPORT_WORLD.support,
  knowledgeSpecs: PRODUCTS_SUPPORT_WORLD.knowledge,
  threadSpecs: PRODUCTS_SUPPORT_WORLD.threads,
  agentNative: PRODUCTS_AGENT_NATIVE_SPECS,
  people: DEMO_WORLD.team,
  personas: personas(),
  namedRows: {
    company: DEMO_WORLD.company,
    fixedCustomer: DEMO_FIXED_CUSTOMER,
    fixedOrder: DEMO_FIXED_ORDER,
    quoteDealer: DEMO_QUOTE_DEALER,
  },
}
