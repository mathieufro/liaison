// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * App knowledge sources against the database (app-sources.ts): a fixture app's
 * source kind syncs N pages into Knowledge over several jobs through the real
 * sync worker, with its cursor persisted on the source; a run that failed is
 * resumed from the last written page; deletes and prune archive; a stale page
 * is refused by the compare-and-set; creation checks the kind, scope and
 * config; and the synced documents stay inside their org (RLS) and, for a
 * personal source, with their owner.
 *
 * The app's handler is a host function registered as the kind's dispatch:
 * the sandboxed run itself (QuickJS and Workers) is covered by
 * modules/apps/workers/executor-parity.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { knowledgeCreateDocumentSchema } from "@liaison/shared"
import { sql } from "drizzle-orm"
import {
  AppSourceConflictError,
  type AppSourceSyncInput,
  dbAppSourceStore,
  loadAppSourceOwnerScopes,
} from "~/apps/knowledge/app-sources"
import { runSyncWorker } from "~/apps/knowledge/knowledge-jobs"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import {
  createKnowledgeDocument,
  type KnowledgeActor,
  knowledgeActorFromContext,
} from "~/apps/knowledge/service"
import {
  createSyncedSource,
  type SyncedSourceRow,
  type SyncedSourceScope,
} from "~/apps/knowledge/synced-sources"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { knowledgeSourceKindRegistry } from "~/modules/apps/app-registries"
import { createExternalUser } from "~/modules/users/external-user"
import * as minimal from "~/seed/tiers/minimal"
import { createTestCompany } from "~/tests/helpers/company"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const APP = "notes-app"
const READ_SCOPE = "notes_app:notes:read"
const SOURCES_MANAGE = "knowledge:sources:manage"
const DOC_READ = "knowledge:documents:read"

let orgA = ""
let orgB = ""
let alice = ""
let bob = ""
let carol = ""

/** The fixture provider: per source, its notes by page (`pages[n]` = page n's notes). */
const provider = new Map<
  string,
  {
    pages: string[][]
    deletes?: Record<number, string[]>
    failAt?: number
    /** Raw pages (documents and folders) returned as they are, in place of `pages`. */
    raw?: Array<Record<string, unknown>>
  }
>()
const calls: Array<{ sourceId: string; cursor: unknown; userId: string }> = []

async function notesHandler(input: AppSourceSyncInput, tenant: { orgId: string; userId: string }) {
  calls.push({ sourceId: input.sourceId, cursor: input.cursor, userId: tenant.userId })
  const spec = provider.get(input.sourceId)
  if (!spec) throw new Error("no notes for this source")
  const page = typeof input.cursor === "number" ? input.cursor % spec.pages.length : 0
  if (spec.failAt === page) {
    spec.failAt = undefined
    throw new Error(`provider failed on page ${page}`)
  }
  if (spec.raw) {
    const at = typeof input.cursor === "number" ? input.cursor % spec.raw.length : 0
    return {
      ...spec.raw[at],
      nextCursor: at + 1,
      done: at + 1 >= spec.raw.length,
      prune: input.config.prune === true,
    }
  }
  const prefix = String(input.config.prefix ?? "")
  return {
    documents: {
      upsert: (spec.pages[page] ?? []).map((id) => ({
        externalId: id,
        title: `${prefix}${id}`,
        body: `# ${id}\n\nbody of ${id}`,
        rev: `r-${page}`,
      })),
      delete: spec.deletes?.[page] ?? [],
    },
    nextCursor: page + 1,
    done: page + 1 >= spec.pages.length,
    prune: input.config.prune === true,
  }
}

function registerKind(orgId: string) {
  knowledgeSourceKindRegistry.set([orgId, APP], {
    kinds: {
      notes: {
        title: "Notes",
        handler: "syncNotes",
        readScope: READ_SCOPE,
        configSchema: {
          type: "object",
          properties: {
            prefix: { type: "string", default: "" },
            prune: { type: "boolean" },
          },
          additionalProperties: false,
        },
      },
      folder: {
        title: "Folder",
        handler: "syncFolder",
        readScope: READ_SCOPE,
        configSchema: {
          type: "object",
          properties: { ref: { type: "string" }, account: { type: "string" } },
          required: ["ref"],
          additionalProperties: false,
        },
      },
    },
    dispatch: (_kind, input, tenant) => notesHandler(input, tenant),
  })
}

function actorOf(orgId: string, userId: string, scopes: string[]): KnowledgeActor {
  return knowledgeActorFromContext({ orgId, userId, scopes, dimensionGrants: {} })
}

