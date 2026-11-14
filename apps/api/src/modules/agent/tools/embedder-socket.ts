// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * One embedding process per host, asked over a local Unix socket.
 *
 * Tool search's model (local-embedder.ts) costs about 1.1 GB of memory once it
 * is loaded, so it is loaded once per host, in its own process
 * (embedder-main.ts), and every API or worker process asks that process for its
 * vectors. There is no network port: the socket is a file, readable and
 * writable by its owner only.
 *
 * The protocol is one request per connection, one JSON line each way:
 *   request  {"kind":"query"|"document","texts":["..."]}
 *   answer   {"ok":true,"dim":768,"count":n,"vectors":"<base64 float32, row after row>"}
 *            {"ok":false,"error":"..."}
 *
 * The asking side (socketEmbedder) bounds every call by a deadline. A socket
 * that is missing, refuses, answers late or answers an error throws
 * EmbedderUnavailable, and tool search ranks that search by keywords alone. It
 * logs one line when the process stops answering and one when it answers again,
 * never one per search.
 */
import { existsSync } from "node:fs"
import { chmod, mkdir, rm } from "node:fs/promises"
import { createConnection, createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import type { TextEmbedder, Vector } from "./tool-meaning"

/** The embedding process did not answer in time, or answered an error. Temporary. */
export class EmbedderUnavailable extends Error {}

/** The two log levels this module writes at (pino's signature). */
export interface EmbedderLog {
  warn(obj: object, msg: string): void
  info(obj: object, msg: string): void
}

/** Longest request line the process reads; anything longer is refused. */
export const MAX_REQUEST_BYTES = 1 << 20
/** Most texts in one request. */
export const MAX_TEXTS = 64
/** Longest text in one request, in characters. */
export const MAX_TEXT_CHARS = 8_000
/** Longest answer the asking side reads. */
const MAX_ANSWER_BYTES = 16 << 20

/**
 * The socket's path: `LIAISON_EMBEDDER_SOCKET`, else `liaison/embedder.sock`
 * under the runtime folder (`XDG_RUNTIME_DIR`, else the temporary folder).
 */
export function defaultEmbedderSocketPath(e: {
  LIAISON_EMBEDDER_SOCKET?: string
  XDG_RUNTIME_DIR?: string
}): string {
  if (e.LIAISON_EMBEDDER_SOCKET) return e.LIAISON_EMBEDDER_SOCKET
  return path.join(e.XDG_RUNTIME_DIR || tmpdir(), "liaison", "embedder.sock")
}

const lazyLog: EmbedderLog = {
  warn(obj, msg) {
    void import("~/lib/logger").then(({ rootLogger }) => rootLogger.warn(obj, msg)).catch(() => {})
  },
  info(obj, msg) {
    void import("~/lib/logger").then(({ rootLogger }) => rootLogger.info(obj, msg)).catch(() => {})
  },
}

function encodeVectors(vectors: Vector[]): { dim: number; count: number; vectors: string } {
  const dim = vectors[0]?.length ?? 0
  const flat = new Float32Array(dim * vectors.length)
  vectors.forEach((v, i) => {
    if (v.length !== dim) throw new Error(`vector ${i} has ${v.length} values, expected ${dim}`)
    flat.set(v as ArrayLike<number>, i * dim)
  })
  return {
    dim,
    count: vectors.length,
    vectors: Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength).toString("base64"),
  }
}

function decodeVectors(dim: number, count: number, b64: string): Float32Array[] {
  const bytes = Buffer.from(b64, "base64")
  if (bytes.byteLength !== dim * count * 4) throw new Error("vectors do not match dim x count")
  const flat = new Float32Array(dim * count)
  new Uint8Array(flat.buffer).set(bytes)
  return Array.from({ length: count }, (_, i) => flat.subarray(i * dim, (i + 1) * dim))
}

