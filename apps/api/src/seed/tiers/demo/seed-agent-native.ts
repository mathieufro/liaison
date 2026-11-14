// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The AGENT NATIVE layer of the demo world: the org's curated skills, its
// routines, the sub agent roles its desks delegate to, the memory its agents
// have written while working here, the knowledge collections each agent is
// pointed at, and the timeline of what each one has been doing.
//
// WHY THIS LAYER EXISTS. Every other layer seeds things a helpdesk or a billing
// tool would also have: tickets, invoices, shipments, articles. The two things
// that are only true of this product are that an agent follows the company's
// OWN playbooks, and that agent work runs on a schedule or off an event without
// anybody opening a chat. A demo org that seeds eleven agents and no skill and
// no routine shows the org chart and hides the product.
//
// ── WHAT A SKILL IS HERE ───────────────────────────────────────────────────
// A row in `kernel.skills` with `author_user_id` NULL is an ORG SHARED skill:
// `resolveAllSkills` hands it to every person's agent, under every personal and
// role agent in the org. `owner_agent_id` is still a real agent, because the
// product gives every skill a named owner and `agent_skill_index` is keyed by
// it: each playbook is owned by the desk that curates it, which is also what
// makes the ownership column read as the company's own filing rather than as
// plumbing.
//
// DISCOVERABILITY IS THE POINT, not the row. A skill nothing can find is
// decoration, so every entry declares:
//   * `auto_attach.keywords` — the trigger vocabulary. It is weighted double in
//     `skill_search` ranking and it BYPASSES the auto surface token gate
//     outright, so a phrase a person would really type ("the customer wants to
//     return it") lands on the playbook. French forms are included because the
//     company is French and the matcher is accent folded and stem tolerant.
//   * `auto_attach.apps` — the app anchors. When the thread is already working
//     in `boxtal` or `invoicing`, the anchored playbook surfaces on app
//     evidence alone, with no vocabulary match needed at all.
//   * `domain` — the routing slug a scoped skill approval is decided against.
// `description` is capped at 100 characters by a check constraint and is ALSO
// half the auto surface label vocabulary, so it is written as a sentence a
// matcher can work with rather than a title.
//   * `required_scopes` — the scope-to-skill binding: `resolveAllSkills` only
//     hands a playbook to a caller whose held scopes are a superset of this
//     list (`subsetOfScopes`), so a playbook that touches money or a dealer's
//     account is invisible to someone whose desk does not carry that scope,
//     the same way the real org's `tessera-support-triage` skill carries its own
//     13. Each entry here names the scope the playbook's own procedure
//     actually exercises (a refund playbook needs invoicing write, a shipping
//     one needs boxtal and shopify read), copied from the scope strings
//     `role-scopes.ts` already validates for the desk that owns it, never
//     invented: a scope the registry does not declare fails the seed rather
//     than sitting invisible in a ceiling.
//
// ── WHY EVERY ROUTINE IS SEEDED OFF ────────────────────────────────────────
// A visitor org is created the moment somebody registers, and agents here run
// on the visitor's OWN model key, which at that moment does not exist. A
// routine seeded enabled would start a burst of ticks against no key, burn the
// org's first minutes on failed runs and fill the run history with errors
// before the visitor has seen a single screen.
//
// So every seeded routine carries `enabled = false` with `status = 'active'`.
// That pair is deliberate:
//   * `enabled = false` is the flag BOTH gates read. The boot reconciler
//     selects `enabled = true AND status = 'active'`, so nothing is registered
//     with BullMQ and no event subscription is opened; and `runRoutineTick`
//     re-checks the same pair and no-ops before any turn, so even a stray job
//     cannot start one.
//   * `status = 'active'` keeps the row's badge reading "off", which is what it
//     is, instead of "paused" which claims a failure that never happened.
// Turning one on is one toggle, and that toggle is the demo.
//
// ── IDEMPOTENT ON CONTENT ──────────────────────────────────────────────────
// Like every other layer: a re-seed RESTORES a body somebody edited rather than
// adopting it, and never duplicates. Skills converge on `(owner_agent_id,
// name)`, routines on `(org_id, owner_user_id, name)`, sub agent roles on
// `(org_id, agent_type)` and memory on `(org_id, owner_agent_id, type, name)`.
// The two tab layers converge on a DETERMINISTIC id instead, derived from the
// agent and the thing the row is about, because neither table has a natural
// key to collide on: a knowledge pointer is (agent, collection) and a timeline
// row is (agent, spec key).
//
// Nothing here reads the wall clock or a random source: `baseTime` is the only
// instant and every offset from it is a fixed literal.
//
// ── WHAT THE TWO AGENT PAGE TABS READ ──────────────────────────────────────
// Sections 5 and 6 exist for one screen each, and each is written against the
// route that serves it rather than against the table:
//   * Knowledge tab: `kernel.agent_knowledge_pointers` (id, collection_id,
//     created_at) joined by name to `app_knowledge.collections`.
//   * Activity tab: `kernel.audit_log`, filtered to one agent and to the
//     route's own closed list of actions, summarised into the kinds turn,
//     routine_tick, sub_run, ask, memory_write and approval.
// Neither table has a product write path a seeder could call, so both are
// written privileged, in the row shape their real writers use.

import type { DemoSeedPart } from "@liaison/shared"
import { type SeedContext, seedContext } from "~/seed/context"
import {
  type ActivityAction,
  agentLayerCounts,
  knowledgeCollectionsByName,
  seedActivityRow,
  seedKnowledgePointer,
} from "~/seed/factories/agent/activity"
import {
  type EpisodeSeed,
  seedMemoryEntries,
  seedRememberedConversations,
} from "~/seed/factories/agent/memory"
import {
  agentDmWith,
  describeAgent,
  personalAgentOf,
  seatAgentInThreads,
  threadsByTitle,
} from "~/seed/factories/agent/presence"
import {
  enableEventRoutine,
  type RoutineSeed,
  scopeReader,
  seedRoutine,
  seedSubAgentRoles,
} from "~/seed/factories/agent/routines"
import { pruneRetiredSkillsAndRoutines, seedOrgSkills } from "~/seed/factories/agent/skills"
import { contactIdByEmail } from "~/seed/factories/people/contacts"
import { seedSalesIssuerProfile } from "./seed-commerce"
import type { SeedDemoOrgResult } from "./seed-org"
import { SCENARIO_PROSPECT } from "./seed-support"

export interface SeedDemoAgentNativeOptions {
  /** The instant every offset is measured from: the caller's one `now`. */
  baseTime: Date
  log?: (msg: string) => void
  /**
   * A tailored seed's parts (`demoSeedPlan`): the scenario routines its needs
   * use are seeded too (`support-routine`, `prospect-routine`). Absent: the
   * company's routines only, exactly as before.
   */
  scenarioParts?: ReadonlySet<DemoSeedPart>
  /** The world pack's agent native specs. Defaults to the `products` world's. */
  specs?: DemoAgentNativeSpecs
}

/**
 * What a world's agent native layer writes: its playbooks, routines, delegate
 * roles, desk memory, remembered conversations, knowledge pointers, activity
 * timeline and the owner's assistant. Pure data, one per world pack
 * (`seed/worlds`); the `products` world's is `PRODUCTS_AGENT_NATIVE_SPECS`.
 */
export interface DemoAgentNativeSpecs {
  skills: readonly SkillSpec[]
  routines: readonly RoutineSpec[]
  subAgents: readonly SubAgentSpec[]
  memory: readonly MemorySpec[]
  episodes: readonly EpisodeSpec[]
  knowledgePointers: readonly KnowledgePointerSpec[]
  activity: readonly ActivitySpec[]
  ownerAgentPurpose: string
  /** The rooms the owner's assistant sits in, by thread title. */
  ownerAgentChannelTitles: readonly string[]
  /** The `products` world's scenario routines (support, prospect) join a tailored seed. */
  scenarioRoutines: boolean
  /**
   * Routines the world's own layer writes (from product templates), which this
   * layer's retirement pass must keep: they are current, not retired.
   */
  layerRoutineNames?: readonly string[]
}

export interface SeedDemoAgentNativeResult {
  orgId: string
  skillIds: string[]
  /** Skill name -> id, so a caller or a test can address one without re-deriving it. */
  skillIdsByName: Record<string, string>
  routineIds: string[]
  routineIdsByName: Record<string, string>
  subAgentTypes: string[]
  memoryKeys: string[]
  /** `<agent handle>:<episode path>` for every remembered conversation written. */
  episodeKeys: string[]
  /** The `agent_knowledge_pointers` rows this layer wrote, by id. */
  knowledgePointerIds: string[]
  /** The `audit_log` timeline rows this layer wrote, by id. */
  activityRowIds: string[]
  counts: Record<string, number>
}

// ── 1. SKILLS ──────────────────────────────────────────────────────────────

export interface SkillSpec {
  /** Kebab case, unique per owning agent. This is what `skill_read` is called with. */
  name: string
  /** At most 100 characters (DB check constraint) and half the auto surface label vocabulary. */
  description: string
  /** The routing slug a scoped skill approval is decided against. */
  domain: string
  /** Handle of the agent that curates it: the desk it belongs to. */
  ownerHandle: string
  /**
   * The scope-to-skill binding: `resolveAllSkills` gates this playbook to
   * callers whose held scopes are a superset. Real scope ids only, copied
   * from `role-scopes.ts`.
   */
  requiredScopes: string[]
  /** `auto_attach.keywords`: the trigger vocabulary, double weighted in search. */
  keywords: string[]
  /** `auto_attach.apps`: surfaces the playbook on app evidence with no vocabulary match. */
  apps: string[]
  body: string
}

/**
 * The nine playbooks Resonant Audio Labs keeps.
 *
 * Each one is grounded in something the other layers already seeded: the
 * knowledge base carries the POLICY (what we promise), and the skill carries
 * the PROCEDURE the agent follows when it acts. They are written the way the
 * company would write them, which is why none of them carries dash
 * punctuation and none of them says "bricked".
 */
