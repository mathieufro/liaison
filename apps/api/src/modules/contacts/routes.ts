// SPDX-License-Identifier: FSL-1.1-ALv2
import {
  mergeContactsSchema,
  resolveContactSchema,
  resourceSharingSchema,
  updateContactSchema,
} from "@liaison/shared"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { extractRlsContext, withRequestRls } from "~/lib/request-rls"
import { paginated, success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { idParam } from "~/lib/validators"
import { assertUnrestrictedSession } from "~/modules/auth/session-ceiling"
import {
  ACTIVITY_DEADLINE_MS,
  activityQuerySchema,
  readActivity,
} from "~/modules/contacts/activity"
import {
  ADDRESS_ROLES,
  addAddress,
  addressBookEditable,
  addressFieldsSchema,
  archiveAddress,
  listAddresses,
  markAddressStale,
  updateAddress,
  verifyAddress,
  verifyAddressSchema,
} from "~/modules/contacts/addresses"
import { companyRoutes } from "~/modules/contacts/company-routes"
import { openContactDiscussion } from "~/modules/contacts/discussion"
import {
  addGroupMembers,
  createGroup,
  deleteGroup,
  GROUP_MEMBERS_BATCH_MAX,
  GROUP_NAME_MAX,
  groupsOfContact,
  listGroupMembers,
  listGroups,
  removeGroupMembers,
  renameGroup,
} from "~/modules/contacts/groups"
import {
  deleteContact,
  getContact,
  listContacts,
  mergeContactsWithMailReferences,
  resolveContact,
  updateContact,
} from "~/modules/contacts/service"
import { getContactSharing, setContactSharing } from "~/modules/contacts/sharing"
import { hasScope } from "~/modules/permissions/permissions"

export const contacts = new Hono<AppEnv>()

// Companies (company-routes.ts), before every "/:id" route below so
// "companies" is never read as a contact id.
contacts.route("/companies", companyRoutes)

contacts.post("/resolve", zValidator("json", resolveContactSchema), async (c) => {
  const params = c.req.valid("json")
  const orgId = c.get("orgId")
  const userId = c.get("userId")

  // Creating a contact FOR THE ORGANISATION is an explicit choice; the
  // default is the caller's own contact, which they can share later.
  const { audience, ...fields } = params
  const { contact } = await withRequestRls(c, async (tx) => {
    return resolveContact(
      tx,
      orgId,
      userId,
      fields,
      audience === "org" ? { audience: "org" } : { audience: "owner", ownerUserId: userId },
    )
  })
  return success(c, contact)
})

// Sharing (modules/sharing): who sees the contact beyond its owner.
contacts.get("/:id/sharing", zValidator("param", idParam), async (c) => {
  const orgId = c.get("orgId")
  const sharing = await withRequestRls(c, (tx) =>
    getContactSharing(tx, { orgId, contactId: c.req.param("id") }),
  )
  return success(c, sharing)
})

contacts.put(
  "/:id/sharing",
  zValidator("param", idParam),
  zValidator("json", resourceSharingSchema),
  async (c) => {
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    const sharing = await withRequestRls(c, (tx) =>
      setContactSharing(tx, {
        orgId,
        userId,
        contactId: c.req.param("id"),
        sharing: c.req.valid("json"),
      }),
    )
    return success(c, sharing)
  },
)

// Contact groups (S15): named groups with hand-picked members. Registered before
// the "/:id" routes so "groups" is never read as a contact id.
const groupNameSchema = z.object({ name: z.string().trim().min(1).max(GROUP_NAME_MAX) })
const groupMembersSchema = z.object({
  contactIds: z.array(z.string().uuid()).min(1).max(GROUP_MEMBERS_BATCH_MAX),
})

contacts.get("/groups", async (c) => {
  const orgId = c.get("orgId")
  const groups = await withRequestRls(c, (tx) => listGroups(tx, { orgId }))
  return success(c, groups)
})

contacts.post("/groups", zValidator("json", groupNameSchema), async (c) => {
  const orgId = c.get("orgId")
  const userId = c.get("userId")
  const { name } = c.req.valid("json")
  const group = await withRequestRls(c, (tx) => createGroup(tx, { orgId, userId, name }))
  return success(c, group, undefined, 201)
})

contacts.patch(
  "/groups/:id",
  zValidator("param", idParam),
  zValidator("json", groupNameSchema),
  async (c) => {
    const orgId = c.get("orgId")
    const { name } = c.req.valid("json")
    const group = await withRequestRls(c, (tx) =>
      renameGroup(tx, { orgId, groupId: c.req.param("id"), name }),
    )
    return success(c, group)
  },
)

contacts.delete("/groups/:id", zValidator("param", idParam), async (c) => {
  const orgId = c.get("orgId")
  const deleted = await withRequestRls(c, (tx) =>
    deleteGroup(tx, { orgId, groupId: c.req.param("id") }),
  )
  if (!deleted) throw new HTTPException(404, { message: "Group not found" })
  return success(c, deleted)
})

contacts.get("/groups/:id/members", zValidator("param", idParam), async (c) => {
  const orgId = c.get("orgId")
  const page = Math.max(1, Math.floor(Number(c.req.query("page") ?? 1)) || 1)
  const limit = Math.min(Math.max(1, Math.floor(Number(c.req.query("limit") ?? 50)) || 50), 100)
  const { rows, total } = await withRequestRls(c, (tx) =>
    listGroupMembers(tx, { orgId, groupId: c.req.param("id"), page, limit }),
  )
  return paginated(c, rows, { page, limit, total })
})

contacts.post(
  "/groups/:id/members",
  zValidator("param", idParam),
  zValidator("json", groupMembersSchema),
  async (c) => {
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    const { contactIds } = c.req.valid("json")
    const result = await withRequestRls(c, (tx) =>
      addGroupMembers(tx, { orgId, userId, groupId: c.req.param("id"), contactIds }),
    )
    return success(c, result)
  },
)

contacts.post(
  "/groups/:id/members/remove",
  zValidator("param", idParam),
  zValidator("json", groupMembersSchema),
  async (c) => {
    const orgId = c.get("orgId")
    const { contactIds } = c.req.valid("json")
    const result = await withRequestRls(c, (tx) =>
      removeGroupMembers(tx, { orgId, groupId: c.req.param("id"), contactIds }),
    )
    return success(c, result)
  },
)

contacts.get("/:id/groups", zValidator("param", idParam), async (c) => {
  const orgId = c.get("orgId")
  const groups = await withRequestRls(c, (tx) =>
    groupsOfContact(tx, { orgId, contactId: c.req.param("id") }),
  )
  return success(c, groups)
})

// A contact's address book (modules/contacts/addresses.ts). Reading needs
// kernel:contacts:read, every change kernel:contacts:write (the mount's
// requireScope); RLS decides which contacts the caller sees and may edit.
const addressParams = z.object({ id: z.string().uuid(), aid: z.string().uuid() })

contacts.get("/:id/addresses", zValidator("param", idParam), async (c) => {
  const orgId = c.get("orgId")
  const roleParam = c.req.query("role")
  const role = ADDRESS_ROLES.find((r) => r === roleParam)
  if (roleParam && !role) throw new HTTPException(400, { message: "Unknown address role" })
  const includeArchived = c.req.query("includeArchived") === "true"
  const contactId = c.req.param("id")
  const { rows, editable } = await withRequestRls(c, async (tx) => ({
    rows: await listAddresses(tx, { orgId, contactId, role, includeArchived }),
    editable: await addressBookEditable(tx, { orgId, contactId }),
  }))
  // meta.canEdit: the contact lets the caller change its addresses and their
  // token may write contacts, so the page draws the edit controls or not.
  const scopes: readonly string[] = c.get("scopes") ?? []
  return success(c, rows, { canEdit: editable && hasScope("kernel:contacts:write", [...scopes]) })
})

contacts.post(
  "/:id/addresses",
  zValidator("param", idParam),
  zValidator("json", addressFieldsSchema),
  async (c) => {
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    const { address, created } = await withRequestRls(c, (tx) =>
      addAddress(tx, { orgId, userId, contactId: c.req.param("id"), fields: c.req.valid("json") }),
    )
    return success(c, address, undefined, created ? 201 : 200)
  },
)

contacts.patch(
  "/:id/addresses/:aid",
  zValidator("param", addressParams),
  zValidator("json", addressFieldsSchema),
  async (c) => {
    const orgId = c.get("orgId")
    const { id, aid } = c.req.valid("param")
    const { address } = await withRequestRls(c, (tx) =>
      updateAddress(tx, { orgId, contactId: id, addressId: aid, patch: c.req.valid("json") }),
    )
    return success(c, address)
  },
)

contacts.post("/:id/addresses/:aid/archive", zValidator("param", addressParams), async (c) => {
  const orgId = c.get("orgId")
  const { id, aid } = c.req.valid("param")
  const address = await withRequestRls(c, (tx) =>
    archiveAddress(tx, { orgId, contactId: id, addressId: aid }),
  )
  return success(c, address)
})

contacts.post(
  "/:id/addresses/:aid/stale",
  zValidator("param", addressParams),
  zValidator("json", z.object({ stale: z.boolean() })),
  async (c) => {
    const orgId = c.get("orgId")
    const { id, aid } = c.req.valid("param")
    const { stale } = c.req.valid("json")
    const address = await withRequestRls(c, (tx) =>
      markAddressStale(tx, { orgId, contactId: id, addressId: aid, stale }),
    )
    return success(c, address)
  },
)

// Verifying is a PERSON's act, recorded as the signed-in person. Only an
// interactive sign-in session may do it here: a restricted device session (a
// CLI or a tool on someone's computer, which an agent may drive) and an MCP or
// agent token are refused. An agent proposes a verification with the gated
// kernel:contacts_address_verify tool instead, which a person approves.
contacts.post(
  "/:id/addresses/:aid/verify",
  zValidator("param", addressParams),
  zValidator("json", verifyAddressSchema),
  async (c) => {
    if (c.get("mcpConnectionId") || c.get("mcpAgentId")) {
      throw new HTTPException(403, { message: "Only a person can verify an address" })
    }
    assertUnrestrictedSession(c, "verify an address")
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    const { id, aid } = c.req.valid("param")
    const address = await withRequestRls(c, (tx) =>
      verifyAddress(tx, {
        orgId,
        contactId: id,
        addressId: aid,
        verifierUserId: userId,
        verification: c.req.valid("json"),
      }),
    )
    return success(c, address)
  },
)

contacts.get("/", async (c) => {
  const orgId = c.get("orgId")
  const page = Math.max(1, Math.floor(Number(c.req.query("page") ?? 1)) || 1)
  const limit = Math.min(Math.max(1, Math.floor(Number(c.req.query("limit") ?? 50)) || 50), 100)
  const query = c.req.query("query")?.slice(0, 200) || undefined
  const mode = c.req.query("mode") === "all" ? "all" : "people"
  const groupParam = c.req.query("groupId")
  const groupId =
    groupParam && z.string().uuid().safeParse(groupParam).success ? groupParam : undefined
  if (groupParam && !groupId) throw new HTTPException(400, { message: "groupId must be a uuid" })

  const { rows, total } = await withRequestRls(c, async (tx) => {
    return listContacts(tx, { orgId, page, limit, query, mode, groupId })
  })
  return paginated(c, rows, { page, limit, total })
})

contacts.post("/merge", zValidator("json", mergeContactsSchema), async (c) => {
  const { sourceId, targetId, resolvedFields } = c.req.valid("json")
  const orgId = c.get("orgId")
  const userId = c.get("userId")

  const result = await withRequestRls(c, async (tx) => {
    return mergeContactsWithMailReferences(tx, {
      orgId,
      userId,
      sourceId,
      targetId,
      resolvedFields,
    })
  })
  return success(c, result)
})

// The contact's discussion: its thread id, created the first time it is
// opened, with the caller enrolled. Seeing the contact (RLS) is what lets
// someone in; a contact they cannot see is a 404 and nothing is created.
contacts.post("/:id/discussion", zValidator("param", idParam), async (c) => {
  const { id } = c.req.valid("param")
  const orgId = c.get("orgId")
  const userId = c.get("userId")
  const opened = await withRequestRls(c, (tx) =>
    openContactDiscussion(tx, { orgId, contactId: id, userId }),
  )
  if (!opened) throw new HTTPException(404, { message: "Contact not found" })
  return success(c, opened)
})

// A contact's timeline page: only rows that involve this contact.
contacts.get(
  "/:id/activity",
  zValidator("param", idParam),
  zValidator("query", activityQuerySchema),
  async (c) => {
    const query = c.req.valid("query")
    const result = await readActivity({
      orgId: c.get("orgId"),
      actor: extractRlsContext(c),
      target: { contactId: c.req.valid("param").id },
      before: query.before,
      limit: query.limit,
      source: query.source,
      deadlineMs: ACTIVITY_DEADLINE_MS,
    })
    if (!result) throw new HTTPException(404, { message: "Contact not found" })
    return success(c, result)
  },
)

contacts.get("/:id", zValidator("param", idParam), async (c) => {
  const id = c.req.param("id")
  const orgId = c.get("orgId")

  const contact = await withRequestRls(c, async (tx) => {
    return getContact(tx, { orgId, contactId: id })
  })
  if (!contact) throw new HTTPException(404, { message: "Contact not found" })
  return success(c, contact)
})

contacts.patch(
  "/:id",
  zValidator("param", idParam),
  zValidator("json", updateContactSchema),
  async (c) => {
    const id = c.req.param("id")
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    const updates = c.req.valid("json")

    const updated = await withRequestRls(c, async (tx) => {
      return updateContact(tx, { orgId, userId, contactId: id, updates })
    })
    if (!updated) throw new HTTPException(404, { message: "Contact not found" })
    return success(c, updated)
  },
)

contacts.delete("/:id", zValidator("param", idParam), async (c) => {
  const id = c.req.param("id")
  const orgId = c.get("orgId")
  const userId = c.get("userId")

  const deleted = await withRequestRls(c, async (tx) => {
    return deleteContact(tx, { orgId, userId, contactId: id })
  })
  if (!deleted) throw new HTTPException(404, { message: "Contact not found" })
  return success(c, deleted)
})
