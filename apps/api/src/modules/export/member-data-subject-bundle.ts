// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql as drizzleSql, type SQL } from "drizzle-orm"
import type { PrivilegedDb, RlsClient } from "~/db"
import { extractRows } from "~/db"
import { schemaRef } from "~/db/schema-ref"

/**
 * The person (member) side of the data-subject export: everything the org
 * holds about ONE member of the organization as a person. The caller has
 * already been authorized (the member themself, or a holder of the data-subject
 * authority), see `data-subject-export-tool.ts`.
 *
 * Two kinds of section:
 *  - `caller`: rows that sit inside conversations and records other people
 *    share (messages, threads, uploaded files). Read under the CALLER's RLS, so
 *    the bundle never carries a conversation the caller could not open.
 *  - `self`: rows that are the member's alone AND that other people may read only under a
 *    rule of their own (the time a person entered). In a self-export they are read like a
 *    `subject` section, all of them; when someone else exports the member they are read under
 *    the CALLER's RLS, so the requester gets only the rows they could already read (an entry
 *    on a project's dated sheet, for that project's lead or finance), never the member's
 *    private ones, whatever authority the requester holds.
 *  - `subject`: rows that are about the member alone (preferences, routines,
 *    approvals, audit entries, connected accounts, the app drafts they made and
 *    the app runs they started). Read privileged and filtered strictly on the
 *    member's id; RLS would hide most of them from the member themself (the
 *    audit log, for one, or a draft after they lost the build permission),
 *    which is exactly what an access request asks for: the right of access does
 *    not depend on today's permissions.
 *
 * Every section selects named columns only. Tokens, password and TOTP hashes,
 * encrypted credentials and key material are never selected, and free-form
 * JSON (settings, preferences, audit changes) goes through `withoutSecrets`.
 *
 * EXTENSION POINT: a new kind of per-person record (a person's time rows, for one) is
 * one more entry in `MEMBER_SECTIONS`. It then appears in every member bundle
 * with its note, its rows and its count, and nothing else changes.
 */

/** Rows per section. A section that reaches it says so (`truncated`). */
export const MEMBER_SECTION_ROW_CAP = 1000

export interface MemberSectionCtx {
  orgId: string
  subjectUserId: string
  /** Who asked for the export. A `self` section is read in full only when it is the subject. */
  callerUserId?: string
}

export interface MemberSection {
  key: string
  /** One plain sentence saying what the section holds, written into the bundle. */
  note: string
  via: "caller" | "self" | "subject"
  /** Reads at most `limit` rows. `db` is the caller's RLS client or a privileged tx, per `via`. */
  read: (
    db: RlsClient | PrivilegedDb,
    ctx: MemberSectionCtx,
    limit: number,
  ) => Promise<Record<string, unknown>[]>
}

export interface MemberSectionResult {
  note: string
  rows: Record<string, unknown>[]
  truncated: boolean
}

const SECRET_KEY_RE =
  /secret|token|password|passwd|hash|credential|cipher|encrypted|recovery|api[_-]?key|private[_-]?key|totp|otp|nonce|wrapped/i

/** A copy of `value` with every object key that names a secret dropped, at any depth. */
export function withoutSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSecrets)
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) continue
      out[k] = withoutSecrets(v)
    }
    return out
  }
  return value
}

function iso(v: unknown): string | null {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString()
}

/** Dates as ISO strings, JSON through `withoutSecrets`. */
function exportableRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    out[k] = v instanceof Date ? iso(v) : withoutSecrets(v)
  }
  return out
}

async function rows(db: RlsClient | PrivilegedDb, query: SQL): Promise<Record<string, unknown>[]> {
  return extractRows<Record<string, unknown>>(await db.execute(query)).map((r) => exportableRow(r))
}

const K = () => drizzleSql.raw(schemaRef("kernel"))
const P = () => drizzleSql.raw(schemaRef("app_projects"))

