# CodeAtlas — Live Code Diagram Tool

Project specification v0.1 — 2026-07-18. Intended audience: coding agents and the project owner. This document was the source of truth for R&D phase 1.

> **Historical document.** Kept for the reasoning behind the Graph IR, the accuracy rules
> and the verification strategy — not as a description of what ships. Two things have since
> changed:
> 1. **v0.2 pivot (2026-07-24):** Claude is the primary graph producer; §3(B)'s
>    "abstraction agent" patch model applies only to an optional automated annotation pass.
> 2. **The Swift analyzer was cut (2026-09-10)**, before the first release. Component
>    §3(A) (`codeatlas analyze` / `serve`, SwiftSyntax + IndexStoreDB), the `fixtures/`
>    golden packages and the requirements that depend on them (F1–F3, N1, and the
>    analyzer half of §7) are no longer implemented. Nothing shipped reached it, and it
>    was costing a macOS CI job and a steady sync tax. The source is archived outside the
>    repo.
>    Mechanical graph production is now `tools/fs2ir.mjs` (directory trees) and
>    `tools/schema2ir.mjs` (database schemas).
>
> For what actually ships, read [`CLAUDE.md`](CLAUDE.md), [`README.md`](README.md) and
> [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md).

## 1. Vision (revised v0.2 — Claude-first)

Generate accurate, live-updating 2D diagrams (control flow, data flow, module architecture) from source code, driven conversationally. **Claude is the primary graph producer**: the user asks a question, Claude reads the code and emits a Graph IR view that answers it; the viewer renders it live within ~1s. Rendering, layout, and validation are hard-coded; deciding *what to draw* is Claude's job (see CLAUDE.md — the operating manual for sessions driving the viewer).

**Core principles:** the LLM never lays out or paints — the layout engine positions, the renderer draws. And every element referring to real code carries a verified `loc` (file:line) as the audit trail. *(As shipped: the compiler-verified analyzer this paragraph refers to was cut; the audit trail is now the verified `loc` plus explicit `inferred` marking for anything not read from the source.)*

*(v0.1 framing — analyzer as sole producer, LLM restricted to annotation patches — is superseded; the F6 patch restriction still applies to the optional automated annotation pass, not to Claude-authored views.)*

## 2. Goals

- G1: Point the tool at a Swift package/Xcode project, get a correct module/type/call diagram in the browser.
- G2: Every edge in every diagram is traceable to a verified source location (zero hallucinated edges).
- G3: Live updates — re-running after a code change produces a minimal visual delta: unchanged nodes keep positions, changes are highlighted.
- G4: Click a node → jump to source (file:line).
- G5: Diagrams at multiple abstraction levels: package → module → type → function, drill-down on demand.

### Non-goals (phase 1)

- 3D rendering (design the graph schema so a 3D view can be added later; do not build it).
- Languages other than Swift.
- Runtime/dynamic tracing (static analysis only).
- Hosted/multi-user product features, auth, collaboration.
- Sequence/UML class diagrams beyond what falls out of the graph naturally.

## 3. Architecture

Three components communicating through one contract: the **Graph IR** (JSON).

```
[Swift codebase]
      │
      ▼
(A) Analyzer CLI  — Swift executable: SwiftSyntax + IndexStoreDB
      │  emits Graph IR (graph.json) + delta (changes.json)
      ▼
(B) Abstraction agent — Claude via Agent SDK (optional pass)
      │  enriches Graph IR: clusters, labels, summaries; may NOT add/remove edges
      ▼
(C) Viewer — local web app: React Flow + elkjs, position persistence
```

### (A) Analyzer CLI — `codeatlas analyze`

