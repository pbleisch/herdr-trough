# Firstmate integration proposals (draft)

These changes are proposals for Firstmate itself and are not part of the Trough package.

## Explicit asynchronous steering

Add a task-selector-only operation that accepts a message file, an expected `spawn_gen`, and a stable delivery ID.
It should always queue to the durable steering inbox, reject a native blocked question, create no reply expectation, and return the inbox record name and generation as JSON.
The final target lock should enforce the generation check, and retrying the same delivery ID should find the same record.
This would remove the current need to reject leading `/` and `$`, infer the record from an inbox scan, and use `--fire-and-forget` only for second mates.

## Structured policy anomalies and decisions

Record policy or permission anomalies as bounded JSON with an event ID, task and spawn generation, policy identifier, observed denial or workaround category, timestamp, and evidence path.
Do not copy credentials, full prompts, or terminal transcripts into the record.
Also give captain holds structured option words, per-option `done` or `release` consequences, and an expected hold lifecycle identity for `answer`.
Trough could then offer exact answer actions without operator-authored options or a race between hold recheck and answer.

## Durable story seam

At a successful merge outcome, captain hold transition, project registry transition, and finished report, emit a stable event envelope after the durable Firstmate fact is committed.
Include the record identity, event type, time, task or project reference, and safe links so an optional adapter can turn it into a story.
Event publication should be best-effort and retryable from the durable fact, so a missing Trough store never rolls back Firstmate work.
