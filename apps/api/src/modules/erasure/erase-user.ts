// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * GDPR user-erasure cascade (Phase 13, G2–G6). The CLI (`liaison erase-user`)
 * delegates here.
 *
 * Single privileged transaction (`withSystemDb`): look up the user, apply each
 * app's declared per-field strategy (`delete` rows / `anonymize` columns),
 * tombstone `kernel.users` (NOT a hard delete — preserves audit FK integrity),
 * and write EXACTLY ONE `user.erased` system audit entry. Any failure rolls
 * the whole transaction back with no audit and no partial mutation.
 */
import crypto from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import type { PrivilegedDb, RlsClient } from "~/db"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { deleteObject } from "~/infra/storage/object-storage"
import { rootLogger } from "~/lib/logger"
import {
  appBridgeManifest,
  type BridgeManifest,
  listInstalledAppNames,
} from "~/modules/apps/app-registries"
import {
  runConnectionTeardown,
  type StageableConnection,
  stageConnectionTeardown,
} from "~/modules/apps/connections/revoke"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { writeAuditLog } from "~/modules/audit/service"
import { invalidateAuthCache } from "~/modules/auth/auth-state"
import { revokeSessions } from "~/modules/auth/session-revocation"
import { releaseErasedUserContacts } from "~/modules/contacts/erasure"
import { erasedUserEmail } from "~/modules/erasure/erased-user"
import { enqueueIndexerDelete } from "~/modules/search/indexer"
import { collectSearchableRegistrations } from "~/modules/search/searchable-entities"
import { avatarStorageKey } from "~/modules/users/avatar-service"

/** Schema-prefixed kernel schema fragment for use in raw SQL. */
const K = drizzleSql.raw(schemaRef("kernel"))

const log = rootLogger.child({ module: "erase-user" })

export interface EraseUserResult {
  exitCode: number
  message?: string
}

export interface EraseUserOptions {
  /** Test hook: inject a stub app declaring a userRef on a missing column. */
  injectMissingColumnApp?: boolean
  /**
   * Test hook: inject a synthetic unaccounted kernel user-column into the
   * completeness sweep's discovered set, simulating a future kernel table that
   * carries a user-referencing column but was never added to
   * `KERNEL_USER_COLUMN_DISPOSITION`. The sweep must THROW (refuse to erase)
   * for it — converting silent survival into a loud, gated failure.
   */
  injectUnaccountedKernelColumn?: { table: string; column: string }
  /**
   * Test hook: treat these `"<table>.<column>"` keys as absent from
   * `KERNEL_USER_COLUMN_DISPOSITION` for this run, proving the sweep really
   * discovers each column (a column it cannot see would erase silently).
   */
  omitKernelDispositions?: readonly string[]
  /**
   * Work the caller needs committed or rolled back WITH the erasure, run in the
   * erasure's transaction after the cascade and before the completeness sweep
   * and the audit row. Self-service deletion uses it to cancel the approvals
   * the user leaves behind, so a failed erasure also leaves them pending.
   */
  inTransaction?: (tx: PrivilegedDb, ctx: { orgId: string }) => Promise<void>
}

interface UserRefField {
  app: string
  schema: string
  table: string
  column: string
  strategy: "delete" | "anonymize"
}

/** Manifest fields are camelCase; the generated DB columns are snake_case. */
function snake(s: string): string {
  return s.replace(/([A-Z])/g, "_$1").toLowerCase()
}

function appSchemaName(appName: string): string {
  return schemaRef(`app_${appName.replace(/-/g, "_")}`)
}

/**
 * Per-org deterministic "deleted user" sentinel row. NOT NULL `anonymize`
 * columns carry an FK to a retained `kernel.users` row, so the only way to
 * remove the erased user's id from the app schema while keeping the FK valid
 * is to re-point those columns at a dedicated sentinel user. The sentinel id
 * is derived deterministically from the org id (UUIDv5-style namespacing via
 * a fixed namespace) so it is idempotent across runs and stable per org.
 */
const SENTINEL_NAMESPACE = "a7c0e4d2-0000-4000-8000-000000000001"

function sentinelUserId(orgId: string): string {
  const h = crypto.createHash("sha1").update(`${SENTINEL_NAMESPACE}:${orgId}`).digest("hex")
  // Format as a RFC-4122 v5-shaped UUID (deterministic, valid, collision-safe
  // against random user ids).
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `5${h.slice(13, 16)}`,
    ((Number.parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20),
    h.slice(20, 32),
  ].join("-")
}

/**
 * Ensure the per-org sentinel "deleted user" exists. Idempotent: re-running
 * erase-user (or erasing multiple users in the same org) reuses the same row.
 */
async function ensureSentinelUser(tx: PrivilegedDb, orgId: string): Promise<string> {
  const id = sentinelUserId(orgId)
  await tx.execute(
    drizzleSql`
      INSERT INTO ${K}.users (id, org_id, email, name, status)
      VALUES (
        ${id}, ${orgId},
        ${`deleted-user-sentinel-${id}`},
        'Deleted user',
        'deactivated'
      )
      ON CONFLICT (id) DO NOTHING
    `,
  )
  return id
}

/** Extract declared user-reference fields from one app's manifest schema. */
function userRefFieldsFromManifest(appName: string, manifest: BridgeManifest): UserRefField[] {
  const out: UserRefField[] = []
  const schema = manifest.schema ?? {}
  for (const [entity, def] of Object.entries(schema)) {
    const fields = def?.fields ?? {}
    for (const [fieldName, fieldDef] of Object.entries(fields)) {
      if (
        fieldDef &&
        typeof fieldDef === "object" &&
        (fieldDef as { userRef?: unknown }).userRef === true
      ) {
        const onErase = (fieldDef as { onErase?: string }).onErase
        if (onErase !== "delete" && onErase !== "anonymize") continue
        out.push({
          app: appName,
          schema: appSchemaName(appName),
          table: entity,
          column: snake(fieldName),
          strategy: onErase,
        })
      }
    }
  }
  return out
}

/**
 * Collect every declared user-reference field across the apps installed for
 * `orgId`, driven by the LIVE registry (not a hardcoded manifest list) so every
 * bundled or third-party app the org has installed is covered — matching the
 * dynamic enumeration the export path uses. The manifest schema (with
 * `userRef`/`onErase`) is resolved from the runtime's per-app bridge snapshot.
 *
 * Throws if an installed app's manifest snapshot is unreachable: the cascade
 * cannot prove that app's PII columns are handled, so it must fail rather than
 * silently skip (defense-in-depth, paired with the `information_schema` sweep).
 */
function collectUserRefFields(orgId: string): UserRefField[] {
  const out: UserRefField[] = []
  for (const appName of listInstalledAppNames(orgId)) {
    if (appName === "kernel") continue
    const manifest = appBridgeManifest(orgId, appName)
    if (!manifest) {
      throw new Error(
        `erase-user: installed app "${appName}" has no resolvable manifest schema — cannot prove its user-reference columns are erased`,
      )
    }
    out.push(...userRefFieldsFromManifest(appName, manifest))
  }
  return out
}

/**
 * Defense-in-depth: derive the set of `app_*` schema names the org's installed
 * apps account for (from the live registry), then enumerate the `app_*` schemas
 * the org's tables actually live in via `information_schema`. The org's PII is
 * confined to schemas owned by apps the registry knows about. If a schema that
 * holds the org's rows is NOT covered by any installed app — including the
 * degenerate case where the registry resolved zero apps while a live schema
 * holds org rows — the cascade has no manifest to consult and would silently
 * skip that schema's PII, so it fails instead of exiting 0 claiming success.
 *
 * Scoped to schemas that actually contain rows for THIS org (an `org_id`
 * predicate), so legacy/other-tenant schemas left on a shared instance don't
 * produce false positives.
 */
