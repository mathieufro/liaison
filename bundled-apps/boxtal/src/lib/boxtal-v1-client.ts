// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Boxtal v1 cotation (quote) client. The v1 API ALWAYS returns XML, regardless
// of Accept header. Authenticates via Basic auth. The querystring uses French
// keys (`colis_N.poids`, `expediteur.pays`, …). Offers are parsed from
// `<offer>` blocks with a hand-rolled scanner (NO DOM, NO node:* — the bundle
// runs in QuickJS), sorted ascending by tax-exclusive price, and DEV-mode rows
// are filtered out.

import {
  type BoxtalEnvironment,
  type BoxtalFetch,
  BoxtalApiError,
} from "./boxtal-v3-client"
import { BOXTAL_HTTP_TIMEOUT_MS, timeoutHints } from "./http-budget"

const V1_BASE: Record<BoxtalEnvironment, string> = {
  sandbox: "https://test.envoimoinscher.com",
  production: "https://www.envoimoinscher.com",
}

export interface CotationParty {
  country: string
  postalCode: string
  city: string
  /** Boxtal `type`: "entreprise" | "particulier". */
  type: string
  /** State/region code — required for US/AU destinations. */
  state?: string
}

export interface CotationParcel {
  weight: number
  length: number
  width: number
  height: number
  /** N identical parcels in one entry — the natural way a model expresses "5
   *  cartons of 19 kg". Expanded into N colis before the cotation call (cap 20
   *  total); absent or 1 means a single parcel. */
  quantity?: number
}

export interface CotationInput {
  /**
   * Optional invoice/draft reference. When present, `quote` resolves the draft
   * (same compute as `shipment_draft_create`) and DEFAULTS `to` (recipient
   * country/postal/city), `parcels`, and `content_code` from it — the agent
   * does not have to re-key the destination it already has on the draft. Any
   * field the caller supplies explicitly still wins. This is what makes a
   * route-correct (e.g. JP) quote happen without the agent hand-building the
   * recipient country (the common weak-model miss that fell back to a domestic
   * quote). `from` still defaults to the org's configured ship-from.
   */
  draft_id?: string
  /**
   * Quote the REVERSE (return) leg: after enrichment resolves the outbound
   * route (from = org ship-from, to = the customer/draft recipient), the two
   * parties are SWAPPED so the cotation prices customer→us — the leg a
   * warranty/RMA return label actually ships. Mirrors `create_shipment`'s
   * `is_return`; a return staged there validates its offer_code against THIS
   * swapped quote, so quote and create must carry the same flag. Never sent to
   * the Boxtal API (the v1 cotation has no direction field — direction IS the
   * from/to order).
   */
  is_return?: boolean
  /**
   * Bypass the org's relay / pickup-point exclusion policy for THIS quote only:
   * when the org excludes pickup-point services (the default), set true to include
   * them anyway (the "customer explicitly wants a relay" case). Has no effect when
   * the policy is off (relay offers already survive). Never sent to the Boxtal API
   * (it is applied to the returned offers, not part of the cotation query).
   */
  include_pickup_point?: boolean
  /**
   * Bypass the org's carrier allowlist for THIS quote only: when the org restricts
   * quotes to an allowlisted set of brands (e.g. UPS/FedEx/DHL), set true to quote
   * the FULL carrier market anyway (the ad-hoc "what else is out there / is there a
   * cheaper non-allowlisted carrier" case). The allowlist is an advisory GUIDELINE
   * that shapes ROUTINE quoting (the prep-dashboard cheapest defaults to an
   * allowlisted carrier); it is NOT a hard gate. This flag lets an operator explore
   * the whole market without mutating the org allowlist setting, and create_shipment
   * sets it on its own pre-buy re-quotes so a gated, human-approved buy is never
   * refused merely for shipping a non-allowlisted carrier (the human approval is the
   * guardrail; the genuine route-validity + price-drift checks still run). Never sent
   * to the Boxtal API (it is applied to the returned offers, not the cotation query).
   */
  ignore_allowlist?: boolean
  // Optional on the public input: when `draft_id` is supplied (or for `from`, the
  // org ship-from), these are resolved during enrichment (`enrichFromDraft` /
  // `enrichCotation`) before the Boxtal cotation call. The caller's explicit
  // fields always win; only absent ones are filled.
  from?: CotationParty
  to?: CotationParty
  parcels?: CotationParcel[]
  /** Single dominant content-category numeric code (`code_contenu`). May be
   *  defaulted from the resolved draft when `draft_id` is supplied. */
  content_code?: string
  /** Desired collection date (YYYY-MM-DD). */
  collection_date?: string
  /** Declared goods value (optional). */
  value?: number
  /** Filter by carrier operator code. */
  operator?: string
  /** Filter by service code. */
  service?: string
  /** Request insurance. */
  insured?: boolean
}

