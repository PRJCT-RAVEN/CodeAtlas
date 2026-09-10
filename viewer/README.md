# CodeAtlas viewer

Local web viewer for Graph IR files. React Flow v12 + elkjs (ELK layered layout,
orthogonal edge routing, ELK-placed edge labels; ELK runs in a Web Worker).

```sh
npm install
npm run dev      # http://localhost:5173 — polls public/live/graph.json every second,
                 # falls back to public/sample-graph.json only when live/ is absent
npm run test     # vitest: layout, routing, shape guard, delta, /open gate
npm run build    # type-check + production build (dist/)
```

Hands-free: `../tools/serve.sh` (or the launchd agent from `../tools/install-launchd.sh`)
keeps this dev server up; Claude sessions write `public/live/graph.json` (see ../CLAUDE.md).
A draft can be previewed without touching the live view at `/?graph=<name>`
(polls `public/live/<name>.json`).

Interactions: click any node for the details panel (summary, loc, attrs, metrics,
"Open in editor" — the server's reply is shown); clicking a container also
collapses/expands it (or use the panel's Expand/Collapse button); the filter box under
the Key dims non-matching nodes; pan/zoom; minimap up to 200 visible nodes.

Display conventions: the root node is the canvas; `file` nodes are hidden only when
they group other nodes; `contains` renders as nesting, never as
arrows; edges into collapsed containers re-route to the container and aggregate with
`×N` labels; self-loops are drawn; read-family edges (`reads|polls|queries…`) are laid
out with the data source ABOVE the reader while the arrow keeps the authored
direction. `annotations` are rendered (summary, importance → stroke width, label,
collapsedByDefault, `inferred` → dashed + "?"). A graph that fails the structural guard
(`src/ir/shape.ts`) never replaces the last good one — the status bar names the problem.
Positions persist per view root (localStorage + ELK order hints), and a same-root
refresh highlights added (green) / modified (amber) nodes.

`GET /open?file=&line=[&root=][&dry]` (vite middleware in `vite.config.ts`) opens a loc
in Xcode (`xed -l`, fallback `open`): loopback Host + `Sec-Fetch-Site` same-origin/none
required; relative paths resolve against this repo, `$CODEATLAS_ROOTS`, or `root=` when
that is under `$HOME`; the result must be a regular file under one of those or `$HOME`.