async function assertOrgPiiSchemasAccounted(tx: PrivilegedDb, orgId: string): Promise<void> {
  const accounted = new Set<string>()
  for (const appName of listInstalledAppNames(orgId)) {
    if (appName === "kernel") continue
    accounted.add(appSchemaName(appName))
  }
  // Every base table in any app_* schema that carries an org_id column. We then
  // probe whether THIS org has rows there; only schemas with the org's data
  // matter for its erasure.
  const candidates = extractRows<{ table_schema: string; table_name: string }>(
    await tx.execute(drizzleSql`
      SELECT table_schema, table_name
      FROM information_schema.columns
      WHERE table_schema LIKE ${`${schemaRef("app_")}%`}
        AND column_name = 'org_id'
    `),
  )
  const unaccounted = new Set<string>()
  for (const c of candidates) {
    if (accounted.has(c.table_schema) || unaccounted.has(c.table_schema)) continue
    const tableRef = drizzleSql.raw(`"${c.table_schema}"."${c.table_name}"`)
    const hasOrgRows =
      extractRows<{ n: number }>(
        await tx.execute(
          drizzleSql`SELECT count(*)::int AS n FROM (SELECT 1 FROM ${tableRef} WHERE org_id = ${orgId} LIMIT 1) t`,
        ),
      )[0].n > 0
    if (hasOrgRows) unaccounted.add(c.table_schema)
  }
  if (unaccounted.size > 0) {
    throw new Error(
      `erase-user: org data found in app schema(s) with no installed-app manifest: ${[...unaccounted].join(", ")} — refusing to erase with unaccounted PII`,
    )
  }
}

/**
 * Disposition for one `kernel.<table>.<column>` that holds a user reference.
 *
 *   handled  → the cascade below removes the erased user's id from this column
 *              (a DELETE of the row, an anonymize to NULL / sentinel, or a real
 *              `ON DELETE CASCADE`/`SET NULL` FK that fires because the row that
 *              owns the FK is itself deleted — NOT one that points at the
 *              tombstoned `kernel.users` row, which never fires).
 *   retain   → the row legally/operationally must survive AND keep the user id
 *              (security, financial, or legal record). The `reason` is the
 *              documented justification surfaced in code review and audits.
 */
type KernelColumnDisposition =
  | { kind: "handled"; reason: string }
  | { kind: "retain"; reason: string }

/**
 * COMPLETENESS ALLOWLIST for kernel-schema PII (mirrors the app-schema sweep).
 *
 * Every `kernel.<table>.<user-column>` that exists today is accounted for here.
 * The sweep (`assertKernelUserColumnsAccounted`) enumerates the live
 * catalog for user-referencing columns on kernel base tables (recognised names
 * and every foreign key to `kernel.users`) and REFUSES TO ERASE if it finds one
 * carrying the erased user's data that is absent from this map; the static
 * completeness test in erase-user.test.ts fails on any such column even when
 * no row holds a user yet. A new kernel table with a user column therefore
 * fails loudly until a human decides its disposition — closing the silent-
 * survival gap (erasure-001) the hardcoded short list left open.
 *
 * Keyed `"<table>.<column>"`. `tombstone`/`delete`/`anonymize`/`cascade` notes
 * describe HOW the cascade body handles each `handled` entry.
 */
