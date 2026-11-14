// SPDX-License-Identifier: FSL-1.1-ALv2
import { z } from "zod"

export const resolveContactSchema = z
  .object({
    email: z.string().email().optional(),
    name: z.string().optional(),
    phone: z.string().optional(),
    company: z.string().optional(),
    externalId: z.record(z.string(), z.string()).optional(),
    // Free-form structured metadata (e.g. a captured postal address / source URL) — persisted on
    // create as well as update (the create path used to drop it). Mirrors updateContactSchema.metadata.
    metadata: z.record(z.string(), z.unknown()).optional(),
    // Who the new contact is for: the caller alone ("private", the default)
    // or the whole organisation ("org"). Adding a contact to the organisation
    // is always this explicit choice.
    audience: z.enum(["private", "org"]).optional(),
  })
  .refine(
    (data) =>
      data.email ||
      data.phone ||
      (data.externalId && Object.keys(data.externalId).length > 0) ||
      data.name,
    { message: "At least one identifier (email, phone, externalId, or name) is required" },
  )

export const updateContactSchema = z.object({
  name: z.string().optional(),
  phone: z.string().optional(),
  company: z.string().optional(),
  externalIds: z.record(z.string(), z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  /** What commercial mail to them rests on; recording it stamps when. */
  lawfulBasis: z
    .enum(["consent", "customer", "professional_interest", "generic_address"])
    .optional(),
})

export const mergeContactsSchema = z.object({
  sourceId: z.string().uuid(),
  targetId: z.string().uuid(),
  resolvedFields: z
    .object({
      name: z.string().optional(),
      email: z.string().email().optional(),
      phone: z.string().optional(),
      company: z.string().optional(),
      externalIds: z.record(z.string(), z.string()).optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
})

const shareRoleSchema = z.enum(["viewer", "editor"])

/** A resource's sharing (modules/sharing): org-wide access plus explicit grants. */
export const resourceSharingSchema = z.object({
  orgAccess: z.enum(["none", "viewer", "editor"]),
  users: z
    .array(z.object({ userId: z.string().uuid(), role: shareRoleSchema }))
    .max(1000)
    .optional(),
  roles: z
    .array(z.object({ roleId: z.string().uuid(), role: shareRoleSchema }))
    .max(1000)
    .optional(),
  dimensions: z
    .array(
      z.object({
        key: z.string().regex(/^[a-z0-9_-]+(:[a-z0-9_-]+)?$/i),
        value: z.string().min(1).max(200),
        role: shareRoleSchema,
      }),
    )
    .max(1000)
    .optional(),
})
export type ResourceSharingInput = z.infer<typeof resourceSharingSchema>
