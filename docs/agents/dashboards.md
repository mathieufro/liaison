---
title: See your dashboards
description: "Open the dashboards your agent built for you or for the whole org, refresh their figures, and read why a block shows no data."
---

A dashboard is a page of figures, tables and charts that your agent builds from your data. Each block reads its data as you, with your own access: two people looking at the same dashboard may see different numbers.

## Open a dashboard

Click **Dashboards** in the bar on the left (on a phone, in **Work**). The page shows every dashboard you can see as a card: who sees it, how many blocks it has and when it last changed. With none yet, it says what a dashboard is and how to get one.

The **Dashboards** sidebar stays beside the page and beside every open dashboard:

- **Filter dashboards** narrows the list by title.
- **All dashboards** opens the page.
- **Yours** lists your own dashboards. The ones you shared with anyone carry a people icon.
- **Shared with the team** lists the dashboards others shared with you, or with everyone, each with its owner's first name.
- The dashboard you have open is highlighted.

- Click a dashboard to open it in its own tab. The tab's address is `/dashboard/<id>`, and the tab is named after the dashboard.
- Your agent can also open a dashboard for you when it has made or changed one. A tab already open then shows the dashboard as it is now, and so does **Refresh all**.

The lists stay up to date without reloading the page. When someone, or an agent working for them, creates, renames, shares or deletes a dashboard you can see, the **Dashboards** page and sidebar show it at once. An open dashboard tab shows the new version, or says "This dashboard no longer exists, or it is not shared with you." once it was deleted or is no longer shared with you. Nobody is told about your personal dashboards, and only the people a restricted dashboard is shared with hear about it.

To get a dashboard, ask your agent, for example: "Build me a dashboard of last month's orders, with revenue by day and the ten most recent orders."

## Read and refresh the figures

The bar at the top of the dashboard shows its title, the period it shows when a block follows one, who sees it (**Personal** or **Org**) and **Refresh all**.

- Blocks keep their figures for a short while. **Refresh all** reads every block again from its source.
- Each block also has its own refresh button, next to its title.
- A block refreshed a moment ago keeps its figures and says "Just refreshed. Try again in a few seconds."

Blocks sit on a grid by their width: up to three side by side on a wide screen, one above the other on a phone.

## When a block shows no data

A block that cannot draw says why, and the rest of the dashboard still shows:

| Message | What it means |
| --- | --- |
| You don't have access to the data behind this block. | The block reads a tool or a collection your role does not allow. Ask an administrator for the access. |
| This block's source can no longer be shown on a dashboard. | The source now asks for approval or changes data, so a dashboard may not run it. Ask your agent to pick another source. |
| This block's source is no longer available. Ask your agent to pick another one. | The app or connection behind the block was removed or turned off. |
| This block no longer fits its source's data. Ask your agent to fix it. | The source's data changed shape, so the block's chart settings no longer apply. |
| This block's data could not be read. Try again later. | The source failed, for example a connected service did not answer. |
| No data for this block yet | The source answered with nothing to show. |
| Some rows are left out: the block shows the first ones. | The source returned more rows than a block shows, or more than 20 series (the largest are kept). |

## Who can make and share dashboards

