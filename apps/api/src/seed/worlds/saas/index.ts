// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The `saas` world's pack: Tideform, a rota software company selling by
 * subscription. Its company, team, desks, support, knowledge and threads, the
 * agent native specs, and its own layer (companies, deals, away, routines).
 */
import type { DemoPerson, DemoRole } from "~/seed/world/fiction"
import type { DemoWorldPack } from "../index"
import { SAAS_AGENT_NATIVE_SPECS } from "./agent-native"
import {
  SAAS_ACCOUNT_MANAGERS,
  SAAS_AWAY,
  SAAS_COMPANY,
  SAAS_DESK_TEAMS,
  SAAS_EMAIL_DOMAIN,
  SAAS_PLANS,
  SAAS_ROLE_AGENTS,
  SAAS_TEAM,
  SAAS_WORLD,
} from "./fiction"
import { SAAS_KNOWLEDGE_SPECS } from "./knowledge-specs"
import { seedSaasLayer } from "./layer"
import { SAAS_SUPPORT_SPECS, SAAS_TICKET_KEYS } from "./support-specs"
import { SAAS_THREAD_SPECS } from "./threads-specs"

function personas(): DemoWorldPack["personas"] {
  const out: Partial<Record<DemoRole, DemoPerson[]>> = {}
  for (const person of SAAS_TEAM) out[person.role] = [...(out[person.role] ?? []), person]
  return out
}

export const SAAS_WORLD_PACK: DemoWorldPack = {
  id: "saas",
  world: SAAS_WORLD,
  orgName: SAAS_COMPANY.name,
  emailDomain: SAAS_EMAIL_DOMAIN,
  roleAgents: SAAS_ROLE_AGENTS,
  deskTeams: SAAS_DESK_TEAMS,
  supportSpecs: SAAS_SUPPORT_SPECS,
  knowledgeSpecs: SAAS_KNOWLEDGE_SPECS,
  threadSpecs: SAAS_THREAD_SPECS,
  agentNative: SAAS_AGENT_NATIVE_SPECS,
  layer: seedSaasLayer,
  people: SAAS_TEAM,
  personas: personas(),
  namedRows: {
    company: SAAS_COMPANY,
    plans: SAAS_PLANS,
    accountManagers: SAAS_ACCOUNT_MANAGERS,
    away: SAAS_AWAY,
    tickets: SAAS_TICKET_KEYS,
  },
}
