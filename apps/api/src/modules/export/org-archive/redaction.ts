// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * What the whole-org export leaves out: an explicit deny list of columns (and
 * jsonb paths) written as `null`, and a reviewed keep list of columns whose
 * names look sensitive but are not.
 *
 * `redaction.guard.test.ts` runs SENSITIVE_COLUMN_NAME over the live catalog
 * of exported tables: every hit must be in one list or the other. At run time
 * a hit in neither list is redacted too (fail closed) and named in the
 * manifest, so a column added after this list was written never leaks.
 *
 * Keys are `<schema>.<table>.<column>` with the schema's logical name (no test
 * prefix). Encrypted columns are exported as stored and the export calls no
 * decrypt path.
 *
 * Server-key ciphertext (`encryptSecret`'s output, ENCRYPTION_KEY or the BYOK
 * key) is a credential the archive must not carry, wherever it sits: whole
 * columns are in REDACTED_COLUMNS, and inside JSON every string leaf of that
 * shape is written as `null` (redactCiphertext), in every json/jsonb column.
 * `cli/keys-rotate.ts` is the catalog of where such values live; the guard
 * test fails when it names a column this file does not leave out.
 */
import { JSON_COLUMNS, looksEncrypted } from "~/cli/keys-rotate"

export const SENSITIVE_COLUMN_NAME =
  /token|secret|hash|password|key|wrap|private|credential|recovery|cipher|encrypt|nonce|signature|otp|salt|seed|verif|pkce|p256dh|endpoint|device_code|user_code|^auth$|^state$/i

/** Columns written as `null`, with why. */
export const REDACTED_COLUMNS: Readonly<Record<string, string>> = {
  "kernel.connected_accounts.access_token_encrypted": "connection token",
  "kernel.connected_accounts.refresh_token_encrypted": "connection token",
  "kernel.connected_accounts.credentials_encrypted": "connection credentials",
  "kernel.oauth_providers.client_secret_encrypted": "sign-in provider client secret",
  "kernel.users.password_hash": "password hash",
  "kernel.users.recovery_codes": "two-step recovery codes",
  "kernel.users.totp_secret": "TOTP secret",
  "kernel.invitations.token_hash": "invitation token hash",
  "kernel.password_resets.token_hash": "password reset token hash",
  "kernel.sessions.refresh_token_hash": "session token hash",
  "kernel.mcp_connections.refresh_token_hash": "MCP client token hash",
  "kernel.nodes.credential_hash": "node credential hash",
  "kernel.notification_device_credentials.token_hash": "device credential hash",
  "kernel.suppression_links.token_hash": "opt-out link token hash",
  "kernel.push_tokens.token": "push notification token",
  "kernel.browser_push_subscriptions.auth": "web push subscription secret",
  "kernel.browser_push_subscriptions.p256dh": "web push subscription key",
  "kernel.browser_push_subscriptions.endpoint": "web push endpoint (sends to the device)",
  "kernel.device_flow_requests.device_code": "pending command line sign-in code",
  "kernel.device_flow_requests.user_code": "pending command line sign-in code",
  "kernel.user_key_wraps.verifier": "recovery phrase verifier (an offline guessing oracle)",
  "kernel.mailbox_client_jobs.result_ciphertext": "mailbox client job result",
  "kernel.mailbox_server_keys.wrapped_key": "mailbox key wrap (server key)",
  "kernel.user_key_wraps.wrapped_account_key": "mailbox key wrap (account key)",
  "kernel.user_mailbox_identities.wrapped_ecdh_private": "mailbox key wrap (private key)",
  "kernel.user_mailbox_identities.wrapped_sign_private": "mailbox key wrap (private key)",
  "kernel.mailbox_migration_state.verify_nonce": "one-time challenge",
  "kernel.mailbox_migration_state.client_ack_nonce": "one-time challenge",
  "app_mcp_manager.mcp_connections.secrets_encrypted": "MCP server secrets",
  "app_mcp_manager.mcp_oauth_state.pending_secrets_encrypted": "MCP server secrets",
  "app_mcp_manager.mcp_oauth_state.pkce_verifier": "OAuth PKCE verifier",
  "app_mcp_manager.mcp_oauth_state.state": "OAuth state value",
  "app_tickets.api_keys.key_hash": "API key hash",
  "app_tickets.ticket_csat.survey_token": "survey link token",
  "app_tickets.tickets.reply_token": "reply address token",
  // A dispatch grant is a signed token that sends an e-invoice with no further approval while it lasts.
  "app_invoicing.recurring_run_items.send_grant": "e-invoice send grant",
  "app_invoicing.einvoice_standing.grant_ref": "e-invoice send grant",
  // Payment card fragments mirrored from the payment provider: the provider keeps them, a
  // restored mirror reads them again at its next sync, and an archive never carries card data.
  "app_stripe.stripe_subscriptions.card_brand": "payment card detail",
  "app_stripe.stripe_subscriptions.card_last4": "payment card detail",
  "app_stripe.stripe_subscriptions.card_exp": "payment card detail",
  "app_stripe.stripe_payments.card_brand": "payment card detail",
  "app_stripe.stripe_payments.card_last4": "payment card detail",
  "app_stripe.stripe_payments.card_exp": "payment card detail",
  // A row's frozen cost is a person's rate times their minutes; a project's cost is the money
  // figure finance reads (withheld.ts keeps the dated sheet's rows, not the rate behind them).
  "app_projects.task_time.cost_minor": "a person's cost on one entry",
}

