// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The host's embedding process and the processes that ask it, over a real Unix
// socket. A stub embedder with fixed vectors stands in for the model.
import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { createConnection } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  defaultEmbedderSocketPath,
  EmbedderAlreadyRunning,
  type EmbedderLog,
  type EmbedderServer,
  EmbedderUnavailable,
  MAX_TEXTS,
  serveEmbedder,
  socketEmbedder,
} from "./embedder-socket"
import { type TextEmbedder, ToolMeaningIndex, toolMeaningText } from "./tool-meaning"

const DIM = 32
const unit = (axis: number) => Array.from({ length: DIM }, (_, i) => (i === axis ? 1 : 0))

const CATALOG = Array.from({ length: 24 }, (_, i) => ({
  sdkName: `gadgets__chore_${i}`,
  appName: "gadgets",
  toolName: `chore_${i}`,
  description: `Does chore number ${i}.`,
}))

const dirs: string[] = []
const servers: EmbedderServer[] = []
function socketPathFor(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "emb-"))
  dirs.push(dir)
  return path.join(dir, "run", "embedder.sock")
}

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function recordingLog() {
  const lines: Array<{ level: "warn" | "info"; msg: string; obj: object }> = []
  const log: EmbedderLog = {
    warn: (obj, msg) => lines.push({ level: "warn", msg, obj }),
    info: (obj, msg) => lines.push({ level: "info", msg, obj }),
  }
  return { log, lines }
}

/** A stub model: a query lands on axis 0, a tool text on its chore number + 1. */
function stubModel(opts: { delayMs?: number; fail?: boolean } = {}) {
  let loads = 0
  let calls = 0
  const embedder: TextEmbedder = {
    id: "stub",
    async embed(texts, kind) {
      calls++
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
      if (opts.fail) throw new Error("model files missing")
      return texts.map((t) => {
        if (kind === "query") return unit(0)
        const m = t.match(/chore (\d+)/)
        return unit(m ? 1 + Number(m[1]) : DIM - 1)
      })
    },
  }
  return {
    load: async () => {
      loads++
      return embedder
    },
    loads: () => loads,
    calls: () => calls,
  }
}

async function start(socketPath: string, model: ReturnType<typeof stubModel>) {
  const server = await serveEmbedder({ socketPath, load: model.load, log: recordingLog().log })
  servers.push(server)
  return server
}

const client = (socketPath: string, log: EmbedderLog, queryDeadlineMs = 150) =>
  socketEmbedder({ socketPath, queryDeadlineMs, documentDeadlineMs: 2_000, log })

describe("the embedding process over a Unix socket", () => {
  it("answers each text with its vector, in order, on a socket only its owner can open", async () => {
    const socketPath = socketPathFor()
    await start(socketPath, stubModel())
    const { log, lines } = recordingLog()
    const asker = client(socketPath, log)

    const docs = await asker.embed(["gadgets chore 3: x", "gadgets chore 7: y"], "document")
    expect(docs.map((v) => Array.from(v))).toEqual([unit(4), unit(8)])
    const [query] = await asker.embed(["cut his access"], "query")
    expect(Array.from(query ?? [])).toEqual(unit(0))
    expect(await asker.embed([], "query")).toEqual([])
    expect(statSync(socketPath).mode & 0o777).toBe(0o600)
    expect(lines).toEqual([])
  })

  it("loads the model once for two asking processes", async () => {
    const socketPath = socketPathFor()
    const model = stubModel()
    await start(socketPath, model)
    const a = client(socketPath, recordingLog().log)
    const b = client(socketPath, recordingLog().log)
    const [va, vb] = await Promise.all([
      a.embed(["gadgets chore 1: x"], "document"),
      b.embed(["gadgets chore 1: x"], "document"),
    ])
    expect(Array.from(va[0] ?? [])).toEqual(unit(2))
    expect(Array.from(vb[0] ?? [])).toEqual(unit(2))
    expect(model.loads()).toBe(1)
    expect(model.calls()).toBe(2)
  })

  it("refuses a second embedding process on a live socket and replaces a stale socket file", async () => {
    const socketPath = socketPathFor()
    const first = await start(socketPath, stubModel())
    await expect(
      serveEmbedder({ socketPath, load: stubModel().load, log: recordingLog().log }),
    ).rejects.toBeInstanceOf(EmbedderAlreadyRunning)
    await first.close()
    servers.splice(servers.indexOf(first), 1)
    // A stopped process's file left behind: the next start takes the path.
    const { writeFileSync } = await import("node:fs")
    writeFileSync(socketPath, "")
    await start(socketPath, stubModel())
    const out = await client(socketPath, recordingLog().log).embed(["q"], "query")
    expect(out).toHaveLength(1)
  })

  it("refuses a malformed or oversized request with its reason", async () => {
    const socketPath = socketPathFor()
    await start(socketPath, stubModel())
    const raw = (line: string) =>
      new Promise<string>((resolve) => {
        let buf = ""
        const sock = createConnection(socketPath)
        sock.setEncoding("utf8")
        sock.on("connect", () => sock.write(line))
        sock.on("data", (c: string) => {
          buf += c
        })
        sock.on("end", () => resolve(buf))
      })
    expect(JSON.parse(await raw("not json\n"))).toEqual({
      ok: false,
      error: "the request is not JSON",
    })
    const many = JSON.stringify({ kind: "document", texts: Array(MAX_TEXTS + 1).fill("x") })
    expect(JSON.parse(await raw(`${many}\n`)).error).toContain(`at most ${MAX_TEXTS}`)
  })

  it("puts its socket under the runtime folder unless one is set", () => {
    expect(defaultEmbedderSocketPath({ LIAISON_EMBEDDER_SOCKET: "/srv/e.sock" })).toBe(
      "/srv/e.sock",
    )
    expect(defaultEmbedderSocketPath({ XDG_RUNTIME_DIR: "/run/user/1000" })).toBe(
      "/run/user/1000/liaison/embedder.sock",
    )
  })
})

