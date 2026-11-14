// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Which tables an org transfer leaves out, and why (closure.ts builds the rest
// from the catalog). Pinned by closure.test.ts: every kernel and app table is
// either in the computed closure (and listed in its expected form there) or
// named here. A new table fails that test until it is classified.

/** Instance state: no row of it belongs to one org. */
export const GLOBAL_TABLES: Record<string, string> = {
  "kernel.instance_settings": "deployment-wide decisions, one row per instance",
  "kernel.system_config": "instance configuration",
  "kernel.model_pricing": "the instance's model price table",
  "kernel.shareable_resource_types": "a registry of resource kinds, the same on every instance",
  "kernel.mcp_oauth_clients":
    "OAuth clients registered with this instance's MCP server (not an org's)",
  "kernel.restore_drill_markers": "restore drill markers of this instance",
  "kernel.org_deletions":
    "this instance's deletion ledger (names a deleted org, which no longer exists here)",
  "kernel.legal_archives": "this instance's legal archive index of deleted orgs",
  "kernel.demo_leads": "demo signups; a demo org is never moved (the import refuses one)",
  "kernel.connection_teardowns":
    "removed connections' pending provider work; it finishes on the server that removed them, under that server's key",
  "kernel.control_plane_outbox":
    "messages to the control plane; the org's are drained before the freeze, never carried",
  "kernel.cloud_request_outcomes":
    "idempotency of in-flight control-plane requests; none is in flight after the drain, and its seal context is the instance's",
  "kernel.demo_spend": "demo visitors' model spend; a demo org is never moved",
  "kernel.app_activation_events": "the instance's record of catalog app version switches",
  "kernel.app_adoptions":
    "the instance's record of the data steps it ran when an in-tree app moved to the catalog",
}

/**
 * Tables the catalog would put in the closure but that must not move: each
 * entry says why, and what the target does instead.
 */
export const EXCLUDED_TABLES: Record<string, string> = {
  "kernel.org_transfer_ledger":
    "each instance's own record of the moves it took part in (the reverse-move proof reads it)",
  "app_mcp_manager.mcp_oauth_state":
    "an MCP OAuth flow in progress on the source; its callback names the source, so the person starts it again",
}

/**
 * Closure columns that hold an object-store key the instance reads or serves.
 * The import refuses a row whose value here is not under `orgs/<org>/`: a
 * forged bundle could otherwise make the org serve another org's object.
 * The check matches the column name in every table.
 */
export const OBJECT_KEY_COLUMNS: Record<string, string> = {
  "kernel.files.storage_key": "the file's bytes",
  "kernel.files.thumbnail_key": "the file's thumbnail",
  "kernel.import_uploads.storage_key": "an uploaded import file",
  "kernel.org_exports.object_key": "the org's export archive, served for download",
}

/**
 * Closure columns named like a key or a path that are not object-store keys,
 * each with the reason. closure.test.ts enumerates every text column named
 * `*_key`, `*_path`, `key` or `path` in the closure and fails on one that is in
 * neither list.
 */
export const NOT_OBJECT_KEY_COLUMNS: Record<string, string> = {
  "app_knowledge.documents.external_path": "a path in the connected source",
  "app_projects.billing_claims.period_key": "the billing period a claim is for",
  "app_projects.projects.key": "the project's short code",
  "kernel.agent_local_claims.holder_key": "a lease holder id",
  "kernel.agent_memory.path": "a memory note's name",
  "kernel.app_sequences.key": "a sequence name",
  "kernel.app_code_modules.source_key": "a hash of the code a Worker module was built from",
  "kernel.attention_events.source_key": "an event's dedupe key",
  "kernel.config_applied_fields.path": "a config field path",
  "kernel.contacts.audience_key": "an audience id",
  "kernel.effect_ledger.key": "an idempotency key",
  "kernel.import_ledger.record_key": "a source record id",
  "kernel.mailbox_server_keys.wrapped_key": "key material, re-keyed with its family",
  "kernel.node_sessions.folder_path": "a folder on the person's machine",
  "kernel.node_sessions.worktree_path": "a folder on the person's machine",
  "kernel.product_attributes.key": "an attribute name",
  "kernel.role_dimension_grants.dimension_key": "a dimension name",
  "kernel.routine_state.key": "a state entry name",
  "kernel.routines.template_key": "a routine template name",
  "kernel.saved_views.manifest_key": "a view name in an app manifest",
  "kernel.secret_requests.target_key": "the setting a secret is for",
  "kernel.thread_briefs.key": "a brief's name",
  "kernel.user_dimension_grants.dimension_key": "a dimension name",
  "kernel.users.avatar_key":
    "a random id: the object key is built from it under the row's own org (`orgs/<org_id>/avatars/`)",
}
