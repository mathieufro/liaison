// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The stand-in wired to its production stores: the org's mirror in Postgres,
// the outside state in Redis, deliveries to the app's own handler. Loaded by a
// dynamic import from provider.ts, only for a demo org's payments request.
import { randomBytes } from "node:crypto"
import type { ShippedLocale } from "@liaison/shared"
import { DemoRestrictionError, demoRestrictionMessage } from "~/modules/demo/demo-egress"
import { answerStandIn, type OutsideStore, type StandInDeps } from "./answer"
import { scheduleDemoPaymentsEvent } from "./deliver"
import { dbMirrorSource, type MirrorSource } from "./mirror-source"
import {
  idempotentResult,
  type OutsideKind,
  outsideObject,
  outsideObjectsOf,
  putOutsideObjects,
  rememberIdempotentResult,
} from "./overlay"

/** The Redis-backed outside state of one org. */
export function redisOutsideStore(orgId: string): OutsideStore {
  return {
    get: (id) => outsideObject(orgId, id),
    ofKind: (kind) => outsideObjectsOf(orgId, kind as OutsideKind),
    put: (objects) => putOutsideObjects(orgId, objects),
    idempotent: (key) => idempotentResult(orgId, key),
    remember: (key, id) => rememberIdempotentResult(orgId, key, id),
  }
}

let mirrorFor: (orgId: string) => MirrorSource = dbMirrorSource

export function standInDeps(orgId: string, locale: ShippedLocale): StandInDeps {
  return {
    mirror: mirrorFor(orgId),
    outside: redisOutsideStore(orgId),
    deliver: (type, object) => scheduleDemoPaymentsEvent(orgId, type, object),
    refuse: (what) =>
      new DemoRestrictionError(
        demoRestrictionMessage("payments_unsupported", locale, { what }),
        "payments_unsupported",
      ),
    now: () => new Date(),
    newId: (prefix) => `${prefix}_${randomBytes(12).toString("hex")}`,
  }
}

export async function answerDemoPayments(opts: {
  orgId: string
  url: URL
  method: string
  body: string | undefined
  idempotencyKey: string | null
  locale: ShippedLocale
}): Promise<Response> {
  return answerStandIn(
    { method: opts.method, url: opts.url, body: opts.body, idempotencyKey: opts.idempotencyKey },
    standInDeps(opts.orgId, opts.locale),
  )
}

/** Test access to the mirror seam. Production code never calls it. */
export const DemoPaymentsStandInTestAccess = {
  /** Read the mirror from `fn`; pass nothing to restore the Postgres reader. */
  setMirror(fn?: (orgId: string) => MirrorSource): void {
    mirrorFor = fn ?? dbMirrorSource
  },
}
