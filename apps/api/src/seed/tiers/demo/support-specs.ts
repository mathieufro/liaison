// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The demo company's support and collaboration fiction: the contact book's
// deliberate duplicates, the ticket queue, the knowledge base, the project
// boards, the week's calendar, the shared and personal mailboxes, the team's
// threads and the owner's agent DMs. Pure data: `seed-support.ts` resolves the
// keys (people, contacts, agents) and hands each table to its factory under
// `seed/factories/`, which knows nothing of this company.

import { DEV_BUGS_CHANNEL_TITLE } from "@liaison/shared"
import type { EventSpec } from "~/seed/factories/calendar/events"
import type { ArticleSpec, KnowledgeCollectionSpec } from "~/seed/factories/knowledge/articles"
import type { MailConversationSpec } from "~/seed/factories/mail/conversations"
import type { ProjectSpec } from "~/seed/factories/projects/projects"
import type { TicketSpec } from "~/seed/factories/support/tickets"
import type { AgentDmSpec, ThreadSpec } from "~/seed/factories/threads/threads"

export interface DuplicateSpec {
  /** Contact key of the primary this shadows. */
  ofKey: string
  name: string
  email: string
  company: string
}

export const DEMO_CONTACT_DUPLICATES: DuplicateSpec[] = [
  {
    ofKey: "helena-ritter",
    name: "H. Ritter",
    email: "h.ritter@nordlicht.example",
    company: "Nordlicht Tonstudio",
  },
  {
    ofKey: "claudine-moreau",
    name: "Claudine Moreau",
    email: "c.moreau@studiotone.example",
    company: "Studio Tone",
  },
]

/** The company a customer key belongs to, where the demo names one. */
export const CUSTOMER_COMPANIES: Record<string, string> = {
  "helena-ritter": "Nordlicht Tonstudio",
  "claudine-moreau": "Studio Tone",
  "jasper-nilsson": "Arclight Recording",
  "tomoko-arai": "Hanabi Sound Design",
  "daniel-okafor": "Brightroom Studios",
  "amelie-roux": "Studio Bleu",
  "jane-doe": "Acme Instruments",
}

export const TICKET_CATEGORIES = [
  "Hardware fault",
  "Shipping and delivery",
  "Billing and VAT",
  "Firmware and software",
  "Returns and warranty",
  "Dealer and pricing",
  "Getting started",
] as const

export const SUPPORT_INBOX = "Support"
export const SALES_INBOX = "Sales"
export const BUGS_INBOX = "Bug reports"

export const TICKET_SPECS: TicketSpec[] = [
  // ── Fresh, still warm ───────────────────────────────────────────────────
  {
    key: "dead-inputs-kestrel",
    subject: "Inputs 4 to 6 have stopped responding",
    contactKey: "customer:helena-ritter",
    category: "Hardware fault",
    team: "support",
    audience: "b2c",
    priority: "high",
    status: "open",
    assignee: "lucas",
    channel: "email",
    createdHoursAgo: 0.7,
    body:
      "Hello,\n\nI have had my Kestrel 6 Field Recorder since March and it has been faultless until this week. " +
      "Since Tuesday inputs 4, 5 and 6 do nothing: no signal, no meter movement, no phantom power light. " +
      "Inputs 1 to 3 record perfectly.\n\n" +
      "I have tried different XLR cables and two different microphones, and I reinstalled Kestrel Link. " +
      "Those three inputs are flat in the recorder's own meters as well, so I do not think it is my card or my mics.\n\n" +
      "Serial number is RAL-K6-00418. Bought direct from you.\n\nThanks,\nHelena",
  },
  {
    key: "kestrel-10-wont-power",
    subject: "New Kestrel 10 does not power on at all",
    contactKey: "customer:tomoko-arai",
    category: "Hardware fault",
    team: "support",
    audience: "b2c",
    priority: "urgent",
    status: "open",
    channel: "email",
    createdHoursAgo: 2.5,
    body:
      "My Kestrel 10 Field Recorder arrived this morning and it will not turn on. " +
      "No lights, nothing on the display, nothing in my computer's USB list. " +
      "I tried both supplied cables, the Kestrel Power Supply and a fresh set of batteries, and three different outlets.\n\n" +
      "The box was not damaged. Order RAL-2291.\n\nTomoko",
  },
  {
    key: "where-is-parcel",
    subject: "Order shipped 9 days ago, tracking has not moved",
    contactKey: "customer:andre-silva",
    category: "Shipping and delivery",
    team: "operations",
    audience: "b2c",
    priority: "high",
    status: "open",
    assignee: "margot",
    channel: "email",
    createdHoursAgo: 5,
    body:
      "Hi,\n\nI ordered a Kestrel Pocket Recorder and a Travel Case on the 2nd and got a shipping " +
      "notification the same day. The tracking page has said 'in transit' ever since and the last scan " +
      "is still the origin depot.\n\n" +
      "I am starting to worry it is lost. Can you check with the carrier? I need it for a shoot at the " +
      "end of the month.\n\nBest,\nAndre",
  },
  {
    key: "vat-invoice-request",
    subject: "Need a VAT invoice for my business",
    contactKey: "customer:felix-berger",
    category: "Billing and VAT",
    team: "finance",
    audience: "b2b",
    priority: "normal",
    status: "open",
    assignee: "henrik",
    channel: "web_form",
    createdHoursAgo: 9,
    body:
      "Hello,\n\nI bought a Kestrel Field Preamp last week as a private customer, but I need to put it " +
      "through my company. Could you reissue the invoice to Klangbau Tonstudio GmbH with our VAT number " +
      "ATU00000000 on it?\n\nOrder reference RAL-2274. Happy to send anything you need.\n\nFelix Berger",
  },
  {
    key: "dealer-tier-question",
    subject: "Question on volume pricing for a 12 unit order",
    contactKey: "dealer:nl-ams",
    category: "Dealer and pricing",
    team: "sales",
    audience: "b2b",
    priority: "normal",
    status: "open",
    assignee: "giulia",
    channel: "email",
    createdHoursAgo: 20,
    body:
      "Hi Giulia,\n\nWe are putting together a Q4 order and would like to go to 12 units of the Kestrel 6 " +
      "Field Recorder plus 6 of the Pocket. Our last order was 8 units, so I believe that moves us up a tier.\n\n" +
      "Could you confirm the price per unit at that volume, and whether the Windshield Packs count towards " +
      "the threshold? We would also like to know the lead time before we commit.\n\n" +
      "Thanks,\nKanaal Audio BV",
  },
  {
    key: "float-gain-setup-help",
    subject: "Do I still need to set the gain in 32 bit float?",
    contactKey: "customer:marta-nowak",
    category: "Getting started",
    team: "support",
    audience: "b2c",
    priority: "low",
    status: "open",
    channel: "web_form",
    createdHoursAgo: 26,
    body:
      "Hi,\n\nJust got my Kestrel Pocket and I am loving it, but I cannot work out whether I am supposed " +
      "to ride the gain any more. The meters go red on anything loud, and yet the file sounds completely " +
      "clean once I pull it down in my editing software.\n\n" +
      "I am on the latest firmware. Is there a setting I have missed?\n\nMarta",
  },
  {
    key: "windshield-fit",
    subject: "Windshield pack does not fit my microphone",
    contactKey: "customer:owen-brady",
    category: "Hardware fault",
    team: "support",
    audience: "b2c",
    priority: "normal",
    status: "open",
    channel: "email",
    createdHoursAgo: 33,
    body:
      "The fur windjammer in the Windshield Pack I ordered is about two millimetres too wide for the basket, " +
      "so it slips round as soon as there is any wind on it and the fur ends up across the capsule. " +
      "Is that within tolerance or should I send it back?\n\nOwen",
  },

  // ── Waiting on the customer ─────────────────────────────────────────────
  {
    key: "usb-dropout-diagnosis",
    subject: "Recorder drops off the USB bus mid session",
    contactKey: "customer:jasper-nilsson",
    category: "Firmware and software",
    team: "support",
    audience: "b2c",
    priority: "high",
    status: "awaiting_customer",
    assignee: "lucas",
    channel: "email",
    createdHoursAgo: 52,
    body:
      "Every 20 minutes or so my Kestrel 6 drops off the USB bus and comes back a few seconds later. " +
      "The card keeps recording, but whatever I am feeding into the laptop is cut in half. " +
      "Started after the last firmware update.\n\nJasper",
    followups: [
      {
        kind: "outbound",
        author: "lucas",
        hoursAfter: 3,
        body:
          "Hi Jasper,\n\nThanks for the detail, that timing pattern is useful. Two things would help me " +
          "narrow this down:\n\n" +
          "1. Could you send the log file from Kestrel Link? It is under Help, then Export diagnostics.\n" +
          "2. Is the recorder plugged straight into the computer or through a hub or dock?\n\n" +
          "If it is through a hub, please try it directly for one session and let me know whether the " +
          "drops stop.\n\nBest,\nLucas",
      },
      {
        kind: "note",
        author: "lucas",
        hoursAfter: 3.1,
        body:
          "Third report this month with the same 20 minute cadence, all on 1.8.2 and all through a dock. " +
          "If Jasper's log matches the other two I will raise it as a firmware regression rather than " +
          "keep treating them as one-offs.",
      },
    ],
  },
  {
    key: "return-change-of-mind",
    subject: "Would like to return the tripod mount",
    contactKey: "customer:sara-lindqvist",
    category: "Returns and warranty",
    team: "support",
    audience: "b2c",
    priority: "normal",
    status: "awaiting_customer",
    assignee: "amina",
    channel: "email",
    createdHoursAgo: 70,
    body:
      "Hello,\n\nI ordered the Kestrel Tripod Mount but it stands the recorder too high for the bag rig " +
      "I work from. It is unused and still in the box. Can I return it?\n\nSara",
    followups: [
      {
        kind: "outbound",
        author: "amina",
        hoursAfter: 4,
        body:
          "Hi Sara,\n\nOf course. You are within the 30 day window and an unused item in its original " +
          "packaging is straightforward.\n\n" +
          "Could you confirm the order number and the address you would like the return label sent to? " +
          "Once I have those I will email the label and a prepaid drop off code. The refund goes back to " +
          "the original payment method once the mount reaches us, usually within three working days of " +
          "arrival.\n\nBest,\nAmina",
      },
    ],
  },
  {
    key: "dealer-vat-mismatch",
    subject: "VAT number on our invoices is out of date",
    contactKey: "dealer:uk-ldn",
    category: "Billing and VAT",
    team: "finance",
    audience: "b2b",
    priority: "normal",
    status: "awaiting_customer",
    assignee: "henrik",
    channel: "email",
    createdHoursAgo: 96,
    body:
      "Our registered details changed at the start of the quarter and your invoices still carry the old " +
      "number. Could you update our account and reissue the last two invoices?\n\nNorthfield Instruments",
    followups: [
      {
        kind: "outbound",
        author: "henrik",
        hoursAfter: 6,
        body:
          "Hello,\n\nHappy to sort that out. Could you send the updated registration certificate, or at " +
          "least the new number and the effective date? I will validate it, update the account and " +
          "reissue both invoices as credit notes plus replacements so your records stay clean.\n\n" +
          "Since you are outside the EU the reverse charge treatment does not change, only the number " +
          "printed on the document.\n\nBest regards,\nHenrik",
      },
    ],
  },
  {
    key: "preamp-noise-floor",
    subject: "Field Preamp adds a hiss on the linked channels",
    contactKey: "customer:ivan-petrov",
    category: "Hardware fault",
    team: "support",
    audience: "b2c",
    priority: "normal",
    status: "awaiting_customer",
    channel: "email",
    createdHoursAgo: 120,
    body:
      "When I link the Kestrel Field Preamp to the recorder there is an audible hiss on those four " +
      "channels that is not there on the recorder's own inputs at the same gain. Is that normal? " +
      "It is loud enough to hear under a quiet dialogue take.\n\nIvan",
    followups: [
      {
        kind: "outbound",
        author: "amina",
        hoursAfter: 8,
        body:
          "Hi Ivan,\n\nThat is not normal. At the gains you are describing the preamp's noise floor " +
          "should sit below the recorder's own.\n\n" +
          "Before we look at a replacement, could you try it on a different power outlet and, if you can, " +
          "with a different XLR set? A ground loop between the preamp and an interface on another " +
          "circuit produces exactly this, and it is the most common cause we see.\n\n" +
          "If the hiss follows the preamp regardless, send me a short take at a known gain and we will " +
          "arrange a replacement under warranty.\n\nBest,\nAmina",
      },
    ],
  },

  // ── Snoozed, waiting to wake up ─────────────────────────────────────────
  {
    key: "firmware-beta-followup",
    subject: "Any news on the dock disconnect fix?",
    contactKey: "customer:grace-whitfield",
    category: "Firmware and software",
    team: "support",
    audience: "b2c",
    priority: "normal",
    status: "awaiting_followup",
    assignee: "lucas",
    channel: "email",
    createdHoursAgo: 190,
    followupInHours: 72,
    followupReason: "Check back when the 1.8.3 beta build is out",
    body:
      "You mentioned a fix was coming for the USB dropouts through a dock. Any idea when? " +
      "Happy to test a beta.\n\nGrace",
    followups: [
      {
        kind: "outbound",
        author: "lucas",
        hoursAfter: 5,
        body:
          "Hi Grace,\n\nIt is in the next firmware, 1.8.3, and you are on the list for the beta. " +
          "I expect the build in about a week.\n\n" +
          "I will come back to you the moment it is ready rather than leaving you to chase.\n\n" +
          "Thanks for offering to test,\nLucas",
      },
      {
        kind: "note",
        author: "lucas",
        hoursAfter: 5.2,
        body: "Snoozed to the expected beta date. Grace is a good tester, worth keeping warm.",
      },
    ],
  },
  {
    key: "stock-notify-kestrel-10",
    subject: "When will the Kestrel 10 be back in stock?",
    contactKey: "customer:nora-haugen",
    category: "Getting started",
    team: "sales",
    audience: "b2c",
    priority: "low",
    status: "awaiting_followup",
    assignee: "giulia",
    channel: "web_form",
    createdHoursAgo: 260,
    followupInHours: 168,
    followupReason: "Tell Nora when the next Kestrel 10 batch lands",
    body: "The Kestrel 10 shows as out of stock. Can you let me know when it is available again?\n\nNora",
  },
  {
    key: "education-quote-chase",
    subject: "Quote for a film school location sound lab",
    contactKey: "dealer:fr-lyo",
    category: "Dealer and pricing",
    team: "sales",
    audience: "b2b",
    priority: "normal",
    status: "awaiting_followup",
    assignee: "giulia",
    channel: "email",
    createdHoursAgo: 330,
    followupInHours: 96,
    followupReason: "Chase the film school on the quote before it expires",
    body:
      "Bonjour Giulia,\n\nWe are quoting a film school for a location sound teaching kit: 10 Kestrel " +
      "Pocket Recorders, 10 Tripod Mounts and 10 Care Plans. They need the quote on headed paper for " +
      "their purchasing committee, which meets at the end of the month.\n\nAtelier Sonore",
    followups: [
      {
        kind: "outbound",
        author: "giulia",
        hoursAfter: 20,
        body:
          "Bonjour,\n\nQuote attached, valid for 60 days, with the education tier applied to all three " +
          "lines. I have put the committee date on it so purchasing can see it comfortably covers their " +
          "meeting.\n\n" +
          "Let me know if they want a demo unit ahead of the decision, we can usually arrange one.\n\n" +
          "Bien a vous,\nGiulia",
      },
    ],
  },

  // ── Closed, resolved ────────────────────────────────────────────────────
  {
    key: "replacement-shipped",
    subject: "Input board fault on a three month old unit",
    contactKey: "customer:claudine-moreau",
    category: "Returns and warranty",
    team: "support",
    audience: "b2c",
    priority: "high",
    status: "closed",
    closedReason: "resolved",
    assignee: "amina",
    language: "French",
    channel: "email",
    createdHoursAgo: 400,
    body:
      "Bonjour,\n\nDepuis hier, les trois premieres entrees de mon Kestrel 6 ne repondent plus: " +
      "aucun signal, aucune alimentation fantome. L'appareil a trois mois. Numero de serie RAL-K6-00302.\n\n" +
      "Merci,\nClaudine",
    followups: [
      {
        kind: "outbound",
        author: "amina",
        hoursAfter: 2,
        body:
          "Bonjour Claudine,\n\nMerci pour le numero de serie. Trois entrees voisines qui tombent " +
          "ensemble indiquent une panne de la carte d'entree, ce qui est couvert par la garantie.\n\n" +
          "Je lance un remplacement immediatement. Vous recevrez une etiquette de retour prepayee " +
          "aujourd'hui, et le nouvel appareil part des reception du votre.\n\n" +
          "Cordialement,\nAmina",
      },
      {
        kind: "note",
        author: "amina",
        hoursAfter: 2.2,
        body: "Input board fault, clearly in warranty. Advance replacement approved, told margot to reserve a unit.",
      },
      {
        kind: "inbound",
        hoursAfter: 50,
        body: "Le remplacement est arrive ce matin et fonctionne parfaitement. Merci beaucoup pour la rapidite.",
      },
    ],
    csat: {
      score: 5,
      comment: "Replacement arranged within hours and arrived in two days. Faultless.",
    },
  },
  {
    key: "customs-held-jp",
    subject: "Parcel held at customs in Tokyo",
    contactKey: "customer:hiroshi-kubo",
    category: "Shipping and delivery",
    team: "operations",
    audience: "b2c",
    priority: "high",
    status: "closed",
    closedReason: "resolved",
    assignee: "margot",
    channel: "email",
    createdHoursAgo: 520,
    body:
      "My order has been sitting at customs for a week. They are asking me for a commercial invoice " +
      "that I do not have. Can you send one?\n\nHiroshi",
    followups: [
      {
        kind: "outbound",
        author: "margot",
        hoursAfter: 3,
        body:
          "Hello Hiroshi,\n\nApologies for that, the commercial invoice should have travelled with the " +
          "parcel. I have attached it along with the customs declaration showing the HS codes and the " +
          "declared value.\n\n" +
          "Forward both to the customs office with your tracking number and they will normally release " +
          "it within two working days. If they ask for anything else, tell me and I will send it the " +
          "same day.\n\nBest,\nMargot",
      },
      {
        kind: "inbound",
        hoursAfter: 60,
        body: "Released yesterday and delivered this morning. Thank you.",
      },
    ],
    csat: {
      score: 4,
      comment: "Sorted quickly once I asked, but the paperwork should have been in the box.",
    },
  },
  {
    key: "refund-processed",
    subject: "Cancelled order still shows as charged",
    contactKey: "customer:lena-vos",
    category: "Billing and VAT",
    team: "finance",
    audience: "b2c",
    priority: "high",
    status: "closed",
    closedReason: "resolved",
    assignee: "henrik",
    channel: "email",
    createdHoursAgo: 610,
    body:
      "I cancelled order RAL-2180 before it shipped, and the charge is still on my card five days later. " +
      "Has the refund been sent?\n\nLena",
    followups: [
      {
        kind: "outbound",
        author: "henrik",
        hoursAfter: 4,
        body:
          "Hello Lena,\n\nYou are right, the cancellation was recorded but the refund had not been " +
          "released. I have issued it today for the full amount including shipping, and the credit note " +
          "is attached.\n\n" +
          "Your bank will usually show it within three to five working days. Sorry for the wait, that " +
          "should have gone out with the cancellation.\n\nBest regards,\nHenrik",
      },
    ],
    csat: {
      score: 4,
      comment: "Should not have needed chasing, but it was fixed the same day I asked.",
    },
  },
  {
    key: "acme-calibration-certificates",
    subject: "Calibration certificates for our last order",
    contactKey: "customer:jane-doe",
    category: "Getting started",
    team: "support",
    audience: "b2b",
    priority: "normal",
    status: "open",
    assignee: "lucas",
    channel: "email",
    createdHoursAgo: 4,
    body:
      "Hello,\n\nWe took delivery of our last order of Kestrel 6 recorders for the measurement lab. " +
      "Our quality process needs a calibration certificate for each unit before they go into service, " +
      "and none was in the boxes.\n\nCould you send them, or tell me where to download them?\n\n" +
      "Thanks,\nJane Doe\nPurchasing manager, Acme Instruments",
  },
  {
    key: "cable-set-missing",
    subject: "XLR cable set missing from my order",
    contactKey: "customer:pierre-caron",
    category: "Shipping and delivery",
    team: "operations",
    audience: "b2c",
    priority: "normal",
    status: "closed",
    closedReason: "resolved",
    assignee: "margot",
    channel: "email",
    createdHoursAgo: 700,
    body:
      "L'enregistreur est bien arrive mais le set de cables XLR n'etait pas dans le carton. " +
      "Commande RAL-2131.\n\nPierre",
    followups: [
      {
        kind: "outbound",
        author: "margot",
        hoursAfter: 5,
        body:
          "Bonjour Pierre,\n\nJe confirme, le set de cables n'a pas ete emballe avec l'enregistreur. " +
          "Il part aujourd'hui en envoi separe, sans frais, et vous recevrez le suivi ce soir.\n\n" +
          "Toutes mes excuses pour l'oubli.\n\nCordialement,\nMargot",
      },
    ],
    csat: { score: 5, comment: "Replacement sent the same day without any argument." },
  },
  {
    key: "firmware-rollback-help",
    subject: "Can I go back to the previous firmware?",
    contactKey: "customer:victor-hansen",
    category: "Firmware and software",
    team: "support",
    audience: "b2c",
    priority: "normal",
    status: "closed",
    closedReason: "resolved",
    assignee: "lucas",
    channel: "email",
    createdHoursAgo: 800,
    body: "I do not get on with the way the new limiter behaves on loud transients. Is there a way back to 1.7?\n\nVictor",
    followups: [
      {
        kind: "outbound",
        author: "lucas",
        hoursAfter: 6,
        body:
          "Hi Victor,\n\nYes, Kestrel Link keeps every release you have installed. Open Firmware, click " +
          "Show all versions, pick 1.7.4 and install it as normal. Your input setups carry across.\n\n" +
          "Worth knowing: 1.8 added a Limiter character setting under Input. Setting it to Classic gives " +
          "you the 1.7 behaviour without downgrading, which is what most people end up preferring.\n\n" +
          "Best,\nLucas",
      },
      {
        kind: "inbound",
        hoursAfter: 30,
        body: "Classic was exactly it. No need to downgrade, thanks.",
      },
    ],
    csat: {
      score: 5,
      comment: "Answered the question I asked and then the one I should have asked.",
    },
  },
  {
    key: "care-plan-explained",
    subject: "What does the Extended Care Plan actually cover?",
    contactKey: "customer:aisha-khan",
    category: "Returns and warranty",
    team: "support",
    audience: "b2c",
    priority: "low",
    status: "closed",
    closedReason: "resolved",
    assignee: "amina",
    channel: "web_form",
    createdHoursAgo: 900,
    body: "Considering the Care Plan. What does it add over the standard warranty?\n\nAisha",
    followups: [
      {
        kind: "outbound",
        author: "amina",
        hoursAfter: 7,
        body:
          "Hello Aisha,\n\nThe standard warranty is two years and covers manufacturing faults. The " +
          "Extended Care Plan takes that to four years and adds two things it does not cover: accidental " +
          "damage (one claim per year) and an advance replacement, so we ship the new unit before yours " +
          "reaches us.\n\n" +
          "It can be added at any point in the first 12 months, so there is no rush to decide today.\n\n" +
          "Best,\nAmina",
      },
    ],
  },
  {
    key: "dealer-display-units",
    subject: "Display units for our shop floor",
    contactKey: "dealer:jp-tky",
    category: "Dealer and pricing",
    team: "sales",
    audience: "b2b",
    priority: "normal",
    status: "closed",
    closedReason: "resolved",
    assignee: "giulia",
    channel: "email",
    createdHoursAgo: 1000,
    body:
      "We would like two display units for the shop floor, one Kestrel 6 and one Kestrel 10. What is the " +
      "demo unit arrangement?\n\nHarborlight Audio",
    followups: [
      {
        kind: "outbound",
        author: "giulia",
        hoursAfter: 12,
        body:
          "Hello,\n\nDemo units are at 50 percent of dealer price, one per model per store, on the " +
          "understanding they stay on the floor and are not resold as new. If you later sell one as " +
          "ex-demo that is fine, just tell us so the serial is recorded correctly for warranty.\n\n" +
          "I have added both to your next shipment.\n\nBest,\nGiulia",
      },
    ],
    csat: { score: 5, comment: "Clear terms, no back and forth." },
  },
  {
    key: "psu-region-plug",
    subject: "Wrong plug type on the power supply",
    contactKey: "customer:clara-mendes",
    category: "Shipping and delivery",
    team: "operations",
    audience: "b2c",
    priority: "normal",
    status: "closed",
    closedReason: "resolved",
    assignee: "margot",
    channel: "email",
    createdHoursAgo: 1100,
    body: "The power supply that arrived has a European plug. I am in Brazil.\n\nClara",
    followups: [
      {
        kind: "outbound",
        author: "margot",
        hoursAfter: 9,
        body:
          "Hello Clara,\n\nThat is our error, the region should have been picked up from your address. " +
          "A Brazilian unit is on its way today at no charge and you do not need to return the other " +
          "one, keep it as a spare.\n\nSorry for the inconvenience.\n\nBest,\nMargot",
      },
    ],
    csat: { score: 5, comment: "Fixed immediately and they let me keep the spare." },
  },

  // ── Closed for other reasons ────────────────────────────────────────────
  {
    key: "spam-seo-offer",
    subject: "Boost your website ranking guaranteed",
    contactKey: "customer:daniel-okafor",
    category: "Getting started",
    team: "support",
    audience: "b2c",
    priority: "low",
    status: "closed",
    closedReason: "spam",
    channel: "web_form",
    createdHoursAgo: 150,
    body:
      "Dear Sir or Madam, we noticed your website is not ranking on the first page. Our team can " +
      "guarantee first page placement within 30 days for a small monthly fee. Reply for a free audit.",
  },
  {
    key: "no-response-fault",
    subject: "Something wrong with my recorder",
    contactKey: "customer:amelie-roux",
    category: "Hardware fault",
    team: "support",
    audience: "b2c",
    priority: "normal",
    status: "closed",
    closedReason: "no_response",
    assignee: "lucas",
    channel: "email",
    createdHoursAgo: 950,
    body: "It is not working properly. Please help.\n\nAmelie",
    followups: [
      {
        kind: "outbound",
        author: "lucas",
        hoursAfter: 4,
        body:
          "Hi Amelie,\n\nSorry to hear that. So I can help, could you tell me a little more:\n\n" +
          "1. Which model is it, and what is the serial number on the base?\n" +
          "2. What happens when it is not working properly: no signal, no display, an error on the card?\n" +
          "3. Does it do the same with a different card and a different microphone?\n\n" +
          "Best,\nLucas",
      },
      {
        kind: "note",
        author: "lucas",
        hoursAfter: 340,
        body: "Two reminders sent, no reply in a fortnight. Closing as no response, will reopen if she writes back.",
      },
    ],
  },

  // ── The merge pair ──────────────────────────────────────────────────────
  {
    key: "merge-target-delay",
    subject: "Delivery delay on order RAL-2244",
    contactKey: "customer:sara-lindqvist",
    category: "Shipping and delivery",
    team: "operations",
    audience: "b2c",
    priority: "normal",
    status: "open",
    assignee: "margot",
    channel: "email",
    createdHoursAgo: 46,
    body:
      "My order was due Tuesday and has not arrived. Tracking says it is still at the sorting hub. " +
      "Can you chase it?\n\nSara",
  },
  {
    key: "merge-source-delay",
    subject: "Following up on my delayed parcel",
    contactKey: "customer:sara-lindqvist",
    category: "Shipping and delivery",
    team: "operations",
    audience: "b2c",
    priority: "normal",
    status: "open",
    channel: "email",
    createdHoursAgo: 25,
    body:
      "Me again about RAL-2244, I do not think my first message got through. The parcel still has not " +
      "moved.\n\nSara",
  },

  // ── The duplicate ───────────────────────────────────────────────────────
  {
    key: "duplicate-form-submit",
    subject: "Gain question",
    contactKey: "customer:marta-nowak",
    category: "Getting started",
    team: "support",
    audience: "b2c",
    priority: "low",
    status: "closed",
    closedReason: "duplicate",
    channel: "web_form",
    createdHoursAgo: 26.1,
    body:
      "My meters go red on anything loud but the file sounds clean once I turn it down. " +
      "What am I doing wrong?\n\nMarta",
  },

  // ── The two reopened ones ───────────────────────────────────────────────
  {
    key: "reopened-hiss",
    subject: "The hiss is back after the replacement",
    contactKey: "customer:jasper-nilsson",
    category: "Hardware fault",
    team: "support",
    audience: "b2c",
    priority: "high",
    status: "open",
    assignee: "amina",
    channel: "email",
    createdHoursAgo: 430,
    reopened: true,
    body: "The replacement preamp was fine for a fortnight and the hiss has come back, same as before.\n\nJasper",
    followups: [
      {
        kind: "outbound",
        author: "amina",
        hoursAfter: 5,
        body:
          "Hi Jasper,\n\nA replacement developing the same fault points at something outside the preamp, " +
          "so let us not just send a third one.\n\n" +
          "Could you try it in a completely different room on a different circuit, with nothing else " +
          "connected and nothing plugged into the recorder but the preamp link? If it is silent there we " +
          "are looking at a ground loop in your studio, and I can talk you through fixing that " +
          "properly.\n\nBest,\nAmina",
      },
      {
        kind: "inbound",
        hoursAfter: 200,
        body: "Sorry to reopen this. It was quiet in the other room, but back in the studio the hiss returned.",
      },
      {
        kind: "note",
        author: "amina",
        hoursAfter: 202,
        body:
          "Reopened. Confirmed it is the studio, not the preamp. Sending the ground loop guide and an " +
          "isolating transformer on us rather than a third replacement.",
      },
    ],
  },
  {
    key: "reopened-invoice",
    subject: "Reissued invoice still has the old address",
    contactKey: "dealer:eu-de",
    category: "Billing and VAT",
    team: "finance",
    audience: "b2b",
    priority: "normal",
    status: "open",
    assignee: "henrik",
    channel: "email",
    createdHoursAgo: 340,
    reopened: true,
    body:
      "Thanks for reissuing, but the replacement still shows our old registered address. " +
      "Could you correct it and send it again?",
    followups: [
      {
        kind: "note",
        author: "henrik",
        hoursAfter: 1,
        body:
          "Reopened: the reissue picked up the cached billing address, not the updated one. " +
          "Worth checking whether that affects other reissues this quarter.",
      },
    ],
  },

  // ── Unassigned backlog ──────────────────────────────────────────────────
  {
    key: "bug-app-crash",
    subject: "Kestrel Link crashes on launch after update",
    contactKey: "customer:daniel-okafor",
    category: "Firmware and software",
    team: "support",
    audience: "b2c",
    priority: "high",
    status: "open",
    channel: "api",
    createdHoursAgo: 14,
    body:
      "Submitted from the in app reporter.\n\n" +
      "Kestrel Link quits immediately on launch since updating. It shows the splash screen and " +
      "disappears. Reinstalling did not help. There is no crash dialog.",
  },
  {
    key: "case-zip-failure",
    subject: "Zip on the travel case has split",
    contactKey: "customer:grace-whitfield",
    category: "Returns and warranty",
    team: "support",
    audience: "b2c",
    priority: "normal",
    status: "open",
    channel: "email",
    createdHoursAgo: 60,
    body: "The zip on my Kestrel Travel Case has split after about two months of use.\n\nGrace",
  },
  {
    key: "social-mention-runtime",
    subject: "Question asked publicly about battery runtime",
    contactKey: "customer:ivan-petrov",
    category: "Getting started",
    team: "support",
    audience: "b2c",
    priority: "low",
    status: "open",
    channel: "social",
    createdHoursAgo: 38,
    body:
      "Picked up from a public post: 'loving the Kestrel 6 but what is the real battery runtime with " +
      "phantom power on all six inputs? cannot find a number anywhere'",
  },
  {
    key: "dealer-rma-batch",
    subject: "Three units for warranty return",
    contactKey: "dealer:eu-de",
    category: "Returns and warranty",
    team: "operations",
    audience: "b2b",
    priority: "high",
    status: "open",
    channel: "email",
    createdHoursAgo: 78,
    body:
      "We have three customer returns to send back under warranty: two Kestrel 6 recorders with dead " +
      "inputs and one Kestrel 10 that will not power on. Can you raise an RMA for the batch and send " +
      "one label for all three?",
  },

  // ── The long one ────────────────────────────────────────────────────────
  //
  // The queue's longest thread, and the one a tour opens on a phone: a dealer
  // chasing a warranty repair over four days, answered, chased again, argued
  // out between two colleagues in a note, and closed with a decision. Seven
  // messages in the order a real one arrives in, each paragraph short enough
  // to read on a handset and long enough to be prose.
  {
    key: "dealer-repair-chase",
    subject: "Where is the repaired Kestrel 10 we sent in on the 9th?",
    contactKey: "dealer:uk-ldn",
    category: "Returns and warranty",
    team: "operations",
    audience: "b2b",
    priority: "high",
    status: "closed",
    closedReason: "resolved",
    assignee: "margot",
    channel: "email",
    createdHoursAgo: 96,
    body:
      "Good morning,\n\n" +
      "We sent a Kestrel 10 back to you under warranty on the 9th, RMA number RAL-RMA-0117, and we have " +
      "heard nothing since the carrier confirmed delivery. The customer has been without it for three " +
      "weeks and has started asking us for a refund instead.\n\n" +
      "Could you tell us where it is in the repair queue and, more usefully, when it is going back out? " +
      "We can hold the customer if we can give them a date. We cannot hold them on nothing.\n\n" +
      "Thanks,\nNorthfield Instruments",
    followups: [
      {
        kind: "outbound",
        author: "margot",
        hoursAfter: 3,
        body:
          "Hello,\n\n" +
          "Thank you for the RMA number, that made it quick to find. The unit arrived on the 11th and " +
          "is logged as a power fault, which matches what you described on the form.\n\n" +
          "It is sitting behind two others in the bench queue at the moment. The honest estimate is " +
          "that the bench reaches it on Thursday and it ships back Friday, so with transit your " +
          "customer would have it early next week.\n\n" +
          "I would rather give you that date than a better one I cannot keep. If anything slips I will " +
          "write to you the same day rather than let you find out from the tracking page.\n\n" +
          "Best,\nMargot",
      },
      {
        kind: "inbound",
        hoursAfter: 27,
        body:
          "Thanks Margot, that helps. One thing though: the customer bought the unit in March last year, " +
          "so the original warranty runs out in about six weeks.\n\n" +
          "If the repair uses the same power board that failed the first time, are we going to be doing " +
          "this again in two months with no cover left? They have already been quite patient and I do " +
          "not want to sell them a second disappointment.",
      },
      {
        kind: "note",
        author: "margot",
        hoursAfter: 29,
        body:
          "Lucas, this is the third Kestrel 10 power fault from the same production window that I have " +
          "seen this quarter. The bench keeps swapping the board and sending it back, and we keep " +
          "starting a fresh clock on a part we already know is weak.\n\n" +
          "Before I answer the dealer: do we have a position on the warranty period after a repair, or " +
          "am I inventing one here?",
      },
      {
        kind: "outbound",
        author: "lucas",
        hoursAfter: 34,
        body:
          "Hello,\n\n" +
          "Margot pulled me in on the warranty question, so let me answer it properly rather than " +
          "leave it hanging.\n\n" +
          "A repaired unit carries the remainder of its original warranty or ninety days from the " +
          "repair, whichever is longer, and that is the policy rather than a favour for this case. So " +
          "your customer will be covered into the new year, not for six more weeks.\n\n" +
          "On the part itself: you are right to ask. The bench is fitting the revised power board, not " +
          "another of the originals, so the repair is not a replay of the same failure.\n\n" +
          "Best,\nLucas",
      },
      {
        kind: "inbound",
        hoursAfter: 50,
        body:
          "That is exactly what I needed, thank you both. I have told the customer the date and the " +
          "cover, and they are happy to wait now that there is something concrete.\n\n" +
          "Please do let me know when it actually leaves you, and I will pass the tracking on.",
      },
      {
        kind: "outbound",
        author: "margot",
        hoursAfter: 74,
        body:
          "Hello,\n\n" +
          "The Kestrel 10 left us this afternoon, a day earlier than I promised, and the tracking number " +
          "is in the shipping mail that went out alongside this one. The revised power board is fitted " +
          "and the bench ran it for two hours on the supply, with all ten inputs loaded, before packing " +
          "it.\n\n" +
          "The repair date is on the paperwork inside the box, so your customer has the ninety day " +
          "cover in writing without having to take our word for it.\n\n" +
          "I am closing this one here. If the unit gives you any trouble at all, reply to this message " +
          "and it comes straight back to me.\n\n" +
          "Best,\nMargot",
      },
    ],
  },
]

