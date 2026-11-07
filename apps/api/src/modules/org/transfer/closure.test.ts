// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The org transfer's table set, pinned against the catalog of a migrated
// database (the test template: kernel plus the bundled apps it installs).
//
// Every kernel and bundled-app table is either in the closure, in exactly the
// form listed below (`org`, `direct` = has org_id, `via <parent> (fk)` = owned
// through a foreign key), or classified global/excluded in classification.ts.
// A new table fails here until it is classified: add it below if it moves with
// its org, or to classification.ts with the reason it does not.
import { afterAll, describe, expect, it } from "bun:test"
import postgres from "postgres"
import {
  EXCLUDED_TABLES,
  GLOBAL_TABLES,
  NOT_OBJECT_KEY_COLUMNS,
  OBJECT_KEY_COLUMNS,
} from "./classification"
import {
  assertTransferable,
  buildClosure,
  type CatalogTable,
  describeClosureTable,
  loadClosure,
  readCatalog,
} from "./closure"

const PINNED_SCHEMAS =
  /^(kernel|app_(api_connector|calendar|knowledge|mail|mcp_manager|projects|tickets))\./

const EXPECTED_CLOSURE: Record<string, string> = {
  "app_api_connector.adapter_versions": "direct",
  "app_api_connector.adapters": "direct",
  "app_calendar.accounts": "direct",
  "app_calendar.calendars": "direct",
  "app_calendar.events": "direct",
  "app_calendar.sync_log": "direct",
  "app_knowledge.collection_memberships": "direct",
  "app_knowledge.collections": "direct",
  "app_knowledge.content_cache_entries": "direct",
  "app_knowledge.documents": "direct",
  "app_knowledge.source_identities": "direct",
  "app_knowledge.source_links": "direct",
  "app_knowledge.source_policies": "direct",
  "app_knowledge.synced_sources": "direct",
  "app_knowledge.taggings": "direct",
  "app_knowledge.tags": "direct",
  "app_mail.accounts": "direct",
  "app_mail.conversations": "direct",
  "app_mail.drafts": "direct",
  "app_mail.messages": "direct",
  "app_mcp_manager.mcp_connection_access": "direct",
  "app_mcp_manager.mcp_connection_health":
    "via app_mcp_manager.mcp_connections (connection_id -> id)",
  "app_mcp_manager.mcp_connections": "direct",
  "app_mcp_manager.mcp_resource_subscription":
    "via app_mcp_manager.mcp_connections (connection_id -> id)",
  "app_mcp_manager.mcp_tool_policy": "via app_mcp_manager.mcp_connections (connection_id -> id)",
  "app_projects.labels": "direct",
  "app_projects.project_statuses": "direct",
  "app_projects.project_templates": "direct",
  "app_projects.projects": "direct",
  "app_projects.task_checklist_items": "direct",
  "app_projects.task_dependencies": "direct",
  "app_projects.task_labels": "direct",
  "app_projects.tasks": "direct",
  "app_tickets.api_keys": "direct",
  "app_tickets.categories": "direct",
  "app_tickets.inboxes": "direct",
  "app_tickets.messages": "direct",
  "app_tickets.reply_templates": "direct",
  "app_tickets.ticket_csat": "direct",
  "app_tickets.ticket_reads": "direct",
  "app_tickets.tickets": "direct",
  "kernel.agent_knowledge_pointers": "direct",
  "kernel.agent_local_claims": "direct",
  "kernel.agent_memory": "direct",
  "kernel.agent_migration_ledger": "direct",
  "kernel.agent_runs": "direct",
  "kernel.agent_skill_index": "direct",
  "kernel.agent_thread_checkpoints": "direct",
  "kernel.agent_turn_events": "direct",
  "kernel.agent_turns": "direct",
  "kernel.agents": "direct",
  "kernel.app_scope_grant_audit": "direct",
  "kernel.app_seeded_assets": "direct",
  "kernel.app_sequences": "direct",
  "kernel.approval_handle_counters": "direct",
  "kernel.approval_policies": "direct",
  "kernel.approval_requests": "direct",
  "kernel.approved_handler_executions": "direct",
  "kernel.apps": "direct",
  "kernel.apps_active_version": "direct",
  "kernel.apps_installed": "direct",
  "kernel.attention_events": "direct",
  "kernel.attention_subscriptions": "via kernel.users (user_id -> id)",
  "kernel.audit_log": "direct",
  "kernel.auto_approve_policies": "direct",
  "kernel.away_ranges": "direct",
  "kernel.browser_push_subscriptions": "direct",
  "kernel.config_applied_fields": "direct",
  "kernel.connected_accounts": "direct",
  "kernel.contact_addresses": "direct",
  "kernel.contact_group_members": "direct",
  "kernel.contact_segments": "direct",
  "kernel.contacts": "direct",
  "kernel.credit_balances": "direct",
  "kernel.credit_transactions": "direct",
  "kernel.demo_world_marks": "direct",
  "kernel.desktop_devices": "direct",
  "kernel.device_flow_requests": "direct",
  "kernel.disabled_app_skills": "direct",
  "kernel.document_template_rules": "direct",
  "kernel.document_templates": "direct",
  "kernel.durable_consumer_marks": "via kernel.pending_events (event_id -> id)",
  "kernel.effect_ledger": "direct",
  "kernel.file_upload_sessions": "direct",
  "kernel.files": "direct",
  "kernel.import_ledger": "direct",
  "kernel.import_runs": "direct",
  "kernel.import_transforms": "direct",
  "kernel.import_uploads": "direct",
  "kernel.invitations": "direct",
  "kernel.mailbox_client_jobs": "direct",
  "kernel.mailbox_migration_state": "direct",
  "kernel.mailbox_server_keys": "direct",
  "kernel.mcp_connections": "direct",
  "kernel.message_reactions": "direct",
  "kernel.messages": "direct",
  "kernel.node_attachments": "direct",
  "kernel.node_capabilities": "direct",
  "kernel.node_connections": "direct",
  "kernel.node_jobs": "direct",
  "kernel.node_level_confirmations": "direct",
  "kernel.node_permission_prompts": "direct",
  "kernel.node_profiles": "direct",
  "kernel.node_session_commands": "via kernel.node_sessions (session_id -> id)",
  "kernel.node_session_events": "via kernel.node_sessions (session_id -> id)",
  "kernel.node_sessions": "direct",
  "kernel.nodes": "direct",
  "kernel.notification_deliveries": "direct",
  "kernel.notification_device_credentials": "direct",
  "kernel.notification_receipts": "direct",
  "kernel.oauth_accounts": "direct",
  "kernel.oauth_providers": "direct",
  "kernel.org_app_access": "direct",
  "kernel.org_app_features": "direct",
  "kernel.org_billing_state": "direct",
  "kernel.org_exports": "direct",
  "kernel.organizations": "org",
  "kernel.password_resets": "direct",
  "kernel.pending_events": "direct",
  "kernel.product_attributes": "direct",
  "kernel.push_tokens": "direct",
  "kernel.reply_thread_followers": "direct",
  "kernel.resource_grants": "direct",
  "kernel.role_dimension_grants": "via kernel.roles (role_id -> id)",
  "kernel.role_scope_grants": "via kernel.roles (role_id -> id)",
  "kernel.roles": "direct",
  "kernel.routine_runs": "direct",
  "kernel.routine_state": "direct",
  "kernel.routines": "direct",
  "kernel.saved_views": "direct",
  "kernel.scope_disclosure_policy": "direct",
  "kernel.scope_requests": "direct",
  "kernel.search_document_clusters": "direct",
  "kernel.secret_requests": "direct",
  "kernel.sessions": "direct",
  "kernel.skills": "direct",
  "kernel.sub_agent_definitions": "direct",
  "kernel.thread_brief_marks": "direct",
  "kernel.thread_briefs": "direct",
  "kernel.thread_episodes": "direct",
  "kernel.thread_node_settings": "direct",
  "kernel.thread_participants": "direct",
  "kernel.thread_references": "direct",
  "kernel.threads": "direct",
  "kernel.timeline_entries": "direct",
  "kernel.tour_progress": "direct",
  "kernel.trusted_senders": "direct",
  "kernel.user_dimension_grants": "direct",
  "kernel.user_key_wraps": "direct",
  "kernel.user_mailbox_identities": "direct",
  "kernel.user_preferences": "via kernel.users (user_id -> id)",
  "kernel.user_roles": "direct",
  "kernel.user_scope_grants": "direct",
  "kernel.user_thread_state": "direct",
  "kernel.users": "direct",
}

