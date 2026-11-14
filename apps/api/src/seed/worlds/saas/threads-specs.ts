// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The `saas` world's team conversations: the Pipeline, Product feedback and
// Support handover channels, and the Rota bugs room the developers work in.
import type { DemoThreadSpecs } from "~/seed/tiers/demo/seed-support"

export const SAAS_CHANNEL_TITLES = {
  pipeline: "Pipeline",
  feedback: "Product feedback",
  handover: "Support handover",
  bugs: "Rota bugs",
} as const

export const SAAS_THREAD_SPECS: DemoThreadSpecs = {
  threads: [
    {
      key: "pipeline",
      title: SAAS_CHANNEL_TITLES.pipeline,
      creator: "tom",
      participants: ["tom", "elodie", "maxime", "yann"],
      discoverable: true,
      topic: "Deals, demos and group expansions",
      messages: [
        {
          author: "tom",
          body: "Maison Arlon wants the 4 more hotels on Group. Proposal is out, I confirm the rollout date with Claire.",
          hoursAgo: 70,
        },
        {
          author: "maxime",
          body: "Pont Neuf went quiet after the demo. I will try once more before I go.",
          hoursAgo: 30,
        },
      ],
    },
    {
      key: "product-feedback",
      title: SAAS_CHANNEL_TITLES.feedback,
      creator: "lucie",
      participants: ["lucie", "ines", "tom", "baptiste", "amel", "jonas"],
      discoverable: true,
      topic: "What customers ask for, in their words",
      messages: [
        {
          author: "ines",
          body: "Third group this month asking for single sign-on for their managers.",
          hoursAgo: 50,
        },
        {
          author: "lucie",
          body: "Noted on the roadmap. Jonas, can you size it?",
          hoursAgo: 46,
        },
      ],
    },
    {
      key: "support-handover",
      title: SAAS_CHANNEL_TITLES.handover,
      creator: "ines",
      // Not discoverable: a conversation the owner has not joined cannot be read, and the
      // demo's accounts layer seats the owner in every channel that is not a browsable one
      // (like the developers' room). The founder is named so he holds a seat too.
      participants: ["ines", "clemence", "nolan", "baptiste", "jonas", "yann"],
      topic: "Bugs and blocked customers handed to the developers",
      messages: [
        {
          author: "ines",
          body: "Maison Arlon's payroll export stops after the fourth hotel. Their payroll runs at the end of the week.",
          hoursAgo: 28,
        },
        {
          author: "baptiste",
          body: "Reproduced. The export pages wrongly past four venues; fix in progress.",
          hoursAgo: 24,
        },
      ],
    },
    {
      key: "rota-bugs",
      title: SAAS_CHANNEL_TITLES.bugs,
      creator: "yann",
      participants: ["yann", "baptiste", "amel", "jonas", "ines"],
      topic: "The developers' room for rota bugs",
      messages: [
        {
          author: "amel",
          body: "Invitation links expire after 48 hours in the app; Vauban's waiters hit it.",
          hoursAgo: 3,
        },
      ],
    },
  ],
  agentDms: [
    {
      key: "owner-personal",
      agent: "personal",
      messages: [
        { from: "owner", body: "What needs me first?", hoursAgo: 1 },
        {
          from: "agent",
          body: "Maison Arlon's card payment failed and Élodie is away, so the reminder waits for you. Then the Lumen follow-up.",
          hoursAgo: 1,
        },
      ],
    },
  ],
}