export const KNOWLEDGE_COLLECTIONS: KnowledgeCollectionSpec[] = [
  {
    key: "policies",
    name: "Policies",
    description: "What we promise customers and dealers, and the rules we hold ourselves to.",
    owner: "amina",
  },
  {
    key: "procedures",
    name: "Support procedures",
    description: "How the desk actually handles a return, a refund, an RMA and a dealer request.",
    owner: "amina",
  },
  {
    key: "products",
    name: "Product guides",
    description: "Troubleshooting and setup, one guide per flagship product.",
    owner: "lucas",
  },
]

export const ARTICLE_SPECS: ArticleSpec[] = [
  {
    key: "warranty-policy",
    title: "Warranty policy",
    collection: "policies",
    owner: "amina",
    summary: "Two years on every product, four with the Extended Care Plan, and what is excluded.",
    tags: ["warranty", "policy"],
    reviewDueInDays: 120,
    verified: true,
    body:
      `Audience: whole company, shared with dealers on request.\n` +
      `Visibility: internal, organization wide.\n` +
      `Source: policy owner Amina Cherif (Customer Support Lead), approved by Elodie Vasseur.\n` +
      `Status: verified.\n\n` +
      `1. Summary\n` +
      `Every Resonant Audio Labs product carries a two year warranty from the date of delivery, ` +
      `covering manufacturing defects and component failure under normal use. The Extended Care Plan ` +
      `(RAL-ACC-CARE, 79.00 EUR list) raises this to four years total and adds one accidental damage ` +
      `claim per year plus advance replacement, where we ship the new unit before the faulty one has ` +
      `even reached us. This article is the one source of truth for what is covered, what is not, and ` +
      `how a claim gets from a first reply to a closed ticket. If a reply to a customer disagrees with ` +
      `this article, the article is right and the reply gets corrected, not the other way around.\n\n` +
      `2. Coverage window\n` +
      `2.1 Standard warranty: 24 months from the delivery date on the order, not the manufacture date ` +
      `and not the date the customer first opens the box.\n` +
      `2.2 Extended Care Plan: 48 months total from the same delivery date, purchased either alongside ` +
      `the unit or within its first 30 days. A Care Plan bought after day 30 does not retroactively ` +
      `cover a fault that already happened.\n` +
      `2.3 The warranty clock never resets on a warranty replacement. Section 6 covers this in detail: ` +
      `a replacement unit inherits the ORIGINAL delivery date, it does not start a fresh two years.\n\n` +
      `3. What is covered\n` +
      `3.1 Input board failures: one or more adjacent inputs that pass no signal at all, or an input ` +
      `stage that reads as dead in the recorder's own meters and in Kestrel Link's channel view.\n` +
      `3.2 An individual input whose noise floor sits well above the published figure and stays there ` +
      `after a Reset input stage pass in Kestrel Link.\n` +
      `3.3 Power supply failure, including a Kestrel Power Supply (RAL-ACC-PSU) that has stopped ` +
      `delivering rated output, and a battery sled that no longer charges or no longer holds a charge ` +
      `inside the warranty window.\n` +
      `3.4 Connectivity and media faults not explained by the customer's own card, cable, hub or USB ` +
      `port. Rule this out with a different card, a different cable and a different computer before ` +
      `treating it as covered; see the per product troubleshooting guides for the exact steps.\n` +
      `3.5 Finish defects: a scratch, a misaligned panel, or a cosmetic flaw present out of the box, ` +
      `reported within 30 days of delivery. After 30 days a cosmetic complaint is not a warranty ` +
      `matter, only a functional one is.\n` +
      `3.6 Phantom power faults on the Kestrel Field Preamp, meaning a channel that does not hold 48 ` +
      `volts under a normal condenser load, and gain drift on a preamp channel beyond what a Reset ` +
      `input stage pass corrects.\n\n` +
      `4. What is not covered\n` +
      `4.1 Liquid damage of any kind, on any product, at any time, Care Plan or not. This is the one ` +
      `absolute exclusion in this policy and it has no exception path. Say so plainly and do not offer ` +
      `to check with anyone.\n` +
      `4.2 Drops and impact damage, UNLESS an active Care Plan is on the account, in which case one ` +
      `accidental damage claim per twelve month period is covered under section 5.\n` +
      `4.3 Cosmetic wear from normal use: worn rubber feet, faded silkscreen, scuffed enclosure edges, ` +
      `a windjammer that has shed fur after a season outdoors. This is expected aging, not a defect.\n` +
      `4.4 Consumable items: windshields and cables are covered for defects for 90 days from delivery, ` +
      `then they are treated as consumables and a replacement is a paid accessory order, not a claim.\n` +
      `4.5 Any unit opened, modified or repaired by a third party. Look for tamper evidence on the ` +
      `enclosure screws before approving a claim; if in doubt, escalate to Margot Dufour rather than ` +
      `guessing.\n` +
      `4.6 Damage from use outside the documented power range, including a non Resonant power supply ` +
      `on the Kestrel 10 Field Recorder, which is the single most common cause of a denied claim on ` +
      `that model.\n\n` +
      `5. The Extended Care Plan in detail\n` +
      `5.1 One accidental damage claim per rolling twelve months, covering drops, impact and similar ` +
      `physical damage that the standard warranty excludes. A second claim inside the same twelve ` +
      `months is a paid repair, quoted by Margot.\n` +
      `5.2 Advance replacement: on any covered claim, we ship the replacement unit before the faulty ` +
      `one arrives back with us, rather than waiting for inspection first. This is the Care Plan's main ` +
      `practical benefit and support should lead with it when a Care Plan customer is anxious about ` +
      `downtime, which on this product usually means a shoot or a session already in the diary.\n` +
      `5.3 The Care Plan itself is a purchasable accessory (RAL-ACC-CARE) and follows the accessory ` +
      `return window described in the return procedure article, not this one, if the customer wants ` +
      `to cancel the plan itself rather than claim against it.\n\n` +
      `6. Proof of purchase and dealer sales\n` +
      `6.1 The serial number is sufficient proof of purchase. Every unit sold direct or through a ` +
      `dealer is in our records against its serial. Never ask a customer to dig up a receipt we can ` +
      `look up ourselves; it reads as distrust and it is unnecessary.\n` +
      `6.2 The warranty is Resonant Audio Labs' obligation, not the dealer's. A customer who bought ` +
      `from Klangwerk GmbH, Northfield Instruments, Atelier Sonore, Kanaal Audio, Harborlight Audio or ` +
      `Westcoast Pro Audio comes to us directly for a warranty claim and we handle it end to end. Do ` +
      `not send them back to the shop; that shifts the customer's cost of proving the claim onto the ` +
      `dealer relationship for no reason.\n` +
      `6.3 Replacement serial recording: when a unit is replaced under warranty, the new serial is ` +
      `recorded against the ORIGINAL sale record, and the warranty end date carried forward is the ` +
      `original delivery date plus the applicable window (24 or 48 months), never a fresh window from ` +
      `the replacement date. See the RMA procedure article for the operational steps.\n\n` +
      `7. Claim workflow, step by step\n` +
      `7.1 First reply: acknowledge the report, ask for the serial number if it is not already on the ` +
      `account, and follow the tone of voice article's rule not to argue about coverage before the ` +
      `facts are on the table.\n` +
      `7.2 Diagnose: run the relevant product troubleshooting guide before assuming a fault is covered. ` +
      `Most dropout, card and noise floor reports resolve without ever becoming a warranty claim.\n` +
      `7.3 Confirm coverage: check the fault against sections 3 and 4 above. A borderline case, meaning ` +
      `one that does not map cleanly onto either list, is escalated per the escalation article's ` +
      `hardware fault route rather than decided alone on the desk.\n` +
      `7.4 Raise the RMA: once coverage is confirmed, the RMA procedure article takes over from here, ` +
      `covering the label, the batch process for dealers, and the testing on arrival.\n` +
      `7.5 Close the loop: tell the customer what happens next and roughly when, matching the tone of ` +
      `voice rule to always say what happens next.\n\n` +
      `8. International claims\n` +
      `8.1 A warranty claim from outside France follows the same coverage rules in this article; only ` +
      `the shipping and customs handling differs.\n` +
      `8.2 A replacement shipped outside the EU is a zero rated export like any other shipment, and the ` +
      `return of the faulty unit is marked returned goods on the customs declaration so import VAT is ` +
      `not charged twice; see the VAT, customs and invoicing outside the EU article for the full rule.\n` +
      `8.3 A dealer batch RMA that crosses a border, for example a UK customer's unit returned through ` +
      `Northfield Instruments, still follows the single RMA and single label rule in the RMA procedure ` +
      `article; the customs paperwork travels with that one shipment, not per unit inside it.\n\n` +
      `9. Common denial reasons, and how to explain one\n` +
      `9.1 Liquid damage evidence, most often corrosion visible through the USB C port, inside an XLR ` +
      `shell or on the card contacts after a wet location shoot. Explain plainly, using the language in ` +
      `section 4.1, rather than hedging.\n` +
      `9.2 A non Resonant power supply used with the Kestrel 10 Field Recorder, identified by the ` +
      `voltage or current mismatch recorded in the diagnostics export. Point the customer at the correct ` +
      `accessory and explain the denial is about the accessory, not a judgement about the customer.\n` +
      `9.3 Tamper evidence on the enclosure screws. This one is rare and worth a second opinion from ` +
      `Margot before it is communicated to the customer as final, since a damaged screw head from a ` +
      `single legitimate attempt to check a battery sled is not the same thing as a full disassembly.\n` +
      `9.4 A claim outside the coverage window entirely: 24 months with no Care Plan, 48 with one. State ` +
      `the exact delivery date and the exact window in the reply so the calculation is visible, not just ` +
      `asserted.\n\n` +
      `10. Quick reference summary\n` +
      `Standard: 24 months from delivery. Care Plan: 48 months, one accidental damage claim per year, ` +
      `advance replacement. Covered: input board and noise floor faults, PSU and battery sled failure, ` +
      `phantom power and gain drift on the preamp, connectivity and media faults not explained by the ` +
      `customer's own gear, finish defects within 30 days. Not covered ever: liquid damage. Not covered ` +
      `without Care Plan: drops and impact. Proof needed: serial number only. ` +
      `Dealer sold: still our claim to handle, directly with the customer. International: same coverage, ` +
      `export and returned goods rules apply to the logistics only.\n\n` +
      `11. Open questions to resolve with the team\n` +
      `11.1 Whether a Care Plan should be transferable to a second owner on a private resale; currently ` +
      `undecided, treat as non transferable until Elodie rules on it.\n` +
      `11.2 Whether the 90 day consumable window on cables should extend to 12 months to match a ` +
      `pending change in the EU sold goods guarantee guidance; flagged to Henrik for the next policy ` +
      `review.\n` +
      `11.3 Whether section 9.3 (tamper evidence) needs a formal second opinion requirement written into ` +
      `this article rather than left as a norm; raised after a claim was denied and then reinstated on ` +
      `appeal last quarter.`,
  },
  {
    key: "return-procedure",
    title: "Return procedure",
    collection: "procedures",
    owner: "amina",
    summary: "The 30 day window, how to raise a label, and when a refund is released.",
    tags: ["returns", "procedure"],
    reviewDueInDays: 90,
    verified: true,
    body:
      `Customers may return any product within 30 days of delivery for a full refund, including the ` +
      `original shipping cost paid on the order. This is a change of mind return: it is separate from ` +
      `an RMA, which is a warranty claim against a fault, and separate from the refund edge cases ` +
      `article, which covers the unusual cases (gifts, duplicate charges, chargebacks) that this ` +
      `article does not.\n\n` +
      `Step 1: check the window and the condition\n` +
      `An item that is unused and in its original packaging is straightforward: accept it without ` +
      `discussion. A used item within the 30 day window is still accepted, with a restocking deduction ` +
      `applied only where the condition means the unit cannot be resold as new, for example a scuffed ` +
      `enclosure or a missing accessory. State the deduction amount to the customer before processing ` +
      `it, never as a surprise on the refund total.\n\n` +
      `Step 2: raise the return\n` +
      `Create the return against the order, which generates a prepaid label and a drop off code. Both ` +
      `go to the customer by mail the same day. Never ask a customer to pay for return shipping on a ` +
      `change of mind return within the window; the shipping cost is on us, it is part of the offer.\n\n` +
      `Step 3: on arrival\n` +
      `Fulfillment inspects and marks the return received. The refund releases automatically to the ` +
      `original payment method the moment the return is marked received, and normally shows on the ` +
      `customer's statement within three working days.\n\n` +
      `Step 4: close the loop\n` +
      `Tell the customer the refund has gone out, with the exact amount. Do not leave them to notice it ` +
      `on their own statement; a proactive confirmation is one of the cheapest trust building moves we ` +
      `have.\n\n` +
      `Outside the window\n` +
      `Between 30 and 60 days after delivery we offer store credit rather than a cash refund, at the ` +
      `full purchase price. Beyond 60 days a change of mind return is no longer offered at all; from ` +
      `that point a request about a faulty unit is a warranty question and belongs with the RMA ` +
      `procedure and the Warranty policy article, not this one.\n\n` +
      `Dealer purchases\n` +
      `A change of mind return on a unit bought from a dealer is the dealer's own policy, not ours: ` +
      `point the customer back to where they bought it. This is the one place in the customer journey ` +
      `where we DO send them back to the shop, and it is worth explaining why if asked: we do not hold ` +
      `the sale record or the payment to refund against.\n\n` +
      `Accessories bundled with a flagship order\n` +
      `An accessory bought as part of the same order as a flagship unit follows the same 30 day window, ` +
      `and can be returned on its own without returning the unit, provided it is unused. An Extended ` +
      `Care Plan bought alongside a unit is the one exception: see the refund policy edge cases article ` +
      `for how a bundled Care Plan is handled if the unit itself is returned.\n\n` +
      `International returns\n` +
      `A change of mind return from outside the EU still uses a prepaid label and still refunds in full ` +
      `within the 30 day window; the only difference is the customs handling on the way back, which is ` +
      `marked returned goods per the VAT, customs and invoicing outside the EU article so the customer ` +
      `is never charged import VAT twice across the return.\n\n` +
      `Why 30 days, not shorter\n` +
      `A shorter window would mean more borderline cases where a customer just missed the deadline, ` +
      `which produces exactly the kind of unhappy exception conversation the policy is meant to avoid. ` +
      `30 days gives a customer enough time to rig the recorder and take it out on a real job before ` +
      `deciding, which is when a change of mind decision is a genuine one rather than a rushed one.\n\n` +
      `Message template, English, confirming a return and the refund timing\n` +
      `"Your return is confirmed, and a prepaid label is on its way to you by email along with the drop ` +
      `off code. Once it is received and checked, which normally takes a few working days, your refund ` +
      `of [AMOUNT] will be released to your original payment method and should show within three ` +
      `working days after that."`,
  },
  {
    key: "dealer-pricing-tiers",
    title: "Dealer pricing tiers",
    collection: "policies",
    owner: "giulia",
    summary: "The four volume tiers, what counts towards a threshold, and demo unit terms.",
    tags: ["dealer", "pricing"],
    reviewDueInDays: 60,
    verified: true,
    body:
      `Dealer pricing is banded by flagship units ordered in a rolling twelve months, counted across ` +
      `every flagship model together: a mix of Kestrel 6 recorders, Kestrel 10 recorders, Pockets and ` +
      `Field Preamps all count toward the same running total.\n\n` +
      `Tier 1, 1 to 5 units: 25 percent off list.\n` +
      `Tier 2, 6 to 15 units: 32 percent off list.\n` +
      `Tier 3, 16 to 40 units: 38 percent off list.\n` +
      `Tier 4, 41 units and above: 42 percent off list, negotiated annually with Giulia and Elodie.\n\n` +
      `What counts\n` +
      `Flagship products only: Kestrel 6 Field Recorder, Kestrel 10 Field Recorder, Kestrel Pocket ` +
      `Recorder and the Kestrel Field Preamp. Accessories are always at a flat 30 percent and do NOT ` +
      `move a dealer up a tier, which is the question dealers ask most often and the one worth getting ` +
      `right in the first reply.\n\n` +
      `Every new dealer starts at Tier 1 regardless of a forecast or a projected volume: see the ` +
      `dealer onboarding article for why we never pre-assign a higher tier on a promise. A dealer moves ` +
      `up automatically once their rolling twelve month volume actually clears the next threshold, and ` +
      `moves down at the next quarterly review if it falls back under one, with 90 days notice before ` +
      `the lower rate takes effect so a dealer is never surprised mid order.\n\n` +
      `Education accounts\n` +
      `A film school, conservatoire or university buying for a teaching kit gets Tier 3 pricing from ` +
      `the first unit, regardless of volume, on a named purchase order. This is a standing exception, ` +
      `not a discretionary one; support and sales can both apply it without asking Giulia first.\n\n` +
      `Demo units\n` +
      `One per model per store at 50 percent of dealer price, on the understanding they stay on the ` +
      `floor for customers to try. Selling a demo unit on afterwards is fine provided the serial is ` +
      `reported to us so warranty records stay correct: an unreported demo sale is the most common ` +
      `cause of a warranty lookup failing later.\n\n` +
      `Quotes and stacking\n` +
      `Quotes are valid for 60 days. Beyond that the tier is rechecked before the order is accepted, in ` +
      `case the dealer's rolling volume has moved. Dealer tier pricing never stacks with a discretionary ` +
      `discount under the pricing approvals article: a dealer gets their tier rate, full stop, not their ` +
      `tier rate plus a goodwill discount on top.\n\n` +
      `Worked example\n` +
      `A dealer with 14 flagship units in their rolling twelve months (Tier 2, 32 percent off) places an ` +
      `order that would bring them to 17 units. The order itself is priced at Tier 2, since the tier ` +
      `check happens against the volume BEFORE the order, not an anticipated volume after it; the ` +
      `dealer moves to Tier 3 for their NEXT order once the 17 units are confirmed and on record, not ` +
      `retroactively on the order that crossed the threshold.\n\n` +
      `Currency and invoicing\n` +
      `Every dealer in the current network is invoiced in EUR regardless of territory, including ` +
      `Harborlight Audio KK in Japan and Westcoast Pro Audio LLC in the United States; see the VAT, ` +
      `customs and invoicing outside the EU article for how those two invoices are treated for VAT and ` +
      `customs purposes.\n\n` +
      `Reviewing a dealer's tier\n` +
      `Tiers are reviewed quarterly by Giulia, using the rolling twelve month order record, not a ` +
      `manual tally kept anywhere else. A dealer disputing their tier is asked which orders they believe ` +
      `should count, and the record is checked against those specific orders rather than re-litigating ` +
      `the whole twelve months from memory.`,
  },
  {
    key: "vat-eu",
    title: "VAT and invoicing inside the EU",
    collection: "policies",
    owner: "henrik",
    summary:
      "When to charge French VAT, when to reverse charge, and what a valid number looks like.",
    tags: ["vat", "invoicing", "finance"],
    reviewDueInDays: 45,
    verified: true,
    body:
      `We are established in France, so the VAT treatment of a sale depends on who the customer is ` +
      `and where they are, not on where the product ships from.\n\n` +
      `French customers, private or business: French VAT at the standard rate, always, no exceptions.\n\n` +
      `Other EU, private customer: French VAT, until the distance selling threshold is crossed for that ` +
      `customer's country, at which point the local rate applies through our one stop shop (OSS) ` +
      `registration instead. Henrik tracks the running total per country; support and sales never need ` +
      `to calculate this themselves, only flag a large private order for Henrik to check.\n\n` +
      `Other EU, business with a valid VAT number: reverse charge. No VAT is charged on the invoice and ` +
      `the invoice must carry both parties' VAT numbers plus the words reverse charge.\n\n` +
      `Validating a number\n` +
      `Always validate the customer's VAT number before applying the reverse charge, and record the ` +
      `validation date on the account. An invalid or expired number means we charge French VAT instead, ` +
      `and the customer reclaims it themselves through their own tax authority. Applying the reverse ` +
      `charge to a number that was never validated leaves Resonant Audio Labs owing the VAT if it is ` +
      `later found invalid, so this step is never optional, even for a dealer we have worked with for ` +
      `years.\n\n` +
      `Reissuing\n` +
      `A customer who bought privately and later wants a business invoice with a different VAT ` +
      `treatment gets a credit note against the original invoice and a fresh invoice, never an edited ` +
      `one. The original document number is never reused, and the credit note references the invoice ` +
      `it cancels by number so the audit trail stays intact. This is the single most common finance ` +
      `request from a freelance location recordist who bought as a private customer and then registered ` +
      `a company.\n\n` +
      `This article covers sales inside the EU only. A sale to a customer outside the EU, including the ` +
      `United Kingdom, follows the VAT, customs and invoicing outside the EU article instead.\n\n` +
      `Dealer sales inside the EU\n` +
      `Every current EU dealer, Klangwerk GmbH (Germany), Atelier Sonore SARL (France) and Kanaal Audio ` +
      `BV (Netherlands), holds a valid VAT number on file and buys on reverse charge terms. Atelier ` +
      `Sonore, being French, is the one exception worth remembering: a French dealer buying from a ` +
      `French supplier is a normal domestic sale, French VAT applies, and reverse charge does not enter ` +
      `into it at all. Reverse charge is specifically a cross border EU business to business mechanism.\n\n` +
      `Rate changes\n` +
      `The standard French rate and any other EU country's local rate under the OSS scheme can change; ` +
      `Henrik owns tracking this and updating the invoicing system, and support or sales should never ` +
      `apply a rate from memory on an order that looks unusual, for example a large order to a country ` +
      `close to crossing its distance selling threshold.\n\n` +
      `Worked example\n` +
      `A private customer in the Netherlands orders a Kestrel Pocket Recorder. Their country has not yet ` +
      `crossed the distance selling threshold this year, so French VAT applies and the invoice looks ` +
      `identical to a French customer's, just with a Dutch shipping address. If the same customer's ` +
      `country crosses the threshold later in the year, the NEXT order from a Dutch private customer ` +
      `switches to the Dutch rate through OSS; the switch is per threshold crossing, not backdated to ` +
      `earlier orders in the year.`,
  },
  {
    key: "vat-non-eu",
    title: "VAT, customs and invoicing outside the EU",
    collection: "policies",
    owner: "henrik",
    summary:
      "Zero rated exports, the paperwork that must travel with the parcel, and who pays duty.",
    tags: ["vat", "customs", "finance"],
    reviewDueInDays: 45,
    verified: true,
    body:
      `Audience: whole company, dealers get the customs pack version rather than this article.\n` +
      `Visibility: internal, organization wide.\n` +
      `Source: policy owner Henrik Sandberg (Finance Manager), operational steps co-owned with Margot ` +
      `Dufour (Fulfillment Coordinator).\n` +
      `Status: verified.\n\n` +
      `1. Summary\n` +
      `Sales to customers outside the European Union, including the United Kingdom, are zero rated ` +
      `exports: no French VAT is charged, and the invoice states plainly that it is an export outside ` +
      `the European Union. This is the single most consequential article for anyone touching an ` +
      `international order, because getting the paperwork wrong is the leading cause of a delayed ` +
      `parcel and an upset customer, not a slow carrier.\n\n` +
      `2. Paperwork that must travel with the parcel\n` +
      `2.1 A commercial invoice showing the transaction value actually paid, never the list price if a ` +
      `discount or dealer rate applied.\n` +
      `2.2 A customs declaration carrying the correct HS code and declared value for every line in the ` +
      `shipment. See the HS codes and product classification article for the exact codes per SKU; do ` +
      `not guess or reuse a code from a similar looking product.\n` +
      `2.3 If either document is missing or the values do not match between them, the parcel will be ` +
      `held at the border, and the customer will typically be asked by the carrier for documents they ` +
      `do not have and cannot produce. This is the single most common cause of a delivery complaint on ` +
      `an export order, ahead of anything the carrier itself does wrong.\n\n` +
      `3. Declared value: the rule that must never be broken\n` +
      `The declared value is always the real transaction value, in full, on every line. Never split an ` +
      `order's value across multiple declarations, never under-declare to keep a shipment under a ` +
      `de minimis threshold, and never mark a paid order as a gift to avoid duty. Any of these is ` +
      `customs fraud in the destination country and exposes Resonant Audio Labs, the customer and ` +
      `whichever carrier account is used to a penalty, not just a delay. If a customer asks for this, ` +
      `decline plainly and explain why, and tell Henrik if it is a dealer asking.\n\n` +
      `4. Duty and import VAT\n` +
      `4.1 Paid by the recipient on arrival, in the destination country's own currency and process, ` +
      `unless the order was explicitly placed on delivered duty paid (DDP) terms, which we offer on ` +
      `dealer bulk shipments only, not on individual customer orders.\n` +
      `4.2 Say this plainly at the point of sale, in the order confirmation and again if a customer asks ` +
      `about their delivery. A customer surprised by a customs bill on arrival will treat it as a ` +
      `hidden charge, and they are not wrong to feel that way if we never told them; this is a tone of ` +
      `voice matter as much as a finance one.\n` +
      `4.3 We cannot estimate the exact duty a customer will owe: it depends on their own country's ` +
      `rates and thresholds. Point them to their own customs authority rather than guessing a figure.\n\n` +
      `5. Returns from outside the EU\n` +
      `5.1 Mark the return as returned goods on the customs declaration so import VAT is not charged a ` +
      `second time on the way back into France. Getting this wrong costs us the value of the unit a ` +
      `second time, on top of the refund already issued.\n` +
      `5.2 The commercial invoice on a returned goods declaration references the original export ` +
      `invoice number, which is why invoice numbers are never reused across a return and reissue: see ` +
      `the VAT inside the EU article for the same rule applied to a reissued invoice.\n\n` +
      `6. The United Kingdom\n` +
      `The UK left the EU customs union, so it follows every rule in this article, not the EU one. ` +
      `Support and sales sometimes default to treating a UK order as an EU order out of habit; it is ` +
      `not, and doing so produces a wrongly zero rated invoice with no customs paperwork attached, ` +
      `which the parcel will then be held for.\n\n` +
      `7. Message templates\n` +
      `7.1 English, customs hold reply:\n` +
      `"Your parcel is currently held by customs, and this is almost always a paperwork step rather ` +
      `than anything wrong with the order itself. We have sent the commercial invoice and customs ` +
      `declaration to the carrier today, and holds normally clear within two working days once those ` +
      `documents are received. I will follow up as soon as tracking moves again."\n` +
      `7.2 English, duty and import VAT reminder, sent proactively on dispatch of an order outside the ` +
      `EU that was not placed on delivered duty paid terms:\n` +
      `"Your order is on its way. Because it is shipping outside the European Union, your country's ` +
      `customs authority may charge import duty and tax on arrival, which is separate from what you ` +
      `paid us and is set by your own country's rules, not ours. We are not able to estimate that ` +
      `amount in advance, and it is paid to the carrier or customs authority directly, not to us."\n` +
      `7.3 French, customs hold reply, for a French speaking customer outside the EU (for example a ` +
      `francophone customer in Quebec):\n` +
      `"Votre colis est actuellement retenu en douane, ce qui correspond presque toujours a une etape ` +
      `administrative plutot qu'a un probleme avec la commande. Nous avons transmis la facture ` +
      `commerciale et la declaration en douane au transporteur aujourd'hui, et le blocage se leve ` +
      `normalement sous deux jours ouvres une fois ces documents recus. Je reviens vers vous des que le ` +
      `suivi bouge a nouveau."\n\n` +
      `8. Working with a customs broker or freight forwarder\n` +
      `8.1 A dealer bulk shipment sometimes routes through the dealer's own customs broker rather than ` +
      `our standard carrier process. In that case the commercial invoice and HS codes still come from ` +
      `us, in the format our own customs paperwork uses; we do not change the declared value or the ` +
      `classification to suit a broker's preference, per section 3 and the HS codes article.\n` +
      `8.2 If a broker or forwarder asks us to under-declare, split a value, or reclassify a product to ` +
      `a lower duty heading, this is declined and reported to Henrik the same day, exactly as the HS ` +
      `codes article's rule against reclassifying states. This applies even when the broker frames it as ` +
      `routine or as something other suppliers do; it is not something we do.\n\n` +
      `9. Currency\n` +
      `Every export invoice is issued in EUR, our default currency, regardless of destination. A ` +
      `customer paying in a different currency through the checkout still receives an invoice ` +
      `denominated in EUR, with the converted amount they actually paid shown as a reference note, not ` +
      `as the invoice's own currency.\n\n` +
      `10. Common mistakes to avoid\n` +
      `10.1 Treating a UK order as EU because the address looks close to France; it is not, per section ` +
      `6, and produces a wrongly zero rated invoice with no customs paperwork attached.\n` +
      `10.2 Sending a parcel with a commercial invoice showing the list price when a dealer discount or ` +
      `a goodwill credit actually applied; the declared value must match what was actually paid, per ` +
      `section 3, or the parcel risks a hold for a mismatch between the invoice and the payment record.\n` +
      `10.3 Forgetting the customs declaration on a small accessory only order, on the assumption a low ` +
      `value shipment does not need one; every export shipment needs both documents in section 2, ` +
      `regardless of value.\n` +
      `10.4 Quoting a duty or import VAT figure to a customer; we do not know it, per section 4.3, and a ` +
      `wrong guess is worse than saying plainly that we cannot estimate it.\n` +
      `10.5 Marking a returned unit as a normal export instead of returned goods per section 5, which ` +
      `causes import VAT to be charged twice on the same physical unit.\n\n` +
      `11. Quick reference summary\n` +
      `Zero rated on the invoice, real transaction value always, commercial invoice plus customs ` +
      `declaration with HS code on every parcel, duty and import VAT on the recipient unless DDP, ` +
      `returned goods marking on the way back, UK treated as non EU, invoices always in EUR, never ` +
      `reclassify or under-declare for a broker or a customer.\n\n` +
      `12. Open questions to resolve with the team\n` +
      `12.1 Whether to offer DDP as an option on individual customer orders to Japan, where customs ` +
      `holds are most frequent; Henrik and Giulia are pricing this out.\n` +
      `12.2 Whether the customs declaration template should carry the HS code description in English ` +
      `and the destination country's language; currently English only.\n` +
      `12.3 Whether the French language customs hold template in section 7.3 should be adapted for ` +
      `Canadian French spelling conventions specifically, rather than reusing the France French wording; ` +
      `raised by Amina after a Canadian customer's reply pointed out a wording difference.`,
  },
  {
    key: "hs-codes",
    title: "HS codes and product classification",
    collection: "policies",
    owner: "henrik",
    summary:
      "The customs classification code for every SKU, and the rule against reclassifying to save duty.",
    tags: ["customs", "hs-codes", "finance"],
    reviewDueInDays: 90,
    verified: true,
    body:
      `Every line on an export customs declaration needs a Harmonized System (HS) code, and using the ` +
      `wrong one is a customs compliance problem even when it is an honest mistake. This article is the ` +
      `single reference for which code goes with which SKU; the VAT, customs and invoicing outside the ` +
      `EU article explains when the declaration is needed, this one covers what goes on it.\n\n` +
      `Flagship products\n` +
      `Kestrel 6 Field Recorder (RAL-FLAG-01), Kestrel 10 Field Recorder (RAL-FLAG-02) and Kestrel ` +
      `Pocket Recorder (RAL-FLAG-03): HS 8519.81, sound recording apparatus using semiconductor media. ` +
      `These are classified as recording apparatus because the unit captures and writes the audio ` +
      `itself, onto its own card, rather than only conditioning a signal for something else.\n` +
      `Kestrel Field Preamp (RAL-FLAG-04): HS 8543.70, electrical machines and apparatus having ` +
      `individual functions, not specified or included elsewhere. The preamp amplifies and converts but ` +
      `records nothing of its own, which is why it sits under a different heading from the recorders.\n\n` +
      `Accessories\n` +
      `Kestrel Travel Case (RAL-ACC-CASE): HS 4202.92, cases and containers with an outer surface of ` +
      `textile or plastic sheeting.\n` +
      `Kestrel XLR Cable Set (RAL-ACC-CABLE) and Kestrel USB C Cable (RAL-ACC-USB): HS 8544.42, ` +
      `insulated electric conductors fitted with connectors.\n` +
      `Kestrel Tripod Mount (RAL-ACC-STAND): HS 9620.00, monopods, bipods, tripods and similar articles.\n` +
      `Kestrel Power Supply (RAL-ACC-PSU): HS 8504.40, static converters.\n` +
      `Kestrel Windshield Pack (RAL-ACC-WIND): HS 3926.90, other articles of plastics, since the pack is ` +
      `a moulded and foam product with a textile windjammer rather than an electronic or acoustic ` +
      `measuring part.\n` +
      `Extended Care Plan (RAL-ACC-CARE): no HS code. It is a service, not a physical good, and never ` +
      `appears on a customs declaration even when sold alongside a shipped unit; only the physical ` +
      `items in the box are declared.\n\n` +
      `The rule against reclassifying\n` +
      `A lower duty rate under a different, plausible sounding code is never a reason to change a ` +
      `product's classification. The code describes what the product actually is, and it does not move ` +
      `because a particular destination country's duty table makes another heading cheaper. If a ` +
      `dealer or a freight forwarder suggests reclassifying to reduce duty, decline and tell Henrik; ` +
      `this is the customs equivalent of the declared value rule in the VAT, customs and invoicing ` +
      `outside the EU article, and it carries the same risk if it goes wrong.\n\n` +
      `Keeping this current\n` +
      `A new SKU gets its HS code assigned before its first international shipment, not after the first ` +
      `customs hold. When in doubt about a new accessory or a bundle, Henrik confirms the code with our ` +
      `customs broker before it ships, and this article is updated the same week.\n\n` +
      `Worked example: a mixed order to the United States\n` +
      `A US customer orders a Kestrel 10 Field Recorder, a Kestrel Power Supply and a Kestrel Windshield ` +
      `Pack in one order. The customs declaration carries three lines: HS 8519.81 for the recorder at ` +
      `its actual transaction value, HS 8504.40 for the power supply, and HS 3926.90 for the windshield ` +
      `pack, each with its own declared value rather than one combined line for the whole order. This ` +
      `matters because US customs, like most destination countries, assesses duty per HS heading, not ` +
      `per shipment as a whole.\n\n` +
      `Where the codes come from\n` +
      `These codes were confirmed with our customs broker when the current catalog was set up, and are ` +
      `reviewed whenever a SKU changes materially, for example a case material change on the Kestrel ` +
      `Travel Case. They are not derived from a generic online HS lookup tool without that confirmation ` +
      `step, since a lookup tool cannot see the physical product the way a broker familiar with our ` +
      `catalog can.`,
  },
  {
    key: "tone-of-voice",
    title: "Tone of voice",
    collection: "policies",
    owner: "amina",
    summary: "How we write to customers: plain, warm, specific, and never defensive.",
    tags: ["writing", "tone"],
    reviewDueInDays: 180,
    verified: true,
    body:
      `Plain before clever. Write the way you would speak to a sound recordist standing in front of ` +
      `you: short sentences, no jargon unless it is their jargon.\n\n` +
      `Say what happens next. Every reply ends with either a concrete action we are taking or a ` +
      `specific thing we need from them. Never leave a customer wondering who moves next.\n\n` +
      `Own the mistake. If we packed the wrong item, say so in the first line. No passive voice, no ` +
      `it appears that an error may have occurred. An apology that hedges reads worse than none.\n\n` +
      `Be specific with numbers. Three working days beats shortly. A tracking number beats it is on ` +
      `its way. If you do not know, say when you will.\n\n` +
      `Never argue about the warranty in the first reply. Establish the facts first: what the customer ` +
      `experienced, the serial number, the firmware version if relevant. A customer who feels accused ` +
      `stops giving you the information you need to help them, and most warranty questions resolve ` +
      `themselves once the facts are on the table.\n\n` +
      `Remember what a bad day costs them. Our customers are usually on a job with a crew waiting, so ` +
      `a reply that arrives with a real date in it is worth more than a perfectly worded one that ` +
      `arrives without one.\n\n` +
      `Match the customer's language where you can. Answering a French message in French matters more ` +
      `than answering it perfectly; Amina and Lucas both work across French, English and, for Amina, ` +
      `Arabic, and a translated reply is always better than a delayed one.\n\n` +
      `Never disparage a competitor by name in anything a customer reads, even a customer who brings one ` +
      `up first. Redirect to what our product does well instead. The competitor positioning article is ` +
      `for internal sales conversations only.\n\n` +
      `No dash punctuation in anything a customer reads: no em dash, no en dash, no double hyphen. Use ` +
      `a colon, a comma or a second sentence. This applies to every language we write in and every ` +
      `surface: tickets, mail, the website, the manuals.\n\n` +
      `A closing reply still gets the full standard: confirm what was resolved, in one sentence, even ` +
      `when the ticket is about to close. A customer should never have to guess whether a thread is ` +
      `actually finished.\n\n` +
      `Before and after examples\n` +
      `Before: "It appears that an error may have occurred with your order and we apologize for any ` +
      `inconvenience this may have caused." After: "We packed the wrong windshield in your order. We are ` +
      `sending the correct one today at no charge, no need to return the wrong one."\n` +
      `Before: "Your item should arrive soon." After: "Your item is on the DHL van for delivery today, ` +
      `tracking number [NUMBER]."\n` +
      `Before: "Unfortunately this is not covered under warranty." After: "This looks like liquid ` +
      `damage on the connector, which our warranty does not cover at any stage. Here is what a repair ` +
      `would cost if you would like to go ahead with one."\n\n` +
      `A note on formality\n` +
      `Warm does not mean casual. A customer who writes formally gets a reply that matches that register; ` +
      `a customer who writes casually gets a reply that is relaxed but still precise. Matching formality ` +
      `is different from matching slang, and slang is avoided either way since it does not translate ` +
      `well across languages or read consistently to every customer.\n\n` +
      `Internal messages follow the same numbers rule\n` +
      `The plain, specific numbers habit is not only for customers: a ticket note or an internal escalation ` +
      `that says "a few units" instead of the actual count, or "recently" instead of a date, wastes the ` +
      `next person's time working out what was actually meant.`,
  },
  {
    key: "guide-kestrel-6",
    title: "Troubleshooting the Kestrel 6 Field Recorder",
    collection: "products",
    owner: "lucas",
    summary: "Dead inputs, card write errors and noise floor complaints on the flagship recorder.",
    tags: ["troubleshooting", "RAL-FLAG-01"],
    reviewDueInDays: 30,
    verified: true,
    body:
      `Dead input, or a group of inputs\n` +
      `A single input that passes no signal is usually the cable or the microphone: ask the customer to ` +
      `move the same mic and cable to a known good input and retest before anything else. Two or more ` +
      `ADJACENT inputs dead at once, confirmed in the recorder's own meters with nothing plugged in and ` +
      `the gain wound up, is an input board fault and is a warranty replacement under the Warranty ` +
      `policy article; raise it straight through the RMA procedure. Do not spend a second reply ` +
      `investigating it, and do not ask the customer to open the unit.\n\n` +
      `Dropouts and disconnects during a session\n` +
      `Ask two questions before anything else: is it through a hub or dock, and what is the firmware ` +
      `version? A regular cadence of roughly 20 minutes on the USB side, through a dock, is a known ` +
      `pattern and is fixed in firmware 1.8.3; if the customer is on an older version, the fix is the ` +
      `update, not a replacement. Plugged directly into the computer with the drop still happening, ask ` +
      `for the diagnostics export from Kestrel Link and escalate through the firmware or app defect ` +
      `route.\n\n` +
      `No power at all\n` +
      `If the unit shows nothing on mains, nothing on a fresh set of batteries and is invisible in the ` +
      `computer's USB device list with two different cables, it is a hardware fault and goes to RMA. A ` +
      `unit that lights up but does not enumerate as a device is usually a charge only cable that ` +
      `carries power but not data, which is worth ruling out first with the Kestrel USB C Cable or an ` +
      `equivalent known good data cable.\n\n` +
      `Card write errors and dropped takes\n` +
      `A take that stops early, a file that will not close, or a card error mid record is by far the ` +
      `most common fault report we get on this product, and it is almost always the card rather than a ` +
      `defect in the recorder. Ask which card is in use, whether it was formatted IN the recorder (not ` +
      `on a computer), and whether the same fault follows the card to the second slot. A card formatted ` +
      `elsewhere, or a counterfeit card sold as a faster grade than it is, produces exactly this ` +
      `pattern. Point the customer at the approved card list in Kestrel Link before touching anything ` +
      `on the recorder itself.\n\n` +
      `Noise floor higher on one input than the rest\n` +
      `Run a Reset input stage pass in Kestrel Link first, with nothing plugged into the affected input. ` +
      `If that input still sits noticeably above its neighbours at the same gain afterwards, collect the ` +
      `diagnostics export and escalate; do not promise a replacement before the export has been ` +
      `reviewed, since a long unbalanced cable or a hot ribbon mic can produce a similar looking ` +
      `report.\n\n` +
      `Firmware and Kestrel Link version to ask for first\n` +
      `Every troubleshooting reply on this product should confirm the firmware version and the Kestrel ` +
      `Link version in the first message; most dropout, card and timecode complaints resolve with an ` +
      `update, and asking up front saves a full round trip.\n\n` +
      `Timecode drift between the recorder and the camera\n` +
      `Drift reported over a long shooting day is usually the OTHER device free running, not the ` +
      `recorder losing its own clock. Ask what the recorder was jammed from, how long ago, and whether ` +
      `the camera was jammed from the same source. A recorder jammed once in the morning and left to ` +
      `hold its own clock all day is working as documented; the fix is a jam at lunch or a continuous ` +
      `timecode feed, not a replacement. Only a unit that drifts against a continuously fed reference ` +
      `is a fault worth escalating.\n\n` +
      `Windshield and shoe mount fit\n` +
      `A Windshield Pack shoe mount that does not seat flush is worth checking against the Kestrel 10's ` +
      `mount before assuming a defect: the two are similar in appearance but not interchangeable, and a ` +
      `picking error at our end is the more common explanation than a manufacturing defect in the mount ` +
      `itself.\n\n` +
      `When to just replace rather than keep troubleshooting\n` +
      `A unit that has already been through a full diagnostics cycle for the same symptom on a previous ` +
      `ticket does not need to repeat the whole cycle a second time; check the ticket history first and ` +
      `move to an RMA once the earlier ticket shows the standard checks were already run.`,
  },
  {
    key: "guide-kestrel-10",
    title: "Troubleshooting the Kestrel 10 Field Recorder",
    collection: "products",
    owner: "lucas",
    summary:
      "What differs on the ten input body, including power draw, charging after a firmware update and the second card slot.",
    tags: ["troubleshooting", "RAL-FLAG-02"],
    reviewDueInDays: 30,
    verified: true,
    body:
      `The Kestrel 10 shares its preamps and its recording engine with the Kestrel 6, so the input, ` +
      `card and timecode troubleshooting in that article applies unchanged. Three things differ, all ` +
      `specific to the larger body's channel count and power draw.\n\n` +
      `Power\n` +
      `With phantom power on several inputs at once, the Kestrel 10 draws more current than a standard ` +
      `USB port reliably supplies. Without the Kestrel Power Supply (RAL-ACC-PSU) or a charged battery ` +
      `sled, it may boot normally and then shut down part way into a long take, which reads to the ` +
      `customer as a random crash rather than a power issue. Always confirm what the unit was powered ` +
      `from, and how many inputs had phantom power enabled, before treating a Kestrel 10 shutdown as a ` +
      `fault; this single question resolves the majority of Kestrel 10 power tickets.\n\n` +
      `A unit that shows nothing at all, with the power supply connected and a known good USB cable, is ` +
      `a hardware fault and goes straight to replacement under the RMA procedure, no further ` +
      `troubleshooting needed.\n\n` +
      `Not charging after a firmware update (LED blinks orange twice)\n` +
      `Two short orange blinks, then the LED goes off, is the charge controller refusing to charge: it ` +
      `happens when a firmware update was interrupted or ran on battery alone, and it is a known ` +
      `software state, not a user error and not yet a hardware fault. The cable is never the cause, so ` +
      `do not ask the customer to try another one. The fix: connect the Kestrel Power Supply ` +
      `(RAL-ACC-PSU), open Kestrel Link and reinstall the current firmware from Device, Firmware; the ` +
      `unit restarts and charges normally. If it still blinks orange twice after the reinstall, it is a ` +
      `charge controller fault and goes to replacement under the RMA procedure. A customer with a ` +
      `recording date gets the reinstall steps first, since they take ten minutes.\n\n` +
      `The second card slot\n` +
      `The Kestrel 10 defaults to mirroring every take to both card slots, which is the whole point of ` +
      `the second slot on a larger crew job. A customer reporting that their second card fills at ` +
      `exactly the same rate as the first, or that they cannot record different tracks to each slot, ` +
      `has not found a bug, they have found the default configuration. Point them at the Media panel in ` +
      `Kestrel Link, where mirroring can be switched to a split assignment or turned off entirely.\n\n` +
      `Shoe mounts and windshields\n` +
      `The Kestrel 10 uses a wider shoe than the Kestrel 6 and the two mounts are not interchangeable, ` +
      `even though they look similar at a glance. A two millimetre mismatch along the shoe usually means ` +
      `a Kestrel 6 mount was shipped with a Kestrel 10 unit, which is a picking error on our side, not ` +
      `a customer mistake or a defect: apologize plainly per the tone of voice article and send the ` +
      `correct mount at no charge, no return of the wrong one required.\n\n` +
      `Weight and bag stability\n` +
      `At 3.6 kilograms the Kestrel 10 is noticeably heavier than the Kestrel 6, and an occasional ` +
      `report of the unit shifting inside a bag rig while walking is a harness and strap issue, not a ` +
      `defect; the Kestrel Tripod Mount's larger plate gives a firmer anchor and resolves this for most ` +
      `customers who ask.\n\n` +
      `Shipping damage versus a hardware fault on arrival\n` +
      `Because the Kestrel 10 ships in a larger, heavier box, a fault reported immediately on unboxing ` +
      `is worth checking against the packaging condition before assuming a pre-existing hardware defect; ` +
      `visible crushing or a torn box is a shipping damage claim through the carrier rather than a ` +
      `standard RMA, and Margot handles that as a separate process from the warranty claim itself.\n\n` +
      `Confirming coverage before promising a replacement\n` +
      `Every Kestrel 10 replacement still goes through the same coverage check as any other product ` +
      `against the Warranty policy article; the differences in this guide are diagnostic steps specific ` +
      `to this model, not a different warranty standard for it.\n\n` +
      `Comparing to the Kestrel 6 when a customer is choosing between them\n` +
      `A presales question about whether to buy the Kestrel 6 or the Kestrel 10 is a sales conversation, ` +
      `not a support one, but support fields it often enough to be worth a plain answer: the Kestrel 10 ` +
      `gives ten inputs, a second card slot and more simultaneous tracks, at a higher price, more weight ` +
      `and a real power budget to plan for; the Kestrel 6 is the lighter, longer running choice for a ` +
      `one or two person crew. Point a presales question toward the two product spec sheets rather than ` +
      `improvising a comparison.`,
  },
  {
    key: "guide-pocket",
    title: "Troubleshooting the Kestrel Pocket Recorder",
    collection: "products",
    owner: "lucas",
    summary:
      "Battery and bus power, the two input limit and travel related faults on the small body.",
    tags: ["troubleshooting", "RAL-FLAG-03"],
    reviewDueInDays: 30,
    verified: true,
    body:
      `The Pocket runs from internal batteries or bus power over its USB C connection and needs no ` +
      `external supply, so a power complaint on this model is nearly always the batteries, the cable or ` +
      `the port, never the Kestrel Power Supply, which the Pocket does not use.\n\n` +
      `Intermittent behaviour in a bag\n` +
      `The Pocket is the unit people travel with, and the most common physical fault we see is connector ` +
      `strain at the USB C port from a cable left plugged in inside a bag between jobs. Visible ` +
      `play or wobble in the port when a cable is inserted is a warranty repair under the Warranty ` +
      `policy article. Mention the Kestrel Travel Case in the reply; it is designed specifically around ` +
      `this failure mode and it is worth recommending even outside a warranty conversation.\n\n` +
      `Fewer inputs than expected\n` +
      `The Pocket has two inputs by design and does not link to the Kestrel Field Preamp over the ` +
      `control bus, unlike the larger bodies. Customers moving across from, or up from, a Kestrel 6 ` +
      `sometimes report the missing link as a fault. It is the compact form factor's tradeoff, not a ` +
      `limitation that can be unlocked in firmware.\n\n` +
      `Wind and handling noise on the built in microphones\n` +
      `The built in pair sits close to the body, so handling noise and wind reach them more easily than ` +
      `they would a boom mounted mic. A customer reporting rumble on outdoor recordings is usually ` +
      `hearing exactly that rather than a fault: suggest the foam shields in the Kestrel Windshield Pack ` +
      `and a high pass filter setting before treating it as a hardware problem, since no amount of ` +
      `service work changes where the capsules are.\n\n` +
      `USB power from a phone or tablet\n` +
      `The Pocket is sometimes bus powered from a phone or tablet rather than a computer, and some ` +
      `mobile devices limit the current available over USB more than a laptop does. If a customer ` +
      `reports the Pocket working on a computer but not on a phone, this is the most likely cause; ` +
      `suggest running it on its own batteries rather than treating it as a hardware fault.\n\n` +
      `Firmware updates while travelling\n` +
      `A firmware update requires Kestrel Link, which needs a full computer; a customer travelling with ` +
      `only a phone or tablet cannot update in the field. This is worth mentioning proactively when a ` +
      `fix is on a newer firmware version and the customer mentions they are away from a computer.\n\n` +
      `Confirming coverage before promising a replacement\n` +
      `As with every product, confirm the fault against the Warranty policy article before promising an ` +
      `RMA; connector strain from bag use is covered, but visible impact damage without an active Care ` +
      `Plan is not, and the two can look similar without a close look at the port itself.\n\n` +
      `Comparing to the Kestrel 6 when a customer is choosing between them\n` +
      `A presales question about whether to buy the Pocket or the Kestrel 6 is a sales conversation, ` +
      `but support fields it often enough to be worth a plain answer: the Pocket trades input count for ` +
      `a genuinely pocketable size and internal batteries, with two inputs, built in microphones and no ` +
      `control bus link; the Kestrel 6 keeps six inputs, timecode in and out and the preamp link. Point ` +
      `a presales question toward the two product spec sheets rather than improvising a comparison.\n\n` +
      `Care while travelling\n` +
      `Beyond the connector strain warning above, a Pocket carried loose in a bag benefits from the foam ` +
      `shields being left on the built in microphones, since they keep dust and grit out of the capsules ` +
      `in transit; this is a suggestion worth passing on, not a warranty requirement.`,
  },
  {
    key: "guide-preamp",
    title: "Troubleshooting the Kestrel Field Preamp",
    collection: "products",
    owner: "lucas",
    summary:
      "Noise, ground loops, phantom power sag, and the difference between a faulty preamp and a faulty studio.",
    tags: ["troubleshooting", "RAL-FLAG-04"],
    reviewDueInDays: 30,
    verified: true,
    body:
      `Hiss or hum on the linked channels\n` +
      `At normal gains the preamp's noise floor should sit below the recorder's own. Noise that appears ` +
      `only on the four linked channels is a ground loop far more often than a faulty unit, and ` +
      `treating it as a hardware fault on the first reply leads to unnecessary replacements.\n\n` +
      `The test that settles it: ask the customer to try the preamp in a different room, on a different ` +
      `electrical circuit, with nothing else connected to the recorder but the link cable. Silent there ` +
      `and noisy back in the studio means the studio's wiring, not the preamp. Noisy in both places ` +
      `means the preamp is at fault and we replace it under the Warranty policy article.\n\n` +
      `Never send a second replacement for the same symptom without running this test first. A ` +
      `replacement unit developing an identical symptom in the same studio is evidence about the ` +
      `environment, not evidence of a bad batch, and jumping straight to a third unit wastes stock and ` +
      `still does not fix the customer's actual problem.\n\n` +
      `When it is the studio\n` +
      `An isolating transformer on the affected circuit resolves a ground loop in almost every case we ` +
      `have seen. We supply one at our own cost where a customer has already been through one ` +
      `replacement cycle for the same symptom: it is cheaper for us than a third unit, and it is the ` +
      `fix that actually addresses the cause.\n\n` +
      `Phantom power sag with condenser microphones\n` +
      `A brief dip on the other channels as all four phantom supplies come up is normal and is not a ` +
      `fault. A channel that cannot hold 48 volts under a single condenser, or that drops phantom power ` +
      `part way through a take, is not normal: it is covered under the Warranty policy article and is ` +
      `worth a diagnostics export and an escalation rather than another round of cable swapping.\n\n` +
      `Cable and link connection\n` +
      `The preamp links to a recorder using the control bus cable in the Kestrel XLR Cable Set; a ` +
      `generic cable not from that set occasionally causes an intermittent or absent link because of a ` +
      `pin convention mismatch, not because the preamp or the cable is faulty. Confirm the correct cable ` +
      `is in use before treating an intermittent link as a hardware fault.\n\n` +
      `Gain does not match the recorder's own inputs\n` +
      `A preamp reading a few decibels off the recorder's own inputs at the same setting is usually a ` +
      `calibration issue, not a fault: run Reset input stage in Kestrel Link with the preamp linked and ` +
      `nothing plugged into either unit, since a calibration pass run with a microphone connected leaves ` +
      `the offset baked in afterwards.\n\n` +
      `Sending a customer through the room swap test\n` +
      `Explain the test plainly rather than asking the customer to just try it: "this narrows down ` +
      `whether the noise is coming from your studio's wiring or the preamp itself, and it takes two ` +
      `minutes." A customer who understands why they are doing a test is far more likely to actually do ` +
      `it and report back with a useful answer.\n\n` +
      `Using the preamp without a Kestrel recorder\n` +
      `The preamp works as a standalone four channel microphone preamp into any line level input, not ` +
      `only a Kestrel recorder. A customer reporting it does not work with a third party recorder is ` +
      `usually feeding a line output into a microphone input, or the reverse, rather than facing a fault ` +
      `in the preamp; ask which input on the other device is in use before assuming a hardware problem.`,
  },
  {
    key: "rma-procedure",
    title: "Raising an RMA, including dealer batches",
    collection: "procedures",
    owner: "margot",
    summary: "How a warranty return is raised, batched for a dealer, and tracked back.",
    tags: ["rma", "procedure", "dealer"],
    reviewDueInDays: 75,
    verified: true,
    body:
      `Audience: fulfillment and support, shared with dealers as the batch process below.\n` +
      `Visibility: internal, organization wide.\n` +
      `Source: procedure owner Margot Dufour (Fulfillment Coordinator), grounded in the Warranty ` +
      `policy article.\n` +
      `Status: verified.\n\n` +
      `1. Summary\n` +
      `A warranty return is an RMA, not a return in the change of mind sense: it is raised against the ` +
      `unit's SERIAL NUMBER, not against the order, because the unit may have been bought from a ` +
      `dealer and the order the customer remembers is not one of our own records. Confirm coverage ` +
      `against the Warranty policy article before raising anything.\n\n` +
      `2. Single unit RMA\n` +
      `2.1 Confirm the fault is covered under the Warranty policy article. If it is not clearly covered ` +
      `or clearly excluded, escalate rather than guess; see the escalation article for the hardware ` +
      `fault route.\n` +
      `2.2 Raise the RMA against the serial number and send a prepaid return label the same day.\n` +
      `2.3 Where the customer holds an active Extended Care Plan, ship the replacement immediately, ` +
      `before the faulty unit has been received back: this is the advance replacement benefit and it ` +
      `is the main reason customers buy the plan, so do not make them wait for it.\n` +
      `2.4 Where there is no Care Plan, the replacement ships once the faulty unit is received and ` +
      `tested clean for the reported fault, per section 4.\n\n` +
      `3. Dealer batches\n` +
      `3.1 Dealers accumulate customer returns over a period of weeks and send them to us together ` +
      `rather than one at a time. Raise ONE RMA covering every serial in the batch, and issue a single ` +
      `label for the whole box.\n` +
      `3.2 Do not make a dealer raise one RMA per unit, and do not send several labels for one physical ` +
      `box: both create reconciliation work that serves nobody and slows the dealer down.\n` +
      `3.3 The dealer includes a packing list matching serial to reported fault for each unit in the ` +
      `batch; if it is missing, ask for it before accepting the batch rather than trying to reconstruct ` +
      `it from the box contents.\n` +
      `3.4 A dealer batch ships back to the dealer's address as a single consolidated shipment once ` +
      `every unit in the batch has been processed, not as individual parcels per unit, unless the ` +
      `dealer specifically asks for individual tracking.\n\n` +
      `4. On arrival\n` +
      `4.1 Every unit is tested against the reported fault before a replacement is released, single ` +
      `unit or dealer batch alike. For an input fault that means every input driven with a real ` +
      `microphone and with phantom power, not a bench signal on one channel.\n` +
      `4.2 A unit that tests clean, meaning the reported fault cannot be reproduced, goes back to the ` +
      `customer (or the dealer, for a batch) with a note explaining exactly what was checked, never ` +
      `silently. A customer whose unit is returned without explanation assumes it was ignored.\n\n` +
      `5. Recording and the warranty clock\n` +
      `5.1 The replacement's serial number is recorded against the ORIGINAL purchase record, so the ` +
      `warranty period continues to run from the first sale date, not from the replacement date. This ` +
      `is the same rule stated in the Warranty policy article, section 6.3; this article is the ` +
      `operational side of it.\n` +
      `5.2 Update the serial lookup the same day the replacement ships, not when the batch is fully ` +
      `closed out, so a support agent looking the customer up in the meantime sees accurate ` +
      `information.\n\n` +
      `6. International RMAs\n` +
      `6.1 A replacement shipped to a customer outside the EU is a zero rated export like any other ` +
      `international shipment, and the faulty unit coming back is marked returned goods on its customs ` +
      `declaration so import VAT is not charged a second time; see the VAT, customs and invoicing ` +
      `outside the EU article for the underlying rule.\n` +
      `6.2 A dealer batch that crosses a border still follows the single RMA, single label rule in ` +
      `section 3; the customs paperwork for the batch travels as one declaration covering every serial ` +
      `in the box, using the HS codes from the HS codes and product classification article, not one ` +
      `declaration per unit.\n` +
      `6.3 A Care Plan advance replacement shipped internationally follows the same dispatch and transit ` +
      `timelines as any other export order in the shipping timelines article; the advance replacement ` +
      `benefit is about not waiting for the old unit to arrive first, not about a faster shipping speed.\n\n` +
      `7. Message templates\n` +
      `7.1 English, RMA confirmation, no Care Plan:\n` +
      `"Thank you for confirming the details. We have raised a warranty return for serial [SERIAL], and ` +
      `a prepaid label is on its way to you by email. Once we receive and test the unit, which normally ` +
      `takes a few working days, we will ship your replacement and let you know it is on its way."\n` +
      `7.2 English, RMA confirmation, active Care Plan (advance replacement):\n` +
      `"Thank you for confirming the details. Since your Extended Care Plan is active on this unit, we ` +
      `are shipping your replacement today rather than waiting for the faulty unit to arrive first. A ` +
      `prepaid label for returning the original unit is on its way to you separately."\n` +
      `7.3 French, RMA confirmation, no Care Plan:\n` +
      `"Merci pour ces precisions. Nous avons ouvert un retour sous garantie pour le numero de serie ` +
      `[SERIAL], et une etiquette prepayee vous parvient par courriel. Des reception et verification de ` +
      `l'appareil, generalement sous quelques jours ouvres, nous expedions votre remplacement et vous en ` +
      `informons."\n\n` +
      `8. Dealer batch worked example\n` +
      `Northfield Instruments sends a box of four units collected from their own customers over three ` +
      `weeks: two Kestrel 6 recorders with reported dead inputs, one Kestrel Field Preamp with reported ` +
      `hiss, and one Kestrel Pocket with a loose USB C port. Margot raises a single RMA covering all ` +
      `four serials, matched against Northfield's packing list. On arrival, each unit is tested against ` +
      `its OWN reported fault, not a blanket check: the preamp in particular gets the room swap test from ` +
      `its troubleshooting guide before any replacement is approved, since hiss on arrival could equally ` +
      `be a mains issue at Northfield's own premises rather than the original customer's. All four ` +
      `replacements ship back to Northfield together as one consolidated parcel, each replacement serial ` +
      `recorded against its own original purchase record per section 5.\n\n` +
      `9. Common mistakes to avoid\n` +
      `9.1 Raising an RMA against the order number instead of the serial number; the order may not even ` +
      `be one of ours if the unit was bought from a dealer, per section 1.\n` +
      `9.2 Sending a dealer a fresh label for every unit in a batch instead of one label for the whole ` +
      `box, which section 3.2 exists specifically to prevent.\n` +
      `9.3 Releasing a replacement before testing, outside the Care Plan advance replacement case in ` +
      `section 2.3; every non Care Plan unit is tested first, no exceptions for a customer who is in a ` +
      `hurry.\n` +
      `9.4 Recording a replacement serial as a NEW sale rather than against the original purchase record, ` +
      `which silently resets the warranty clock and contradicts the Warranty policy article's section ` +
      `6.3.\n` +
      `9.5 Returning a unit that tested clean without any note, leaving the customer to assume it was ` +
      `ignored rather than actually checked.\n\n` +
      `10. Quick reference summary\n` +
      `RMA against serial, not order. Care Plan means advance replacement. Dealer batches get one RMA ` +
      `and one label. Every unit tested before a replacement releases, against its own reported fault. ` +
      `Replacement serial recorded against the original purchase, warranty clock unchanged. ` +
      `International RMAs follow the export and returned goods customs rules.\n\n` +
      `11. Open questions to resolve with the team\n` +
      `11.1 Whether a dealer batch above a certain size should get a scheduled collection instead of a ` +
      `dropped off label, to reduce the chance of a batch going missing in transit; Margot is costing ` +
      `this against last quarter's carrier claims.\n` +
      `11.2 Whether the clean tested note back to the customer should include the specific diagnostic ` +
      `steps run, or stay at the current summary level; raised by Lucas after a customer asked for more ` +
      `detail than the current note gives.\n` +
      `11.3 Whether the French message template in section 7.3 needs a shorter variant for a ticket ` +
      `reply versus a formal email; currently the same wording is used for both.`,
  },
  {
    key: "refund-procedure",
    title: "Issuing a refund or a credit note",
    collection: "procedures",
    owner: "henrik",
    summary: "Which instrument to use, who approves what, and the wording on the document.",
    tags: ["refund", "finance", "procedure"],
    reviewDueInDays: -20,
    verified: false,
    body:
      `A refund returns money to the original payment method. A credit note cancels an invoice, or ` +
      `part of one. They are not interchangeable, and a cancelled order after an invoice was already ` +
      `issued needs both: the credit note to correct the accounting record, the refund to actually ` +
      `return the money.\n\n` +
      `Cancelled before shipping\n` +
      `Release the refund at the moment of cancellation, not when someone gets around to it. The most ` +
      `common finance complaint we receive is a cancellation that was recorded in the system without ` +
      `the refund actually being released, leaving the customer to chase it days later. If an invoice ` +
      `had already been issued, pair the refund with a credit note the same day.\n\n` +
      `Returned after delivery\n` +
      `The refund releases when fulfillment marks the return received, matching the return procedure ` +
      `article, not when the customer says they have posted it. Marking received is the trigger, ` +
      `nothing earlier.\n\n` +
      `Partial refunds\n` +
      `Used for a missing accessory, a shipping error where the customer keeps the goods, or a partial ` +
      `shipment shortfall. Always state the exact amount and what it covers in the reply to the ` +
      `customer, never just send it silently and let them work out what happened.\n\n` +
      `Wording\n` +
      `A paid document shows Amount paid, never Total due; a document still awaiting payment is the ` +
      `only place Total due belongs. A credit note references the invoice it cancels by its document ` +
      `number, and the original invoice number is never reissued to a different document.\n\n` +
      `Approval\n` +
      `Refunds above one thousand euros need a second pair of eyes, normally Henrik plus Elodie or ` +
      `Tobias, before release. Everything below that threshold is the finance desk's own call to make ` +
      `without waiting on anyone. See the refund policy edge cases article for gifts, duplicate charges ` +
      `and chargebacks, which follow additional rules on top of this one.\n\n` +
      `Which document to check first\n` +
      `Before issuing anything, read the order and the most recent invoice or credit note against it. A ` +
      `refund issued against a stale document total, after a partial refund or a price adjustment has ` +
      `already happened, is the second most common finance complaint after the cancellation delay ` +
      `described above.\n\n` +
      `Refund method\n` +
      `A refund always returns to the ORIGINAL payment method, never as store credit unless the customer ` +
      `explicitly prefers it and it is offered, not defaulted to; defaulting to credit when a customer ` +
      `wanted their money back is a fast way to turn a simple refund into a complaint.\n\n` +
      `This article is currently overdue for review: Henrik is updating the approval threshold wording ` +
      `after a recent case where a large dealer credit note needed the same second pair of eyes as a ` +
      `refund, which the article does not yet state explicitly.\n\n` +
      `Who can issue what\n` +
      `Henrik issues both refunds and credit notes as part of his normal role. In his absence, Elodie can ` +
      `issue either directly; no one else on the team has this access, and a refund request that arrives ` +
      `while both are unavailable waits rather than being handled by whoever is on the desk, since an ` +
      `incorrect refund is harder to unwind than a short delay.`,
  },
  {
    key: "refund-edge-cases",
    title: "Refund policy edge cases",
    collection: "procedures",
    owner: "henrik",
    summary:
      "Gifts, duplicate charges, chargebacks and Care Plan bundles: the cases the basic procedure does not cover.",
    tags: ["refund", "finance", "procedure"],
    reviewDueInDays: 45,
    verified: true,
    body:
      `The Issuing a refund or a credit note article covers the ordinary case. This article covers the ` +
      `cases that come up often enough to need a written answer, but not often enough to belong in the ` +
      `main procedure.\n\n` +
      `Gift purchases\n` +
      `A refund always goes back to the person who PAID, not to the person who received the gift, even ` +
      `when the recipient is the one asking for it. We need the purchaser's own payment method on ` +
      `file, which is why a gift return sometimes takes an extra reply to confirm who bought it; do not ` +
      `skip that confirmation to save a round trip, it is the step that prevents the refund going to ` +
      `the wrong person entirely.\n\n` +
      `Duplicate charges\n` +
      `If the payment processor shows the same order charged twice, refund the duplicate transaction ` +
      `immediately on discovery, do not wait for the customer to notice and complain first. Flag it to ` +
      `Henrik so the processor side can be checked for a systemic cause rather than treating each one ` +
      `as isolated.\n\n` +
      `Chargebacks\n` +
      `Once a chargeback (a disputed charge raised through the customer's bank or card issuer) has been ` +
      `received, do not also process a normal refund on the same charge. Running both at once risks ` +
      `losing the money twice, once to the chargeback and once to our own refund, with no way to claw ` +
      `either back cleanly. Pause any refund in progress on that order and route the ticket to Henrik ` +
      `the same day; he decides whether to accept the chargeback or contest it with evidence from the ` +
      `order and shipping records.\n\n` +
      `Dealer refunds and currency\n` +
      `A refund to a dealer is always issued in the currency of the original dealer invoice, which is ` +
      `EUR for every current dealer in our network. Never convert at a different day's exchange rate ` +
      `to make a number come out even; the refund amount matches the invoice line exactly.\n\n` +
      `Extended Care Plan bundled orders\n` +
      `Where a unit and its Extended Care Plan were bought together and the unit is returned within the ` +
      `unit's own 30 day return window, the Care Plan's 79.00 EUR list value is refunded as part of the ` +
      `same transaction, since it has no unit left to cover. A Care Plan cannot be returned on its own, ` +
      `separately from the unit, once it has been used to cover even one claim; at that point it has ` +
      `delivered value and is no longer eligible for its own refund.\n\n` +
      `When none of these fit\n` +
      `A case that does not match any of the above, or any pattern in the main refund procedure, goes ` +
      `to Henrik directly rather than being decided ad hoc; write down what actually happened, not a ` +
      `guess at which category it belongs to.\n\n` +
      `Partial shipment shortfall\n` +
      `An order that ships in two parcels because of a stock split, where the second parcel is later ` +
      `found to be lost, is refunded for the missing line only once the shipping timelines article's ` +
      `seven working day no scan rule confirms it as lost, not before; a replacement is sent in parallel ` +
      `per that article, so the refund and replacement decisions are independent of each other and the ` +
      `customer should not be left choosing between the two.\n\n` +
      `Refunding across a VAT boundary\n` +
      `A refund on an order that was correctly zero rated as an export, per the VAT, customs and ` +
      `invoicing outside the EU article, is refunded at the full amount paid; there is no VAT component ` +
      `to remove since none was charged. A refund on a French or reverse charged EU order likewise ` +
      `refunds the VAT inclusive or reverse charged total actually paid, matching the original invoice ` +
      `line for line.\n\n` +
      `Worked example\n` +
      `A customer in Sweden receives a Kestrel 6 Field Recorder as a gift from a friend in France, and ` +
      `asks for a refund because it is more recorder than the two track work they actually do. The ` +
      `refund goes to the FRIEND's payment method, since the friend is the purchaser of record; support ` +
      `explains this plainly to the recipient and asks them to loop the purchaser in, rather than ` +
      `processing the refund to a payment method the recipient supplies instead.`,
  },
  {
    key: "escalation-paths",
    title: "When to escalate, and to whom",
    collection: "procedures",
    owner: "amina",
    summary: "The four escalation routes off the support desk and what each one needs.",
    tags: ["escalation", "procedure"],
    reviewDueInDays: -12,
    verified: false,
    body:
      `Audience: support desk primarily, useful reference for the whole team.\n` +
      `Visibility: internal, organization wide.\n` +
      `Source: procedure owner Amina Cherif (Customer Support Lead).\n` +
      `Status: unverified, due for review.\n\n` +
      `1. Summary\n` +
      `There are exactly four escalation routes off the support desk. Knowing which one a ticket needs, ` +
      `and having the right information ready before escalating, is most of what separates a ticket ` +
      `that closes in a day from one that drags for a week. This article names the four, what each ` +
      `needs before you send it, and who owns it once it lands.\n\n` +
      `2. Hardware fault confirmed: fulfillment (Margot)\n` +
      `2.1 Needs: the serial number, and one line on what was ruled out using the relevant product ` +
      `troubleshooting guide.\n` +
      `2.2 Do not escalate a fault you have not reproduced, or one the customer has only described ` +
      `vaguely. Ask the clarifying question first; a hardware escalation with a real symptom description ` +
      `moves fast, a vague one bounces back for more information and costs everyone a day.\n` +
      `2.3 This route feeds directly into the RMA procedure once Margot confirms it.\n\n` +
      `3. Firmware or app defect: engineering, through a bug report\n` +
      `3.1 Needs: the firmware version, the platform (operating system and, where relevant, the editing ` +
      `software in use), and the diagnostics export from Kestrel Link.\n` +
      `3.2 A single report is handled as an individual ticket. Three similar reports inside a month stop ` +
      `being one-offs and get raised as a regression to the whole engineering queue rather than handled ` +
      `ticket by ticket; if you notice a pattern, say so explicitly when you escalate, do not assume ` +
      `someone else has already connected the dots.\n\n` +
      `4. Money: finance (Henrik)\n` +
      `4.1 Covers refunds, disputed charges, VAT treatment questions and anything touching an invoice ` +
      `number.\n` +
      `4.2 Support never edits a financial document directly, even a small correction; describe the ` +
      `change needed and let finance make it, so the audit trail stays consistent with the refund and ` +
      `VAT articles.\n\n` +
      `5. Dealer commercial terms: sales (Giulia)\n` +
      `5.1 Covers pricing, tiers, demo units and quotes.\n` +
      `5.2 Support should not quote a dealer's tier from memory even when it seems obvious; tiers move ` +
      `quarterly and a wrong quote is awkward to walk back once a dealer has seen it in writing.\n\n` +
      `6. Anything public\n` +
      `Anything a customer has publicly complained about, on social media or any public forum, goes to ` +
      `Tobias (Head of Operations) the SAME DAY, whichever of the four routes above it also takes. A ` +
      `public complaint is never just a normal ticket with an audience; it needs the operations lead ` +
      `aware regardless of who else is handling the underlying issue.\n\n` +
      `7. Worked examples\n` +
      `7.1 A customer reports two dead inputs on a Kestrel 6 Field Recorder after already moving the ` +
      `same microphone and cable to a known good input per the troubleshooting guide, and the recorder's ` +
      `own meters confirm both inputs are flat with the gain wound up and nothing connected. This ` +
      `escalates to Margot with the serial number and the one line "inputs 4 and 5 flat in the meters ` +
      `with nothing connected": a hardware fault, section 2.\n` +
      `7.2 A customer on firmware 1.8.2 reports USB dropouts roughly every 20 minutes through a dock. ` +
      `This is the known pattern fixed in 1.8.3 and documented in the Kestrel 6 troubleshooting guide: ` +
      `it is resolved by directing the customer to update, and does NOT escalate to engineering, since ` +
      `the fix already shipped. Escalation is for defects that are not already a known, fixed issue.\n` +
      `7.3 A dealer asks why their quote shows Tier 2 pricing when they believe their order volume ` +
      `qualifies for Tier 3. This escalates to Giulia with the dealer's name and the order in question, ` +
      `never resolved by support recalculating the tier from the dealer pricing tiers article's table, ` +
      `since the actual rolling twelve month figure lives in the sales record, not in the article.\n\n` +
      `8. What escalation is not\n` +
      `8.1 Escalation is not a way to hand off a ticket you would rather not answer. If a ticket is ` +
      `simply awkward but the answer is already covered in the knowledge base, for example a plain ` +
      `warranty denial under the Warranty policy article's section 4, answer it directly using the tone ` +
      `of voice article rather than escalating to avoid delivering unwelcome news.\n` +
      `8.2 Escalation is not a substitute for diagnosis. Every route in this article assumes the relevant ` +
      `product troubleshooting guide, or the relevant policy article, was already consulted; an ` +
      `escalation that skips this step comes back with a request to do it first, which is slower than ` +
      `doing it up front.\n\n` +
      `9. Message templates for handing off\n` +
      `9.1 English, escalating a confirmed hardware fault to fulfillment:\n` +
      `"Hardware escalation: serial [SERIAL], reported fault [FAULT]. Ruled out: [WHAT WAS CHECKED]. ` +
      `Customer has been told we are raising an RMA and will hear back shortly."\n` +
      `9.2 English, escalating a firmware defect to engineering:\n` +
      `"Bug report: firmware [VERSION], platform [OS / EDITING SOFTWARE], diagnostics export attached. ` +
      `Reported by [N] customers this month if a pattern; otherwise a single report. Customer has been ` +
      `told this is being looked into and we will follow up once we know more."\n\n` +
      `9.3 French, escalating a confirmed hardware fault to fulfillment:\n` +
      `"Escalade materielle: numero de serie [SERIAL], defaut signale [DEFAUT]. Verifications ` +
      `effectuees: [CE QUI A ETE VERIFIE]. Le client a ete informe qu'un retour sous garantie est en ` +
      `cours et qu'une reponse suivra rapidement."\n\n` +
      `10. How this article relates to the others\n` +
      `10.1 This is the routing article: it decides WHICH desk a ticket goes to. It deliberately does ` +
      `not restate the detail owned elsewhere: the coverage rules live in the Warranty policy article, ` +
      `the operational RMA steps live in the RMA procedure article, the refund rules live in the two ` +
      `refund articles, and the tier table lives in the dealer pricing tiers article.\n` +
      `10.2 When a rule here and a rule in one of those articles ever seem to disagree, the more specific ` +
      `article wins and this one should be corrected to match, since this article is a map of routes, ` +
      `not the source of truth on any of them.\n\n` +
      `11. Quick reference summary\n` +
      `Hardware, confirmed: Margot, needs serial plus what was ruled out. Firmware or app defect: ` +
      `engineering bug report, needs version, platform, diagnostics export; three in a month becomes a ` +
      `regression, but a KNOWN and already fixed issue is resolved by an update, not escalated again. ` +
      `Money: Henrik, support never edits a financial document. Dealer terms: Giulia, never quote a tier ` +
      `from memory or recalculate it from the article's table. Public complaint: Tobias, same day, ` +
      `always in addition to the other route. Escalation is not a way to avoid delivering bad news, and ` +
      `it is not a substitute for diagnosis.\n\n` +
      `12. Open questions to resolve with the team\n` +
      `12.1 Whether a fifth route is needed for security or data handling questions that do not fit ` +
      `cleanly into the four above; see the security and data handling article, which currently routes ` +
      `everything to Elodie directly rather than through this list.\n` +
      `12.2 This article is currently overdue for its scheduled review; Amina is updating the firmware ` +
      `escalation threshold following a discussion about whether three reports in a month is still the ` +
      `right bar now that the dealer network is larger.\n` +
      `12.3 Whether the worked examples in section 7 should be expanded into a short internal training ` +
      `page of their own, separate from this reference article; suggested by Lucas after using them to ` +
      `train a new support hire.`,
  },
  {
    key: "shipping-timelines",
    title: "Shipping timelines and carrier exceptions",
    collection: "procedures",
    owner: "margot",
    summary: "What we promise per region and when a delayed parcel becomes a claim.",
    tags: ["shipping", "procedure"],
    // A working document the whole team keeps current, so anyone may edit it
    // (and a demo visitor has one document to edit in the Knowledge tour).
    orgAccess: "editor",
    reviewDueInDays: -30,
    verified: false,
    body:
      `Dispatch is same day on orders placed before 14:00 Paris time, next working day otherwise. This ` +
      `applies to every order, direct customer or dealer, unless a dealer bulk order has been agreed on ` +
      `a different schedule with Giulia.\n\n` +
      `Transit\n` +
      `France: 1 to 2 working days. Rest of the EU: 2 to 4 working days. United Kingdom: 3 to 5 working ` +
      `days plus customs. North America: 4 to 7 working days plus customs. Japan and the rest of Asia: ` +
      `5 to 9 working days plus customs. These are transit estimates from the carrier, not a promise ` +
      `that includes customs clearance time; see the note below.\n\n` +
      `When tracking stops moving\n` +
      `Three working days with no new scan is worth a proactive query to the carrier, before the ` +
      `customer asks. Seven working days with no scan is treated as a lost parcel: open a claim with ` +
      `the carrier AND ship a replacement immediately, rather than waiting for the claim to resolve ` +
      `first. The customer should never be the one left waiting on our claims process; that is our ` +
      `problem to carry, not theirs.\n\n` +
      `Customs holds\n` +
      `Usually a missing or mismatched commercial invoice; see the VAT, customs and invoicing outside ` +
      `the EU article and the HS codes article for what should have travelled with the parcel in the ` +
      `first place. Send the missing documents to the carrier and the customs authority the same day ` +
      `the hold is spotted, and the hold normally clears within two working days once they are received.\n\n` +
      `Never promise a delivery date that depends on customs clearing on time; customs timing is outside ` +
      `our control and outside the carrier's control too. Give the transit estimate and say plainly that ` +
      `customs may add time on an international order.\n\n` +
      `A customer with a shoot date\n` +
      `Our customers frequently order against a fixed call sheet, so a question about timing is rarely ` +
      `idle. Ask for the date, quote the transit table honestly against it, and say plainly when the ` +
      `date is not safe rather than letting them find out on the day.\n\n` +
      `This article is currently overdue for review: Margot is updating the North America transit ` +
      `figures following a carrier contract change that has not yet been reflected here.\n\n` +
      `Carrier by region\n` +
      `We use one primary carrier per region rather than shopping each parcel individually, which keeps ` +
      `claims and customs relationships simple: a regional carrier switch is a deliberate operational ` +
      `decision made by Tobias, not something support or fulfillment does ad hoc for a single order.\n\n` +
      `Weekend and holiday dispatch\n` +
      `The warehouse does not dispatch on weekends or French public holidays; an order placed before ` +
      `14:00 Paris time on a Friday dispatches that day as normal, but an order placed over the weekend ` +
      `dispatches the following Monday, or the next working day if Monday is a holiday.\n\n` +
      `Dealer bulk shipments\n` +
      `A dealer bulk order follows the same transit table by destination country, but often ships as a ` +
      `single palletised consignment rather than individual parcels; Margot coordinates the collection ` +
      `date directly with the dealer rather than using the standard label workflow.\n\n` +
      `Address corrections\n` +
      `An incomplete or incorrect address caught before dispatch is fixed immediately at no cost. Once a ` +
      `parcel has left the warehouse, an address correction goes through the carrier's own process and ` +
      `can add several working days; tell the customer this plainly rather than promising the original ` +
      `transit estimate still holds.`,
  },
  {
    key: "dealer-onboarding",
    title: "Onboarding a new dealer",
    collection: "policies",
    owner: "giulia",
    summary:
      "From inbound enquiry to a countersigned agreement, first order and dealer portal access.",
    tags: ["dealer", "onboarding", "sales"],
    reviewDueInDays: 90,
    verified: true,
    body:
      `A new dealer relationship goes through the same five steps every time, whether the enquiry comes ` +
      `in through the Sales inbox, a trade show or a personal introduction to Giulia.\n\n` +
      `Step 1: qualify the enquiry\n` +
      `Confirm the prospective dealer is a real registered business with a physical or established ` +
      `online storefront appropriate to the territory, and get their company registration details and a ` +
      `trade reference if one is available. A hobbyist reseller enquiry is redirected to a normal ` +
      `customer purchase, not signed up as a dealer.\n\n` +
      `Step 2: agree terms and sign\n` +
      `Send the standard dealer agreement, covering the pricing tiers, the demo unit terms, and the ` +
      `warranty handling described in the Warranty policy article. The agreement is countersigned by ` +
      `Elodie or Tobias, never by Giulia alone, before the dealer is live in our systems.\n\n` +
      `Step 3: starting tier\n` +
      `Every new dealer starts at Tier 1 (25 percent off list) regardless of a projected volume or a ` +
      `verbal forecast made during the sales conversation. We never pre-assign a higher tier on a ` +
      `promise: the dealer pricing tiers article is explicit that a tier moves only once the rolling ` +
      `twelve month volume actually clears the threshold. This protects the pricing structure from a ` +
      `forecast that does not materialize.\n\n` +
      `Step 4: first order\n` +
      `The first order is a minimum of one unit of each flagship model the dealer intends to carry, or a ` +
      `value minimum negotiated directly by Giulia for a larger opening order. This gives the dealer ` +
      `real stock to demo and sell from day one rather than starting on backorder.\n\n` +
      `Step 5: access and assets\n` +
      `On countersignature, the dealer gets access to the dealer price list and the marketing asset ` +
      `pack (product photography, spec sheets, the current price list in their territory's currency ` +
      `where applicable). Demo unit terms follow the dealer pricing tiers article: one per model per ` +
      `store at 50 percent of dealer price.\n\n` +
      `Ongoing support\n` +
      `A dealer's day to day commercial contact is Giulia, cc Amina for anything that touches a specific ` +
      `end customer so support has visibility. Importantly, a dealer's OWN customers still come to us ` +
      `directly for warranty claims, per the Warranty policy article; onboarding briefing to a new ` +
      `dealer should say this explicitly so they do not field warranty claims themselves and then ask us ` +
      `to reimburse them after the fact, which is not how the relationship works.\n\n` +
      `Current network\n` +
      `Six dealers across five territories as of this review: Klangwerk GmbH (Germany), Northfield ` +
      `Instruments Ltd (United Kingdom), Atelier Sonore SARL (France), Kanaal Audio BV (Netherlands), ` +
      `Harborlight Audio KK (Japan) and Westcoast Pro Audio LLC (United States). A new territory enquiry ` +
      `outside these still signs up through the same five steps.\n\n` +
      `A dealer that goes quiet\n` +
      `A countersigned dealer that has placed no order in over a year is not automatically removed from ` +
      `the network; Giulia checks in directly before any decision is made, since a quiet dealer is often ` +
      `a slow season rather than a lapsed relationship. Their tier reverts to Tier 1 only once a review ` +
      `confirms the relationship is genuinely inactive, not automatically on the anniversary date.\n\n` +
      `Declining an enquiry\n` +
      `Not every enquiry becomes a dealer. A territory that already has adequate coverage, or an ` +
      `applicant who cannot show a real storefront or trade reference, is declined politely and pointed ` +
      `to buying direct instead; Giulia handles the decline personally rather than leaving it to an ` +
      `automated reply, since a declined dealer enquiry is still a potential customer relationship.`,
  },
  {
    key: "firmware-release-process",
    title: "Firmware release process",
    collection: "products",
    owner: "lucas",
    summary:
      "The release train, the beta channel, and what a support escalation needs before it reaches engineering.",
    tags: ["firmware", "engineering", "process"],
    reviewDueInDays: 60,
    verified: true,
    body:
      `Firmware moves on a six week release train for minor versions, with hotfix releases outside the ` +
      `train when a confirmed regression needs an immediate fix rather than waiting for the next ` +
      `scheduled release.\n\n` +
      `Versioning\n` +
      `Major.minor.patch. A minor release (for example the current line's 1.8 series) ships new ` +
      `features and behaviour changes. A patch release (1.8.1, 1.8.2, 1.8.3 and so on) is a fix only, ` +
      `no new behaviour. The dock disconnect fix referenced throughout the product troubleshooting ` +
      `guides shipped as patch 1.8.3, which is why support should always confirm a customer is on 1.8.3 ` +
      `or later before escalating that particular symptom again.\n\n` +
      `Beta channel\n` +
      `A small group of opted in dealers and VIP customers receive each build roughly two weeks ahead of ` +
      `general release, through an opt in beta channel in Kestrel Link. Beta feedback is triaged by ` +
      `engineering before the general release is cut; a beta build should never be recommended to a ` +
      `customer outside that program as a fix for their specific issue, since it has not gone through ` +
      `the go or no go review yet, and a recorder on a shoot is the worst possible place for an ` +
      `untested build.\n\n` +
      `Go or no go review\n` +
      `Every release, minor or hotfix, goes through a go or no go review before it is published, with ` +
      `sign off from engineering and, for a release attached to a specific product launch, from the ` +
      `whole launch team. This is the same review named in the Preamp launch project's own go or no go ` +
      `task.\n\n` +
      `What a firmware bug report needs\n` +
      `The firmware version, the platform (operating system and, where relevant, the editing software in ` +
      `use), and a diagnostics export from Kestrel Link. This matches exactly what the escalation ` +
      `article asks for on the firmware or app defect route; a report missing any of the three gets sent ` +
      `back for more information before it reaches engineering's queue, which is slower for everyone ` +
      `than asking up front.\n\n` +
      `Rollback\n` +
      `The previous stable version stays downloadable for 12 months after a new minor release, and ` +
      `Kestrel Link warns before a downgrade that crosses a major version boundary, since a downgrade ` +
      `can leave saved input setups in a format the older firmware cannot read.\n\n` +
      `Diagnostics content\n` +
      `A diagnostics export contains the serial number, the firmware and Kestrel Link version, and a log ` +
      `of hardware events with timestamps. It never contains audio: no take from the card and nothing ` +
      `the microphones captured. See the security and data handling article for the retention rule that ` +
      `applies once an export has been attached to a ticket.\n\n` +
      `Kestrel Link releases\n` +
      `The Kestrel Link application follows its own release cadence, roughly matched to the firmware ` +
      `train but not always released on the same day; a mismatch between the latest app and the latest ` +
      `firmware is checked for compatibility before either is recommended as a fix, since an app update ` +
      `alone does not always resolve a firmware level symptom.\n\n` +
      `Communicating a release to customers and dealers\n` +
      `A minor release gets a short patch note published to the knowledge base and, for a release with ` +
      `customer visible changes, a note in Kestrel Link's own update prompt. A hotfix release gets a ` +
      `patch note only when it is customer visible; a purely internal fix does not need one, to avoid ` +
      `training customers to expect an explanation for every routine patch.\n\n` +
      `What happens to an open bug report across a release\n` +
      `When a release ships that fixes a reported bug, the underlying bug report is closed with the ` +
      `fixed version noted; any open support ticket referencing it gets a proactive update recommending ` +
      `the new version, rather than waiting for the customer to ask whether it has been fixed yet.`,
  },
  {
    key: "stock-lead-times",
    title: "Stock and lead times",
    collection: "procedures",
    owner: "tobias",
    summary:
      "Forward stock targets, supplier lead times, and how to tell a customer a real backorder date.",
    tags: ["operations", "stock", "procedure"],
    reviewDueInDays: 30,
    verified: false,
    body:
      `We hold a target of six weeks of forward stock per flagship SKU in the Paris warehouse, and ` +
      `reorder from our assembly partner at three weeks of stock remaining, not when stock actually ` +
      `runs out. This buffer exists because the assembly lead time is long relative to how fast a good ` +
      `launch month can sell through it.\n\n` +
      `Supplier lead times\n` +
      `Flagship product PCB assembly: eight weeks from our assembly partner, for the Kestrel 6, the ` +
      `Kestrel 10, the Pocket and the Field Preamp alike. Accessories: two weeks from our EU based ` +
      `accessory supplier, which is why an accessory backorder is normally a short one and a flagship ` +
      `backorder is not.\n\n` +
      `Dealer bulk orders\n` +
      `A Tier 3 or Tier 4 dealer placing a bulk order needs to give two weeks notice ahead of the ` +
      `published lead time whenever the order would take more than 20 percent of current on hand stock ` +
      `of a single model; this protects direct customer orders from being starved by one large dealer ` +
      `order landing without warning. Giulia coordinates this with Tobias before confirming a bulk order ` +
      `date to a dealer.\n\n` +
      `Talking to a customer about a backorder\n` +
      `Always quote the real date the system shows, read from actual stock and open purchase order data, ` +
      `never an estimate invented in the moment. Soon is not a date and should never appear in a reply ` +
      `about stock, and it is worth remembering that a customer asking about stock usually has a shoot ` +
      `date behind the question.\n\n` +
      `A backorder expected to run longer than 10 working days gets a proactive email to the affected ` +
      `customer, not just a reply when they happen to ask. Waiting for the customer to chase a stock ` +
      `delay is the single most avoidable cause of a frustrated pre-order customer, and it costs us ` +
      `nothing to send the update first.\n\n` +
      `This article's supplier lead time figures are under review following a discussion with the ` +
      `assembly partner about shortening the eight week PCB assembly lead time ahead of next year's ` +
      `dealer network growth; treat the current figures as accurate until Tobias confirms a change.\n\n` +
      `Which model runs out first\n` +
      `The Kestrel 6 Field Recorder, as the highest volume flagship model, is the one most likely to ` +
      `brush against the reorder trigger during a strong sales month; Tobias reviews the forward stock ` +
      `dashboard weekly rather than waiting for an automatic alert, since a launch related spike can ` +
      `move faster than a fixed threshold accounts for.\n\n` +
      `A stockout despite the buffer\n` +
      `If stock reaches zero on a model despite the six week target, for example after an unusually large ` +
      `dealer order landed close together with a strong direct sales week, every affected customer gets ` +
      `the proactive backorder email in the same message as their order confirmation, not as a separate, ` +
      `later surprise.\n\n` +
      `Accessories are rarely the bottleneck\n` +
      `Because the EU accessory supplier's two week lead time is short relative to the flagship models, an ` +
      `accessory going out of stock is unusual and usually resolved before it affects a customer order; a ` +
      `flagship backorder is the pattern this article exists to manage.\n\n` +
      `Coordinating with a firmware or product launch\n` +
      `A launch, like the current Kestrel Field Preamp cycle, gets its own stock plan agreed ahead of the ` +
      `go or no go review rather than relying on the standing six week target, since a launch month's ` +
      `demand curve does not look like a normal month's.`,
  },
  {
    key: "pricing-approvals",
    title: "Pricing approvals",
    collection: "policies",
    owner: "giulia",
    summary:
      "Who can discount, how much, and the line between a goodwill gesture and a commercial decision.",
    tags: ["pricing", "sales", "approvals"],
    sensitivity: "confidential",
    reviewDueInDays: 60,
    verified: true,
    body:
      `This article is confidential: it describes internal discount authority and is not shared with ` +
      `dealers or customers, including a dealer asking directly what discount another dealer received.\n\n` +
      `Support and fulfillment\n` +
      `Neither support nor fulfillment can independently discount an order. Support can offer a ` +
      `goodwill credit of up to 50 euros without approval, for example to smooth over a shipping delay ` +
      `or a minor error on our side; anything larger needs sign off from Amina or Tobias first.\n\n` +
      `Sales, direct customers\n` +
      `Giulia can extend up to 5 percent off list to a direct end customer with a business reason logged ` +
      `against the order (a bulk personal order, a returning customer with a documented prior issue, an ` +
      `education adjacent purchase that does not qualify for the full education account terms). Up to ` +
      `10 percent needs sign off from Elodie or Tobias before it is offered, not after. Anything beyond ` +
      `10 percent to a direct customer does not happen without Elodie personally.\n\n` +
      `Sales, dealers\n` +
      `A dealer's own tier rate under the dealer pricing tiers article is not a discretionary discount ` +
      `and does not need separate approval; it is simply the published rate for their tier. A rate ` +
      `BEYOND the published Tier 4 rate, or any bespoke annual arrangement outside the four tiers, is ` +
      `Elodie's decision alone, negotiated directly with the dealer.\n\n` +
      `Stacking\n` +
      `Discounts never stack. A dealer gets their tier rate, full stop, never their tier rate plus a ` +
      `goodwill credit on top for the same order. A direct customer discount and a goodwill credit on ` +
      `the same order need Giulia's or Amina's awareness of each other before both are applied, so the ` +
      `combined reduction is a deliberate decision, not an accident of two people acting independently.\n\n` +
      `Cross reference\n` +
      `This is a pricing authority matrix, not a refund authority one: the one thousand euro refund ` +
      `approval threshold in the Issuing a refund or a credit note article is a separate rule and the ` +
      `two are not interchangeable, a large discretionary discount and a large refund both need their ` +
      `own sign off even on the same order.\n\n` +
      `Recording a discount\n` +
      `Every discount, at any level, is logged against the order with the reason and who approved it, ` +
      `even a goodwill credit under the 50 euro threshold that needs no separate sign off. This is what ` +
      `lets Giulia's quarterly tier review and Henrik's month end close both work from the same record ` +
      `rather than reconciling two different ideas of what was actually offered.\n\n` +
      `Education accounts and this article\n` +
      `The Tier 3 education pricing described in the dealer pricing tiers article is a standing policy, ` +
      `not a discretionary discount, and does not draw on any of the approval thresholds above; support ` +
      `and sales can both apply it directly to a qualifying purchase order.\n\n` +
      `A note on why this is confidential\n` +
      `Sharing exact discount thresholds with dealers or customers invites every negotiation to open at ` +
      `the ceiling rather than a fair starting point, which is a worse outcome for everyone than a quiet ` +
      `internal matrix that sales applies with judgement. This is a business reason, not a trust issue, ` +
      `and it is fine to tell a persistent customer plainly that pricing authority is an internal matter ` +
      `without elaborating further.`,
  },
  {
    key: "support-slas",
    title: "Support SLAs",
    collection: "procedures",
    owner: "amina",
    summary:
      "First response targets per inbox, the VIP exception, and the weekly report that keeps us honest.",
    tags: ["support", "sla", "procedure"],
    reviewDueInDays: 40,
    verified: true,
    body:
      `All times below are business hours, Paris time, Monday to Friday 9:00 to 18:00. A message that ` +
      `arrives outside those hours starts its clock at the next business day's opening.\n\n` +
      `First response targets by inbox\n` +
      `Support inbox: 1 business day. Sales inbox: 4 business hours, since a sales enquiry that goes ` +
      `quiet loses momentum fast. Bug reports inbox: 2 business days, reflecting that a bug report ` +
      `usually needs engineering input before a substantive reply, not just an acknowledgement.\n\n` +
      `The VIP exception\n` +
      `A VIP customer or a VIP dealer gets a 4 business hour first response regardless of which inbox ` +
      `their message lands in, including the Support inbox's normal 1 business day target. Check VIP ` +
      `status on the contact before triaging, not after a complaint about slow response makes it ` +
      `obvious in hindsight.\n\n` +
      `Resolution target\n` +
      `3 business days for a non hardware ticket, from first response to close. A ticket that needs an ` +
      `RMA, a firmware escalation or a finance decision is measured against the underlying process ` +
      `instead (the RMA procedure, the firmware release process, or the refund procedure respectively), ` +
      `since those have their own realistic timelines that a flat 3 day target would misrepresent.\n\n` +
      `Public complaints\n` +
      `A publicly visible complaint gets a same day response, matching the escalation article's rule ` +
      `that anything public goes to Tobias the same day regardless of which other route it also takes.\n\n` +
      `Reporting\n` +
      `A weekly first response report goes to the whole team, covering actual performance against every ` +
      `target above, broken down by inbox. This is not a private management metric: everyone on the ` +
      `desk sees where the week actually landed, which is deliberate, since a target nobody sees has a ` +
      `way of quietly slipping.\n\n` +
      `Out of hours coverage\n` +
      `There is no dedicated out of hours desk; a message outside business hours waits for the next ` +
      `business day, with one exception. A public complaint per the escalation article's same day rule ` +
      `is checked by Tobias even outside normal hours if he sees it, though this is not a formal ` +
      `coverage commitment and is not promised to customers.\n\n` +
      `When a target is missed\n` +
      `A missed first response target is not hidden in the weekly report; it is shown alongside the ` +
      `target with a one line reason where one is known, for example a volume spike after a firmware ` +
      `release. The point of the report is an honest picture, not a clean one.\n\n` +
      `How this interacts with escalation\n` +
      `Meeting the first response target does not mean the ticket is resolved within it; an ` +
      `acknowledgement that follows the escalation article's routing correctly, with the right ` +
      `information gathered, counts as meeting the target even if the underlying fix takes longer.\n\n` +
      `Language does not change the target\n` +
      `A ticket in French, English or Arabic carries the same first response target as any other; per ` +
      `the tone of voice article, matching the customer's language is worth a short delay to find the ` +
      `right person, but it is not a reason to miss the target altogether, and Amina or Lucas covering ` +
      `for each other across languages is the normal way this is handled day to day.`,
  },
  {
    key: "security-data-handling",
    title: "Security and data handling",
    collection: "policies",
    owner: "tobias",
    summary:
      "What customer data we hold, what we never touch, diagnostics retention, and the breach protocol.",
    tags: ["security", "privacy", "gdpr"],
    sensitivity: "restricted",
    orgAccess: "none",
    reviewDueInDays: 90,
    verified: true,
    body:
      `Restricted: this article is limited to Elodie, Tobias, Henrik and Amina. It is referenced from ` +
      `the escalation and firmware release process articles but its content is not shared beyond this ` +
      `list without Elodie's approval.\n\n` +
      `What we hold\n` +
      `Customer personal data is limited to name, email address, shipping and billing address, order ` +
      `history and support ticket history. We are established in France, so the CNIL (the French data ` +
      `protection authority) is our competent GDPR supervisory authority for the whole customer base, ` +
      `not only French customers.\n\n` +
      `Payment data\n` +
      `Payment card data never touches our own systems directly. Card processing runs entirely through ` +
      `our payment and commerce processor, which carries its own PCI compliance; we hold order and ` +
      `payment status, never a card number, an expiry date or a security code. A support agent who is ` +
      `ever asked to key in a customer's card number by phone should decline and direct the customer to ` +
      `the checkout instead; we have no system that should ever receive one.\n\n` +
      `Diagnostics exports\n` +
      `A diagnostics export attached to a support or bug ticket contains the serial number, the firmware ` +
      `and Kestrel Link version, and a timestamped hardware event log. It never contains audio: no take ` +
      `from the card, no file the customer recorded, nothing the microphones captured. This matters more ` +
      `on this product than on most, since our customers' recordings are frequently confidential ` +
      `production material under their own non disclosure agreements. A diagnostics export is deleted ` +
      `from the ticket 90 days after the ticket closes; it is not kept indefinitely as reference ` +
      `material.\n\n` +
      `Customer supplied recordings\n` +
      `A customer will sometimes attach a short recording to demonstrate a noise floor or a dropout. ` +
      `Treat that file exactly like a diagnostics export: it stays on the ticket, it is never copied ` +
      `anywhere else, and it is deleted on the same 90 day clock after the ticket closes. Never ask for ` +
      `more of a take than is needed to hear the fault.\n\n` +
      `Data subject requests\n` +
      `An access or erasure request from a customer, under GDPR, routes to Elodie directly rather than ` +
      `through any of the four escalation routes in the standard escalation article. We respond within ` +
      `30 days as GDPR requires, and Elodie confirms with Henrik whether any invoicing records need to ` +
      `be retained despite an erasure request, since tax law in France requires retaining certain ` +
      `financial records for longer than a customer's personal data would otherwise be kept.\n\n` +
      `Suspected breach\n` +
      `Any SUSPECTED breach, meaning something that looks wrong even before it is confirmed, is ` +
      `escalated to Elodie and Tobias immediately, the same hour it is noticed, not after someone has ` +
      `tried to confirm it first. A confirmed breach affecting personal data has a 72 hour notification ` +
      `clock to the CNIL under GDPR, and that clock starts from when we became aware, not from when we ` +
      `finished investigating; early escalation protects that deadline.\n\n` +
      `Dealer data\n` +
      `A dealer's own customer records are the dealer's responsibility, not ours; we hold only the ` +
      `warranty and RMA records tied to a serial number, which is why the Warranty policy article can ` +
      `promise direct warranty support without needing the dealer's own customer database.\n\n` +
      `Access within the team\n` +
      `Day to day support, fulfillment and finance work only needs the customer record relevant to the ` +
      `ticket or order in front of a person, not the full customer database; access is scoped by role ` +
      `rather than granted broadly, and a request to look up a customer outside an active ticket or ` +
      `order is unusual enough to ask why before granting it.\n\n` +
      `Third parties\n` +
      `Beyond the payment processor named above, the only other processor holding customer personal data ` +
      `is our shipping and customs platform, which receives name, address and order contents strictly to ` +
      `generate labels and customs paperwork; it does not receive payment data or ticket history.\n\n` +
      `Retention outside diagnostics exports\n` +
      `Order and invoice records are retained for the period French tax law requires, independent of ` +
      `whether a customer later asks for erasure of their support ticket history; the two retention ` +
      `clocks run separately, and Henrik owns the invoicing side while Amina owns the ticket side.\n\n` +
      `Why this article is restricted rather than merely internal\n` +
      `Unlike most policy articles, the specific retention windows and processor list here describe our ` +
      `actual security posture in enough detail that broad internal visibility is itself a small risk; ` +
      `restricting it to the four people who need it for their own work is a deliberate, not an ` +
      `accidental, choice.`,
  },
  {
    key: "competitor-positioning",
    title: "Competitor positioning",
    collection: "policies",
    owner: "giulia",
    summary:
      "How the Kestrel range compares to the two other makers customers mention most, for internal use.",
    tags: ["sales", "competitors", "internal"],
    sensitivity: "confidential",
    reviewDueInDays: 60,
    verified: false,
    body:
      `Internal use only, for sales and support conversations. This article never appears in ` +
      `customer facing copy, and per the tone of voice article a competitor is never named or ` +
      `disparaged directly to a customer even when they bring one up first: redirect to what our own ` +
      `product does well instead.\n\n` +
      `Voltframe Instruments\n` +
      `The volume competitor. Solid 24 bit recorders with no 32 bit float capture and timecode as a ` +
      `paid option rather than standard, priced noticeably below the Kestrel range, and sold with ` +
      `aggressive periodic discounting rather than a stable dealer tier structure like ours. Their ` +
      `firmware cadence is slow: two releases in roughly the time we have shipped six, which shows up as ` +
      `unresolved complaints in public forums about fixes that were promised and have not shipped. Our ` +
      `honest answer to a customer comparing us to Voltframe: 32 bit float on every input and timecode ` +
      `in and out as standard, not an add on, and a firmware team that ships fixes on a six week train. ` +
      `Not our lower price, because we are not the cheaper option here and should not pretend to be.\n\n` +
      `Aria Devices\n` +
      `The boutique competitor. Hand assembled, priced above even the Kestrel 10 Field Recorder, with ` +
      `comparable preamp noise performance to ours on a good unit. Their practical weakness is ` +
      `availability: six to eight weeks lead time in a good month, longer around a product update, and ` +
      `no dealer network to speak of, so a customer who wants to try before buying or needs a warranty ` +
      `handled locally has nowhere to go. That matters more in this category than in most, because a ` +
      `recorder that is away for repair is a recordist who cannot work. Our honest answer: comparable ` +
      `preamps, in stock reliability and a real dealer network in six territories, at a lower price than ` +
      `their flagship.\n\n` +
      `GridTone\n` +
      `A budget handheld recorder maker in a genuinely different category from ours; occasionally comes ` +
      `up in the same search results as the Kestrel Pocket Recorder because of size, but is not really a ` +
      `competitor for a customer who has worked with both. Worth mentioning only to redirect a confused ` +
      `comparison, not to argue against.\n\n` +
      `Overall positioning\n` +
      `We sit between Voltframe and Aria: preamp performance and 32 bit float headroom like Aria, at in ` +
      `stock reliability and dealer supported pricing like neither of them offers. This is the honest, ` +
      `defensible version of our pitch and it should be the one sales actually uses, not an inflated ` +
      `one; this article is still marked unverified pending Giulia's next quarterly check against ` +
      `current market information.\n\n` +
      `Handling a direct price comparison\n` +
      `A customer who states a competitor's exact price and asks us to match it is not owed a match; ` +
      `the pricing approvals article governs what can actually be offered, and a comparison conversation ` +
      `is a chance to explain the difference in what is being bought, not a negotiation to win on price ` +
      `alone.\n\n` +
      `What we do not know\n` +
      `We do not have verified figures for Voltframe's or Aria's actual sales volume or warranty claim ` +
      `rate; the comparisons above are built from public information, customer reports and direct ` +
      `observation of their products, not from anything confidential about their businesses. Do not ` +
      `state a competitor's internal numbers as fact in a sales conversation, since we do not actually ` +
      `have them.\n\n` +
      `Reviewing this article\n` +
      `Giulia checks this quarterly against current pricing pages, lead time claims and public reviews ` +
      `for all three named competitors, and updates the figures here rather than letting sales work from ` +
      `an increasingly stale impression of the market.`,
  },
  {
    key: "spec-kestrel-6",
    title: "Product spec sheet: Kestrel 6 Field Recorder",
    collection: "products",
    owner: "lucas",
    summary:
      "Inputs, power, connectivity and box contents for the flagship recorder (RAL-FLAG-01).",
    tags: ["spec", "RAL-FLAG-01"],
    reviewDueInDays: 90,
    verified: true,
    body:
      `SKU: RAL-FLAG-01. List price: 899.00 EUR. Weight: 2.4 kg.\n\n` +
      `Inputs: six XLR and TRS combo inputs, 48 volt phantom power switchable per input, 32 bit float ` +
      `capture on every channel so a take survives a level nobody could have predicted.\n\n` +
      `Dimensions: approximately 32 by 20 by 6 centimetres, the standard Kestrel body that the Kestrel ` +
      `10 widens and the Pocket reduces.\n\n` +
      `Power: bus powered over USB C, from mains through the Kestrel Power Supply, or from its own ` +
      `battery sled. The power supply is optional on this model, not required, unlike the Kestrel 10.\n\n` +
      `Connectivity: USB C to host for file offload and class compliant USB audio. Timecode in and out ` +
      `on BNC. The clock and control bus for linking a Kestrel Field Preamp, using the Kestrel XLR ` +
      `Cable Set.\n\n` +
      `In the box: the Kestrel 6 Field Recorder, one Kestrel USB C Cable, a quick start sheet in English ` +
      `and French. The Kestrel Travel Case, Kestrel Tripod Mount, Kestrel Windshield Pack and Kestrel ` +
      `XLR Cable Set are sold separately as accessories.\n\n` +
      `Compatible accessories: Kestrel Travel Case (RAL-ACC-CASE), Kestrel XLR Cable Set ` +
      `(RAL-ACC-CABLE), Kestrel Tripod Mount (RAL-ACC-STAND), Kestrel Power Supply (RAL-ACC-PSU), ` +
      `Kestrel Windshield Pack (RAL-ACC-WIND), Extended Care Plan (RAL-ACC-CARE).\n\n` +
      `Firmware: ships on the current 1.8 series; see the firmware release process article for the ` +
      `release train and Kestrel Link for the exact build.\n\n` +
      `Battery runtime with phantom power on all six inputs: not yet published externally; the website ` +
      `workstream is finalizing the figure and copy before it goes on the product page. Do not quote an ` +
      `unpublished number to a customer.\n\n` +
      `Warranty: 2 years standard, 4 years with the Extended Care Plan; see the Warranty policy article ` +
      `for full coverage terms.\n\n` +
      `System requirements: none in the field, the recorder runs standalone onto its own card. A USB C ` +
      `capable computer running Kestrel Link is needed for firmware updates, metadata templates and ` +
      `diagnostics exports.\n\n` +
      `Who it's for: a location recordist or a small crew wanting six inputs, 32 bit float and timecode ` +
      `in one body, positioned between the Pocket's bag size and the Kestrel 10's ten input capacity. It ` +
      `is the model most customers land on as a first purchase, and the one most often paired with the ` +
      `Kestrel Field Preamp when a job outgrows six inputs.\n\n` +
      `Ordering note for support and sales: this is the base flagship SKU (RAL-FLAG-01); do not confuse ` +
      `it with the Kestrel 10 (RAL-FLAG-02) or the Pocket (RAL-FLAG-03) when quoting a price or checking ` +
      `dealer tier volume, since the three share a naming pattern but are separate SKUs with separate ` +
      `pricing.\n\n` +
      `Care and cleaning\n` +
      `A soft, dry cloth is sufficient for the enclosure and the connector panel; no solvents or abrasive ` +
      `cleaners, which can degrade the seals around the inputs over time. This is not a warranty matter ` +
      `either way, but it is a reasonable proactive tip to include in a first unboxing related ticket.\n\n` +
      `Export classification\n` +
      `HS 8519.81 on an international shipment; see the HS codes and product classification article for ` +
      `the full table and the rule against reclassifying for a lower duty rate.\n\n` +
      `Where this SKU sits in the catalog\n` +
      `Flagship tier, alongside the Kestrel 10, the Pocket and the Kestrel Field Preamp; all four count ` +
      `toward a dealer's rolling twelve month volume under the dealer pricing tiers article, unlike any ` +
      `of the accessory SKUs.`,
  },
  {
    key: "spec-kestrel-10",
    title: "Product spec sheet: Kestrel 10 Field Recorder",
    collection: "products",
    owner: "lucas",
    summary: "Inputs, power, connectivity and box contents for the ten input body (RAL-FLAG-02).",
    tags: ["spec", "RAL-FLAG-02"],
    reviewDueInDays: 90,
    verified: true,
    body:
      `SKU: RAL-FLAG-02. List price: 1,349.00 EUR. Weight: 3.6 kg.\n\n` +
      `Inputs: ten XLR and TRS combo inputs with the same preamps as the Kestrel 6, 48 volt phantom ` +
      `power switchable per input, 32 bit float capture on every channel. Two card slots, mirroring ` +
      `every take by default and configurable to a split assignment in Kestrel Link.\n\n` +
      `Dimensions: approximately 40 by 24 by 7 centimetres.\n\n` +
      `Power: the Kestrel Power Supply or a charged battery sled is required for a long take with ` +
      `phantom power on several inputs. Bus power alone can boot the unit but is not sufficient to avoid ` +
      `a shutdown under that load; see the troubleshooting guide for this model before treating a ` +
      `shutdown as a fault.\n\n` +
      `Connectivity: USB C to host for file offload and class compliant USB audio. Timecode in and out ` +
      `on BNC, plus word clock out. The clock and control bus for linking a Kestrel Field Preamp, using ` +
      `the Kestrel XLR Cable Set.\n\n` +
      `In the box: the Kestrel 10 Field Recorder, one Kestrel Power Supply, one Kestrel USB C Cable, a ` +
      `quick start sheet in English and French.\n\n` +
      `Compatible accessories: the Kestrel Travel Case and the Kestrel Windshield Pack's shoe mount are ` +
      `NOT interchangeable between the Kestrel 6 and the Kestrel 10; always confirm the Kestrel 10 ` +
      `specific version is being ordered or quoted, since the smaller versions do not fit.\n\n` +
      `Firmware: shares the same 1.8 series firmware and release train as the rest of the Kestrel range.\n\n` +
      `Warranty: 2 years standard, 4 years with the Extended Care Plan.\n\n` +
      `System requirements: same as the Kestrel 6, none in the field and a USB C capable computer ` +
      `running Kestrel Link for firmware, metadata templates and diagnostics.\n\n` +
      `Who it's for: a recordist working a larger crew day who needs ten inputs in one body and a ` +
      `mirrored second card, most often drama, documentary with several radio mics, or a music session ` +
      `captured on location.\n\n` +
      `Ordering note for support and sales: always confirm a customer ordering a Kestrel 10 understands ` +
      `the Kestrel Power Supply or a charged sled is effectively required, not merely recommended, per ` +
      `the power note above; a customer who buys the Kestrel 10 and runs it bus powered with phantom on ` +
      `eight inputs, then experiences a shutdown mid take, is a common and avoidable first ticket.\n\n` +
      `Care and cleaning\n` +
      `A soft, dry cloth for the enclosure and the connector panel, no solvents or abrasive cleaners; the ` +
      `same rule applies across the whole Kestrel range regardless of model size.\n\n` +
      `Export classification\n` +
      `HS 8519.81 on an international shipment, same heading as the rest of the Kestrel recorders; see ` +
      `the HS codes and product classification article for the full table.\n\n` +
      `Where this SKU sits in the catalog\n` +
      `Flagship tier, the highest priced model in the range; it counts toward a dealer's rolling twelve ` +
      `month volume the same as any other flagship SKU under the dealer pricing tiers article, and is ` +
      `the model most often quoted for a demo unit terms conversation given its price point.\n\n` +
      `Transport\n` +
      `At this size and weight the Kestrel 10 specific version of the Travel Case, not the standard one, ` +
      `is worth recommending for any customer moving the unit between locations regularly; the smaller ` +
      `case does not fit.\n\n` +
      `Typical buyer\n` +
      `A production sound mixer running a full bag or cart, or a rental house wanting one body that ` +
      `covers the largest jobs it hires out for.`,
  },
  {
    key: "spec-pocket",
    title: "Product spec sheet: Kestrel Pocket Recorder",
    collection: "products",
    owner: "lucas",
    summary: "Inputs, power, connectivity and box contents for the two input body (RAL-FLAG-03).",
    tags: ["spec", "RAL-FLAG-03"],
    reviewDueInDays: 90,
    verified: true,
    body:
      `SKU: RAL-FLAG-03. List price: 549.00 EUR. Weight: 1.2 kg.\n\n` +
      `Inputs: two XLR and TRS combo inputs with the same preamps as the rest of the range, 48 volt ` +
      `phantom power switchable per input, 32 bit float capture, plus a built in stereo pair for ` +
      `ambience and scratch tracks.\n\n` +
      `Dimensions: approximately 20 by 14 by 5 centimetres, sized for a bag or a large coat pocket.\n\n` +
      `Power: internal batteries or bus power over USB C. No external power supply exists for this model ` +
      `and none is needed.\n\n` +
      `Connectivity: USB C to host for file offload and class compliant USB audio. Timecode in on a 3.5 ` +
      `millimetre jack for a jam, with no timecode output and no clock and control bus port, reflecting ` +
      `the compact, travel focused design.\n\n` +
      `In the box: the Kestrel Pocket Recorder, one Kestrel USB C Cable, a quick start sheet in English ` +
      `and French.\n\n` +
      `Compatible accessories: the Kestrel Travel Case is sized for the Kestrel 6 and its cable set, not ` +
      `the Pocket; recommend checking with Lucas or the product listing before promising case fit to a ` +
      `customer. The Kestrel Windshield Pack's foam shields fit the Pocket's built in pair.\n\n` +
      `Notes for support: the built in microphones sit close to the body, so handling and wind noise ` +
      `reach them more easily than a boom mounted mic; see the troubleshooting guide before treating ` +
      `this as a fault.\n\n` +
      `Warranty: 2 years standard, 4 years with the Extended Care Plan.\n\n` +
      `System requirements: none in the field; a full firmware update still requires a computer running ` +
      `Kestrel Link, per the firmware release process article.\n\n` +
      `Who it's for: a recordist who travels light, a journalist or documentary maker working alone, or ` +
      `an owner of a larger Kestrel wanting a second body that lives permanently in a bag. It is the ` +
      `most commonly recommended pairing with the Windshield Pack, though note the Travel Case itself is ` +
      `sized for the Kestrel 6, not the Pocket, per the compatible accessories note above.\n\n` +
      `Ordering note for support and sales: the Pocket has no clock and control bus port and cannot link ` +
      `a Kestrel Field Preamp; a customer wanting more than two inputs needs the Kestrel 6 or the ` +
      `Kestrel 10 instead, which is worth surfacing before an order rather than after a confused ` +
      `unboxing.\n\n` +
      `Care and cleaning\n` +
      `A soft, dry cloth for the enclosure and the connector panel, no solvents or abrasive cleaners, ` +
      `matching the rest of the Kestrel range.\n\n` +
      `Export classification\n` +
      `HS 8519.81 on an international shipment; see the HS codes and product classification article for ` +
      `the full table.\n\n` +
      `Where this SKU sits in the catalog\n` +
      `Flagship tier, the lowest priced flagship model; it still counts toward a dealer's rolling twelve ` +
      `month volume under the dealer pricing tiers article the same as the larger models, which is worth ` +
      `clarifying to a dealer who assumes only the pricier models count.\n\n` +
      `Typical buyer\n` +
      `Often a second purchase for an existing Kestrel owner wanting a portable backup body, or a first ` +
      `purchase for someone prioritizing size and price over input count.\n\n` +
      `Packaging\n` +
      `Ships in a smaller box than the rest of the range, reflecting its compact size; this is worth ` +
      `mentioning to a customer who expects a box similar to the Kestrel 6's and asks whether something ` +
      `is missing.`,
  },
  {
    key: "spec-preamp",
    title: "Product spec sheet: Kestrel Field Preamp",
    collection: "products",
    owner: "lucas",
    summary: "Channels, connectivity and box contents for the four channel preamp (RAL-FLAG-04).",
    tags: ["spec", "RAL-FLAG-04"],
    reviewDueInDays: 90,
    verified: true,
    body:
      `SKU: RAL-FLAG-04. List price: 399.00 EUR. Weight: 1.8 kg.\n\n` +
      `Function: a four channel microphone preamp that links to a Kestrel recorder over the same clock ` +
      `and control bus, so the four added channels share the recorder's clock and its gain and phantom ` +
      `power control rather than behaving as a separate, unsynchronised box.\n\n` +
      `Dimensions: approximately 20 by 14 by 6 centimetres, sized to sit under or beside a recorder in ` +
      `the same bag.\n\n` +
      `Phantom power: 48 volts switchable per channel, with enough headroom in the supply to hold all ` +
      `four under a full condenser load. A brief dip as all four come up at once is normal, see the ` +
      `troubleshooting guide.\n\n` +
      `Connectivity: four XLR inputs, a line level output pair, and the clock and control bus link to a ` +
      `Kestrel 6 or Kestrel 10, using the Kestrel XLR Cable Set.\n\n` +
      `In the box: the Kestrel Field Preamp, a quick start sheet in English and French. The Kestrel XLR ` +
      `Cable Set is sold separately.\n\n` +
      `Common misdiagnosis: hiss or hum that appears only on the four linked channels is a ground loop ` +
      `in the studio or the location power far more often than a fault in the preamp itself; the ` +
      `troubleshooting guide has the room swap test that settles which one it is before any replacement ` +
      `is offered.\n\n` +
      `Warranty: 2 years standard, 4 years with the Extended Care Plan, covering phantom power faults ` +
      `and gain drift beyond what a Reset input stage pass corrects.\n\n` +
      `System requirements: none on its own as a standalone preamp into a line input; the clock and ` +
      `control bus features require a Kestrel 6 or Kestrel 10, and the preamp has no card slot and ` +
      `records nothing itself.\n\n` +
      `Who it's for: any Kestrel owner whose jobs occasionally need four more inputs than their body ` +
      `has, and any recordist wanting a clean four channel preamp that shares a clock with the recorder ` +
      `rather than a generic, unsynchronised one.\n\n` +
      `Ordering note for support and sales: the preamp is frequently the first thing a customer adds ` +
      `after their initial recorder purchase; when quoting or discussing an add on order, remember it ` +
      `counts toward a dealer's flagship tier volume under the dealer pricing tiers article, since it is ` +
      `a flagship SKU (RAL-FLAG-04), not an accessory, despite often being bought as one.\n\n` +
      `Care and cleaning\n` +
      `A soft, dry cloth is sufficient; the preamp's gain controls need no lubrication or maintenance ` +
      `under normal use, on location or in a studio.\n\n` +
      `Export classification\n` +
      `HS 8543.70 on an international shipment, a different heading from the Kestrel recorders since the ` +
      `preamp records nothing of its own; see the HS codes and product classification article for the ` +
      `full table and the reasoning.\n\n` +
      `Where this SKU sits in the catalog\n` +
      `Flagship tier alongside the three Kestrel recorders. It is the one flagship product most often ` +
      `bought as a genuine add on to an existing order rather than as a first purchase, which is worth ` +
      `keeping in mind when a customer asks whether it "counts" toward anything; it counts as a full ` +
      `flagship unit under the dealer pricing tiers article regardless of how it is positioned in the ` +
      `sale.\n\n` +
      `Typical buyer\n` +
      `A Kestrel 6 owner who keeps hitting six inputs on a busy day, or a rental house wanting one ` +
      `preamp that works consistently across every recorder in their inventory rather than a different ` +
      `box per job.`,
  },
]