describe("tool search when the embedding process does not answer", () => {
  async function readyIndex(socketPath: string, log: EmbedderLog, queryDeadlineMs = 150) {
    const index = new ToolMeaningIndex(client(socketPath, log, queryDeadlineMs), {
      queryBudgetMs: 1_000,
      retryMs: 50,
    })
    index.prepare(CATALOG)
    await index.ready()
    return index
  }

  it("ranks by keywords when the socket is missing, logs one line for the outage, and recovers", async () => {
    const socketPath = socketPathFor()
    const { log, lines } = recordingLog()
    const index = await readyIndex(socketPath, log)
    expect(await index.meaningFor("q", CATALOG)).toBeNull()
    expect(await index.meaningFor("q", CATALOG)).toBeNull()
    expect(lines).toHaveLength(1)
    expect(lines[0]?.level).toBe("warn")
    expect((lines[0]?.obj as { reason?: string } | undefined)?.reason).toBe(
      `no socket at ${socketPath}`,
    )

    // The process starts: after the pause the tool vectors fill and meaning is back.
    await start(socketPath, stubModel())
    await new Promise((r) => setTimeout(r, 60))
    index.prepare(CATALOG)
    await index.ready()
    const meaning = await index.meaningFor("q", CATALOG)
    expect(meaning).not.toBeNull()
    expect(Array.from(meaning?.vectorOf("gadgets__chore_0") ?? [])).toEqual(unit(1))
    expect(lines.map((l) => l.level)).toEqual(["warn", "info"])
  })

  it("ranks by keywords when the answer comes past the deadline, with one log line", async () => {
    const socketPath = socketPathFor()
    const fast = await start(socketPath, stubModel())
    const { log, lines } = recordingLog()
    const index = await readyIndex(socketPath, log, 40)
    await fast.close()
    servers.splice(servers.indexOf(fast), 1)
    await start(socketPath, stubModel({ delayMs: 300 }))

    const t0 = Date.now()
    expect(await index.meaningFor("q", CATALOG)).toBeNull()
    expect(Date.now() - t0).toBeLessThan(250)
    expect(await index.meaningFor("q", CATALOG)).toBeNull()
    expect(lines).toHaveLength(1)
    expect((lines[0]?.obj as { reason?: string } | undefined)?.reason).toBe(
      "no answer within 40 ms",
    )
  })

  it("ranks by keywords when the process answers an error, with one log line", async () => {
    const socketPath = socketPathFor()
    await start(socketPath, stubModel({ fail: true }))
    const { log, lines } = recordingLog()
    const asker = client(socketPath, log)
    await expect(asker.embed(["q"], "query")).rejects.toBeInstanceOf(EmbedderUnavailable)
    await expect(asker.embed(["q"], "query")).rejects.toThrow(
      "the embedding process failed: model files missing",
    )
    const index = new ToolMeaningIndex(asker, { retryMs: 50 })
    index.prepare(CATALOG)
    await index.ready()
    expect(await index.meaningFor("q", CATALOG)).toBeNull()
    expect(lines).toHaveLength(1)
    expect(lines[0]?.level).toBe("warn")
  })

  it("keeps the tool texts queued through an outage instead of giving up on them", async () => {
    const socketPath = socketPathFor()
    const index = new ToolMeaningIndex(client(socketPath, recordingLog().log), { retryMs: 50 })
    index.prepare(CATALOG)
    await index.ready()
    const model = stubModel()
    await start(socketPath, model)
    // Inside the pause nothing is asked; after it the queue fills.
    index.prepare(CATALOG)
    await index.ready()
    expect(model.calls()).toBe(0)
    await new Promise((r) => setTimeout(r, 60))
    index.prepare(CATALOG)
    await index.ready()
    expect(model.calls()).toBe(Math.ceil(CATALOG.length / 4))
    expect(toolMeaningText(CATALOG[0] as (typeof CATALOG)[number])).toContain("chore 0")
  })
})
