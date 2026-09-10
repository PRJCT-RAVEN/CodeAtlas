---
name: viewer
description: Start, stop, open, or check the CodeAtlas diagram viewer (http://localhost:5173). Use when the user asks to start/open/stop the viewer or reports it is not showing a graph.
argument-hint: [start|stop|status|open|paths]
---

Run `"${CLAUDE_PLUGIN_ROOT}/bin/codeatlas-viewer" $ARGUMENTS` (default command: `start`; on
a Windows shell without Git Bash use `"${CLAUDE_PLUGIN_ROOT}\bin\codeatlas-viewer.cmd"`, or
`node "${CLAUDE_PLUGIN_ROOT}/bin/codeatlas-viewer.mjs"` anywhere). Keep the quotes: the
plugin path contains a space on most Windows machines. Then
report the result in one or two lines: URL, whether it was already up, and the LIVE_DIR
where graphs go. On failure, show the log lines the script printed and suggest the fix it
names (Node.js >= 20 missing, port :5173 held → set `CODEATLAS_PORT`).

Environment the launcher honours: `CODEATLAS_DATA` (default `~/.codeatlas`),
`CODEATLAS_PORT` (default 5173), `CODEATLAS_EDITOR` (e.g. `code -g {file}:{line}`),
`CODEATLAS_OPEN_HOME=1` (open any file under `$HOME`, not only the roots the graph names;
the graph's own root works on any drive, and system locations are always refused).

Themes: light/dark follow the OS; the ☀/☾ button in the viewer overrides; `?theme=light`
forces one for a screenshot. If the user wants different colours, copy
`"${CLAUDE_PLUGIN_ROOT}/docs/theme.example.css"` to `<CODEATLAS_DATA>/theme.css` (the
`THEME_CSS` path `... paths` prints) and edit only
the tokens they name — it is loaded after the built-in tokens and survives plugin updates.
