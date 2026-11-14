// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Where a commercial mail's opt-out link points (`<public origin>/public/opt-out/<token>`).
 * One constant for the link the footer mints, the API route that answers it, and
 * the server's list of paths the web app never takes (lib/server.ts), so a GET of
 * the link always reaches the API's page. No imports: the server loads it early.
 */
export const OPT_OUT_PATH = "/public/opt-out"
