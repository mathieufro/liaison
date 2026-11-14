// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The invoicing suite's in-memory DB mock: the shared bridge-shaped mock from
// @liaison/test-helpers/mock-db, bound to this app's manifest.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  createMockDb as createSharedMockDb,
  type ManifestSchema,
  type MockDb,
  type MockDbOptions,
} from "@liaison/test-helpers/mock-db"

export type { MockDb, MockDbOptions }

const MANIFEST_SCHEMA = (
  JSON.parse(readFileSync(join(import.meta.dir, "..", "app.manifest.json"), "utf8")) as {
    schema: ManifestSchema
  }
).schema

/** `bridgeWhereOperators`: read `{ in }` and `null` in a `where` as the bridge does. */
export function createMockDb(
  opts: MockDbOptions & { bridgeWhereOperators?: boolean } = {},
): MockDb {
  return createSharedMockDb(opts, {
    // Mirror prod (gen_random_uuid()): generated ids must be uuid-SHAPED, because
    // document lookups route uuid input to an id lookup and everything else to a
    // number lookup (reads.ts resolveDocumentRow): a `documents_17`-style
    // generated id would silently take the number path and never match.
    ids: "uuid",
    // The bridge (rpc-bridge.ts db_findMany) rejects an `orderBy` key that is
    // neither a kernel base column nor a field declared in the manifest, so a
    // handler that orders by an undeclared or snake_cased base column
    // (`created_at`) fails here, in a unit test, instead of on every prod event.
    orderByManifestSchema: MANIFEST_SCHEMA,
    bridgeWhereOperators: opts.bridgeWhereOperators === true,
  })
}