| Scope | What it allows |
| --- | --- |
| `kernel:dashboards:write` | Make, change and delete your own dashboards, and change the ones shared with you as an editor. |
| `kernel:dashboards:share` | Also choose who sees a dashboard you can change ([Share a dashboard](#share-a-dashboard)), and make a new dashboard for the whole organization. |
| `kernel:dashboards:admin` | Change or delete any dashboard the whole organization sees, and decide the agent's requests about them. It gives no access to a restricted dashboard that is not shared with you. |

Every member can make dashboards: the **member** role and the **Full Member** role both hold `kernel:dashboards:write` and `kernel:dashboards:share` ([Set up roles](../admin/roles.md)). Only administrators hold `kernel:dashboards:admin` by default; give it to another role to let its people decide the agent's org dashboards.

Everyone can list and open the dashboards they see: every active member holds `kernel:dashboards:read`, whatever their roles, and so does an agent working for them.

Your personal agent builds dashboards with your access. A named agent, such as a team's sales or support agent, builds them when `kernel:dashboards:write` is in its scopes, and always with the access of the person it works for. An agent declared in the config file gets it with its common base; an agent created before that gets it the next time the server starts ([Create an agent](create-an-agent.md)). A named agent can never hold `kernel:dashboards:admin`. Asked for a dashboard without that access, the agent says which access is missing instead of saying dashboards do not exist.

In a shared conversation the agent works with only the access every person there holds. A dashboard it reads, previews, sums up or prints as a PDF there is computed with that narrower access too: a block whose data someone in the conversation may not see shows "You don't have access to the data behind this block." instead of its figures.

Nobody else sees a personal dashboard, administrators included. Your own changes are never held for approval: your scopes decide. When the **agent** creates an org dashboard, makes one org-visible, or changes or deletes an org dashboard, the change waits for a person who holds `kernel:dashboards:admin`. When the agent changes, shares or deletes a restricted dashboard (shared with some people or roles only), the change waits for its owner instead, so nobody who cannot see the dashboard reads its card. The approval card of a new dashboard lists it the way the card of a change does (next section): each shared dataset, filter and block, one numbered line each, with the tool or collection it reads, its settings and the rolling dates it uses with the date each one stands for today. The card of a change lists every change, one line each. A personal dashboard the agent makes for you saves at once. A table change the agent asks for is checked before any card is made: one that approving would only see fail (an own column of a project-backed table that repeats a value read from the tasks, a field the project does not have, a name already taken) is refused at once with its reason, and the agent corrects its request.

## Share a dashboard

Dashboards are shared the way knowledge documents are. Click **Share** at the top of a dashboard:

- **General access** is what everyone in the organization gets: **Restricted** (only its owner and the people and roles listed), **Anyone in the organisation can view**, or **Anyone in the organisation can edit**.
- **Add people** and **Add roles** give one person, or everyone holding a role, **Can view** or **Can edit**.
- **Save** applies it at once.

A restricted dashboard is invisible to everyone it is not shared with, administrators included: it is not in their list or sidebar, and they cannot open it, read its blocks, the records behind a figure, its filters, its exports, its versions, or a snapshot of it, and a scheduled send leaves them out. Its badge reads **Shared with some people**. Anyone who sees a dashboard can open **Share** to see who else does; only its owner and its editors who hold `kernel:dashboards:share` change it. An administrator who restricts a dashboard keeps it only by adding themselves first.

A personal dashboard is a restricted one shared with nobody; an org dashboard is one everyone can view. Changing **Personal** to **Org** in the agent's words, or with `visibility`, sets the general access only and keeps the people and roles listed.

Ask your agent, for example "Share the board dashboard with the C-Level role only": it uses `dashboards_share`, which waits for one approval. Its card says plainly who gains access and who loses it (each person by name, each role, and the organization), and that administrators see a restricted dashboard only when it is shared with them.

## Ask your agent to change a dashboard

Ask for the changes in plain words, for example: "Add Google spend by campaign after the orders, remove the stock table, and open the dashboard on last month." The agent sends everything you asked for in one go, applied in order: add, change, move or remove a block, rename the dashboard, set the period it opens on, add, change or remove a shared dataset or a filter, or share it. Either every change is saved, or none is.

On an org dashboard the whole request waits for **one** approval by a person who holds `kernel:dashboards:admin`, however many changes it holds (up to 50; the list scrolls on a long card). Its card numbers the changes, one line each: the block added, changed, moved or removed with its title and position; the tool or collection it reads with its settings (written out when short, else each setting by name; or the shared dataset it reads), each date in them and what it stands for today; for an added block, what it shows (for example "sum of total by status, target 5000"; over a dashboard table, the table by its name and each column by its label, or "an editable table of" the table), whether it follows the dashboard's period or keeps its own dates, and its refresh interval; the rows it keeps; for a changed block, what changed (including the columns its rows open with, its sorting, row limit and number format); each shared dataset and filter added, changed or removed, with a filter's choices (and the tool and settings it reads them from), its default, its place in the filter bar and how many blocks read it; and the period the dashboard opens on. A text note shows in full: a short one on its line, a longer one on the lines below it, and every link it holds, listed under it, so nothing in a note is approved unseen. A blended chart takes one line, then one numbered line per layer under it (2.1, 2.2) with how the layer is drawn, what it shows and what it reads. A block that reads a shared dataset added or changed in the same request points to that line ("added in 1.") instead of repeating its source; one that reads a dataset already on the dashboard names its tool. Each line says what the block is, where it goes and what it shows before the settings it reads, so a very long line loses only the end of its settings. Sharing a personal dashboard with the organization reads "Share the dashboard". When the agent rebuilds a whole dashboard at once, its card lists the differences from the saved dashboard the same way.

The request is checked before anyone is asked: a block that is not there or already is, a block that cannot draw its data, or a source you cannot read is refused at once, and the agent corrects it, so an administrator never approves a change that then fails. If the dashboard was saved again before the change runs (another approved change, or someone's edit), the change still applies, on top of the newer version, as long as no version saved since changed the same blocks, shared datasets, filters, title, description, period or visibility; its result says which versions it was applied on top of. Otherwise it is refused, naming the change and the version that changed the same thing, and the agent reads the dashboard again. So the agent can send several requests for one dashboard in a row, and each lands as it is approved, in any order. Going back to a version, or rebuilding the whole dashboard at once, only applies to the version it was written against. Past 50 lines (a long note takes a line per 440 characters, and its links one more), the agent sends the changes in two requests, the second once the first is approved. A change to your personal dashboard saves at once.

## Change a dashboard yourself

Your own changes save at once, never held for approval: your scopes decide (the table above). When you may change a dashboard, its bar at the top has **Edit**. Click it to enter edit mode, and **Done** to leave it. In edit mode:

- The dashboard's title and its description (under the title, **Add a description (optional)**) become fields. A change is saved when you press Enter or leave the field.
- Each block's title becomes a field: rename it the same way.
- Move a block by dragging it onto another one: it takes that block's place, just before or after it. From the keyboard, the arrows beside its title do the same: **Move earlier** and **Move later** move it one place, **Move up a row** and **Move down a row** to the block above or below it in the grid as it is drawn, whatever the blocks' widths (one place on a phone).
- A block's menu (the three dots) sets its **Width** (1, 2 or 3 columns) and its **Height** (**Normal**, or **Tall (2 rows)**), and has **Duplicate** (a copy right after it, named "<title> (copy)") and **Delete**, which asks first.
- **Filters**, under the description, lists the dashboard's filters. Each name is a field: rename a filter the same way. Beside it, **Blocks: 2** says how many blocks it narrows, and the cross removes it from the dashboard and from those blocks. See [Add a filter](#add-a-filter).
- **Undo** takes back your last change, then the one before, as many as you made since the dashboard opened. If someone else saved the dashboard after your last change, Undo saves nothing, since it would erase their change: it says so and opens the version history, where you choose the version yourself.

Each change goes through the same checks as the agent's: either it is saved, or nothing is. If someone saved the dashboard in the meantime, your change is saved on top of theirs when it touches other blocks, filters or settings. When it touches the same one, it is not saved: the dashboard reloads and says "Someone else changed this dashboard. It is reloaded: make your change again." A change you make while it reloads waits for it and is saved on the new version. On a phone the dashboard keeps one column, and edit mode works the same way.

Any dashboard you can see can also be **duplicated**: **More actions** (the three dots at the top), then **Duplicate as my own**. The copy is your own personal dashboard, with the same blocks, named "<title> (copy)", and it opens at once. Its blocks must read sources you may read yourself.

## Go back to an earlier version

Every save keeps the version it made, with who saved it and when: the last 20 versions of each dashboard. Anyone who sees the dashboard can list them and look at one. Going back to a version saves it again as a new version, so nothing is lost: you can always go forward again. A dashboard saved before version history existed keeps its versions from its next save. Versions saved while a dashboard was personal stay its owner's: once it is shared, everyone else sees, and goes back to, only the versions saved since.

On the dashboard, **More actions**, then **Version history**, opens the versions in a panel on the right (over the dashboard on a phone), newest first. Each one says who saved it and when, and what it changed against the one before: "1 block added", "Renamed "Sales"", "Blocks or layout changed". **Show blocks** lists that version's blocks. **Restore**, shown to someone who may change the dashboard, brings that version back as a new one. Close the panel with its close button or Escape.

Ask your agent, for example "Put the sales dashboard back as it was on Monday": it lists the versions (`dashboards_history`) and reverts to the one you mean. On an org dashboard that revert waits for an approval like any other change, and its card lists every change the revert makes, one per line under it, as for any other change: each block it removes or adds back with what it reads (source and parameters) and what it shows, each block it changes with its old and new values, and each setting (title, description, size, range, filters) with its old and new value.

## Time range and comparison

A dashboard can follow a time range: last 7, 30 or 90 days, this month, quarter or year to date, last month, quarter or year, or two dates of your choice. The blocks that follow it are compared with another period: the same period last year by default, or the period just before. A metric then shows its previous value beside the current one, and a chart the previous values for each point. A month, quarter or year compares with the whole same month, quarter or year (February 2028 with February 2027); a number of days, or dates of your choice, compares with as many days a year earlier, even across 29 February.

- Whoever builds the dashboard (usually your agent) sets the range it opens on. Without one, it is the last 30 days, compared with last year.
- The range you choose on a dashboard is remembered for you alone, on that dashboard. Others keep their own choice.
- A block that keeps its own dates (for example "open orders, last 90 days", or stock with no date) is not affected by the range and is not compared. It says the dates it reads.
- Dashboards built before time ranges existed keep their blocks' own dates.

A metric can also show a goal (its target) and its trend over the period as a small line.

Days, weeks, months, quarters (`2026-Q4`) and years are always counted in the organization's time zone: an order placed at 00:30 in Paris on 1 November counts on 1 November, in the figures, the trend and the charts alike. A date with no time of day is that calendar day, as written, wherever the organization is: a date column read from a database (sent as midnight UTC), or a date and time with no time zone (read as the organization's own clock). The periods in the bar at the top (this month, last quarter...) start from today in the organization's time zone too, wherever you are. A chart reads a month as "Nov 2026", a quarter as "Q4 2026" ("T4 2026" in French) and a year as "2026".

## Choose the period

When at least one block follows the time range, the bar at the top shows the period as days, with the period it is compared with: for example "1–11 Nov 2026 · vs 1–11 Nov 2025". Click it to change it:

- Under **Period**: **Last 7 days**, **Last 30 days**, **Last 90 days**, **Month to date**, **Last month**, **Quarter to date**, **Last quarter**, **Year to date**, **Last year**, or **Custom range…**, which asks for a **From** and a **To** day and applies them with **Apply**.
- Under **Compare to**: **Same period last year**, **Previous period** or **No comparison**.
- **Back to the dashboard's default** forgets your choice. It shows once you have picked a period on that dashboard.

The blocks that follow the period read again at once. Your choice is remembered for you on that dashboard, and it goes into the tab's address (`?range=lastMonth&compare=lastYear`, or `?range=custom&from=2026-11-01&to=2026-11-11`), so a link you copy opens on the same period. A dashboard opens on the period in its link, else on the one you last chose there, else on its default.

A block that keeps its own dates says them in a small label next to its title, such as "Since 13 Aug 2026", or **Own period** when it reads no dates at all. A block over a dashboard table that names no date reads every row and shows no label.

## What the figures show

- A metric shows its figure large. When it is compared, the change reads beside the figure, with an arrow and its sign, for example "+12% vs same period last year". It is neutral grey, because up is not always good news, unless the block says which way is better (`map.higherIsBetter`: true for sales, false for a backlog or a delay): then a change for the better reads green and one for the worse red, on the text only.
- A metric with a target shows "30 of 40" and a thin bar of the progress toward it, and a metric with a trend shows it as a line under the figure, in the change's colour.
- Colour comes from the data. A chart over a project's tasks by status draws each status in its own colour from the project's board, in the board's order (`map.colorField`, `map.keepOrder`). A chart by person shows each person's avatar colour (`map.personField`). Series that carry no colour of their own take the chart palette of the theme, chosen by their name, so one status or series keeps one colour in every block of a dashboard. A colour from the data that would be hard to see on the theme's background is drawn lighter on the dark theme and darker on the light one. A bar of 0 draws as a thin line on the baseline.
- A chart draws the compared period's values lighter (dashed for a line), named **Same period last year** or **Previous period**.
- Under each block, "Updated 4 min. ago" says when its figures were read. A block built with its own refresh interval reads again on that interval, but only while its tab is on screen.
- A block that follows the period and finds nothing says which days it read: "No data between 1 Nov and 11 Nov".
- A bar of a chart over a project's tasks opens the tasks behind it, each opening the task in Projects, when the block lists them (`map.drillRows: "tasks"` with `map.link`, as in the [project overview](../apps/projects.md#a-project-overview-dashboard)). Any block can do the same: `map.drillRows` names a field of each row that lists the records behind it.
- "3 rows are left out: a field they need is missing or unreadable." means some of the source's rows lacked a date or a number the block needs. "The comparison could not be read this time." means the compared period failed while the current figures still show.

## Chart types and notes

Besides metrics, tables, bars, lines and pies, your agent can build:

- an **area** chart (a line filled), and **stacked** bars or areas (spend by platform, one colour per platform);
- **horizontal** bars, for long names and rankings; with a person per bar (`map.personField`), one row per person with their avatar and name, the bar split by the series (who has what);
- a **pipeline**: one bar split into a segment per category (`map.stackedSingle`), coloured by its data, its legend giving each count; click a segment or a legend entry to list its rows;
- a **combo** chart: bars and lines over the same days or categories, the lines optionally on their own axis (revenue as bars, order count as a line);
- a **funnel**: ordered stages, such as cart, paid, shipped, from one field per stage or from the values of one field;
- a **text** note: a few lines of formatted text with no data behind it, for definitions ("B2B means orders tagged b2b"), targets and caveats.

How each one reads on the dashboard:

- A **funnel** shows its stages top to bottom, each bar as wide as its share of the first stage, and between two stages the share that went on, for example "25% of the step before". It uses calm colours, never red or green.
- A **combo** chart draws its bars and its lines together; when the lines have their own axis, it is on the right. When its bars are stacked, its lines always have their own axis on the right, so a line is never drawn on top of the bars' total.
- A **text** note shows its formatting (bold, lists, links). Any HTML written in it shows as plain text. A link to a web page opens in a new tab; a link to a page of Liaison (such as `/projects`) opens it in place.

## Add a filter

In edit mode, **Add filter** (in **Filters**, at the top of the dashboard) opens a short form in place:

1. **Field**: pick one of the fields the blocks' rows hold, for example `market` or `channel`. The list is read from the blocks' own data when the form opens.
2. **Name**: what the filter's button says. It starts as the field's name.
3. **Kind**: **Choose one value**, **Choose several values**, or **Type text** (the blocks keep the rows whose field holds what you type).
4. **Applies to**: every block (or every source of a blended chart) whose rows hold that field, ticked. Untick the ones the filter should leave alone.
5. **Save filter** adds it. **Cancel** closes the form.

A filter that offers values lists the values the field holds in a block's own data, so it needs a block whose data reads no other filter; when none fits, the form says so: pick **Type text**, or other blocks. Adding, renaming or removing a filter is a change like any other: saved at once, in the version history, and **Undo** takes it back. Everyone who opens the dashboard then picks their own value in the filter row, remembered for them alone.

## Read a chart over time

A chart with a headline shows the period's figure above it, large, with its change against the compared period beside it: "54 ↓ 25%", then "vs Oct 1 – 12, 2026" under it, naming the compared days. The change is an arrow and a percentage in the text's own colour, never red or green. A blended chart shows one figure per source and per worked out figure (units per session), side by side.

When the dashboard compares, the legend names both periods by their real days, for example "Nov 1 – 12, 2026" for the current line and "Oct 1 – 12, 2026" for the compared one, drawn lighter and dashed on the same days. Hover a day to read both values: "Nov 6", "sessions: 7", "Oct 6: 6". Stacked bars split into several series (units per product, say) compare by their total: one lighter bar beside each day's stack holds the compared period's total, named once in the legend, for example "Units · Oct 1 – 12, 2026". Hovering a stacked day lists each series' value, then the day's total and the compared total: "Total: 12", "Oct 6: 9". A line keeps its own dashed comparison, and bars that do not stack keep one lighter bar per series. The day that holds today is drawn dotted (a faint bar for a bar chart), with **Today, still counting** under the chart: its figure grows until the day ends. A line on the right axis says so in the legend, for example "Sessions (right axis)". When one source of a blended chart cannot be read, a line under the chart names it and says why. Clicking a bar or a point of a blended chart opens the records of the source it comes from.

## Charts over time

A chart by day, week, month, quarter or year that follows the dashboard's period shows every one of its days (or weeks, or months), up to 400 of them: a quiet day counts as 0, so the line never jumps over it. A day with no value for an average, a lowest or a highest figure is left as a gap. The compared period is laid out the same way, day for day. The day, week or month that holds today is marked as still in progress while the period ends today.

Your agent can also give a chart:

- a **headline**: the period's figure above the chart with its change against the compared period, worked out over every row (a total stays a total, an average is the average of every row, not of the daily averages), or one figure per series;
- a **smooth** line instead of straight segments;
- a **blended** chart: two or three sources in one combo chart, for example units sold per product as stacked bars and the shop's sessions as a line on the right axis. The sources join on the same day, week or month, never on anything else. A blended chart can add figures worked out from its sources' totals, such as units per session. When one source cannot be read, its reason is shown and the others still draw. The records behind a blended chart are read one source at a time.


A dashboard can also have **filters** (at most 8), such as a market, a channel or a campaign. They sit in a row under the bar at the top, one button per filter, which reads its name and its value: "Market: All", "Market: FR", or "Channel: b2b, dtc". On a phone the row wraps.

- Click a filter to see its values. **All** shows everything. A filter that takes one value closes on your pick; one that takes several keeps its menu open, each click ticks or unticks a value, and the blocks read the values you ticked once you close the menu.
- A text filter is a small field: type a value and press Enter, or leave the field. Empty it to show everything again.
- A filter's values are a fixed list, or the values found in the dashboard's own data for the period shown, read when you open the menu. A long list shows its first 200 values and says so.
- A menu of values found in the data has a **Search** box at its top (so has a fixed list of more than 10 values): type part of a value and the menu lists the matching ones, searched among all of them, not only the first 200.
- **Reset filters** goes back to the dashboard's default values and forgets yours.
- A value cannot hold `{{` or `}}`. A link with a value the filter does not offer (removed since), or longer than 200 characters, opens with that value left out.

Each block that reads a filter shows only the matching data: either the source is asked for that value, or the block keeps only the rows that match. Your values are remembered for you alone, on that dashboard, like the period, and they go into the tab's address (`?f.market=FR&f.channel=b2b&f.channel=dtc`; `f.market=` with nothing after it means all), so a link you copy opens with the same filters. Values too long to remember (about 16 KB in all) apply in the tab and its link only. A dashboard opens, filter by filter, on the value in its link, else on the one you last chose there, else on its default. A block asked for new values a moment ago may keep the figures it shows and say "Just refreshed. Try again in a few seconds."

A block can keep only some rows of its source ("only the ad sets that spent", "without cancelled orders") before anything is counted.

When several blocks show the same data (a count and the list of the same orders, a chart and a table of the same ad spend), your agent declares that data once as a **shared dataset**: it is read once for all of them, so the dashboard loads faster, asks connected services less often, and its blocks always agree.

## See the records behind a figure

A block's figures come from rows of its source, and you can see those rows: the orders behind a bar, the ad sets in a slice, the rows a metric adds up.

- Click a bar, a point, a slice, a funnel stage, a table row's first cell or a metric's figure. With the keyboard, each chart's categories can also be reached with Tab.
- The button with rows lines next to a block's title (**Show the rows behind this block**) lists every row the block counts. A metric read from a single record (not a list) has no rows behind it, so it has no such button.

The rows open in a panel on the right of the dashboard (over it on a phone), with the block's title and the figure you picked ("FR", or **All rows**). At its top: "1 to 50 of 230", **Previous page** and **Next page**, and **Close** (or press Escape, wherever you are on the dashboard); focus then goes back to what you clicked. The rows follow the period and the filters the dashboard shows: change either while the panel is open and it reads the rows again from the first page. A bar or point of the compared period opens that period's rows, with its dates under the title. When the block says where a row leads (an order, a ticket, a contact), each row has **Open**, which opens that record in Liaison. When the source holds more rows than are searched, the panel says "The source has more rows: only its first 2,000 are searched."

The rows are read from the figures already loaded, never by running the source again while those are fresh, with the same access as the block.

## Calculated figures

A block can compute its figures from others, for example a return on ad spend (revenue divided by ad spend, the spend read from another shared dataset), a difference between two counts, a share of a total, or amounts kept in cents shown in units. Your agent writes the calculation with numbers, `+ - * /`, parentheses, `min`, `max`, `abs` and `round`. A calculation may use another calculated figure, listed before or after it. One that uses itself, or two that use each other, is refused when the dashboard is saved, with the reason. A division by zero, or a figure that is missing, shows no value rather than a wrong number or 0: a chart leaves a gap there. A chart can also show each value as a percentage of its total, read as "25%".

## Export a dashboard

On the dashboard, **Export** then **Download PDF** downloads the whole dashboard for the period and filters you show. A block's menu (the three dots beside its title) has **Data (CSV)** and **Rows behind it (CSV)**. A block that keeps its own dates exports those dates.

- A block's figures as a CSV file: one row per label and a column per series, the compared values beside them (`GET /api/dashboards/:id/blocks/:blockId/data.csv`).
- The rows behind a block as a CSV file: every row it reads (up to 2,000), with the same columns as when you look at them (`GET /api/dashboards/:id/blocks/:blockId/rows.csv`).
- The whole dashboard as a PDF, for the period and filters you show (`GET /api/dashboards/:id/export.pdf`): the title and description, the period and what it is compared with, each filter's value, then every block (a metric with its compared value, change and target, a chart's values as a table, a table's first 100 rows, a note's text, and for a block that cannot show, why).

Everything is read with your own access, through the same figures as the dashboard. A text in a CSV file that a spreadsheet would run as a formula starts with `'`; a number sent as text, such as `-12.50`, stays a number.

## Send a dashboard on a schedule

On the dashboard, **More actions** then **Send regularly…** reminds you how, with an example request naming the dashboard. Ask your agent, for example "Every Monday at 8, send me the sales dashboard for last week". It sets up a routine ([Routines](routines.md)) that, each time, reads the dashboard for that period (`dashboards_snapshot`: each figure with its change), posts the key figures and, if you want it, the PDF (`dashboards_pdf`). The routine waits for your approval like any new routine.

Nobody receives more than they could see themselves. The figures are read with the access of the routine's owner. Before the snapshot or the PDF goes to anyone else (a shared conversation, an email), the agent names the recipients, and each one is checked: an active member who can open the dashboard, read every source behind it, and see at least the rows the routine's owner sees (every dimension value the owner holds, and every role). Only the people who pass are listed to receive it (`sendTo`); the others are left out (`leftOut`, with the reason), and the agent says who and why. When nobody passes, nothing is sent. Someone who sees fewer rows gets their own figures from a routine of their own, which reads with their access: one routine per person.

## What a block can read

Each block reads one source:

- a **read tool** of an app or a connector, such as a connector's read of a shop's orders. Every read can feed a block, including the reads an app's own settings pages use. A tool that changes data, sends something, needs an approval or acts outside Liaison is refused, and so are a few reads: one that hands out a secret (a webhook signing secret), one that answers a single file's text (a repository file, a Drive file) or the connector authoring guide, a provider operation only another app calls, and the kernel reads that belong to one person or one conversation (an agent's memory, a conversation's messages, your own computer) or to the agent's own work (tool search, setup guides, block previews). The kernel's reads of the organization's records and settings qualify: people, contacts and their groups, companies and their timelines, conversations, routines and their events, approvals and policies, roles and scopes, skills, agents, files, document templates and rules, product attributes, imports, dashboards, app builds, AI models and the audit log. An organization's own custom app feeds a dashboard under the same rules; another organization's never does. A read that answers a few figures rather than a list (queue counts, a profit and loss summary, a monitoring summary) also answers them as rows, one per figure, so a block can chart or total them.
- a **data store collection** that its app declares readable outside the app, read with the collection's read scope (the agent's own collections need `kernel:data:read`).
- a **dashboard table**, including one backed by a project, whose rows are the project's tasks the viewer can read ([Keep data in tables](dashboard-tables.md)). A project's figures by status, handler, time in status or SLA come from Projects' `tasks_aggregate` read ([Projects](../apps/projects.md)).

