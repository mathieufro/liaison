// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Manifest integrity tests (T14) — make sure the handler names declared in
 * `app.manifest.json` resolve to real exports, and that obsolete scope
 * vocabulary has been scrubbed.
 */

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { validateAppManifest } from "~/modules/apps/contract"
import manifest from "./app.manifest.json"
import * as attention from "./attention"
import { assertCanReadDocumentRow, type KnowledgeActor } from "./service"

// The app guide is a short core plus sections keyed by the tools they are
// about (app-guide.ts); these assertions read the whole guide.
type ManifestGuide = string | { core: string; sections?: Array<{ tools: string[]; text: string }> }
const guideText = (m: { agentInstructions?: unknown }): string => {
  const g = m.agentInstructions as ManifestGuide | undefined
  if (!g) return ""
  return typeof g === "string" ? g : [g.core, ...(g.sections ?? []).map((s) => s.text)].join("\n\n")
}

// handlers.ts uses bare function declarations (no module exports) so QuickJS
// can resolve them at sandbox runtime. We assert by source-scanning the
// bundle for the declared names rather than via dynamic import.
const handlersSource = readFileSync(new URL("./handlers.ts", import.meta.url), "utf8")

describe("knowledge app manifest (T14)", () => {
  it("declares the heading over its attention items, in the words and catalog key Home shows", () => {
    expect(manifest.attention.groupLabel).toEqual({
      label: "Knowledge",
      labelKey: "kernel.homeGroupKnowledge",
    })
  })

  it("views.attentionItems handler resolves to an exported function (BC-2)", () => {
    const views = (manifest as unknown as { views: Record<string, { handler: string }> }).views
    const handlerName = views.attentionItems.handler
    expect(handlerName).toBe("computeAttentionItems")
    expect(typeof (attention as Record<string, unknown>)[handlerName]).toBe("function")
  })

  it("tool handlers all map to a function declaration in handlers.ts", () => {
    const tools = (manifest as { tools: Record<string, { handler: string }> }).tools
    for (const [name, tool] of Object.entries(tools)) {
      // handlers.ts declares `async function <name>(...)` for each manifest tool
      const decl = new RegExp(`async\\s+function\\s+${tool.handler}\\s*\\(`)
      expect(handlersSource).toMatch(decl)
      expect(tool.handler).toMatch(/^[a-zA-Z][a-zA-Z0-9_]*$/)
      expect(name.length).toBeGreaterThan(0)
    }
  })

  it("the search tool declares a REQUIRED `query` param and get declares `id` (agent-callable schema)", () => {
    // Without a `params` schema the agent has no idea `search` takes a query, calls it empty, and
    // the backend skips with "Remote search skipped for empty query" → every KB-grounded scenario
    // dies. The schema is what surfaces `query` (required) into the agent's tool definition.
    const tools = manifest.tools as Record<
      string,
      { params?: { properties?: Record<string, unknown>; required?: string[] } }
    >
    expect(tools.search.params?.properties?.query).toBeDefined()
    expect(tools.search.params?.required).toContain("query")
    expect(tools.get.params?.properties?.id).toBeDefined()
  })

  // DEFECT 2 (2026-07-15): the MCP-projected schema for `update` showed
  // `revision` as untyped ({}), so every MCP call ("2" or 2) failed ajv's
  // strict `must be integer` check on the SERVER side even when the raw
  // manifest declared the right type. This pins the manifest source of truth;
  // `tool-bridge.test.ts`'s "projects a JSON-Schema integer param..." test
  // pins the projection seam that was actually dropping the type.
  it("update's `revision` param is declared as JSON-Schema `integer` and required", () => {
    const tools = manifest.tools as Record<
      string,
      { params?: { properties?: Record<string, unknown>; required?: string[] } }
    >
    const revisionProp = tools.update.params?.properties?.revision as { type?: string } | undefined
    expect(revisionProp?.type).toBe("integer")
    expect(tools.update.params?.required).toContain("revision")
  })

  it("no scope in manifest references the obsolete knowledge:source-links:write (IS-10)", () => {
    const serialised = JSON.stringify(manifest)
    expect(serialised).not.toContain("knowledge:source-links:write")
  })

  it("descriptor exposes the knowledge-create skill with a lazy body loader", async () => {
    const { knowledgeAppManifest } = await import("./manifest-descriptor")
    const skill = (knowledgeAppManifest as any).skills?.["knowledge-create"]
    expect(skill).toBeDefined()
    expect(skill.description.length).toBeLessThanOrEqual(100)
    expect(typeof skill.body).toBe("function")
    const body = await skill.body()
    expect(typeof body).toBe("string")
    expect(body).toMatch(/document/i)
    expect(body).toMatch(/source.link/i)
    expect(skill.requiredScopes).toContain("knowledge:documents:create")
    expect(skill.requiredScopes).toContain("knowledge:collections:manage")
  })

  it("dedupe matches topic AND doc-type (changelog != recovery article) + no fabricated 'published' (recall arm b)", () => {
    // crisis-bricked-firmware-recall-end-to-end-recovery-partial arm (b): on the recall war-room the
    // model dedupe-matched the pre-existing v2.4 CHANGELOG doc and tried to knowledge:update it into the
    // emergency recovery article (a forbidden/failed path), then fabricated that the article was
    // "live/published/verified" — so the required NEW recovery doc was never created. The generic
    // "DEDUPE FIRST … update THAT one" instruction over-matched on the firmware version. The fix teaches
    // dedupe to match TOPIC *and* DOC-TYPE (a changelog is not a recovery article), so an emergency
    // recovery article is a NEW knowledge:create, plus the anti-fabrication "never claim published unless
    // the create/update succeeded this turn".
    const ai = guideText(manifest)
    expect(ai).toMatch(/DEDUPE MATCHES TOPIC \*AND\* DOC-TYPE/i)
    expect(ai).toMatch(/CHANGELOG \/ release-notes doc and a customer-facing RECOVERY/i)
    expect(ai).toMatch(/create the NEW recovery article|do NOT knowledge:update the changelog/i)
    expect(ai).toMatch(/NEVER claim a doc is 'created \/ published \/ live \/ verified'/i)
    expect(ai).toMatch(/SUCCEEDED in THIS turn and returned a real document id/i)
  })

  it("forbids fabricating an event date / schedule into a doc for a relative-window ask (synth-summit-modular-expo-calendar-blockout-routine root fix, BL-275)", () => {
    // ROOT-CAUSE REGRESSION: asked for a weekday launch-status digest "during the two weeks before
    // Modular Expo" with NO specific dates in any data source, the flash-lite agent intermittently
    // searched-then-INVENTED an expo start date (e.g. "July 10, 2026") and persisted a fabricated
    // 'Event Schedule' Knowledge doc to satisfy the framing — a hard-fail fabrication. The existing
    // "GROUND EVERY FIGURE" rule covered prices/SKUs/specs but not DATES, so the date fabrication slipped
    // through. The agentInstructions + the create tool description must both forbid manufacturing an
    // event date / schedule doc when the dates aren't in a readable source.
    const ai = guideText(manifest)
    expect(ai).toMatch(/DATES ARE FIGURES TOO[,:] NEVER FABRICATE AN EVENT DATE OR SCHEDULE/i)
    expect(ai).toMatch(/RELATIVE window/i)
    expect(ai).toMatch(/bound a recurring routine by its cron, not by an invented date doc/i)
    const tools = manifest.tools as Record<string, { description?: string }>
    const createDesc = tools.create?.description ?? ""
    expect(createDesc).toMatch(/NEVER FABRICATE DATES OR AN EVENT SCHEDULE INTO A DOC/i)
    expect(createDesc).toMatch(
      /manufacturing concrete dates and persisting them here is a fabrication/i,
    )
  })

  it("frames `sensitivity` as INTERNAL access-classification ONLY — `public` does NOT publish a doc externally / make it customer-facing (raphael_week_product S11 root fix, BL-18)", () => {
    // ROOT-CAUSE REGRESSION: asked to "publish the v2.5 release notes to our public help center /
    // website" the flash-lite agent equated the Knowledge doc's `sensitivity: "public"` value with
    // ACTUAL external publication — when probed "can our customers see it on the public help center?"
    // it affirmed "Yes... they are customer-facing" (a hard F2 fabrication: Knowledge is an internal
    // org KB with NO external-publish capability; `public` is only an internal access label). The
    // `sensitivity` enum had NO field description, so the misleading value name `public` drove the
    // wrong inference. The fix: BOTH the create + update `sensitivity` field docs AND the
    // agentInstructions must state explicitly that `sensitivity` is internal-only, that Knowledge has
    // no external-publish surface, and that `public` does NOT make a doc visible to customers on a
    // website/help center — so the agent never asserts external/customer-facing publication.
    const tools = manifest.tools as Record<
      string,
      { params?: { properties?: Record<string, { description?: string }> } }
    >
    for (const toolName of ["create", "update"] as const) {
      const sens = tools[toolName]?.params?.properties?.sensitivity?.description ?? ""
      expect(sens).toMatch(/INTERNAL access-classification ONLY/i)
      expect(sens).toMatch(/NO external-publish capability/i)
      expect(sens).toMatch(/publishes the document to any public help center/i)
      expect(sens).toMatch(/NEVER tell the user the document is 'published externally'/i)
    }
    const ai = guideText(manifest)
    expect(ai).toMatch(/SENSITIVITY IS INTERNAL-ONLY, NOT EXTERNAL PUBLISHING/i)
    expect(ai).toMatch(/no public-help-center \/ website \/ CMS \/ forum-write tool exists/i)
    expect(ai).toMatch(/NEVER tell the user a doc is 'published externally'/i)
  })

  // REGRESSION (nadia_week_ops journey S9 — knowledge-sensitivity-triage-misfiled-doc): the agent set
  // BOTH sensitivity=confidential AND team=["leadership"] on the org-scoped 'Channel economics' doc
  // correctly (revisions 0→1→2, optimistic locks fine), but then INVENTED a non-existent rule that the
  // unchanged `documentScope:"organization"` "overrides" the `team` field and repeatedly told the user
  // the doc was "still visible to the whole organization / everyone in the org can still open it" — a
  // flat misreport of a SUCCESSFUL restriction.
  //
  // UPDATED (Google-Drive-style sharing, 0002 migration): `team`/`sensitivity` are NO LONGER an access
  // gate — they are decoupled annotation dimensions only. Restricting who can read/write an org doc is
  // now done via `orgAccess` ('none' | 'viewer' | 'editor') + explicit `document_shares` rows, mirrored by
  // `assertCanReadDocumentRow`'s `shareRole` param. This test now pins that model instead: a restricted
  // ('none') org doc is invisible to a non-owner/non-creator/non-shared member REGARDLESS of team grant,
  // and becomes visible once explicitly shared — so the agent must reason about sharing, not team/sensitivity,
  // when asked to restrict visibility.
  it("org doc access is governed by orgAccess + explicit shares, NOT team/sensitivity grants (post-sharing-model regression)", () => {
    const orgId = "11111111-1111-1111-1111-111111111111"
    const restrictedDoc = {
      orgId,
      documentScope: "organization" as const,
      ownerUserId: "22222222-2222-2222-2222-222222222222",
      createdBy: "22222222-2222-2222-2222-222222222222",
      orgAccess: "none" as const,
      archivedAt: null,
    }
    const actorWith = (grants: KnowledgeActor["dimensionGrants"]): KnowledgeActor => ({
      orgId,
      userId: "33333333-3333-3333-3333-333333333333",
      scopes: ["knowledge:documents:read"],
      dimensionGrants: grants,
    })
    // A member with a MATCHING team/sensitivity grant but NO explicit share is still DENIED — dimension
    // grants no longer authorize org-doc access on their own.
    expect(() =>
      assertCanReadDocumentRow(
        restrictedDoc,
        actorWith({ team: ["leadership"], sensitivity: ["public", "internal", "confidential"] }),
        null,
      ),
    ).toThrow(/forbidden/i)
    // The SAME member, once explicitly shared (any role), CAN read — regardless of dimension grants.
    expect(() => assertCanReadDocumentRow(restrictedDoc, actorWith({}), "viewer")).not.toThrow()
  })
})