export interface Offer {
  offer_code: string
  carrier: string
  carrier_code: string
  service: string
  service_code: string
  price_ht: number
  price_ttc: number
  currency: string
  collection_date: string | null
  delivery_date: string | null
  insurance_ht: number | null
  needs_relay_point: boolean
  /**
   * Raw Boxtal v1 collection `<type><code>` (live prod codes: "COMPANY"/"HOME"/"PICKUP" = carrier
   * collects at the sender's premises; "POST_OFFICE"/"DROPOFF_POINT"/"PICKUP_POINT" = the sender
   * must drop the parcel at a relay/post point). `null`
   * when the offer's `<collection>`/`<type>` block is absent from the XML (seen on some routes) —
   * a genuinely UNKNOWN pickup mode, not a known dropoff, so callers must not treat `null` as
   * "not at sender".
   */
  collection_type: string | null
  /**
   * Derived: true when the collection type code is a known on-premise (carrier-collects-at-sender)
   * code, false when it is a known relay/dropoff-point code. `null` when `collection_type` is
   * `null` (block absent) — the pickup mode is UNKNOWN, not "false". Never coerce this to `false`
   * when filtering: a `null` here must be surfaced with a caveat, not silently excluded from an
   * "on-premise pickup" match (that would drop a possibly-valid offer instead of flagging it as
   * unknown).
   */
  pickup_at_sender: boolean | null
}

export interface BoxtalV1ClientOptions {
  fetch: BoxtalFetch
  environment: BoxtalEnvironment
  /** The credentials connection whose v1 key pair the host sends. Default "boxtal". */
  connection?: string
  /** Cap for the single cotation round trip. Default BOXTAL_HTTP_TIMEOUT_MS. */
  requestTimeoutMs?: number
}

/** Build the French cotation querystring (no leading `?`). */
/**
 * QuickJS-safe querystring builder. The sandbox provides NEITHER
 * `URLSearchParams` NOR a DOM, so `new URLSearchParams()` throws
 * `URLSearchParams is not defined` at runtime (the E2E quote tool caught the
 * live throw). Encode each pair with `encodeURIComponent` and join with `&`;
 * `URLSearchParams` form-encodes spaces as `+`, so mirror that for parity with
 * the original output (the keys/values here are ASCII, but the `+` rule keeps
 * any city name with a space byte-identical to the prior behaviour).
 */
function qsPair(key: string, value: string): string {
  const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, "+")
  return `${enc(key)}=${enc(value)}`
}

export function buildCotationQuery(input: CotationInput): string {
  const pairs: string[] = []
  const set = (k: string, v: string) => pairs.push(qsPair(k, v))
  // from/to/parcels are resolved by enrichFromDraft/enrichCotation before this
  // runs, so they are present here; guard defensively to satisfy the optional
  // public-input type without changing the emitted query for a resolved input.
  const parcels = input.parcels ?? []
  parcels.forEach((parcel, i) => {
    const n = i + 1
    set(`colis_${n}.poids`, String(parcel.weight))
    set(`colis_${n}.longueur`, String(parcel.length))
    set(`colis_${n}.largeur`, String(parcel.width))
    set(`colis_${n}.hauteur`, String(parcel.height))
  })
  if (input.content_code) set("code_contenu", input.content_code)
  const { from, to } = input
  if (from) {
    set("expediteur.pays", from.country)
    set("expediteur.code_postal", from.postalCode)
    set("expediteur.ville", from.city)
    set("expediteur.type", from.type)
    if (from.state) set("expediteur.code_region", from.state)
  }
  if (to) {
    set("destinataire.pays", to.country)
    set("destinataire.code_postal", to.postalCode)
    set("destinataire.ville", to.city)
    set("destinataire.type", to.type)
    if (to.state) set("destinataire.code_region", to.state)
  }
  if (input.collection_date) set("collecte", input.collection_date)
  if (input.value !== undefined) set("colis.valeur", String(input.value))
  if (input.operator) set("operator", input.operator)
  if (input.service) set("service", input.service)
  if (input.insured) set("assurance", "true")
  return pairs.join("&")
}

