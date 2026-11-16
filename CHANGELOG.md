# Changelog

## 0.2.0 - 2026-11-15

- Card feed: the pane is one column of cards, each holding everything about its story, in place of the list and detail view. A card shows the severity, source and time, the title, the summary clamped to two lines and a thumbnail; its caret opens it in place to the whole summary, the body, the full picture and every link. Done, Snooze, Read and a ⋯ menu replace the time on hover or selection. Links are chips whose ▾ lists what can be done with them, decision options sit on the card, and the review and delete sheets open inside it. Stories in one group stack into a single card with "N earlier". Title, summary, prompt and link lines wrap at the card's width.
- Stories gain an optional markdown `body` (up to 16384 characters; raw HTML is shown as text and images are never loaded) and an optional `image`, naming one of the story's path links to a PNG, JPEG, GIF or WebP picture. The CLI copies a picture into the Herdr home only after checking its type, size and dimensions, and never fetches one from the network. `trough emit` gains `--body`, `--body-file` and `--image`.
- Each card, and the header, is built on its own, so a value the kit refuses shows that card's error in its place instead of taking down the pane.
- Story augmentation: a pack's `augment(story, context)` attaches actions and badges to stories when they are processed, without changing the stored story. Offers are recomputed and pinned at review and refused at run if they are gone, each pack fails alone, and the review sheet names the pack that offered an action.
- Links accept an optional `role` (such as `report`, `document`, `log`, `pr`) and `media_type` (a MIME type), so packs can choose fitting actions.
- Core pack, on by default: `open_url`, `open_path` and `open_file`, offered on every link by type. `trough packages remove core` turns it off.
- Open and reveal on macOS, Linux and Windows through per-platform handler scripts called with separate arguments, and an optional handler of your own in front of them: off until `trough handler on`, checked for ownership and permissions, and stopped until approved again after it changes.
- Always allow: a review sheet for a local, low-risk action that a pack offers has an **Always allow** checkbox. Confirming with it ticked records a standing approval for that pack's handler in `allow.json`, and later clicks run at once and still write a receipt. The approval is tied to what the handler runs and asks again once when that changes. The pane's **Always allowed** panel and `trough allow` list and revoke approvals; `trough act` and `trough run --always-allow` are the CLI side. Decision answers, prompt deliveries and actions a story declares can never be always allowed.
- Reading-list pack: offers **Add to reading list** on report and document links instead of waiting for a story to declare it.
- `trough actions` also lists each pack's augment rules.
- The Linux and Windows handlers were run on real systems; the README's Status section records what was covered. Fixes from that:
  - Linux: when `xdg-open` finds no program for a file, the action fails with "xdg-open found no program to open it with" instead of the first "not found" line `xdg-open` prints.
  - Windows: the handler and the check of your own handler write UTF-8, so a path with letters outside the console's code page (an accented user folder, for example) is no longer garbled, which had stopped a handler under such a folder from running. Open and reveal refuse a path that does not exist, and a failed start reports Windows's own message.
- The story schema's `$id` is now its address in this repository, `https://raw.githubusercontent.com/pbleisch/herdr-trough/main/docs/story-v1.schema.json`.
- The tests pass on Linux with or without `xdg-open` installed and on Windows, and never start an app.

### Upgrading from 0.1.0

- The pane's list and detail view are replaced by the card feed. Enter opens and closes a card, `.` opens its ⋯ menu and `o` opens its first link.
- The Firstmate pack no longer declares the reading-list action on report cards; the reading-list pack offers it on any link with role `report`. Report cards stored earlier have no role on their link and keep their declared action.
- Open and reveal moved into the core pack. Stories that declare `open_url`, `open_path` or `open_file` keep working.
- `trough ls --json` rows gain `offers` and `badges`; `trough actions --json` is now `{handlers, augmenters}`.

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