/** jsonb paths written as `null` (`*` matches any key). */
export const REDACTED_JSON_PATHS: ReadonlyArray<{ column: string; path: string[]; why: string }> = [
  {
    column: "kernel.organizations.settings",
    path: ["providerKeys"],
    why: "AI provider keys",
  },
  {
    column: "kernel.organizations.settings",
    path: ["integrations", "*", "oauthClient"],
    why: "OAuth client secret",
  },
]

const ENVELOPE =
  "per-item envelope value, opens nothing without the person's own private key; exported with the ciphertext it belongs to"
const SEALED = "sealed content, exported as stored (ciphertext) and counted in manifest.sealed"
const NOT_SECRET_KEY = "a name or lookup key, not a secret"
const USAGE = "token usage counts or limits, not a credential"
const CONTENT_HASH = "content hash or dedup key, not a credential"
const STATUS = "a status label, not an OAuth state value"

/** Reviewed: sensitive-looking names that are kept, with why. */
export const KEPT_COLUMNS: Readonly<Record<string, string>> = {
  "kernel.suppression_links.email_hash":
    "fingerprint of an address that opted out, not a credential (the token hash is redacted)",
  "kernel.suppressions.email_hash":
    "fingerprint of an address that opted out: the org keeps honouring it after a restore",
  "app_knowledge.documents.verified_at": "a timestamp",
  "app_knowledge.documents.verified_by": "who checked the document, not a verifier",
  "app_knowledge.source_links.verified_at": "a timestamp",
  "app_knowledge.source_links.verified_by": "who checked the link, not a verifier",
  "kernel.config_applied_fields.value_hash":
    "drift check over config values that are never a secret",
  "kernel.contact_addresses.verified_at": "a timestamp",
  "kernel.contact_addresses.verified_by": "who checked the address, not a verifier",
  "app_boxtal.short_code_sync.state": STATUS,
  "kernel.agent_turns.state": STATUS,
  "app_projects.reconciliations.state": STATUS,
  "app_projects.billing_claims.state": STATUS,
  "app_projects.billing_claims.period_key": "a billing period (all or a month), not a key",
  "kernel.demo_world_marks.state": STATUS,
  "kernel.device_flow_requests.state": STATUS,
  "kernel.effect_ledger.state": STATUS,
  "kernel.mailbox_migration_state.client_verified_at": "a timestamp",
  "kernel.oauth_providers.authorization_endpoint": "a public URL",
  "kernel.oauth_providers.userinfo_endpoint": "a public URL",
  "app_boxtal.app_config.key": NOT_SECRET_KEY,
  "app_pennylane.app_config.key": NOT_SECRET_KEY,
  "app_stripe.install_metadata.state": STATUS,
  "app_projects.projects.key": NOT_SECRET_KEY,
  "kernel.product_attributes.key": NOT_SECRET_KEY,
  "app_test_bridge_a.audit.key": NOT_SECRET_KEY,
  "app_boxtal.prep_order_state.order_key": NOT_SECRET_KEY,
  "app_boxtal.prep_quote.input_hash": CONTENT_HASH,
  "app_calendar.calendars.sync_token": "provider sync cursor, grants no access",
  "app_invoicing.counterparty_identities.verified_by": "who approved the identity, not a verifier",
  "app_invoicing.einvoice_book_batches.state": STATUS,
  "app_invoicing.einvoice_send_batches.state": STATUS,
  "app_invoicing.einvoice_transmissions.idempotency_key": CONTENT_HASH,
  "app_invoicing.einvoice_transmissions.state": STATUS,
  "app_invoicing.recurring_run_items.approved_hash": CONTENT_HASH,
  "app_invoicing.recurring_run_items.period_key":
    "the billing period a row is for, not a credential",
  "app_invoicing.recurring_run_items.state": STATUS,
  "app_mail.accounts.encryption_state": "mailbox encryption status label",
  "app_mail.accounts.encryption_conversion":
    "progress of a mailbox encryption change, holds no key",
  "app_mail.conversations.content_key_epk": ENVELOPE,
  "app_mail.conversations.content_key_wrapped": ENVELOPE,
  "app_mail.conversations.enc_key_id": ENVELOPE,
  "app_mail.conversations.snippet_ciphertext": SEALED,
  "app_mail.conversations.subject_ciphertext": SEALED,
  "app_mail.drafts.body_ciphertext": SEALED,
  "app_mail.drafts.content_key_epk": ENVELOPE,
  "app_mail.drafts.content_key_wrapped": ENVELOPE,
  "app_mail.drafts.enc_key_id": ENVELOPE,
  "app_mail.drafts.html_body_ciphertext": SEALED,
  "app_mail.drafts.subject_ciphertext": SEALED,
  "app_mail.messages.content_key_epk": ENVELOPE,
  "app_mail.messages.content_key_wrapped": ENVELOPE,
  "app_mail.messages.enc_key_id": ENVELOPE,
  "app_mail.messages.html_body_ciphertext": SEALED,
  "app_mail.messages.raw_headers_ciphertext": SEALED,
  "app_mail.messages.snippet_ciphertext": SEALED,
  "app_mail.messages.subject_ciphertext": SEALED,
  "app_mail.messages.text_body_ciphertext": SEALED,
  "app_monitoring.incidents.dedup_key": CONTENT_HASH,
  "app_tickets.api_keys.key_prefix": "first characters shown in the UI to recognise a key",
  "app_tickets.inboxes.signature_html": "email signature text",
  "app_tickets.inboxes.signature_text": "email signature text",
  "app_tickets.tickets.summary_token_usage": USAGE,
  "kernel.agent_local_claims.holder_key": NOT_SECRET_KEY,
  "kernel.agent_runs.usage_completion_tokens": USAGE,
  "kernel.agent_runs.usage_prompt_tokens": USAGE,
  "kernel.agent_thread_checkpoints.token_estimate": USAGE,
  "kernel.app_seeded_assets.seeded_at": "a timestamp",
  "kernel.app_sequences.key": NOT_SECRET_KEY,
  "kernel.apps.schema_hash": CONTENT_HASH,
  "kernel.apps_installed.signature_bundle":
    "an org custom app's public release signature, proves the package, holds no secret",
  "kernel.app_code_modules.source_key": NOT_SECRET_KEY,
  "kernel.attention_events.source_key": NOT_SECRET_KEY,
  "kernel.connected_accounts.token_expires_at": "a timestamp",
  "kernel.contacts.audience_key": NOT_SECRET_KEY,
  "kernel.credit_transactions.input_tokens": USAGE,
  "kernel.credit_transactions.output_tokens": USAGE,
  "kernel.effect_ledger.key": NOT_SECRET_KEY,
  "kernel.webhook_inbox.endpoint_name": "an app webhook endpoint's name, not a URL",
  "kernel.webhook_inbox.delivery_hash": CONTENT_HASH,
  "kernel.webhook_inbox.claim_token": "a replay claim's id, grants no access",
  "kernel.files.analysis_context_hash": CONTENT_HASH,
  "kernel.files.content_key_epk": ENVELOPE,
  "kernel.files.content_key_wrapped": ENVELOPE,
  "kernel.files.enc_key_id": ENVELOPE,
  "kernel.files.nonce_prefix": ENVELOPE,
  "kernel.files.storage_key": "object storage path of the file (the file is in the archive)",
  "kernel.files.thumbnail_key": "object storage path of the thumbnail",
  "kernel.import_ledger.record_key": NOT_SECRET_KEY,
  "kernel.import_uploads.storage_key": "object storage path",
  "kernel.org_exports.object_key": "object storage path of an earlier export archive",
  "kernel.mailbox_migration_state.client_ack_key_id": NOT_SECRET_KEY,
  "kernel.mailbox_migration_state.client_ack_signature":
    "a public signature, proves an acknowledgement",
  "kernel.mailbox_migration_state.verify_nonce_issued_at": "a timestamp",
  "kernel.mailbox_server_keys.key_version": NOT_SECRET_KEY,
  "kernel.node_attachments.max_tokens_per_day": USAGE,
  "kernel.node_jobs.hard_token_limit": USAGE,
  "kernel.node_jobs.token_budget": USAGE,
  "kernel.node_sessions.last_batch_hash": CONTENT_HASH,
  "kernel.node_sessions.tokens_cache_read": USAGE,
  "kernel.node_sessions.tokens_cache_write_1h": USAGE,
  "kernel.node_sessions.tokens_cache_write_5m": USAGE,
  "kernel.node_sessions.tokens_in": USAGE,
  "kernel.node_sessions.tokens_out": USAGE,
  "kernel.nodes.credential_issued_at": "a timestamp",
  "kernel.oauth_providers.token_endpoint": "a public URL",
  "kernel.routine_state.content_hash": CONTENT_HASH,
  "kernel.routine_state.key": NOT_SECRET_KEY,
  "kernel.routines.hard_token_limit": USAGE,
  "kernel.routines.template_key": NOT_SECRET_KEY,
  "kernel.routines.token_budget": USAGE,
  "kernel.saved_views.manifest_key": NOT_SECRET_KEY,
  "kernel.secret_requests.target_key": "names where a secret goes, holds no secret",
  "kernel.sessions.rotated_ua_hash": "hash of a browser user agent",
  "kernel.thread_briefs.key": NOT_SECRET_KEY,
  "kernel.user_dimension_grants.dimension_key": NOT_SECRET_KEY,
  "kernel.role_dimension_grants.dimension_key": NOT_SECRET_KEY,
  "kernel.user_key_wraps.credential_id": "a passkey's public credential id",
  "kernel.user_key_wraps.wrap_type": "a label",
  "kernel.user_mailbox_identities.ecdh_public_key": "a public key",
  "kernel.user_mailbox_identities.sign_public_key": "a public key",
  "kernel.user_mailbox_identities.ecdh_wrap_iv": ENVELOPE,
  "kernel.user_mailbox_identities.sign_wrap_iv": ENVELOPE,
  "kernel.user_mailbox_identities.key_id": NOT_SECRET_KEY,
  "kernel.user_mailbox_identities.keyring_attestation": "a public attestation",
  "kernel.users.avatar_key": "object storage path of the avatar",
  "kernel.users.totp_enabled": "whether two-step verification is on",
  "kernel.users.totp_last_used_at": "a timestamp",
}

