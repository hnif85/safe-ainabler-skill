#!/usr/bin/env bash
# Safe Ainabler — USER-RUN restore.
#
# Run this YOURSELF after the agent has produced its output. The passphrase and
# the mapping file stay on your side; the agent only ever handled labels.
#
# Usage:
#   ./restore-user.sh <ai-output> --mapping <mapping-file> [-o <out>]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SA="$SCRIPT_DIR/../src/sa.mjs"
NODE_BIN="${NODE_BIN:-node}"

if [ "$#" -lt 1 ]; then
  echo "Usage: restore-user.sh <ai-output> --mapping <mapping-file> [-o <out>]" >&2
  exit 2
fi

INPUT="$1"
shift

printf 'Passphrase: ' >&2
IFS= read -r -s PASS
printf '\n' >&2

if [ -z "$PASS" ]; then
  echo "Empty passphrase — aborted." >&2
  exit 1
fi

printf '%s' "$PASS" | "$NODE_BIN" "$SA" restore "$INPUT" "$@" --passphrase-stdin

unset PASS
