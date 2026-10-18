#!/usr/bin/env bash
# Safe Ainabler — USER-RUN sanitize.
#
# Run this YOURSELF, in your own terminal — not through the AI agent. The point
# is that the passphrase and the raw file never enter the agent's context. When
# you are done, hand only the *sanitized* file to the agent; keep the mapping
# file and the passphrase on your side.
#
# Usage:
#   ./sanitize-user.sh <raw-file> [sa sanitize options...]
#   ./sanitize-user.sh data.xlsx --auto
#   ./sanitize-user.sh data.xlsx --columns "Name=person,Email=email"
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SA="$SCRIPT_DIR/../src/sa.mjs"
NODE_BIN="${NODE_BIN:-node}"

if [ "$#" -lt 1 ]; then
  echo "Usage: sanitize-user.sh <raw-file> [sa sanitize options...]" >&2
  exit 2
fi

INPUT="$1"
shift

printf 'Passphrase: ' >&2
IFS= read -r -s PASS
printf '\n' >&2
printf 'Confirm passphrase: ' >&2
IFS= read -r -s PASS2
printf '\n' >&2

if [ -z "$PASS" ]; then
  echo "Empty passphrase — aborted." >&2
  exit 1
fi
if [ "$PASS" != "$PASS2" ]; then
  echo "Passphrases do not match — aborted." >&2
  exit 1
fi

# The passphrase travels over stdin only: not in argv, not in the environment,
# never echoed. The raw file is read by this local process, not by the agent.
printf '%s' "$PASS" | "$NODE_BIN" "$SA" sanitize "$INPUT" "$@" --passphrase-stdin

unset PASS PASS2
