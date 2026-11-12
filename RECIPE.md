# Trough

A feed of short stories that tools and agents publish on this machine: a build failed, a report is ready, something needs a decision. The person scans the list, opens a story for its full text and links, files it as read or done, snoozes it, or runs one of its actions after reading exactly what the action will do.

![Trough](preview.png)

**What you see**

A single column, top to bottom. All colors are theme colors.

1. Header, on the chrome color with a bottom border, 10px side padding.
   - Title row: `Trough` in 15px semibold, then `N unread` in 11px muted, `N rejected` in the blocked color only when a submission was rejected, and a `↻` reload button.
   - Filter row: an `f Filters` button, the active view and filters as one truncated 11px muted line (for example `Inbox (unread OR needs action) · severity: WARN · search: build`), and an `x Clear` button.
   - Filter picker, only while open: `Inbox` and `Active unfinished` buttons, a hint line `States (AND): 1–4 toggle`, four state buttons `1 unread`, `2 needs action`, `3 done`, `4 snoozed`, four field buttons `source`, `kind`, `severity`, `subject` (each with a count of picked values), and a 120px scrolling list of that field's values.
   - Producer line, only when a pack provides a producer: `Name: last 2m ago` per producer in 10px dim text, with ` · error: ...` after a failed run.
   - Search box, 27px tall, only while searching or when a search is set.
2. Error line in the blocked color, only when the last command failed.
3. Story list, filling the remaining height and scrolling. Each story is a card with 10px by 8px padding and a bottom border; the selected card uses the selected background.
   - Line 1: a 34px severity label in 10px text (`INFO` muted, `NOTE` accent, `WARN` in the working color, `CRIT` in the blocked color), the title in semibold (foreground when unread, muted when read), and the relative time in 10px dim text (`just now`, `5m ago`, `3h ago`, `yesterday`, `4d ago`, then a short date).
   - Line 2, 11px muted: `Source label · kind`, then ` · outcome` and ` · done` when set.
   - Line 3, 11px muted, truncated: the summary.
   - Stories that share a group get one 11px header row above them: `Source · kind · N stories · N actions`.
   - An empty view shows `No stories in this view`.
4. Detail, below the list while a story is open, with a top border and 12px by 10px padding: the title and a `×` close button; a line with severity, source, exact local time and story ID; the full summary; the decision prompt in the accent color; one `Label: destination` line per link; `Last action: outcome · result` after an action ran; one button per action; then `Read`/`Unread`, `Done`/`Undo`, `Snooze 1h` and `Delete` buttons.
   - An action that cannot run is a dim outlined label, not a button, with a 10px line under the row: `Label is unavailable: reason`.
   - Review sheet, accent border: `Review action`, the source claim, the numbered exact effects, `Confirm action` and `Cancel`.
   - Delete sheet, blocked-color border: what will be removed, `Delete story` and `Cancel`.
5. Footer: one 10px dim line of key hints.

As an overlay the pane is 640 by 560; docked in a layout it defaults to 420 wide.

**How it behaves**

- It opens in Inbox: stories that are unread, or that have actions and are not done. `Active unfinished` shows stories that are neither done nor snoozed. Picking a state toggle leaves Inbox; state toggles combine with AND, values within one field with OR, and fields, state and search with AND.
- Keys while the list has focus: `j`/`k` or arrows move, `g`/`G` jump to the first and last story, Enter opens and closes the detail, `/` focuses search, `f` opens the filter picker, `1` to `4` toggle states while the picker is open, `x` clears everything back to Inbox, `r` toggles read, `d` toggles done, `D` asks to delete, `z` snoozes for one hour, `a` starts review of the first action that can run, Escape closes whatever is open.
- Clicking a card selects it and opens the detail.
- An action never runs on the first click. The click asks the CLI for a review and shows the sheet; `Confirm action` runs it once and shows the outcome. An action that needs a choice first lists the decision's options (and a comment box if the story allows one); picking an option opens the review.
- URLs in the summary, the prompt and the links are underlined in the accent color and open in the browser. Local paths are underlined too; clicking one opens the file or folder, or reveals it in Finder if it could run.
- The list reloads when the data folder changes and every 10 seconds; relative times refresh every 15 seconds.
- Read stories older than the retention age are pruned when the pane opens and hourly.
- Each pack producer runs when the pane opens and then on its own interval; one run at a time per producer.
- It does not show agent status. It shows only stories.

**Built from**

- One mod, `mods/trough`, with `mod.json` `{"place":"none","title":"Trough","size":420,"focusable":true,"overlay":{"width":640,"height":560}}`. Props: `dir`, the data folder (default `~/.local/state/trough`).
- `main.js` is a `View`. It uses `gpui-kit` (`View`, `div`), `gpui-base` (`v_flex`, `h_flex`, `InputState`, `Input`) and from `herdr`: `exec`, `watchFolder`, `theme`, `home`, `appHome`, `props`, `nextCommand`. `nextCommand` handles `focus`.
- The pane keeps no data of its own. Every read and write is `exec('node', [<appHome>/mods/trough/bin/trough, '--dir', dir, ...])`: `ls --all --json`, `receipts`, `rejections`, `read`/`unread`/`done`/`undo`/`snooze`/`delete ID`, `review STORY ACTION [--option ID] [--comment TEXT]`, `run TOKEN`, `open STORY PATH`, `producers`, `produce ID`, `prune`.
- `bin/trough` and `core/` are the store, the story validator, the action review and receipt logic, pack loading and pruning, in plain Node.js with no dependencies. `feed.js` (views, filters, groups), `links.js` (URL and path detection), `time.js`, `severity-label.js` and `producer-schedule.js` are small pure modules the pane imports.
- Programs it runs: `node`. On macOS, actions and path clicks run `/usr/bin/open`. Packs the person lists in `handlers.json` may run more; the reading-list pack runs `rl`.
- Suggested key, in `keys.json`: `cmd-shift-u` to `mod.open:trough`.
- No art.

**Watch out**

- The pane needs `node` on the app's `PATH`, and the CLI must sit at `mods/trough/bin/trough` under the app home with `core/` beside it. If the mod folder is renamed, change the `cli` path in `main.js`.
- Open, reveal and path clicks work on macOS only. Elsewhere the built-in open actions are shown disabled.
- `ls --json` returns `action_status` per story. Use it to disable an action; do not guess from the handler name.
- `a` and the review flow act on the selected story. Drop a review sheet when the selection changes, or the sheet can confirm an action for the wrong story.
- While a text input has focus, keys belong to the input; only Escape returns focus to the list.
- The pane prunes on open. A check or a second copy pointed at the same data folder prunes too.
- A story with only unavailable actions still counts as "needs action" in Inbox until it is marked done.
- Group headers appear only for groups of two or more stories.
- Stories are capped at 64 KiB, 16 links and 8 actions.

**Done when**

- `herdr-app check mods/trough` passes and `npm test` passes.
- `trough emit --source demo --kind note --title Hello --summary 'First story'` makes a card appear in an open pane without a reload click.
- `r` dims the title, `d` adds ` · done` and the story leaves Inbox, `x` returns to Inbox.
- A story with an `open_url` action shows a button; clicking it shows the review sheet with the URL, and only `Confirm action` opens the browser and adds `Last action: succeeded`.
- A story whose action names a handler that is not installed shows that action dimmed with `handler <id> is not installed` and nothing happens on click.
- `D` shows the delete sheet; `Delete story` removes the card and posting the same story again does not bring it back.
