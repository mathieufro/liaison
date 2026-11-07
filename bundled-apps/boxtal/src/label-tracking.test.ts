// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInNewContext } from "node:vm"
import { deflateRawSync, deflateSync } from "node:zlib"
import type { BoxtalToolCtx } from "./ctx"
import {
  ascii85Decode,
  carrierTrackingFromLabelText,
  inflateRaw,
  inflateZlib,
  isValidDhlExpressWaybill,
  isValidUpsTracking,
  LABEL_ANALYSIS_PROMPT,
  labelCarrierOf,
  labelTextShowsPostcode,
  pdfTextStrings,
  postcodesMatch,
  sourceTrackingFromLabel,
  trackingNumberFromLabelPdf,
  trackingNumberFromLabelText,
} from "./label-tracking"
import { buildLabelPdf, FEDEX_LABEL_LINES } from "./__fixtures__/label-pdf"
import { createMockDb } from "./test-db"

describe("inflate", () => {
  it("round-trips stored, fixed and dynamic Huffman blocks against zlib", () => {
    const random = new Uint8Array(5000).map((_, i) => (i * 7919 + 13) % 251)
    const text = new TextEncoder().encode("TRK# 8777 4092 5574 ".repeat(400))
    for (const input of [random, text, new Uint8Array(0)]) {
      for (const level of [0, 1, 9]) {
        expect(inflateRaw(new Uint8Array(deflateRawSync(input, { level })))).toEqual(Array.from(input))
        expect(inflateZlib(new Uint8Array(deflateSync(input, { level })))).toEqual(Array.from(input))
      }
    }
  })

  it("refuses a stream that is not zlib", () => {
    expect(() => inflateZlib(new Uint8Array([1, 2, 3, 4]))).toThrow()
  })

  it("decodes ASCII85 with the z shortcut and a partial last group", () => {
    expect(String.fromCharCode(...ascii85Decode("<~87cURD]i,\"Ebo80~>"))).toBe("Hello World!")
    expect(ascii85Decode("z~>")).toEqual([0, 0, 0, 0])
  })
})

describe("tracking number from the label", () => {
  it("reads the AWB printed after TRK# on a FedEx label", () => {
    const pdf = buildLabelPdf(FEDEX_LABEL_LINES)
    expect(pdfTextStrings(pdf)).toContain("TRK#")
    expect(trackingNumberFromLabelPdf(pdf)).toBe("877740925574")
  })

  it("returns null without the TRK# marker", () => {
    expect(trackingNumberFromLabelPdf(buildLabelPdf(FEDEX_LABEL_LINES.filter((l) => l !== "TRK#")))).toBeNull()
  })

  it("returns null when two different numbers could be the AWB", () => {
    expect(trackingNumberFromLabelText(["TRK#", "8777 4092 5574", "8777 4092 5575"])).toBeNull()
    // The same number drawn twice is still one number.
    expect(trackingNumberFromLabelText(["TRK#", "8777 4092 5574", "877740925574"])).toBe("877740925574")
  })

  it("returns null on a body that is not a PDF", () => {
    expect(trackingNumberFromLabelPdf("{\"status\":200}")).toBeNull()
  })
})

// Prod, 2026-10-05: get_shipment on a FedEx Regional Economy parcel downloaded the label and still
// answered "no tracking number". The app sandbox deletes ArrayBuffer and every typed array before app
// code runs; the decoder used Uint8Array, threw a ReferenceError inside the per-stream catch, and the
// label read as having no number. This runs the BUILT module under the same deleted globals.
describe("tracking number from the label, inside the app sandbox's globals", () => {
  it("reads the AWB with ArrayBuffer, DataView and every typed array removed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "label-tracking-"))
    const entry = join(dir, "entry.ts")
    writeFileSync(
      entry,
      `import { trackingNumberFromLabelPdf } from ${JSON.stringify(new URL("./label-tracking.ts", import.meta.url).pathname)}\n` +
        "globalThis.__labelTracking = { trackingNumberFromLabelPdf }\n",
    )
    const built = await Bun.build({ entrypoints: [entry], target: "browser", format: "iife" })
    expect(built.success).toBe(true)
    const code = await built.outputs[0]!.text()
    const blocked = [
      "ArrayBuffer", "SharedArrayBuffer", "DataView", "Int8Array", "Uint8Array", "Uint8ClampedArray",
      "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "Float32Array", "Float64Array",
      "BigInt64Array", "BigUint64Array", "TextDecoder", "TextEncoder",
    ]
    const sandbox: Record<string, unknown> = { __pdf: buildLabelPdf(FEDEX_LABEL_LINES) }
    const result = runInNewContext(
      `${blocked.map((g) => `delete globalThis.${g};`).join("")}
       ${code}
       __labelTracking.trackingNumberFromLabelPdf(__pdf)`,
      sandbox,
    )
    expect(result).toBe("877740925574")
  })
})