export const KERNEL_USER_COLUMN_DISPOSITION: Record<string, KernelColumnDisposition> = {
  // ── users themselves ──────────────────────────────────────────────────────
  // The erased user's own row is tombstoned (UPDATE, never hard-deleted) so
  // audit/FK integrity holds; `invited_by` on OTHER users' rows is an
  // inviter-attribution link that we null out so no surviving row points at the
  // erased user.
  "users.invited_by": { kind: "handled", reason: "anonymize → NULL (inviter attribution)" },
  // ── credentials / sessions (deleted: could re-authenticate the erased user) ─
  "sessions.user_id": { kind: "handled", reason: "delete (revoke refresh-token sessions)" },
  "oauth_accounts.user_id": { kind: "handled", reason: "delete (federated identity link)" },
  "push_tokens.user_id": {
    kind: "handled",
    reason: "delete (the address of the user's phones: nothing may reach them after erasure)",
  },
  "connected_accounts.owner_id": {
    kind: "handled",
    reason: "delete (user-owned connected accounts)",
  },
  "connected_accounts.created_by": {
    kind: "handled",
    reason: "anonymize → sentinel (NOT NULL creator attribution on retained org-level accounts)",
  },
  "mcp_connections.user_id": {
    kind: "handled",
    reason: "delete (per-user MCP credential that can mint tokens)",
  },
  "device_flow_requests.user_id": {
    kind: "handled",
    reason: "delete (in-flight device-auth grant tied to the user)",
  },
  "password_resets.user_id": {
    kind: "handled",
    reason: "delete (single-use reset tokens for the user)",
  },
  // ── notification devices (0121, 0122): the addresses of the person's apps
  //    and browsers, and the credentials those devices report receipts with ──
  "notification_device_credentials.user_id": {
    kind: "handled",
    reason: "delete (hashed receipt credentials bound to the user's devices)",
  },
  "desktop_devices.user_id": {
    kind: "handled",
    reason: "delete (the user's desktop app installs: nothing may reach them after erasure)",
  },
  "browser_push_subscriptions.user_id": {
    kind: "handled",
    reason: "delete (the user's Web Push endpoints and keys: a device address)",
  },
  // ── clearly personal, user-owned rows (deleted) ────────────────────────────
  "agent_memory.user_id": {
    kind: "handled",
    reason: "delete (behavioral profile — personal data)",
  },
  "user_preferences.user_id": { kind: "handled", reason: "delete (per-user settings — personal)" },
  "tour_progress.user_id": {
    kind: "handled",
    reason: "delete (the person's guided tour progress — personal)",
  },
  "routines.owner_user_id": { kind: "handled", reason: "delete (personal automations + prompts)" },
  // ── the person's local node (0127, 0130, 0140): their computer, its jobs,
  //    sessions with prompts and folder paths, level confirmations: personal ──
  "nodes.owner_user_id": { kind: "handled", reason: "delete (the person's own computers)" },
  "node_jobs.owner_user_id": { kind: "handled", reason: "delete (jobs run on the person's node)" },
  "node_jobs.requester_user_id": {
    kind: "handled",
    reason: "anonymize → NULL (who asked another person's node; column SET NULL-able)",
  },
  "node_profiles.node_owner_user_id": {
    kind: "handled",
    reason: "delete (the person's per-agent node levels)",
  },
  "node_attachments.node_owner_user_id": {
    kind: "handled",
    reason: "delete (agents attached to the person's node)",
  },
  "thread_node_settings.owner_user_id": {
    kind: "handled",
    reason: "delete (the person's My node chat settings)",
  },
  "node_permission_prompts.owner_user_id": {
    kind: "handled",
    reason: "delete (permission prompts of the person's node jobs)",
  },
  "node_sessions.owner_user_id": {
    kind: "handled",
    reason: "delete (the person's sessions: prompts, folder paths; events and commands cascade)",
  },
  "node_level_confirmations.owner_user_id": {
    kind: "handled",
    reason: "delete (the person's level confirmations)",
  },
  "node_capabilities.owner_user_id": {
    kind: "handled",
    reason: "delete (the person's shared folders with paths, models and level pins)",
  },
  "agents.owner_user_id": {
    kind: "handled",
    reason:
      "delete (the personal agent's handle is derived from the user's first name or email " +
      "local part, so the row carries personal data; handle is made unconditionally immutable " +
      "by a trigger, so it cannot be anonymized in place; migration 0054 already declares the " +
      "intended semantics that deleting a user deletes their personal agent outright; mirrors " +
      "routines.owner_user_id's existing handled: delete disposition)",
  },
  "attention_subscriptions.user_id": {
    kind: "handled",
    reason: "delete (per-user attention rules)",
  },
  "away_ranges.user_id": {
    kind: "handled",
    reason: "delete (when the person was away is about them)",
  },
  "away_ranges.next_in_line_id": {
    kind: "handled",
    reason: "anonymize → NULL (NULL = the away person's standing default)",
  },
  "away_ranges.set_by": {
    kind: "handled",
    reason: "anonymize → NULL (who set someone else's away range)",
  },
  "user_preferences.next_in_line_id": {
    kind: "handled",
    reason: "anonymize → NULL (another person's standing next in line)",
  },
  "approval_requests.route_person_id": {
    kind: "handled",
    reason: "anonymize → NULL (NULL = the usual deciders)",
  },
  "org_app_features.changed_by": {
    kind: "handled",
    reason: "anonymize → NULL (who changed an org's feature; the switch survives)",
  },
  "attention_events.user_id": {
    kind: "handled",
    reason: "delete (per-user attention deliveries)",
  },
  "attention_events.actor_id": {
    kind: "handled",
    reason:
      "anonymize → NULL (erased user was the ACTOR on another user's surviving attention row)",
  },
  "scope_requests.requested_by": {
    kind: "handled",
    reason: "delete (the user's own scope requests)",
  },
  "scope_requests.target_user_id": {
    kind: "handled",
    reason: "delete (scope requests targeting the user)",
  },
  "scope_requests.decided_by": {
    kind: "handled",
    reason: "anonymize → NULL (erased user DECIDED another user's surviving scope request)",
  },
  "disabled_app_skills.user_id": {
    kind: "handled",
    reason: "delete (per-user skill toggles)",
  },
  "file_upload_sessions.created_by": {
    kind: "handled",
    reason: "delete (transient per-user upload staging)",
  },
  "notification_deliveries.user_id": {
    kind: "handled",
    reason: "delete (per-user delivery log, payload included; purged after 30 days anyway)",
  },
  "notification_receipts.user_id": {
    kind: "handled",
    reason: "delete (what the user's devices received and showed)",
  },
  "agent_local_claims.user_id": {
    kind: "handled",
    reason: "delete (the user's machine's lease on a conversation; the server answers again)",
  },
  "reply_thread_followers.user_id": {
    kind: "handled",
    reason: "delete (per-user reply-thread follows and read marks, like attention rules)",
  },
  // ── the person's mailbox encryption control plane (0033): their keyring,
  //    unlock wraps, cutover ledger and headless jobs. Every mailbox these
  //    describe is the user's own and is deleted by the mail app's onErase
  //    (accounts/conversations/messages ownerId → delete), so nothing that
  //    survives is sealed to these keys. Deleting the keyring is what the
  //    mailbox reset already does (modules/mailbox-keys/reset.ts), and a
  //    retained wrap would be an offline cracking oracle for a person who
  //    can no longer sign in. Rows only: no encryption logic is involved. ──
  "user_mailbox_identities.user_id": {
    kind: "handled",
    reason: "delete (the user's keyring; their sealed mailboxes are deleted with them)",
  },
  "user_key_wraps.user_id": {
    kind: "handled",
    reason: "delete (the user's wrapped Account Key: an offline cracking oracle, never retained)",
  },
  "mailbox_migration_state.user_id": {
    kind: "handled",
    reason: "delete (per-user cutover ledger of a mailbox that no longer exists)",
  },
  "mailbox_client_jobs.user_id": {
    kind: "handled",
    reason: "delete (work only the user's own browser could run)",
  },
  // ── permission / role assignment rows (deleted: the user no longer exists) ──
  "user_roles.user_id": { kind: "handled", reason: "delete (role assignment rows)" },
  "user_scope_grants.user_id": { kind: "handled", reason: "delete (direct scope grants)" },
  "user_dimension_grants.user_id": { kind: "handled", reason: "delete (direct dimension grants)" },
  // A text column (grantee_kind 'user' carries the user id as text), so the
  // sweep cannot discover it; listed so the disposition is still written down.
  "resource_grants.grantee": {
    kind: "handled",
    reason: "delete the user's own per-resource shares (grantee_kind = 'user')",
  },
  // ── shared / org content that survives but loses the PII link (anonymized) ──
  "skills.author_user_id": {
    kind: "handled",
    reason: "anonymize → NULL (shared skill authorship; column already SET NULL-able)",
  },
  "skills.created_by_user_id": {
    kind: "handled",
    reason: "anonymize → NULL (shared skill creator attribution)",
  },
  "routines.created_by_user_id": {
    kind: "handled",
    reason: "anonymize → NULL (creator attribution; owned rows already deleted via owner_user_id)",
  },
  "routines.edited_by_user_id": {
    kind: "handled",
    reason:
      "anonymize → NULL (last-editor attribution; NULL with edited_at set reads as an unknown editor)",
  },
  "saved_views.owner_user_id": {
    kind: "handled",
    reason:
      "delete personal views (CHECK chk_owner_or_default forbids a NULL owner on non-default views) / anonymize → NULL only on org-shared DEFAULT views the CHECK allows to be ownerless",
  },
  // ── RETAIN: rows that must legally/operationally survive WITH the user id ───
  "audit_log.actor_id": {
    kind: "retain",
    reason:
      "RETAIN: security/legal record — who-did-what must survive erasure. Raw email in auth-event `changes` is separately redacted at ingestion (see event-subscribers stripMessageContentForAudit).",
  },
  // Agent-turn identity and security context on the same append-only audit row
  // (UPDATE/DELETE revoked from the app role). Same disposition as actor_id.
  "audit_log.requester_user_id": {
    kind: "retain",
    reason:
      "RETAIN: the human who caused an agent turn is the who-did-what of that turn, the same accountability record as actor_id.",
  },
  "audit_log.room_member_snapshot": {
    kind: "retain",
    reason:
      "RETAIN: room members at the time of an audited agent turn (the security context its effective scope was computed from); jsonb array of user ids.",
  },
  "audit_log.disclosure_list": {
    kind: "retain",
    reason:
      "RETAIN: who restricted content was disclosed to, recorded on the audit row of the disclosure; a security record.",
  },
  "org_exports.requested_by": {
    kind: "retain",
    reason:
      "RETAIN: who exported the whole org's data is a security record (audited as org.export.*); the archive row expires after 7 days and the erased user is tombstoned, so the id still resolves.",
  },
  "timeline_entries.actor_id": {
    kind: "retain",
    reason: "RETAIN: activity-history record mirrors audit_log; entity provenance must survive.",
  },
  "credit_transactions.user_id": {
    kind: "retain",
    reason: "RETAIN: financial ledger — per-user spend attribution is a billing/accounting record.",
  },
  "approval_requests.requested_by": {
    kind: "retain",
    reason:
      "RETAIN: who requested a gated (often financial/destructive) action is an accountability record.",
  },
  "approval_requests.decided_by": {
    kind: "retain",
    reason: "RETAIN: who approved/denied a gated action is an accountability record.",
  },
  "approval_requests.notify_user_ids": {
    kind: "retain",
    reason:
      "RETAIN: notification audience on a retained approval record (bounded, non-PII handle).",
  },
  "approval_requests.resource_owner_id": {
    kind: "retain",
    reason:
      "RETAIN: the private-routing key of an approval on a personally owned resource; NULLing it would show that approval to every approvals admin (migration 0029 RLS).",
  },
  "approved_handler_executions.actor_id": {
    kind: "retain",
    reason: "RETAIN: the executing actor of an approved gated handler — accountability record.",
  },
  "app_scope_grant_audit.target_user_id": {
    kind: "retain",
    reason: "RETAIN: 'which app granted whom which scope when' — a security audit record.",
  },
  "invitations.invited_by": {
    kind: "retain",
    reason: "RETAIN: inviter attribution on invitation records (org-membership provenance).",
  },
  "apps_installed.installed_by": {
    kind: "retain",
    reason: "RETAIN: who installed an instance-wide app — operational/supply-chain provenance.",
  },
  "contacts.owner_user_id": {
    kind: "handled",
    reason:
      "private contacts nothing uses are deleted; used ones go to an org admin; org contacts lose their owner (modules/contacts/erasure.ts)",
  },
  "contacts.created_by": {
    kind: "retain",
    reason: "RETAIN: org-owned CRM data; creator attribution survives (org asset, not the user's).",
  },
  "contact_segments.created_by": {
    kind: "retain",
    reason: "RETAIN: org-owned segment definitions; creator attribution survives.",
  },
  "contact_addresses.created_by": {
    kind: "retain",
    reason: "RETAIN: org-owned contact address; who added it survives.",
  },
  "contact_addresses.verified_by": {
    kind: "retain",
    reason: "RETAIN: org-owned contact address; who verified it is the verification's provenance.",
  },
  "contact_group_members.added_by": {
    kind: "retain",
    reason: "RETAIN: org-owned contact group membership; who added a member survives.",
  },
  "document_template_rules.created_by": {
    kind: "retain",
    reason: "RETAIN: org-owned needed-template rule; who made it survives.",
  },
  "document_template_rules.updated_by": {
    kind: "retain",
    reason: "RETAIN: org-owned needed-template rule; who last changed it survives.",
  },
  "document_templates.created_by": {
    kind: "retain",
    reason: "RETAIN: org-owned document template; who made it survives.",
  },
  "document_templates.updated_by": {
    kind: "retain",
    reason: "RETAIN: org-owned document template; who last changed it survives.",
  },
  "product_attributes.updated_by": {
    kind: "retain",
    reason: "RETAIN: org-owned product data; who last set an attribute survives.",
  },
  // ── thread/message content: org-shared collaboration history (retained) ─────
  // Conversation history is shared org content (others' threads reference it);
  // the user-display side (name/email) is already tombstoned on kernel.users and
  // de-indexed from search. Hard-deleting authored messages would tear holes in
  // every co-participant's history, so authorship attribution is retained
  // pointing at the tombstoned user row.
  "threads.created_by": { kind: "retain", reason: "RETAIN: shared thread provenance." },
  "thread_participants.user_id": {
    kind: "retain",
    reason: "RETAIN: membership of shared threads (tombstoned user; deactivated, can't act).",
  },
  "messages.author_id": {
    kind: "retain",
    reason: "RETAIN: shared conversation history; author display already tombstoned + de-indexed.",
  },
  "messages.disclosure_list": {
    kind: "retain",
    reason:
      "RETAIN: read audience of a shared message, like thread_participants.user_id; the tombstoned user is deactivated and cannot read it.",
  },
  "message_reactions.user_id": {
    kind: "retain",
    reason: "RETAIN: reactions on shared messages (tombstoned user).",
  },
  "thread_references.added_by": {
    kind: "retain",
    reason: "RETAIN: who linked an entity into a shared thread.",
  },
  "user_thread_state.user_id": {
    kind: "retain",
    reason:
      "RETAIN: per-user read/archive/mute state — harmless residue keyed to a tombstoned user; no PII content.",
  },
  // ── files uploaded by the user: org content, attribution survives ──────────
  "files.uploaded_by": {
    kind: "retain",
    reason:
      "RETAIN: org-owned files (attachments in shared threads/tickets); uploader attribution.",
  },
  // ── auto-approve policy authorship (org-level, informational creator) ──────
  "auto_approve_policies.created_by": {
    kind: "handled",
    reason: "anonymize → NULL (org-level policy; creator is informational, column SET NULL-able)",
  },
  "approval_policies.created_by": {
    kind: "handled",
    reason:
      "anonymize → NULL (org-level tightening policy; creator is informational, SET NULL-able)",
  },
  "trusted_senders.created_by": {
    kind: "handled",
    reason: "anonymize → NULL (org-level trusted sender; creator attribution, nullable)",
  },
  "resource_grants.created_by": {
    kind: "handled",
    reason: "anonymize → NULL (who shared a resource with someone else; the share survives)",
  },
  "node_attachments.agent_allowed_by": {
    kind: "handled",
    reason:
      "anonymize → NULL (who allowed an agent on another person's node; `allowed` reads agent_allowed_at)",
  },
  "app_activation_events.actor_id": {
    kind: "handled",
    reason: "anonymize → NULL (who switched an app on or off; the org's app history stays)",
  },
  "import_transforms.created_by": {
    kind: "handled",
    reason: "anonymize → NULL (org-level import rule others reuse; creator is informational)",
  },
  "import_uploads.created_by": {
    kind: "handled",
    reason: "anonymize → sentinel (NOT NULL uploader of an org import; the import record stays)",
  },
  "secret_requests.requested_by": {
    kind: "handled",
    reason: "anonymize → sentinel (NOT NULL requester; the org connection's secret history stays)",
  },
  "secret_requests.completed_by": {
    kind: "handled",
    reason: "anonymize → NULL (who entered a secret for an org connection; the secret stays)",
  },
}

