// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every foreign key to kernel.users, and what a placeholder merge does with it.
//
// A merge moves what an import placeholder holds onto the real person and
// then deletes the placeholder. A foreign key the merge did not think about
// would do something silent on that delete: CASCADE drops the rows, SET NULL
// orphans them. So every FK to kernel.users must be listed here with a
// disposition, and nothing is left to the delete by accident:
//
// - `repoint`: the row belongs to the person's history or work (a reaction, a
//   file, a task they own): it moves to the real user. Where a unique index
//   covers the column, a row the real user already holds wins and the
//   placeholder's duplicate is dropped (the indexes are read from the catalog
//   at run time, see merge-placeholder.ts).
// - `drop`: the row is the placeholder's own delivery or preference, which
//   would be wrong on the real user (notifications addressed to it, its own
//   notification rules). Deleted, and counted.
// - `cascade`: the row is a credential or setting of the placeholder account
//   itself (sessions, login links, roles, keys): it must NEVER move to another
//   person, and dies with the placeholder by its own ON DELETE CASCADE.
//   Placeholders cannot sign in, so these are empty in practice.
// - `refuse`: the row would hand the real user something that needs its own
//   decision (an automation, an agent, a connected account, mailbox keys, a
//   scope request): the merge refuses while any exists, so a human looks. A
//   PENDING approval the placeholder is the resource owner of refuses too
//   (merge-placeholder.ts): deciding it would fall to the person.
//
// At run time an FK missing from this list refuses the merge (fail closed),
// and `merge-references.test.ts` reads every FK to kernel.users from the
// catalog and fails when one is not listed here.

export type ReferenceDisposition =
  | { kind: "repoint" }
  | { kind: "drop"; reason: string }
  | { kind: "cascade"; reason: string }
  | { kind: "refuse"; reason: string }

const repoint = { kind: "repoint" } as const
const credential = (what: string) =>
  ({ kind: "cascade", reason: `${what} of the placeholder account itself` }) as const
const refuse = (reason: string) => ({ kind: "refuse", reason }) as const