export const SKILL_SPECS: SkillSpec[] = [
  {
    name: "customer-reply-voice",
    description: "How a reply to a customer is written: warm, plain, specific, and never markdown.",
    domain: "support",
    ownerHandle: "@support",
    requiredScopes: ["tickets:tickets:reply", "mail:conversations:read"],
    keywords: [
      "reply",
      "respond",
      "answer",
      "draft",
      "customer email",
      "ticket reply",
      "tone",
      "voice",
      "repondre",
      "reponse",
      "brouillon",
      "ton",
    ],
    apps: ["tickets", "mail"],
    body:
      "# Writing to a customer\n\n" +
      "Every reply we send is plain text. Markdown would go out as formatted email, but a " +
      "support reply reads best without headings or bullets. Write sentences and short " +
      "paragraphs, and use a blank line where you would have used a bullet.\n\n" +
      "## The shape\n" +
      "1. Answer the question in the first sentence. The customer should not have to read to the " +
      "end to find out whether we can help.\n" +
      "2. Say what happens next, with who does it and when.\n" +
      "3. Give the one number that matters: the order number, the RMA reference, the amount, the " +
      "tracking link. One is enough.\n" +
      "4. Close with a single line offering the next step.\n\n" +
      "## Voice\n" +
      "Warm and plain. We are a small company in Paris that makes field recorders, not a support " +
      "department. Use we and you. Contractions are fine.\n\n" +
      "Never apologise twice, and never apologise for something that is not our fault. One clear " +
      "sorry, then the fix.\n\n" +
      "Never guess at a date, a figure or a policy. Read it from the system or from the knowledge " +
      "base, and if it is not there say that you are checking and give a time you will come back.\n\n" +
      "Never tell a customer their unit is beyond saving. Every unit has a recovery bootloader and " +
      "every failure we have seen is either a firmware recovery or a replacement.\n\n" +
      "## Language\n" +
      "Reply in the language the customer wrote in. French and English are both first class here. " +
      "If you are not confident in the customer's language, say so plainly and keep it simple " +
      "rather than machine translating a long answer.\n\n" +
      "## What needs a person\n" +
      "A refund, a goodwill gesture, a promise about a date we have not committed to, and anything " +
      "about a dispute or a chargeback. Draft it and let a human send it.",
  },
  {
    name: "returns-and-warranty",
    description: "Deciding return, repair or replacement, and raising the RMA and the label.",
    domain: "support",
    ownerHandle: "@support",
    requiredScopes: ["shopify:returns:write", "boxtal:shipments:write", "tickets:tickets:write"],
    keywords: [
      "return",
      "returns",
      "rma",
      "warranty",
      "replacement",
      "faulty",
      "defect",
      "dead input",
      "retour",
      "garantie",
      "echange",
      "panne",
      "remboursement",
    ],
    apps: ["tickets", "shopify", "boxtal", "knowledge"],
    body:
      "# Returns, warranty and replacements\n\n" +
      "Read the Warranty policy and the Return procedure in the knowledge base before you decide " +
      "anything. This is how the desk applies them.\n\n" +
      "## Which of the three is it\n" +
      "Within 30 days of delivery and the customer simply changed their mind: that is a RETURN. " +
      "Full refund including the original shipping.\n\n" +
      "Within the warranty and the unit is faulty: that is a WARRANTY claim. Never a return, never " +
      "a restocking deduction, and never a request that the customer pay return shipping.\n\n" +
      "Between 30 and 60 days and not a fault: credit, not a refund. Beyond 60 days and not a " +
      "fault: no return, and say so kindly in one sentence.\n\n" +
      "## Before you raise anything\n" +
      "Find the order. The serial number is enough, and every unit we sold direct or through a " +
      "dealer is in our records. Do not ask a customer for a receipt we can look up ourselves.\n\n" +
      "Confirm the symptom is not a cable, a hub or a power supply. The product guides carry the " +
      "test for each recorder and it takes the customer two minutes. A replacement we ship for a " +
      "faulty USB cable is a unit we do not have for the customer who really needs one.\n\n" +
      "## Raising it\n" +
      "Raise the return against the order so the prepaid label and the drop off code are generated " +
      "together, then send both to the customer the same day. Put the RMA reference in the ticket " +
      "so fulfillment can find it without asking.\n\n" +
      "A Care Plan holder gets advance replacement: the new unit ships before the faulty one " +
      "reaches us. Say that in the reply, because it is the reason they bought the plan.\n\n" +
      "## Dealer units\n" +
      "The warranty is ours, not the dealer's. A customer who bought from a shop comes to us and we " +
      "handle it. Never send them back to the shop. Tell the dealer afterwards so their records " +
      "stay right.\n\n" +
      "## What needs a person\n" +
      "Buying the label and issuing the refund are both approvals. Prepare them, name the amount " +
      "and the carrier, and let a human decide.",
  },
  {
    name: "dealer-pricing-and-quotes",
    description: "Working out a dealer's tier and writing the quote, including education accounts.",
    domain: "sales",
    ownerHandle: "@operations",
    requiredScopes: ["shopify:orders:read", "invoicing:contacts:read", "invoicing:documents:read"],
    keywords: [
      "dealer",
      "reseller",
      "distributor",
      "quote",
      "tier",
      "trade price",
      "wholesale",
      "education",
      "conservatoire",
      "revendeur",
      "devis",
      "remise",
      "tarif",
    ],
    apps: ["shopify", "invoicing", "contacts"],
    body:
      "# Dealer pricing and quotes\n\n" +
      "The tiers themselves live in the Dealer pricing tiers article. This is how to apply them " +
      "without getting one wrong.\n\n" +
      "## Work out the tier before you quote\n" +
      "Count FLAGSHIP units the dealer ordered in the last rolling twelve months, across every " +
      "flagship product. Accessories never move a dealer up a tier: they are a flat 30 percent and " +
      "that is the question dealers ask most often, so answer it before they ask.\n\n" +
      "Count what was ORDERED, not what was invoiced or delivered. A unit on an open order counts.\n\n" +
      "## Education\n" +
      "A film school, a conservatoire or a university buying for a teaching lab gets Tier 3 from the " +
      "first unit, on a named purchase order. Ask for the purchase order number before the quote " +
      "goes out, not after.\n\n" +
      "## Demo units\n" +
      "One per model per store, at half the dealer price, on the understanding that it stays on the " +
      "floor. If they sell one on as ex demo that is fine, but we need the serial so the warranty " +
      "record follows the unit.\n\n" +
      "## Writing the quote\n" +
      "State the tier and the percentage on the quote itself, so nobody has to reverse engineer the " +
      "figures later. Quote in the dealer's own currency where we have one, otherwise euros.\n\n" +
      "Every quote is valid for 60 days. Put the expiry date on it. Past that the tier is rechecked " +
      "before we accept the order, which is fair to the dealer who has grown.\n\n" +
      "Check the VAT treatment with the invoicing playbook before you put a total on anything " +
      "crossing a border.\n\n" +
      "## What needs a person\n" +
      "Any discount past Tier 4, any payment terms beyond our standard, and any first order from a " +
      "dealer we have not signed. Prepare it and hand it over.",
  },
  {
    name: "eu-and-export-vat",
    description: "Which VAT treatment an invoice takes, inside the EU and outside it.",
    domain: "finance",
    ownerHandle: "@finance",
    requiredScopes: [
      "invoicing:documents:read",
      "invoicing:settings:read",
      "invoicing:contacts:read",
    ],
    keywords: [
      "vat",
      "tva",
      "invoice",
      "invoicing",
      "reverse charge",
      "autoliquidation",
      "export",
      "customs",
      "douane",
      "hs code",
      "facture",
      "intracommunautaire",
      "duty",
    ],
    apps: ["invoicing", "pennylane", "shopify"],
    body:
      "# VAT on an invoice\n\n" +
      "We invoice from France. Two knowledge base articles carry the rules in full; this is the " +
      "decision the finance desk actually makes, in order.\n\n" +
      "## Step 1: where is the customer\n" +
      "France: French VAT at the standard rate, always. No exceptions, business or consumer.\n\n" +
      "Another EU country, CONSUMER: French VAT, until the distance selling threshold is crossed " +
      "for that country. Check the threshold before you assume.\n\n" +
      "Another EU country, BUSINESS with a valid VAT number: reverse charge. No VAT on the " +
      "invoice, and the invoice must carry the customer's VAT number and the reverse charge " +
      "mention. Both, or the invoice is not valid.\n\n" +
      "Outside the EU: export. No VAT. The invoice needs the commodity code and the value per " +
      "line, because it travels with the parcel.\n\n" +
      "## Step 2: validate the number, do not trust it\n" +
      "An EU VAT number is only a reverse charge if it validates TODAY. A number that was valid " +
      "last quarter is not evidence. Validate it, record that you did, and if it fails charge " +
      "French VAT and tell the customer why in one sentence.\n\n" +
      "## Step 3: the paperwork that travels\n" +
      "Every export needs a commercial invoice with the commodity code, the country of origin " +
      "(France for everything we make) and the value per line. Understating a value to help a " +
      "customer with duty is not a favour we do.\n\n" +
      "Duty and import VAT are the recipient's, everywhere. Say so on the quote, on the invoice " +
      "and in the reply, because it is the single most common surprise.\n\n" +
      "## Step 4: credit notes\n" +
      "A credit note takes the VAT treatment of the invoice it credits, not the treatment that " +
      "would apply today. Reference the original document number on it.\n\n" +
      "## What needs a person\n" +
      "Issuing, sending and crediting are all approvals. Prepare the document, state the treatment " +
      "you applied and why, and let a human issue it.",
  },
  {
    name: "shipment-exception",
    description: "What to do when a parcel is late, stuck, refused, damaged or lost.",
    domain: "shipping",
    ownerHandle: "@operations",
    requiredScopes: [
      "boxtal:shipments:read",
      "boxtal:shipments:write",
      "shopify:fulfillments:read",
    ],
    keywords: [
      "shipment",
      "parcel",
      "tracking",
      "carrier",
      "stuck",
      "delayed",
      "late",
      "lost",
      "damaged",
      "customs hold",
      "colis",
      "expedition",
      "livraison",
      "retard",
      "bloque",
    ],
    apps: ["boxtal", "shopify", "tickets"],
    body:
      "# A shipment that is not moving\n\n" +
      "The Shipping timelines article carries what we promise. This is what the operations desk " +
      "does when a parcel misses it.\n\n" +
      "## Read the tracking first\n" +
      "Never answer a where is my order question from the order alone. Pull the tracking, read the " +
      "last scan and its date, and work from that. A parcel with no scan for three working days is " +
      "an exception, whatever the promised date said.\n\n" +
      "## The five shapes\n" +
      "NO SCAN SINCE HANDOVER. The carrier may never have collected it. Check the pickup, then " +
      "open a claim rather than waiting another day.\n\n" +
      "HELD IN CUSTOMS. Almost always a missing or wrong commodity code, or a recipient who has " +
      "not answered the broker. Send the customer the invoice and the code, and tell them who to " +
      "call. Duty is theirs, and saying that early is kinder than saying it late.\n\n" +
      "REFUSED OR UNDELIVERABLE. The parcel is coming back. Tell the customer before the carrier " +
      "does, and ask whether they want it resent or refunded.\n\n" +
      "DAMAGED. Photograph what arrives back, open the carrier claim the same day (most carriers " +
      "close the window fast), and ship the replacement without waiting for the claim.\n\n" +
      "LOST. After the carrier's own search window closes, treat it as lost, ship a replacement " +
      "and pursue the claim ourselves. The customer never chases a carrier on our behalf.\n\n" +
      "## Tell the customer before they ask\n" +
      "An exception we found and reported reads as care. The same exception found by the customer " +
      "reads as neglect. One short message, with the fact and what we are doing about it.\n\n" +
      "## Keep the order in step\n" +
      "Whatever we do, the order in the shop has to say it: a replacement is a new fulfillment with " +
      "its own tracking, not a note. An order that says delivered when it is not is how the same " +
      "problem gets found twice.\n\n" +
      "## What needs a person\n" +
      "Buying a replacement label, refunding, and any goodwill gesture.",
  },
  {
    name: "escalation-path",
    description: "What counts as an escalation here, who it goes to, and how fast.",
    domain: "support",
    ownerHandle: "@base",
    requiredScopes: ["tickets:tickets:read", "kernel:contacts:read", "kernel:approvals:read"],
    keywords: [
      "escalation path",
      "who to escalate to",
      "hand over",
      "handover",
      "escalate",
      "escalation",
      "urgent",
      "angry",
      "complaint",
      "sla",
      "breach",
      "priority",
      "out of hours",
      "safety",
      "escalade",
      "urgent client",
      "plainte",
      "reclamation",
    ],
    // Not projects: on that screen the body tainted a "plan a project" turn with
    // the tickets, contacts and approvals scopes it is tagged with (walk D42).
    apps: ["tickets", "mail"],
    body:
      "# Escalating\n\n" +
      "The When to escalate article names the people. This is the judgement call.\n\n" +
      "## What is actually an escalation\n" +
      "A safety question about a power supply or a mains lead. Immediately, to the founder, and " +
      "stop selling the batch until somebody has looked.\n\n" +
      "A dealer or an education account blocked on something we have promised. Same day, to sales.\n\n" +
      "A customer on their second failed unit. Same day, to the support lead. Two failures is a " +
      "pattern, not bad luck, and the customer already knows that.\n\n" +
      "A payment dispute or a chargeback. Same day, to finance. Never answer one directly.\n\n" +
      "Anything a journalist, a reviewer or a large account asks in public. To the founder, before " +
      "any reply goes out.\n\n" +
      "## What is not\n" +
      "An angry tone on its own is not an escalation. A long ticket is not an escalation. A missed " +
      "first response is a miss we fix, not a thing we hand to somebody else.\n\n" +
      "## How to hand it over\n" +
      "Escalating is not forwarding. Write the three lines the next person needs: what the customer " +
      "wants, what we have already done, and what decision you are asking for. A handover without " +
      "those three lines comes straight back.\n\n" +
      "Stay on the ticket. The person you escalated to owns the decision; you still own the " +
      "customer, and you tell them what is happening.\n\n" +
      "## Out of hours\n" +
      "Only the safety case travels out of hours. Everything else waits for the morning, and the " +
      "morning triage picks it up first.",
  },
  {
    name: "refunds-and-credit-notes",
    description: "When we refund, when we credit, and what the document has to say.",
    domain: "finance",
    ownerHandle: "@finance",
    requiredScopes: ["shopify:refunds:create", "invoicing:documents:write", "invoicing:approve"],
    keywords: [
      "refund",
      "credit note",
      "avoir",
      "remboursement",
      "chargeback",
      "dispute",
      "goodwill",
      "partial refund",
      "geste commercial",
      "litige",
    ],
    apps: ["invoicing", "shopify", "pennylane"],
    body:
      "# Refunds and credit notes\n\n" +
      "## Which one\n" +
      "Money going back to the customer's own payment method is a REFUND. It needs a credit note " +
      "behind it, because the invoice it reverses is already in the ledger.\n\n" +
      "Money staying with us as a balance is a CREDIT. A credit note, no refund. This is what a " +
      "return between 30 and 60 days gets.\n\n" +
      "A goodwill gesture on an order we are not reversing is a partial credit note against the " +
      "original invoice, never an unexplained payment.\n\n" +
      "## Before you prepare one\n" +
      "Read the order and the invoice. Check what was actually paid, in what currency and on what " +
      "date. A refund larger than the payment is refused by the processor and looks careless.\n\n" +
      "Check whether one is already pending. A duplicate refund is far harder to unwind than a late " +
      "one, and a second request staged while the first is still waiting is the usual cause.\n\n" +
      "## What the document says\n" +
      "The credit note carries the original invoice number, the same VAT treatment as that invoice, " +
      "and one line saying why. Not a code, a sentence: returned within the window, faulty on " +
      "arrival, shipping refunded after a carrier delay.\n\n" +
      "## Disputes and chargebacks\n" +
      "Never refund into an open dispute. Two refunds go out and only one comes back. Gather the " +
      "order, the tracking and the delivery confirmation, and hand it to finance.\n\n" +
      "## Telling the customer\n" +
      "Say the amount and say when it will show, which is normally three working days to the " +
      "original method. Do not leave them to notice it.\n\n" +
      "## What needs a person\n" +
      "Every refund and every credit note. There is no threshold below which this is automatic.",
  },
  {
    name: "month-end-close",
    description: "The order the month is closed in, and what must be true before it is.",
    domain: "finance",
    ownerHandle: "@finance",
    requiredScopes: ["invoicing:documents:read", "pennylane:invoices:read", "pennylane:cash:read"],
    keywords: [
      "month end",
      "close",
      "closing",
      "cloture",
      "reconcile",
      "reconciliation",
      "ledger",
      "aged",
      "outstanding",
      "bank",
      "rapprochement",
      "grand livre",
    ],
    apps: ["invoicing", "pennylane", "shopify"],
    body:
      "# Closing a month\n\n" +
      "Nothing here is a decision. It is an order of operations, and doing it out of order is what " +
      "makes a close take a week.\n\n" +
      "## 1. Every order has its document\n" +
      "Every shipped order in the period has an issued invoice. An order that shipped without one " +
      "is the thing to find first, because it moves revenue into the wrong month.\n\n" +
      "## 2. Every document has its treatment\n" +
      "Spot check the reverse charge and export invoices against the VAT playbook. A wrong " +
      "treatment found now is a correction; found next quarter it is a filing.\n\n" +
      "## 3. Credit notes are matched\n" +
      "Every credit note points at the invoice it reverses. An unmatched credit note is either a " +
      "mistake or a refund nobody recorded.\n\n" +
      "## 4. The bank is reconciled\n" +
      "Every payment in the account matches a document. Unmatched receipts are usually a dealer " +
      "paying two invoices with one transfer, which is fine once it is split.\n\n" +
      "## 5. The aged list is read, not just produced\n" +
      "Anything past 30 days gets a name against it and a next action. A dealer we are still " +
      "shipping to and who has not paid in 60 days is a conversation, not a reminder.\n\n" +
      "## 6. Say what the month was\n" +
      "Revenue, refunds and credits, the cash position and the three largest outstanding invoices. " +
      "Six lines, written the same way every month so the shape of the business is visible in the " +
      "difference.\n\n" +
      "## What needs a person\n" +
      "Writing anything off, and any correction to a document already sent to a customer.",
  },
  {
    name: "knowledge-upkeep",
    description: "Keeping the knowledge base true: what to write, what to verify, what to retire.",
    domain: "support",
    ownerHandle: "@support",
    requiredScopes: ["knowledge:documents:create", "knowledge:documents:update"],
    keywords: [
      "knowledge",
      "knowledge base",
      "article",
      "review",
      "verify",
      "stale",
      "out of date",
      "documentation",
      "base de connaissance",
      "obsolete",
      "verifier",
    ],
    apps: ["knowledge", "tickets"],
    body:
      "# Keeping the knowledge base true\n\n" +
      "The knowledge base is the thing every reply is grounded in, so an article that is quietly " +
      "wrong is worse than no article at all.\n\n" +
      "## When to write a new one\n" +
      "The third time the desk answers the same question from scratch. Not the first, because one " +
      "customer is not a pattern, and not the tenth, because by then the answer has drifted into " +
      "ten different versions.\n\n" +
      "## What an article is\n" +
      "One question, answered. If it needs two titles it is two articles. Put the answer in the " +
      "first paragraph and the caveats after it.\n\n" +
      "Write what is true, not what we wish were true. An article that says a repair takes five " +
      "days when it takes ten produces an angry customer on day six.\n\n" +
      "## Review dates are a promise\n" +
      "An article past its review date is unverified, and the desk should treat it that way. " +
      "Reviewing means checking it against what actually happened since, not reading it again.\n\n" +
      "Verify an article only when you have checked the facts in it yourself. Verification is a " +
      "signal other people act on.\n\n" +
      "## Retiring\n" +
      "Archive rather than delete: a ticket from last year may still link to it. An archived " +
      "article that is still being opened is a sign the replacement is not findable.\n\n" +
      "## Grounding a reply\n" +
      "Quote the article's substance, not its title, and never cite an article you have not read " +
      "this turn. If nothing covers the question, say so and write the article afterwards.",
  },
]