describe("knowledge settings page (settings overhaul P2)", () => {
  it("declares ONE page: synced sources list on synced_sources.* plus the add-source block, no views.settings", () => {
    const m = manifest as unknown as {
      kind?: string
      settings: { sections: Array<{ id: string; scope: string; blocks: any[] }> }
      views: Record<string, unknown>
      tools: Record<string, any>
    }
    expect(validateAppManifest(manifest).success).toBe(true)
    expect(m.kind).toBe("app")
    expect(m.views.settings).toBeUndefined()
    const [section] = m.settings.sections
    expect(section).toMatchObject({ id: "synced-sources", scope: "user" })
    expect(section.blocks[0]).toMatchObject({
      block: "list",
      ops: {
        list: "synced_sources.list",
        archive: "synced_sources.archive",
        rowAction: [{ tool: "synced_sources.run_now" }],
      },
    })
    expect(section.blocks[1]).toMatchObject({ block: "custom", component: "SyncedSourceAdd" })
    for (const t of ["synced_sources.list", "synced_sources.archive", "synced_sources.run_now"]) {
      expect(m.tools[t].agentVisible).toBe(false)
      expect(m.tools[t].requiredScopes).toEqual(["knowledge:documents:read"])
      expect(m.tools[t].gated).toBeUndefined()
    }
    expect(m.tools["synced_sources.list"].readOnly).toBe(true)
  })
})

