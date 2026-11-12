# Firstmate pack (optional)

Trough does not need Firstmate. The core, the pane and the other packs run without it, and the core imports no Firstmate code. This pack is for people who run Firstmate, an agent orchestrator that keeps its state in a local home directory. It turns that home's holds, merges, finished reports and project changes into stories, and adds two reviewed actions that steer a task or answer a hold.

The pack imports the Trough core by relative path, so load it from a checkout of this repository rather than a copy of the `packages/firstmate` folder alone.

## Enable

Write the pack's options to a JSON file and add the pack:

```sh
trough packages add /absolute/path/to/herdr-trough/packages/firstmate --options-file firstmate-options.json
```

The only required option is `home`, the absolute path of the Firstmate home. The resulting `$TROUGH_DIR/handlers.json` entry looks like this:

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
      "task_categories": {"credential-task-id": "credential"},
      "story_kinds": {
        "project": {"enabled": false},
        "agent": {"min_severity": "warning"}
      }
    }
  }]
}
```

## Options

Configure exact decision words and `done` or `release` consequences before the first sync for a hold.
Holds without configured options are view-only decision cards because Firstmate's hold record does not encode answer choices.
`task_categories` can mark a held task as `credential` or `hands_on` for a separate attention card without copying any secret value into a story.
`story_kinds` accepts `decision`, `credential`, `hands_on`, `merge`, `agent`, `report`, `project`, and `prompt_ack`.
Each kind accepts `enabled` and `min_severity` (`info`, `notice`, `warning`, or `critical`); omitted settings use the defaults.
By default, all kinds are enabled except `prompt_ack`, and each enabled kind accepts `info` or higher.
Captain holds and owner actions appear at `notice`, automatic merges, landings, deploys, finished reports, and project changes at `info`, and failures or missed targets at `warning`.
Closing a captain hold marks its existing decision card done and read with `done_by: "firstmate-sync"` in operator state; it creates no completion story and never answers the hold.
Ongoing work and outcomes already represented by a merge or decision are not posted.

## Sync

Run `packages/firstmate/bin/trough-firstmate sync --dir "$TROUGH_DIR"` to publish changes outside the pane.
The first sync records a history baseline and publishes current captain holds. Later syncs publish newer branch outcomes, merges, and finished reports. To import older records explicitly, run `packages/firstmate/bin/trough-firstmate sync --dir "$TROUGH_DIR" --backfill YYYY-MM-DD` (an RFC 3339 timestamp also works). Backfill applies to that invocation only.
While the Trough pane is open, its configured Firstmate producer syncs on opening and every two minutes. Set `"sync_interval_seconds": N` in the pack's `options` for another positive integer interval. The pane shows the last run and last error in its header. The command also accepts `--home` for an explicit home and `--interval-seconds N` for a persistent producer outside the pane.
It reads the local backlog snapshot, branch outcomes, merge records, and project registry without changing Firstmate tracked files.
The optional Firstmate `config/fleet-ledger` flag adds merge and status history to the feed when enabled by the operator.
The first sync also establishes a project registry baseline; later additions and removals create project stories. Repeated outcomes for one task share a group.
Finished report cards link the report file. If the `add_to_reading_list` handler is installed when the card is created (see the reading-list pack in the [README](../README.md#packs)), the card also offers **Add to reading list**. Stories are immutable, so cards created before the pack was added do not gain the action.
Policy anomalies require a structured Firstmate record and are covered in [the draft proposals](firstmate-proposals.md).

## Actions

`deliver_prompt` actions name a local Firstmate task ID, its `spawn_gen`, and exact text.
Review rechecks the live task, and run checks it again before calling `fm-send.sh` with `FM_HOME` and the expected generation explicitly set.
The handler rejects leading `/` or `$`, parked tasks, replaced tasks, and remote second mates; a local second mate uses `--fire-and-forget` to avoid creating a reply expectation.
Delivery is asynchronous, and a later sync records when the exact inbox record reaches `handled/`; `prompt_ack` stories are muted by default.
`answer_firstmate_decision` calls `fm-captain-hold.sh answer` with a decision file containing the selected words and uses `--release` for configured release options.
