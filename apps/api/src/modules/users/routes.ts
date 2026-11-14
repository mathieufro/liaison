// SPDX-License-Identifier: FSL-1.1-ALv2
import { hiddenSidebarAppsSchema, updateProfileSchema } from "@liaison/shared"
import { and, eq } from "drizzle-orm"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import type { PrivilegedDb } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { users } from "~/db/schema/kernel"
import { deleteObject, getObjectStream, putObject } from "~/infra/storage/object-storage"
import { withRequestRls } from "~/lib/request-rls"
import { paginated, success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { idParam } from "~/lib/validators"
import { requireScope } from "~/middleware/require-scope"
import { deactivateWithCompanies } from "~/modules/apps/kernel-bulk"
import { broadcastReadState } from "~/modules/threads/read-state-broadcast"
import {
  AVATAR_STORED_MIME,
  MAX_AVATAR_UPLOAD_BYTES,
  normalizeAvatar,
  validateAvatarBytes,
} from "~/modules/users/avatar-image"
import {
  avatarStorageKey,
  clearAvatarRow,
  resolveAvatarForServe,
  setAvatarRow,
} from "~/modules/users/avatar-service"
import {
  type MergeErrorCode,
  MergeUserError,
  mergePlaceholderIntoUser,
} from "~/modules/users/merge-placeholder"
import { getHiddenSidebarApps, updateHiddenSidebarApps } from "~/modules/users/preferences-service"
import {
  getProfile,
  getUserDetail,
  getUserPreview,
  ImportPlaceholderError,
  listUsers,
  reactivateUser,
  UserAuthorityError,
  updateProfile,
} from "~/modules/users/service"

export const userRoutes = new Hono<AppEnv>()

userRoutes.get("/me", async (c) => {
  const userId = c.get("userId")
  const profile = await withRequestRls(c, async (tx) => {
    return getProfile(tx, userId)
  })
  if (!profile) throw new HTTPException(404, { message: "User not found" })
  return success(c, profile)
})

userRoutes.get("/:id/preview", zValidator("param", idParam), async (c) => {
  const orgId = c.get("orgId")
  const userId = c.req.param("id")
  const preview = await withRequestRls(c, (tx) => getUserPreview(tx, { orgId, userId }))
  if (!preview) throw new HTTPException(404, { message: "User not found" })
  return success(c, preview)
})

userRoutes.patch("/me", zValidator("json", updateProfileSchema), async (c) => {
  const userId = c.get("userId")
  const updates = c.req.valid("json")

  const updated = await withRequestRls(c, async (tx) => {
    return updateProfile(tx, { userId, orgId: c.get("orgId"), updates })
  })
  if (!updated) throw new HTTPException(404, { message: "User not found" })

  return success(c, updated)
})

// Profile picture upload. The raw image body is sent as the request body (the
// browser sets Content-Type from the File). Validated by magic bytes (not the
// declared MIME), re-encoded to a bounded webp, stored, and pointed at by an
// unguessable capability key. The app-level body-limit exception in app.ts
// raises the cap for this path; the real 5 MB ceiling is enforced here.
userRoutes.post("/me/avatar", async (c) => {
  const userId = c.get("userId")
  const orgId = c.get("orgId")

  const buf = Buffer.from(await c.req.arrayBuffer())
  if (buf.byteLength === 0) {
    throw new HTTPException(400, { message: "Empty image upload" })
  }
  if (buf.byteLength > MAX_AVATAR_UPLOAD_BYTES) {
    throw new HTTPException(413, { message: "Image is too large (maximum 5 MB)" })
  }

  const validation = await validateAvatarBytes(buf)
  if (!validation.ok) {
    throw new HTTPException(400, {
      message: "Unsupported image type. Use a PNG, JPEG, WEBP, or GIF image.",
    })
  }

  let webp: Buffer
  try {
    webp = await normalizeAvatar(buf)
  } catch {
    throw new HTTPException(400, { message: "That image could not be processed." })
  }

  const avatarKey = crypto.randomUUID()
  const storageKey = avatarStorageKey(orgId, avatarKey)
  // Store the object BEFORE flipping the row so avatar_url never points at a
  // missing object; a failed row update leaves an orphan object (GC-able).
  await putObject({ key: storageKey, body: webp, contentType: AVATAR_STORED_MIME })

  const { previousKey, profile } = await withRequestRls(c, (tx) =>
    setAvatarRow(tx, { userId, orgId, avatarKey }),
  )
  if (!profile) throw new HTTPException(404, { message: "User not found" })

  if (previousKey && previousKey !== avatarKey) {
    // Best-effort purge of the superseded object; the URL already rotated so a
    // leaked object is never user-visible.
    await deleteObject(avatarStorageKey(orgId, previousKey)).catch(() => {})
  }
  return success(c, profile)
})

// Remove the profile picture, returning to the initials fallback.
userRoutes.delete("/me/avatar", async (c) => {
  const userId = c.get("userId")
  const orgId = c.get("orgId")
  const { previousKey, profile } = await withRequestRls(c, (tx) =>
    clearAvatarRow(tx, { userId, orgId }),
  )
  if (!profile) throw new HTTPException(404, { message: "User not found" })
  if (previousKey) {
    await deleteObject(avatarStorageKey(orgId, previousKey)).catch(() => {})
  }
  return success(c, profile)
})

/**
 * Public avatar-serving route (mounted OUTSIDE the auth middleware in app.ts).
 * Bearer-token auth cannot ride on an <img> tag, so the unguessable `avatar_key`
 * in the path IS the capability. The key rotates on every upload, so a stale URL
 * simply stops resolving. Served nosniff + locked-down CSP + immutable cache.
 */
export const avatarPublicRoutes = new Hono<AppEnv>()

// randomUUID() shape, but tolerant of any url-safe token of a sane length.
const AVATAR_KEY_RE = /^[A-Za-z0-9_-]{16,64}$/

avatarPublicRoutes.on(["GET", "HEAD"], "/:key", async (c) => {
  const key = c.req.param("key")
  if (!AVATAR_KEY_RE.test(key)) {
    return c.json({ error: { message: "Not found", code: "NOT_FOUND" } }, 404)
  }
  const resolved = await withSystemDb("avatar-serve", (db) => resolveAvatarForServe(db, key))
  if (!resolved) {
    return c.json({ error: { message: "Not found", code: "NOT_FOUND" } }, 404)
  }
  const headers: Record<string, string> = {
    "Content-Type": AVATAR_STORED_MIME,
    // The key is content-versioned (rotates on change), so the URL is immutable.
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Referrer-Policy": "no-referrer",
  }
  if (c.req.method === "HEAD") {
    return new Response(null, { status: 200, headers })
  }
  let stream: Awaited<ReturnType<typeof getObjectStream>>
  try {
    stream = await getObjectStream(resolved.storageKey)
  } catch {
    return c.json({ error: { message: "Not found", code: "NOT_FOUND" } }, 404)
  }
  if (stream.contentLength > 0) headers["Content-Length"] = String(stream.contentLength)
  return new Response(stream.stream, { status: 200, headers })
})

// Admin routes
export const adminUserRoutes = new Hono<AppEnv>()

adminUserRoutes.get("/", async (c) => {
  const orgId = c.get("orgId")
  const page = Math.max(1, Math.floor(Number(c.req.query("page") ?? 1)) || 1)
  const limit = Math.min(Math.max(1, Math.floor(Number(c.req.query("limit") ?? 25)) || 25), 100)

  // Default: people only. `?kind=imported` lists the import placeholders.
  const kind = c.req.query("kind") === "imported" ? "imported" : "people"

  const { rows, total } = await withRequestRls(c, async (tx) => {
    return listUsers(tx, { orgId, page, limit, kind })
  })
  return paginated(c, rows, { page, limit, total })
})

adminUserRoutes.get("/:id", zValidator("param", idParam), async (c) => {
  const orgId = c.get("orgId")
  const userId = c.req.param("id")
  const detail = await withRequestRls(c, (tx) => getUserDetail(tx, { orgId, userId }))
  if (!detail) throw new HTTPException(404, { message: "User not found" })
  return success(c, detail)
})

adminUserRoutes.post("/:id/deactivate", zValidator("param", idParam), async (c) => {
  const targetId = c.req.param("id")
  const actorId = c.get("userId")
  const orgId = c.get("orgId")

  if (targetId === actorId) {
    throw new HTTPException(400, { message: "Cannot deactivate yourself" })
  }

  // The companies they manage go with the answer to the one question, as the tool does.
  const body = (await c.req.json().catch(() => ({}))) as { accountsTo?: unknown }
  const accountsTo =
    body.accountsTo === null || typeof body.accountsTo === "string" ? body.accountsTo : undefined
  const actorScopes = (c.get("scopes") as string[] | undefined) ?? []
  const result = await deactivateWithCompanies({
    orgId,
    actorId,
    actorScopes,
    userId: targetId,
    ...(accountsTo !== undefined ? { accountsTo } : {}),
  })
  if ("error" in result) {
    const status =
      result.error.code === "not_found"
        ? 404
        : result.error.code === "forbidden"
          ? 403
          : result.error.code === "accounts_to_required" || result.error.code === "last_admin"
            ? 409
            : 422
    return c.json({ error: { message: result.error.message, code: result.error.code } }, status)
  }
  return success(c, result)
})

adminUserRoutes.post("/:id/reactivate", zValidator("param", idParam), async (c) => {
  const targetId = c.req.param("id")
  const actorId = c.get("userId")
  const orgId = c.get("orgId")

  let result: Awaited<ReturnType<typeof reactivateUser>>
  try {
    result = await withPrivilegedDb(orgId, "admin-reactivate-user", (tx) =>
      reactivateUser(tx, {
        targetId,
        actorId,
        orgId,
        actorScopes: (c.get("scopes") as string[] | undefined) ?? [],
      }),
    )
  } catch (err) {
    if (err instanceof UserAuthorityError) {
      throw new HTTPException(403, { message: err.message })
    }
    if (err instanceof ImportPlaceholderError) {
      return c.json({ error: { message: err.message, code: err.code } }, 409)
    }
    throw err
  }
  if (!result) throw new HTTPException(404, { message: "User not found" })
  return success(c, result)
})

const MERGE_ERROR_STATUS: Record<MergeErrorCode, 400 | 404 | 409> = {
  SAME_USER: 400,
  NOT_A_PLACEHOLDER: 400,
  TARGET_IS_PLACEHOLDER: 400,
  TARGET_NOT_ACTIVE: 400,
  PLACEHOLDER_NOT_FOUND: 404,
  TARGET_NOT_FOUND: 404,
  BLOCKED_BY_REFERENCE: 409,
}

const mergeBody = z
  .object({ targetUserId: z.string().uuid(), dryRun: z.boolean().optional() })
  .strict()

// Link an import placeholder (`:id`) to the real person it stands for: their
// history, reactions, files, participations and mentions move to
// `targetUserId`, and the placeholder is removed (merge-placeholder.ts has the
// rules). `dryRun: true` answers the same counts without writing. Identity
// change: the admin scope is required here explicitly, on top of the
// /api/admin/users mount, so moving the route can never drop the check.
adminUserRoutes.post(
  "/:id/merge",
  requireScope("kernel:users:admin"),
  zValidator("param", idParam),
  zValidator("json", mergeBody),
  async (c) => {
    const { targetUserId, dryRun } = c.req.valid("json")
    try {
      const result = await mergePlaceholderIntoUser({
        orgId: c.get("orgId"),
        actorId: c.get("userId"),
        placeholderId: c.req.param("id"),
        targetId: targetUserId,
        dryRun: dryRun === true,
      })
      return success(c, result)
    } catch (err) {
      if (err instanceof MergeUserError) {
        return c.json(
          { error: { message: err.message, code: err.code } },
          MERGE_ERROR_STATUS[err.code],
        )
      }
      throw err
    }
  },
)

// A member's sidebar: the rail entries hidden for them (0293). The admin sets a
// starting point the member can change back at any time; hiding changes no
// access. user_preferences RLS is self-only, so these run privileged, and only
// after the member is found IN THE CALLER'S ORG (404 otherwise, never another
// org's row). The admin scope is required here too, like /merge, so moving the
// route can never drop the check.
async function memberInOrg(tx: PrivilegedDb, orgId: string, userId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.orgId, orgId), eq(users.userType, "member")))
    .limit(1)
  return Boolean(row)
}