export const PROJECT_SPECS: ProjectSpec[] = [
  {
    key: "PREAMP",
    name: "Kestrel Field Preamp launch",
    description:
      "Everything between a finished preamp and a product customers can buy and we can support.",
    icon: "rocket",
    owner: "elodie",
    tasks: [
      {
        key: "preamp-firmware",
        title: "Freeze launch firmware",
        description: "1.8.3 is the launch build. Nothing new goes in after the freeze, fixes only.",
        status: "done",
        assignee: "lucas",
        priority: "high",
        dueInDays: -21,
      },
      {
        key: "preamp-manual",
        title: "Write the preamp manual",
        status: "in_progress",
        assignee: "amina",
        priority: "high",
        dueInDays: -3,
        dependsOn: ["preamp-firmware"],
      },
      {
        key: "preamp-manual-en",
        title: "English manual copy",
        status: "done",
        assignee: "amina",
        parent: "preamp-manual",
        dueInDays: -8,
      },
      {
        key: "preamp-manual-fr",
        title: "French manual translation",
        status: "in_progress",
        assignee: "amina",
        parent: "preamp-manual",
        dueInDays: -1,
      },
      {
        key: "preamp-kb",
        title: "Troubleshooting guide in the knowledge base",
        status: "done",
        assignee: "lucas",
        parent: "preamp-manual",
        dueInDays: -5,
      },
      {
        key: "preamp-support-brief",
        title: "Brief the support desk on the ground loop test",
        description:
          "The hiss reports will come. Everyone needs the different room, different circuit test " +
          "before anyone promises a replacement.",
        status: "todo",
        assignee: "amina",
        priority: "high",
        dueInDays: 2,
        dependsOn: ["preamp-kb"],
      },
      {
        key: "preamp-packaging",
        title: "Sign off packaging and the customs paperwork insert",
        status: "in_progress",
        assignee: "margot",
        priority: "normal",
        dueInDays: 4,
      },
      {
        key: "preamp-dealer-pricing",
        title: "Set dealer pricing and tell the network",
        status: "todo",
        assignee: "giulia",
        priority: "normal",
        dueInDays: 6,
      },
      {
        key: "preamp-launch-review",
        title: "Go or no go review",
        status: "todo",
        assignee: "elodie",
        priority: "high",
        dueInDays: 9,
        dependsOn: ["preamp-support-brief", "preamp-packaging", "preamp-dealer-pricing"],
      },
      {
        key: "preamp-launch-video",
        title: "Launch video",
        status: "cancelled",
        assignee: "giulia",
        priority: "low",
        dueInDays: 12,
      },
    ],
  },
  {
    key: "BACKLOG",
    name: "Support backlog cleanup",
    description: "Work the queue back down to a one day first response and keep it there.",
    icon: "inbox",
    owner: "amina",
    tasks: [
      {
        key: "backlog-triage-old",
        title: "Triage everything older than 14 days",
        status: "in_progress",
        assignee: "amina",
        priority: "high",
        dueInDays: -2,
      },
      {
        key: "backlog-close-stale",
        title: "Close the no response tickets properly",
        description: "Two reminders then close, with a note saying it reopens if they write back.",
        status: "done",
        assignee: "lucas",
        dueInDays: -6,
      },
      {
        key: "backlog-macros",
        title: "Write reply templates for the five most common questions",
        status: "todo",
        assignee: "lucas",
        priority: "normal",
        dueInDays: 5,
        dependsOn: ["backlog-triage-old"],
      },
      {
        key: "backlog-kb-gaps",
        title: "Fill the knowledge gaps triage keeps hitting",
        status: "todo",
        assignee: "amina",
        priority: "normal",
        dueInDays: 8,
        dependsOn: ["backlog-triage-old"],
      },
      {
        key: "backlog-kb-review",
        title: "Review the two articles past their review date",
        status: "backlog",
        assignee: "amina",
        priority: "low",
        dueInDays: 14,
      },
      {
        key: "backlog-sla-report",
        title: "Weekly first response report to the whole team",
        status: "backlog",
        assignee: "tobias",
        priority: "low",
        dueInDays: 11,
      },
    ],
  },
  {
    key: "WEB",
    name: "Website refresh",
    description: "Rebuild the product pages around what customers actually ask us before they buy.",
    icon: "globe",
    owner: "giulia",
    tasks: [
      {
        key: "web-audit",
        title: "Audit the current pages against the top presales questions",
        status: "done",
        assignee: "giulia",
        dueInDays: -15,
      },
      {
        key: "web-copy",
        title: "Rewrite the flagship product copy",
        status: "in_progress",
        assignee: "giulia",
        priority: "normal",
        dueInDays: 3,
        dependsOn: ["web-audit"],
      },
      {
        key: "web-runtime-spec",
        title: "Publish the battery runtime figure",
        description:
          "People ask publicly and cannot find it. Get the measured number with phantom power on " +
          "every input, not a claim.",
        status: "todo",
        assignee: "lucas",
        priority: "normal",
        dueInDays: 7,
      },
      {
        key: "web-dealer-locator",
        title: "Dealer locator page",
        status: "backlog",
        assignee: "giulia",
        priority: "low",
        dueInDays: 21,
      },
      {
        key: "web-vat-note",
        title: "Say plainly that customs and duty are on the recipient",
        status: "todo",
        assignee: "henrik",
        priority: "high",
        dueInDays: -1,
      },
    ],
  },
  {
    key: "JPDEAL",
    name: "Japan dealer onboarding",
    description:
      "Bring Harborlight Audio KK up to a full dealer account, with stock and support cover.",
    icon: "handshake",
    owner: "giulia",
    tasks: [
      {
        key: "jp-contract",
        title: "Countersign the dealer agreement",
        status: "done",
        assignee: "giulia",
        dueInDays: -18,
      },
      {
        key: "jp-pricing",
        title: "Set them up on tier 2 pricing",
        status: "done",
        assignee: "henrik",
        dueInDays: -12,
        dependsOn: ["jp-contract"],
      },
      {
        key: "jp-demo-units",
        title: "Ship the two demo units",
        status: "in_progress",
        assignee: "margot",
        priority: "normal",
        dueInDays: 1,
        dependsOn: ["jp-pricing"],
      },
      {
        key: "jp-customs-pack",
        title: "Build the standing customs pack for Japan shipments",
        description:
          "Commercial invoice plus declaration, prepared once so no parcel ships without it.",
        status: "todo",
        assignee: "margot",
        priority: "high",
        dueInDays: -4,
      },
      {
        key: "jp-support-hours",
        title: "Agree support cover for the time difference",
        status: "backlog",
        assignee: "tobias",
        priority: "normal",
        dueInDays: 16,
      },
    ],
  },
]

