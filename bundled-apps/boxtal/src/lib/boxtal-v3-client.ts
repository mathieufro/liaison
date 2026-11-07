// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Boxtal v3 JSON API client (shipping orders, tracking, documents, content
// categories, webhook subscriptions). Authenticates with a bearer from the
// Basic→Bearer exchange against `/iam/account-app/token`, which the HOST runs
// (`ctx.fetch` auth `exchange`): it caches the bearer until shortly before its
// declared expiry and drops it on a 401, and this client retries once on a 401
// so the retry exchanges again. Neither the key pair nor the bearer enters the
// bundle.
//
// Host-free: constructor-injected with a `fetch` shaped exactly like
// `ctx.fetch` (`(url, {method,headers,body}) → {status,headers,body}`). NEVER
// imports `node:*` — the bundle runs in the QuickJS sandbox.

import type { FetchAuth } from "@liaison/app-sdk"
import {
  BOXTAL_CALL_BUDGET_MS,
  BOXTAL_HTTP_TIMEOUT_MS,
  BUDGET_EXHAUSTED_STATUS,
  budgetExhaustedMessage,
  makeDeadline,
  timeoutHints,
  type Deadline,
} from "./http-budget"

export type BoxtalEnvironment = "sandbox" | "production"

export type BoxtalFetch = (
  url: string,
  opts?: {
    method?: string
    headers?: Record<string, string>
    body?: string
    /** Per-request abort hints added by the client's own time budget
     *  (http-budget.ts). A fetch implementation that ignores them is still
     *  correct: the client also refuses to start a request past its deadline. */
    signal?: unknown
    timeoutMs?: number
    /** The credential the host adds (`@liaison/app-sdk` FetchAuth). */
    auth?: FetchAuth
    /** `{ placeholder: configKey }`: a config secret the host writes into the body. */
    configSecrets?: Record<string, string>
  },
) => Promise<{ status: number; headers: Record<string, string>; body: string }>

export class BoxtalApiError extends Error {
  readonly status: number
  readonly body: string
  constructor(message: string, status: number, body = "") {
    super(message)
    this.name = "BoxtalApiError"
    this.status = status
    this.body = body
  }
}

export interface BoxtalV3ClientOptions {
  fetch: BoxtalFetch
  environment: BoxtalEnvironment
  /** The credentials connection whose v3 key pair the host exchanges. Default "boxtal". */
  connection?: string
  /** Injectable clock for deterministic expiry tests. Default Date.now. */
  now?: () => number
  /** Cap for ONE HTTP round trip. Default BOXTAL_HTTP_TIMEOUT_MS. */
  requestTimeoutMs?: number
  /** Cap for ONE logical API call (token exchange + request + 401 refresh).
   *  Default BOXTAL_CALL_BUDGET_MS. */
  callBudgetMs?: number
}

const V3_BASE: Record<BoxtalEnvironment, string> = {
  sandbox: "https://api.boxtal.build",
  production: "https://api.boxtal.com",
}

/** Where a body carries the webhook secret; the host replaces it with the value. */
export function webhookSecretPlaceholder(configKey: string): string {
  return `__LIAISON_CONFIG_SECRET__${configKey}__`
}

export class BoxtalV3Client {
  protected readonly fetchImpl: BoxtalFetch
  private readonly connection: string
  protected readonly environment: BoxtalEnvironment
  private readonly now: () => number
  protected readonly requestTimeoutMs: number
  protected readonly callBudgetMs: number

  constructor(opts: BoxtalV3ClientOptions) {
    this.fetchImpl = opts.fetch
    this.connection = opts.connection ?? "boxtal"
    this.environment = opts.environment
    this.now = opts.now ?? (() => Date.now())
    this.requestTimeoutMs = opts.requestTimeoutMs ?? BOXTAL_HTTP_TIMEOUT_MS
    this.callBudgetMs = opts.callBudgetMs ?? BOXTAL_CALL_BUDGET_MS
  }

  /** Every HTTP round trip goes through here so ONE deadline governs a whole
   *  logical call. Refuses to start a request whose call budget is already
   *  spent, and hands the fetch layer this request's own abort hints. */
  protected async timedFetch(
    url: string,
    opts: {
      method?: string
      headers?: Record<string, string>
      body?: string
      auth?: FetchAuth
      configSecrets?: Record<string, string>
    },
    deadline: Deadline,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const left = deadline.remaining(this.now())
    if (left <= 0) {
      throw new BoxtalApiError(
        budgetExhaustedMessage("request", this.callBudgetMs),
        BUDGET_EXHAUSTED_STATUS,
      )
    }
    const perRequest = Math.min(this.requestTimeoutMs, left)
    return this.fetchImpl(url, { ...opts, ...timeoutHints(perRequest) })
  }