// ── every carrier: UPS / DHL Express, validated ────────────────────────────────

const UPS_NUMBER = "1ZW4941Y0492530257"

describe("carrier check digits", () => {
  it("accepts a UPS 1Z whose mod-10 check digit is right, and only that", () => {
    expect(isValidUpsTracking(UPS_NUMBER)).toBe(true)
    expect(isValidUpsTracking("1Z W49 41Y 04 9253 0257")).toBe(true)
    expect(isValidUpsTracking("1ZW4941Y0492530258")).toBe(false)
    expect(isValidUpsTracking("1ZW4941Y049253025")).toBe(false)
  })

  it("accepts a DHL Express waybill whose mod-7 check digit is right", () => {
    expect(isValidDhlExpressWaybill("1234567891")).toBe(true)
    expect(isValidDhlExpressWaybill("1234567890")).toBe(false)
  })

  it("names the carrier from the Boxtal offer code", () => {
    expect(labelCarrierOf("UPSE-StandardAP")).toBe("ups")
    expect(labelCarrierOf("FEDX-RegionalEconomy")).toBe("fedex")
    expect(labelCarrierOf("DHLE-DomesticExpress")).toBe("dhl_express")
    expect(labelCarrierOf("MONR-CpourToi")).toBeNull()
  })

  it("compares postcodes in their national spelling", () => {
    expect(postcodesMatch("sw1a 1aa", "SW1A1AA", "GB")).toBe(true)
    expect(postcodesMatch("10019-1234", "10019", "US")).toBe(true)
    expect(postcodesMatch("75011", "75012", "FR")).toBe(false)
    expect(postcodesMatch(null, "75011", "FR")).toBe(false)
  })
})

describe("UPS tracking number from a text label", () => {
  const lines = ["SHIP TO:", "TEST RECIPIENT", "1 TEST STREET", "75011 PARIS", "FRANCE", "TRACKING #: 1Z W49 41Y 04 9253 0257"]
  it("reads the 1Z and sees the recipient's postcode", () => {
    const strings = pdfTextStrings(buildLabelPdf(lines))
    expect(carrierTrackingFromLabelText("ups", strings)).toBe(UPS_NUMBER)
    expect(labelTextShowsPostcode(strings, "75011", "FR", UPS_NUMBER)).toBe(true)
    expect(labelTextShowsPostcode(strings, "69001", "FR", UPS_NUMBER)).toBe(false)
  })

  it("refuses a 1Z with a wrong check digit", () => {
    const bad = lines.map((l) => l.replace("0257", "0258"))
    expect(carrierTrackingFromLabelText("ups", pdfTextStrings(buildLabelPdf(bad)))).toBeNull()
  })
})

