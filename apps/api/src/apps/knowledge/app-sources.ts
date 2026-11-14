// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * app-sources.ts: knowledge sources an app declares, synced page by page.
 *
 * An app declares source kinds in its manifest (`knowledgeSources.<kind>`:
 * title, handler, readScope, configSchema, timeoutMs). A synced source of such
 * a kind (`synced_sources.source_kind`) is synced by the Knowledge job
 * (knowledge-jobs.ts) through `runAppSourceSync`: it wakes the kind's handler in
 * the app's sandbox with `{ sourceId, kind, config, cursor }` and receives one
 * page `{ documents: { upsert, delete }, nextCursor, done, prune? }`.
 *
 * - Each page is written in ONE privileged transaction together with the new
 *   cursor, behind a compare-and-set on `sync_generation`: a page is applied
 *   once, a crash before its commit leaves the previous cursor (the next run
 *   asks for the same page again), and of two concurrent runs only one applies.
 * - A job runs pages while it has budget (`APP_SOURCE_LIMITS`), then hands the
 *   rest to a continuation job; one page is one run, bounded by the
 *   "knowledge-sync" row of the run-limit table (modules/apps/run-limits.ts).
 * - A pass starts when a sync begins with no pass open (`sync_pass_started_at`)
 *   and ends on `done`. The cursor of the final page is kept: the next pass
 *   starts from it (an incremental sync), or from null when the app returns
 *   none. `prune: true` on the final page archives the source's documents the
 *   pass did not upsert (a full listing).
 * - Provenance is the folder sources' own: `source_identities` per external id
 *   (source = the app's name), documents carrying `synced_source_id` and
 *   `source_identity_id`, in the source's root collection.
 *
 * The in-tree folder adapters (source-registry.ts) keep their own path:
 * a source with no `source_kind` never comes here.
 */
import { sql as drizzleSql } from "drizzle-orm"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import { type KnowledgeActor, KnowledgeError } from "~/apps/knowledge/service"
import {
  reparentMembership,
  sanitizeExternalString,
  syncedCollectionMarker,
  TITLE_MAX,
  upsertSourceIdentity,
  upsertSyncedCollection,
  upsertSyncedDocument,
} from "~/apps/knowledge/sync-reconciler"
import type { SyncedSourceRow } from "~/apps/knowledge/synced-sources"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { jobsLogger as log } from "~/lib/logger"
import {
  type KnowledgeSourceKindDecl,
  knowledgeSourceKindRegistry,
} from "~/modules/apps/app-registries"
import { createParamValidatorCache } from "~/modules/apps/param-validator"
import { hasScope } from "~/modules/permissions/permissions"

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

/** What one page may carry, and how much one sync job may do before it hands over. */
export const APP_SOURCE_LIMITS = {
  /** Documents upserted by one page. */
  maxUpserts: 200,
  /** External ids deleted by one page. */
  maxDeletes: 1_000,
  /** One document's body, in characters. */
  maxBodyChars: 1_000_000,
  /** An external id, in characters. */
  maxExternalIdChars: 512,
  /** The cursor, as JSON. */
  maxCursorBytes: 16_384,
  /** Folders one page declares, those its documents' paths add included. */
  maxFolderUpserts: 500,
  /** Folders one page deletes. */
  maxFolderDeletes: 1_000,
  /** Segments of a document's folder path. */
  maxFolderDepth: 32,
  /** Pages one job runs before it hands the rest to a continuation. */
  maxPagesPerJob: 25,
  /** No new page starts in a job after this much of its time. */
  jobBudgetMs: 60_000,
}

export type AppSourceLimits = typeof APP_SOURCE_LIMITS

/** One document an app source returns. */
export interface AppSourceDocument {
  /** The provider's stable id: the document's identity across syncs. */
  externalId: string
  title: string
  /** The document's text (markdown or plain text). */
  body: string
  url?: string
  mimeType?: string
  modifiedAt?: string
  /** The provider's revision (etag, commit, version): kept as the document's external revision. */
  rev?: string
  /** A path to show for the document; its title when absent. */
  path?: string
  /**
   * The folder the document is filed in: a folder's external id (declared by
   * this page or an earlier one, or derived from a `folderPath`). Absent: the
   * source's root collection.
   */
  folderId?: string
}

/**
 * One folder of an app source: a collection under the source's root, found
 * again across syncs by its external id (so a rename or a move keeps it).
 */
export interface AppSourceFolder {
  externalId: string
  name: string
  /** The parent folder's external id; null: directly under the source's root. */
  parentExternalId: string | null
}

/** One page, parsed and checked. */
export interface AppSourcePage {
  upserts: AppSourceDocument[]
  deletes: string[]
  /** Folders to create, rename or move: declared ones and those document paths name. */
  folders?: AppSourceFolder[]
  /** Folders removed upstream, by external id: archived with what is still filed below them. */
  folderDeletes?: string[]
  nextCursor: unknown
  done: boolean
  prune: boolean
}

/** The input of one page's run, handed to the app's handler. */
export interface AppSourceSyncInput {
  sourceId: string
  kind: string
  config: Record<string, unknown>
  cursor: unknown
  /** Whose source it is: one person's own, or the organization's. */
  scope: "personal" | "organization"
}

/** A page the app returned that breaks the contract: the sync records it and writes nothing. */
export class AppSourceContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AppSourceContractError"
  }
}

