// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Records the invoicing app's contract fixture for project_invoiced_get
// (fixtures/invoicing/tool__project_invoiced_get.json): a project's issued invoice and the
// credit note that corrects it, read back net. The read touches the app's own tables only. Not
// part of any suite run (it skips unless CONTRACT_RECORD=1): run it by path when the tool's
// bridge calls change, read what it wrote, commit it.
//
//   (cd apps/api && set -a && source ../../.env.test && set +a && CONTRACT_RECORD=1 \
//     bun run ../../scripts/with-test-lock.ts -- \
//     bun test ./src/modules/apps/contract/record-invoicing-project.recorder.test.ts)
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { join } from "node:path"
import { sql } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import { insertAppRow } from "~/seed/factories/app-tables"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  installForRecording,
  type RecordingState,
  type RecordingStep,
  runRecordingPlan,
  uninstallAfterRecording,
} from "./recording-run.test-helpers"
import { CONTRACT_ORG_ID } from "./replay-bridge"

const APP = "invoicing"
const PROJECT = "7a000000-0000-4000-8000-00000000c0de"
const ISSUER = "7b000000-0000-4000-8000-00000000c0de"
const INVOICE = "7d000000-0000-4000-8000-000000000001"
const CREDIT = "7d000000-0000-4000-8000-000000000002"

const PLAN: RecordingStep[] = [
  {
    entry: "tool:project_invoiced_get",
    before: async () => {
      await withPrivilegedDb(CONTRACT_ORG_ID, "contract-recording", async (tx) => {
        await insertAppRow(tx, APP, "issuer_profiles", {
          id: ISSUER,
          org_id: CONTRACT_ORG_ID,
          legal_name: "Contract Issuer SAS",
          country: "FR",
          vat_id: "FR60902000009",
          address: "2 rue Test, 75001 Paris",
          default_currency: "EUR",
          default_language: "fr",
        })
        const base = {
          org_id: CONTRACT_ORG_ID,
          issuer_profile_id: ISSUER,
          payment_status: "unpaid",
          currency: "EUR",
          tax_total_minor: "0",
        }
        await insertAppRow(tx, APP, "documents", {
          ...base,
          id: INVOICE,
          type: "invoice",
          status: "issued",
          number: "F-2026-0001",
          subtotal_minor: "1400000",
          grand_total_minor: "1400000",
          issued_at: "2026-07-02",
          billing_project_id: PROJECT,
        })
        await insertAppRow(tx, APP, "documents", {
          ...base,
          id: CREDIT,
          type: "credit_note",
          status: "issued",
          number: "A-2026-0001",
          subtotal_minor: "-200000",
          grand_total_minor: "-200000",
          issued_at: "2026-07-10",
          original_document_id: INVOICE,
        })
      })
    },
    input: () => ({ params: { projectId: PROJECT } }),
  },
]

describe.skipIf(process.env.CONTRACT_RECORD !== "1")("record invoicing project fixtures", () => {
  let installed: Awaited<ReturnType<typeof installForRecording>>

  beforeAll(async () => {
    await acquireTestLock()
    installed = await installForRecording(APP, {})
    await sql`DELETE FROM app_invoicing.documents WHERE org_id = ${CONTRACT_ORG_ID} AND id IN (${INVOICE}, ${CREDIT})`
    await sql`DELETE FROM app_invoicing.issuer_profiles WHERE org_id = ${CONTRACT_ORG_ID} AND id = ${ISSUER}`
  }, 300_000)

  afterAll(async () => {
    await uninstallAfterRecording(APP)
    await releaseTestLock()
  })

  it("records every planned entry", async () => {
    const report = await runRecordingPlan({
      app: APP,
      manifest: installed.manifest,
      bridgeManifest: installed.bridgeManifest,
      plan: PLAN,
      state: { values: {} } satisfies RecordingState,
      replacements: [],
      secrets: [],
      recordedFrom: "the contract org on a local stack, record-invoicing-project.recorder.test.ts",
      fixturesDir: join(import.meta.dir, "fixtures"),
      appConfig: {},
    })
    console.log(`\n${report.join("\n")}\n`)
    expect(report.filter((l) => !l.startsWith("ok "))).toEqual([])
  }, 600_000)
})