// ── 2. ROUTINES ────────────────────────────────────────────────────────────

export interface RoutineSpec {
  name: string
  /** At most 200 characters (DB check constraint). */
  description: string
  kind: "recurring" | "event"
  /** Set for `recurring`. */
  cron?: string
  /** Set for `event`: a full `app:entity:action` string the org really declares. */
  event?: string
  /**
   * The person the routine runs AS. `owner` means the org's owner (the visitor,
   * or the App Review account), falling back to the founder when the org was
   * seeded with nobody who can sign in.
   */
  ownerKey: string | "owner"
  /** The desk the routine is attributed to. */
  ownerHandle: string
  /** Requested ceiling. Clamped to what the OWNER actually holds before it is written. */
  scopes: string[]
  prompt: string
}

/**
 * The five routines the company runs. One of them is EVENT driven, which is the
 * half that has no equivalent anywhere else: the org reacts the moment a ticket
 * is opened, with nobody watching a queue and no schedule to wait for. It binds
 * to `tickets:ticket:create`, an event the tickets app really declares, because
 * a routine subscribed to an event nothing emits looks set up and never runs.
 *
 * Every cron is a working hour in Europe/Paris, the org's own timezone, so the
 * schedule reads as this company's day.
 */
const ROUTINE_SPECS: RoutineSpec[] = [
  {
    name: "Morning backlog triage",
    description:
      "Every working morning: read the open ticket queue, group it by what it is really about, and post the day's shortlist.",
    kind: "recurring",
    cron: "0 8 * * 1-5",
    ownerKey: "amina",
    ownerHandle: "@support",
    scopes: [
      "tickets:tickets:read",
      "tickets:inboxes:read",
      "knowledge:documents:read",
      "kernel:contacts:read",
      "kernel:threads:read",
      "mail:conversations:read",
    ],
    prompt:
      "Read every open ticket in the queue and produce the desk's shortlist for today.\n\n" +
      "Group the queue by what the tickets are actually about, not by their category field: the " +
      "field is what somebody guessed on the way in, and the grouping is the useful part.\n\n" +
      "For each group give the count, the oldest ticket in it and one line saying what it is.\n\n" +
      "Then list, separately and in order, the tickets that need a person today:\n" +
      "anything past its first response target, anything a customer has chased more than once, " +
      "anything from a dealer or an education account, and anything the escalation playbook calls " +
      "an escalation.\n\n" +
      "Name each one by its reference and its subject, with one line on why it is on the list and " +
      "who you think should take it.\n\n" +
      "Where the knowledge base already answers a group, say which article, so the desk replies " +
      "from it instead of writing the answer again.\n\n" +
      "Do not reply to anything, do not change a status and do not assign anybody. This post is a " +
      "reading of the queue, and the desk decides.",
  },
  {
    name: "Overdue invoice sweep",
    description:
      "Every Monday: read the outstanding invoices, say who is genuinely late and why, and prepare the reminders for a person to send.",
    kind: "recurring",
    cron: "30 8 * * 1",
    ownerKey: "henrik",
    ownerHandle: "@finance",
    scopes: [
      "invoicing:documents:read",
      "invoicing:contacts:read",
      "invoicing:settings:read",
      "pennylane:cash:read",
      "pennylane:invoices:read",
      "kernel:contacts:read",
      "shopify:orders:read",
      "mail:conversations:read",
    ],
    prompt:
      "Produce this week's outstanding invoice picture.\n\n" +
      "List every issued invoice that is past its due date, oldest first, with the customer, the " +
      "document number, the amount, the currency and how many days past due it is.\n\n" +
      "Before you call anything late, check for a payment that has landed but is not matched: a " +
      "dealer settling several invoices with one transfer is the usual cause, and chasing a " +
      "customer who has already paid costs us more than the invoice.\n\n" +
      "Separate the list into three: a first reminder due, a second reminder due, and the ones " +
      "that need a conversation rather than a reminder. Anything past 60 days from a dealer we are " +
      "still shipping to belongs in the third group, with a note saying so.\n\n" +
      "Draft the reminder text for the first two groups, one per customer and not one per invoice, " +
      "naming every document it covers. Follow the customer reply playbook for the wording.\n\n" +
      "Send nothing. Post the drafts and the reasoning, and let finance decide what goes out.",
  },
  {
    name: "Monday digest",
    description:
      "Every Monday at seven: one short reading of the week just gone across support, shipping and invoicing, for the founder.",
    kind: "recurring",
    cron: "0 7 * * 1",
    ownerKey: "owner",
    ownerHandle: "@base",
    scopes: [
      "tickets:tickets:read",
      "tickets:inboxes:read",
      "invoicing:documents:read",
      "invoicing:contacts:read",
      "shopify:orders:read",
      "shopify:fulfillments:read",
      "boxtal:shipments:read",
      "projects:tasks:read",
      "projects:projects:read",
      "kernel:contacts:read",
      "pennylane:cash:read",
    ],
    prompt:
      "Write the Monday digest: what the week just gone actually looked like, in a page.\n\n" +
      "Six sections, the same six every week so the differences are visible:\n\n" +
      "Support. Tickets opened and closed, how many are still open, and the one thing customers " +
      "asked about most.\n\n" +
      "Orders. What shipped, what is waiting, and anything that has been waiting longer than it " +
      "should.\n\n" +
      "Shipping. Any parcel currently an exception, named, with what is being done.\n\n" +
      "Money. Invoiced, paid, and the three largest outstanding invoices.\n\n" +
      "Projects. What moved and what did not, by project.\n\n" +
      "Worth a look. At most three things that are not yet a problem but are pointing at one.\n\n" +
      "Quote real numbers read from the system. Where a number is not available, say that plainly " +
      "rather than estimating it. No section is longer than six lines.",
  },
  {
    name: "New ticket first look",
    description:
      "The moment a ticket is opened: read it, say what it is about, find the article that answers it, and flag it if it is an escalation.",
    kind: "event",
    event: "tickets:ticket:create",
    ownerKey: "amina",
    ownerHandle: "@support",
    scopes: [
      "tickets:tickets:read",
      "tickets:inboxes:read",
      "knowledge:documents:read",
      "kernel:contacts:read",
      "kernel:threads:read",
      "mail:conversations:read",
      "shopify:orders:read",
    ],
    prompt:
      "A ticket has just been opened. The event data names it. Give the desk its first look, in " +
      "under ten lines.\n\n" +
      "Say what the customer actually wants, in one sentence, in your own words.\n\n" +
      "Say who they are: a direct customer, a dealer, an education account, and whether we have an " +
      "open order or a recent one for them.\n\n" +
      "Say which knowledge base article answers it, by title, or say plainly that none does. If " +
      "none does, that is worth knowing: the desk is about to write an answer from scratch.\n\n" +
      "Say whether the escalation playbook calls this an escalation, and if it does, name who it " +
      "goes to and how fast.\n\n" +
      "Do not reply to the customer, do not set a status, do not assign it. First look only.",
  },
  {
    name: "Shipment exception check",
    description:
      "Twice each working day: read the tracking on everything in flight, and name the parcels that are not moving.",
    kind: "recurring",
    cron: "0 9,15 * * 1-5",
    ownerKey: "tobias",
    ownerHandle: "@operations",
    scopes: [
      "boxtal:shipments:read",
      "boxtal:documents:read",
      "boxtal:quotes:read",
      "shopify:orders:read",
      "shopify:fulfillments:read",
      "shopify:inventory:read",
      "tickets:tickets:read",
      "tickets:inboxes:read",
    ],
    prompt:
      "Read the tracking on every shipment currently in flight and report the exceptions.\n\n" +
      "A parcel is an exception when it has had no scan for three working days, when the carrier " +
      "is holding it, when it has been refused or is coming back, or when it is past the delivery " +
      "window we promised.\n\n" +
      "For each one give the order, the customer, the carrier, the tracking reference, the last " +
      "scan and its date, and which of the five shapes in the shipment exception playbook it is.\n\n" +
      "Say which of them the customer has already noticed: if there is an open ticket about the " +
      "order, name it. A parcel the customer has not asked about yet is the one worth telling them " +
      "about first.\n\n" +
      "If nothing is an exception, say exactly that in one line rather than padding the post.\n\n" +
      "Do not buy a label, do not refund and do not message anybody. Report, and let operations " +
      "decide.",
  },
]

