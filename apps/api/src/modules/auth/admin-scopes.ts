// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The scopes that make their holder an administrator, read by the second-factor
// rule (admin-second-factor.ts) and by the role agent ceiling guard
// (agent/directory/ceiling-guard.ts), so the two cannot drift apart.
import { hasScope } from "~/modules/permissions/permissions"

/** Kernel administrative scopes, checked even when the catalog is cold. */
export const KERNEL_ADMIN_SCOPES = [
  "kernel:org:admin",
  "kernel:users:admin",
  "kernel:portal:admin",
  "kernel:dashboards:admin",
  "kernel:roles:admin",
  "kernel:apps:admin",
  "kernel:agents:admin",
  "kernel:policies:admin",
  "kernel:threads:admin",
  "kernel:approvals:admin",
  "kernel:scope_requests:admin",
  "kernel:contacts:admin",
  "kernel:saved_views:admin",
]

/**
 * Whether one granted entry makes its holder an administrator whatever the
 * org's installed apps declare: `*`, any scope whose action is `admin`, or a
 * parent of a kernel administrative scope (`kernel`, `kernel:*`,
 * `kernel:users:*`). The second-factor rule adds the `…:admin` scopes the org's
 * apps declare on top of this.
 */
export function isKernelAdminEntry(entry: string): boolean {
  if (entry === "*" || entry.split(":").at(-1) === "admin") return true
  return KERNEL_ADMIN_SCOPES.some((adminScope) => hasScope(adminScope, [entry]))
}
