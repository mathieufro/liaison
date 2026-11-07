---
title: Invite and manage users
description: Invite teammates, give them roles, deactivate and reactivate accounts, and link imported history authors to real people.
---

You manage the people in your organization from **Settings › Users**, in the **Workspace** group. You need the `kernel:users:admin` scope, which the **admin** role holds.

## Invite a user

1. Open **Settings › Users** and click **Invite user**.
2. Enter the **Email address**.
3. Pick a **Role**. You cannot assign a role that grants more permissions than you have.
4. Click **Send invitation**.

Liaison emails the person an **Accept invitation** link. The invitation expires in 7 days. If the email already belongs to a user, the dialog offers to open that user instead.

On a local trial with no SMTP server, the email is written to the app log instead of being sent (see [Install Liaison](../getting-started/install.md#sign-in-the-first-time)). To invite many people from a file, list them under `users` in a config file and run `liaison config apply`: its report gives each invite link as `users[].inviteUrl`. See [Provision from a config file](../provisioning-cli.md).

## Change what a user can do

1. In the users list, click the person.
2. Under **Identity**, edit their **Name** if needed.
3. Under **What can this user do?**, click a role to grant it or revoke it. A user can hold several roles.
4. Under **Which teams and sensitivity levels**, set what data the user can see on top of their roles' grants. See [Control data visibility with dimensions](dimensions.md).

The roles themselves are defined in **Settings › Roles & access**. See [Set up roles](roles.md).

## Deactivate a user

1. In the users list, click **Deactivate** in the person's row.
2. Confirm in the **Deactivate user** dialog.

A deactivated user cannot sign in, and their open sessions end at once: the access tokens they hold are refused within seconds and their open real-time connections close. Their phones and browsers stop receiving push notifications. Nothing they own is deleted, except the days they had said they would be away (or that their own calendar showed), and you can reactivate them later.

You cannot deactivate:

- the last active administrator of the organization;
- someone who holds more permissions than you do.

To deactivate several people at once, tick their checkboxes and use the bulk action **Deactivate users**.

When an agent tries to deactivate a user (tool `kernel:deactivateUser`, or `bulkDeactivateUsers`), the action waits for a person to approve it. See [Approve what agents do](../agents/approvals.md).

## Reactivate a user

1. In the users list, click **Reactivate** in the person's row.
2. Confirm in the **Reactivate user** dialog.

The user can sign in again.

## When the organization has a seat limit

Whoever runs the server can limit how many people are active in the organization (**Settings › Organization › Usage and limits** shows it). Agents and deactivated people take no seat. Once every seat is taken, sending an invitation, accepting one, a first sign-in with the organization's single sign-on and reactivating someone are refused with **SEAT_LIMIT_REACHED**, which gives the limit and how many seats are used. Deactivate someone to free a seat, or ask whoever runs the server to raise the limit (see [Limit an organization](../provisioning-cli.md#limit-an-organization)).

## When the managed subscription is suspended

On a managed instance whose subscription is suspended (unpaid, or ended), only admins can sign in, and only to **Settings › Billing** and the organization's export. Other people get **org_suspended**, with the date until which admins can still export and the address to contact about billing. In the app, every screen then shows **Workspace suspended** with that contact; admins who still have access get **Export your data** and **Billing** there, and others **Sign out**. Once the subscription is closed, nobody can sign in. See [When a payment fails or the subscription ends](settings.md#when-a-payment-fails-or-the-subscription-ends).

## Delete an account

There is no admin action that deletes a user. Each person can delete their own account in **Settings › Security › Delete my account**, after confirming a 6-digit code sent by email. Their profile, personal agent and its memory, preferences, connected accounts and registered devices are deleted. What they shared with the team (messages, tickets, documents) stays, without their name. The only admin of an organization cannot delete their account until another member is an admin.

## Link an imported author to a person

Imports (for example a Slack import) create accounts for the authors of imported history, so messages keep their original author. These accounts cannot sign in and cannot be reactivated.

1. In **Settings › Users**, open the **Imported** tab.
2. Click **Link to a person** in the row.
3. Pick the **Person** and click **Link and merge**.

Everything the imported author holds moves to that person: messages, mentions, reactions, files and conversations. The imported account is then removed. This cannot be undone.

To give one of these people their own access, invite them with their real email.

## Set how people sign in

The first administrator to sign in to a new workspace is greeted by their agent in a pinned **Set up your space** conversation. See [Set up a new workspace with your agent](../agents/how-agents-work.md#set-up-a-new-workspace-with-your-agent).

Sign-in is passwordless by default: a person enters their email, clicks **Continue with email** and types the 6-digit code (valid 10 minutes) or opens the link in the email. A person who has a password can choose **Sign in with a password** instead, and changes it in **Settings › Security › Change password**. Changing or resetting a password ends every session of that person and every AI tool they connected over MCP; the tools must connect again. It also stops push notifications to every phone and browser the person registered: the phone app registers again at its next launch, and in a browser the person turns notifications on again.

A sign-in link that someone else sent you, such as the one that opens a new hosted workspace for its owner, does not sign you in by itself: the page first shows **Sign in to** the workspace's name and the account it signs in as, and signs in only when you click **Continue**. Such a link works once, for 10 minutes, and only at the workspace's own address.

A sign-in stays open for 30 days from its last use. A browser that loses the answer to a session renewal on a bad network (a train, a tunnel) and retries within 3 minutes stays signed in. If an old renewal token is used again after its replacement was already in use, Liaison treats it as stolen and ends that one sign-in (the device or browser that presented it), which then asks the person to sign in again. The person's other sign-ins, on other devices and browsers, stay open.

Admins with `kernel:org:admin` see a **Sign-in methods** section in **Settings › Security**:

| Setting | What it does |
|---|---|
| **Email sign-in link** | Always on. People get a one-time link by email whenever the server can send email. |
| **Single sign-on** | Add OIDC providers with **Add SSO Provider**. |
| **Google credentials** | The Google OAuth client used for Google sign-in. |
| **Require two-step verification for administrators** | Anyone who can administer the organization must enter an authenticator app code at sign-in. |

A single sign-on or Google client lists one redirect URI: `<BASE_URL>/api/auth/oauth/callback`, or `<LIAISON_OAUTH_REDIRECT_BASE>/api/auth/oauth/callback` on a server that sends every provider to one central host (see [Connecting apps](../connecting-apps.md#one-redirect-host-for-several-org-hosts)).

Each person turns on their own two-step verification in **Settings › Security** with **Enable 2FA**.

A few actions ask a signed-in person to confirm it's them again, with their password or a 6-digit code sent by email for that one action: turning two-step verification on or off, resetting or changing the key of an encrypted mailbox, making a private mailbox transparent, connecting an AI tool with full access to their account (an MCP client not limited to one of their agents, see [Use Liaison over MCP](../developers/mcp.md); code only, emailed as soon as the approval page opens), and deleting their account (code only). A code sent for one of these confirms only that action, and expires in 10 minutes.
