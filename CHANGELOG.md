# Changelog

## 0.1.0 - 2026-11-12

First version.

- Story protocol v1: immutable JSON stories published through an inbox folder or the `trough` CLI, with validation, rejections, grouping and four severities.
- Herdr pane: Inbox and Active unfinished views, filters, search, read, done, snooze, delete, and clickable links and local paths.
- Reviewed actions: every action shows its exact effects before a separate confirmation, runs once, and leaves a receipt.
- Story augmentation: a pack's `augment(story, context)` attaches actions and badges to stories when they are processed, without changing the stored story. Offers are recomputed and pinned at review and refused at run if they are gone, each pack fails alone, and the review sheet names the pack that offered an action.
- Links accept an optional `role` (such as `report`, `document`, `log`, `pr`) and `media_type` (a MIME type), so packs can choose fitting actions.
- Core pack, on by default: `open_url`, `open_path` and `open_file`, offered on every link by type. `trough packages remove core` turns it off.
- Open and reveal on macOS, Linux and Windows through per-platform handler scripts called with separate arguments, and an optional handler of your own in front of them: off until `trough handler on`, checked for ownership and permissions, and stopped until approved again after it changes. Linux and Windows have not been run yet.
- `answer_decision` built in for decision stories with an operator-bound route.
- Packs: optional modules listed in `handlers.json` that add action handlers, augmenters and producers. `trough packages` lists, checks, adds and removes them; `trough actions` lists the installed handlers and each pack's augment rules.
- Reading-list pack (`packages/reading-list`): offers **Add to reading list** on report and document links, using the `rl` command.
- Firstmate pack (`packages/firstmate`): optional producer and actions for a Firstmate home.
- An action that cannot run (handler not installed, tool missing) is shown disabled with the reason.
- Retention: read stories are pruned after 3 days by default, with tombstones that block a pruned or deleted ID from returning.

### Upgrading from an unreleased build

- `add_to_reading_list` was a built-in action. It now comes from the reading-list pack: run `trough packages add /absolute/path/to/herdr-trough/packages/reading-list` to keep it. Until then, stories that declare the action show it disabled with "handler add_to_reading_list is not installed".
- The Firstmate pack no longer declares the reading-list action on report cards; the reading-list pack offers it on any link with role `report`. Report cards stored earlier have no role on their link and keep their declared action.
- Open and reveal moved into the core pack. Stories that declare `open_url`, `open_path` or `open_file` keep working.
- `trough ls --json` rows gain `offers` and `badges`; `trough actions --json` is now `{handlers, augmenters}`.
