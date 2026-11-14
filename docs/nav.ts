// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The docs site's table of contents: every published page, in reading order.
 *
 * A page's id is its source path under `docs/` without `.md`; its URL is
 * `/docs/<url>/` (or `/docs/` for the landing page). `.claude/docs-map.ts`
 * names pages by these ids, and `bun run check:docs` fails when a page file
 * is missing from this list or a listed page has no file.
 */
export interface NavPage {
  /** Source path under docs/, without `.md`. */
  id: string
  /** URL path under /docs/, without slashes. Stable: never rename a published one. */
  url: string
}

export interface NavSection {
  title: string
  pages: NavPage[]
}

export const LANDING: NavPage = { id: "index", url: "" }

export const NAV: NavSection[] = [
  {
    title: "Getting started",
    pages: [
      { id: "getting-started/introduction", url: "getting-started/introduction" },
      { id: "getting-started/demo", url: "getting-started/demo" },
      { id: "getting-started/install", url: "getting-started/install" },
      { id: "getting-started/first-org", url: "getting-started/first-org" },
      { id: "getting-started/desktop-and-phone", url: "getting-started/desktop-and-phone" },
    ],
  },
  {
    title: "Agents",
    pages: [
      { id: "agents/how-agents-work", url: "agents/how-agents-work" },
      { id: "agents/create-an-agent", url: "agents/create-an-agent" },
      { id: "agents/approvals", url: "agents/approvals" },
      { id: "agents/routines", url: "agents/routines" },
      { id: "agents/permissions", url: "agents/permissions" },
      { id: "agents/models", url: "agents/models" },
      { id: "agents/tools", url: "agents/tools" },
      { id: "agents/dashboards", url: "agents/dashboards" },
      { id: "agents/dashboard-tables", url: "agents/dashboard-tables" },
      { id: "agents/build-an-app", url: "agents/build-an-app" },
      { id: "agents/mcp-servers", url: "agents/mcp-servers" },
    ],
  },
  {
    title: "Computers",
    pages: [
      { id: "computers/what-is-a-node", url: "computers/what-is-a-node" },
      { id: "computers/connect", url: "computers/connect" },
      { id: "computers/folders", url: "computers/folders" },
      { id: "computers/run-work", url: "computers/run-work" },
      { id: "computers/sessions", url: "computers/sessions" },
      { id: "computers/guardrails", url: "computers/guardrails" },
      { id: "computers/security", url: "computers/security" },
    ],
  },
  {
    title: "Apps",
    pages: [
      { id: "apps/mail", url: "apps/mail" },
      { id: "apps/tickets", url: "apps/tickets" },
      { id: "apps/chat", url: "apps/chat" },
      { id: "apps/knowledge", url: "apps/knowledge" },
      { id: "apps/google-drive", url: "apps/google-drive" },
      { id: "apps/gitlab", url: "apps/gitlab" },
      { id: "apps/github", url: "apps/github" },
      { id: "apps/contacts", url: "apps/contacts" },
      { id: "apps/calendar", url: "apps/calendar" },
      { id: "apps/projects", url: "apps/projects" },
      { id: "apps/files", url: "apps/files" },
      { id: "apps/invoicing", url: "apps/invoicing" },
      { id: "apps/recurring", url: "apps/recurring" },
      { id: "apps/boxtal", url: "apps/boxtal" },
      { id: "apps/store", url: "apps/store" },
      { id: "apps/pennylane", url: "apps/pennylane" },
      { id: "apps/stripe", url: "apps/stripe" },
      { id: "apps/social", url: "apps/social" },
      { id: "apps/ads", url: "apps/ads" },
      { id: "apps/calls", url: "apps/calls" },
      { id: "apps/monitoring", url: "apps/monitoring" },
    ],
  },
  {
    title: "Money how-to",
    pages: [
      { id: "money/connect-stripe-restricted-key", url: "money/connect-stripe-restricted-key" },
      { id: "money/who-issues-what", url: "money/who-issues-what" },
      { id: "money/turn-off-stripe-emails", url: "money/turn-off-stripe-emails" },
      { id: "money/failed-payments-routine", url: "money/failed-payments-routine" },
      { id: "money/payment-reminders", url: "money/payment-reminders" },
      { id: "money/refunds-and-credit-notes", url: "money/refunds-and-credit-notes" },
      { id: "money/disputes-in-stripe", url: "money/disputes-in-stripe" },
      { id: "money/mrr-rules", url: "money/mrr-rules" },
      { id: "money/no-card-data", url: "money/no-card-data" },
    ],
  },
  {
    title: "Sales and CRM",
    pages: [
      { id: "sales/contacts", url: "sales/contacts" },
      { id: "sales/companies", url: "sales/companies" },
      { id: "sales/duplicates", url: "sales/duplicates" },
      { id: "sales/deals", url: "sales/deals" },
      { id: "sales/quiet-deals", url: "sales/quiet-deals" },
      { id: "sales/follow-ups", url: "sales/follow-ups" },
      { id: "sales/opt-outs", url: "sales/opt-outs" },
      { id: "sales/lead-scoring", url: "sales/lead-scoring" },
      { id: "sales/forecast", url: "sales/forecast" },
      { id: "sales/importing-companies-and-deals", url: "sales/importing-companies-and-deals" },
      { id: "sales/connect-your-crm", url: "sales/connect-your-crm" },
      { id: "sales/research-prospects", url: "sales/research-prospects" },
      { id: "sales/quotes", url: "sales/quotes" },
      { id: "sales/sales-data", url: "sales/sales-data" },
    ],
  },
  {
    title: "Admin",
    pages: [
      { id: "admin/users", url: "admin/users" },
      { id: "admin/roles", url: "admin/roles" },
      { id: "admin/dimensions", url: "admin/dimensions" },
      { id: "admin/settings", url: "admin/settings" },
      { id: "admin/shipping-documents", url: "admin/shipping-documents" },
      { id: "admin/backups", url: "admin/backups" },
      { id: "admin/upgrades", url: "admin/upgrades" },
      { id: "runbooks/key-rotation", url: "admin/rotate-keys" },
    ],
  },
  {
    title: "Self-hosting",
    pages: [
      { id: "self-hosting/docker", url: "self-hosting/docker" },
      { id: "runbooks/production-bootstrap", url: "self-hosting/production" },
      { id: "runbooks/deploy-effects", url: "self-hosting/deploy-effects" },
      { id: "runbooks/org-transfer", url: "self-hosting/move-an-org" },
      { id: "self-hosting/pools", url: "self-hosting/pools" },
      { id: "self-hosting/sandbox", url: "self-hosting/sandbox" },
      { id: "self-hosting/liaison-team", url: "self-hosting/liaison-team" },
      { id: "provisioning-cli", url: "self-hosting/config-as-code" },
      { id: "mcp-servers", url: "self-hosting/mcp-servers" },
    ],
  },
  {
    title: "Developers",
    pages: [
      { id: "app-development", url: "developers/build-an-app" },
      { id: "app-package-format", url: "developers/app-package" },
      { id: "app-sandbox", url: "developers/app-sandbox" },
      { id: "app-webhooks", url: "developers/app-webhooks" },
      { id: "connecting-apps", url: "developers/connecting-apps" },
      { id: "api-connector", url: "developers/api-connector" },
      { id: "database-connector", url: "developers/database-adapter" },
      { id: "developers/mcp", url: "developers/mcp" },
      { id: "developers/rest-api", url: "developers/rest-api" },
      { id: "sdk-gaps", url: "developers/sdk-gaps" },
      { id: "notifications", url: "developers/notifications" },
      { id: "backend-overview", url: "developers/backend-overview" },
      { id: "frontend-overview", url: "developers/frontend-overview" },
      { id: "conventions", url: "developers/conventions" },
      { id: "testing", url: "developers/testing" },
    ],
  },
  {
    title: "Reference",
    pages: [
      { id: "reference/env", url: "reference/env" },
      { id: "reference/cli", url: "reference/cli" },
      { id: "reference/config", url: "reference/config" },
      { id: "reference/scopes", url: "reference/scopes" },
      { id: "reference/agent-tools", url: "reference/agent-tools" },
      { id: "reference/app-settings", url: "reference/app-settings" },
      { id: "reference/setup", url: "reference/setup" },
    ],
  },
  {
    title: "More",
    pages: [
      { id: "security", url: "security" },
      { id: "faq", url: "faq" },
      { id: "release-notes", url: "changelog" },
    ],
  },
]
