#!/bin/sh
# Install (or reinstall) the CodeAtlas viewer as a launchd user agent, so
# http://localhost:5173 is up after login/reboot with zero intervention.
#   tools/install-launchd.sh            install / reinstall (idempotent; re-run after editing
#                                       tools/launchd/*.plist or tools/serve.sh to apply)
#   tools/install-launchd.sh --force    install even from a TCC-protected folder (see below)
#   tools/install-launchd.sh uninstall  stop and remove
#   tools/install-launchd.sh status     state / pid / last exit of the loaded agent
# Log:      ~/Library/Logs/codeatlas-viewer.log (rotated to .1 by serve.sh when > 5 MB)
# Restart:  launchctl kickstart -k gui/$(id -u)/com.codeatlas.viewer
#
# Contract: KeepAlive.SuccessfulExit=false + serve.sh exiting 0 when :5173 is already
# served/held, or when the checkout cannot be read → launchd only relaunches when vite
# itself dies (no storm on port conflicts, none on a TCC-blocked checkout either).
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
LABEL=com.codeatlas.viewer
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
FORCE=0

case "${1:-}" in
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$DEST"
    echo "removed $LABEL"
    exit 0 ;;
  status)
    launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E '^\s*(state|pid|last exit code) ' || echo "$LABEL not loaded"
    exit 0 ;;
  --force) FORCE=1 ;;
  "") ;;
  *) echo "usage: $0 [--force|uninstall|status]" >&2; exit 2 ;;
esac

# Refuse rather than warn: a launchd-spawned process cannot read these folders (TCC), so
# serve.sh could never start vite from here. Installing anyway produced an agent that only
# ever logged its own failure — and, before serve.sh grew its readability guard, relaunched
# every ThrottleInterval forever. --force is for anyone who has granted Full Disk Access.
# Case-INSENSITIVE: macOS volumes are case-insensitive by default, so `~/documents/x` is
# the very same TCC-protected folder as `~/Documents/x` and used to install without even a
# warning. (`tr` rather than ${VAR,,}: this is /bin/sh, not bash.)
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
REPO_LC=$(lower "$REPO")
HOME_LC=$(lower "$HOME")
case "$REPO_LC" in
  "$HOME_LC/documents"/*|"$HOME_LC/desktop"/*|"$HOME_LC/downloads"/*)
    if [ "$FORCE" = 1 ]; then
      echo "warning: $REPO is under a TCC-protected folder; installing anyway (--force)." >&2
    else
      echo "error: $REPO is under a TCC-protected folder ($HOME/Documents, Desktop, Downloads);" >&2
      echo "       launchd-spawned processes cannot read it, so the agent could never start the" >&2
      echo "       viewer. Move the checkout (see CLAUDE.md) and re-run, or pass --force." >&2
      exit 1
    fi ;;
esac

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
sed -e "s|__REPO__|$REPO|g" -e "s|__HOME__|$HOME|g" "$HERE/launchd/$LABEL.plist" >"$DEST"
plutil -lint "$DEST" >/dev/null
# Reinstall cleanly if a previous copy is loaded (bootout is a no-op otherwise).
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$DEST"
echo "installed $DEST"
launchctl print "$DOMAIN/$LABEL" | grep -E '^\s*(state|pid) ' || true
