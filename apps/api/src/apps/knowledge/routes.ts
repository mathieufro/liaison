// SPDX-License-Identifier: FSL-1.1-ALv2

import {
  knowledgeCollectionMembershipSchema,
  knowledgeCollectionPatchSchema,
  knowledgeCollectionSchema,
  knowledgeCreateDocumentSchema,
  knowledgeDocumentSharingSchema,
  knowledgeFederatedSearchSchema,
  knowledgeLinkRemoteSchema,
  knowledgeSourcePolicyPatchSchema,
  knowledgeTagSchema,
  knowledgeUpdateDocumentSchema,
  knowledgeVerifyDocumentSchema,
} from "@liaison/shared"
import { sql } from "drizzle-orm"
import { type Context, Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import {
  addCollectionMembership,
  archiveKnowledgeCollection,
  createKnowledgeCollection,
  listKnowledgeCollections,
  listKnowledgeCollectionTree,
  removeCollectionMembership,
  updateKnowledgeCollection,
} from "~/apps/knowledge/collections"
import {
  attachSyncedSourceApp,
  federatedKnowledgeSearch,
  scrubSourceStatuses,
} from "~/apps/knowledge/federated-search"
import { requestForceOnOpenSync } from "~/apps/knowledge/force-on-open"
import { searchLocalKnowledge } from "~/apps/knowledge/local-search"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import {
  archiveKnowledgeDocument,
  assertCanReadDocumentRow,
  canEditDocumentRow,
  createKnowledgeDocument,
  dropArchivedKnowledgeHits,
  getDocumentSharing,
  type KnowledgeActor,
  KnowledgeError,
  knowledgeActorFromContext,
  knowledgeDisplayTitle,
  knowledgeHttpStatus,
  listKnowledgeDocuments,
  loadDocumentShareRole,
  loadKnowledgeDocument,
  restoreKnowledgeDocument,
  setDocumentSharing,
  updateKnowledgeDocument,
  verifyKnowledgeDocument,
} from "~/apps/knowledge/service"
import {
  archiveSourceLink,
  linkRemoteDocument,
  loadSourceLink,
  refreshSourceLinkMetadata,
  verifySourceLink,
} from "~/apps/knowledge/source-links"
import { isFolderSourceCapable } from "~/apps/knowledge/source-protocol"
import { registerDefaultKnowledgeSources } from "~/apps/knowledge/source-registry"
import { loadSearchPolicies, loadSourcePolicy, updateSourcePolicy } from "~/apps/knowledge/sources"
import {
  archiveSyncedSource,
  assertCanForceSyncedSource,
  createSyncedSource,
  listSyncedSources,
  loadSyncedSource,
  requireKnowledgeReader,
  updateSyncedSource,
} from "~/apps/knowledge/synced-sources"
import { listKnowledgeTags, upsertKnowledgeTag } from "~/apps/knowledge/tags"
import { extractRows } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { enqueueAppJob } from "~/infra/jobs/jobs"
import { qaSeedRoutesEnabled } from "~/lib/env"
import { withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { knowledgeItemsRegistry } from "~/modules/apps/app-registries"
import { hasScope } from "~/modules/permissions/permissions"

import { listShareMembers, listShareRoles } from "~/modules/sharing/targets"

const K = () => sql.raw(schemaRef("kernel"))

const idParamSchema = z.object({ id: z.string().min(1) })

export const knowledgeRoutes = new Hono<AppEnv>()

type KnowledgeContext = Context<AppEnv>

function getActor(c: KnowledgeContext, opts: { includeArchived?: boolean } = {}): KnowledgeActor {
  return knowledgeActorFromContext({
    orgId: c.get("orgId"),
    userId: c.get("userId"),
    scopes: c.get("scopes") ?? [],
    dimensionGrants: c.get("dimensionGrants") ?? {},
    roles: c.get("roles") ?? [],
    includeArchived: opts.includeArchived,
  })
}

function knowledgeErrorResponse(c: KnowledgeContext, err: unknown) {
  if (!(err instanceof KnowledgeError)) throw err
  const status = knowledgeHttpStatus(err.code)
  if (err.code === "SOURCE_UNAVAILABLE") {
    // Genuine dependency outage. The internal message often reveals which dep was
    // missing ("Knowledge document storage unavailable") — useful for ops, useless
    // and slightly leaky for clients. Return a generic 503 + log the cause.
    const logger = c.get("logger") as
      | { warn?: (b: Record<string, unknown>, msg: string) => void }
      | undefined
    if (logger && typeof logger.warn === "function") {
      logger.warn({ knowledgeCause: err.message }, "knowledge_source_unavailable")
    }
    return c.json(
      { error: { message: "Knowledge service is temporarily unavailable", code: err.code } },
      status,
    )
  }
  // All other codes (incl. SOURCE_NOT_ENABLED → 422) pass the actionable message
  // through. SOURCE_NOT_ENABLED is a client precondition, not a server fault.
  return c.json({ error: { message: err.message, code: err.code } }, status)
}

/**
 * Zero-knowledge response — collapses both FORBIDDEN and NOT_FOUND into a
 * single 404 so unauthorized callers cannot probe for row existence. Per
 * spec §72-76, this collapse must apply to *every* document endpoint that
 * touches a row by id (reads, writes, archive, restore, verify, backlinks).
 */
export function zeroKnowledgeResponse(c: KnowledgeContext, err: unknown) {
  if (err instanceof KnowledgeError && (err.code === "FORBIDDEN" || err.code === "NOT_FOUND")) {
    return c.json({ error: { message: "Knowledge item not found", code: "NOT_FOUND" } }, 404)
  }
  return knowledgeErrorResponse(c, err)
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

knowledgeRoutes.get("/documents", async (c) => {
  const actor = getActor(c)
  const filter = c.req.query("filter")
  const opts = filter === "unfiled" ? { unfiled: true } : {}
  const docs = await withRequestRls(c, (tx) => listKnowledgeDocuments(tx, actor, opts))
  return success(c, docs)
})

knowledgeRoutes.post("/documents", zValidator("json", knowledgeCreateDocumentSchema), async (c) => {
  try {
    const actor = getActor(c)
    const input = c.req.valid("json")
    // A human creating a document through the Knowledge UI reads nothing
    // scoped into it: the empty array is the positive assertion (D5).
    const doc = await withRequestRls(c, (tx) => createKnowledgeDocument(tx, input, actor, []))
    return success(c, doc, undefined, 201)
  } catch (err) {
    return knowledgeErrorResponse(c, err)
  }
})

/**
 * Backlinks for a Knowledge document. The backend filters to references the
 * caller is authorized to see — never expose redacted counts or unauthorized
 * titles (spec §72-76). Currently returns an empty array; the indexer that
 * populates real backlinks lands in a follow-up task that registers Knowledge
 * documents as reference targets across the mention/reference system.
 */
knowledgeRoutes.get("/documents/:id/backlinks", zValidator("param", idParamSchema), async (c) => {
  try {
    const actor = getActor(c)
    const { id } = c.req.valid("param")
    const backlinks = await withRequestRls(c, async (tx) => {
      const row = await loadKnowledgeDocument(tx, id, actor)
      if (!row) throw new KnowledgeError("NOT_FOUND", "Knowledge item not found")
      const shareRole = await loadDocumentShareRole(tx, row.id, actor)
      assertCanReadDocumentRow(row, actor, shareRole)
      // Backlinks come from kernel.thread_references — every entity (thread,
      // doc, mail, etc.) that referenced this Knowledge document. RLS on
      // thread_references already filters to threads the caller can see, so
      // we only need to scope to (app='knowledge', entityType='document', id).
      const result = await tx.execute(sql`
          SELECT
            tr.thread_id AS "threadId",
            tr.app AS "app",
            tr.entity_type AS "entityType",
            tr.entity_id AS "entityId",
            t.title AS "title",
            tr.last_visited_at AS "lastVisitedAt"
          FROM ${K()}.thread_references tr
          JOIN ${K()}.threads t ON t.id = tr.thread_id
          WHERE tr.app = 'knowledge'
            AND tr.entity_type = 'document'
            AND tr.entity_id = ${id}
            AND tr.org_id = ${actor.orgId}::uuid
            -- Exclude private 1:1 Liaison assistant chats (type 'agent_chat').
            -- They accumulate incidental entity references for the assistant's
            -- own context strip and must never surface as public document
            -- backlinks. Mirrors listBacklinks() in modules/threads/reference.ts.
            AND t.type <> 'agent_chat'
          ORDER BY tr.last_visited_at DESC
          LIMIT 100
        `)
      const rows = extractRows<{
        threadId: string
        app: string
        entityType: string
        entityId: string
        title: string | null
        lastVisitedAt: string | Date
      }>(result)
      return rows.map((r) => ({
        app: "kernel",
        entityType: "thread",
        entityId: r.threadId,
        title: r.title ?? "Thread",
        url: `/threads/${r.threadId}`,
      }))
    })
    return success(c, { backlinks })
  } catch (err) {
    return zeroKnowledgeResponse(c, err)
  }
})

knowledgeRoutes.get("/documents/:id", zValidator("param", idParamSchema), async (c) => {
  try {
    const actor = getActor(c)
    const { id } = c.req.valid("param")
    const row = await withRequestRls(c, async (tx) => {
      const doc = await loadKnowledgeDocument(tx, id, actor)
      if (!doc) return null
      const shareRole = await loadDocumentShareRole(tx, doc.id, actor)
      assertCanReadDocumentRow(doc, actor, shareRole)
      // Where a synced document comes from, for its banner: the source's app
      // and the folder's name ("Google Drive", "Finance").
      const source = doc.syncedSourceId
        ? extractRows<{ app_name: string; display_name: string }>(
            await tx.execute(sql`
              SELECT app_name, display_name FROM ${knowledgeRel("synced_sources")}
              WHERE id = ${doc.syncedSourceId}::uuid
            `),
          )[0]
        : undefined
      return {
        ...doc,
        canEdit: canEditDocumentRow(doc, actor, shareRole),
        ...(source
          ? { syncedSourceApp: source.app_name, syncedSourceName: source.display_name }
          : {}),
      }
    })
    if (!row) throw new KnowledgeError("NOT_FOUND", "Knowledge item not found")

    // Force-on-open (force-on-open.ts): a stale synced document queues an
    // immediate sync. Never fails and never holds the read past a short cap.
    const { deferred: syncDeferred } = await requestForceOnOpenSync(row, actor.userId)

    return success(c, row, syncDeferred ? { syncDeferred: true } : undefined)
  } catch (err) {
    return zeroKnowledgeResponse(c, err)
  }
})

knowledgeRoutes.patch(
  "/documents/:id",
  zValidator("param", idParamSchema),
  zValidator("json", knowledgeUpdateDocumentSchema),
  async (c) => {
    try {
      const actor = getActor(c)
      const { id } = c.req.valid("param")
      const input = { ...c.req.valid("json"), id }
      // A human edit asserts [] and the union leaves any tag an agent turn put
      // on the document intact.
      const doc = await withRequestRls(c, (tx) => updateKnowledgeDocument(tx, input, actor, []))
      return success(c, doc)
    } catch (err) {
      // Writes against rows the actor cannot read must also zero-knowledge.
      return zeroKnowledgeResponse(c, err)
    }
  },
)

knowledgeRoutes.post("/documents/:id/archive", zValidator("param", idParamSchema), async (c) => {
  try {
    const actor = getActor(c)
    const { id } = c.req.valid("param")
    const doc = await withRequestRls(c, (tx) => archiveKnowledgeDocument(tx, id, actor))
    return success(c, doc)
  } catch (err) {
    return zeroKnowledgeResponse(c, err)
  }
})

knowledgeRoutes.post("/documents/:id/restore", zValidator("param", idParamSchema), async (c) => {
  try {
    const actor = getActor(c, { includeArchived: true })
    const { id } = c.req.valid("param")
    const doc = await withRequestRls(c, (tx) => restoreKnowledgeDocument(tx, id, actor))
    return success(c, doc)
  } catch (err) {
    return zeroKnowledgeResponse(c, err)
  }
})

knowledgeRoutes.post(
  "/documents/:id/verify",
  zValidator("param", idParamSchema),
  zValidator("json", knowledgeVerifyDocumentSchema),
  async (c) => {
    try {
      const actor = getActor(c)
      const { id } = c.req.valid("param")
      const { revision } = c.req.valid("json")
      const doc = await withRequestRls(c, async (tx) => {
        // BC-8: client-supplied revision is the optimistic-concurrency token —
        // server must NOT silently substitute the live row.revision here, or
        // any stale tab can verify a doc someone else just edited.
        const row = await loadKnowledgeDocument(tx, id, actor)
        if (!row) throw new KnowledgeError("NOT_FOUND", "Knowledge item not found")
        return verifyKnowledgeDocument(tx, id, revision, actor)
      })
      return success(c, doc)
    } catch (err) {
      return zeroKnowledgeResponse(c, err)
    }
  },
)

// ---------------------------------------------------------------------------
// Sharing (Google-Drive-style) — GET/PUT /documents/:id/sharing
// ---------------------------------------------------------------------------

knowledgeRoutes.get("/documents/:id/sharing", zValidator("param", idParamSchema), async (c) => {
  try {
    const actor = getActor(c)
    const { id } = c.req.valid("param")
    const sharing = await withRequestRls(c, (tx) => getDocumentSharing(tx, id, actor))
    return success(c, sharing)
  } catch (err) {
    return zeroKnowledgeResponse(c, err)
  }
})

knowledgeRoutes.put(
  "/documents/:id/sharing",
  zValidator("param", idParamSchema),
  zValidator("json", knowledgeDocumentSharingSchema),
  async (c) => {
    try {
      const actor = getActor(c)
      const { id } = c.req.valid("param")
      const input = c.req.valid("json")
      const sharing = await withRequestRls(c, (tx) => setDocumentSharing(tx, id, input, actor))
      return success(c, sharing)
    } catch (err) {
      return zeroKnowledgeResponse(c, err)
    }
  },
)

// ---------------------------------------------------------------------------
// Org members — GET /members (for the share picker)
// ---------------------------------------------------------------------------
//
// Any authenticated org member holding knowledge:documents:read may list org
// members to share a document with — this is NOT an admin-only surface (unlike
// /api/admin/users). kernel.users' own `users_select_rls` policy already
// allows any org member to read all users in the same org, so reusing
// `listShareMembers` here does not widen access beyond what RLS already grants;
// this route simply exposes a minimal (id, name, email) projection to
// non-admin callers for the sharing picker.

knowledgeRoutes.get("/members", async (c) => {
  try {
    const actor = getActor(c)
    if (
      !hasScope("knowledge:documents:read", actor.scopes) &&
      !hasScope("knowledge:documents:admin", actor.scopes)
    ) {
      throw new KnowledgeError("FORBIDDEN", "Forbidden to list org members")
    }
    return success(c, await withRequestRls(c, (tx) => listShareMembers(tx, actor.orgId)))
  } catch (err) {
    return knowledgeErrorResponse(c, err)
  }
})

// ---------------------------------------------------------------------------
// Org roles — GET /roles (for the share picker's "share with a role" surface)
// ---------------------------------------------------------------------------
//
// Any member who may share a document (knowledge read/admin scope) may list org
// ROLES to share it with. kernel.roles' `roles_org_rls` policy already lets any
// org member read all roles in their org, so this widens nothing; it exposes a
// minimal (roleId, name, memberCount) projection for the non-admin share dialog
// — parallel to /members. NOT the admin roles surface (/api/admin/roles), which
// stays gated on kernel:users:admin.
knowledgeRoutes.get("/roles", async (c) => {
  try {
    const actor = getActor(c)
    if (
      !hasScope("knowledge:documents:read", actor.scopes) &&
      !hasScope("knowledge:documents:admin", actor.scopes)
    ) {
      throw new KnowledgeError("FORBIDDEN", "Forbidden to list org roles")
    }
    return success(c, await withRequestRls(c, (tx) => listShareRoles(tx, actor.orgId)))
  } catch (err) {
    return knowledgeErrorResponse(c, err)
  }
})

// ---------------------------------------------------------------------------
// Federated search — POST /search
// ---------------------------------------------------------------------------
//
// Empty queries return an empty result without fanning out to remote sources
// (spec §283). Non-empty queries search local Knowledge and every app that
// declares `knowledgeItems.search` for the caller (source-registry.ts). The local
// MeiliSearch path requires the kernel search service to be invoked with
// already-expanded grants (knowledgeActorFromContext takes care of this).

knowledgeRoutes.post("/search", zValidator("json", knowledgeFederatedSearchSchema), async (c) => {
  try {
    const actor = getActor(c)
    const input = c.req.valid("json")
    // Remote sources are apps woken for this search: no transaction is held
    // across them (each DB step below opens its own).
    const registry = await registerDefaultKnowledgeSources({
      orgId: actor.orgId,
      userId: actor.userId,
      scopes: actor.scopes,
      searchPolicy: await withRequestRls(c, (tx) => loadSearchPolicies(tx)),
    })
    const result = await federatedKnowledgeSearch(
      {
        query: input.query,
        limit: input.limit,
        mode: input.mode,
        sources: input.sources,
        cursors: input.cursors,
        filters: input.filters,
      },
      {
        actor,
        registry,
        // Local-knowledge adapter: query the kernel MeiliSearch index
        // for the caller's `knowledge_document` + `knowledge_source_link`
        // entries and project each Meili hit into the canonical
        // `KnowledgeSearchHit` shape so the federated fuser can rank
        // them alongside Drive/other remote hits.
        localSearch: async () => {
          const q = input.query.trim()
          if (!q) {
            return {
              hits: [],
              status: {
                source: "knowledge",
                state: "skipped",
                retryable: false,
                hitCount: 0,
              },
            }
          }
          try {
            const limit = Math.min(Math.max(input.limit ?? 20, 1), 20)
            // Narrowed to Knowledge in the engine (local-search.ts), then paged
            // through the read guard: the index can lag an archive/delete, so
            // a hit whose row is archived, gone or unreadable is never returned
            // (opening it would return not_found) nor counted.
            const kept = await searchLocalKnowledge({
              actor,
              q,
              limit,
              keep: (indexed) =>
                withRequestRls(c, (tx) =>
                  dropArchivedKnowledgeHits(tx, actor.orgId, indexed, actor),
                ),
            })
            const { hits, syncedAppByDocId } = await withRequestRls(c, async (tx) => {
              const hits = kept
              // Tag document hits that are mirrored from an external synced
              // source so the UI can mark their provenance. One JOIN over just
              // the returned doc ids (RLS-scoped via tx); a doc whose source
              // row is invisible simply stays unbadged.
              const docHitIds = hits
                .filter((h) => h.type === "document")
                .map((h) => h.sourceEntityId)
              let syncedAppByDocId = new Map<string, string>()
              if (docHitIds.length > 0) {
                const syncedRows = extractRows<{ id: string; app_name: string }>(
                  await tx.execute(sql`
                    SELECT d.id, ss.app_name
                    FROM ${knowledgeRel("documents")} d
                    JOIN ${knowledgeRel("synced_sources")} ss ON ss.id = d.synced_source_id
                    WHERE d.synced_source_id IS NOT NULL
                      AND d.id IN (${sql.join(
                        docHitIds.map((i) => sql`${i}::uuid`),
                        sql`,`,
                      )})
                  `),
                )
                syncedAppByDocId = new Map(syncedRows.map((r) => [r.id, r.app_name]))
              }
              return { hits, syncedAppByDocId }
            })
            const enrichedHits = attachSyncedSourceApp(hits, syncedAppByDocId)
            return {
              hits: enrichedHits,
              status: {
                source: "knowledge",
                state: "complete" as const,
                retryable: false,
                hitCount: enrichedHits.length,
              },
            }
          } catch (err) {
            // Server-side: log the real error so ops can diagnose. The
            // outgoing source-status message is scrubbed (BS-6) — the
            // client never sees this string.
            const logger = c.get("logger") as
              | { error?: (b: Record<string, unknown>, msg: string) => void }
              | undefined
            logger?.error?.(
              {
                err: (err as Error)?.stack ?? String(err),
                cause:
                  ((err as { cause?: unknown })?.cause as Error)?.stack ??
                  String((err as { cause?: unknown })?.cause),
                orgId: actor.orgId,
                userId: actor.userId,
                meiliHost: process.env.MEILISEARCH_HOST ?? "(default)",
                hasMeiliKey: !!process.env.MEILISEARCH_API_KEY,
              },
              "knowledge_local_search_failed",
            )
            return {
              hits: [],
              status: {
                source: "knowledge",
                state: "error" as const,
                retryable: true,
                message: (err as Error)?.message,
                hitCount: 0,
              },
            }
          }
        },
      },
    )
    // BS-6: scrub adapter-supplied error messages on the wire — only the
    // `complete` state may carry an adapter message. Closes the leak surface
    // for any current or future error state (unauthorized, rate-limited,
    // unavailable, error, ...) without coupling the route to specific codes.
    return success(c, {
      ...result,
      sourceStatuses: scrubSourceStatuses(result.sourceStatuses),
    })
  } catch (err) {
    return knowledgeErrorResponse(c, err)
  }
})

// ---------------------------------------------------------------------------
// Remote source linking — POST /source-links (B4)
// ---------------------------------------------------------------------------

/**
 * Create a source link by linking a remote document. The registry is
 * request-scoped so each call gets a Drive adapter wired with a per-request
 * OAuth token resolver — never a cached process-global stub.
 */
knowledgeRoutes.post("/source-links", zValidator("json", knowledgeLinkRemoteSchema), async (c) => {
  try {
    const actor = getActor(c)
    const input = c.req.valid("json")
    // The source's app resolves the item outside any transaction; a source the
    // org has not enabled is a 422 SOURCE_NOT_ENABLED (a precondition, not an
    // outage), an unreachable one a 503 SOURCE_UNAVAILABLE.
    const registry = await registerDefaultKnowledgeSources({
      orgId: actor.orgId,
      userId: actor.userId,
      scopes: actor.scopes,
    })
    const link = await linkRemoteDocument((fn) => withRequestRls(c, fn), input, registry, actor)
    return success(c, link, undefined, 201)
  } catch (err) {
    return knowledgeErrorResponse(c, err)
  }
})

// ---------------------------------------------------------------------------
// Source link lifecycle — get/verify/refresh/archive (spec §466)
// ---------------------------------------------------------------------------

knowledgeRoutes.get("/source-links/:id", zValidator("param", idParamSchema), async (c) => {
  try {
    const actor = getActor(c)
    const { id } = c.req.valid("param")
    const row = await withRequestRls(c, (tx) => loadSourceLink(tx, id, actor))
    if (!row) throw new KnowledgeError("NOT_FOUND", "Source link not found")
    return success(c, row)
  } catch (err) {
    return zeroKnowledgeResponse(c, err)
  }
})

knowledgeRoutes.post("/source-links/:id/verify", zValidator("param", idParamSchema), async (c) => {
  try {
    const actor = getActor(c)
    const { id } = c.req.valid("param")
    const registry = await registerDefaultKnowledgeSources({
      orgId: actor.orgId,
      userId: actor.userId,
      scopes: actor.scopes,
    })
    const result = await verifySourceLink((fn) => withRequestRls(c, fn), id, registry, actor)
    return success(c, result)
  } catch (err) {
    return zeroKnowledgeResponse(c, err)
  }
})

knowledgeRoutes.post("/source-links/:id/refresh", zValidator("param", idParamSchema), async (c) => {
  try {
    const actor = getActor(c)
    const { id } = c.req.valid("param")
    const registry = await registerDefaultKnowledgeSources({
      orgId: actor.orgId,
      userId: actor.userId,
      scopes: actor.scopes,
    })
    const result = await refreshSourceLinkMetadata(
      (fn) => withRequestRls(c, fn),
      id,
      registry,
      actor,
    )
    return success(c, result)
  } catch (err) {
    return zeroKnowledgeResponse(c, err)
  }
})

knowledgeRoutes.post("/source-links/:id/archive", zValidator("param", idParamSchema), async (c) => {
  try {
    const actor = getActor(c)
    const { id } = c.req.valid("param")
    const result = await withRequestRls(c, (tx) => archiveSourceLink(tx, id, actor))
    return success(c, result)
  } catch (err) {
    return zeroKnowledgeResponse(c, err)
  }
})

// ---------------------------------------------------------------------------
// Source telemetry — zero-cache invariant under default remote_search policy
// ---------------------------------------------------------------------------

/**
 * Registered source ids: "knowledge" and every app of the org that declares a
 * `knowledgeItems.search` (its `broadSearchEnabled` switches it in federated
 * search). The allowlist keeps callers from probing arbitrary source names.
 */
function isRegisteredSource(orgId: string, source: string): boolean {
  if (source === "knowledge") return true
  return knowledgeItemsRegistry.get([orgId, source])?.decl.search !== undefined
}

knowledgeRoutes.get("/sources/:source", async (c) => {
  const source = c.req.param("source")
  if (!isRegisteredSource(getActor(c).orgId, source)) {
    return c.json({ error: { message: "Source not found", code: "NOT_FOUND" } }, 404)
  }
  try {
    const actor = getActor(c)
    const row = await withRequestRls(c, (tx) => loadSourcePolicy(tx, source, actor))
    return success(c, row)
  } catch (err) {
    return knowledgeErrorResponse(c, err)
  }
})

knowledgeRoutes.patch(
  "/sources/:source",
  zValidator("json", knowledgeSourcePolicyPatchSchema),
  async (c) => {
    const source = c.req.param("source")
    if (!isRegisteredSource(getActor(c).orgId, source)) {
      return c.json({ error: { message: "Source not found", code: "NOT_FOUND" } }, 404)
    }
    try {
      const actor = getActor(c)
      const row = await withRequestRls(c, (tx) =>
        updateSourcePolicy(tx, source, c.req.valid("json"), actor),
      )
      return success(c, row)
    } catch (err) {
      return knowledgeErrorResponse(c, err)
    }
  },
)

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Collections (T6)
// ---------------------------------------------------------------------------

knowledgeRoutes.get("/collections/tree", async (c) => {
  const actor = getActor(c)
  const tree = await withRequestRls(c, (tx) => listKnowledgeCollectionTree(tx, actor))
  return success(c, tree)
})

knowledgeRoutes.get("/collections", async (c) => {
  const actor = getActor(c)
  const rows = await withRequestRls(c, (tx) => listKnowledgeCollections(tx, actor))
  return success(c, rows)
})

knowledgeRoutes.post("/collections", zValidator("json", knowledgeCollectionSchema), async (c) => {
  try {
    const actor = getActor(c)
    const row = await withRequestRls(c, (tx) =>
      createKnowledgeCollection(tx, c.req.valid("json"), actor),
    )
    return success(c, row, undefined, 201)
  } catch (err) {
    return knowledgeErrorResponse(c, err)
  }
})

knowledgeRoutes.patch(
  "/collections/:id",
  zValidator("param", idParamSchema),
  zValidator("json", knowledgeCollectionPatchSchema),
  async (c) => {
    try {
      const actor = getActor(c)
      const { id } = c.req.valid("param")
      const row = await withRequestRls(c, (tx) =>
        updateKnowledgeCollection(tx, id, c.req.valid("json"), actor),
      )
      return success(c, row)
    } catch (err) {
      return zeroKnowledgeResponse(c, err)
    }
  },
)

knowledgeRoutes.post("/collections/:id/archive", zValidator("param", idParamSchema), async (c) => {
  try {
    const actor = getActor(c)
    const { id } = c.req.valid("param")
    const row = await withRequestRls(c, (tx) => archiveKnowledgeCollection(tx, id, actor))
    return success(c, row)
  } catch (err) {
    return zeroKnowledgeResponse(c, err)
  }
})

knowledgeRoutes.post(
  "/collections/:id/members",
  zValidator("param", idParamSchema),
  zValidator("json", knowledgeCollectionMembershipSchema),
  async (c) => {
    try {
      const actor = getActor(c)
      const { id } = c.req.valid("param")
      const row = await withRequestRls(c, (tx) =>
        addCollectionMembership(tx, { collectionId: id, ...c.req.valid("json") }, actor),
      )
      return success(c, row, undefined, 201)
    } catch (err) {
      return zeroKnowledgeResponse(c, err)
    }
  },
)

knowledgeRoutes.delete(
  "/collections/:id/members",
  zValidator("param", idParamSchema),
  zValidator("json", knowledgeCollectionMembershipSchema),
  async (c) => {
    try {
      const actor = getActor(c)
      const { id } = c.req.valid("param")
      await withRequestRls(c, (tx) =>
        removeCollectionMembership(tx, { collectionId: id, ...c.req.valid("json") }, actor),
      )
      return success(c, { ok: true })
    } catch (err) {
      return zeroKnowledgeResponse(c, err)
    }
  },
)

// ---------------------------------------------------------------------------
// Tags (T7)
// ---------------------------------------------------------------------------

knowledgeRoutes.get("/tags", async (c) => {
  const actor = getActor(c)
  const rows = await withRequestRls(c, (tx) => listKnowledgeTags(tx, actor))
  return success(c, rows)
})

knowledgeRoutes.post("/tags", zValidator("json", knowledgeTagSchema), async (c) => {
  try {
    const actor = getActor(c)
    const row = await withRequestRls(c, (tx) => upsertKnowledgeTag(tx, c.req.valid("json"), actor))
    return success(c, row, undefined, 201)
  } catch (err) {
    return knowledgeErrorResponse(c, err)
  }
})

knowledgeRoutes.get("/home", async (c) => {
  const actor = getActor(c)
  const { recent, needsReview, unfiledCount } = await withRequestRls(c, async (tx) => {
    const recent = await listKnowledgeDocuments(tx, actor, { limit: 20 })
    // IC-3: needsReview is a separate query — not a filter of recent — so
    // review-needing entries that fell off the recency window still surface.
    const needsReview = await listKnowledgeDocuments(tx, actor, { limit: 50 })
    const unfiled = await listKnowledgeDocuments(tx, actor, { limit: 200, unfiled: true })
    return {
      recent,
      needsReview: needsReview.filter(
        (d) => d.reviewStatus === "needs_review" || d.reviewStatus === "stale",
      ),
      unfiledCount: unfiled.length,
    }
  })
  // Surface a clean display title alongside the canonical title so the
  // "Recently touched" list never shows a raw import filename ("11-presets.md").
  // The stored `title` is left untouched (edit surfaces still key off it).
  const withDisplayTitle = <T extends { title: string; body?: string | null }>(d: T) => ({
    ...d,
    displayTitle: knowledgeDisplayTitle(d.title, d.body),
  })
  return success(c, {
    personal: recent.filter((d) => d.documentScope === "personal").map(withDisplayTitle),
    recent: recent.map(withDisplayTitle),
    needsReview: needsReview.map(withDisplayTitle),
    unfiledCount,
    sourceHealth: [],
  })
})

// ---------------------------------------------------------------------------
// Synced sources (T-8)
// ---------------------------------------------------------------------------

// C3: folderRef is forwarded to the source adapter, so it stays a POSITIVE
// allowlist (never whitespace, quotes, or control chars). Two id shapes share
// this route:
//   - Drive: a file id, e.g. "root1234" — charset [A-Za-z0-9_-].
//   - GitLab: the "<projectId>:<branch>:<pathPrefix>" triple, e.g. "123:main:docs"
//     or "123:main:docs/chapter-1" — needs ':', '/', and '.' as well.
// Both id families are safe to interpolate downstream: Drive re-validates against
// its own file-id charset in the adapter (defense-in-depth), and GitLab parses the
// triple then URL-encodes each segment via `encodeURIComponent`. The added chars
// ('.', '/', ':') do not open a query-injection hole for either consumer.
const FOLDER_REF_RE = /^[A-Za-z0-9_:./-]{8,512}$/
const syncedSourceCreateSchema = z
  .object({
    appName: z.string().min(1).max(64),
    folderRef: z
      .string()
      .regex(FOLDER_REF_RE, "folderRef must be 8–512 chars [A-Za-z0-9_:./-]")
      .optional(),
    /** An app-declared knowledge source kind (app-sources.ts) instead of a folder. */
    sourceKind: z
      .string()
      .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/)
      .max(64)
      .optional(),
    sourceConfig: z.record(z.string(), z.unknown()).optional(),
    displayName: z.string().min(1).max(200),
    syncIntervalSeconds: z.number().int().min(60),
    scope: z.enum(["personal", "organization"]),
    defaultSensitivity: z
      .enum(["public", "internal", "confidential", "restricted"])
      .nullable()
      .optional(),
  })
  .refine((v) => Boolean(v.sourceKind) !== Boolean(v.folderRef), {
    message: "give either folderRef (a folder source) or sourceKind (an app source)",
  })

const syncedSourcePatchSchema = z.object({
  displayName: z.string().min(1).optional(),
  syncIntervalSeconds: z.number().int().min(60).optional(),
})

knowledgeRoutes.get("/synced-sources", async (c) => {
  try {
    const actor = getActor(c)
    const rows = await withRequestRls(c, (tx) => listSyncedSources(tx, actor))
    return success(c, rows)
  } catch (err) {
    return knowledgeErrorResponse(c, err)
  }
})

// The knowledge source kinds installed apps declare that the caller may add. Adding any
// source takes at least the knowledge reader floor, so a caller below it gets no list.
knowledgeRoutes.get("/synced-sources/kinds", async (c) => {
  try {
    const actor = getActor(c)
    requireKnowledgeReader(actor)
    const { listAppSourceKinds } = await import("~/apps/knowledge/app-sources")
    return success(c, listAppSourceKinds(actor))
  } catch (err) {
    return knowledgeErrorResponse(c, err)
  }
})

knowledgeRoutes.post("/synced-sources", zValidator("json", syncedSourceCreateSchema), async (c) => {
  try {
    const actor = getActor(c)
    const input = c.req.valid("json")
    const folderRef = input.folderRef ?? ""
    // A folder of an app whose own `folder` source kind syncs it (no adapter here).
    const { listAppSourceKinds } = await import("~/apps/knowledge/app-sources")
    const folderKind =
      !input.sourceKind && folderRef
        ? listAppSourceKinds(actor).find((k) => k.appName === input.appName && k.kind === "folder")
        : undefined
    if (input.sourceKind || folderKind) {
      // An app source: the kind's own checks replace the folder precheck.
      const sourceKind = input.sourceKind ?? "folder"
      const sourceConfig = folderKind ? { ref: folderRef } : (input.sourceConfig ?? {})
      const ref = typeof sourceConfig.ref === "string" ? sourceConfig.ref : null
      const row = await withRequestRls(c, (tx) =>
        createSyncedSource(
          tx,
          {
            ...input,
            sourceKind,
            sourceConfig,
            folderRef: ref ?? `app-source:${sourceKind}`,
          },
          actor,
        ),
      )
      return success(c, row, undefined, 201)
    }
    const registry = await registerDefaultKnowledgeSources({
      orgId: actor.orgId,
      userId: actor.userId,
      scopes: actor.scopes,
    })
    const row = await withRequestRls(c, async (tx) => {
      const adapter = registry
        .listEnabled(actor)
        .find((a) => a.source === input.appName && isFolderSourceCapable(a))
      // I1: if no adapter is registered/enabled, fail loud rather than
      // silently skipping the H-5 precheck. Persisting an unverified row
      // would leave an orphan row + collection that never syncs successfully.
      if (!adapter) {
        throw new KnowledgeError(
          "SOURCE_UNAVAILABLE",
          `No connection enabled for ${input.appName}; connect the app first`,
        )
      }
      return createSyncedSource(tx, { ...input, folderRef }, actor, { adapter })
    })
    return success(c, row, undefined, 201)
  } catch (err) {
    return knowledgeErrorResponse(c, err)
  }
})

knowledgeRoutes.patch(
  "/synced-sources/:id",
  zValidator("param", idParamSchema),
  zValidator("json", syncedSourcePatchSchema),
  async (c) => {
    try {
      const actor = getActor(c)
      const { id } = c.req.valid("param")
      const patch = c.req.valid("json")
      const row = await withRequestRls(c, (tx) => updateSyncedSource(tx, id, patch, actor))
      return success(c, row)
    } catch (err) {
      return knowledgeErrorResponse(c, err)
    }
  },
)

knowledgeRoutes.delete("/synced-sources/:id", zValidator("param", idParamSchema), async (c) => {
  try {
    const actor = getActor(c)
    const { id } = c.req.valid("param")
    await withRequestRls(c, (tx) => archiveSyncedSource(tx, id, actor))
    return success(c, { ok: true })
  } catch (err) {
    return knowledgeErrorResponse(c, err)
  }
})

knowledgeRoutes.post(
  "/synced-sources/:id/run-now",
  zValidator("param", idParamSchema),
  async (c) => {
    try {
      const actor = getActor(c)
      const { id } = c.req.valid("param")
      // C1: load + authorize the source BEFORE enqueueing. `loadSyncedSource`
      // is RLS-scoped and includes the explicit `org_id = actor.orgId`
      // predicate, so a cross-org id collapses to NOT_FOUND (zero-knowledge).
      // `assertCanForceSyncedSource` then checks owner for personal sources
      // and `knowledge:sources:manage` for org-shared sources. Without this,
      // any authenticated user could enumerate cross-org source ids and burn
      // worker capacity / OAuth quota on sources they cannot see.
      await withRequestRls(c, async (tx) => {
        const existing = await loadSyncedSource(tx, id, actor)
        if (!existing) throw new KnowledgeError("NOT_FOUND", "Synced source not found")
        assertCanForceSyncedSource(existing, actor)
      })
      await enqueueAppJob(
        "knowledge",
        "sync-source",
        { sourceId: id, trigger: "force-on-open", enqueuedBy: actor.userId },
        { jobId: `sync:${id}` },
      )
      return success(c, { enqueued: true })
    } catch (err) {
      // Zero-knowledge: forbidden access to a synced source is reported as
      // not-found to avoid leaking existence by status code.
      return zeroKnowledgeResponse(c, err)
    }
  },
)

// ---------------------------------------------------------------------------
// Test-only: synchronous reconciliation endpoint.
//
// E2E tests need a deterministic "the sync completed" signal without polling
// the BullMQ worker (which adds flakiness and ~1s of latency per test). This
// endpoint is mounted ONLY under the same gate as the /api/_test/* routes in
// app.ts: `qaSeedRoutesEnabled` (NODE_ENV=test, or ENABLE_QA_SEED_ROUTES, which
// env.ts refuses to boot with in production).
//
// The route still goes through the same authz path as `/run-now` (load via
// RLS + `assertCanForceSyncedSource`) so a misuse cannot bypass authorization
// even in a dev environment.
// ---------------------------------------------------------------------------
if (qaSeedRoutesEnabled) {
  knowledgeRoutes.post(
    "/synced-sources/:id/_test_sync_now",
    zValidator("param", idParamSchema),
    async (c) => {
      try {
        const actor = getActor(c)
        const { id } = c.req.valid("param")
        const source = await withRequestRls(c, async (tx) => {
          const existing = await loadSyncedSource(tx, id, actor)
          if (!existing) throw new KnowledgeError("NOT_FOUND", "Synced source not found")
          assertCanForceSyncedSource(existing, actor)
          return existing
        })
        const { runSyncWorker } = await import("~/apps/knowledge/knowledge-jobs")
        // Capture the reconcile stats so test failures show *why* the sync
        // produced no documents (fetch errors, pagination cap, etc.).
        let capturedStats: unknown = null
        const { reconcileSyncedSource } = await import("~/apps/knowledge/sync-reconciler")
        await runSyncWorker(
          {
            sourceId: source.id,
            trigger: "force-on-open",
            enqueuedBy: actor.userId,
          },
          {
            reconcile: async (s, a) => {
              const stats = await reconcileSyncedSource(s, a)
              capturedStats = stats
              return stats
            },
          },
        )
        return success(c, { reconciled: true, stats: capturedStats })
      } catch (err) {
        return zeroKnowledgeResponse(c, err)
      }
    },
  )
}
