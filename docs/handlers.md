# Operator handlers

`$TROUGH_DIR/handlers.json` is the operator's configuration file. Story JSON can name a handler but cannot install one. Trough loads this file only for action review and execution. An absent file leaves the built-in handlers available. Handler IDs in `handlers` override built-ins; configured packages can add handlers or override built-ins. Treat this file and any package modules as trusted local code. Protect them from untrusted writers.

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
| `add_to_reading_list` | `{"link":"link-id","note":"optional"}` | Calls `rl add` with separate argv and `--if-new`; unavailable if `rl` is absent. |
| `answer_decision` | `{}` | Writes an immutable answer to `answers/<source-id>/`. Requires an exact route binding. |

For a decision story, put `"answer_routes":{"<story-id>":{"source_id":"<source-id>","story_hash":"<sha256-from-trough-show>"}}` in `handlers.json`. This binding is outside the story and pins the exact bytes. A decision without it is view-only. The operator selects an option in the pane; CLI review uses `--option OPTION_ID` and optionally `--comment TEXT` if the story allows comments. Answers remain pending until the source consumes them. The source may move a captured answer into its `handled/` subdirectory; this does not imply the requested outcome was applied. A second answer for the same question is refused by Trough.

An optional integration package is an absolute path in `packages`. It exports `handlers()` returning an object keyed by handler ID. Each descriptor has `args` (the same typed schema), `effects` (declared effect classes), `plan({story,action,args,root,choice})`, and `run({root,reviewed,choice})`. `plan` must return a serializable object with an `effects` string array spelling out the exact targets and changes. Trough stores that plan with the review token and compares it with a fresh plan before calling `run`. Packages are loaded only if listed in operator configuration. A future Firstmate package can supply `deliver_prompt` and its own bound decision route through this interface; the standalone core imports no Firstmate code.

Every successful review creates `reviews/<token>.json` with the story hash, chosen args, and exact plan. The token expires after five minutes. `run` claims `receipts/<token>.json` before the effect, and replaces it with the outcome afterward. An existing receipt prevents another execution. A `pending` receipt after a crash represents an uncertain effect and needs operator review outside Trough; Trough never retries it automatically.