export const EVENT_SPECS: EventSpec[] = [
  {
    key: "standup",
    title: "Morning standup",
    description: "Fifteen minutes: what landed, what is stuck, who needs a hand.",
    location: "Atelier, ground floor",
    day: 0,
    startHour: 8,
    startMinute: 15,
    durationMinutes: 15,
    attendees: ["elodie", "tobias", "amina", "lucas", "margot", "henrik", "giulia"],
    // The read path's RRULE parser treats a multi-day BYDAY as "complex" and
    // stops expanding, rendering only the master row. A plain daily rule is
    // what a daily standup is anyway, and `list_events` expands it properly.
    recurrence: ["RRULE:FREQ=DAILY;COUNT=20"],
  },
  {
    key: "queue-review",
    title: "Support queue review",
    description: "Everything older than a week, and anything that has been reopened.",
    day: 0,
    startHour: 14,
    durationMinutes: 45,
    attendees: ["amina", "lucas", "tobias"],
  },
  {
    key: "dealer-call-jp",
    title: "Dealer call: Harborlight Audio",
    description:
      "Onboarding check in: demo units, customs pack and support hours for the time difference.",
    location: "Video call",
    day: 1,
    startHour: 9,
    durationMinutes: 30,
    attendees: ["giulia", "tobias", "margot"],
  },
  {
    key: "shipping-sync",
    title: "Shipping and returns sync",
    day: 1,
    startHour: 15,
    startMinute: 30,
    durationMinutes: 30,
    attendees: ["margot", "tobias"],
  },
  {
    key: "launch-review",
    title: "Preamp launch: go or no go",
    description:
      "Firmware frozen, manual, packaging and dealer pricing. One decision at the end: ship or hold.",
    location: "Atelier, meeting room",
    day: 2,
    startHour: 10,
    durationMinutes: 90,
    attendees: ["elodie", "tobias", "amina", "lucas", "margot", "giulia"],
  },
  {
    key: "finance-close",
    title: "Month end close",
    description: "Reconcile the dealer accounts before the reminders go out.",
    day: 3,
    startHour: 9,
    durationMinutes: 120,
    attendees: ["henrik", "elodie"],
  },
  {
    key: "kb-hour",
    title: "Knowledge base hour",
    description: "Everyone takes one article past its review date and fixes it.",
    day: 3,
    startHour: 16,
    durationMinutes: 60,
    attendees: ["amina", "lucas", "margot", "henrik"],
  },
  {
    key: "offsite",
    title: "Team offsite",
    description: "No standup, no queue duty. Phones off.",
    day: 4,
    startHour: 0,
    allDay: true,
    attendees: ["elodie", "tobias", "amina", "lucas", "margot", "henrik", "giulia"],
  },
]