- Language: Swift. Dependencies: **swift-syntax** (parsing/AST), **IndexStoreDB** (compiler-verified references, call graph, type relations), SwiftPM libSwiftPM or plain target enumeration for module structure.
- Requires a build to exist (index store at `.build`/DerivedData). Command flag `--index-store-path`; auto-detect for SwiftPM and Xcode defaults.
- Extracts:
  - Nodes: packages, modules/targets, files, types (class/struct/enum/protocol/actor/extension), functions/methods, properties.
  - Edges: `imports`, `contains`, `calls`, `references`, `conforms_to`, `inherits`, `instantiates`, `reads`/`writes` (property-level data flow, best effort).
- Every node/edge carries `loc` (file, line, col) and a **stable ID** (see §4). Determinism requirement: same input ⇒ byte-identical output (sorted keys, sorted arrays).
- `codeatlas analyze --diff <old-graph.json>` emits `changes.json` (added/removed/modified node and edge IDs).
- Performance target: ≤10s cold on a 100-kLOC package, ≤2s incremental (analyze only files changed since last run, merge into cached graph).

### (B) Abstraction agent

- Runs Claude (Agent SDK or `claude -p`) over the Graph IR, not over raw source (raw source only for summarization snippets).
- Allowed outputs, written into IR `annotations`: cluster assignments (grouping nodes into named subsystems), human-readable summaries per node/cluster, suggested default view (which level, which clusters collapsed), edge importance ranking (for decluttering).
- **Hard rule enforced by a validator:** the agent's output is a patch that may only touch `annotations` and `clusters`. A schema validator rejects any patch touching `nodes`/`edges`. This is the accuracy guarantee.
- Phase 1 can stub this component (mechanical clustering by directory/module) — the pipeline must work without it.

### (C) Viewer — local web app

- Stack: **React + TypeScript + Vite**, **React Flow** (rendering/interaction), **elkjs** (ELK layered layout, `elk.layered` with `org.eclipse.elk.interactive`-style incremental options), **Zustand** or equivalent for state.
- Served by `codeatlas serve` (small static server + file watcher; re-run analyzer on change or accept `--watch` mode; push updates over WebSocket).
- Features (phase 1): render graph at chosen level; expand/collapse clusters and containers; pan/zoom; click node → open in editor (`vscode://` and `xed://` URL schemes, configurable); search/filter by name/kind; delta highlighting (added = green, removed = ghosted red, modified = amber) with a change list panel.
- **Layout stability:** persist node positions keyed by stable ID (localStorage per project + optional `layout.json`); on update, pin unchanged nodes, run ELK incrementally for new/changed nodes only; animate transitions.
- Rendering perf target: 60fps interaction at 500 visible nodes; virtualize/cull beyond viewport; never render more than ~800 nodes at once — force collapse instead.

## 4. Graph IR schema (the contract)

Version the schema (`irVersion`). Draft v0:

```jsonc
{
  "irVersion": "0.1",
  "generator": { "tool": "codeatlas", "version": "0.1.0", "commit": "<analyzed repo commit>" },
  "root": "module:MyApp",
  "nodes": [
    {
      "id": "func:MyApp/Networking/APIClient.fetch(_:completion:)",  // stable, content-independent
      "kind": "function",            // package|module|file|type|function|property
      "name": "fetch(_:completion:)",
      "parent": "type:MyApp/Networking/APIClient",
      "loc": { "file": "Sources/Networking/APIClient.swift", "line": 42, "col": 10 },
      "attrs": { "access": "public", "isAsync": true, "typeKind": null },
      "metrics": { "loc": 31, "fanIn": 4, "fanOut": 7 }   // optional, extensible
    }
  ],
  "edges": [
    {
      "id": "e:calls:func:A…->func:B…",
      "kind": "calls",   // imports|contains|calls|references|conforms_to|inherits|instantiates|reads|writes
      "from": "func:…", "to": "func:…",
      "locs": [ { "file": "…", "line": 45, "col": 8 } ],   // every call site; edge is verifiable
      "count": 3
    }
  ],
  "clusters": [ { "id": "cluster:networking", "name": "Networking", "members": ["type:…"], "source": "agent|mechanical" } ],
  "annotations": { "func:…": { "summary": "…", "importance": 0.8 } }
}
```