const sql = postgres(process.env.DATABASE_URL_SUPERUSER as string, { max: 1, onnotice: () => {} })
afterAll(() => sql.end({ timeout: 5 }))

describe("org transfer closure", () => {
  it("classifies every kernel and bundled-app table, as pinned", async () => {
    const catalog = await readCatalog(sql as never)
    const closure = buildClosure(catalog)
    const got: Record<string, string> = {}
    for (const t of closure.tables) {
      if (PINNED_SCHEMAS.test(t.name)) got[t.name] = describeClosureTable(t)
    }
    expect(got).toEqual(EXPECTED_CLOSURE)
    expect(closure.unclassified.filter((n) => PINNED_SCHEMAS.test(n))).toEqual([])
    // Every classification names a table that exists (none left behind by a rename).
    for (const name of [...Object.keys(GLOBAL_TABLES), ...Object.keys(EXCLUDED_TABLES)]) {
      expect({ name, exists: catalog.has(name) }).toEqual({ name, exists: true })
    }
    // The tables which the purge's org_id list misses.
    for (const name of [
      "kernel.role_scope_grants",
      "kernel.role_dimension_grants",
      "kernel.user_preferences",
      "kernel.attention_subscriptions",
      "kernel.durable_consumer_marks",
      "kernel.node_session_commands",
      "kernel.node_session_events",
    ]) {
      expect(closure.byName.get(name)?.kind).toBe("via")
    }
    for (const name of [
      "kernel.control_plane_outbox",
      "kernel.cloud_request_outcomes",
      "kernel.demo_spend",
    ]) {
      expect(closure.byName.has(name)).toBe(false)
    }
  })

  it("classifies every key- or path-named text column of the closure as an object key or not", async () => {
    const closure = await loadClosure(sql as never)
    const found: string[] = []
    for (const t of closure.tables) {
      if (!PINNED_SCHEMAS.test(t.name)) continue
      for (const c of t.columns) {
        if (!/^(text|character varying|text\[\]|jsonb)/.test(c.type)) continue
        if (!/(^|_)(key|path|keys|paths)$/.test(c.name)) continue
        found.push(`${t.name}.${c.name}`)
      }
    }
    const classified = { ...OBJECT_KEY_COLUMNS, ...NOT_OBJECT_KEY_COLUMNS }
    expect(found.filter((n) => !(n in classified))).toEqual([])
    // No stale entry, and no column in both lists.
    expect(Object.keys(classified).filter((n) => !found.includes(n))).toEqual([])
    expect(Object.keys(OBJECT_KEY_COLUMNS).filter((n) => n in NOT_OBJECT_KEY_COLUMNS)).toEqual([])
  })

  it("every closure table has a primary key (a delta addresses rows by it)", async () => {
    const closure = await loadClosure(sql as never)
    expect(closure.tables.filter((t) => t.primaryKey.length === 0).map((t) => t.name)).toEqual([])
  })

  it("the import raises every kernel and app sequence, the handle sequences among them", async () => {
    const rows = await sql<
      { n: string }[]
    >`SELECT schemaname || '.' || sequencename AS n FROM pg_sequences
      WHERE schemaname = 'kernel' OR schemaname LIKE 'app\\_%'`
    const names = rows.map((r) => r.n)
    for (const seq of [
      "kernel.thread_handle_seq",
      "kernel.contact_handle_seq",
      "kernel.approval_request_handle_seq",
      "app_tickets.tickets_handle_seq",
      "kernel.pending_events_seq_seq",
    ]) {
      expect(names).toContain(seq)
    }
  })

  it("an unclassified kernel table refuses the export (fail closed)", async () => {
    const catalog = await readCatalog(sql as never)
    const stray: CatalogTable = {
      name: "kernel.zz_unclassified",
      schema: "kernel",
      table: "zz_unclassified",
      columns: [{ name: "id", type: "uuid", ordinal: 1, generated: false, identity: "" }],
      primaryKey: ["id"],
      uniques: [],
      complexUniques: [],
      foreignKeys: [],
    }
    catalog.set(stray.name, stray)
    const closure = buildClosure(catalog)
    expect(closure.unclassified).toContain("kernel.zz_unclassified")
    expect(() => assertTransferable(closure)).toThrow(/kernel\.zz_unclassified are not classified/)
  })
})
