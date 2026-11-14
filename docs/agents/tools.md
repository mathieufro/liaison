---
title: Tools agents can use
description: "See the kinds of tools an agent has, which scope each needs, which ones wait for approval, and how an agent finds them."
---

An agent acts through tools. Some ship with Liaison itself, some come from the apps you install, and some come from external services you connect. This page lists them, so you know what an agent can reach and what will stop to ask first.

## The four kinds of tool

| Kind | Where it comes from | How it is named |
| --- | --- | --- |
| Kernel tools | Liaison itself: conversations, files, memory, the web, contacts, skills, routines, approvals, administration. | `kernel__<tool>`, for example `kernel__threads_reply`. |
| App tools | Each installed app, for example Mail, Tickets, Invoicing, Shipping. | `<app>__<tool>`, for example `mail__search` or `tickets__reply`. |
| Connector tools | Apps that read an outside system: the API connector, the database connector, GitLab, Google Drive. | The same `<app>__<tool>` form. See [GitLab](../apps/gitlab.md), [Google Drive](../apps/google-drive.md), [API connector](../api-connector.md) and [Database connector](../database-connector.md). |
| MCP server tools | External MCP servers you connect. | `mcp__<server>_<tool>`. See [Connect MCP servers](../agents/mcp-servers.md). |

Every tool has a scope. The agent sees a tool only when the scope is inside its access, so a person who cannot read tickets never gets an agent that can. See [Control what agents can access](../agents/permissions.md).

## How an agent finds a tool