async function newSource(opts: {
  orgId: string
  userId: string
  scope?: SyncedSourceScope
  config?: Record<string, unknown>
  scopes?: string[]
}): Promise<SyncedSourceRow> {
  const scopes = opts.scopes ?? [SOURCES_MANAGE, DOC_READ, READ_SCOPE]
  const scope = opts.scope ?? "organization"
  return withRlsContext(
    { actorType: "user", orgId: opts.orgId, userId: opts.userId, scopes, dimensionGrants: {} },
    (tx) =>
      createSyncedSource(
        tx,
        {
          appName: APP,
          folderRef: "app-source:notes",
          sourceKind: "notes",
          sourceConfig: opts.config ?? {},
          displayName: `Notes ${crypto.randomUUID().slice(0, 6)}`,
          syncIntervalSeconds: 3600,
          scope,
          ...(scope === "organization" ? { defaultSensitivity: "internal" } : {}),
        },
        actorOf(opts.orgId, opts.userId, scopes),
      ),
  )
}

/**
 * Run the sync job for a source the way the queue would: the scheduled run,
 * then each continuation it enqueued, until none is left.
 */
async function drive(
  sourceId: string,
  opts: { maxPagesPerJob?: number; ownerScopes?: string[] | null } = {},
): Promise<{ jobs: number; continuations: string[] }> {
  const queue: Array<{ trigger: "schedule" | "continue" }> = [{ trigger: "schedule" }]
  const continuations: string[] = []
  let jobs = 0
  while (queue.length > 0) {
    const next = queue.shift()!
    jobs++
    await runSyncWorker(
      { sourceId, trigger: next.trigger },
      {
        appSource: {
          setUpAppSourceOrg: async () => undefined,
          ownerScopes: async () =>
            opts.ownerScopes === undefined ? [READ_SCOPE, DOC_READ] : opts.ownerScopes,
          enqueueContinuation: async (id, generation) => {
            continuations.push(`sync:${id}:g${generation}`)
            queue.push({ trigger: "continue" })
          },
          limits: { maxPagesPerJob: opts.maxPagesPerJob ?? 2 },
        },
      },
    )
  }
  return { jobs, continuations }
}

async function sourceState(id: string) {
  const [row] = extractRows<{
    sync_cursor: unknown
    sync_generation: number
    sync_pass_started_at: string | null
    last_sync_status: string
    last_error: string | null
  }>(
    await db.execute(sql`
      SELECT sync_cursor, sync_generation, sync_pass_started_at, last_sync_status, last_error
      FROM ${knowledgeRel("synced_sources")} WHERE id = ${id}::uuid`),
  )
  return row!
}

async function docsOf(sourceId: string) {
  return extractRows<{
    title: string
    body: string
    archived: boolean
    external_id: string
    source: string
    in_root: boolean
    org_id: string
  }>(
    await db.execute(sql`
      SELECT d.title, d.body, d.archived_at IS NOT NULL AS archived, si.external_id, si.source,
             d.org_id::text AS org_id,
             EXISTS (
               SELECT 1 FROM ${knowledgeRel("collection_memberships")} cm
               JOIN ${knowledgeRel("synced_sources")} s ON s.root_collection_id = cm.collection_id
               WHERE s.id = d.synced_source_id AND cm.target_id = d.id
             ) AS in_root
      FROM ${knowledgeRel("documents")} d
      JOIN ${knowledgeRel("source_identities")} si ON si.id = d.source_identity_id
      WHERE d.synced_source_id = ${sourceId}::uuid
      ORDER BY si.external_id`),
  )
}

/** The source's folders: external id -> name, parent (external id or "root"), archived. */
async function foldersOf(source: SyncedSourceRow) {
  const prefix = `synced:${source.id}:`
  const rows = extractRows<{
    id: string
    external_id: string
    name: string
    parent: string | null
    archived: boolean
    org_id: string
  }>(
    await db.execute(sql`
      SELECT c.id, substr(c.description, ${prefix.length + 1}) AS external_id, c.name,
             CASE WHEN c.parent_collection_id = ${source.rootCollectionId}::uuid THEN 'root'
                  ELSE substr(p.description, ${prefix.length + 1}) END AS parent,
             c.archived_at IS NOT NULL AS archived, c.org_id::text AS org_id
      FROM ${knowledgeRel("collections")} c
      LEFT JOIN ${knowledgeRel("collections")} p ON p.id = c.parent_collection_id
      WHERE starts_with(c.description, ${prefix})
      ORDER BY 2`),
  )
  return Object.fromEntries(rows.map((r) => [r.external_id, r]))
}

