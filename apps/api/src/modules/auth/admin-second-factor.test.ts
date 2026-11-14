// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The second-factor rule's own list of kernel administrative scopes backs the check when the scope
// catalog is cold, so a parent grant (`kernel:portal`) is read as administrative even then. Every
// kernel scope whose action is `admin` is on it.
import { describe, expect, it } from "bun:test"
import { KERNEL_SCOPES } from "~/modules/permissions/scope-catalog"
import { KERNEL_ADMIN_SCOPES } from "./admin-scopes"

describe("the second factor's kernel administrative scopes", () => {
  it("lists every kernel scope whose action is admin, the portal's included", () => {
    const kernelAdmin = KERNEL_SCOPES.map((e) => e.scope).filter((s) => s.endsWith(":admin"))
    expect(kernelAdmin).toContain("kernel:portal:admin")
    expect(kernelAdmin.filter((s) => !KERNEL_ADMIN_SCOPES.includes(s))).toEqual([])
  })
})
