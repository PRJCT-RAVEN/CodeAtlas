#!/bin/sh
# Install (or reinstall) the CodeAtlas viewer as a launchd user agent, so
# http://localhost:5173 is up after login/reboot with zero intervention.
#   tools/install-launchd.sh            install / reinstall (idempotent; re-run after editing
#                                       tools/launchd/*.plist or tools/serve.sh to apply)
#   tools/install-launchd.sh uninstall  stop and remove
#   tools/install-launchd.sh status     state / pid / last exit of the loaded agent
# Log:      ~/Library/Logs/codeatlas-viewer.log (rotated to .1 by serve.sh when > 5 MB)
# Restart:  launchctl kickstart -k gui/$(id -u)/com.codeatlas.viewer
#
# Contract: KeepAlive.SuccessfulExit=false + serve.sh exiting 0 when :5173 is already
# served/held → launchd only relaunches when vite itself dies (no storm on port conflicts).
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
LABEL=com.codeatlas.viewer
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

case "${1:-}" in
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$DEST"
    echo "removed $LABEL"
    exit 0 ;;
  status)
    launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E '^\s*(state|pid|last exit code) ' || echo "$LABEL not loaded"
    exit 0 ;;
  "") ;;
  *) echo "usage: $0 [uninstall|status]" >&2; exit 2 ;;
esac

case "$REPO" in
  "$HOME/Documents"/*|"$HOME/Desktop"/*|"$HOME/Downloads"/*)
    echo "warning: $REPO is under a TCC-protected folder; launchd-spawned processes cannot read it. Move the checkout (see CLAUDE.md)." >&2 ;;
esac

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
sed -e "s|__REPO__|$REPO|g" -e "s|__HOME__|$HOME|g" "$HERE/launchd/$LABEL.plist" >"$DEST"
plutil -lint "$DEST" >/dev/null
# Reinstall cleanly if a previous copy is loaded (bootout is a no-op otherwise).
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$DEST"
echo "installed $DEST"
launchctl print "$DOMAIN/$LABEL" | grep -E '^\s*(state|pid) ' || true