/** Where each live document of the source is filed: its folder's external id, or "root". */
async function placementOf(source: SyncedSourceRow) {
  const prefix = `synced:${source.id}:`
  const rows = extractRows<{ external_id: string; folder: string }>(
    await db.execute(sql`
      SELECT si.external_id,
             string_agg(CASE WHEN c.id = ${source.rootCollectionId}::uuid THEN 'root'
                             ELSE substr(c.description, ${prefix.length + 1}) END, ',') AS folder
      FROM ${knowledgeRel("documents")} d
      JOIN ${knowledgeRel("source_identities")} si ON si.id = d.source_identity_id
      JOIN ${knowledgeRel("collection_memberships")} cm ON cm.target_type = 'document' AND cm.target_id = d.id
      JOIN ${knowledgeRel("collections")} c ON c.id = cm.collection_id
      WHERE d.synced_source_id = ${source.id}::uuid AND d.archived_at IS NULL
      GROUP BY si.external_id
      ORDER BY si.external_id`),
  )
  return Object.fromEntries(rows.map((r) => [r.external_id, r.folder]))
}

const note = (externalId: string, over: Record<string, unknown> = {}) => ({
  externalId,
  title: externalId.toUpperCase(),
  body: `body of ${externalId}`,
  ...over,
})

beforeAll(async () => {
  await acquireTestLock()
  orgA = (await createTestOrg()).id
  alice = (await minimal.orgAdmin(orgA)).id
  bob = (await minimal.person(orgA)).id
  const second = await minimal.secondOrg({ name: "App sources B" })
  orgB = second.orgId
  carol = second.adminUserId
  registerKind(orgA)
  registerKind(orgB)
})

afterAll(async () => {
  knowledgeSourceKindRegistry.delete([orgA, APP])
  knowledgeSourceKindRegistry.delete([orgB, APP])
  await releaseTestLock()
})

