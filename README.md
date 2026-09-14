# CodeAtlas

Live code diagrams — you ask a question about a codebase and a Claude session answers by
drawing it, in a local viewer where every node links to a `file:line`. New here? Start with
the [User Guide](docs/USER_GUIDE.md). `CLAUDE.md` is the operating manual for sessions
driving the viewer; `docs/audit/` holds the build audits.

## Use it as a Claude Code plugin

Requires [Claude Code](https://claude.com/claude-code) and Node.js ≥ 20. Inside Claude Code:

```
/plugin marketplace add PRJCT-RAVEN/CodeAtlas
/plugin install codeatlas@codeatlas
```

The viewer is loopback-only: `http://localhost:5173`, `http://127.0.0.1:5173` and
`http://[::1]:5173` all reach it, nothing else on the network does.

Then, in any project, just ask: *"map this codebase"*, *"show the data flow through auth"*,
*"what depends on NetworkClient?"*. Claude starts the viewer (`http://localhost:5173`,
first run installs the viewer's npm dependencies), reads your code, and draws a validated
graph in which every node links to a `file:line` you can open in your editor. Refine it
conversationally; each answer is a new graph rendered live.

- `/codeatlas:viewer start|stop|restart|status|open` controls the viewer by hand. After a
  plugin update, `restart` — a running viewer keeps serving the packages it started with.
- Graphs are kept in `~/.codeatlas/live/` (`CODEATLAS_DATA` to move them); the port is
  `CODEATLAS_PORT` (default 5173).
- "Open in editor" uses `CODEATLAS_EDITOR` if set (`code -g {file}:{line}`,
  `subl {file}:{line}`, …); otherwise Xcode on macOS, VS Code elsewhere, then a plain
  text editor (`open -t` / `xdg-open` / Notepad; never for executables). It only opens
  files inside the project the graph names — on any drive, so a repo outside your home
  directory works unconfigured — never system locations. `CODEATLAS_OPEN_HOME=1` also allows
  anything under your home directory.
- Tokens are billed to your own Claude Code account; the plugin adds no service of its
  own. Graph authoring is delegated to Sonnet/Haiku subagents where it can be.
- Big graphs are fine: the viewer lays out only what is expanded. A 100k-node schema opens
  as its top-level containers in under a second, expands one level at a time, and search
  looks inside collapsed containers. `?budget=N` on the viewer URL changes how much starts
  visible (default 600 nodes / 800 edges) — the viewer treats those as targets, not hard
  limits, and will sit slightly over one rather than collapse a view down to a single box.
- Light and dark themes follow your OS; the ☀/☾ button in the viewer overrides it. For
  your own colours, copy `docs/theme.example.css` to `~/.codeatlas/theme.css` and edit the
  tokens you care about (it survives plugin updates).
- macOS, Linux and Windows (Node.js ≥ 20; on Windows the launcher is
  `bin\codeatlas-viewer.cmd`, or the shell shim under Git Bash / WSL). All three run the
  full suites in CI; Windows was also tested by hand on 2026-09-07 and again on 2026-09-12
  for 0.3.0 ([docs/audit/2026-09-12-windows-test.md](docs/audit/2026-09-12-windows-test.md),
  plugin flow included) — there
  "Open in editor" uses VS Code when `code` is on PATH and Notepad otherwise, and the
  schema importer needs the `sqlite3` CLI (`winget install SQLite.SQLite`).
- Big graphs without Claude: `tools/schema2ir.mjs` imports a database schema (SQLite
  directly; PostgreSQL/MySQL through a JSON export) and `tools/fs2ir.mjs` a directory tree.
- Try a checkout without installing: `claude --plugin-dir /path/to/codeatlas`.

Layout:

- `.claude-plugin/`, `skills/`, `agents/`, `bin/` — the Claude Code plugin: manifest + marketplace, the `codeatlas` and `viewer` skills, the `graph-author`/`graph-refresh` subagents, the `codeatlas-viewer` launcher (`codeatlas-viewer.mjs`, with `codeatlas-viewer` and `codeatlas-viewer.cmd` shims for POSIX shells and Windows).
- `schema/` — IR JSON Schema + Node validator CLI.
- `tools/` — `fs2ir.mjs` (directory tree → IR), `schema2ir.mjs` (database catalog → IR: SQLite directly, PostgreSQL/MySQL via [docs/schema-import.md](docs/schema-import.md)), `irdiff.mjs`, `shot.mjs` (headless screenshots; `npx playwright install chromium` once in `tools/`), `serve.sh` + `install-launchd.sh` (always-on viewer on macOS).
- `viewer/` — React Flow + elkjs local web app (`npm install && npm run dev`, tests `npm test`).
- `docs/` — R&D notes and decisions.

## License

MIT — see [LICENSE](LICENSE).
