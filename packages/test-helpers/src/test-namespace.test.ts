// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { DEV_COMPOSE_PROJECT, selfHostComposeIn } from "./ensure-infra"
import { deterministicPorts } from "./port-allocator"
import {
  LEGACY_PORT_BASE,
  namespaceEnv,
  namespaceForCheckout,
  namespaceMeiliIndexes,
  PORT_BLOCK_COUNT,
  PORT_BLOCK_SIZE,
  PORT_BLOCKS_START,
  portBlockBase,
  preferredPortBlock,
  resolveTestCoordinates,
  sanitizeNamespace,
  TEST_SUBSTRATE_MEILI_KEY,
} from "./test-namespace"

describe("namespace slug", () => {
  it("is the checkout directory name, sanitized", () => {
    expect(namespaceForCheckout("/x/liaison/.claude/worktrees/test-infra", {})).toBe("test_infra")
    expect(namespaceForCheckout("/home/me/liaison", {})).toBe("liaison")
  })

  it("is overridden by LIAISON_TEST_NS", () => {
    expect(namespaceForCheckout("/home/me/liaison", { LIAISON_TEST_NS: "B" })).toBe("b")
  })

  it("is always a safe SQL identifier, short, and unique when truncated", () => {
    expect(sanitizeNamespace("Feat/Einvoicing-P1")).toBe("feat_einvoicing_p1")
    expect(sanitizeNamespace("123-abc")).toBe("n123_abc")
    const a = sanitizeNamespace("a-very-long-worktree-name-number-one")
    const b = sanitizeNamespace("a-very-long-worktree-name-number-two")
    expect(a.length).toBeLessThanOrEqual(24)
    expect(a).not.toBe(b)
    for (const s of [a, b]) expect(s).toMatch(/^[a-z][a-z0-9_]*$/)
  })
})

