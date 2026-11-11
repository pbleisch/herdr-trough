# Trough

Trough is a local activity feed for Herdr desktop. Tools publish immutable JSON stories; the operator reads, files, snoozes, and reviews actions in a pane. The core CLI works without Herdr or Firstmate. No service or third-party package is required. Node.js and, for the pane, Herdr desktop are required. The local action implementations currently target macOS.

## Install on macOS

Copy `mods/trough` into `~/.config/herdr-app/mods/trough`, then symlink its `bin/trough` into a directory on `PATH` (for example `~/.local/bin/trough`). Keep the `core/` directory beside the CLI in the copied mod. Add `{"mod":"trough"}` as a block in a Herdr layout, or open it as a mod pane. `mod.json` uses `place: none`, so installation does not alter an existing layout. Run `herdr-app check ~/.config/herdr-app/mods/trough` after copying. This repository does not install or start Herdr.

For isolated use, set `TROUGH_DIR=/absolute/path` for the CLI. A layout block can set `{"mod":"trough","props":{"dir":"/absolute/path"}}` for the pane. The default is `~/.local/state/trough`.

## Publish

`trough emit --source monitor --kind ci --title 'Build failed' --summary 'Main branch verification failed.' --severity warning` makes a simple story. `trough post --file story.json` accepts the full v1 format; `trough validate --file story.json` checks without writing. `trough ingest` imports pending direct files. `trough ls --json`, `trough show ID`, `trough read|unread|done|undo ID`, and `trough snooze ID --until 2026-11-12T18:00:00Z` work without the pane. `trough rejections` reports invalid and conflicting submissions.

For a direct producer, generate a 32-hex random ID or ULID, serialize one story as UTF-8 JSON, and write `inbox/.<id>.<nonce>.tmp` in the same directory. Flush and close, then publish as `inbox/<id>.json` **without replacement** (for example, create a hard link to the final name and unlink the temporary file). Do not edit a published file. The importer ignores dotfiles, validates the file and filename, and stores it only if its ID is new or its bytes match an existing record. A same-ID conflict goes to `rejected/` and cannot replace a stored story. The CLI uses this same inbox path.

Stories follow [the v1 schema](docs/story-v1.schema.json). Required fields are `v`, `id`, `source`, `kind`, `title`, `summary`, `occurred_at`, and `severity`. Unknown top-level fields are invalid. `source` and provenance are claims displayed to the operator, not authority. `extensions` are inert. The validator also checks unique IDs, timestamps, paths, link types, duplicate JSON keys, UTF-8, and the 64 KiB file cap. The store adds `received_at` from the stored file's creation time for ordering. `group_key` groups cards only within the same source and kind; each event keeps its own state.

Choose the lowest severity that fits: `info` is routine FYI needing nothing, such as landed work or a finished report; `notice` asks for attention without a problem, such as a decision, approval, credential, or review; `warning` means work is blocked, a check failed, or a target is at risk; `critical` means something is down or data is at risk. The [schema](docs/story-v1.schema.json) defines the full severity contract. Stored stories are immutable, so a producer mapping change applies to new stories only.

The data directory contains `inbox/`, immutable `store/`, per-story `state/`, `rejected/`, `reviews/`, `receipts/`, and `answers/<source-id>/`. `read` and `done` are operator filing state. Neither answers a decision nor changes the source's status.

## Actions

Stories may declare `actions` with an `id`, `label`, installed `handler` ID, and typed `args`. They cannot declare a command or executable. Built-ins are `open_url`, `open_path` (Finder reveal only), `add_to_reading_list` (requires `rl` on `PATH`), and `answer_decision`. The last one requires an operator-installed route bound to the exact story hash. See [handler configuration](docs/handlers.md).

Clicking an action opens a review sheet that shows the source claim and exact effects. A separate **Confirm action** click executes it and writes a receipt. CLI callers use `trough review STORY ACTION`, inspect its output, then `trough run REVIEW_TOKEN`. The run checks the story and handler again; a token can run only once. A failed or uncertain action remains visible in `receipts/` and is not retried automatically. Actions never answer a native agent or terminal question. The optional Firstmate package below sends asynchronous steering to a task inbox and answers Firstmate captain holds through Firstmate's own decision command.

