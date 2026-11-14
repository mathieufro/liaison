// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * What the Vite dev and preview servers forward to the API. In production one
 * origin serves the app and the API, so every URL the server prints from
 * `BASE_URL` (an API ticket inbox's ingest URL under `/webhooks`, which
 * `liaison tickets inbox create` and the inbox settings show) works as is; on a
 * dev checkout `BASE_URL` is this web server, so each of those prefixes must
 * be proxied here or the printed URL answers 404.
 */
export function devProxyFor(apiTarget: string, opts: { preserveHost?: boolean } = {}) {
  // `preserveHost` forwards the page's own Host, so this web server is the
  // host the API sees, as one origin serving both is in production: a server
  // with org hosts (LIAISON_ORG_HOST_TEMPLATE) binds each session to it. The
  // managed-edition browser tests set it (VITE_PROXY_PRESERVE_HOST=1).
  const changeOrigin = !opts.preserveHost
  // A frame host (`<app>--<org>.localhost:<port>`, LIAISON_APP_FRAME_ORIGIN_TEMPLATE) is
  // served by the API itself on its own port in development, never through this proxy:
  // its one path is `/frame/<version>`, which the API answers only on that host.
  return {
    "/api": { target: apiTarget, changeOrigin },
    "/healthz": { target: apiTarget, changeOrigin },
    "/webhooks": { target: apiTarget, changeOrigin },
    // A commercial mail's opt-out link, printed from BASE_URL.
    "/public/opt-out": { target: apiTarget, changeOrigin },
    "/ws": { target: apiTarget, ws: true },
  }
}
