// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A connection's check of a key BEFORE it is kept. A credentials connection
// may declare `checkBeforeStore: "<tool>"`: before the credentials route stores
// (and so replaces) a key, it runs that read-only tool of the app with the
// candidate key in place of the stored one. A refusal (a key the provider
// rejects, a key of another account or of the other mode) stops the save, so
// the key already stored stays the one every sync uses. The candidate reaches
// only this one run's outbound requests, host side.
import type { UserContext } from "~/db/rls"
import { connectionConfigRegistry } from "~/modules/apps/app-registries"
import {
  assertCredentialsAccepted,
  CredentialRefusedError,
} from "~/modules/apps/connections/service"
import { executeTool } from "~/modules/apps/execute-tool"

export async function precheckCredentials(input: {
  actor: UserContext
  appName: string
  connectionName: string
  credentials: Record<string, string>
}): Promise<void> {
  const { actor, appName, connectionName, credentials } = input
  const config = connectionConfigRegistry.get([actor.orgId, appName, connectionName])
  // A value of the wrong kind never leaves the server, not even for the check.
  assertCredentialsAccepted(config, credentials)
  const tool = config?.checkBeforeStore
  if (!tool) return
  try {
    await executeTool({
      toolName: `${appName}:${tool}`,
      orgId: actor.orgId,
      actor,
      params: {},
      origin: "system",
      candidateCredentials: { connection: connectionName, values: credentials },
    })
  } catch (err) {
    const e = err as Error & { code?: string; status?: number }
    // The app's own refusal (a 4xx with its code): the key is not kept.
    if (typeof e.code === "string" && typeof e.status === "number" && e.status < 500) {
      throw new CredentialRefusedError(e.code, connectionName, e.message)
    }
    throw err
  }
}
