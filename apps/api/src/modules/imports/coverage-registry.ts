// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Import coverage registry (S13, A33): every org-scoped table is either written
 * by an import kind (its manifest `tables`), exempt with a class and a reason, or
 * planned for a kind not built yet (`planned`: only the mail archive, whose owner
 * model is still open).
 * `coverage-guard.test.ts` fails on any table that is none of these.
 */

/** `deferred`: business data entered by hand that no import kind covers yet (an owner's call). */
export type CoverageClass = "config" | "deferred" | "derived" | "sync" | "system"

export type CoverageEntry =
  | { exempt: CoverageClass; reason: string }
  | { planned: "P3b"; kind: string }

export const IMPORT_COVERAGE: Readonly<Record<string, CoverageEntry>> = {
  "app_ads.audience_erasure_log": {
    exempt: "system",
    reason: "ads runtime state and configuration",
  },
  "app_ads.dealer_profiles": {
    exempt: "config",
    reason:
      "ads configuration: dealer profiles are set up in the app per dealer (no import kind yet)",
  },
  "app_ads.experiments": { exempt: "system", reason: "ads runtime state and configuration" },
  "app_ads.manual_spend": {
    exempt: "deferred",
    reason: "no import kind yet; hand-entered data",
  },
  "app_ads.metric_formulas": { exempt: "system", reason: "ads runtime state and configuration" },
  "app_ads.pause_ledger": { exempt: "system", reason: "ads runtime state and configuration" },
  "app_api_connector.adapter_versions": {
    exempt: "config",
    reason: "credentials and configuration",
  },
  "app_api_connector.adapters": { exempt: "config", reason: "credentials and configuration" },
  "app_boxtal.app_config": { exempt: "sync", reason: "shipping sync and preparation state" },
  "app_boxtal.attention_rule": { exempt: "sync", reason: "shipping sync and preparation state" },
  "app_boxtal.claim": { exempt: "sync", reason: "shipping sync and preparation state" },
  "app_boxtal.prep_draft_cache": { exempt: "sync", reason: "shipping sync and preparation state" },
  "app_boxtal.prep_meta": { exempt: "sync", reason: "shipping sync and preparation state" },
  "app_boxtal.prep_order_state": { exempt: "sync", reason: "shipping sync and preparation state" },
  "app_boxtal.prep_quote": { exempt: "sync", reason: "shipping sync and preparation state" },
  "app_boxtal.prep_state": { exempt: "sync", reason: "shipping sync and preparation state" },
  "app_boxtal.shipment": { exempt: "sync", reason: "shipping sync and preparation state" },
  "app_boxtal.short_code_sync": {
    exempt: "sync",
    reason: "product short codes not yet synced to the products",
  },
  "app_boxtal.subscription": { exempt: "sync", reason: "shipping sync and preparation state" },
  "app_boxtal.variant_sku": {
    exempt: "derived",
    reason: "cache of each variant's SKU read from the store",
  },
  "app_boxtal.webhook_delivery": { exempt: "sync", reason: "shipping sync and preparation state" },
  "app_calendar.sync_log": { exempt: "system", reason: "calendar sync log" },
  "app_example.items": { exempt: "system", reason: "development scaffold app" },
  "app_example.summaries": { exempt: "system", reason: "development scaffold app" },
  "app_invoicing.contact_primary_thread": {
    exempt: "sync",
    reason: "e-invoicing and FX sync state",
  },
  "app_invoicing.contact_relationships": {
    exempt: "sync",
    reason: "e-invoicing and FX sync state",
  },
  "app_invoicing.counterparty_identities": {
    exempt: "sync",
    reason: "e-invoicing and FX sync state",
  },
  "app_invoicing.deferred_events": { exempt: "sync", reason: "e-invoicing and FX sync state" },
  "app_invoicing.einvoice_book_batches": {
    exempt: "sync",
    reason: "e-invoicing and FX sync state",
  },
  "app_invoicing.einvoice_transmissions": {
    exempt: "sync",
    reason: "e-invoicing and FX sync state",
  },
  "app_invoicing.einvoicing_orphan_events": {
    exempt: "sync",
    reason: "e-invoicing and FX sync state",
  },
  "app_invoicing.einvoicing_settings": {
    exempt: "config",
    reason: "invoicing configuration, set by config apply",
  },
  "app_invoicing.facturx_files": {
    exempt: "derived",
    reason:
      "legal originals: recorded from an imported PDF by the legacy-originals backfill, never by an import (immutable 10 years)",
  },
  "app_invoicing.fx_rates": { exempt: "sync", reason: "e-invoicing and FX sync state" },
  "app_invoicing.hs_code_library": { exempt: "sync", reason: "e-invoicing and FX sync state" },
  "app_invoicing.install_state": {
    exempt: "config",
    reason: "invoicing configuration, set by config apply",
  },
  "app_invoicing.issuer_profiles": {
    exempt: "config",
    reason: "invoicing configuration, set by config apply",
  },
  "app_invoicing.legal_originals": {
    exempt: "derived",
    reason:
      "legal originals: recorded from an imported PDF by the legacy-originals backfill, never by an import (immutable 10 years)",
  },
  "app_invoicing.product_customs_overlay": {
    exempt: "deferred",
    reason: "no import kind yet; hand-entered data",
  },
  "app_invoicing.received_einvoice_files": {
    exempt: "sync",
    reason: "e-invoicing and FX sync state",
  },
  "app_invoicing.received_einvoices": { exempt: "sync", reason: "e-invoicing and FX sync state" },
  "app_invoicing.received_retry": { exempt: "sync", reason: "e-invoicing and FX sync state" },
  "app_invoicing.received_sync_state": { exempt: "sync", reason: "e-invoicing and FX sync state" },
  "app_invoicing.tax_regimes": {
    exempt: "config",
    reason: "invoicing configuration, set by config apply",
  },
  "app_invoicing.webhook_deliveries": { exempt: "sync", reason: "e-invoicing and FX sync state" },
  "app_knowledge.content_cache_entries": { exempt: "sync", reason: "knowledge source sync" },
  "app_knowledge.source_identities": { exempt: "sync", reason: "knowledge source sync" },
  "app_knowledge.source_links": { exempt: "sync", reason: "knowledge source sync" },
  "app_knowledge.source_policies": { exempt: "sync", reason: "knowledge source sync" },
  "app_knowledge.synced_sources": { exempt: "sync", reason: "knowledge source sync" },
  "app_mail.accounts": { planned: "P3b", kind: "mail.archive (imported account)" },
  "app_mail.conversations": { planned: "P3b", kind: "mail.archive" },
  "app_mail.drafts": { exempt: "system", reason: "transient encrypted drafts" },
  "app_mail.messages": { planned: "P3b", kind: "mail.archive" },
  "app_mcp_manager.mcp_connection_access": {
    exempt: "config",
    reason: "credentials and configuration",
  },
  "app_mcp_manager.mcp_connections": { exempt: "config", reason: "credentials and configuration" },
  "app_monitoring.incidents": { exempt: "system", reason: "generated incidents" },
  "app_monitoring.incident_comments": {
    exempt: "system",
    reason: "comments and archived episodes of generated incidents",
  },
  "app_pennylane.account_class_map": {
    exempt: "sync",
    reason: "accounting sync state and configuration",
  },
  "app_pennylane.app_config": { exempt: "sync", reason: "accounting sync state and configuration" },
  "app_pennylane.cash_snapshot": {
    exempt: "sync",
    reason: "accounting sync state and configuration",
  },
  "app_pennylane.einvoicing_inbox": {
    exempt: "sync",
    reason: "accounting sync state and configuration",
  },
  "app_pennylane.pnl_snapshot": {
    exempt: "sync",
    reason: "accounting sync state and configuration",
  },
  "app_pennylane.supplier_invoice_upload": {
    exempt: "sync",
    reason: "accounting sync state and configuration",
  },
  "app_projects.labels": {
    exempt: "config",
    reason: "projects configuration: label groups and values are defined per org in the app",
  },
  "app_projects.task_labels": {
    exempt: "deferred",
    reason: "no import kind maps task labels yet; set by hand or by the agent",
  },
  "app_shopify.backfill_progress": { exempt: "sync", reason: "shop mirror and install state" },
  "app_shopify.install_metadata": { exempt: "sync", reason: "shop mirror and install state" },
  "app_shopify.staff_mirror": { exempt: "sync", reason: "shop mirror and install state" },
  "app_shopify.staff_overrides": { exempt: "sync", reason: "shop mirror and install state" },
  "app_shopify.webhook_deliveries": { exempt: "sync", reason: "shop mirror and install state" },
  "app_social.dm_conversation": {
    exempt: "sync",
    reason: "social sync state and watch configuration",
  },
  "app_social.dm_message": { exempt: "sync", reason: "social sync state and watch configuration" },
  "app_social.finding": { exempt: "sync", reason: "social sync state and watch configuration" },
  "app_social.monitor_term": {
    exempt: "sync",
    reason: "social sync state and watch configuration",
  },
  "app_social.sync_state": { exempt: "sync", reason: "social sync state and watch configuration" },
  "app_social.watched_object": {
    exempt: "sync",
    reason: "social sync state and watch configuration",
  },
  "app_tickets.api_keys": { exempt: "system", reason: "secrets" },
  "app_tickets.inboxes": {
    exempt: "config",
    reason: "provisioned by config apply; an inbox is backed by a connected mailbox",
  },
  "app_tickets.ticket_csat": { exempt: "derived", reason: "read state, survey answers" },
  "app_tickets.ticket_reads": { exempt: "derived", reason: "read state, survey answers" },
  "kernel.agent_knowledge_pointers": { exempt: "derived", reason: "derived from knowledge" },
  "kernel.agent_local_claims": { exempt: "system", reason: "agent runtime state" },
  "kernel.agent_memory": {
    exempt: "derived",
    reason: "written by agents as they work; never brought over from another system",
  },
  "kernel.agent_migration_ledger": { exempt: "system", reason: "ledger of a one-off migration" },
  "kernel.agent_runs": { exempt: "system", reason: "agent runtime state" },
  "kernel.agent_skill_index": { exempt: "system", reason: "agent runtime state" },
  "kernel.agent_thread_checkpoints": { exempt: "system", reason: "agent runtime state" },
  "kernel.agent_turn_events": { exempt: "system", reason: "agent runtime state" },
  "kernel.agent_turns": { exempt: "system", reason: "agent runtime state" },
  "kernel.agents": {
    exempt: "config",
    reason: "provisioned by config apply (agent configuration, not business records)",
  },
  "kernel.app_scope_grant_audit": { exempt: "derived", reason: "grant audit trail" },
  "kernel.app_seeded_assets": { exempt: "config", reason: "org and app configuration" },
  "kernel.app_sequences": { exempt: "config", reason: "org and app configuration" },
  "kernel.approval_handle_counters": {
    exempt: "system",
    reason: "per-org numbering of approval handles",
  },
  "kernel.approval_policies": {
    exempt: "config",
    reason: "policy configuration, set by config apply",
  },
  "kernel.approval_requests": { exempt: "system", reason: "agent runtime state" },
  "kernel.approved_handler_executions": { exempt: "system", reason: "agent runtime state" },
  "kernel.apps": { exempt: "config", reason: "org and app configuration" },
  "kernel.apps_active_version": {
    exempt: "system",
    reason: "instance-wide app version state (org_id reserved, always NULL)",
  },
  "kernel.apps_installed": {
    exempt: "system",
    reason:
      "installed app versions; org_id marks an org-private custom app, installed, not imported",
  },
  "kernel.attention_events": { exempt: "system", reason: "per-user and per-device state" },
  "kernel.away_ranges": { exempt: "system", reason: "per-user and per-device state" },
  "kernel.audit_log": { exempt: "system", reason: "audit, credits, demo and search bookkeeping" },
  "kernel.auto_approve_policies": {
    exempt: "config",
    reason: "policy configuration, set by config apply",
  },
  "kernel.browser_push_subscriptions": {
    exempt: "system",
    reason: "per-user and per-device state",
  },
  "kernel.config_applied_fields": { exempt: "config", reason: "org and app configuration" },
  "kernel.connected_accounts": { exempt: "system", reason: "credentials and secrets" },
  "kernel.contact_addresses": {
    exempt: "deferred",
    reason: "no import kind yet; addresses come from the shipping sync or are entered by hand",
  },
  "kernel.contact_group_members": {
    exempt: "deferred",
    reason: "no import kind yet; hand-entered data",
  },
  "kernel.contact_segments": {
    exempt: "config",
    reason: "segments are saved contact filters or hand-picked groups, set up in the app",
  },
  "kernel.credit_balances": {
    exempt: "system",
    reason: "audit, credits, demo and search bookkeeping",
  },
  "kernel.credit_transactions": {
    exempt: "system",
    reason: "audit, credits, demo and search bookkeeping",
  },
  "kernel.demo_world_marks": {
    exempt: "system",
    reason: "audit, credits, demo and search bookkeeping",
  },
  "kernel.desktop_devices": { exempt: "system", reason: "per-user and per-device state" },
  "kernel.device_flow_requests": { exempt: "system", reason: "credentials and secrets" },
  "kernel.disabled_app_skills": { exempt: "config", reason: "org and app configuration" },
  "kernel.document_template_rules": {
    exempt: "config",
    reason: "the org's needed-template rules, made in settings or by an agent",
  },
  "kernel.document_templates": {
    exempt: "config",
    reason: "the org's document templates, made in settings or by an agent",
  },
  "kernel.effect_ledger": {
    exempt: "system",
    reason: "once-only ledger of outside effects (agent runtime state)",
  },
  "kernel.file_upload_sessions": { exempt: "system", reason: "transient upload state" },
  "kernel.import_ledger": { exempt: "system", reason: "import framework bookkeeping" },
  "kernel.import_transforms": { exempt: "system", reason: "import framework bookkeeping" },
  "kernel.import_uploads": { exempt: "system", reason: "import framework bookkeeping" },
  "kernel.import_runs": { exempt: "system", reason: "import framework bookkeeping" },
  "kernel.invitations": { exempt: "system", reason: "credentials and secrets" },
  "kernel.mailbox_client_jobs": { exempt: "system", reason: "credentials and secrets" },
  "kernel.mailbox_migration_state": { exempt: "system", reason: "credentials and secrets" },
  "kernel.mailbox_server_keys": { exempt: "system", reason: "credentials and secrets" },
  "kernel.mcp_connections": { exempt: "system", reason: "credentials and secrets" },
  "kernel.node_attachments": { exempt: "system", reason: "node runtime" },
  "kernel.node_capabilities": { exempt: "system", reason: "node runtime" },
  "kernel.node_connections": { exempt: "system", reason: "node runtime" },
  "kernel.node_jobs": { exempt: "system", reason: "node runtime" },
  "kernel.node_level_confirmations": { exempt: "system", reason: "node runtime" },
  "kernel.node_permission_prompts": { exempt: "system", reason: "node runtime" },
  "kernel.node_profiles": { exempt: "system", reason: "node runtime" },
  "kernel.node_sessions": { exempt: "system", reason: "node runtime" },
  "kernel.nodes": { exempt: "system", reason: "node runtime" },
  "kernel.notification_deliveries": { exempt: "system", reason: "per-user and per-device state" },
  "kernel.notification_device_credentials": { exempt: "system", reason: "credentials and secrets" },
  "kernel.notification_receipts": { exempt: "system", reason: "per-user and per-device state" },
  "kernel.oauth_accounts": { exempt: "system", reason: "credentials and secrets" },
  "kernel.oauth_providers": { exempt: "system", reason: "credentials and secrets" },
  "kernel.org_app_access": { exempt: "config", reason: "org and app configuration" },
  "kernel.org_app_features": { exempt: "config", reason: "org and app configuration" },
  "kernel.org_billing_state": {
    exempt: "system",
    reason: "billing status pushed by the control plane (managed edition), never imported",
  },
  "kernel.org_exports": { exempt: "system", reason: "export archive bookkeeping" },
  "kernel.org_transfer_ledger": {
    exempt: "system",
    reason: "this instance's record of org moves, written by the transfer itself, never imported",
  },
  "kernel.password_resets": { exempt: "system", reason: "credentials and secrets" },
  "kernel.pending_events": { exempt: "system", reason: "per-user and per-device state" },
  "kernel.product_attributes": {
    exempt: "config",
    reason: "per-SKU product configuration (short codes), set in the apps or by an agent",
  },
  "kernel.push_tokens": { exempt: "system", reason: "per-user and per-device state" },
  "kernel.reply_thread_followers": {
    exempt: "derived",
    reason: "rebuilt from threads and messages",
  },
  "kernel.roles": { exempt: "config", reason: "roles and grants, set by config apply" },
  "kernel.secret_requests": { exempt: "system", reason: "credentials and secrets" },
  "kernel.routine_runs": { exempt: "system", reason: "agent runtime state" },
  "kernel.routine_state": { exempt: "system", reason: "agent runtime state" },
  "kernel.saved_views": { exempt: "system", reason: "per-user and per-device state" },
  "kernel.scope_disclosure_policy": {
    exempt: "config",
    reason: "policy configuration, set by config apply",
  },
  "kernel.scope_requests": { exempt: "system", reason: "agent runtime state" },
  "kernel.search_document_clusters": {
    exempt: "system",
    reason: "audit, credits, demo and search bookkeeping",
  },
  "kernel.sessions": { exempt: "system", reason: "credentials and secrets" },
  "kernel.sub_agent_definitions": {
    exempt: "config",
    reason: "agent configuration, defined in the app or by agents (not business records)",
  },
  "kernel.thread_brief_marks": { exempt: "derived", reason: "rebuilt from threads and messages" },
  "kernel.thread_briefs": { exempt: "derived", reason: "rebuilt from threads and messages" },
  "kernel.thread_episodes": { exempt: "derived", reason: "rebuilt from threads and messages" },
  "kernel.thread_node_settings": { exempt: "system", reason: "node runtime" },
  "kernel.thread_references": { exempt: "derived", reason: "rebuilt from threads and messages" },
  "kernel.timeline_entries": { exempt: "derived", reason: "rebuilt from threads and messages" },
  "kernel.tour_progress": { exempt: "system", reason: "per-user and per-device state" },
  "kernel.trusted_senders": { exempt: "config", reason: "security configuration, set in the UI" },
  "kernel.user_key_wraps": { exempt: "system", reason: "credentials and secrets" },
  "kernel.user_mailbox_identities": { exempt: "system", reason: "credentials and secrets" },
  "kernel.user_roles": { exempt: "config", reason: "roles and grants, set by config apply" },
  "kernel.user_scope_grants": { exempt: "config", reason: "roles and grants, set by config apply" },
  "kernel.user_thread_state": { exempt: "derived", reason: "rebuilt from threads and messages" },
}
