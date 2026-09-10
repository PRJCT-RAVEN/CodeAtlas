# CodeAtlas — instructions for Claude sessions

You are the diagram engine. The user asks questions about code in natural language;
you answer by DRAWING: read the code, decide what view answers the question, emit a
Graph IR JSON file. The viewer renders it live. Rendering is hard-coded (ELK layout,
React Flow) — never attempt layout or coordinates yourself.

## The loop

1. User asks ("show the data flow through auth", "what depends on NetworkClient?",
   "map this codebase", "now hide the tests and zoom into persistence").
2. Read the relevant source. Choose nodes/edges that ANSWER THE QUESTION — a view,
   not a dump. Prefer <100 nodes; collapse detail the question doesn't need.
3. Write the graph to a STAGING path, validate, then publish — never write an
   unvalidated draft to the live path:
   `viewer/public/live/<name>.json` → `node schema/validate.mjs viewer/public/live/<name>.json`
   → `mv viewer/public/live/<name>.json viewer/public/live/graph.json`. The viewer at
   http://localhost:5173 polls `live/graph.json` every second. A draft can be previewed
   without touching the live view at `http://localhost:5173/?graph=<name>` (polls
   `live/<name>.json` only, never falls back to the sample).
   The viewer is meant to be always-on: `tools/serve.sh` runs vite (strict :5173, log in
   `~/Library/Logs/codeatlas-viewer.log`, rotated at 5 MB); `tools/install-launchd.sh`
   registers it as a launchd user agent (KeepAlive on non-zero exit only; `serve.sh` exits 0
   when :5173 is already answering, so no relaunch storms). Caveat: macOS TCC blocks
   launchd-spawned processes from `~/Documents`, `~/Desktop` and `~/Downloads`, so the
   checkout must live outside them. Fallback if the agent is ever unavailable:
   `nohup tools/serve.sh &` (survives the Claude session, not a reboot).
   PLUGIN MODE (end users, see "Plugin packaging" below): `bin/codeatlas-viewer start`
   runs the same vite with `CODEATLAS_LIVE_DIR=~/.codeatlas/live`, and the `codeatlas`
   skill stages/publishes there instead of `viewer/public/live/` — same loop, different dir.
4. Validate: `node schema/validate.mjs <file>...` (multiple files ok, `-` reads stdin,
   `--quiet` for exit code only). It checks JSON Schema plus: unique ids, one root, parent chains acyclic and
   ending at the root, every `parent` mirrored by a `contains` edge (and vice versa),
   edge endpoints exist, edge id === `e:<kind>:<from>-><to>`, `count === locs.length`
   when both present, nodes/edges sorted by id in UTF-8 byte order. Fix anything invalid
   before telling the user it's done — the viewer's own guard keeps the LAST GOOD graph on
   screen and names the problem in its status bar, but an invalid file is still a failure.
5. Iterate conversationally — each refinement is just a new graph.json. Keep ids stable:
   the viewer highlights what changed (green = added, amber = modified, removed count in
   the status bar) and keeps previous positions (per root id, in localStorage + an
   interactive ELK pass) so a refresh moves as little as possible.

## Graph IR essentials (full contract: schema/ir.schema.json, v0.2)

- Top level: `irVersion: "0.2"`, `generator: {tool: "claude", version: <model>, commit: null}`,
  `root: <root node id>`, `nodes`, `edges`; optional `title` (the question — shown as the
  title bar), `description` (what was included/cut — shown under it), `annotations`,
  `clusters`. Nothing else.
- Node: `{id, kind, name, parent?, loc?, attrs?, metrics?}`.
  Edge: `{id, kind, from, to, locs?, count?}` with `id === "e:<kind>:<from>-><to>"`.
  `loc` is `{file, line, col?}` — col is optional. `count` may stand alone on a
  conceptual edge (multiplicity); with `locs` it must equal `locs.length`.
- IDs: `<lowercase-prefix>:<stable-path>`, e.g. `type:MyApp/APIClient`,
  `func:MyApp/APIClient.fetch(_:)`. Derive from symbol identity, NEVER from position —
  stable IDs are what make live updates smooth instead of a reshuffle.
