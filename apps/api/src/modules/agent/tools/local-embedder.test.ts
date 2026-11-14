// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Tool search's model files are fetched at one pinned revision, each checked
// against its SHA-256 before it is used, and kept in the model cache folder
// only. A stub stands in for the network.
import { afterAll, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ensureModelFiles, LOCAL_MODEL, ModelFileMismatch } from "./local-embedder"

const sha = (s: string) => createHash("sha256").update(s).digest("hex")
const dirs: string[] = []
const freshDir = () => {
  const d = mkdtempSync(path.join(tmpdir(), "model-cache-"))
  dirs.push(d)
  return d
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const CONTENT: Record<string, string> = { "config.json": '{"a":1}', "onnx/model.onnx": "weights" }
const MODEL = {
  repo: "org/model",
  revision: "0123456789abcdef0123456789abcdef01234567",
  files: Object.fromEntries(Object.entries(CONTENT).map(([f, c]) => [f, sha(c)])),
}
const network = (body: (file: string) => string = (f) => CONTENT[f] ?? "") => {
  const urls: string[] = []
  const fetchFile = async (url: string) => {
    urls.push(url)
    const file = url.split(`/resolve/${MODEL.revision}/`)[1] ?? ""
    return new Response(body(file))
  }
  return { urls, fetchFile }
}
const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
    .sort()

describe("tool search model files", () => {
  it("fetches each file at the pinned revision into the cache folder, and nowhere else", async () => {
    const dir = freshDir()
    const net = network()
    await ensureModelFiles(dir, MODEL, net.fetchFile)
    expect(net.urls).toEqual([
      `https://huggingface.co/org/model/resolve/${MODEL.revision}/config.json`,
      `https://huggingface.co/org/model/resolve/${MODEL.revision}/onnx/model.onnx`,
    ])
    expect(filesUnder(dir)).toEqual(["org/model/config.json", "org/model/onnx/model.onnx"])
  })

  it("fetches nothing when every file is there and matches", async () => {
    const dir = freshDir()
    await ensureModelFiles(dir, MODEL, network().fetchFile)
    const again = network()
    await ensureModelFiles(dir, MODEL, again.fetchFile)
    expect(again.urls).toHaveLength(0)
  })

  it("refuses a file whose hash does not match, and keeps no trace of it", async () => {
    const dir = freshDir()
    const tampered = network((f) =>
      f === "onnx/model.onnx" ? "other weights" : (CONTENT[f] ?? ""),
    )
    await expect(ensureModelFiles(dir, MODEL, tampered.fetchFile)).rejects.toBeInstanceOf(
      ModelFileMismatch,
    )
    expect(existsSync(path.join(dir, "org/model/onnx/model.onnx"))).toBe(false)
    expect(filesUnder(dir)).toEqual(["org/model/config.json"])
  })

  it("replaces a file on disk that no longer matches", async () => {
    const dir = freshDir()
    await ensureModelFiles(dir, MODEL, network().fetchFile)
    const file = path.join(dir, "org/model/onnx/model.onnx")
    writeFileSync(file, "corrupted")
    const net = network()
    await ensureModelFiles(dir, MODEL, net.fetchFile)
    expect(net.urls).toHaveLength(1)
    expect(readFileSync(file, "utf8")).toBe("weights")
  })

  it("pins the shipped model to one revision and a hash for every file it reads", () => {
    expect(LOCAL_MODEL.repo).toBe("Snowflake/snowflake-arctic-embed-m-v2.0")
    expect(LOCAL_MODEL.revision).toMatch(/^[0-9a-f]{40}$/)
    expect(Object.keys(LOCAL_MODEL.files)).toContain("onnx/model_quantized.onnx")
    for (const h of Object.values(LOCAL_MODEL.files)) expect(h).toMatch(/^[0-9a-f]{64}$/)
  })
})