The pane supports `j`/`k` and arrows, `g`/`G`, `/` search, `f` filter picker, `r` read, `d` done, `z` one-hour snooze, Enter detail, and `a` action review. In the picker, `1`–`4` toggle unread, needs action, done, and snoozed; click values to toggle source, kind, severity, and subject. The header shows the active filters. Press `x` to clear every filter, including search. State filters combine with AND; selected values within one field combine with OR; fields and search combine with AND. With no state filter, the feed shows active unfinished stories. Unread means no read timestamp, needs action means a story has actions and is not done, and snoozed means its snooze time is in the future. `trough ls` uses the same rules: for example, `trough ls --unread --needs-action --source agent --source monitor --search build`. Use `--all` to include every state when no state flags are selected. Stored stories and state reload on folder changes and a periodic fallback, including changes from another pane copy.

The pane shows relative times and refreshes their labels while open. Story detail shows the exact local time.

## Develop

Run `npm test` and `herdr-app check mods/trough`. Both use local files. No remote operation or Herdr lifecycle action is part of the test suite.

## Optional Firstmate integration

The core and pane run without Firstmate.
To enable the package, add it to the operator's `$TROUGH_DIR/handlers.json` with the absolute path to this repository's `packages/firstmate/index.js` and an absolute Firstmate home path:

```json
{
  "v": 1,
  "packages": [{
    "path": "/absolute/path/to/herdr-trough/packages/firstmate/index.js",
    "options": {
      "home": "/absolute/path/to/firstmate",
      "decisions": {
        "held-task-id": {
          "options": [
            {"id": "proceed", "label": "Proceed", "answer_text": "Proceed with the work", "mode": "release"},
            {"id": "stop", "label": "Stop", "answer_text": "Stop this work", "mode": "done"}
          ]
        }
      },
      "task_categories": {"credential-task-id": "credential"}
    }
  }]
}
```

Configure exact decision words and `done` or `release` consequences before the first sync for a hold.
Holds without configured options are view-only decision cards because Firstmate's hold record does not encode answer choices.
`task_categories` can mark a held task as `credential` or `hands_on` for a separate attention card without copying any secret value into a story.

Run `packages/firstmate/bin/trough-firstmate sync --dir "$TROUGH_DIR"` to publish changes.
The first sync records a history baseline and publishes current captain holds. Later syncs publish newer branch outcomes, merges, and finished reports. To import older records explicitly, run `packages/firstmate/bin/trough-firstmate sync --dir "$TROUGH_DIR" --backfill YYYY-MM-DD` (an RFC 3339 timestamp also works). Backfill applies to that invocation only.
While the Trough pane is open, its configured Firstmate producer syncs on opening and every two minutes. Set `"sync_interval_seconds": N` in the package's `options` for another positive integer interval. The pane shows the last run and last error in its header. The command also accepts `--home` for an explicit home and `--interval-seconds N` for a persistent producer outside the pane.
It reads the local backlog snapshot, branch outcomes, merge records, and project registry without changing Firstmate tracked files.
The optional Firstmate `config/fleet-ledger` flag adds merge and status history to the feed when enabled by the operator.
The first sync also establishes a project registry baseline; later additions and removals create project stories. Branch outcomes already represented by a merge or captain decision are omitted, and repeated outcomes for one task share a group.
Finished report cards link the report file and offer the built-in reading-list action.
Policy anomalies require a structured Firstmate record and are covered in [the draft proposals](docs/firstmate-proposals.md).

`deliver_prompt` actions name a local Firstmate task ID, its `spawn_gen`, and exact text.
Review rechecks the live task, and run checks it again before calling `fm-send.sh` with `FM_HOME` and the expected generation explicitly set.
The handler rejects leading `/` or `$`, parked tasks, replaced tasks, and remote second mates; a local second mate uses `--fire-and-forget` to avoid creating a reply expectation.
Delivery is asynchronous, and a later sync reports when the exact inbox record reaches `handled/`.
`answer_firstmate_decision` calls `fm-captain-hold.sh answer` with a decision file containing the selected words and uses `--release` for configured release options.
