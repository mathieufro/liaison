// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `connection_check` (agent-visible, admins) and `settings_load` (the settings
// page's read, hidden from the agent). Neither ever sees the key.
import {
  type ConnectionCtx,
  decodeState,
  readInstall,
  runConnectionCheck,
  storedPermissions,
} from "../connection"

export const connectionCheck = (_params: Record<string, never>, ctx: ConnectionCtx) =>
  runConnectionCheck(ctx)

/** The kernel's check of a key before it is stored (`checkBeforeStore`): same answers, records nothing. */
export const connectionPrecheck = (_params: Record<string, never>, ctx: ConnectionCtx) =>
  runConnectionCheck(ctx, { dryRun: true })

export async function settingsLoad(_params: Record<string, never>, ctx: ConnectionCtx) {
  const install = await readInstall(ctx.db)
  const permissions = storedPermissions(install)
  const state = decodeState(install?.state)
  return {
    state: state.overlay ? `${state.base}+${state.overlay}` : state.base,
    mode: permissions?.mode ?? null,
    permissions: permissions?.checks ?? [],
    checkedAt: permissions?.checkedAt ?? null,
  }
}