// ── 3. SUB AGENT ROLES ─────────────────────────────────────────────────────

export interface SubAgentSpec {
  agentType: string
  whenToUse: string
  systemPrompt: string
  /** Clamped to what the org's admin actually holds before the row is written. */
  scopeCeiling: string[]
  /** Skill names the spawned instance loads. They are seeded above. */
  skills: string[]
}

/**
 * Two roles, and only two, because a sub agent earns its row by being work a
 * desk really hands off: a bounded, read only question asked about ONE entity,
 * answered in a sentence, while the desk agent gets on with the rest of the
 * queue. Both are the delegate of a routine seeded above, which is what makes
 * them part of the story rather than a row that proves the table exists.
 *
 * Both are kernel owned (`appName` defaults to `kernel`), so the ceiling is
 * bounded by the creating admin's own scopes rather than by one app's grant.
 */
const SUB_AGENT_SPECS: SubAgentSpec[] = [
  {
    agentType: "ticket-first-look",
    whenToUse:
      "Use for ONE ticket, when you need what it is about, who the customer is and which article " +
      "answers it, without reading the whole queue yourself. Read only. Returns a short paragraph, " +
      "never a reply to the customer.",
    systemPrompt:
      "You look at one ticket and report what it is.\n\n" +
      "Read the ticket and its messages, resolve the customer, and check whether they have a " +
      "recent or open order. Then search the knowledge base for the article that answers the " +
      "question.\n\n" +
      "Report, in under ten lines: what the customer wants in one sentence, who they are, which " +
      "article answers it (by title) or that none does, and whether the escalation playbook makes " +
      "this an escalation.\n\n" +
      "You never reply to a customer, never change a ticket and never assign anybody. Say plainly " +
      "when you could not find something rather than filling the gap.",
    scopeCeiling: [
      "tickets:tickets:read",
      "knowledge:documents:read",
      "kernel:contacts:read",
      "shopify:orders:read",
    ],
    skills: ["escalation-path", "knowledge-upkeep"],
  },
  {
    agentType: "shipment-status-check",
    whenToUse:
      "Use for ONE shipment or order, when you need the real carrier position and whether it is an " +
      "exception. Read only. Returns the last scan, the shape of the exception and what the " +
      "playbook says to do, never a purchased label.",
    systemPrompt:
      "You check one shipment and say where it really is.\n\n" +
      "Read the shipment and its tracking, and the order behind it. Report the last scan and its " +
      "date, how long it has been since, and whether that makes this an exception.\n\n" +
      "If it is, name which of the five shapes it is (no scan since handover, held in customs, " +
      "refused or undeliverable, damaged, lost) and what the shipment exception playbook says to " +
      "do about that shape.\n\n" +
      "You never buy a label, never refund and never message a customer. Quote the tracking, do " +
      "not paraphrase it, and say plainly when the carrier has told us nothing.",
    scopeCeiling: [
      "boxtal:shipments:read",
      "boxtal:documents:read",
      "shopify:orders:read",
      "shopify:fulfillments:read",
    ],
    skills: ["shipment-exception"],
  },
]

// ── 4. AGENT MEMORY ────────────────────────────────────────────────────────

export interface MemorySpec {
  /** Handle of the agent whose tree this lives in. */
  ownerHandle: string
  /** One of the four settable types. */
  type: "user" | "feedback" | "project" | "reference"
  name: string
  description: string
  content: string
}

/**
 * A few entries per desk, so the agents read as having worked here rather than
 * as having been created a minute ago.
 *
 * These are deliberately the SHAPE the product itself writes: a small durable
 * fact or a correction somebody made, one per entry, with a description that
 * works as the one line the index carries. Nothing here is a policy (a policy
 * is a knowledge article), nothing is a procedure (a procedure is a skill), and
 * nothing claims a source thread it does not have. `handleMemorySet` is the
 * write path, so the reserved `MEMORY.md` index row is rebuilt exactly as a
 * real write rebuilds it.
 */
const MEMORY_SPECS: MemorySpec[] = [
  {
    ownerHandle: "@support",
    type: "feedback",
    name: "plain-text-replies-only",
    description: "Ticket and mail bodies are plain text: markdown syntax reaches the customer raw",
    content:
      "Amina corrected this twice in the same week. A reply drafted with headings and bullets went " +
      "out with the hash and dash characters visible, because ticket and mail bodies do not render " +
      "markdown.\n\n" +
      "Write sentences and blank lines. This is in the customer reply playbook as well, but it is " +
      "the correction that comes back most often, so it lives here too.",
  },
  {
    ownerHandle: "@support",
    type: "reference",
    name: "serial-number-is-proof-of-purchase",
    description: "Never ask a customer for a receipt: the serial resolves the order in our records",
    content:
      "Every unit we sold, direct or through a dealer, is in our records against its serial " +
      "number. Asking for a receipt reads as suspicion and is usually the reason a warranty ticket " +
      "takes an extra day.\n\n" +
      "The serial is on the underside of every recorder and on the box label. If a customer cannot " +
      "find it, the order number or the delivery address is enough to get there.",
  },
  {
    ownerHandle: "@operations",
    type: "reference",
    name: "carrier-handover-cutoff",
    description: "Anything not handed over by 15:00 Paris time ships the next working day",
    content:
      "The carrier collects once a day, mid afternoon. A label bought at 16:00 shows as created " +
      "but does not move until the following working day, and a customer reading the tracking sees " +
      "a parcel that has not moved for a day.\n\n" +
      "So a same day promise made after the cutoff is a promise we break. Say next working day " +
      "instead, and it arrives when we said.",
  },
  {
    ownerHandle: "@operations",
    type: "reference",
    name: "japan-shipments-need-the-standing-pack",
    description: "Japan shipments clear far faster with the standing customs pack attached",
    content:
      "Shipments to the Japanese dealer were being held for paperwork on almost every consignment. " +
      "The standing customs pack (commercial invoice with commodity codes, country of origin and " +
      "the value per line) attached at handover clears them without a query.\n\n" +
      "Attach it to every Japan shipment, not only the dealer ones.",
  },
  {
    ownerHandle: "@finance",
    type: "reference",
    name: "one-transfer-many-invoices",
    description:
      "Dealers settle several invoices with one transfer: match before calling anything late",
    content:
      "Our dealers pay on a schedule, not per invoice, so one bank receipt regularly covers three " +
      "or four documents. An unmatched receipt is the single most common reason an invoice looks " +
      "overdue when it is paid.\n\n" +
      "Split the receipt across the documents before any reminder is drafted. Chasing a dealer who " +
      "has already paid costs more than the invoice.",
  },
  {
    ownerHandle: "@finance",
    type: "feedback",
    name: "validate-vat-numbers-every-time",
    description: "A VAT number that validated last quarter is not evidence it validates today",
    content:
      "Henrik pushed back on a reverse charge invoice raised against a number that had been valid " +
      "the previous year and was not any more. The correction is a filing, not an edit.\n\n" +
      "Validate on the day you issue, record that you did, and charge French VAT when it fails.",
  },
]

/** The agent key that means the org OWNER's own personal agent. */
const OWNER_AGENT_KEY = "owner"

// ── 4b. REMEMBERED CONVERSATIONS ───────────────────────────────────
//
// WHY A SEEDER HAS TO WRITE THESE AT ALL. An episode is not written when a
// conversation happens: `runConsolidation` (apps/api/src/modules/agent/memory/
// consolidation.ts) closes one six hours after the last agent message, off a
// background job. A freshly provisioned box has never run that job, so the
// Memory tab's "Past conversations" group stands empty over a rule and the
// header's "Forget this conversation" panel lists nothing at all, on an agent
// whose Activity tab is already showing a `memory_episode_written` row. The
// tour reads that as broken rather than as new.
//
// SO THIS WRITES WHAT THE JOB WOULD HAVE WRITTEN, THROUGH THE JOB'S OWN
// WRITER. `writeEpisodeForRegion` ends in exactly one call, `writeEpisode`
// (memory.ts), and so does this: the `agent_memory` row of type `episode`, its
// `episodes/<thread handle>/<closed on>.md` path, `source_kind` of
// `consolidation`, the `source_thread_id` the Forget route deletes on, and the
// `MEMORY.md` folder line the same call keeps in step. Writing the row by hand
// would be a second writer to keep in step with, and the index line is the
// half a hand written row always forgets.
//
// AND THE CHECKPOINT BESIDE IT. Forget deletes an agent's episodes for a
// thread AND its `kernel.agent_thread_checkpoints` versions of it in one pass
// (memory-routes.ts, `POST /:agentId/memory/forget`), so an episode seeded
// without its checkpoint makes the panel report half of what a real forget
// would remove. A version row is immutable by database trigger once written,
// which is why this one is inserted ON CONFLICT DO NOTHING rather than upserted.
//
// RESOLVED BY TITLE, exactly as the activity specs are: the conversations
// belong to the support layer, so a title that is not in this org is logged and
// skipped rather than thrown.

export interface EpisodeSpec {
  /** Agent handle, or `owner` for the org owner's own personal agent. */
  agentKey: string
  /** The conversation this agent remembers, by the support layer's own title. */
  threadTitle: string
  /** Days before the base time the room went quiet and the job closed it. */
  daysAgo: number
  /** The episode body, in the shape the summarizer's system prompt asks for. */
  body: string
  /** This agent's rolling summary of the room, as a checkpoint version. */
  checkpoint: string
}

/**
 * Two or three conversations per agent, each one a room that agent really
 * worked in.
 *
 * The bodies are written to the summarizer's own brief (participants, what was
 * asked, decisions, open items, next steps, entities with their ids) because
 * that brief is what a real episode reads like, and a visitor opening one
 * should find the record of a conversation rather than a paragraph of filler.
 */