/** Another run applied a page first: this run stops and writes nothing. */
export class AppSourceConflictError extends Error {
  constructor(sourceId: string) {
    super(`another sync of source ${sourceId} moved its cursor first`)
    this.name = "AppSourceConflictError"
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)

function optionalString(doc: Record<string, unknown>, key: string, at: string): string | undefined {
  const v = doc[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== "string") throw new AppSourceContractError(`${at}.${key} must be a string`)
  return v
}

/** Check one page against the contract and the limits. */
export function parseSyncResult(
  raw: unknown,
  limits: AppSourceLimits = APP_SOURCE_LIMITS,
): AppSourcePage {
  if (!isObject(raw)) throw new AppSourceContractError("a sync page must be an object")
  if (typeof raw.done !== "boolean") throw new AppSourceContractError("done must be a boolean")
  const documents = raw.documents === undefined ? {} : raw.documents
  if (!isObject(documents)) throw new AppSourceContractError("documents must be an object")
  const upsertRaw = documents.upsert ?? []
  const deleteRaw = documents.delete ?? []
  if (!Array.isArray(upsertRaw)) throw new AppSourceContractError("documents.upsert must be a list")
  if (!Array.isArray(deleteRaw)) throw new AppSourceContractError("documents.delete must be a list")
  if (upsertRaw.length > limits.maxUpserts) {
    throw new AppSourceContractError(
      `documents.upsert has ${upsertRaw.length} documents, at most ${limits.maxUpserts} per page`,
    )
  }
  if (deleteRaw.length > limits.maxDeletes) {
    throw new AppSourceContractError(
      `documents.delete has ${deleteRaw.length} ids, at most ${limits.maxDeletes} per page`,
    )
  }
  const checkId = (v: unknown, at: string): string => {
    if (typeof v !== "string" || v.length === 0 || v.length > limits.maxExternalIdChars) {
      throw new AppSourceContractError(
        `${at} must be a non-empty string of at most ${limits.maxExternalIdChars} characters`,
      )
    }
    return v
  }
  const { folders, folderDeletes, declared } = parseFolders(raw.folders, limits, checkId)
  const upserts: AppSourceDocument[] = []
  const seen = new Set<string>()
  upsertRaw.forEach((doc, i) => {
    const at = `documents.upsert[${i}]`
    if (!isObject(doc)) throw new AppSourceContractError(`${at} must be an object`)
    const externalId = checkId(doc.externalId, `${at}.externalId`)
    if (seen.has(externalId)) {
      throw new AppSourceContractError(`${at}.externalId "${externalId}" appears twice in the page`)
    }
    seen.add(externalId)
    if (typeof doc.title !== "string" || doc.title.trim().length === 0) {
      throw new AppSourceContractError(`${at}.title must be a non-empty string`)
    }
    if (typeof doc.body !== "string")
      throw new AppSourceContractError(`${at}.body must be a string`)
    if (doc.body.length > limits.maxBodyChars) {
      throw new AppSourceContractError(
        `${at}.body has ${doc.body.length} characters, at most ${limits.maxBodyChars}`,
      )
    }
    const url = optionalString(doc, "url", at)
    const mimeType = optionalString(doc, "mimeType", at)
    const modifiedAt = optionalString(doc, "modifiedAt", at)
    const rev = optionalString(doc, "rev", at)
    const path = optionalString(doc, "path", at)
    if (modifiedAt !== undefined && Number.isNaN(Date.parse(modifiedAt))) {
      throw new AppSourceContractError(`${at}.modifiedAt must be an ISO date`)
    }
    let folderId = optionalString(doc, "folderId", at)
    const folderPath = optionalString(doc, "folderPath", at)
    if (folderId !== undefined && folderPath !== undefined) {
      throw new AppSourceContractError(`${at} has both folderId and folderPath; give one`)
    }
    if (folderId !== undefined) folderId = checkId(folderId, `${at}.folderId`)
    if (folderPath !== undefined) {
      folderId = addPathFolders(folderPath, `${at}.folderPath`, folders, declared, limits)
    }
    if (folderId !== undefined && folderDeletes.includes(folderId)) {
      throw new AppSourceContractError(
        `${at} is filed in folder "${folderId}", which the page deletes`,
      )
    }
    upserts.push({
      externalId,
      title: doc.title,
      body: doc.body,
      ...(url !== undefined ? { url } : {}),
      ...(mimeType !== undefined ? { mimeType } : {}),
      ...(modifiedAt !== undefined ? { modifiedAt } : {}),
      ...(rev !== undefined ? { rev } : {}),
      ...(path !== undefined ? { path } : {}),
      ...(folderId !== undefined ? { folderId } : {}),
    })
  })
  checkFolderDeletes(folders, folderDeletes)
  if (folders.length > limits.maxFolderUpserts) {
    throw new AppSourceContractError(
      `the page declares ${folders.length} folders (paths included), at most ${limits.maxFolderUpserts}`,
    )
  }
  const deletes = deleteRaw.map((v, i) => checkId(v, `documents.delete[${i}]`))
  const both = deletes.find((id) => seen.has(id))
  if (both) {
    throw new AppSourceContractError(`"${both}" is both upserted and deleted in one page`)
  }
  const nextCursor = raw.nextCursor === undefined ? null : raw.nextCursor
  let cursorJson: string | undefined
  try {
    cursorJson = JSON.stringify(nextCursor)
  } catch {
    throw new AppSourceContractError("nextCursor must be JSON")
  }
  if (cursorJson === undefined) throw new AppSourceContractError("nextCursor must be JSON")
  if (Buffer.byteLength(cursorJson) > limits.maxCursorBytes) {
    throw new AppSourceContractError(`nextCursor is larger than ${limits.maxCursorBytes} bytes`)
  }
  if (!raw.done && nextCursor === null) {
    throw new AppSourceContractError("a page that is not done must return a nextCursor")
  }
  if (raw.prune !== undefined && typeof raw.prune !== "boolean") {
    throw new AppSourceContractError("prune must be a boolean")
  }
  return {
    upserts,
    deletes,
    ...(folders.length > 0 ? { folders } : {}),
    ...(folderDeletes.length > 0 ? { folderDeletes } : {}),
    nextCursor: JSON.parse(cursorJson),
    done: raw.done,
    prune: raw.done && raw.prune === true,
  }
}

/** The page's `folders` block: declared folders and folder deletes, checked. */
function parseFolders(
  raw: unknown,
  limits: AppSourceLimits,
  checkId: (v: unknown, at: string) => string,
): { folders: AppSourceFolder[]; folderDeletes: string[]; declared: Map<string, AppSourceFolder> } {
  const folders: AppSourceFolder[] = []
  const declared = new Map<string, AppSourceFolder>()
  if (raw === undefined || raw === null) return { folders, folderDeletes: [], declared }
  if (!isObject(raw)) throw new AppSourceContractError("folders must be an object")
  const upsertRaw = raw.upsert ?? []
  const deleteRaw = raw.delete ?? []
  if (!Array.isArray(upsertRaw)) throw new AppSourceContractError("folders.upsert must be a list")
  if (!Array.isArray(deleteRaw)) throw new AppSourceContractError("folders.delete must be a list")
  if (upsertRaw.length > limits.maxFolderUpserts) {
    throw new AppSourceContractError(
      `folders.upsert has ${upsertRaw.length} folders, at most ${limits.maxFolderUpserts} per page`,
    )
  }
  if (deleteRaw.length > limits.maxFolderDeletes) {
    throw new AppSourceContractError(
      `folders.delete has ${deleteRaw.length} ids, at most ${limits.maxFolderDeletes} per page`,
    )
  }
  upsertRaw.forEach((f, i) => {
    const at = `folders.upsert[${i}]`
    if (!isObject(f)) throw new AppSourceContractError(`${at} must be an object`)
    const externalId = checkId(f.externalId, `${at}.externalId`)
    if (declared.has(externalId)) {
      throw new AppSourceContractError(`${at}.externalId "${externalId}" appears twice in the page`)
    }
    if (typeof f.name !== "string" || f.name.trim().length === 0) {
      throw new AppSourceContractError(`${at}.name must be a non-empty string`)
    }
    const parentExternalId =
      f.parentExternalId === undefined || f.parentExternalId === null
        ? null
        : checkId(f.parentExternalId, `${at}.parentExternalId`)
    if (parentExternalId === externalId) {
      throw new AppSourceContractError(`${at} cannot be its own parent`)
    }
    const folder = { externalId, name: f.name, parentExternalId }
    declared.set(externalId, folder)
    folders.push(folder)
  })
  const folderDeletes = deleteRaw.map((v, i) => checkId(v, `folders.delete[${i}]`))
  return { folders, folderDeletes, declared }
}

/** A page may not declare, or file anything in, a folder it deletes. */
function checkFolderDeletes(folders: AppSourceFolder[], folderDeletes: string[]): void {
  if (folderDeletes.length === 0) return
  const deleted = new Set(folderDeletes)
  for (const folder of folders) {
    if (deleted.has(folder.externalId)) {
      throw new AppSourceContractError(
        `folder "${folder.externalId}" is both declared and deleted in one page`,
      )
    }
    if (folder.parentExternalId && deleted.has(folder.parentExternalId)) {
      throw new AppSourceContractError(
        `folder "${folder.externalId}" is placed in folder "${folder.parentExternalId}", which the page deletes`,
      )
    }
  }
}

/**
 * A document's `folderPath` ("guides/setup"): each segment is a folder whose
 * external id is the path up to it ("guides", "guides/setup") and whose name
 * is the segment, unless the page declares that id itself. Returns the id of
 * the deepest folder.
 */
function addPathFolders(
  path: string,
  at: string,
  folders: AppSourceFolder[],
  declared: Map<string, AppSourceFolder>,
  limits: AppSourceLimits,
): string {
  const trimmed = path.replace(/^\/+|\/+$/g, "")
  const segments = trimmed.split("/")
  if (
    trimmed.length === 0 ||
    segments.some((s) => s.trim().length === 0 || s === "." || s === "..")
  ) {
    throw new AppSourceContractError(`${at} must be a path of non-empty folder names, like "a/b"`)
  }
  if (segments.length > limits.maxFolderDepth) {
    throw new AppSourceContractError(
      `${at} is ${segments.length} folders deep, at most ${limits.maxFolderDepth}`,
    )
  }
  if (trimmed.length > limits.maxExternalIdChars) {
    throw new AppSourceContractError(`${at} is longer than ${limits.maxExternalIdChars} characters`)
  }
  let parent: string | null = null
  for (let i = 0; i < segments.length; i++) {
    const id = segments.slice(0, i + 1).join("/")
    if (!declared.has(id)) {
      const folder = { externalId: id, name: segments[i]!, parentExternalId: parent }
      declared.set(id, folder)
      folders.push(folder)
    }
    parent = id
  }
  return trimmed
}

// ---------------------------------------------------------------------------
// Kinds: lookup and the checks at creation
// ---------------------------------------------------------------------------

/** The kind an app declares for an org, or null. */
export function findAppSourceKind(
  orgId: string,
  appName: string,
  kind: string,
): KnowledgeSourceKindDecl | null {
  return knowledgeSourceKindRegistry.get([orgId, appName])?.kinds[kind] ?? null
}

/**
 * Check a new app source before it is stored: the app declares the kind for
 * the actor's org, the actor holds the kind's read scope, and the config
 * matches its configSchema. Returns the config (defaults filled in).
 */
export function checkAppSourceKind(
  actor: KnowledgeActor,
  appName: string,
  kind: string,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const decl = findAppSourceKind(actor.orgId, appName, kind)
  if (!decl) {
    throw new KnowledgeError(
      "SOURCE_NOT_ENABLED",
      `${appName} offers no knowledge source "${kind}" here; install or enable the app first`,
    )
  }
  if (decl.readScope && !hasScope(decl.readScope, actor.scopes)) {
    throw new KnowledgeError("FORBIDDEN", `Missing ${decl.readScope}`)
  }
  if (!isObject(config)) throw new KnowledgeError("VALIDATION", "config must be an object")
  if (decl.configSchema) {
    const validate = configValidator(decl.configSchema)
    const value = structuredClone(config)
    if (!validate(value)) {
      const detail = (validate.errors ?? [])
        .map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`)
        .join("; ")
      throw new KnowledgeError("VALIDATION", `config: ${detail}`)
    }
    return value
  }
  return config
}

/** A kind's config check, compiled once per schema; fills the schema's defaults in. */
const configValidator = createParamValidatorCache({ allErrors: true, useDefaults: true })

/** The app source kinds of the actor's org that the actor may create a source of. */
export function listAppSourceKinds(actor: KnowledgeActor): Array<{
  appName: string
  kind: string
  title: string
  description?: string
  configSchema?: Record<string, unknown>
}> {
  const out: ReturnType<typeof listAppSourceKinds> = []
  for (const [key, entry] of knowledgeSourceKindRegistry.entriesOf(actor.orgId)) {
    const appName = key[1]
    if (key[0] !== actor.orgId || !appName) continue
    for (const [kind, decl] of Object.entries(entry.kinds)) {
      if (decl.readScope && !hasScope(decl.readScope, actor.scopes)) continue
      out.push({
        appName,
        kind,
        title: decl.title,
        ...(decl.description ? { description: decl.description } : {}),
        ...(decl.configSchema ? { configSchema: decl.configSchema } : {}),
      })
    }
  }
  return out.sort((a, b) => `${a.appName}:${a.kind}`.localeCompare(`${b.appName}:${b.kind}`))
}

// ---------------------------------------------------------------------------
// Persisted state: where the source's sync stands
// ---------------------------------------------------------------------------

export interface AppSourceState {
  cursor: unknown
  /** Bumped by every applied page: the compare-and-set token. */
  generation: number
  /** When the open pass started (ISO), or null between passes. */
  passStartedAt: string | null
}

export interface AppliedPage {
  state: AppSourceState
  upserted: number
  archived: number
}

/** Where the sync reads and writes; the database in production, memory in unit tests. */
export interface AppSourceStore {
  /** Mark the source running, open a pass when none is open, and read its state. */
  beginAppSourcePass(source: SyncedSourceRow): Promise<AppSourceState>
  /**
   * Write one page and its cursor in one transaction, only while the source is
   * still at `from.generation` (else AppSourceConflictError, nothing written).
   * A done page closes the pass and stamps the source ok.
   */
  applyAppSourcePage(
    source: SyncedSourceRow,
    from: AppSourceState,
    page: AppSourcePage,
  ): Promise<AppliedPage>
  /** Stamp a failed sync (cursor and pass kept: the next sync resumes). */
  failAppSourceSync(source: SyncedSourceRow, message: string): Promise<void>
}

const toIso = (v: unknown): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : String(v)

/** Mark the source running and open a pass when none is open (the database store's begin). */
async function beginAppSourcePass(source: SyncedSourceRow): Promise<AppSourceState> {
  const rows = extractRows<{
    sync_cursor: unknown
    sync_generation: number | null
    sync_pass_started_at: Date | string | null
  }>(
    await withPrivilegedDb(source.orgId, "knowledge-app-source-begin", (tx) =>
      tx.execute(drizzleSql`
          UPDATE ${knowledgeRel("synced_sources")}
          SET last_sync_status = 'running',
              sync_pass_started_at = COALESCE(
                sync_pass_started_at, date_trunc('milliseconds', now())
              ),
              updated_at = now()
          WHERE id = ${source.id}::uuid AND org_id = ${source.orgId}::uuid
          RETURNING sync_cursor, sync_generation, sync_pass_started_at
        `),
    ),
  )
  const row = rows[0]
  if (!row) throw new KnowledgeError("NOT_FOUND", `synced source ${source.id} not found`)
  return {
    cursor: row.sync_cursor ?? null,
    generation: Number(row.sync_generation ?? 0),
    passStartedAt: toIso(row.sync_pass_started_at),
  }
}

/** Write one page and its cursor behind the generation compare-and-set (the database store's applyPage). */
async function applyAppSourcePage(
  source: SyncedSourceRow,
  from: AppSourceState,
  page: AppSourcePage,
): Promise<AppliedPage> {
  return withPrivilegedDb(source.orgId, "knowledge-app-source-page", async (tx) => {
    // The compare-and-set first: it locks the source row, so a concurrent
    // run waits here and then finds the generation moved.
    const cursorJson = JSON.stringify(page.nextCursor ?? null)
    const moved = extractRows<{ sync_generation: number; at: Date | string }>(
      await tx.execute(drizzleSql`
          UPDATE ${knowledgeRel("synced_sources")}
          SET sync_cursor = ${cursorJson}::jsonb,
              sync_generation = sync_generation + 1,
              ${
                page.done
                  ? drizzleSql`sync_pass_started_at = NULL,
              last_sync_at = now(),
              last_sync_status = 'ok',
              last_error = NULL,`
                  : drizzleSql``
              }
              updated_at = now()
          WHERE id = ${source.id}::uuid
            AND org_id = ${source.orgId}::uuid
            AND sync_generation = ${from.generation}
          RETURNING sync_generation, now() AS at
        `),
    )
    if (!moved[0]) throw new AppSourceConflictError(source.id)
    const at = new Date(toIso(moved[0].at) ?? Date.now())
    // Folders: the source's collections below its root, found by their marker.
    const tree = await loadSourceFolders(tx, source)
    /** Folders that may have lost their last item in this page. */
    const emptied = new Set<string>()
    /** Folders this page declared or filed a document in: never archived as empty by it. */
    const keep = new Set<string>()
    if (tree.byId.size > 0) {
      for (const id of await currentDocumentFolders(tx, source, [
        ...page.upserts.map((d) => d.externalId),
        ...page.deletes,
      ])) {
        emptied.add(id)
      }
    }
    await upsertFolders(tx, source, tree, page.folders ?? [], { emptied, keep })
    const collectionFor = async (doc: AppSourceDocument): Promise<string> => {
      if (doc.folderId === undefined) return source.rootCollectionId
      const node = tree.byExternalId.get(doc.folderId)
      if (!node) {
        throw new AppSourceContractError(
          `document "${doc.externalId}" is filed in folder "${doc.folderId}", which this source never declared`,
        )
      }
      await reviveFolder(tx, source, tree, node, keep)
      keep.add(node.id)
      return node.id
    }
    const upserted = await writeUpserts(tx, source, page.upserts, at, collectionFor)
    const archivedIds = await archiveByExternalIds(tx, source, page.deletes)
    archivedIds.push(...(await deleteFolders(tx, source, tree, page.folderDeletes ?? [], emptied)))
    await archiveEmptyFolders(tx, source, tree, emptied, (id) => !keep.has(id))
    if (page.done && page.prune && from.passStartedAt) {
      archivedIds.push(...(await archiveNotSyncedSince(tx, source, from.passStartedAt)))
      // A folder this pass neither declared nor filed anything in, now empty.
      const passStarted = Date.parse(from.passStartedAt)
      const unseen = (id: string) => {
        const node = tree.byId.get(id)
        return !!node && !keep.has(id) && node.updatedAt < passStarted
      }
      await archiveEmptyFolders(
        tx,
        source,
        tree,
        new Set([...tree.byId.keys()].filter(unseen)),
        unseen,
      )
    }
    for (const id of archivedIds) {
      await tx.queueEvent({
        app: "knowledge",
        entity: "document",
        action: "archive",
        entityId: id,
        data: { id, syncedSourceId: source.id },
        actorId: source.createdBy,
        actorType: "system",
        orgId: source.orgId,
      })
    }
    return {
      state: {
        cursor: page.nextCursor ?? null,
        generation: Number(moved[0].sync_generation),
        passStartedAt: page.done ? null : from.passStartedAt,
      },
      upserted,
      archived: archivedIds.length,
    }
  })
}

/** Stamp a failed sync, keeping the cursor and the pass (the database store's fail). */
async function failAppSourceSync(source: SyncedSourceRow, message: string): Promise<void> {
  // `last_sync_at` advances on a failure too, so a permanent failure waits a
  // whole interval (sync-reconciler.ts says why).
  await withPrivilegedDb(source.orgId, "knowledge-app-source-fail", (tx) =>
    tx.execute(drizzleSql`
        UPDATE ${knowledgeRel("synced_sources")}
        SET last_sync_at = now(),
            last_sync_status = 'error',
            last_error = ${message.slice(0, 500)},
            updated_at = now()
        WHERE id = ${source.id}::uuid AND org_id = ${source.orgId}::uuid
      `),
  )
}

/** The production store: `app_knowledge.synced_sources` and the documents of the source. */
export const dbAppSourceStore: AppSourceStore = {
  beginAppSourcePass,
  applyAppSourcePage,
  failAppSourceSync,
}

async function writeUpserts(
  tx: PrivilegedDb,
  source: SyncedSourceRow,
  docs: AppSourceDocument[],
  at: Date,
  collectionFor: (doc: AppSourceDocument) => Promise<string>,
): Promise<number> {
  for (const doc of docs) {
    const collectionId = await collectionFor(doc)
    const identityId = await upsertSourceIdentity(tx, source.orgId, source.appName, {
      kind: "file",
      externalId: doc.externalId,
      name: doc.title,
      parentExternalId: source.folderRef,
      ...(doc.mimeType ? { mimeType: doc.mimeType } : {}),
      ...(doc.modifiedAt ? { modifiedAt: doc.modifiedAt } : {}),
      ...(doc.url ? { url: doc.url } : {}),
    })
    const externalRev = doc.rev ?? doc.modifiedAt ?? null
    const { id, bodyChanged } = await upsertSyncedDocument(tx, {
      source,
      identityId,
      title: doc.title,
      body: doc.body,
      externalPath: doc.path ?? doc.title,
      externalRev,
      lastSyncedAt: at,
    })
    await reparentMembership(
      tx,
      source.orgId,
      source.id,
      "document",
      id,
      collectionId,
      source.createdBy,
    )
    if (bodyChanged) {
      await tx.queueEvent({
        app: "knowledge",
        entity: "document",
        action: "update",
        entityId: id,
        data: { syncedSourceId: source.id, externalRev, lastSyncAt: at.toISOString() },
        actorId: source.createdBy,
        actorType: "system",
        orgId: source.orgId,
      })
    }
  }
  return docs.length
}

// ---------------------------------------------------------------------------
// Folders: the source's collections below its root
// ---------------------------------------------------------------------------

interface FolderNode {
  id: string
  externalId: string
  /** The parent collection: another folder of the source, or the source's root. */
  parentId: string | null
  archived: boolean
  /** updated_at, in ms: a folder declared during a pass was touched after the pass started. */
  updatedAt: number
}

interface SourceFolderTree {
  byExternalId: Map<string, FolderNode>
  byId: Map<string, FolderNode>
}

const idListSql = (ids: Iterable<string>) =>
  drizzleSql.join(
    [...ids].map((id) => drizzleSql`${id}::uuid`),
    drizzleSql`, `,
  )

/** Every folder the source created (archived ones too), by its marker `synced:<sourceId>:<externalId>`. */
async function loadSourceFolders(
  tx: PrivilegedDb,
  source: SyncedSourceRow,
): Promise<SourceFolderTree> {
  const prefix = syncedCollectionMarker(source.id, "")
  const rows = extractRows<{
    id: string
    parent_collection_id: string | null
    description: string
    archived: boolean
    updated_at: Date | string
  }>(
    await tx.execute(drizzleSql`
      SELECT id, parent_collection_id, description, archived_at IS NOT NULL AS archived, updated_at
      FROM ${knowledgeRel("collections")}
      WHERE org_id = ${source.orgId}::uuid
        AND id <> ${source.rootCollectionId}::uuid
        AND starts_with(description, ${prefix})
      ORDER BY created_at, id
    `),
  )
  const tree: SourceFolderTree = { byExternalId: new Map(), byId: new Map() }
  for (const r of rows) {
    const externalId = r.description.slice(prefix.length)
    if (tree.byExternalId.has(externalId)) continue
    const node: FolderNode = {
      id: r.id,
      externalId,
      parentId: r.parent_collection_id,
      archived: r.archived,
      updatedAt: Date.parse(toIso(r.updated_at) ?? "") || 0,
    }
    tree.byExternalId.set(externalId, node)
    tree.byId.set(r.id, node)
  }
  return tree
}

/** The folders the source's documents with these external ids are filed in now. */
async function currentDocumentFolders(
  tx: PrivilegedDb,
  source: SyncedSourceRow,
  externalIds: string[],
): Promise<string[]> {
  if (externalIds.length === 0) return []
  const ids = drizzleSql.join(
    externalIds.map((id) => drizzleSql`${id}`),
    drizzleSql`, `,
  )
  return extractRows<{ collection_id: string }>(
    await tx.execute(drizzleSql`
      SELECT DISTINCT cm.collection_id
      FROM ${knowledgeRel("documents")} AS d
      JOIN ${knowledgeRel("source_identities")} AS si ON si.id = d.source_identity_id
      JOIN ${knowledgeRel("collection_memberships")} AS cm
        ON cm.org_id = d.org_id AND cm.target_type = 'document' AND cm.target_id = d.id
      WHERE d.org_id = ${source.orgId}::uuid
        AND d.synced_source_id = ${source.id}::uuid
        AND si.source = ${source.appName}
        AND si.external_id IN (${ids})
    `),
  ).map((r) => r.collection_id)
}

/** Bring back an archived folder and its archived ancestors (a document or folder is filed in it again). */
async function reviveFolder(
  tx: PrivilegedDb,
  source: SyncedSourceRow,
  tree: SourceFolderTree,
  node: FolderNode,
  keep: Set<string>,
): Promise<void> {
  const revive: FolderNode[] = []
  for (
    let n: FolderNode | undefined = node;
    n?.archived;
    n = n.parentId ? tree.byId.get(n.parentId) : undefined
  ) {
    revive.push(n)
  }
  if (revive.length === 0) return
  await tx.execute(drizzleSql`
    UPDATE ${knowledgeRel("collections")}
    SET archived_at = NULL, updated_at = now()
    WHERE org_id = ${source.orgId}::uuid AND id IN (${idListSql(revive.map((n) => n.id))})
  `)
  for (const n of revive) {
    n.archived = false
    keep.add(n.id)
  }
}

/**
 * Create, rename or move the page's folders: parents first, wherever they sit
 * in the list. A parent must be a folder of this source (this page's or an
 * earlier one's); a folder never moves inside itself.
 */
async function upsertFolders(
  tx: PrivilegedDb,
  source: SyncedSourceRow,
  tree: SourceFolderTree,
  folders: AppSourceFolder[],
  sets: { emptied: Set<string>; keep: Set<string> },
): Promise<void> {
  const pending = new Map(folders.map((f) => [f.externalId, f]))
  while (pending.size > 0) {
    let progressed = false
    for (const folder of [...pending.values()]) {
      let parentId = source.rootCollectionId
      if (folder.parentExternalId !== null) {
        if (pending.has(folder.parentExternalId)) continue
        const parent = tree.byExternalId.get(folder.parentExternalId)
        if (!parent) {
          throw new AppSourceContractError(
            `folder "${folder.externalId}" is placed in folder "${folder.parentExternalId}", which this source never declared`,
          )
        }
        await reviveFolder(tx, source, tree, parent, sets.keep)
        parentId = parent.id
      }
      const existing = tree.byExternalId.get(folder.externalId)
      if (existing) {
        for (let at: string | null = parentId; at; at = tree.byId.get(at)?.parentId ?? null) {
          if (at === existing.id) {
            throw new AppSourceContractError(
              `folder "${folder.externalId}" cannot move into its own subfolder "${folder.parentExternalId}"`,
            )
          }
        }
      }
      const id = await upsertSyncedCollection(tx, new Map(), {
        sourceId: source.id,
        orgId: source.orgId,
        externalId: folder.externalId,
        name: sanitizeExternalString(folder.name, TITLE_MAX),
        parentCollectionId: parentId,
        ownerUserId: source.ownerUserId,
      })
      if (existing?.parentId && existing.parentId !== parentId) sets.emptied.add(existing.parentId)
      const node: FolderNode = {
        id,
        externalId: folder.externalId,
        parentId,
        archived: false,
        updatedAt: Date.now(),
      }
      tree.byExternalId.set(folder.externalId, node)
      tree.byId.set(id, node)
      sets.keep.add(id)
      pending.delete(folder.externalId)
      progressed = true
    }
    if (!progressed) {
      throw new AppSourceContractError(
        `folders ${[...pending.keys()].map((id) => `"${id}"`).join(", ")} are placed inside each other`,
      )
    }
  }
}

/**
 * Folders removed upstream: archive each with its subfolders and the source's
 * documents still filed there. Returns the archived documents' ids.
 */
async function deleteFolders(
  tx: PrivilegedDb,
  source: SyncedSourceRow,
  tree: SourceFolderTree,
  externalIds: string[],
  emptied: Set<string>,
): Promise<string[]> {
  const roots = externalIds
    .map((id) => tree.byExternalId.get(id))
    .filter((n): n is FolderNode => !!n && !n.archived)
  if (roots.length === 0) return []
  const children = new Map<string, FolderNode[]>()
  for (const node of tree.byId.values()) {
    if (!node.parentId) continue
    children.set(node.parentId, [...(children.get(node.parentId) ?? []), node])
  }
  const subtree = new Set<string>()
  const queue = [...roots]
  while (queue.length > 0) {
    const node = queue.shift()!
    if (subtree.has(node.id)) continue
    subtree.add(node.id)
    queue.push(...(children.get(node.id) ?? []))
  }
  await tx.execute(drizzleSql`
    UPDATE ${knowledgeRel("collections")}
    SET archived_at = now(), updated_at = now()
    WHERE org_id = ${source.orgId}::uuid
      AND id IN (${idListSql(subtree)})
      AND archived_at IS NULL
  `)
  for (const id of subtree) {
    const node = tree.byId.get(id)
    if (node) node.archived = true
  }
  for (const root of roots) {
    if (root.parentId && !subtree.has(root.parentId)) emptied.add(root.parentId)
  }
  return extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      UPDATE ${knowledgeRel("documents")} AS d
      SET archived_at = now(), updated_at = now()
      WHERE d.org_id = ${source.orgId}::uuid
        AND d.synced_source_id = ${source.id}::uuid
        AND d.archived_at IS NULL
        AND EXISTS (
          SELECT 1 FROM ${knowledgeRel("collection_memberships")} AS cm
          WHERE cm.org_id = d.org_id
            AND cm.target_type = 'document'
            AND cm.target_id = d.id
            AND cm.collection_id IN (${idListSql(subtree)})
        )
      RETURNING d.id
    `),
  ).map((r) => r.id)
}

/**
 * Archive the candidates that hold nothing any more (no live member, no live
 * subfolder), then their parents in turn. Only the source's own folders are
 * candidates, never its root; anything a person filed in a folder keeps it.
 */
async function archiveEmptyFolders(
  tx: PrivilegedDb,
  source: SyncedSourceRow,
  tree: SourceFolderTree,
  candidates: Set<string>,
  eligible: (id: string) => boolean,
): Promise<number> {
  let archived = 0
  let round = [...candidates].filter((id) => {
    const node = tree.byId.get(id)
    return !!node && !node.archived && eligible(id)
  })
  while (round.length > 0) {
    const rows = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        UPDATE ${knowledgeRel("collections")} AS c
        SET archived_at = now(), updated_at = now()
        WHERE c.org_id = ${source.orgId}::uuid
          AND c.id IN (${idListSql(round)})
          AND c.archived_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM ${knowledgeRel("collections")} AS ch
            WHERE ch.parent_collection_id = c.id AND ch.archived_at IS NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM ${knowledgeRel("collection_memberships")} AS cm
            WHERE cm.collection_id = c.id
              AND NOT EXISTS (
                SELECT 1 FROM ${knowledgeRel("documents")} AS d
                WHERE cm.target_type = 'document' AND d.id = cm.target_id AND d.archived_at IS NOT NULL
              )
              AND NOT EXISTS (
                SELECT 1 FROM ${knowledgeRel("source_links")} AS sl
                WHERE cm.target_type = 'source_link' AND sl.id = cm.target_id AND sl.archived_at IS NOT NULL
              )
          )
        RETURNING c.id
      `),
    )
    archived += rows.length
    const next = new Set<string>()
    for (const { id } of rows) {
      const node = tree.byId.get(id)
      if (!node) continue
      node.archived = true
      if (node.parentId) {
        const parent = tree.byId.get(node.parentId)
        if (parent && !parent.archived && eligible(parent.id)) next.add(parent.id)
      }
    }
    round = [...next]
  }
  return archived
}

async function archiveByExternalIds(
  tx: PrivilegedDb,
  source: SyncedSourceRow,
  externalIds: string[],
): Promise<string[]> {
  if (externalIds.length === 0) return []
  const ids = drizzleSql.join(
    externalIds.map((id) => drizzleSql`${id}`),
    drizzleSql`, `,
  )
  return extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      UPDATE ${knowledgeRel("documents")} AS d
      SET archived_at = now(), updated_at = now()
      FROM ${knowledgeRel("source_identities")} AS si
      WHERE d.synced_source_id = ${source.id}::uuid
        AND d.archived_at IS NULL
        AND si.id = d.source_identity_id
        AND si.org_id = ${source.orgId}::uuid
        AND si.source = ${source.appName}
        AND si.external_id IN (${ids})
      RETURNING d.id
    `),
  ).map((r) => r.id)
}

