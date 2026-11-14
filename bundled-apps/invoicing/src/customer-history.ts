// SPDX-License-Identifier: FSL-1.1-ALv2
//
// customer_history: a customer's earlier sales in one read, so "same price as last time" is
// answered from the record. The customer is found the way a person would look: the name on the
// document, the name inside its address (an invoice made out to a company often names the person
// only there), the email, the linked contact, and the store's orders by name, email or the order
// numbers on the documents found. Each document comes with its lines and unit prices, and the
// most recent line of the asked product is picked out as `last_sale`. The recurring schedules
// that bill the customer come with it: a price said to hold from now on is the schedule's.

import { normaliseAddress } from "./address-match"
import { shopifyAbsent, shopifyTerm } from "./buyer-vat"
import { formatMoneyMinor } from "./money"
import { type DocumentHeader, documentsSearch, type ReadsCtx } from "./reads"

export interface CustomerHistoryInput {
  /** The customer's name, company, email or a word of their address, as the user said it. */
  customer?: string
  /** The kernel contact, when known: adds the documents linked to it or made out to its email or address. */
  contact_id?: string
  /** Only lines of this product ("Mono MK2"): every word must be in the line description. */
  product?: string
  /** At most this many documents (default 10, at most 25). */
  limit?: number
}

export interface CustomerHistoryLine {
  description: string
  quantity: string
  unit_price: string
  unit_price_minor: string
  discount_minor: string
  /** The price paid per unit: the line's subtotal (after its discount, before VAT) over its quantity. */
  net_unit_price: string
  net_unit_price_minor: string
  tax_rate_bp: number | null
  line_total: string
}

export interface CustomerHistoryDocument {
  id: string
  number: string | null
  type: string
  status: string
  issued_at: string | null
  counterparty_name: string | null
  counterparty_address: string | null
  currency: string
  grand_total: string
  shopify_order_number: string | null
  lines: CustomerHistoryLine[]
}

export interface CustomerHistoryOrder {
  order: string
  created_at: string | null
  customer: string | null
  email: string | null
  total: string | null
  items: Array<{ title: string | null; quantity: number }>
}

/** A recurring schedule that bills the customer, as its next invoices will read. */
export interface CustomerHistorySchedule {
  id: string
  status: string
  repeats: string
  next_issue_on: string | null
  lines: Array<{ description: string; quantity: string; unit_price_minor: string }>
}

export interface CustomerHistoryResult {
  customer: string | null
  /** The latest sale of `product` (or the latest line of any product when none is asked). */
  last_sale: {
    description: string
    /** The price paid per unit (after the line's discount, before VAT): what "same price" means. */
    unit_price: string
    unit_price_minor: string
    /** The list price per unit printed on the line, before its discount. */
    list_unit_price: string
    quantity: string
    currency: string
    document: string
    document_type: string
    issued_at: string | null
  } | null
  documents: CustomerHistoryDocument[]
  /** The schedules (not ended) that bill this customer: the price of their next invoices. */
  recurring_schedules: CustomerHistorySchedule[]
  shopify_orders: CustomerHistoryOrder[]
  /** "checked", "not connected", or why the store could not be read. */
  shopify: string
  note: string
}

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 25
const SHOPIFY_TIMEOUT_MS = 2500
const SHOPIFY_LIMIT = 5
/** Documents that are sales (a purchase order is a supplier's). */
const SALE_TYPES = new Set(["invoice", "proforma", "quote", "credit_note"])
/** Statuses that are not a sale that happened. */
const NOT_A_SALE = new Set(["draft", "void", "voided", "cancelled", "discarded"])

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null
}

/** Every word of the product is in the text, or the product without spaces is ("mk 2" / "mk2"). */
function productMatches(product: string | null, text: string): boolean {
  if (!product) return true
  const words = normaliseAddress(product).split(" ").filter(Boolean)
  const t = normaliseAddress(text)
  if (words.length === 0) return true
  if (words.every((w) => t.includes(w))) return true
  return t.replace(/ /g, "").includes(words.join(""))
}

/**
 * The price paid per unit, in minor units: the line's subtotal (quantity x unit price minus the
 * line's discount, before VAT) over its quantity. An imported dealer invoice carries the list price
 * per unit and the dealer price only as a line discount (2 x 490.83 less 261.66 = 720.00), so the
 * printed unit price is not what the customer paid.
 */
function netUnitMinor(row: Record<string, unknown>, unit: string): string {
  const qty = Number(row.quantity ?? 0)
  const isInt = (v: string) => /^-?\d+$/.test(v)
  const unitMinor = isInt(unit) ? Number(unit) : 0
  if (!(qty > 0)) return String(unitMinor)
  const sub = String(row.subtotal_minor ?? "")
  const discount = String(row.discount_minor ?? "0")
  const subtotal = isInt(sub)
    ? Number(sub)
    : Math.round(unitMinor * qty) - (isInt(discount) ? Number(discount) : 0)
  return String(Math.round(subtotal / qty))
}

