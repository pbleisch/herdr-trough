#!/usr/bin/env bash
set -eu
task=$1
shift
delivery_id=
if [ "${1:-}" = --fire-and-forget ]; then
  delivery_id=$2
  shift 2
fi
[ "$#" -eq 1 ] || exit 2
message=$1
current_gen=$(sed -n 's/^spawn_gen=//p' "$FM_HOME/state/$task.meta")
[ "$current_gen" = "${FM_SEND_EXPECTED_SPAWN_GEN:-}" ] || exit 2
printf '%s\n' "${delivery_id:+--fire-and-forget $delivery_id} $task" >> "$FM_HOME/send.log"
dir="$FM_HOME/state/$task.inbox"
mkdir -p "$dir/handled"
sequence=1
while [ -e "$dir/$sequence.msg" ] || [ -e "$dir/handled/$sequence.msg" ]; do sequence=$((sequence+1)); done
{
  printf 'schema=fm-task-inbox.v1\n'
  printf 'at=2026-11-11T18:00:00Z\n'
  case "$message" in *$'\n') ;; *) printf 'body-terminator=1\n' ;; esac
  [ -z "$delivery_id" ] || printf 'delivery=fire-and-forget\n'
  printf '%s\n' --
  [ -z "$delivery_id" ] || message="from-firstmate delivery=$delivery_id $message"
  case "$message" in *$'\n') printf '%s' "$message" ;; *) printf '%s\n' "$message" ;; esac
} > "$dir/$sequence.msg"