describe("an app source syncs into Knowledge", () => {
  it("syncs N pages over several jobs, the cursor persisted on the source", async () => {
    const source = await newSource({ orgId: orgA, userId: alice, config: { prefix: "N:" } })
    expect(source.sourceKind).toBe("notes")
    expect(source.sourceConfig).toEqual({ prefix: "N:" })
    provider.set(source.id, { pages: [["a1", "a2"], ["b1"], ["c1", "c2"], ["d1"], ["e1"]] })

    const run = await drive(source.id, { maxPagesPerJob: 2 })
    expect(run.jobs).toBe(3)
    expect(run.continuations).toEqual([`sync:${source.id}:g2`, `sync:${source.id}:g4`])
    expect(calls.filter((c) => c.sourceId === source.id).map((c) => c.cursor)).toEqual([
      null,
      1,
      2,
      3,
      4,
    ])
    // The run acts for the source's creator (an org source has no owner).
    expect(new Set(calls.filter((c) => c.sourceId === source.id).map((c) => c.userId))).toEqual(
      new Set([alice]),
    )
    const docs = await docsOf(source.id)
    expect(docs.map((d) => d.external_id)).toEqual(["a1", "a2", "b1", "c1", "c2", "d1", "e1"])
    expect(
      docs.every((d) => d.source === APP && d.in_root && !d.archived && d.org_id === orgA),
    ).toBe(true)
    expect(docs[0]?.title).toBe("N:a1")
    const state = await sourceState(source.id)
    expect(state.last_sync_status).toBe("ok")
    expect(state.sync_cursor).toBe(5)
    expect(state.sync_generation).toBe(5)
    expect(state.sync_pass_started_at).toBeNull()
  })

  it("resumes from the last written page after a failed run, in the same pass", async () => {
    const source = await newSource({ orgId: orgA, userId: alice })
    provider.set(source.id, { pages: [["p0"], ["p1"], ["p2"], ["p3"]], failAt: 2 })
    await expect(drive(source.id, { maxPagesPerJob: 10 })).rejects.toThrow(
      "provider failed on page 2",
    )
    const failed = await sourceState(source.id)
    expect(failed.last_sync_status).toBe("error")
    expect(failed.last_error).toBe("provider failed on page 2")
    expect(failed.sync_cursor).toBe(2)
    expect(failed.sync_pass_started_at).not.toBeNull()
    expect((await docsOf(source.id)).map((d) => d.external_id)).toEqual(["p0", "p1"])

    await drive(source.id, { maxPagesPerJob: 10 })
    expect(calls.filter((c) => c.sourceId === source.id).map((c) => c.cursor)).toEqual([
      null,
      1,
      2,
      2,
      3,
    ])
    expect((await docsOf(source.id)).map((d) => d.external_id)).toEqual(["p0", "p1", "p2", "p3"])
    const done = await sourceState(source.id)
    expect(done.last_sync_status).toBe("ok")
    expect(done.last_error).toBeNull()
  })

  it("archives deleted ids, and with prune what the pass did not list", async () => {
    const source = await newSource({ orgId: orgA, userId: alice, config: { prune: true } })
    provider.set(source.id, {
      pages: [
        ["k1", "k2"],
        ["k3", "k4"],
      ],
    })
    await drive(source.id)
    expect((await docsOf(source.id)).filter((d) => !d.archived)).toHaveLength(4)

    // The next pass starts from the kept cursor (2 -> page 0): it deletes k2
    // and no longer lists k4, which prune archives at the end of the pass.
    provider.set(source.id, { pages: [["k1"], ["k3"]], deletes: { 0: ["k2"] } })
    await drive(source.id)
    const docs = await docsOf(source.id)
    expect(docs.map((d) => [d.external_id, d.archived])).toEqual([
      ["k1", false],
      ["k2", true],
      ["k3", false],
      ["k4", true],
    ])
    const [events] = extractRows<{ n: number }>(
      await db.execute(sql`
        SELECT count(*)::int AS n FROM kernel.pending_events
        WHERE org_id = ${orgA}::uuid
          AND payload->>'action' = 'archive'
          AND payload->'data'->>'syncedSourceId' = ${source.id}`),
    )
    expect(events?.n).toBe(2)
  })

  it("refuses a page whose generation moved: nothing is written", async () => {
    const source = await newSource({ orgId: orgA, userId: alice })
    const begun = await dbAppSourceStore.beginAppSourcePass(source)
    const page = {
      upserts: [{ externalId: "x1", title: "X1", body: "x" }],
      deletes: [],
      nextCursor: 1,
      done: false,
      prune: false,
    }
    await dbAppSourceStore.applyAppSourcePage(source, begun, page)
    await expect(
      dbAppSourceStore.applyAppSourcePage(source, begun, {
        ...page,
        upserts: [{ externalId: "x2", title: "X2", body: "x" }],
      }),
    ).rejects.toBeInstanceOf(AppSourceConflictError)
    expect((await docsOf(source.id)).map((d) => d.external_id)).toEqual(["x1"])
    expect((await sourceState(source.id)).sync_generation).toBe(1)
  })

  it("stops syncing when the owner no longer holds the kind's read scope", async () => {
    const source = await newSource({ orgId: orgA, userId: alice })
    provider.set(source.id, { pages: [["z1"]] })
    await drive(source.id, { ownerScopes: [DOC_READ] })
    const state = await sourceState(source.id)
    expect(state.last_sync_status).toBe("error")
    expect(state.last_error).toBe(`the source owner no longer holds ${READ_SCOPE}`)
    expect(await docsOf(source.id)).toEqual([])
  })

  it("stops syncing when the owner is no longer an active member", async () => {
    const source = await newSource({ orgId: orgA, userId: alice })
    provider.set(source.id, { pages: [["d1"]] })
    await drive(source.id, { ownerScopes: null })
    const state = await sourceState(source.id)
    expect(state.last_sync_status).toBe("error")
    expect(state.last_error).toBe("the source owner is no longer an active member")
    expect(await docsOf(source.id)).toEqual([])
  })

  it("an owner's scopes are read only while they are an active member of the source's org", async () => {
    const owner = await minimal.person(orgA, { role: "member" })
    expect(await loadAppSourceOwnerScopes(orgA, owner.id)).not.toBeNull()
    expect(await loadAppSourceOwnerScopes(orgB, owner.id)).toBeNull()
    await db.execute(sql`UPDATE kernel.users SET status = 'deactivated' WHERE id = ${owner.id}`)
    expect(await loadAppSourceOwnerScopes(orgA, owner.id)).toBeNull()
  })

  it("an external user's scopes are never an app source owner's", async () => {
    const companyId = await createTestCompany(orgA)
    const created = await withPrivilegedDb(orgA, "app-source-external-owner-test", (tx) =>
      createExternalUser(tx, {
        orgId: orgA,
        companyId,
        email: `client-${crypto.randomUUID().slice(0, 8)}@client.example`,
        name: "Client",
      }),
    )
    if (!created.ok) throw new Error(created.code)
    expect(await loadAppSourceOwnerScopes(orgA, created.userId)).toBeNull()
  })
})

