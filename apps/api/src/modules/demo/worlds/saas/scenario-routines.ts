// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The two routines the software world's support and sales scenarios start:
// their names and instructions. Written for a small model that follows steps
// literally: the exact tool names, the order and the @ref forms are spelled
// out, and there is one path per case. Every write waits for the visitor's
// approval, and the sales request is one approval for the whole chain.
import { SAAS_PROSPECT_ROUTINE_NAME } from "@liaison/shared"

export const SAAS_SUPPORT_ROUTINE_NAME = "Draft a reply to new tickets"
export const PROSPECT_SCENARIO_ROUTINE_NAME = SAAS_PROSPECT_ROUTINE_NAME

export const SUPPORT_ROUTINE_PROMPT =
  "A ticket has just been opened. The event data names it. Act only on a customer's " +
  "inbound message; stand down on anything else.\n\n" +
  "Read the ticket, the customer's earlier tickets and the help centre article that answers " +
  "it. Then do exactly two things on this ticket:\n" +
  "1. Add ONE internal note for the team: your verdict in bold (a known issue, a user " +
  "error, a suspected bug), the sources you used, and a line starting TODO HUMAN only " +
  "when a person must check something first.\n" +
  "2. Draft ONE reply to the customer with the ticket reply tool, in their language: " +
  "specific to what they wrote, under 120 words, with the next step. It waits for a " +
  "person's approval.\n\n" +
  "Never change the ticket's status, assignee or follow-up date, and never say something " +
  "was sent."

/**
 * The sales routine's instructions: one request the owner approves once, with
 * the company and contact written natively (no outside CRM), the quote and the
 * reply, each step citing the one before with @ref tokens.
 */
export function prospectRoutinePrompt(issuerProfileId: string): string {
  return (
    "An email has just arrived from a hotel group asking for a quote. The event data names " +
    "the message, its conversation and its sender.\n\n" +
    "You prepare ONE request that I approve once: the company, the contact, a quote and the " +
    "reply with the quote attached. Each tool below waits for my approval; it returns `outputs` " +
    "with @ref tokens. Do NOT wait for an approval between the steps: make the next call at " +
    "once, with the token copied exactly where the step says.\n\n" +
    "1. Read the email. Look the sender up with kernel__contacts_search by their email, then " +
    "their company with kernel__companies_search by its domain, then by its name.\n" +
    "2. If the group is not there yet, read its website with web_fetch, at exactly " +
    "https://DOMAIN/ where DOMAIN is the part of the sender's address after the @, with " +
    "nothing after the last slash. Note what the group does and its size. If the fetch " +
    "fails, go on without it and say so in the brief.\n" +
    "3. Company. A NEW group: call kernel__companies_write with its name, its domain and one " +
    "line on what it does. Its result has outputs.record_id, a token like @ref:<id>:record_id. " +
    "A group ALREADY there: make no call; its id is the id the search returned.\n" +
    "4. Contact. A NEW sender: call kernel__contacts_write with their name, email and the " +
    "company from step 3 (the whole token). A sender ALREADY there: make no call.\n" +
    "5. Quote. Call invoicing__quote_create_and_issue with:\n" +
    `- issuer_profile_id: ${issuerProfileId}\n` +
    "- counterparty: legal_name (the group), country (ISO code, from their address), address " +
    "(from their signature or website), email (the sender's address)\n" +
    "- items: one line for the Group plan, quantity the number of sites they ask for, " +
    "unit_price_minor 145000 (EUR 1,450.00 a month)\n" +
    "Its result has outputs.number and outputs.pdf_file_id (tokens like @ref:<id>:number). " +
    "Amounts in minor units are cents: in the reply and the brief, write them in euros.\n" +
    "6. Reply. Call mail__reply with conversationId (from the event data), attachments: [the " +
    "pdf_file_id token from step 5, whole], and a textBody that answers their request: the " +
    "quote's number written as the number token, the monthly price per site, a rollout in " +
    "waves of three sites, and one line that shows you know their group.\n" +
    "Then stop: the run waits for my decision and comes back to you with the results.\n" +
    "7. Once I have decided, create the deal with projects__create in the Sales pipeline: " +
    "title the group's name, linked to its company. Then close with a short brief: who they " +
    "are, what the group does (say where you learned it), what they want, and what became of " +
    "the company, the contact, the quote (its number) and the reply. If a step failed, propose " +
    "the corrected calls as the error says instead. Post it in the discussion of their Liaison " +
    "contact (kernel__contacts_search by their email, then kernel__threads_reply with its " +
    "contactId), and end with it as your answer.\n\n" +
    "If a call is refused, read its error, fix the call as it says and make it again. Report " +
    "only what the results show."
  )
}
