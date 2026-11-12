# Changelog

## 0.1.0 - 2026-11-12

First version.

- Story protocol v1: immutable JSON stories published through an inbox folder or the `trough` CLI, with validation, rejections, grouping and four severities.
- Herdr pane: Inbox and Active unfinished views, filters, search, read, done, snooze, delete, and clickable links and local paths.
- Reviewed actions: every action shows its exact effects before a separate confirmation, runs once, and leaves a receipt.
- Built-in actions `open_url`, `open_path`, `open_file` (macOS only) and `answer_decision`.
- Packs: optional modules listed in `handlers.json` that add action handlers and producers. `trough packages` lists, checks, adds and removes them; `trough actions` lists the installed action handlers.
- Reading-list pack (`packages/reading-list`): the `add_to_reading_list` action, which calls the `rl` command.
- Firstmate pack (`packages/firstmate`): optional producer and actions for a Firstmate home.
- An action whose handler is not installed or cannot run is shown disabled with the reason.
- Retention: read stories are pruned after 3 days by default, with tombstones that block a pruned or deleted ID from returning.

### Upgrading from an unreleased build

`add_to_reading_list` was a built-in action before this version. It now comes from the reading-list pack. Run `trough packages add /absolute/path/to/herdr-trough/packages/reading-list` to keep it. Until the pack is added, existing stories show the action disabled with "handler add_to_reading_list is not installed", and the Firstmate pack leaves the action off new report cards.