// The label sourcing itself, against an in-memory shipment table and a stubbed analysis seam.
function sourcingCtx(opts: {
  row: Record<string, unknown>
  labelLines: string[]
  analysis?: ((args: { fileId: string; prompt: string }) => unknown) | null
  /** The linked contact's stored shipping address (kernel:contacts_read). */
  contactAddress?: Record<string, unknown> | null
  /** No label file on the shipment and no import seam: the label cannot reach the analysis. */
  noLabelFile?: boolean
}) {
  const db = createMockDb({ seed: { shipment: [opts.row] } })
  const analysisCalls: Array<{ fileId: string; prompt: string }> = []
  const contactReads: string[] = []
  const ctx: BoxtalToolCtx = {
    orgId: "org-1",
    db,
    fetch: async () => ({ status: 200, headers: {}, body: buildLabelPdf(opts.labelLines) }),
    connections: {},
    config: { get: async () => null, has: async () => false },
    executeTool: async (target: string) => {
      contactReads.push(target)
      return (
        opts.contactAddress
          ? { status: "completed", result: { contact: { metadata: { shipping_address: opts.contactAddress } } } }
          : { status: "completed", result: { contact: { metadata: {} } } }
      ) as never
    },
    logger: { info() {}, warn() {} },
    files_listAttachments: async () =>
      JSON.stringify(
        opts.noLabelFile ? [] : [{ id: "file-label-1", mimeType: "application/pdf", filename: "label-ord-1.pdf" }],
      ),
    ...(opts.analysis === null
      ? {}
      : {
          files_analyzeDocument: async (argsJson: string) => {
            const args = JSON.parse(argsJson) as { fileId: string; prompt: string }
            analysisCalls.push(args)
            return JSON.stringify(opts.analysis ? opts.analysis(args) : { error: { code: "analysis_disabled" } })
          },
        }),
  }
  return { ctx, db, analysisCalls, contactReads }
}

const UPS_ROW = {
  id: "shp-1",
  boxtal_order_id: "ord-1",
  offer_code: "UPSE-StandardAP",
  tracking_number: null,
  queue_facts: { destination: "FR", to_postcode: "75011", to_country: "FR" },
}
// A UPS label is one image: its content streams draw no text at all.
const IMAGE_LABEL: string[] = []

describe("sourceTrackingFromLabel, every carrier", () => {
  const read = (n: string, pc: string) => () => ({ text: `\`\`\`json\n{"tracking_number":"${n}","recipient_postcode":"${pc}"}\n\`\`\``, model: "m" })

  it("stores a UPS number read from the label image when it validates (source label, operator tick fulfils)", async () => {
    const { ctx, db, analysisCalls } = sourcingCtx({ row: UPS_ROW, labelLines: IMAGE_LABEL, analysis: read("1Z W49 41Y 04 9253 0257", "75 011") })
    expect(await sourceTrackingFromLabel(ctx, UPS_ROW, { labelUrl: "https://document.boxtal.com/l.pdf" })).toBe(UPS_NUMBER)
    expect(analysisCalls).toEqual([{ fileId: "file-label-1", prompt: LABEL_ANALYSIS_PROMPT }])
    const row = db.__all("shipment")[0]!
    expect(row.tracking_number).toBe(UPS_NUMBER)
    expect(row.tracking_from_label).toBe(true)
    expect(row.tracking_to_confirm).toBe(false)
  })

  it("refuses a misread check digit: no number, the row says tracking to confirm", async () => {
    const { ctx, db } = sourcingCtx({ row: UPS_ROW, labelLines: IMAGE_LABEL, analysis: read("1ZW4941Y0492530258", "75011") })
    expect(await sourceTrackingFromLabel(ctx, UPS_ROW, { labelUrl: "https://document.boxtal.com/l.pdf" })).toBeNull()
    const row = db.__all("shipment")[0]!
    expect(row.tracking_number ?? null).toBeNull()
    expect(row.tracking_to_confirm).toBe(true)
  })

  it("refuses a label printed for another postcode", async () => {
    const { ctx, db } = sourcingCtx({ row: UPS_ROW, labelLines: IMAGE_LABEL, analysis: read(UPS_NUMBER, "69001") })
    expect(await sourceTrackingFromLabel(ctx, UPS_ROW, { labelUrl: "https://document.boxtal.com/l.pdf" })).toBeNull()
    expect(db.__all("shipment")[0]!.tracking_to_confirm).toBe(true)
  })

  it("without the analysis seam the row says tracking to confirm, and a marked row is not analysed again", async () => {
    const none = sourcingCtx({ row: UPS_ROW, labelLines: IMAGE_LABEL, analysis: null })
    expect(await sourceTrackingFromLabel(none.ctx, UPS_ROW, { labelUrl: "https://document.boxtal.com/l.pdf" })).toBeNull()
    expect(none.db.__all("shipment")[0]!.tracking_to_confirm).toBe(true)

    const marked = { ...UPS_ROW, tracking_to_confirm: true }
    const again = sourcingCtx({ row: marked, labelLines: IMAGE_LABEL, analysis: read(UPS_NUMBER, "75011") })
    expect(await sourceTrackingFromLabel(again.ctx, marked, { labelUrl: "https://document.boxtal.com/l.pdf" })).toBeNull()
    expect(again.analysisCalls).toHaveLength(0)
  })

  it("reads a UPS text label without asking the analysis", async () => {
    const lines = ["SHIP TO:", "75011 PARIS", "TRACKING #: 1Z W49 41Y 04 9253 0257"]
    const { ctx, analysisCalls } = sourcingCtx({ row: UPS_ROW, labelLines: lines, analysis: read(UPS_NUMBER, "75011") })
    expect(await sourceTrackingFromLabel(ctx, UPS_ROW, { labelUrl: "https://document.boxtal.com/l.pdf" })).toBe(UPS_NUMBER)
    expect(analysisCalls).toHaveLength(0)
  })

  it("FedEx is unchanged: TRK# text, no analysis, no to-confirm mark", async () => {
    const fedex = { ...UPS_ROW, offer_code: "FEDX-RegionalEconomy" }
    const { ctx, db, analysisCalls } = sourcingCtx({ row: fedex, labelLines: FEDEX_LABEL_LINES, analysis: read(UPS_NUMBER, "75011") })
    expect(await sourceTrackingFromLabel(ctx, fedex, { labelUrl: "https://document.boxtal.com/l.pdf" })).toBe("877740925574")
    expect(analysisCalls).toHaveLength(0)
    expect(db.__all("shipment")[0]!.tracking_from_label).toBe(true)

    const noNumber = sourcingCtx({ row: fedex, labelLines: IMAGE_LABEL, analysis: read(UPS_NUMBER, "75011") })
    expect(await sourceTrackingFromLabel(noNumber.ctx, fedex, { labelUrl: "https://document.boxtal.com/l.pdf" })).toBeNull()
    expect(noNumber.analysisCalls).toHaveLength(0)
    expect(noNumber.db.__all("shipment")[0]!.tracking_to_confirm ?? false).toBe(false)
  })
})

