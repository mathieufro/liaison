// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The settings sections THIS viewer may reach and this deployment shows, in
// registry order: the access check plus the edition gate `visibleWhen`, exactly
// the pair the desktop sidebar applies. The phone You screen derives its rows
// from the same answer, so a section the sidebar hides never becomes a row
// there either.
import {
  getSettingsSections,
  type SettingsPageSectionAccess,
  type SettingsSection,
} from "~/framework/app-registry"
import { isFeatureOff } from "~/framework/org-features"
import { canAccessScope } from "~/modules/auth/auth-store"

/** The scope an org section of an app page needs when it names none. */
export const DEFAULT_SECTION_ADMIN_SCOPE = "kernel:apps:admin"

/** Does the viewer see this section of an app's settings page (A7)? */
export function canSeePageSection(section: SettingsPageSectionAccess): boolean {
  if (isFeatureOff(section.appId, section.feature)) return false
  if (section.scope === "user") return true
  return canAccessScope(section.adminScope ?? DEFAULT_SECTION_ADMIN_SCOPE)
}

/**
 * May the viewer open this settings page? Its admin scope, and for an app's
 * declarative page at least one section they can see: an app with nothing
 * for them has no page and no row (S13).
 */
export function canAccessSettingsSection(section: SettingsSection): boolean {
  if (isFeatureOff(section.appId, section.feature)) return false
  if (!canAccessScope(section.adminScope)) return false
  if (section.pageSections) return section.pageSections.some(canSeePageSection)
  return true
}

export function visibleSettingsSections(): SettingsSection[] {
  return [...getSettingsSections()]
    .filter((s) => canAccessSettingsSection(s) && (s.visibleWhen ? s.visibleWhen() : true))
    .sort((a, b) => a.order - b.order)
}