export const MEMBER_SECTIONS: MemberSection[] = [
  {
    key: "preferences",
    note: "The member's own settings: notifications digest, work hours, time zone, language, theme and writing preferences.",
    via: "subject",
    read: (db, ctx) =>
      rows(
        db,
        drizzleSql`
        SELECT digest_cadence, work_hours_start::text AS work_hours_start,
               work_hours_end::text AS work_hours_end, work_days, timezone, language, theme,
               magic_wand_instructions, dictation_auto_clean, home_card_layout
        FROM ${K()}.user_preferences
        WHERE user_id = ${ctx.subjectUserId}`,
      ),
  },
  {
    key: "roles",
    note: "The roles the member holds in this organization.",
    via: "subject",
    read: (db, ctx, limit) =>
      rows(
        db,
        drizzleSql`
        SELECT r.name, r.description
        FROM ${K()}.user_roles ur
        JOIN ${K()}.roles r ON r.id = ur.role_id
        WHERE ur.org_id = ${ctx.orgId} AND ur.user_id = ${ctx.subjectUserId}
        ORDER BY r.name
        LIMIT ${limit}`,
      ),
  },
  {
    key: "messages",
    note: "Messages the member wrote, in conversations the requester can open.",
    via: "caller",
    read: (db, ctx, limit) =>
      rows(
        db,
        drizzleSql`
        SELECT id::text AS id, thread_id::text AS thread_id, content,
               parent_message_id::text AS parent_message_id, created_at, edited_at
        FROM ${K()}.messages
        WHERE org_id = ${ctx.orgId} AND author_id = ${ctx.subjectUserId}
          AND author_type = 'user' AND deleted_at IS NULL
        ORDER BY created_at
        LIMIT ${limit}`,
      ),
  },
  {
    key: "threads",
    note: "Conversations the member started, as far as the requester can open them.",
    via: "caller",
    read: (db, ctx, limit) =>
      rows(
        db,
        drizzleSql`
        SELECT id::text AS id, handle, title, type, topic, description, created_at
        FROM ${K()}.threads
        WHERE org_id = ${ctx.orgId} AND created_by = ${ctx.subjectUserId}
        ORDER BY created_at
        LIMIT ${limit}`,
      ),
  },
  {
    key: "files",
    note: "Files the member uploaded that the requester can open: their details and where to download them. The file contents are not copied into this export.",
    via: "caller",
    read: async (db, ctx, limit) =>
      (
        await rows(
          db,
          drizzleSql`
          SELECT id::text AS id, filename, mime_type, size_bytes::text AS size_bytes, app,
                 entity_type, entity_id, created_at
          FROM ${K()}.files
          WHERE org_id = ${ctx.orgId} AND uploaded_by = ${ctx.subjectUserId}
          ORDER BY created_at
          LIMIT ${limit}`,
        )
      ).map(({ size_bytes, ...r }) => ({
        ...r,
        size_bytes: Number(size_bytes ?? 0),
        links: {
          metadata: `/api/files/${r.id as string}/metadata`,
          download: `/api/files/${r.id as string}/download-url`,
        },
      })),
  },
  {
    key: "approvals",
    note: "Approval requests the member made or decided: which action, its status and when. What each request would have done is not included, as it is usually about other people.",
    via: "subject",
    read: (db, ctx, limit) =>
      rows(
        db,
        drizzleSql`
        SELECT id::text AS id, handle, tool_name, status,
               (requested_by = ${ctx.subjectUserId}) AS requested_by_member,
               (decided_by = ${ctx.subjectUserId}) AS decided_by_member,
               CASE WHEN decided_by = ${ctx.subjectUserId} THEN reason END AS reason,
               thread_id::text AS thread_id, created_at, decided_at
        FROM ${K()}.approval_requests
        WHERE org_id = ${ctx.orgId}
          AND (requested_by = ${ctx.subjectUserId} OR decided_by = ${ctx.subjectUserId})
        ORDER BY created_at
        LIMIT ${limit}`,
      ),
  },
  {
    key: "routines",
    note: "Routines the member owns: what each does and when it runs.",
    via: "subject",
    read: (db, ctx, limit) =>
      rows(
        db,
        drizzleSql`
        SELECT id::text AS id, name, description, kind, cron, timezone, run_at, event, app_name,
               prompt, visibility, enabled, status, last_run_at, last_run_status, created_at
        FROM ${K()}.routines
        WHERE org_id = ${ctx.orgId} AND owner_user_id = ${ctx.subjectUserId}
        ORDER BY created_at
        LIMIT ${limit}`,
      ),
  },
  {
    key: "dashboards",
    note: "Dashboards the member owns, made or last changed: title, whether it is personal or shared with the organization, and when. Their blocks are not included, as they show the organization's data.",
    via: "subject",
    read: (db, ctx, limit) =>
      rows(
        db,
        drizzleSql`
        SELECT id::text AS id, title, visibility,
               COALESCE(owner_user_id = ${ctx.subjectUserId}, false) AS owned,
               COALESCE(created_by = ${ctx.subjectUserId}, false) AS made,
               COALESCE(updated_by = ${ctx.subjectUserId}, false) AS last_changed,
               created_at, updated_at
        FROM ${K()}.dashboards
        WHERE org_id = ${ctx.orgId}
          AND (owner_user_id = ${ctx.subjectUserId} OR created_by = ${ctx.subjectUserId}
               OR updated_by = ${ctx.subjectUserId})
        ORDER BY created_at
        LIMIT ${limit}`,
      ),
  },
  {
    key: "dashboardTables",
    note: "Dashboard tables the member owns, made or last changed, and how many row changes they made: the table's name and when. The rows are not included, as they are the organization's data.",
    via: "subject",
    read: (db, ctx, limit) =>
      rows(
        db,
        drizzleSql`
        SELECT t.id::text AS id, t.name,
               COALESCE(t.owner_user_id = ${ctx.subjectUserId}, false) AS owned,
               COALESCE(t.created_by = ${ctx.subjectUserId}, false) AS made,
               COALESCE(t.updated_by = ${ctx.subjectUserId}, false) AS last_changed,
               (SELECT count(*)::int FROM ${K()}.dashboard_table_changes c
                 WHERE c.org_id = t.org_id AND c.table_id = t.id
                   AND c.actor_id = ${ctx.subjectUserId}) AS row_changes,
               t.created_at, t.updated_at
        FROM ${K()}.dashboard_tables t
        WHERE t.org_id = ${ctx.orgId}
          AND (t.owner_user_id = ${ctx.subjectUserId} OR t.created_by = ${ctx.subjectUserId}
               OR t.updated_by = ${ctx.subjectUserId}
               OR EXISTS (SELECT 1 FROM ${K()}.dashboard_table_changes c
                           WHERE c.org_id = t.org_id AND c.table_id = t.id
                             AND c.actor_id = ${ctx.subjectUserId}))
        ORDER BY t.created_at
        LIMIT ${limit}`,
      ),
  },
  {
    key: "storeDocuments",
    note: "Documents the member wrote or last changed in an app's data store or the agent's: which app, collection and key, their size and when. Their contents are not included, as they are usually about the organization or other people.",
    via: "subject",
    read: (db, ctx, limit) =>
      rows(
        db,
        drizzleSql`
        SELECT app, collection, doc_id, size_bytes,
               COALESCE(created_by = ${ctx.subjectUserId}, false) AS made,
               COALESCE(updated_by = ${ctx.subjectUserId}, false) AS last_changed,
               created_at, updated_at
        FROM ${K()}.app_documents
        WHERE org_id = ${ctx.orgId}
          AND (created_by = ${ctx.subjectUserId} OR updated_by = ${ctx.subjectUserId})
        ORDER BY created_at
        LIMIT ${limit}`,
      ),
  },
  {
    key: "auditEntries",
    note: "Audit log entries about the member or recording what they did. The recorded changes are included only for entries about the member themself.",
    via: "subject",
    read: (db, ctx, limit) =>
      rows(
        db,
        drizzleSql`
        SELECT id::text AS id, timestamp, actor_type::text AS actor_type, app, entity_type,
               entity_id, action,
               (actor_id = ${ctx.subjectUserId} OR requester_user_id = ${ctx.subjectUserId})
                 AS by_member,
               CASE WHEN entity_type = 'user' AND entity_id = ${ctx.subjectUserId}::text
                    THEN changes END AS changes
        FROM ${K()}.audit_log
        WHERE org_id = ${ctx.orgId}
          AND (actor_id = ${ctx.subjectUserId}
               OR requester_user_id = ${ctx.subjectUserId}
               OR (entity_type = 'user' AND entity_id = ${ctx.subjectUserId}::text))
        ORDER BY timestamp
        LIMIT ${limit}`,
      ),
  },
  {
    key: "connectedAccounts",
    note: "Accounts the member connected (mail, calendar and other services): which account and its state. Access tokens and credentials are never exported.",
    via: "subject",
    read: (db, ctx, limit) =>
      rows(
        db,
        drizzleSql`
        SELECT id::text AS id, app_name, connection_name, provider_type, identifier, display_name,
               status, status_message, created_at, updated_at, disconnected_at
        FROM ${K()}.connected_accounts
        WHERE org_id = ${ctx.orgId} AND owner_type = 'user' AND owner_id = ${ctx.subjectUserId}
        ORDER BY created_at
        LIMIT ${limit}`,
      ),
  },
  {
    key: "signInAccounts",
    note: "Outside sign-in accounts linked to the member (Google and others): provider and address.",
    via: "subject",
    read: (db, ctx, limit) =>
      rows(
        db,
        drizzleSql`
        SELECT id::text AS id, provider_id::text AS provider_id, external_email, created_at
        FROM ${K()}.oauth_accounts
        WHERE org_id = ${ctx.orgId} AND user_id = ${ctx.subjectUserId}
        ORDER BY created_at
        LIMIT ${limit}`,
      ),
  },
  {
    key: "connectedApps",
    note: "Outside AI clients the member connected to Liaison: name, last use and whether it was revoked.",
    via: "subject",
    read: (db, ctx, limit) =>
      rows(
        db,
        drizzleSql`
        SELECT id::text AS id, client_id, label, last_used_at, revoked_at, created_at
        FROM ${K()}.mcp_connections
        WHERE org_id = ${ctx.orgId} AND user_id = ${ctx.subjectUserId}
        ORDER BY created_at
        LIMIT ${limit}`,
      ),
  },
  {
    key: "companiesManaged",
    note: "Companies the member is account manager of, or created: name, domain and which of the two. A company they manage but cannot read shows its id only.",
    via: "subject",
    // Being account manager grants nothing: a company the member cannot read
    // (shared with nobody, not created by them, no grant to them or their
    // roles) keeps its name, domain and date out of their bundle.
    read: (db, ctx, limit) =>
      rows(
        db,
        drizzleSql`
        SELECT c.id::text AS id,
               CASE WHEN r.readable THEN c.name END AS name,
               CASE WHEN r.readable THEN c.domain END AS domain,
               (c.owner_user_id = ${ctx.subjectUserId}::uuid) AS account_manager,
               (c.created_by = ${ctx.subjectUserId}::uuid) AS created_by_member,
               CASE WHEN r.readable THEN c.created_at END AS created_at
        FROM ${K()}.companies c
        CROSS JOIN LATERAL (
          SELECT (
            c.org_access <> 'none'
            OR c.created_by = ${ctx.subjectUserId}::uuid
            OR EXISTS (
              SELECT 1 FROM ${K()}.resource_grants g
               WHERE g.org_id = c.org_id AND g.resource_type = 'kernel.company'
                 AND g.resource_id = c.id
                 AND ((g.grantee_kind = 'user' AND g.grantee = ${ctx.subjectUserId}::text)
                   OR (g.grantee_kind = 'role' AND g.grantee IN (
                         SELECT ur.role_id::text FROM ${K()}.user_roles ur
                          WHERE ur.org_id = c.org_id AND ur.user_id = ${ctx.subjectUserId}::uuid)))
            )
          ) AS readable
        ) r
        WHERE c.org_id = ${ctx.orgId}
          AND (c.owner_user_id = ${ctx.subjectUserId}::uuid OR c.created_by = ${ctx.subjectUserId}::uuid)
        ORDER BY c.created_at, c.id
        LIMIT ${limit}`,
      ),
  },
  {
    key: "deals",
    note: "Deals the member owns (as the task's assignee) or closed: title, pipeline, outcome, when it closed and which of the two.",
    via: "subject",
    read: async (db, ctx, limit) => {
      const P = drizzleSql.raw(schemaRef("app_projects"))
      // An org database without the projects tables has no deals to list.
      const present = extractRows<{ ok: boolean }>(
        await db.execute(
          drizzleSql`SELECT to_regclass(${`${schemaRef("app_projects")}.deals`}) IS NOT NULL AS ok`,
        ),
      )
      if (present[0]?.ok !== true) return []
      return rows(
        db,
        drizzleSql`
        SELECT d.task_id::text AS task_id, t.title, p.name AS pipeline, d.outcome, d.closed_at,
               (t.assignee_id IS NOT DISTINCT FROM ${ctx.subjectUserId}::uuid) AS owner,
               (d.closed_by IS NOT DISTINCT FROM ${ctx.subjectUserId}::uuid) AS closed_by_member
        FROM ${P}.deals d
        JOIN ${P}.tasks t ON t.id = d.task_id AND t.org_id = d.org_id
        JOIN ${P}.projects p ON p.id = t.project_id AND p.org_id = t.org_id
        WHERE d.org_id = ${ctx.orgId} AND t.parent_task_id IS NULL
          AND (t.assignee_id = ${ctx.subjectUserId}::uuid OR d.closed_by = ${ctx.subjectUserId}::uuid)
        ORDER BY d.created_at
        LIMIT ${limit}`,
      )
    },
  },
  {
    key: "suppressionsAdded",
    note: "Opt-outs the member recorded: when and how. The address is not kept, only a fingerprint of it, so none is listed.",
    via: "subject",
    read: async (db, ctx, limit) => {
      const { suppressionsAddedBy } = await import("~/modules/mail/suppressions")
      return (await suppressionsAddedBy(db, ctx.orgId, ctx.subjectUserId, limit)).map((r) => ({
        reason: r.reason,
        created_at: iso(r.created_at),
      }))
    },
  },
  {
    key: "appDrafts",
    note: "App drafts the member made, last changed or saved a version of: name, title, status, the published app if any, which versions they saved, and when. The draft's code is not included.",
    via: "subject",
    read: (db, ctx, limit) =>
      rows(
        db,
        drizzleSql`
        SELECT d.id::text AS id, d.base_name, d.title, d.status, d.published_app_name,
               d.latest_version,
               COALESCE(d.created_by = ${ctx.subjectUserId}::uuid, false) AS made,
               COALESCE(d.updated_by = ${ctx.subjectUserId}::uuid, false) AS last_changed,
               COALESCE((SELECT array_agg(v.n ORDER BY v.n) FROM ${K()}.app_draft_versions v
                          WHERE v.draft_id = d.id AND v.org_id = d.org_id
                            AND v.created_by = ${ctx.subjectUserId}::uuid), '{}') AS versions_made,
               d.created_at, d.updated_at
        FROM ${K()}.app_drafts d
        WHERE d.org_id = ${ctx.orgId}
          AND (d.created_by = ${ctx.subjectUserId}::uuid OR d.updated_by = ${ctx.subjectUserId}::uuid
               OR EXISTS (SELECT 1 FROM ${K()}.app_draft_versions v
                           WHERE v.draft_id = d.id AND v.org_id = d.org_id
                             AND v.created_by = ${ctx.subjectUserId}::uuid))
        ORDER BY d.created_at, d.id
        LIMIT ${limit}`,
      ),
  },
  {
    key: "ownTaskTime",
    note: "The time the member entered on tasks: the day, the minutes, how it was entered, the task and its project, and whether someone else changed the entry (not who). Nobody else's time is included. Exported by someone else, it holds only the entries that person can already read on a project's dated sheet.",
    via: "self",
    read: (db, ctx, limit) =>
      rows(
        db,
        drizzleSql`
        SELECT tt.work_date::text AS work_date, tt.minutes, tt.entered_via,
               t.title AS task, p.name AS project,
               COALESCE(tt.changed_by IS NOT NULL AND tt.changed_by <> tt.user_id, false)
                 AS changed_by_someone_else,
               tt.created_at, tt.updated_at
        FROM ${P()}.task_time tt
        JOIN ${P()}.tasks t ON t.id = tt.task_id AND t.org_id = tt.org_id
        JOIN ${P()}.projects p ON p.id = tt.project_id AND p.org_id = tt.org_id
        WHERE tt.org_id = ${ctx.orgId} AND tt.user_id = ${ctx.subjectUserId}::uuid
        ORDER BY tt.work_date, tt.created_at
        LIMIT ${limit}`,
      ),
  },
  {
    key: "awayRanges",
    note: "The member's away days: from, to or the weekdays, where they came from, their state and an early end. Who is next in line and who set a range are not included.",
    via: "subject",
    read: (db, ctx, limit) =>
      rows(
        db,
        drizzleSql`
        SELECT starts_on::text AS starts_on, ends_on::text AS ends_on, weekdays, source, status,
               ended_early_on::text AS ended_early_on,
               COALESCE(set_by IS NOT NULL AND set_by <> user_id, false) AS set_by_someone_else,
               created_at, updated_at
        FROM ${K()}.away_ranges
        WHERE org_id = ${ctx.orgId} AND user_id = ${ctx.subjectUserId}::uuid
        ORDER BY starts_on, created_at
        LIMIT ${limit}`,
      ),
  },
  {
    key: "daysPerWeek",
    note: "How many days a week the member works, when that was set.",
    via: "subject",
    read: (db, ctx) =>
      rows(
        db,
        drizzleSql`
        SELECT days_per_week, updated_at
        FROM ${P()}.person_capacity
        WHERE org_id = ${ctx.orgId} AND user_id = ${ctx.subjectUserId}::uuid`,
      ),
  },
  {
    key: "appLogs",
    note: "App runs started by the member's actions that left log lines, one row per run: the app or draft, how many lines, how many warnings and errors, and when. What the app wrote is not included, as it is written by app code and often about other people.",
    via: "subject",
    read: async (db, ctx, limit) =>
      (
        await rows(
          db,
          drizzleSql`
          SELECT run_id::text AS run_id, app, draft_id::text AS draft_id,
                 count(*)::int AS lines,
                 (count(*) FILTER (WHERE level = 'warn'))::int AS warnings,
                 (count(*) FILTER (WHERE level = 'error'))::int AS errors,
                 min(at) AS first_at, max(at) AS last_at
          FROM ${K()}.app_logs
          WHERE org_id = ${ctx.orgId} AND actor_user_id = ${ctx.subjectUserId}::uuid
          GROUP BY run_id, app, draft_id
          ORDER BY min(at), run_id
          LIMIT ${limit}`,
        )
      ).map((r) => ({ ...r, first_at: iso(r.first_at), last_at: iso(r.last_at) })),
  },
]

