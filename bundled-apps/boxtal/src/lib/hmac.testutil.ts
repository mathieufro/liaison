// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Unit-test HMAC helper, bound to the boxtal secret key. Pure node:crypto path
// (@liaison/test-helpers/webhook-hmac) imported only from tests, so the
// `node:crypto` import never reaches the sandbox bundle.
import { type HmacTestBridge, hmacBase64, hmacHex, makeHmacTestBridge } from "@liaison/test-helpers/webhook-hmac"

export { hmacBase64, hmacHex }

/**
 * A bridge stub that mirrors the host `crypto_*` + `config_*` surface,
 * including the by-key methods the verifier uses. Boxtal reads no other config
 * key, so every other key is null.
 */
export function makeTestBridge(
  secret: string | null,
  { withHex = true }: { withHex?: boolean } = {},
): HmacTestBridge {
  return makeHmacTestBridge({ secretKey: "boxtalWebhookSecret", secret, withHex })
}
