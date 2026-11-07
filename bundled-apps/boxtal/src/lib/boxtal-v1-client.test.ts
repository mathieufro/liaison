// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { BoxtalApiError } from "./boxtal-v3-client"
import {
  BoxtalV1Client,
  buildCotationQuery,
  parseCotationXml,
  type CotationInput,
} from "./boxtal-v1-client"

const FIX = join(import.meta.dir, "..", "__fixtures__", "boxtal")
const fixture = (n: string) => readFileSync(join(FIX, `${n}.xml`), "utf8")

interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  auth?: unknown
}

function makeFetch(status: number, body: string): {
  fetch: BoxtalV1Client["fetchImpl"]
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const fetch = async (
    url: string,
    opts?: { method?: string; headers?: Record<string, string>; body?: string; auth?: unknown },
  ) => {
    calls.push({ url, method: opts?.method ?? "GET", headers: opts?.headers ?? {}, auth: opts?.auth })
    return { status, headers: {}, body }
  }
  return { fetch, calls }
}

const singleParcelInput: CotationInput = {
  from: { country: "FR", postalCode: "75001", city: "Paris", type: "entreprise" },
  to: { country: "US", postalCode: "10001", city: "New York", type: "particulier", state: "NY" },
  parcels: [{ weight: 1.2, length: 30, width: 20, height: 10 }],
  content_code: "10120",
  collection_date: "2026-06-01",
}

describe("buildCotationQuery", () => {
  it("emits the French per-parcel + endpoint keys for a single FR→US parcel", () => {
    const qs = buildCotationQuery(singleParcelInput)
    const params = new URLSearchParams(qs)
    expect(params.get("colis_1.poids")).toBe("1.2")
    expect(params.get("colis_1.longueur")).toBe("30")
    expect(params.get("colis_1.largeur")).toBe("20")
    expect(params.get("colis_1.hauteur")).toBe("10")
    expect(params.get("code_contenu")).toBe("10120")
    expect(params.get("expediteur.pays")).toBe("FR")
    expect(params.get("expediteur.code_postal")).toBe("75001")
    expect(params.get("expediteur.ville")).toBe("Paris")
    expect(params.get("expediteur.type")).toBe("entreprise")
    expect(params.get("destinataire.pays")).toBe("US")
    expect(params.get("destinataire.code_postal")).toBe("10001")
    expect(params.get("destinataire.ville")).toBe("New York")
    expect(params.get("destinataire.type")).toBe("particulier")
    expect(params.get("collecte")).toBe("2026-06-01")
    // US destination carries the state as code_region
    expect(params.get("destinataire.code_region")).toBe("NY")
  })

  it("emits colis_1 and colis_2 for a two-parcel input", () => {
    const qs = buildCotationQuery({
      ...singleParcelInput,
      parcels: [
        { weight: 1, length: 10, width: 10, height: 10 },
        { weight: 2, length: 20, width: 20, height: 20 },
      ],
    })
    const params = new URLSearchParams(qs)
    expect(params.get("colis_1.poids")).toBe("1")
    expect(params.get("colis_2.poids")).toBe("2")
    expect(params.get("colis_2.longueur")).toBe("20")
  })
})

