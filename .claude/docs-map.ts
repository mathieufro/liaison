// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Code path → docs pages, for `bun run check:docs`.
 *
 * A pull request that changes a file matching `glob` must also change at least
 * one of `pages` (page ids from docs/nav.ts, i.e. paths under docs/ without
 * `.md`), or carry a `Docs-skip: <reason>` line in its body or a commit message.
 *
 * DOCS_EXEMPT is checked first: an exempt file never needs a page. Otherwise
 * the first DOCS_MAP glob that matches decides its pages; keep entries
 * specific → general, like .claude/test-map.ts. A changed file under one of
 * DOCS_FAILSAFE_ROOTS that matches neither list fails the check: map it (or
 * exempt it with a reason) when you add a new directory.
 *
 * Generated reference pages (docs/reference/*) are kept fresh by the same
 * check: run `bun run docs:gen` after changing their sources.
 */
export const DOCS_MAP: { glob: string; pages: string[] }[] = [
  // Generated references: their sources regenerate the page (docs:gen).
  { glob: "apps/api/src/lib/env.ts", pages: ["reference/env"] },
  { glob: "apps/api/src/cli/commands.ts", pages: ["reference/cli"] },
  { glob: "apps/api/src/cli/config/**", pages: ["reference/config", "provisioning-cli"] },
  { glob: "apps/api/src/cli/provisioners/**", pages: ["reference/config", "provisioning-cli"] },
  { glob: "apps/api/src/cli/api-connector/**", pages: ["api-connector", "reference/cli"] },
  // `liaison seed`: its tiers and flags (provisioning-cli), how tests seed (testing).
  { glob: "apps/api/src/cli/seed/**", pages: ["provisioning-cli", "reference/cli", "testing"] },
  { glob: "apps/api/src/cli/org-transfer.ts", pages: ["runbooks/org-transfer", "reference/cli"] },
  { glob: "apps/api/src/cli/**", pages: ["reference/cli", "provisioning-cli"] },
  { glob: "apps/api/src/modules/permissions/scope-catalog.ts", pages: ["reference/scopes", "agents/permissions"] },

  // Agents
  { glob: "apps/api/src/modules/approvals/**", pages: ["agents/approvals"] },
  { glob: "apps/web/src/modules/approvals/**", pages: ["agents/approvals"] },
  { glob: "apps/api/src/modules/home/**", pages: ["agents/routines"] },
  { glob: "packages/shared/src/approvals/**", pages: ["agents/approvals"] },
  { glob: "apps/api/src/modules/scope-requests/**", pages: ["agents/permissions"] },
  { glob: "apps/web/src/modules/admin-scope-requests/**", pages: ["agents/permissions"] },
  { glob: "apps/api/src/modules/secret-requests/**", pages: ["agents/tools"] },
  { glob: "apps/api/src/modules/connection-guides/**", pages: ["connecting-apps", "apps/store"] },
  { glob: "packages/shared/src/setup-guides*", pages: ["connecting-apps", "apps/store"] },
  { glob: "apps/web/src/modules/secret-request/**", pages: ["agents/tools"] },
  { glob: "apps/api/src/modules/permissions/**", pages: ["agents/permissions", "admin/roles"] },
  { glob: "apps/api/src/modules/agent/**", pages: ["agents/how-agents-work", "agents/create-an-agent", "agents/routines", "agents/models", "agents/tools"] },
  { glob: "apps/web/src/modules/agent/**", pages: ["agents/how-agents-work", "agents/create-an-agent", "agents/routines", "agents/models"] },
  { glob: "packages/shared/src/agents/**", pages: ["agents/how-agents-work", "agents/models"] },
  { glob: "packages/shared/src/reasoning.ts", pages: ["agents/models"] },
  { glob: "apps/api/src/modules/assist/**", pages: ["agents/how-agents-work"] },
  { glob: "apps/web/src/modules/assist/**", pages: ["agents/how-agents-work"] },
  { glob: "apps/api/src/apps/mcp-manager/**", pages: ["agents/mcp-servers", "mcp-servers"] },
  { glob: "apps/web/src/modules/mcp-manager/**", pages: ["agents/mcp-servers"] },
  { glob: "apps/api/src/modules/mcp-client/**", pages: ["agents/mcp-servers", "developers/mcp"] },
  { glob: "apps/api/src/modules/mcp/**", pages: ["developers/mcp"] },

  // Computers (nodes)
  { glob: "apps/api/src/modules/nodes/**", pages: ["computers/what-is-a-node", "computers/folders", "computers/run-work", "computers/guardrails", "computers/security"] },
  { glob: "apps/api/src/modules/node-sessions/**", pages: ["computers/sessions", "computers/run-work"] },
  { glob: "apps/web/src/modules/nodes/**", pages: ["computers/guardrails", "computers/connect"] },
  { glob: "apps/web/src/modules/sessions/**", pages: ["computers/sessions"] },
  { glob: "apps/web/src/modules/desktop/**", pages: ["computers/connect", "getting-started/desktop-and-phone"] },
  { glob: "packages/shared/src/node-*", pages: ["computers/guardrails", "computers/sessions", "computers/folders"] },
  { glob: "apps/desktop/**", pages: ["computers/connect", "computers/sessions", "getting-started/desktop-and-phone"] },
  { glob: "apps/mobile/**", pages: ["getting-started/desktop-and-phone"] },

  // Built-in apps
  { glob: "apps/api/src/apps/mail/**", pages: ["apps/mail"] },
  { glob: "apps/api/src/modules/mail*/**", pages: ["apps/mail"] },
  { glob: "apps/web/src/modules/mail/**", pages: ["apps/mail"] },
  { glob: "apps/web/src/modules/mailbox/**", pages: ["apps/mail"] },
  { glob: "apps/api/src/apps/tickets/**", pages: ["apps/tickets"] },
  { glob: "apps/web/src/modules/tickets/**", pages: ["apps/tickets"] },
  { glob: "apps/api/src/modules/threads/**", pages: ["apps/chat"] },
  { glob: "apps/api/src/modules/messages/**", pages: ["apps/chat"] },
  { glob: "apps/web/src/modules/threads/**", pages: ["apps/chat"] },
  { glob: "packages/shared/src/threads/**", pages: ["apps/chat"] },
  { glob: "apps/api/src/apps/knowledge/**", pages: ["apps/knowledge"] },
  { glob: "apps/web/src/modules/knowledge/**", pages: ["apps/knowledge"] },
  { glob: "apps/api/src/modules/sharing/**", pages: ["apps/knowledge"] },
  { glob: "apps/web/src/modules/sharing/**", pages: ["apps/knowledge"] },
  { glob: "apps/api/src/apps/google-drive/**", pages: ["apps/google-drive"] },
  { glob: "apps/web/src/modules/drive-picker/**", pages: ["apps/google-drive"] },
  { glob: "apps/api/src/apps/gitlab/**", pages: ["apps/gitlab"] },
  { glob: "apps/api/src/apps/contacts/**", pages: ["apps/contacts", "sales/contacts"] },
  { glob: "apps/api/src/modules/contacts/**", pages: ["apps/contacts", "sales/contacts", "sales/duplicates"] },
  { glob: "apps/api/src/modules/product-attributes/**", pages: ["agents/tools"] },
  { glob: "apps/web/src/modules/contacts/**", pages: ["apps/contacts", "sales/contacts"] },
  { glob: "apps/api/src/apps/calendar/**", pages: ["apps/calendar"] },
  { glob: "apps/web/src/modules/calendar/**", pages: ["apps/calendar"] },
  { glob: "packages/shared/src/calendar-recurrence.ts", pages: ["apps/calendar"] },
  { glob: "apps/api/src/apps/projects/**", pages: ["apps/projects"] },
  { glob: "apps/web/src/modules/projects/**", pages: ["apps/projects"] },
  { glob: "apps/api/src/modules/files/**", pages: ["apps/files"] },
  { glob: "apps/api/src/modules/imports/uploads/**", pages: ["runbooks/production-bootstrap"] },
  { glob: "apps/web/src/modules/files/**", pages: ["apps/files"] },
  { glob: "apps/api/src/apps/api-connector/**", pages: ["api-connector", "sales/connect-your-crm"] },
  { glob: "apps/api/src/modules/api-connector/**", pages: ["api-connector", "sales/connect-your-crm"] },
  { glob: "apps/web/src/modules/api-connector/**", pages: ["api-connector", "sales/connect-your-crm"] },
  { glob: "packages/api-connector-core/**", pages: ["api-connector"] },
  { glob: "apps/api/src/apps/database/**", pages: ["database-connector", "sales/sales-data"] },
  { glob: "apps/api/src/modules/database/**", pages: ["database-connector", "sales/sales-data"] },
  { glob: "apps/web/src/modules/database/**", pages: ["database-connector", "sales/sales-data"] },
  { glob: "packages/db-core/**", pages: ["database-connector"] },
  { glob: "apps/db-gate/**", pages: ["database-connector"] },
  { glob: "apps/api/src/apps/example/**", pages: ["app-development"] },

  // Bundled apps
  { glob: "bundled-apps/invoicing/**", pages: ["apps/invoicing", "sales/quotes"] },
  { glob: "bundled-apps/boxtal/**", pages: ["apps/boxtal"] },
  { glob: "bundled-apps/shopify/**", pages: ["apps/store"] },
  { glob: "bundled-apps/pennylane/**", pages: ["apps/pennylane"] },
  { glob: "bundled-apps/social/**", pages: ["apps/social"] },
  { glob: "bundled-apps/ads/**", pages: ["apps/ads"] },
  { glob: "bundled-apps/calls/**", pages: ["apps/calls", "sales/sales-data"] },
  { glob: "bundled-apps/monitoring/**", pages: ["apps/monitoring"] },

  // Admin
  { glob: "apps/api/src/modules/users/**", pages: ["admin/users"] },
  { glob: "apps/api/src/modules/auth/**", pages: ["admin/users", "developers/rest-api"] },
  { glob: "apps/web/src/modules/auth/**", pages: ["admin/users"] },
  { glob: "apps/web/src/modules/members/**", pages: ["admin/users", "admin/roles"] },
  { glob: "apps/api/src/modules/settings/**", pages: ["admin/settings"] },
  { glob: "apps/api/src/modules/billing-managed/**", pages: ["admin/settings"] },
  // An org moving to another server: the 503 `org_moving` answer of the API and webhooks.
  { glob: "apps/api/src/modules/org/transfer-state/**", pages: ["developers/rest-api", "app-webhooks"] },
  // Moving an org between servers (the core: export, import, re-keying, purge).
  { glob: "apps/api/src/modules/org/transfer/**", pages: ["runbooks/org-transfer"] },
  // Document templates (org admin settings); the settings page that edits them documents them.
  { glob: "apps/api/src/modules/documents/**", pages: ["admin/settings"] },
  { glob: "apps/api/src/modules/org/**", pages: ["admin/settings"] },
  { glob: "apps/api/src/modules/branding/**", pages: ["admin/settings"] },
  { glob: "apps/api/src/modules/client-policy/**", pages: ["reference/env"] },
  { glob: "apps/web/src/modules/settings/**", pages: ["admin/settings"] },
  { glob: "apps/api/src/modules/export/**", pages: ["admin/backups"] },
  { glob: "apps/api/src/modules/imports/**", pages: ["admin/settings", "app-development"] },
  { glob: "apps/web/src/modules/imports/**", pages: ["admin/settings", "agents/how-agents-work"] },
  { glob: "apps/api/src/modules/erasure/**", pages: ["admin/backups"] },
  { glob: "apps/api/src/modules/mailbox-keys/**", pages: ["runbooks/key-rotation"] },

  // Getting started
  { glob: "apps/api/src/modules/demo/**", pages: ["getting-started/demo"] },
  // Seed tiers before the catch-all below (the first matching entry wins).
  { glob: "apps/api/src/seed/tiers/standard/**", pages: ["testing", "provisioning-cli"] },
  { glob: "apps/api/src/seed/tiers/minimal.ts", pages: ["testing"] },
  { glob: "apps/api/src/seed/tiers/lively/**", pages: ["provisioning-cli", "getting-started/install"] },
  { glob: "apps/api/src/seed/**", pages: ["getting-started/demo", "provisioning-cli"] },
  { glob: "apps/api/src/modules/liaison-team/**", pages: ["self-hosting/liaison-team"] },
  { glob: "apps/web/src/modules/demo/**", pages: ["getting-started/demo"] },
  { glob: "apps/api/src/modules/tours/**", pages: ["getting-started/demo"] },
  { glob: "apps/web/src/modules/tours/**", pages: ["getting-started/demo"] },
  { glob: "packages/shared/src/demo/**", pages: ["getting-started/demo"] },
  { glob: "packages/shared/src/tours/**", pages: ["getting-started/demo", "sales/research-prospects"] },
  { glob: ".claude/skills/setup-liaison/**", pages: ["getting-started/install"] },

  // Self-hosting
  { glob: "apps/api/src/modules/healthz/**", pages: ["self-hosting/docker"] },
  // The effect ledger: what a resumed turn or a retried job does not do twice.
  { glob: "apps/api/src/lib/effect-once.ts", pages: ["self-hosting/docker", "runbooks/deploy-effects", "agents/how-agents-work"] },
  { glob: "apps/api/src/lib/effect-sink.ts", pages: ["self-hosting/docker"] },
  // Deploys under load and the launch scenario (Test deploys under load).
  { glob: "scripts/load-test.ts", pages: ["self-hosting/docker"] },
  { glob: "scripts/lib/deploy-under-load.ts", pages: ["self-hosting/docker"] },
  { glob: "scripts/lib/load-harness-client.ts", pages: ["self-hosting/docker"] },
  { glob: "scripts/lib/load-seed.ts", pages: ["self-hosting/docker"] },
  { glob: "qa/load/a9-deploy-under-load.js", pages: ["self-hosting/docker"] },
  { glob: "apps/api/src/modules/health/**", pages: ["self-hosting/docker"] },
  { glob: "deploy/**", pages: ["self-hosting/docker", "runbooks/production-bootstrap", "admin/backups"] },
  { glob: "deploy/docker-compose.yml", pages: ["self-hosting/pools"] },
  { glob: "docker-compose.yml", pages: ["self-hosting/docker"] },
  { glob: "Dockerfile*", pages: ["self-hosting/docker"] },
  { glob: "apps/api/Dockerfile", pages: ["self-hosting/docker"] },
  { glob: "apps/api/scripts/entrypoint.sh", pages: ["self-hosting/docker", "admin/upgrades"] },
  { glob: "apps/api/scripts/cron-fanout-rollback.ts", pages: ["self-hosting/docker", "backend-overview"] },
  { glob: "apps/api/app-index-none.json", pages: ["self-hosting/docker"] },
  { glob: "scripts/build-app-catalog.ts", pages: ["self-hosting/docker"] },

  // Developers
  { glob: "packages/app-sdk/**", pages: ["app-development", "app-package-format"] },
  { glob: "packages/shared/src/app-signing/**", pages: ["app-package-format"] },
  { glob: "scripts/app-signing/**", pages: ["app-package-format"] },
  { glob: "packages/host-sdk/**", pages: ["app-development"] },
  { glob: "packages/app-ui/**", pages: ["app-development"] },
  { glob: "apps/api/src/modules/apps/**", pages: ["app-development", "app-sandbox", "connecting-apps"] },
  { glob: "apps/api/src/modules/webhooks/**", pages: ["app-webhooks"] },
  { glob: "apps/api/src/modules/notifications/**", pages: ["notifications"] },
  { glob: "apps/web/src/modules/notifications/**", pages: ["notifications"] },
  { glob: "apps/web/public/liaison-sw.js", pages: ["notifications"] },
  { glob: "packages/shared/src/notifications/**", pages: ["notifications"] },
  { glob: "apps/web/src/app-frame/**", pages: ["app-sandbox"] },
  { glob: "apps/web/scripts/build-app-frame.ts", pages: ["app-sandbox"] },
]

/**
 * Paths that never need a docs change: tests, fixtures, generated output and
 * internals a reader cannot act on. Each entry says why.
 */
export const DOCS_EXEMPT: { glob: string; reason: string }[] = [
  { glob: "**/*.test.ts", reason: "tests" },
  { glob: "**/*.test.tsx", reason: "tests" },
  { glob: "**/__fixtures__/**", reason: "test fixtures" },
  {
    glob: "apps/api/src/modules/setup-guides/**",
    reason: "former path of modules/connection-guides (renamed); the new path is mapped",
  },
  { glob: "**/__snapshots__/**", reason: "test snapshots" },
  { glob: "**/fixtures/**", reason: "test fixtures" },
  { glob: "**/tests/**", reason: "tests" },
  { glob: "**/test-support/**", reason: "test helpers" },
  { glob: "**/*.testutil.ts", reason: "test helpers" },
  { glob: "**/__test-helpers__/**", reason: "test helpers" },
  {
    glob: "apps/web/vitest.config.ts",
    reason: "the web unit-test runner's config; no user, admin or self-host surface",
  },
  {
    glob: "apps/web/vite.config.ts",
    reason: "the contributor dev server's build and proxy config; no user, admin or self-host surface",
  },
  {
    glob: "apps/api/src/modules/imports/transforms/**",
    reason: "import transform engine internals; the import tools that expose it carry its page",
  },
  {
    glob: "apps/api/src/modules/imports/parsers/**",
    reason: "import parser internals; the import tools that expose them carry their page",
  },
  { glob: "**/node_modules/**", reason: "dependencies" },
  { glob: "**/dist/**", reason: "build output" },
  { glob: "**/package.json", reason: "dependency bumps; behaviour changes land in mapped source files" },
  { glob: "**/tsconfig*.json", reason: "build config" },
  { glob: "{apps,bundled-apps,packages}/**/*.md", reason: "an app or package README; docs pages are under docs/" },
  { glob: "packages/test-helpers/**", reason: "test helpers" },
  { glob: "packages/mailbox-crypto/**", reason: "internal crypto, covered by Security" },
  { glob: "packages/shared/src/i18n/**", reason: "translations; label changes follow the module's own map entry" },
  { glob: "apps/web/src/modules/i18n/**", reason: "translations" },
  { glob: "apps/api/src/db/**", reason: "schema and migrations (internal)" },
  { glob: "apps/api/src/infra/**", reason: "internal plumbing" },
  { glob: "apps/api/src/middleware/**", reason: "internal plumbing" },
  { glob: "apps/api/src/services/**", reason: "internal plumbing" },
  // Exempt is checked before the map, so these globs must NOT match lib/env.ts
  // (mapped to reference/env above): subfolders, files not starting with "e",
  // and the "e" files other than env.ts by name. A new lib/e*.ts is unmapped
  // and fails the check until it is listed here.
  { glob: "apps/api/src/lib/manifest-regex-proven.json", reason: "generated; its behaviour is documented in app-package-format" },
  { glob: "apps/api/src/lib/*/**", reason: "internal helpers" },
  { glob: "apps/api/src/lib/[!e]*.ts", reason: "internal helpers" },
  { glob: "apps/api/src/lib/{edition,env-boolean,error-tracker,external-content}.ts", reason: "internal helpers" },
  { glob: "apps/api/src/*.ts", reason: "server entry points" },
  { glob: "apps/api/src/modules/cloud/**", reason: "signed operator API of the managed edition, no user-facing setting (its handoff page is documented under admin/users via apps/web auth)" },
  { glob: "apps/api/src/modules/{admin,attention,audit,billing-admin,billing-state,bug-reports,i18n,loadtest,maintenance,monitor,pdf,provisioning,push,saved-views,search,security,sequences,slots}/**", reason: "internal modules with no user-facing setting" },
  {
    glob: "apps/api/src/modules/documents/pdf-form*.ts",
    reason: "host PDF form fill library (like modules/pdf); the document templates settings that use it map their own page",
  },
  { glob: "apps/web/src/{framework,ui,lib,primitives,styles,assets,startup.ts,index.tsx,index.css,App.tsx,env.d.ts,test-setup.ts}", reason: "web shell internals" },
  { glob: "apps/web/src/{framework,ui,lib,primitives,styles,assets}/**", reason: "web shell internals" },
  { glob: "apps/web/src/modules/{bug-report,editor,search,shell,test}/**", reason: "web shell internals" },
  { glob: "apps/web/src/modules/*.ts", reason: "web module glue" },
]

/** Roots where an unmapped, non-exempt file fails the check. packages/shared is
 * left out on purpose: it is mostly helpers, and its user-facing files are mapped. */
export const DOCS_FAILSAFE_ROOTS = ["apps/", "bundled-apps/", "deploy/", "packages/app-sdk/", "packages/host-sdk/", "packages/app-ui/", "packages/api-connector-core/", "packages/db-core/"]
