// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The `studio` world's pack: Halden Studio, a software services firm billing
 * by the day, on a retainer and at fixed prices. Its company, team, clients,
 * the plan for time and budgets, and the layer that writes it (`layer.ts`).
 * The pack is registered in `PACKS`, so the CLI seeds it; the door never offers
 * the world while it has no door tours (`enabledDemoWorlds`).
 *
 * This layer of the world holds people, roles, companies, the pipeline, the
 * projects with their time and budgets, and who is away. Its desks, support
 * backlog, knowledge, threads and routines are not seeded yet: the specs below
 * are empty on purpose.
 *
 * A driver outside the seed reads `personas` and `namedRows`, never copies.
 */
import type { DemoPerson, DemoRole } from "~/seed/world/fiction"
import type { DemoWorldPack } from "../index"
import {
  STUDIO_AWAY,
  STUDIO_CLIENTS,
  STUDIO_COMPANY,
  STUDIO_DELIVERY_KEYS,
  STUDIO_EMAIL_DOMAIN,
  STUDIO_TEAM,
  STUDIO_WORLD,
} from "./fiction"
import { STUDIO_PIPELINE_KEY, seedStudioLayer } from "./layer"
import { STUDIO_COST_RATES, STUDIO_DATED_LINES, studioPlan } from "./plan"

function personas(): DemoWorldPack["personas"] {
  const out: Partial<Record<DemoRole, DemoPerson[]>> = {}
  for (const person of STUDIO_TEAM) out[person.role] = [...(out[person.role] ?? []), person]
  return out
}

/** The ticket teams each role works. */
const STUDIO_DESK_TEAMS: DemoWorldPack["deskTeams"] = {
  ops_lead: ["support", "sales"],
  support: ["support"],
  fulfillment: ["support"],
  engineering: ["support"],
  finance: ["finance"],
  sales: ["sales"],
}

export const STUDIO_WORLD_PACK: DemoWorldPack & { plan: typeof studioPlan } = {
  id: "studio",
  world: STUDIO_WORLD,
  orgName: STUDIO_COMPANY.name,
  emailDomain: STUDIO_EMAIL_DOMAIN,
  roleAgents: [],
  deskTeams: STUDIO_DESK_TEAMS,
  supportSpecs: {
    customerCompanies: Object.fromEntries(
      STUDIO_CLIENTS.flatMap((c) => c.contactKeys.map((k) => [k, c.name])),
    ),
    contactDuplicates: [],
    inboxes: { support: "Support", sales: "Sales", bugs: "Client issues" },
    ticketCategories: [],
    tickets: [],
    ticketMerges: [],
    projects: [],
    calendarName: "Halden team",
    events: [],
    mail: [],
    mailTourConversation: null,
    companies: STUDIO_CLIENTS.map((c) => ({
      key: c.key,
      name: c.name,
      domain: c.domain,
      contactKeys: c.contactKeys,
    })),
    // The pipeline's deals are the layer's (`layer.ts`).
    pipeline: {
      key: STUDIO_PIPELINE_KEY,
      name: "Sales pipeline",
      description: "New work from briefs to signed agreements.",
      deals: [],
    },
    approvals: [],
    productScenarios: false,
  },
  knowledgeSpecs: { authorKey: "lea", collections: [], articles: [] },
  threadSpecs: { threads: [], agentDms: [] },
  agentNative: {
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
    ownerAgentChannelTitles: [],
    scenarioRoutines: false,
  },
  layer: seedStudioLayer,
  people: STUDIO_TEAM,
  personas: personas(),
  namedRows: {
    company: STUDIO_COMPANY,
    clients: STUDIO_CLIENTS,
    delivery: STUDIO_DELIVERY_KEYS,
    costRates: STUDIO_COST_RATES,
    datedLines: STUDIO_DATED_LINES,
    away: STUDIO_AWAY,
  },
  plan: studioPlan,
}

/** The same pack, under the name drivers outside the seed import it by. */
export const STUDIO_PACK_EXPORTS = STUDIO_WORLD_PACK