describe("sourceTrackingFromLabel, rows without a frozen postcode", () => {
  const read = (n: string, pc: string) => () => ({ text: `{"tracking_number":"${n}","recipient_postcode":"${pc}"}`, model: "m" })
  // Bought before the label postcode was frozen on the row, or adopted from Boxtal.
  const OLD_ROW = { ...UPS_ROW, queue_facts: { destination: "FR" }, contact_ref: "contact-1" }

  it("no postcode anywhere: to confirm, and the paid analysis is never asked", async () => {
    const row = { ...OLD_ROW, contact_ref: null }
    const { ctx, db, analysisCalls } = sourcingCtx({ row, labelLines: IMAGE_LABEL, analysis: read(UPS_NUMBER, "75011") })
    expect(await sourceTrackingFromLabel(ctx, row, { labelUrl: "https://document.boxtal.com/l.pdf" })).toBeNull()
    expect(analysisCalls).toHaveLength(0)
    expect(db.__all("shipment")[0]!.tracking_to_confirm).toBe(true)
  })

  it("the contact's stored address has no postcode either: to confirm, no analysis", async () => {
    const { ctx, db, analysisCalls } = sourcingCtx({
      row: OLD_ROW,
      labelLines: IMAGE_LABEL,
      analysis: read(UPS_NUMBER, "75011"),
      contactAddress: { city: "Paris" },
    })
    expect(await sourceTrackingFromLabel(ctx, OLD_ROW, { labelUrl: "https://document.boxtal.com/l.pdf" })).toBeNull()
    expect(analysisCalls).toHaveLength(0)
    expect(db.__all("shipment")[0]!.tracking_to_confirm).toBe(true)
  })

  it("falls back to the recipient contact's postcode and accepts a label printed for it", async () => {
    const { ctx, db, analysisCalls, contactReads } = sourcingCtx({
      row: OLD_ROW,
      labelLines: IMAGE_LABEL,
      analysis: read(UPS_NUMBER, "75011"),
      contactAddress: { postalCode: "75 011", countryIsoCode: "FR" },
    })
    expect(await sourceTrackingFromLabel(ctx, OLD_ROW, { labelUrl: "https://document.boxtal.com/l.pdf" })).toBe(UPS_NUMBER)
    expect(contactReads).toEqual(["kernel:contacts_read"])
    expect(analysisCalls).toHaveLength(1)
    expect(db.__all("shipment")[0]!.tracking_number).toBe(UPS_NUMBER)
  })

  it("a return's label is printed for us, not the contact: no fallback, to confirm without analysis", async () => {
    const row = { ...OLD_ROW, kind: "return" }
    const { ctx, analysisCalls, contactReads } = sourcingCtx({
      row,
      labelLines: IMAGE_LABEL,
      analysis: read(UPS_NUMBER, "75011"),
      contactAddress: { postalCode: "75011" },
    })
    expect(await sourceTrackingFromLabel(ctx, row, { labelUrl: "https://document.boxtal.com/l.pdf" })).toBeNull()
    expect(contactReads).toHaveLength(0)
    expect(analysisCalls).toHaveLength(0)
  })
})