The same holds for a shared dataset and for a filter that lists the values of a source. The source is checked when the dashboard is saved, as its author, and again every time a block is shown, as the viewer. A tool that later starts asking for approval shows "This block's source can no longer be shown on a dashboard". A block's run may only read: any write it attempts is refused, even when the tool claims to be a read. A tool can still call an outside service while it reads; a dashboard does not stop that.

A block reads at most 2,000 rows from its source, and shows at most 100 rows, bars or slices. A dashboard holds at most 24 blocks. Each source run is recorded in the audit log (`dashboard.block_run`) with the dashboard and the block, the shared dataset or the filter it was read for.

## Rolling date ranges

A block's source settings can hold a rolling date, so "this month" or "the last 30 days" moves with the calendar instead of staying on the day the dashboard was built. Each one is replaced by a date (`YYYY-MM-DD`) every time the block runs, in the organization's timezone (UTC when none is set):

| Written | Stands for |
| --- | --- |
| `{{today}}` | Today. |
| `{{yesterday}}` | Yesterday. |
| `{{startOfWeek}}` | Monday of this week. |
| `{{startOfMonth}}` | The 1st of this month. |
| `{{startOfQuarter}}` | The 1st day of this quarter. |
| `{{startOfYear}}` | January 1st of this year. |
| `{{endOfWeek}}`, `{{endOfMonth}}`, `{{endOfQuarter}}`, `{{endOfYear}}` | The last day of this week (Sunday), month, quarter or year. |
| `{{range.from}}`, `{{range.to}}` | The first and last day of the dashboard's time range, as the viewer chose it. |
| `{{range.fromTime}}`, `{{range.toTime}}` | The first and last second of that range, as a date and time with the organization's UTC offset. |
| `{{range.endExclusive}}` | The first instant after the range (midnight of the next day), for a filter written "before this instant". |

