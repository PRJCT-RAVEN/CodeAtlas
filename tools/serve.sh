#!/bin/sh
# CodeAtlas viewer, hands-free. Run by launchd (tools/launchd/com.codeatlas.viewer.plist,
# installed via tools/install-launchd.sh) or by hand: `tools/serve.sh`.
#
# Serves viewer/ at http://localhost:5173 in vite dev mode (HMR + live/graph.json polling).
# --strictPort: fail instead of silently drifting to :5174 — the graph loop assumes 5173.
#
# Exit-code contract with launchd (KeepAlive.SuccessfulExit=false → relaunch only on non-zero):
#   0  viewer already answering on :5173, or the port is held by something else — nothing
#      to do, do NOT relaunch (this is what stops the old relaunch storm on a port conflict)
#   ≠0 vite died — launchd restarts it after ThrottleInterval
#
# Log: ~/Library/Logs/codeatlas-viewer.log — this script is the ONLY writer (the plist sets
# no StandardOut/ErrPath), so rotation here is authoritative: >5 MB at start → .1 (one kept).
# launchd starts with an empty PATH, hence the export.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"   # /usr/sbin for lsof
PORT=5173
LOG="$HOME/Library/Logs/codeatlas-viewer.log"
MAX_LOG_BYTES=5242880   # 5 MB
mkdir -p "$(dirname "$LOG")"

log() { echo "[$(date '+%F %T')] serve.sh: $*" | tee -a "$LOG"; }

# Already up? (another launchd/hand-started instance, or a previous run) → exit 0, no relaunch.
if curl -sf "http://localhost:$PORT/" >/dev/null 2>&1; then
  log "codeatlas viewer already up on :$PORT"
  echo "codeatlas viewer already up on :$PORT"
  exit 0
fi
# Port held by something that is not answering HTTP → also exit 0 (a non-zero exit would
# make launchd relaunch every ThrottleInterval seconds forever). Fix by hand, then
# `launchctl kickstart -k gui/$(id -u)/com.codeatlas.viewer`.
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  log "port :$PORT is held by another process (not the viewer); not starting. Free it, then kickstart the agent."
  exit 0
fi

# Rotate only on the branch that actually starts vite: rotating while another vite is
# already writing would leave it appending to the renamed inode (.1) forever.
if [ -f "$LOG" ]; then
  size=$(stat -f %z "$LOG" 2>/dev/null || wc -c <"$LOG" 2>/dev/null || echo 0)
  if [ "${size:-0}" -gt "$MAX_LOG_BYTES" ]; then
    mv -f "$LOG" "$LOG.1"
    echo "[$(date '+%F %T')] serve.sh: rotated log ($size bytes) → $LOG.1" >>"$LOG"
  fi
fi

cd "$HERE/../viewer"
log "starting vite on :$PORT (pid $$)" >/dev/null
exec npx vite --strictPort --port "$PORT" >>"$LOG" 2>&1
