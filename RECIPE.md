# Trough

A feed of short stories that tools and agents publish on this machine: a build failed, a report is ready, something needs a decision. The person scans the list, opens a story for its full text and links, files it as read or done, snoozes it, or runs one of its actions after reading exactly what the action will do.

![Trough](preview.png)

**What you see**

A single column, top to bottom. All colors are theme colors.

1. Header, on the chrome color with a bottom border, 10px side padding.
   - Title row: `Trough` in 15px semibold, then `N unread` in 11px muted, `N rejected` in the blocked color only when a submission was rejected, an `Always allowed` button (`Always allowed (N)` when there are standing approvals), and a `↻` reload button.
   - Filter row: an `f Filters` button, the active view and filters as one truncated 11px muted line (for example `Inbox (unread OR needs action) · severity: WARN · search: build`), and an `x Clear` button.
   - Filter picker, only while open: `Inbox` and `Active unfinished` buttons, a hint line `States (AND): 1–4 toggle`, four state buttons `1 unread`, `2 needs action`, `3 done`, `4 snoozed`, four field buttons `source`, `kind`, `severity`, `subject` (each with a count of picked values), and a 120px scrolling list of that field's values.
   - Always-allowed panel, only while open: a bordered box on the surface color with a 10px dim line (`These actions run without a review sheet, for every story. Each run still leaves a receipt.`), then one row per approval: the handler's declared effect in 11px, under it `pack/handler · allowed 2h ago` in 10px dim text (in the working color with ` · asks again: reason` when the approval no longer holds), and a `Revoke` button. With no approvals the box says how to add one.
   - Pack problem lines in the blocked color, one per problem: `Pack name: problem`. When the person's own open handler changed, a line `Your open handler is not used: reason` with `Use it` and `Turn off` buttons instead.
   - Producer line, only when a pack provides a producer: `Name: last 2m ago` per producer in 10px dim text, with ` · error: ...` after a failed run.
   - Search box, 27px tall, only while searching or when a search is set.
2. Error line in the blocked color, only when the last command failed.
3. Story list, filling the remaining height and scrolling. Each story is a card with 10px by 8px padding and a bottom border; the selected card uses the selected background.
   - Line 1: a 34px severity label in 10px text (`INFO` muted, `NOTE` accent, `WARN` in the working color, `CRIT` in the blocked color), the title in semibold (foreground when unread, muted when read), and the relative time in 10px dim text (`just now`, `5m ago`, `3h ago`, `yesterday`, `4d ago`, then a short date).
   - Line 2, 11px muted: `Source label · kind`, then ` · outcome` and ` · done` when set, then ` · badge` for each badge a pack added.
   - Line 3, 11px muted, truncated: the summary.
   - Stories that share a group get one 11px header row above them: `Source · kind · N stories · N actions`.
   - An empty view shows `No stories in this view`.
4. Detail, below the list while a story is open, with a top border and 12px by 10px padding: the title and a `×` close button; a line with severity, source, exact local time and story ID; the full summary; the decision prompt in the accent color; one `Label (role): destination` line per link, with a row of small buttons under it for the actions packs offer on that link (`Open`, `Show in Finder`, `Add to reading list`); `Last action: outcome · result` after an action ran; one button per action the story declares, then any pack offers that belong to no link; then `Read`/`Unread`, `Done`/`Undo`, `Snooze 1h` and `Delete` buttons.
   - An action that cannot run is a dim outlined label, not a button, with a 10px line under the row: `Label is unavailable: reason`.
   - Review sheet, accent border: `Review action`, the source claim, where the action came from (`Action declared by the story` or `Action offered by pack core: Open`), the numbered exact effects, `Confirm action` and `Cancel`. For an action that may be always allowed, above the buttons: a 13px checkbox (accent fill and a check mark when ticked) labelled `Always allow: <the handler's declared effect>`, and a 10px dim line `Later clicks run at once, for every story (pack/handler). Revoke under Always allowed.` When an earlier approval no longer holds, a line in the working color says so and the box starts ticked.
   - Delete sheet, blocked-color border: what will be removed, `Delete story` and `Cancel`.
5. Footer: one 10px dim line of key hints.

As an overlay the pane is 640 by 560; docked in a layout it defaults to 420 wide.

**How it behaves**

