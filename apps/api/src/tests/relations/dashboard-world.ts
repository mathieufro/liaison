// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The world of what a person makes in the workspace: an organization dashboard and a document in
// the agent's data store, both written by `owner` through the product's own services (the
// dashboard service, the data store service). Readers read them as the workspace does, under their
// own row security: `owner` made them, `colleague` and `admin` see them as members of the
// organization, and `outsider`, an admin of another organization, is the control. The link a cell
// reads is the column it names: the dashboard's owner, its author columns, or the document's.

import { randomUUID } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { sql } from "~/db/connection"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { appDocuments, files } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { getObjectBuffer } from "~/infra/storage/object-storage"
import { createDraft, getDraft } from "~/modules/app-builder/drafts"
import { executeTool } from "~/modules/apps/execute-tool"
import { createDashboard, getDashboard } from "~/modules/dashboards/service"
import { AGENT_STORE_APP, getDocument, setDocument } from "~/modules/data-store/service"
import { deactivateUser, reactivateUser } from "~/modules/users/service"
import * as minimal from "~/seed/tiers/minimal"
import { type ApprovalOrg, ctxOf } from "./approval-world"
import type { Reading, Sight } from "./classes"

/** The kernel schema as the run names it (a test namespace prefixes it). */
const K = () => sql(schemaRef("kernel"))

export const SHARE_SCOPE = "kernel:dashboards:share"
const READERS = ["owner", "admin", "colleague", "outsider"] as const
type Reader = (typeof READERS)[number]
/** Which column of the made thing the link is. */
export type MadeLink = "dashboardOwner" | "dashboardAuthor" | "documentAuthor" | "draftAuthor"
export const BUILD_SCOPE = "kernel:apps:build"
const COLLECTION = "notes"

let other: Promise<{ orgId: string; adminUserId: string }> | null = null

/** An admin of another organisation: the reader who never could see what was made. */
function otherOrg() {
  other ??= minimal.secondOrg({ name: "Other Org" })
  return other
}

export class MadeCase {
  people = {} as Record<Reader, string>
  otherOrgId = ""
  dashboardId = ""
  docId = ""
  draftId = ""
  /** The export file the member's data export wrote, once it ran. */
  exportFileId: string | null = null
  exported: string[] = []

  constructor(
    readonly org: ApprovalOrg,
    readonly link: MadeLink,
  ) {}

  get orgId(): string {
    return this.org.orgId
  }

  async build(): Promise<this> {
    const tag = randomUUID().slice(0, 6)
    this.people.owner = (await minimal.person(this.orgId, { name: `M${tag}owner Made` })).id
    this.people.colleague = (await minimal.person(this.orgId, { name: `M${tag}colleague Made` })).id
    this.people.admin = this.org.adminId
    const other = await otherOrg()
    this.people.outsider = other.adminUserId
    this.otherOrgId = other.orgId
    await minimal.grantScope(this.people.owner, SHARE_SCOPE)
    const owner = await ctxOf(this.orgId, this.people.owner)
    if (this.link === "draftAuthor") {
      // Drafts are read by holders of the build scope only.
      for (const who of ["owner", "colleague", "admin"] as const)
        await minimal.grantScope(this.people[who], BUILD_SCOPE)
      const builder = await ctxOf(this.orgId, this.people.owner)
      const made = await withRlsContext(builder, (tx) =>
        createDraft(
          tx,
          { orgId: this.orgId, userId: this.people.owner },
          {
            baseName: `tracker${tag}`,
            title: `Tracker ${tag}`,
            files: {
              "app.manifest.json": JSON.stringify({ name: "x", version: "0.1.0" }),
              "handlers.ts": "export const ping = () => 'pong'\n",
            },
          },
        ),
      )
      this.draftId = made.draft.id
    } else if (this.link === "documentAuthor") {
      this.docId = `note-${tag}`
      await withRlsContext(owner, (tx) =>
        setDocument(
          tx,
          { orgId: this.orgId, app: AGENT_STORE_APP, userId: this.people.owner },
          COLLECTION,
          this.docId,
          { title: `Plan ${tag}` },
        ),
      )
    } else {
      this.dashboardId = (
        await createDashboard(owner, {
          title: `Pipeline ${tag}`,
          visibility: "org",
          spec: { v: 1, blocks: [] },
        })
      ).id
    }
    return this
  }

  // ── events ─────────────────────────────────────────────────────────────────

  async deactivateOwner(): Promise<void> {
    await withPrivilegedDb(this.orgId, "relations-deactivate-maker", (tx) =>
      deactivateUser(tx, {
        targetId: this.people.owner,
        actorId: this.org.adminId,
        orgId: this.orgId,
        actorScopes: this.org.admin.scopes,
      }),
    )
  }