/**
 * The user-referencing column names the kernel sweep recognises. Discovery is
 * by name (a strong convention across the kernel schema) + type: uuid, uuid[]
 * or jsonb (a jsonb array of user ids). A text column that happens to be named
 * like one of these (e.g. `disabled_app_skills.disabled_by`, a 'seed'|'user'
 * text flag) is excluded.
 */
export const KERNEL_USER_COLUMN_NAMES = [
  "user_id",
  "owner_id",
  "owner_user_id",
  "created_by",
  "created_by_user_id",
  "author_id",
  "author_user_id",
  "actor_id",
  "added_by",
  "invited_by",
  "installed_by",
  "requested_by",
  "decided_by",
  "uploaded_by",
  "target_user_id",
  "notify_user_ids",
  "requester_user_id",
  "room_member_snapshot",
  "disclosure_list",
] as const

/**
 * KERNEL-schema completeness sweep (erasure-001 root-cause fix). The app-schema
 * sweep (`assertOrgPiiSchemasAccounted`) refuses to erase if any `app_*` schema
 * holding the org's data is unaccounted; this is the symmetric guard for the
 * KERNEL schema, which was previously handled by a hardcoded short list with no
 * completeness check. Because the erased user's `kernel.users` row is TOMBSTONED
 * (UPDATE) rather than deleted, every `ON DELETE CASCADE`/`SET NULL` FK to
 * `users.id` silently NO-OPs — so user-referencing kernel rows silently SURVIVE
 * erasure unless explicitly handled below.
 *
 * This sweep enumerates every user-referencing column on a kernel base table
 * (`discoverKernelUserColumns`: the recognised names, plus every foreign key to
 * `kernel.users`), and for each one that actually carries
 * the erased user's id, asserts it is accounted for in
 * `KERNEL_USER_COLUMN_DISPOSITION` (either `handled` by the cascade or `retain`
 * with a documented reason). An unaccounted column with the user's data → THROW,
 * rolling the whole transaction back. New kernel tables fail loudly until a
 * human records their disposition.
 *
 * Run AFTER the cascade mutations so `handled: delete/anonymize` columns no
 * longer carry the user's id; the residual rows it can still see are exactly the
 * `retain` ones (which keep the id by design) plus any genuinely-unaccounted
 * column — which is the failure we want to surface.
 */
export interface KernelUserColumn {
  table_name: string
  column_name: string
  udt_name: string
}

/**
 * Every kernel base-table column the sweep treats as holding a user id: the
 * recognised names (uuid, uuid[] or jsonb), plus every column carrying a
 * foreign key to `kernel.users` whatever its name (e.g.
 * `approval_requests.resource_owner_id`, `node_attachments.agent_allowed_by`),
 * which a name list alone never sees. Exported for the static completeness
 * test, which asserts every one of them has a disposition whether or not any
 * row holds a user today.
 */
export async function discoverKernelUserColumns(tx: PrivilegedDb): Promise<KernelUserColumn[]> {
  const kernelSchema = schemaRef("kernel")
  // Bind the recognised column names as a real SQL list. A bare multi-param
  // `ANY(($2, $3, ...))` is a ROW, not an array — Postgres rejects it
  // ("op ANY/ALL (array) requires array on right side"). Build an `IN (...)`
  // list the same way the rest of this codebase does (drizzleSql.join), so each
  // name is a separately-bound literal.
  const columnNameList = drizzleSql.join(
    KERNEL_USER_COLUMN_NAMES.map((n) => drizzleSql`${n}`),
    drizzleSql`, `,
  )
  // The FK half reads pg_catalog, not information_schema: the constraint views
  // only show tables the connected role owns.
  return extractRows<KernelUserColumn>(
    await tx.execute(drizzleSql`
      SELECT c.table_name, c.column_name, c.udt_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = ${kernelSchema}
        AND t.table_type = 'BASE TABLE'
        AND c.column_name IN (${columnNameList})
        AND c.udt_name IN ('uuid', '_uuid', 'jsonb')
      UNION
      SELECT rel.relname::text, a.attname::text, ty.typname::text
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = rel.relnamespace
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)
      JOIN pg_type ty ON ty.oid = a.atttypid
      WHERE con.contype = 'f'
        AND con.confrelid = ${`"${kernelSchema}".users`}::regclass
        AND n.nspname = ${kernelSchema}
        AND rel.relkind IN ('r', 'p')
    `),
  )
}

async function assertKernelUserColumnsAccounted(
  tx: PrivilegedDb,
  userId: string,
  injected?: { table: string; column: string },
  omit: readonly string[] = [],
): Promise<void> {
  const kernelSchema = schemaRef("kernel")
  const columns = await discoverKernelUserColumns(tx)
  // Test hook: simulate a newly-added kernel column the disposition map forgot.
  if (injected) {
    columns.push({ table_name: injected.table, column_name: injected.column, udt_name: "uuid" })
  }

  const unaccounted: string[] = []
  for (const { table_name, column_name, udt_name } of columns) {
    const key = `${table_name}.${column_name}`
    if (KERNEL_USER_COLUMN_DISPOSITION[key] && !omit.includes(key)) continue
    // Only flag columns that actually carry THIS user's id — an unaccounted
    // column with no rows for the user is not (yet) a leak, but we still want to
    // know about a populated one. The injected hook has no real column to probe,
    // so it always counts as a violation.
    const hasUserRows =
      injected && injected.table === table_name && injected.column === column_name
        ? true
        : await kernelColumnHasUser(tx, kernelSchema, table_name, column_name, udt_name, userId)
    if (hasUserRows) unaccounted.push(key)
  }

  if (unaccounted.length > 0) {
    throw new Error(
      `erase-user: kernel column(s) holding the erased user's id are unaccounted for: ${unaccounted.join(", ")} — add each to KERNEL_USER_COLUMN_DISPOSITION (handled by the cascade, or retain with a documented reason) before erasing`,
    )
  }
}

