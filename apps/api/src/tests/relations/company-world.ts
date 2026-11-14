// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The world of a customer: a company with a person linked to it (also its main contact), a
// colleague who is its account manager, a pipeline with one deal on it (that company, that
// person, owned by the account manager), a work project for the company, and an opt-out recorded
// for the person's address. A second company and a second person exist to merge into. Everything is
// written through the product's own services by the organization's admin, and read back as the
// workspace reads it, under each reader's row security: `admin` and `seller` (the account manager,
// with the contacts, companies, deals and opt-out read scopes) are of the organization, `outsider`,
// an admin of another organization, is the control. The link a cell reads is the column it names.

import { randomUUID } from "node:crypto"
import { sql as drizzleSql, eq } from "drizzle-orm"
import { createPipeline, createProject } from "~/apps/projects/service/create-project"
import { listDeals, writeDealFields } from "~/apps/projects/service/deals"
import { moveTask } from "~/apps/projects/service/move-task"
import { createTask } from "~/apps/projects/service/tasks"
import { updateProject } from "~/apps/projects/service/update-project"
import { extractRows } from "~/db"
import { sql } from "~/db/connection"
import { withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { files } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { getObjectBuffer } from "~/infra/storage/object-storage"
import { quoteIdent } from "~/lib/sql-utils"
import { executeTool } from "~/modules/apps/execute-tool"
import { deactivateWithCompanies } from "~/modules/apps/kernel-bulk"
import {
  createCompany,
  deleteCompany,
  getCompany,
  linkContactsToCompany,
  mergeCompanies,
  setCompanyManager,
  updateCompany,
} from "~/modules/contacts/companies"
import { deleteContact, mergeContactsWithMailReferences } from "~/modules/contacts/service"
import { addSuppression, listSuppressions } from "~/modules/mail/suppressions"
import * as minimal from "~/seed/tiers/minimal"
import { type ApprovalOrg, ctxOf } from "./approval-world"
import type { Reading, Sight } from "./classes"

/** The kernel schema as the run names it (a test namespace prefixes it). */
const K = () => sql(schemaRef("kernel"))
const P = () => sql(schemaRef("app_projects"))

const READERS = ["admin", "seller", "outsider"] as const
type Reader = (typeof READERS)[number]

/** Which column of the customer's world the link is. */
export type CrmLink =
  | "contactCompany"
  | "companyManager"
  | "mainContact"
  | "dealCompany"
  | "dealContact"
  | "dealOwner"
  | "dealPipeline"
  | "projectCompany"
  | "suppressionContact"

const SELLER_SCOPES = [
  "kernel:contacts:read",
  "kernel:companies:read",
  "projects:projects:read",
  "projects:tasks:read",
  "projects:deals:read",
  "mail:suppressions:read",
]

/** The visible state a read shows once the link no longer points anywhere. */
export const UNLINKED = "unlinked"
export const UNOWNED = "unowned"

let other: Promise<{ orgId: string; adminUserId: string }> | null = null

function otherOrg() {
  other ??= minimal.secondOrg({ name: "Other Customer Org" })
  return other
}

export class CrmCase {
  people = {} as Record<Reader, string>
  otherOrgId = ""
  tag = ""
  companyName = ""
  companyId = ""
  otherCompanyId = ""
  contactId = ""
  otherContactId = ""
  email = ""
  pipelineId = ""
  workProjectId = ""
  dealId = ""
  /** What a refused event answered. */
  refusal: string | null = null
  /** What the last export carried, by the link's own row id. */
  exported: string[] = []
  exportFileId: string | null = null

  constructor(
    readonly org: ApprovalOrg,
    readonly link: CrmLink,
  ) {}

  get orgId(): string {
    return this.org.orgId
  }

  private admin = () => ctxOf(this.orgId, this.org.adminId)

  async build(): Promise<this> {
    const tag = randomUUID().slice(0, 6)
    this.tag = tag
    this.people.admin = this.org.adminId
    this.people.seller = (await minimal.person(this.orgId, { name: `C${tag}seller Crm` })).id
    for (const s of SELLER_SCOPES) await minimal.grantScope(this.people.seller, s)
    const o = await otherOrg()
    this.people.outsider = o.adminUserId
    this.otherOrgId = o.orgId

    this.email = `buyer-${tag}@client-${tag}.example`
    this.contactId = await minimal.contact(this.orgId, this.email, { name: `Buyer ${tag}` })
    this.otherContactId = await minimal.contact(this.orgId, `other-${tag}@client-${tag}.example`, {
      name: `Buyer ${tag} again`,
    })
    const admin = await this.admin()
    const by = { orgId: this.orgId, userId: this.org.adminId }
    this.companyName = `Verrerie ${tag}`
    await withRlsContext(admin, async (tx) => {
      this.companyId = (
        await createCompany(tx, { ...by, input: { name: this.companyName } })
      ).company.id
      this.otherCompanyId = (
        await createCompany(tx, { ...by, input: { name: `Verrerie ${tag} Group` } })
      ).company.id
      await linkContactsToCompany(tx, {
        ...by,
        companyId: this.companyId,
        contactIds: [this.contactId],
      })
    })
    await withRlsContext(admin, (tx) =>
      setCompanyManager(tx, {
        ...by,
        companyIds: [this.companyId],
        ownerUserId: this.people.seller,
      }),
    )
    await withRlsContext(admin, (tx) =>
      updateCompany(tx, {
        ...by,
        companyId: this.companyId,
        patch: { mainContactId: this.contactId },
      }),
    )
    await withRlsContext(admin, async (tx) => {
      const pipeline = await createPipeline({
        tx,
        orgId: this.orgId,
        actor: admin,
        input: { name: `Sales ${tag}` },
      })
      this.pipelineId = pipeline.id
      const work = await createProject({
        tx,
        orgId: this.orgId,
        actor: admin,
        input: { name: `Fit out ${tag}` },
      })
      this.workProjectId = work.id
      const task = await createTask({
        tx,
        orgId: this.orgId,
        actor: admin,
        input: { projectId: pipeline.id, title: `Studio ${tag}`, assigneeId: this.people.seller },
      })
      this.dealId = task.id
      await writeDealFields(tx, this.orgId, admin.scopes, this.dealId, {
        companyId: this.companyId,
        contactId: this.contactId,
      })
    })
    await withRlsContext(admin, (tx) =>
      updateProject({
        tx,
        orgId: this.orgId,
        projectId: this.workProjectId,
        actor: admin,
        patch: { companyId: this.companyId },
      }),
    )
    await addSuppression(null, {
      orgId: this.orgId,
      email: this.email,
      reason: "person",
      createdBy: this.org.adminId,
    })
    return this
  }

  // ── events ─────────────────────────────────────────────────────────────────

  async renameCompany(): Promise<void> {
    const admin = await this.admin()
    await withRlsContext(admin, (tx) =>
      updateCompany(tx, {
        orgId: this.orgId,
        userId: this.org.adminId,
        companyId: this.companyId,
        patch: { name: `${this.companyName} renamed` },
      }),
    )
  }

  async mergeCompany(): Promise<void> {
    const admin = await this.admin()
    await withRlsContext(admin, (tx) =>
      mergeCompanies(tx, {
        orgId: this.orgId,
        userId: this.org.adminId,
        sourceId: this.companyId,
        targetId: this.otherCompanyId,
      }),
    )
  }

  async deleteCompany(): Promise<void> {
    const admin = await this.admin()
    await withRlsContext(admin, (tx) =>
      deleteCompany(tx, { orgId: this.orgId, userId: this.org.adminId, companyId: this.companyId }),
    )
  }

  async mergeContact(): Promise<void> {
    const admin = await this.admin()
    await withRlsContext(admin, (tx) =>
      mergeContactsWithMailReferences(tx, {
        orgId: this.orgId,
        userId: this.org.adminId,
        sourceId: this.contactId,
        targetId: this.otherContactId,
      }),
    )
  }

  async deleteContact(): Promise<void> {
    const admin = await this.admin()
    await withRlsContext(admin, (tx) =>
      deleteContact(tx, { orgId: this.orgId, userId: this.org.adminId, contactId: this.contactId }),
    )
  }

  /** The account manager leaves, and the admin answers that their companies stay unowned. */
  async sellerLeaves(): Promise<void> {
    const res = await deactivateWithCompanies({
      orgId: this.orgId,
      actorId: this.org.adminId,
      actorScopes: this.org.admin.scopes,
      userId: this.people.seller,
      accountsTo: null,
    })
    if ("error" in res) throw new Error(`deactivation refused: ${JSON.stringify(res.error)}`)
  }

  /** The deal is moved to a work project, which a deal cannot live in. */
  async moveDealToWork(): Promise<void> {
    const admin = await this.admin()
    try {
      await withRlsContext(admin, (tx) =>
        moveTask({
          tx,
          orgId: this.orgId,
          actor: admin,
          taskId: this.dealId,
          targetProjectId: this.workProjectId,
        }),
      )
      this.refusal = null
    } catch (err) {
      this.refusal = (err as Error).message
    }
  }

  /** A data subject export: of the person (`contact`) or of the account manager's own data. */
  async exportOf(subject: "contact" | "seller"): Promise<Record<string, unknown>> {
    const actor = await ctxOf(
      this.orgId,
      subject === "contact" ? this.org.adminId : this.people.seller,
    )
    const res = await executeTool<{ fileId: string }>({
      toolName: "kernel:data_subject_export",
      orgId: this.orgId,
      actor,
      params: subject === "contact" ? { contactId: this.contactId } : { userId: "me" },
      origin: "human-ui",
    })
    const fileId = res.data?.fileId
    if (!fileId) throw new Error(`export wrote no file: ${JSON.stringify(res)}`)
    this.exportFileId = fileId
    const [row] = await withSystemDb("relations-read-export", (db) =>
      db.select({ key: files.storageKey }).from(files).where(eq(files.id, fileId)).limit(1),
    )
    if (!row) throw new Error(`no file row ${fileId}`)
    return JSON.parse((await getObjectBuffer(row.key)).toString("utf-8")) as Record<string, unknown>
  }

  // ── facts the events check on their own object ────────────────────────────

  async companyRow(id = this.companyId) {
    const [row] = (await sql`
      SELECT name, owner_user_id, main_contact_id FROM ${K()}.companies WHERE id = ${id}`) as Array<{
      name: string
      owner_user_id: string | null
      main_contact_id: string | null
    }>
    return row ?? null
  }

  async contactExists(id = this.contactId): Promise<boolean> {
    const rows = await sql`SELECT 1 FROM ${K()}.contacts WHERE id = ${id}`
    return rows.length > 0
  }

  async sellerStatus(): Promise<string | null> {
    const [row] = (await sql`
      SELECT status FROM ${K()}.users WHERE id = ${this.people.seller}`) as Array<{
      status: string
    }>
    return row?.status ?? null
  }

  async dealProject(): Promise<string | null> {
    const [row] = (await sql`
      SELECT project_id FROM ${P()}.tasks WHERE id = ${this.dealId}`) as Array<{
      project_id: string
    }>
    return row?.project_id ?? null
  }

  /** When the opt-out was recorded, as an ISO instant. */
  async suppressionAt(): Promise<string | null> {
    const [rec] = await listSuppressions(this.orgId, [this.email])
    return rec ? new Date(rec.createdAt).toISOString() : null
  }

  // ── readings ───────────────────────────────────────────────────────────────

  async read(): Promise<Reading> {
    const out: Reading = {}
    for (const r of READERS) out[r] = await this.sightOf(r)
    return out
  }

  private symbol(id: string | null | undefined): string | null {
    if (!id) return null
    const named: Record<string, string> = {
      [this.companyId]: "company",
      [this.otherCompanyId]: "otherCompany",
      [this.contactId]: "contact",
      [this.otherContactId]: "otherContact",
      [this.pipelineId]: "pipeline",
      [this.workProjectId]: "workProject",
      ...Object.fromEntries(READERS.map((r) => [this.people[r], r])),
    }
    return named[id] ?? id
  }

  private linked(points: string | null, label: string | null, empty = UNLINKED): Sight {
    return { visible: true, points, label, state: points ? null : empty }
  }

  private async sightOf(who: Reader): Promise<Sight> {
    const orgId = who === "outsider" ? this.otherOrgId : this.orgId
    const ctx = await ctxOf(orgId, this.people[who])
    return withRlsContext(ctx, async (tx) => {
      switch (this.link) {
        case "contactCompany":
        case "suppressionContact": {
          if (this.link === "suppressionContact") {
            const [rec] = await listSuppressions(orgId, [this.email], tx)
            return rec
              ? { visible: true, points: "address", label: rec.reason }
              : { visible: false }
          }
          const [row] = extractRows<{ company_id: string | null; company: string | null }>(
            await tx.execute(drizzleSql`
              SELECT company_id, company FROM ${drizzleSql.raw(quoteIdent(schemaRef("kernel")))}.contacts
              WHERE id = ${this.contactId}::uuid AND org_id = ${orgId}::uuid`),
          )
          if (!row) return { visible: false }
          return this.linked(this.symbol(row.company_id), row.company)
        }
        case "companyManager":
        case "mainContact": {
          const c = await getCompany(tx, { orgId, companyId: this.companyId })
          if (!c) return { visible: false }
          return this.link === "companyManager"
            ? this.linked(this.symbol(c.ownerUserId), c.name, UNOWNED)
            : this.linked(this.symbol(c.mainContactId), c.name)
        }
        case "projectCompany": {
          const [row] = extractRows<{ company_id: string | null; name: string }>(
            await tx.execute(drizzleSql`
              SELECT company_id, name FROM ${drizzleSql.raw(quoteIdent(schemaRef("app_projects")))}.projects
              WHERE id = ${this.workProjectId}::uuid AND org_id = ${orgId}::uuid`),
          )
          if (!row) return { visible: false }
          return this.linked(this.symbol(row.company_id), row.name)
        }
        default: {
          const [d] = await listDeals(tx, orgId, { taskId: this.dealId })
          if (!d) return { visible: false }
          const at = {
            dealCompany: d.companyId,
            dealContact: d.contactId,
            dealOwner: d.assigneeId,
            dealPipeline: d.projectId,
          }[this.link]
          return this.linked(this.symbol(at), d.title)
        }
      }
    })
  }
}
