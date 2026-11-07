// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Oracle half of the requiredScopes guard (see tool-required-scopes-guard.test.ts).
// The registry type makes `tool.scope` a compile error, but a value typed `any`
// or cast to an ad hoc `{ scope?: ... }` shape escapes the type. So every read
// of a property named `scope` in non-test source is found by syntax, not by
// regex: a property access `x.scope`, a bracket access `x["scope"]`, and an
// object destructuring `{ scope } = x` or `{ scope: y } = x` (declarations,
// parameters and assignments alike).
//
// Each read must match an allowlist entry by file AND exact line text, with the
// reason that line is not a tool definition. A new read fails even under a
// receiver name that is already allowlisted elsewhere in the same file, and an
// entry that no longer matches a read fails as stale.

import { describe, expect, it } from "bun:test"
import { type Dirent, readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"

const ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")

const SKIP_DIRS = new Set(["node_modules", "dist", "tests", "__tests__", "__fixtures__"])

function scanRoots(): string[] {
  const roots = ["apps/api/src", "apps/web/src"]
  for (const parent of ["packages", "bundled-apps"]) {
    for (const entry of readdirSync(join(ROOT, parent), { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(`${parent}/${entry.name}/src`)
    }
  }
  return roots
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) sourceFiles(join(dir, entry.name), out)
      continue
    }
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$|\.d\.ts$/.test(entry.name)) continue
    out.push(join(dir, entry.name))
  }
  return out
}

type ReadKind = "access" | "bracket" | "destructure"