  protected get base(): string {
    return V3_BASE[this.environment]
  }

  /** The bearer the host obtains for this connection's v3 key pair. */
  private get auth(): FetchAuth {
    return {
      connection: this.connection,
      scheme: "bearer",
      exchange: { url: `${this.base}/iam/account-app/token`, fields: ["v3Key", "v3Secret"] },
    }
  }

  /**
   * Authenticated v3 request with single refresh-on-401 (the host drops the
   * bearer a 401 answered, so the retry exchanges again). The `path` is
   * appended to the env base; `query` is serialized to a querystring.
   * `configSecrets` lets the host write a config secret into the body.
   */
  protected async request<T = unknown>(
    method: string,
    path: string,
    opts?: {
      body?: unknown
      query?: Record<string, string | number | undefined>
      configSecrets?: Record<string, string>
    },
  ): Promise<T> {
    // ONE deadline for the whole logical call (the host's token exchange runs
    // inside the first request's round trip; see http-budget.ts).
    const deadline = makeDeadline(this.now(), this.callBudgetMs)
    let attempt = 0
    while (true) {
      const qs = opts?.query ? buildQuery(opts.query) : ""
      const url = `${this.base}${path}${qs}`
      const headers: Record<string, string> = {}
      let body: string | undefined
      if (opts?.body !== undefined) {
        headers["Content-Type"] = "application/json"
        body = JSON.stringify(opts.body)
      }
      const res = await this.timedFetch(
        url,
        {
          method,
          headers,
          body,
          auth: this.auth,
          ...(opts?.configSecrets ? { configSecrets: opts.configSecrets } : {}),
        },
        deadline,
      )

      if (res.status === 401) {
        if (attempt >= 1) {
          throw new BoxtalApiError(
            "Boxtal v3 session could not be established (401 after refresh)",
            401,
            res.body,
          )
        }
        attempt++
        continue
      }
      if (res.status >= 400) {
        throw new BoxtalApiError(
          `Boxtal v3 ${method} ${path} failed (${res.status})`,
          res.status,
          res.body,
        )
      }
      return parseJsonBody<T>(res.body)
    }
  }

  /** Unwrap the `{ status, timestamp, content }` v3 envelope. */
  private async requestContent<T = unknown>(
    method: string,
    path: string,
    opts?: {
      body?: unknown
      query?: Record<string, string | number | undefined>
      configSecrets?: Record<string, string>
    },
  ): Promise<T> {
    const env = await this.request<V3Envelope<T>>(method, path, opts)
    return env.content
  }

  // — business methods —

  /** POST /shipping/v3.1/shipping-order */
  async createShippingOrder(draft: BoxtalCreateDraft): Promise<NormalizedOrder> {
    const content = await this.requestContent<RawOrderContent>(
      "POST",
      "/shipping/v3.1/shipping-order",
      { body: buildCreateBody(draft) },
    )
    return normalizeOrder(content)
  }

  /** GET /shipping/v3.1/shipping-order/{id} */
  async getShippingOrder(id: string): Promise<NormalizedOrder> {
    const content = await this.requestContent<RawOrderContent>(
      "GET",
      `/shipping/v3.1/shipping-order/${encodeURIComponent(id)}`,
    )
    return normalizeOrder(content)
  }

  /** GET /shipping/v3.1/shipping-order/{id}/tracking */
  async getTracking(id: string): Promise<NormalizedTracking> {
    const content = await this.requestContent<RawTrackingPackage[]>(
      "GET",
      `/shipping/v3.1/shipping-order/${encodeURIComponent(id)}/tracking`,
    )
    return normalizeTracking(content)
  }

  /** GET /shipping/v3.1/shipping-order/{id}/shipping-document */
  async getDocuments(id: string): Promise<ShippingDocument[]> {
    const content = await this.requestContent<ShippingDocument[]>(
      "GET",
      `/shipping/v3.1/shipping-order/${encodeURIComponent(id)}/shipping-document`,
    )
    return (content ?? []).map((d) => ({ url: d.url, type: d.type, format: d.format }))
  }

