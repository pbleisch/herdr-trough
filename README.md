# Trough

Trough is a local activity feed for [Herdr](https://herdr.dev) desktop. Tools and agents publish short JSON stories ("the build failed", "a report is ready", "this needs your decision"); you read them in a pane, file them as read or done, snooze them, and run their actions after reviewing exactly what each one will do.

![Trough](preview.png)

- **Local.** Stories are files in a folder on your machine. There is no service, no account and no third-party package.
- **Immutable.** A published story never changes. Read, done and snooze are your own filing state, kept beside it.
- **Reviewed actions.** A story can offer actions, but it cannot name a command. It names a handler you installed, and nothing runs until you confirm the exact effects.
- **Usable without the pane.** The `trough` CLI does everything the pane does, so scripts and agents can publish and read stories on their own.

## Status

Version 0.1.0. The feed and the CLI need only Node.js (developed and tested on Node.js 26). The pane needs Herdr desktop.

The built-in open and reveal actions (`open_url`, `open_path`, `open_file`) and clicking a local path in a story work on macOS only: they call `/usr/bin/open`. On other systems those actions are shown disabled with that reason, and clicking a local path reports it. Everything else is plain Node.js, but it has only been run on macOS.

## Install

1. Copy `mods/trough` to `~/.config/herdr-app/mods/trough`. Keep its `bin/` and `core/` folders together.
2. Put the CLI on your `PATH`: `ln -s ~/.config/herdr-app/mods/trough/bin/trough ~/.local/bin/trough`.
3. Run `herdr-app check ~/.config/herdr-app/mods/trough`.
4. Show the pane. Either add `{"mod":"trough"}` as a block in a layout, or bind a key that opens it as an overlay. [`keys.json`](keys.json) suggests `cmd-shift-u`:

   ```json
   { "global": { "cmd-shift-u": "mod.open:trough" } }
   ```

   Merge that into `~/.config/herdr-app/keys.json`. `mod.json` uses `"place": "none"`, so installing the mod does not change an existing layout.

Stories live in `~/.local/state/trough` by default. Set `TROUGH_DIR=/absolute/path` (or pass `--dir`) for the CLI, and `{"mod":"trough","props":{"dir":"/absolute/path"}}` for a pane, to use another folder.

[`RECIPE.md`](RECIPE.md) describes the pane for anyone who wants to rebuild it rather than copy it.

## Publish stories

```sh
trough emit --source monitor --kind ci --title 'Build failed' \
  --summary 'Main branch verification failed.' --severity warning \
  --link Log=https://ci.example.com/runs/42
```

`trough post --file story.json` accepts the full [v1 format](docs/story-v1.schema.json), and `trough validate --file story.json` checks a story without storing it. Required fields are `v`, `id`, `source`, `kind`, `title`, `summary`, `occurred_at` and `severity`. Unknown top-level fields are invalid. `source` and `provenance` are claims shown to the operator, not authority. `extensions` are inert. `group_key` groups cards within the same source and kind; each story keeps its own state.

Choose the lowest severity that fits:

| Severity | Use it for |
| --- | --- |
| `info` | Routine news that needs nothing, such as landed work or a finished report. |
| `notice` | Something that wants attention without a problem: a decision, an approval, a review. |
| `warning` | Work is blocked, a check failed, or a target is at risk. |
| `critical` | Something is down or data is at risk. |

### Publishing without the CLI

A producer can write files directly. Generate a 32-hex random ID or a ULID, serialize one story as UTF-8 JSON, and write it to `inbox/.<id>.<nonce>.tmp`. Flush and close it, then publish it as `inbox/<id>.json` **without replacement** (for example, hard-link the final name and unlink the temporary file). Never edit a published file. The importer ignores dotfiles, validates the file and its name, and stores it only if the ID is new or the bytes match the stored record. A different story with a used ID goes to `rejected/` and cannot replace the stored one. `trough rejections` lists invalid and conflicting submissions. The validator also checks timestamps, paths, link types, duplicate JSON keys, UTF-8 and a 64 KiB size cap.

## Read and file

In the pane:

| Key | Does |
| --- | --- |
| `j` / `k`, arrows | Move |
| `g` / `G` | First / last |
| Enter | Open or close the detail |
| `/` | Search |
| `f` | Filter picker |
| `x` | Clear search and filters, back to Inbox |
| `r` | Read / unread |
| `d` | Done / undo |
| `D` | Delete, after a confirmation in the pane |
| `z` | Snooze for one hour |
| `a` | Review the story's first available action |

The pane opens in **Inbox**: stories that are unread or still need action, including read stories with unfinished actions. The filter picker also offers **Active unfinished** (neither done nor snoozed) and the state toggles `1` to `4` for unread, needs action, done and snoozed. State toggles combine with AND. Values picked within one field (source, kind, severity, subject) combine with OR, and fields, state and search combine with AND. Unread means no read time, needs action means the story has actions and is not done, and snoozed means its snooze time is in the future. The header shows the active view and filters. Times are relative in the list and exact in the detail. The pane reloads when the folder changes, including changes made by the CLI or another copy of the pane.

From the CLI:

```sh
trough ls --inbox                 # the pane's Inbox rule
trough ls --unread --source monitor --search build
trough ls --all --json            # every story, with state and action availability
trough show ID
trough read ID | unread ID | done ID | undo ID
trough snooze ID --until 2026-11-12T18:00:00Z
trough delete ID
```

`trough ls` shows Active unfinished by default. Done marks an unread story read; undo leaves the read state alone. Neither answers a decision nor changes anything at the source.

### Retention

The pane prunes read stories when it opens and hourly while open. `trough prune --dry-run` previews the IDs and `trough prune [--older-than 3d]` removes them on demand. The default age is 3 days, measured from the later of the read and done times; set `{"v":1,"retention":{"older_than":"7d"}}` in `$TROUGH_DIR/trough.json` to change it. Unread stories, open decisions, unfinished actions, active snoozes and anything with an effect still in flight stay. `trough delete ID` removes a story at once, including an open decision (it does not answer the decision), and refuses while an effect is still in flight. Both leave a small tombstone that blocks the same ID from reappearing for 365 days.

## Actions

A story may declare actions with an `id`, a `label`, a `handler` ID and typed `args`. It cannot declare a command or an executable. The handler must already be installed on your machine, as a built-in, an operator handler, or part of a pack.

Clicking an action opens a review sheet with the source claim and the exact effects. A separate **Confirm action** click runs it once and writes a receipt. From the CLI, `trough review STORY ACTION` prints the sheet and a token, and `trough run TOKEN` runs it. A failed or uncertain action stays visible in `receipts/` and is never retried automatically.

An action whose handler is not installed, or cannot run right now (a missing tool, another operating system, a decision with no answer route), is shown disabled with the reason beside it. `trough ls --json` reports the same thing per story as `action_status`.

`trough actions` lists every installed handler with its arguments and whether it can run, so a producer or an agent can see what it may attach to a story:

```
$ trough actions
add_to_reading_list  pack reading-list  available  link:string note?:string
answer_decision      built-in           available  -
open_file            built-in           available  link:string
open_path            built-in           available  link:string
open_url             built-in           available  link:string
```

Add `--json` for the full argument schema and declared effects. [docs/handlers.md](docs/handlers.md) covers the built-ins, operator command handlers and decision answers.

## Packs

A pack is a JavaScript module that adds action handlers, a producer that publishes stories on an interval, or both. Trough loads only the packs you list, and you manage that list with `trough packages`:

```sh
trough packages                          # what is listed, what each provides, and its health
trough packages check                    # the same, and a non-zero exit if a pack is broken
trough packages add PATH [--options-file options.json]
trough packages remove NAME|PATH
```

```
$ trough packages
reading-list  ok  /absolute/path/to/herdr-trough/packages/reading-list/index.js
  handlers: add_to_reading_list
  producer: none
```

`add` takes a pack folder or module file, loads it once to make sure it works with the options given, and only then records its absolute path. Running `add` again with `--options-file` replaces that pack's options. The list lives in `$TROUGH_DIR/handlers.json`; these commands rewrite only its `packages` field and leave your other settings alone. You can still edit the file by hand.

A pack is trusted local code that runs with your permissions. Add only packs you have read.

This repository ships two packs, both optional:

| Pack | Adds | Needs |
| --- | --- | --- |
| [`packages/reading-list`](packages/reading-list/index.js) | The `add_to_reading_list` action: hands a story link to a reading list. | An `rl` command on `PATH` that accepts `rl add TARGET --from NAME --if-new [--note TEXT]`. Without it the action is shown disabled. Set `{"rl":"/absolute/path/to/rl"}` as the pack's options to name the command explicitly. |
| [`packages/firstmate`](docs/firstmate.md) | Stories and actions for a Firstmate home. | A Firstmate home. Skip this pack if you do not use Firstmate; nothing else depends on it. |

Keep the checkout these packs are loaded from: the list stores their absolute paths. [docs/handlers.md](docs/handlers.md#packs) describes how to write a pack.

## Data folder

`$TROUGH_DIR` holds `inbox/`, the immutable `store/`, per-story `state/`, `rejected/`, `reviews/`, `receipts/`, `answers/<source-id>/`, `tombstones/`, and the operator files `handlers.json` and `trough.json`. Treat `handlers.json` and any pack it lists as code: whoever can write them can run commands as you.

## Develop

```sh
npm test
herdr-app check mods/trough
```

Both use local files only. The tests need no Herdr, no network and no installed pack.

## License

[MIT](LICENSE)