export const DEMO_CALENDAR_NAME = "Resonant Audio Labs team"

export const MAIL_CONVERSATIONS: MailConversationSpec[] = [
  {
    key: "org-dealer-restock",
    box: "org",
    subject: "Restock order for Q4",
    status: "open",
    labels: ["dealer"],
    isRead: false,
    isStarred: true,
    messages: [
      {
        direction: "inbound",
        fromName: "Klangwerk GmbH",
        fromEmail: "orders@eu-de.dealer.example",
        toName: "Resonant Audio Labs",
        toEmail: "support@resonantaudiolabs.example",
        hoursAgo: 3,
        body:
          "Good morning,\n\nWe would like to place our Q4 restock: 15 Kestrel 6 recorders, 8 Pockets and " +
          "20 Windshield Packs. Could you confirm the tier and the lead time before we raise the purchase " +
          "order?\n\nBest regards,\nKlangwerk",
      },
    ],
  },
  {
    key: "org-press-enquiry",
    box: "org",
    subject: "Review unit request for a feature",
    status: "open",
    labels: ["press"],
    isRead: false,
    isStarred: false,
    messages: [
      {
        direction: "inbound",
        fromName: "Sound On Stage",
        fromEmail: "editor@soundonstage.example",
        toName: "Resonant Audio Labs",
        toEmail: "support@resonantaudiolabs.example",
        // Before the loan reply approved 40 h ago, and before the runtime answer staged
        // 16 h ago: a mail from this address after a staged draft stops that draft's send.
        hoursAgo: 52,
        body:
          "Hello,\n\nWe are running a feature on location sound recorders next month and would like to " +
          "include the Kestrel 10. Could you loan us a review unit for four weeks?\n\n" +
          "Happy to cover shipping both ways.\n\nEditor, Sound On Stage",
      },
    ],
  },
  {
    key: "org-carrier-delay",
    box: "org",
    subject: "Service disruption notice for your account",
    status: "open",
    labels: ["logistics"],
    isRead: true,
    isStarred: false,
    messages: [
      {
        direction: "inbound",
        fromName: "Carrier Operations",
        fromEmail: "notices@carrier.example",
        toName: "Resonant Audio Labs",
        toEmail: "support@resonantaudiolabs.example",
        hoursAgo: 27,
        body:
          "Please be advised that sorting operations at the Lyon hub are running approximately 48 hours " +
          "behind schedule following a systems outage. Parcels already in the network will be delivered " +
          "with delay. No action is required from you.",
      },
    ],
  },
  {
    key: "org-supplier-invoice",
    box: "org",
    subject: "Invoice for the October panel print run",
    status: "open",
    labels: ["supplier"],
    isRead: true,
    isStarred: false,
    messages: [
      {
        direction: "inbound",
        fromName: "Precision Print",
        fromEmail: "accounts@precisionprint.example",
        toName: "Resonant Audio Labs",
        toEmail: "support@resonantaudiolabs.example",
        hoursAgo: 50,
        body:
          "Attached is our invoice for the October front panel print run, payable within 30 days. " +
          "Please let us know if anything needs correcting.\n\nPrecision Print",
      },
      {
        direction: "outbound",
        fromName: "Henrik Sandberg",
        fromEmail: "henrik@resonantaudiolabs.example",
        toName: "Precision Print",
        toEmail: "accounts@precisionprint.example",
        hoursAgo: 44,
        body:
          "Received, thank you. It is scheduled for payment on the due date.\n\n" +
          "One note for next time: our VAT number was missing from the header. Could you add it so we " +
          "do not have to request a correction?\n\nBest regards,\nHenrik",
      },
    ],
  },
  {
    key: "org-education-enquiry",
    box: "org",
    subject: "Equipping a teaching lab",
    status: "open",
    labels: ["sales"],
    isRead: false,
    isStarred: false,
    messages: [
      {
        direction: "inbound",
        fromName: "Conservatoire de Lyon",
        fromEmail: "achats@conservatoire-lyon.example",
        toName: "Resonant Audio Labs",
        toEmail: "support@resonantaudiolabs.example",
        hoursAgo: 72,
        body:
          "Bonjour,\n\nNous equipons un laboratoire pedagogique et souhaitons un devis pour dix " +
          "enregistreurs Kestrel Pocket avec supports. Notre commission d'achat se reunit a la fin du mois.\n\n" +
          "Cordialement,\nService des achats",
      },
    ],
  },
  {
    // Started by us: the first message is OUTBOUND, from the shared mailbox, so
    // the conversation's sender is our own address and the customer is the
    // first INBOUND sender.
    key: "org-acme-volume-quote",
    box: "org",
    subject: "Your volume quote for the measurement lab",
    status: "open",
    labels: ["sales"],
    isRead: false,
    isStarred: false,
    messages: [
      {
        direction: "outbound",
        fromName: "Resonant Audio Labs",
        fromEmail: "support@resonantaudiolabs.example",
        toName: "Jane Doe",
        toEmail: "jane.doe@acme-instruments.example",
        hoursAgo: 30,
        body:
          "Hello Jane,\n\nFollowing your call with Elodie, here is the volume quote for twelve Kestrel 6 " +
          "recorders with calibration, valid for thirty days. Tell us if the lab needs a different mix.\n\n" +
          "Best regards,\nResonant Audio Labs",
      },
      {
        direction: "inbound",
        fromName: "Jane Doe",
        fromEmail: "jane.doe@acme-instruments.example",
        toName: "Resonant Audio Labs",
        toEmail: "support@resonantaudiolabs.example",
        hoursAgo: 2,
        body:
          "Thanks for the quote. Before I raise the purchase order: can the twelve units ship in two " +
          "batches, six now and six next quarter, at the same price?\n\nJane",
      },
    ],
  },
  {
    key: "amina-team-cover",
    box: "amina",
    subject: "Queue cover next Friday",
    status: "open",
    labels: [],
    isRead: true,
    isStarred: false,
    messages: [
      {
        direction: "inbound",
        fromName: "Tobias Braun",
        fromEmail: "tobias@resonantaudiolabs.example",
        toName: "Amina Cherif",
        toEmail: "amina@resonantaudiolabs.example",
        hoursAgo: 19,
        body:
          "Amina, the offsite is Friday and nobody is on the queue. Can you and Lucas split the morning " +
          "between you, or should we set an away message and pick it up Monday?\n\nTobias",
      },
      {
        direction: "outbound",
        fromName: "Amina Cherif",
        fromEmail: "amina@resonantaudiolabs.example",
        toName: "Tobias Braun",
        toEmail: "tobias@resonantaudiolabs.example",
        hoursAgo: 18,
        body:
          "I will take the morning, Lucas takes the afternoon if anything urgent lands. Away message for " +
          "everything else saying we answer Monday.\n\nAmina",
      },
    ],
  },
  {
    key: "amina-kb-review",
    box: "amina",
    subject: "Two articles are past their review date",
    status: "open",
    labels: [],
    isRead: false,
    isStarred: false,
    messages: [
      {
        direction: "inbound",
        fromName: "Lucas Pereira",
        fromEmail: "lucas@resonantaudiolabs.example",
        toName: "Amina Cherif",
        toEmail: "amina@resonantaudiolabs.example",
        hoursAgo: 6,
        body:
          "The escalation paths article and the shipping timelines one are both overdue for review. " +
          "The shipping one still says seven days before we call a parcel lost, which is not what we do " +
          "now. Want me to take it at the knowledge base hour?\n\nLucas",
      },
    ],
  },
  {
    key: "henrik-vat-check",
    box: "henrik",
    subject: "Reverse charge on the Northfield account",
    status: "open",
    labels: [],
    isRead: true,
    isStarred: true,
    messages: [
      {
        direction: "inbound",
        fromName: "Elodie Vasseur",
        fromEmail: "elodie@resonantaudiolabs.example",
        toName: "Henrik Sandberg",
        toEmail: "henrik@resonantaudiolabs.example",
        hoursAgo: 30,
        body:
          "Henrik, Northfield have changed their registration. Before we reissue anything, can you " +
          "confirm we validated the new number and recorded the date? I do not want us carrying the VAT " +
          "on an unvalidated reverse charge.\n\nElodie",
      },
      {
        direction: "outbound",
        fromName: "Henrik Sandberg",
        fromEmail: "henrik@resonantaudiolabs.example",
        toName: "Elodie Vasseur",
        toEmail: "elodie@resonantaudiolabs.example",
        hoursAgo: 28,
        body:
          "Not yet: I have asked them for the certificate and I will validate the moment it arrives. " +
          "Nothing gets reissued before then, and they are outside the EU now in any case, so the " +
          "treatment does not change, only the number on the document.\n\nHenrik",
      },
    ],
  },
  {
    key: "giulia-jp-onboarding",
    box: "giulia",
    subject: "Harborlight demo units and customs pack",
    status: "open",
    labels: [],
    isRead: false,
    isStarred: false,
    messages: [
      {
        direction: "inbound",
        fromName: "Margot Dufour",
        fromEmail: "margot@resonantaudiolabs.example",
        toName: "Giulia Ferrari",
        toEmail: "giulia@resonantaudiolabs.example",
        hoursAgo: 8,
        body:
          "The two Harborlight demo units are packed and ready. I am holding them until the standing " +
          "customs pack is done, because the last Japan shipment went without a commercial invoice and " +
          "sat at customs for a week.\n\nMargot",
      },
    ],
  },
  {
    key: "lucas-firmware-beta",
    box: "lucas",
    subject: "1.8.3 beta build",
    status: "open",
    labels: [],
    isRead: false,
    isStarred: true,
    messages: [
      {
        direction: "inbound",
        fromName: "Firmware Build",
        fromEmail: "builds@resonantaudiolabs.example",
        toName: "Lucas Pereira",
        toEmail: "lucas@resonantaudiolabs.example",
        hoursAgo: 4,
        body:
          "Build 1.8.3-beta.2 is available. Changes since beta.1: dock enumeration timing fix, " +
          "input calibration persistence on the Kestrel 10.\n\nThis build is cleared for external testers.",
      },
    ],
  },

  // ── The long exchange ───────────────────────────────────────────────────
  //
  // The shared desk mailbox's one real back and forth: five messages in both
  // directions, ending in a decision. Everything else in this list is one or
  // two messages, which reads as an inbox nobody has answered yet.
  {
    key: "org-conservatoire-tender",
    box: "org",
    subject: "Teaching room fit out: twelve recorders and a question about mounts",
    status: "open",
    labels: ["education", "quote"],
    isRead: false,
    isStarred: true,
    messages: [
      {
        direction: "inbound",
        fromName: "Conservatoire de Lyon",
        fromEmail: "achats@conservatoire-lyon.example",
        toName: "Resonant Audio Labs",
        toEmail: "support@resonantaudiolabs.example",
        hoursAgo: 96,
        body:
          "Good afternoon,\n\n" +
          "We are fitting out a new location sound teaching room for the autumn intake and we are " +
          "looking at twelve of your recorders, one per station.\n\n" +
          "Before we put anything in front of our purchasing committee, we need to know two things: " +
          "what the price per unit is at that quantity, and whether the mounts can be fixed to a desk " +
          "rather than left free standing. The room is used by two hundred students a week and " +
          "anything loose walks.\n\n" +
          "With kind regards,\nPurchasing, Conservatoire de Lyon",
      },
      {
        direction: "outbound",
        fromName: "Giulia Ferrari",
        fromEmail: "support@resonantaudiolabs.example",
        toName: "Conservatoire de Lyon",
        toEmail: "achats@conservatoire-lyon.example",
        hoursAgo: 89,
        body:
          "Good afternoon,\n\n" +
          "Thank you for thinking of us, and for asking about the mounts first: it is the part most " +
          "people discover after the room is built.\n\n" +
          "At twelve units you sit in our education tier, and I can put the exact figures in a written " +
          "quote that your committee can hold on to. The quote stays valid for sixty days, which " +
          "should carry you past the meeting.\n\n" +
          "The mount has two mounting points on the underside and takes a standard desk clamp, so " +
          "fixing it down is a matter of a bracket rather than a modification. I can send the " +
          "measurements to whoever is building the desks.\n\n" +
          "Best,\nGiulia",
      },
      {
        direction: "inbound",
        fromName: "Conservatoire de Lyon",
        fromEmail: "achats@conservatoire-lyon.example",
        toName: "Resonant Audio Labs",
        toEmail: "support@resonantaudiolabs.example",
        hoursAgo: 61,
        body:
          "Thank you, the measurements would be very welcome. Our joiner starts on the desks in " +
          "October.\n\n" +
          "Two further points from the committee. They will want the quote to show the price with and " +
          "without the care kits, because the kits come out of a different budget line. And they have " +
          "asked whether you can deliver in two batches: six in September for the first group, six in " +
          "January.\n\n" +
          "Is a split delivery something you can hold the price on?",
      },
      {
        direction: "outbound",
        fromName: "Giulia Ferrari",
        fromEmail: "support@resonantaudiolabs.example",
        toName: "Conservatoire de Lyon",
        toEmail: "achats@conservatoire-lyon.example",
        hoursAgo: 54,
        body:
          "Yes to both, and neither costs you anything.\n\n" +
          "The quote will carry the recorders, the mounts and the care kits as separate lines, so " +
          "your committee can approve two budget lines against one document rather than asking us for " +
          "a second quote.\n\n" +
          "On the split: the price is set by the order, not by the number of parcels, so twelve " +
          "ordered in one go and delivered in two batches is the twelve unit price. What I would ask " +
          "is that the January batch is on the same order number, because a separate order in January " +
          "is a separate quantity and I would be back to explaining a higher figure.\n\n" +
          "The measurements for your joiner are attached to the quote.\n\n" +
          "Best,\nGiulia",
      },
      {
        direction: "inbound",
        fromName: "Conservatoire de Lyon",
        fromEmail: "achats@conservatoire-lyon.example",
        toName: "Resonant Audio Labs",
        toEmail: "support@resonantaudiolabs.example",
        hoursAgo: 20,
        body:
          "Understood, one order and two deliveries. The committee meets on the fourteenth and this is " +
          "on the agenda.\n\n" +
          "Please send the quote in the form you described and we will take it from there. If it helps " +
          "your planning, the room has to be working by the first week of term, so a September batch " +
          "is the part we cannot move.",
      },
    ],
  },
]