  async reactivateOwner(): Promise<void> {
    await withPrivilegedDb(this.orgId, "relations-reactivate-maker", (tx) =>
      reactivateUser(tx, {
        targetId: this.people.owner,
        actorId: this.org.adminId,
        orgId: this.orgId,
        actorScopes: this.org.admin.scopes,
      }),
    )
  }

  /** The member exports their own data, through the export tool as the workspace calls it. */
  async exportOwner(): Promise<void> {
    const res = await executeTool<{ fileId: string }>({
      toolName: "kernel:data_subject_export",
      orgId: this.orgId,
      actor: await ctxOf(this.orgId, this.people.owner),
      params: { userId: "me" },
      origin: "human-ui",
    })
    const fileId = res.data?.fileId
    if (!fileId) throw new Error(`export wrote no file: ${JSON.stringify(res)}`)
    this.exportFileId = fileId
    const [row] = await withSystemDb("relations-read-export", (db) =>
      db.select({ key: files.storageKey }).from(files).where(eq(files.id, fileId)).limit(1),
    )
    if (!row) throw new Error(`no file row ${fileId}`)
    const bundle = JSON.parse((await getObjectBuffer(row.key)).toString("utf-8")) as {
      records: Record<string, { rows?: Array<Record<string, unknown>> }>
    }
    const key =
      this.link === "documentAuthor"
        ? "storeDocuments"
        : this.link === "draftAuthor"
          ? "appDrafts"
          : "dashboards"
    const field = this.link === "documentAuthor" ? "doc_id" : "id"
    this.exported = (bundle.records[key]?.rows ?? []).map((r) => String(r[field]))
  }

  // ── facts the events check on their own object ────────────────────────────

  async ownerStatus(): Promise<string | null> {
    const [row] =
      (await sql`SELECT status FROM ${K()}.users WHERE id = ${this.people.owner}`) as Array<{
        status: string
      }>
    return row?.status ?? null
  }

  async ownerAuthVersion(): Promise<number> {
    const [row] = (await sql`
      SELECT auth_version FROM ${K()}.users WHERE id = ${this.people.owner}`) as Array<{
      auth_version: number
    }>
    return row?.auth_version ?? 0
  }

  async ownerHolds(scope: string): Promise<boolean> {
    return (await ctxOf(this.orgId, this.people.owner)).scopes.includes(scope)
  }

  /** The id of the link's own row, as the export names it. */
  get rowId(): string {
    if (this.link === "draftAuthor") return this.draftId
    return this.link === "documentAuthor" ? this.docId : this.dashboardId
  }

  // ── readings ───────────────────────────────────────────────────────────────

  async read(): Promise<Reading> {
    const out: Reading = {}
    for (const r of READERS) out[r] = await this.sightOf(r)
    return out
  }

  private roleOf(id: string | null | undefined): string | null {
    if (!id) return null
    const role = READERS.find((r) => this.people[r] === id)
    return role ?? id
  }

  private async sightOf(who: Reader): Promise<Sight> {
    const orgId = who === "outsider" ? this.otherOrgId : this.orgId
    const ctx = await ctxOf(orgId, this.people[who])
    if (this.link === "draftAuthor") {
      try {
        const d = await withRlsContext(ctx, (tx) => getDraft(tx, this.draftId))
        return {
          visible: true,
          label: d.draft.title,
          points: `${this.roleOf(d.draft.createdBy)}/${this.roleOf(d.draft.updatedBy)}/${this.roleOf(d.version.createdBy)}`,
        }
      } catch (err) {
        if ((err as { code?: string }).code === "not_found") return { visible: false }
        throw err
      }
    }
    if (this.link === "documentAuthor") {
      const caller = { orgId, app: AGENT_STORE_APP, userId: this.people[who] }
      const found = await withRlsContext(ctx, async (tx) => {
        const doc = await getDocument(tx, caller, COLLECTION, this.docId)
        if (!doc) return null
        const [cols] = await tx
          .select({ createdBy: appDocuments.createdBy, updatedBy: appDocuments.updatedBy })
          .from(appDocuments)
          .where(
            and(
              eq(appDocuments.orgId, orgId),
              eq(appDocuments.app, AGENT_STORE_APP),
              eq(appDocuments.collection, COLLECTION),
              eq(appDocuments.docId, this.docId),
            ),
          )
        return { title: String(doc.data.title ?? ""), ...cols }
      })
      if (!found) return { visible: false }
      return {
        visible: true,
        label: found.title,
        points: `${this.roleOf(found.createdBy)}/${this.roleOf(found.updatedBy)}`,
      }
    }
    try {
      const d = await getDashboard(ctx, this.dashboardId)
      return {
        visible: true,
        label: d.title,
        points:
          this.link === "dashboardOwner"
            ? this.roleOf(d.ownerUserId)
            : `${this.roleOf(d.createdBy)}/${this.roleOf(d.updatedBy)}`,
      }
    } catch (err) {
      if ((err as { code?: string }).code === "NOT_FOUND") return { visible: false }
      throw err
    }
  }
}
