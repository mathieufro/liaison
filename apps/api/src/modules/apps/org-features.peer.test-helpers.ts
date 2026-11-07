// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A second process for app-features.test.ts: it primes the org once, subscribes to
// the org-apps invalidation and never primes again, so the only way it can learn of
// a feature flip is the Redis channel. Prints one line per state it sees.
import { initOrgAppsInvalidation, isFeatureOffForTool, primeOrgApps } from "~/modules/apps/org-apps"

const [orgId, appName, feature] = process.argv.slice(2) as [string, string, string]
const tool = { appName, feature }

await initOrgAppsInvalidation()
await primeOrgApps(orgId)
console.log(isFeatureOffForTool(orgId, tool) ? "off" : "on")

const deadline = Date.now() + 15_000
while (Date.now() < deadline && isFeatureOffForTool(orgId, tool)) {
  await new Promise((resolve) => setTimeout(resolve, 25))
}
console.log(isFeatureOffForTool(orgId, tool) ? "still-off" : "on")
process.exit(0)