describe("an app source files its documents in folders", () => {
  it("creates the folders under the source's collection, declared or from a path", async () => {
    const source = await newSource({ orgId: orgA, userId: alice })
    provider.set(source.id, {
      pages: [],
      raw: [
        {
          // A child declared before its parent, across a page boundary below.
          folders: {
            upsert: [
              { externalId: "f-setup", name: "Setup", parentExternalId: "f-guides" },
              { externalId: "f-guides", name: "Guides" },
            ],
          },
          documents: { upsert: [note("d1", { folderId: "f-setup" }), note("d2")] },
        },
        {
          documents: {
            upsert: [note("d3", { folderId: "f-guides" }), note("d4", { folderPath: "ref/api" })],
          },
        },
      ],
    })
    await drive(source.id)
    const folders = await foldersOf(source)
    expect(
      Object.values(folders).map((f) => [f.external_id, f.name, f.parent, f.archived, f.org_id]),
    ).toEqual([
      ["f-guides", "Guides", "root", false, orgA],
      ["f-setup", "Setup", "f-guides", false, orgA],
      ["ref", "ref", "root", false, orgA],
      ["ref/api", "api", "ref", false, orgA],
    ])
    expect(await placementOf(source)).toEqual({
      d1: "f-setup",
      d2: "root",
      d3: "f-guides",
      d4: "ref/api",
    })
    // A second pass reuses every folder: no duplicate collection.
    await drive(source.id)
    expect(Object.keys(await foldersOf(source))).toHaveLength(4)
    expect((await sourceState(source.id)).last_sync_status).toBe("ok")
  })

  it("renames and moves folders and documents, keeping each collection, and drops emptied folders", async () => {
    const source = await newSource({ orgId: orgA, userId: alice })
    provider.set(source.id, {
      pages: [],
      raw: [
        {
          folders: {
            upsert: [
              { externalId: "a", name: "A" },
              { externalId: "b", name: "B" },
              { externalId: "c", name: "C", parentExternalId: "a" },
              { externalId: "empty", name: "Empty" },
            ],
          },
          documents: {
            upsert: [
              note("n1", { folderId: "a" }),
              note("n2", { folderId: "c" }),
              note("n3", { folderId: "b" }),
            ],
          },
        },
      ],
    })
    await drive(source.id)
    const before = await foldersOf(source)
    expect(before.empty?.archived).toBe(false)

    // Next pass: "a" is renamed, "c" moves under "b", n1 moves to the root and
    // n3 into "c": "a" lost its last item and is not declared, so it goes.
    provider.set(source.id, {
      pages: [],
      raw: [
        {
          folders: {
            upsert: [
              { externalId: "a", name: "A renamed" },
              { externalId: "c", name: "C", parentExternalId: "b" },
            ],
          },
          documents: { upsert: [note("n1"), note("n3", { folderId: "c" })] },
        },
      ],
    })
    await drive(source.id)
    let after = await foldersOf(source)
    expect(after.a?.id).toBe(before.a?.id)
    expect(after.c?.id).toBe(before.c?.id)
    expect(after.a?.name).toBe("A renamed")
    expect(after.c?.parent).toBe("b")
    expect(await placementOf(source)).toEqual({ n1: "root", n2: "c", n3: "c" })
    // "a" was declared in this page: kept although empty. "b" holds "c": kept.
    expect([after.a?.archived, after.b?.archived, after.c?.archived]).toEqual([false, false, false])

    // A page that only moves n2 and n3 out of "c" empties it; "b" then holds
    // nothing either, and goes too. "empty" was never touched: it stays.
    provider.set(source.id, {
      pages: [],
      raw: [{ documents: { upsert: [note("n2", { folderId: "a" }), note("n3")] } }],
    })
    await drive(source.id)
    after = await foldersOf(source)
    expect([
      after.a?.archived,
      after.b?.archived,
      after.c?.archived,
      after.empty?.archived,
    ]).toEqual([false, true, true, false])
    // Filing a document in an archived folder brings it back, with its parent.
    provider.set(source.id, {
      pages: [],
      raw: [{ documents: { upsert: [note("n3", { folderId: "c" })] } }],
    })
    await drive(source.id)
    after = await foldersOf(source)
    expect([after.b?.archived, after.c?.archived]).toEqual([false, false])
    expect(after.c?.id).toBe(before.c?.id)
    expect((await placementOf(source)).n3).toBe("c")
  })

  it("deletes a folder with its subfolders and the documents still in it", async () => {
    const source = await newSource({ orgId: orgA, userId: alice })
    provider.set(source.id, {
      pages: [],
      raw: [
        {
          folders: {
            upsert: [
              { externalId: "top", name: "Top" },
              { externalId: "sub", name: "Sub", parentExternalId: "top" },
              { externalId: "keep", name: "Keep" },
            ],
          },
          documents: {
            upsert: [
              note("t1", { folderId: "top" }),
              note("s1", { folderId: "sub" }),
              note("s2", { folderId: "sub" }),
              note("k1", { folderId: "keep" }),
            ],
          },
        },
      ],
    })
    await drive(source.id)
    // s2 moves out in the same page that deletes "top": it stays.
    provider.set(source.id, {
      pages: [],
      raw: [
        {
          folders: { delete: ["top", "never-declared"] },
          documents: { upsert: [note("s2", { folderId: "keep" })] },
        },
      ],
    })
    await drive(source.id)
    const folders = await foldersOf(source)
    expect([folders.top?.archived, folders.sub?.archived, folders.keep?.archived]).toEqual([
      true,
      true,
      false,
    ])
    expect(await placementOf(source)).toEqual({ k1: "keep", s2: "keep" })
    expect((await docsOf(source.id)).filter((d) => d.archived).map((d) => d.external_id)).toEqual([
      "s1",
      "t1",
    ])
    const [events] = extractRows<{ n: number }>(
      await db.execute(sql`
        SELECT count(*)::int AS n FROM kernel.pending_events
        WHERE org_id = ${orgA}::uuid
          AND payload->>'action' = 'archive'
          AND payload->'data'->>'syncedSourceId' = ${source.id}`),
    )
    expect(events?.n).toBe(2)
  })

  it("with prune, archives the folders the pass neither declared nor used", async () => {
    const source = await newSource({ orgId: orgA, userId: alice, config: { prune: true } })
    provider.set(source.id, {
      pages: [],
      raw: [
        {
          folders: { upsert: [{ externalId: "listed-empty", name: "Listed" }] },
          documents: {
            upsert: [note("p1", { folderPath: "x/y" }), note("p2", { folderPath: "gone" })],
          },
        },
      ],
    })
    await drive(source.id)
    // A person files their own document in "x": it keeps "x" when the source
    // no longer lists anything there.
    const x = (await foldersOf(source)).x!
    const author = {
      orgId: orgA,
      userId: alice,
      scopes: ["knowledge:documents:create", "knowledge:collections:manage", DOC_READ],
      // An admin's wildcard grant: any sensitivity and team.
      dimensionGrants: { "*": ["*"] },
    }
    await withRlsContext({ actorType: "user", ...author }, (tx) =>
      createKnowledgeDocument(
        tx,
        knowledgeCreateDocumentSchema.parse({
          documentScope: "organization",
          title: "Mine",
          body: "mine",
          collectionIds: [x.id],
        }),
        knowledgeActorFromContext(author),
        [],
      ),
    )

    provider.set(source.id, {
      pages: [],
      raw: [
        {
          folders: { upsert: [{ externalId: "listed-empty", name: "Listed" }] },
          documents: { upsert: [note("p3")] },
        },
      ],
    })
    await drive(source.id)
    const folders = await foldersOf(source)
    expect(Object.values(folders).map((f) => [f.external_id, f.archived])).toEqual([
      ["gone", true],
      ["listed-empty", false],
      ["x", false],
      ["x/y", true],
    ])
    expect(await placementOf(source)).toEqual({ p3: "root" })
  })

  it("refuses a page filed in a folder the source never declared, or that nests folders in themselves", async () => {
    const source = await newSource({ orgId: orgA, userId: alice })
    provider.set(source.id, {
      pages: [],
      raw: [{ documents: { upsert: [note("u1", { folderId: "nowhere" })] } }],
    })
    await expect(drive(source.id)).rejects.toThrow(
      'folder "nowhere", which this source never declared',
    )
    let state = await sourceState(source.id)
    expect(state.last_error).toStartWith("Sync page refused:")
    expect(state.sync_generation).toBe(0)
    expect(await docsOf(source.id)).toEqual([])

    provider.set(source.id, {
      pages: [],
      raw: [
        {
          folders: {
            upsert: [
              { externalId: "p", name: "P" },
              { externalId: "q", name: "Q", parentExternalId: "p" },
            ],
          },
        },
      ],
    })
    await drive(source.id)
    provider.set(source.id, {
      pages: [],
      raw: [{ folders: { upsert: [{ externalId: "p", name: "P", parentExternalId: "q" }] } }],
    })
    await expect(drive(source.id)).rejects.toThrow("cannot move into its own subfolder")
    expect((await foldersOf(source)).p?.parent).toBe("root")
    provider.set(source.id, {
      pages: [],
      raw: [
        {
          folders: {
            upsert: [
              { externalId: "m", name: "M", parentExternalId: "n" },
              { externalId: "n", name: "N", parentExternalId: "m" },
            ],
          },
        },
      ],
    })
    await expect(drive(source.id)).rejects.toThrow("are placed inside each other")
    state = await sourceState(source.id)
    expect(state.last_sync_status).toBe("error")
    expect(Object.keys(await foldersOf(source))).toEqual(["p", "q"])
  })

  it("a stale page writes no folder: the generation guard covers the tree", async () => {
    const source = await newSource({ orgId: orgA, userId: alice })
    const begun = await dbAppSourceStore.beginAppSourcePass(source)
    const page = {
      upserts: [{ externalId: "g1", title: "G1", body: "x", folderId: "g" }],
      deletes: [],
      folders: [{ externalId: "g", name: "G", parentExternalId: null }],
      nextCursor: 1,
      done: false,
      prune: false,
    }
    await dbAppSourceStore.applyAppSourcePage(source, begun, page)
    await expect(
      dbAppSourceStore.applyAppSourcePage(source, begun, {
        ...page,
        upserts: [{ externalId: "g2", title: "G2", body: "x", folderId: "h" }],
        folders: [{ externalId: "h", name: "H", parentExternalId: null }],
        folderDeletes: ["g"],
      }),
    ).rejects.toBeInstanceOf(AppSourceConflictError)
    const folders = await foldersOf(source)
    expect(Object.keys(folders)).toEqual(["g"])
    expect(folders.g?.archived).toBe(false)
    expect(await placementOf(source)).toEqual({ g1: "g" })
  })

  it("never touches another org's or another source's folders with the same ids", async () => {
    const mine = await newSource({ orgId: orgA, userId: alice })
    const sibling = await newSource({ orgId: orgA, userId: alice })
    const theirs = await newSource({ orgId: orgB, userId: carol })
    const first = [
      {
        folders: { upsert: [{ externalId: "shared", name: "Shared" }] },
        documents: { upsert: [note("o1", { folderId: "shared" })] },
      },
    ]
    for (const s of [mine, sibling, theirs]) provider.set(s.id, { pages: [], raw: first })
    for (const s of [mine, sibling, theirs]) await drive(s.id)
    provider.set(mine.id, {
      pages: [],
      raw: [{ folders: { upsert: [{ externalId: "shared", name: "Renamed" }], delete: [] } }],
    })
    await drive(mine.id)
    provider.set(mine.id, { pages: [], raw: [{ folders: { delete: ["shared"] } }] })
    await drive(mine.id)
    expect((await foldersOf(mine)).shared?.archived).toBe(true)
    for (const s of [sibling, theirs]) {
      const f = (await foldersOf(s)).shared!
      expect([f.name, f.archived]).toEqual(["Shared", false])
      expect(await placementOf(s)).toEqual({ o1: "shared" })
    }
    expect((await foldersOf(theirs)).shared?.org_id).toBe(orgB)
  })
})