// — hand-rolled XML helpers (QuickJS-safe; no DOM) —

/** Return the inner text of the FIRST `<tag>…</tag>` inside `xml`, or null. */
function firstTag(xml: string, tag: string): string | null {
  const open = `<${tag}>`
  const close = `</${tag}>`
  const start = xml.indexOf(open)
  if (start === -1) return null
  const end = xml.indexOf(close, start + open.length)
  if (end === -1) return null
  return xml.slice(start + open.length, end)
}

/** Return all top-level `<tag>…</tag>` block bodies inside `xml`. */
function allBlocks(xml: string, tag: string): string[] {
  const open = `<${tag}>`
  const close = `</${tag}>`
  const out: string[] = []
  let cursor = 0
  while (true) {
    const start = xml.indexOf(open, cursor)
    if (start === -1) break
    const end = xml.indexOf(close, start + open.length)
    if (end === -1) {
      // Malformed: an opening tag with no matching close.
      throw new BoxtalApiError(
        `Boxtal v1 cotation XML malformed: unterminated <${tag}>`,
        200,
        xml.slice(start, start + 120),
      )
    }
    out.push(xml.slice(start + open.length, end))
    cursor = end + close.length
  }
  return out
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim()
}

/**
 * Parse a cotation XML body into a sorted, DEV-filtered `Offer[]`. An `<error>`
 * body throws a `BoxtalApiError` carrying the verbatim `<message>`. An empty
 * offer set returns `[]` (not an error).
 */
/** Boxtal's v1 cotation errors come back as XML carrying the offending field in an
 *  `<error>`/`<message>` element. Pull that out for the thrown message, falling back to a
 *  trimmed slice of the body so an unrecognised shape still says something concrete. */
export function describeCotationError(body: string): string {
  if (!body || body.trim() === "") return ""
  const tagged = body.match(/<(?:message|error|erreur)>\s*([\s\S]*?)\s*<\/(?:message|error|erreur)>/i)
  const raw = tagged?.[1] ?? body
  const text = raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
  if (text === "") return ""
  return `: ${text.length > 300 ? `${text.slice(0, 300)}...` : text}`
}

