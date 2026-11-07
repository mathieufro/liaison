// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The cell's /run signer against the loader's shared vectors (an independent
// HMAC implementation produced them; the loader's own tests run the same file).

import { describe, expect, it } from "bun:test"
import vectors from "./__fixtures__/sign-vectors.json"
import {
  CELL_ID_HEADER,
  CELL_SIGNATURE_HEADER,
  CELL_SIGNATURE_SKEW_MS,
  CELL_TS_HEADER,
  sha256Hex,
  signCellRequest,
  verifyCellRequest,
} from "./sign"

describe("cell request signing (shared vectors)", () => {
  it("uses the vectors' header names and skew window", () => {
    expect(CELL_ID_HEADER).toBe(vectors.headers.cellId)
    expect(CELL_TS_HEADER).toBe(vectors.headers.ts)
    expect(CELL_SIGNATURE_HEADER).toBe(vectors.headers.signature)
    expect(CELL_SIGNATURE_SKEW_MS).toBe(vectors.skewMs)
  })

  for (const v of vectors.sign) {
    it(`signs ${JSON.stringify(v.body).slice(0, 40)} exactly as the vector`, () => {
      expect(sha256Hex(v.body)).toBe(v.bodySha256)
      const headers = signCellRequest(v.cellId, v.cellKey, v.body, v.ts)
      expect(headers).toEqual({
        [CELL_ID_HEADER]: v.cellId,
        [CELL_TS_HEADER]: String(v.ts),
        [CELL_SIGNATURE_HEADER]: v.signature,
      })
      // The same bytes as a Uint8Array sign the same.
      const bytes = new TextEncoder().encode(v.body)
      expect(signCellRequest(v.cellId, v.cellKey, bytes, v.ts)[CELL_SIGNATURE_HEADER]).toBe(
        v.signature,
      )
    })
  }

  for (const v of vectors.verify) {
    it(`verify: ${v.case}`, () => {
      const r = verifyCellRequest(vectors.cellKey, String(v.ts), v.signature, v.body, v.now)
      if (v.ok) expect(r).toEqual({ ok: true })
      else expect(r).toEqual({ ok: false, reason: v.reason as never })
    })
  }

  it("refuses a missing or malformed header", () => {
    expect(verifyCellRequest("k".repeat(20), null, "x", "")).toEqual({
      ok: false,
      reason: "missing",
    })
    expect(verifyCellRequest("k".repeat(20), "12a", "x", "")).toEqual({
      ok: false,
      reason: "bad_ts",
    })
    expect(verifyCellRequest("k".repeat(20), String(Date.now()), "c2hvcnQ=", "")).toEqual({
      ok: false,
      reason: "bad_signature",
    })
  })
})
