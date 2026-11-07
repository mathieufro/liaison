// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Cell -> app loader request signing (the Workers executor's wire protocol).
//
//   x-cell-id        the cell's id, the loader's key into its cell table
//   x-cell-ts        unix milliseconds, as a decimal string
//   x-cell-signature base64(HMAC-SHA256(cellKey, "<ts>.<sha256hex(body)>"))
//
// The loader accepts a timestamp within ±60 s of its own clock. The same
// vectors (__fixtures__/sign-vectors.json) prove this signer and the loader's
// verifier; `verifyCellRequest` is the loader's check, used by the test loader.

import { createHash, createHmac, timingSafeEqual } from "node:crypto"

export const CELL_ID_HEADER = "x-cell-id"
export const CELL_TS_HEADER = "x-cell-ts"
export const CELL_SIGNATURE_HEADER = "x-cell-signature"
export const CELL_SIGNATURE_SKEW_MS = 60_000

type Bytes = string | Uint8Array

export function sha256Hex(body: Bytes): string {
  return createHash("sha256").update(body).digest("hex")
}

function signature(cellKey: string, ts: string, body: Bytes): Buffer {
  return createHmac("sha256", cellKey)
    .update(`${ts}.${sha256Hex(body)}`, "utf8")
    .digest()
}

/** The three signing headers for one /run body. */
export function signCellRequest(
  cellId: string,
  cellKey: string,
  body: Bytes,
  ts: number = Date.now(),
): Record<string, string> {
  const t = String(ts)
  return {
    [CELL_ID_HEADER]: cellId,
    [CELL_TS_HEADER]: t,
    [CELL_SIGNATURE_HEADER]: signature(cellKey, t, body).toString("base64"),
  }
}

export type CellVerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "bad_ts" | "skew" | "bad_signature" }

/** The loader's check: timestamp shape, skew window, constant-time HMAC compare. */
export function verifyCellRequest(
  cellKey: string,
  ts: string | null | undefined,
  sig: string | null | undefined,
  body: Bytes,
  now: number = Date.now(),
): CellVerifyResult {
  if (!ts || !sig) return { ok: false, reason: "missing" }
  if (!/^\d{1,16}$/.test(ts)) return { ok: false, reason: "bad_ts" }
  if (Math.abs(now - Number(ts)) > CELL_SIGNATURE_SKEW_MS) return { ok: false, reason: "skew" }
  const presented = Buffer.from(sig, "base64")
  if (presented.length !== 32) return { ok: false, reason: "bad_signature" }
  const expected = signature(cellKey, ts, body)
  return timingSafeEqual(presented, expected)
    ? { ok: true }
    : { ok: false, reason: "bad_signature" }
}
