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
   checkout must live outside them — `install-launchd.sh` REFUSES such a path (exit 1,
   case-insensitively; `--force` for anyone who has granted Full Disk Access), and if an
   agent is installed from one anyway, `serve.sh` exits 0 with a `cannot read …/viewer`
   log line rather than the non-zero exit that made launchd relaunch it every 10 s. The
   plist deliberately sets no `WorkingDirectory`: launchd chdir()s BEFORE it execs, so
   pointing it into the checkout defeated that guard before the script could run.
   Fallback if the agent is ever unavailable:
   `nohup tools/serve.sh &` (survives the Claude session, not a reboot).
   The socket is LOOPBACK-ONLY and must stay that way (`/open` shells out): vite binds
   `127.0.0.1` and a best-effort twin listener answers `[::1]` on the same port, so
   `localhost`, `127.0.0.1` and `[::1]` all work — which matters for curl, scripts and
   anything that does not retry the other address family. Never `--host` / `0.0.0.0` / `::`.
   No IPv6 on the machine → a `[codeatlas] no IPv6 loopback listener…` warning and IPv4
   keeps serving; something ELSE holding `[::1]:<port>` is fatal, because `localhost` would
   then resolve to it and reach a server that is not this viewer.
   PLUGIN MODE (end users, see "Plugin packaging" below): `bin/codeatlas-viewer start`
   runs the same vite with `CODEATLAS_LIVE_DIR=~/.codeatlas/live`, and the `codeatlas`
   skill stages there instead of `viewer/public/live/` and publishes with
   `bin/codeatlas-viewer publish <name> [--to <other>]` — validate and rename in ONE step,
   exit 1 with the errors and the draft left in place when it is not valid IR. The `mv`
   above is for this repo only: in plugin mode the live dir is outside every project and
   Claude Code refuses `mv` there outright ("may only move files to/from the allowed
   working directories" — a hard block, not a prompt; found 2026-09-12 when a headless
   "map this codebase" fell back to writing `graph.json` with the Write tool). The
   subcommand sits behind the one Bash permission users already grant the launcher, and
   it keeps the ordering out of the model's hands: nothing reaches the live file unless
   the validator said VALID.
4. Validate: `node schema/validate.mjs <file>...` (multiple files ok, `-` reads stdin,
   `--quiet` for exit code only). It checks JSON Schema plus: unique ids, one root, parent chains acyclic and
   ending at the root, every `parent` mirrored by a `contains` edge (and vice versa),
   edge endpoints exist, edge id === `e:<kind>:<from>-><to>`, `count === locs.length`
   when both present, nodes/edges sorted by id in UTF-8 byte order. Fix anything invalid
   before telling the user it's done — the viewer's own guard keeps the LAST GOOD graph on
   screen and names the problem in its status bar, but an invalid file is still a failure.
   Exit codes: 0 valid, 1 invalid, 2 a USAGE error — or the validator's own dependency
   (ajv) missing, in which case it names the install command instead of dying with a
   module-resolution stack. Each schema error quotes the offending value
   (`/nodes/8/id must match pattern "…" — got "doc:we\nird.txt"`, JSON-quoted so an
   unprintable character cannot break the one-error-per-line output), and past 200 schema
   errors the listing is capped — the trailing `… and N more` counts every real problem,
   not just the ones that were formatted.
