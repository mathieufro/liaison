// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Test support for the demo seeders: install catalog apps the way a demo box
// has them, from the tarball the CURRENT source builds to
// (`bash scripts/build-bundled-app.sh <app>` writes it under the app's `dist/`).
import { readFileSync } from "node:fs"
import path from "node:path"
import { installAppFromTarball } from "~/modules/apps/install-service"
import { ensureBundledAppBuilt } from "~/tests/helpers/bundled-app-build"
import { bakeIntoTestCatalog } from "~/tests/helpers/test-app-catalog"

const ROOT = path.join(import.meta.dir, "..", "..", "..", "..")

/**
 * Install one bundled app from its `dist/` tarball, not from the baked
 * `app-catalog/` artifact. The baked catalog is a release snapshot that lags
 * the tree, and a stale app there (a boxtal with no `prep_meta` table) fails
 * reads for a reason that has nothing to do with the seed. A missing tarball
 * is built from the current source first, never skipped.
 */
export async function installFromDist(name: string, installedBy: string): Promise<void> {
  const manifestPath = path.join(ROOT, "bundled-apps", name, "app.manifest.json")
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    version: string
    scopes?: string[]
    connections?: Record<string, unknown>
  }
  // Built here when absent, never left to whichever test happened to build it
  // first: a file that ran before any such test found no tarball and failed.
  const tarballPath = ensureBundledAppBuilt(name)
  await installAppFromTarball({
    // Baked into the test catalog, as on a demo box: the first-party app, not an outside one.
    tarballPath: bakeIntoTestCatalog(tarballPath),
    installedBy,
    grantedScopes: manifest.scopes ?? [],
    grantedConnections: Object.keys(manifest.connections ?? {}),
    requireSignature: false,
    sourceUrl: `dist:${name}@${manifest.version}`,
  })
}