describe("resolveTestCoordinates", () => {
  it("keeps the legacy shared coordinates when no namespace is set", () => {
    const c = resolveTestCoordinates({})
    expect(c.ns).toBeNull()
    expect(c.dbName).toBe("liaison_test")
    expect(c.superuserUrl()).toBe("postgres://postgres:postgres@localhost:5432/liaison_test")
    expect(c.appUrl()).toBe("postgres://liaison_app:liaison_app@localhost:5432/liaison_test")
    expect(c.workerRedisPrefix(3)).toBe("w3:")
    expect(c.workerMeiliPrefix(3)).toBe("w3_")
    expect(c.redisPrefix).toBe("")
    expect(c.portBase).toBe(LEGACY_PORT_BASE)
    expect(c.workerPorts(2, 2)).toEqual([14020, 14021])
    expect(namespaceEnv(c)).toEqual({})
  })

  it("namespaces every coordinate a run creates", () => {
    const c = resolveTestCoordinates({ LIAISON_TEST_NS: "a", LIAISON_TEST_PORT_BASE: "21000" })
    expect(c.dbName).toBe("liaison_test_a")
    expect(c.appUrl()).toBe("postgres://liaison_app:liaison_app@localhost:5432/liaison_test_a")
    expect(c.redisPrefix).toBe("a:")
    expect(c.workerRedisPrefix(3)).toBe("a:w3:")
    expect(c.meiliPrefix).toBe("a-")
    expect(c.workerMeiliPrefix(3)).toBe("a-w3_")
    expect(c.workerPorts(2, 3)).toEqual([21020, 21021, 21022])
  })

  it("keeps two namespaces apart everywhere they meet a shared service", () => {
    const a = resolveTestCoordinates({ LIAISON_TEST_NS: "a", LIAISON_TEST_PORT_BASE: "16000" })
    const b = resolveTestCoordinates({ LIAISON_TEST_NS: "b", LIAISON_TEST_PORT_BASE: "17000" })
    expect(a.dbName).not.toBe(b.dbName)
    // No prefix is a prefix of the other's, so a sweep of one never reaches the other.
    expect(b.redisPrefix.startsWith(a.redisPrefix)).toBe(false)
    expect(b.meiliPrefix.startsWith(a.meiliPrefix)).toBe(false)
    // And no namespaced prefix collides with the legacy per-worker ones (w<N>: / w<N>_).
    expect(/^w\d+_/.test(a.workerMeiliPrefix(0))).toBe(false)
    const portsA = new Set(Array.from({ length: 100 }, (_, i) => a.workerPorts(i, 10)).flat())
    const portsB = Array.from({ length: 100 }, (_, i) => b.workerPorts(i, 10)).flat()
    expect(portsB.some((p) => portsA.has(p))).toBe(false)
  })

  it("never lets one namespace's sweep reach a namespace whose name extends it", () => {
    const a = resolveTestCoordinates({ LIAISON_TEST_NS: "a" })
    const ab = resolveTestCoordinates({ LIAISON_TEST_NS: "a_b" })
    expect(ab.redisPrefix.startsWith(a.redisPrefix)).toBe(false)
    expect(ab.meiliPrefix.startsWith(a.meiliPrefix)).toBe(false)
    expect(ab.workerMeiliPrefix(0).startsWith(a.meiliPrefix)).toBe(false)
    expect(ab.workerRedisPrefix(0).startsWith(a.redisPrefix)).toBe(false)
  })

  it("keeps every worker inside its block, whatever the worker id", () => {
    const c = resolveTestCoordinates({ LIAISON_TEST_NS: "a", LIAISON_TEST_PORT_BASE: "16000" })
    for (const id of [0, 57, 99, 100, 140, 999]) {
      for (const p of c.workerPorts(id, 6)) {
        expect(p).toBeGreaterThanOrEqual(16000)
        expect(p).toBeLessThan(16000 + PORT_BLOCK_SIZE)
      }
    }
  })

  it("falls back to the namespace's preferred block without a lease", () => {
    const c = resolveTestCoordinates({ LIAISON_TEST_NS: "a" })
    expect(c.portBase).toBe(portBlockBase(preferredPortBlock("a")))
  })

  it("places every block above the legacy range and below the ephemeral range", () => {
    expect(PORT_BLOCKS_START).toBeGreaterThanOrEqual(LEGACY_PORT_BASE + 2000)
    expect(portBlockBase(PORT_BLOCK_COUNT - 1) + PORT_BLOCK_SIZE).toBeLessThanOrEqual(32768)
  })

  it("hands children the namespace database and prefixes", () => {
    const env = namespaceEnv(
      resolveTestCoordinates({ LIAISON_TEST_NS: "a", LIAISON_TEST_PORT_BASE: "16000" }),
    )
    expect(env).toMatchObject({
      LIAISON_TEST_NS: "a",
      LIAISON_TEST_PORT_BASE: "16000",
      DATABASE_URL: "postgres://liaison_app:liaison_app@localhost:5432/liaison_test_a",
      // Request transactions log in as liaison_request, as on a split deployment.
      DATABASE_REQUEST_PASSWORD: "liaison_request",
      E2E_DATABASE_URL: "postgres://postgres:postgres@localhost:5432/liaison_test_a",
      E2E_SERVER_DATABASE_URL: "postgres://liaison_app:liaison_app@localhost:5432/liaison_test_a",
      REDIS_PREFIX: "a:",
      MEILI_INDEX_PREFIX: "a-",
      MEILISEARCH_API_KEY: "dev-master-key",
    })
  })

  it("runs request transactions on the privileged login when the run asks for unsplit logins", () => {
    const c = resolveTestCoordinates({ LIAISON_TEST_NS: "a" })
    // Empty, not absent: it overrides a password the parent environment carries,
    // and the API's env schema reads "" as unset (one login for every pool).
    expect(
      namespaceEnv(c, { LIAISON_TEST_UNSPLIT_LOGINS: "1", DATABASE_REQUEST_PASSWORD: "x" })
        .DATABASE_REQUEST_PASSWORD,
    ).toBe("")
    expect(namespaceEnv(c, { LIAISON_TEST_UNSPLIT_LOGINS: "0" }).DATABASE_REQUEST_PASSWORD).toBe(
      "liaison_request",
    )
  })

  it("names the key docker-compose.yml starts the substrate's Meilisearch with", () => {
    const compose = readFileSync(path.join(import.meta.dir, "../../../docker-compose.yml"), "utf8")
    expect(compose).toContain(`MEILI_MASTER_KEY: ${TEST_SUBSTRATE_MEILI_KEY}`)
  })

  it("names one compose project, so every checkout and worktree starts and recovers the same substrate", () => {
    const compose = readFileSync(path.join(import.meta.dir, "../../../docker-compose.yml"), "utf8")
    expect(compose).toMatch(new RegExp(`^name: ${DEV_COMPOSE_PROJECT}$`, "m"))
  })

  it("dev tooling refuses a compose project that holds the self-host stack, which shares its name", () => {
    const selfHost = readFileSync(
      path.join(import.meta.dir, "../../../deploy/docker-compose.yml"),
      "utf8",
    )
    expect(selfHost).toMatch(new RegExp(`^name: ${DEV_COMPOSE_PROJECT}$`, "m"))
    expect(selfHostComposeIn(["/srv/liaison/deploy/docker-compose.yml"])).toBe(
      "/srv/liaison/deploy/docker-compose.yml",
    )
    expect(
      selfHostComposeIn([
        "/home/me/liaison/deploy/docker-compose.yml,/home/me/liaison/deploy/override.compose.yml",
      ]),
    ).toBe("/home/me/liaison/deploy/docker-compose.yml")
    expect(
      selfHostComposeIn(["/home/me/liaison/docker-compose.yml", "", "/x/wt/docker-compose.yml"]),
    ).toBeNull()
  })

  it("points children at the substrate's Meilisearch key, whatever the checkout's .env says", () => {
    const c = resolveTestCoordinates({ LIAISON_TEST_NS: "a" })
    expect(namespaceEnv(c, { MEILISEARCH_API_KEY: "a-stale-dev-key" }).MEILISEARCH_API_KEY).toBe(
      "dev-master-key",
    )
    expect(namespaceEnv(c, { LIAISON_TEST_MEILI_API_KEY: "custom" }).MEILISEARCH_API_KEY).toBe(
      "custom",
    )
  })

  it("lists every Meili index a namespace can create, and none for a bare run", () => {
    const c = resolveTestCoordinates({ LIAISON_TEST_NS: "a" })
    const names = namespaceMeiliIndexes(c)
    expect(names).toContain("a-liaison_search")
    expect(names).toContain(`${c.workerMeiliPrefix(7)}liaison_search`)
    expect(names).toContain("a-s3_liaison_search")
    for (const n of names) expect(n.startsWith("a-")).toBe(true)
    expect(namespaceMeiliIndexes(resolveTestCoordinates({}))).toEqual([])
  })

  it("is what deterministicPorts allocates from", () => {
    expect(deterministicPorts(1, 2, {})).toEqual([14010, 14011])
    expect(
      deterministicPorts(1, 2, { LIAISON_TEST_NS: "a", LIAISON_TEST_PORT_BASE: "16000" }),
    ).toEqual([16010, 16011])
  })
})