describe("org-wide write gating (handler-conditional, tighten-only)", () => {
  const tools = (
    manifest as unknown as {
      tools: Record<
        string,
        {
          conditionalGate?: boolean
          approvalImpact?: string
          editableFields?: Array<{ field: string; widget: string }>
        }
      >
    }
  ).tools

  it("create/update/archive declare conditionalGate (org-scope writes park an approval)", () => {
    for (const name of ["create", "update", "archive"]) {
      expect(tools[name]?.conditionalGate).toBe(true)
      expect(tools[name]?.approvalImpact).toBe("internal")
    }
  })

  it("create and update declare title/body editableFields so the card supports editing", () => {
    for (const name of ["create", "update"]) {
      const fields = tools[name]?.editableFields ?? []
      expect(fields.map((f) => f.field).sort()).toEqual(["body", "title"])
      expect(fields.find((f) => f.field === "title")?.widget).toBe("text")
      expect(fields.find((f) => f.field === "body")?.widget).toBe("richtext")
    }
  })

  it("handlers gate org-scope writes through parkForApproval and bypass for personal notes", () => {
    // handlers.ts is script-mode (QuickJS globals), so pin the gating structure
    // by source: each write handler consults ctx.approval (post-approval
    // re-entry) and routes the organization-scope case into parkForApproval;
    // create's bypass keys on documentScope === "personal".
    expect(handlersSource).toMatch(/function\s+parkForApproval/)
    expect(handlersSource).toMatch(/documentScope !== "personal"/)
    // update/archive resolve the TARGET doc's scope before gating.
    expect(handlersSource).toMatch(/function\s+documentScopeOf/)
    const gatedCalls = handlersSource.match(/parkForApproval\(ctx,/g) ?? []
    expect(gatedCalls.length).toBeGreaterThanOrEqual(3)
    // Re-entry bypass present in each write handler.
    const reentryGuards = handlersSource.match(/!ctx\.approval/g) ?? []
    expect(reentryGuards.length).toBeGreaterThanOrEqual(3)
  })
})

// SEARCH BEFORE YOU CREATE. The tool description is the second channel (after
// the MCP instructions block) that reaches an agent about to author a document,
// and a duplicate org doc reached a human approver because neither said so.
describe("knowledge create description: duplication", () => {
  it("tells the agent to look for an existing document and update it instead", () => {
    const desc = (manifest.tools as Record<string, { description: string }>).create.description
    expect(desc).toContain("SEARCH BEFORE YOU CREATE")
    expect(desc).toContain("find_by_title")
    expect(desc.toLowerCase()).toContain("update it instead")
  })
})