5. Iterate conversationally — each refinement is just a new graph.json. Keep ids stable:
   the viewer highlights what changed (green = added, amber = modified — for EDGES too: an
   edge whose MULTIPLICITY changed is amber and counted, which an id-set diff cannot see since
   the id embeds kind/from/to, so `calls ×2` → `calls ×7` was reported nowhere at all. What is
   compared is `edgeCount` in `ir/density.ts` — `count ?? locs.length`, the number the chip
   shows — because `locs` without `count` is what the honesty rule actually produces, and a
   diff that looked at `count` alone missed every one of those and false-positived on an edge
   converted from `count: 2` to two `locs`. A changed edge is drawn even in a hairball, like
   an added one — and drawn DISTINGUISHABLY: the delta colour is on the STROKE, not only on
   the chip, because dense views suppress chips and are the only views where the delta
   clause is reachable at all (a plain view lights everything), so for one round the Key
   showed a green and an amber swatch over two identical blue edges. A DISPLAY edge decides
   its own delta from its constituents (`displayEdgeDelta`): several IR edges fold into one
   display edge whenever a container is collapsed, and lifting "some constituent was added"
   onto it painted an edge that merely GREW from `calls ×3` to `×4` green as new, while one
   that SHRANK got nothing beside a status bar saying "−1 removed" about a connection still
   on screen — so it asks "was any of me here before" (else added) and "has my summed
   multiplicity changed" (modified), with removed constituents resolved back onto it through
   the layout's own `rep`. `tools/irdiff.mjs` derives the same multiplicity, so the two tools
   agree on what a change is. Node `attrs` are compared by VALUE with key order ignored,
   as irdiff does; removed
   count in the status bar covers edges as well as nodes; `contains` edges are not counted as
   changes of their own — they mirror
   `parent`, so every added node brings one and the bar read "+2 added" for one new node) and keeps previous positions (per root id, in localStorage + an
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
- CHARSET: a kind and an id prefix are lowercase letters, digits and underscore only
  (`[a-z][a-z0-9_]*`) — `routes_to`, never `routes-to` or `routesTo`. The edge id embeds
  the kind, so a hyphen would make `e:<kind>:<from>-><to>` ambiguous; the validator now
  reports a bad kind on `/edges/N/kind`, not only on the id.
- SEPARATORS: `loc.file` and path-shaped ids use FORWARD slashes on every platform,
  Windows included. The validator rejects a RELATIVE `loc.file` containing a backslash;
  absolute Windows paths (`C:\src\App.tsx`) and UNC paths are accepted as-is.
- Sort nodes and edges by id in UTF-8 BYTE order — in node
  `arr.sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)))`, not plain
  `<` (UTF-16). Exactly one node (the root) omits `parent`.
- Hierarchy via `parent` + mirrored `contains` edges (the validator enforces both
  directions); renders as nesting, not arrows. The root node is hidden (root = canvas).
  A `file` node is hidden when it has children (a grouping level) AND takes part in no
  edge, the author has not asked it to start collapsed, the graph is small enough not to need
  budgeting (`skipForBudget` — the smaller of `VIEW_NODE_CAP` and the budget in force, so a
  LOWERED `?budget=` still keeps the level it will have to fold) and there is another
  container above it — `groupingSkip` in
  `viewer/src/ir/grouping.ts`, the ONE definition, shared by the layout engine, the
  visibility budget, the Key AND search (it was four identical copies, which is how the rule
  came to be wrong in all of them at once; unifying only two left the legend showing no
  `file` row beside a canvas full of `FILE` containers, and unifying three left search
  promising "+1 hidden" for a node no click can reveal). A `collapsedByDefault` file is
  exempt for the same reason an edge-carrying one is: the annotation is an instruction about
  how THAT node renders, and a skipped node cannot render as a chip — a `module` and a `file`
  with byte-identical annotations came out as one chip and eight loose pills. The last two
  exemptions are about the BUDGET, which only considers display nodes that have display
  children: dissolve the file level and there is no candidate left, so an edgeless
  `package > 500 file > 8 function` opened on 4,000 visible with nothing folded and
  "collapse to fit" a silent no-op, while the same graph with one `imports` per file opened
  on 596. And a file whose parent is the ROOT has only the canvas above it, so eliding it
  leaves its children with no grouping at all. A file that CARRIES an edge is drawn as a
  container, because `imports` naturally join FILES: without the exemption every such edge
  was destroyed silently, and `package > file > function` with imports between the files —
  the vocabulary above — rendered as twelve unlabelled `fn0`/`fn1`/`fn2` pills in a grid
  with no arrows and an `imports` row still in the Key. A leaf `file` in a conceptual view
  is drawn as a store.
- `annotations.<id>` IS rendered: `summary` (details panel; on the root → the
  description), `importance` 0..1 (edge stroke width), `label` (replaces the edge chip
  text), `collapsedByDefault: true` (container starts collapsed on first load of that
  graph; the user's later expand sticks), `inferred: true` (edge drawn dashed with a "?"
  and listed in the Key), `feedback: true` (typed in the schema; on the edge of a cycle you want drawn UPWARD —
  a retry/backorder loop; without it ELK picks which edge of the cycle to reverse). `metrics` show in the details panel; `attrs.scale` (1..3)
  scales a leaf's box.

## Vocabulary

Structural views: kinds `package|module|file|type|function|property` and edge kinds
`imports|contains|calls|references|conforms_to|inherits|instantiates|reads|writes`.
Conceptual views (dataflow, control flow, request lifecycles, architecture): invent
kinds — `step:`, `store:`, `queue:`, `screen:`, edge kinds like `sends`, `mutates`,
`triggers`. The viewer derives styling for unknown kinds automatically. An invented kind
still obeys the charset rule above: `[a-z][a-z0-9_]*`, so `routes_to`, not `routes-to`.

File-structure views: `node tools/fs2ir.mjs <root> [--depth N] [--max-children M]
[--sizes] -o viewer/public/live/graph.json` walks a directory into IR — `dir`
(container), `doc` (file leaf; badge hidden), `overflow` (ghost "… +N more" for
truncation — never truncate silently; the root's overflow id is `overflow:.`).
`--sizes` sets `attrs.scale` from `metrics.bytes` (1 KB → 1.0, 100 KB → 2.0, capped 2.6).
Locs are root-relative and the root node carries `attrs.absRoot` (pass `--abs-locs` for
absolute paths) — same convention as the repo-relative locs in code graphs. Symlinks
become `link` nodes (`attrs.target`), never dropped; FIFOs/sockets/unreadable dirs are
counted in the parent dir's `attrs.skipped`, which now also carries `unrepresentable` —
entries whose NAME holds a line terminator or a backslash, which no IR id or relative loc
can carry. Counted, never dropped silently. A nonexistent root or a bad `--depth` is a
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
Chrome: a dynamic **Key** (top-left, collapsible) listing exactly what is ON THE CANVAS —
one row per (kind, treatment) among the VISIBLE nodes, the kinds of the DISPLAY edges, plus
"inferred" and each delta row — ALL of them decided from the rendered objects, so a republish
that adds a node inside a collapsed container no longer puts a green "added" swatch in the
legend with nothing green on the canvas. (The status bar still reports it: that half is about
the graph, this half is about what is drawn.) It reads the rendered nodes and edges,
not the file: a legend that lists a kind sitting entirely inside collapsed containers, or an
`imports` row beside a canvas with no arrows, retires the one diagnostic that found three
separate classes of silently destroyed edge with a filter box under it (dims non-matches, shows the
count); a **title bar** (top centre: `title` or root name, `description` or the root's
summary); a **status bar** (bottom centre: source file, node/edge counts, layout state,
last poll error, delta counts). Click any node to select it (details panel with summary,
loc, attrs, metrics, importance, "Open in editor" and the server's reply); clicking a
container also collapses/expands it (the details panel has an Expand/Collapse button
too). MiniMap (bottom-right, collapsible like the Key) only up to 200 visible nodes; nodes are not draggable.
Keyboard (2026-09-10): every node is a tab stop with an accessible name
(`<kind> <name>[, collapsed]`) and `aria-expanded` on the ones that toggle; Enter/Space
selects a node and expands/collapses a container; Escape closes the details panel, except
while a text field has focus, where it belongs to the field. Edges are not tab stops.
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
must be loopback and `Sec-Fetch-Site` must be PRESENT and same-origin/none — a request with
no such header is refused, so curl and scripts need `-H 'Sec-Fetch-Site: same-origin'`; a
relative loc resolves against this
repo, `$CODEATLAS_ROOTS` (platform path-list delimiter: `:` on macOS/Linux, `;` on Windows),
or the root node's `attrs.absRoot` — honoured on any drive, so a project outside `$HOME`
works with no configuration. The result must realpath to a regular file inside one of those
roots and must not be a SYSTEM path (`/etc`, `/usr`, `/bin`, `/sbin`, `/dev`, `/System`,
`/Library` and `~/Library`; on Windows `Windows\`, `Program Files\`, `ProgramData\`,
`AppData\`) — the deny-list is applied AFTER realpath, so a symlink inside a project cannot
smuggle one in. A CLIENT-supplied `root=` must also be specific enough to bound anything:
`/`, a bare drive root, `$HOME` and any ancestor of it are dropped (`tooBroadRoot`), because
"the file must live inside the root the graph names" is the actual fence and a graph rooted
at `/` made it vacuous — `/open?file=$HOME/.zshrc&root=/` used to answer "resolvable".
`$CODEATLAS_ROOTS` and this repo are exempt: those are configured by whoever runs the
viewer, not asserted by whatever graph is on screen. The deny-list also covers the
credential directories a diagram never has a legitimate loc in (`~/.ssh`, `~/.aws`,
`~/.gnupg`, `~/.kube`, `~/.docker`, `~/.netrc`, `~/.npmrc`) — short and not exhaustive on
purpose: it raises the floor, the boundary is still "inside the root the graph names".
`~/.claude` is denied too, with the four CODE subtrees exempted (`plugins/`, `skills/`,
`agents/`, `commands/` — `deniedExceptions`). Enumerating the secrets inside it instead
was tried and was worse: it left `history.jsonl`, `settings.local.json` and
`projects/**/*.jsonl` reachable, because that list is open-ended while the exemption list
is closed. The exemption matters because the documented install puts this very checkout
under `~/.claude/plugins/…`, so `DEFAULT_ROOTS[0]` is inside the denied tree.
A root that merely HOLDS projects is refused too (`/Volumes`, `/mnt`, `/media`, `/private`,
`/srv`, `/opt`): "/Volumes" is one level below "/" and contains every mounted disk on the
machine. Every comparison FOLDS CASE **and unicode normalisation** on macOS and Windows
(`foldCase`): those filesystems are case-insensitive, macOS stores names NFD while
accepting NFC, and `realpathSync` canonicalises neither — so `root=/users`,
`/PRIVATE/etc/passwd` and an `attrs.absRoot` in the other normalisation each walked
straight through until 2026-09-10. `systemPrefixes` builds its `$HOME`-relative entries
from the REALPATH of home, because candidates are realpath'd before they are checked.
`CODEATLAS_OPEN_HOME=1` additionally allows anything under `$HOME`, and the generic opener
is never handed an executable or a run-on-open type.

## Big graphs (database scale, 2026-09-05)

The file may be huge (100k nodes / 25 MB tested); the viewer only lays out and renders
what is VISIBLE, so size is governed by what is expanded, not by the file:
- **Visibility budget** (`viewer/src/ir/budget.ts`): on first sight of a root, depth levels
  are collapsed deepest-first (every table before any schema) until ≤ 600 visible nodes and
  ≤ 800 display edges — `FASTEST_EDGES`, imported, not a third copy of the number
  (`?budget=N[,E]` overrides). Author `collapsedByDefault` and the
  user's own expands are never revisited. Status bar: "N auto-collapsed · showing X/Y". So
  author big graphs as containers (schema > table > column, module > type > member): a flat
  5,000-child container cannot be budgeted and expands to a 5,000-node view.
  Two refinements make the numbers approximate ON PURPOSE (2026-09-10) — do not "fix" a
  view that sits a little over its cap:
  - The SHALLOWEST level it touches folds only as far as it must (largest subtrees first),
    so a level can be partly folded and "N auto-collapsed" no longer implies a uniform one.
  - **The pass never folds the canvas down to a single node** (`MIN_OVERVIEW`), in either
    phase. Two earlier rules were wrong and both are worth remembering. Refusing a fold that
    hid more than HALF the view, but only within 2x a cap, inverted the product for real
    imports — the bigger the database the less of it opened, 1,200 tables showing 36 of
    10,836 display nodes and 4,000+ showing ONE, because aggregated foreign keys sit far
    past 2x the edge cap. Applying that same half-the-view rule ALWAYS fixed those and broke
    the 104k flagship: the ratio is measured against a `visible` that shrinks as a level
    folds, so the first container in a level is judged against a big denominator and the
    last against a small one, and a clean 40-schema overview (780 edges, all drawn) became
    39 chips plus one arbitrary schema exploded into 200 tables (1,648 edges, past
    `FASTEST_EDGES`, none drawn). The pathological case was never "more than half" — it is
    always "fold the last container standing and leave the canvas empty", so that is the
    only thing refused. Cap compliance yields at that point, because `layoutTier` has a
    cheaper tier for edge overflow and no tier can recover context that has been folded
    away. `DEFAULT_BUDGET.maxEdges` IS `FASTEST_EDGES` (imported from
    `ir/density.ts`, not a third copy of 800): a budgeted view stays inside the tier that
    still routes edges orthogonally, which is why the cap was NOT simply raised. A group-free 600-table
    single-schema graph therefore lands on 601 visible nodes and ~1,190 display edges —
    over both caps — rather than on the one chip it used to become, and a bucketed
    `schema2ir` import never falls below "the schema plus every bucket" (10,000 tables: 101).
  - …with ONE exception (`UNRENDERABLE`, 3,000 visible nodes, or `UNRENDERABLE_EDGES`,
    5,000 aggregated display edges — both against the LIVE counts, so a view that shrinks
    into range regains its protection): a view already too big to render gets none. A flat 4,000-table schema has no intermediate
    level, so its only two views are 4,001 chips and one — and 4,001 visible / 7,989 display
    edges measured 12.7 s to load and 29 s to drag, at 2.0 edges per node, so not even dense
    enough for the hairball path to save it. A chip the user opens deliberately beats a view
    that cannot be moved. This is why the advice above is to author big graphs as
    CONTAINERS: a flat container cannot be budgeted. An explicit `?budget=` of 1 or 2 IS honoured — by
    `keepsEnough` (half a budget is then ≤ 1, and a fold always leaves the container it
    folded), not by a special case: two dedicated escapes used to sit in `refuseFold` for
    exactly that and BOTH were dead code, which is how the behaviour came to be
    mis-attributed here. From 3 up the proportional ceiling takes over and has no escape,
    so a graph whose only fold leaves almost nothing (a flat 1,499-table schema) returns
    1,500 for any larger budget: the request is about size, the guard is about usefulness,
    and "collapse to fit" is what forces it.
  - BOTH phases are additionally proportionate (`MOST_OF_A_VIEW`): no single fold may hide
    more than half of what is on screen as its LEVEL begins — unless what it LEAVES is
    still half a budget, which is never gutting however much it hides. Read it as a bound
    on ONE fold, never on what a level hides in total: for k roughly equal siblings each
    fold passes on its own and the level still folds whole, so two 200-file directories
    with 2,394 references between them open on two chips and the `references x587` edge
    each way. That is the intended answer — the same one `db(2,700,6)` gives — and better
    than the half-folded alternative (one chip beside 200 exploded files, 933 display edges,
    still a hairball so not one of them drawn). The floor that IS absolute is
    `MIN_OVERVIEW`. (Reading the guard
    as a ratio on what GOES rather than on what REMAINS made two extra files flip a root
    of 599 loose leaves beside a 601-file directory from 600 visible to 1,201.) "Leave at least two" is
    no protection for a SKEWED graph where one container holds nearly everything — real
    `tools/fs2ir.mjs` output for a directory with 610 generated files beside three source
    files folded 99.3% of itself away to get 16 nodes under a 600 cap and opened on SIX.
    And in the edge phase the node budget is already met, so every further fold buys edges
    with context the view will not get back, while `layoutTier` has a cheaper tier for edge
    overflow: without a ceiling it folded the last expanded schema of a 1,500-table
    3-schema database (500 tables) to take 837 aggregated edges under a cap of 800.
    A level there also STOPS once it has refused a container and folding what is left
    cannot reach the cap: 290 files beside 10, 2,990 display edges, used to fold the small
    directory — ten nodes hidden, four edges removed, the view still 3.7x over the cap and
    still a hairball, so zero SVG paths either way. Measured what folding would LEAVE
    rather than treating a refusal as the end of the level, because both happen: one
    350-file package with no references beside four dense 15-file ones folds the four and
    lands on 370 visible / 684 edges with the big package still open. The check is
    deliberately not made before the first fold — `bucketed(10000,8)` and the 104k flagship
    both leave the node phase on a half-folded level whose fold cannot reach the cap either
    (4,666 and 780 edges), and finishing that level is exactly right: 100 uniform bucket
    chips beat 96 chips plus four exploded buckets.
    The denominator is the count at LEVEL start — not per sibling (the number would shrink
    as the level folds, judging the first container against a big one and the last against
    a small one, which is what left the 104k flagship as 39 chips and one arbitrary schema
    exploded) and not per PHASE either (a phase-wide constant only bounds the FIRST level
    it touches, so a tree with two container levels lost the guard at the shallow end and a
    real 2,084-node fs2ir run opened on FOURTEEN). A tiny explicit `?budget=` is honoured
    through `keepsEnough`, as described above — not by an escape of its own — and the
    ceiling is switched off entirely above `UNRENDERABLE` — 3,000 visible, the size at which this project's own measurements say
    a view stops being usable (1,005 loads in 1.1 s and pans in 250 ms, 2,010 in 2.0 s /
    0.7 s, 4,020 in 7.6 s with multi-second pans). That number was 1,500, below anything
    unrenderable, and because the check bails out BEFORE measuring while the LARGEST
    container in a level is judged first, that container was exactly the one that escaped
    the guard: a real fs2ir tree of 1,600 generated files opened on SIX of 1,606, with no
    render warning and nothing to recover with. Any threshold is a cliff when the only
    available fold is all-or-nothing; this one now sits where the alternative is genuinely
    unusable rather than merely large. The EDGE half exists because `UNRENDERABLE` counts
    nodes while the cost lives on edges, and the only above-guard fixtures (`lumpy`,
    `nested`) have none at all: `db(1,2999,8)` — 3,000 visible, 5,987 display edges, 2.0
    per node so not even dense — measured 8.3 s to load and 6.5 s to drag from INSIDE the
    node guard, slower than the 4,020-node case that defines unusable. `UNRENDERABLE_EDGES`
    is set clear of `db(3,500,6)`'s ~3,000, which must stay protected, is the larger of
    itself and the caller's `maxEdges` (so `?budget=600,1000000` means what it says), and
    NEVER fires on a hairball: past `FASTEST_EDGES` at more than `DENSE_RATIO` edges per
    node the viewer draws no SVG paths at all, so the view is cheap however many edges it
    has — 616 nodes with 6,120 display edges loads in 2.6 s and pans in 328 ms. Without
    that check the guard folded exactly the views the hairball economy had just made free
    (that 616-node tree → SIX), while an identical-cost 4,194-edge one kept all 701.
    NOTE for anyone re-tuning this: each fixture in `viewer/tests/fixtures.ts` exists
    because the previous one could not express the bug. `db()`/`bucketed()` have UNIFORM
    siblings and cannot express skew at all; `lumpy()` is skewed but DEPTH-2, so a stale
    ceiling can never show up in it; `nested()` is depth-3; and none of those three has
    EDGES, so an edge-driven threshold could not be tested with any of them until
    `budget.test.ts` grew skew-with-edges and flat-foreign-key generators. Every `db()`
    graph sits at exactly 2.0 edges per node — below `DENSE_RATIO` — so no `db()` fixture
    can reach the dense/hairball quadrant at all. Every documented operating
    point below stayed green through both of those failures.
  - Levels an earlier pass collapsed stay uniform for newcomers, and are guarded too. They
    used to fold unconditionally — the decision "had already been guarded" — but the graph
    on a later poll is not the graph that was judged, so an 841-node follow-up under the
    same root came back as ONE node and the invariant above was untrue on every poll but
    the first — and only records a level it actually finished, like the two phases below.
  - Across POLLS, the budget's own decisions are re-derived rather than inherited
    (`applyDefaults` in `store.ts`): a pass is run with the carried budget state released,
    and whichever shows more wins. Carrying it meant a refinement published under a stable
    root — the loop this manual tells authors to use — was folded by the PREVIOUS view's
    shape: an 841-node follow-up after a 10,803-node one opened on 1, 2, 3 or 18 nodes
    depending on how many of its top-level containers the old view happened to have
    collapsed, where the same graph on its own shows ~597. The author's
    `collapsedByDefault`, the user's own collapses, the containers the user has since
    EXPANDED, `collapse to fit` (`userFitted`) and any container the user DELIBERATELY
    collapsed (`userCollapsed` — an id the budget once chose stays in `autoChosen` for as
    long as it exists, so without this a later user click looked exactly like stale budget
    state) are all exempt: only guesses are re-derived. The author-default loop runs INSIDE
    each pass, after the release, or a `collapsedByDefault` arriving on the same poll was
    skipped (the id was still in `defaulted`) and then released, taking effect a poll late.
    Cost: a second budget pass per republish that has carried state — about +150 ms on the
    90k-node flagship. Twice fixed by testing a floor on the visible count, and twice the test
    used the one follow-up shape that lands on exactly one node: the store-level matrix in
    `store.test.ts` now covers six follow-up widths against three previous views.
  "Collapse to fit" is the user asking explicitly, so it overrides the refusal (`force`) —
  otherwise the button was a no-op in exactly the band where the render warning offers it.
  Keeping the root id stable across refinements is safe: a four-node follow-up under a big
  view's root renders expanded, because the re-derived pass above shows more than the carried
  one and wins. There used to be a SECOND release for this, keyed on "the graph cannot exceed
  the budget" — it was dead (removed 2026-09-11), and two rounds of bug-fixing went into it
  before anyone noticed, because the same two bugs were also fixed in the live release.
- **Layout tiers** (`layoutTier` in `elk.ts`): quality (≤ 400 nodes and ≤ 400 edges:
  network-simplex placement, orthogonal routing, ELK inline labels + label pass) · fast
  (≤ 1,500 nodes, ≤ 800 edges: longest-path layering, simple placement, thoroughness 1) ·
  fastest (above that: polyline routing, containers laid out SEPARATELY so cross-container
  edges are plain curves, chips at midpoints). **Dense** views (> 200 edges and > 3 edges per
  visible node — `isDense`/`isHairball` in `viewer/src/ir/density.ts`, the ONE definition,
  shared by the layout engine, the visibility budget and the incremental splicer) give ELK
  no edges at all: nodes fold into a grid and edges are drawn faint
  until a node is selected (`ElkEdge` reads the selection; no chips on faint edges — the
  details panel lists the selected node's edges with counts instead, ordered by the edge's own
  `count` — never by scraping "×N" back out of the rendered chip, which an author's
  `annotations.<edge>.label` replaces outright: the showcase graph's heaviest connection
  sorted last). Past `FASTEST_EDGES`
  (800) a dense view is a **hairball** and the faint cloud is not drawn at all until
  something is selected: every edge costs TWO SVG paths (`BaseEdge` adds an interaction
  path), so the 100-bucket overview of a 10,000-table import was 9,388 edges = 18,776 paths
  and 2.6 s per pan; at that density the cloud is mush, not texture, and hiding it takes the
  pan to 203 ms. A newly-ADDED (delta) edge is drawn anyway, at full opacity with its
  marker — it is the one thing a delta view exists to show, and rare by definition.
  What counts as traced is `crossesSelection` (`store.ts`) — an edge with exactly one end
  inside the selection, plus a self-loop inside it (recursion). The canvas, the status-bar
  count and the details panel all key off that ONE function, so they cannot disagree
  (measured: 9,201 hidden + 394 drawn = 9,595 total). Whether an edge puts any SVG on the
  canvas at all is `edgeIsPainted`, shared the same way: the canvas used the edge's own
  `data.hairball` and the status bar used `layoutMode.hairball`, two sources that can
  diverge (measured after unifying: 462 hidden + 480 drawn = 942 total, in the browser). Two weaker rules were tried and both
  broke: matching the selected id alone lit nothing at all, because clicking a container
  expands it and an expanded container is no longer an edge endpoint; matching "either end
  is in `litIds`" lit EVERYTHING when the selection was a top-level container, because
  `litIds` is the node plus its whole subtree — two clicks then switched the hairball
  economies off, drew 5,397 edges and took a pan from 133 ms to 1,394 ms.
  KNOWN GAP: edges INTERNAL to the selection are neither drawn nor listed, so opening a
  bucket in a hairball view shows its tables with no foreign keys between them (measured:
  272 crossing drawn, 84 internal invisible). Select one of the tables to see those. The
  obvious generalisation — "or joins two visible children of the selection" — is what puts
  the whole graph back on screen when the selection is the top container, so it is a
  deliberate gap rather than an oversight. Containers with > 12 visible
  children use MIN_WIDTH layering (bound ≈ 0.95·√k), so 200 tables are a block, not a
  30,000 px row. `LayoutResult.mode` reports tier/dense/hairball/heavy.
- **Render guard**: above 800 VISIBLE nodes the status bar warns and offers "collapse to
  fit", which re-applies the budget to the current view (targeting the smaller of the
  budget and the guard, so it still helps when `?budget=` was raised, and overriding the
  anti-gutting refusal). It is NOT always able to help: `force` overrides a REFUSAL, it
  cannot invent a candidate, so on a level that is flat under the root — 900 loose files
  beside one directory, what `fs2ir` emits for a data folder — the automatic pass has
  already folded the only container and nothing is left to fold. The click then changes
  nothing at all; it used to relayout anyway and throw away wherever the user had panned. The automatic pass never revisits a
  container the user opened — undoing their click would be hostile — so this is the
  on-demand form of PROJECT_SPEC §3(C)/N4's forced-collapse cap.
- **Polling** is conditional (ETag → 304; `/live` cap 256 MB): an unchanged 25 MB graph
  costs one 304 per second. **Search** counts matches inside collapsed containers ("+N
  hidden") and keeps their container lit. Above 800 visible nodes node shadows are dropped
  (`atlas-big`) — panning is paint-bound.
- Measured (headless Chromium, software rendering, synthetic schema/table/column graphs with
  two hashed foreign keys per table): 104k nodes → 40-schema overview in 0.7 s, expanding a
  200-table schema 1.7 s; 603 visible tables: load 0.9 s, pan 93 ms; 1,005: 1.1 s / 250 ms;
  2,010: 2.0 s / 0.7 s; 4,020 (budget overridden): 7.6 s and multi-second pans — the budget
  exists so nobody lands there. Benchmark aids: `?budget=`, `?culling=0`; the generators are
  `db()` (schema > table > column) and `bucketed()` (the shape schema2ir really emits:
  schema > group > table > column) in `viewer/tests/fixtures.ts` — a plain module, NOT a
  test file, because importing one re-registers its describe blocks in the importer and the
  budget suite was silently running four times per `npm test`.
  Budget operating points, measured 2026-09-10 (visible / total display nodes). Through the
  REAL `schema2ir` pipeline, single schema, 8 columns and 2 hashed foreign keys per table —
  the floor is "the schema plus every bucket" (buckets ≈ √tables), never one chip:
  4,000 tables → 64 / 36,064 (load 0.7 s, pan 100 ms) · 10,000 (43 MB, 90k nodes) → 101 /
  90,101 (load 1.6 s, pan 203 ms). Hand-authored container shapes: `db(40,200,12)` (104k
  nodes) → 40 / 104,040 with all 780 edges DRAWN, load 0.9 s, pan 102 ms — the flagship
  overview · `db(3,200,12)` → 403 / 7,803, 673 edges · `db(1,600,8)` → 601 / 5,401, 1,191
  edges · `db(1,1200,8)` → 1,201 (over the render guard; the alternative is one chip) ·
  `db(1,4000,8)` → 1 (past `UNRENDERABLE`) · `db(3,500,6)` → 503 / 10,503 with 837 edges,
  over the edge cap on purpose. Skewed, depth 2 (`lumpy`): `[610,2,1]` → 613 / 616 ·
  `[300,300]` → 302 / 602. Skewed, depth 3 (`nested`, a codegen tree):
  `(690,2,[10,1])` → 693 / 2,084 · `(1000,1,[10,1])` → 1,003 / 2,014 ·
  `(340,2,[10,1])` → 600 / 1,034. Skewed above the render guard: `lumpy([1600,2,1])` →
  1,603 / 1,606 · `[2500,2,1]` → 2,503 / 2,506 · `[3500,2,1]` → 6 (past `UNRENDERABLE`).
  Containers and leaves mixed at one level (`mixed(loose, big)` in `budget.test.ts`):
  `(599,601)` → 600 / 1,201 · `(400,500)` → 401 / 901. Both measured in the browser against real `fs2ir` output:
  610 flat generated files → 613 / 616, and 690 generated module dirs → 693 / 2,084.
  The pass itself is
  linear in depth levels (its counts are maintained incrementally): a 10k-deep chain went
  1.5 s → 19 ms, a 20k-deep one 5.7 s → 26 ms.
- **Incremental relayout** (`viewer/src/layout/incremental.ts`): when one container is
  toggled and the last full pass was expensive (> 300 ms or > 400 visible nodes), only that
  container's subtree goes through ELK; it is spliced into the previous layout, neighbours
  are pushed only as far as needed (never pulled back — gaps are harmless, overlaps are
  not), ancestors grow, routed edges whose endpoints did not move keep their polylines and
  the rest become plain curves. The status bar says "approximate layout · tidy"; tidy runs
  a full pass. Unchanged React Flow node/edge objects are reused across passes so React
  Flow skips their DOM. Measured (headless): a toggle in a routed 302-table view 1,003 ms →
  198 ms. The path is chosen by cost (`INCREMENTAL_MIN_MS` / `INCREMENTAL_MIN_NODES`) with a
  FLOOR on size (`INCREMENTAL_MIN_VISIBLE`, 150) — nothing consults `mode.dense`, so a dense
  view above that size is spliced like any other. (The 40-schema dense overview of a
  104k-node file is NOT an example any more — 40 visible nodes is below the floor, so it
  takes the full path, measured 193 ms; `?incremental=1` still forces a splice there.) The floor exists because a full pass over a handful of nodes
  is cheap by definition: one slow measurement used to be enough to answer the FIRST collapse
  of the 18-node showcase with an approximate layout (overlapping chips, edges cutting through
  pills) on ~20% of fresh loads, and `fullMs` is carried forward, so it stayed that way until
  "Tidy". `warmElk()` now also runs a throwaway layout, so the first real measurement is a
  warm one — the ELK worker JITs its algorithm on its FIRST job, which `layoutMs` was still
  counting even though it already excluded engine construction.
  The mini layout of the toggled subtree makes its OWN tier/density decision, so a subtree
  spliced into a dense or fastest-tier view can come back orthogonally routed with inline
  chips until "Tidy". `?incremental=0|1` forces the path for benchmarking.
- Database kinds have fixed hue slots (`database|schema|table|column|index|trigger|procedure`,
  plus `group` for schema2ir's name-range buckets).
- **Platforms**: everything shipped is Node ≥ 20 and portable across macOS, Linux and
  Windows; `CODEATLAS_ROOTS` uses the platform path-list delimiter; "Open in editor" has
  per-platform defaults. CI runs the viewer, tools and schema suites on a
  ubuntu+windows matrix, plus a `package` job (manifest versions agree, every shipped graph
  validates, no personal paths, shims runnable), an `audit` job and a Windows shim check;
  hands-on Windows 11 passes were run on 2026-09-07 (0.2.0) and 2026-09-12 (0.3.0, this
  tree). Windows specifics: `code` on PATH is
  `code.cmd`, so an editor command that resolves to a batch file runs through `cmd.exe`
  (`spawnDetached` in `viewer/vite.config.ts`); npm test scripts must double-quote globs
  (cmd.exe keeps single quotes and `node --test` then runs zero tests with exit 0 — CI now
  fails a suite that reports zero tests); a dynamic `import()` of a repo file must be a
  `file://` URL (`new URL("../x.mjs", import.meta.url).href`), never a bare absolute path —
  the ESM loader rejects `C:\…` with "Received protocol 'c:'", which is how `schema2ir`'s
  self-check silently never ran on Windows until 2026-09-12; test-only directory links use
  `symlinkSync(…, "junction")` on win32 (no privilege needed); vite refuses to serve any path
  containing `~` on Windows (8.3 short-name hardening), so a test that copies the viewer
  under TEMP expands the path with `realpathSync.native` first — GitHub's runner keeps TEMP
  under `C:\Users\RUNNER~1` and served nothing on the first CI run; file symlinks skip without
  Developer Mode or elevation, FIFO tests skip, the unreadable-dir test uses `icacls`; and a
  fence test that injects a foreign `os` can only assert what the HOST's `node:path` can
  express (win32 `relative()` folds case whatever `os` says), so case-SENSITIVE assertions
  are guarded off Windows the way the win32 ones are guarded off POSIX.
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
draft), waits for `.react-flow__node` + ~2.5 s settle, optionally collapses containers
(idempotent: a container already collapsed — by `collapsedByDefault` or by the budget — is
left alone and says so, because the click is a TOGGLE and used to EXPAND it while still
reporting "(collapsed: …)"; the click is DISPATCHED on the chip rather than aimed at it,
because the app's own chrome — the details panel a previous click opened, the Key, the
MiniMap — floats over the canvas and a real click underneath any of them waits out its
timeout and kills the run; and the resulting state is VERIFIED, since a tool that reports
success without acting is the defect this has now had twice), and writes a 1600×1000 @2x
full-page png. Iterate: edit viewer source (vite
HMR) or `live/graph.json` → shot → Read the png → compare against references → adjust.
This is how style changes get verified — never claim a visual change works without a
shot of it. `shot.mjs` waits for the viewer to SETTLE and then asks what it settled on,
rather than matching status-bar phrases: a graph on screen is shot, a viewer that never got
a graph or reports an error (`.status.error`, which covers an ELK timeout too) exits 1 with
the reason after an ~8 s grace, and a graph with no display nodes — a root-only `fs2ir` run
over an empty directory, where the root IS the canvas — is shot as the empty view it is
rather than waited out for two minutes. `shot.mjs` and any Playwright script you write must use
`waitUntil: "domcontentloaded"` and then wait for `.react-flow__node` and for `.busy` to
clear — the 1 s poller means `networkidle` only ever settles in the gap between two polls.

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
The version lives in BOTH manifests and they must stay equal — bump them together on every
shipped change (currently 0.3.0). `claude plugin validate` does NOT check this; CI's
`package` job and `tools/test/manifests.test.mjs` do.
Shipped components — keep them portable (no personal paths, no macOS-only assumptions
without a fallback, every plugin path via `${CLAUDE_PLUGIN_ROOT}`):

- `skills/codeatlas/SKILL.md` — the end-user version of THIS manual (the loop, IR
  essentials, honesty rules, view design); invoked automatically on diagram questions or
  as `/codeatlas:codeatlas <question>`. Keep it in sync with the sections above when the
  contract or the viewer changes. `skills/viewer/SKILL.md` — `/codeatlas:viewer
  start|stop|restart|status|open|paths`.
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
  Verbs: `start|stop|restart|status|open|paths|install|publish`. `publish <draft> [--to
  <name>]` validates a staged graph with `schema/validate.mjs` (imported as a `file://`
  URL) and renames it over `LIVE_DIR/<name>.json` (default `graph`) in one step — the
  skill's publish step, because Claude Code refuses `mv` outside the project; an invalid
  draft exits 1 and stays put, usage exits 2. `stop` verifies the pid is still a
  vite before killing (`taskkill /T` on Windows); `status` exits 1 when down; `restart`
  stops THIS launcher's instance and starts it again — the only way a `node_modules` change
  from a plugin update reaches a running viewer, and it refuses (exit 2) rather than kill a
  viewer the launcher did not start. `start` and `status` print a NOTE when the viewer's
  dependencies changed since it started, pointing at `restart`. A dependency update that
  cannot complete keeps the working install and records it, so both warn that the viewer is
  running stale packages until `install` succeeds. `start` is serialised by an exclusive
  start lock, so two concurrent starts (the codeatlas skill and the viewer skill, or two
  sessions) no longer race for the port or run `npm ci` on top of each other. Deps install
  with `--omit=dev` — what a user runs is vite, never vitest/typescript, and it is the tree
  CI audits. The data dir (`~/.codeatlas`, forced 0700) holds `live/`, the pidfile, the log,
  the stop script, `viewer.state.json` (what the running instance was started with) and,
  transiently while a start runs, `start.lock`. Graphs live OUTSIDE the plugin so an update
  never deletes them. Tested end to end in `tools/test/launcher.test.mjs`.
- Skills must NOT declare `allowed-tools` (verified 2026-09-05, Claude Code 2.1.261): with
  it, the `Skill` call itself becomes a permission gate ("Execute skill: codeatlas:viewer"),
  which `-p` denies outright and interactive mode would prompt for on every question. Let
  the Bash calls prompt normally instead. `${CLAUDE_PLUGIN_ROOT}` and `$ARGUMENTS` do
  expand in the skill body.
- `viewer/package.json`: vite and `@vitejs/plugin-react` are **dependencies**, not
  devDependencies, deliberately — the daemon this plugin ships and runs IS vite, so the
  production tree is what users execute and what the audit gate has to cover. Moving them
  back to devDependencies silently makes both the launcher's install and the CI audit
  vacuous (before this, `npm audit --omit=dev` reported "0 vulnerabilities" for a viewer
  tree that carried two high advisories).
- Check before shipping: `claude plugin validate .` (add `--strict`) — a MANUAL step, not in
  CI, which would need the Claude Code CLI on the runner. Then `cd viewer && npm
  test`, `cd schema && npm test`, `cd tools && npm test`; try it as a stranger with
  `claude --plugin-dir /path/to/this/repo` from some other project (headless smoke test:
  `claude --plugin-dir <repo> --allowedTools 'Bash("<repo>/bin/codeatlas-viewer" *)' -p
  "Use the /codeatlas:viewer skill with argument 'status'"` — the skill QUOTES the path, so
  the pattern must too; the unquoted form matches nothing and every call is denied. Write
  `<repo>` with forward slashes, which is how `${CLAUDE_PLUGIN_ROOT}` expands on Windows
  as well. Verified 2026-09-12 on Windows with a logged-in CLI: the Skill call is not gated,
  the POSIX shim runs from Claude Code's Git Bash, and a real "map this codebase" from a
  foreign project staged, validated and published — except that the skill's then-`mv`
  publish was refused by Claude Code's own directory fence (the live dir is outside the
  project), so the session fell back to writing `graph.json` directly. That is why the skill
  now publishes with `codeatlas-viewer publish`, see "The loop"). CI also runs an `audit` job
  (`npm audit --audit-level=high --omit=dev` in `viewer/` and `schema/`; `tools/` is a dev
  tree and is audited whole) and the workflow runs weekly on a Monday cron — the five test
  jobs carry `if: github.event_name != 'schedule'`, so the weekly run is audit-only.
  `.github/dependabot.yml` is the half that produces the fixing PR.

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
- **Audits**: audit reports and work logs are not kept in this repo — never add them under
  `docs/`. The CI `package` job refuses home and profile paths in shipped files.
- Personal conventions live in `CLAUDE.local.md`, which is gitignored — never put them
  here; this file ships with the plugin.

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