/** Does `kernel.<table>.<column>` hold any row referencing `userId`? */
async function kernelColumnHasUser(
  tx: PrivilegedDb,
  schema: string,
  table: string,
  column: string,
  udtName: string,
  userId: string,
): Promise<boolean> {
  const tableRef = drizzleSql.raw(`"${schema}"."${table}"`)
  const colRef = drizzleSql.raw(`"${column}"`)
  // Membership test by column type: uuid[] (e.g. approval_requests.notify_user_ids)
  // an array ANY, jsonb (e.g. audit_log.room_member_snapshot) containment of the
  // id as a string element, scalar uuid an equality test.
  const predicate =
    udtName === "_uuid"
      ? drizzleSql`${userId}::uuid = ANY(${colRef})`
      : udtName === "jsonb"
        ? drizzleSql`${colRef} @> jsonb_build_array(${userId}::text)`
        : drizzleSql`${colRef} = ${userId}`
  return (
    extractRows<{ n: number }>(
      await tx.execute(
        drizzleSql`SELECT count(*)::int AS n FROM (SELECT 1 FROM ${tableRef} WHERE ${predicate} LIMIT 1) t`,
      ),
    )[0].n > 0
  )
}

export async function eraseUser(
  userId: string,
  opts: EraseUserOptions = {},
): Promise<EraseUserResult> {
  try {
    // The messages the erased user wrote, collected inside the transaction for
    // the post-commit search pass below.
    const authoredMessageIds: string[] = []
    // The searchable app rows the cascade deletes: their documents go after
    // the commit (no entity event reaches the indexer for a plain-SQL delete).
    const deletedEntityDocs: Array<{ app: string; entityType: string; entityId: string }> = []
    // The person's profile picture object, removed from storage after the commit.
    let erasedAvatarKey: string | null = null
    // The person's connections with something left to do at the provider after the commit.
    const teardownAfterCommit: string[] = []
    // The sign-in sessions the erasure ends: their access tokens are revoked
    // after the commit.
    let endedSessionIds: string[] = []
    // Populate the org's app registry before the cascade. A thin caller (the
    // `liaison` CLI) does not boot app registration, so without this the live
    // registry is empty: collectUserRefFields would skip every app schema's
    // PII and assertOrgPiiSchemasAccounted would (correctly) refuse to erase.
    // Idempotent — registerApps overwrites, so this is safe on a warm server.
    // It runs before the erasure's transaction, never inside it: registration
    // takes privileged connections of its own and must not wait on one held here.
    const registryOrgId = extractRows<{ orgId: string }>(
      await withSystemDb("erase-user-org", (tx) =>
        tx.execute(drizzleSql`SELECT org_id AS "orgId" FROM ${K}.users WHERE id = ${userId}`),
      ),
    )[0]?.orgId
    if (registryOrgId) await ensureAppsForOrg(registryOrgId)
    const result = await withSystemDb("erase-user", async (tx) => {
      // 1. Look up the user.
      const userRows = extractRows<{
        id: string
        orgId: string
        email: string
        avatarKey: string | null
      }>(
        await tx.execute(
          drizzleSql`SELECT id, org_id AS "orgId", email, avatar_key AS "avatarKey" FROM ${K}.users WHERE id = ${userId}`,
        ),
      )
      if (userRows.length === 0) {
        // Unknown userId → non-zero, NO mutation, NO audit (G6).
        return { exitCode: 1, message: `user not found: ${userId}`, orgId: null }
      }
      const { orgId, email, avatarKey } = userRows[0]
      const sentinel = erasedUserEmail(userId)

      // Already-tombstoned → idempotent: exit 0, NO second audit entry.
      if (email === sentinel) {
        return { exitCode: 0, orgId }
      }

      // The per-org sentinel must exist before the cascade: NOT NULL
      // `anonymize` columns are re-pointed to it (the FK target must be a
      // retained row). Idempotent — reused across users/runs in the same org.
      const sentinelUid = await ensureSentinelUser(tx, orgId)

      // Defense-in-depth: any app schema holding this org's rows must be backed
      // by an installed-app manifest. Fail loudly rather than silently skip PII.
      await assertOrgPiiSchemasAccounted(tx, orgId)

      const fields = collectUserRefFields(orgId)
      const searchable = collectSearchableRegistrations(orgId).entities
      if (opts.injectMissingColumnApp) {
        fields.push({
          app: "tickets",
          schema: appSchemaName("tickets"),
          table: "tickets",
          column: "no_such_user_column",
          strategy: "anonymize",
        })
      }

      // 2. Apply each declared strategy. A declaration referencing a missing
      //    column fails fast (the thrown error rolls back the whole tx).
      for (const f of fields) {
        const colExists = extractRows<{ n: number }>(
          await tx.execute(drizzleSql`
            SELECT count(*)::int AS n FROM information_schema.columns
            WHERE table_schema = ${f.schema}
              AND table_name = ${f.table}
              AND column_name = ${f.column}
          `),
        )[0].n
        if (colExists === 0) {
          throw new Error(
            `erase-user: declared userRef column ${f.schema}.${f.table}.${f.column} (${f.app}) does not exist`,
          )
        }
        const tableRef = drizzleSql.raw(`"${f.schema}"."${f.table}"`)
        const colRef = drizzleSql.raw(`"${f.column}"`)
        if (f.strategy === "delete") {
          const reg = searchable.find((e) => e.app === f.app && e.tableName === f.table)
          if (reg) {
            const gone = extractRows<{ id: string }>(
              await tx.execute(
                drizzleSql`DELETE FROM ${tableRef} WHERE ${colRef} = ${userId} RETURNING id::text AS id`,
              ),
            )
            for (const r of gone) {
              deletedEntityDocs.push({ app: f.app, entityType: reg.entityType, entityId: r.id })
            }
          } else {
            await tx.execute(drizzleSql`DELETE FROM ${tableRef} WHERE ${colRef} = ${userId}`)
          }
        } else {
          // anonymize: NULL when nullable, else a deterministic sentinel.
          const nullable =
            extractRows<{ is_nullable: string }>(
              await tx.execute(drizzleSql`
                SELECT is_nullable FROM information_schema.columns
                WHERE table_schema = ${f.schema}
                  AND table_name = ${f.table}
                  AND column_name = ${f.column}
              `),
            )[0]?.is_nullable === "YES"
          if (nullable) {
            await tx.execute(
              drizzleSql`UPDATE ${tableRef} SET ${colRef} = NULL WHERE ${colRef} = ${userId}`,
            )
          } else {
            // NOT NULL attribution column: NULL is not representable, so
            // re-point the FK at the per-org "deleted user" sentinel. The
            // erased user's id is removed from the app schema (G4) and the
            // FK to a retained kernel.users row stays valid.
            await tx.execute(
              drizzleSql`UPDATE ${tableRef} SET ${colRef} = ${sentinelUid} WHERE ${colRef} = ${userId}`,
            )
          }
        }
      }

      // 3. Tombstone kernel.users (NOT a hard delete — G3). Mark the account
      //    deactivated and bump auth_version + permission_version so any
      //    already-issued access token is rejected by the auth middleware on its
      //    next request (status no longer "active" and the versions no longer
      //    match the token claims). Also clear all residual PII and re-auth
      //    material: recovery codes and TOTP are credentials that could otherwise
      //    re-authenticate the erased user, and settings/timezone/locale may
      //    carry personal data.
      await tx.execute(drizzleSql`
        UPDATE ${K}.users
        SET email = ${sentinel},
            name = ${sentinel},
            password_hash = NULL,
            totp_secret = NULL,
            totp_enabled = false,
            totp_last_used_at = NULL,
            recovery_codes = NULL,
            avatar_url = NULL,
            avatar_key = NULL,
            timezone = NULL,
            locale = NULL,
            settings = '{}'::jsonb,
            status = 'deactivated',
            auth_version = auth_version + 1,
            permission_version = permission_version + 1
        WHERE id = ${userId}
      `)

      // 3b. Revoke every credential that could re-authenticate the erased user:
      //     refresh-token sessions (which mint fresh access tokens), federated
      //     identity links, and the user's own connected accounts. Mirrors
      //     deactivateUser's session revocation, extended for full erasure.
      endedSessionIds = extractRows<{ id: string }>(
        await tx.execute(
          drizzleSql`DELETE FROM ${K}.sessions WHERE user_id = ${userId} RETURNING id`,
        ),
      ).map((r) => r.id)
      // Open WebSocket connections: the same `user deactivate` event
      // deactivateUser queues, which the permission subscriber turns into a
      // close on every node once this transaction commits. A socket that never
      // pings is otherwise never revalidated and keeps receiving live events.
      await tx.queueEvent({
        app: "kernel",
        entity: "user",
        action: "deactivate",
        orgId,
        actorId: null,
        entityId: userId,
      })
      await tx.execute(drizzleSql`DELETE FROM ${K}.oauth_accounts WHERE user_id = ${userId}`)
      // The user's own OAuth connections: their push watches are stopped and their
      // grants revoked at the provider after the commit. Staged here in this transaction,
      // while the rows and the tokens still exist; whether another active connection on
      // the instance still uses them is checked when that work runs (connections/revoke.ts).
      const ownConnections = extractRows<StageableConnection>(
        await tx.execute(drizzleSql`
          SELECT id, org_id AS "orgId", app_name AS "appName",
                 connection_name AS "connectionName", provider_type AS "providerType",
                 identifier, access_token_encrypted AS "accessTokenEncrypted",
                 refresh_token_encrypted AS "refreshTokenEncrypted",
                 oauth_client_source AS "oauthClientSource",
                 oauth_client_id AS "oauthClientId",
                 token_expires_at AS "tokenExpiresAt"
          FROM ${K}.connected_accounts
          WHERE owner_type = 'user' AND owner_id = ${userId} AND status <> 'disconnected'
        `),
      )
      for (const conn of ownConnections) {
        await stageConnectionTeardown(tx, conn)
        teardownAfterCommit.push(conn.id)
      }
      await tx.execute(drizzleSql`
        DELETE FROM ${K}.connected_accounts
        WHERE owner_type = 'user' AND owner_id = ${userId}
      `)
      // Per-user MCP credential (a refresh-token equivalent that can mint
      // tokens) and any in-flight device-auth grant tied to the user.
      await tx.execute(drizzleSql`DELETE FROM ${K}.mcp_connections WHERE user_id = ${userId}`)
      await tx.execute(drizzleSql`DELETE FROM ${K}.device_flow_requests WHERE user_id = ${userId}`)
      await tx.execute(drizzleSql`DELETE FROM ${K}.password_resets WHERE user_id = ${userId}`)
      // The user's registered phones: a push after erasure would reach a
      // device of someone who no longer has an account here.
      await tx.execute(drizzleSql`DELETE FROM ${K}.push_tokens WHERE user_id = ${userId}`)
      // The rest of the user's notification devices: the receipt credentials
      // their apps hold, their desktop installs and their browsers' Web Push
      // endpoints. Any phone that ever signed in has a credential row.
      await tx.execute(
        drizzleSql`DELETE FROM ${K}.notification_device_credentials WHERE user_id = ${userId}`,
      )
      await tx.execute(drizzleSql`DELETE FROM ${K}.desktop_devices WHERE user_id = ${userId}`)
      await tx.execute(
        drizzleSql`DELETE FROM ${K}.browser_push_subscriptions WHERE user_id = ${userId}`,
      )

      // 3c. KERNEL-schema PII cascade (erasure-001). The tombstone above leaves
      //     every FK to users.id pointing at a RETAINED row, so ON DELETE
      //     CASCADE/SET NULL never fires for the erased user. Each
      //     user-referencing kernel column must therefore be handled explicitly
      //     here (or RETAINed with a documented reason — see
      //     KERNEL_USER_COLUMN_DISPOSITION). The completeness sweep below
      //     (assertKernelUserColumnsAccounted) is the gate that proves NOTHING
      //     was missed.

      // (a) DELETE — clearly personal, user-owned rows.
      await tx.execute(drizzleSql`DELETE FROM ${K}.agent_memory WHERE user_id = ${userId}`)
      // The agents slice re-keyed memory ownership to owner_agent_id (migration
      // 0055) and user_id is now only the slice-1b bridge, so the DELETE above
      // no longer catches a memory row owned by the erased user's personal
      // agent whose user_id was never backfilled (or diverges). Catch those
      // here too, before the personal agent row itself is deleted below
      // (agent_memory.owner_agent_id is a plain FK with no ON DELETE clause,
      // so it would block the agent's deletion otherwise) — mirrors the
      // routines.owner_agent_id handling a few lines down.
      await tx.execute(drizzleSql`
        DELETE FROM ${K}.agent_memory
        WHERE owner_agent_id IN (SELECT id FROM ${K}.agents WHERE owner_user_id = ${userId})
      `)
      await tx.execute(drizzleSql`DELETE FROM ${K}.user_preferences WHERE user_id = ${userId}`)
      await tx.execute(drizzleSql`DELETE FROM ${K}.tour_progress WHERE user_id = ${userId}`)
      // Contacts the person owns (owner_user_id is ON DELETE RESTRICT).
      await releaseErasedUserContacts(tx as never, { orgId, userId, sentinelUserId: sentinelUid })
      await tx.execute(drizzleSql`DELETE FROM ${K}.routines WHERE owner_user_id = ${userId}`)
      // The agents slice re-keyed routine ownership to owner_agent_id and made
      // owner_user_id provenance-only, so the DELETE above no longer catches a
      // routine owned by the erased user's personal agent (it may carry a
      // different, or NULL, owner_user_id). Catch those here, before the
      // personal agent row itself is deleted below (routines.owner_agent_id is
      // a plain FK with no ON DELETE clause, so it would block the agent's
      // deletion otherwise).
      await tx.execute(drizzleSql`
        DELETE FROM ${K}.routines
        WHERE owner_agent_id IN (SELECT id FROM ${K}.agents WHERE owner_user_id = ${userId})
      `)
      // The person's local node and everything it carries (children before
      // parents): sessions (their events and commands cascade), jobs,
      // profiles, attachments, chat settings, permission prompts, level
      // confirmations, capabilities, then the nodes. A job of someone else's
      // node the person asked for survives without its requester.
      await tx.execute(drizzleSql`DELETE FROM ${K}.node_sessions WHERE owner_user_id = ${userId}`)
      await tx.execute(drizzleSql`DELETE FROM ${K}.node_jobs WHERE owner_user_id = ${userId}`)
      await tx.execute(drizzleSql`
        UPDATE ${K}.node_jobs SET requester_user_id = NULL WHERE requester_user_id = ${userId}
      `)
      await tx.execute(
        drizzleSql`DELETE FROM ${K}.node_profiles WHERE node_owner_user_id = ${userId}`,
      )
      await tx.execute(
        drizzleSql`DELETE FROM ${K}.node_attachments WHERE node_owner_user_id = ${userId}`,
      )
      await tx.execute(
        drizzleSql`DELETE FROM ${K}.thread_node_settings WHERE owner_user_id = ${userId}`,
      )
      await tx.execute(
        drizzleSql`DELETE FROM ${K}.node_permission_prompts WHERE owner_user_id = ${userId}`,
      )
      await tx.execute(
        drizzleSql`DELETE FROM ${K}.node_level_confirmations WHERE owner_user_id = ${userId}`,
      )
      await tx.execute(
        drizzleSql`DELETE FROM ${K}.node_capabilities WHERE owner_user_id = ${userId}`,
      )
      await tx.execute(drizzleSql`DELETE FROM ${K}.nodes WHERE owner_user_id = ${userId}`)
      await tx.execute(
        drizzleSql`DELETE FROM ${K}.attention_subscriptions WHERE user_id = ${userId}`,
      )
      await tx.execute(drizzleSql`DELETE FROM ${K}.attention_events WHERE user_id = ${userId}`)
      await tx.execute(drizzleSql`DELETE FROM ${K}.disabled_app_skills WHERE user_id = ${userId}`)
      await tx.execute(
        drizzleSql`DELETE FROM ${K}.file_upload_sessions WHERE created_by = ${userId}`,
      )
      // What reached the user's devices, their desktop's leases on
      // conversations, and the reply threads they follow.
      await tx.execute(
        drizzleSql`DELETE FROM ${K}.notification_deliveries WHERE user_id = ${userId}`,
      )
      await tx.execute(drizzleSql`DELETE FROM ${K}.notification_receipts WHERE user_id = ${userId}`)
      await tx.execute(drizzleSql`DELETE FROM ${K}.agent_local_claims WHERE user_id = ${userId}`)
      await tx.execute(
        drizzleSql`DELETE FROM ${K}.reply_thread_followers WHERE user_id = ${userId}`,
      )
      // The user's mailbox encryption control plane. The mailboxes themselves
      // were deleted by the mail app's declared onErase above, so the keyring,
      // the unlock wraps (an offline cracking oracle), the cutover ledger and
      // the headless jobs describe nothing that survives.
      await tx.execute(drizzleSql`DELETE FROM ${K}.mailbox_client_jobs WHERE user_id = ${userId}`)
      await tx.execute(
        drizzleSql`DELETE FROM ${K}.mailbox_migration_state WHERE user_id = ${userId}`,
      )
      await tx.execute(drizzleSql`DELETE FROM ${K}.user_key_wraps WHERE user_id = ${userId}`)
      await tx.execute(
        drizzleSql`DELETE FROM ${K}.user_mailbox_identities WHERE user_id = ${userId}`,
      )
      // scope_requests reference the user three ways (requester + target +
      // decider); delete a row if the user was the requester or target — neither
      // side outlives the user. For rows the user merely DECIDED (for someone
      // else, so requester/target ≠ user), the row survives → null the
      // decided_by attribution.
      await tx.execute(drizzleSql`
        DELETE FROM ${K}.scope_requests
        WHERE requested_by = ${userId} OR target_user_id = ${userId}
      `)
      await tx.execute(
        drizzleSql`UPDATE ${K}.scope_requests SET decided_by = NULL WHERE decided_by = ${userId}`,
      )

      // (b) DELETE — permission/role assignment rows. The user no longer exists,
      //     so their direct grants and role memberships go with them.
      await tx.execute(drizzleSql`DELETE FROM ${K}.user_roles WHERE user_id = ${userId}`)
      await tx.execute(drizzleSql`DELETE FROM ${K}.user_scope_grants WHERE user_id = ${userId}`)
      await tx.execute(drizzleSql`DELETE FROM ${K}.user_dimension_grants WHERE user_id = ${userId}`)
      // Per-resource shares made TO the user (grantee is text: the user id for
      // grantee_kind 'user').
      await tx.execute(drizzleSql`
        DELETE FROM ${K}.resource_grants WHERE grantee_kind = 'user' AND grantee = ${userId}
      `)

      // (c) ANONYMIZE — shared/org content that must survive but lose the PII
      //     link. All these columns are nullable (SET NULL FKs), so NULL is the
      //     anonymized value; a surviving shared row no longer attributes to the
      //     erased user. (routines.owner_user_id rows were already deleted in
      //     (a); created_by_user_id is the creator-attribution shadow that can
      //     differ from owner — null it on any leftover shared/app routine.)
      await tx.execute(
        drizzleSql`UPDATE ${K}.skills SET author_user_id = NULL WHERE author_user_id = ${userId}`,
      )
      await tx.execute(drizzleSql`
        UPDATE ${K}.skills SET created_by_user_id = NULL WHERE created_by_user_id = ${userId}
      `)
      await tx.execute(drizzleSql`
        UPDATE ${K}.routines SET created_by_user_id = NULL WHERE created_by_user_id = ${userId}
      `)
      await tx.execute(drizzleSql`
        UPDATE ${K}.routines SET edited_by_user_id = NULL WHERE edited_by_user_id = ${userId}
      `)
      await tx.execute(drizzleSql`DELETE FROM ${K}.away_ranges WHERE user_id = ${userId}`)
      await tx.execute(drizzleSql`
        UPDATE ${K}.away_ranges SET next_in_line_id = NULL WHERE next_in_line_id = ${userId}
      `)
      await tx.execute(
        drizzleSql`UPDATE ${K}.away_ranges SET set_by = NULL WHERE set_by = ${userId}`,
      )
      await tx.execute(drizzleSql`
        UPDATE ${K}.user_preferences SET next_in_line_id = NULL WHERE next_in_line_id = ${userId}
      `)
      await tx.execute(drizzleSql`
        UPDATE ${K}.approval_requests SET route_person_id = NULL WHERE route_person_id = ${userId}
      `)
      await tx.execute(drizzleSql`
        UPDATE ${K}.org_app_features SET changed_by = NULL WHERE changed_by = ${userId}
      `)
      // skills.owner_agent_id is nullable and the existing disposition for
      // skills is ANONYMIZE (the skill survives the erasure), so a skill owned
      // by the erased user's dying personal agent loses the owner link instead
      // of being deleted. Must run before the agent row is deleted below.
      await tx.execute(drizzleSql`
        UPDATE ${K}.skills SET owner_agent_id = NULL
        WHERE owner_agent_id IN (SELECT id FROM ${K}.agents WHERE owner_user_id = ${userId})
      `)
      // saved_views carries CHECK chk_owner_or_default:
      //   (owner_user_id IS NOT NULL) OR (is_default AND shared_with_org)
      // A personal view (NOT the default+shared kind) requires a non-NULL owner,
      // so NULLing its owner would violate the CHECK. Personal views are private
      // to the erased user → DELETE them. Only the org-shared DEFAULT views may
      // legally carry a NULL owner, so for those we keep the view (org content)
      // and sever the PII link by NULLing the owner.
      await tx.execute(drizzleSql`
        DELETE FROM ${K}.saved_views
        WHERE owner_user_id = ${userId}
          AND NOT (is_default AND shared_with_org)
      `)
      await tx.execute(drizzleSql`
        UPDATE ${K}.saved_views SET owner_user_id = NULL
        WHERE owner_user_id = ${userId}
          AND is_default AND shared_with_org
      `)
      await tx.execute(drizzleSql`
        UPDATE ${K}.auto_approve_policies SET created_by = NULL WHERE created_by = ${userId}
      `)
      await tx.execute(drizzleSql`
        UPDATE ${K}.approval_policies SET created_by = NULL WHERE created_by = ${userId}
      `)
      await tx.execute(drizzleSql`
        UPDATE ${K}.trusted_senders SET created_by = NULL WHERE created_by = ${userId}
      `)
      await tx.execute(drizzleSql`
        UPDATE ${K}.resource_grants SET created_by = NULL WHERE created_by = ${userId}
      `)
      // Who allowed an agent on SOMEONE ELSE'S node (the user's own node
      // attachments were deleted above); whether it is allowed reads
      // agent_allowed_at, which stays.
      await tx.execute(drizzleSql`
        UPDATE ${K}.node_attachments SET agent_allowed_by = NULL WHERE agent_allowed_by = ${userId}
      `)
      // The user named on SOMEONE ELSE'S node allowlist ({ type, id } entries in
      // allowed_requesters): the entry goes, the rest of the list stays.
      await tx.execute(drizzleSql`
        UPDATE ${K}.node_attachments
        SET allowed_requesters = COALESCE(
          (SELECT jsonb_agg(e) FROM jsonb_array_elements(allowed_requesters) e
           WHERE NOT (e->>'type' = 'user' AND e->>'id' = ${userId})),
          '[]'::jsonb)
        WHERE allowed_requesters @> jsonb_build_array(jsonb_build_object('type', 'user', 'id', ${userId}::text))
      `)
      // Another user's surviving attention row where the erased user was the
      // triggering actor: null the actor attribution (the row's recipient lives).
      await tx.execute(
        drizzleSql`UPDATE ${K}.attention_events SET actor_id = NULL WHERE actor_id = ${userId}`,
      )
      // connected_accounts.created_by is NOT NULL → re-point at the per-org
      // sentinel (the org-level accounts themselves are retained; only the
      // user's OWN connected accounts were deleted above).
      await tx.execute(drizzleSql`
        UPDATE ${K}.connected_accounts SET created_by = ${sentinelUid} WHERE created_by = ${userId}
      `)
      // Org records the user only authored: who switched an app on, created an
      // import rule, uploaded an import or asked for and entered a connection's
      // secret. The records stay; NOT NULL authors point at the sentinel.
      await tx.execute(drizzleSql`
        UPDATE ${K}.app_activation_events SET actor_id = NULL WHERE actor_id = ${userId}
      `)
      await tx.execute(drizzleSql`
        UPDATE ${K}.import_transforms SET created_by = NULL WHERE created_by = ${userId}
      `)
      await tx.execute(drizzleSql`
        UPDATE ${K}.import_uploads SET created_by = ${sentinelUid} WHERE created_by = ${userId}
      `)
      await tx.execute(drizzleSql`
        UPDATE ${K}.secret_requests SET requested_by = ${sentinelUid} WHERE requested_by = ${userId}
      `)
      await tx.execute(drizzleSql`
        UPDATE ${K}.secret_requests SET completed_by = NULL WHERE completed_by = ${userId}
      `)
      // inviter attribution on OTHER users' rows: null it so no surviving user
      // row points back at the erased account.
      await tx.execute(
        drizzleSql`UPDATE ${K}.users SET invited_by = NULL WHERE invited_by = ${userId}`,
      )

      // The erased user's personal agent row carries personal data (handle is
      // derived from the user's first name or email local part, and is made
      // unconditionally immutable by a trigger, so it cannot be anonymized in
      // place) — delete it outright, mirroring routines.owner_user_id's
      // existing handled: delete disposition. Run LAST in this pass: the
      // routine and skill statements above already cleared every row that
      // would otherwise RESTRICT this delete (routines.owner_agent_id,
      // skills.owner_agent_id); agent_skill_index.agent_id and
      // agent_knowledge_pointers.agent_id are ON DELETE CASCADE, so they need
      // no explicit statement here.
      // P4m: the agent's rolling per thread summaries. The composite
      // (agent_id, org_id) foreign key on kernel.agent_thread_checkpoints
      // carries no ON DELETE clause, exactly like agent_memory.owner_agent_id
      // above, so it BLOCKS the agent delete below unless the rows go first. A
      // checkpoint is also personal data in its own right: it is one agent's
      // summary of what it read in a conversation this user was in.
      await tx.execute(drizzleSql`
        DELETE FROM ${K}.agent_thread_checkpoints
        WHERE agent_id IN (SELECT id FROM ${K}.agents WHERE owner_user_id = ${userId})
      `)
      await tx.execute(drizzleSql`DELETE FROM ${K}.agents WHERE owner_user_id = ${userId}`)

      // P4m: the SEARCH INDEX. Message rows are retained (author_id is a
      // RETAINed attribution link), but the erased user's authored text must
      // not stay searchable, and neither must the sliding WINDOW documents that
      // quote it: a window is five messages of verbatim text under one
      // document id, so deleting only the message document would leave the
      // words in the index under a different key.
      //
      // Best effort, deliberately: search is a derived store and a reindex
      // rebuilds it, so an unreachable Meili must never roll back an erasure
      // that the database itself completed.
      try {
        const authored = extractRows<{ id: string; thread_id: string }>(
          await tx.execute(drizzleSql`
            SELECT id, thread_id FROM ${K}.messages WHERE author_id = ${userId}
          `),
        )
        authoredMessageIds.push(...authored.map((r) => r.id))
        if (authored.length > 0) {
          const { deleteMessageAndWindowDocuments } = await import(
            "~/modules/search/message-indexer"
          )
          for (const row of authored) {
            await deleteMessageAndWindowDocuments(orgId, row.thread_id, row.id, tx)
          }
        }
      } catch (err) {
        log.warn(
          { err, userId },
          "Could not remove the erased user's documents from the search index; a reindex will",
        )
      }

      if (opts.inTransaction) await opts.inTransaction(tx, { orgId })

      // (d) COMPLETENESS GATE — refuse to erase if any kernel column carrying
      //     this user's id is neither handled above nor RETAINed with a reason.
      //     Runs inside the tx: a throw rolls back the whole erasure.
      await assertKernelUserColumnsAccounted(
        tx,
        userId,
        opts.injectUnaccountedKernelColumn,
        opts.omitKernelDispositions,
      )

      // 4. Exactly one system audit entry (G5). `withSystemDb` yields a
      //    privileged tx (BYPASSRLS); writeAuditLog's RlsClient param is
      //    structurally compatible — same query API (privileged.ts uses the
      //    same cast). `required: true` makes a failed INSERT roll the whole
      //    transaction back so PII can never be deleted without its audit row.
      await writeAuditLog(
        tx as unknown as RlsClient,
        {
          orgId,
          actorType: "system",
          action: "user.erased",
          entityType: "user",
          entityId: userId,
          metadata: { userId },
        },
        { required: true },
      )

      erasedAvatarKey = avatarKey
      return { exitCode: 0, orgId }
    })

    // After the erasure transaction commits, drop the erased user's cached auth
    // state across every process so their existing access tokens stop
    // authenticating immediately instead of lingering for up to the 15s in-memory
    // TTL on each node. The tx already bumped auth_version/permission_version and
    // set status='deactivated' (the durable backstop); this is the fast path,
    // mirroring deactivateUser. Best-effort — never fatal to a committed erasure.
    if (result.exitCode === 0 && result.orgId) {
      try {
        invalidateAuthCache(userId)
        revokeSessions(endedSessionIds, "user-erased")
      } catch (cacheErr) {
        log.warn({ cacheErr, userId }, "erase-user: failed to invalidate auth cache for user")
      }
      // The erasure dropped every role and grant the user held.
      log.debug(
        { userId, orgId: result.orgId },
        "erase-user: effective scope changed (every role and grant dropped)",
      )
    }

    // Also remove the erased user's name/email from the search index so they
    // cannot be found via mentions or global search. Enqueued outside the
    // transaction because MeiliSearch is not transactional; a failure here is
    // non-fatal (the erasure DB side already succeeded).
    // The removal queued inside the transaction can be applied by the flusher
    // (about a second) BEFORE the tombstone commits, and a neighbour's window
    // rebuilt in that gap still read the author as live and re-quoted the
    // text. Now that the tombstone is committed, every authored message is
    // re-queued: its document is deleted (its author is erased) and the window
    // covering it is rebuilt without it (message-indexer.ts, QUOTABLE).
    if (result.exitCode === 0 && result.orgId && authoredMessageIds.length > 0) {
      try {
        const [{ recordLiveIndex }, { messageLiveIndexItem }] = await Promise.all([
          import("~/modules/search/live-index-queue"),
          import("~/modules/search/message-indexer"),
        ])
        const orgId = result.orgId
        for (let i = 0; i < authoredMessageIds.length; i += 1000) {
          await recordLiveIndex(
            authoredMessageIds
              .slice(i, i + 1000)
              .map((messageId) => messageLiveIndexItem({ action: "upsert", orgId, messageId })),
          )
        }
      } catch (indexErr) {
        log.warn(
          { indexErr, userId },
          "erase-user: could not re-queue the erased user's message documents; a rebuild will",
        )
      }
    }

    // The erased user's OAuth connections (Google and any provider declaring a
    // `watchStopUrl` or `revocationUrl`): the provider is told to stop and to end the
    // grant. Never fatal to a committed erasure: what an outage prevents stays queued.
    if (result.exitCode === 0) {
      for (const connectionId of teardownAfterCommit) await runConnectionTeardown(connectionId)
    }

    // The profile picture: the tombstone cleared avatar_key, so the public
    // `/api/avatars/<key>` URL no longer resolves; the object itself goes too
    // (best effort, like the avatar routes' purge of a superseded key).
    if (result.exitCode === 0 && result.orgId && erasedAvatarKey) {
      await deleteObject(avatarStorageKey(result.orgId, erasedAvatarKey)).catch((err: unknown) => {
        log.warn({ err, userId }, "erase-user: could not delete the erased user's avatar object")
      })
    }

    // The search documents of the app rows the cascade deleted.
    if (result.exitCode === 0 && result.orgId && deletedEntityDocs.length > 0) {
      try {
        const [{ recordLiveIndex }, { entityLiveIndexItem }] = await Promise.all([
          import("~/modules/search/live-index-queue"),
          import("~/modules/search/indexer"),
        ])
        const orgId = result.orgId
        for (let i = 0; i < deletedEntityDocs.length; i += 1000) {
          await recordLiveIndex(
            deletedEntityDocs
              .slice(i, i + 1000)
              .map((d) => entityLiveIndexItem({ action: "delete", orgId, ...d })),
          )
        }
      } catch (indexErr) {
        log.warn(
          { indexErr, userId },
          "erase-user: could not queue the deleted rows' search documents for removal; a rebuild will",
        )
      }
    }

    if (result.exitCode === 0 && result.orgId) {
      const eventId = `erase:${userId}`
      try {
        await enqueueIndexerDelete(result.orgId, "kernel", "user", userId, eventId)
      } catch (indexErr) {
        log.warn({ indexErr, userId }, "erase-user: failed to enqueue search index delete for user")
      }
    }

    return { exitCode: result.exitCode, message: result.message }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error({ err, userId }, "erase-user failed (transaction rolled back)")
    return { exitCode: 1, message }
  }
}