Most kernel tools and all app tools are loaded on demand. The agent calls `tool_search` with keywords, or with `select:name` when it knows the exact name, and the matching tools become callable on its next step. The search ranks by words and, where meaning is on, by meaning as well, so a request in plain words, such as "Marc left, cut his access", finds the tool that deactivates a user. It ranks only the tools the agent may use. Meaning is on by default in the managed edition and off by default on a self-hosted server, which can turn it on ([Tool search model](../self-hosting/docker.md#tool-search-model)). The model runs in one embedding process for the whole server; while that process is not running or answers slowly, the search ranks by words alone. When nothing matches, the search loads nothing and names the apps it can search, with how many tools each has. A `select:` with a bare name that two apps share, such as `refunds_create`, loads neither and lists both, so the agent names the one it means. `tool_search` needs `kernel:threads:read`. A role agent without that scope has no app tools at all.

The search reads each word beyond its exact spelling: another form of it (`factures`, `invoicing`), a misspelling of five letters or more (`refnud`), and common French words and plain synonyms for the English words of tool names (`rembourser`, `money` for a refund). In a query of several words, a word few tools answer to counts more than a common one such as `send` or `list`.

A conversation keeps the same tool list from its first turn to its last, so the model provider can reuse its cached copy of the conversation. A tool loaded later is not added to that list: its description and parameters arrive in the conversation, and the agent calls it through `call_tool` with the tool's name and arguments. When the arguments do not fit, `call_tool` answers with the tool's name and the parameters it expects. When the name is no tool the agent can call, for instance one that was replaced by another, `call_tool` says so and points at a `tool_search` by the job in words, since `select:name` only works for a name that a search has returned.

At the start of a turn the agent also loads, on its own guess, the other tools of the apps the last turns worked with and of the page you are on. Those are listed by name and purpose only. A tool's description and parameters arrive once the agent asks for it: a `tool_search` naming it, or a first call. A first call with fitting arguments runs; one whose arguments do not fit does not run, and its answer shows the parameters.

When the org has an API connection to its CRM or ERP, the agent's prompt names each connected system with its read and write operations on every page, and a search such as "add a note to a company in the CRM" finds the connector's write tool, which asks for approval. See [API connector](../api-connector.md).

The full generated list, app tools included, is the [agent tools reference](../reference/agent-tools.md).

If something looks missing, ask the agent to run `list_locked_capabilities`. It lists the tools you lack the scope for, with the scope each needs, and can then ask for access with `request_scope`. An MCP server you may not use is the exception: its tools are not listed at all, because an admin decides who uses each organization server on its page (see [Choose who can use an organization server](mcp-servers.md#choose-who-can-use-an-organization-server)).

When a tool keeps failing with an error that will not change on a retry, the agent stops calling it for the rest of its turn after three steps that failed. Several calls the agent makes at once in one step count as one, so a corrected call on the next step still runs.

## Which tools wait for approval

The **Approval** column in the tables below uses these values.

| Value | Meaning |
| --- | --- |
| Yes | The call always becomes an approval request. Nothing runs until a person approves. |
| When it overwrites | Registering a new sub-agent role runs directly. Replacing an existing one waits for a person. |
| Owner decides if outside text was read | Only the person's own typed turn may call it; a message from a device sign-in does not count as one. If the turn read text from outside the organization, it becomes an approval that only the owner of the computer can decide. A routine, another agent or an MCP client is refused. |
| Only a change to autonomy | Model, level and effort changes go through the session's own owner confirmation. Switching a session to run on its own takes the same path as starting work on your computer. |
| No | It runs directly, within the agent's access. |

A kernel tool's request is decided by anyone who holds the tool's own scope, the person who asked included: whoever holds `kernel:contacts:write` decides a contact edit. Administrative tools (roles, users, policies, routines, apps, configuration, connections and access to a computer) are decided by `kernel:approve`. See [Who can approve](../agents/approvals.md#who-can-approve).

When an approved call fails (the tool answers with an error), its card says it failed, gives the reason and goes back to waiting for a decision. It never says the call ran.

A tool marked **No** can still wait. After an agent has read outside text, such as an inbound mail or a web page, its outward-facing tools become approval requests as well. See [Hold actions after outside content](../agents/approvals.md#hold-actions-after-outside-content). An auto-approve policy lets a tool marked **Yes** run without a person, but not once the conversation has read data that needs a scope, such as a contact search: the call waits for a person, whatever the tool. When a tool marked **No** waits only because of that data, anyone who holds every scope the conversation read decides it, including the person who asked. App tools declare their own gates. Sending a mail, replying to a ticket, issuing an invoice and creating a shipment are gated. See [Approve what agents do](../agents/approvals.md).

When an agent chains actions into one request (a mail reply that attaches the PDF of a proforma it just prepared) and reads more data before the next step, the whole request waits for a person who holds everything it read: it is never refused for that. When the steps act on your own things, such as your own mailbox, you decide it.

When an agent posts into another conversation, or starts one, after reading data that some people there may not see, the message waits for your approval instead of being posted where they could not read it. Its card says how many people in that conversation cannot see the data: approving shares the message with them, and later messages your agent posts there with the same kind of data are then posted right away. A message everyone there may read is posted right away, and so is a direct message to one person: telling them is your choice. A message carrying data you cannot see yourself (a routine can read more than you) is never posted. Someone who joins later and cannot see the data does not read those messages. This holds the same way for an app such as Claude Code connected to Liaison as you. For such an app, only its messages wait like this: what else it does (a dashboard, a note, a memory) runs as yours, as it would in Liaison itself.

## Kernel tools

Scopes are shown in full. `kernel:agent:memory` is the gate for the memory and notification tools.

### Conversations and people

| Tool | What it does | Scope | Approval |
| --- | --- | --- | --- |
| `threads_list` | List recent conversations you are in. | `kernel:threads:read` | No |
| `threads_search` | Search conversations by title, participant or content. | `kernel:threads:read` | No |
| `threads_read` | Read the messages of one conversation. | `kernel:threads:read` | No |
| `threads_create` | Message people in the conversation you already share (a 1:1 opens if none). With `createdFrom` naming a record that has a discussion, posts into that discussion instead, as the agent; people listed who cannot see the record are left out and named. A record you cannot see: `created_from_not_visible`, nothing is posted. | `kernel:threads:write` | When an agent opens a new conversation |
| `threads_reply` | Post a message into an existing conversation, or into a contact's discussion (`contactId`). | `kernel:threads:write` | No |
| `agents_ask` | Ask another agent a question, or hand it one piece of work, without adding it to the conversation. | `kernel:threads:write` | No |
| `agents_invite` | Add another agent to the conversation, after you approve it there. | `kernel:threads:write` | Yes |
| `users_search` | Find colleagues by name or email. | `kernel:users:read` | No |
| `create_pinned_thread` | Create an organization-wide pinned conversation. | `kernel:threads:admin` | No |
| `open_app` | Open an app, a view (such as **Dashboards**, the list of your dashboards, or **Help**, these docs) or one record (an invoice, a ticket, a channel) on your screen. Only your own request moves your own tabs. | `kernel:threads:read` | No |

### Files and media

| Tool | What it does | Scope | Approval |
| --- | --- | --- | --- |
| `files_list` | List the files attached to an entity. | `kernel:files:read` | No |
| `files_read` | Get a short-lived download link and metadata for a file. | `kernel:files:read` | No |
| `files_upload_url` | Start uploading a local file so a send tool can attach it. | `kernel:files:read` | No |
| `files_upload_confirm` | Finish an upload and get the file id. | `kernel:files:read` | No |
| `files_merge_pdfs` | Merge stored PDFs into one new PDF. | `kernel:files:read` | No |
| `analyze_media` | Analyze an image, video or PDF attachment. | `kernel:files:analyze` | No |
| `mail_attachment_read` | Read one email attachment: a PDF, Word, Excel or PowerPoint file, an image or a video. | `mail:conversations:read`, `kernel:files:analyze` | No |

`analyze_media` reads attachments of tickets, email and agent chats. Apps can read their own files the same way (a shipping label, for its tracking number) through the `files.analyzeDocument` capability; those reads use the same model and credits, and follow the workspace's `apps` media-analysis setting.

Agents set up the papers a record needs with the document tools: `document_template_create` writes a template, `product_attributes_upsert` keeps product facts by SKU, and `document_rules_upsert` says which templates a record needs, by destination country, SKU, carrier or product attribute (`attribute`). Each of these writes waits for approval. See [Generate shipping papers automatically](../admin/shipping-documents.md).

`mail_attachment_read` reads an attachment of your own email by the file id `mail__read` lists. Images, videos and PDFs go through the same analysis, model and credits as `analyze_media`, under the workspace's `mail` media-analysis setting (for email, PDFs are on by default and images and videos are off until an admin turns them on); Word, Excel and PowerPoint files (.docx, .xlsx, .pptx) are read as text, without a model call. In a private mailbox, the attachment is opened by your unlocked Liaison window, analysed for that turn only, and nothing about it is stored: no summary, no preview, no cache. Files over 25 MB are refused, and so is a private mailbox's video: it can't be analysed yet, because reading a video needs a temporary file on disk. A long Word, Excel or PowerPoint file is read up to a size limit and its text says it was cut. When the mailbox is locked, the agent says so and asks you to unlock it. `analyze_media` refuses any attachment of a private mailbox and points the agent to `mail_attachment_read`.

A mail tool that reads a private mailbox (`mail__read`, `mail__search`) asks your open Liaison window for the content. When none of your open windows can decrypt it, the tool result says the mailbox is locked on your open windows, and the agent asks you to unlock it rather than reporting the mail as unreadable.

### Web

| Tool | What it does | Scope | Approval |
| --- | --- | --- | --- |
| `web_search` | Search the web and return titles, links and snippets. Never waits; the [limits on reading the web](approvals.md#limits-on-reading-the-web) apply. | `kernel:agent:web` | No |
| `web_fetch` | Fetch a page as markdown or text, or extract only the data asked for. Never waits; the [limits on reading the web](approvals.md#limits-on-reading-the-web) and the fetch allowlist and blocklist apply: an empty allowlist reads any public site, on a demo workspace too, and private and internal addresses are always refused. | `kernel:agent:web` | No |
| `web_watch` | Routines only: fetch a page and diff it against the previous run. | `kernel:agent:web` | No |
| `watch_state` | Routines only: read or write a value that persists between runs. | `kernel:agent:web` | No |

### Memory

| Tool | What it does | Scope | Approval |
| --- | --- | --- | --- |
| `user_memory_get` | Read a stored memory about the user, by type and name. | `kernel:agent:memory` | No |
| `user_memory_set` | Save or update a private memory about the user. | `kernel:agent:memory` | No |
| `user_memory_delete` | Remove a memory entry. | `kernel:agent:memory` | No |
| `memory_view` | Read a file in the agent's own memory, or list a folder. | `kernel:agent:memory` | No |
| `memory_create` | Create a memory file (not for a skill or toolkit change: that is `report_bug`). | `kernel:agent:memory` | No |
| `memory_str_replace` | Replace one exact passage in a memory file. | `kernel:agent:memory` | No |
| `memory_insert` | Insert a line into a memory file. | `kernel:agent:memory` | No |
| `memory_delete` | Remove a memory file. | `kernel:agent:memory` | No |
| `memory_rename` | Move a memory file. | `kernel:agent:memory` | No |
| `memory_search` | Search memory and the conversations the agent may read. | `kernel:agent:memory` | No |
| `memory_open` | Read the messages around a search hit. | `kernel:agent:memory` | No |
| `memory_episode` | Read one closed episode of a conversation. | `kernel:agent:memory` | No |

### Data store

The data store keeps JSON documents in named collections. Apps write their own collections; the agent keeps its own under the app `agent`. An app's collection can be read by these tools only when its manifest declares it readable by agents, and only by someone who holds the collection's read scope. Declared searchable collections also show up in search, to people who hold that scope.

| Tool | What it does | Scope | Approval |
| --- | --- | --- | --- |
| `data_collections_list` | List the collections you can read, with their document counts. | `kernel:data:read` | No |
| `data_query` | Read documents of a collection, filtered, sorted and paged. | `kernel:data:read` plus the collection's read scope | No |
| `data_get` | Read one document by id. | `kernel:data:read` plus the collection's read scope | No |
| `data_set` | Save a document in one of the agent's own collections. | `kernel:data:write` | No |
| `data_update` | Change some fields of one of the agent's own documents. | `kernel:data:write` | No |
| `data_delete` | Delete one of the agent's own documents. | `kernel:data:write` | No |

The write tools never write an app's collections.

### Dashboards

The agent builds dashboards from read tools and data store collections, and previews every block before it saves. The kernel skill `build-dashboard` teaches it the steps and one worked block per chart type ([See your dashboards](dashboards.md)).

| Tool | What it does | Scope | Approval |
| --- | --- | --- | --- |
| `dashboards_sources` | List the read tools you may put on a dashboard, with their params and result fields. | `kernel:dashboards:write` | No |
| `dashboards_preview_block` | Run one block as you and return what the chart would draw; saves nothing. | `kernel:dashboards:write` | No |
| `dashboards_list` | List the dashboards you can see. | `kernel:dashboards:read` (every member) | No |
| `dashboards_get` | Read one dashboard and its blocks. | `kernel:dashboards:read` (every member) | No |
| `dashboards_create` | Save a new dashboard. | `kernel:dashboards:write` | For an org dashboard (decided by `kernel:dashboards:admin`) |
| `dashboards_update` | Change a dashboard's title, blocks or visibility. | `kernel:dashboards:write` | For an org dashboard, or to make one org-visible |
| `dashboards_edit` | Change a dashboard by a list of operations (add, change, move, resize, duplicate or remove a block; title, description, default time range, visibility; add, change or remove a shared dataset or a filter; go back to a saved version), all applied or none. | `kernel:dashboards:write` | For an org dashboard, or to make one org-visible: one approval for the whole list |
| `dashboards_share` | Change who sees a dashboard: what everyone in the organization gets (`none`, `viewer`, `editor`), and people or roles added, changed or removed. | `kernel:dashboards:write` (plus editor access and `kernel:dashboards:share`) | Always: decided by the owner of a restricted dashboard, else by `kernel:dashboards:admin` |
| `dashboards_history` | List a dashboard's saved versions (the last 20). | `kernel:dashboards:read` (every member) | No |
| `dashboards_snapshot` | Read every block of a dashboard for a period and filters: each figure with its change; with `recipients`, who may receive it. | `kernel:dashboards:read` (every member) | No |
| `dashboards_pdf` | Print a dashboard as a PDF, staged as a file only you can read. | `kernel:dashboards:read` (every member) | No |
| `dashboards_delete` | Delete a dashboard. | `kernel:dashboards:write` | For an org dashboard |

### Contacts

| Tool | What it does | Scope | Approval |
| --- | --- | --- | --- |
| `contacts_search` | Search contacts by name, email or company. | `kernel:contacts:read` | No |
| `contacts_read` | Read a contact with recent mail and timeline, and one line per other app that holds records for them, such as a recurring schedule or an invoice, with its id. Only what you may read there is named. | `kernel:contacts:read` | No |
| `contacts_write` | Create or update a contact. | `kernel:contacts:write` | Yes |
| `contacts_export` | Export contacts to a CSV file. | `kernel:contacts:export`, `kernel:contacts:read` | Yes |
| `contacts_find_duplicates` | Find likely duplicate contacts. | `kernel:contacts:read` | No |
| `contacts_merge` | Merge two duplicate contacts. | `kernel:contacts:write` | Yes |
| `contacts_share` | Change who a contact is shared with. | `kernel:contacts:write` | Yes |
| `contacts_groups_list` | List contact groups. | `kernel:contacts:read` | No |
| `contacts_group_members` | List the members of a group. | `kernel:contacts:read` | No |
| `contacts_group_create` | Create a contact group. | `kernel:contacts:write` | No |
| `contacts_group_rename` | Rename a contact group. | `kernel:contacts:write` | No |
| `contacts_group_delete` | Delete a contact group (the contacts stay). | `kernel:contacts:write` | Yes |
| `contacts_group_add` | Add contacts to a group. | `kernel:contacts:write` | No |
| `contacts_group_remove` | Remove contacts from a group. | `kernel:contacts:write` | No |
| `contacts_addresses_list` | List a contact's addresses with their verification. | `kernel:contacts:read` | No |
| `contacts_address_upsert` | Add or change an address, always saved as not verified. | `kernel:contacts:write` | Yes |
| `contacts_address_verify` | Propose to verify an address against a source; a person approves, no policy skips it. | `kernel:contacts:write` | Always |

### Product attributes

Small facts kept per product SKU, whichever app sells or ships the product. The key `short_code` is the short code a product shows as in a cart summary (`1×E2`).

| Tool | What it does | Scope | Approval |
| --- | --- | --- | --- |
| `product_attributes_list` | List product attributes by SKU and key. | `kernel:products:read` | No |
| `product_attributes_upsert` | Set or remove product attributes. | `kernel:products:write` | Yes |

### Documents and templates

An agent designs a printable document with you (a customs declaration, a certificate, a letter, a thank you note, a form), previews it, saves it as a template and prints records with it. It previews before saving: without a record the preview uses sample values and every page says SAMPLE. A preview is visible to you alone and expires after 24 hours. Printing takes the record and the templates, never values: the values come from the record's app, and a field the record has no value for prints as a grey placeholder that the agent names for you to fill.

| Tool | What it does | Scope | Approval |
| --- | --- | --- | --- |
| `document_record_types_list` | List the record types a template can print from, with their fields and a sample record. | `kernel:files:read` | No |
| `document_templates_list` | List the organization's document templates. | `kernel:files:read` | No |
| `document_template_get` | Read one template: its content, the fields it fills in, unknown fields. | `kernel:files:read` | No |
| `document_template_create` | Create a template (text blocks, or an uploaded PDF form). | `kernel:org:admin` | Yes |
| `document_template_update` | Change a template. | `kernel:org:admin` | Yes |
| `document_template_archive` | Archive a template. | `kernel:org:admin` | Yes |
| `document_template_preview` | Preview a template or a draft as a PDF, with sample values or a real record. | `kernel:files:read` | No |
| `documents_print` | Print a record's documents with chosen templates; lists the blanks to fill. | `kernel:files:read` | No |

### Document rules

Rules that say which document templates a record needs (a customs declaration, a certificate, a letter), by product SKU, destination country and carrier. Every condition a rule names must hold; any listed value satisfies one.

| Tool | What it does | Scope | Approval |
| --- | --- | --- | --- |
| `document_rules_list` | List the document rules and their templates. | `kernel:org:admin` | No |
| `document_rules_match` | Check which document templates a list of records needs. | `kernel:files:read` | No |
| `document_rules_upsert` | Add or change a document rule. | `kernel:org:admin` | Yes |
| `document_rules_delete` | Delete a document rule. | `kernel:org:admin` | Yes |

### Skills and routines

| Tool | What it does | Scope | Approval |
| --- | --- | --- | --- |
| `skill_search` | Search the skill catalog. | `kernel:skills:read` | No |
| `skill_read` | Load one skill's body. | `kernel:skills:read` | No |
| `list_skills` | List the skills you can see. | `kernel:skills:read` | No |
| `create_skill` | Create a personal or organization skill. | `kernel:skills:write` | Yes |
| `update_skill` | Change a skill. | `kernel:skills:write` | Yes |
| `delete_skill` | Delete a skill. | `kernel:skills:write` | Yes |
| `toggle_app_skill` | Hide or show an app-shipped skill. | `kernel:skills:write` | Yes |
| `list_routines` | List routines with schedule, status and last run. | `kernel:routines:read` | No |
| `list_routine_events` | List the events a routine can subscribe to. | `kernel:routines:read` | No |
| `routine_tool_scopes` | Look up the scopes a routine needs for given tools. | `kernel:routines:write` | No |
| `create_routine` | Create a routine. | `kernel:routines:write` | Yes |
| `update_routine` | Change a routine. | `kernel:routines:write` | Yes |
| `delete_routine` | Delete a routine. | `kernel:routines:write` | Yes |
| `run_routine_now` | Run a routine once, now. | `kernel:routines:write` | Yes |
| `enable_routine_template` | Create a routine from a template. | `kernel:routines:write` | Yes |
| `reset_routine_to_template` | Put a routine back to its template. | `kernel:routines:write` | Yes |

### Approvals and policies

| Tool | What it does | Scope | Approval |
| --- | --- | --- | --- |
| `approvals_list` | List the approvals waiting on you. | `kernel:approvals:read` | No |
| `approval_update_payload` | Edit the editable fields of a pending approval you raised. Editing someone else's also needs `kernel:approvals:write`, and every edit asks approvers to review the new version. | `kernel:approvals:read` | No |
| `approval_withdraw` | Retract an approval you raised. | `kernel:approvals:read` | No |
| `outside_text_sources` | Explain why actions wait because of outside text. | `kernel:threads:read` | No |
| `outside_text_clear` | Ask the person to lift the outside-text mark. The person can also clear it from the globe beside the conversation name. | `kernel:threads:read` | Yes |
| `policy_get` | List auto-approve policies. | `kernel:policies:read` | No |
| `policy_set` | Create or update an auto-approve policy. | `kernel:policies:admin` | Yes |
| `approval_policy_get` | List approval-tightening policies. | `kernel:policies:read` | No |
| `approval_policy_set` | Create or update an approval-tightening policy. | `kernel:policies:admin` | Yes |

### Access and discovery

| Tool | What it does | Scope | Approval |
| --- | --- | --- | --- |
| `tool_search` | Search the on-demand tools and load the matches. | `kernel:threads:read` | No |
| `call_tool` | Call a loaded tool that is not in the conversation's tool list, by name. | `kernel:threads:read` | No |
| `list_locked_capabilities` | List tools you lack the scope for, with the scope each needs. | `kernel:threads:read` | No |
| `request_scope` | Ask an administrator for scopes you lack. | `kernel:threads:read` | No |
| `request_secret` | Ask a person to type a secret into a card in the conversation, or to connect an account on a Connect card. Any member can connect their own account this way ("connect my Gmail"). | `kernel:threads:read` | No |
| `connect_link_send` | Send a member the one-time link that connects their own account as a personal connection (emailed, and returned to the agent). It works once, for 30 minutes, only for that member signed in as themselves. Sending it to someone else takes the connection's admin scope. | `kernel:threads:read` | Yes |
| `connection_disconnect` | Disconnect one account by its address; what Liaison imported from it is deleted. The organization's connections take the connection's admin scope, a personal connection only its owner. The approval names exactly one connection (owner, address, id); an address matching several is refused until the caller passes the id. | `kernel:threads:read` | Yes |

### Administration

| Tool | What it does | Scope | Approval |
| --- | --- | --- | --- |
| `roles_list` | List roles with scope and member counts. | `kernel:users:admin` | No |
| `get_role` | Read one role's exact scopes. | `kernel:users:admin` | No |
| `create_role` | Create a role. | `kernel:roles:admin` | Yes |
| `edit_role` | Rename a role or add and remove its scopes. | `kernel:roles:admin` | Yes |
| `delete_role` | Delete a role. | `kernel:roles:admin` | Yes |
| `users_list` | List team members and their roles. | `kernel:users:admin` | No |
| `describe_user_access` | Read one person's resolved access: exactly the scopes their sign-in holds, each with where it comes from. | `kernel:users:admin` | No |
| `list_scopes` | List every grantable scope. | `kernel:users:admin` | No |
| `invite_user` | Invite a person by email with a role. | `kernel:users:admin` | Yes |
| `assign_role` | Assign a person to a role. | `kernel:users:admin` | Yes |
| `remove_user_from_role` | Remove a person from a role. | `kernel:users:admin` | Yes |
| `grant_user_scope` | Grant or revoke scopes for one person. | `kernel:users:admin` | Yes |
| `list_dimensions` | List data dimensions. | `kernel:users:admin` | No |
| `grant_dimension_value` | Grant a person values of a data dimension. | `kernel:users:admin` | Yes |
| `deactivateUser` | Deactivate a user account. | `kernel:users:admin` | Yes |
| `merge_imported_user_preview` | Preview linking an imported history author to a real member. | `kernel:users:admin` | No |
| `merge_imported_user` | Link an imported history author to a real member. | `kernel:users:admin` | Yes |
| `enable_app` | Turn on an app for the workspace, installing it from the catalog first when the instance does not have it. | `kernel:apps:admin` | Yes |
| `apps_set_enabled` | Turn an app on or off for everyone. | `kernel:apps:admin` | Yes |
| `apps_set_access` | Choose who may use an app. | `kernel:apps:admin` | Yes |
| `ai_models_get` | Read the organization's AI model settings. | `kernel:org:admin` | No |
| `ai_models_set` | Change what Auto runs and the default reasoning level, switch models on or off, add a model from OpenRouter. | `kernel:org:admin` | Yes |
| `audit_search` | Search the audit log. | `kernel:audit:read` | No |
| `export` | Export the data you can see for chosen apps as a zip. | `kernel:users:admin` | No |
| `data_subject_export` | Compile everything held on one contact, or one member of the organization, into a GDPR export. A member may export their own data; anyone else needs `kernel:data_subject:export`. | `kernel:data_subject:export:self` | Yes |
| `capture_business_knowledge` | Save company knowledge as an organization document. | `knowledge:documents:create` | Yes |
| `config_export` | Read the organization's configuration, without secrets. | `kernel:org:admin` | No |
| `setup_state` | Show what is set up in the workspace and what is left of the features the person chose (the basics until they answer; the other features come as a menu with their times), including permissions a connected account still lacks because the provider must approve them first (Shopify's Read all orders). | `kernel:threads:read` | No |
| `google_setup` | Say where each Google connection gets its OAuth client (the workspace's own, the server's, or none) and, given the mailbox address, which path it takes: connect, mark the server's client as Trusted in the Google Workspace Admin console, IMAP with an app password for a personal Gmail address, or create a client (redirect URIs, scopes, APIs and steps). A mailbox's app-password steps. | `kernel:threads:read` | No |
| `mailbox_setup` | Show the card for the person's own mailbox: set the mailbox password a private mailbox waits for, or, only when the person asks, make a transparent mailbox private. | `kernel:threads:read` | No |
| `shopify_setup` | Give the Shopify Dev Dashboard steps for creating the store's app, with the App URL, redirect URL, scopes and API version for this server. When the server provides the Shopify app, the steps are just connect. | `kernel:threads:read` | No |
| `shopify_app_toml` | For someone who prefers the Shopify CLI: post the Shopify app configuration file for this server in the conversation, with the Shopify CLI steps. The app uses Shopify-managed installation: a store gets only the scopes the file lists, so the agent posts the file again (deploy, then reconnect) once full order history is on or a scope is missing. The steps include requesting Read all orders right after the deploy, with the answer to paste in Shopify's form. When the server provides the Shopify app, it posts no file and says to just connect the store. | `kernel:threads:write` | No |
| `config_plan` | Show what a configuration change would do. | `kernel:org:admin` | No |
| `config_setup` | Record which features the person chose to set up; `setup_state` then counts only those as left. | `kernel:org:admin` | Yes |
| `config_roles` | Change roles and their scopes. | `kernel:roles:admin` | Yes |
| `config_email` | Change the email sender identity. | `kernel:org:admin` | Yes |
| `config_users` | Invite people. | `kernel:users:admin` | Yes |
| `config_mail` | Add Mail app mailboxes. | `mail:accounts:admin` | Yes |
| `config_tickets` | Add ticket inboxes and change ticket settings. | `tickets:inboxes:admin` | Yes |
| `config_apps` | Enable apps, set their config, settings and connections. | `kernel:apps:admin` | Yes |
| `config_knowledge` | Add knowledge collections and documents. | `knowledge:documents:create` | Yes |
| `config_agents` | Add or change role agents. | `kernel:agents:admin` | Yes |
| `config_invoicing` | Change invoicing issuers, tax regimes and e-invoicing. | `invoicing:settings:write` | Yes |
| `config_liaisonTeam` | Record whether this server registers with the Liaison team and may forward bug reports. | `kernel:org:admin` | Yes |

The `config_*` tools take the same sections as a `liaison config apply` file, without secrets (see [Configuration file reference](../reference/config.md)). The agent sees each section's keys and entry shapes. A call with the wrong shape is refused with the keys it expected and an example, and the agent corrects it before anything reaches an approval card. `config_apps` refuses an app that is neither installed nor in the catalog.

A change that changes nothing (an app that is already on, a setting already at that value) is answered at once with `changed: false` and a sentence the agent passes on ("Tickets is already on. Nothing to change."), and no approval card is shown. That answer ends the request: the agent posts no Connect or secret card the person did not ask for, and at most asks whether they also want to connect something. The card of a change that does something lists only its real changes. After approval, the `config_apps` result says, per app, what changed. A mailbox or ticket inbox address that an agent passes to `config_mail` or `config_tickets` must be one the person gave in the conversation (a message or an attached file) or one the workspace knows (a member's address, a connected account). Otherwise the call is refused before any card: the agent never makes up an address, such as `support@` on the company's domain.

### Imports

| Tool | What it does | Scope | Approval |
| --- | --- | --- | --- |
| `import_kinds` | List what the organization can import, and one kind's record schema. | `kernel:imports:read` | No |
| `import_reference` | List or read the shipped transforms (Jira Software, Jira Service Management, Freshdesk XML, Slack export, an invoice CSV example). | `kernel:imports:read` | No |
| `import_sample` | Show the first records of each uploaded export file, as a transform receives them. | `kernel:imports:run` | No |
| `import_transform_save` | Save a new version of a transform: a shipped one as is (`fromReference`), or the agent's own. | `kernel:imports:run` | No |
| `import_preview` | Try a transform on the start of the source; writes no record. | `kernel:imports:run` | No |
| `import_start` | Start the import a preview showed. | `kernel:imports:run` | Yes |
| `import_status` | Read an import's progress and report. | `kernel:imports:read` | No |
| `import_cancel` | Stop a running import after its current batch. | `kernel:imports:run` | No |
| `import_undo` | Undo a finished import. | `kernel:imports:undo` | Yes |

### Notifications and feedback

| Tool | What it does | Scope | Approval |
| --- | --- | --- | --- |
| `notify_user` | Post a notification to your attention feed. | `kernel:agent:memory` | No |
| `notifications_get` | Read your notification settings. | `kernel:agent:memory` | No |
| `notifications_set` | Change your notification settings, including how often your agent reminds you of your requests waiting for approval (daily, every 3 days, weekly or off). | `kernel:agent:memory` | No |
| `notification_rules_set` | Silence an app or keep only some notification kinds. | `kernel:agent:memory` | No |
| `thread_mute_set` | Mute or unmute a conversation. | `kernel:agent:memory` | No |
| `sidebar_apps_get` | Read which apps are hidden from your sidebar, or from a member's with `kernel:users:admin`. | `kernel:agent:memory` | No |
| `sidebar_apps_set` | Hide apps from your sidebar or show them again, or a member's with `kernel:users:admin`. Hiding never changes access. | `kernel:agent:memory` | No |
| `set_away` | Record the days someone is away (never why), end them, or name their standing next in line. The result states the dates with weekdays, who is next in line and what they cannot approve. Someone else's days need `kernel:users:admin` or `projects:capacity:write`. | `kernel:threads:read` | Only when the turn read outside text, or a routine or an MCP client asks: then it waits for the person who asked |
| `report_bug` | File a bug report about Liaison itself. It never waits for an approval, whatever the conversation read before. Where bug reports go only to the Liaison team, it prepares the report and you send it from its card. It can attach up to 5 of your files (`attachments`, file ids you can open). | `kernel:bug_reports:file` (every member holds it) | No |

### Sub-agents

| Tool | What it does | Scope | Approval |
| --- | --- | --- | --- |
| `spawn_agent` | Run a fresh-context sub-agent for one isolated task. | `kernel:agents:spawn` | No |
| `subagent_list` | List sub-agent roles. | `kernel:agents:spawn` | No |
| `subagent_get` | Read one sub-agent role. | `kernel:agents:admin` | No |
| `subagent_create` | Register a reusable sub-agent role. | `kernel:agents:admin` | When it overwrites |
| `subagent_delete` | Delete a sub-agent role. | `kernel:agents:admin` | When it overwrites |

### Your computer

| Tool | What it does | Scope | Approval |
| --- | --- | --- | --- |
| `run_on_my_computer` | Start a session on your computer. | `kernel:threads:write` | Owner decides if outside text was read |
| `computer_session_list` | List your computer sessions. | `kernel:threads:read` | No |
| `computer_session_read` | Read a session. | `kernel:threads:read` | No |
| `computer_session_send` | Send a message to a session. | `kernel:threads:write` | Owner decides if outside text was read |
| `computer_session_stop` | Stop a session. | `kernel:threads:write` | No |
| `computer_session_answer` | Answer a session's question or permission request. | `kernel:threads:write` | Owner decides if outside text was read |
| `computer_session_settings` | Change a session's model, level, effort or autonomy. | `kernel:threads:write` | Only a change to autonomy |
| `share_folder_on_my_computer` | Share a folder a search found. | `kernel:threads:write` | Yes |
| `find_repos_on_my_computer` | Find git repositories on your computer. | `kernel:threads:read` | No |
| `list_my_remote_repos` | List repositories your computer's GitHub and GitLab logins reach. | `kernel:threads:read` | No |
| `clone_repo_on_my_computer` | Clone a repository onto your computer. | `kernel:threads:write` | Yes |
| `computer_session_import_list` | List Claude Code sessions that can be imported. | `kernel:threads:read` | No |
| `computer_session_import` | Import a Claude Code session: follow or take over. | `kernel:threads:write` | Yes |

## Secrets the agent asks for

An agent never handles a secret: an API key, a password or an OAuth client secret. When it needs one, it calls `request_secret` and a card appears under its message. The card names what is asked for and where it goes: the model provider, the app and connection (for an API connection, also the address it sends to and its auth type), or the label of a new API key.

- Type the secret into the card and select **Save**. The card sends it straight to the place that stores it, the same one the Settings page uses. App and connector credentials are saved for the organization, not for you alone, unless the agent asked for your own account: a personal mailbox over IMAP (your @gmail.com address, for one) is saved as yours, and only you can fill in that card.
- Liaison then checks that a new secret was stored. Only then is the request marked saved, and the agent is told it was saved with a short hint: the last 4 characters of a provider key, the end of an OAuth client ID, or the prefix of a new API key. A password gets no hint.
- If a member already connected that same account for themselves, the card says it replaces their personal account. Select **Replace it** to go ahead: their own connection is disconnected and they are told.
- When the place that stores it refuses what you typed (a Stripe secret key where a restricted key is asked for, a key the provider rejects), the card shows that refusal's own words, which say why and what to do. Nothing is stored.
- The card names the app by its name. For credentials, the agent is told the labels of the fields the card asks for, such as **Restricted key**.
- The card says who asked: the agent, and the person it asked for.
- For an IMAP mailbox you already approved in a mail or tickets configuration change, the card shows that change's servers, ports and username read-only and asks only for the password. They come from the approved change, never from the agent's request. For a @gmail.com address with no approved change, the card shows Gmail's own servers (`imap.gmail.com`:993, `smtp.gmail.com`:465, the address as username).
- A setup step on the card can carry links, such as Google's 2-Step Verification and app-password pages for a personal Gmail address. They open in a new tab.
- For a new API key, select **Create key**. The key is shown once, with **Copy**. It is not shown again.
- Only a person who can change that setting can save the card: an organization admin for model keys and the Google client that Gmail and Google Calendar connect with, an apps admin for OAuth clients, the connection's admin for credentials (the person who asked, for their own account). Everyone else in the conversation sees it read-only, with "Waiting for an admin to enter it."
- The person who asked, or an admin, can select **Cancel**. A request nobody answers expires after 24 hours.
- When the agent names a connection the organization does not have, it is told which connections (or saved API connectors) take that kind of secret, and asks again with the right one.
- Asking for the same card twice shows it once. The agent is told the card is already there.
- A card the agent filed after reading data (mail, for example) is shown only to people who can read that data. Someone added to the conversation later without that access does not see it.
- A card is a request, not a result. Until you complete it, nothing is saved or connected, and the agent is told so. If the agent says something is connected while nothing is, Liaison has it correct its answer.
- If the conversation read outside text, the card can wait for an approval first. Once approved, the card appears under the line **request-N ran; its result was passed to the agent**, also after a reload.

## Connect an account from the conversation

Gmail, Google Calendar, Shopify and the other apps that sign in at a provider are connected on a card too. The agent calls `request_secret` with kind `oauth_connect`, the app and connection, and whose account it is: yours alone, or one the organization shares (a support inbox, the store).

- Select **Connect with Google** (or **Connect with Shopify**). The provider's sign-in opens in a small window. Sign in and allow access there; the window closes by itself and the card turns to **Connected** with the account's name.
- For Shopify, type your store's domain (your-store.myshopify.com) on the card first.
- If your browser blocks the window, the sign-in opens in the same tab and brings you back to the conversation when it is done. If it did not complete there, the card says why and offers **Try again**.
- If the sign-in in the window is refused (for example, the account is already connected for the organization or another member), the card says why and offers **Try again**.
- In the desktop and mobile apps, the sign-in opens in your system browser or the phone's sign-in sheet, as for Settings.
- Liaison stores the account, then marks the card connected. The agent is told only that it is connected and which account: it never sees the provider's code or tokens.
- Your own account: only you can connect it, and only from your own card. Everyone else sees "Waiting for (you) to connect it." A shared account: anyone who administers that connection can connect it.
- If the organization has no OAuth client for that app yet, the agent first asks for it on a client card (for Gmail and Google Calendar, the organization's Google client), then shows the Connect card. Connections of one app that share a client (the app's manifest names one client key for them) take it once, on one card. The Shopify client card shows the Shopify Dev Dashboard steps with this server's values. A configuration change that adds a Gmail mailbox or inbox, or an OAuth app, hands the agent both cards in that order.
- A connection that reads an app setting before it can start (Instagram with Unified login: its configuration ID) refuses Connect until the setting is set, and the card says an admin sets it in the app's settings or asks the agent to.
- A connection the organization has switched off (for example **Gmail mailboxes** off in Settings › Apps › Mail) gets no Connect card: the agent first proposes the configuration change that turns it on. A card shown before the switch went off says so when you select Connect, and who can turn it on.
- Each card is completed only by the account its own sign-in connected. Connecting your own account in Settings also completes your waiting personal card. Another admin connecting a different shared inbox in Settings does not complete a card for a shared account.
- Two people in one conversation who each ask to connect their own account each get their own card.
- A Google Drive connected with a personal Google account sees only the files the person picks. The agent puts the address on the Drive Connect card (`identifier`), which decides the mode. Once Drive is connected, the agent shows an **Open** button to Google's picker with `google-drive__drive_picker`, for example when a file you name cannot be found. The agent posts one card per message: a mailbox card first, the Drive Connect card in a later message once the mailbox is connected, and the picker only once Drive is connected. See [Google Drive](../apps/google-drive.md#choose-the-files-liaison-sees).

## Import from another tool

Ask the agent to bring in data from another tool: a Freshdesk or Jira site, a Trello board, a spreadsheet, any export file or API. There is no importer per tool: the agent writes a transform, a short script that turns the export into the records Liaison imports (tickets, projects and tasks, contacts and the other kinds your apps declare).

1. Upload the export in the conversation, or have the agent set up an API connection (its credentials go through a secret card).
2. The agent first looks for a shipped transform for your tool (`import_reference`): Jira Software, Jira Service Management, Freshdesk XML and Slack exports have one. It saves that one as shipped (`import_transform_save` with `fromReference`), changing only a setting you asked for, such as which Jira projects or service desks to bring in. For Jira it asks for your site (`acme` for https://acme.atlassian.net). When the Jira connection does not exist yet, the save names it and the agent proposes it: you approve the **Save the API connection jira** card, then type the account's email and API token on the secret card, never in the chat. When a kind comes from an app the organization has not turned on (invoices come from Invoicing), the agent is told which app provides it and that an admin can install it from the catalog; it does not import the records as something else. For another tool, it reads what can be imported (`import_kinds`), looks at the first records of your export (`import_sample`), starts from the closest shipped example and saves its own transform. Then it runs `import_preview`. The preview reads the first batches of the export, or the first pages of the API, and writes nothing: you see the counts per kind, the records it refused and where they came from, and a few samples.
3. When the preview is right, the agent calls `import_start`. The approval card shows, for each kind, the preview's counts and one sample record (marked as outside text); the transform's author, size, hash and how much it changed since its last version; and how many members the import credits as authors. Once a person approves, the import runs in the background as the person who approved, with their permissions. The run records who asked for it too: that person (or their agent) can stop it and propose its undo.

- The transform runs in the sandbox, with no network, no files and no database. Over an API connection it can only read paths on that connection's address; the credentials stay on the server. A connection may send literal headers an API requires (such as Jira Service Management's `X-ExperimentalApi: opt-in`); see [API connections](../api-connector.md).
- A transform can only attach files of the import itself: entries of the uploaded files, the uploaded files, and the downloads it asks for. It cannot name any other file, even one you can read.
- Approval binds the preview: the transform version and its code, the files or the connection (its adapter and its saved credentials), and the counts. If any of them changes, the agent previews again.
- An import is refused while more than 5% of the previewed records are refused, and a preview is good for a day. Only the person who made a preview can start it.
- Attachments the transform names are fetched by Liaison after each call, each up to 2 GB and ten minutes, within the organization's storage quota. A file that cannot be fetched is left out and listed as missing in the report.
- The conversation shows the import's card under the agent's `import_start` (once approved) and `import_status` calls: counts per kind, the refused records, the final report and **Undo**. It updates while the import runs and is still there after a reload.
- Every import can be undone: from the card, from the conversation (`import_undo`, approved by a person) or under **Settings › Organization › Imports**. You can also run the same steps yourself there (see [Import from another tool yourself](../admin/settings.md#import-from-another-tool-yourself)).

## Web tools

- `web_search` returns titles, links and snippets. It appears only when the organization has a search key: an Exa key, or an OpenRouter key, which makes search work through OpenRouter's web plugin. Adding or removing the key updates the tool at once. The Exa key can be set for the whole instance with `EXA_API_KEY`.
- `web_fetch` reads one page. With mode `extract` and an extraction query it returns only the data you asked for and ignores instructions written in the page.
- When a site refuses automated reading (it answers 403, 429 or 503, an empty page, or a page whose text its scripts fill in), `web_fetch` reads the page through Exa's copy instead, if the organization has an Exa key. The result says so, so the agent can cite it. The allowlist, blocklist and private-address rules apply first, and a page that does not exist (404) is not retried. Each such read is billed like one web search. When the page still cannot be read (Exa has no copy, or there is no Exa key), the agent is told the site blocks automated reading and to look for the same document on another site through `web_search`, instead of retrying that site. A 404 tells it to search for the page's real address instead of guessing another.
- `web_fetch` leaves out a page's navigation, menus, language picker, page header and footer, sidebars and cookie banner. When that would leave too little of the page, it returns the whole page.
- Fetching the same page again in the same turn, with the same content, returns a short note pointing to the earlier result instead of a second copy. The earlier result then stays whole for the rest of the turn.
- Text from the web is untrusted. An agent treats it as data, and the conversation is marked as having read outside content. The first web result in a conversation carries the full research instructions; later ones carry a short untrusted-content note instead.
- `web_watch` and `watch_state` are for routines only. See [Schedule routines](../agents/routines.md#watch-a-web-page-between-runs).

All four need `kernel:agent:web`.

## Memory

Each agent has its own memory: Markdown files under its own handle, organized by type (user, feedback, project, reference), with an index file (`MEMORY.md`) that lists them. The `memory_*` tools read and edit those files, search the conversations the agent may read, and open the verbatim messages around a hit. `user_memory_get`, `user_memory_set` and `user_memory_delete` keep private notes about the person. You can read an agent's memory on its **Memory** tab. After outside content, writes to memory also wait for approval.

## App tools and the sandbox

App tools run inside the app's sandbox, with the agent's scopes, and a gated one stops at an approval first. An app lists its tools and the scope for each in its manifest. For building your own, see [Build an app](../app-development.md).

## Next steps

- [Connect MCP servers](../agents/mcp-servers.md)
- [Approve what agents do](../agents/approvals.md)
- [Use Liaison from Claude, Cursor and other clients](../developers/mcp.md)
