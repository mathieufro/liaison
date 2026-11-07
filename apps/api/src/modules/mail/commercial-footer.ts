// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * What a commercial mail carries at the moment it leaves, added after the send
 * check so nothing here reaches an approver's payload. No commercial identity
 * exists yet: the body goes through untouched and nothing refuses. The handler
 * already calls these, so an identity only has to fill them in.
 */

export interface CommercialFooter {
  body: string
  headers: Record<string, string>
}

export async function applyCommercialFooter(
  _orgId: string,
  body: string,
  _recipient: string,
): Promise<CommercialFooter> {
  return { body, headers: {} }
}

/** True when the org lacks what a commercial mail must state. */
export async function commercialIdentityMissing(_orgId: string): Promise<boolean> {
  return false
}
