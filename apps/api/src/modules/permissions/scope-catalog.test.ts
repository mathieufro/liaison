// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import projectsManifest from "~/apps/projects/app.manifest.json"
import { manifestRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { getScopeCatalog, invalidateScopeCatalog } from "~/modules/permissions/scope-catalog"

const ORG = "00000000-0000-4000-8000-000000000001"
const OTHER_ORG = "00000000-0000-4000-8000-000000000002"

function seedTool(
  orgId: string,
  app: string,
  toolName: string,
  scope: string,
  extra: { gated?: boolean; approveScope?: string } = {},
): void {
  toolRegistry.set([orgId, app, toolName], {
    appName: app,
    name: toolName,
    requiredScopes: [scope],
    description: "test",
    handler: () => Promise.resolve(null),
    ...extra,
  } as any)
}

describe("scope catalog", () => {
  beforeEach(() => {
    toolRegistry.deleteByPrefix([ORG])
    toolRegistry.deleteByPrefix([OTHER_ORG])
    manifestRegistry.deleteByPrefix([ORG])
    manifestRegistry.deleteByPrefix([OTHER_ORG])
    invalidateScopeCatalog()
  })

  afterEach(() => {
    toolRegistry.deleteByPrefix([ORG])
    toolRegistry.deleteByPrefix([OTHER_ORG])
    manifestRegistry.deleteByPrefix([ORG])
    manifestRegistry.deleteByPrefix([OTHER_ORG])
    invalidateScopeCatalog()
  })

  it("returns kernel scopes deduped, including saved_views entries", () => {
    const out = getScopeCatalog(ORG)
    const scopes = out.map((s) => s.scope)
    expect(scopes).toContain("kernel:users:admin")
    expect(scopes).toContain("kernel:saved_views:share")
    expect(scopes).toContain("kernel:saved_views:admin")
    expect(new Set(scopes).size).toBe(scopes.length)
  })

  it("declares kernel:billing:read so a role can be granted the Usage section", () => {
    const entry = getScopeCatalog(ORG).find((s) => s.scope === "kernel:billing:read")
    expect(entry).toBeDefined()
    expect(entry?.app).toBe("kernel")
    expect(entry?.description).toBeTruthy()
    expect(entry?.description).not.toMatch(/[\u2013\u2014]|--/)
  })

  it("includes the kernel:approve and kernel:skills:approve scopes", () => {
    const out = getScopeCatalog(ORG)
    const kernelApprove = out.find((s) => s.scope === "kernel:approve")
    const skillsApprove = out.find((s) => s.scope === "kernel:skills:approve")
    expect(kernelApprove).toBeDefined()
    expect(kernelApprove?.app).toBe("kernel")
    expect(skillsApprove).toBeDefined()
    expect(skillsApprove?.app).toBe("kernel")
  })

  it("includes the kernel:files:analyze scope", () => {
    const out = getScopeCatalog(ORG)
    const found = out.find((s) => s.scope === "kernel:files:analyze")
    expect(found).toBeDefined()
    expect(found?.app).toBe("kernel")
  })

  it("includes the routine execute-only and delegate scopes", () => {
    const out = getScopeCatalog(ORG)
    const run = out.find((s) => s.scope === "kernel:routines:run")
    const delegate = out.find((s) => s.scope === "kernel:routines:delegate")
    expect(run).toBeDefined()
    expect(run?.app).toBe("kernel")
    expect(delegate).toBeDefined()
    expect(delegate?.app).toBe("kernel")
  })

  it("includes manifest-declared tool scopes for the org", () => {
    seedTool(ORG, "tickets", "list_tickets", "tickets:tickets:read")
    seedTool(ORG, "tickets", "create_ticket", "tickets:tickets:write")
    const out = getScopeCatalog(ORG)
    const found = out.find((s) => s.scope === "tickets:tickets:read")
    expect(found).toBeDefined()
    expect(found?.app).toBe("tickets")
  })

  it("lists the company, suppression and deal scopes", () => {
    manifestRegistry.set([ORG, "projects"], { ...projectsManifest, uiBundleUrl: null } as never)
    const scopes = getScopeCatalog(ORG).map((s) => s.scope)
    for (const scope of [
      "kernel:companies:read",
      "kernel:companies:write",
      "mail:suppressions:read",
      "mail:suppressions:write",
      "projects:deals:read",
      "projects:deals:write",
    ]) {
      expect(scopes, scope).toContain(scope)
    }
    const mail = getScopeCatalog(ORG).filter((s) => s.scope.startsWith("mail:suppressions:"))
    expect(mail.map((s) => s.app)).toEqual(["mail", "mail"])
  })

  it("includes manifest role, settings admin, and entity read scopes", () => {
    manifestRegistry.set([ORG, "projects"], {
      name: "projects",
      roles: {
        admin: { scopes: ["projects:settings:admin"] },
      },
      views: {
        settings: [{ id: "project-settings", adminScope: "projects:settings:write" }],
      },
      entities: {
        task: { readScope: "projects:projects:read" },
      },
      uiBundleUrl: null,
    })

    const scopes = getScopeCatalog(ORG).map((s) => s.scope)
    expect(scopes).toContain("projects:settings:admin")
    expect(scopes).toContain("projects:settings:write")
    expect(scopes).toContain("projects:projects:read")
  })

  it("a gated tool contributes its app's <app>:approve scope", () => {
    // The catalog is documented to agents as "the AUTHORITATIVE universe of
    // permissions", and grant_user_scope tells them never to invent a scope.
    // `<app>:approve` is never declared anywhere — decide/edit/list all derive it
    // as `${appName}:approve` — so it used to be missing from the catalog while
    // being perfectly real and grantable. An admin looking up how to let someone
    // approve Shopify actions concluded the scope did not exist.
    seedTool(ORG, "shopify", "draft_orders_create", "shopify:draft-orders:write", { gated: true })
    const out = getScopeCatalog(ORG)
    const approve = out.find((s) => s.scope === "shopify:approve")
    expect(approve).toBeDefined()
    expect(approve?.app).toBe("shopify")
    expect(approve?.description).toContain("approve")
  })

  // REVISED 2026-08-05. This previously asserted the opposite: that an app with
  // no manifest-`gated` tool contributes NO approve scope. That premise was
  // wrong, and prod proved it. Gating has two sources — the manifest, and an org
  // `approval_policies` row an admin can attach to ANY tool at any time. The
  // knowledge app declares ZERO gated tools and is gated entirely by four org
  // policies, so `knowledge:approve` never entered the catalog, the role editor
  // could not offer it, and it ended up held by NOBODY: every knowledge edit by
  // a C-Level user had to be approved by an org admin.
  //
  // So the rule is now "an app that registers a tool has an approve scope",
  // because any of its tools may be gated by policy. The scope is meaningful
  // whether or not a gate happens to exist today.
  it("an app with tools contributes its approver scope even with no manifest-gated tool", () => {
    seedTool(ORG, "readonly", "list_things", "readonly:things:read")
    expect(getScopeCatalog(ORG).map((s) => s.scope)).toContain("readonly:approve")
  })

  // The regression this exists for, stated directly.
  it("a policy-only-gated app (knowledge) still exposes knowledge:approve", () => {
    seedTool(ORG, "knowledge", "update", "knowledge:documents:update")
    const out = getScopeCatalog(ORG)
    const approve = out.find((s) => s.scope === "knowledge:approve")
    expect(approve).toBeDefined()
    expect(approve?.app).toBe("knowledge")
  })

  it("a gated tool's approveScope override wins over the <app>:approve default", () => {
    seedTool(ORG, "kernel", "create_skill", "kernel:skills:write", {
      gated: true,
      approveScope: "kernel:skills:approve",
    })
    const scopes = getScopeCatalog(ORG).map((s) => s.scope)
    expect(scopes).toContain("kernel:skills:approve")
    // The override replaces the default; it does not additionally synthesize one.
    expect(scopes).not.toContain("kernel:approve:approve")
  })

  it("does not leak scopes from another org", () => {
    seedTool(OTHER_ORG, "tickets", "list_tickets", "tickets:tickets:read")
    const out = getScopeCatalog(ORG)
    expect(out.map((s) => s.scope)).not.toContain("tickets:tickets:read")
  })

  it("dedupes when multiple tools share a scope", () => {
    seedTool(ORG, "tickets", "list_tickets", "tickets:tickets:read")
    seedTool(ORG, "tickets", "get_ticket", "tickets:tickets:read")
    const out = getScopeCatalog(ORG)
    const ticketsRead = out.filter((s) => s.scope === "tickets:tickets:read")
    expect(ticketsRead.length).toBe(1)
  })

  it("cache invalidates per-org so newly registered tool scopes appear", () => {
    const before = getScopeCatalog(ORG)
    expect(before.map((s) => s.scope)).not.toContain("ephemeral:foo:bar")
    seedTool(ORG, "ephemeral", "tool", "ephemeral:foo:bar")
    invalidateScopeCatalog(ORG)
    const after = getScopeCatalog(ORG)
    expect(after.map((s) => s.scope)).toContain("ephemeral:foo:bar")
  })

  it("invalidateScopeCatalog() with no args clears all orgs", () => {
    seedTool(ORG, "tickets", "list_tickets", "tickets:tickets:read")
    getScopeCatalog(ORG)
    getScopeCatalog(OTHER_ORG)
    invalidateScopeCatalog()
    seedTool(OTHER_ORG, "x", "y", "x:y:z")
    expect(getScopeCatalog(OTHER_ORG).map((s) => s.scope)).toContain("x:y:z")
  })
})