async function archiveNotSyncedSince(
  tx: PrivilegedDb,
  source: SyncedSourceRow,
  passStartedAt: string,
): Promise<string[]> {
  return extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      UPDATE ${knowledgeRel("documents")}
      SET archived_at = now(), updated_at = now()
      WHERE synced_source_id = ${source.id}::uuid
        AND archived_at IS NULL
        AND (last_synced_at IS NULL OR last_synced_at < ${passStartedAt}::timestamptz)
      RETURNING id
    `),
  ).map((r) => r.id)
}

// ---------------------------------------------------------------------------
// The sync loop
// ---------------------------------------------------------------------------

export interface AppSourceSyncDeps {
  /** Run one page in the app (the registered dispatch in production). */
  dispatch: (input: AppSourceSyncInput) => Promise<unknown>
  store?: AppSourceStore
  /** Hand the rest of the pass to a new job, after `generation`. */
  enqueueContinuation: (sourceId: string, generation: number) => Promise<void>
  limits?: Partial<AppSourceLimits>
  now?: () => number
}

export type AppSourceSyncOutcome =
  | { state: "done"; pages: number; upserted: number; archived: number }
  | { state: "continued"; pages: number; upserted: number; archived: number }
  | { state: "conflict"; pages: number; upserted: number; archived: number }

/**
 * Sync an app source: pages while the job has budget, each page written with
 * its cursor; then either the pass is done or a continuation is enqueued. A
 * failed page (the run threw, or broke the contract) is stamped on the source
 * and rethrown; the cursor stays, so the next sync asks for the same page.
 */
export async function runAppSourceSync(
  source: SyncedSourceRow,
  deps: AppSourceSyncDeps,
): Promise<AppSourceSyncOutcome> {
  if (!source.sourceKind) throw new Error(`synced source ${source.id} has no source kind`)
  const store = deps.store ?? dbAppSourceStore
  const limits = { ...APP_SOURCE_LIMITS, ...deps.limits }
  const now = deps.now ?? Date.now
  const startedAt = now()
  const totals = { pages: 0, upserted: 0, archived: 0 }
  let state = await store.beginAppSourcePass(source)
  for (;;) {
    let page: AppSourcePage
    try {
      const raw = await deps.dispatch({
        sourceId: source.id,
        kind: source.sourceKind,
        config: source.sourceConfig ?? {},
        cursor: state.cursor,
        scope: source.ownerUserId ? "personal" : "organization",
      })
      page = parseSyncResult(raw, limits)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await store.failAppSourceSync(
        source,
        err instanceof AppSourceContractError ? `Sync page refused: ${message}` : message,
      )
      throw err
    }
    let applied: AppliedPage
    try {
      applied = await store.applyAppSourcePage(source, state, page)
    } catch (err) {
      if (err instanceof AppSourceConflictError) {
        log.info({ sourceId: source.id }, "app source sync: another run moved the cursor; stopping")
        return { state: "conflict", ...totals }
      }
      const message = err instanceof Error ? err.message : String(err)
      await store.failAppSourceSync(
        source,
        err instanceof AppSourceContractError ? `Sync page refused: ${message}` : message,
      )
      throw err
    }
    state = applied.state
    totals.pages += 1
    totals.upserted += applied.upserted
    totals.archived += applied.archived
    if (page.done) return { state: "done", ...totals }
    if (totals.pages >= limits.maxPagesPerJob || now() - startedAt >= limits.jobBudgetMs) {
      try {
        await deps.enqueueContinuation(source.id, state.generation)
      } catch (err) {
        // The pass stays open: the next scheduled sync resumes it from the cursor.
        await store.failAppSourceSync(
          source,
          `Could not schedule the next page: ${err instanceof Error ? err.message : String(err)}`,
        )
        throw err
      }
      return { state: "continued", ...totals }
    }
  }
}

/**
 * The sync job's app-source branch (knowledge-jobs.ts): sets the org up, finds
 * the kind the app declares, re-checks that the owner still holds its read
 * scope, and runs the pages through the app's registered dispatch.
 */
export async function runAppSourceSyncJob(
  source: SyncedSourceRow,
  opts: {
    enqueueContinuation: (sourceId: string, generation: number) => Promise<void>
    setUpAppSourceOrg?: (orgId: string) => Promise<void>
    /** The owner's scopes; null when the owner is no longer an active member. */
    ownerScopes?: (orgId: string, userId: string) => Promise<readonly string[] | null>
    dispatch?: AppSourceSyncDeps["dispatch"]
    store?: AppSourceStore
    limits?: Partial<AppSourceLimits>
  },
): Promise<AppSourceSyncOutcome | { state: "refused"; reason: string }> {
  const store = opts.store ?? dbAppSourceStore
  const kind = source.sourceKind ?? ""
  const userId = source.ownerUserId ?? source.createdBy
  const setUpOrg =
    opts.setUpAppSourceOrg ??
    (async (orgId: string) => {
      const { awaitOrgApps } = await import("~/modules/apps/init")
      await awaitOrgApps(orgId)
    })
  await setUpOrg(source.orgId)
  const entry = knowledgeSourceKindRegistry.get([source.orgId, source.appName])
  const decl = entry?.kinds[kind]
  const refuse = async (reason: string) => {
    log.warn({ sourceId: source.id, app: source.appName, kind }, `app source sync: ${reason}`)
    await store.failAppSourceSync(source, reason)
    return { state: "refused" as const, reason }
  }
  if (!entry || !decl) {
    return refuse(`${source.appName} no longer offers the knowledge source "${kind}"`)
  }
  // The owner as they are now: a deactivated owner's sources stop, whatever
  // roles they still carry.
  const scopes = await (opts.ownerScopes ?? loadAppSourceOwnerScopes)(source.orgId, userId)
  if (scopes === null) return refuse("the source owner is no longer an active member")
  if (decl.readScope && !hasScope(decl.readScope, [...scopes])) {
    return refuse(`the source owner no longer holds ${decl.readScope}`)
  }
  const dispatch =
    opts.dispatch ??
    ((input: AppSourceSyncInput) => entry.dispatch(kind, input, { orgId: source.orgId, userId }))
  return runAppSourceSync(source, {
    dispatch,
    store,
    enqueueContinuation: opts.enqueueContinuation,
    ...(opts.limits ? { limits: opts.limits } : {}),
  })
}

/**
 * The owner's current scopes, or null when they are not an active member of the org.
 * An external user (a client) is not a member: a source they somehow own stops syncing.
 */
export async function loadAppSourceOwnerScopes(
  orgId: string,
  userId: string,
): Promise<readonly string[] | null> {
  const { loadEffectivePermissions } = await import("~/modules/permissions/permissions")
  const { withSystemDb } = await import("~/db/privileged")
  const { users } = await import("~/db/schema/kernel")
  const { and, eq } = await import("drizzle-orm")
  return withSystemDb("knowledge-app-source-owner-scopes", async (db) => {
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.id, userId),
          eq(users.orgId, orgId),
          eq(users.status, "active"),
          eq(users.userType, "member"),
        ),
      )
      .limit(1)
    if (!row) return null
    return (await loadEffectivePermissions(db, userId, orgId)).scopes
  })
}
