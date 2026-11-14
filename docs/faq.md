---
title: Frequently asked questions
description: "Short answers about what Liaison is, models, approvals, data, computers, apps, backups, the licence and security, each with a link to the page that covers it."
---

Short answers to what people ask before and after adopting Liaison. Each one links to the page with the full steps.

## What is Liaison?

Liaison is an agent-native business operating system: your team's mail, tickets, knowledge, invoicing, shipping and more in one workspace, with AI agents that work alongside you under the same permissions. It is modular, so anyone can build a new app on its kernel. See [Introduction](getting-started/introduction.md) and [How agents work](agents/how-agents-work.md).

## Do I have to self-host, or can I just try it?

You can try it first. The demo at [demo.liaison.sh](https://demo.liaison.sh) gives you your own copy of Resonant Audio Labs, a fictional company, and the agents work out of the box, with no model key to bring. The demo workspace expires after 72 hours. To run it for your team, self-host with Docker Compose. See [Try the demo](getting-started/demo.md) and [Install Liaison](getting-started/install.md).

## Which AI models does it work with?

You bring your own key. Supported providers are Anthropic, OpenAI, Google, Mistral and OpenRouter, and an administrator chooses which models the organization may use. For agents that read outside input, the security policy recommends a frontier model and choosing it explicitly instead of leaving it on Auto. See [Choose a model](agents/models.md).

## Can agents act without my approval?

Sensitive actions such as customer replies, invoices, discounts and record merges wait for a person, who can edit or reject them. Which tools run on their own is configurable, and an administrator sets who must approve what. Once an agent has read outside content in a turn, any action that leaves your company waits for a person. See [Approve what agents do](agents/approvals.md) and [Tools agents can use](agents/tools.md).

## What can an agent see?

Only what the person it works for can see. Row-level security in Postgres decides, not the agent's judgment, so an agent cannot read or change anything that person cannot. See [Control what agents can access](agents/permissions.md).

## Where does my data live?

On your own servers. A self-hosted Liaison is one app image plus Postgres, Redis, MeiliSearch and an S3-compatible object store, each with its own Docker volume. Point the object store at your own S3-compatible endpoint if you prefer. See [Run Liaison with Docker](self-hosting/docker.md) and [Production setup](runbooks/production-bootstrap.md).

## Does it work with Gmail and IMAP?

Yes. The Mail app connects Gmail accounts and IMAP/SMTP mailboxes. Agents can search mail and draft replies that wait for your approval. See [Mail](apps/mail.md).

## Is there a built-in CRM pipeline?

Yes. Companies, their people and a timeline of their mail, tickets, invoices and meetings are in Contacts, and deals sit on a pipeline in Projects, with an amount, stages and a next step. Agents can follow up quiet deals, and every commercial mail respects opt-outs. See [Companies](sales/companies.md), [Track deals on a pipeline](sales/deals.md) and [Opt-outs](sales/opt-outs.md). If your deals live in another CRM or ERP, connect it with the API connector (see [Connect your own CRM or ERP](sales/connect-your-crm.md)).

## What is a computer (node), and does code run on my machine?

A computer is one of your own machines running the Liaison desktop app, switched on for agents. When an agent hands it work, a coding session runs on that machine, in the folders you shared, with your files and git login. See [What a computer is](computers/what-is-a-node.md) and [Security of a computer](computers/security.md).

## Does it run Claude Code or Codex on computers?

Claude Code. The desktop app embeds the Claude Agent SDK and sessions use your own Claude account. The code has no Codex runtime for computers. Codex only appears in the setup instructions, where it can follow the setup playbook from a clone of the repository. See [Connect your computer](computers/connect.md) and [Install Liaison](getting-started/install.md).

## Are there phone and desktop apps?

Yes. Desktop apps for macOS and Windows and a mobile shell for iOS and Android wrap the same web app. A computer can only be the desktop app, but a browser or the phone can start sessions on it and approve what they ask. See [Install the desktop and phone apps](getting-started/desktop-and-phone.md).

## How do I back up and upgrade?

Run `./deploy/backup.sh` to write one archive that `./deploy/restore.sh` can bring back on this machine or another. To upgrade, back up, point the stack at the new image tag and restart. Migrations run when the container starts. See [Back up and restore](admin/backups.md) and [Upgrade Liaison](admin/upgrades.md).

## What is the licence?

Liaison uses the Functional Source License, Version 1.1, with an Apache 2.0 future licence. You may use it for any purpose other than a Competing Use, which includes internal use. On the second anniversary of the date a version is made available, you may use that version under Apache License 2.0. Read the [LICENSE](../LICENSE) file for the exact terms.

## How do I report a security issue?

Do not use public issues. Use GitHub private vulnerability reporting from the repository's Security tab, or email mathieu@liaison.sh with steps to reproduce, the affected version and the impact. See [Security](security.md).

## How do I build an app?

Build a sandboxed plugin app with the SDK, package it and install it like any bundled app. See [Build an app](app-development.md) and [App package format](app-package-format.md).

## How do I set up an organization without clicking through the UI?

Describe it in one file and run `liaison config apply`: org, admin, members, model keys, mailboxes, ticket inboxes, apps and knowledge. See [Config as code](provisioning-cli.md).