describe("parseCotationXml", () => {
  it("parses multi-offer XML sorted ascending by price_ht with v3 offer_code", () => {
    const offers = parseCotationXml(fixture("cotation-multi"))
    expect(offers).toHaveLength(3)
    // sorted ascending by price_ht: MONR 5.50, CHRP 7.80, SOGP 9.20
    expect(offers.map((o) => o.price_ht)).toEqual([5.5, 7.8, 9.2])
    expect(offers[0]!.offer_code).toBe("MONR-CpourToi")
    expect(offers[0]!.carrier_code).toBe("MONR")
    expect(offers[0]!.service_code).toBe("CpourToi")
    expect(offers[0]!.carrier).toBe("Mondial Relay")
    expect(offers[0]!.price_ttc).toBe(6.6)
    expect(offers[0]!.currency).toBe("EUR")
    expect(offers[0]!.collection_date).toBe("2026-06-01")
    expect(offers[0]!.delivery_date).toBe("2026-06-05")
    // MONR delivers to a PICKUP_POINT → needs_relay_point true
    expect(offers[0]!.needs_relay_point).toBe(true)
    // CHRP is a home delivery → needs_relay_point false
    const chrp = offers.find((o) => o.carrier_code === "CHRP")!
    expect(chrp.needs_relay_point).toBe(false)
    // MONR's collection type is DROPOFF_POINT (sender drops at a relay) → not on-premise pickup
    expect(offers[0]!.collection_type).toBe("DROPOFF_POINT")
    expect(offers[0]!.pickup_at_sender).toBe(false)
    // CHRP's collection type is PICKUP (carrier collects at the sender's premises)
    expect(chrp.collection_type).toBe("PICKUP")
    expect(chrp.pickup_at_sender).toBe(true)
  })

  it("collection type PICKUP yields pickup_at_sender true (carrier collects on premises)", () => {
    const offers = parseCotationXml(fixture("cotation-collection-pickup"))
    expect(offers).toHaveLength(1)
    expect(offers[0]!.collection_type).toBe("PICKUP")
    expect(offers[0]!.pickup_at_sender).toBe(true)
  })

  it("collection type DROPOFF_POINT yields pickup_at_sender false (sender drops at a relay point)", () => {
    const offers = parseCotationXml(fixture("cotation-collection-dropoff"))
    expect(offers).toHaveLength(1)
    expect(offers[0]!.collection_type).toBe("DROPOFF_POINT")
    expect(offers[0]!.pickup_at_sender).toBe(false)
  })

  it("collection type COMPANY yields pickup_at_sender true (live prod on-premise code)", () => {
    const xml = fixture("cotation-collection-pickup").replace("<code>PICKUP</code>", "<code>COMPANY</code>")
    const offers = parseCotationXml(xml)
    expect(offers).toHaveLength(1)
    expect(offers[0]!.collection_type).toBe("COMPANY")
    expect(offers[0]!.pickup_at_sender).toBe(true)
  })

  it("collection type POST_OFFICE yields pickup_at_sender false (live prod dropoff code)", () => {
    const xml = fixture("cotation-collection-pickup").replace("<code>PICKUP</code>", "<code>POST_OFFICE</code>")
    const offers = parseCotationXml(xml)
    expect(offers).toHaveLength(1)
    expect(offers[0]!.collection_type).toBe("POST_OFFICE")
    expect(offers[0]!.pickup_at_sender).toBe(false)
  })

  it("unknown collection type code yields pickup_at_sender null, not false", () => {
    const xml = fixture("cotation-collection-pickup").replace("<code>PICKUP</code>", "<code>WAREHOUSE_X</code>")
    const offers = parseCotationXml(xml)
    expect(offers).toHaveLength(1)
    expect(offers[0]!.collection_type).toBe("WAREHOUSE_X")
    expect(offers[0]!.pickup_at_sender).toBeNull()
  })

  it("missing collection type block yields collection_type null and pickup_at_sender null, not false", () => {
    const offers = parseCotationXml(fixture("cotation-collection-missing"))
    expect(offers).toHaveLength(1)
    expect(offers[0]!.collection_type).toBeNull()
    expect(offers[0]!.pickup_at_sender).toBeNull()
  })

  it("drops DEV-mode offers, keeping only commercial offers", () => {
    const offers = parseCotationXml(fixture("cotation-dev"))
    expect(offers).toHaveLength(1)
    expect(offers[0]!.carrier_code).toBe("CHRP")
  })

  it("returns [] for an empty offer set (NOT an error)", () => {
    const offers = parseCotationXml(fixture("cotation-empty"))
    expect(offers).toEqual([])
  })

  it("throws BoxtalApiError carrying the verbatim <message> on <error>", () => {
    let err: unknown
    try {
      parseCotationXml(fixture("cotation-error"))
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(BoxtalApiError)
    expect((err as BoxtalApiError).message).toContain(
      "Le code postal du destinataire est invalide.",
    )
  })

  it("throws a typed error on truncated/malformed XML (no raw exception bubble)", () => {
    const partial = "<cotation><shipment><offer><operator><code>CHRP"
    expect(() => parseCotationXml(partial)).toThrow(BoxtalApiError)
  })
})

describe("BoxtalV1Client.quote", () => {
  it("GETs cotation with host-side Basic auth and returns the sorted, DEV-filtered offers", async () => {
    const { fetch, calls } = makeFetch(200, fixture("cotation-multi"))
    const client = new BoxtalV1Client({
      fetch,
      environment: "sandbox",
    })
    const offers = await client.quote(singleParcelInput)
    const call = calls[0]!
    expect(call.url.startsWith("https://test.envoimoinscher.com/api/v1/cotation?")).toBe(true)
    // The host sends Basic(v1Key:v1Secret); the client sets no credential itself.
    expect(call.auth).toEqual({ connection: "boxtal", scheme: "basic", fields: ["v1Key", "v1Secret"] })
    expect(call.headers.Authorization).toBeUndefined()
    expect(offers.map((o) => o.price_ht)).toEqual([5.5, 7.8, 9.2])
  })

  it("uses the production host when environment=production", async () => {
    const { fetch, calls } = makeFetch(200, fixture("cotation-empty"))
    const client = new BoxtalV1Client({
      fetch,
      environment: "production",
    })
    await client.quote(singleParcelInput)
    expect(calls[0]!.url.startsWith("https://www.envoimoinscher.com/api/v1/cotation?")).toBe(true)
  })

  it("empty offer set yields [] without throwing", async () => {
    const { fetch } = makeFetch(200, fixture("cotation-empty"))
    const client = new BoxtalV1Client({
      fetch,
      environment: "sandbox",
    })
    expect(await client.quote(singleParcelInput)).toEqual([])
  })

  // A quote rejected with a 4xx reported only "Boxtal v1 cotation HTTP 400", which names no
  // field: a missing postal code read identically to a bad weight, and the operator saw an HTTP
  // code where the carrier had actually said what was wrong. The reason has to ride in the
  // MESSAGE, because the sandbox worker boundary flattens the error and keeps only that.
  it("a 4xx names the field the carrier rejected, not just the status", async () => {
    const { fetch } = makeFetch(
      400,
      "<?xml version=\"1.0\"?><cotation><error>Le code postal du destinataire est invalide.</error></cotation>",
    )
    const client = new BoxtalV1Client({
      fetch,
      environment: "sandbox",
    })
    await expect(client.quote(singleParcelInput)).rejects.toThrow(
      "Le code postal du destinataire est invalide.",
    )
  })

  it("an <error> body surfaces the verbatim message", async () => {
    const { fetch } = makeFetch(200, fixture("cotation-error"))
    const client = new BoxtalV1Client({
      fetch,
      environment: "sandbox",
    })
    await expect(client.quote(singleParcelInput)).rejects.toThrow(
      "Le code postal du destinataire est invalide.",
    )
  })
})

describe("BoxtalV1Client - request timeout", () => {
  it("hands the cotation fetch a per-request abort deadline", async () => {
    const seen: Array<{ timeoutMs?: number; hasSignal: boolean }> = []
    const client = new BoxtalV1Client({
      fetch: async (_url, opts) => {
        const o = opts as { timeoutMs?: number; signal?: unknown } | undefined
        seen.push({ timeoutMs: o?.timeoutMs, hasSignal: Boolean(o?.signal) })
        return { status: 200, headers: {}, body: "<cotation><shipment></shipment></cotation>" }
      },
      environment: "sandbox",
      requestTimeoutMs: 1234,
    })
    await client.quote(singleParcelInput)
    expect(seen).toEqual([{ timeoutMs: 1234, hasSignal: true }])
  })
})