const EPISODE_SPECS: EpisodeSpec[] = [
  // The owner's own assistant, in the two rooms it is seated in.
  {
    agentKey: OWNER_AGENT_KEY,
    threadTitle: "Preamp launch readiness",
    daysAgo: 2,
    body:
      "Participants: Elodie, Tobias, Amina, Lucas, Margot, Giulia.\n\n" +
      "What was asked: one line from each desk before the go or no go review, ready or not ready " +
      "and what is missing.\n\n" +
      "Decisions: Wednesday holds. Two blockers were named and both were sized at two days, the " +
      "customs paperwork insert and the support desk brief on the ground loop test.\n\n" +
      "Open items: the customs insert sits with fulfillment, the desk brief with support. Firmware " +
      "1.8.3 is frozen and beta.2 is with testers, so nothing else is waiting on engineering.\n\n" +
      "Next steps: confirm both blockers cleared before the review opens, and carry the ground loop " +
      "test into the launch brief so the desk has it before the volume arrives.\n\n" +
      "Entities: Kestrel Field Preamp, firmware 1.8.3.",
    checkpoint:
      "Launch readiness for the Kestrel Field Preamp. Every desk reported in: firmware frozen, " +
      "dealer pricing set, manual done except the French translation. Two blockers, the customs " +
      "paperwork insert and the support desk brief, both sized at two days. The go or no go review " +
      "stays on Wednesday.",
  },
  {
    agentKey: OWNER_AGENT_KEY,
    threadTitle: "Preamp hiss: are we replacing units we should not be?",
    daysAgo: 4,
    body:
      "Participants: Amina, Lucas, Tobias.\n\n" +
      "What was asked: whether the preamp hiss reports are a batch fault or something in the " +
      "customer's room, after a second replacement unit came back with an identical symptom.\n\n" +
      "Decisions: it is a ground loop, not a fault. The desk stops promising a replacement before " +
      "the different room, different circuit test has been run.\n\n" +
      "Open items: the test is in the preamp troubleshooting guide, and it still has to reach the " +
      "launch brief.\n\n" +
      "Next steps: send an isolating transformer at our cost to anyone already through one " +
      "replacement cycle, which costs less than a third unit and actually fixes it.\n\n" +
      "Entities: Kestrel Field Preamp.",
    checkpoint:
      "Two preamp replacements came back with the same hiss, both in studios with an interface on " +
      "a different circuit. Read as a ground loop rather than a batch fault. The different room, " +
      "different circuit test goes into the guide before any replacement is promised, and an " +
      "isolating transformer goes out at our cost where a cycle has already happened.",
  },
  // The support desk.
  {
    agentKey: "@support",
    threadTitle: "Morning triage with the support desk",
    daysAgo: 1,
    body:
      "Participants: Amina, the support desk agent.\n\n" +
      "What was asked: what landed overnight and what should be looked at first.\n\n" +
      "Decisions: the overnight queue was walked in priority order rather than by arrival, so the " +
      "warranty cases and the dealer batch went first and the presales questions waited.\n\n" +
      "Open items: one case is still waiting on the customer for a serial number, which is the only " +
      "thing standing between it and a decision.\n\n" +
      "Next steps: pick the queue back up after the shipping handover, and reopen anything the " +
      "customer answers during the day.\n\n" +
      "Entities: Kestrel 10 Field Recorder, Kestrel Field Preamp.",
    checkpoint:
      "A standing morning triage: the overnight queue read in priority order, warranty and dealer " +
      "batch cases first, presales after. One case waits on a serial number from the customer.",
  },
  {
    agentKey: "@support",
    threadTitle: "Preamp hiss: are we replacing units we should not be?",
    daysAgo: 4,
    body:
      "Participants: Amina, Lucas, Tobias.\n\n" +
      "What was asked: whether a second replacement returning with the same hiss means the fault is " +
      "ours.\n\n" +
      "Decisions: it does not. Both units were in studios with an interface on a different circuit, " +
      "which is a ground loop, and the desk had been treating it as a batch problem.\n\n" +
      "Open items: the different room, different circuit test is now in the preamp troubleshooting " +
      "guide and has to be run before anyone promises a replacement.\n\n" +
      "Next steps: offer an isolating transformer at our cost to any customer already through a " +
      "replacement cycle.\n\n" +
      "Entities: Kestrel Field Preamp.",
    checkpoint:
      "The hiss pattern, from the desk's side: run the different room, different circuit test " +
      "before promising a replacement, and send an isolating transformer at our cost where a " +
      "customer has already been through one cycle.",
  },
  {
    agentKey: "@support",
    threadTitle: "Knowledge gaps triage keeps hitting",
    daysAgo: 6,
    body:
      "Participants: Lucas, Amina.\n\n" +
      "What was asked: which questions the desk answers from scratch every week because no article " +
      "covers them.\n\n" +
      "Decisions: the gaps are worth articles rather than reply templates, because a template is " +
      "invisible to anyone who did not already know it exists.\n\n" +
      "Open items: the battery runtime figure is quoted three different ways across the site and " +
      "the guides, so the article cannot be written until one figure is agreed.\n\n" +
      "Next steps: write the missing guides against the top presales questions, and put the review " +
      "dates far enough out that the hour set aside each week can actually clear them.\n\n" +
      "Entities: Kestrel 6 Field Recorder, Kestrel Pocket Recorder.",
    checkpoint:
      "The recurring knowledge gaps: write articles rather than templates, and settle one battery " +
      "runtime figure before the guide is written, because the site and the guides disagree.",
  },
  // The operations desk.
  {
    agentKey: "@operations",
    threadTitle: "Shipping exceptions",
    daysAgo: 3,
    body:
      "Participants: Margot, Tobias, Amina.\n\n" +
      "What was asked: which parcels have stopped moving and which of them need a customer told " +
      "before they ask.\n\n" +
      "Decisions: a parcel held for paperwork is chased with the carrier, never with the customer, " +
      "and the customer is told the same day rather than at the end of it.\n\n" +
      "Open items: the standing customs pack is attached on the dealer consignments and not yet on " +
      "every shipment to the same country.\n\n" +
      "Next steps: attach the pack to every shipment on that lane, and keep the afternoon carrier " +
      "handover cutoff in every delivery promise made after it.\n\n" +
      "Entities: Harborlight Audio.",
    checkpoint:
      "How the desk handles a stopped parcel: chase the carrier, tell the customer the same day, " +
      "and attach the standing customs pack to every shipment on the lane rather than to the " +
      "dealer consignments alone.",
  },
  {
    agentKey: "@operations",
    threadTitle: "Desk handover",
    daysAgo: 7,
    body:
      "Participants: Amina, Lucas, Margot.\n\n" +
      "What was asked: what the next shift is picking up, and what must not wait for it.\n\n" +
      "Decisions: anything already promised for today is handed over by name rather than left in " +
      "the queue, because a promise nobody owns is a promise that slips.\n\n" +
      "Open items: one RMA is waiting on a dealer batch reference, and one refund is waiting on " +
      "finance rather than on the desk.\n\n" +
      "Next steps: read the handover before the queue, and close anything the previous shift " +
      "already answered.\n\n" +
      "Entities: Kestrel 10 Field Recorder.",
    checkpoint:
      "The shift handover: promises made for today are handed over by name, an RMA waits on a " +
      "dealer batch reference and a refund waits on finance, not on the desk.",
  },
  {
    agentKey: "@operations",
    threadTitle: "Preamp launch readiness",
    daysAgo: 2,
    body:
      "Participants: Elodie, Tobias, Amina, Lucas, Margot, Giulia.\n\n" +
      "What was asked: whether fulfillment is ready for the preamp launch.\n\n" +
      "Decisions: not ready, and said plainly. Packaging is signed off, the customs paperwork " +
      "insert is not, and no export ships without it.\n\n" +
      "Open items: the insert, sized at two days, which is the only fulfillment blocker on the go " +
      "or no go review.\n\n" +
      "Next steps: finish the insert, then confirm the first dealer consignments against the " +
      "carrier cutoff so nothing is promised for a day it cannot leave on.\n\n" +
      "Entities: Kestrel Field Preamp.",
    checkpoint:
      "Fulfillment's line on the launch: packaging signed off, customs paperwork insert outstanding " +
      "and sized at two days. No export ships without it.",
  },
]

// ── 5. KNOWLEDGE POINTERS ──────────────────────────────────────────────────
//
// WHAT THE TAB READS. `GET /api/agents/:agentId/knowledge` selects `id`,
// `collection_id` and `created_at` out of `kernel.agent_knowledge_pointers`
// for one (org, agent), then names each collection with a single raw read of
// `app_knowledge.collections`. The table carries no label, no note and no
// order column: a row IS the pointer, and the date is the only thing the tab
// shows beside the collection name. So the only thing worth seeding is WHICH
// desk reads WHICH collection, and since when.
//
// THE COLLECTIONS BELONG TO THE SUPPORT LAYER, which runs before this one, so
// they are looked up BY NAME. A name that is not there is logged and skipped
// rather than thrown: an org seeded without the support layer still gets its
// skills, its routines and its memory.
//
// NOT PRUNED, for the same reason sub agent roles and memory are not: the
// table carries no creator column to tell a seeded row from a visitor's own.
// Every row converges on an id derived from (agent, collection), so a re-seed
// updates the row it already made and writes no second one.

export interface KnowledgePointerSpec {
  /** An agent handle, or `owner` for the org owner's personal agent. */
  agentKey: string
  /** The collection's name, exactly as the support layer wrote it. */
  collectionName: string
  /** When the desk was pointed at it, in hours before the base time. */
  hoursAgo: number
}

/**
 * Who reads what.
 *
 * Every desk that answers a customer is pointed at the policies, because the
 * promise is the thing nobody may improvise. The procedures go to the three
 * desks that carry out a return, a shipment or a refund. The product guides go
 * where a troubleshooting answer is actually written. The owner's own agent
 * reads all three, which is what an owner's agent is for.
 */
const KNOWLEDGE_POINTER_SPECS: KnowledgePointerSpec[] = [
  { agentKey: "@support", collectionName: "Policies", hoursAgo: 61 * 24 },
  { agentKey: "@support", collectionName: "Support procedures", hoursAgo: 61 * 24 },
  { agentKey: "@support", collectionName: "Product guides", hoursAgo: 40 * 24 },
  { agentKey: "@operations", collectionName: "Support procedures", hoursAgo: 54 * 24 },
  { agentKey: "@operations", collectionName: "Policies", hoursAgo: 33 * 24 },
  { agentKey: "@finance", collectionName: "Policies", hoursAgo: 47 * 24 },
  { agentKey: "@finance", collectionName: "Support procedures", hoursAgo: 26 * 24 },
  { agentKey: OWNER_AGENT_KEY, collectionName: "Policies", hoursAgo: 19 * 24 },
  { agentKey: OWNER_AGENT_KEY, collectionName: "Support procedures", hoursAgo: 19 * 24 },
  { agentKey: OWNER_AGENT_KEY, collectionName: "Product guides", hoursAgo: 12 * 24 },
]

// ── 6. AGENT ACTIVITY ──────────────────────────────────────────────────────
//
// WHAT THE TAB READS. `GET /api/agents/:agentId/activity` selects `timestamp`,
// `action`, `entity_type`, `entity_id`, `changes` and `metadata` from
// `kernel.audit_log` where `org_id` and `agent_id` match and `action` is in
// its own closed list, newest first. Nothing of the payload is echoed: the
// sentence a row renders comes from its ACTION alone, and the only two things
// read out of the row's json are a thread id and `metadata.runLocation`.
//
// SO THE ROW HAS TO BE THE REAL SHAPE, not a plausible one. Each action below
// is written the way its real writer writes it: `memory_fact_written` carries
// its thread in `entity_type = 'thread'` plus `entity_id` (the consolidation
// writer), the local session rows carry theirs in `metadata` beside
// `runLocation = 'local'` (the local session routes), and an event sourced
// `message.create` carries its thread and its mentions in `changes` (the audit
// event consumer). An ASK is not an action of its own: it is that same message
// row carrying an agent mention, which is how the route tells the two apart.
//
// NOTHING DANGLES. A row whose thread is not in this world is SKIPPED with a
// log line rather than written with an id that resolves to nothing, because a
// timeline row linking to a conversation that is not there renders blank and
// reads as a bug. Threads come from the support layer (by title) and routines
// from this file's own section 2, so both are real rows or the spec is not
// seeded at all.
//
// `changes` and `metadata` carry ONLY what a real writer puts there and the
// route reads. No message preview and no tool call is invented: the route
// deliberately echoes neither, so a fabricated one would be data nothing can
// ever read.
//
// NOT PRUNED. An audit row is a record of something that happened, and this
// seeder has no business deleting one it did not write. Every row converges on
// an id derived from (agent, key), so a re-seed rewrites its own and nothing
// else.

