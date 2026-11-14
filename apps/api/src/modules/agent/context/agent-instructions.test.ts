// SPDX-License-Identifier: FSL-1.1-ALv2
// Every in-tree descriptor exports `<name>AppManifest` (verified) — importing the wrong identifier
// is a COMPILE error, not the intended `undefined`-instructions failure.
import { describe, expect, it } from "bun:test"
import { contactsAppManifest } from "~/apps/contacts/manifest-descriptor"
import { knowledgeAppManifest } from "~/apps/knowledge/manifest-descriptor"
import { mailAppManifest } from "~/apps/mail/manifest-descriptor"
import { mcpManagerAppManifest } from "~/apps/mcp-manager/manifest-descriptor"
import { projectsAppManifest } from "~/apps/projects/manifest-descriptor"
import { ticketsAppManifest } from "~/apps/tickets/manifest-descriptor"
import { normalizeAppGuide } from "~/modules/agent/context/app-guide"
import boxtalManifest from "../../../../../../bundled-apps/boxtal/app.manifest.json"
import googleDriveManifest from "../../../../../../bundled-apps/google-drive/app.manifest.json"
import invoicingManifest from "../../../../../../bundled-apps/invoicing/app.manifest.json"
import pennylaneManifest from "../../../../../../bundled-apps/pennylane/app.manifest.json"
import shopifyManifest from "../../../../../../bundled-apps/shopify/app.manifest.json"
import socialManifest from "../../../../../../bundled-apps/social/app.manifest.json"

const inTree = {
  tickets: ticketsAppManifest,
  mail: mailAppManifest,
  projects: projectsAppManifest,
  contacts: contactsAppManifest,
  "mcp-manager": mcpManagerAppManifest,
  knowledge: knowledgeAppManifest, // NEW — was missing agentInstructions entirely
}
const bundled: Record<string, { agentInstructions?: unknown }> = {
  shopify: shopifyManifest,
  invoicing: invoicingManifest,
  boxtal: boxtalManifest,
  social: socialManifest, // NEW — was omitted from coverage
  pennylane: pennylaneManifest, // NEW — built in the Pennylane section (Task 7)
  "google-drive": googleDriveManifest,
}

// Upper guard against runaway prompt-cache bloat. The original 1600 floor was
// sized when every host app shipped a short paragraph; since then the busiest
// surfaces (tickets, mail) have legitimately grown detailed steering paragraphs
// via the scenario loop (BL-91/92/126 etc.), so the ceiling tracks the largest
// justified host instruction with headroom rather than failing a real, grown
// instruction. The tight per-app expectation lives in K1's authored knowledge
// string (~600 chars), not in this shared loop's ceiling.
//
// The 6000 ceiling went stale: tickets (~13.6k) and mail (~7.3k, after the
// BL-253 AP-store-over-mail-search steering for claire-find-vendor-invoices-
// email-3mo) both legitimately exceed it, every clause traceable to a scenario/BL.
// Raised to 16000 — headroom over the largest justified host instruction
// (tickets) while still catching a genuinely runaway/duplicated paragraph.
//
// Re-bumped (BL-213) to 20000: tickets grew past 16k via the BL-227 backlogHealth
// + BL-246 warranty-eligibility-verdict clauses (each BL-traceable, ~18.4k) — the
// ceiling was already red at HEAD before this change. The BL-213 search-
// tokenization fix CORRECTED (did not remove) its now-stale "search is subject-
// only/untokenized" clustering guidance. The ceiling stays a runaway/duplication
// tripwire, just with headroom over the justified tickets size.
//
// Re-bumped (post-ultrareview-merge) to 36000: tickets has grown to ~29.5k via
// further BL-traceable scenario-loop steering (134 distinct sentences, zero
// duplicated paragraphs — verified not runaway), the largest justified host
// instruction. The ceiling was already red on deep-week-sim before the merge;
// the merge merely surfaced it alongside the registry-discipline guards. Headroom
// over the current tickets size keeps the tripwire biting on a genuine
// runaway/duplication regression without failing the legitimately grown instruction.
//
// Re-bumped to 48000: the long tickets tool descriptions (search, assign and
// others past 600 characters) moved word for word into tickets guide sections
// that name each tool (tool-text-moves.json), about 8.7k characters. A section
// reaches a turn only with its tool loaded, and the tool lost the same text, so
// a turn carries less than before; the guide's own total grew by exactly the
// moved text (tickets ~42.8k).
const HOST_INSTRUCTIONS_MAX = 48000

/** The whole guide as one string: the core and every section (app-guide.ts). */
function guideText(raw: unknown): string {
  if (!raw) return ""
  const guide = normalizeAppGuide(raw as Parameters<typeof normalizeAppGuide>[0])
  return [guide.core, ...guide.sections.map((s) => s.text)].join("\n\n")
}

describe("per-app agentInstructions", () => {
  it("all in-tree product apps declare non-trivial agentInstructions", () => {
    for (const [name, app] of Object.entries(inTree)) {
      expect(app.agentInstructions, name).toBeTruthy()
      const text = guideText(app.agentInstructions)
      expect(text.length, name).toBeGreaterThan(80) // ~100-200 words
      expect(text.length, `${name} too verbose (cache bloat)`).toBeLessThan(HOST_INSTRUCTIONS_MAX)
    }
  })

  it("all bundled apps declare agentInstructions in their manifest", () => {
    for (const [name, m] of Object.entries(bundled)) {
      expect(m.agentInstructions, name).toBeTruthy()
      expect(guideText(m.agentInstructions).length, name).toBeGreaterThan(80)
    }
  })

  it("no agentInstructions string references a banned real literal", () => {
    const all = [
      ...Object.values(inTree).map((a) => guideText(a.agentInstructions)),
      ...Object.values(bundled).map((m) => guideText(m.agentInstructions)),
    ]
    for (const s of all) for (const w of ["Fabrikam", "Tessera"]) expect(s).not.toContain(w)
  })
})
