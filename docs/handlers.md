# Handlers and packs

`$TROUGH_DIR/handlers.json` is the operator's configuration file. Story JSON can name a handler but cannot install one. Trough loads this file for action review and execution and for pane producers. An absent file leaves the built-in handlers available. Operator handlers in `handlers` win over pack handlers with the same ID, pack handlers win over built-ins, and a later pack wins over an earlier one. Treat this file and any pack module as trusted local code. Protect them from untrusted writers.

`trough actions [--json]` lists the handlers that are installed right now: ID, origin (`built-in`, `config` or `pack`), argument schema, declared effects, and whether the handler can run. It then lists each pack's rules for attaching actions to stories. A handler that cannot run carries a `reason`, and the pane shows any action that uses it disabled with that reason. A command handler is unavailable when its executable is missing; the open actions are unavailable when the platform's opener is missing (`xdg-open` on Linux, `pwsh` on Windows); `answer_decision` is unavailable for a story with no matching answer route; an action naming a handler that is not installed is unavailable.

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

Handlers that ship with Trough:

| Handler | From | Action args | Effect |
| --- | --- | --- | --- |
| `open_url` | core pack | `{"link":"link-id"}` | Opens the declared HTTP(S) link in the default browser. |
| `open_path` | core pack | `{"link":"link-id"}` | Shows the declared absolute path in the file manager. |
| `open_file` | core pack | `{"link":"link-id"}` | Opens the declared file or folder; anything that could run (an executable, a script, an app bundle) is shown in the file manager instead. |
| `answer_decision` | built in | `{}` | Writes an immutable answer to `answers/<source-id>/`. Requires an exact route binding. |
| `add_to_reading_list` | reading-list pack | `{"link":"link-id","note":"optional"}` | Calls `rl add` with separate argv and `--if-new`. |