export interface ActivitySpec {
  /** An agent handle, or `owner` for the org owner's personal agent. */
  agentKey: string
  /** Unique per agent: the row's deterministic id is derived from it. */
  key: string
  action: ActivityAction
  /** How long ago it happened, in hours before the base time. */
  hoursAgo: number
  /** The title of the conversation it happened in, as the support layer wrote it. */
  threadTitle?: string
  /** The routine this tick belongs to, by the name section 2 seeds it under. */
  routineName?: string
  /** The delegate role a sub run was started with, by its seeded agent type. */
  subAgentType?: string
  /** Set on a `message.create` that is one agent asking another: the handle asked. */
  asksAgent?: string
  /** The memory file a `memory_file_edited` row edited. */
  memoryPath?: string
  /** The entry a `memory_fact_written` row wrote, by its seeded name. */
  factName?: string
}

/**
 * A few days of work, per agent.
 *
 * The owner's own agent has the shape of somebody's assistant: turns in the
 * conversation they are in, a question put to a desk, a couple of turns that
 * ran on their own machine rather than here, and an approval it had to ask
 * for. The desks have the shape of a desk: the routine ticks they own, the
 * delegate they hand a single ticket to, and the facts they wrote down.
 *
 * Every hour offset is a distinct instant, so the timeline never has to break
 * a tie and reads the same on every seed.
 */
const ACTIVITY_SPECS: ActivitySpec[] = [
  // The owner's own agent.
  {
    agentKey: OWNER_AGENT_KEY,
    key: "owner-launch-turn",
    action: "message.create",
    hoursAgo: 3,
    threadTitle: "Preamp launch readiness",
  },
  {
    agentKey: OWNER_AGENT_KEY,
    key: "owner-asks-support",
    action: "message.create",
    hoursAgo: 5,
    threadTitle: "Preamp launch readiness",
    asksAgent: "@support",
  },
  {
    agentKey: OWNER_AGENT_KEY,
    key: "owner-episode",
    action: "memory_episode_written",
    hoursAgo: 7,
    threadTitle: "Preamp launch readiness",
  },
  {
    agentKey: OWNER_AGENT_KEY,
    key: "owner-approval-asked",
    action: "approval_request.create",
    hoursAgo: 23,
    threadTitle: "Preamp launch readiness",
  },
  {
    agentKey: OWNER_AGENT_KEY,
    key: "owner-approval-decided",
    action: "approval_request.update",
    hoursAgo: 22,
    threadTitle: "Preamp launch readiness",
  },
  {
    agentKey: OWNER_AGENT_KEY,
    key: "owner-local-turn",
    action: "agent.local_session.turn",
    hoursAgo: 27,
  },
  {
    agentKey: OWNER_AGENT_KEY,
    key: "owner-local-reply",
    action: "agent.local_session.reply",
    hoursAgo: 26,
    threadTitle: "Preamp launch readiness",
  },
  {
    agentKey: OWNER_AGENT_KEY,
    key: "owner-subrun-start",
    action: "sub_run.create",
    hoursAgo: 49,
    subAgentType: "ticket-first-look",
  },
  {
    agentKey: OWNER_AGENT_KEY,
    key: "owner-subrun-advance",
    action: "sub_run.update",
    hoursAgo: 48,
    subAgentType: "ticket-first-look",
  },
  {
    agentKey: OWNER_AGENT_KEY,
    key: "owner-memory-file",
    action: "memory_file_edited",
    hoursAgo: 72,
    memoryPath: "MEMORY.md",
  },
  // The support desk.
  {
    agentKey: "@support",
    key: "support-triage-turn",
    action: "message.create",
    hoursAgo: 2,
    threadTitle: "Morning triage with the support desk",
  },
  {
    agentKey: "@support",
    key: "support-hiss-turn",
    action: "message.create",
    hoursAgo: 6,
    threadTitle: "Preamp hiss: are we replacing units we should not be?",
  },
  {
    agentKey: "@support",
    key: "support-asks-operations",
    action: "message.create",
    hoursAgo: 9,
    threadTitle: "Preamp hiss: are we replacing units we should not be?",
    asksAgent: "@operations",
  },
  {
    agentKey: "@support",
    key: "support-kb-turn",
    action: "message.create",
    hoursAgo: 11,
    threadTitle: "Knowledge gaps triage keeps hitting",
  },
  {
    agentKey: "@support",
    key: "support-backlog-tick",
    action: "routine.run_completed",
    hoursAgo: 25,
    routineName: "Morning backlog triage",
  },
  {
    agentKey: "@support",
    key: "support-first-look-tick",
    action: "routine.run_completed",
    hoursAgo: 28,
    routineName: "New ticket first look",
  },
  {
    agentKey: "@support",
    key: "support-backlog-state",
    action: "routine.status",
    hoursAgo: 49,
    routineName: "Morning backlog triage",
  },
  {
    agentKey: "@support",
    key: "support-subrun-start",
    action: "sub_run.create",
    hoursAgo: 30,
    subAgentType: "ticket-first-look",
  },
  {
    agentKey: "@support",
    key: "support-subrun-advance",
    action: "sub_run.update",
    hoursAgo: 29,
    subAgentType: "ticket-first-look",
  },
  {
    agentKey: "@support",
    key: "support-fact",
    action: "memory_fact_written",
    hoursAgo: 34,
    threadTitle: "Preamp hiss: are we replacing units we should not be?",
    factName: "plain-text-replies-only",
  },
  {
    agentKey: "@support",
    key: "support-approval-asked",
    action: "approval_request.create",
    hoursAgo: 52,
    threadTitle: "Morning triage with the support desk",
  },
  // Operations.
  {
    agentKey: "@operations",
    key: "operations-launch-turn",
    action: "message.create",
    hoursAgo: 8,
    threadTitle: "Preamp launch readiness",
  },
  {
    agentKey: "@operations",
    key: "operations-asks-finance",
    action: "message.create",
    hoursAgo: 12,
    threadTitle: "Preamp launch readiness",
    asksAgent: "@finance",
  },
  {
    agentKey: "@operations",
    key: "operations-exception-tick",
    action: "routine.run_completed",
    hoursAgo: 26,
    routineName: "Shipment exception check",
  },
  {
    agentKey: "@operations",
    key: "operations-exception-tick-prev",
    action: "routine.run_completed",
    hoursAgo: 50,
    routineName: "Shipment exception check",
  },
  {
    agentKey: "@operations",
    key: "operations-exception-state",
    action: "routine.status",
    hoursAgo: 74,
    routineName: "Shipment exception check",
  },
  {
    agentKey: "@operations",
    key: "operations-subrun-start",
    action: "sub_run.create",
    hoursAgo: 31,
    subAgentType: "shipment-status-check",
  },
  {
    agentKey: "@operations",
    key: "operations-subrun-advance",
    action: "sub_run.update",
    hoursAgo: 30.5,
    subAgentType: "shipment-status-check",
  },
  {
    agentKey: "@operations",
    key: "operations-fact",
    action: "memory_fact_written",
    hoursAgo: 55,
    threadTitle: "Preamp launch readiness",
    factName: "carrier-handover-cutoff",
  },
  {
    agentKey: "@operations",
    key: "operations-approval-asked",
    action: "approval_request.create",
    hoursAgo: 56,
    threadTitle: "Preamp launch readiness",
  },
  // Finance, which runs fewer and heavier things.
  {
    agentKey: "@finance",
    key: "finance-sweep-tick",
    action: "routine.run_completed",
    hoursAgo: 27,
    routineName: "Overdue invoice sweep",
  },
  {
    agentKey: "@finance",
    key: "finance-launch-turn",
    action: "message.create",
    hoursAgo: 29,
    threadTitle: "Preamp launch readiness",
  },
  {
    agentKey: "@finance",
    key: "finance-approval-asked",
    action: "approval_request.create",
    hoursAgo: 33,
  },
  {
    agentKey: "@finance",
    key: "finance-approval-decided",
    action: "approval_request.update",
    hoursAgo: 32,
  },
  {
    agentKey: "@finance",
    key: "finance-memory-file",
    action: "memory_file_edited",
    hoursAgo: 76,
    memoryPath: "MEMORY.md",
  },
]

/**
 * Every conversation title the timeline above points at.
 *
 * Exported because the coupling it carries is invisible from here: a spec names
 * a thread BY TITLE and a title the support layer does not write is skipped
 * silently, so the tab quietly holds fewer rows than the seed believes it wrote.
 * The whole world's own test walks this list and checks each one really exists.
 */
export const ACTIVITY_THREAD_TITLES: string[] = [
  ...new Set(ACTIVITY_SPECS.flatMap((s) => (s.threadTitle ? [s.threadTitle] : []))),
]
// ── The seeder ─────────────────────────────────────────────────────────────
//
// The rows are written by the agent factories (`seed/factories/agent/*`):
// this layer resolves each spec's handles, owners and rooms in this org and
// hands the factories typed input.

/** The agent a spec addresses by handle. Throws rather than seeding an orphan. */
function agentIdFor(org: SeedDemoOrgResult, handle: string, what: string): string {
  const agent = org.agentsByHandle[handle]
  if (!agent) throw new Error(`demo agent-native seed: no agent '${handle}' for ${what}`)
  return agent.agentId
}

/** The org's owner, or the founder for an org seeded with nobody who can sign in. */
function ownerUserIdOf(org: SeedDemoOrgResult): string {
  return org.ownerUserId ?? org.adminUserId
}

/**
 * The org's nine playbooks, converged. `author_user_id` stays NULL (org
 * shared), `owner_agent_id` is the curating desk, and the founder persona is
 * the creator, which is what lets `pruneRetiredRows` tell them apart.
 */
async function seedSkills(
  ctx: SeedContext,
  org: SeedDemoOrgResult,
  specs: DemoAgentNativeSpecs,
  log: (msg: string) => void,
): Promise<Record<string, string>> {
  const byName = await seedOrgSkills(ctx, {
    createdByUserId: org.adminUserId,
    skills: specs.skills.map((spec) => ({
      name: spec.name,
      description: spec.description,
      domain: spec.domain,
      ownerAgentId: agentIdFor(org, spec.ownerHandle, `skill '${spec.name}'`),
      requiredScopes: spec.requiredScopes,
      keywords: spec.keywords,
      apps: spec.apps,
      body: spec.body,
    })),
  })
  log(`skills: ${Object.keys(byName).length} org playbooks ready`)
  return byName
}

/**
 * The five routines, all seeded OFF, each ceiling clamped to what its owner
 * really holds: a routine whose ceiling names a scope its owner lacks is
 * paused with `paused_scope_mismatch` on its first tick.
 */
async function seedRoutines(
  ctx: SeedContext,
  org: SeedDemoOrgResult,
  specs: DemoAgentNativeSpecs,
  log: (msg: string) => void,
): Promise<Record<string, string>> {
  const byName: Record<string, string> = {}
  const scopesOf = scopeReader(ctx)
  for (const spec of specs.routines) {
    // `owner` is the account the org belongs to. A seed with no owner at all
    // (the nightly reset's probe org) falls back to the founder, who exists in
    // every seeded world.
    const ownerUserId =
      spec.ownerKey === "owner"
        ? ownerUserIdOf(org)
        : (org.peopleByKey[spec.ownerKey]?.userId ??
          (() => {
            throw new Error(`demo agent-native seed: no person '${spec.ownerKey}'`)
          })())
    byName[spec.name] = await seedRoutine(ctx, {
      createdByUserId: org.adminUserId,
      ownerScopes: await scopesOf(ownerUserId),
      routine: {
        name: spec.name,
        description: spec.description,
        kind: spec.kind,
        cron: spec.cron,
        timezone: org.timezone,
        event: spec.event,
        ownerUserId,
        ownerAgentId: agentIdFor(org, spec.ownerHandle, `routine '${spec.name}'`),
        scopes: spec.scopes,
        prompt: spec.prompt,
      },
    })
  }
  const events = specs.routines.filter((r) => r.kind === "event").length
  log(
    `routines: ${Object.keys(byName).length} seeded OFF ` +
      `(${events} event driven, ${specs.routines.length - events} scheduled)`,
  )
  return byName
}