export const THREAD_SPECS: ThreadSpec[] = [
  {
    key: "launch-readiness",
    title: "Preamp launch readiness",
    creator: "elodie",
    participants: ["tobias", "amina", "lucas", "margot", "giulia"],
    pinned: true,
    messages: [
      {
        author: "elodie",
        hoursAgo: 30,
        body:
          "Go or no go is Wednesday. Before then I want one line from each of you: ready, or not ready " +
          "and what is missing. No essays.",
      },
      {
        author: "lucas",
        hoursAgo: 28,
        body: "Firmware ready. 1.8.3 is frozen and beta.2 is out to testers.",
      },
      {
        author: "margot",
        hoursAgo: 27,
        body:
          "Not ready. Packaging is signed off but the customs paperwork insert is not, and I will not " +
          "ship an export without it. Two days.",
      },
      {
        author: "amina",
        hoursAgo: 26,
        body:
          "Nearly. English manual and the troubleshooting guide are done, French translation lands " +
          "tomorrow. The desk brief on the ground loop test has not happened yet and it needs to before " +
          "we ship, or we will replace preamps that are not faulty.",
      },
      {
        author: "giulia",
        hoursAgo: 25,
        body: "Dealer pricing is set, the network goes out Monday. Ready.",
      },
      {
        author: "tobias",
        hoursAgo: 24,
        body: "So the two blockers are the customs insert and the desk brief. Both are two days. Wednesday holds.",
      },
    ],
  },
  {
    key: "hiss-pattern",
    title: "Preamp hiss: are we replacing units we should not be?",
    creator: "amina",
    participants: ["lucas", "tobias"],
    messages: [
      {
        author: "amina",
        hoursAgo: 20,
        body:
          "Jasper's replacement developed the same hiss. That is the second time a replacement has come " +
          "back with an identical fault, which tells me it is not the preamp.",
      },
      {
        author: "lucas",
        hoursAgo: 19,
        body:
          "Agreed. Both are studios with an interface on a different circuit. It is a ground loop and we " +
          "have been treating it as a batch problem.",
      },
      {
        author: "amina",
        hoursAgo: 19,
        body:
          "I have put the different room, different circuit test into the preamp guide as the thing to " +
          "run before anyone promises a replacement. And we send an isolating transformer at our cost " +
          "where someone has already been through a cycle. Cheaper than a third unit and it actually " +
          "works.",
      },
      {
        author: "tobias",
        hoursAgo: 18,
        body: "Good. Put it in the launch brief too so the desk has it before the volume arrives.",
      },
    ],
  },
  {
    key: "support-agent-triage",
    title: "Morning triage with the support desk",
    creator: "amina",
    participants: [],
    messages: [
      {
        author: "amina",
        hoursAgo: 5,
        body: "What has landed overnight that I should look at first?",
      },
      {
        author: "@support",
        hoursAgo: 5,
        body:
          "Three things stand out.\n\n" +
          "A Kestrel 10 that will not power on at all, opened two and a half hours ago and unassigned. " +
          "The customer has already tried both cables, the power supply and a fresh set of batteries, " +
          "so it reads as a hardware fault rather than a setup problem.\n\n" +
          "Three dead inputs on a Kestrel 6 bought in March, assigned to Lucas. The customer ruled out " +
          "the cables and the microphones before writing, and the three are flat in the recorder's own " +
          "meters, which the guide calls an input board fault.\n\n" +
          "A parcel that has not scanned in nine days. The shipping article says seven days with no " +
          "scan is a lost parcel, so that one is past the point where we should still be chasing it.",
      },
      {
        author: "amina",
        hoursAgo: 4.8,
        body: "Take the Kestrel 10 first. What does the guide say before we send a replacement?",
      },
      {
        author: "@support",
        hoursAgo: 4.8,
        body:
          "For the Kestrel 10 specifically, check what it was powered from before treating it as a " +
          "fault: with phantom power on several inputs it draws more than a standard USB port supplies, " +
          "and without the Kestrel Power Supply or a charged sled it can boot and then die under load.\n\n" +
          "This customer says they tried the supply and fresh batteries, so that is already ruled out. A " +
          "unit showing nothing with the supply connected and a known good cable goes straight to " +
          "replacement, no second round of questions.",
      },
      {
        author: "amina",
        hoursAgo: 4.6,
        body: "That is what I thought. I will assign it to myself and raise the replacement now.",
      },
    ],
  },
  {
    key: "kb-gaps",
    title: "Knowledge gaps triage keeps hitting",
    creator: "lucas",
    participants: ["amina"],
    messages: [
      {
        author: "lucas",
        hoursAgo: 12,
        body:
          "Three questions this week that the knowledge base does not answer: battery runtime with " +
          "phantom power on every input, whether windshield packs count towards a dealer tier, and what " +
          "happens to the warranty period on a replacement unit.",
      },
      {
        author: "amina",
        hoursAgo: 11,
        body:
          "The second two are answered, just not where anyone looks. Tier counting is in the pricing " +
          "article and the replacement warranty is in the RMA procedure. Runtime is genuinely missing " +
          "and people are asking publicly, so that one is a website job as much as a knowledge base one.",
      },
    ],
  },

  // ── Channels ────────────────────────────────────────────────────────────
  //
  // Rooms that describe themselves: a title, the one line beside it and the
  // standing "what is this for". Two are ordinary team channels the desk works
  // in alongside a role agent. The third is DISCOVERABLE, which is the row a
  // member who is not in it sees in the channel browser, topic and all.
  {
    key: "desk-shift-handover",
    title: "Desk handover",
    creator: "amina",
    participants: ["lucas", "margot"],
    topic: "What the next shift needs to know, once a day, before anyone logs off",
    description:
      "The support desk's running handover. One post at the end of each shift: what is still open " +
      "and who owns it, anything a customer was promised and by when, and anything the next person " +
      "would otherwise have to work out twice.\n\n" +
      "This is not the place to debug a fault. Take that to the ticket, and leave the one line here " +
      "that says where it got to.",
    messages: [
      {
        author: "lucas",
        hoursAgo: 9,
        body:
          "Handing over. Two live things.\n\n" +
          "The Kestrel 10 that will not power on is still unassigned and the customer has now waited " +
          "most of a day. It needs somebody this evening, not tomorrow morning.\n\n" +
          "The parcel that has not scanned in nine days is past the point where the guide says we stop " +
          "chasing and replace, so it is a decision rather than a phone call.",
      },
      {
        author: "@support",
        hoursAgo: 8.8,
        body:
          "Adding the two that will land on the next shift whether or not anyone opens them.\n\n" +
          "The windshield fit question has been open a day and a half with no reply, and it is a " +
          "two minute answer: the tolerance is in the Kestrel 6 troubleshooting guide.\n\n" +
          "The dealer volume question from Kanaal Audio is the one with money attached. It has been " +
          "open since yesterday morning, and a dealer chasing a price twice tends to ask somebody " +
          "else the third time.",
      },
      {
        author: "margot",
        hoursAgo: 8.5,
        body:
          "I have the parcel. Replacing it tonight and chasing the carrier for the claim separately, " +
          "so the customer is not waiting on our paperwork.",
      },
      {
        author: "amina",
        hoursAgo: 8.2,
        body:
          "I will take the Kestrel 10 myself and raise the replacement before I go. The windshield one " +
          "is a template reply, whoever opens it first.\n\n" +
          "Leaving the dealer question for Giulia in the morning rather than guessing at a tier and " +
          "having to walk it back.",
      },
    ],
  },
  {
    key: "shipping-exceptions",
    title: "Shipping exceptions",
    creator: "margot",
    participants: ["tobias", "amina"],
    topic: "Parcels that have gone wrong, and what we decided to do about each one",
    description:
      "Every parcel that stops moving, gets damaged, gets refused at customs or arrives at the " +
      "wrong address ends up here, with the decision written next to it.\n\n" +
      "The point is the decision, not the sympathy: replace, refund, chase or wait, and who is " +
      "telling the customer. If a pattern shows up across several parcels, it becomes a task on the " +
      "operations board rather than a longer thread here.",
    messages: [
      {
        author: "margot",
        hoursAgo: 30,
        body:
          "Three exceptions this week, which is one more than usual and all three are the same lane.\n\n" +
          "Two parcels into Japan sat at customs because the commercial invoice was not in the pouch, " +
          "and one came back to us entirely.",
      },
      {
        author: "@operations",
        hoursAgo: 29.5,
        body:
          "That lane has produced five of the last eight exceptions on record, and every one of them " +
          "names the same missing document.\n\n" +
          "The standing customs pack exists as a task on the operations board and has not moved in " +
          "eleven days. Until it does, each shipment to that territory depends on whoever packs it " +
          "remembering what the last one was held for.",
      },
      {
        author: "tobias",
        hoursAgo: 29,
        body:
          "Then it stops being a packing habit and becomes a rule: nothing leaves for that territory " +
          "without the pack, and the pack is done this week rather than when there is time.",
      },
      {
        author: "margot",
        hoursAgo: 28.6,
        body:
          "Agreed. I am holding the two demo units that were due to go out on Thursday until it is " +
          "written, and I would rather explain a short delay than another week in a customs shed.",
      },
    ],
  },
  {
    // The developer scenario's bug list: the visitor's agent reads it, then
    // hands the battery bug to the recorded laptop, whose recording fixes it
    // (apps/api/src/modules/demo/replay/recording.json). A team room, so the
    // workspace's owner is a member (seed-accounts.ts) without writing in it.
    key: "firmware-bugs",
    title: DEV_BUGS_CHANNEL_TITLE,
    creator: "amina",
    participants: ["lucas", "tobias"],
    topic: "Bugs from support and the test bench, one message per bug",
    description:
      "Where support and the production test bench report what looks like a firmware or app bug. " +
      "One message per bug: the product, the firmware version, what the customer sees and how often. " +
      "Whoever picks one up says so in the thread, so nobody fixes the same bug twice.",
    messages: [
      {
        author: "tobias",
        hoursAgo: 52,
        body:
          "Kestrel 6, firmware 1.8.3: after a battery swap the clock resets to 1 January 2000, so the " +
          "first takes of the day carry the wrong date. Seen on two units at the test bench.",
      },
      {
        author: "amina",
        hoursAgo: 30,
        body:
          "Kestrel Link quits on launch since the last update, on two Windows laptops: the splash " +
          "screen shows, then it closes. Reinstalling does not help. Diagnostics are on the ticket.",
      },
      {
        author: "lucas",
        hoursAgo: 6,
        body:
          "Kestrel 6, firmware 1.8.3: the battery percentage stays at 99% after a full charge and " +
          "never reaches 100%. Three customers this week. The charge itself looks fine, only the " +
          "percentage is stuck, but it is the one people write in about.",
      },
    ],
  },
  {
    key: "product-feedback-open",
    title: "Product feedback",
    creator: "elodie",
    participants: ["lucas", "giulia"],
    discoverable: true,
    topic: "What customers keep telling us about the hardware, open to anyone in the company",
    description:
      "An open room: anyone here can read it and anyone can join it, whether or not they talk to " +
      "customers for a living.\n\n" +
      "What goes in is what customers actually said, in their words, with a link to where they said " +
      "it. What does not go in is a roadmap argument. The point is that the people designing the next " +
      "revision hear the same sentence we hear on the desk, rather than a summary of it three months " +
      "later.",
    messages: [
      {
        author: "lucas",
        hoursAgo: 40,
        body:
          "The same sentence three times this month, from three unrelated customers: they cannot find " +
          "a battery runtime figure anywhere and they assume the worst because of it.\n\n" +
          "Nobody has complained that the runtime is short. They have complained that we will not say " +
          "what it is.",
      },
      {
        author: "giulia",
        hoursAgo: 39,
        body:
          "Dealers ask the same thing, and they ask it in front of a customer who is holding the unit. " +
          "Not having a number is the part that costs us, not the number.",
      },
      {
        author: "elodie",
        hoursAgo: 38,
        body:
          "Then we measure it properly and publish it, including the part we are less proud of. A " +
          "figure we stand behind beats a silence people fill in for themselves.",
      },
    ],
  },
]