describe("creating an app source", () => {
  it("checks the kind, the read scope and the config", async () => {
    const create = (over: { kind?: string; scopes?: string[]; config?: Record<string, unknown> }) =>
      withRlsContext(
        {
          actorType: "user",
          orgId: orgA,
          userId: alice,
          scopes: over.scopes ?? [SOURCES_MANAGE, DOC_READ, READ_SCOPE],
          dimensionGrants: {},
        },
        (tx) =>
          createSyncedSource(
            tx,
            {
              appName: APP,
              folderRef: "app-source:notes",
              sourceKind: over.kind ?? "notes",
              sourceConfig: over.config ?? {},
              displayName: "Notes",
              syncIntervalSeconds: 3600,
              scope: "organization",
              defaultSensitivity: "internal",
            },
            actorOf(orgA, alice, over.scopes ?? [SOURCES_MANAGE, DOC_READ, READ_SCOPE]),
          ),
      )
    await expect(create({ kind: "wiki" })).rejects.toMatchObject({ code: "SOURCE_NOT_ENABLED" })
    await expect(create({ scopes: [SOURCES_MANAGE, DOC_READ] })).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    await expect(create({ config: { unknown: 1 } })).rejects.toMatchObject({ code: "VALIDATION" })
    // Defaults from the config schema are kept.
    expect((await create({})).sourceConfig).toEqual({ prefix: "" })
  })
})