/** The support scenario's routine: it drafts the reply to every new ticket (gated). */
export const SUPPORT_SCENARIO_ROUTINE = "Draft a reply to new tickets"
/** The sales scenario's routine (the tour's "switch it on" beat names it). */
export const PROSPECT_SCENARIO_ROUTINE = "Research interested prospects"

/** The Kestrel 6's list price and its dealer discount per unit, by quantity tier (minor units). */
const KESTREL_6_PRICE_MINOR = 89900
const DEALER_TIERS = [
  { units: "1 to 5", percent: 25 },
  { units: "6 to 15", percent: 32 },
  { units: "16 to 40", percent: 38 },
  { units: "41 or more", percent: 42 },
] as const

/**
 * The sales routine's instructions. Written for a small model that follows
 * steps literally: the exact tool names, the order, the @ref forms and the
 * prices are spelled out, and there is one path per case.
 */
export function prospectRoutinePrompt(issuerProfileId: string): string {
  const tiers = DEALER_TIERS.map((t) => {
    const perUnit = Math.round((KESTREL_6_PRICE_MINOR * t.percent) / 100)
    return `${t.units} units: ${t.percent}% off (EUR ${(perUnit / 100).toFixed(2)} per unit), so discount_minor = quantity x ${perUnit}`
  }).join("; ")
  return (
    "An email has just arrived from a prospect. The event data names the message, its conversation and its sender.\n\n" +
    "You prepare ONE request that I approve once: the CRM record, then a quote, then the reply with the quote attached. " +
    "Each tool below waits for my approval; it returns `outputs` with @ref tokens. Do NOT wait for an approval between " +
    "the steps: make the next call at once, with the token copied exactly where the step says.\n\n" +
    "1. Read the email. Look the sender up in the CRM with api-connector__connector_read, reading only: by their " +
    "email first, then their company by its domain, then by its name.\n" +
    "2. If neither the sender nor their company is in the CRM, read their company's website with web_fetch, at " +
    "exactly https://DOMAIN/ where DOMAIN is the part of the sender's address after the @ (for ana@example.com, " +
    "fetch https://example.com/), with nothing after the last slash. Note what the company does, its size and any " +
    "news that bears on the request. If the fetch fails, go on without it and say so in the brief.\n" +
    "3. CRM record. A NEW sender: call api-connector__connector_write with connection crm, operation " +
    "create_contact: the person with their company in the same call (companyName and companyDomain when the " +
    "company is new too, and companyIndustry: one line on what it does, from its website). Its result has " +
    "outputs.record_id, a token like @ref:<id>:record_id. A sender ALREADY in the CRM: make no CRM call; their " +
    "CRM id is the id the read returned.\n" +
    "4. Quote. Call invoicing__quote_create_and_issue with:\n" +
    `- issuer_profile_id: ${issuerProfileId}\n` +
    "- counterparty: legal_name (their company), country (ISO code, from their address), address (from their " +
    "email signature or website), email (the sender's address)\n" +
    '- customer_reference: for a new sender, the record_id token from step 3, whole ("@ref:<id>:record_id"); ' +
    "for a sender already in the CRM, their CRM id\n" +
    `- items: one line for the product they ask about. Our recorder is the Kestrel 6 Field Recorder at unit_price_minor ${KESTREL_6_PRICE_MINOR}; ` +
    "quote it when they name it or name no model (say in the reply that the Kestrel 10 and the Kestrel Pocket " +
    "exist too). quantity: the number of units they ask for. Dealer discount by quantity: " +
    `${tiers}. Put that amount in the line's discount_minor (example: 40 units, discount_minor 1366480). ` +
    "Amounts in minor units are cents: in the reply and the brief, write them in euros (89900 is EUR 899.00).\n" +
    "Its result has outputs.number and outputs.pdf_file_id (tokens like @ref:<id>:number).\n" +
    "5. Reply. Call mail__reply with conversationId (from the event data), attachments: [the pdf_file_id token " +
    "from step 4, whole], and a textBody that answers their request: the quote's number written as the number " +
    "token from step 4, the unit price, their discount, a lead time of 2 to 3 weeks, payment at 30 days, and one " +
    "line that shows you know their company.\n" +
    "Then stop: the run waits for my decision and comes back to you with the results.\n" +
    "6. Once I have decided, close with a short brief: who they are, what their company does (say where you " +
    "learned it), what they want, what the CRM knew about them, and what became of the record, the quote (its " +
    "number) and the reply. If a step failed, propose the corrected calls as the error says instead. Post it in the discussion of their Liaison contact, so the team finds it there " +
    "(kernel__contacts_search by their email, then kernel__threads_reply with its contactId), and end with it as " +
    "your answer.\n\n" +
    "If a call is refused, read its error, fix the call as it says and make it again. Report only what the results show."
  )
}

/**
 * The routines a tailored seed's scenarios use, seeded OFF like every other.
 * The support one is switched on by `enableScenarioRoutine` once the support
 * part has written every seeded ticket (so no seeded ticket fires it); the
 * prospect one is switched on by the visitor, in the sales scenario.
 */
async function seedScenarioRoutines(
  ctx: SeedContext,
  org: SeedDemoOrgResult,
  parts: ReadonlySet<DemoSeedPart>,
  log: (msg: string) => void,
): Promise<Record<string, string>> {
  const byName: Record<string, string> = {}
  const scopesOf = scopeReader(ctx)
  const write = async (spec: RoutineSeed & { kind: "event" }) => {
    byName[spec.name] = await seedRoutine(ctx, {
      createdByUserId: org.adminUserId,
      ownerScopes: await scopesOf(spec.ownerUserId),
      routine: spec,
    })
  }

  if (parts.has("support-routine")) {
    const owner = org.peopleByKey.amina
    if (!owner) throw new Error("demo agent-native seed: no support lead for the support routine")
    await write({
      name: SUPPORT_SCENARIO_ROUTINE,
      description:
        "The moment a ticket is opened: read it and the customer's history, leave a note for the team and draft the reply for a person to approve.",
      kind: "event",
      event: "tickets:ticket:create",
      ownerUserId: owner.userId,
      ownerAgentId: agentIdFor(org, "@support", `routine '${SUPPORT_SCENARIO_ROUTINE}'`),
      // The reply draft is its own scope: without it the routine read the
      // ticket, wrote its note and found no reply tool.
      scopes: [
        "tickets:tickets:read",
        "tickets:tickets:write",
        "tickets:tickets:reply",
        "tickets:inboxes:read",
        "knowledge:documents:read",
        "kernel:contacts:read",
      ],
      prompt:
        "A ticket has just been opened. The event data names it. Act only on a customer's " +
        "inbound message; stand down on anything else.\n\n" +
        "Read the ticket, the customer's earlier tickets and orders, and the knowledge base " +
        "article that answers it. Then do exactly two things on this ticket:\n" +
        "1. Add ONE internal note for the team: your verdict in bold (a known issue, a user " +
        "error, a suspected bug), the sources you used, and a line starting TODO HUMAN only " +
        "when a person must check something first.\n" +
        "2. Draft ONE reply to the customer with the ticket reply tool, in their language: " +
        "specific to what they wrote, under 120 words, with the next step. It waits for a " +
        "person's approval.\n\n" +
        "Never change the ticket's status, assignee or follow-up date, and never say something " +
        "was sent.",
      eventFilter: null,
      reportThreadId: null,
    })
  }

  if (parts.has("prospect-routine")) {
    const ownerUserId = ownerUserIdOf(org)
    const ownerAgentId = await personalAgentOf(ctx, ownerUserId)
    if (!ownerAgentId) throw new Error("demo agent-native seed: the owner has no personal agent")
    const prospectContactId = await contactIdByEmail(ctx, SCENARIO_PROSPECT.email)
    // The brief reaches the owner where they talk to their agent: its report
    // is posted in the owner's direct messages with it (the scenario's brief
    // beat points there), not only in the routine's own output thread.
    const reportThreadId = await agentDmWith(ctx, ownerUserId, ownerAgentId)
    // The quote comes from the sales profile: no shop, gated from the first
    // cent, its id named in the prompt so the routine never picks between two
    // profiles in a workspace that seeds the shop's as well.
    const issuerProfileId = await seedSalesIssuerProfile(org.orgId, ctx.now)
    await write({
      reportThreadId,
      name: PROSPECT_SCENARIO_ROUTINE,
      description:
        "When an interested prospect writes in: check the CRM, read up on a new one's company, then prepare their CRM record, a quote and the reply with the quote attached, as one request I approve once.",
      kind: "event",
      event: "mail:message:create",
      ownerUserId,
      ownerAgentId,
      scopes: [
        "mail:conversations:read",
        // The reply draft (mail's `reply`, gated): `mail:messages:send` named no
        // capability, so the routine briefed and never staged the reply.
        "mail:conversations:write",
        // The reply reads the conversation's mailbox account before it stages
        // anything (ROUTINE_TOOL_RUN_READS, skills-routines-tools.ts): without
        // it every reply failed with Conversation account not found, and the
        // compose fallback with No mailbox matches that accountId.
        "mail:accounts:read",
        // The sender's Liaison contact, whose discussion gets the brief.
        "kernel:contacts:read",
        "api-connector:read",
        // The CRM record (connector_write, gated: a person approves it).
        "api-connector:write",
        // The quote (quote_create_and_issue, gated by the profile's threshold 0)
        // and the reads it may need to check a document or a profile.
        "invoicing:documents:write",
        "invoicing:documents:read",
        "invoicing:settings:read",
        // The brief in the contact's discussion (kernel__threads_reply with
        // contactId): a post, so no approval.
        "kernel:threads:write",
        // Step 2 reads the sender's website: the bare home page of the
        // sender's own domain, which runs without an approval although an
        // outside email started the run (web-fetch-sender-root.ts; any other
        // address still waits for one). Without web access the routine called
        // a fetch it did not hold. A demo org answers the fictional domain from
        // its in-process fixture (demo/world/web-fetch-fixture.ts).
        "kernel:agent:web",
      ],
      prompt: prospectRoutinePrompt(issuerProfileId),
      eventFilter: prospectContactId ? { fromContactIds: [prospectContactId] } : null,
    })
  }

  const names = Object.keys(byName)
  if (names.length > 0) log(`routines: scenario routines seeded OFF (${names.join(", ")})`)
  return byName
}

/**
 * Switch a seeded routine on and open its event subscription. The support
 * part's LAST step, after every seeded ticket is written.
 */
export async function enableScenarioRoutine(
  org: SeedDemoOrgResult,
  routineId: string,
): Promise<void> {
  await enableEventRoutine(org.orgId, routineId)
}

/** The two delegate roles, their ceilings clamped to the org admin's own scopes. */
async function seedSubAgents(
  ctx: SeedContext,
  org: SeedDemoOrgResult,
  specs: DemoAgentNativeSpecs,
  log: (msg: string) => void,
): Promise<string[]> {
  const seeded = await seedSubAgentRoles(ctx, {
    creatorUserId: org.adminUserId,
    roles: specs.subAgents,
  })
  log(`sub agents: ${seeded.length} delegate roles ready`)
  return seeded
}

/**
 * The memory each desk has written, as the org admin (the role agent memory
 * policy requires `kernel:agents:admin`), addressed at each DESK's tree.
 */
async function seedMemory(
  ctx: SeedContext,
  org: SeedDemoOrgResult,
  specs: DemoAgentNativeSpecs,
  log: (msg: string) => void,
): Promise<string[]> {
  await seedMemoryEntries(ctx, {
    writerUserId: org.adminUserId,
    entries: specs.memory.map((spec) => ({
      ownerAgentId: agentIdFor(org, spec.ownerHandle, `memory '${spec.name}'`),
      type: spec.type,
      name: spec.name,
      description: spec.description,
      content: spec.content,
    })),
  })
  const keys = specs.memory.map((spec) => `${spec.ownerHandle}:${spec.type}/${spec.name}`)
  log(
    `agent memory: ${keys.length} entries across ${new Set(specs.memory.map((m) => m.ownerHandle)).size} desks`,
  )
  return keys
}

