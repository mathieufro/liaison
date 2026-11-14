// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The fake Shopify Admin API's gate: on only on a labelled private test box,
// refused everywhere else, and a refused value stops the process at boot.
import { describe, expect, it } from "bun:test"
import { randomBytes } from "node:crypto"
import { join } from "node:path"
import { type ShopifyFakeAdminGateInput, shopifyFakeAdminGate } from "~/lib/shopify-fake-admin-gate"

const PRIVATE_BOX: ShopifyFakeAdminGateInput = {
  value: "http://127.0.0.1:8899",
  declaredPrivate: true,
  baseUrl: "http://127.0.0.1:3000",
  managed: false,
}

const gate = (over: Partial<ShopifyFakeAdminGateInput>) =>
  shopifyFakeAdminGate({ ...PRIVATE_BOX, ...over })

describe("the fake Shopify Admin API gate", () => {
  it("is off when the setting is unset or empty, whatever the box", () => {
    expect(gate({ value: undefined })).toEqual({ state: "off" })
    expect(gate({ value: "  " })).toEqual({ state: "off" })
    expect(gate({ value: undefined, declaredPrivate: false, managed: true })).toEqual({
      state: "off",
    })
  })

  it("is on with the exact origin on a labelled private box with a loopback BASE_URL", () => {
    expect(gate({})).toEqual({ state: "on", origin: "http://127.0.0.1:8899" })
    expect(gate({ value: "http://shopfake:8080/" })).toEqual({
      state: "on",
      origin: "http://shopfake:8080",
    })
    expect(gate({ value: "http://host.docker.internal:9000" }).state).toBe("on")
    expect(gate({ value: "https://localhost:8443", baseUrl: "http://localhost:3000" }).state).toBe(
      "on",
    )
  })

  it("refuses a box that is not labelled private", () => {
    const g = gate({ declaredPrivate: false })
    expect(g.state).toBe("refused")
  })

  it("refuses a box whose BASE_URL is public, even when labelled private", () => {
    expect(gate({ baseUrl: "https://liaison.example.com" }).state).toBe("refused")
    expect(gate({ baseUrl: "http://198.51.100.4:3000" }).state).toBe("refused")
    expect(gate({ baseUrl: "not a url" }).state).toBe("refused")
  })

  it("refuses the managed edition, even on a labelled private box", () => {
    expect(gate({ managed: true }).state).toBe("refused")
  })

  it("refuses a value that is not one bare origin on the box's own network", () => {
    for (const value of [
      "https://evil.example.com",
      "https://a-real-store.myshopify.com",
      "http://198.51.100.5:8080",
      "http://[fd12:3456::10]",
      "http://169.254.169.254",
      "http://[fe80::1]:80",
      "http://0.0.0.0:8899",
      "http://user:pass@127.0.0.1:8899",
      "http://127.0.0.1:8899/admin",
      "http://127.0.0.1:8899?x=1",
      "ftp://127.0.0.1",
      "file:///etc/passwd",
      "127.0.0.1:8899",
    ]) {
      expect({ value, state: gate({ value }).state }).toEqual({ value, state: "refused" })
    }
  })
})

// lib/env.ts enforces the gate with process.exit at module load, so each case
// loads it in a child process and reads the exit code and the log.
const API_DIR = join(import.meta.dir, "..", "..")

function boot(extra: Record<string, string>): { code: number; stderr: string } {
  const res = Bun.spawnSync(["bun", "-e", "await import('./src/lib/env.ts'); process.exit(0)"], {
    cwd: API_DIR,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      NODE_ENV: "production",
      JWT_SECRET: randomBytes(32).toString("hex"),
      ENCRYPTION_KEY: randomBytes(32).toString("hex"),
      BYOK_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
      MONITOR_TOKEN: randomBytes(24).toString("hex"),
      BASE_URL: "https://liaison.example.com",
      DATABASE_URL: "postgres://u:p@127.0.0.1:1/none",
      REDIS_URL: "redis://127.0.0.1:1",
      MEILISEARCH_API_KEY: randomBytes(16).toString("hex"),
      ...extra,
    },
    stderr: "pipe",
    stdout: "pipe",
  })
  return { code: res.exitCode ?? -1, stderr: res.stderr.toString() }
}

describe("a production boot with the fake Shopify Admin API set", () => {
  const fake = { LIAISON_TEST_SHOPIFY_ADMIN_URL: "http://127.0.0.1:8899" }

  it("boots without the setting (control)", () => {
    const r = boot({})
    expect(r.stderr).not.toContain("FATAL")
    expect(r.code).toBe(0)
  }, 30_000)

  it("refuses to start on a real instance (public BASE_URL, no private label)", () => {
    const r = boot(fake)
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain("FATAL: LIAISON_TEST_SHOPIFY_ADMIN_URL")
  }, 30_000)

  it("refuses to start when labelled private but served on a public BASE_URL", () => {
    const r = boot({ ...fake, LIAISON_PRIVATE_DEMO_BOX: "true" })
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain("FATAL: LIAISON_TEST_SHOPIFY_ADMIN_URL")
  }, 30_000)

  it("refuses to start in the managed edition on a private box", () => {
    const r = boot({
      ...fake,
      LIAISON_PRIVATE_DEMO_BOX: "true",
      BASE_URL: "http://127.0.0.1:3000",
      LIAISON_EDITION: "managed",
    })
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain("FATAL: LIAISON_TEST_SHOPIFY_ADMIN_URL")
  }, 30_000)

  it("starts on a labelled private box and says once that the fake is on", () => {
    const r = boot({ ...fake, LIAISON_PRIVATE_DEMO_BOX: "true", BASE_URL: "http://127.0.0.1:3000" })
    expect(r.stderr).not.toContain("FATAL")
    expect(r.code).toBe(0)
    expect(r.stderr.split("LIAISON_TEST_SHOPIFY_ADMIN_URL is ON").length - 1).toBe(1)
  }, 30_000)
})
