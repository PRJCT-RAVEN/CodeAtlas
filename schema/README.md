# CodeAtlas IR schema & validator

`ir.schema.json` is the Graph IR **v0.2** contract (spec §4) between graph producers
(Claude sessions, `codeatlas analyze`, `tools/fs2ir.mjs`) and the viewer. `irVersion`
`"0.1"` documents remain valid.

## Usage

```sh
npm install                                        # once
node validate.mjs <graph.json>...                  # validate one or more full IR documents
node validate.mjs --patch <patch.json>...          # validate abstraction-agent patches (spec F6)
node validate.mjs --quiet <graph.json>             # exit code only
npm test                                           # node --test test/
```

Exit codes: `0` every file valid · `1` at least one file invalid · `2` usage error.
Errors are one line each and name the offending id.

## What v0.2 changed

- `loc.col` optional (defaults to 1; the viewer opens `file:line`).
- `attrs.typeKind` is any string or null (was a fixed Swift enum); documented
  `attrs.absRoot`, `scale`, `isCase`, `skipped`; `attrs` stays open.
- `edge.count` allowed without `locs` (multiplicity of a conceptual edge); when both are
  present they must agree.
- Top-level optional `title` and `description` (shown by the viewer).
- Annotation keys documented: `summary`, `importance` (0..1), `label`,
  `collapsedByDefault`, `inferred` (boolean, edges). Extra keys still allowed.

## Semantic checks (full-IR mode, beyond JSON Schema)

| Check | Error message shape |
|---|---|
| node ids unique | `duplicate node id: <id>` |
| edge ids unique | `duplicate edge id: <id>` |
| cluster ids unique | `duplicate cluster id: <id>` |
| root present | `root <id> not present in nodes` |
| exactly one parentless node, and it is the root | `exactly one node (the root <id>) may omit parent; found N (<ids>)` |
| parent resolves | `node <id> has unknown parent <id>` |
| parent chain acyclic | `node <id> is its own parent` · `parent cycle: a -> b -> a` · `parent chain of <id> enters a cycle at <id>` |
| parent chain ends at root | `parent chain of <id> ends at <id>, which is not the root <id>` |
| `contains` agrees with `parent` | `contains edge <eid> but <id>.parent is <id\|absent (root)>` |
| every parent link mirrored | `node <id> has parent <id> but no mirrored edge e:contains:<p>-><id>` |
| edge endpoints resolve | `edge <eid>: unknown from <id>` · `edge <eid>: unknown to <id>` |
| edge id = `e:<kind>:<from>-><to>` | `edge id mismatch: <eid> ≠ <expected>` |
| `count` vs `locs` | `edge <eid>: count=N but locs.length=M` (count without locs is fine) |
| sorted by id, UTF-8 byte order | `nodes\|edges not sorted by id (UTF-8 byte order) at index i: "a" >= "b" (spec N2)` |
| cluster members resolve | `cluster <cid>: unknown member <id>` |
| annotation keys resolve | `annotation for unknown id: <id>` |

Sorting uses `Buffer.compare` on UTF-8 bytes — every producer must use the same order.
JavaScript's default string comparison is UTF-16 code-unit order and differs for astral
characters (emoji sort before U+E000–U+FFFF in UTF-16 but after them in UTF-8).

Patch mode enforces spec F6: agent patches may only contain `clusters` and `annotations`;
any patch touching `nodes` or `edges` is rejected, and non-object JSON is reported
INVALID rather than crashing.

## Conventions

- ID prefixes: `package:` `module:` `file:` `type:` `func:` `prop:` (short forms for
  function/property); conceptual views may use any lowercase prefix (`step:`, `store:`, …).
- Hierarchy: `parent` + mirrored `contains` edges for every parent link; the viewer renders
  them as nesting, not arrows.
- File node IDs use package-root-relative paths: `file:Sources/Tiny/App.swift`.
- `loc` is 1-based line (and optional col) at the start of the declaration syntax node (or
  the call site for edges). Paths are repo-relative (root node `attrs.absRoot`) or absolute.
- Function IDs include the full selector: `func:Tiny/ConsoleGreeter.greet(name:)`.
- Exactly one node (the root) omits `parent`.
