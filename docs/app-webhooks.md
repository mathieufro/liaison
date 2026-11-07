# App Webhooks: verifier contract

Manifest-driven apps that accept external webhooks declare two bundle exports per webhook entry:

```json
{
  "webhooks": {
    "orders-create": {
      "handler": "ordersCreateHandler",
      "verify": "hmacSha256Verifier",
      "bodyLimitBytes": 5242880
    }
  }
}
```

Webhook keys must match `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`: lowercase alphanumerics and hyphens only, no slashes.

A handler that makes several provider calls can declare a budget, `timeoutMs` (1000 to 29000), next to `bodyLimitBytes`. Its run is stopped at that budget, on the delivery and on the retry alike. `LIAISON_SANDBOX_MAX_TOOL_TIMEOUT_MS` caps it, as it caps a tool's. Without one the handler has the sandbox default (5 s in production). A delivery with a budget waits for a free slot on the background connections first, within what the budget leaves of `REQUEST_TIMEOUT_MS`; if none frees up, it is answered `500` and goes to the retry job, unrun.

## Verifier signature

```ts
// From the app bundle.
export const hmacSha256Verifier = (
  request: { headers: Record<string, string>; body: string; method: string; query: Record<string, string> },
) =>
  | { ok: true; replayKey: string; replayTtlSeconds?: number; scopes?: string[] }
  | { ok: false; status: number; retryAfterSeconds?: number }
  | { drop: true; status: number }
```

(`valid` is accepted as a synonym for `ok` in both the accept and reject shapes; the two are equivalent.)

Return shapes:

- `{ ok: true, replayKey, replayTtlSeconds?, scopes? }`: accept. `replayKey` is required (a non-empty string) and is hashed and put behind a Redis `SETNX` keyed by org, app, and endpoint for replay protection; `scopes` is the scope set the handler runs with.
- `{ ok: false, status, retryAfterSeconds? }`: reject. `status` is clamped into the 400 to 599 range and echoed to the caller; `retryAfterSeconds`, if present, becomes a `retry-after` header.
- `{ drop: true, status }`: silent acknowledge. The delivery is discarded but the response status (typically a 2xx) is sent as-is, telling the provider the delivery succeeded so it stops retrying.
- Anything else, including a bare `true` or `false`, a thrown error, or an object missing `replayKey` on accept, is treated as verification failure.

## Signing secrets

A verifier reads its signing secret with `config_get(<key>)`. When the key is a connection's `clientSecretConfigKey` (a provider that signs webhooks with the app's OAuth client secret, such as Shopify), the kernel answers with the connection's current client secret: the workspace's own client, else the client the instance provides for every workspace (`modules/apps/connections/oauth-client.ts`). With no client at all, it answers with the copy stored in the app's config when the account connected. Every other key is read from the app's config.

A verifier should not read the secret itself: `config_has(<key>)` says whether it is set, and `crypto_verifyHmacForConfig(<key>, body, signature, "base64" | "hex")` checks a signature with it on the host, in constant time (`modules/webhooks/verify-bridge.ts`). On the Workers executor, `config_get` of a declared secret key is refused.

## Runtime sequence

The kernel runs, in strict order:

1. Body-size check (default 1 MiB; override via `bodyLimitBytes` in the manifest, range 1 KiB to 10 MiB).
2. `verify(request)` resolved against the built bundle's named export (sandboxed for installed apps; in-process for in-tree trusted apps).
3. On an unrecognized return value or a thrown error: HTTP 401, no handler invoked.
4. On accept: replay-protection lookup; if first delivery, the topic handler runs under the same bundle. On reject or drop, the verifier's own status (and, for reject, `retry-after`) is returned instead of running the handler.

Before step 1, a delivery under an org that may not see the app (another organization's custom app, managed instances) is answered `404`, like an unknown endpoint. A delivery to an organization's custom app past its budget (120 a minute per organization and app, managed instances) is answered `429` with `Retry-After` and code `custom_app_rate_limited`, before its `verify` runs. A delivery for an org whose app is Off, an org being deleted, or (managed instances) an org suspended or closed for billing is answered `200` with `{ "ok": true, "dropped": "<code>" }` and no handler runs, so the provider keeps the subscription. A suspended org's deliveries are not replayed after it resumes. While an organization is being moved to another server, its deliveries are answered `503` with `Retry-After` and code `org_moving`, and no handler runs: providers that retry deliver again once the move is over.

## Server-level callbacks (managed edition)

A managed server also answers two callbacks of its own, one per provider for the whole server; a self-hosted server answers neither (404):

- `POST /webhooks/_cell/gmail-push`: the push subscription of the server's Gmail topic (`GMAIL_PUBSUB_TOPIC`). The kernel checks the Google OIDC token against `GMAIL_PUSH_AUDIENCE` and `GMAIL_PUSH_SERVICE_ACCOUNT`, reads the mailbox address from the message, and passes the original request to `/webhooks/<org>/<app>/gmail-push` of every org whose Mail or Tickets Gmail connection holds that address; each app's verifier checks it again, with the same values as instance config (`gmailPushAudience`, `gmailPushServiceAccount`). An address no org holds answers `204`.
- `POST /webhooks/_cell/meta` (and its `hub.challenge` GET): the callback of the server's Meta app. The kernel checks `X-Hub-Signature-256` with `META_APP_SECRET`, splits `entry[]` by Page id, and runs each org's Social `meta` handler with only its own entries, from step 4 on (replay protection keyed per org). An org counts for a Page only while the Facebook account that recorded it is still connected with a working token; the Social app also checks the Page against Meta's list of the account's Pages before it ingests anything (see [Social](apps/social.md)).

A suspended or closed org is skipped by both.

## Webhook health

An app that declares webhooks also declares how the kernel can tell its stream stopped, as `webhookHealth` in the manifest:

- `{ "probe": "<scheduled job>" }`: the job reports the newest change the sender knows about (`{ "upstreamActivityAt": "<ISO time>" }`, or `null` when there is none). A change newer than the last accepted delivery, and older than the delivery grace, is reported as a missed delivery.
- `{ "probe": null, "reason": "<why>" }`: no upstream can be asked; the app is judged by refused deliveries only.

The delivery grace is 30 minutes (`WEBHOOK_DELIVERY_GRACE_SEC`). A sender that delivers well after the change it reports sets its own with `deliveryGraceSec`, in seconds (60 to 86400, only next to a probe):

```json
{ "webhookHealth": { "probe": "probe-webhook-upstream", "deliveryGraceSec": 10800 } }
```

## Freeze-time enforcement

`bun run app:freeze <app>` parses the in-tree manifest, builds the bundle, then asserts that every `webhooks[*].handler` AND `webhooks[*].verify` export name actually appears in the built bundle. A missing export aborts freeze with:

```
webhook 'orders-create': verify export 'hmacSha256Verifier' not found in built bundle
```

This catches typos, deleted exports, and rename-without-rebuild mistakes before a broken `.liaisonapp` is published.

## Why both checks?

A missing handler would 500 at first delivery; a missing verifier would silently reject every webhook with 401. Either way, an installed app is broken on day one. The freeze guard makes the failure observable at build time instead of at runtime: it was added after a bundled app shipped with a missing `verify` export, which meant every webhook call to that endpoint failed with a 401 instead of ever reaching the handler.