A story does not have to declare the open actions or the reading-list action: the packs offer them on its links (see [Augmenting stories](#augmenting-stories)). Declaring them still works. The three open actions run the handler chain described in the README under "Your own handler": the person's own handler if they turned it on, then `mods/trough/handlers/macos.sh`, `linux.sh` or `windows.ps1`, each called as `VERB -- ITEM` with separate arguments.

For a decision story, put `"answer_routes":{"<story-id>":{"source_id":"<source-id>","story_hash":"<sha256-from-trough-show>"}}` in `handlers.json`. This binding is outside the story and pins the exact bytes. A decision without it is view-only. The operator selects an option in the pane; CLI review uses `--option OPTION_ID` and optionally `--comment TEXT` if the story allows comments. Answers remain pending until the source consumes them. The source may move a captured answer into its `handled/` subdirectory; this does not imply the requested outcome was applied. A second answer for the same question is refused by Trough.


## Packs

A pack is a JavaScript module listed by absolute path in `packages`.
An entry can be a path string, or `{"path":"/absolute/pack/index.js","options":{...}}` when the pack needs trusted operator configuration.
The core pack is built in and loads first; `"core": false` in `handlers.json` turns it off.

Manage the list with `trough packages` (list), `trough packages check`, `trough packages add PATH [--options-file FILE]` and `trough packages remove NAME|PATH` (`core` as the name turns the core pack off or back on). `add` resolves the path, loads the pack with the given options, and refuses to record a pack that does not load. The commands replace `handlers.json` atomically and change only `packages` and `core`. `list` and `check` show each pack's handlers, its augment rules, its producer with the last run and error, and any problem: a module that does not load, an invalid handler or producer, an augmenter that fails on a stored story, a pack listed twice, or a person's open handler that changed and awaits approval. They also mark a handler that another pack or an operator handler overrides. `check` exits non-zero if any pack has a problem. A handler that is merely unavailable, such as a missing tool, is reported but is not a problem. A pack that fails to load contributes nothing and does not stop the feed or the other packs.

A pack may export:

| Export | Purpose |
| --- | --- |
| `name` | The pack's name, a lowercase key such as `reading-list`. Without it the name is the folder name (for an `index.js`) or the file name. Required for a pack that augments stories. |
| `handlers(options)` | Returns an object of action handlers keyed by handler ID. |
| `augment(story, context)` | Attaches actions and badges to a story. |
| `rules` | An array of short sentences describing what `augment` attaches, shown by `trough actions` and `trough packages`. |
| `facts(options)` | Returns an object of local facts for `augment`, such as whether a tool is installed. May be async. |
| `producer(options)` | Returns `{name, interval_seconds, run({root})}`. |

### Handlers

Each handler descriptor has `args` (the typed schema above), `effects` (declared effect classes), `plan({story,action,args,root,choice})`, and `run({root,reviewed,choice,token})`.
It may also have `unavailable()`, which returns a short reason while the handler cannot run (for example, a tool it needs is not installed) and nothing otherwise. Keep it cheap: it runs whenever stories are listed.
Set `always_allow: true` only on a handler whose effect is local and low-risk; see [Standing approvals](#standing-approvals).
`plan` must return a serializable object with an `effects` string array spelling out the exact targets and changes.
Trough stores that plan with the review token and compares it with a fresh plan before calling `run`.

### Augmenting stories

`augment(story, context)` runs whenever a story is processed: when the pane or `trough ls --json` lists it, when one of its actions is reviewed, and again when that action runs. It returns additions only:

```js
return {
  actions: [{id: 'save.log', label: 'Save to notes', handler: 'save_to_notes', args: {link: 'log'}, link: 'log'}],
  badges: ['has log']
};
```

- `context` is `{options, facts, platform}`: the pack's options, the result of its `facts(options)` (or `{}`), and `process.platform`.
- An offered action has an `id` (lowercase letters, digits, `.`, `_`, `-`; unique within the pack for that story), a `label`, a `handler` and `args`. Set `link` to a link ID to show the action beside that link in the pane. The action's ID for `trough review` is `<pack>.<id>`, for example `notes.save.log`.
- The handler must be one of the same pack's own handlers, and `args` must satisfy its schema. A pack cannot offer another pack's handler, and an offer always runs the offering pack's handler even if another pack defines the same ID.
- `badges` are up to 4 strings of 1 to 24 characters, shown on the story's card.
- At most 48 actions per story per pack.

The guard rails:

- **Additions only.** `augment` receives a copy of the story. It cannot edit or remove anything, and any other key in its result is an error. The stored story bytes never change.
- **Synchronous and pure.** `augment` must return its result directly (a promise is an error) and should depend only on the story and `context`. Read the clock, the disk or the network in `facts()` or in a handler's `plan`, not here. The same story and facts must give the same offers, because the offer is worked out again at review and at run.
- **Pinned at review.** The review record stores the offer (pack, ID, label, handler, args) next to the story hash and the plan. At run time the offer is recomputed; if it is missing or differs, the run is refused. The review sheet names the pack that offered the action.
- **Isolated.** Packs augment in the order they are listed, core first. If one pack's `augment` throws or returns something invalid for a story, only that pack's additions for that story are dropped. The failure appears in the pane header and in `trough packages check`.
- **Not "needs action".** Only actions a story declares count toward the Inbox's "needs action". An offer does not keep a story in the Inbox.

Give `augment` good criteria by reading the link's type: `link.url` or `link.path`, its optional `role` (`report`, `document`, `artifact`, `log`, `screenshot`, `pr`, `issue`, `source`, or another key) and its optional `media_type` (a MIME type). Producers should set these on their links instead of declaring generic actions.

[docs/example-pack/index.js](example-pack/index.js) is a complete pack with a handler, facts, rules and an augmenter; `packages/reading-list/index.js` and `mods/trough/core/core-pack.js` are the shipped ones.

### Standing approvals

The operator can tick **Always allow** on a review sheet (or pass `trough run TOKEN --always-allow`). That records a standing approval in `$TROUGH_DIR/allow.json`, and later clicks on the same kind of action run without a sheet. `trough act STORY ACTION` is the click: it runs the action and prints `{"receipt": ...}` when a standing approval holds, and otherwise prints `{"review": ...}`, the same sheet as `trough review`. `trough allow` lists the approvals and `trough allow revoke PACK/HANDLER|all` removes them.

- **Scope.** An approval is keyed `<pack>/<handler>`: one handler, as offered by one pack through `augment`, for every story. It never covers an action a story declares, even one that names the same handler, nor the same handler ID from another pack.
- **Eligibility.** The handler must set `always_allow: true`. That only makes the checkbox available; it grants nothing. Set it for effects that stay on this computer and are harmless to repeat, such as opening or revealing a link. Do not set it on a handler that answers a decision, sends a prompt or message to an agent, or sends data elsewhere. `answer_decision` and the Firstmate pack's handlers do not set it, and `run --always-allow` is refused for them.
- **Granting.** Only a confirmed review writes an approval. Stories are data and have no field for it; `augment` results and handler descriptors have none either.
- **Fingerprint.** The approval stores a SHA-256 over the pack's name, path, module file contents and options, the handler's ID, argument schema and declared effects, and the value of the handler's optional `fingerprint()`. Return from `fingerprint()` whatever else decides what will run: the core pack returns the state, path and hash of the person's own open handler and the hash of the built-in script; the reading-list pack returns the `rl` path it found. When the fingerprint differs, the approval is listed as "asks again", the next click returns the sheet with `always_allow.state` set to `changed`, and one confirmation with `--always-allow` restores it.
- **Receipts.** A run on a standing approval still creates a review record and a receipt. The receipt carries `"approval": "always-allow"` and `"allow_key"`.

A review sheet for an eligible action carries `always_allow: {key, state, effects}`, where `state` is `new`, `active` or `changed`. Other sheets have no such field.

### Producers

The pane invokes each listed producer when opened and on its interval while open. `interval_seconds` is a positive integer. The core CLI exposes `producers` and `produce ID`; `produce` serializes runs with a lock under the Trough data directory, skips runs already completed within the interval, and records the last run and error there. A failed producer does not stop other producers or the feed.

Packs are loaded only if listed in operator configuration.
The core imports no pack code other than its own core pack.

Decision stories may be view-only, with an empty `decision.options` array and no answer action.
A pack answer action uses `"choice":true` so the pane asks the operator to select one of the story's options before review.

Every successful review creates `reviews/<token>.json` with the story hash, where the action came from (the story, or a pack's offer), chosen args, and exact plan. The token expires after five minutes. `run` claims `receipts/<token>.json` before the effect, and replaces it with the outcome afterward. An existing receipt prevents another execution. A `pending` receipt after a crash represents an uncertain effect and needs operator review outside Trough; Trough never retries it automatically.
