// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The embedding process: one per host. It loads tool search's model once
 * (local-embedder.ts), then answers the host's API and worker processes on its
 * Unix socket (embedder-socket.ts, `LIAISON_EMBEDDER_SOCKET`). The socket
 * appears only once the model is loaded, so an asking process falls back to
 * keywords while it loads. Started by the image as `embedder`, or from
 * apps/api with `bun run embedder`.
 *
 * A model that cannot load (files missing and not fetchable, a hash mismatch)
 * or a second embedding process on the same socket exits non-zero with the
 * reason in the log.
 */
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { defaultEmbedderSocketPath, serveEmbedder } from "./embedder-socket"
import { loadLocalEmbedder } from "./local-embedder"

const log = rootLogger.child({ component: "embedder" })
const socketPath = defaultEmbedderSocketPath({
  LIAISON_EMBEDDER_SOCKET: env.LIAISON_EMBEDDER_SOCKET,
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
})

const started = Date.now()
try {
  const server = await serveEmbedder({
    socketPath,
    log,
    load: async () => {
      const embedder = await loadLocalEmbedder()
      // One query loads the weights into memory before the socket opens.
      await embedder.embed(["warm up"], "query")
      return embedder
    },
  })
  log.info(
    {
      socket: socketPath,
      loadMs: Date.now() - started,
      rssMb: Math.round(process.memoryUsage().rss / 1e6),
    },
    "embedding process: model loaded, answering on the socket",
  )
  let stopping = false
  const stop = (signal: string) => {
    if (stopping) return
    stopping = true
    log.info({ signal }, "embedding process: stopping")
    void server.close().finally(() => process.exit(0))
  }
  process.on("SIGTERM", () => stop("SIGTERM"))
  process.on("SIGINT", () => stop("SIGINT"))
} catch (err) {
  log.error({ err, socket: socketPath }, "embedding process: could not start")
  process.exit(1)
}
