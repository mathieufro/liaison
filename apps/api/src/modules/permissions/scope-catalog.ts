// SPDX-License-Identifier: FSL-1.1-ALv2
import { decidingScopeForToolDef } from "@liaison/shared"
import { manifestRegistry, toolRegistry } from "~/modules/apps/app-registries"

export interface ScopeCatalogEntry {
  scope: string
  app: string
  description?: string
}

/**
 * Kernel scope catalog — the canonical list of kernel-owned scopes.
 * Manifest tools/roles contribute the rest at runtime.
 */
export const KERNEL_SCOPES: ScopeCatalogEntry[] = [
  { scope: "kernel", app: "kernel", description: "Full kernel access" },
  {
    scope: "kernel:users:admin",
    app: "kernel",
    description: "Manage users, roles, and invitations",
  },
  { scope: "kernel:users:read", app: "kernel", description: "Read user list" },
  {
    scope: "kernel:portal:admin",
    app: "kernel",
    description: "See and manage clients' portal accounts",
  },
  { scope: "kernel:org:admin", app: "kernel", description: "Edit org settings" },
  { scope: "kernel:threads:read", app: "kernel", description: "Read threads" },
  { scope: "kernel:threads:write", app: "kernel", description: "Write threads" },
  { scope: "kernel:threads:admin", app: "kernel", description: "Administer threads" },
  { scope: "kernel:contacts:read", app: "kernel", description: "Read contacts" },
  { scope: "kernel:contacts:write", app: "kernel", description: "Write contacts" },
  {
    scope: "kernel:products:read",
    app: "kernel",
    description: "Read product attributes (short codes)",
  },
  {
    scope: "kernel:products:write",
    app: "kernel",
    description: "Write product attributes (short codes)",
  },
  { scope: "kernel:imports:read", app: "kernel", description: "See import runs and their reports" },
  {
    scope: "kernel:imports:run",
    app: "kernel",
    description: "Start and cancel import runs (each kind also needs its own write scopes)",
  },
  { scope: "kernel:imports:undo", app: "kernel", description: "Undo a finished import run" },
  {
    // Dedicated DSR (data-subject-request) authority — distinct from
    // kernel:users:admin (whole-app/org export). Lets a privacy/finance handler
    // compile ONE data subject's records across apps into a single GDPR bundle
    // WITHOUT org-admin powers. Gates the `data_subject_export` kernel tool.
    scope: "kernel:data_subject:export",
    app: "kernel",
    description:
      "Compile a single data subject's records across apps into one GDPR data-subject-request (DSR) export bundle (privacy/DSR handler authority, NOT org admin)",
  },
  { scope: "kernel:files:read", app: "kernel", description: "Read files attached to entities" },
  {
    scope: "kernel:files:analyze",
    app: "kernel",
    description: "Analyze image/video files with the media-analysis tool",
  },
  { scope: "kernel:audit:read", app: "kernel", description: "Read audit log" },
  {
    // Gates the Usage settings section and the credit usage and transaction
    // reads behind it. Without an entry here no role could be granted it, so
    // only wildcard admins ever reached Usage.
    scope: "kernel:billing:read",
    app: "kernel",
    description:
      "Read AI credit usage: the Usage settings page, usage chart and credit transactions (own transactions only unless also an org admin)",
  },
  { scope: "kernel:audit:write", app: "kernel", description: "Write to audit log" },
  {
    scope: "kernel:approve",
    app: "kernel",
    description: "Decide kernel-level approvals (skills, routines, roles, policies)",
  },
  // Kernel TOOL scopes that the live catalog only ever learned from the tool
  // registry, so this "canonical list of kernel-owned scopes" did not carry
  // them and anything reading it without a running org runtime (the offline
  // scope registry, and a reader taking the list at its word) concluded they
  // did not exist. `kernel:roles:admin` is the sharpest case: the agent ceiling
  // guard's own ADMIN_SCOPES list names it as one of the four organization
  // administration scopes, and it was absent here.
  { scope: "kernel:roles:admin", app: "kernel", description: "Create and edit roles" },
  {
    scope: "kernel:routines:read",
    app: "kernel",
    description: "List and read routines and their run history",
  },
  {
    scope: "kernel:routines:write",
    app: "kernel",
    description: "Create, edit, enable and delete your own routines",
  },
  {
    scope: "kernel:policies:write",
    app: "kernel",
    description:
      "Read the org's auto-approve (loosening) policies; setting them (policy_set) requires kernel:policies:admin",
  },
  {
    scope: "kernel:contacts:admin",
    app: "kernel",
    description: "Change who can see contacts nobody owns (shared-mailbox and imported contacts)",
  },
  {
    scope: "kernel:contacts:export",
    app: "kernel",
    description: "Export the contact registry",
  },
  {
    scope: "kernel:agent:web",
    app: "kernel",
    description: "Fetch and search the public web from an agent turn",
  },
  // The skill read/write pair gates the /api/skills routes and the skill_read
  // / skill_search / list_skills / update_skill kernel tools, and was missing
  // from this list: an admin reading `list_scopes` as "the AUTHORITATIVE
  // universe of permissions" could not find the scope an agent needed to open
  // its own playbook, and the offline scope registry read it as an unknown
  // string.
  { scope: "kernel:skills:read", app: "kernel", description: "Read skills" },
  { scope: "kernel:skills:write", app: "kernel", description: "Create and edit skills" },
  {
    scope: "kernel:skills:approve",
    app: "kernel",
    description: "Approve skill changes, restricted by the kernel:skills_domain dimension grant",
  },
  { scope: "kernel:approvals:read", app: "kernel", description: "Read approval requests" },
  { scope: "kernel:approvals:write", app: "kernel", description: "Decide on approval requests" },
  { scope: "kernel:approvals:admin", app: "kernel", description: "Administer approvals" },
  {
    scope: "kernel:bug_reports:file",
    app: "kernel",
    description: "Report a bug about Liaison under your own name (every active member holds it)",
  },
  {
    scope: "kernel:agent:memory",
    app: "kernel",
    description: "Agent-tool gate for reading/writing user memory (kernel tool surface)",
  },
  {
    scope: "kernel:agent:memory:read",
    app: "kernel",
    description: "Read the current user's agent memory",
  },
  {
    scope: "kernel:agent:memory:write",
    app: "kernel",
    description: "Create, update, or delete the current user's agent memory",
  },
  {
    scope: "kernel:saved_views:share",
    app: "kernel",
    description: "Share saved views with the org",
  },
  {
    scope: "kernel:saved_views:admin",
    app: "kernel",
    description: "Manage shared and default saved views",
  },
  {
    // Operator-level: runtime app install/upgrade/uninstall is instance-wide.
    // On a multi-tenant instance (demo mode, managed edition) the routes are also
    // confined to the operator's org (LIAISON_OPERATOR_ORG_ID, else the first org).
    scope: "kernel:apps:admin",
    app: "kernel",
    description: "Install, upgrade, and uninstall apps (instance operator)",
  },
  {
    scope: "kernel:agents:spawn",
    app: "kernel",
    description: "Dispatch fresh-context sub-agent runs via the spawn_agent kernel tool",
  },
  {
    scope: "kernel:agents:admin",
    app: "kernel",
    description: "Author and remove sub-agent role definitions (subagent_create / _delete)",
  },
  {
    // The composed agent DEFINITION read: system prompt, own skill bodies,
    // scoped memory and tool list, over GET /api/agents/:agentId/definition
    // (the desktop client's Local-model composition fetch). It was reachable by
    // every org member on session auth alone, which handed an agent's whole
    // playbook set to anyone who could log in. Deliberately NOT in the `member`
    // default role: a definition read is an operator grant, and `*` (admin)
    // still covers it.
    scope: "kernel:agents:read",
    app: "kernel",
    description: "Read an agent's composed definition (system prompt, skill bodies, tool list)",
  },
  {
    scope: "kernel:scope_requests:admin",
    app: "kernel",
    description: "Review and decide scope-access requests (grant/deny)",
  },
  {
    // Execute-only authority over SHARED routines: run_routine_now on a shared
    // routine you don't own, WITHOUT the edit/delete/delegate rights that
    // kernel:routines:delegate or kernel:apps:admin carry.
    scope: "kernel:routines:run",
    app: "kernel",
    description: "Run shared org routines on demand (execute-only, no edit rights)",
  },
  {
    scope: "kernel:routines:delegate",
    app: "kernel",
    description:
      "Build and manage routines for the team: create routines that run as another user, edit/delete shared routines",
  },
  {
    scope: "kernel:policies:read",
    app: "kernel",
    description: "Read the org's auto-approve (loosening) and approval-tightening policies",
  },
  {
    scope: "kernel:policies:admin",
    app: "kernel",
    description:
      "Configure the org's approval policies, an admin authority: APPROVAL-TIGHTENING ones via approval_policy_set (require approval / N-eyes per tool + condition) and AUTO-APPROVE (loosening) ones via policy_set",
  },
]

