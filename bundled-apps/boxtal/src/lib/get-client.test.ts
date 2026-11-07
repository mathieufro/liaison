// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { getClient } from "./get-client"

const FIELDS = ["v1Key", "v1Secret", "v3Key", "v3Secret", "environment"] as const

const fullMap = {
  v1Key: "u1",
  v1Secret: "s1",
  v3Key: "k3",
  v3Secret: "s3",
  environment: "sandbox",
}

/** What the host's `connections_getSettings` answers for a stored map: only the
 *  readable `environment`, plus the names of the empty fields. */
function settingsOf(map: Record<string, string> | null) {
  const m = map ?? {}
  return {
    values: m.environment ? { environment: m.environment } : {},
    missing: FIELDS.filter((f) => !m[f]),
  }
}

type Call = { url: string; opts?: Record<string, unknown> }

function fetchStub(calls: Call[]) {
  return async (url: string, opts?: Record<string, unknown>) => {
    calls.push({ url, opts })
    return { status: 200, headers: {}, body: '{"status":"OK","content":[]}' }
  }
}

/** RECORD shape: `ctx.connections.boxtal.getSettings(id?)` (SDK type / mock). */
function recordCtx(map: Record<string, string> | null, calls: Call[] = []) {
  return {
    fetch: fetchStub(calls),
    connections: {
      boxtal: {
        getSettings: async () => settingsOf(map),
        getAccounts: async () => [],
      },
    },
  } as any
}

/** FLAT shape: `ctx.connections.getSettings(name, id?)` (sandbox bridge, a JSON string). */
function flatCtx(map: Record<string, string> | null) {
  return {
    fetch: fetchStub([]),
    connections: {
      getSettings: async (_name: string) => JSON.stringify(settingsOf(map)),
      getAccounts: async () => [],
    },
  } as any
}

describe("getClient (Boxtal facade)", () => {
  it("builds both clients from the RECORD-shape connection", async () => {
    const { v1, v3, environment } = await getClient(recordCtx(fullMap))
    expect(environment).toBe("sandbox")
    expect(v1).toBeDefined()
    expect(v3).toBeDefined()
  })

  it("builds both clients from the FLAT-shape connection", async () => {
    const { environment } = await getClient(flatCtx(fullMap))
    expect(environment).toBe("sandbox")
  })

  it("reads the production environment from the connection settings", async () => {
    const { environment } = await getClient(recordCtx({ ...fullMap, environment: "production" }))
    expect(environment).toBe("production")
  })

  it("throws 'Boxtal not connected' when nothing is stored", async () => {
    await expect(getClient(recordCtx({}))).rejects.toThrow("Boxtal not connected")
  })

  it("throws 'Boxtal not connected' when the connection accessor is absent", async () => {
    const ctx = { fetch: fetchStub([]), connections: {} } as any
    await expect(getClient(ctx)).rejects.toThrow("Boxtal not connected")
  })

  it("throws 'Boxtal not connected' when the settings read fails", async () => {
    const ctx = {
      fetch: fetchStub([]),
      connections: { boxtal: { getSettings: async () => { throw new Error("no row") } } },
    } as any
    await expect(getClient(ctx)).rejects.toThrow("Boxtal not connected")
  })

  it("throws 'Boxtal credentials incomplete' when a required key is missing", async () => {
    const partial = { v1Key: "u1", v3Key: "k3", environment: "sandbox" }
    await expect(getClient(recordCtx(partial))).rejects.toThrow(
      "Boxtal credentials incomplete, missing: v1Secret, v3Secret",
    )
  })

  it("rejects an invalid environment value", async () => {
    await expect(getClient(recordCtx({ ...fullMap, environment: "staging" }))).rejects.toThrow()
  })

  it("never handles a key: every request names the connection for the host to authenticate", async () => {
    const calls: Call[] = []
    const { v1, v3 } = await getClient(recordCtx(fullMap, calls))
    await v3.listContentCategories().catch(() => undefined)
    await v1.quote({} as never).catch(() => undefined)
    expect(calls.length).toBe(2)
    const sent = JSON.stringify(calls)
    for (const secret of ["s1", "s3", "u1", "k3"]) expect(sent).not.toContain(`"${secret}"`)
    expect(calls[0]!.opts!.auth).toEqual({
      connection: "boxtal",
      scheme: "bearer",
      exchange: { url: "https://api.boxtal.build/iam/account-app/token", fields: ["v3Key", "v3Secret"] },
    })
    expect(calls[1]!.opts!.auth).toEqual({ connection: "boxtal", scheme: "basic", fields: ["v1Key", "v1Secret"] })
  })
})
