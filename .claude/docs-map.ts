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
 * Generated reference pages (docs/reference/*): an entry that names one is
 * satisfied when the page's fresh render differs from the base's copy (the
 * check renders it; a PR does not regenerate the committed copy, a refresh PR
 * running `bun run docs:gen` does).
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
  { glob: "apps/api/src/modules/agent/routines/deal-followups*", pages: ["sales/follow-ups", "agents/routines"] },
  { glob: "apps/api/src/modules/agent/tools/company-tools.ts", pages: ["sales/companies", "agents/tools"] },
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

  // Sales and CRM: specific before the app globs below.
  { glob: "apps/api/src/modules/mail/suppressions*", pages: ["sales/opt-outs", "apps/mail"] },
  { glob: "apps/api/src/modules/mail/commercial-footer*", pages: ["sales/opt-outs", "apps/mail"] },
  { glob: "apps/api/src/modules/mail/opt-out*", pages: ["sales/opt-outs", "apps/mail"] },
  { glob: "apps/api/src/modules/mail/optout*", pages: ["sales/opt-outs", "apps/mail"] },
  { glob: "apps/api/src/modules/mail/send-guard*", pages: ["sales/opt-outs", "sales/follow-ups", "apps/mail"] },
  { glob: "apps/api/src/modules/contacts/prospect-retention*", pages: ["sales/opt-outs", "apps/mail"] },
  { glob: "apps/api/src/modules/contacts/compan*", pages: ["sales/companies", "apps/contacts"] },
  { glob: "apps/api/src/modules/contacts/activity*", pages: ["sales/companies", "apps/contacts"] },
  { glob: "apps/api/src/apps/contacts/import-kind*", pages: ["sales/importing-companies-and-deals", "apps/contacts"] },
  { glob: "apps/api/src/apps/projects/import-deal-kind*", pages: ["sales/importing-companies-and-deals", "sales/deals"] },
  { glob: "apps/api/src/apps/projects/service/deals*", pages: ["sales/deals", "sales/quiet-deals", "sales/follow-ups", "sales/forecast"] },
  { glob: "apps/web/src/modules/contacts/Compan*", pages: ["sales/companies", "apps/contacts"] },
  { glob: "apps/web/src/modules/contacts/Activity*", pages: ["sales/companies", "apps/contacts"] },
  { glob: "apps/web/src/modules/projects/Deal*", pages: ["sales/deals", "apps/projects"] },
  { glob: "apps/web/src/modules/projects/CompanyWorkPanel*", pages: ["sales/companies", "apps/projects"] },
  { glob: "apps/web/src/modules/tickets/CompanySupportPanel*", pages: ["sales/companies", "apps/tickets"] },
  { glob: "bundled-apps/invoicing/src/ui/CompanyMoneyPanel*", pages: ["sales/companies", "apps/invoicing"] },

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
  { glob: "bundled-apps/google-drive/**", pages: ["apps/google-drive"] },
  { glob: "bundled-apps/gitlab/**", pages: ["apps/gitlab"] },
  { glob: "bundled-apps/github/**", pages: ["apps/github"] },
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
  { glob: "apps/api/src/modules/apps/connections/api/**", pages: ["api-connector", "sales/connect-your-crm"] },
  { glob: "bundled-apps/api-connector/**", pages: ["api-connector", "sales/connect-your-crm"] },
  { glob: "packages/api-connector-core/**", pages: ["api-connector"] },
  { glob: "bundled-apps/database/**", pages: ["database-connector", "sales/sales-data"] },
  { glob: "packages/db-core/**", pages: ["database-connector"] },
  { glob: "apps/db-gate/**", pages: ["database-connector"] },
  { glob: "apps/api/src/apps/example/**", pages: ["app-development"] },

  // Bundled apps
  { glob: "bundled-apps/invoicing/src/recurring/**", pages: ["apps/recurring"] },
  { glob: "bundled-apps/invoicing/src/{streams,ui/IssuerStreams}*", pages: ["money/who-issues-what", "money/turn-off-stripe-emails", "apps/invoicing"] },
  { glob: "bundled-apps/invoicing/**", pages: ["apps/invoicing", "sales/quotes"] },
  { glob: "bundled-apps/boxtal/**", pages: ["apps/boxtal"] },
  { glob: "bundled-apps/boxtal/src/{customs-documents,print-pack,needed-documents}.ts", pages: ["admin/shipping-documents"] },
  { glob: "bundled-apps/shopify/**", pages: ["apps/store"] },
  { glob: "bundled-apps/pennylane/**", pages: ["apps/pennylane"] },
  { glob: "bundled-apps/social/**", pages: ["apps/social"] },
  { glob: "bundled-apps/ads/**", pages: ["apps/ads"] },
  { glob: "bundled-apps/calls/**", pages: ["apps/calls", "sales/sales-data"] },
  { glob: "bundled-apps/monitoring/**", pages: ["apps/monitoring"] },
  { glob: "bundled-apps/stripe/src/{mrr,mrr-events,mrr-rebuild,tools/mrr-query}*", pages: ["apps/stripe", "money/mrr-rules"] },
  { glob: "bundled-apps/stripe/src/tools/refunds*", pages: ["apps/stripe", "money/refunds-and-credit-notes"] },
  { glob: "bundled-apps/stripe/**", pages: ["apps/stripe"] },

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
  // The app data store (ctx.store for apps, the agent's data tools) and dashboards (agent tools, the dashboard tab).
  // The in-product app builder: drafts, the sandboxed build, custom app logs.
  { glob: "apps/api/src/modules/app-builder/**", pages: ["app-development", "agents/build-an-app"] },
  { glob: "apps/web/src/modules/app-builder/**", pages: ["agents/build-an-app"] },
  { glob: "apps/api/src/modules/agent/prompts/kernel/build-app.md", pages: ["agents/build-an-app"] },
  { glob: "apps/api/src/modules/data-store/**", pages: ["agents/tools", "app-sandbox"] },
  { glob: "apps/api/src/modules/dashboards/**", pages: ["agents/tools", "agents/dashboards"] },
  // Dashboard tables: the rows, their sharing, history, tools, routines trigger and link picking.
  {
    glob: "apps/api/src/modules/dashboards/tables/**",
    pages: ["agents/tools", "agents/dashboards", "agents/dashboard-tables"],
  },
  { glob: "apps/web/src/modules/dashboards/**", pages: ["agents/dashboards", "agents/dashboard-tables"] },
  // Document templates (org admin settings); the settings page that edits them documents them.
  { glob: "apps/api/src/modules/documents/**", pages: ["admin/settings"] },
  { glob: "apps/api/src/modules/documents/{rich-text,rules,rules-store}.ts", pages: ["admin/shipping-documents"] },
  { glob: "apps/api/src/modules/org/**", pages: ["admin/settings"] },
  { glob: "apps/api/src/modules/branding/**", pages: ["admin/settings"] },
  { glob: "apps/api/src/modules/client-policy/**", pages: ["reference/env"] },
  { glob: "apps/web/src/modules/settings/**", pages: ["admin/settings"] },
  { glob: "apps/api/src/modules/export/**", pages: ["admin/backups"] },
  { glob: "apps/api/src/modules/imports/**", pages: ["admin/settings", "app-development"] },
  { glob: "apps/web/src/modules/imports/**", pages: ["admin/settings", "agents/how-agents-work"] },
  { glob: "apps/web/src/modules/app-pages/**", pages: ["app-development"] },
  { glob: "apps/api/src/modules/erasure/**", pages: ["admin/backups"] },
  { glob: "apps/api/src/modules/mailbox-keys/**", pages: ["runbooks/key-rotation"] },

  // Getting started
  { glob: "apps/api/src/modules/demo/**", pages: ["getting-started/demo"] },
  // The Playwright suite's config: snapshot update mode, baselines per platform.
  { glob: "apps/web/playwright.config.ts", pages: ["testing"] },
  // Seed tiers before the catch-all below (the first matching entry wins).
  { glob: "apps/api/src/seed/tiers/standard/**", pages: ["testing", "provisioning-cli"] },
  { glob: "apps/api/src/seed/tiers/minimal.ts", pages: ["testing"] },
  { glob: "apps/api/src/seed/tiers/lively/**", pages: ["provisioning-cli", "getting-started/install"] },
  { glob: "apps/api/src/seed/**", pages: ["getting-started/demo", "provisioning-cli"] },
  { glob: "apps/api/src/modules/liaison-team/**", pages: ["self-hosting/liaison-team"] },
  { glob: "apps/web/src/modules/demo/**", pages: ["getting-started/demo"] },
  { glob: "apps/api/src/modules/tours/**", pages: ["getting-started/demo"] },
  { glob: "apps/web/src/modules/tours/**", pages: ["getting-started/demo"] },
  // The Help tab and the "?" that opens it; on a demo the menu also lists the tours.
  { glob: "apps/web/src/modules/help/**", pages: ["getting-started/introduction", "getting-started/demo"] },
  { glob: "packages/shared/src/help-docs.ts", pages: ["getting-started/introduction"] },
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
  { glob: "deploy/docker-compose.yml", pages: ["self-hosting/pools", "self-hosting/sandbox"] },
  { glob: "deploy/sandbox-firewall.sh", pages: ["self-hosting/sandbox"] },
  { glob: "packages/sandbox-supervisor/**", pages: ["self-hosting/sandbox"] },
  { glob: "apps/api/src/modules/apps/workers/bridge-listener.ts", pages: ["self-hosting/sandbox"] },
  { glob: "apps/api/src/modules/apps/usage/run-{health,health-checks,pool-gauges}.ts", pages: ["self-hosting/docker"] },
  { glob: "apps/api/src/modules/admin/app-health.ts", pages: ["self-hosting/docker"] },
  { glob: "docker-compose.yml", pages: ["self-hosting/docker"] },
  { glob: "Dockerfile*", pages: ["self-hosting/docker"] },
  { glob: "apps/api/Dockerfile", pages: ["self-hosting/docker"] },
  { glob: "apps/api/scripts/entrypoint.sh", pages: ["self-hosting/docker", "admin/upgrades"] },
  { glob: "apps/api/scripts/cron-fanout-rollback.ts", pages: ["self-hosting/docker", "backend-overview"] },
  { glob: "apps/api/scripts/kernel-queues-rollback.ts", pages: ["self-hosting/docker", "backend-overview"] },
  { glob: "apps/api/app-index-none.json", pages: ["self-hosting/docker"] },
  { glob: "scripts/build-app-catalog.ts", pages: ["self-hosting/docker"] },

  // Developers
  { glob: "packages/app-sdk/**", pages: ["app-development", "app-package-format"] },
  { glob: "packages/shared/src/app-signing/**", pages: ["app-package-format"] },
  { glob: "scripts/app-signing/**", pages: ["app-package-format"] },
  { glob: "packages/host-sdk/**", pages: ["app-development"] },
  { glob: "packages/app-ui/**", pages: ["app-development"] },
  // The platform-held SQL connections: `ctx.sql` and the database connector's transports.
  { glob: "apps/api/src/modules/apps/connections/sql/**", pages: ["app-sandbox", "database-connector"] },
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
  {
    glob: "apps/api/src/apps/gitlab/**",
    reason: "former path of the gitlab app (moved to bundled-apps/gitlab, which is mapped)",
  },
  {
    glob: "apps/api/src/apps/database/**",
    reason: "former path of the database app (moved to bundled-apps/database, which is mapped)",
  },
  {
    glob: "apps/api/src/modules/database/**",
    reason: "former kernel routes of the database app (now its own tools); bundled-apps/database is mapped",
  },
  {
    glob: "apps/web/src/modules/database/**",
    reason: "former web module of the database app (now its own ui.tsx); bundled-apps/database is mapped",
  },
  {
    glob: "apps/api/src/apps/google-drive/**",
    reason: "former path of the google-drive app (moved to bundled-apps/google-drive, which is mapped)",
  },
  {
    glob: "apps/web/src/modules/drive-picker/**",
    reason: "former web module of the google-drive app (now its own ui.tsx and page); bundled-apps/google-drive is mapped",
  },
  {
    glob: "apps/api/src/apps/api-connector/**",
    reason:
      "former path of the api-connector app (now bundled-apps/api-connector over the platform's connections/api, both mapped)",
  },
  {
    glob: "apps/api/src/modules/api-connector/**",
    reason: "former kernel routes of the api-connector app (now its own tools); bundled-apps/api-connector is mapped",
  },
  {
    glob: "apps/web/src/modules/api-connector/**",
    reason: "former web module of the api-connector app (now its own ui.tsx); bundled-apps/api-connector is mapped",
  },
  { glob: "**/__snapshots__/**", reason: "test snapshots" },
  { glob: "**/fixtures/**", reason: "test fixtures" },
  { glob: "**/tests/**", reason: "tests" },
  { glob: "**/test-support/**", reason: "test helpers" },
  { glob: "**/*.testutil.ts", reason: "test helpers" },
  { glob: "**/__test-helpers__/**", reason: "test helpers" },
  {
    glob: "apps/api/scripts/contract/**",
    reason: "contract fixture recorders, run by hand by a developer; no user-visible effect",
  },
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
