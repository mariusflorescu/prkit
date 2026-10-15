#!/usr/bin/env bash
# One headless cursor-agent run under prkit-style controls, for the phase-1 spike.
# usage: cli-probe.sh <fixture-root> <name> <prompt> [extra cursor-agent flags...]
# The fixture root holds repo/ (the workspace), cfg/ (prkit's CURSOR_CONFIG_DIR),
# tmp/ (the run's temp dir) and runs/ (captured output). The environment is
# rebuilt from an allowlist, like packages/contracts/src/childEnv.ts. CURSOR_SPIKE_HOME
# swaps HOME for a prkit-owned one (its Library/Keychains links the login keychain).
set -euo pipefail
root=$1 name=$2 prompt=$3
shift 3
mkdir -p "$root/runs"
out="$root/runs/$name.jsonl"
cd "${CURSOR_SPIKE_CWD:-$root/repo}"
env -i HOME="${CURSOR_SPIKE_HOME:-$HOME}" USER="$USER" PATH="/usr/bin:/bin:/usr/sbin:/sbin" SHELL=/bin/zsh LANG=en_US.UTF-8 \
  TMPDIR="$root/tmp" TERM=dumb CURSOR_CONFIG_DIR="$root/cfg" ${PRKIT_MCP_AUTHORIZATION:+PRKIT_MCP_AUTHORIZATION="$PRKIT_MCP_AUTHORIZATION"} \
  "$(command -v cursor-agent)" -p --output-format stream-json --trust --workspace "$root/repo" \
  --model "${CURSOR_SPIKE_MODEL:-composer-2.5-fast}" "$@" "$prompt" >"$out" 2>"$root/runs/$name.stderr" &
pid=$!
echo "pid $pid"
(
  trap 'kill "$sleeper" 2>/dev/null; exit 0' TERM
  sleep "${CURSOR_SPIKE_TIMEOUT:-240}" &
  sleeper=$!
  wait "$sleeper" && kill -TERM "$pid" 2>/dev/null
) &
watchdog=$!
status=0
wait "$pid" || status=$?
kill "$watchdog" 2>/dev/null || true
echo "exit $status"