  /** DELETE /shipping/v3.1/shipping-order/{id} */
  async cancel(id: string): Promise<{ order_status: "CANCELLED" }> {
    // Boxtal returns the order with status CANCELLED on a successful delete;
    // the local link row is always flipped to CANCELLED regardless.
    await this.request(
      "DELETE",
      `/shipping/v3.1/shipping-order/${encodeURIComponent(id)}`,
    )
    return { order_status: "CANCELLED" }
  }

  /** GET /shipping/v3.1/content-category */
  async listContentCategories(): Promise<ContentCategory[]> {
    const content = await this.requestContent<ContentCategory[]>(
      "GET",
      "/shipping/v3.1/content-category",
    )
    return (content ?? []).map((c) => ({ id: c.id, label: c.label }))
  }

  /** POST /shipping/v3.1/subscription */
  async createSubscription(input: {
    eventType: SubscriptionEventType
    callbackUrl: string
    /** The config key of the signing secret; the host writes its value into the body. */
    webhookSecretConfigKey: string
  }): Promise<{ id: string }> {
    const placeholder = webhookSecretPlaceholder(input.webhookSecretConfigKey)
    // Boxtal v3.1 returns the new subscription's `id` as a NUMBER, but the app's
    // `subscription` table types `subscription_id` as a string (and the DELETE
    // path takes it in the URL). Coerce here at the client boundary so the
    // declared `{id: string}` is honest — otherwise persisting it throws
    // "Field subscription_id has invalid type: expected string, got number",
    // the registration is dropped, and the id is lost so the live subscription
    // can never be DELETEd on disconnect (orphaned residue on the sandbox).
    const content = await this.requestContent<{ id: string | number }>(
      "POST",
      "/shipping/v3.1/subscription",
      {
        body: { eventType: input.eventType, callbackUrl: input.callbackUrl, webhookSecret: placeholder },
        configSecrets: { [placeholder]: input.webhookSecretConfigKey },
      },
    )
    return { id: String(content.id) }
  }

  /**
   * PUT /shipping/v3.1/subscription/{id}/webhook-secret
   *
   * THE ONLY CALL THAT ACTUALLY SETS THE SIGNING SECRET. The spec marks
   * `webhookSecret` required on POST /subscription, but the live API silently
   * IGNORES it there and its PUT /subscription/{id} rejects the field with
   * "cannot be modified using this endpoint, please use dedicated endpoint" —
   * this is that dedicated endpoint (absent from our api-v3.json snapshot;
   * discovered 2026-08-04 after every genuine delivery kept failing
   * signature_mismatch with a correct len=64 hex sigShape even though the
   * subscriptions were re-registered with the kernel secret inline). Every
   * registration path MUST follow createSubscription with this call, or
   * Boxtal signs with a server-generated secret we never see.
   */
  async setSubscriptionWebhookSecret(id: string, webhookSecretConfigKey: string): Promise<void> {
    const placeholder = webhookSecretPlaceholder(webhookSecretConfigKey)
    await this.request(
      "PUT",
      `/shipping/v3.1/subscription/${encodeURIComponent(id)}/webhook-secret`,
      { body: { webhookSecret: placeholder }, configSecrets: { [placeholder]: webhookSecretConfigKey } },
    )
  }

  /** DELETE /shipping/v3.1/subscription/{id} */
  async deleteSubscription(id: string): Promise<void> {
    await this.request(
      "DELETE",
      `/shipping/v3.1/subscription/${encodeURIComponent(id)}`,
    )
  }

  /** Pure helpers exported for reuse by the shipment orchestrator (Task 12). */
  /** Test access to this module's internal helpers. Production never calls it. */
  static readonly TestAccess = { buildCreateBody }
}

// — v3 types —

export interface V3Envelope<T> {
  status: number
  timestamp: string
  content: T
}

export type ShippingOrderStatus = "PENDING" | "REQUESTED" | "CONFIRMED" | "CANCELLED"
export type PackageTrackingStatus =
  | "ANNOUNCED"
  | "SHIPPED"
  | "IN_TRANSIT"
  | "OUT_FOR_DELIVERY"
  | "FAILED_ATTEMPT"
  | "REACHED_DELIVERY_PICKUP_POINT"
  | "DELIVERED"
  | "RETURNED"
  | "EXCEPTION"