- It opens in Inbox: stories that are unread, or that declare actions and are not done. Actions that packs offer do not keep a story in Inbox. `Active unfinished` shows stories that are neither done nor snoozed. Picking a state toggle leaves Inbox; state toggles combine with AND, values within one field with OR, and fields, state and search with AND.
- Keys while the list has focus: `j`/`k` or arrows move, `g`/`G` jump to the first and last story, Enter opens and closes the detail, `/` focuses search, `f` opens the filter picker, `1` to `4` toggle states while the picker is open, `x` clears everything back to Inbox, `r` toggles read, `d` toggles done, `D` asks to delete, `z` snoozes for one hour, `a` starts review of the first action that can run (declared first, then offered; an always-allowed offer runs at once), Escape closes whatever is open.
- Clicking a card selects it and opens the detail.
- An action never runs on the first click, unless the person always allowed that kind of action. The click asks the CLI for a review and shows the sheet; `Confirm action` runs it once and shows the outcome. Confirming with `Always allow` ticked also records a standing approval for that pack's handler; later clicks on such an action, for any story, run at once and show the outcome. Only actions a pack offers can have the checkbox, never a decision answer, a prompt delivery or an action the story declares. If what the handler runs changed since, the sheet comes back once with the box ticked; confirming with it unticked withdraws the approval. `Always allowed` in the header lists and revokes approvals. An action that needs a choice first lists the decision's options (and a comment box if the story allows one); picking an option opens the review.
- URLs in the summary, the prompt and the links are underlined in the accent color and open in the browser. Local paths are underlined too; clicking one opens the file or folder, or shows it in the file manager if it could run.
- The list reloads when the data folder changes and every 10 seconds; relative times refresh every 15 seconds.
- Read stories older than the retention age are pruned when the pane opens and hourly.
- Each pack producer runs when the pane opens and then on its own interval; one run at a time per producer.
- It does not show agent status. It shows only stories.

**Built from**

- One mod, `mods/trough`, with `mod.json` `{"place":"none","title":"Trough","size":420,"focusable":true,"overlay":{"width":640,"height":560}}`. Props: `dir`, the data folder (default `~/.local/state/trough`).
- `main.js` is a `View`. It uses `gpui-kit` (`View`, `div`), `gpui-base` (`v_flex`, `h_flex`, `InputState`, `Input`) and from `herdr`: `exec`, `watchFolder`, `theme`, `home`, `appHome`, `props`, `nextCommand`. `nextCommand` handles `focus`.
- The pane keeps no data of its own. Every read and write is `exec('node', [<appHome>/mods/trough/bin/trough, '--dir', dir, ...])`: `ls --all --json`, `receipts`, `rejections`, `packages list --json`, `handler on|off`, `read`/`unread`/`done`/`undo`/`snooze`/`delete ID`, `review STORY ACTION [--option ID] [--comment TEXT]`, `act STORY ACTION` (for a pack offer: returns `{receipt}` if it ran on a standing approval, else `{review}`), `run TOKEN [--always-allow]`, `allow list --json`, `allow revoke KEY`, `open STORY PATH`, `producers`, `produce ID`, `prune`.
- `bin/trough` and `core/` are the store, the story validator, the action review and receipt logic, pack loading and augmentation, the core pack and pruning, in plain Node.js with no dependencies. `handlers/` holds the open and reveal scripts: `macos.sh`, `linux.sh`, `windows.ps1`, and `check-handler.ps1` for Windows. `feed.js` (views, filters, groups), `links.js` (URL and path detection), `time.js`, `severity-label.js` and `producer-schedule.js` are small pure modules the pane imports.
- Programs it runs: `node`. Open and reveal run `sh` with `open` on macOS, `sh` with `xdg-open` and `gdbus` on Linux, and `pwsh` with `explorer.exe` on Windows; and, only after the person turns it on, their own handler at `<Herdr home>/trough/handler`. Packs the person lists in `handlers.json` may run more; the reading-list pack runs `rl`.
- Suggested key, in `keys.json`: `cmd-shift-u` to `mod.open:trough`.
- No art.

**Watch out**

- The pane needs `node` on the app's `PATH`, and the CLI must sit at `mods/trough/bin/trough` under the app home with `core/` beside it. If the mod folder is renamed, change the `cli` path in `main.js`.
- Open and reveal have been run on macOS only; the Linux and Windows handlers are written but untested.
- `ls --json` returns `action_status` (declared actions), `offers` (pack actions, each with `available` and `reason`) and `badges` per story. Use them; do not guess from the handler name. An offer's ID has the form `pack.id` and is what `review` takes.
- The pane never decides that an action may skip the sheet. It calls `act` and shows whatever comes back, and it shows the checkbox only when the sheet carries `always_allow`.
- A person's own handler is never turned on by the mod itself, only by `Use it` after it changed or by `trough handler on`.
- `a` and the review flow act on the selected story. Drop a review sheet when the selection changes, or the sheet can confirm an action for the wrong story.
- While a text input has focus, keys belong to the input; only Escape returns focus to the list.
- The pane prunes on open. A check or a second copy pointed at the same data folder prunes too.
- A story whose declared actions are all unavailable still counts as "needs action" in Inbox until it is marked done.
- Group headers appear only for groups of two or more stories.
- Stories are capped at 64 KiB, 16 links and 8 actions.

**Done when**

- `herdr-app check mods/trough` passes and `npm test` passes.
- `trough emit --source demo --kind note --title Hello --summary 'First story'` makes a card appear in an open pane without a reload click.
- `r` dims the title, `d` adds ` · done` and the story leaves Inbox, `x` returns to Inbox.
- A story with a URL link shows `Open` under that link without declaring any action; clicking it shows the review sheet with `Action offered by pack core: Open` and the URL, and only `Confirm action` opens the browser and adds `Last action: succeeded`.
- A story whose declared action names a handler that is not installed shows that action dimmed with `handler <id> is not installed` and nothing happens on click.
- After `trough packages remove core` the `Open` buttons disappear from every story; `trough packages add core` brings them back.
- `D` shows the delete sheet; `Delete story` removes the card and posting the same story again does not bring it back.