/** Every read of a property named `scope` in `src`, with its kind and trimmed line text. */
function scopeReads(fileName: string, src: string): Array<{ kind: ReadKind; line: string }> {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, kind)
  const lines = src.split("\n")
  const reads: Array<{ kind: ReadKind; line: string }> = []
  const hit = (node: ts.Node, readKind: ReadKind) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
    reads.push({ kind: readKind, line: (lines[line] ?? "").trim() })
  }
  const isScopeName = (name: ts.Node | undefined): boolean =>
    !!name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) && name.text === "scope"
  // An object literal on the left of `=` (or nested there) is a destructuring target.
  const isAssignmentTarget = (node: ts.ObjectLiteralExpression): boolean => {
    let child: ts.Node = node
    let parent = node.parent
    while (
      parent &&
      (ts.isParenthesizedExpression(parent) || ts.isArrayLiteralExpression(parent))
    ) {
      child = parent
      parent = parent.parent
    }
    if (parent && ts.isPropertyAssignment(parent) && ts.isObjectLiteralExpression(parent.parent)) {
      return isAssignmentTarget(parent.parent)
    }
    return (
      !!parent &&
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.left === child
    )
  }
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === "scope") hit(node, "access")
    else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === "scope"
    ) {
      hit(node, "bracket")
    } else if (
      ts.isBindingElement(node) &&
      ts.isObjectBindingPattern(node.parent) &&
      isScopeName(node.propertyName ?? node.name)
    ) {
      hit(node, "destructure")
    } else if (ts.isObjectLiteralExpression(node) && isAssignmentTarget(node)) {
      for (const prop of node.properties) {
        if (
          (ts.isShorthandPropertyAssignment(prop) || ts.isPropertyAssignment(prop)) &&
          isScopeName(prop.name)
        ) {
          hit(prop, "destructure")
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return reads
}

/** Why a `scope` read is not a tool definition. */
const REASONS = {
  GITLAB: "the GitLab search API's own scope parameter",
  API_CONNECTOR:
    "an API adapter's OAuth2 client-credentials scope (RFC 6749), sent to its token URL",
  KNOW: "a knowledge source or document's personal or organization visibility",
  GRANT: "a scope grant row or a grant table's scope column",
  POLICY: "a scope disclosure policy row or its table's column",
  FRAME: "a websocket status frame's scope",
  SKILL: "a skill's user or org visibility",
  LOCKED: "a locked capability digest: its scope is the joined missing requiredScopes",
  APPROVAL: "a row of the approval visibility query",
  ATTN: "an attention item provider registration",
  OAUTH: "an OAuth token response",
  PROTECTED_OAUTH: "a connection's protected OAuth scope declaration (manifest protectedScopes)",
  CATALOG: "a scope catalog entry",
  BULK: "a manifest bulk action declaration",
  PROVIDER:
    "a context provider declaration, whose scope is checked against its tool's requiredScopes",
  RECIP: "an attention scope_holders recipient spec",
  EXPORT: "an export handler registration",
  ROUTE: "a route parameter naming the scope being granted",
  SHARE: "a share anyway computed scope",
  COMMAND: "a command palette entry's required scope",
  DOC: "an invoice document's goods or software split",
  PENNY: "the Pennylane token scope (company or firm)",
  CAL: "a calendar edit's occurrence or series scope",
  NODE: "a node session permission answer's grant scope (once or always)",
  FEED: "a node session event feed's scope (the main thread or a subagent's Agent call id)",
  SIGNAL: "a security signal's rate-limit scope (identifier or address)",
  MCP_OAUTH: "an MCP server's OAuth scope (a challenge, a grant request or a token response)",
  GRANT_ROW:
    "a stored role or user scope grant row (kernel role_scope_grants / user_scope_grants), not a tool",
  CATALOG_ENTRY: "a scope catalog entry (the org's registered scopes), not a tool",
  CHANGE_PAYLOAD: "an org-app access change payload ({ scope, mode }), not a tool",
  ROUTE_PARAM: "a URL route or search parameter naming a scope filter, not a tool",
  SETTINGS: "a declarative settings section's user or org scope",
} as const

// One entry per read, keyed by file and exact trimmed line. A line that reads
// scope twice, or repeats in a file, is listed once per read.
const SCOPE_READ_ALLOWLIST: ReadonlyArray<readonly [file: string, line: string, reason: string]> = [
  [
    "apps/api/src/modules/mcp-client/call.ts",
    'return err.challenge.scope ?? ""',
    REASONS.MCP_OAUTH,
  ],
  [
    "apps/api/src/modules/mcp-client/transports/types.ts",
    "...(p.scope ? { scope: p.scope } : {}),",
    REASONS.MCP_OAUTH,
  ],
  [
    "apps/api/src/modules/mcp-client/transports/types.ts",
    "...(p.scope ? { scope: p.scope } : {}),",
    REASONS.MCP_OAUTH,
  ],
  [
    "apps/api/src/modules/mcp-client/transports/fixtures/oauth-mcp-server.ts",
    'scope: q.scope ?? "",',
    REASONS.MCP_OAUTH,
  ],
  [
    "apps/api/src/modules/mcp-client/transports/fixtures/oauth-mcp-server.ts",
    "return issueTokens(client.clientId, pending.scope, pending.resource)",
    REASONS.MCP_OAUTH,
  ],
  [
    "apps/api/src/modules/mcp-client/transports/fixtures/oauth-mcp-server.ts",
    "return issueTokens(client.clientId, rt.scope, rt.resource)",
    REASONS.MCP_OAUTH,
  ],
  [
    "apps/api/src/modules/mcp-client/transports/fixtures/oauth-mcp-server.ts",
    "const scope = extra.scope ?? opts.challengeScope",
    REASONS.MCP_OAUTH,
  ],
  [
    "apps/api/src/modules/mcp-client/transports/fixtures/oauth-mcp-server.ts",
    'const granted = issued.scope.split(" ")',
    REASONS.MCP_OAUTH,
  ],
  [
    "apps/api/src/modules/mcp-client/oauth-tokens.ts",
    "...(tokens.scope ? { scope: tokens.scope } : {}),",
    REASONS.MCP_OAUTH,
  ],
  [
    "apps/api/src/modules/mcp-client/oauth-tokens.ts",
    "...(tokens.scope ? { scope: tokens.scope } : {}),",
    REASONS.MCP_OAUTH,
  ],
  [
    "apps/api/src/modules/mcp-client/oauth-tokens.ts",
    "scope: fields.scope ?? meta.scope,",
    REASONS.MCP_OAUTH,
  ],
  [
    "apps/api/src/modules/mcp-client/oauth-tokens.ts",
    "scope: fields.scope ?? meta.scope,",
    REASONS.MCP_OAUTH,
  ],
  [
    "apps/api/src/modules/mcp-client/index.ts",
    "[meta.scope, meta.requiredScope, scope]",
    REASONS.MCP_OAUTH,
  ],
  [
    "apps/api/src/modules/apps/contract.ts",
    "const KERNEL_SCOPE_SET = new Set(KERNEL_SCOPES.map((e) => e.scope))",
    REASONS.CATALOG,
  ],
  [
    "apps/api/src/modules/apps/contract.ts",
    "for (const bulk of Object.values((manifest.bulk ?? {}) as Record<string, any>)) add(bulk?.scope)",
    REASONS.BULK,
  ],
  [
    "apps/api/src/modules/agent/context/context-providers.ts",
    "if (!hasScope(decl.scope, [...input.grants])) return null",
    REASONS.PROVIDER,
  ],
  [
    "apps/api/src/modules/agent/context/context-providers.ts",
    "...new Set([decl.scope, ...resolveRequiredScopes(tool)]),",
    REASONS.PROVIDER,
  ],
  ["apps/api/src/modules/apps/contract.ts", "if (!required.includes(p.scope)) {", REASONS.PROVIDER],
  [
    "apps/api/src/modules/apps/contract.ts",
    "errors.push(`${at}.scope: '${p.scope}' is not in the requiredScopes of '${p.tool}'`)",
    REASONS.PROVIDER,
  ],
  [
    "apps/api/src/modules/apps/app-visibility.ts",
    "if (list) list.push(entry.scope)",
    REASONS.CATALOG,
  ],
  [
    "apps/api/src/modules/apps/app-visibility.ts",
    "else appScopes.set(entry.app, [entry.scope])",
    REASONS.CATALOG,
  ],
  [
    "apps/api/src/modules/apps/settings-schema-from-manifest.ts",
    's.scope === "org" && s.adminScope === undefined',
    REASONS.SETTINGS,
  ],
  [
    "apps/api/src/modules/apps/settings-schema-from-manifest.ts",
    "fields[section.scope].set(block.key, {",
    REASONS.SETTINGS,
  ],
  [
    "apps/api/src/modules/apps/settings-schema-from-manifest.ts",
    'adminScope: section.scope === "org" ? (section.adminScope ?? null) : null,',
    REASONS.SETTINGS,
  ],
  [
    "apps/api/src/apps/mcp-manager/oauth-discovery.ts",
    "if (!p.resourceMetadataUrl && !p.scope && !p.error) {",
    REASONS.MCP_OAUTH,
  ],
  [
    "apps/api/src/apps/mcp-manager/oauth-discovery.ts",
    "...(p.scope ? { scope: p.scope } : {}),",
    REASONS.MCP_OAUTH,
  ],
  [
    "apps/api/src/apps/mcp-manager/oauth-discovery.ts",
    "...(p.scope ? { scope: p.scope } : {}),",
    REASONS.MCP_OAUTH,
  ],
  [
    "apps/api/src/apps/mcp-manager/oauth-discovery.ts",
    "...(opts.challenge?.scope ? { challengeScope: opts.challenge.scope } : {}),",
    REASONS.MCP_OAUTH,
  ],
  [
    "apps/api/src/apps/mcp-manager/oauth-discovery.ts",
    "...(opts.challenge?.scope ? { challengeScope: opts.challenge.scope } : {}),",
    REASONS.MCP_OAUTH,
  ],
  [
    "apps/api/src/apps/mcp-manager/oauth-routes.ts",
    "scope: fields.scope ?? stateRow.scope ?? meta.scope,",
    REASONS.MCP_OAUTH,
  ],
  [
    "apps/api/src/apps/mcp-manager/oauth-routes.ts",
    "scope: fields.scope ?? stateRow.scope ?? meta.scope,",
    REASONS.MCP_OAUTH,
  ],
  [
    "apps/api/src/apps/mcp-manager/oauth-routes.ts",
    "scope: fields.scope ?? stateRow.scope ?? meta.scope,",
    REASONS.MCP_OAUTH,
  ],
  [
    "apps/api/src/apps/mcp-manager/oauth-routes.ts",
    "...(plan.scope ? { scope: plan.scope } : {}),",
    REASONS.MCP_OAUTH,
  ],
  [
    "apps/api/src/apps/mcp-manager/oauth-routes.ts",
    "...(plan.scope ? { scope: plan.scope } : {}),",
    REASONS.MCP_OAUTH,
  ],
  [
    "apps/api/src/apps/mcp-manager/oauth-routes.ts",
    "scope: plan.scope ?? null,",
    REASONS.MCP_OAUTH,
  ],
  [
    "apps/api/src/apps/mcp-manager/oauth-registration.ts",
    "...(input.scope ? { scope: input.scope } : {}),",
    REASONS.MCP_OAUTH,
  ],
  [
    "apps/api/src/apps/mcp-manager/oauth-registration.ts",
    "...(input.scope ? { scope: input.scope } : {}),",
    REASONS.MCP_OAUTH,
  ],
  ["apps/web/src/framework/define-app.ts", "scope: s.scope,", REASONS.SETTINGS],
  [
    "apps/web/src/modules/settings/SettingsPageParts.tsx",
    "<Show when={props.scope}>",
    REASONS.SETTINGS,
  ],
  [
    "apps/web/src/modules/settings/SettingsPageParts.tsx",
    '{props.scope === "org"',
    REASONS.SETTINGS,
  ],
  [
    "apps/web/src/modules/settings/visible-settings-sections.ts",
    'if (section.scope === "user") return true',
    REASONS.SETTINGS,
  ],
  [
    "apps/web/src/modules/settings/app-page/AppSettingsPage.tsx",
    'return sections.some((s) => s.scope === scope && s.blocks.some((b) => b.block === "field"))',
    REASONS.SETTINGS,
  ],
  [
    "apps/web/src/modules/settings/app-page/AppSettingsPage.tsx",
    "const scope = section.scope",
    REASONS.SETTINGS,
  ],
  [
    "apps/web/src/modules/settings/app-page/AppSettingsPage.tsx",
    "const values = loaded(section.scope)",
    REASONS.SETTINGS,
  ],
  // App management (S20, S21): whether an app owns scopes, the workspace's `*`
  // holders, and a listing's permissions in the catalog's words.
  [
    "apps/api/src/modules/apps/org-apps.ts",
    '.where(and(eq(userScopeGrants.orgId, orgId), eq(userScopeGrants.scope, "*")))',
    REASONS.GRANT,
  ],
  [
    "apps/api/src/modules/apps/org-apps.ts",
    '.where(and(eq(userRoles.orgId, orgId), eq(roleScopeGrants.scope, "*")))',
    REASONS.GRANT,
  ],
  [
    "apps/web/src/modules/settings/app-store/AppStoreDetail.tsx",
    "const scopes = own.length > 0 ? own.map((e) => e.scope) : item.scopes",
    REASONS.CATALOG,
  ],
  [
    "apps/web/src/modules/settings/app-page/SectionView.tsx",
    'props.section.scope === "user"',
    REASONS.SETTINGS,
  ],
  [
    "apps/web/src/modules/settings/app-page/SectionView.tsx",
    '{props.section.scope === "user"',
    REASONS.SETTINGS,
  ],
  [
    "apps/web/src/modules/settings/app-page/SectionView.tsx",
    'return props.section.scope === "user"',
    REASONS.SETTINGS,
  ],
  [
    "apps/web/src/modules/settings/app-page/SectionView.tsx",
    'personalSection={props.section.scope === "user"}',
    REASONS.SETTINGS,
  ],
  [
    "apps/web/src/modules/settings/app-page/page-model.ts",
    'if (section.scope === "user") return null',
    REASONS.SETTINGS,
  ],
  [
    "apps/web/src/modules/settings/app-page/page-model.ts",
    '...all.filter((s) => s.scope === "user"),',
    REASONS.SETTINGS,
  ],
  [
    "apps/web/src/modules/settings/app-page/page-model.ts",
    'return s.scope === "org" && scope !== null && canAccess(scope)',
    REASONS.SETTINGS,
  ],
  ["packages/app-sdk/src/app-settings.ts", 'if (section.scope === "user") {', REASONS.SETTINGS],
  ["packages/app-sdk/src/app-settings.ts", 'if (section.scope !== "org") {', REASONS.SETTINGS],
  [
    "packages/app-sdk/src/app-settings.ts",
    "const seen = settingsKeys[section.scope]",
    REASONS.SETTINGS,
  ],
  [
    "packages/app-sdk/src/app-settings.ts",
    '`${bat}.key: "${block.key}" overlaps "${clash}" (${seen.get(clash)}) in the ${section.scope} settings`,',
    REASONS.SETTINGS,
  ],
  [
    "apps/api/src/cli/provisioners/roles.ts",
    "const current = new Set((detail?.scopes ?? []).map((s) => s.scope))",
    REASONS.GRANT,
  ],
  [
    "apps/api/src/lib/mailbox-status-frame.ts",
    'if (frame.type !== "status" || frame.scope !== "mailbox") return null',
    REASONS.FRAME,
  ],
  [
    "apps/api/src/lib/server.ts",
    '} else if (data.type === "status" && data.scope === "mailbox") {',
    REASONS.FRAME,
  ],
  [
    "apps/api/src/db/schema/kernel/scope-disclosure-policy.ts",
    '(t) => [uniqueIndex("scope_disclosure_policy_org_scope_idx").on(t.orgId, t.scope)],',
    REASONS.POLICY,
  ],
  [
    "apps/api/src/db/schema/kernel/roles.ts",
    'uniqueIndex("role_scope_grants_role_scope_idx").on(table.roleId, table.scope),',
    REASONS.GRANT,
  ],
  [
    "apps/api/src/db/schema/kernel/roles.ts",
    'uniqueIndex("user_scope_grants_user_org_scope_idx").on(table.userId, table.orgId, table.scope),',
    REASONS.GRANT,
  ],
  ["apps/api/src/modules/attention/translator.ts", "scope: t.recipients.scope,", REASONS.RECIP],
  [
    "apps/api/src/modules/attention/recipients.ts",
    "const ids = await ctx.loadScopeHolders(ctx.orgId, spec.scope, spec.dimensionFilter)",
    REASONS.RECIP,
  ],
  [
    "apps/api/src/modules/agent/tools/admin-tools.ts",
    "const grantedStrings = detail.effectiveScopes.map((s) => s.scope)",
    REASONS.GRANT,
  ],
  [
    "apps/api/src/modules/agent/tools/admin-tools.ts",
    "const exact = detail.effectiveScopes.find((s) => s.scope === required)",
    REASONS.GRANT,
  ],
  [
    "apps/api/src/modules/agent/tools/admin-tools.ts",
    "const covering = detail.effectiveScopes.find((s) => hasScope(required, [s.scope]))",
    REASONS.GRANT,
  ],
  [
    "apps/api/src/modules/agent/tools/admin-tools.ts",
    'via = covering?.scope.includes("*") ? "wildcard" : "parent"',
    REASONS.GRANT,
  ],
  [
    "apps/api/src/modules/agent/tools/admin-tools.ts",
    "scopes: after.scopes.map((s) => s.scope),",
    REASONS.GRANT,
  ],
  ["apps/api/src/modules/agent/tools/admin-tools.ts", ".map((s) => s.scope)", REASONS.GRANT],
  [
    "apps/api/src/modules/agent/tools/admin-tools.ts",
    "const scopes = detail?.scopes.map((s) => s.scope) ?? []",
    REASONS.GRANT,
  ],
  [
    "apps/api/src/modules/agent/tools/skills-routines-tools.ts",
    'if (params.scope === "org") {',
    REASONS.SKILL,
  ],
  [
    "apps/api/src/modules/agent/tools/skills-routines-tools.ts",
    'const userIdForRow = params.scope === "user" ? (ctx.approverUserId ?? ctx.userId) : null',
    REASONS.SKILL,
  ],
  [
    "apps/api/src/modules/agent/tools/skills-routines-tools.ts",
    'subtitle: p.scope === "org" ? "Org-wide" : "Personal",',
    REASONS.SKILL,
  ],
  [
    "apps/api/src/modules/agent/tools/scope-request-tools.ts",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the exact text of a source line
    "const byName = locked.filter((t) => matches(`${t.name} ${t.app} ${t.scope}`))",
    REASONS.LOCKED,
  ],
  ["apps/api/src/modules/agent/tools/scope-request-tools.ts", "scope: t.scope,", REASONS.LOCKED],
  [
    "apps/api/src/modules/agent/skills/skills-routes.ts",
    'const { scope } = c.req.valid("json")',
    REASONS.SKILL,
  ],
  [
    "apps/api/src/modules/permissions/scope-disclosure-policy.ts",
    "scope: scopeDisclosurePolicy.scope,",
    REASONS.POLICY,
  ],
  [
    "apps/api/src/modules/permissions/scope-disclosure-policy.ts",
    "and(eq(scopeDisclosurePolicy.orgId, orgId), inArray(scopeDisclosurePolicy.scope, scopes)),",
    REASONS.POLICY,
  ],
  [
    "apps/api/src/modules/permissions/scope-disclosure-policy.ts",
    "const withheld = new Set(rows.filter((r) => !r.disclosable).map((r) => r.scope))",
    REASONS.POLICY,
  ],
  [
    "apps/api/src/modules/permissions/scope-disclosure-policy.ts",
    ".select({ scope: scopeDisclosurePolicy.scope })",
    REASONS.POLICY,
  ],
  [
    "apps/api/src/modules/permissions/scope-disclosure-policy.ts",
    "closedScopes = rows.map((r) => r.scope)",
    REASONS.POLICY,
  ],
  [
    "apps/api/src/modules/permissions/scope-disclosure-policy.ts",
    "const { orgId, scope, disclosable } = params",
    REASONS.POLICY,
  ],
  [
    "apps/api/src/modules/permissions/scope-disclosure-policy.ts",
    "target: [scopeDisclosurePolicy.orgId, scopeDisclosurePolicy.scope],",
    REASONS.POLICY,
  ],
  [
    "apps/api/src/modules/permissions/scope-disclosure-policy.ts",
    "scope: scopeDisclosurePolicy.scope,",
    REASONS.POLICY,
  ],
  [
    "apps/api/src/modules/permissions/permissions.ts",
    "for (const g of sources.roleScopeGrants) scopeSet.add(g.scope)",
    REASONS.GRANT,
  ],
  [
    "apps/api/src/modules/permissions/permissions.ts",
    "for (const g of sources.userScopeGrants) scopeSet.add(g.scope)",
    REASONS.GRANT,
  ],
  [
    "apps/api/src/modules/permissions/app-grants.ts",
    ".select({ scope: userScopeGrants.scope })",
    REASONS.GRANT,
  ],
  [
    "apps/api/src/modules/permissions/app-grants.ts",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the exact text of a source line
    "like(userScopeGrants.scope, `${args.callingApp}:%`),",
    REASONS.GRANT,
  ],
  [
    "apps/api/src/modules/permissions/app-grants.ts",
    "const existingSet = new Set(existing.map((r) => r.scope))",
    REASONS.GRANT,
  ],
  [
    "apps/api/src/modules/permissions/app-grants.ts",
    "inArray(userScopeGrants.scope, toRemove),",
    REASONS.GRANT,
  ],
  [
    "apps/api/src/modules/permissions/roles-routes.ts",
    'const { scope } = c.req.valid("json")',
    REASONS.ROUTE,
  ],
  [
    "apps/api/src/modules/permissions/roles-routes.ts",
    'const { roleId, scope } = c.req.valid("param")',
    REASONS.ROUTE,
  ],
  [
    "apps/api/src/modules/permissions/roles-routes.ts",
    'const { scope } = c.req.valid("json")',
    REASONS.ROUTE,
  ],
  ["apps/api/src/modules/permissions/roles.ts", "scope: roleScopeGrants.scope,", REASONS.GRANT],
  [
    "apps/api/src/modules/permissions/roles.ts",
    ".returning({ scope: roleScopeGrants.scope })",
    REASONS.GRANT,
  ],
  [
    "apps/api/src/modules/permissions/roles.ts",
    "const added = inserted.map((row) => row.scope)",
    REASONS.GRANT,
  ],
  [
    "apps/api/src/modules/permissions/roles.ts",
    "scopes: scopes.map((s) => ({ scope: s.scope, grantedAt })),",
    REASONS.GRANT,
  ],
  [
    "apps/api/src/modules/permissions/roles.ts",
    "if (!hasScope(params.scope, params.actorScopes)) {",
    REASONS.GRANT,
  ],
  [
    "apps/api/src/modules/permissions/roles.ts",
    ".values({ roleId: params.roleId, scope: params.scope })",
    REASONS.GRANT,
  ],
  [
    "apps/api/src/modules/permissions/roles.ts",
    "data: { roleId: params.roleId, scope: params.scope },",
    REASONS.GRANT,
  ],
  [
    "apps/api/src/modules/permissions/roles.ts",
    "if (!hasScope(params.scope, params.actorScopes)) {",
    REASONS.GRANT,
  ],
  [
    "apps/api/src/modules/permissions/roles.ts",
    ".where(and(eq(roleScopeGrants.roleId, params.roleId), eq(roleScopeGrants.scope, params.scope)))",
    REASONS.GRANT,
  ],
  [
    "apps/api/src/modules/permissions/roles.ts",
    ".where(and(eq(roleScopeGrants.roleId, params.roleId), eq(roleScopeGrants.scope, params.scope)))",
    REASONS.GRANT,
  ],
  [
    "apps/api/src/modules/permissions/roles.ts",
    "data: { roleId: params.roleId, scope: params.scope },",
    REASONS.GRANT,
  ],
  [
    "apps/api/src/modules/permissions/roles.ts",
    ".select({ scope: roleScopeGrants.scope })",
    REASONS.GRANT,
  ],
  [
    "apps/api/src/modules/permissions/roles.ts",
    "for (const { scope } of targetScopes) {",
    REASONS.GRANT,
  ],
  [
    "apps/api/src/modules/permissions/roles.ts",
    ".select({ scope: roleScopeGrants.scope })",
    REASONS.GRANT,
  ],
  [
    "apps/api/src/modules/permissions/roles.ts",
    "for (const { scope } of targetScopes) {",
    REASONS.GRANT,
  ],
  [
    "apps/api/src/modules/permissions/roles.ts",
    "if (!hasScope(params.scope, params.actorScopes)) {",
    REASONS.GRANT,
  ],
  [
    "apps/api/src/modules/permissions/roles.ts",
    ".values({ userId: params.userId, orgId: params.orgId, scope: params.scope })",
    REASONS.GRANT,
  ],
  [
    "apps/api/src/modules/permissions/roles.ts",
    "data: { targetUserId: params.userId, scope: params.scope },",
    REASONS.GRANT,
  ],
  [
    "apps/api/src/modules/permissions/roles.ts",
    "if (!hasScope(params.scope, params.actorScopes)) {",
    REASONS.GRANT,
  ],
  [
    "apps/api/src/modules/permissions/roles.ts",
    "eq(userScopeGrants.scope, params.scope),",
    REASONS.GRANT,
  ],
  [
    "apps/api/src/modules/permissions/roles.ts",
    "eq(userScopeGrants.scope, params.scope),",
    REASONS.GRANT,
  ],
  [
    "apps/api/src/modules/permissions/roles.ts",
    "data: { targetUserId: params.userId, scope: params.scope },",
    REASONS.GRANT,
  ],
  [
    "apps/api/src/modules/permissions/scope-registry.ts",
    "add((bulk as { scope?: unknown }).scope)",
    REASONS.BULK,
  ],
  [
    "apps/api/src/modules/permissions/scope-registry.ts",
    "for (const entry of KERNEL_SCOPES) out.add(entry.scope)",
    REASONS.CATALOG,
  ],
  [
    "apps/api/src/modules/permissions/scope-holders.ts",
    "inArray(roleScopeGrants.scope, satisfying),",
    REASONS.GRANT,
  ],
  [
    "apps/api/src/modules/permissions/scope-holders.ts",
    "inArray(userScopeGrants.scope, satisfying),",
    REASONS.GRANT,
  ],
  [
    "apps/api/src/modules/permissions/scope-catalog.ts",
    "addScope(entry.scope, entry.app, entry.description)",
    REASONS.CATALOG,
  ],
  [
    "apps/api/src/modules/permissions/scope-catalog.ts",
    "addScope((bulk as { scope?: unknown }).scope, appName)",
    REASONS.BULK,
  ],
  [
    "apps/api/src/modules/users/invites.ts",
    ".select({ scope: roleScopeGrants.scope })",
    REASONS.GRANT,
  ],
  [
    "apps/api/src/modules/users/invites.ts",
    "for (const { scope } of targetScopes) {",
    REASONS.GRANT,
  ],
  ["apps/api/src/modules/users/service.ts", "scope: roleScopeGrants.scope,", REASONS.GRANT],
  [
    "apps/api/src/modules/users/service.ts",
    ".select({ scope: userScopeGrants.scope })",
    REASONS.GRANT,
  ],
  [
    "apps/api/src/modules/users/service.ts",
    "const entry = scopeMap.get(r.scope) ?? { fromRoles: [], direct: false }",
    REASONS.GRANT,
  ],
  ["apps/api/src/modules/users/service.ts", "scopeMap.set(r.scope, entry)", REASONS.GRANT],
  [
    "apps/api/src/modules/users/service.ts",
    "const entry = scopeMap.get(r.scope) ?? { fromRoles: [], direct: false }",
    REASONS.GRANT,
  ],
  ["apps/api/src/modules/users/service.ts", "scopeMap.set(r.scope, entry)", REASONS.GRANT],
  [
    "apps/api/src/modules/export/invoke-export.ts",
    "const declaredScope = (entry as unknown as { scope?: string }).scope",
    REASONS.EXPORT,
  ],
  ["apps/api/src/modules/apps/attention-aggregator.ts", "if (reg.scope) {", REASONS.ATTN],
  [
    "apps/api/src/modules/apps/attention-aggregator.ts",
    "if (!hasScope(reg.scope, aliasedScopes ?? callerScopes)) continue",
    REASONS.ATTN,
  ],
  [
    "apps/api/src/modules/apps/runtime.ts",
    "const previous = new Set(deletedRows.map((r) => r.scope))",
    REASONS.GRANT,
  ],
  // The role_scope_grants rows an INSERT ... RETURNING scope actually added.
  ["apps/api/src/modules/apps/runtime.ts", ").map((r) => r.scope),", REASONS.GRANT],
  [
    "apps/api/src/modules/apps/runtime.ts",
    'const explicitScope = typeof attDecl === "object" ? attDecl.scope : undefined',
    REASONS.ATTN,
  ],
  ["apps/api/src/modules/apps/runtime.ts", "scope: opts.scope,", REASONS.ATTN],
  [
    "apps/api/src/modules/apps/connections/protected-scopes.ts",
    ".map((p) => p.scope)",
    REASONS.PROTECTED_OAUTH,
  ],
  [
    "apps/api/src/modules/apps/connections/protected-scopes.ts",
    "for (const { scope } of declared) {",
    REASONS.PROTECTED_OAUTH,
  ],
  [
    "apps/api/src/modules/connection-guides/shopify-app-toml.ts",
    "const isProtected = new Set((connection.protectedScopes ?? []).map((p) => p.scope))",
    REASONS.PROTECTED_OAUTH,
  ],
  [
    "apps/api/src/modules/connection-guides/plan.ts",
    "protectedScopes: (connection.protectedScopes ?? []).map((p) => p.scope),",
    REASONS.PROTECTED_OAUTH,
  ],
  [
    "apps/api/src/modules/apps/connections/attention.ts",
    "...protectedScopesOf(connConfig).map((p) => p.scope),",
    REASONS.PROTECTED_OAUTH,
  ],
  [
    "apps/api/src/modules/apps/connections/attention.ts",
    ").filter((p) => missing.includes(p.scope))",
    REASONS.PROTECTED_OAUTH,
  ],
  [
    "apps/api/src/modules/provisioning/setup-state.ts",
    'grants.some((g) => g !== "unknown" && !g.includes(p.scope)),',
    REASONS.PROTECTED_OAUTH,
  ],
  ["apps/api/src/modules/provisioning/setup-state.ts", "scope: p.scope,", REASONS.PROTECTED_OAUTH],
  [
    "apps/api/src/cli/setup/state.ts",
    "for (const { scope: missing, setting, settingOn } of c.missingProtectedScopes ?? []) {",
    REASONS.PROTECTED_OAUTH,
  ],
  [
    "apps/api/src/cli/setup/state.ts",
    "for (const { scope: missing, setting, settingOn } of c.missingProtectedScopes ?? []) {",
    REASONS.PROTECTED_OAUTH, // the report's text, then its Left list
  ],
  [
    "apps/api/src/modules/provisioning/setup-state.ts",
    "settingOn: on.includes(p.scope),",
    REASONS.PROTECTED_OAUTH,
  ],
  [
    "apps/api/src/modules/apps/connections/service.ts",
    "let grantedOAuthScopes = parseGrantedScopes(tokens.scope ?? tokens.permissions)",
    REASONS.OAUTH,
  ],
  [
    "apps/api/src/modules/apps/sandbox/bridge/knowledge-curation.ts",
    'const reqScope = (p.scope ?? "personal") === "organization"',
    REASONS.KNOW,
  ],
  [
    "apps/api/src/modules/apps/sandbox/bridge/knowledge-curation.ts",
    'const scope = p.scope ?? "personal"',
    REASONS.KNOW,
  ],
  [
    "apps/api/src/apps/gitlab/gitlab-rest.ts",
    "async search({ projectId, groupId, scope, query, ref }) {",
    REASONS.GITLAB,
  ],
  ["apps/api/src/apps/gitlab/tools.ts", "scope: params.scope,", REASONS.GITLAB],
  [
    "apps/api/src/apps/api-connector/transport.ts",
    "const tokenScope = auth.scope",
    REASONS.API_CONNECTOR,
  ],
  [
    "apps/api/src/apps/knowledge/synced-sources.ts",
    'if (input.scope === "organization") {',
    REASONS.KNOW,
  ],
  [
    "apps/api/src/apps/knowledge/synced-sources.ts",
    'const ownerUserId = input.scope === "personal" ? actor.userId : null',
    REASONS.KNOW,
  ],
  ["apps/api/src/apps/knowledge/synced-sources.ts", "scope: input.scope,", REASONS.KNOW],
  ["apps/api/src/services/security/share-anyway.ts", "const scope = computed.scope", REASONS.SHARE],
  [
    "apps/web/src/modules/settings/PermissionGrid.tsx",
    "const known = new Set(catalog.map((c) => c.scope))",
    REASONS.CATALOG,
  ],
  [
    "apps/web/src/modules/settings/PermissionGrid.tsx",
    "if (entry.scope === entry.app) bucket.wildcard = entry",
    REASONS.CATALOG,
  ],
  [
    "apps/web/src/modules/settings/PermissionGrid.tsx",
    "bucket.scopes.sort((a, b) => a.scope.localeCompare(b.scope))",
    REASONS.CATALOG,
  ],
  [
    "apps/web/src/modules/settings/PermissionGrid.tsx",
    "bucket.scopes.sort((a, b) => a.scope.localeCompare(b.scope))",
    REASONS.CATALOG,
  ],
  [
    "apps/web/src/modules/settings/PermissionGrid.tsx",
    "return props.humanLabels ? scopeLabel(entry.scope, i18n.t, entry.description) : entry.scope",
    REASONS.CATALOG,
  ],
  [
    "apps/web/src/modules/settings/PermissionGrid.tsx",
    "return props.humanLabels ? scopeLabel(entry.scope, i18n.t, entry.description) : entry.scope",
    REASONS.CATALOG,
  ],
  [
    "apps/web/src/modules/settings/PermissionGrid.tsx",
    "if (entry.scope.toLowerCase().includes(q)) return true",
    REASONS.CATALOG,
  ],
  [
    "apps/web/src/modules/settings/PermissionGrid.tsx",
    "if (group.wildcard && set.has(group.wildcard.scope)) n += 1",
    REASONS.CATALOG,
  ],
  [
    "apps/web/src/modules/settings/PermissionGrid.tsx",
    "for (const s of group.scopes) if (set.has(s.scope)) n += 1",
    REASONS.CATALOG,
  ],
  [
    "apps/web/src/modules/settings/PermissionGrid.tsx",
    "if (group.wildcard && !set.has(group.wildcard.scope)) out.push(group.wildcard.scope)",
    REASONS.CATALOG,
  ],
  [
    "apps/web/src/modules/settings/PermissionGrid.tsx",
    "if (group.wildcard && !set.has(group.wildcard.scope)) out.push(group.wildcard.scope)",
    REASONS.CATALOG,
  ],
  [
    "apps/web/src/modules/settings/PermissionGrid.tsx",
    "for (const s of group.scopes) if (!set.has(s.scope)) out.push(s.scope)",
    REASONS.CATALOG,
  ],
  [
    "apps/web/src/modules/settings/PermissionGrid.tsx",
    "for (const s of group.scopes) if (!set.has(s.scope)) out.push(s.scope)",
    REASONS.CATALOG,
  ],
  [
    "apps/web/src/modules/settings/PermissionGrid.tsx",
    "if (group.wildcard && set.has(group.wildcard.scope)) out.push(group.wildcard.scope)",
    REASONS.CATALOG,
  ],
  [
    "apps/web/src/modules/settings/PermissionGrid.tsx",
    "if (group.wildcard && set.has(group.wildcard.scope)) out.push(group.wildcard.scope)",
    REASONS.CATALOG,
  ],
  [
    "apps/web/src/modules/settings/PermissionGrid.tsx",
    "for (const s of group.scopes) if (set.has(s.scope)) out.push(s.scope)",
    REASONS.CATALOG,
  ],
  [
    "apps/web/src/modules/settings/PermissionGrid.tsx",
    "for (const s of group.scopes) if (set.has(s.scope)) out.push(s.scope)",
    REASONS.CATALOG,
  ],
  [
    "apps/web/src/modules/settings/PermissionGrid.tsx",
    "const granted = () => isScopeGranted(w.scope)",
    REASONS.CATALOG,
  ],
  [
    "apps/web/src/modules/settings/PermissionGrid.tsx",
    "const pending = () => isPending(w.scope)",
    REASONS.CATALOG,
  ],
  ["apps/web/src/modules/settings/PermissionGrid.tsx", "scope={w.scope}", REASONS.CATALOG],
  [
    "apps/web/src/modules/settings/PermissionGrid.tsx",
    "titleText={scopeIdTitle(w.scope, i18n.t)}",
    REASONS.CATALOG,
  ],
  [
    "apps/web/src/modules/settings/PermissionGrid.tsx",
    "source={props.scopeSource?.(w.scope)}",
    REASONS.CATALOG,
  ],
  [
    "apps/web/src/modules/settings/PermissionGrid.tsx",
    "testId={rowTestId(w.scope)}",
    REASONS.CATALOG,
  ],
  [
    "apps/web/src/modules/settings/PermissionGrid.tsx",
    "onToggle={() => void handleToggle(w.scope, granted())}",
    REASONS.CATALOG,
  ],
  [
    "apps/web/src/modules/settings/PermissionGrid.tsx",
    "const granted = () => isScopeGranted(entry.scope)",
    REASONS.CATALOG,
  ],
  [
    "apps/web/src/modules/settings/PermissionGrid.tsx",
    "const pending = () => isPending(entry.scope)",
    REASONS.CATALOG,
  ],
  ["apps/web/src/modules/settings/PermissionGrid.tsx", "scope={entry.scope}", REASONS.CATALOG],
  [
    "apps/web/src/modules/settings/PermissionGrid.tsx",
    "titleText={scopeIdTitle(entry.scope, i18n.t)}",
    REASONS.CATALOG,
  ],
  [
    "apps/web/src/modules/settings/PermissionGrid.tsx",
    "source={props.scopeSource?.(entry.scope)}",
    REASONS.CATALOG,
  ],
  [
    "apps/web/src/modules/settings/PermissionGrid.tsx",
    "testId={rowTestId(entry.scope)}",
    REASONS.CATALOG,
  ],
  [
    "apps/web/src/modules/settings/PermissionGrid.tsx",
    "onToggle={() => void handleToggle(entry.scope, granted())}",
    REASONS.CATALOG,
  ],
  [
    "apps/web/src/modules/settings/PermissionGrid.tsx",
    "{props.label ?? props.scope}",
    REASONS.CATALOG,
  ],
  [
    "apps/web/src/modules/settings/AdminUserDetail.tsx",
    "const effectiveScopeNames = createMemo(() => detail()?.effectiveScopes.map((s) => s.scope) ?? [])",
    REASONS.GRANT,
  ],
  [
    "apps/web/src/modules/settings/AdminUserDetail.tsx",
    "for (const s of detail()?.effectiveScopes ?? []) map.set(s.scope, s)",
    REASONS.GRANT,
  ],
  [
    "apps/web/src/modules/settings/AdminRoleDetail.tsx",
    "const grantedScopes = createMemo(() => detail()?.scopes.map((s) => s.scope) ?? [])",
    REASONS.GRANT,
  ],
  [
    "apps/web/src/modules/shell/CommandPalette.tsx",
    ".filter((c) => canAccessScope(c.scope))",
    REASONS.COMMAND,
  ],
  [
    "apps/web/src/modules/agent/skills-store.ts",
    'source: input.scope === "org" ? "org" : "personal",',
    REASONS.SKILL,
  ],
  [
    "apps/web/src/modules/agent/skills-store.ts",
    'visibility: input.scope === "org" ? ("org" as const) : ("personal" as const),',
    REASONS.SKILL,
  ],
  [
    "apps/web/src/modules/agent/AgentSettingsTab.tsx",
    '(entry: any): entry is ScopeCatalogEntry => typeof entry?.scope === "string",',
    REASONS.CATALOG,
  ],
  [
    "bundled-apps/boxtal/src/orders.ts",
    'const goods = issued.filter((d) => d.scope === "goods" || d.scope == null)',
    REASONS.DOC,
  ],
  [
    "bundled-apps/boxtal/src/orders.ts",
    'const goods = issued.filter((d) => d.scope === "goods" || d.scope == null)',
    REASONS.DOC,
  ],
  [
    "bundled-apps/boxtal/src/orders.ts",
    'return issued.length > 0 && issued.every((d) => d.scope === "software")',
    REASONS.DOC,
  ],
  ["bundled-apps/shopify/src/reads.ts", "scope: link.scope,", REASONS.DOC],
  [
    "bundled-apps/pennylane/src/connection.ts",
    "await persistConnectionScope(ctx, probe.scope, probe.cash_status)",
    REASONS.PENNY,
  ],
  ["bundled-apps/pennylane/src/lib/get-client.ts", "const scope = map.scope", REASONS.PENNY],
  [
    "bundled-apps/invoicing/src/ui/dashboards/pair-split.ts",
    'if (r.scope !== "goods" && r.scope !== "software") return null',
    REASONS.DOC,
  ],
  [
    "bundled-apps/invoicing/src/ui/dashboards/pair-split.ts",
    'if (r.scope !== "goods" && r.scope !== "software") return null',
    REASONS.DOC,
  ],
  [
    "bundled-apps/invoicing/src/ui/dashboards/pair-split.ts",
    'if (list.some((r) => r.scope === "goods") && list.some((r) => r.scope === "software")) {',
    REASONS.DOC,
  ],
  [
    "bundled-apps/invoicing/src/ui/dashboards/pair-split.ts",
    'if (list.some((r) => r.scope === "goods") && list.some((r) => r.scope === "software")) {',
    REASONS.DOC,
  ],
  [
    "bundled-apps/invoicing/src/ui/dashboards/pair-split.ts",
    'const goods = g.members.filter((m) => m.scope === "goods")',
    REASONS.DOC,
  ],
  [
    "bundled-apps/invoicing/src/ui/dashboards/pair-split.ts",
    'const software = g.members.filter((m) => m.scope === "software")',
    REASONS.DOC,
  ],
  ["bundled-apps/invoicing/src/issue.ts", "scope: row.scope,", REASONS.DOC],
  ["bundled-apps/invoicing/src/issue.ts", "scope: input.scope ?? null,", REASONS.DOC],
  ["bundled-apps/invoicing/src/issue.ts", "scope: document.scope ?? null,", REASONS.DOC],
  [
    "bundled-apps/invoicing/src/einvoicing/parked-credit-note.ts",
    "(original.scope as string | null) ?? null,",
    REASONS.DOC,
  ],
  [
    "bundled-apps/invoicing/src/reads.ts",
    "scope: (r.scope as string | null) ?? null,",
    REASONS.DOC,
  ],
  [
    "bundled-apps/invoicing/src/reads.ts",
    "scope: (r.scope as string | null) ?? null,",
    REASONS.DOC,
  ],
  ["bundled-apps/invoicing/src/handlers/shopify-refund-created.ts", "args.doc.scope,", REASONS.DOC],
  [
    "bundled-apps/invoicing/src/handlers/shopify-refund-created.ts",
    "scope: (r.scope as string | null) ?? null,",
    REASONS.DOC,
  ],
  [
    "bundled-apps/invoicing/src/handlers/shopify-refund-created.ts",
    'const doc = docs.find((d) => d.scope === "goods" || d.scope === null) ?? docs[0]!',
    REASONS.DOC,
  ],
  [
    "bundled-apps/invoicing/src/handlers/shopify-refund-created.ts",
    'const doc = docs.find((d) => d.scope === "goods" || d.scope === null) ?? docs[0]!',
    REASONS.DOC,
  ],
  [
    "bundled-apps/invoicing/src/handlers/reconcile-shopify-payments.ts",
    'scope: (r.scope as "goods" | "software" | null) ?? null,',
    REASONS.DOC,
  ],
  [
    "bundled-apps/invoicing/src/handlers/reconcile-shopify-payments.ts",
    'const shipsPhysically = doc.scope !== "software"',
    REASONS.DOC,
  ],
  [
    "bundled-apps/invoicing/src/handlers/shopify-order-paid.ts",
    "scope: (r.scope as string | null) ?? null,",
    REASONS.DOC,
  ],
  [
    "bundled-apps/invoicing/src/handlers/shopify-order-paid.ts",
    "if (d.scope !== null) continue",
    REASONS.DOC,
  ],
  [
    "bundled-apps/invoicing/src/handlers/shopify-order-paid.ts",
    "const existingScopes = new Set(existingDocs.map((d) => d.scope))",
    REASONS.DOC,
  ],
  [
    "bundled-apps/invoicing/src/handlers/shopify-order-paid.ts",
    "issueResult = await issueDocument(ctx, buildIssueInput(split.scope, split.items, when, paidAt))",
    REASONS.DOC,
  ],
  [
    "bundled-apps/invoicing/src/handlers/shopify-order-paid.ts",
    "const input = buildIssueInput(split.scope, split.items, when, paidAt)",
    REASONS.DOC,
  ],
  ["bundled-apps/invoicing/src/handlers/shopify-order-paid.ts", "scope: split.scope,", REASONS.DOC],
  [
    "bundled-apps/invoicing/src/handlers/shopify-order-paid.ts",
    'const primary = issued.find((d) => d.scope === "goods") ?? issued[0]!',
    REASONS.DOC,
  ],
  [
    "bundled-apps/invoicing/src/handlers/shopify-order-cancelled.ts",
    "(fresh.scope as string | null) ?? null,",
    REASONS.DOC,
  ],
  [
    "apps/api/src/apps/calendar/sync.ts",
    'if (params.scope !== "occurrence" && params.scope !== "series") {',
    REASONS.CAL,
  ],
  [
    "apps/api/src/apps/calendar/sync.ts",
    'if (params.scope !== "occurrence" && params.scope !== "series") {',
    REASONS.CAL,
  ],
  [
    "apps/api/src/apps/calendar/sync.ts",
    'if (params.scope === "occurrence" && params.changesRecurrence) {',
    REASONS.CAL,
  ],
  [
    "apps/api/src/apps/calendar/sync.ts",
    'if (params.scope === "occurrence") return { eventId: row.id, scope: "occurrence" }',
    REASONS.CAL,
  ],
  [
    "apps/api/src/apps/calendar/sync.ts",
    'if (params.scope === "series") return { eventId: row.id, scope: "series" }',
    REASONS.CAL,
  ],
  [
    "apps/api/src/apps/mcp-manager/service/connections.ts",
    "eq(userScopeGrants.scope, scope),",
    REASONS.GRANT,
  ],
  [
    "apps/api/src/modules/agent/routines/routines-routes.ts",
    'entry.scope !== "*" &&',
    REASONS.CATALOG,
  ],
  [
    "apps/api/src/modules/agent/routines/routines-routes.ts",
    'entry.scope.includes(":") &&',
    REASONS.CATALOG,
  ],
  [
    "apps/api/src/modules/agent/routines/routines-routes.ts",
    "isScopeCovered([entry.scope], actor.scopes),",
    REASONS.CATALOG,
  ],
  [
    "apps/api/src/modules/agent/scopes/taint-read-scopes.ts",
    "for (const entry of getScopeCatalog(orgId)) if (isReadScope(entry.scope)) out.add(entry.scope)",
    REASONS.CATALOG,
  ],
  [
    "apps/api/src/modules/agent/scopes/taint-read-scopes.ts",
    "for (const entry of getScopeCatalog(orgId)) if (isReadScope(entry.scope)) out.add(entry.scope)",
    REASONS.CATALOG,
  ],
  [
    "apps/api/src/modules/agent/tools/skills-routines-tools.ts",
    "return new Map(getScopeCatalog(orgId).map((e) => [e.scope, e.description]))",
    REASONS.CATALOG,
  ],
  [
    "apps/api/src/modules/scope-requests/announce.ts",
    "const catalog = new Map(getScopeCatalog(orgId).map((e) => [e.scope, e.description]))",
    REASONS.CATALOG,
  ],
  [
    "apps/api/src/modules/apps/sandbox/bridge/calendar.ts",
    "...(target.scope ? { scope: target.scope } : {}),",
    REASONS.CAL,
  ],
  [
    "apps/api/src/modules/apps/sandbox/bridge/calendar.ts",
    "...(target.scope ? { scope: target.scope } : {}),",
    REASONS.CAL,
  ],
  [
    "apps/api/src/modules/apps/sandbox/bridge/calendar.ts",
    "...(target.scope ? { scope: target.scope } : {}),",
    REASONS.CAL,
  ],
  [
    "apps/api/src/modules/apps/sandbox/bridge/calendar.ts",
    "...(target.scope ? { scope: target.scope } : {}),",
    REASONS.CAL,
  ],
  ["apps/api/src/modules/apps/sandbox/bridge/calendar.ts", "scope: params.scope,", REASONS.CAL],
  [
    "apps/api/src/modules/auth/session-ceiling.ts",
    "const known = new Set(getScopeCatalog(orgId).map((e) => e.scope))",
    REASONS.CATALOG,
  ],
  [
    "apps/api/src/modules/permissions/roles.ts",
    ".select({ scope: roleScopeGrants.scope })",
    REASONS.GRANT,
  ],
  [
    "apps/api/src/modules/permissions/roles.ts",
    "for (const { scope } of targetScopes) {",
    REASONS.GRANT,
  ],
  ["apps/api/src/modules/users/service.ts", "AND ${roleScopeGrants.scope} = '*'", REASONS.GRANT],
  ["apps/api/src/modules/users/service.ts", "AND ${userScopeGrants.scope} = '*'", REASONS.GRANT],
  [
    "apps/web/src/modules/agent/RoutineScopesField.tsx",
    "() => new Map((options() ?? []).map((o) => [o.scope, o.description])),",
    REASONS.CATALOG,
  ],
  ["apps/web/src/modules/agent/RoutineScopesField.tsx", "+ {label(option.scope)}", REASONS.CATALOG],
  [
    "apps/web/src/modules/agent/RoutineScopesField.tsx",
    ".filter((o) => !current.has(o.scope))",
    REASONS.CATALOG,
  ],
  [
    "apps/web/src/modules/agent/RoutineScopesField.tsx",
    '? (rows as RoutineScopeOption[]).filter((o) => typeof o?.scope === "string")',
    REASONS.CATALOG,
  ],
  [
    "apps/web/src/modules/agent/RoutineScopesField.tsx",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the exact text of a source line
    "data-testid={`routine-scope-add-${option.scope}`}",
    REASONS.CATALOG,
  ],
  [
    "apps/web/src/modules/agent/RoutineScopesField.tsx",
    "label(o.scope).toLowerCase().includes(q) ||",
    REASONS.CATALOG,
  ],
  [
    "apps/web/src/modules/agent/RoutineScopesField.tsx",
    "o.scope.toLowerCase().includes(q) ||",
    REASONS.CATALOG,
  ],
  [
    "apps/web/src/modules/agent/RoutineScopesField.tsx",
    "props.onChange([...props.value, option.scope])",
    REASONS.CATALOG,
  ],
  [
    "apps/web/src/modules/agent/RoutineScopesField.tsx",
    "title={scopeIdTitle(option.scope, i18n.t)}",
    REASONS.CATALOG,
  ],
  [
    "bundled-apps/invoicing/src/handlers/link-shipments.ts",
    'if (r.scope === "software") return false',
    REASONS.DOC,
  ],
  [
    "bundled-apps/invoicing/src/handlers/shopify-refund-created.ts",
    "? buildAdjustmentReversalItems(shippingSources, shipping, args.doc.scope)",
    REASONS.DOC,
  ],
  [
    "bundled-apps/invoicing/src/handlers/shopify-refund-created.ts",
    'const fallback = docs.find((d) => d.scope === "goods" || d.scope === null) ?? docs[0]!',
    REASONS.DOC,
  ],
  [
    "bundled-apps/invoicing/src/handlers/shopify-refund-created.ts",
    'const fallback = docs.find((d) => d.scope === "goods" || d.scope === null) ?? docs[0]!',
    REASONS.DOC,
  ],
  [
    "bundled-apps/invoicing/src/handlers/tax-override.ts",
    "documents: documents.map((d) => ({ document_id: d.document_id, number: d.number, scope: d.scope })),",
    REASONS.DOC,
  ],
  [
    "apps/api/src/modules/node-sessions/agent-tools.ts",
    'scope: request.type === "permission_request" ? (params.scope ?? "once") : "once",',
    REASONS.NODE,
  ],
  [
    "apps/api/src/modules/node-sessions/routes-me.ts",
    'const { after: afterQ, before, limit, scope, parent } = c.req.valid("query")',
    REASONS.FEED,
  ],
  [
    "apps/web/src/modules/sessions/session-disk-cache.ts",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the exact text of a source line
    "const key = `${w.sessionId}\\u0000${w.scope}`",
    REASONS.FEED,
  ],
  [
    "apps/web/src/modules/sessions/session-disk-cache.ts",
    "r = ((await request(ranges.get([w.sessionId, w.scope]))) as RangeRecord | undefined) ?? null",
    REASONS.FEED,
  ],
  [
    "apps/web/src/modules/sessions/session-disk-cache.ts",
    "events.delete(scopeBounds(w.sessionId, w.scope, r.lo, r.hi))",
    REASONS.FEED,
  ],
  [
    "apps/web/src/modules/sessions/session-disk-cache.ts",
    "events.put(rec, [w.sessionId, w.scope, e.seq])",
    REASONS.FEED,
  ],
  [
    "apps/web/src/modules/sessions/session-disk-cache.ts",
    "ranges.put(r, [w.sessionId, w.scope])",
    REASONS.FEED,
  ],
  [
    "apps/web/src/modules/sessions/session-disk-cache.ts",
    "if (w.db !== name || w.sessionId !== sessionId || w.scope !== scope) continue",
    REASONS.FEED,
  ],
  [
    "apps/web/src/modules/sessions/session-store.ts",
    "diskCache.write(feed.sessionId, feed.scope, held, held.map(sizeOf), from, to)",
    REASONS.FEED,
  ],
  [
    "apps/web/src/modules/sessions/session-store.ts",
    'f.release(f.scope === "" ? screenFirst : undefined)',
    REASONS.FEED,
  ],
  ["apps/web/src/modules/sessions/session-store.ts", 'if (f.scope === "") {', REASONS.FEED],
  [
    "apps/web/src/modules/sessions/session-store.ts",
    "const key = subKey(id, f.scope)",
    REASONS.FEED,
  ],
  ["apps/web/src/modules/sessions/session-store.ts", "const toolUseId = f.scope", REASONS.FEED],
  ["apps/web/src/modules/sessions/session-store.ts", "feed.scope,", REASONS.FEED],
  [
    "apps/web/src/modules/sessions/session-store.ts",
    'f.release(f.scope === "" ? visibility.get(f.sessionId)?.screenFirst : undefined)',
    REASONS.FEED,
  ],
  [
    "apps/api/src/modules/security/security-events.ts",
    "const sub = signal.factor ?? signal.scope",
    REASONS.SIGNAL,
  ],
  ["apps/api/src/modules/security/security-events.ts", "scope: signal.scope,", REASONS.SIGNAL],
  ["apps/api/src/modules/auth/admin-second-factor.ts", ".map((e) => e.scope)", REASONS.CATALOG],
  [
    "apps/api/src/cli/provisioners/roles.ts",
    ".select({ roleId: roleScopeGrants.roleId, scope: roleScopeGrants.scope })",
    REASONS.GRANT_ROW,
  ],
  [
    "apps/api/src/cli/provisioners/roles.ts",
    "if (name) out.get(name)?.scopes.add(g.scope)",
    REASONS.GRANT_ROW,
  ],
  [
    "apps/api/src/modules/provisioning/config-admin-guard.ts",
    ".select({ roleId: roleScopeGrants.roleId, scope: roleScopeGrants.scope })",
    REASONS.GRANT_ROW,
  ],
  [
    "apps/api/src/modules/provisioning/config-admin-guard.ts",
    ".select({ userId: userScopeGrants.userId, scope: userScopeGrants.scope })",
    REASONS.GRANT_ROW,
  ],
  [
    "apps/api/src/modules/provisioning/config-admin-guard.ts",
    "const stored = state.grants.filter((g) => g.roleId === r.id).map((g) => g.scope)",
    REASONS.GRANT_ROW,
  ],
  [
    "apps/api/src/modules/provisioning/config-admin-guard.ts",
    "...state.direct.filter((d) => d.userId === userId).map((d) => d.scope),",
    REASONS.GRANT_ROW,
  ],
  [
    "apps/api/src/modules/approvals/route-world.ts",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the exact text of a source line
    "(p) => drizzleSql`(${p.userId}::uuid, ${p.scope}::text, ${p.app}::text)`,",
    REASONS.GRANT_ROW,
  ],
  [
    "apps/api/src/modules/approvals/route-world.ts",
    "for (const r of rows) out.add(pairKey(r.user_id, r.scope, r.app))",
    REASONS.GRANT_ROW,
  ],
  [
    "apps/api/src/modules/apps/org-app-admin.ts",
    "return getScopeCatalog(orgId).some((e) => scopeBelongsToApp(e.scope, app))",
    REASONS.CATALOG_ENTRY,
  ],
  [
    "apps/api/src/modules/apps/org-app-service.ts",
    "data: { targetUserIds: bumped, scope: change.scope, change: change.mode },",
    REASONS.CHANGE_PAYLOAD,
  ],
  [
    "apps/api/src/modules/apps/org-app-service.ts",
    "await runAfterChangeSteps(orgId, { scope: change.scope }, userIds)",
    REASONS.CHANGE_PAYLOAD,
  ],
  [
    "apps/web/src/modules/settings/AdminRoles.tsx",
    'const scopeFilter = () => (typeof params.scope === "string" ? params.scope : "")',
    REASONS.ROUTE_PARAM,
  ],
  [
    "apps/web/src/modules/settings/AdminRoles.tsx",
    'const scopeFilter = () => (typeof params.scope === "string" ? params.scope : "")',
    REASONS.ROUTE_PARAM,
  ],
  [
    "apps/web/src/modules/settings/AdminRoles.tsx",
    "async ({ scope, list }) => {",
    REASONS.ROUTE_PARAM,
  ],
  [
    "apps/web/src/modules/settings/AdminRoles.tsx",
    "const grants = (detail.scopes ?? []).map((g) => g.scope)",
    REASONS.GRANT_ROW,
  ],
  [
    "apps/web/src/modules/settings/PermissionGrid.tsx",
    "const named = props.scopeLabels?.(entry.scope)",
    REASONS.CATALOG_ENTRY,
  ],
  [
    "apps/web/src/modules/settings/PermissionGrid.tsx",
    "return props.scopeLabels?.(entry.scope) ?? (props.humanLabels ? rowLabel(entry) : undefined)",
    REASONS.CATALOG_ENTRY,
  ],
  [
    "apps/web/src/modules/settings/app-store/AppStoreDetail.tsx",
    "scopeLabel(scope, t, catalog.find((e) => e.scope === scope)?.description)",
    REASONS.CATALOG_ENTRY,
  ],
  [
    "apps/web/src/modules/settings/AdminRoleDetail.tsx",
    '<span class="text-text" title={g.scope}>',
    REASONS.GRANT_ROW,
  ],
  [
    "apps/api/src/seed/tiers/standard/people.ts",
    "for (const { key, scope } of QA_APPROVER_SPLIT.userScopes) {",
    "the standard seed's approver split: a direct user scope grant written to kernel.user_scope_grants, not a tool",
  ],
]

describe("oracle: no source reads scope off a tool definition", () => {
  it("flags every read shape it guards, and nothing else", () => {
    const kinds = (src: string) => scopeReads("sample.ts", src).map((r) => r.kind)
    expect(kinds("if (def.scope) addScope(def.scope)")).toEqual(["access", "access"])
    expect(kinds("x = tool?.scope")).toEqual(["access"])
    expect(kinds("(tool as { scope?: string }).scope")).toEqual(["access"])
    expect(kinds('const s = tool["scope"]')).toEqual(["bracket"])
    expect(kinds("const s = tool['scope']")).toEqual(["bracket"])
    expect(kinds("const { scope } = tool")).toEqual(["destructure"])
    expect(kinds("const { scope: s, name } = tool")).toEqual(["destructure"])
    expect(kinds("function f({ scope }: Tool) {}")).toEqual(["destructure"])
    expect(kinds("for (const { scope } of tools) {}")).toEqual(["destructure"])
    expect(kinds("let s; ({ scope: s } = tool)")).toEqual(["destructure"])
    expect(kinds("let scope; ({ scope } = tool)")).toEqual(["destructure"])
    // Not reads: writing a `scope` key, an array binding named scope, plural fields.
    expect(kinds("const o = { scope: 'a:b' }")).toEqual([])
    expect(kinds("const [scope, setScope] = createSignal('user')")).toEqual([])
    expect(kinds("t.scopes.length + t.scopeCeiling")).toEqual([])
    expect(kinds("const at = touched?.[scope]")).toEqual([])
    expect(scopeReads("s.tsx", "const el = <Row scope={w.scope} />").map((r) => r.kind)).toEqual([
      "access",
    ])
  })

  it("keys the allowlist by exact line, so an allowlisted receiver name is no free pass", () => {
    const allowed = new Set(["if (!hasScope(reg.scope, callerScopes)) continue"])
    const reads = scopeReads(
      "sample.ts",
      "if (!hasScope(reg.scope, callerScopes)) continue\nconst required = reg.scope",
    )
    expect(reads.filter((r) => !allowed.has(r.line)).map((r) => r.line)).toEqual([
      "const required = reg.scope",
    ])
  })

  it("every scope read in non-test source is allowlisted by exact line, and no entry is stale", () => {
    const remaining = new Map<string, number>()
    for (const [file, line] of SCOPE_READ_ALLOWLIST) {
      const key = `${file}\t${line}`
      remaining.set(key, (remaining.get(key) ?? 0) + 1)
    }
    const unexpected: string[] = []
    for (const root of scanRoots()) {
      for (const file of sourceFiles(join(ROOT, root))) {
        const src = readFileSync(file, "utf8")
        if (!src.includes("scope")) continue
        const rel = relative(ROOT, file)
        for (const read of scopeReads(file, src)) {
          const key = `${rel}\t${read.line}`
          const left = remaining.get(key) ?? 0
          if (left > 0) remaining.set(key, left - 1)
          else unexpected.push(`${rel}: ${read.kind}: ${read.line}`)
        }
      }
    }
    expect(
      unexpected,
      "a tool's scopes are requiredScopes; if this read is not a tool definition, allowlist its line with a reason",
    ).toEqual([])
    const stale = [...remaining].filter(([, n]) => n > 0).map(([key]) => key.replace("\t", ": "))
    expect(stale, "allowlist entries that no longer match a read: remove them").toEqual([])
  })
})