function parseRequest(line: string): { kind: "query" | "document"; texts: string[] } {
  let body: unknown
  try {
    body = JSON.parse(line)
  } catch {
    throw new Error("the request is not JSON")
  }
  const { kind, texts } = (body ?? {}) as { kind?: unknown; texts?: unknown }
  if (kind !== "query" && kind !== "document") throw new Error('kind must be "query" or "document"')
  if (!Array.isArray(texts) || !texts.every((t) => typeof t === "string"))
    throw new Error("texts must be an array of strings")
  if (texts.length > MAX_TEXTS) throw new Error(`at most ${MAX_TEXTS} texts per request`)
  if (texts.some((t) => t.length > MAX_TEXT_CHARS))
    throw new Error(`a text is longer than ${MAX_TEXT_CHARS} characters`)
  return { kind, texts }
}

// ── The embedding process's side ─────────────────────────────────────────

export interface EmbedderServer {
  readonly socketPath: string
  close(): Promise<void>
}

/** Another process already answers on the socket: one embedding process per host. */
export class EmbedderAlreadyRunning extends Error {}

function answers(socketPath: string, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection(socketPath)
    const done = (alive: boolean) => {
      clearTimeout(timer)
      sock.destroy()
      resolve(alive)
    }
    const timer = setTimeout(() => done(true), timeoutMs)
    sock.once("connect", () => done(true))
    sock.once("error", () => done(false))
  })
}

/**
 * Answer embed requests on `socketPath` with the embedder `load` returns,
 * called once. Requests run one at a time, a search's query before any tool
 * text waiting, and a request whose caller has gone is skipped. A stale socket
 * file left by a stopped process is replaced; a live one refuses the start.
 */
export async function serveEmbedder(opts: {
  socketPath: string
  load: () => Promise<TextEmbedder>
  log?: EmbedderLog
}): Promise<EmbedderServer> {
  const log = opts.log ?? lazyLog
  const { socketPath } = opts
  const embedder = await opts.load()

  await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 })
  if (existsSync(socketPath)) {
    if (await answers(socketPath))
      throw new EmbedderAlreadyRunning(`an embedding process already answers on ${socketPath}`)
    await rm(socketPath, { force: true })
  }

  type Job = { kind: "query" | "document"; texts: string[]; sock: Socket }
  const queries: Job[] = []
  const documents: Job[] = []
  let running = false
  let failing = false

  const reply = (sock: Socket, body: object) => {
    if (!sock.destroyed) sock.end(`${JSON.stringify(body)}\n`)
  }

  const drain = async () => {
    if (running) return
    running = true
    try {
      for (
        let job = queries.shift() ?? documents.shift();
        job;
        job = queries.shift() ?? documents.shift()
      ) {
        if (job.sock.destroyed) continue
        try {
          const vectors = job.texts.length ? await embedder.embed(job.texts, job.kind) : []
          reply(job.sock, { ok: true, ...encodeVectors(vectors) })
          if (failing) {
            failing = false
            log.info({ embedder: embedder.id }, "embedding process: the model answers again")
          }
        } catch (err) {
          reply(job.sock, { ok: false, error: err instanceof Error ? err.message : String(err) })
          if (!failing) {
            failing = true
            log.warn({ err, embedder: embedder.id }, "embedding process: the model failed to embed")
          }
        }
      }
    } finally {
      running = false
    }
  }

  const server: Server = createServer((sock) => {
    let buf = ""
    let taken = false
    sock.setEncoding("utf8")
    sock.on("error", () => sock.destroy())
    sock.on("data", (chunk: string) => {
      if (taken) return
      buf += chunk
      const nl = buf.indexOf("\n")
      if (nl < 0 && buf.length <= MAX_REQUEST_BYTES) return
      taken = true
      if (nl < 0) {
        reply(sock, { ok: false, error: `the request is longer than ${MAX_REQUEST_BYTES} bytes` })
        return
      }
      try {
        const req = parseRequest(buf.slice(0, nl))
        ;(req.kind === "query" ? queries : documents).push({ ...req, sock })
        void drain()
      } catch (err) {
        reply(sock, { ok: false, error: (err as Error).message })
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPath, () => {
      server.off("error", reject)
      resolve()
    })
  })
  await chmod(socketPath, 0o600)

  return {
    socketPath,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(socketPath, { force: true })
    },
  }
}