export type SubscriptionEventType = "DOCUMENT_CREATED" | "TRACKING_CHANGED"
export type ShippingDocumentType = "LABEL" | "PROFORMA" | "CN23" | "VOUCHER"
export type ShippingDocumentFormat = "PDF_A4" | "PDF_10x15"

export interface Money {
  value: number
  currency: string
}

export interface BoxtalAddress {
  type: "RESIDENTIAL" | "BUSINESS"
  contact: {
    email: string
    phone: string
    company?: string
    lastName: string
    firstName: string
  }
  location: {
    city: string
    state?: string
    number?: string
    street: string
    postalCode: string
    countryIsoCode: string
  }
  additionalInformation?: string
}

export interface BoxtalPackageInput {
  weight: number
  length: number
  width: number
  height: number
  value: Money
  externalId?: string
}

export interface BoxtalCustomsArticle {
  description: string
  quantity: number
  unitWeight: number
  unitValue: Money
  originCountry: string
  tariffNumber?: string
  packageExternalId?: string
}

export interface BoxtalCustomsDeclaration {
  reason: "SALE" | "REPAIR" | "RETURN" | "GIFT" | "SAMPLE" | "DOCUMENTS" | "PERSONAL_USE" | "OTHER"
  articles: BoxtalCustomsArticle[]
}

export interface BoxtalCreateDraft {
  shippingOfferCode: string
  fromAddress: BoxtalAddress
  toAddress: BoxtalAddress
  packages: BoxtalPackageInput[]
  content?: { id: string; description: string }
  customsDeclaration?: BoxtalCustomsDeclaration
  insured: boolean
  labelType: ShippingDocumentFormat
  externalId?: string
  pickupPointCode?: string
  expectedTakingOverDate?: string
}

export interface BoxtalCreateBody {
  shippingOfferCode: string
  insured: boolean
  labelType: ShippingDocumentFormat
  expectedTakingOverDate?: string
  shipment: {
    packages: Array<{
      weight: number
      length: number
      width: number
      height: number
      value: Money
      externalId?: string
    }>
    content?: { id: string; description: string }
    fromAddress: BoxtalAddress
    toAddress: BoxtalAddress
    externalId?: string
    pickupPointCode?: string
    customsDeclaration?: BoxtalCustomsDeclaration
  }
}

interface RawOrderContent {
  id: string
  status: ShippingOrderStatus
  shipmentId?: string
  deliveryPriceExclTax?: Money
  insurancePriceExclTax?: Money
  expectedTakingOverDate?: string
  estimatedDeliveryDate?: string
  // Some carriers' numbers are known at purchase; when Boxtal returns the order's parcels with
  // their tracking number, it is read from here (the parcel tracking endpoint answers only after
  // the first scan).
  shipment?: { packages?: Array<{ trackingNumber?: string | null }> }
  packages?: Array<{ trackingNumber?: string | null }>
}

export interface NormalizedOrder {
  id: string
  order_status: ShippingOrderStatus
  deliveryPriceExclTax: number | null
  insurancePriceExclTax: number | null
  expectedTakingOverDate: string | null
  estimatedDeliveryDate: string | null
  /** The first parcel's carrier tracking number when the order response carries one, else null. */
  tracking_number: string | null
}

interface RawTrackingEvent {
  status: PackageTrackingStatus
  trackingDateTime?: string
  message?: string
}

interface RawTrackingPackage {
  status: PackageTrackingStatus
  trackingNumber?: string
  trackingDateTime?: string
  packageExternalId?: string
  history?: RawTrackingEvent[]
  // The carrier-reported deadline by which the recipient must collect a parcel
  // sitting at a pickup/relay point (Mondial Relay / point-retrait). After this
  // date the parcel is returned to sender. Boxtal surfaces it on the tracking
  // package ONLY while the parcel is at a pickup point (REACHED_DELIVERY_PICKUP_POINT);
  // it is absent for in-transit / home-delivery parcels. Never fabricated — the
  // carrier sets it from the actual arrival date + the relay hold window.
  pickupDeadline?: string
}

export interface NormalizedTracking {
  tracking_number: string | null
  tracking_status: PackageTrackingStatus | null
  events: Array<{ status: PackageTrackingStatus; at: string | null; label: string | null }>
  // ISO date the parcel must be collected by before it returns to sender — present
  // ONLY for a parcel awaiting collection at a pickup point (else null). This is the
  // authoritative, carrier-reported collection deadline; an agent must use THIS to
  // decide which pickup-point parcels are "about to expire" rather than guessing a
  // deadline from the arrival date.
  pickup_deadline: string | null
}