/** Kept columns that hold sealed content: a non-null value counts in manifest.sealed. */
export function isSealedColumn(key: string): boolean {
  return KEPT_COLUMNS[key] === SEALED
}

export type ColumnDecision = { action: "keep" } | { action: "redact"; why: string }

/** Keep or redact one column (`<schema>.<table>.<column>`, logical schema). */
export function decideColumn(key: string): ColumnDecision {
  const denied = REDACTED_COLUMNS[key]
  if (denied) return { action: "redact", why: denied }
  const column = key.slice(key.lastIndexOf(".") + 1)
  if (!SENSITIVE_COLUMN_NAME.test(column) || KEPT_COLUMNS[key]) return { action: "keep" }
  return {
    action: "redact",
    why: "not reviewed yet (a sensitive-looking name), redacted by default",
  }
}

/** The JSON columns whose ciphertext leaves are written as null (all of them). */
export function scrubsCiphertext(columnType: string): boolean {
  return columnType === "jsonb" || columnType === "json"
}

/**
 * The manifest's account of the ciphertext scrub: each JSON column keys-rotate
 * knows, and every other JSON column.
 */
export const CIPHERTEXT_JSON_PATHS: ReadonlyArray<{ column: string; path: string; why: string }> = [
  ...JSON_COLUMNS.map((c) => ({
    column: `${c.schema}.${c.table}.${c.column}`,
    path: "*",
    why: "server-key ciphertext (a stored secret), wherever it sits in the document",
  })),
  {
    column: "*",
    path: "*",
    why: "server-key ciphertext in any other JSON column",
  },
]

