---
title: Try the demo
description: Open your own temporary copy of a sample company at demo.liaison.sh and watch its agents work, without installing anything.
---

The live demo at [demo.liaison.sh](https://demo.liaison.sh) gives you your own copy of **Resonant Audio Labs**, a fictional company that makes portable field recorders. You sign in as its CEO. The support queue, dealer orders, shipping and books are already filled in, so you can watch agents work without installing anything. Each dealer and customer contact has its country recorded, which the check on commercial mail reads.

## Start a demo workspace

1. Open [demo.liaison.sh](https://demo.liaison.sh). The counter at the top shows the three pages: **Scenarios**, **The company** and **Your details**.
2. **Which looks most like your company?** is optional. Click **We sell products**, **We sell software** or **We sell our expertise to clients** and the scenarios that fit are picked for you below; change them as you like. **Other, or just show me** picks nothing and takes a few words about your company if you want to give them; **Continue** then opens the whole company unless you pick scenarios. Click your answer again to take it back. Every answer opens the same example company.
3. Under **What do you want to see agents do?**, pick one or more scenarios, or **Everything** (its **Select all** pill reads **All selected** once every scenario is picked). They play in the order you pick them; the bar at the bottom shows your picks and about how many minutes they take.
4. Click **Continue**. It stays off until you pick at least one scenario, unless you answered **Other, or just show me**.
5. The company page shows what Resonant Audio Labs makes and sells, **How it runs on Liaison** (support, orders and shipping, invoicing, sales, projects and chat, company knowledge), **The team** you run as CEO, and under **You'll see** the scenarios you picked. Only the outside world is simulated. Click **Continue**.
6. Enter **Your name** and **Email**, then click **Start the demo**.

To look around without a guided scenario, click **Or just explore on your own** instead of **Continue**: the whole company is loaded and you go on to the company page. **Change what you'll see** takes you from the company page back to the scenarios, and **Back** takes you from your details back to the company page.

A link from liaison.sh that names a scenario opens the demo with it already picked, on the company page. A link that names a company type does the same with that type's scenarios.

Your answer to the company question stays with your temporary workspace and is deleted with it. The server's logs count the answers by type, without your words or any link to you.

The demo uses your email to send your confirmation code. You join no list by signing up: **Send me occasional news about Liaison** on the form is unticked. Unless you tick it and confirm your email, your name and email are deleted when your demo ends, after 72 hours.

| Scenario | What happens |
|---|---|
| **Customer support** | A customer writes in, a routine drafts the reply, you approve it. |
| **Project management** | A teammate asks for help on a task. From **Chats** at the bottom of the screen, beside the task, you ask your agent; it breaks the task into subtasks and answers the teammate in the task's discussion. Back on the project, the new subtasks are ringed in its list. |
| **Team chat** | A teammate asks a question in a channel. You read it, then from **Chats** at the bottom of the screen, beside the channel, you ask your agent; it searches the web, cites its sources, turns the answer into a task, then answers your teammate in the channel with its sources and the task. |
| **Sales & CRM** | A prospect emails and a routine works in order: it checks your CRM, reads up on a new company, then prepares one request with three steps: their CRM record, a quote at your dealer price that carries the record's id, and the reply with the quote's PDF attached. You approve once and the steps run in that order. |
| **Orders & shipping** | An order arrives and its invoice is issued. From **Chats** at the bottom of the screen, beside the orders, you ask the **Operations Desk** (the agent that holds the shipping, shop and invoicing tools); it prepares the shipment for your approval. |
| **Dev sessions** | A coding agent works on a laptop, and you approve what it asks. |
| **Company knowledge** | Manuals from GitLab, finance from Google Drive and a playbook written in Liaison, in one knowledge base. Asked from **Chats** at the bottom of the screen, beside the P&L, your agent answers from all three; when a support teammate asks the same question, the agent reads with their access and finds no finance figures. |

The company's warehouse reports on revenue, dealers and customers are confidential: they run for you, the finance and operations teams, and not for support, fulfillment or sales (**Settings › Connectors › Database › Report access**).

## Let the agents run

Agent turns need a confirmed email or your own model key.

1. Open the email the demo sends you. It holds a 6-digit code.
2. Paste the code in the demo tab and click **Confirm**, or open the link in the email.

Once your email is confirmed, the agents run on the demo's key within a small budget. When that budget is spent, everything stays open to browse, and a window opens once to show how to keep going (a reload does not open it again; **Budget** in the banner at the top opens it at any time). It shows what you did in the demo (scenarios done, agent actions, approvals you decided, minutes spent) and three ways forward:

- **We set it up for you**: **Write to us** opens the demo's contact link.
- **Continue now with your key**: **Add my key** opens the key form described below.
- **Install it yourself**: **See the guide** opens the self-hosting guide.

With a work address, **We set it up for you** comes first; with a personal one (Gmail, Outlook, Yahoo and the like), your own key does. **Send me occasional news about Liaison, including when the hosted version opens** at the bottom is the same choice as the box on the form, if you did not tick it.

When you finish your last scenario, the same window opens in place of the scenario's end card: **Keep exploring** shows what is left of your budget, with a request to try, above the same three options.

To run on your own key instead, add it in the **Add your own model key** prompt: pick a **Provider** (Anthropic, OpenAI, Google, Mistral or OpenRouter), paste the **API key** and click **Save key**. The key is stored encrypted on the demo instance and used only for your workspace.

## Follow a guided tour

Click **Help** (**?**) in the left bar: the tours are listed under **Show me how**, below **Documentation** (on a phone, tap **Help** on the **Work** screen). Each tour is listed once, and the tours for your roles come first. Each tour shows its status (**New**, **Step k of n**, **Done** or **Stopped**). The tour card sits at the bottom left of the page and moves only when it would cover what it points at. Its top line shows the tour, a dot per step and the close button (**End the tour**). The card shows what to do now: while the place to click is on another screen, the one move to make next, with how many are left (**1/3**), and the request your agent gets, cut to two lines (click it to read all of it). Click **Next**, **Do it for me** or **I'll do it**; **Take me there**, **Play whole scenario**, **Pause** and **Skip this step** are in the **More actions** menu (**⋯**).

Some steps wait on your agent, on a routine or on a recorded session playing, with nothing for you to click. While it works, the step says so with no buttons to press and **Next** stays off until the work is done (**Do it for me** in **⋯** opens where the work shows), and a step waiting on a routine says how long the run has taken, then whether it finished, stopped with an error or did not run. If your agent's turn stops to ask before it uses a tool, the step says **Your agent asks first** and rings the approval card: click **Approve** on the card, or **Do it for me** in the step. **Do it for me** approves a request once: if it comes back to wait on you, the card says why and you decide it there. If your agent answers without doing the step, the step says that instead (not while its turn waits on an approval). Under **Play whole scenario** it then keeps playing: if the step's work still arrives, the scenario moves on. Reply to your agent in the conversation, click **Try again** to send the request again, or click **Skip this step**. The step moves on as soon as your agent does it. If your agent could not answer the question a step waits on (the turn was refused, for example because the demo's budget ran out, or it failed), the step says **Your agent could not answer** with the reason under it: click **Try again** to send the same question again in the same conversation, or click **Skip this step**. If you ask your agent again yourself in that conversation, the step follows the answer to your newest message. A step that approves what a routine proposed rings the card this run staged. In the sales scenario, the routine is run by your personal agent. After the email arrives, a step tells you to wait while the routine works, with no trip to **Routines**. The routine prepares one request in **Home**: the CRM record, then a quote, then the reply with the quote attached, each step using what the one before it produced (the quote carries the record's id; the reply attaches the quote's PDF and cites its number). When the prospect is already in your CRM, there is no record step and the request starts at the quote. The step after the email waits until the whole request is ready. The next steps open **Home** on the left bar and ring the request's row; click it to open the request and read its steps in order, and **Next** turns on once it is open. Then click **Approve** once: the steps run in order, and the approve step finishes when the reply has gone. If a step fails, the steps after it do not run, the routine is told what went wrong and proposes a corrected request, and the step says the routine is working again until it does. Under **Play whole scenario**, the step approves the corrected request too. The run lands in your chat with that agent: after the approval, a step opens it from **Chats** in the dock to read the routine's summary, and the last step shows the customer card with the approved record. A step approving what a routine staged says the routine is still running while it runs, and once the run has finished it waits on you. Work that lands while you are still reading an earlier step (the agent's reply right after its subtasks) is kept: when you get to its step, it shows **Next**.

The scenarios talk to your agent in your one conversation with it, the same one **Chats** opens. That conversation keeps what your agent read in earlier scenarios. When it has read outside content (a web search, for example) or data not everyone can see, your agent asks before it writes: the next step shows its approval card, and you click **Approve** to continue. If the write ran at once, the tour skips that step.

| Tour | Covers |
|---|---|
| **Messages and agents** | Posting a message, dictating, bringing an agent into a conversation |
| **Agents and approvals** | Your agent, what it can do, asking it something |
| **Routines** | Routines that run on their own |
| **Sessions** | Agent sessions on a computer |
| **Mail basics** | Reading and answering mail |
| **Tickets** | Working the support queue |
| **Knowledge** | The knowledge base |
| **Projects** | Projects and tasks |
| **API connector** | The API connector settings |

## Start the demo over

Once you have played some scenarios, your workspace holds the mails, approvals and records they made. To get the company back in its starting state, click **Scenarios k/n** in the banner, then **Start over** under the list of scenarios. The question **Start the demo over?** says what goes; click **Start over** to confirm, or **Cancel**.

You land, still signed in, in a fresh copy of the company, with your scenarios back at 0. Your confirmed email, your demo budget and the date your workspace ends stay the same. A model key of your own stays with the old workspace: add it again in the new one.

## Know what the demo cannot do

Click **What this demo cannot do** in the banner for the full list. The banner shows in demo workspaces only: a workspace of your own on the same server shows none of the demo's banner and help, and its setup card does not offer the demo it already runs on. In short:

- No mail leaves the instance except your verification code. Replies to the fictional customers are recorded as delivered and go nowhere.
- Connectors are fixtures, not live accounts. The store, shipping and books read seeded data, and connecting a real account is refused. The CRM keeps what you approve writing to it (a new contact shows on the customer card and in later lookups) until the end of the day (UTC), in your workspace only.
- Ads is not part of the demo.
- Agents search the web and read public pages as in any workspace, within the demo's budget: a few searches per turn and per day (`LIAISON_DEMO_WEB_SEARCH_PER_TURN`, `LIAISON_DEMO_WEB_SEARCH_PER_EMAIL_PER_DAY`), and the agent steps that read pages are paid from the same budget as its answers, with a cap on pages read per turn and per hour. Private and internal network addresses are always refused.

## When the workspace expires

The banner shows when your workspace expires. A workspace lives 72 hours, and everything in it goes with it, including the invoices you issued: a workspace of your own keeps an issued invoice for ten years and refuses to delete it, a demo workspace does not. Once you connect a service of your own to it, such as an MCP server, it lives 7 days from that moment. After that, click **Get a fresh workspace** to start again with the same company. If you connected a Shopify store, removing the workspace deletes the webhooks Liaison registered on it.

A tab still open when the workspace expires signs out and returns to the demo page, which says "This demo workspace has ended. Start a new one below."

To keep your work, run Liaison yourself: follow [Install Liaison](install.md).

## Run a demo instance for many visitors

If you run a public demo of your own (`LIAISON_DEMO_MODE` on), the instance keeps a warm pool of workspaces that are already filled in, so a visitor gets a complete company the moment they click **Start the demo**.

- `LIAISON_DEMO_POOL_SIZE` sets how many ready workspaces it keeps (default `5`). `0` turns the pool off: each visitor's workspace is then filled in after it opens, as the visitor watches.
- The pool is refilled in the background, one workspace at a time, so a rush of visitors never fills many workspaces at once. Each refill logs a warning line with how long the fill took and how many workspaces are ready.
- A ready workspace does not expire while it waits. Its 72 hours start when a visitor takes it.
- A visitor only gets a workspace filled in with the world of the version that is running (`LIAISON_VERSION`). Each pooled workspace records a fingerprint of the database schema and of the demo seed's own files. An upgrade that changes neither keeps the older version's ready workspaces in the pool. An upgrade that changes one of them hands those workspaces to the cleanup and fills new ones, and the log warns `seeded by another build from another world` with how many it retired. Until the new ones are ready, visitors get a workspace filled in after it opens.
- When the pool is empty, the visitor still gets a workspace, filled in after it opens, and the log warns `demo pool empty` with a running count. Raise `LIAISON_DEMO_POOL_SIZE` if you see it often.
- `LIAISON_DEMO_WORLDS` lists the demo companies the instance runs, comma separated (default `products`). A company whose seed files are not in this version yet is left out, with one warning in the log. The pool keeps ready workspaces of each company, and a visitor only ever gets a workspace of the company they were sent to: when that company's pool is empty, they get one filled in after it opens, and the `demo pool empty` warning names the company.
- `LIAISON_DEMO_POOL_SIZES` splits the pool across the companies, as `company=count` pairs (`products=2,saas=2,studio=1`); a company it leaves out keeps none. Without it, `LIAISON_DEMO_POOL_SIZE` is shared evenly, the remainder going to `products`, then `saas`, then `studio`: `5` keeps 2, 2 and 1. A malformed value stops the server at start. The refill fills the company missing the largest share first. A company whose fills keep failing waits before it tries again (the log says `that world backs off`), and the other companies go on filling.
- Each company has its own fingerprint: an upgrade that changes one company's seed files retires only that company's ready workspaces.
- A ready workspace is handed out only while it is younger than `LIAISON_DEMO_POOL_MAX_AGE_HOURS` (default `12`). A company whose story follows the calendar month (any but `products`) also never hands out a workspace filled in during an earlier month, Paris time. The next refill retires both kinds and the log warns `too old to hand out`.
- On a busy moment, a start that cannot make its workspace within 15 seconds does not keep the visitor waiting on one request: the server answers that the workspace is being prepared and asks again in 5 seconds, and finishes the start behind that answer. The page says it is a busy moment and keeps trying on its own with the same start, so the visitor lands in that workspace, never in a second one. The log warns `demo signup past its answer budget`.
- `LIAISON_DEMO_SEED_CONCURRENCY` caps how many workspaces are filled in at once (default `2`), refills and empty-pool visitors together. Visitors beyond it wait in line, first come first served, and their workspace shows as still filling in until their turn; the log warns `demo seed queue` with the number waiting. While visitors wait, the refill keeps a third of those places (2 of 6; none when the cap is 1 or 2, where the pool refills only while nobody is waiting) and the visitors in line get the rest, so a rush that outruns the cap still refills the pool: the next visitors get a ready workspace at once instead of joining the line. A visitor whose server process stops while waiting (an upgrade, a restart) drops out of the line on its own, so a line left behind by a restart never keeps the pool from refilling. A workspace being filled in holds its place only while its server process is alive: a stopped process frees its place within about 30 seconds. The same holds for the refill itself: after an upgrade the new version's refill starts within about 30 seconds. During a rolling upgrade the old version starts no new fill once it begins to shut down: it finishes the ones it has running and leaves the refill to the new version.
- The company's read-only warehouse (the reports behind **Settings › Connectors › Database**) is seeded only when you turn on `LIAISON_DEMO_WAREHOUSE` and set `LIAISON_DEMO_WAREHOUSE_DATABASE_URL`, the warehouse's own database login. Off by default: the workspaces then have every other part and no warehouse, and the seed log says `opt-in parts off on this deployment: warehouse`. Turned on without the login, every seed fails.
- Expired workspaces are deleted every 10 minutes. The cleanup yields to visitors: while the server is busy (requests waiting for a database connection, a slow database, or a host load above 0.7 per core) it deletes one workspace at a time and rests after each one, for up to nine times as long as that deletion took, so it uses at most a tenth of the time. On a quiet server it deletes three at once. Yielding never stops the cleanup from keeping up: each pass plans to delete its whole backlog within its first 6.4 minutes (80 % of its budget), so a rest is cut short (and more deletions run at once) when the backlog needs it, and when a workspace limit is 80 % full the pass does not yield at all. A pass stops after 8 minutes and the next one carries on; every pass logs one `demo reap pass` line with its backlog, and `demo reap pass paced: yielded to live traffic` when it slowed down.
- On a public demo the seed never replaces a demo workspace and never gives seeded people a password: those workspaces belong to visitors. A private test box that runs in demo mode behind a tunnel can lift both with `LIAISON_PRIVATE_DEMO_BOX=true`, which counts only while `BASE_URL` is a loopback address ([Public demo variables](../self-hosting/docker.md#public-demo)).
- A seed either fills in every part or fails. A failed seed is logged as an error naming the parts that failed (`demo org seed failed`), `liaison seed --tier demo` exits with code 1, a failed pooled workspace is never handed out, and a visitor whose workspace failed sees "Part of this workspace failed to set up" instead of a workspace that only looks finished.
- Your instance keeps its visitors' leads to itself. `LIAISON_TEAM_FORWARD_DEMO_LEADS` (off by default) copies them to the Liaison team's support system and is meant only for the Liaison team's own demo: leave it off. Even when it is on, a lead is copied (the demo privacy notice names that copy, and each lead records the notice version it was shown) only if the instance is registered with the Liaison team, and never one that opted out or a load-test address on `.invalid` ([Sharing with the Liaison team](../self-hosting/liaison-team.md)).
- A confirmed visitor's agent runs on the instance's own OpenRouter key at reasoning **Low**, so answers come quickly. `LIAISON_DEMO_STEP_OUTPUT_TOKENS` caps what one step writes (default `16000`); what a step reads is not capped. Before a step is sent it holds its worst cost in the visitor's budget: its output at the cap, and its input from the size of the request itself. A step the budget cannot hold is not sent, and the conversation shows the budget message.