/** Keyed `<schema>.<table>.<column>` with the UNPREFIXED schema name. */
export const USER_FK_DISPOSITION: Record<string, ReferenceDisposition> = {
  // ── history and work: moves to the person ───────────────────────────────
  "kernel.message_reactions.user_id": repoint,
  "kernel.thread_participants.user_id": repoint,
  "kernel.reply_thread_followers.user_id": repoint,
  "kernel.files.uploaded_by": repoint,
  "kernel.contact_segments.created_by": repoint,
  "kernel.contact_group_members.added_by": repoint,
  // Who added and who verified a contact address: history. verified_by must
  // move before the placeholder goes (no ON DELETE action, 0253).
  "kernel.contact_addresses.created_by": repoint,
  "kernel.contact_addresses.verified_by": repoint,
  // Who made and who last changed a document template or a needed-template rule: history.
  "kernel.document_template_rules.created_by": repoint,
  "kernel.document_template_rules.updated_by": repoint,
  "kernel.document_templates.created_by": repoint,
  "kernel.document_templates.updated_by": repoint,
  // Who wrote an app store document, and whose dashboard it is (0275): a
  // personal dashboard moves to the person.
  "kernel.app_documents.created_by": repoint,
  "kernel.app_documents.updated_by": repoint,
  "kernel.dashboards.owner_user_id": repoint,
  "kernel.dashboards.created_by": repoint,
  "kernel.dashboards.updated_by": repoint,
  "kernel.dashboard_versions.saved_by": repoint,
  "kernel.dashboard_tables.owner_user_id": repoint,
  "kernel.dashboard_tables.created_by": repoint,
  "kernel.dashboard_tables.updated_by": repoint,
  "kernel.dashboard_table_changes.actor_id": repoint,
  // App builder (0276): authors of drafts and versions, and whose run logged a line.
  "kernel.app_drafts.created_by": repoint,
  "kernel.app_drafts.updated_by": repoint,
  "kernel.app_draft_versions.created_by": repoint,
  "kernel.app_logs.actor_user_id": repoint,
  // Who last set a product attribute: history.
  "kernel.product_attributes.updated_by": repoint,
  // Who marked a sender address or domain as trusted: history.
  "kernel.trusted_senders.created_by": repoint,
  // Who asked a node job (A17) and who allowed an agent onto a node: history.
  "kernel.node_jobs.requester_user_id": repoint,
  "kernel.node_attachments.agent_allowed_by": repoint,
  // A private contact is the person's: it moves to them (ON DELETE RESTRICT
  // would otherwise refuse the placeholder's delete).
  "kernel.contacts.owner_user_id": repoint,
  // A company's account manager: a label that routes approvals, the person
  // holds it now. (Its created_by is a soft column, not a foreign key: the
  // merge re-points it beside the other soft columns, merge-placeholder.ts.)
  "kernel.companies.owner_user_id": repoint,
  "kernel.invitations.invited_by": repoint,
  "kernel.credit_transactions.user_id": repoint,
  "kernel.agent_memory.user_id": repoint,
  "kernel.approval_requests.decided_by": repoint,
  "kernel.approval_requests.requested_by": repoint,
  "kernel.approval_requests.resource_owner_id": repoint,
  // Who an approval is routed to, who takes over for someone away, and who set
  // that or changed a feature: the real person now holds those.
  "kernel.approval_requests.route_person_id": repoint,
  // A person's own away record is a real absence: it moves to them too.
  "kernel.away_ranges.user_id": repoint,
  "kernel.away_ranges.set_by": repoint,
  "kernel.away_ranges.next_in_line_id": repoint,
  "kernel.user_preferences.next_in_line_id": repoint,
  "kernel.org_app_features.changed_by": repoint,
  "kernel.approved_handler_executions.actor_id": repoint,
  "kernel.saved_views.owner_user_id": repoint,
  "kernel.skills.author_user_id": repoint,
  "kernel.skills.created_by_user_id": repoint,
  "kernel.routines.created_by_user_id": repoint,
  "kernel.auto_approve_policies.created_by": repoint,
  "kernel.approval_policies.created_by": repoint,
  "kernel.scope_requests.decided_by": repoint,
  // Who saved an import transform, and who entered a requested secret: history.
  "kernel.import_transforms.created_by": repoint,
  "kernel.secret_requests.completed_by": repoint,
  "app_tickets.ticket_reads.user_id": repoint,
  "app_projects.projects.owner_id": repoint,
  "app_projects.tasks.assignee_id": repoint,
  "app_projects.tasks.created_by": repoint,
  "app_projects.project_templates.created_by": repoint,
  "app_projects.task_checklist_items.created_by": repoint,
  // A person's own time, days per week and cost rates, and who bills a project.
  "app_projects.task_time.user_id": repoint,
  "app_projects.person_capacity.user_id": repoint,
  "app_projects.cost_rates.user_id": repoint,
  "app_projects.project_time_plan.biller_id": repoint,
  "app_knowledge.documents.created_by": repoint,
  "app_knowledge.documents.owner_user_id": repoint,
  "app_knowledge.documents.updated_by": repoint,
  "app_knowledge.documents.verified_by": repoint,
  "app_knowledge.source_links.owner_user_id": repoint,
  "app_knowledge.source_links.verified_by": repoint,
  "app_knowledge.collections.owner_user_id": repoint,
  "app_knowledge.collection_memberships.created_by": repoint,
  "app_knowledge.taggings.created_by": repoint,
  "app_knowledge.synced_sources.created_by": repoint,
  // Grant HISTORY is kept, never deleted with the account: the rows move to the
  // person, and the merge's own `user.merge` audit record (placeholder id ->
  // person id) says they were recorded against the imported account. The
  // permissions themselves (user_roles, below) never move.
  "kernel.app_scope_grant_audit.target_user_id": repoint,

  // ── the placeholder's own deliveries and rules: dropped ──────────────────
  "kernel.attention_events.user_id": {
    kind: "drop",
    reason: "notifications addressed to the placeholder, which nobody read",
  },
  "kernel.app_attention_items.user_id": {
    kind: "drop",
    reason:
      "the apps' attention lists computed for the placeholder; the person's own are recomputed",
  },
  "kernel.attention_subscriptions.user_id": {
    kind: "drop",
    reason: "the placeholder's notification rules are not the person's",
  },
  "kernel.tour_progress.user_id": {
    kind: "drop",
    reason: "the placeholder's guided tour progress is not the person's",
  },
  "kernel.disabled_app_skills.user_id": {
    kind: "drop",
    reason: "the placeholder's per-user skill switches are not the person's",
  },

  // ── credentials and settings of the account: die with it ─────────────────
  "kernel.sessions.user_id": credential("sign-in sessions"),
  "kernel.oauth_accounts.user_id": credential("federated login links"),
  "kernel.password_resets.user_id": credential("password reset tokens"),
  "kernel.user_roles.user_id": credential("role memberships (never granted to another person)"),
  "kernel.user_preferences.user_id": credential("settings"),
  "kernel.dashboard_viewer_states.user_id": credential("dashboard time range choices"),
  "kernel.file_upload_sessions.created_by": credential("in-flight uploads"),
  "kernel.import_uploads.created_by": credential("in-flight import uploads"),
  "kernel.secret_requests.requested_by": credential("in-flight secret requests"),
  "kernel.push_tokens.user_id": credential("phone push addresses"),
  "kernel.desktop_devices.user_id": credential("desktop app installs"),
  "kernel.browser_push_subscriptions.user_id": credential("browser push subscriptions"),
  "kernel.notification_device_credentials.user_id": credential("notification receipt credentials"),
  "kernel.notification_deliveries.user_id": credential("notification delivery log"),
  "kernel.notification_receipts.user_id": credential("notification receipts"),
  "kernel.agent_local_claims.user_id": credential("desktop claims"),
  "kernel.nodes.owner_user_id": credential("node registrations"),
  "kernel.node_jobs.owner_user_id": credential("node jobs"),
  "kernel.node_profiles.node_owner_user_id": credential("node profiles"),
  "kernel.node_attachments.node_owner_user_id": credential("node attachments"),
  "kernel.thread_node_settings.owner_user_id": credential("node chat settings"),
  "kernel.node_permission_prompts.owner_user_id": credential("node permission prompts"),
  "kernel.node_sessions.owner_user_id": credential("node sessions"),
  "kernel.node_level_confirmations.owner_user_id": credential("level confirmations"),
  "kernel.node_capabilities.owner_user_id": credential("node capabilities"),
  "app_mcp_manager.mcp_oauth_state.initiator_user_id": credential("in-flight OAuth state"),

  // ── needs its own decision: refuse ───────────────────────────────────────
  "kernel.routines.owner_user_id": refuse("an automation that would start acting for the person"),
  // A routine edited by its owner is trusted as the owner's own work (0230);
  // moving the edit to the person could make it count as theirs.
  "kernel.routines.edited_by_user_id": refuse("a routine edit that decides its trust"),
  "kernel.agents.owner_user_id": refuse("a personal agent"),
  "kernel.connected_accounts.owner_id": refuse("a connected account"),
  "kernel.connected_accounts.created_by": refuse("a connected account"),
  "kernel.mcp_connections.user_id": refuse("an MCP connection (a credential)"),
  "app_mcp_manager.mcp_connections.created_by": refuse("an MCP server connection"),
  "app_mcp_manager.mcp_connections.owner_user_id": refuse("an MCP server connection"),
  "app_knowledge.synced_sources.owner_user_id": refuse("a synced source reading an account"),
  "kernel.scope_requests.requested_by": refuse("a pending permission request"),
  "kernel.scope_requests.target_user_id": refuse("a pending permission request"),
  "kernel.user_mailbox_identities.user_id": refuse("mailbox encryption keys"),
  "kernel.user_key_wraps.user_id": refuse("mailbox encryption keys"),
  "kernel.mailbox_migration_state.user_id": refuse("mailbox encryption state"),
  "kernel.mailbox_client_jobs.user_id": refuse("mailbox jobs"),
}
