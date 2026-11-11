# Trough

Trough is a local activity feed for Herdr desktop. Tools publish immutable JSON stories; the operator reads, files, snoozes, and reviews actions in a pane. The core CLI works without Herdr or Firstmate. No service or third-party package is required. Node.js and, for the pane, Herdr desktop are required. The local action implementations currently target macOS.

## Install on macOS

Copy `mods/trough` into `~/.config/herdr-app/mods/trough`, then symlink its `bin/trough` into a directory on `PATH` (for example `~/.local/bin/trough`). Keep the `core/` directory beside the CLI in the copied mod. Add `{"mod":"trough"}` as a block in a Herdr layout, or open it as a mod pane. `mod.json` uses `place: none`, so installation does not alter an existing layout. Run `herdr-app check ~/.config/herdr-app/mods/trough` after copying. This repository does not install or start Herdr.

For isolated use, set `TROUGH_DIR=/absolute/path` for the CLI. A layout block can set `{"mod":"trough","props":{"dir":"/absolute/path"}}` for the pane. The default is `~/.local/state/trough`.

## Publish

`trough emit --source monitor --kind ci --title 'Build failed' --summary 'Main branch verification failed.' --severity warning` makes a simple story. `trough post --file story.json` accepts the full v1 format; `trough validate --file story.json` checks without writing. `trough ingest` imports pending direct files. `trough ls --json`, `trough show ID`, `trough read|unread|done|undo ID`, and `trough snooze ID --until 2026-11-12T18:00:00Z` work without the pane. `trough rejections` reports invalid and conflicting submissions.

For a direct producer, generate a 32-hex random ID or ULID, serialize one story as UTF-8 JSON, and write `inbox/.<id>.<nonce>.tmp` in the same directory. Flush and close, then publish as `inbox/<id>.json` **without replacement** (for example, create a hard link to the final name and unlink the temporary file). Do not edit a published file. The importer ignores dotfiles, validates the file and filename, and stores it only if its ID is new or its bytes match an existing record. A same-ID conflict goes to `rejected/` and cannot replace a stored story. The CLI uses this same inbox path.

Stories follow [the v1 schema](docs/story-v1.schema.json). Required fields are `v`, `id`, `source`, `kind`, `title`, `summary`, `occurred_at`, and `severity`. Unknown top-level fields are invalid. `source` and provenance are claims displayed to the operator, not authority. `extensions` are inert. The validator also checks unique IDs, timestamps, paths, link types, duplicate JSON keys, UTF-8, and the 64 KiB file cap. The store adds `received_at` from the stored file's creation time for ordering. `group_key` groups cards only within the same source and kind; each event keeps its own state.

The data directory contains `inbox/`, immutable `store/`, per-story `state/`, `rejected/`, `reviews/`, `receipts/`, and `answers/<source-id>/`. `read` and `done` are operator filing state. Neither answers a decision nor changes the source's status.

## Actions

Stories may declare `actions` with an `id`, `label`, installed `handler` ID, and typed `args`. They cannot declare a command or executable. Built-ins are `open_url`, `open_path` (Finder reveal only), `add_to_reading_list` (requires `rl` on `PATH`), and `answer_decision`. The last one requires an operator-installed route bound to the exact story hash. See [handler configuration](docs/handlers.md).

Clicking an action opens a review sheet that shows the source claim and exact effects. A separate **Confirm action** click executes it and writes a receipt. CLI callers use `trough review STORY ACTION`, inspect its output, then `trough run REVIEW_TOKEN`. The run checks the story and handler again; a token can run only once. A failed or uncertain action remains visible in `receipts/` and is not retried automatically. Actions never answer a native agent or terminal question. Prompt delivery and the optional Firstmate integration are future packages, not part of this core.

The pane supports `j`/`k` and arrows, `g`/`G`, `/` search, `f` view filters, `r` read, `d` done, `z` one-hour snooze, Enter detail, and `a` action review. Source, kind, severity, and subject filters are also available in the header. Stored stories and state reload on folder changes and a periodic fallback, including changes from another pane copy.

## Develop

Run `npm test` and `herdr-app check mods/trough`. Both use local files. No remote operation or Herdr lifecycle action is part of the test suite.
