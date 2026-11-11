#!/usr/bin/env bash
set -eu
[ "${1:-}" = --contribution-input ] || exit 2
cat "$FM_HOME/fixture-snapshot.json"