adminUserRoutes.get(
  "/:id/hidden-apps",
  requireScope("kernel:users:admin"),
  zValidator("param", idParam),
  async (c) => {
    const orgId = c.get("orgId")
    const userId = c.req.param("id")
    const hidden = await withPrivilegedDb(orgId, "admin-read-hidden-sidebar-apps", async (tx) =>
      (await memberInOrg(tx, orgId, userId)) ? getHiddenSidebarApps(userId, { rlsTx: tx }) : null,
    )
    if (!hidden) throw new HTTPException(404, { message: "User not found" })
    return success(c, { userId, hiddenSidebarApps: hidden })
  },
)

adminUserRoutes.put(
  "/:id/hidden-apps",
  requireScope("kernel:users:admin"),
  zValidator("param", idParam),
  zValidator("json", hiddenSidebarAppsSchema),
  async (c) => {
    const orgId = c.get("orgId")
    const userId = c.req.param("id")
    const { hiddenSidebarApps } = c.req.valid("json")
    const stored = await withPrivilegedDb(orgId, "admin-set-hidden-sidebar-apps", async (tx) =>
      (await memberInOrg(tx, orgId, userId))
        ? (await updateHiddenSidebarApps(userId, orgId, hiddenSidebarApps, { rlsTx: tx }))
            .hiddenSidebarApps
        : null,
    )
    if (!stored) throw new HTTPException(404, { message: "User not found" })
    // Committed: the member's open apps re-apply it at once.
    await broadcastReadState(orgId, userId, {
      kind: "hidden_sidebar_apps",
      hiddenSidebarApps: stored,
    })
    return success(c, { userId, hiddenSidebarApps: stored })
  },
)