const cache = new Map<string, ScopeCatalogEntry[]>()

export function invalidateScopeCatalog(orgId?: string): void {
  if (orgId) cache.delete(orgId)
  else cache.clear()
}

export function getScopeCatalog(orgId: string): ScopeCatalogEntry[] {
  const hit = cache.get(orgId)
  if (hit) return hit

  const seen = new Set<string>()
  const out: ScopeCatalogEntry[] = []

  const addScope = (scope: unknown, app: string, description?: unknown) => {
    if (typeof scope !== "string" || scope.length === 0 || seen.has(scope)) return
    seen.add(scope)
    out.push({
      scope,
      app,
      ...(typeof description === "string" ? { description } : {}),
    })
  }

  const addScopes = (scopes: unknown, app: string) => {
    if (!Array.isArray(scopes)) return
    for (const scope of scopes) addScope(scope, app)
  }

  for (const entry of KERNEL_SCOPES) {
    addScope(entry.scope, entry.app, entry.description)
  }

  // Walk toolRegistry for manifest-declared tool scopes for this org.
  //
  // A gated tool ALSO implies an approver scope that no manifest declares: the
  // decide/edit/list paths all derive it as `${appName}:approve` (with the
  // tool's optional `approveScope` overriding it). Nothing else contributes
  // those strings, so without this pass the catalog silently omitted
  // shopify:approve, boxtal:approve, invoicing:approve, projects:approve,
  // mail:approve, pennylane:approve, social:approve — real, grantable scopes
  // held by real roles. An admin (or an agent) reading list_scopes as "the
  // AUTHORITATIVE universe of permissions" therefore concluded the scope did
  // not exist and could not grant the one capability the person was missing:
  // the right to approve that app's gated actions.
  const approverScopes = new Map<string, string>()
  for (const [[tOrgId, tApp], tool] of toolRegistry.entriesOf(orgId)) {
    if (tOrgId !== orgId) continue
    const def = tool as { requiredScopes?: string[]; gated?: boolean; approveScope?: string }
    addScopes(def.requiredScopes, tApp)
    // Every app that registers a tool gets its approve scope, NOT only apps
    // with a manifest-`gated` tool. Gating has two sources: the manifest, and
    // an org `approval_policies` row an admin can add to ANY tool at any time.
    // Deriving from the manifest alone meant a policy-only-gated app never
    // surfaced its approve scope, so the role editor could not offer it.
    //
    // That is exactly how `knowledge:approve` came to be held by nobody: the
    // knowledge app declares ZERO gated tools, its gate comes entirely from four
    // org policies (2026-07-22), and when the C-Level role was built the scope
    // it needed was simply not on the list. Two members' knowledge edits
    // then had to go to an admin. This catalog is read as the authoritative
    // universe of permissions, so an absent scope reads as a nonexistent one.
    approverScopes.set(decidingScopeForToolDef(def, tApp), tApp)
  }
  for (const [scope, app] of approverScopes) {
    addScope(
      scope,
      app,
      `Decide (approve, edit, or deny) ${app} approvals raised by its gated tools`,
    )
  }

  // Walk manifests for scopes that are not necessarily attached to executable tools.
  for (const [[mOrgId, appName], manifest] of manifestRegistry.entriesOf(orgId)) {
    if (mOrgId !== orgId) continue

    for (const role of Object.values((manifest as { roles?: Record<string, any> }).roles ?? {})) {
      addScopes((role as { scopes?: unknown }).scopes, appName)
    }

    const manifestViews = manifest.views as Record<string, any> | undefined
    const settingsGroups = [
      manifestViews?.settings,
      ...Object.values(manifestViews ?? {}).map((v) => v?.settings),
    ]
    for (const settings of settingsGroups) {
      if (!Array.isArray(settings)) continue
      for (const entry of settings) {
        addScope((entry as { adminScope?: unknown; label?: unknown }).adminScope, appName)
      }
    }
    // The declarative settings page: each section's adminScope.
    for (const section of manifest.settings?.sections ?? []) addScope(section.adminScope, appName)

    for (const entity of Object.values(manifest.entities ?? {})) {
      addScope((entity as { readScope?: unknown }).readScope, appName)
    }

    for (const bulk of Object.values(manifest.bulk ?? {})) {
      addScope((bulk as { scope?: unknown }).scope, appName)
    }
  }

  cache.set(orgId, out)
  return out
}
