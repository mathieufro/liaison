// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Live sandbox smoke — OPT-IN. Skipped (not failed) when BOXTAL_SMOKE is unset
// or sandbox creds are absent, so CI stays green. When creds ARE present and the
// sandbox is down, the test fails loudly (a real signal, not a silent skip).
//
// Run: `cd liaison/bundled-apps/boxtal && BOXTAL_SMOKE=1 \
//   BOXTAL_V3_KEY=… BOXTAL_V3_SECRET=… BOXTAL_V1_KEY=… BOXTAL_V1_SECRET=… \
//   bun test src/smoke.test.ts`
import { describe, expect, it } from "bun:test"
import { BoxtalV1Client } from "./lib/boxtal-v1-client"
import { BoxtalV3Client, type BoxtalFetch } from "./lib/boxtal-v3-client"

const RUN = process.env.BOXTAL_SMOKE === "1" && !!process.env.BOXTAL_V3_KEY
const maybe = RUN ? it : it.skip

const CREDS: Record<string, string | undefined> = {
  v1Key: process.env.BOXTAL_V1_KEY,
  v1Secret: process.env.BOXTAL_V1_SECRET,
  v3Key: process.env.BOXTAL_V3_KEY,
  v3Secret: process.env.BOXTAL_V3_SECRET,
}
const basic = (fields: readonly string[]) =>
  `Basic ${Buffer.from(`${CREDS[fields[0]!]}:${CREDS[fields[1]!]}`).toString("base64")}`

/** Real fetch shaped like ctx.fetch, doing the host's `auth` (Basic, bearer exchange). */
const liveFetch: BoxtalFetch = async (url, opts) => {
  const headers: Record<string, string> = { ...(opts?.headers ?? {}) }
  const auth = opts?.auth
  if (auth?.scheme === "basic" && auth.fields) headers.Authorization = basic(auth.fields)
  if (auth?.scheme === "bearer" && auth.exchange) {
    const tok = await fetch(auth.exchange.url, {
      method: "POST",
      headers: { Authorization: basic(auth.exchange.fields), "Content-Type": "application/json" },
    })
    headers.Authorization = `Bearer ${((await tok.json()) as { accessToken: string }).accessToken}`
  }
  const res = await fetch(url, { method: opts?.method ?? "GET", headers, body: opts?.body })
  const out: Record<string, string> = {}
  res.headers.forEach((v, k) => {
    out[k.toLowerCase()] = v
  })
  return { status: res.status, headers: out, body: await res.text() }
}

describe("Boxtal live sandbox smoke (opt-in)", () => {
  maybe("v3 token exchange + content-category returns ≥1 row", async () => {
    const v3 = new BoxtalV3Client({
      fetch: liveFetch,
      environment: "sandbox",
    })
    const categories = await v3.listContentCategories()
    expect(categories.length).toBeGreaterThanOrEqual(1)
  })

  maybe("v1 domestic cotation returns ≥1 offer", async () => {
    const v1 = new BoxtalV1Client({
      fetch: liveFetch,
      environment: "sandbox",
    })
    const offers = await v1.quote({
      from: { country: "FR", postalCode: "75001", city: "Paris", type: "entreprise" },
      to: { country: "FR", postalCode: "33000", city: "Bordeaux", type: "particulier" },
      parcels: [{ weight: 1, length: 20, width: 20, height: 20 }],
      content_code: "10120",
    })
    expect(offers.length).toBeGreaterThanOrEqual(1)
  })
})