describe("synced documents stay where they belong", () => {
  it("another org reads none of them; a personal source's documents are its owner's", async () => {
    const orgSource = await newSource({ orgId: orgA, userId: alice })
    provider.set(orgSource.id, { pages: [["iso-org-1", "iso-org-2"]] })
    await drive(orgSource.id)
    const personal = await newSource({ orgId: orgA, userId: alice, scope: "personal" })
    provider.set(personal.id, { pages: [["iso-mine-1"]] })
    await drive(personal.id)
    // The same kind in another org syncs into that org only.
    const other = await newSource({ orgId: orgB, userId: carol })
    provider.set(other.id, { pages: [["iso-b-1"]] })
    await drive(other.id)

    const visible = (orgId: string, userId: string) =>
      withRlsContext(
        { actorType: "user", orgId, userId, scopes: [DOC_READ], dimensionGrants: {} },
        async (tx) =>
          extractRows<{ title: string }>(
            await tx.execute(sql`
              SELECT title FROM ${knowledgeRel("documents")}
              WHERE synced_source_id IN (${orgSource.id}::uuid, ${personal.id}::uuid, ${other.id}::uuid)
              ORDER BY title`),
          ).map((r) => r.title),
      )
    const carolSees = await visible(orgB, carol)
    expect(carolSees).toEqual(["iso-b-1"])
    expect(await visible(orgA, bob)).not.toContain("iso-mine-1")
    expect(await visible(orgA, alice)).toContain("iso-mine-1")
    expect(await visible(orgA, alice)).not.toContain("iso-b-1")
    expect((await docsOf(personal.id)).map((d) => d.org_id)).toEqual([orgA])
  })
})

