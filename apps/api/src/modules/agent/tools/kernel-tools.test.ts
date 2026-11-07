// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { THREAD_MESSAGE_MAX_CHARS, THREAD_TITLE_MAX_CHARS } from "@liaison/shared"
import { z } from "zod"
import { sql } from "~/db"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { byokEncryptionKey } from "~/lib/env"
import {
  agentInstructionsRegistry,
  skillRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"

const ORG_ID = "00000000-0000-0000-0000-000000da0001"

/**
 * Everything the model actually reads about one tool at the moment it acts: the
 * description it is shown on every step, the hint its RESULT carries back, and
 * the per-argument guidance in its schema. A behavioural rule is guarded on this
 * surface, not on the description alone: a hot description is a 240 char budget,
 * so a rule that no longer fits there has MOVED to the result or the argument,
 * it has not been dropped.
 */
async function affordance(name: string, orgId: string = ORG_ID): Promise<string> {
  const entry = toolRegistry.get([orgId, "kernel", name])
  if (!entry) return ""
  const { KERNEL_RESULT_HINTS } = await import("./kernel-tools")
  const params = (entry as { params?: unknown }).params
  const schema = params ? JSON.stringify(z.toJSONSchema(params as z.ZodType)) : ""
  return `${entry.description}\n${KERNEL_RESULT_HINTS[name] ?? ""}\n${schema}`
}

describe("kernel tool registration", () => {
  beforeAll(async () => {
    const { registerKernelAgentTools } = await import("./kernel-tools")
    await registerKernelAgentTools(ORG_ID)
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG_ID])
    skillRegistry.deleteByPrefix([ORG_ID])
    agentInstructionsRegistry.deleteByPrefix([ORG_ID])
    await sql`DELETE FROM kernel.role_scope_grants WHERE role_id IN (SELECT id FROM kernel.roles WHERE org_id = ${ORG_ID})`
    await sql`DELETE FROM kernel.user_roles WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.roles WHERE org_id = ${ORG_ID}`
  })

  it("registers all 25 kernel agent tools (23 domain + tool_search + spawn_agent)", async () => {
    const expectedTools = [
      "user_memory_get",
      "user_memory_set",
      "user_memory_delete",
      "memory_view",
      "memory_create",
      "memory_str_replace",
      "memory_insert",
      "memory_delete",
      "memory_rename",
      "memory_search",
      "memory_open",
      // P4c-T49: one episode body by id. Episodes are fetched, never fed.
      "memory_episode",
      "web_search",
      "web_fetch",
      "threads_list",
      "threads_search",
      "threads_read",
      "threads_create",
      "threads_reply",
      "contacts_search",
      "contacts_read",
      "contacts_write",
      "contacts_merge",
      "contacts_share",
      "approval_update_payload",
      "tool_search",
      // Media-analysis tool — gated by `kernel:files:analyze`. Surfaces a
      // diagnostic summary of a customer's image/video attachment.
      "analyze_media",
      // Sub-agent dispatch primitive. Always registered; gated at
      // `buildToolSet` time to only surface when an installed app declares
      // the `agent.spawn` capability.
      "spawn_agent",
    ]

    console.log("\n=== Kernel tools registered ===")
    for (const name of expectedTools) {
      const entry = toolRegistry.get([ORG_ID, "kernel", name])
      expect(entry).toBeDefined()
      expect(entry!.description.length).toBeGreaterThan(50)
      expect(typeof entry!.handler).toBe("function")
      console.log(
        `  ${name}: ${entry!.description.slice(0, 80)}... (${entry!.description.length} chars)`,
      )
    }
  })

  // P4m-T11: the file verbs join the registry. view, create, str_replace, insert and search are in
  // the STABLE tool set from the first turn (I7): a tools array change already invalidates the
  // cached prefix, so those are never discovered mid session. delete, rename and open load on
  // discovery.
  const MEMORY_VERBS = [
    "memory_view",
    "memory_create",
    "memory_str_replace",
    "memory_insert",
    "memory_delete",
    "memory_rename",
  ]

  it("every memory verb declares a taint posture", () => {
    for (const name of MEMORY_VERBS) {
      const entry = toolRegistry.get([ORG_ID, "kernel", name])
      expect(entry).toBeDefined()
      const readOnly = entry!.readOnly === true
      const writes = entry!.writesToTable === "kernel.agent_memory"
      expect(readOnly || writes).toBe(true)
    }
  })

  it("user_memory_delete declares writesToTable", () => {
    const entry = toolRegistry.get([ORG_ID, "kernel", "user_memory_delete"])
    expect(entry).toBeDefined()
    expect(entry!.writesToTable).toBe("kernel.agent_memory")
  })

  it("the everyday memory verbs are in the stable set; the rarer ones and the typed trio load on discovery", () => {
    // view, create, str_replace, insert and search are the stable tool set from the first turn: a
    // tools-array change invalidates the cached prefix, so one appearing mid session costs a full
    // cache miss. delete, rename and open are rarer verbs, found by tool_search. The three
    // typed user_memory_* entries are the older path-free surface the file verbs supersede: hidden
    // from the agent, still registered for a screen or a parked approval.
    for (const name of [
      "memory_view",
      "memory_create",
      "memory_str_replace",
      "memory_insert",
      "memory_search",
    ]) {
      expect(Boolean(toolRegistry.get([ORG_ID, "kernel", name])!.deferLoading)).toBe(false)
    }
    for (const name of ["memory_delete", "memory_rename", "memory_open"]) {
      expect(toolRegistry.get([ORG_ID, "kernel", name])!.deferLoading).toBe(true)
    }
    for (const name of ["user_memory_get", "user_memory_set", "user_memory_delete"]) {
      const entry = toolRegistry.get([ORG_ID, "kernel", name])!
      expect(entry.deferLoading).toBe(true)
      expect(entry.agentVisible).toBe(false)
    }
  })

  it("web_search teaches ITERATE-don't-abandon for a multi-subject research task (competitor-price-undercut-analysis)", async () => {
    // competitor-price-undercut-analysis smoke b14ff1d7: the agent ran ONE broad query, got junk back,
    // then abandoned the web-research half and hand-waved "competitors generally sit in a premium tier"
    // with ZERO sourced prices. The fix lives in the affordance layer (the web_search description): a
    // task naming specific subjects gets a query PER subject, a weak first query gets REFORMULATED, and a
    // vague placeholder substituted for the researched figures is forbidden. Guard it so an edit can't
    // silently drop it and re-flake the scenario.
    const entry = toolRegistry.get([ORG_ID, "kernel", "web_search"])
    expect(entry).toBeDefined()
    const desc = (await affordance("web_search")).toLowerCase()
    expect(desc).toContain("iterate")
    expect(desc.includes("query per") || desc.includes("targeted query per")).toBe(true)
    expect(desc.includes("reformulate")).toBe(true)
    expect(desc.includes("do not give up") || desc.includes("don't abandon")).toBe(true)
    // Forbid substituting a vague placeholder for the actual researched figures.
    expect(desc.includes("vague placeholder")).toBe(true)
    // Source URLs are required IN THE CHAT REPLY when the research IS the reply (not only saved records),
    // and NO figure may be reported that isn't in a returned result (the Gridwell-from-memory failure).
    expect(desc.includes("chat reply")).toBe(true)
    expect(desc.includes("never report a figure not in a returned result")).toBe(true)
    expect(desc.includes("from memory")).toBe(true)
  })

  it("approvals_list steers READ-ONLY governance: cannot self-approve, user decides in the UI (BL-128)", async () => {
    // The approval-inbox-sweep scenario requires the agent to enumerate the pending queue AND state
    // that it cannot approve on the user's behalf — they must approve/edit/deny each item in the UI.
    // That governance framing lives in the tool description (the affordance layer); guard it here so a
    // future edit can't silently drop it and re-flake the scenario.
    const entry = toolRegistry.get([ORG_ID, "kernel", "approvals_list"])
    expect(entry).toBeDefined()
    const desc = (await affordance("approvals_list")).toLowerCase()
    expect(desc).toContain("read-only")
    expect(desc.includes("cannot approve")).toBe(true)
    expect(desc.includes("ui")).toBe(true)
    // Must forbid claiming an approval was actioned (the weak-model false-claim failure mode).
    expect(desc.includes("never")).toBe(true)
  })

  it("approvals_list is gated on kernel:approvals:read, NOT kernel:users:admin (approve-gated-refund-and-replacement-batch)", () => {
    // Listing your OWN approval inbox is a self-filtering READ (listApprovals returns only items you
    // are eligible to decide — in the notify-set AND holding the item's `<app>:approve` scope), so the
    // tool gate must be the canonical "Read approval requests" scope, NOT an org-admin scope. The prior
    // `kernel:users:admin` gate wrongly hid the approval-inbox triage from a non-admin approver like
    // Nadia (ops_lead), who holds shopify/invoicing/tickets :approve but is not a kernel admin — so the
    // tool never surfaced for her and her approval-queue scenario was scope-blocked before any read.
    const entry = toolRegistry.get([ORG_ID, "kernel", "approvals_list"])
    expect(entry).toBeDefined()
    expect(entry!.requiredScopes).toEqual(["kernel:approvals:read"])
    expect(entry!.requiredScopes).not.toContain("kernel:users:admin")
  })

  it("contacts_write mandates a dedupe contacts_search before creating (BL-114)", async () => {
    // promote-email-sender-to-contact requires the agent to confirm a contact does not already exist
    // (contacts_search) before creating — otherwise it creates duplicates. That discipline lives in
    // the tool description; guard it so a future edit can't drop it.
    const entry = toolRegistry.get([ORG_ID, "kernel", "contacts_write"])
    expect(entry).toBeDefined()
    const desc = (await affordance("contacts_write")).toLowerCase()
    expect(desc.includes("contacts_search")).toBe(true)
    expect(desc.includes("duplicate")).toBe(true)
  })

  it("memory_create steers ORG/SHARED business facts to capture_business_knowledge (first-run-org-bootstrap)", async () => {
    // first-run-org-bootstrap-resonant-audio-labs: the weak model recorded "support@… is our shared
    // inbox" into PRIVATE memory instead of an org-visible Knowledge doc via
    // capture_business_knowledge — failing the rubric's "a Knowledge doc records the shared inbox"
    // clause (the fact was invisible to the team). The disambiguation lives in the tool text (the
    // affordance layer, operator-preferred over a broad system.md edit); guard both ends here so a
    // future edit can't drop the steering and re-flake the scenario.
    const mem = toolRegistry.get([ORG_ID, "kernel", "memory_create"])
    expect(mem).toBeDefined()
    const memText = (await affordance("memory_create")).toLowerCase()
    // memory_create must (a) say its memory is PRIVATE to the operator / not org-visible, and
    // (b) route a "write down our shared inbox / company fact" to capture_business_knowledge.
    expect(memText).toContain("private")
    expect(memText).toContain("capture_business_knowledge")
    expect(memText.includes("shared") && memText.includes("inbox")).toBe(true)

    // capture_business_knowledge must POSITIVELY claim the shared-inbox / company-fact "write down"
    // request, naming memory_create as the wrong home so the model pulls toward Knowledge.
    const kb = toolRegistry.get([ORG_ID, "kernel", "capture_business_knowledge"])
    expect(kb).toBeDefined()
    const kbDesc = (await affordance("capture_business_knowledge")).toLowerCase()
    expect(kbDesc).toContain("memory_create")
    expect(kbDesc.includes("shared") && kbDesc.includes("inbox")).toBe(true)
    expect(kbDesc.includes("write down") || kbDesc.includes("record")).toBe(true)
  })

  it("capture_business_knowledge is GATED with title/body editable on the approval card (org-wide write)", async () => {
    // Product default: this always writes an ORGANIZATION-scoped Knowledge doc,
    // so it must park a human approval (tighten-only vs policies), and the card
    // must allow editing title/body before approving.
    const kb = toolRegistry.get([ORG_ID, "kernel", "capture_business_knowledge"])
    expect(kb).toBeDefined()
    expect((kb as { gated?: boolean }).gated).toBe(true)
    const { approvalEditableFieldsRegistry } = await import("~/modules/apps/app-registries")
    const fields = approvalEditableFieldsRegistry.get([
      ORG_ID,
      "kernel",
      "capture_business_knowledge",
    ])
    expect(fields?.map((f) => f.field).sort()).toEqual(["body", "title"])
  })

  // SEARCH BEFORE YOU CAPTURE. capture_business_knowledge writes an org-wide
  // document; without this steer an agent authored a doc on a subject the
  // knowledge base already covered and the duplicate reached a human approver.
  it("capture_business_knowledge tells the agent to check for an existing doc and update it instead", async () => {
    // The rule is about what to put in `title`, so it rides on that argument.
    const surface = await affordance("capture_business_knowledge")
    expect(surface).toContain("SEARCH BEFORE YOU CAPTURE")
    expect(surface).toContain("find_by_title")
    expect(surface.toLowerCase()).toContain("update that one instead")
  })

  it("capture_business_knowledge declares a STAGE-TIME preflight (a gated call is never parked with missing data)", () => {
    // execute-tool runs `tool.preflight` BEFORE createApprovalRequest, so a
    // capture the Knowledge create guard would reject is refused in the agent's
    // loop instead of erroring in the approver's hands on approve.
    const kb = toolRegistry.get([ORG_ID, "kernel", "capture_business_knowledge"])
    expect(typeof (kb as { preflight?: unknown }).preflight).toBe("function")
  })

  it("contacts_write is GATED for agents, internal, with a preflight and a card; the description says a pending edit is not done", async () => {
    // Owner decision: an agent's contact edit is a write, so it waits for a person by default. An
    // admin switches that off with an auto-approve policy on kernel:contacts_write (any gated tool's
    // switch); `internal` lets such a policy cover enrichment turns that read a web page.
    const write = toolRegistry.get([ORG_ID, "kernel", "contacts_write"])
    expect(write).toBeDefined()
    expect(write!.trustBoundary).toBe("user")
    expect(write!.gated).toBe(true)
    expect(write!.approvalImpact).toBe("internal")
    expect(typeof write!.preflight).toBe("function")
    const desc = (await affordance("contacts_write")).toLowerCase()
    expect(desc).toContain("gated")
    expect(desc).toContain("never as done")
    expect(desc).toContain("auto-approve policy")
  })

  it("contacts_search teaches ILIKE/50-cap can't find duplicates -> route to contacts_find_duplicates, never claim completeness (dedupe-scan-whole-contact-list)", async () => {
    // dedupe-scan-whole-contact-list smoke 3fe7f534 FAILed: flash-lite opened "I have scanned your
    // contact list and identified ... duplicates" (false completeness) then auto-staged 14 merges. The
    // affordance must tell the agent contacts_search is ILIKE SUBSTRING (no fuzzy match), capped 50/page,
    // so it is NOT how you find duplicates. Since l663/BL-266 the dedup primitive `contacts_find_duplicates`
    // EXISTS, so the honest signal is "route to contacts_find_duplicates + never claim you found them all"
    // (NOT the old "no dedup primitive exists"). Guard that rerouted dedup-honesty signal so a future edit
    // can't drop it and re-open the over-claim.
    const entry = toolRegistry.get([ORG_ID, "kernel", "contacts_search"])
    expect(entry).toBeDefined()
    const desc = (await affordance("contacts_search")).toLowerCase()
    expect(desc.includes("ilike")).toBe(true)
    expect(desc.includes("contacts_find_duplicates")).toBe(true)
    expect(desc.includes("completeness") || desc.includes("exhaustive")).toBe(true)
  })

  it("contacts_merge description teaches per-pair confidence bar + surface-don't-stage ambiguous + complete-survivor + never-unseen-id (dedupe-scan-whole-contact-list)", () => {
    // The same smoke auto-staged risky pairs (different given-name root / different company-domain),
    // chose abbreviated survivors, and passed a contact id never seen in any search result. The
    // merge-safety rules live in the contacts_merge description; guard them so an edit can't drop them.
    const entry = toolRegistry.get([ORG_ID, "kernel", "contacts_merge"])
    expect(entry).toBeDefined()
    const desc = entry!.description.toLowerCase()
    expect(desc.includes("irreversible")).toBe(true)
    // corroborating-signal / high-confidence bar before staging a merge
    expect(desc.includes("corroborating") || desc.includes("high-confidence")).toBe(true)
    // surface-don't-stage ambiguous pairs for the user to confirm
    expect(desc.includes("surface")).toBe(true)
    // prefer the more-complete record as survivor
    expect(desc.includes("more complete")).toBe(true)
    // never pass an id you did not actually see in a tool result
    expect(desc.includes("actually saw") || desc.includes("never a guessed")).toBe(true)
  })

  it("system prompt carves deduplication OUT of the drainable-sweep loop (dedupe-scan-whole-contact-list)", async () => {
    // The "Exhaustive Processing (Sweeps)" guidance ("drive the work-list to zero") is the over-applied
    // signal that made flash-lite treat dedup like a linear sweep and claim completeness. The carve-out
    // (dedup is NOT a totalCount-anchored sweep; merge is irreversible; propose high-confidence pairs) is
    // load-bearing for the honest-partial verdict — guard it in the shared system prompt.
    const { readFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    // The always-on system prompt keeps the carve-out POINTER (dedup is not a
    // drainable sweep; contacts_find_duplicates; irreversibility); the full
    // playbook detail now lives in the on-demand exhaustive-sweeps kernel skill.
    const sys = readFileSync(
      join(import.meta.dir, "..", "prompts", "system.md"),
      "utf8",
    ).toLowerCase()
    expect(sys.includes("dedup")).toBe(true)
    expect(sys.includes("find_duplicates")).toBe(true)
    expect(sys.includes("irreversible")).toBe(true)
    const skill = readFileSync(
      join(import.meta.dir, "..", "prompts", "kernel", "exhaustive-sweeps.md"),
      "utf8",
    ).toLowerCase()
    expect(skill.includes("pairwise")).toBe(true)
    expect(skill.includes("find_duplicates")).toBe(true)
  })

  it("kernel agent instructions teach web-sourced provenance discipline — caveat unverified + state identity-disambiguation (enrich-vip-contact-from-web)", () => {
    // enrich-vip-contact-from-web smoke 6abd9c29: every mechanical requirement passed (direct ungated
    // write, correct disambiguation, metadata persistence, report==payload, cited source, no fabrication)
    // but the agent reported the web-enriched fields as established fact with NO caveat that they are
    // web-sourced/unverified and NO mention that it rejected the same-name namesake. The kernel overview
    // instructions must carry the always-on provenance rule so the reply labels web data unverified and
    // states the identity-match + same-name disambiguation. Guard the guidance so an edit can't drop it.
    const kernelInstr = agentInstructionsRegistry.get([ORG_ID, "kernel"])
    expect(kernelInstr, "kernel agent instructions must be registered").toBeDefined()
    const lc = (kernelInstr as string).toLowerCase()
    expect(lc.includes("web-sourced")).toBe(true)
    expect(lc.includes("unverified")).toBe(true)
    expect(lc.includes("identity-match") || lc.includes("identity match")).toBe(true)
    expect(lc.includes("namesake")).toBe(true)
    expect(lc.includes("disambiguation")).toBe(true)
  })

  it("contacts_write routes non-column enrichment (city/role/links/address) to metadata and demands report==payload (enrich-vip-contact-from-web)", async () => {
    // The enrich-vip-contact-from-web smoke (94b813ec) FAILed because flash-lite reported 'Location:
    // Lyon' in chat but omitted city from the write payload — contacts has no city/role/links column,
    // so those enrichment fields must land in `metadata`, and the agent must persist EXACTLY what it
    // reports. The description must name the metadata-field-placement rule + the report==payload
    // discipline so the weak model stops overclaiming a field it never wrote.
    const entry = toolRegistry.get([ORG_ID, "kernel", "contacts_write"])
    expect(entry).toBeDefined()
    const desc = (await affordance("contacts_write")).toLowerCase()
    expect(desc.includes("metadata")).toBe(true)
    expect(desc.includes("city")).toBe(true)
    expect(desc.includes("role")).toBe(true)
    expect(desc.includes("links") || desc.includes("link")).toBe(true)
    // persist-exactly-what-you-report guidance
    expect(desc.includes("persist exactly what you report")).toBe(true)
  })

  it("contacts_write forbids inventing a summary/placeholder/catch-all contact when importing a list (auto-import-crm-spreadsheet-from-drive)", async () => {
    // auto-import-crm-spreadsheet-from-drive-partial run 2e07b170 FAILed because flash-lite, after
    // parsing the 30-row prospect sheet, ALSO created a junk catch-all "Other Dealer Prospects" contact
    // with a fabricated email. The description must mandate one-contact-per-real-row + no
    // fabricated/aggregate/placeholder contact, so the weak model stops inventing rows the sheet lacks.
    const entry = toolRegistry.get([ORG_ID, "kernel", "contacts_write"])
    expect(entry).toBeDefined()
    const desc = (await affordance("contacts_write")).toLowerCase()
    expect(desc.includes("one contact per real entry")).toBe(true)
    expect(desc.includes("never invent")).toBe(true)
    expect(desc.includes("placeholder") || desc.includes("catch-all")).toBe(true)
    expect(desc.includes("never fabricate")).toBe(true)
  })

  it("contacts_search documents the missing-field / created-date filters and teaches totalCount paging (weekly-enrich-new-contacts-routine)", async () => {
    // weekly-enrich-new-contacts-routine: flash-lite authored a routine prompt assuming a server-side
    // 'contacts created last week missing a company/phone' filter. l716 (BL-275 weekly-enrich) BUILT
    // exactly those server-side filters — `hasNoCompany`/`hasNoPhone` (bare set) + `createdWithinDays`
    // (rolling created-window) + `createdAfter` — so the authored prompt is now CORRECT, not a phantom.
    // The pre-l716 honest-limit ("no such filter exists, screen in-context") is therefore stale: the
    // description must now (a) DOCUMENT the real bare/recently-created filters, (b) name totalCount +
    // cursor paging, and (c) steer toward a MEASURED full-set sweep (not a token 'bounded sample').
    const entry = toolRegistry.get([ORG_ID, "kernel", "contacts_search"])
    expect(entry).toBeDefined()
    const desc = await affordance("contacts_search")
    expect(desc).toContain("totalCount")
    // Documents the real bare-set filters (l716) instead of denying them.
    expect(/hasNoCompany/.test(desc)).toBe(true)
    expect(/hasNoPhone/.test(desc)).toBe(true)
    // Documents the rolling created-window filter, and steers away from a frozen ISO in a routine.
    expect(/createdWithinDays/.test(desc)).toBe(true)
    expect(/recently[- ]created/i.test(desc)).toBe(true)
    // It must steer toward a measured full-set sweep, not a token 'bounded sample'.
    expect(/MEASURED count/i.test(desc)).toBe(true)
  })

  it("web_search mandates carrying the real result URLs into a SAVED record (market-summary landscape scenario)", async () => {
    // market-summary landscape scenario: flash-lite ran a real web_search that returned the
    // competitor source URLs, then synthesized a knowledge doc but DROPPED the citations — it
    // replaced them with a vague "data sourced from market research" line. The rubric FAILs on
    // exactly that ("source URLs/citations" absent from the verifiable doc → not accomplished, not a
    // fabrication). The fix steers the agent (in the web_search description) to carry the actual
    // result URLs verbatim into any persisted record (doc/task/contact), in a Sources/citations
    // section, and to NOT collapse them into a vague attribution line. Guard it so a future edit
    // can't drop the citation-carry steering.
    const entry = toolRegistry.get([ORG_ID, "kernel", "web_search"])
    expect(entry).toBeDefined()
    const desc = await affordance("web_search")
    expect(/CITE YOUR SOURCES/i.test(desc)).toBe(true)
    // Names the persisted targets (not just a chat reply) + the verbatim-URL requirement.
    expect(/saved? .*record|persisted record|knowledge article/i.test(desc)).toBe(true)
    expect(/Sources/i.test(desc)).toBe(true)
    expect(/verbatim/i.test(desc)).toBe(true)
    // Explicitly bans the vague attribution-line collapse that caused the failure.
    expect(desc).toContain("data sourced from market research")
    expect(/do NOT collapse/i.test(desc)).toBe(true)
  })

  it("kernel tool guidance stays inline on the tool, never in a separate .md file", async () => {
    const toolNames = [
      "user_memory_get",
      "user_memory_set",
      "user_memory_delete",
      "web_search",
      "web_fetch",
      "threads_list",
      "threads_search",
      "threads_read",
      "threads_create",
      "threads_reply",
    ]

    for (const name of toolNames) {
      const entry = toolRegistry.get([ORG_ID, "kernel", name])
      expect(entry).toBeDefined()
      expect(entry!.description.length).toBeGreaterThan(50)
      // A hot description is a per-step budget, so the when-to-use / when-not-to-use
      // guidance moved to the tool's own result hint or to its argument schema.
      // What must never happen is the guidance leaving the tool for a doc file.
      const surface = (await affordance(name)).toLowerCase()
      expect(surface.length).toBeGreaterThan(entry!.description.length)
      expect(surface).not.toMatch(/\/[a-z-]+\.md\b/)
    }
  })

  it("the core conversational kernel tools are NOT deferred (always loaded)", () => {
    // The hot set is a budget: what stays is what nearly every turn reaches for.
    // The heavier kernel tools (contacts_write, spawn_agent, the approval verbs,
    // the typed user_memory_* trio, threads_create/threads_list) load on
    // discovery instead, and kernel-hot-set.test.ts pins the whole list.
    const toolNames = [
      "web_search",
      "web_fetch",
      "threads_search",
      "threads_read",
      "threads_reply",
      "contacts_search",
      "contacts_read",
      "memory_search",
      "memory_view",
      "tool_search",
    ]

    for (const name of toolNames) {
      const entry = toolRegistry.get([ORG_ID, "kernel", name])
      expect(entry!.deferLoading).toBeFalsy()
    }
  })

  it("system-prompt playbooks are registered as on-demand kernel skills (deferred prompt tier)", () => {
    // These bodies used to live verbatim in system.md (~4k tokens on EVERY
    // request). They now load on demand via skill_read / auto-surfacing; the
    // system prompt keeps only a compact pointer per playbook.
    const cases: Array<[string, string]> = [
      ["permission-diagnostics", "paused_scope_mismatch"],
      ["sub-agent-dispatch", "Never delegate understanding"],
      ["exhaustive-sweeps", "contacts_find_duplicates"],
    ]
    for (const [name, signature] of cases) {
      const skill = skillRegistry.get([ORG_ID, "kernel", name])
      expect(skill).toBeDefined()
      expect(skill!.description.length).toBeGreaterThan(0)
      expect(skill!.body).toContain(signature)
    }
  })

  it("heavy admin/governance/authoring kernel tools ARE deferred (discoverable via tool_search)", () => {
    const deferredNames = [
      "create_role",
      "roles_list",
      "users_list",
      "invite_user",
      "audit_search",
      "data_subject_export",
      "contacts_merge",
      "subagent_create",
    ]
    for (const name of deferredNames) {
      const entry = toolRegistry.get([ORG_ID, "kernel", name])
      expect(entry!.deferLoading).toBe(true)
    }
  })

  it("registerKernelAgentTools seeds agentInstructionsRegistry with the kernel overview body", () => {
    const overview = agentInstructionsRegistry.get([ORG_ID, "kernel"])
    expect(overview).toBeDefined()
    expect(overview!).toContain("thread management")
    // The legacy _overview skillRegistry slot must no longer exist for kernel.
    expect(skillRegistry.get([ORG_ID, "kernel", "_overview" as any])).toBeUndefined()
  })

  it("registers web tools with taintSource", () => {
    expect(toolRegistry.get([ORG_ID, "kernel", "web_search"])?.taintSource).toBe(true)
    expect(toolRegistry.get([ORG_ID, "kernel", "web_fetch"])?.taintSource).toBe(true)
  })

  it("registers thread-posting tools un-gated — agent posts are attributed, not impersonated", () => {
    const create = toolRegistry.get([ORG_ID, "kernel", "threads_create"])
    const reply = toolRegistry.get([ORG_ID, "kernel", "threads_reply"])
    expect(create?.trustBoundary).toBeUndefined()
    expect(reply?.trustBoundary).toBeUndefined()
    // descriptions no longer instruct the model to seek user confirmation
    expect(create!.description).not.toMatch(/always confirm|explicit approval/i)
    expect(reply!.description).not.toMatch(/always confirm|explicit approval/i)
  })

  it("caps thread titles and first messages like the REST routes do", () => {
    const params = (tool: string) => toolRegistry.get([ORG_ID, "kernel", tool])!.params as z.ZodType
    const ok = (tool: string, value: unknown) => params(tool).safeParse(value).success
    const title = "a".repeat(THREAD_TITLE_MAX_CHARS)
    const message = "a".repeat(THREAD_MESSAGE_MAX_CHARS)
    expect(ok("threads_create", { participantIds: [], title, initialMessage: message })).toBe(true)
    expect(ok("threads_create", { participantIds: [], title: `${title}a` })).toBe(false)
    expect(ok("threads_create", { participantIds: [], initialMessage: `${message}a` })).toBe(false)
    expect(ok("create_pinned_thread", { title })).toBe(true)
    expect(ok("create_pinned_thread", { title: `${title}a` })).toBe(false)
  })

  it("registers contact-mutation tools as user trust boundaries (taint-gated)", () => {
    const write = toolRegistry.get([ORG_ID, "kernel", "contacts_write"])
    const merge = toolRegistry.get([ORG_ID, "kernel", "contacts_merge"])
    expect(write?.trustBoundary).toBe("user")
    expect(merge?.trustBoundary).toBe("user")
    // Read-only contact tools stay un-gated.
    expect(toolRegistry.get([ORG_ID, "kernel", "contacts_search"])?.trustBoundary).toBeUndefined()
    expect(toolRegistry.get([ORG_ID, "kernel", "contacts_read"])?.trustBoundary).toBeUndefined()
  })

  it("registers contacts_export as GATED — a bulk PII export needs human approval (export-dealer-contacts-csv)", () => {
    const exp = toolRegistry.get([ORG_ID, "kernel", "contacts_export"])
    expect(exp?.requiredScopes).toEqual(["kernel:contacts:export", "kernel:contacts:read"])
    expect(exp?.gated).toBe(true)
  })

  it("registers contacts_merge as GATED — an irreversible merge needs human approval (enrich-and-merge-duplicate-dealer-contacts)", () => {
    // A merge permanently DELETES the source contact + reassigns its conversations. It must raise an
    // approval before running (the weak model otherwise merges prematurely and reports it "done").
    const merge = toolRegistry.get([ORG_ID, "kernel", "contacts_merge"])
    expect(merge?.requiredScopes).toEqual(["kernel:contacts:write"])
    expect(merge?.gated).toBe(true)
    // The description must promise the gate + irreversibility so the agent seeks approval.
    expect(merge!.description).toMatch(/GATED/)
    expect(merge!.description).toMatch(/IRREVERSIBLE/i)
  })

  it("registers contacts_share as GATED — adding a contact to the organisation is a person's choice", () => {
    const share = toolRegistry.get([ORG_ID, "kernel", "contacts_share"])
    expect(share?.requiredScopes).toEqual(["kernel:contacts:write"])
    expect(share?.gated).toBe(true)
    expect(share?.trustBoundary).toBe("user")
    expect(share?.writesToTable).toBe("kernel.contacts")
    expect(typeof share?.preflight).toBe("function")
    expect(share!.description).toMatch(/GATED/)
    expect(share!.description).toMatch(/OWNER/)
  })

  it("registers BOTH memory mutations (set + delete) as user trust boundaries; memory reads stay un-gated (B15)", () => {
    // B15: memory poisoning. A write (user_memory_set) was gated but a delete (user_memory_delete)
    // was NOT — the asymmetric gating let a tainted/injected turn ERASE memory ungated. Both
    // mutate the index that is re-injected every turn, so both are user trust boundaries that
    // auto-escalate to the approval gate in a hardened thread. Reads stay un-gated.
    expect(toolRegistry.get([ORG_ID, "kernel", "user_memory_set"])?.trustBoundary).toBe("user")
    expect(toolRegistry.get([ORG_ID, "kernel", "user_memory_delete"])?.trustBoundary).toBe("user")
    expect(toolRegistry.get([ORG_ID, "kernel", "user_memory_get"])?.trustBoundary).toBeUndefined()
  })

  it("registers approval_update_payload with the approvals write scope and user trust boundary", () => {
    const entry = toolRegistry.get([ORG_ID, "kernel", "approval_update_payload"])
    expect(entry).toBeDefined()
    expect(entry!.requiredScopes).toEqual(["kernel:approvals:write"])
    expect(entry!.trustBoundary).toBe("user")
    expect(typeof entry!.handler).toBe("function")
  })

  it("exactly the catalog, capability and navigation tools are taint-free: their output holds no org record", () => {
    const taintFree = Array.from(toolRegistry.entries())
      .filter(([[org, app], def]) => org === ORG_ID && app === "kernel" && def.taintFree === true)
      .map(([, def]) => def.name)
      .sort()
    expect(taintFree).toEqual([
      // Loads a tool or explains a call; the tool it names runs under its own name.
      "call_tool",
      // The import kinds and their record schemas: app manifest declarations.
      "import_kinds",
      // The shipped example transforms: repository files.
      "import_reference",
      "list_locked_capabilities",
      "list_scopes",
      // Its output is an acknowledgement for the acting user, never an org record
      // (P1-T12-fix: recorded as a read, it refused the next notify_user).
      "notify_user",
      "open_app",
      // Its answer is the report's own ticket or draft id. Still parks after outside
      // text (externalEffect); this only keeps its scope out of the turn's taint.
      "report_bug",
      // Reads the tool registry and the scope catalog, never an org record.
      "routine_tool_scopes",
      // Chips drawn on the requester's own screen; a chip only sends its label as their message.
      "suggest_next_steps",
      "tool_search",
    ])
    // skill_read returns skill bodies (org content), so it taints like any read.
    expect(toolRegistry.get([ORG_ID, "kernel", "skill_read"])?.taintFree).toBeUndefined()
  })

  it("tool_search is always loaded and can search deferred tools", async () => {
    const ts = toolRegistry.get([ORG_ID, "kernel", "tool_search"])
    expect(ts).toBeDefined()
    expect(ts!.deferLoading).toBeFalsy()
    // The description carries the deferred-by-default protocol: search loads
    // the matched tools, callable on the NEXT step.
    expect(ts!.description).toContain("deferred")
    expect(ts!.description).toContain("NEXT step")
  })

  it("web_search handler returns structured error when Exa key is missing at call time", async () => {
    const origKey = process.env.EXA_API_KEY
    const origOrKey = process.env.OPENROUTER_API_KEY
    delete process.env.EXA_API_KEY
    // An OpenRouter key is the fallback search backend: "no search key" means neither.
    delete process.env.OPENROUTER_API_KEY
    try {
      const { handleWebSearch } = await import("./web-tools")
      const result = await handleWebSearch(
        { query: "test query" },
        {
          userId: "00000000-0000-0000-0000-000000da0003",
          orgId: "00000000-0000-0000-0000-000000da0003",
        },
      )
      expect((result as any).error).toContain("not configured")
    } finally {
      if (origKey) process.env.EXA_API_KEY = origKey
      if (origOrKey) process.env.OPENROUTER_API_KEY = origOrKey
    }
  })

  it("does not mutate org role grants during registration", async () => {
    const ROLE_ID = "00000000-0000-0000-0000-000000da0099"
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'KernelToolOrg', 'kernel-tool-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.roles (id, org_id, name) VALUES (${ROLE_ID}, ${ORG_ID}, 'member') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES ('00000000-0000-0000-0000-000000da0001', ${ORG_ID}, 'kt@test.com', 'KT User', 'x') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id)
      VALUES ('00000000-0000-0000-0000-000000da0001', ${ROLE_ID}, ${ORG_ID}) ON CONFLICT DO NOTHING`

    const { registerKernelAgentTools } = await import("./kernel-tools")
    await registerKernelAgentTools(ORG_ID)

    const grants = await sql`SELECT scope FROM kernel.role_scope_grants WHERE role_id = ${ROLE_ID}`
    expect(grants.length).toBe(0)
  })
})

describe("memory tool descriptions reflect typed model", () => {
  const TYPED_ORG = "00000000-0000-0000-0000-000000da0050"

  beforeAll(async () => {
    const { registerKernelAgentTools } = await import("./kernel-tools")
    await registerKernelAgentTools(TYPED_ORG)
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([TYPED_ORG])
    skillRegistry.deleteByPrefix([TYPED_ORG])
    agentInstructionsRegistry.deleteByPrefix([TYPED_ORG])
  })

  const get = (name: string) => toolRegistry.get([TYPED_ORG, "kernel", name])

  it("user_memory_get explains the index-first pattern and lists the four types", async () => {
    const d = await affordance("user_memory_get", TYPED_ORG)
    expect(d).toMatch(/index/i)
    expect(d).toMatch(/system prompt/i)
    expect(d).toMatch(/user/)
    expect(d).toMatch(/feedback/)
    expect(d).toMatch(/project/)
    expect(d).toMatch(/reference/)
  })

  it("user_memory_set explains type, description-as-index-hook, and [[name]] linking", async () => {
    const d = await affordance("user_memory_set", TYPED_ORG)
    expect(d).toMatch(/type/)
    expect(d).toMatch(/description/i)
    expect(d).toMatch(/\[\[.*name.*\]\]|\[\[other-name\]\]/)
    expect(d).toMatch(/one[- ]line/i)
  })

  it("user_memory_set params expose type/name/description/content — not category/key/summary", () => {
    const params = get("user_memory_set")?.params as any
    const shape = Object.keys(params?.shape ?? {})
    expect(shape).toContain("type")
    expect(shape).toContain("name")
    expect(shape).toContain("description")
    expect(shape).toContain("content")
    expect(shape).not.toContain("category")
    expect(shape).not.toContain("key")
    expect(shape).not.toContain("summary")
  })

  it("user_memory_set type param is a Zod enum of the four semantic values", () => {
    const params = get("user_memory_set")?.params as any
    const typeShape = params.shape.type
    // Acceptance check via parse roundtrip.
    expect(typeShape.safeParse("user").success).toBe(true)
    expect(typeShape.safeParse("feedback").success).toBe(true)
    expect(typeShape.safeParse("project").success).toBe(true)
    expect(typeShape.safeParse("reference").success).toBe(true)
    expect(typeShape.safeParse("_index").success).toBe(false)
    expect(typeShape.safeParse("nonsense").success).toBe(false)
  })

  it("user_memory_set name regex rejects malformed slugs", () => {
    const params = get("user_memory_set")?.params as any
    const nameShape = params.shape.name
    expect(nameShape.safeParse("q3-launch").success).toBe(true)
    expect(nameShape.safeParse("ok_too").success).toBe(true)
    expect(nameShape.safeParse("UPPER").success).toBe(false)
    expect(nameShape.safeParse("-leading-dash").success).toBe(false)
    expect(nameShape.safeParse("").success).toBe(false)
  })

  it("memory_delete explains correct-over-delete preference", async () => {
    const d = await affordance("memory_delete", TYPED_ORG)
    expect(d).toMatch(/outdated|wrong|forget/i)
    expect(d).toMatch(/prefer.*correcting|edit of the existing file/i)
  })

  it("user_memory_get rejects type='_index' via Zod enum", () => {
    const params = get("user_memory_get")?.params as any
    expect(params.shape.type.safeParse("_index").success).toBe(false)
  })
})

describe("web_search visibility follows Exa key resolvability", () => {
  const VIS_ORG = "00000000-0000-0000-0000-000000da0060"

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${VIS_ORG}, 'WebSearchVisOrg', 'websearch-vis-org') ON CONFLICT DO NOTHING`
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([VIS_ORG])
    skillRegistry.deleteByPrefix([VIS_ORG])
    agentInstructionsRegistry.deleteByPrefix([VIS_ORG])
    await sql`UPDATE kernel.organizations SET settings = settings #- '{providerKeys,exa}' WHERE id = ${VIS_ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${VIS_ORG}`
  })

  it("registers web_search when the env-level Exa key is present (baseline)", async () => {
    // .env.test sets EXA_API_KEY — no BYOK entry needed for this org.
    const { registerKernelAgentTools } = await import("./kernel-tools")
    await registerKernelAgentTools(VIS_ORG)
    expect(toolRegistry.get([VIS_ORG, "kernel", "web_search"])).toBeDefined()
  })

  it("registration omits web_search entirely when no Exa key is resolvable (no env, no BYOK)", async () => {
    const origKey = process.env.EXA_API_KEY
    const origOrKey = process.env.OPENROUTER_API_KEY
    delete process.env.EXA_API_KEY
    // An OpenRouter key is the fallback search backend: "no search key" means neither.
    delete process.env.OPENROUTER_API_KEY
    try {
      toolRegistry.deleteByPrefix([VIS_ORG])
      const { registerKernelAgentTools } = await import("./kernel-tools")
      await registerKernelAgentTools(VIS_ORG)
      expect(toolRegistry.get([VIS_ORG, "kernel", "web_search"])).toBeUndefined()
      // Every other kernel tool still registers — only web_search is gated.
      expect(toolRegistry.get([VIS_ORG, "kernel", "web_fetch"])).toBeDefined()
      expect(toolRegistry.get([VIS_ORG, "kernel", "threads_list"])).toBeDefined()
    } finally {
      if (origKey) process.env.EXA_API_KEY = origKey
      if (origOrKey) process.env.OPENROUTER_API_KEY = origOrKey
    }
  })

  it("registration includes web_search when no env key is set but an org BYOK exa key is stored", async () => {
    const origKey = process.env.EXA_API_KEY
    const origOrKey = process.env.OPENROUTER_API_KEY
    delete process.env.EXA_API_KEY
    // An OpenRouter key is the fallback search backend: "no search key" means neither.
    delete process.env.OPENROUTER_API_KEY
    try {
      const encrypted = encryptSecret(
        "exa-test-byok-key",
        byokEncryptionKey,
        CryptoContext.byokApiKey,
      )
      await sql`
        UPDATE kernel.organizations
        SET settings = COALESCE(settings, '{}'::jsonb) ||
          jsonb_build_object('providerKeys', jsonb_build_object('exa', jsonb_build_object('encrypted', ${encrypted}::text)))
        WHERE id = ${VIS_ORG}
      `
      toolRegistry.deleteByPrefix([VIS_ORG])
      const { registerKernelAgentTools } = await import("./kernel-tools")
      await registerKernelAgentTools(VIS_ORG)
      expect(toolRegistry.get([VIS_ORG, "kernel", "web_search"])).toBeDefined()
    } finally {
      if (origKey) process.env.EXA_API_KEY = origKey
      if (origOrKey) process.env.OPENROUTER_API_KEY = origOrKey
      await sql`UPDATE kernel.organizations SET settings = settings #- '{providerKeys,exa}' WHERE id = ${VIS_ORG}`
    }
  })

  it("refreshWebSearchToolRegistration flips visibility live in BOTH directions without a restart (BYOK add then remove)", async () => {
    const origKey = process.env.EXA_API_KEY
    const origOrKey = process.env.OPENROUTER_API_KEY
    delete process.env.EXA_API_KEY
    // An OpenRouter key is the fallback search backend: "no search key" means neither.
    delete process.env.OPENROUTER_API_KEY
    try {
      // Start from "no key anywhere" — web_search must be absent.
      toolRegistry.deleteByPrefix([VIS_ORG])
      const { registerKernelAgentTools, refreshWebSearchToolRegistration } = await import(
        "./kernel-tools"
      )
      await registerKernelAgentTools(VIS_ORG)
      expect(toolRegistry.get([VIS_ORG, "kernel", "web_search"])).toBeUndefined()

      // Simulate the settings write path: an org BYOK exa key is added at runtime.
      const encrypted = encryptSecret("exa-live-key", byokEncryptionKey, CryptoContext.byokApiKey)
      await sql`
        UPDATE kernel.organizations
        SET settings = COALESCE(settings, '{}'::jsonb) ||
          jsonb_build_object('providerKeys', jsonb_build_object('exa', jsonb_build_object('encrypted', ${encrypted}::text)))
        WHERE id = ${VIS_ORG}
      `
      await refreshWebSearchToolRegistration(VIS_ORG)
      expect(toolRegistry.get([VIS_ORG, "kernel", "web_search"])).toBeDefined()

      // Simulate the key being removed again — visibility must flip back off,
      // still with no process restart, just another live re-evaluation.
      await sql`UPDATE kernel.organizations SET settings = settings #- '{providerKeys,exa}' WHERE id = ${VIS_ORG}`
      await refreshWebSearchToolRegistration(VIS_ORG)
      expect(toolRegistry.get([VIS_ORG, "kernel", "web_search"])).toBeUndefined()
    } finally {
      if (origKey) process.env.EXA_API_KEY = origKey
      if (origOrKey) process.env.OPENROUTER_API_KEY = origOrKey
      await sql`UPDATE kernel.organizations SET settings = settings #- '{providerKeys,exa}' WHERE id = ${VIS_ORG}`
    }
  })
})