/**
 * The remembered conversations. A spec whose agent or room this org lacks is
 * logged and skipped (the rooms belong to the support layer). An episode on
 * the owner's own agent is written as the owner: `agent_memory_insert` admits
 * a write to a PERSONAL agent's memory only from the person it belongs to.
 */
async function seedEpisodes(
  ctx: SeedContext,
  org: SeedDemoOrgResult,
  specs: DemoAgentNativeSpecs,
  log: (msg: string) => void,
): Promise<string[]> {
  const ownerUserId = ownerUserIdOf(org)
  const ownerAgentId = await personalAgentOf(ctx, ownerUserId)
  const rooms = await threadsByTitle(ctx)
  const seeds: EpisodeSeed[] = []
  const keys: string[] = []
  const skipped: string[] = []
  for (const spec of specs.episodes) {
    const owner = spec.agentKey === OWNER_AGENT_KEY
    const agentId = owner
      ? ownerAgentId
      : agentIdFor(org, spec.agentKey, `episode in '${spec.threadTitle}'`)
    const room = rooms.get(spec.threadTitle)
    if (!agentId || !room) {
      skipped.push(`${spec.agentKey}/${spec.threadTitle}`)
      continue
    }
    seeds.push({
      agentId,
      ownerLegacyUserId: owner ? ownerUserId : null,
      writerUserId: owner ? ownerUserId : org.adminUserId,
      thread: room,
      daysAgo: spec.daysAgo,
      body: spec.body,
      checkpoint: spec.checkpoint,
    })
    keys.push(spec.agentKey)
  }
  const paths = await seedRememberedConversations(ctx, seeds)
  const episodeKeys = paths.map((path, i) => `${keys[i]}:${path}`)
  log(
    `remembered conversations: ${episodeKeys.length} episodes across ` +
      `${new Set(specs.episodes.map((e) => e.agentKey)).size} agents` +
      (skipped.length > 0 ? ` (skipped ${skipped.length}: ${skipped.join(", ")})` : ""),
  )
  return episodeKeys
}

/**
 * THE OWNER'S OWN ASSISTANT IS SOMEBODY, not a blank page.
 *
 * The personal agent every account gets is created with no purpose and no seat
 * anywhere, so the first thing the owner saw on its Overview was "No purpose
 * recorded yet" and "Not in any channel yet": a page that reads as broken on a
 * demo whose whole point is that the agents are working colleagues. The role
 * agents get both from `world.ts`; the owner's does not exist until their
 * account does, so it is written here.
 */
const OWNER_AGENT_PURPOSE =
  "Keeps the owner's day in order: what needs a decision, what is waiting on " +
  "somebody else and what can wait."

/** The rooms the owner's assistant sits in, by thread title (the support layer
 *  owns the rows, so they are matched by name exactly as collections are). */
const OWNER_AGENT_CHANNEL_TITLES = [
  "Preamp launch readiness",
  "Preamp hiss: are we replacing units we should not be?",
] as const

/** The `products` world's agent native layer: today's Resonant Audio Labs. */
export const PRODUCTS_AGENT_NATIVE_SPECS: DemoAgentNativeSpecs = {
  skills: SKILL_SPECS,
  routines: ROUTINE_SPECS,
  subAgents: SUB_AGENT_SPECS,
  memory: MEMORY_SPECS,
  episodes: EPISODE_SPECS,
  knowledgePointers: KNOWLEDGE_POINTER_SPECS,
  activity: ACTIVITY_SPECS,
  ownerAgentPurpose: OWNER_AGENT_PURPOSE,
  ownerAgentChannelTitles: OWNER_AGENT_CHANNEL_TITLES,
  scenarioRoutines: true,
}

async function seedOwnerAgentPresence(
  ctx: SeedContext,
  org: SeedDemoOrgResult,
  specs: DemoAgentNativeSpecs,
  log: (msg: string) => void,
): Promise<{ purpose: boolean; channels: number }> {
  const agentId = await personalAgentOf(ctx, ownerUserIdOf(org))
  if (!agentId) {
    log("owner agent: this org has no owner personal agent, so there is nothing to describe")
    return { purpose: false, channels: 0 }
  }
  await describeAgent(ctx, agentId, specs.ownerAgentPurpose)
  const seated = await seatAgentInThreads(ctx, agentId, specs.ownerAgentChannelTitles)
  const missing = specs.ownerAgentChannelTitles.length - seated
  log(
    `owner agent: purpose set, seated in ${seated} channels` +
      (missing > 0 ? ` (${missing} named room absent from this org)` : ""),
  )
  return { purpose: true, channels: seated }
}

/**
 * The knowledge collections each desk reads. Collections are the SUPPORT
 * layer's rows and are matched by name, so this skips rather than throws when
 * one is absent: a tab with two of its three rows is still a tab, while a
 * throw would take the skills and the routines down with it.
 */
async function seedKnowledgePointers(
  ctx: SeedContext,
  org: SeedDemoOrgResult,
  specs: DemoAgentNativeSpecs,
  log: (msg: string) => void,
): Promise<string[]> {
  const ownerAgentId = await personalAgentOf(ctx, ownerUserIdOf(org))
  const collectionIdByName = await knowledgeCollectionsByName(ctx)
  const ids: string[] = []
  const skipped: string[] = []
  for (const spec of specs.knowledgePointers) {
    const collectionId = collectionIdByName.get(spec.collectionName)
    const agentId = !collectionId
      ? null
      : spec.agentKey === OWNER_AGENT_KEY
        ? ownerAgentId
        : agentIdFor(org, spec.agentKey, `knowledge pointer '${spec.collectionName}'`)
    if (!collectionId || !agentId) {
      skipped.push(`${spec.agentKey} -> ${spec.collectionName}`)
      continue
    }
    ids.push(await seedKnowledgePointer(ctx, { agentId, collectionId, hoursAgo: spec.hoursAgo }))
  }
  log(
    `agent knowledge: ${ids.length} pointers across ` +
      `${new Set(specs.knowledgePointers.map((s) => s.agentKey)).size} agents` +
      (skipped.length > 0 ? ` (skipped ${skipped.length}: ${skipped.join(", ")})` : ""),
  )
  return ids
}

/**
 * The activity timeline each agent has. A spec naming a thread or a routine
 * this world does not have is skipped with a log line: a dangling reference is
 * worse than a shorter timeline.
 */
async function seedActivity(
  ctx: SeedContext,
  org: SeedDemoOrgResult,
  specs: DemoAgentNativeSpecs,
  routineIdsByName: Record<string, string>,
  log: (msg: string) => void,
): Promise<string[]> {
  const ownerUserId = ownerUserIdOf(org)
  const ownerAgentId = await personalAgentOf(ctx, ownerUserId)
  const rooms = await threadsByTitle(ctx)
  const ids: string[] = []
  const skipped: string[] = []
  for (const spec of specs.activity) {
    const agentId =
      spec.agentKey === OWNER_AGENT_KEY
        ? ownerAgentId
        : agentIdFor(org, spec.agentKey, `activity '${spec.key}'`)
    const threadId = spec.threadTitle ? (rooms.get(spec.threadTitle)?.id ?? null) : null
    const routineId = spec.routineName ? (routineIdsByName[spec.routineName] ?? null) : null
    if (!agentId || (spec.threadTitle && !threadId) || (spec.routineName && !routineId)) {
      skipped.push(spec.key)
      continue
    }
    ids.push(
      await seedActivityRow(ctx, {
        key: spec.key,
        action: spec.action,
        agentId,
        personUserId: ownerUserId,
        hoursAgo: spec.hoursAgo,
        threadId,
        routineId,
        asks: spec.asksAgent
          ? {
              agentId: agentIdFor(org, spec.asksAgent, `activity '${spec.key}'`),
              handle: spec.asksAgent,
            }
          : null,
        subAgentType: spec.subAgentType,
        memoryPath: spec.memoryPath,
        factName: spec.factName,
      }),
    )
  }
  log(
    `agent activity: ${ids.length} timeline rows across ` +
      `${new Set(specs.activity.map((s) => s.agentKey)).size} agents` +
      (skipped.length > 0 ? ` (skipped ${skipped.length}: ${skipped.join(", ")})` : ""),
  )
  return ids
}

/**
 * Delete the skills and routines a PREVIOUS version of this file seeded and
 * the current one no longer declares: a dropped playbook would otherwise sit
 * in every org ever seeded with it, still surfacing on `skill_search`.
 *
 * The rows are identified by `created_by_user_id`, which every write above
 * stamps with the FOUNDER persona. That account is passwordless by
 * construction (see `seed-org.ts`), so nothing but this seeder can have created
 * a row under it. Sub agent roles and memory entries are deliberately NOT
 * pruned: neither table carries a creator column to tell a seeded row from a
 * visitor's own. A demo box's nightly reset clears them outright.
 */
async function pruneRetiredRows(
  ctx: SeedContext,
  org: SeedDemoOrgResult,
  specs: DemoAgentNativeSpecs,
  log: (msg: string) => void,
): Promise<void> {
  const removed = await pruneRetiredSkillsAndRoutines(ctx, {
    createdByUserId: org.adminUserId,
    skillNames: specs.skills.map((s) => s.name),
    routineNames: [...specs.routines.map((r) => r.name), ...(specs.layerRoutineNames ?? [])],
  })
  if (removed.length > 0)
    log(`agent native: retired ${removed.length} row(s): ${removed.join(", ")}`)
}

/**
 * Seed the agent native surface of one demo org: its playbooks, its routines,
 * its delegate roles and its agents' memory.
 *
 * Idempotent on CONTENT: a re-seed restores a drifted skill body and a drifted
 * routine definition, and duplicates nothing.
 */
export async function seedDemoAgentNative(
  org: SeedDemoOrgResult,
  opts: SeedDemoAgentNativeOptions,
): Promise<SeedDemoAgentNativeResult> {
  const log = opts.log ?? (() => {})
  // Every dated row below (a knowledge pointer's date, a timeline row's
  // instant) is a fixed offset from it, so two runs are identical.
  const ctx = seedContext({ orgId: org.orgId, now: opts.baseTime, log })
  const specs = opts.specs ?? PRODUCTS_AGENT_NATIVE_SPECS

  await pruneRetiredRows(ctx, org, specs, log)
  const skillIdsByName = await seedSkills(ctx, org, specs, log)
  const routineIdsByName = await seedRoutines(ctx, org, specs, log)
  if (opts.scenarioParts && specs.scenarioRoutines) {
    Object.assign(routineIdsByName, await seedScenarioRoutines(ctx, org, opts.scenarioParts, log))
  }
  const subAgentTypes = await seedSubAgents(ctx, org, specs, log)
  const memoryKeys = await seedMemory(ctx, org, specs, log)
  const ownerPresence = await seedOwnerAgentPresence(ctx, org, specs, log)
  // After the owner's seats: an episode is keyed on the owner's personal agent,
  // which `seedOwnerAgentPresence` is what makes worth opening at all.
  const episodeKeys = await seedEpisodes(ctx, org, specs, log)
  const knowledgePointerIds = await seedKnowledgePointers(ctx, org, specs, log)
  // After the routines: a tick row names the routine it ran, and section 2 is
  // where that id comes from.
  const activityRowIds = await seedActivity(ctx, org, specs, routineIdsByName, log)

  // Read back what actually landed rather than counting what was asked for: a
  // count taken from the spec list cannot see a row that failed to converge.
  // The two tab layers are counted by exactly the ids computed, not the table.
  const landed = await agentLayerCounts(ctx, {
    pointerIds: knowledgePointerIds,
    activityIds: activityRowIds,
  })

  return {
    orgId: org.orgId,
    skillIds: Object.values(skillIdsByName),
    skillIdsByName,
    routineIds: Object.values(routineIdsByName),
    routineIdsByName,
    subAgentTypes,
    memoryKeys,
    episodeKeys,
    knowledgePointerIds,
    activityRowIds,
    counts: {
      skills: landed.skills,
      skillIndexRows: landed.skillIndexRows,
      routines: Object.keys(routineIdsByName).length,
      routinesDisabled: landed.routinesDisabled,
      subAgents: subAgentTypes.length,
      memoryEntries: memoryKeys.length,
      rememberedConversations: landed.episodes,
      knowledgePointers: landed.pointers,
      activityRows: landed.activity,
      ownerAgentChannels: ownerPresence.channels,
    },
  }
}