- Sort nodes and edges by id in UTF-8 BYTE order — in node
  `arr.sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)))`, not plain
  `<` (UTF-16). Exactly one node (the root) omits `parent`.
- Hierarchy via `parent` + mirrored `contains` edges (the validator enforces both
  directions); renders as nesting, not arrows. The root node is hidden (root = canvas).
  A `file` node is hidden only when it has children (a grouping level); a leaf `file`
  in a conceptual view is drawn as a store.
- `annotations.<id>` IS rendered: `summary` (details panel; on the root → the
  description), `importance` 0..1 (edge stroke width), `label` (replaces the edge chip
  text), `collapsedByDefault: true` (container starts collapsed on first load of that
  graph; the user's later expand sticks), `inferred: true` (edge drawn dashed with a "?"
  and listed in the Key), `feedback: true` (on the edge of a cycle you want drawn UPWARD —
  a retry/backorder loop; without it ELK picks which edge of the cycle to reverse). `metrics` show in the details panel; `attrs.scale` (1..3)
  scales a leaf's box.

## Vocabulary

Structural views: kinds `package|module|file|type|function|property` and edge kinds
`imports|contains|calls|references|conforms_to|inherits|instantiates|reads|writes`.
Conceptual views (dataflow, control flow, request lifecycles, architecture): invent
kinds — `step:`, `store:`, `queue:`, `screen:`, edge kinds like `sends`, `mutates`,
`triggers`. The viewer derives styling for unknown kinds automatically.