function lineOf(row: Record<string, unknown>, currency: string): CustomerHistoryLine {
  const unit = String(row.unit_price_minor ?? "0")
  const total = String(row.total_minor ?? "0")
  const net = netUnitMinor(row, unit)
  return {
    description: String(row.description ?? ""),
    quantity: String(row.quantity ?? "0"),
    unit_price: formatMoneyMinor(/^-?\d+$/.test(unit) ? unit : "0", currency),
    unit_price_minor: unit,
    discount_minor: String(row.discount_minor ?? "0"),
    net_unit_price: formatMoneyMinor(net, currency),
    net_unit_price_minor: net,
    tax_rate_bp: row.tax_rate_bp == null ? null : Number(row.tax_rate_bp),
    line_total: formatMoneyMinor(/^-?\d+$/.test(total) ? total : "0", currency),
  }
}

interface OrderHit {
  id?: unknown
  title?: unknown
  currency?: unknown
  attributes?: {
    email?: unknown
    createdAt?: unknown
    totalAmount?: unknown
    customer?: { firstName?: unknown; lastName?: unknown; email?: unknown } | null
    lineItems?: Array<{ title?: unknown; quantity?: unknown }> | null
  }
}

/** The customer's store orders: by name, by email, by the order numbers on their documents. */
async function shopifyOrders(
  ctx: ReadsCtx,
  customer: string | null,
  docs: DocumentHeader[],
  product: string | null,
): Promise<{ orders: CustomerHistoryOrder[]; status: string }> {
  const exec = ctx.executeTool
  if (!exec) return { orders: [], status: "not connected" }
  const queries: string[] = []
  const emails = new Set<string>()
  if (customer?.includes("@")) emails.add(customer.trim())
  for (const d of docs) if (d.counterparty_email) emails.add(d.counterparty_email)
  if (customer && !customer.includes("@")) queries.push(`"${shopifyTerm(customer)}"`)
  for (const e of [...emails].slice(0, 2)) queries.push(`email:"${shopifyTerm(e)}"`)
  const numbers = [
    ...new Set(docs.map((d) => d.shopify_order_number).filter((n): n is string => !!n)),
  ].slice(0, 5)
  if (numbers.length > 0)
    queries.push(numbers.map((n) => `name:#${shopifyTerm(n.replace(/^#/, ""))}`).join(" OR "))
  if (queries.length === 0) return { orders: [], status: "checked" }
  let absent = 0
  let failed: string | null = null
  const answers = await Promise.all(
    queries.slice(0, 4).map(async (query) => {
      try {
        const env = await exec("shopify:orders_search", {
          query,
          limit: SHOPIFY_LIMIT,
          timeout_ms: SHOPIFY_TIMEOUT_MS,
        })
        if (env.status === "completed") {
          const results = (env.result as { results?: unknown } | null)?.results
          return Array.isArray(results) ? (results as OrderHit[]) : []
        }
        const code =
          env.status === "error" ? String(env.error?.code ?? "error") : String(env.status)
        const message = env.status === "error" ? String(env.error?.message ?? "") : ""
        if (shopifyAbsent(`${code} ${message}`)) absent++
        else failed ??= code
      } catch (err) {
        const code = String((err as { code?: unknown } | null)?.code ?? "error")
        if (shopifyAbsent(`${code} ${String((err as Error | null)?.message ?? "")}`)) absent++
        else failed ??= code
      }
      return [] as OrderHit[]
    }),
  )
  if (absent === Math.min(queries.length, 4)) return { orders: [], status: "not connected" }
  const byId = new Map<string, CustomerHistoryOrder>()
  for (const hit of answers.flat()) {
    const id = String(hit?.id ?? hit?.title ?? "")
    if (!id || byId.has(id)) continue
    const a = hit.attributes ?? {}
    const items = (Array.isArray(a.lineItems) ? a.lineItems : []).map((li) => ({
      title: str(li?.title),
      quantity: typeof li?.quantity === "number" ? li.quantity : Number(li?.quantity ?? 0) || 0,
    }))
    if (product && items.length > 0 && !items.some((i) => productMatches(product, i.title ?? "")))
      continue
    const name = [str(a.customer?.firstName), str(a.customer?.lastName)].filter(Boolean).join(" ")
    const amount = str(a.totalAmount)
    const currency = str(hit.currency)
    byId.set(id, {
      order: str(hit.title) ?? id,
      created_at: str(a.createdAt),
      customer: name || null,
      email: str(a.email) ?? str(a.customer?.email),
      total: amount
        ? `${amount}${currency ? ` ${currency}` : ""} (order total, tax and shipping included)`
        : null,
      items,
    })
  }
  return {
    orders: [...byId.values()],
    status: failed ? `could not be checked (${failed})` : "checked",
  }
}

