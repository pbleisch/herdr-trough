# Handlers and packs

`$TROUGH_DIR/handlers.json` is the operator's configuration file. Story JSON can name a handler but cannot install one. Trough loads this file for action review and execution and for pane producers. An absent file leaves the built-in handlers available. Operator handlers in `handlers` win over pack handlers with the same ID, pack handlers win over built-ins, and a later pack wins over an earlier one. Treat this file and any pack module as trusted local code. Protect them from untrusted writers.

`trough actions [--json]` lists the handlers that are installed right now: ID, origin (`built-in`, `config` or `pack`), argument schema, declared effects, and whether the handler can run. A handler that cannot run carries a `reason`, and the pane shows any action that uses it disabled with that reason. A command handler is unavailable when its executable is missing; a built-in open action is unavailable outside macOS; `answer_decision` is unavailable for a story with no matching answer route; an action naming a handler that is not installed is unavailable.

```json
{
  "v": 1,
  "handlers": {
    "record_note": {
      "kind": "command",
      "executable": "/usr/local/bin/record-note",
      "argv": [{"literal": "--text"}, {"arg": "note"}],
      "args": {"note": {"type": "string", "required": true, "max_length": 500}},
      "effects": ["Append a note to the local operator journal"]
    }
  },
  "answer_routes": {},
  "packages": []
}
```

Command handlers use an absolute executable path and an array of **literal** or **arg** slots. Each argument has a `string`, `number`, or `boolean` type; string arguments can set `max_length`, and any type can set `enum`. A required argument must be present. Story arguments cannot name a binary, shell, working directory, environment variable, or additional argv slots. The review sheet shows declared effects and the exact executable and argv. Execution uses separate argv with no shell interpolation.

Built-in arguments:

| Handler | Action args | Effect |
| --- | --- | --- |
| `open_url` | `{"link":"link-id"}` | Opens the declared HTTP(S) link in the default browser. |
| `open_path` | `{"link":"link-id"}` | Reveals the declared absolute path in Finder using `open -R`. |
| `open_file` | `{"link":"link-id"}` | Opens the declared file or folder with `open`; anything that could run (an executable, a script, an app bundle) is revealed in Finder instead. |
| `answer_decision` | `{}` | Writes an immutable answer to `answers/<source-id>/`. Requires an exact route binding. |

For a decision story, put `"answer_routes":{"<story-id>":{"source_id":"<source-id>","story_hash":"<sha256-from-trough-show>"}}` in `handlers.json`. This binding is outside the story and pins the exact bytes. A decision without it is view-only. The operator selects an option in the pane; CLI review uses `--option OPTION_ID` and optionally `--comment TEXT` if the story allows comments. Answers remain pending until the source consumes them. The source may move a captured answer into its `handled/` subdirectory; this does not imply the requested outcome was applied. A second answer for the same question is refused by Trough.

The three open actions are macOS only. `add_to_reading_list` is not built in; it comes from the reading-list pack (`packages/reading-list`) and takes `{"link":"link-id","note":"optional"}`.

## Packs

A pack is a JavaScript module listed by absolute path in `packages`.
An entry can be a path string, or `{"path":"/absolute/pack/index.js","options":{...}}` when the pack needs trusted operator configuration.
Manage the list with `trough packages` (list), `trough packages check`, `trough packages add PATH [--options-file FILE]` and `trough packages remove NAME|PATH`. `add` resolves the path, loads the pack with the given options, and refuses to record a pack that does not load. The commands replace `handlers.json` atomically and change only `packages`. `list` and `check` show each pack's handlers, its producer with the last run and error, and any problem: a module that does not load, an invalid handler or producer, a pack listed twice. They also mark a handler that another pack or an operator handler overrides. `check` exits non-zero if any pack has a problem. A handler that is merely unavailable, such as a missing tool, is reported but is not a problem. A pack that fails to load contributes nothing and does not stop the feed or the other packs.

A pack is named by its `name` export (a lowercase key such as `reading-list`), or else by its folder name for an `index.js`, or its file name.
It can export `handlers(options)` returning an object keyed by handler ID, `producer(options)` returning `{name, interval_seconds, run({root})}`, or both. The pane invokes each listed producer when opened and on its interval while open. `interval_seconds` is a positive integer. The core CLI exposes `producers` and `produce ID`; `produce` serializes runs with a lock under the Trough data directory, skips runs already completed within the interval, and records the last run and error there. A failed producer does not stop other producers or the feed.
Each handler descriptor has `args` (the same typed schema), `effects` (declared effect classes), `plan({story,action,args,root,choice})`, and `run({root,reviewed,choice,token})`.
It may also have `unavailable()`, which returns a short reason while the handler cannot run (for example, a tool it needs is not installed) and nothing otherwise. Keep it cheap: it runs whenever stories are listed.
`plan` must return a serializable object with an `effects` string array spelling out the exact targets and changes.
Trough stores that plan with the review token and compares it with a fresh plan before calling `run`.
Packs are loaded only if listed in operator configuration.
The core imports no pack code. [packages/reading-list/index.js](../packages/reading-list/index.js) is a small complete pack to copy from.

Decision stories may be view-only, with an empty `decision.options` array and no answer action.
A pack answer action uses `"choice":true` so the pane asks the operator to select one of the story's options before review.

Every successful review creates `reviews/<token>.json` with the story hash, chosen args, and exact plan. The token expires after five minutes. `run` claims `receipts/<token>.json` before the effect, and replaces it with the outcome afterward. An existing receipt prevents another execution. A `pending` receipt after a crash represents an uncertain effect and needs operator review outside Trough; Trough never retries it automatically.