describe("sourceTrackingFromLabel, transient failures", () => {
  const read = (n: string, pc: string) => () => ({ text: `{"tracking_number":"${n}","recipient_postcode":"${pc}"}`, model: "m" })
  const pass = async (ctx: BoxtalToolCtx, db: ReturnType<typeof createMockDb>) =>
    sourceTrackingFromLabel(ctx, db.__all("shipment")[0] as never, { labelUrl: "https://document.boxtal.com/l.pdf" })

  for (const code of ["timeout", "model_error", "storage_error"]) {
    it(`a ${code} leaves the row for the next pass, and marks it only after 3 attempts`, async () => {
      const { ctx, db, analysisCalls } = sourcingCtx({ row: UPS_ROW, labelLines: IMAGE_LABEL, analysis: () => ({ error: { code } }) })
      expect(await pass(ctx, db)).toBeNull()
      expect(db.__all("shipment")[0]!.tracking_to_confirm ?? false).toBe(false)
      expect(db.__all("shipment")[0]!.tracking_label_attempts).toBe(1)
      await pass(ctx, db)
      expect(db.__all("shipment")[0]!.tracking_to_confirm ?? false).toBe(false)
      await pass(ctx, db)
      expect(db.__all("shipment")[0]!.tracking_to_confirm).toBe(true)
      expect(analysisCalls).toHaveLength(3)
      // Marked: no fourth paid call.
      await pass(ctx, db)
      expect(analysisCalls).toHaveLength(3)
    })
  }

  it("a thrown seam error is transient too", async () => {
    const { ctx, db } = sourcingCtx({
      row: UPS_ROW,
      labelLines: IMAGE_LABEL,
      analysis: () => {
        throw new Error("bridge down")
      },
    })
    expect(await pass(ctx, db)).toBeNull()
    expect(db.__all("shipment")[0]!.tracking_to_confirm ?? false).toBe(false)
    expect(db.__all("shipment")[0]!.tracking_label_attempts).toBe(1)
  })

  it("no label file yet (not imported) is transient: not marked, retried", async () => {
    const { ctx, db, analysisCalls } = sourcingCtx({
      row: UPS_ROW,
      labelLines: IMAGE_LABEL,
      analysis: read(UPS_NUMBER, "75011"),
      noLabelFile: true,
    })
    expect(await pass(ctx, db)).toBeNull()
    expect(analysisCalls).toHaveLength(0)
    expect(db.__all("shipment")[0]!.tracking_to_confirm ?? false).toBe(false)
  })

  it("the analysis switched off is final at once: to confirm", async () => {
    const { ctx, db } = sourcingCtx({ row: UPS_ROW, labelLines: IMAGE_LABEL, analysis: () => ({ error: { code: "analysis_disabled" } }) })
    expect(await pass(ctx, db)).toBeNull()
    expect(db.__all("shipment")[0]!.tracking_to_confirm).toBe(true)
  })
})
