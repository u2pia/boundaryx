#!/bin/zsh
# Restarts the local Control Plane on the live data directory with the built-in Builder and the GitHub token
# taken from the gh CLI login. The token only lives in this process's environment; it is never printed or stored.
set -e
cd "$(dirname "$0")/.."

if pid=$(lsof -nP -iTCP:8787 -sTCP:LISTEN -t 2>/dev/null); then
  echo "stopping control plane (pid $pid)"
  kill $pid
  while lsof -nP -iTCP:8787 -sTCP:LISTEN -t >/dev/null 2>&1; do sleep 0.2; done
fi

export APERTURE_GITHUB_TOKEN="$(gh auth token)"
[ -n "$APERTURE_GITHUB_TOKEN" ] || { echo "gh auth token returned nothing; run gh auth login first"; exit 1; }
export CONTROL_PLANE_DATA_DIR="$PWD/.aperture-live"
export CONTROL_PLANE_AGENT_EXECUTABLE="$(command -v node)"
export CONTROL_PLANE_AGENT_ARGS_JSON="[\"$PWD/scripts/agents/builder.mjs\"]"

# Everything the server prints is also kept, so why it stopped can be read after the terminal is gone.
log="$CONTROL_PLANE_DATA_DIR/server.log"
echo "starting control plane · data $CONTROL_PLANE_DATA_DIR · GitHub token set · log $log"
npm run server:start 2>&1 | tee -a "$log"