Each may carry one offset (not the two date and time forms): `+` or `-`, a number, and `d` (days), `w` (weeks), `M` (months) or `y` (years). For example `{{today-30d}}`, `{{startOfMonth-1M}}` (the 1st of last month) or `{{endOfMonth-1M}}` (the last day of last month). A month or year offset keeps the day, moved back to the month's last day when the month is shorter; on an end-of date it moves the whole period, so `{{endOfMonth-1M}}` is always last month's last day. A rolling date also works inside a longer text, such as a query's `BETWEEN '{{today-29d}}' AND '{{today}}'`. A date written out in full stays that date. Anything else between `{{` and `}}` is refused when the block is previewed or saved.

## How long figures are kept

Changing a dashboard's layout, titles, sizes or description never reads its sources again: only a change to what a block reads, or to the fields it uses, does. A block's figures are kept for a minute, or for the block's own interval, set by whoever built it (at most 15 minutes, whatever the interval; a shared dataset follows the shortest interval of its blocks). They are kept per person and per set of access rights (scopes, dimension grants and roles), so a change to your access is never answered with figures read under the old one. A block with rolling dates reads again as soon as its dates move, a block that follows the time range keeps its figures per range, and a filter value its source reads is a new read. A filter that only keeps some rows never reads the source again. Blocks of one shared dataset that load together wait for the same read, and refreshing them one after the other within 30 seconds reads it once. A block runs at most four sources at once for one person; the rest wait their turn. One refresh per block per person every 30 seconds. The compared period lies in the past, so its figures are kept for 6 hours and **Refresh** reads only the current period again. Reads the cache cannot answer are budgeted: new dates of your choice (counting the compared period), new filter values a source is asked for, and every read of a source whose result is too large to keep (or while the cache is down). A block reads at most 12 of them per person per minute, and one person at most 60 across all blocks and dashboards; past that a block keeps its figures and says "Just refreshed. Try again in a few seconds." The listed periods, the dashboard's default and the filters' defaults never count while their result is kept. A filter that takes several values gives the same read whatever order they were ticked in. A block whose source failed keeps that answer for 30 seconds too, so opening the dashboard again does not run the failing source again; **Refresh** reads it at once. Closing the tab stops its blocks' reads.

