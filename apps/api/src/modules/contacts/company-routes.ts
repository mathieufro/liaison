// SPDX-License-Identifier: FSL-1.1-ALv2
//
// /api/contacts/companies: companies under the caller's RLS. Mounted inside
// the contacts router before its "/:id" routes, so "companies" is never read
// as a contact id. Reading needs kernel:companies:read, every change
// kernel:companies:write (on top of the contacts mount's own check). A company
// the caller cannot see answers 404, never 403.

import { resourceSharingSchema } from "@liaison/shared"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { extractRlsContext, withRequestRls } from "~/lib/request-rls"
import { paginated, success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { idParam } from "~/lib/validators"
import { requireScope } from "~/middleware/require-scope"
import {
  ACTIVITY_DEADLINE_MS,
  activityQuerySchema,
  readActivity,
} from "~/modules/contacts/activity"
import {
  COMPANY_LINK_BATCH_MAX,
  COMPANY_NAME_MAX,
  companyWaitingApprovalIds,
  createCompany,
  deleteCompany,
  getCompany,
  getCompanySharing,
  linkContactsToCompany,
  listCompanies,
  setCompanySharing,
  similarCompanies,
  unlinkContactsFromCompany,
  updateCompany,
} from "~/modules/contacts/companies"
import { openCompanyDiscussion } from "~/modules/contacts/discussion"

const tagsSchema = z.array(z.string().max(100)).max(50)

const createSchema = z.object({
  name: z.string().min(1).max(COMPANY_NAME_MAX),
  domain: z.string().max(300).nullish(),
  description: z.string().max(2000).nullish(),
  tags: tagsSchema.optional(),
})

const patchSchema = z
  .object({
    name: z.string().min(1).max(COMPANY_NAME_MAX).optional(),
    domain: z.string().max(300).nullable().optional(),
    description: z.string().max(2000).nullable().optional(),
    tags: tagsSchema.optional(),
    closed: z.boolean().optional(),
  })
  .strict()

const peopleSchema = z.object({
  contactIds: z.array(z.string().uuid()).min(1).max(COMPANY_LINK_BATCH_MAX),
})

export const companyRoutes = new Hono<AppEnv>()

companyRoutes.use(
  "*",
  requireScope({ GET: "kernel:companies:read", "*": "kernel:companies:write" }),
)

companyRoutes.get("/", async (c) => {
  const orgId = c.get("orgId")
  const page = Math.max(1, Math.floor(Number(c.req.query("page") ?? 1)) || 1)
  const limit = Math.min(Math.max(1, Math.floor(Number(c.req.query("limit") ?? 50)) || 50), 100)
  const query = c.req.query("query")?.slice(0, 200) || undefined
  const { rows, total } = await withRequestRls(c, (tx) =>
    listCompanies(tx, { orgId, page, limit, query }),
  )
  return paginated(c, rows, { page, limit, total })
})

// The create form's "Looks like ..." hint: same name once legal forms and case
// are set aside, or the same business domain. Never a refusal.
companyRoutes.get("/similar", async (c) => {
  const orgId = c.get("orgId")
  const name = c.req.query("name")?.slice(0, COMPANY_NAME_MAX) || undefined
  const domain = c.req.query("domain")?.slice(0, 300) || undefined
  const excludeId = c.req.query("excludeId") || undefined
  const rows = await withRequestRls(c, (tx) =>
    similarCompanies(tx, { orgId, name, domain, excludeId }),
  )
  return success(c, rows)
})

companyRoutes.post("/", zValidator("json", createSchema), async (c) => {
  const orgId = c.get("orgId")
  const userId = c.get("userId")
  const { company, notice } = await withRequestRls(c, (tx) =>
    createCompany(tx, { orgId, userId, input: c.req.valid("json") }),
  )
  return success(c, company, notice ? { notice } : undefined, 201)
})

/** A company's timeline page: its people's mail, tickets, invoices, meetings and deals, read from each app. */
companyRoutes.get(
  "/:id/activity",
  zValidator("param", idParam),
  zValidator("query", activityQuerySchema),
  async (c) => {
    const query = c.req.valid("query")
    const result = await readActivity({
      orgId: c.get("orgId"),
      actor: extractRlsContext(c),
      target: { companyId: c.req.param("id") },
      before: query.before,
      limit: query.limit,
      source: query.source,
      deadlineMs: ACTIVITY_DEADLINE_MS,
    })
    if (!result) throw new HTTPException(404, { message: "Company not found" })
    return success(c, result)
  },
)

// The company page's Waiting section: ids of the pending approvals the caller
// sees that link this company, one of its people or one of its deals. The page
// shows them as Home's own cards, from the caller's Home feed.
companyRoutes.get("/:id/waiting", zValidator("param", idParam), async (c) => {
  const orgId = c.get("orgId")
  const ids = await withRequestRls(c, (tx) =>
    companyWaitingApprovalIds(tx, { orgId, companyId: c.req.param("id") }),
  )
  if (!ids) throw new HTTPException(404, { message: "Company not found" })
  return success(c, { approvalIds: ids })
})

companyRoutes.get("/:id", zValidator("param", idParam), async (c) => {
  const orgId = c.get("orgId")
  const company = await withRequestRls(c, (tx) =>
    getCompany(tx, { orgId, companyId: c.req.param("id") }),
  )
  if (!company) throw new HTTPException(404, { message: "Company not found" })
  return success(c, company)
})

companyRoutes.patch(
  "/:id",
  zValidator("param", idParam),
  zValidator("json", patchSchema),
  async (c) => {
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    const { company, notice } = await withRequestRls(c, (tx) =>
      updateCompany(tx, {
        orgId,
        userId,
        companyId: c.req.param("id"),
        patch: c.req.valid("json"),
      }),
    )
    return success(c, company, notice ? { notice } : undefined)
  },
)

companyRoutes.delete("/:id", zValidator("param", idParam), async (c) => {
  const orgId = c.get("orgId")
  const userId = c.get("userId")
  const deleted = await withRequestRls(c, (tx) =>
    deleteCompany(tx, { orgId, userId, companyId: c.req.param("id") }),
  )
  return success(c, deleted)
})

companyRoutes.post(
  "/:id/contacts",
  zValidator("param", idParam),
  zValidator("json", peopleSchema),
  async (c) => {
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    const result = await withRequestRls(c, (tx) =>
      linkContactsToCompany(tx, {
        orgId,
        userId,
        companyId: c.req.param("id"),
        contactIds: c.req.valid("json").contactIds,
      }),
    )
    return success(c, result)
  },
)

companyRoutes.post(
  "/:id/contacts/remove",
  zValidator("param", idParam),
  zValidator("json", peopleSchema),
  async (c) => {
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    const result = await withRequestRls(c, (tx) =>
      unlinkContactsFromCompany(tx, {
        orgId,
        userId,
        companyId: c.req.param("id"),
        contactIds: c.req.valid("json").contactIds,
      }),
    )
    return success(c, result)
  },
)

// The company's discussion: its thread id, created the first time it is
// opened, with the caller enrolled. A company the caller cannot see is a 404
// and nothing is created.
companyRoutes.post("/:id/discussion", zValidator("param", idParam), async (c) => {
  const orgId = c.get("orgId")
  const userId = c.get("userId")
  const opened = await withRequestRls(c, (tx) =>
    openCompanyDiscussion(tx, { orgId, companyId: c.req.param("id"), userId }),
  )
  if (!opened) throw new HTTPException(404, { message: "Company not found" })
  return success(c, opened)
})

companyRoutes.get("/:id/sharing", zValidator("param", idParam), async (c) => {
  const orgId = c.get("orgId")
  const sharing = await withRequestRls(c, (tx) =>
    getCompanySharing(tx, { orgId, companyId: c.req.param("id") }),
  )
  return success(c, sharing)
})

// Change the company's sharing: general access and grants. Only whoever may
// manage it (its creator, or a contacts admin for a company whose creator is
// gone); anyone else gets 403 and nothing changes.
companyRoutes.put(
  "/:id/sharing",
  zValidator("param", idParam),
  zValidator("json", resourceSharingSchema),
  async (c) => {
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    const sharing = await withRequestRls(c, (tx) =>
      setCompanySharing(tx, {
        orgId,
        userId,
        companyId: c.req.param("id"),
        sharing: c.req.valid("json"),
      }),
    )
    return success(c, sharing)
  },
)
