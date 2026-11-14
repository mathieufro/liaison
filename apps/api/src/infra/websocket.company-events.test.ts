// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Company frames (`kernel/company:*`) reach holders of the companies read
// scope, on every delivery path (broadcast, bufferAndBroadcast, hello
// replay). A company shared with nobody reaches only its creator and the
// people it is shared with, never another member, not even an admin holding
// `*`. The frame crosses the socket as the company id alone: the name, the
// sharing lists and the rest of the row stay on the server, and a client
// refetches the company through the API, where RLS decides. A frame that says
// nothing of its audience reaches no one (fail closed).
import { beforeEach, describe, expect, it, mock } from "bun:test"
import { WebSocketManager } from "~/infra/websocket"

// Tiny in-memory shim for the subset of ioredis the manager and its live state
// actually call, so the manager runs without a live Redis on the test runner
// (`websocket-state/redis.test.ts` runs the live state against the real Redis).
const _store = new Map<string, string>()
const _sets = new Map<string, Set<string>>()
const mockRedis = {
  zadd: mock(() => Promise.resolve()),
  // The replay buffer append (websocket-replay-buffer.ts) is one Lua script.
  eval: mock((..._args: unknown[]) => Promise.resolve(0)),
  zrangebyscore: mock(() => Promise.resolve([] as string[])),
  expire: mock(() => Promise.resolve()),
  incr: mock(() => Promise.resolve(1)),
  exists: mock(() => Promise.resolve(1)),
  set: mock((key: string, value: string) => {
    _store.set(key, value)
    return Promise.resolve("OK")
  }),
  get: mock((key: string) => Promise.resolve(_store.get(key) ?? null)),
  del: mock((...keys: string[]) => {
    let n = 0
    for (const k of keys) {
      if (_store.delete(k)) n++
      if (_sets.delete(k)) n++
    }
    return Promise.resolve(n)
  }),
  sadd: mock((key: string, ...members: string[]) => {
    let set = _sets.get(key)
    if (!set) {
      set = new Set()
      _sets.set(key, set)
    }
    let added = 0
    for (const m of members) {
      if (!set.has(m)) {
        set.add(m)
        added++
      }
    }
    return Promise.resolve(added)
  }),
  srem: mock((key: string, ...members: string[]) => {
    const set = _sets.get(key)
    if (!set) return Promise.resolve(0)
    let removed = 0
    for (const m of members) {
      if (set.delete(m)) removed++
    }
    return Promise.resolve(removed)
  }),
  smembers: mock((key: string) => {
    const set = _sets.get(key)
    return Promise.resolve(set ? Array.from(set) : [])
  }),
  mget: mock(() => Promise.resolve(["online", "away"])),
  scanStream: mock(() => {
    const stream = {
      on: mock((event: string, cb: (...args: any[]) => void) => {
        if (event === "data") cb(["presence:org1:user1", "presence:org1:user2"])
        if (event === "end") setTimeout(() => cb(), 0)
        return stream
      }),
    }
    return stream
  }),
}

function updated(audience: { orgWide: boolean; userIds: string[] } | undefined) {
  return {
    app: "kernel",
    entity: "company",
    action: "update",
    entityId: "c1",
    orgId: "org-1",
    data: {
      id: "c1",
      name: "Maison Arlon",
      domain: "arlon.example",
      aclUserIds: ["grantee"],
      renamedPeople: 3,
      ...(audience ? { audience } : {}),
    },
  }
}

const socket = () => ({ send: mock(() => {}), readyState: 1 }) as any
const READ = ["kernel:contacts:read", "kernel:companies:read"]
const frameOf = (ws: any, i = 0) => JSON.parse(ws.send.mock.calls[i][0] as string)

describe("kernel/company frames", () => {
  let manager: WebSocketManager

  beforeEach(() => {
    _store.clear()
    _sets.clear()
    manager = new WebSocketManager(mockRedis as any)
    mockRedis.zrangebyscore.mockClear()
  })

  it("an org-wide company reaches a member holding the companies read scope, as its id alone", async () => {
    const member = socket()
    const contactsOnly = socket()
    manager.addConnection("member", member, READ, "org-1")
    manager.addConnection("contacts-only", contactsOnly, ["kernel:contacts:read"], "org-1")
    await manager.broadcast(updated({ orgWide: true, userIds: [] }))
    await manager.bufferAndBroadcast(updated({ orgWide: true, userIds: [] }))
    expect(member.send).toHaveBeenCalledTimes(2)
    expect(contactsOnly.send).not.toHaveBeenCalled()
    for (const i of [0, 1]) expect(frameOf(member, i).payload.data).toEqual({ id: "c1" })
  })

  it("a private company reaches its creator and grantees, not another member or an admin", async () => {
    const creator = socket()
    const grantee = socket()
    const member = socket()
    const admin = socket()
    manager.addConnection("creator", creator, READ, "org-1")
    manager.addConnection("grantee", grantee, READ, "org-1")
    manager.addConnection("member", member, READ, "org-1")
    manager.addConnection("admin", admin, ["*"], "org-1")
    const audience = { orgWide: false, userIds: ["creator", "grantee"] }
    await manager.broadcast(updated(audience))
    await manager.bufferAndBroadcast(updated(audience))
    expect(creator.send).toHaveBeenCalledTimes(2)
    expect(grantee.send).toHaveBeenCalledTimes(2)
    expect(member.send).not.toHaveBeenCalled()
    expect(admin.send).not.toHaveBeenCalled()
    expect(frameOf(grantee).payload.data).toEqual({ id: "c1" })
  })

  it("a company frame without an audience reaches no one", async () => {
    const member = socket()
    manager.addConnection("member", member, READ, "org-1")
    await manager.bufferAndBroadcast(updated(undefined))
    expect(member.send).not.toHaveBeenCalled()
  })

  it("hello replay sends another member nothing for a private company", async () => {
    mockRedis.zrangebyscore.mockResolvedValueOnce([
      JSON.stringify({
        type: "event",
        eventId: 1,
        payload: updated({ orgWide: false, userIds: ["creator"] }),
      }),
      JSON.stringify({
        type: "event",
        eventId: 2,
        payload: updated({ orgWide: true, userIds: [] }),
      }),
    ])
    const member = socket()
    manager.addConnection("member", member, READ, "org-1")
    await manager.handleHello(member, "member", 1, READ, "org-1")
    expect(member.send).toHaveBeenCalledTimes(1)
    const frame = frameOf(member)
    expect(frame.eventId).toBe(2)
    expect(frame.payload.data).toEqual({ id: "c1" })
  })
})