// One source per identity (synced-sources.ts findAppSource): a source added
// with a `ref` is the same source whatever else its config holds, so adding a
// folder that an earlier release synced (its config carrying the account it
// read through) finds that source instead of adding a second one.
describe("adding an app source that exists", () => {
  const scopes = [SOURCES_MANAGE, DOC_READ, READ_SCOPE]
  const add = (
    config: Record<string, unknown>,
    over: { kind?: string; account?: string; reuseSameConfig?: boolean } = {},
  ) =>
    withRlsContext(
      { actorType: "user", orgId: orgA, userId: alice, scopes, dimensionGrants: {} },
      (tx) =>
        createSyncedSource(
          tx,
          {
            appName: APP,
            folderRef:
              typeof config.ref === "string" ? config.ref : `app-source:${over.kind ?? "folder"}`,
            sourceKind: over.kind ?? "folder",
            sourceConfig: config,
            ...(over.account ? { sourceAccount: over.account } : {}),
            displayName: "Folder",
            syncIntervalSeconds: 3600,
            scope: "organization",
            defaultSensitivity: "internal",
          },
          actorOf(orgA, alice, scopes),
          over.reuseSameConfig ? { reuseSameConfig: true } : {},
        ),
    )
  const countRef = async (ref: string) =>
    Number(
      extractRows<{ n: number }>(
        await db.execute(sql`
          SELECT count(*)::int AS n FROM ${knowledgeRel("synced_sources")}
          WHERE org_id = ${orgA}::uuid AND app_name = ${APP} AND folder_ref = ${ref}
        `),
      )[0]!.n,
    )

  it("a source whose config also carries an account is found by its ref", async () => {
    const adopted = await add(
      { ref: "FOLDER_A", account: "team@example.com" },
      {
        account: "team@example.com",
      },
    )
    const again = await add({ ref: "FOLDER_A" })
    expect(again.id).toBe(adopted.id)
    expect(await countRef("FOLDER_A")).toBe(1)
  })

  it("an archived one comes back instead of a new one", async () => {
    const first = await add({ ref: "FOLDER_B" })
    await db.execute(sql`
      UPDATE ${knowledgeRel("synced_sources")} SET archived_at = now() WHERE id = ${first.id}::uuid
    `)
    const again = await add({ ref: "FOLDER_B" })
    expect(again.id).toBe(first.id)
    expect(again.archivedAt).toBeNull()
  })

  it("concurrent adds of one folder make one source", async () => {
    const rows = await Promise.all([1, 2, 3].map(() => add({ ref: "FOLDER_C" })))
    expect(new Set(rows.map((r) => r.id)).size).toBe(1)
    expect(await countRef("FOLDER_C")).toBe(1)
  })

  it("another named account, kind or owner is another source", async () => {
    const a = await add({ ref: "PICKS", account: "a@example.com" }, { account: "a@example.com" })
    const b = await add({ ref: "PICKS", account: "b@example.com" }, { account: "b@example.com" })
    expect(b.id).not.toBe(a.id)
    const other = await add({ prefix: "" }, { kind: "notes" })
    expect(other.id).not.toBe(a.id)
  })

  it("a source without a ref is reused by its whole config only when asked", async () => {
    const one = await add({ prefix: "Z:" }, { kind: "notes" })
    const two = await add({ prefix: "Z:" }, { kind: "notes" })
    expect(two.id).not.toBe(one.id)
    const reused = await add({ prefix: "Z:" }, { kind: "notes", reuseSameConfig: true })
    expect([one.id, two.id]).toContain(reused.id)
    const otherConfig = await add({ prefix: "Y:" }, { kind: "notes", reuseSameConfig: true })
    expect([one.id, two.id]).not.toContain(otherConfig.id)
  })
})
