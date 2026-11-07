// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import { env } from "~/lib/env"
import { bridgeUrlFor, readWorkersConfig, readWorkersSelection, workersBundleSha } from "./config"

const KEYS = [
  "LIAISON_WORKERS_APPS",
  "LIAISON_APP_LOADER_URL",
  "LIAISON_APP_LOADER_CELL_ID",
  "LIAISON_APP_LOADER_KEY",
  "LIAISON_WORKERS_BUNDLES",
  "LIAISON_APP_BRIDGE_BASE_URL",
] as const
const saved = Object.fromEntries(KEYS.map((k) => [k, env[k]]))
const savedRole = env.LIAISON_ROLE
const SHA = "a".repeat(64)

function setAll(): void {
  env.LIAISON_WORKERS_APPS = "shopify, boxtal"
  env.LIAISON_APP_LOADER_URL = "https://loader.example.com/"
  env.LIAISON_APP_LOADER_CELL_ID = "cell-1"
  env.LIAISON_APP_LOADER_KEY = "k"
  env.LIAISON_WORKERS_BUNDLES = JSON.stringify({ "shopify@0.4.1": SHA })
  env.LIAISON_APP_BRIDGE_BASE_URL = undefined
  env.LIAISON_ROLE = "all"
}

afterEach(() => {
  for (const k of KEYS) (env as Record<string, unknown>)[k] = saved[k]
  env.LIAISON_ROLE = savedRole
})

describe("workers config", () => {
  it("is unset by default", () => {
    for (const k of KEYS) (env as Record<string, unknown>)[k] = undefined
    expect(readWorkersSelection()).toEqual({ kind: "unset" })
    expect(readWorkersConfig()).toBeNull()
  })

  it("is used when everything is set and the role is all", () => {
    setAll()
    const cfg = readWorkersConfig()
    expect(cfg).not.toBeNull()
    if (!cfg) return
    expect([...cfg.apps]).toEqual(["shopify", "boxtal"])
    expect(cfg.loaderUrl).toBe("https://loader.example.com")
    expect(cfg.bridgeBaseUrl).toBe(env.BASE_URL.replace(/\/+$/, ""))
    expect(workersBundleSha(cfg, "shopify", "0.4.1")).toBe(SHA)
    expect(workersBundleSha(cfg, "shopify", "0.4.2")).toBeUndefined()
    expect(workersBundleSha(cfg, "boxtal", "0.23.3")).toBeUndefined()
    expect(bridgeUrlFor(cfg, "r1")).toBe(`${cfg.bridgeBaseUrl}/api/app-bridge/r1`)
  })

  it("is refused under another role", () => {
    setAll()
    env.LIAISON_ROLE = "worker"
    expect(readWorkersSelection().kind).toBe("invalid")
  })

  it("is refused when partly set or with a bad bundle map", () => {
    setAll()
    env.LIAISON_APP_LOADER_KEY = undefined
    expect(readWorkersSelection()).toEqual({
      kind: "invalid",
      reason: "missing LIAISON_APP_LOADER_KEY",
    })
    setAll()
    env.LIAISON_WORKERS_BUNDLES = "{nope"
    expect(readWorkersSelection().kind).toBe("invalid")
    env.LIAISON_WORKERS_BUNDLES = JSON.stringify({ shopify: SHA })
    expect(readWorkersSelection().kind).toBe("invalid")
    env.LIAISON_WORKERS_BUNDLES = JSON.stringify({ "shopify@1.0.0": "XYZ" })
    expect(readWorkersSelection().kind).toBe("invalid")
  })
})
