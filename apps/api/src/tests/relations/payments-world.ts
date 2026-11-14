// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The money world: an organization with the payments connector and invoicing registered, a
// company with a person, a second company and person to merge into, the invoicing rows of
// recurring-world.ts, and the payments mirror the connector's sync writes: a customer linked to
// the company and the person, an invoice issued as the Liaison document, a payment and its refund.
// Readers: `admin`; `clerk`, a member holding only the read scopes of the money tables; and
// `outsider`, an admin of another organization, the control. Each link is read as the workspace
// reads it, under the reader's row security; the link a cell reads is the column it names.

import { expect } from "bun:test"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { eq } from "drizzle-orm"
import { sql } from "~/db/connection"
import { withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { files } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { getObjectBuffer } from "~/infra/storage/object-storage"
import { executeTool } from "~/modules/apps/execute-tool"
import { setOrgAppStatus } from "~/modules/apps/org-app-service"
import { registerApps } from "~/modules/apps/runtime"
import {
  createCompany,
  deleteCompany,
  linkContactsToCompany,
  mergeCompanies,
  updateCompany,
} from "~/modules/contacts/companies"
import {
  deleteContact,
  mergeContactsWithMailReferences,
  updateContact,
} from "~/modules/contacts/service"
import { seedAppRow } from "~/seed/factories/org/platform-rows"
import * as minimal from "~/seed/tiers/minimal"
import { type ApprovalOrg, approvalOrg, ctxOf } from "./approval-world"
import type { CellImpl, CellWorld } from "./cells"
import type { Reading } from "./classes"
import {
  columnValue,
  countRows,
  type InvoicingRows,
  insertRow,
  inv,
  rowAs,
  sightOfRow,
  writeInvoicing,
} from "./recurring-world"

const READERS = ["admin", "clerk", "outsider"] as const
type Reader = (typeof READERS)[number]
const SEE = ["admin", "clerk"]

/** The payments connector's app name: its mirror's schema, tables and columns carry it. */
const PAYMENTS_APP = "stripe"
/** `<the connector's schema as the run names it>.<app>_<table>`, a payments mirror table. */
const pay = (table: string) => `${schemaRef(`app_${PAYMENTS_APP}`)}.${PAYMENTS_APP}_${table}`
/** A mirror column named after the app: its row id, its upstream update and creation times. */
const MIRROR_ID = `${PAYMENTS_APP}_id`
const UPSTREAM_UPDATED = `${PAYMENTS_APP}_updated`
const UPSTREAM_CREATED = `created_at_${PAYMENTS_APP}`

const CLERK_SCOPES = [
  "kernel:contacts:read",
  "kernel:companies:read",
  "stripe:customers:read",
  "stripe:invoices:read",
  "stripe:payments:read",
  "invoicing:documents:read",
]

/** Which link of the money world a case reads. */
export type MoneyLink =
  | "invoiceParty"
  | "scheduleParty"
  | "scheduleContact"
  | "runItem"
  | "paymentsCustomer"
  | "paymentsCustomerContact"
  | "paymentsInvoice"
  | "paymentsRefund"

interface LinkRead {
  table: () => string
  key: (w: MoneyCase) => { column: string; value: string }
  column: string
  label?: string
  /** The scope whose loss hides the row. */
  scope: string
}

const LINK_READS: Record<MoneyLink, LinkRead> = {
  invoiceParty: {
    table: () => inv("documents"),
    key: (w) => ({ column: "id", value: w.inv.documentId }),
    column: "counterparty_contact_id",
    label: "counterparty_name",
    scope: "invoicing:documents:read",
  },
  scheduleParty: {
    table: () => inv("recurring_schedules"),
    key: (w) => ({ column: "id", value: w.inv.scheduleId }),
    column: "company_id",
    scope: "invoicing:documents:read",
  },
  scheduleContact: {
    table: () => inv("recurring_schedules"),
    key: (w) => ({ column: "id", value: w.inv.scheduleId }),
    column: "contact_id",
    scope: "invoicing:documents:read",
  },
  runItem: {
    table: () => inv("recurring_run_items"),
    key: (w) => ({ column: "id", value: w.inv.runItemId }),
    column: "schedule_id",
    scope: "invoicing:documents:read",
  },
  paymentsCustomer: {
    table: () => pay("customers"),
    key: (w) => ({ column: MIRROR_ID, value: w.customerId }),
    column: "company_id",
    scope: "stripe:customers:read",
  },
  paymentsCustomerContact: {
    table: () => pay("customers"),
    key: (w) => ({ column: MIRROR_ID, value: w.customerId }),
    column: "contact_id",
    scope: "stripe:customers:read",
  },
  paymentsInvoice: {
    table: () => pay("invoices"),
    key: (w) => ({ column: MIRROR_ID, value: w.upstreamInvoiceId }),
    column: "liaison_document_id",
    scope: "stripe:invoices:read",
  },
  paymentsRefund: {
    table: () => pay("refunds"),
    key: (w) => ({ column: MIRROR_ID, value: w.refundId }),
    column: "payment_id",
    scope: "stripe:payments:read",
  },
}

function descriptor(name: string): Record<string, unknown> {
  const m = JSON.parse(
    readFileSync(
      path.join(import.meta.dir, "../../../../../bundled-apps", name, "app.manifest.json"),
      "utf8",
    ),
  ) as Record<string, unknown>
  return {
    name: m.name,
    version: m.version,
    _format: "manifest",
    _bundlePath: `/apps/${name}/handlers.js`,
    scopes: m.scopes,
    roles: m.roles,
    schema: m.schema,
    events: m.events,
  }
}

let money: Promise<ApprovalOrg> | null = null
let other: Promise<{ orgId: string; adminUserId: string }> | null = null

/**
 * Forget the cached money organizations, so the next case builds them again. For a file that
 * runs beside the cells: a later file's org truncation would otherwise leave them stale.
 */
export function forgetMoneyOrgs(): void {
  money = null
  other = null
}

/** One organization for every money cell, with both apps registered and active. */
export function moneyOrg(): Promise<ApprovalOrg> {
  money ??= (async () => {
    const { orgId } = await minimal.secondOrg({ name: "Money Org" })
    const org = await approvalOrg(orgId)
    await registerApps([descriptor("stripe"), descriptor("invoicing")] as never, orgId)
    for (const name of ["stripe", "invoicing"]) {
      const [known] = await sql.unsafe(
        `SELECT 1 FROM ${schemaRef("kernel")}.apps WHERE org_id = $1 AND name = $2`,
        [orgId, name],
      )
      if (!known) await seedAppRow({ orgId, name, version: "1.0.0" })
    }
    return { ...org, admin: await ctxOf(orgId, org.adminId) }
  })()
  return money
}

export class MoneyCase implements CellWorld {
  people = {} as Record<Reader, string>
  tag = ""
  companyId = ""
  companyName = ""
  otherCompanyId = ""
  contactId = ""
  contactName = ""
  otherContactId = ""
  inv = {} as InvoicingRows
  customerId = ""
  upstreamInvoiceId = ""
  paymentId = ""
  refundId = ""
  exported: string[] = []
  refusal: string | null = null

  constructor(
    readonly org: ApprovalOrg,
    readonly link: MoneyLink,
  ) {}

  get orgId(): string {
    return this.org.orgId
  }

  get reads(): LinkRead {
    return LINK_READS[this.link]
  }

  async build(): Promise<this> {
    const tag = randomUUID().slice(0, 6)
    this.tag = tag
    this.people.admin = this.org.adminId
    const clerk = await minimal.person(this.orgId, { name: `M${tag}clerk Money` })
    this.people.clerk = clerk.id
    // The clerk holds the money reads as direct grants only, so a lost grant is a lost read.
    await minimal.revokeRole(clerk.id, "member")
    for (const s of CLERK_SCOPES) await minimal.grantScope(clerk.id, s)
    other ??= minimal.secondOrg({ name: "Other Money Org" })
    this.people.outsider = (await other).adminUserId

    this.contactName = `Buyer ${tag}`
    this.contactId = await minimal.contact(this.orgId, `buyer-${tag}@maison-${tag}.example`, {
      name: this.contactName,
    })
    this.otherContactId = await minimal.contact(this.orgId, `again-${tag}@maison-${tag}.example`, {
      name: `${this.contactName} again`,
    })
    const by = { orgId: this.orgId, userId: this.org.adminId }
    this.companyName = `Maison ${tag}`
    await withRlsContext(this.org.admin, async (tx) => {
      this.companyId = (
        await createCompany(tx, { ...by, input: { name: this.companyName } })
      ).company.id
      this.otherCompanyId = (
        await createCompany(tx, { ...by, input: { name: `Maison ${tag} Group` } })
      ).company.id
      await linkContactsToCompany(tx, {
        ...by,
        companyId: this.companyId,
        contactIds: [this.contactId],
      })
    })

    this.inv = await writeInvoicing({
      orgId: this.orgId,
      adminId: this.org.adminId,
      tag,
      companyId: this.companyId,
      contactId: this.contactId,
      contactName: this.contactName,
      // A schedule naming the company holds it (its delete is refused), so only its own cells have one.
      scheduleBillsCompany: this.link !== "paymentsCustomer",
      // A live schedule billing the person holds them (their delete is refused), so the payments
      // customer's person cells bill the other person.
      scheduleContactId:
        this.link === "paymentsCustomerContact" ? this.otherContactId : this.contactId,
    })

    // The payments mirror, as the connector's sync writes it.
    const now = new Date().toISOString()
    this.customerId = `cus_${tag}${randomUUID().slice(0, 6)}`
    await insertRow(pay("customers"), {
      org_id: this.orgId,
      [MIRROR_ID]: this.customerId,
      email: `buyer-${tag}@maison-${tag}.example`,
      name: this.companyName,
      company_id: this.companyId,
      contact_id: this.contactId,
      match_method: "email",
      [UPSTREAM_UPDATED]: now,
      [UPSTREAM_CREATED]: now,
    })
    this.upstreamInvoiceId = `in_${tag}${randomUUID().slice(0, 6)}`
    await insertRow(pay("invoices"), {
      org_id: this.orgId,
      [MIRROR_ID]: this.upstreamInvoiceId,
      customer_id: this.customerId,
      status: "paid",
      total_minor: 120000,
      tax_minor: 20000,
      amount_paid_minor: 120000,
      amount_due_minor: 0,
      currency: "eur",
      issuer: "liaison",
      liaison_document_id: this.inv.documentId,
      [UPSTREAM_UPDATED]: now,
    })
    this.paymentId = `ch_${tag}${randomUUID().slice(0, 6)}`
    await insertRow(pay("payments"), {
      org_id: this.orgId,
      [MIRROR_ID]: this.paymentId,
      invoice_id: this.upstreamInvoiceId,
      customer_id: this.customerId,
      amount_minor: 120000,
      currency: "eur",
      status: "succeeded",
      [UPSTREAM_CREATED]: now,
    })
    this.refundId = `re_${tag}${randomUUID().slice(0, 6)}`
    await insertRow(pay("refunds"), {
      org_id: this.orgId,
      [MIRROR_ID]: this.refundId,
      payment_id: this.paymentId,
      amount_minor: 20000,
      currency: "eur",
      status: "succeeded",
      [UPSTREAM_CREATED]: now,
    })
    return this
  }

  async read(): Promise<Reading> {
    const out: Reading = {}
    const r = this.reads
    for (const who of READERS) {
      const orgId = who === "outsider" ? ((await other)?.orgId ?? this.orgId) : this.orgId
      const ctx = await ctxOf(orgId, this.people[who])
      const cols = [r.column, ...(r.label ? [r.label] : [])]
      out[who] = sightOfRow(await rowAs(ctx, r.table(), r.key(this), cols), r.column, r.label)
    }
    return out
  }

  /** The link's column on its row, read past row security; undefined when the row is gone. */
  linkValue(): Promise<string | null | undefined> {
    const r = this.reads
    return columnValue(r.table(), r.key(this), r.column)
  }

  async rows(): Promise<number> {
    const r = this.reads
    const k = r.key(this)
    return countRows(r.table(), k.column, k.value)
  }

  // ── events ────────────────────────────────────────────────────────────────

  async renameCompany(): Promise<void> {
    await withRlsContext(this.org.admin, (tx) =>
      updateCompany(tx, {
        orgId: this.orgId,
        userId: this.org.adminId,
        companyId: this.companyId,
        patch: { name: `${this.companyName} renamed` },
      }),
    )
  }

  async companyName_(): Promise<string | null> {
    const [row] = (await sql`
      SELECT name FROM ${sql(schemaRef("kernel"))}.companies WHERE id = ${this.companyId}`) as Array<{
      name: string
    }>
    return row?.name ?? null
  }

  async mergeCompany(): Promise<void> {
    await withRlsContext(this.org.admin, (tx) =>
      mergeCompanies(tx, {
        orgId: this.orgId,
        userId: this.org.adminId,
        sourceId: this.companyId,
        targetId: this.otherCompanyId,
      }),
    )
  }

  async renameContact(): Promise<void> {
    await withRlsContext(this.org.admin, (tx) =>
      updateContact(tx, {
        orgId: this.orgId,
        userId: this.org.adminId,
        contactId: this.contactId,
        updates: { name: `${this.contactName} renamed` },
      }),
    )
  }

  async contactName_(): Promise<string | null> {
    const [row] = (await sql`
      SELECT name FROM ${sql(schemaRef("kernel"))}.contacts WHERE id = ${this.contactId}`) as Array<{
      name: string
    }>
    return row?.name ?? null
  }

  async mergeContact(): Promise<void> {
    await withRlsContext(this.org.admin, (tx) =>
      mergeContactsWithMailReferences(tx, {
        orgId: this.orgId,
        userId: this.org.adminId,
        sourceId: this.contactId,
        targetId: this.otherContactId,
      }),
    )
  }

  /** Delete the company through the product; a refusal is kept as its sentence. */
  async deleteCompany(): Promise<void> {
    try {
      await withRlsContext(this.org.admin, (tx) =>
        deleteCompany(tx, {
          orgId: this.orgId,
          userId: this.org.adminId,
          companyId: this.companyId,
        }),
      )
    } catch (err) {
      this.refusal = err instanceof Error ? err.message : String(err)
    }
  }

  /** Delete the person through the product; a refusal is kept as its sentence. */
  async deleteContact(): Promise<void> {
    try {
      await withRlsContext(this.org.admin, (tx) =>
        deleteContact(tx, {
          orgId: this.orgId,
          userId: this.org.adminId,
          contactId: this.contactId,
        }),
      )
    } catch (err) {
      this.refusal = err instanceof Error ? err.message : String(err)
    }
  }

  async companyExists(): Promise<boolean> {
    return (await this.companyName_()) !== null
  }

  async contactExists(id = this.contactId): Promise<boolean> {
    const [row] = (await sql`
      SELECT 1 AS one FROM ${sql(schemaRef("kernel"))}.contacts WHERE id = ${id}`) as Array<{
      one: number
    }>
    return Boolean(row)
  }

  async loseRead(): Promise<void> {
    await minimal.revokeScope(this.people.clerk, this.reads.scope)
  }

  async regainRead(): Promise<void> {
    await minimal.grantScope(this.people.clerk, this.reads.scope)
  }

  async clerkHolds(): Promise<boolean> {
    return (await ctxOf(this.orgId, this.people.clerk)).scopes.includes(this.reads.scope)
  }

  async clerkVersion(): Promise<number> {
    const [row] = (await sql`
      SELECT permission_version FROM ${sql(schemaRef("kernel"))}.users WHERE id = ${this.people.clerk}`) as Array<{
      permission_version: number
    }>
    return row?.permission_version ?? 0
  }

  /** The payments connector switched off and back on. */
  async paymentsOffAndOn(): Promise<void> {
    await setOrgAppStatus(this.orgId, "stripe", "disabled")
    await setOrgAppStatus(this.orgId, "stripe", "active")
  }

  async appStatus(app: string): Promise<string | null> {
    const [row] = (await sql`
      SELECT status FROM ${sql(schemaRef("kernel"))}.apps WHERE org_id = ${this.orgId} AND name = ${app}`) as Array<{
      status: string
    }>
    return row?.status ?? null
  }

  exportFileId: string | null = null

  /** The person's data subject export, as the admin runs it. */
  async exportContact(): Promise<Record<string, unknown>> {
    const res = await executeTool<{ fileId: string }>({
      toolName: "kernel:data_subject_export",
      orgId: this.orgId,
      actor: this.org.admin,
      params: { contactId: this.contactId },
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
}

/** Every string under `key` anywhere in a bundle. */
function valuesAt(bundle: unknown, key: string): string[] {
  const out: string[] = []
  const walk = (v: unknown) => {
    if (Array.isArray(v)) for (const x of v) walk(x)
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (k === key && typeof x === "string") out.push(x)
        else walk(x)
      }
    }
  }
  walk(bundle)
  return out
}

function cell(c: CellImpl<MoneyCase>): CellImpl {
  return c as CellImpl
}

const money_ = (link: MoneyLink) => async () => new MoneyCase(await moneyOrg(), link).build()

const permissionLost = (name: string, link: MoneyLink): CellImpl =>
  cell({
    link: name,
    event: "Pm",
    says: "a reader lost the read scope",
    build: money_(link),
    mustSee: SEE,
    whoIsTold: ["admin"],
    act: (w) => w.loseRead(),
    took: async (w) => expect(await w.clerkHolds()).toBe(false),
    facts: () => ({ lostAccess: "clerk", neverHad: "outsider" }),
  })

const paymentsBack = (name: string, link: MoneyLink): CellImpl =>
  cell({
    link: name,
    event: "Rv",
    says: "the payments connector switched off and on again",
    build: money_(link),
    mustSee: SEE,
    mark: async (w) => ({ version: await w.clerkVersion(), rows: await w.rows() }),
    act: (w) => w.paymentsOffAndOn(),
    took: async (w, mark) => {
      expect(await w.appStatus("stripe")).toBe("active")
      expect(await w.clerkVersion()).toBeGreaterThanOrEqual(
        (mark as { version: number }).version + 2,
      )
    },
    facts: async (w) => ({ rowsAfter: await w.rows(), rowsBefore: 1 }),
  })

const permissionBack = (name: string, link: MoneyLink): CellImpl =>
  cell({
    link: name,
    event: "Rv",
    says: "a reader lost the read scope and got it back",
    build: money_(link),
    mustSee: SEE,
    mark: async (w) => ({ version: await w.clerkVersion() }),
    act: async (w) => {
      await w.loseRead()
      await w.regainRead()
    },
    took: async (w, mark) => {
      expect(await w.clerkHolds()).toBe(true)
      expect(await w.clerkVersion()).toBeGreaterThanOrEqual(
        (mark as { version: number }).version + 2,
      )
    },
    facts: async (w) => ({ rowsAfter: await w.rows(), rowsBefore: 1 }),
  })

/** The person's data subject export carries the link's row (`id` anywhere in the bundle). */
const exported = (name: string, link: MoneyLink, rowId: (w: MoneyCase) => string): CellImpl =>
  cell({
    link: name,
    event: "Ex",
    says: "the person's data subject export",
    build: money_(link),
    mustSee: SEE,
    act: async (w) => {
      w.exported = valuesAt(await w.exportContact(), "id")
    },
    took: async (w) => expect(w.exportFileId).not.toBeNull(),
    facts: (w) => ({ exported: w.exported, linkRowId: rowId(w) }),
  })

export function moneyCells(): CellImpl[] {
  return [
    // ── invoice-party ─────────────────────────────────────────────────────────
    cell({
      link: "invoice-party",
      event: "Mg",
      says: "its person merged into another",
      build: money_("invoiceParty"),
      mustSee: SEE,
      act: (w) => w.mergeContact(),
      took: async (w) => expect(await w.contactExists()).toBe(false),
      facts: (w) => ({ survivor: w.otherContactId, goneId: w.contactId }),
    }),
    cell({
      link: "invoice-party",
      event: "Rn",
      says: "its person renamed after the invoice was issued",
      build: money_("invoiceParty"),
      mustSee: SEE,
      act: (w) => w.renameContact(),
      took: async (w) => expect(await w.contactName_()).toBe(`${w.contactName} renamed`),
      facts: (w) => ({ newName: `${w.contactName} renamed`, oldName: w.contactName }),
    }),
    permissionLost("invoice-party", "invoiceParty"),
    permissionBack("invoice-party", "invoiceParty"),
    cell({
      link: "invoice-party",
      event: "Ex",
      says: "the person's data subject export",
      build: money_("invoiceParty"),
      mustSee: SEE,
      act: async (w) => {
        w.exported = valuesAt(await w.exportContact(), "id")
      },
      took: async (w) => expect(w.exportFileId).not.toBeNull(),
      facts: (w) => ({ exported: w.exported, linkRowId: w.inv.documentId }),
    }),

    // ── schedule-party ────────────────────────────────────────────────────────
    cell({
      link: "schedule-party",
      event: "Rn",
      says: "its company renamed",
      build: money_("scheduleParty"),
      mustSee: SEE,
      act: (w) => w.renameCompany(),
      took: async (w) => expect(await w.companyName_()).toBe(`${w.companyName} renamed`),
      facts: (w) => ({ newName: `${w.companyName} renamed`, oldName: w.companyName }),
    }),
    cell({
      link: "schedule-party",
      event: "Mg",
      says: "its company merged into another",
      build: money_("scheduleParty"),
      mustSee: SEE,
      act: (w) => w.mergeCompany(),
      took: async (w) => expect(await w.companyExists()).toBe(false),
      facts: (w) => ({ survivor: w.otherCompanyId, goneId: w.companyId }),
    }),
    cell({
      link: "schedule-party",
      event: "Dl",
      says: "its company deleted while the schedule bills it",
      build: money_("scheduleParty"),
      mustSee: SEE,
      act: (w) => w.deleteCompany(),
      took: async (w) => {
        expect(w.refusal).not.toBeNull()
        expect(await w.companyExists()).toBe(true)
      },
      facts: (w) => ({ refusal: w.refusal }),
    }),
    permissionLost("schedule-party", "scheduleParty"),
    permissionBack("schedule-party", "scheduleParty"),

    // ── schedule-contact ──────────────────────────────────────────────────────
    cell({
      link: "schedule-contact",
      event: "Mg",
      says: "its person merged into another",
      build: money_("scheduleContact"),
      mustSee: SEE,
      act: (w) => w.mergeContact(),
      took: async (w) => expect(await w.contactExists()).toBe(false),
      facts: (w) => ({ survivor: w.otherContactId, goneId: w.contactId }),
    }),
    cell({
      link: "schedule-contact",
      event: "Dl",
      says: "its person deleted while the schedule bills them",
      build: money_("scheduleContact"),
      mustSee: SEE,
      act: (w) => w.deleteContact(),
      took: async (w) => {
        expect(w.refusal).not.toBeNull()
        expect(await w.contactExists()).toBe(true)
      },
      facts: (w) => ({ refusal: w.refusal }),
    }),
    exported("schedule-contact", "scheduleContact", (w) => w.inv.scheduleId),

    // ── run-item-schedule-draft ───────────────────────────────────────────────
    permissionLost("run-item-schedule-draft", "runItem"),
    permissionBack("run-item-schedule-draft", "runItem"),

    // ── payments-customer-party ─────────────────────────────────────────────────
    cell({
      link: "payments-customer-party",
      event: "Rn",
      says: "its company renamed",
      build: money_("paymentsCustomer"),
      mustSee: SEE,
      act: (w) => w.renameCompany(),
      took: async (w) => expect(await w.companyName_()).toBe(`${w.companyName} renamed`),
      facts: (w) => ({ newName: `${w.companyName} renamed`, oldName: w.companyName }),
    }),
    cell({
      link: "payments-customer-party",
      event: "Mg",
      says: "its company merged into another",
      build: money_("paymentsCustomer"),
      mustSee: SEE,
      act: (w) => w.mergeCompany(),
      took: async (w) => expect(await w.companyExists()).toBe(false),
      facts: (w) => ({ survivor: w.otherCompanyId, goneId: w.companyId }),
    }),
    cell({
      link: "payments-customer-party",
      event: "Dl",
      says: "its company deleted",
      build: money_("paymentsCustomer"),
      mustSee: SEE,
      act: (w) => w.deleteCompany(),
      took: async (w) => {
        if (w.refusal) throw new Error(`company delete refused: ${w.refusal}`)
        expect(await w.companyExists()).toBe(false)
      },
      facts: (w) => ({ goneId: w.companyId }),
    }),
    permissionLost("payments-customer-party", "paymentsCustomer"),
    paymentsBack("payments-customer-party", "paymentsCustomer"),

    // ── payments-customer-contact ───────────────────────────────────────────────
    cell({
      link: "payments-customer-contact",
      event: "Mg",
      says: "its person merged into another",
      build: money_("paymentsCustomerContact"),
      mustSee: SEE,
      act: (w) => w.mergeContact(),
      took: async (w) => expect(await w.contactExists()).toBe(false),
      facts: (w) => ({ survivor: w.otherContactId, goneId: w.contactId }),
    }),
    cell({
      link: "payments-customer-contact",
      event: "Dl",
      says: "its person deleted",
      build: money_("paymentsCustomerContact"),
      mustSee: SEE,
      act: (w) => w.deleteContact(),
      took: async (w) => {
        if (w.refusal) throw new Error(`person delete refused: ${w.refusal}`)
        expect(await w.contactExists()).toBe(false)
      },
      facts: (w) => ({ goneId: w.contactId }),
    }),
    exported("payments-customer-contact", "paymentsCustomerContact", (w) => w.customerId),

    // ── payments-invoice-document ───────────────────────────────────────────────
    permissionLost("payments-invoice-document", "paymentsInvoice"),
    paymentsBack("payments-invoice-document", "paymentsInvoice"),

    // ── payments-refund-charge ──────────────────────────────────────────────────
    permissionLost("payments-refund-charge", "paymentsRefund"),
    paymentsBack("payments-refund-charge", "paymentsRefund"),
  ]
}