File-structure views: `node tools/fs2ir.mjs <root> [--depth N] [--max-children M]
[--sizes] -o viewer/public/live/graph.json` walks a directory into IR — `dir`
(container), `doc` (file leaf; badge hidden), `overflow` (ghost "… +N more" for
truncation — never truncate silently; the root's overflow id is `overflow:.`).
`--sizes` sets `attrs.scale` from `metrics.bytes` (1 KB → 1.0, 100 KB → 2.0, capped 2.6).
Locs are root-relative and the root node carries `attrs.absRoot` (pass `--abs-locs` for
absolute paths) — same convention as the repo-relative locs in code graphs. Symlinks
become `link` nodes (`attrs.target`), never dropped; FIFOs/sockets/unreadable dirs are
counted in the parent dir's `attrs.skipped`. A nonexistent root or a bad `--depth` is a
non-zero exit, not an empty graph. Containers whose entire visible subtree is edge-free
lay out via rectpacking automatically, so pure trees render as grids, not one endless
row; any edge touching a descendant keeps the container in ELK layered.

Diffing two IR files: `node tools/irdiff.mjs old.json new.json [--json]` (added / removed /
modified nodes and edges; locs ignored; works for any kinds).

## Visual language (DFD theme, adopted 2026-08-24 from reference DFD images; light + dark)

Every colour is a TOKEN in `viewer/src/theme.ts` (dark and light sets; both validated
with the dataviz six-checks — adjacent-pair CVD ΔE ≥ 8, normal-vision ≥ 15, ≥ 3:1 on the
surface). `styles.css`, the node renderer, the edge families and the Key only use
`var(--token)`; a test fails if any other file names a colour. Theme choice:
`?theme=light|dark` > the ☀/☾ toggle (localStorage) > `prefers-color-scheme`. Tokens are
injected as a `<style>` BEFORE `/theme.css` (the user's `~/.codeatlas/theme.css`, served
by the launcher's viewer), so an override file only redefines what it wants — template with
every token: `docs/theme.example.css`. When adding a colour: add the token to BOTH sets,
validate accents with the dataviz validator, never write a literal.
Node ARCHETYPE picks the shape treatment; kind picks the hue slot (six accents): process-like kinds → cream
pill · store-like (`store|db|queue|cache|file|config|artifact|…`) → open amber rails ·
containers → thin outline + floating title chip · everything else → pastel rect.
Edge kinds map to one validated hue per TASK family (2026-08-24 notes):
calls/sends/submits/reports_to=blue · writes/mutates/appends=orange ·
reads/queries/polls=dashed aqua (and layout-REVERSED: ELK layers the source
ABOVE the reader so data always flows down; drawing keeps the authored arrow) ·
triggers/emits/notifies=pink · runs/plays/routes_to/streams/outputs=violet ·
instantiates/derives/builds=amber · structural imports/references=muted dashes ·
feeds/misc=neutral gray · inferred=dashed with "?".
Edges are ROUTED BY ELK (orthogonal, `elk.json.edgeCoords=ROOT`) and drawn by the
custom `elk` edge type (`viewer/src/edges/ElkEdge.tsx`) — they never cut through node
boxes; label chips are placed by ELK too (inline labels), so chips don't collide with
each other or with pills — and `viewer/src/layout/labels.ts` (pass 2, 2026-09-05) then
re-scores every chip against leaf boxes, container outlines, other chips and other edges'
segments and slides it along ITS OWN polyline when ELK's spot is not clean (`labelPass:
false` in tests to compare; `collisionPenalty` is the metric). Self-loops (recursion) are drawn. ELK breaks cycles, so an
UPWARD edge is a feedback loop, not a layout error (in the DFD example: send_receipt →
price_order, "payment failed"). ELK runs in a Web Worker (the UI never freezes; the status bar
says "laying out…").
Chrome: a dynamic **Key** (top-left, collapsible; only kinds present, plus "inferred"
and delta rows when relevant) with a filter box under it (dims non-matches, shows the
count); a **title bar** (top centre: `title` or root name, `description` or the root's
summary); a **status bar** (bottom centre: source file, node/edge counts, layout state,
last poll error, delta counts). Click any node to select it (details panel with summary,
loc, attrs, metrics, importance, "Open in editor" and the server's reply); clicking a
container also collapses/expands it (the details panel has an Expand/Collapse button
too). MiniMap (bottom-right, collapsible like the Key) only up to 200 visible nodes; nodes are not draggable.
Node maps live in `viewer/src/App.tsx` (KIND_SLOT → `--accent-N`/`--pastel-N`), the edge-family
table in `viewer/src/ir/families.ts` (style + layout direction, shared by App/Key/elk),
treatments in `styles.css`, layout in `viewer/src/layout/elk.ts`, `/open` in
`viewer/vite.config.ts` (config change = vite restart:
`launchctl kickstart -k gui/$(id -u)/com.codeatlas.viewer`).
Stacking is deliberate: edges pinned z=2 (CSS `!important` — React Flow
auto-elevates nested-node edges to 6 otherwise), containers 3, edge chips 3, leaf marks 4.
Showcase graph: `docs/examples/order-pipeline.graph.json` (fictional).

"Open in editor" hits the dev server's `/open` endpoint → `$CODEATLAS_EDITOR` (a template
with `{file}`/`{line}`, e.g. `code -g {file}:{line}`), else per platform: macOS `xed -l`
(Xcode), Linux/Windows `code -g` (a command that resolves to a batch file runs through
`cmd.exe` — see `spawnDetached`); when that is missing or exits non-zero, a plain text
editor (`open -t` / `xdg-open` for MIME-text files / Notepad — never `start`). Rules: Host
must be loopback and `Sec-Fetch-Site` same-origin/none; a relative loc resolves against this
repo, `$CODEATLAS_ROOTS` (platform path-list delimiter: `:` on macOS/Linux, `;` on Windows),
or the root node's `attrs.absRoot` — honoured on any drive, so a project outside `$HOME`
works with no configuration. The result must realpath to a regular file inside one of those
roots and must not be a SYSTEM path (`/etc`, `/usr`, `/bin`, `/sbin`, `/dev`, `/System`,
`/Library` and `~/Library`; on Windows `Windows\`, `Program Files\`, `ProgramData\`,
`AppData\`) — the deny-list is applied AFTER realpath, so a symlink inside a project cannot
smuggle one in. `CODEATLAS_OPEN_HOME=1` additionally allows anything under `$HOME`,
and the generic opener is never handed an executable or a run-on-open type.

## Big graphs (database scale, 2026-09-05)

The file may be huge (100k nodes / 25 MB tested); the viewer only lays out and renders
what is VISIBLE, so size is governed by what is expanded, not by the file:
- **Visibility budget** (`viewer/src/ir/budget.ts`): on first sight of a root, whole depth
  levels are collapsed deepest-first (every table before any schema) until ≤ 600 visible
  nodes and ≤ 800 display edges (`?budget=N[,E]` overrides). Author `collapsedByDefault`
  and the user's own expands are never revisited. Status bar: "N auto-collapsed · showing
  X/Y". So author big graphs as containers (schema > table > column, module > type >
  member): a flat 5,000-child container cannot be budgeted and expands to a 5,000-node view.
- **Layout tiers** (`layoutTier` in `elk.ts`): quality (≤ 400 nodes and ≤ 400 edges:
  network-simplex placement, orthogonal routing, ELK inline labels + label pass) · fast
  (≤ 1,500 nodes, ≤ 800 edges: longest-path layering, simple placement, thoroughness 1) ·
  fastest (above that: polyline routing, containers laid out SEPARATELY so cross-container
  edges are plain curves, chips at midpoints). **Dense** views (> 200 edges and > 3 edges per
  visible node) give ELK no edges at all: nodes fold into a grid and edges are drawn faint
  until a node is selected (`ElkEdge` reads the selection; no chips on faint edges — the
  details panel lists the selected node's edges with counts instead). Containers with > 12 visible
  children use MIN_WIDTH layering (bound ≈ 0.95·√k), so 200 tables are a block, not a
  30,000 px row. `LayoutResult.mode` reports tier/dense/heavy.
- **Render guard**: above 800 VISIBLE nodes the status bar warns and offers "collapse to
  fit", which re-applies the budget to the current view (targeting the smaller of the
  budget and the guard, so it still helps when `?budget=` was raised). The automatic pass
  never revisits a container the user opened — undoing their click would be hostile — so
  this is the on-demand form of PROJECT_SPEC §3(C)/N4's forced-collapse cap.
- **Polling** is conditional (ETag → 304; `/live` cap 256 MB): an unchanged 25 MB graph
  costs one 304 per second. **Search** counts matches inside collapsed containers ("+N
  hidden") and keeps their container lit. Above 800 visible nodes node shadows are dropped
  (`atlas-big`) — panning is paint-bound.
- Measured (headless Chromium, software rendering, synthetic schema/table/column graphs with
  two hashed foreign keys per table): 104k nodes → 40-schema overview in 0.7 s, expanding a
  200-table schema 1.7 s; 603 visible tables: load 0.9 s, pan 93 ms; 1,005: 1.1 s / 250 ms;
  2,010: 2.0 s / 0.7 s; 4,020 (budget overridden): 7.6 s and multi-second pans — the budget
  exists so nobody lands there. Benchmark aids: `?budget=`, `?culling=0`; the generator is
  `db()` in `viewer/tests/budget.test.ts`.
- **Incremental relayout** (`viewer/src/layout/incremental.ts`): when one container is
  toggled and the last full pass was expensive (> 300 ms or > 400 visible nodes), only that
  container's subtree goes through ELK; it is spliced into the previous layout, neighbours
  are pushed only as far as needed (never pulled back — gaps are harmless, overlaps are
  not), ancestors grow, routed edges whose endpoints did not move keep their polylines and
  the rest become plain curves. The status bar says "approximate layout · tidy"; tidy runs
  a full pass. Unchanged React Flow node/edge objects are reused across passes so React
  Flow skips their DOM. Measured (headless): a toggle in a routed 302-table view 1,003 ms →
  198 ms; dense views already relay out in ~350 ms, so they stay on the full path.
  `?incremental=0|1` forces the path for benchmarking.
- Database kinds have fixed hue slots (`database|schema|table|column|index|trigger|procedure`,
  plus `group` for schema2ir's name-range buckets).
- **Platforms**: everything shipped is Node ≥ 20 and portable across macOS, Linux and
  Windows; `CODEATLAS_ROOTS` uses the platform path-list delimiter; "Open in editor" has
  per-platform defaults. CI runs the viewer, tools and schema suites on a
  ubuntu+windows matrix, plus a `package` job (every shipped graph validates, no personal
  paths, shims runnable) and a Windows shim check; the hands-on Windows 11 pass is
  `docs/audit/2026-09-07-windows-test.md`. Windows specifics: `code` on PATH is
  `code.cmd`, so an editor command that resolves to a batch file runs through `cmd.exe`
  (`spawnDetached` in `viewer/vite.config.ts`); npm test scripts must double-quote globs
  (cmd.exe keeps single quotes and `node --test` then runs zero tests with exit 0 — CI now
  fails a suite that reports zero tests); symlink tests skip without Developer Mode or
  elevation, FIFO tests skip, the unreadable-dir test uses `icacls`.
- **Authoring big graphs without Claude**: `tools/schema2ir.mjs` (database catalog →
  IR; SQLite via the `sqlite3` CLI, PostgreSQL/MySQL via `docs/schema-import/*.sql` →
  JSON; 10,000 tables in ~2 s; tables always sit under a `schema` container, and a schema
  with more than 200 of them is split into `group` name-ranges so the budget can collapse
  each level — a flat level under the root cannot be collapsed, since the root is the
  canvas) and `tools/fs2ir.mjs` (`--max-nodes` to raise the 3,000
  default). Claude-authored views stay < 100 nodes.

## Headless screenshot loop (Claude's eyes on the viewer)

No Chrome extension needed: `cd tools && npm install && npx playwright install chromium`
once (npm install no longer downloads browsers; the cache is `~/Library/Caches/ms-playwright`
on macOS, `%LOCALAPPDATA%\ms-playwright` on Windows, `~/.cache/ms-playwright` on Linux), then
`node tools/shot.mjs out.png [url] [--collapsed <id>...]` — opens the viewer
(default `http://localhost:5173/`; use `http://localhost:5173/?graph=<name>` for a
draft), waits for `.react-flow__node` + ~2.5 s settle, optionally clicks containers to
collapse them, writes a 1600×1000 @2x full-page png. Iterate: edit viewer source (vite
HMR) or `live/graph.json` → shot → Read the png → compare against references → adjust.
This is how style changes get verified — never claim a visual change works without a
shot of it. In your own Playwright scripts use `waitUntil: "domcontentloaded"` — the
1 s poller means `networkidle` never settles.

## Honesty rules (non-negotiable)

- Every node and edge that refers to real code MUST carry `loc`/`locs` with actual
  file:line you verified by reading the file. This is the audit trail — the user can
  click any node to open the source. Never fabricate a loc.
- Do not invent edges you have not seen evidence for. If you infer (e.g. dynamic
  dispatch), mark it `"annotations": {"<edge-id>": {"inferred": true, "summary":
  "inferred: ..."}}` — the viewer draws it dashed with a "?" so it can never pass for a
  verified edge — and say so in chat.
- For a codebase too large to read exhaustively, get the SHAPE mechanically first and
  then verify what you draw: `tools/fs2ir.mjs` for the directory tree, `tools/schema2ir.mjs`
  for a database, plus Grep/Glob to locate the symbols the question is about. Read the files
  you cite. Never infer an edge from a filename.

## Plugin packaging (this repo IS the Claude Code plugin)

The repo root is the plugin root; `.claude-plugin/plugin.json` is the manifest and
`.claude-plugin/marketplace.json` lists the plugin itself (`source: "./"`), so users run
`/plugin marketplace add <owner>/<repo>` then `/plugin install codeatlas@codeatlas`.
Shipped components — keep them portable (no personal paths, no macOS-only assumptions
without a fallback, every plugin path via `${CLAUDE_PLUGIN_ROOT}`):

- `skills/codeatlas/SKILL.md` — the end-user version of THIS manual (the loop, IR
  essentials, honesty rules, view design); invoked automatically on diagram questions or
  as `/codeatlas:codeatlas <question>`. Keep it in sync with the sections above when the
  contract or the viewer changes. `skills/viewer/SKILL.md` — `/codeatlas:viewer
  start|stop|status|open|paths`.
- `agents/graph-author.md` (Sonnet) and `agents/graph-refresh.md` (Haiku) — subagents
  `codeatlas:graph-author` / `codeatlas:graph-refresh`; they validate with the plugin's
  own `schema/validate.mjs`.
- `bin/codeatlas-viewer.mjs` — the launcher (Node, one implementation for macOS, Linux
  and Windows; `bin/codeatlas-viewer` and `bin/codeatlas-viewer.cmd` are shims): installs
  `viewer/` + `schema/` deps on first run, starts vite detached on `$CODEATLAS_PORT`
  (5173) with `CODEATLAS_LIVE_DIR=$CODEATLAS_DATA/live` (`~/.codeatlas/live`), pid/log
  under the data dir, along with a self-contained `stop-viewer.sh`/`.cmd` that still works
  after the plugin is uninstalled (the running viewer also exits on its own once the plugin
  manifest has been gone ~60 s, so a detached daemon cannot outlive its uninstall);
  `stop` (verifies the pid is still a vite before killing; `taskkill
  /T` on Windows) / `status` (exit 1 when down) / `open` / `paths` / `install`. A dependency
  update that cannot complete keeps the working install and records it, so `start` and
  `status` warn that the viewer is running stale packages until `install` succeeds. Graphs live
  OUTSIDE the plugin so an update never deletes them. Tested end to end in
  `tools/test/launcher.test.mjs`.
- Skills must NOT declare `allowed-tools` (verified 2026-09-05, Claude Code 2.1.261): with
  it, the `Skill` call itself becomes a permission gate ("Execute skill: codeatlas:viewer"),
  which `-p` denies outright and interactive mode would prompt for on every question. Let
  the Bash calls prompt normally instead. `${CLAUDE_PLUGIN_ROOT}` and `$ARGUMENTS` do
  expand in the skill body.
- Check before shipping: `claude plugin validate .` (add `--strict`), `cd viewer && npm
  test`, `cd schema && npm test`, `cd tools && npm test`; try it as a stranger with
  `claude --plugin-dir /path/to/this/repo` from some other project (headless smoke test:
  `claude --plugin-dir <repo> --allowedTools "Bash(<repo>/bin/codeatlas-viewer *)" -p
  "Use the /codeatlas:viewer skill with argument 'status'"`).

## Session habits (standing instructions)

- **Model economy for graph generation**: emitting IR does not need the largest model.
  Use the plugin subagents `codeatlas:graph-author` (Sonnet: judgement-heavy new views) and
  `codeatlas:graph-refresh` (Haiku: re-emit an existing view after edits, ids stable) —
  available when the plugin is installed or the session runs with `--plugin-dir .`.
  Invoke with `Agent` + `subagent_type: "codeatlas:graph-author"` / `"codeatlas:graph-refresh"`,
  give them the question, the source root and an OUTPUT PATH under
  `viewer/public/live/<name>.json` (never the live file). The orchestrating session designs
  the view (which question, which nodes) and ALWAYS runs `node schema/validate.mjs` on the
  subagent's output before publishing to `live/graph.json` — the validator is the safety
  net that makes cheap models safe here.
- **Audits**: `docs/audit/` holds the 2026-08-27 build audit (problem list + status);
  add to it rather than re-deriving the same findings.
- Personal conventions (task tracker, machine paths) live in `CLAUDE.local.md`, which is
  gitignored — never put them here; this file ships with the plugin.

## View design guidance

- Default to the coarsest level that answers the question; use `contains` nesting so
  the user can expand interactively (clicking a container collapses/expands it).
- One question, one view. "Show auth flow" ≠ the whole module graph with auth
  highlighted — cut everything irrelevant.
- Use `metrics` (numbers) and `annotations` (summaries, importance 0..1) to enrich;
  `annotations.<id>.collapsedByDefault: true` for detail-heavy containers.
- Edge labels come from kind + count (or `annotations.<edge>.label`); keep kinds short
  and verb-like.
- For diffs/"what changed": emit the new graph with the SAME root id and stable node ids;
  the viewer highlights added/modified nodes and keeps positions.
