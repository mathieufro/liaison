// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A small multilingual embedding model run in the API process (ONNX on the
 * CPU, through transformers.js), for tool search's meaning score
 * (tool-meaning.ts): Snowflake arctic-embed-m-v2.0, Apache-2.0, 8-bit weights.
 * Nothing leaves the machine.
 *
 * The model's files are pinned to one revision and one SHA-256 each. They are
 * fetched once into the model cache folder (`LIAISON_MODEL_CACHE_DIR`), each
 * checked against its hash before it is used, and transformers.js reads them
 * from there only: it never downloads on its own. When a file is missing and
 * cannot be fetched, or does not match, loading throws and tool search ranks by
 * keywords alone.
 */
import { createHash } from "node:crypto"
import { createReadStream, existsSync } from "node:fs"
import { mkdir, rename, rm } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { fetchWithRedirectValidation } from "~/lib/outbound-fetch"
import type { TextEmbedder, Vector } from "./tool-meaning"

export const LOCAL_MODEL = {
  repo: "Snowflake/snowflake-arctic-embed-m-v2.0",
  revision: "95c2741480856aa9666782eb4afe11959938017f",
  /** 8-bit weights: transformers.js reads them as `onnx/model_quantized.onnx`. */
  dtype: "q8",
  queryPrefix: "query: ",
  files: {
    "config.json": "2e0b386e7a826903b06c301f8d4dde2ac6279f7ccd3ea11f3911019a1ee0bc05",
    "tokenizer.json": "f1cc44ad7faaeec47241864835473fd5403f2da94673f3f764a77ebcb0a803ec",
    "tokenizer_config.json": "6f00514620aff01ba8b7291b2394e98daca5be264cb743805232d9ae27494b2a",
    "special_tokens_map.json": "8c785abebea9ae3257b61681b4e6fd8365ceafde980c21970d001e834cf10835",
    "onnx/model_quantized.onnx": "03d923bb1850ebdccb068e2f3abd8aa43fe81c50d07d037ef103fe3d0fb78e3b",
  } as Record<string, string>,
} as const

/** Where the model's files live: `LIAISON_MODEL_CACHE_DIR`, else ~/.cache/liaison/models. */
export function modelCacheDir(): string {
  return process.env.LIAISON_MODEL_CACHE_DIR || path.join(homedir(), ".cache", "liaison", "models")
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest("hex")
}

export class ModelFileMismatch extends Error {}

/**
 * Every pinned file present in `dir` and matching its hash: a missing one is
 * fetched at the pinned revision into a temporary name beside it, checked,
 * then renamed in place. A file on disk that does not match is replaced.
 */
export async function ensureModelFiles(
  dir: string,
  model: { repo: string; revision: string; files: Record<string, string> } = LOCAL_MODEL,
  // The model host redirects to its file CDN: every hop is checked and pinned.
  fetchFile: (url: string) => Promise<Response> = (url) => fetchWithRedirectValidation(url),
): Promise<string> {
  const root = path.join(dir, model.repo)
  for (const [file, sha] of Object.entries(model.files)) {
    const target = path.join(root, file)
    if (existsSync(target) && (await sha256Of(target)) === sha) continue
    await mkdir(path.dirname(target), { recursive: true })
    const url = `https://huggingface.co/${model.repo}/resolve/${model.revision}/${file}`
    const res = await fetchFile(url)
    if (!res.ok) throw new ModelFileMismatch(`${file}: HTTP ${res.status} from ${url}`)
    const partial = `${target}.partial`
    await Bun.write(partial, res)
    const got = await sha256Of(partial)
    if (got !== sha) {
      await rm(partial, { force: true })
      throw new ModelFileMismatch(`${file}: sha256 ${got}, expected ${sha}`)
    }
    await rename(partial, target)
  }
  return root
}

export async function loadLocalEmbedder(): Promise<TextEmbedder> {
  const dir = modelCacheDir()
  await ensureModelFiles(dir)
  const { pipeline, env } = await import("@huggingface/transformers")
  // Read the checked files only; never fetch or cache anything elsewhere.
  env.allowRemoteModels = false
  env.allowLocalModels = true
  env.localModelPath = dir
  env.cacheDir = dir
  env.useFSCache = false
  env.useBrowserCache = false
  const extract = await pipeline("feature-extraction", LOCAL_MODEL.repo, {
    dtype: LOCAL_MODEL.dtype,
  })
  return {
    id: `local:${LOCAL_MODEL.repo}@${LOCAL_MODEL.revision.slice(0, 7)}`,
    async embed(texts, kind) {
      const out = await extract(
        texts.map((t) => (kind === "query" ? LOCAL_MODEL.queryPrefix + t : t)),
        { pooling: "cls", normalize: true },
      )
      return out.tolist() as Vector[]
    },
  }
}
