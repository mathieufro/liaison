// SPDX-License-Identifier: FSL-1.1-ALv2
// Test helper: a fake IMAP server behind an ImapFlow-like client. Nothing in
// the app imports this file.
import type { ImapFetchClient } from "~/modules/apps/sandbox/imap-bridge"

export const rawImapMessage = (uid: number, body = `Body of ${uid}`) =>
  Buffer.from(
    `Message-ID: <m${uid}@example.test>\r\nFrom: a@example.test\r\nTo: b@example.test\r\nSubject: S${uid}\r\nContent-Type: text/plain\r\n\r\n${body}\r\n`,
  )

/**
 * A fake IMAP server over a folder of `uids`, modelled on ImapFlow where it
 * matters here: ONE command at a time (a download issued while a FETCH is
 * being iterated is the real client's deadlock, here an error), and every
 * command counted, so a test can assert how much one page asks of the server.
 */
export function fakeImapServer(opts: {
  /** The INBOX's UIDs (a live array: push to it to deliver new mail). */
  uids: number[]
  /** The Sent folder's UIDs ("Sent", flagged \\Sent as a listOnly LIST shows it). */
  sentUids?: number[]
  sizes?: Record<number, number>
  failDownload?: (uid: number, part?: string) => Error | null
}) {
  let current = opts.uids
  const folderOf = (path: string) => (path === "Sent" ? (opts.sentUids ?? []) : opts.uids)
  const stats = {
    searches: [] as unknown[],
    fetchedRows: 0,
    fetchRanges: [] as unknown[],
    downloads: [] as Array<{ uid: number; part?: string; maxBytes?: number }>,
    lockedReadOnly: [] as boolean[],
    logouts: 0,
  }
  let fetchOpen = false
  const client: ImapFetchClient & { logout(): Promise<void>; close(): void } = {
    capabilities: new Map(),
    usable: true,
    mailbox: { uidValidity: 42n },
    async list() {
      return [{ path: "INBOX" }, { path: "Sent", flags: new Set(["\\HasNoChildren", "\\Sent"]) }]
    },
    async getMailboxLock(path, options) {
      stats.lockedReadOnly.push(options?.readOnly === true)
      current = folderOf(path)
      return { release() {} }
    },
    async search(query) {
      if (fetchOpen) throw new Error("command issued inside a FETCH iteration")
      stats.searches.push(query)
      if ((query as { all?: boolean }).all) return [...current]
      const range = String((query as { uid?: string }).uid ?? "")
      const [lo, hi] = range.split(":")
      const min = Number(lo)
      const max = hi === "*" ? Number.POSITIVE_INFINITY : Number(hi ?? lo)
      const hits = current.filter((u) => u >= min && u <= max)
      // `n:*` above the top UID still matches the top message (RFC 3501).
      if (hits.length === 0 && hi === "*" && current.length > 0) return [Math.max(...current)]
      return hits
    },
    fetch(range, query, _options) {
      if (fetchOpen) throw new Error("command issued inside a FETCH iteration")
      stats.fetchRanges.push(range)
      const wanted = Array.isArray(range) ? new Set(range) : null
      if (!wanted) throw new Error(`unbounded FETCH range ${String(range)}`)
      const rows = current.filter((u) => wanted.has(u))
      return (async function* () {
        fetchOpen = true
        try {
          for (const uid of rows) {
            stats.fetchedRows++
            yield {
              uid,
              // ImapFlow answers `headers` with the raw block, and only when asked.
              ...((query as { headers?: unknown } | undefined)?.headers
                ? {
                    headers: Buffer.from(
                      "List-Id: <news.example.test>\r\nPrecedence: bulk\r\n\r\n",
                    ),
                  }
                : {}),
              flags: new Set<string>(),
              size: opts.sizes?.[uid] ?? rawImapMessage(uid).byteLength,
              envelope: {
                messageId: `<m${uid}@example.test>`,
                subject: `S${uid}`,
                from: [{ address: "a@example.test" }],
                date: new Date(Date.UTC(2026, 0, 1) + uid * 1000),
              },
              bodyStructure: {
                childNodes: [
                  { part: "1", type: "text/plain" },
                  { part: "2", type: "application/pdf", disposition: "attachment" },
                ],
              },
            } as { uid: number; flags?: Set<string> }
          }
        } finally {
          fetchOpen = false
        }
      })()
    },
    async download(range, part, options) {
      if (fetchOpen) throw new Error("command issued inside a FETCH iteration")
      const uid = Number(range)
      stats.downloads.push({ uid, part, maxBytes: options?.maxBytes })
      const failure = opts.failDownload?.(uid, part)
      if (failure) throw failure
      const size = opts.sizes?.[uid]
      // A message's whole source is as large as the server says (up to the cap asked).
      const whole =
        size && size > rawImapMessage(uid).byteLength
          ? rawImapMessage(uid, "x".repeat(Math.min(size, options?.maxBytes ?? size)))
          : rawImapMessage(uid)
      const bytes = part ? Buffer.from(`Text part ${part} of ${uid}`) : whole
      return {
        content: (async function* () {
          yield new Uint8Array(bytes)
        })(),
      }
    },
    async messageFlagsAdd() {
      throw new Error("a sync never writes")
    },
    async messageFlagsRemove() {
      throw new Error("a sync never writes")
    },
    async messageMove() {
      throw new Error("a sync never writes")
    },
    async append() {
      throw new Error("a sync never writes")
    },
    async logout() {
      stats.logouts++
    },
    close() {},
  }
  return { client, stats }
}
