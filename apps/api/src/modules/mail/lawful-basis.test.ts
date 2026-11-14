// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The lawful-basis step of the send check, on what the contacts at an address
// record: nothing is inferred, an unknown consumer status counts as a consumer,
// an unknown country takes the default rule, and two contacts that disagree
// leave the choice to a person.
import { describe, expect, it } from "bun:test"
import {
  basisProblemFor,
  DEFAULT_COUNTRY_POLICY,
  type RecipientBasis,
} from "~/modules/mail/suppressions"

const at = (fields: Partial<RecipientBasis>): RecipientBasis => ({
  email: "lea@prospect.example",
  contactIds: ["c1"],
  basis: "professional_interest",
  conflict: null,
  isConsumer: false,
  countries: ["FR"],
  name: null,
  ...fields,
})

const code = (r: RecipientBasis) => basisProblemFor(r, DEFAULT_COUNTRY_POLICY)?.code ?? null

describe("lawful basis", () => {
  it("a commercial send is refused for no basis, a consumer, an unknown consumer status, and a country needing consent, and passes for a generic address in France and for a service message", () => {
    expect(code(at({ basis: null }))).toBe("no_basis")
    expect(code(at({ basis: null, contactIds: [], isConsumer: null, countries: [] }))).toBe(
      "no_basis",
    )
    expect(code(at({ isConsumer: true }))).toBe("consumer")
    expect(code(at({ isConsumer: null }))).toBe("consumer_unknown")
    expect(code(at({ countries: ["DE"] }))).toBe("country_needs_consent")
    // An unknown country takes the default rule, which asks for consent.
    expect(code(at({ countries: [] }))).toBe("country_needs_consent")
    expect(code(at({ basis: "generic_address", isConsumer: null }))).toBeNull()
    expect(code(at({ basis: "professional_interest" }))).toBeNull()
    // Consent covers a consumer and a consent country alike.
    expect(code(at({ basis: "consent", isConsumer: true, countries: ["DE"] }))).toBeNull()
    // A service message never reaches this step: the guard runs it for marketing only.
    const problem = basisProblemFor(at({ isConsumer: true }), DEFAULT_COUNTRY_POLICY)
    expect(problem?.who).toBe("lea@prospect.example")
    expect(problem?.label).toContain("consent")
  })

  it("an existing contact with no recorded consumer status is skipped", () => {
    const problem = basisProblemFor(at({ isConsumer: null }), DEFAULT_COUNTRY_POLICY)
    expect(problem?.code).toBe("consumer_unknown")
    expect(problem?.label).toContain("is not recorded")
  })

  it("two contacts at one address with different recorded bases wait for a person's choice", () => {
    const problem = basisProblemFor(
      at({ basis: null, conflict: ["consent", "professional_interest"] }),
      DEFAULT_COUNTRY_POLICY,
    )
    expect(problem?.code).toBe("basis_conflict")
    expect(problem?.label).toContain("a person keeps one")
  })

  it("the organization's own country rule replaces the default", () => {
    const policy = { DE: "optout", default: "consent" } as const
    expect(basisProblemFor(at({ countries: ["DE"] }), policy)).toBeNull()
    expect(basisProblemFor(at({ countries: ["FR"] }), policy)?.code).toBe("country_needs_consent")
    expect(
      basisProblemFor(at({ countries: ["FR", "DE"] }), { FR: "optout", default: "consent" })?.code,
    ).toBe("country_needs_consent")
  })

  it("a country refusal names the countries the policy lets mail go to on opt-out, and says when recording a country would help", () => {
    const unknown = basisProblemFor(at({ countries: [] }), DEFAULT_COUNTRY_POLICY)?.label
    expect(unknown).toContain("Their country is not recorded")
    expect(unknown).toContain(
      "Without recorded consent, the organization's policy allows commercial mail only to FR.",
    )
    expect(unknown).toContain("Recording their country helps only if it is FR.")
    const recorded = basisProblemFor(at({ countries: ["DE"] }), {
      FR: "optout",
      BE: "optout",
      default: "consent",
    })?.label
    expect(recorded).toContain("The rule for DE needs recorded consent")
    expect(recorded).toContain("only to BE and FR.")
    expect(recorded).not.toContain("Recording their country")
    const none = basisProblemFor(at({ countries: [] }), { default: "consent" })?.label
    expect(none).toContain(
      "The organization's policy allows no commercial mail without recorded consent, so recording their country would not change this.",
    )
  })
})
