#!/usr/bin/env bash
# Safe Ainabler — USER-RUN local API server.
#
# Start this YOURSELF, in your own terminal. You type the passphrase once, here; the
# server keeps it in memory and never puts it on the wire. Your agent only ever gets
# the URL and the bearer token (printed below, and written to the state file), so it
# can ask the server to sanitize or restore without ever seeing your passphrase or the
# raw data.
#
# Usage:
#   ./serve-user.sh [sa serve options...]
#   ./serve-user.sh --port 8787
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SA="$SCRIPT_DIR/../src/sa.mjs"
NODE_BIN="${NODE_BIN:-node}"

printf 'Passphrase for this session: ' >&2
IFS= read -r -s PASS
printf '\n' >&2

if [ -z "$PASS" ]; then
  echo "Empty passphrase — aborted." >&2
  exit 1
fi

# The passphrase travels over stdin only: not in argv, not in the environment,
# never echoed. It stays inside the server process for the life of the session.
printf '%s' "$PASS" | "$NODE_BIN" "$SA" serve "$@" --passphrase-stdin

unset PASS