export const AGENT_DM_SPECS: AgentDmSpec[] = [
  {
    key: "owner-personal-brief",
    agent: "personal",
    messages: [
      {
        from: "owner",
        hoursAgo: 3,
        body: "Before I open anything: what actually needs me this morning, and what can wait?",
      },
      {
        from: "agent",
        hoursAgo: 3,
        body:
          "Two things need you, and neither is a ticket.\n\n" +
          "A quote for the Conservatoire is waiting on your approval and has been for fourteen hours. " +
          "It is twelve units at the education tier, so it is the largest thing in the tray by some " +
          "distance, and the committee it is going to meets on the fourteenth.\n\n" +
          "A refund of 1349 euros was recorded against an order that was cancelled before it shipped " +
          "and never released, which means the customer has been waiting on money we already agreed " +
          "to send back.\n\n" +
          "Everything else in the tray is desk work that has an owner.",
      },
      {
        from: "owner",
        hoursAgo: 2.8,
        body: "The refund first then. Why has it sat there?",
      },
      {
        from: "agent",
        hoursAgo: 2.8,
        body:
          "It was raised on a Friday afternoon and the person who could approve it was the person who " +
          "raised it, so it has been waiting for a second pair of eyes rather than for a decision.\n\n" +
          "Nothing about it is unusual: the order was cancelled before picking, the amount matches the " +
          "invoice line for line, and the note on it says what happened in one sentence. It is the " +
          "kind of request that sits for three days because nobody thinks it is theirs.",
      },
      {
        from: "owner",
        hoursAgo: 2.6,
        body:
          "Fine. I will release that now and read the quote properly rather than skim it.\n\n" +
          "Separately, I want to know if anything else in the tray has been waiting more than two days. " +
          "That is the pattern I care about, not the individual case.",
      },
      {
        from: "agent",
        hoursAgo: 2.6,
        body:
          "Nothing else has, today. Over the last month, four requests waited longer than two days and " +
          "three of them were money: a refund, a credit note and a quote.\n\n" +
          "All three were raised by the person who would normally approve them, which is the same " +
          "shape as this morning's. If you want that to stop being a pattern, the change is a standing " +
          "second approver for finance requests rather than a reminder to be quicker.",
      },
    ],
  },
  {
    key: "owner-support-desk",
    agent: "@support",
    messages: [
      {
        from: "owner",
        hoursAgo: 26,
        body:
          "I am being asked about our response times by a dealer, and I would rather quote the real " +
          "number than the one I would like it to be. What is it?",
      },
      {
        from: "agent",
        hoursAgo: 26,
        body:
          "First reply on a dealer ticket averages four hours in working time over the last thirty " +
          "days, and the slowest was nineteen.\n\n" +
          "End customers average nine hours, which is the number most people mean when they ask. The " +
          "gap is deliberate: dealer tickets carry a priority that puts them at the top of the queue.\n\n" +
          "The number I would not quote is the average time to RESOLVE, because it is dragged around " +
          "by a handful of warranty repairs that wait on a bench rather than on us.",
      },
      {
        from: "owner",
        hoursAgo: 25.6,
        body: "Four hours is better than I expected. Is it getting worse or better?",
      },
      {
        from: "agent",
        hoursAgo: 25.6,
        body:
          "Slightly better, and for a reason worth knowing: the biggest single improvement came from " +
          "the troubleshooting guide, not from anyone answering faster.\n\n" +
          "Since the preamp guide got the different room, different circuit test written into it, the " +
          "hiss tickets stopped turning into three message conversations before anyone could act. That " +
          "is four or five tickets a month that now close on the first reply.",
      },
      {
        from: "owner",
        hoursAgo: 25.2,
        body:
          "Then the lesson is that the knowledge base is a response time tool, which is not how anyone " +
          "here talks about it.\n\n" +
          "Give me the three questions that cost us the most messages and are not written down " +
          "anywhere. I will raise them as work rather than as a complaint.",
      },
      {
        from: "agent",
        hoursAgo: 25.2,
        body:
          "Battery runtime with phantom power on every input, which is asked publicly as well as " +
          "privately and has no answer anywhere on the site.\n\n" +
          "Whether windshield packs count towards a dealer volume tier, which is answered inside the " +
          "pricing article where no dealer thinks to look.\n\n" +
          "What happens to the warranty period after a repair, which is in the returns procedure and " +
          "nowhere a customer can read.\n\n" +
          "Two of the three are a placement problem rather than a writing one, which is the cheaper " +
          "half to fix.",
      },
    ],
  },
]
