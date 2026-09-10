---
name: viewer
description: Start, stop, open, or check the CodeAtlas diagram viewer (http://localhost:5173). Use when the user asks to start/open/stop the viewer or reports it is not showing a graph.
argument-hint: [start|stop|restart|status|open|paths]
---

Run `"${CLAUDE_PLUGIN_ROOT}/bin/codeatlas-viewer" $ARGUMENTS` (default command: `start`; on
a Windows shell without Git Bash use `"${CLAUDE_PLUGIN_ROOT}\bin\codeatlas-viewer.cmd"`, or
`node "${CLAUDE_PLUGIN_ROOT}/bin/codeatlas-viewer.mjs"` anywhere). Keep the quotes: the
plugin path contains a space on most Windows machines. Then
report the result in one or two lines: URL, whether it was already up, and the LIVE_DIR
where graphs go. The viewer answers on `http://localhost:<port>`, `http://127.0.0.1:<port>`
and `http://[::1]:<port>` — use whichever the user's tooling needs; it is loopback-only and
never reachable from another machine. A `[codeatlas] no IPv6 loopback listener…` line in
the log is harmless (the machine has no IPv6; IPv4 still serves). On failure, show the log lines the script printed and suggest the fix it
names (Node.js >= 20 missing, port :5173 held → set `CODEATLAS_PORT`).

**Always relay a `NOTE — the viewer's dependencies changed since it started` line**, and
run `... restart` when the user agrees. A running viewer never reloads `node_modules`, so
after a plugin update it keeps serving the old ones until it is restarted. `restart` only
touches an instance this launcher started; against a viewer someone else started (a bare
`npm run dev`, or the repo's launchd agent) it exits 2 and says so rather than killing it.

**Always relay a `WARNING — … dependencies are STALE` line to the user**, even though the
command still exits 0 and the viewer starts. It means an update could not be applied (no
network, or a cold npm cache) and the previous install was kept, so the viewer is running
older packages than the plugin expects. Tell them to re-run `... install` when they are
back online. `status` repeats the warning until an update succeeds.

Environment the launcher honours: `CODEATLAS_DATA` (default `~/.codeatlas`),
`CODEATLAS_PORT` (default 5173), `CODEATLAS_EDITOR` (e.g. `code -g {file}:{line}`),
`CODEATLAS_OPEN_HOME=1` (open any file under `$HOME`, not only the roots the graph names;
the graph's own root works on any drive, and system locations are always refused).

Themes: light/dark follow the OS; the ☀/☾ button in the viewer overrides; `?theme=light`
forces one for a screenshot. If the user wants different colours, copy
`"${CLAUDE_PLUGIN_ROOT}/docs/theme.example.css"` to `<CODEATLAS_DATA>/theme.css` (the
`THEME_CSS` path `... paths` prints) and edit only
the tokens they name — it is loaded after the built-in tokens and survives plugin updates.

If the user uninstalls the plugin, the viewer stops itself within about a minute; the
`STOP=` script in their data dir (`paths` prints it) stops it immediately and keeps
working after the plugin is gone.