export interface ShippingDocument {
  url: string
  type: ShippingDocumentType
  format: ShippingDocumentFormat
}

export interface ContentCategory {
  id: string
  label: string
}

/** Boxtal caps free-text descriptions at 64 chars. */
const DESCRIPTION_MAX = 64
function truncate(s: string): string {
  return s.length > DESCRIPTION_MAX ? s.slice(0, DESCRIPTION_MAX) : s
}

/**
 * Pure mapping draft → v3 create body. The load-bearing transform; Task 12
 * reuses it. EU-domestic drafts pass `customsDeclaration: undefined` and the
 * key is omitted entirely.
 */
export function buildCreateBody(draft: BoxtalCreateDraft): BoxtalCreateBody {
  const shipment: BoxtalCreateBody["shipment"] = {
    packages: draft.packages.map((p) => ({
      weight: p.weight,
      length: p.length,
      width: p.width,
      height: p.height,
      value: p.value,
      ...(p.externalId !== undefined ? { externalId: p.externalId } : {}),
    })),
    fromAddress: draft.fromAddress,
    toAddress: draft.toAddress,
  }
  if (draft.content) {
    shipment.content = {
      id: draft.content.id,
      description: truncate(draft.content.description),
    }
  }
  if (draft.externalId !== undefined) shipment.externalId = draft.externalId
  if (draft.pickupPointCode !== undefined) shipment.pickupPointCode = draft.pickupPointCode
  if (draft.customsDeclaration) {
    shipment.customsDeclaration = {
      reason: draft.customsDeclaration.reason,
      articles: draft.customsDeclaration.articles.map((a) => ({
        ...a,
        description: truncate(a.description),
      })),
    }
  }
  const body: BoxtalCreateBody = {
    shippingOfferCode: draft.shippingOfferCode,
    insured: draft.insured,
    labelType: draft.labelType,
    shipment,
  }
  if (draft.expectedTakingOverDate !== undefined) {
    body.expectedTakingOverDate = draft.expectedTakingOverDate
  }
  return body
}

function normalizeOrder(c: RawOrderContent): NormalizedOrder {
  return {
    id: c.id,
    order_status: c.status,
    deliveryPriceExclTax: c.deliveryPriceExclTax?.value ?? null,
    insurancePriceExclTax: c.insurancePriceExclTax?.value ?? null,
    expectedTakingOverDate: c.expectedTakingOverDate ?? null,
    estimatedDeliveryDate: c.estimatedDeliveryDate ?? null,
    tracking_number: orderTrackingNumber(c),
  }
}

/** The first parcel's tracking number in the order response (as getTracking reads the first
 *  package), or null when the response carries none. */
function orderTrackingNumber(c: RawOrderContent): string | null {
  for (const p of c.shipment?.packages ?? c.packages ?? []) {
    const n = typeof p?.trackingNumber === "string" ? p.trackingNumber.trim() : ""
    if (n) return n
  }
  return null
}

function normalizeTracking(pkgs: RawTrackingPackage[]): NormalizedTracking {
  const first = (pkgs ?? [])[0]
  if (!first) {
    return { tracking_number: null, tracking_status: null, events: [], pickup_deadline: null }
  }
  const events = (first.history ?? []).map((e) => ({
    status: e.status,
    at: e.trackingDateTime ?? null,
    label: e.message ?? null,
  }))
  // Only surface a pickup deadline for a parcel actually sitting at a pickup point —
  // a deadline on any other state would be meaningless (and the carrier never reports one).
  const pickup_deadline =
    first.status === "REACHED_DELIVERY_PICKUP_POINT" ? (first.pickupDeadline ?? null) : null
  return {
    tracking_number: first.trackingNumber ?? null,
    tracking_status: first.status ?? null,
    events,
    pickup_deadline,
  }
}

function buildQuery(
  query: Record<string, string | number | undefined>,
): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
  }
  return parts.length ? `?${parts.join("&")}` : ""
}

function parseJsonBody<T>(body: string): T {
  if (!body) return {} as T
  try {
    return JSON.parse(body) as T
  } catch {
    throw new BoxtalApiError("Boxtal v3 response was not valid JSON", 200, body)
  }
}