// ── The asking side ──────────────────────────────────────────────────────

/** Send one request and read its answer, within `deadlineMs`. */
function ask(
  socketPath: string,
  body: { kind: "query" | "document"; texts: string[] },
  deadlineMs: number,
): Promise<Float32Array[]> {
  return new Promise((resolve, reject) => {
    let settled = false
    let buf = ""
    const sock = createConnection(socketPath)
    const finish = (err: Error | null, out?: Float32Array[]) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.destroy()
      if (err)
        reject(err instanceof EmbedderUnavailable ? err : new EmbedderUnavailable(err.message))
      else resolve(out ?? [])
    }
    const timer = setTimeout(
      () => finish(new EmbedderUnavailable(`no answer within ${deadlineMs} ms`)),
      deadlineMs,
    )
    sock.setEncoding("utf8")
    sock.once("connect", () => sock.write(`${JSON.stringify(body)}\n`))
    sock.on("error", (err: NodeJS.ErrnoException) =>
      finish(
        new EmbedderUnavailable(err.code === "ENOENT" ? `no socket at ${socketPath}` : err.message),
      ),
    )
    sock.on("data", (chunk: string) => {
      buf += chunk
      if (buf.length > MAX_ANSWER_BYTES)
        return finish(new EmbedderUnavailable("the answer is too long"))
      const nl = buf.indexOf("\n")
      if (nl < 0) return
      try {
        const ans = JSON.parse(buf.slice(0, nl)) as
          | { ok: true; dim: number; count: number; vectors: string }
          | { ok: false; error: string }
        if (!ans.ok)
          return finish(new EmbedderUnavailable(`the embedding process failed: ${ans.error}`))
        if (ans.count !== body.texts.length)
          return finish(
            new EmbedderUnavailable(`${ans.count} vectors for ${body.texts.length} texts`),
          )
        finish(null, decodeVectors(ans.dim, ans.count, ans.vectors))
      } catch (err) {
        finish(err as Error)
      }
    })
    sock.on("end", () =>
      finish(new EmbedderUnavailable("the embedding process closed without an answer")),
    )
  })
}

/**
 * A TextEmbedder that asks the host's embedding process. Every call is bounded:
 * `queryDeadlineMs` for a search's query, `documentDeadlineMs` for a batch of
 * tool texts. A failure throws EmbedderUnavailable; the first one of an outage
 * logs one line, and the first answer after it logs that the process is back.
 */
export function socketEmbedder(opts: {
  socketPath: string
  queryDeadlineMs: number
  documentDeadlineMs: number
  log?: EmbedderLog
}): TextEmbedder {
  const log = opts.log ?? lazyLog
  let down = false
  return {
    id: `socket:${opts.socketPath}`,
    async embed(texts, kind) {
      const deadline = kind === "query" ? opts.queryDeadlineMs : opts.documentDeadlineMs
      try {
        const out = await ask(opts.socketPath, { kind, texts }, deadline)
        if (down) {
          down = false
          log.info(
            { socket: opts.socketPath },
            "tool search: the embedding process answers again, so tools rank by meaning too",
          )
        }
        return out
      } catch (err) {
        if (!down) {
          down = true
          log.warn(
            { socket: opts.socketPath, reason: (err as Error).message },
            "tool search: the embedding process does not answer, so tools rank by words alone until it does (start it with `embedder`, see the self-hosting docs)",
          )
        }
        throw err
      }
    },
  }
}