/** The schedules, not ended, of the customer's contacts. */
async function schedulesOf(
  ctx: ReadsCtx,
  contactIds: Array<string | null>,
): Promise<CustomerHistorySchedule[]> {
  const out: CustomerHistorySchedule[] = []
  for (const id of new Set(contactIds.filter((c): c is string => !!c))) {
    const rows = (await ctx.db.findMany("recurring_schedules", {
      where: { contact_id: id },
      orderBy: { next_issue_on: "asc" },
      limit: 10,
    })) as Array<Record<string, unknown>>
    for (const r of rows) {
      if (r.status === "ended") continue
      const raw = typeof r.lines === "string" ? (JSON.parse(r.lines) as unknown) : r.lines
      const lines = (Array.isArray(raw) ? raw : []) as Array<Record<string, unknown>>
      const day =
        r.next_issue_on instanceof Date
          ? r.next_issue_on.toISOString().slice(0, 10)
          : (str(r.next_issue_on)?.slice(0, 10) ?? null)
      out.push({
        id: String(r.id),
        status: String(r.status),
        repeats: String(r.repeats ?? ""),
        next_issue_on: day,
        lines: lines.map((l) => ({
          description: String(l.description ?? ""),
          quantity: String(l.qty ?? l.quantity ?? "1"),
          unit_price_minor: String(l.unit_price_minor ?? "0"),
        })),
      })
    }
  }
  return out
}

export async function customerHistory(
  ctx: ReadsCtx,
  input: CustomerHistoryInput = {},
): Promise<CustomerHistoryResult> {
  const customer = str(input.customer)
  const contactId = str(input.contact_id)
  const product = str(input.product)
  const limit = Math.min(Math.max(1, Math.floor(Number(input.limit) || DEFAULT_LIMIT)), MAX_LIMIT)

  const found = new Map<string, DocumentHeader>()
  const add = (rows: DocumentHeader[]) => {
    for (const r of rows) if (SALE_TYPES.has(r.type) && !found.has(r.id)) found.set(r.id, r)
  }
  if (contactId) add(await documentsSearch(ctx, { contact_id: contactId, limit: 50 }))
  if (customer) add(await documentsSearch(ctx, { query: customer, limit: 50 }))
  // The newest first: documentsSearch ranks by match, the history reads by date.
  const docs = [...found.values()].sort((a, b) =>
    String(b.issued_at ?? "").localeCompare(String(a.issued_at ?? "")),
  )

  const documents: CustomerHistoryDocument[] = []
  for (const d of docs) {
    if (documents.length >= limit) break
    const rows = (await ctx.db.findMany("document_lines", {
      where: { document_id: d.id },
      orderBy: { position: "asc" },
      limit: 200,
    })) as Array<Record<string, unknown>>
    const lines = rows
      .filter((l) => productMatches(product, String(l.description ?? "")))
      .map((l) => lineOf(l, d.currency))
    if (product && lines.length === 0) continue
    documents.push({
      id: d.id,
      number: d.number,
      type: d.type,
      status: d.status,
      issued_at: d.issued_at,
      counterparty_name: d.counterparty_name,
      counterparty_address: d.counterparty_address,
      currency: d.currency,
      grand_total: formatMoneyMinor(String(d.grand_total_minor ?? "0"), d.currency),
      shopify_order_number: d.shopify_order_number,
      lines,
    })
  }

  const pick =
    documents.find(
      (d) => d.type !== "credit_note" && !NOT_A_SALE.has(d.status) && d.lines.length > 0,
    ) ?? documents.find((d) => d.type !== "credit_note" && d.lines.length > 0)
  const line = pick?.lines[0]
  const last_sale =
    pick && line
      ? {
          description: line.description,
          unit_price: line.net_unit_price,
          unit_price_minor: line.net_unit_price_minor,
          list_unit_price: line.unit_price,
          quantity: line.quantity,
          currency: pick.currency,
          document: pick.number ?? pick.id,
          document_type: pick.type,
          issued_at: pick.issued_at,
        }
      : null

  const recurring_schedules = await schedulesOf(ctx, [
    contactId,
    ...docs.map((d) => d.counterparty_contact_id),
  ])
  const shop = await shopifyOrders(ctx, customer, docs, product)
  const who = customer ?? contactId ?? "this customer"
  const found_note =
    documents.length === 0 && shop.orders.length === 0 && recurring_schedules.length === 0
      ? `Nothing found for "${who}"${product ? ` with "${product}"` : ""}. Try the company name, the email, a word of the address, or the product alone.`
      : `For "same price as last time" use last_sale.unit_price: the price paid per unit, after the line's discount, before VAT. A line's unit_price is the list price printed before its discount; net_unit_price is what was paid.`
  const note =
    recurring_schedules.length > 0
      ? `${found_note} A recurring schedule bills this customer: a price that holds from now on is changed on it with recurring_schedule_update; a draft already made is changed with drafts_update.`
      : found_note
  return {
    customer,
    last_sale,
    documents,
    recurring_schedules,
    shopify_orders: shop.orders,
    shopify: shop.status,
    note,
  }
}
