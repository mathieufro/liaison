// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A fake `ctx` for the app's unit tests: a GitHub answering from a route table
// (`"<path or URL>" -> answer`), the connection's readable settings, and a
// record of every ctx.fetch call with the method and auth it named.

import type { FetchAnswer, GithubCtx } from "./client"

export interface FakeCall {
  url: string
  method?: string
  auth?: unknown
  headers?: Record<string, string>
}

export type Route = FetchAnswer | ((url: string) => FetchAnswer)

export function json(
  body: unknown,
  headers: Record<string, string> = {},
  status = 200,
): FetchAnswer {
  return {
    status,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }
}

export function base64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

export interface FakeOptions {
  routes?: Record<string, Route>
  /** The connection's settings answer; default: connected to owner "maison-example". */
  settings?: { values: Record<string, string>; missing: string[] } | "throws"
}

const API = "https://api.github.com"

export function fakeCtx(opts: FakeOptions = {}) {
  const calls: FakeCall[] = []
  const routes = opts.routes ?? {}
  const settings = opts.settings ?? { values: { owner: "maison-example" }, missing: [] }
  const ctx = {
    calls,
    async fetch(
      url: string,
      init?: { method?: string; headers?: Record<string, string>; auth?: unknown },
    ) {
      calls.push({ url, method: init?.method, auth: init?.auth, headers: init?.headers })
      const parsed = new URL(url)
      const key = parsed.origin === API ? `${parsed.pathname}${parsed.search}` : url
      const route = routes[key] ?? routes[url]
      if (!route) return json({ message: `no fake route for ${key}` }, {}, 404)
      return typeof route === "function" ? route(url) : route
    },
    connections: {
      async getSettings(name: string) {
        if (name !== "github") throw new Error(`unknown connection ${name}`)
        if (settings === "throws") throw new Error("No connected account")
        return JSON.stringify(settings)
      },
    },
  }
  return ctx
}

export const asCtx = (ctx: ReturnType<typeof fakeCtx>): GithubCtx => ctx as unknown as GithubCtx