Stable ID rules: derived from fully-qualified symbol path + arity/signature, never from file offsets or ordering. Renames are detected as remove+add in phase 1 (rename detection is a stretch goal).

## 5. Requirements

### Functional

- F1: `codeatlas analyze [path]` produces valid Graph IR for any building SwiftPM package or Xcode project.
- F2: `codeatlas analyze --diff` produces correct change sets.
- F3: `codeatlas serve [path]` opens the viewer with live watch mode.
- F4: Viewer implements all §3(C) phase-1 features.
- F5: JSON Schema for the IR published in-repo (`schema/ir.schema.json`); analyzer output and agent patches validated against it in CI.
- F6: Agent patches restricted to `annotations`/`clusters` by the validator (reject otherwise).

### Non-functional

- N1: Accuracy — an edge appears iff the index store/AST supports it. Test: on fixture projects, generated edges match a hand-written expected graph exactly.
- N2: Determinism — repeated runs on identical input are byte-identical.
- N3: Stability — on fixture "one-line change" tests, ≥95% of unchanged visible nodes keep their positions.
- N4: Performance targets in §3.
- N5: Everything runs locally; no code leaves the machine except the abstraction agent's IR/snippet payloads (agent pass must be optional/off by default).

## 6. Milestones (agent work packages)

Ordered; M1–M3 are parallelizable after M0.

- **M0 — Repo scaffold + IR contract.** Monorepo (`analyzer/` Swift package, `viewer/` Vite app, `schema/`, `fixtures/`). Write `ir.schema.json` + validator + 3 fixture Swift packages (tiny/medium/tricky: extensions, protocols with default impls, generics, closures, async). Exit: schema validates hand-written fixture graphs.
- **M1 — Analyzer core.** SwiftSyntax walk for declarations/containment + IndexStoreDB for calls/references/conformances. Exit: N1 + N2 pass on all fixtures.
- **M2 — Viewer core.** Load a static `graph.json`, ELK layout, expand/collapse, search, click-to-editor. Exit: F4 minus delta features, perf target on a 500-node synthetic graph.
- **M3 — Delta + live mode.** `--diff`, watcher, WebSocket push, position persistence, delta highlighting/animation. Exit: N3 passes; edit-to-updated-diagram latency <3s on the medium fixture.
- **M4 — Abstraction agent.** Clustering + summaries via Claude, validator-enforced patch. Exit: F6; qualitative review that clusters improve the medium fixture's default view.
- **M5 — Dogfood.** Run on a real personal Swift project; log every wrong/missing edge and every layout-jump as an issue. Exit: one week of daily use with zero incorrect edges observed.

## 7. Verification strategy

- Fixture-based golden tests: expected IR per fixture, exact match (N1/N2).
- Mutation tests for deltas: scripted one-line edits to fixtures, assert exact expected change set and position stability (N3).
- Schema validation in CI for analyzer output and agent patches.
- Perf benchmarks in CI on the large fixture (regression gate, not absolute).

## 8. Risks & open questions

- IndexStoreDB requires a successful build and its API is sparsely documented — validate M1 feasibility in the first R&D session; fallback is SourceKit-LSP requests, second fallback tree-sitter-swift (weaker: no verified call resolution).
- Dynamic dispatch/protocol witnesses: index store gives conservative resolution; decide whether protocol-mediated calls render as `calls` to the protocol requirement, the witnesses, or both (proposal: to the requirement, with expandable witness edges).
- Closures and stored function values blur the call graph — phase 1: represent as `references`, not `calls`.
- Xcode project (non-SwiftPM) support may be messy — acceptable to ship M1 SwiftPM-only, Xcode in M5 if painful.
- Rename detection deferred; revisit after M5 dogfooding.
- 3D view: only revisit if a concrete encoding for the 3rd axis proves itself (e.g., churn or layer depth).
