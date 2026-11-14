---
title: Choose where agents can work
description: "Add the folders and repositories agents may use on a computer, clone a repository with your own git login, and remove access again."
---

An agent can only open the folders you add to a computer. This page shows how to add a folder, find your git repositories, clone a new one and take access away.

## What a shared folder gives an agent

Agents open each folder you add and each git repository directly inside it. Nothing else on that computer. They can read and change the files in it.

- Your home folder, or any folder that contains it, is never added. Add a folder inside it instead.
- Hidden folders and system folders are never added.
- The computer decides which folders it will take. If it refuses one, it says so.
- Repositories get their own worktree and branch when a session starts on them. See [Sessions](../computers/sessions.md).

Folders are listed by name. The computer keeps the full path to itself. When an agent talks about a folder it says `~/Documents/my-repo`, never the full path, and it cannot name a path of its own. See [Security of a computer](../computers/security.md).

## Add a folder

1. Open **Settings › Computers** and click the computer. Open the **Folders** tab. The heading is **Folders agents can work in**.
2. Click **Add a folder**. A dialog opens: **Add a folder to** and the computer's name.
3. In **Find it by name**, type the folder name and click **Search**. Each result has an **Add** button. A folder already shared shows **Added**, and one the computer refuses shows **Cannot be added**.
4. Or, in the desktop app on that computer, use **Choose it on** the computer, click **Choose…** and pick the folder in the system picker. The picker opens only on the computer itself.
5. Confirm. The question reads **Add "name"?** and says that agents on the computer will be able to read and change the files in it and in each git repository directly inside it. You can remove it at any time.

The computer must be online to change its folders. If it is offline, the tab shows **Folders when last seen** and says its folders can be changed once it is back.

### Change where "Add a folder" looks

The search looks for folders by name in a list of places, up to 4 levels down, and follows links (for example a Documents folder on another disk). It lists names only and never opens your files.

1. On the **Folders** tab, open **More** and find **Where "Add a folder" looks**.
2. The default place is `~` (your home folder). Click **Add a place…** and type a path such as `~/Documents` or `/Volumes/Data`.
3. Confirm **Allow**. The question reads **Let Add a folder look in "path"?**

When the search covers your home folder it skips Documents, Desktop and Downloads, and the dialog offers **Also look there**. A place above your home folder is refused as too wide. If your system does not let Liaison read a place, the page says so and offers **Open System Settings** and **Check again**. See [Connect your computer](../computers/connect.md#let-liaison-read-your-folders).

If the search takes too long it stops and says it covered part of the places only. Add a narrower place to look in.

## Find the repositories on your computer

1. On the **Folders** tab, find **Repositories on** the computer's name.
2. Click **Scan for repos**. Liaison looks for git repositories in the places above.
3. Tick the ones you want and click **Share selected** with the count. Up to 100 can be shared in one go.

A scan lists each repository as **Shared** or shareable. It marks the ones that can never be shared with a reason: **Your home folder: never shared**, **Hidden or system folder: never shared**, or **Outside the places Add a folder looks in**. Click **Scan again** to refresh it.

## Share a repository from GitHub or GitLab

Use this to bring in a repository you can reach but do not have yet.

1. Under **Repositories you can access**, click **Find repos I can access**.
2. The computer asks its own signed-in GitHub CLI (`gh`) and GitLab CLI (`glab`) which repositories your account reaches. If one is missing or signed out, the page says how to install or sign in there.
3. Filter by name. Each row shows **Private** if it is private and **On this computer** if you already have it.
4. Click **Share** for a repository that is already on the computer, or **Clone and share** for one that is not.

Nothing is cloned until you ask.

## Clone a repository

1. On the **Folders** tab, click **Add a folder**. The dialog has a **Clone a repository** section below the search.
2. Enter the **Repository URL**, as `https://…`, `ssh://…` or `git@host:owner/repo.git`. Optionally enter a **Folder name** (letters, numbers and dashes, no slash).
3. Click **Clone**, then confirm **Clone "name" onto** the computer.
4. The computer clones it with its own git login (its ssh key or saved password) into `Liaison Node/repos/name`, then adds it. The page shows **Cloning "name"…** and then that it is cloned and added.

A repository larger than the computer's limit (2 GB by default) is stopped and removed. Common problems have their own messages: the computer could not sign in to the host, could not reach it, or found no repository at that URL.

An agent can clone for you with `clone_repo_on_my_computer`. It takes only those three URL forms and uses the computer's own git login, so no token passes through Liaison.

## Folders for work that needs no folder

When an agent runs something that does not belong to a project, the session gets a fresh folder in the computer's own work folder, **Liaison Node** by default. To move it, open the desktop app on that computer, then on the **Folders** tab open **More** and, under **Work that needs no folder**, click **Change**. You cannot change it while a session is running on the computer. Pick a full path outside your home folder's private folders.

## Remove a folder

On the **Folders** tab, click **Remove** on the folder. The agents lose access at once. Folders that are missing on disk show **Missing on disk**.

## What agents can do with folders

Agents can look for, and offer, folders but they cannot add one on their own. The two search tools work only in your own private conversation, and an agent is offered them only once you have a computer set up for Liaison.

| Tool | What it does | Approval |
| --- | --- | --- |
| `find_repos_on_my_computer` | Looks up folders by name or lists repositories. Read-only. | No |
| `list_my_remote_repos` | Lists what the computer's `gh` and `glab` reach. Read-only. | No |
| `share_folder_on_my_computer` | Shares a folder a search found. It takes an opaque id, never a path, and only after you say yes. | Yes, decided by you |
| `clone_repo_on_my_computer` | Clones a repository and shares it. | Yes, decided by you |

An id from a search lasts one hour and works once. See [Approve what agents do](../agents/approvals.md).

## Next steps

- [Run work on your computer](../computers/run-work.md)
- [Guardrails and permission modes](../computers/guardrails.md)
