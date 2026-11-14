// SPDX-License-Identifier: FSL-1.1-ALv2
import { lazy } from "solid-js"
import { ContactsIcon } from "~/modules/contacts/ContactsIcon"
import {
  type Company,
  handleCompanyEvent as companyHandler,
  companyStore,
} from "~/modules/contacts/company-store"
import {
  contactDetailStore,
  handleContactEvent as detailHandler,
} from "~/modules/contacts/contact-detail-store"
import { handleContactEvent as listHandler } from "~/modules/contacts/contact-list-store"
import { tNow } from "~/modules/i18n/i18n-context"
import { invalidatePreview } from "~/modules/shell/entity-preview/entity-preview-store"

export const ContactList = lazy(() =>
  import("~/modules/contacts/ContactList").then((module) => ({ default: module.ContactList })),
)
export const ContactDetail = lazy(() =>
  import("~/modules/contacts/ContactDetail").then((module) => ({ default: module.ContactDetail })),
)
export const CompanyList = lazy(() =>
  import("~/modules/contacts/CompanyList").then((module) => ({ default: module.CompanyList })),
)
export const CompanyDetail = lazy(() =>
  import("~/modules/contacts/CompanyDetail").then((module) => ({ default: module.CompanyDetail })),
)
export const CompaniesSidebar = lazy(() =>
  import("~/modules/contacts/ContactsSidebar").then((module) => ({
    default: module.CompaniesSidebar,
  })),
)
export const ContactsSidebar = lazy(() =>
  import("~/modules/contacts/ContactsSidebar").then((module) => ({
    default: module.ContactsSidebar,
  })),
)
export const ContactListSidebar = lazy(() =>
  import("~/modules/contacts/ContactsSidebar").then((module) => ({
    default: module.ContactListSidebar,
  })),
)

// Icons are eager because tabs/activity bar render synchronously; component bundles stay lazy.

type ContactEventData = Partial<import("./contact-list-store").Contact> & { id: string }

export function handleContactEvent(action: string, data: ContactEventData): void {
  listHandler(action, data)
  detailHandler(action, data)
  if ((action === "update" || action === "delete" || action === "merge") && data?.id) {
    invalidatePreview("kernel", "contact", data.id)
  }
}

// Called by the tab framework with a bare entityId — the previous `{ entityId }`
// shape silently destructured to `undefined` and pinned the tab to its default
// "Contact" label even after the contact loaded.
export function resolveContactTabLabel(entityId: string): string | undefined {
  if (!entityId) return undefined
  const contact = contactDetailStore.contacts[entityId]
  return contact?.name ?? contact?.email ?? undefined
}

export function handleCompanyEvent(action: string, data: Partial<Company> & { id: string }): void {
  companyHandler(action, data)
}

/**
 * A company tab's label: the company's name once loaded. A company the reader
 * cannot see (or one that is gone) is labelled "No access", never a stale name.
 */
export function resolveCompanyTabLabel(entityId: string): string | undefined {
  if (!entityId || !(entityId in companyStore.companies)) return undefined
  const company = companyStore.companies[entityId]
  return company ? company.name : tNow("contacts.companies.noAccess")
}

export { registerEntityPreviews } from "./entity-preview-renderers"
export { ContactsIcon }