/**
 * Reads every section: the `caller` ones (and `self` ones of someone else's export) on
 * `callerDb`, the rest in one privileged transaction.
 */
export async function readMemberSections(
  callerDb: RlsClient,
  ctx: MemberSectionCtx,
  sections: readonly MemberSection[] = MEMBER_SECTIONS,
): Promise<Record<string, MemberSectionResult>> {
  const out: Record<string, MemberSectionResult> = {}
  const take = async (s: MemberSection, db: RlsClient | PrivilegedDb) => {
    const got = await s.read(db, ctx, MEMBER_SECTION_ROW_CAP + 1)
    out[s.key] = {
      note: s.note,
      rows: got.slice(0, MEMBER_SECTION_ROW_CAP),
      truncated: got.length > MEMBER_SECTION_ROW_CAP,
    }
  }
  // A `self` section is the subject's own read only in a self-export; anyone else reads it
  // under their own RLS (fail closed: no caller named is someone else).
  const selfExport = ctx.callerUserId !== undefined && ctx.callerUserId === ctx.subjectUserId
  const onCaller = (s: MemberSection) => s.via === "caller" || (s.via === "self" && !selfExport)
  for (const s of sections) if (onCaller(s)) await take(s, callerDb)
  const subjectSections = sections.filter((s) => !onCaller(s))
  if (subjectSections.length > 0) {
    const { withPrivilegedDb } = await import("~/db/privileged")
    await withPrivilegedDb(ctx.orgId, "data_subject_export member sections", async (tx) => {
      for (const s of subjectSections) await take(s, tx)
    })
  }
  // Keep the declared order in the file, whatever order they were read in.
  return Object.fromEntries(sections.map((s) => [s.key, out[s.key] as MemberSectionResult]))
}