/** Quick test before parsing a row: a JSON string of encryptSecret's shape. */
const CIPHERTEXT_IN_JSON = /"[A-Za-z0-9+/]{16}\.[A-Za-z0-9+/]{22}==\.[A-Za-z0-9+/]*={0,2}"/

export function mayHoldCiphertext(jsonText: string): boolean {
  return CIPHERTEXT_IN_JSON.test(jsonText)
}

/** Null every string leaf of `value` that is server-key ciphertext. */
export function redactCiphertext(value: unknown): { value: unknown; count: number } {
  let count = 0
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      if (!looksEncrypted(node)) return node
      count++
      return null
    }
    if (Array.isArray(node)) return node.map(walk)
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(node)) out[k] = walk(v)
      return out
    }
    return node
  }
  const out = walk(value)
  return { value: out, count }
}

/** Null every redacted jsonb path of `column` in `value` (a parsed jsonb). */
export function redactJsonPaths(column: string, value: unknown): unknown {
  const rules = REDACTED_JSON_PATHS.filter((r) => r.column === column)
  if (rules.length === 0 || value === null || typeof value !== "object") return value
  const copy = structuredClone(value) as Record<string, unknown>
  for (const rule of rules) nullPath(copy, rule.path)
  return copy
}

function nullPath(node: unknown, path: string[]): void {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return
  const obj = node as Record<string, unknown>
  const [head, ...rest] = path
  if (head === undefined) return
  const keys = head === "*" ? Object.keys(obj) : [head]
  for (const k of keys) {
    if (!(k in obj)) continue
    if (rest.length === 0) obj[k] = null
    else nullPath(obj[k], rest)
  }
}