## Edit a table's rows

A table holds rows that people and agents write, such as incoming batches or repairs. Your agent creates a table; you then edit its rows on any dashboard that shows it, or on the table's own page.

- The **Tables** section of the **Dashboards** sidebar lists the tables you can see. Click one to open it full width, at `/dashboard-table/<id>`, with three tabs at the top: **Grid**, **Settings** and **History**.
- A table block on a dashboard shows the same rows. It may show only some columns, in its own order.
- Click a cell to change it. Each column type has its editor: a text, number or date field (Enter saves, Escape cancels), an amount in the column's currency, a choice as chips, several choices as boxes to tick, a checkbox you tick in place, a person picked from the members, and a link picked from the records of the column's app.
- **Add** opens a form at the top, required columns first. A missing required value or a word in a number column is refused before anything is saved.
- The bin at the end of a row deletes it, after a confirm. The history keeps the row, and **Undo** brings it back.
- **Last change** says who changed the row and when ("@logistics · 4 min ago"). Click it to open the row's history: each change, who made it, and **Undo** on a change that can still be undone.
- If someone changed the row since you opened it, your change is not saved: the row reloads and says "Changed by Nico just now".
- A block may mark rows not changed for some days as **To confirm**.
- A record your access does not let you read shows as **Linked record**.
- Rows come 50 a page, with **Previous** and **Next**. Click a column's name to sort by it, again to reverse.
- With view access only, you see the rows without the editors.
- A table backed by a project shows its tasks as rows. Editing a task value (its title, status, assignee or a field) changes the task in Projects; its own columns are kept per task. Adding a row creates a task; its rows have no bin.

