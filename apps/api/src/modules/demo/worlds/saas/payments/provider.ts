// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The interception point: a demo org's card-payments traffic never leaves the box.
//
// The sandbox fetch bridge (`ctx.fetch`, file imports and bulk downloads) calls
// `maybeDemoPaymentsResponse` once per outbound call, after the store and
// carrier stand-ins. The stand-in itself is behind a dynamic import.
//
// Gate one, the request: a call to the processor's API host from ANY app (the
// payments app, an API connector, anything whose install declares the host),
// a host the payments app's own connection declares, or a request carrying the
// stand-in's sentinel key (that connection holds no real key and must never
// reach the processor). Anything else returns null before any read: on a
// normal deployment the cost is a string compare per header and one URL parse.
//
// Gate two, the org: an org without the demo marker is not a demo org, so its
// call is forwarded exactly as before, on every box (a sentinel request from
// such an org is refused, never forwarded). A demo-marked org's call is the
// stand-in's on every box, whether or not demo mode or
// `LIAISON_DEMO_PAYMENTS_FIXTURES` is on: a self-hosted demo seed or a walk box
// holds demo orgs too.
//
// For a demo org past both, the processor is a closed door: the stand-in
// answers or refuses. A demo org whose request carries anything but the
// sentinel (a real key, a connector's own credential) is refused with the
// connector sentence and its key is never used.
import { DemoRestrictionError, demoRestrictionMessage } from "~/modules/demo/demo-egress"
import { loadDemoOrg } from "~/modules/demo/demo-org"
import { fixtureConnectionOf, fixtureRefusal } from "~/modules/demo/fixture-credential"
import { isDeclaredPaymentsHost, isPaymentsHost, PAYMENTS_APP } from "./sentinel"

export interface DemoPaymentsRequest {
  orgId: string
  /** The calling app. */
  appName: string
  /** The hosts the calling app's install may reach (its manifest's `allowedDomains`). */
  allowedDomains: readonly string[]
  url: string
  method: string
  body: string | undefined
  /** The request's headers, credential included (injected by the host). */
  headers?: Record<string, string>
}

function idempotencyKeyOf(headers: Record<string, string> | undefined): string | null {
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (k.toLowerCase() === "idempotency-key" && typeof v === "string" && v) return v
  }
  return null
}

/**
 * The stand-in's answer to this request, or null when this box, this request
 * or this org is none of the stand-in's business. Throws `DemoRestrictionError`
 * for a refusal a demo org reads.
 */
export async function maybeDemoPaymentsResponse(
  request: DemoPaymentsRequest,
): Promise<Response | null> {
  // Gate one: the request.
  const fixture = fixtureConnectionOf(request.url, request.headers) === PAYMENTS_APP
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return null
  }
  const paymentsHost =
    isPaymentsHost(url.hostname) ||
    (request.appName === PAYMENTS_APP &&
      isDeclaredPaymentsHost(url.hostname, request.allowedDomains))
  if (!paymentsHost && !fixture) return null

  // Gate two: the org.
  const { marker, locale } = await loadDemoOrg(request.orgId)
  if (!marker) return fixture ? fixtureRefusal(PAYMENTS_APP) : null

  // A demo org's connection carries the sentinel and nothing else: anything
  // else is a real key, refused and never sent.
  if (!fixture) {
    throw new DemoRestrictionError(
      demoRestrictionMessage("connector_credentials", locale),
      "connector_credentials",
    )
  }
  const { answerDemoPayments } = await import("./standin")
  return answerDemoPayments({
    orgId: request.orgId,
    url,
    method: request.method,
    body: request.body,
    idempotencyKey: idempotencyKeyOf(request.headers),
    locale,
  })
}
