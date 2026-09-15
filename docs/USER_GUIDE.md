# CodeAtlas — User Guide

Ask a question about a codebase; get a live, interactive diagram that answers it, with
every node linked to a `file:line` you can open in your editor.

CodeAtlas is a Claude Code plugin. A Claude session reads your code, authors a *view* that
answers your question, validates it against the Graph IR contract and publishes it; the
viewer at `http://localhost:5173` redraws within a second. Any codebase, any language —
conceptual views (data flow, request lifecycles, architecture) as well as structural ones.
Refine it conversationally: each answer is a new graph.

Two mechanical importers cover the cases too big to read by hand — `tools/fs2ir.mjs`
(directory tree) and `tools/schema2ir.mjs` (database schema).

- Operating manual for sessions driving the viewer: [`CLAUDE.md`](../CLAUDE.md)
- The contract: [`schema/README.md`](../schema/README.md), [`schema/ir.schema.json`](../schema/ir.schema.json)
- Original design spec (historical): [`DESIGN_HISTORY.md`](../DESIGN_HISTORY.md)

---

## 1. Install

Requires [Claude Code](https://claude.com/claude-code) and Node.js ≥ 20. Inside Claude Code:

```
/plugin marketplace add PRJCT-RAVEN/CodeAtlas
/plugin install codeatlas@codeatlas
```

Then, in any project, just ask — *"map this codebase"*, *"show the data flow through
auth"*, *"what depends on NetworkClient?"*. The first start installs the viewer's npm
dependencies (one time, ~20 s) and opens `http://localhost:5173`.

To try a checkout without installing: `claude --plugin-dir /path/to/codeatlas`.

### Controlling the viewer by hand

`/codeatlas:viewer start|stop|restart|status|open|paths|publish`, or directly:

```sh
scripts/codeatlas-viewer start     # installs deps on first run, starts vite on :5173, prints paths
scripts/codeatlas-viewer status    # up/down + pid (exit 1 when down)
scripts/codeatlas-viewer restart   # stop + start — how a plugin update reaches a running viewer
scripts/codeatlas-viewer stop
scripts/codeatlas-viewer paths     # PLUGIN_ROOT / LIVE_DIR / VALIDATOR / THEME_CSS / URL / LOG / STOP
scripts/codeatlas-viewer publish <draft> [--to <name>]
                               # validate a staged graph (a path, or <name> for LIVE_DIR/<name>.json)
                               # and rename it over LIVE_DIR/graph.json in one step; an invalid
                               # draft exits 1 with the errors and nothing changes on screen
```

On Windows use `scripts\codeatlas-viewer.cmd` (or the shell shim under Git Bash / WSL).

A running viewer never reloads its `node_modules`, so after a plugin update it keeps
serving the packages it started with. `start` and `status` notice and print a NOTE;
`restart` applies the update. `restart` only touches a viewer this launcher started — it
exits 2 rather than kill one you started another way.

Two starts at once (two Claude sessions, or the `codeatlas` and `viewer` skills together)
are safe: the second waits for the first instead of racing it for the port.

The viewer answers on `http://localhost:5173`, `http://127.0.0.1:5173` and
`http://[::1]:5173`. It is bound to loopback only and is not reachable from another
machine — this is deliberate, because "Open in editor" launches programs on your machine.
A `[codeatlas] no IPv6 loopback listener on [::1]:5173 …` line in the log just means the
machine has no IPv6; IPv4 keeps serving.

### Environment

| Variable | Default | Purpose |
|---|---|---|
| `CODEATLAS_DATA` | `~/.codeatlas` | graphs (`live/`), `theme.css`, log, pidfile — outside the plugin, so an update never deletes them |
| `CODEATLAS_PORT` | `5173` | viewer port (strict — never drifts) |
| `CODEATLAS_EDITOR` | per platform | "Open in editor" command template, e.g. `code -g {file}:{line}`, `subl {file}:{line}` |
| `CODEATLAS_ROOTS` | — | extra directories "Open in editor" may resolve into; platform path-list separator (`:` on macOS/Linux, `;` on Windows) |
| `CODEATLAS_OPEN_HOME` | unset | `=1` lets "Open in editor" open anything under your home directory, not only the project being drawn |

---

## 2. Reading the diagram

**Node kinds** (containers nest; leaves are clickable):

| Kind | Shown as |
|---|---|
| `module` / `type` | thin outlined container with a floating title chip; click to collapse/expand (a collapsed container is a `+ KIND name` chip) |
| `function` | cream "process" pill (leaf) |
| `property` | pastel rectangle (leaf) |
| `package` | the root — it *is* the canvas, never drawn |
| `file` | elided when it ONLY groups other nodes — that is, it has children, takes part in no edge, carries no `collapsedByDefault`, sits under another container rather than directly under the root, and the graph is small enough not to need budgeting. Otherwise it is drawn as a container, so `imports` between files are drawn between FILE boxes. A leaf `file` is drawn as a store (amber rails) |

Any other kind (conceptual views use `step`, `store`, `queue`, `screen`, database views use
`schema`, `table`, `column`, …) gets a shape from its archetype (process / store /
container / entity) and a hue from a fixed six-colour palette; the **Key** panel (top-left)
lists exactly the kinds present.

**Edge kinds:**

| Edge | Meaning | Drawn |
|---|---|---|
| `contains` | nesting — rendered as containment, never as an arrow | — |
| `calls` | a function/initializer calls another | blue |
| `reads` / `writes` | a property is read / assigned | dashed aqua / orange |
| `instantiates` | a constructor call `Type(...)` | amber |
| `references` | any other symbol reference | muted dashes |
| `conforms_to` / `inherits` | protocol conformance / subclassing | muted dashes |
| `imports` | an import between two modules | muted dashes |

Conceptual views invent their own verb-like kinds (`sends`, `mutates`, `triggers`,
`routes_to`, …); colour follows the task family (calls blue, writes orange, reads aqua,
triggers pink, runs violet, instantiates amber) and the Key shows the mapping for what is
on screen. An edge with a `count` carries a `×N` chip. An edge drawn **dashed with a "?"**
was *inferred* by the author rather than read from the code — it is never presented as
verified.

**Interactions:** click any node to select it — the details panel shows its summary, kind,
id, `file:line`, attributes, metrics and an "Open in editor" button; clicking a container
also collapses/expands it (the panel has an Expand/Collapse button too). Edges into a
collapsed container re-route to the container and aggregate with a `×N` count. The filter
box under the Key dims everything whose name/kind/id doesn't match, and counts matches
hidden inside collapsed containers. Pan/zoom as usual; the minimap (collapsible from its Map header, like the Key)
appears for graphs up to 200 visible nodes. Nodes are not draggable — layout is ELK's job, and the viewer remembers
the previous layout so a refresh moves as little as possible.

**Reading direction.** Data flows down: a `reads`/`polls` edge is laid out with its source
above the reader while the arrow still points reader → source. Because ELK breaks cycles,
an edge that runs upward is a feedback loop, not a layout accident.

**Delta.** When a graph is republished with the same root, added nodes get a green outline,
modified ones amber, and the status bar counts what was removed.

**Themes.** Light and dark follow your OS; the ☀/☾ button overrides (remembered), and
`?theme=light|dark` forces one for a screenshot. For your own colours, copy
[`docs/theme.example.css`](theme.example.css) to `~/.codeatlas/theme.css` and edit only the
tokens you care about — it loads after the built-in tokens and survives plugin updates.

**Open in editor** asks the dev server (`GET /open`) to run `$CODEATLAS_EDITOR` if set,
else Xcode's `xed -l` on macOS / `code -g` elsewhere, falling back to the system opener
(`open` / `xdg-open` / `start`) when that is missing or refuses the file — never for an
executable. Relative locs resolve against the root node's `attrs.absRoot`, then the
server's own roots plus anything in `CODEATLAS_ROOTS`; absolute locs are taken as-is. The
result must be a regular file under one of those roots (or, with
`CODEATLAS_OPEN_HOME=1`, anywhere under your home directory). The graph's own root is
honoured on any drive, so a project outside your home directory needs no configuration;
system locations (`/etc`, `/usr`, `/System`, `~/Library`, `C:\Windows`, `Program Files`,
`AppData`, …) are refused whatever a graph asks for, and the check runs after symlinks are
resolved.
Only same-origin requests from a loopback `Host` are honoured, because the request shells
out and a hostile web page must not be able to trigger it. The panel shows the reply.

---

## 3. Graph IR — the file contract

One JSON document is the whole contract between whatever produces a graph (a Claude
session, `fs2ir`, `schema2ir`, your own script) and the viewer:

```jsonc
{
  "irVersion": "0.2",
  "generator": { "tool": "claude", "version": "<model>", "commit": null },
  "root": "view:auth_flow",
  "title": "How a request gets authenticated",     // optional — the title bar
  "description": "Middleware and token refresh; storage cut.",
  "nodes": [ { "id": "func:App/Auth.verify(_:)", "kind": "function", "name": "verify(_:)",
               "parent": "type:App/Auth", "loc": { "file": "src/Auth.swift", "line": 42 } } ],
  "edges": [ { "id": "e:calls:func:App/Auth.verify(_:)->func:App/Token.decode()",
               "kind": "calls", "from": "func:…", "to": "func:…", "count": 1 } ]
}
```

IDs are **stable** — derived from symbol identity, never from position — so the same
declaration keeps its id across runs, which is what makes diffs and layout stability work.
Hierarchy is `parent` plus a mirrored `contains` edge. Validate any IR file:

```sh
node schema/validate.mjs graph.json …    # VALID, or one line per problem
                                         # --quiet for exit code only; - reads stdin
```

Beyond the JSON Schema it checks: unique ids, exactly one root, parent chains acyclic and
ending at the root, every `parent` mirrored by a `contains` edge (and vice versa), edge
endpoints exist, edge id `=== e:<kind>:<from>-><to>`, `count === locs.length` when both are
present, and nodes/edges sorted by id in UTF-8 byte order. Full contract:
[`schema/README.md`](../schema/README.md).

Compare two IR files with `node tools/irdiff.mjs old.json new.json` (added / removed /
modified nodes and edges; `--json` for machine output).

---

## 4. Importing big structures mechanically

Claude-authored views stay small on purpose (< 100 nodes — a view, not a dump). For
whole-tree or whole-database pictures, two importers write IR directly.

### Directory tree

```sh
node tools/fs2ir.mjs <root> [--depth N] [--max-children M] [--sizes] -o graph.json
```

`dir` containers, `doc` file leaves, and explicit `overflow` ghosts (`… +N more`) wherever
truncation happens — never a silent cut. `--sizes` scales each file's box from its byte
count. Symlinks become `link` nodes; unreadable dirs, FIFOs and sockets are counted in the
parent's `attrs.skipped`. `--max-nodes` raises the 3,000 default.

### Database schema

```sh
node tools/schema2ir.mjs --sqlite app.db -o graph.json
node tools/schema2ir.mjs --json catalog.json -o graph.json     # PostgreSQL / MySQL
```

SQLite is read directly through the `sqlite3` CLI. For PostgreSQL and MySQL, run the query
in [`docs/schema-import/`](schema-import/) to produce a JSON catalog and feed that in — see
[`docs/schema-import.md`](schema-import.md). Tables, columns, indexes, triggers and foreign
keys become a nested graph; 10,000 tables import in about two seconds.

Publish either one by writing it into the live directory (`scripts/codeatlas-viewer paths`
prints `LIVE_DIR`) as `graph.json`.

---

## 5. Big graphs

The viewer lays out only what is *expanded*, so file size barely matters — 100k nodes /
25 MB is tested. On first load it collapses the deepest levels (columns, then tables, …)
until the view is roughly within 600 nodes and 800 edges, and reports "N auto-collapsed ·
showing X/Y" in the status bar. Roughly, on purpose: it will sit a little OVER a cap rather
than fold the last container standing and leave you one chip — a 600-table single-schema
import lands on 601 nodes and ~1,190 edges, not on 1. Click a container to expand it, and
use the filter box to find names inside collapsed containers ("+N hidden"). `?budget=N` (or `?budget=N,E`) on the
viewer URL changes the limits.

Views with more than about three edges per node draw their edges faint until you select a
node, which then lights its own. Past about 800 of them the faint cloud is not drawn at all
— at that density it is mush rather than texture, and each edge costs two SVG paths on every
pan — so the status bar says "N of M edges hidden · select a node to trace them" and the
details panel lists the selected node's edges with their counts. If your own expanding takes the view past about 800 visible
nodes the status bar says so and offers **collapse to fit**, which re-applies the budget —
the viewer warns rather than undoing the click you just made. Large layouts drop to faster ELK settings automatically
and say so in the status bar; a collapse/expand in an expensive view relays out only that
subtree ("approximate layout · tidy" — *tidy* runs a full pass).

So: **author big graphs as containers** (schema > table > column, module > type > member).
A flat 5,000-child container cannot be budgeted and will expand to a 5,000-node view.

---

## 6. Previewing a draft

The viewer polls `live/graph.json`. To look at a candidate view without disturbing the live
one, write it as `live/<name>.json` and open `http://localhost:5173/?graph=<name>` — that
page polls only that file and never falls back to the sample graph.

---

## 7. Development

Only needed if you are working on CodeAtlas itself.

```sh
cd viewer && npm install && npm run dev     # vite on :5173 with HMR
cd viewer && npm test                       # vitest
cd schema && npm test                       # validator tests
cd tools  && npm test                       # fs2ir / schema2ir / irdiff / launcher tests
```

`.github/workflows/ci.yml` runs the viewer, tools and schema suites on Linux.

### Headless screenshots

```sh
cd tools && npm install                      # Playwright, once
node tools/shot.mjs out.png [url] [--collapsed <id>…]
```

Opens the viewer, waits for the graph to settle, optionally collapses containers, and
writes a 1600×1000 @2x PNG. In your own Playwright scripts use `waitUntil:
"domcontentloaded"` — the 1 s poller means `networkidle` never settles.

### Always-on viewer (macOS)

For a checkout you develop against, rather than the plugin launcher:

```sh
tools/serve.sh                 # vite, strict :5173, log → ~/Library/Logs/codeatlas-viewer.log
tools/install-launchd.sh       # register it as a launchd user agent
tools/install-launchd.sh uninstall
launchctl print gui/$(id -u)/com.codeatlas.viewer | grep -E 'state|pid'
```

> **macOS privacy caveat.** A launchd-spawned process does not inherit your terminal's
> access to the TCC-protected folders (`~/Documents`, `~/Desktop`, `~/Downloads`), so an
> agent installed from a checkout inside one can never start the viewer. `install-launchd.sh`
> therefore REFUSES such a path (exit 1, naming the move; the check is case-insensitive, as
> the filesystem is) unless you pass `--force`. If an agent is somehow already installed
> from one, `tools/serve.sh` logs `cannot read …/viewer — TCC-protected folder … not
> starting` and exits 0, so launchd leaves it alone instead of relaunching it every 10 s
> forever. Alternatives: move the checkout (simplest), grant Full Disk Access to your `node`
> binary (per-path, and it lapses silently on a node upgrade), or `nohup tools/serve.sh &`
> from a terminal, which survives the Claude session but not a reboot.

---

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| `Node.js >= 20 required` | install a current Node; the launcher needs ≥ 20 |
| the viewer is still running after I uninstalled the plugin | it stops itself within about a minute of the plugin disappearing. To stop it now, run the `STOP=` script `codeatlas-viewer paths` printed (it lives in `~/.codeatlas/` and keeps working after the plugin is gone) |
| `WARNING — … dependencies are STALE` | an update could not be applied (no network, or a cold npm cache), so the previous install was kept and the viewer is running older packages than the plugin expects. It still starts; `status` keeps warning until you re-run `codeatlas-viewer install` with the network available |
| Port already in use | `CODEATLAS_PORT=<other> scripts/codeatlas-viewer start` |
| Viewer says "waiting for live/graph.json…" | nothing published yet — ask Claude a question, or write a graph into `LIVE_DIR` (`scripts/codeatlas-viewer paths`) |
| Status bar shows a red poll error | the published file is invalid; the last good graph stays on screen. Run `node schema/validate.mjs <file>` and fix what it lists |
| Graph didn't update | check the status bar (source file and counts); confirm you wrote to the `LIVE_DIR` the launcher prints, not the repo's `viewer/public/live/` |
| "Open in editor" says `cannot resolve to an existing file` | usually a missing file, or a loc outside the root the graph names (`attrs.absRoot`). Add the directory to `CODEATLAS_ROOTS` if the graph has no root. System paths are refused by design |
| "Open in editor" opens the wrong app | set `CODEATLAS_EDITOR`, e.g. `code -g {file}:{line}` |
| A huge graph opens nearly empty | that's the visibility budget — expand containers, or raise it with `?budget=2000,3000` |
| A view sits a little over the budget I set | on purpose. The budget will not fold a container away when doing so would hide more than half of what is on screen — a few nodes over beats one box with everything inside it. "Collapse to fit" overrides that when you ask explicitly |
| `NOTE — the viewer's dependencies changed since it started` | a plugin update landed under a running viewer. Run `codeatlas-viewer restart` |
| Nothing happens when I click a node / I can't reach one with the keyboard | every node is a tab stop: Tab to it, Enter or Space to select (and expand/collapse a container), Escape to close the details panel |
| `[::1]:5173 is already in use by another process` | something else holds the IPv6 loopback port. Because `localhost` usually resolves to `::1` first, the viewer refuses to start rather than let that address point at someone else's server — stop it, or use `CODEATLAS_PORT` |
| `schema2ir` fails on SQLite | needs the `sqlite3` CLI on PATH (3.33+ for `-json`) |