export function parseCotationXml(xml: string): Offer[] {
  // Error envelope wins.
  if (xml.includes("<error>")) {
    const message = decodeXml(firstTag(xml, "message") ?? "Boxtal cotation error")
    const code = firstTag(xml, "code")?.trim() ?? "ERROR"
    throw new BoxtalApiError(`Boxtal v1 cotation error [${code}]: ${message}`, 200, xml)
  }
  // Detect gross truncation: an unbalanced top-level structure.
  const opens = (xml.match(/<offer>/g) ?? []).length
  const closes = (xml.match(/<\/offer>/g) ?? []).length
  if (opens !== closes) {
    throw new BoxtalApiError("Boxtal v1 cotation XML malformed: unbalanced <offer>", 200, xml.slice(0, 120))
  }

  const offers: Offer[] = []
  for (const block of allBlocks(xml, "offer")) {
    const mode = firstTag(block, "mode")?.trim() ?? "COM"
    if (mode === "DEV") continue // drop sandbox/dev offers

    const operatorBlock = firstTag(block, "operator") ?? ""
    const serviceBlock = firstTag(block, "service") ?? ""
    const priceBlock = firstTag(block, "price") ?? ""
    const collectionBlock = firstTag(block, "collection") ?? ""
    const deliveryBlock = firstTag(block, "delivery") ?? ""

    const carrier_code = decodeXml(firstTag(operatorBlock, "code") ?? "")
    const carrier = decodeXml(firstTag(operatorBlock, "label") ?? "")
    const service_code = decodeXml(firstTag(serviceBlock, "code") ?? "")
    const service = decodeXml(firstTag(serviceBlock, "label") ?? "")
    const price_ht = Number(firstTag(priceBlock, "tax-exclusive") ?? "0")
    const price_ttc = Number(firstTag(priceBlock, "tax-inclusive") ?? "0")
    const currency = decodeXml(firstTag(priceBlock, "currency") ?? "EUR")
    const collection_date = firstTag(collectionBlock, "date")?.trim() ?? null
    const delivery_date = firstTag(deliveryBlock, "date")?.trim() ?? null

    // Relay-point requirement: the delivery type code carries PICKUP_POINT.
    const deliveryTypeBlock = firstTag(deliveryBlock, "type") ?? ""
    const deliveryTypeCode = firstTag(deliveryTypeBlock, "code")?.trim() ?? ""
    const needs_relay_point = deliveryTypeCode === "PICKUP_POINT"

    // On-premise pickup: live prod cotations return COMPANY (carrier collects at the sender's
    // business address) or HOME (residential collection) alongside the PICKUP code seen in older
    // fixtures; POST_OFFICE / DROPOFF_POINT / PICKUP_POINT mean the sender must drop the parcel
    // at a relay or post point. The <collection><type> block is absent on some routes/offers —
    // in that case, and for any code not in either known set, leave pickup_at_sender null
    // (unknown), never assert false: a false-negative here would silently drop a possibly-valid
    // on-premise-pickup offer from an agent's filter.
    const collectionTypeBlock = firstTag(collectionBlock, "type")
    const collectionTypeCode = collectionTypeBlock != null ? firstTag(collectionTypeBlock, "code")?.trim() ?? null : null
    const collection_type = collectionTypeCode
    const AT_SENDER_CODES = ["PICKUP", "COMPANY", "HOME"]
    const DROPOFF_CODES = ["DROPOFF_POINT", "POST_OFFICE", "PICKUP_POINT", "CHRONOPOST_SITE"]
    const pickup_at_sender = collection_type === null
      ? null
      : AT_SENDER_CODES.includes(collection_type)
        ? true
        : DROPOFF_CODES.includes(collection_type)
          ? false
          : null

    const insuranceRaw = firstTag(block, "insurance")
    const insurance_ht = insuranceRaw != null ? Number(insuranceRaw) : null

    offers.push({
      offer_code: `${carrier_code}-${service_code}`,
      carrier,
      carrier_code,
      service,
      service_code,
      price_ht,
      price_ttc,
      currency,
      collection_date,
      delivery_date,
      insurance_ht,
      needs_relay_point,
      collection_type,
      pickup_at_sender,
    })
  }

  offers.sort((a, b) => a.price_ht - b.price_ht)
  return offers
}

export class BoxtalV1Client {
  readonly fetchImpl: BoxtalFetch
  private readonly connection: string
  private readonly environment: BoxtalEnvironment
  /** Cap for this client's single HTTP round trip (http-budget.ts). A cotation
   *  is one GET, so the per-request cap IS the whole call budget here. */
  private readonly requestTimeoutMs: number

  constructor(opts: BoxtalV1ClientOptions) {
    this.fetchImpl = opts.fetch
    this.connection = opts.connection ?? "boxtal"
    this.environment = opts.environment
    this.requestTimeoutMs = opts.requestTimeoutMs ?? BOXTAL_HTTP_TIMEOUT_MS
  }

  private get base(): string {
    return V1_BASE[this.environment]
  }

  /** GET /api/v1/cotation → sorted, DEV-filtered Offer[]. */
  async quote(input: CotationInput): Promise<Offer[]> {
    const qs = buildCotationQuery(input)
    const url = `${this.base}/api/v1/cotation?${qs}`
    const res = await this.fetchImpl(url, {
      method: "GET",
      // HTTP Basic of the v1 key pair, added host-side: the keys never enter the bundle.
      auth: { connection: this.connection, scheme: "basic", fields: ["v1Key", "v1Secret"] },
      ...timeoutHints(this.requestTimeoutMs),
    })
    if (res.status >= 400) {
      // Carry Boxtal's own reason in the MESSAGE, not just the body: across the
      // sandbox-worker IPC boundary the error is flattened to a plain Error that
      // keeps only its message, so a body-only detail is lost exactly where the
      // operator reads it. A bare "HTTP 400" told them nothing about which field
      // the carrier rejected (a missing postal code reads identically to a bad
      // weight), which is the failure this spells out.
      throw new BoxtalApiError(
        `Boxtal v1 cotation HTTP ${res.status}${describeCotationError(res.body)}`,
        res.status,
        res.body,
      )
    }
    return parseCotationXml(res.body)
  }
}