In **Settings**, an editor of the table adds a column, renames one, edits a choice column's choices or removes a column (after a confirm). Each change applies at once. A removed column's name cannot be used again, and its values stay in the history. **Who can see and edit** opens the same sharing dialog as a dashboard's. **Agent row writes need approval** makes an agent's row change wait for someone to approve it; off, agents write at once and every change is kept in the history.

## The dashboards API

Signed-in requests, with the person's own access:

| Request | What it does |
| --- | --- |
| `GET /api/dashboards` | Your dashboards and the org's. |
| `POST /api/dashboards` | Create one: `{ title, visibility, spec }`. |
| `GET /api/dashboards/:id` | One dashboard and its spec, today's date and the time zone its dates are counted in (`today`, `timeZone`), the range it opens on for you (`range`, with `saved` when it is your own choice), its default (`defaultRange`), which blocks follow the range (`blockTimeRange`), and the filter values it opens on for you (`filters.values`, `filters.saved`) with their defaults (`defaultFilters`). |
| `PATCH /api/dashboards/:id` | Change `title`, `visibility` or `spec`; `ifVersion` refuses to overwrite a newer save (409). |
| `POST /api/dashboards/:id/edit` | Change it by a list of operations, all or none: `{ ifVersion, operations }` (1 to 50: `moveBlock`, `resizeBlock`, `updateBlock`, `duplicateBlock`, `removeBlock`, `addBlock`, `setTitle`, `setDescription`, `setTimeRange`, `revert`...). Never held for approval. Written against an older `ifVersion`, it applies on top of the current version unless a version saved since changed what it names (409 `VERSION_CONFLICT` otherwise; a `revert` never applies on top). Answers the dashboard as `GET` does. |
| `POST /api/dashboards/:id/duplicate` | A copy as your own personal dashboard: `{ title? }`. |
| `GET /api/dashboards/:id/versions` | Its kept versions, newest first (`version`, `title`, `savedAt`, `savedByName`, `blockCount`, `current`). |
| `GET /api/dashboards/:id/versions/:version` | One kept version with its spec. |
| `GET /api/dashboards/:id/blocks/:blockId/data.csv` | The block's figures as CSV (range, compare and filters as for the data). |
| `GET /api/dashboards/:id/blocks/:blockId/rows.csv` | The rows behind it as CSV (as for the rows, every row). |
| `GET /api/dashboards/:id/export.pdf` | The dashboard as a PDF (range, compare and filters as for the data). |
| `DELETE /api/dashboards/:id` | Delete it. |
| `GET /api/dashboards/:id/sharing` | Who sees it: `orgAccess` (`none`, `viewer` or `editor`), `ownerUserId`, `ownerName`, `canManage`, `users` and `roles` (each with `role` `viewer` or `editor` and its `name`). Anyone who sees it may read it. |
| `PUT /api/dashboards/:id/sharing` | Change it: any of `{ orgAccess, users: [{ userId, role }], roles: [{ roleId, role }] }`; each list given replaces that list. 403 without editor access and `kernel:dashboards:share`; 400 for a person or role outside the organization. |
| `GET /api/dashboards/:id/blocks/:blockId/data` | One block's data, run as you. `?refresh=1` reads it again. `?range=<preset>` (`last7d`, `last30d`, `last90d`, `mtd`, `lastMonth`, `qtd`, `lastQuarter`, `ytd`, `lastYear`), or `?from=YYYY-MM-DD&to=YYYY-MM-DD`, and `?compare=lastYear\|previousPeriod\|none` set the range; without them, the dashboard's default. `?f.<filterId>=<value>` (repeated for several values) sets a filter; an absent filter takes its default, an empty one means all. |
| `GET /api/dashboards/:id/blocks/:blockId/rows` | The rows behind a figure, read-only: `?category=<label>` (and `?series=<name>`) for a chart, `?row=<index>` for a table row, nothing for a metric; `?offset=` and `?limit=` (at most 200) page them. Range and filters as for the data. Answers `columns`, `rows`, `links` (where each row leads), `total`, `nextOffset` and `fields` (the names of the fields the source's rows hold). A blended chart takes `?layer=<id>`. |
| `GET /api/dashboards/:id/filters/:filterId/options` | A filter's choices: its list, or the values found in its data (at most 200, `?q=` narrows them). |
| `GET /api/dashboards/:id/viewer-state` | The range and filter values you last chose on this dashboard, or `null`. |
| `PUT /api/dashboards/:id/viewer-state` | Remember your choice: any of `{ timeRange: { preset, from?, to? }, compare, filters: { <filterId>: [values] } }`. Filter values over 16 KB in all answer 400. |
| `DELETE /api/dashboards/:id/viewer-state` | Forget it: the dashboard opens on its defaults again. |

A block's data is the chart's shape (`kind`, then `value`, `rows` or `labels` and `series`, a note's `markdown`, and `meta`; with a comparison, `previous`; a metric's `target` and `sparkline`; how a chart is drawn in `display`; a table's `links`), with `computedAt`, `window` (the days it read, or its own dates) and `compareWindow`, or the block's own refusal `{ error, message }` with `error` one of `no_access`, `not_allowed`, `unknown_tool`, `source_failed`, `invalid_map` or `rate_limited`. Both answer 200, so the other blocks still render. A spec the server refuses answers 422 with every problem named; an unknown filter or a value outside a filter's list answers 400.

Tables a dashboard shows and edits have their own API and tools: [Keep data in tables](dashboard-tables.md).
