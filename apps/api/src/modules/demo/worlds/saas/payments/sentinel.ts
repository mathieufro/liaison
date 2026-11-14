// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The constants that make a demo org's payments connection inert.
//
// The software world's money pages read a card-payments account through the
// payments app. A demo org must never hold a real key for it and must never
// put a request on the processor's wire, so:
//
//   * the seeder installs a connection whose key is the literal sentinel below,
//     a constant with no secret in it and no key shape (no `rk_`, `sk_` or
//     `whsec_` prefix): a leak of the demo database leaks nothing;
//   * every call the payments app makes for a demo org is answered in-process
//     by the stand-in (provider.ts) or refused, never forwarded;
//   * the hosts are the ones the app itself declares (its connection's
//     `allowedDomains`), never a literal here.
//
// Customer-facing links of a stand-in install (the billing portal login, the
// hosted invoice pages) live on a reserved `.example` host, so nobody is ever
// sent to a real billing page that does not know the fictional customer.

/** The payments app, and its one connection, by the name the app declares. */
export const PAYMENTS_APP = "stripe"
export const PAYMENTS_CONNECTION = "stripe"
export const DEMO_PAYMENTS_IDENTIFIER = "demo-payments"

/** The stand-in for the restricted key. Not a credential, and recognisably not one. */
export const DEMO_PAYMENTS_SENTINEL_KEY = "liaison-demo-fixture-not-a-processor-key"

/** The host every customer-facing link of a stand-in install points at. */
export const PAYMENTS_STANDIN_HOST = "billing.payments-standin.example"

/**
 * The field of the app's `install_metadata.permissions` JSON that marks a
 * stand-in install. Written by the demo seeder only (no route, no tool); the
 * payments app reads it to accept stand-in links and to hide its links out to
 * the processor's dashboard. The app holds the same constant
 * (`bundled-apps/stripe/src/standin.ts`); a test keeps the two equal.
 */
const PAYMENTS_STANDIN_MARKER = "demoStandIn"

/** The `permissions` value the seeder writes on a stand-in install's metadata row. */
export function standInInstallPermissions(checkedAt: string): Record<string, unknown> {
  return { mode: "test", checks: [], checkedAt, [PAYMENTS_STANDIN_MARKER]: true }
}

/** The hosted page of a stand-in invoice (the mirror's `hosted_invoice_url`). */
export function standInHostedInvoiceUrl(invoiceId: string): string {
  return `https://${PAYMENTS_STANDIN_HOST}/i/${invoiceId.replace(/[^A-Za-z0-9_-]/g, "")}`
}

/**
 * The processor's API hosts (the payments app's `allowedDomains`). A demo org's
 * call to one of them is the stand-in's whatever app makes it: a connector
 * holding a real key reaches the processor exactly as the payments app would.
 */
export const PAYMENTS_HOSTS: readonly string[] = ["api.stripe.com"]

/** Is `host` one of the processor's API hosts? */
export function isPaymentsHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "")
  return PAYMENTS_HOSTS.includes(h)
}

/** Is `host` one the payments app declared for its connection? */
export function isDeclaredPaymentsHost(host: string, allowedDomains: readonly string[]): boolean {
  const h = host.toLowerCase()
  return allowedDomains.some((d) => d.toLowerCase() === h)
}

/** A string shaped like a processor key or signing secret (never allowed in a fixture). */
export const KEY_SHAPED =
  /(?<![A-Za-z0-9])(?:rk|sk|pk)_(?:live|test)_[A-Za-z0-9]{6,}|whsec_[A-Za-z0-9]{6,}/
