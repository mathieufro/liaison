// SPDX-License-Identifier: FSL-1.1-ALv2
import { env } from "~/lib/env"

/**
 * The instance edition — the clean frontier between self-hosted and managed.
 *
 * - `managed`     — the multi-tenant managed edition, switched on by
 *                   `LIAISON_EDITION=managed` (validated at server boot,
 *                   lib/managed-boot.ts). Credit metering, balance deduction,
 *                   and tier gating are live.
 * - `self_hosted` — BYOK-only: agent usage is recorded for monitoring but is
 *                   NEVER metered, deducted, or balance-gated.
 *
 * Only `LIAISON_EDITION=managed` switches managed on, so the managed boot
 * checks always run for a managed server (lib/managed-boot.ts). The legacy
 * control-plane pair (`CONTROL_PLANE_URL` + `CONTROL_PLANE_API_KEY`) alone no
 * longer does: such a server boots self-hosted with a warning (`legacyControlPlaneBootProblem`).
 */
export type Edition = "self_hosted" | "managed"

/** The edition these settings select. Pure: the caller passes the values. */
export function detectEdition(e: {
  LIAISON_EDITION?: string
  /** Read by older releases; none of these select the edition now. */
  NODE_ENV?: string
  CONTROL_PLANE_URL?: string
  CONTROL_PLANE_API_KEY?: string
}): Edition {
  return e.LIAISON_EDITION === "managed" ? "managed" : "self_hosted"
}

let override: Edition | null = null

/** The resolved instance edition. */
export function edition(): Edition {
  return override ?? detectEdition(env)
}

/** True in the managed edition — the only mode in which credits exist and agent
 *  usage is metered and deducted. */
export function isManagedEdition(): boolean {
  return edition() === "managed"
}

/**
 * Whether organisations may have their own custom apps: install one by URL
 * for themselves, or build one with the app builder. `LIAISON_CUSTOM_APPS`
 * (`on` | `off`) decides; unset, it follows the edition (on when managed, off
 * when self-hosted), so a self-hosted server with public sign-up never runs
 * apps its operator did not choose. Instance installs by the operator, and
 * custom apps already installed, are never affected.
 */
export function customAppsEnabled(): boolean {
  const v = env.LIAISON_CUSTOM_APPS
  if (v === "on") return true
  if (v === "off") return false
  return isManagedEdition()
}

/**
 * Whether tool search ranks by meaning as well as by words. The local
 * embedding model runs in one shared embedding process per host (about
 * 1.1 GB loaded, 1.4 GB at peak), which the API processes ask over a Unix
 * socket; it adds nothing to each API process. `LIAISON_TOOL_MEANING`
 * (`on` | `off`) decides; unset, it follows the edition (on when managed, off
 * when self-hosted), so a small self-hosted server never runs the embedding
 * process unless its operator turns it on. Keyword ranking is the fallback
 * either way, and while the embedding process is down or slow.
 */
export function toolMeaningEnabled(): boolean {
  const v = env.LIAISON_TOOL_MEANING
  if (v === "on") return true
  if (v === "off") return false
  return isManagedEdition()
}

/** Test helper — force the edition. Pass `null` to restore env detection. */
export function _setEdition(mode: Edition | null): void {
  override = mode
}
