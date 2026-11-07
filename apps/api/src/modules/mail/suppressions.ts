// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * What the send check asks about the people a commercial mail goes to. No
 * suppression list exists yet, so nobody is suppressed and every basis holds. The
 * check already calls these, so a list only has to fill them in.
 */

export interface LawfulBasisProblem {
  code: string
  label: string
  who: string
}

/** The addresses among `emails` that have opted out. */
export async function suppressedAmong(_orgId: string, _emails: string[]): Promise<string[]> {
  return []
}

/** Why the org may not write to these people, or null when it may. */
export async function lawfulBasisProblem(
  _orgId: string,
  _contactIds: string[],
  _addresses: string[],
): Promise<LawfulBasisProblem | null> {
  return null
}
