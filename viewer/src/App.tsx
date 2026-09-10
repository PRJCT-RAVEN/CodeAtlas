import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ReactFlow,
  Controls,
  MiniMap,
  Panel,
  Handle,
  Position,
  MarkerType,
  useReactFlow,
  type Node,
  type NodeProps,
  type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { layoutGraph, warmElk, type LayoutMode, type LayoutResult, type Point } from "./layout/elk";
import { incrementalToggle } from "./layout/incremental";
import { edgeStyle } from "./ir/families";
import type { EdgeKind, GraphIR, NodeKind } from "./ir/types";
import { checkGraphShape } from "./ir/shape";
import { isEmptyDelta } from "./ir/delta";
import { ElkEdge, type ElkEdgeType } from "./edges/ElkEdge";
import { useAtlas } from "./store";
import { THEMES, SLOT_COUNT, applyTheme, initialTheme, rememberTheme, type Theme, type ThemeName } from "./theme";
import { parseBudget } from "./ir/budget";
import "./styles.css";

// --- visual language ---------------------------------------------------------
// Node KIND → accent slot (validated categorical set per theme, src/theme.ts)
// and pastel fill (entity archetype). Unknown kinds hash into the same six
// slots so any freeform vocabulary stays on-palette.

const KIND_SLOT: Record<string, number> = {
  package: 5,
  database: 3,
  schema: 5,
  table: 3,
  column: 4,
  index: 3,
  trigger: 1,
  procedure: 1,
  module: 0,
  layer: 0,
  type: 2,
  function: 1,
  step: 1,
  property: 4,
  state: 4,
  store: 3,
  db: 3,
  queue: 3,
  screen: 5,
  view: 5,
  control: 3,
  app: 0,
  actor: 2,
  dir: 0,
  doc: 0,
  link: 0,
};

function slotFor(kind: NodeKind): number {
  if (kind in KIND_SLOT) return KIND_SLOT[kind];
  let h = 0;
  for (let i = 0; i < kind.length; i++) h = (h * 31 + kind.charCodeAt(i)) >>> 0;
  return h % SLOT_COUNT;
}

// Archetype picks the SHAPE treatment (DFD conventions); kind picks the hue.
type Archetype = "process" | "entity" | "store" | "container";

// `doc` (plain files in fs views) deliberately excluded — file trees render as
// compact entities; rails are reserved for true data stores. A leaf `file` in
// a conceptual view (a config file, a log) IS a store.
const STORE_RE = /^(store|db|database|queue|cache|file|config|table|bucket|log|artifact|index)(es|s)?$/;
const PROCESS_RE = /^(func(tion)?|step|process|job|task|hook|method|script|command|action|daemon)s?$/;

export function classify(kind: NodeKind): Archetype {
  if (STORE_RE.test(kind)) return "store";
  if (PROCESS_RE.test(kind)) return "process";
  return "entity";
}

// --- custom nodes -------------------------------------------------------------

type AtlasNodeData = {
  label: string;
  kind: NodeKind;
  typeKind?: string | null;
  isContainer: boolean;
  collapsed: boolean;
  delta?: "added" | "modified";
  dim: boolean;
  [key: string]: unknown;
};
type AtlasNode = Node<AtlasNodeData>;

function AtlasNodeView({ data, selected }: NodeProps<AtlasNode>) {
  const slot = slotFor(data.kind);
  const isBox = data.isContainer || data.collapsed;
  const archetype: Archetype = isBox ? "container" : classify(data.kind);
  const badge = data.typeKind ?? data.kind;
  const vars = {
    "--accent": `var(--accent-${slot})`,
    "--accent-dim": `var(--accent-${slot}-dim)`,
    "--pastel": `var(--pastel-${slot})`,
  } as React.CSSProperties;
  return (
    <div
      className={
        `atlas-node a-${archetype}` +
        (data.collapsed ? " collapsed" : "") +
        (selected ? " selected" : "") +
        (data.delta ? ` delta-${data.delta}` : "") +
        (data.dim ? " dim" : "")
      }
      data-kind={data.kind}
      style={vars}
    >
      <div className={archetype === "container" ? "chip" : "body"}>
        <span className="badge">{data.collapsed ? "+ " : ""}{badge}</span>
        <span className="name">{data.label}</span>
      </div>
      {/* Invisible handles — React Flow needs them to consider an edge valid.
          The `elk` edge draws its own routed path, so handle geometry is
          irrelevant except for the bezier fallback. */}
      <Handle id="t-top" type="target" position={Position.Top} className="atlas-handle" isConnectable={false} />
      <Handle id="s-bot" type="source" position={Position.Bottom} className="atlas-handle" isConnectable={false} />
      <Handle id="t-bot" type="target" position={Position.Bottom} className="atlas-handle" isConnectable={false} />
      <Handle id="s-top" type="source" position={Position.Top} className="atlas-handle" isConnectable={false} />
    </div>
  );
}

const nodeTypes = { atlas: AtlasNodeView };
const edgeTypes = { elk: ElkEdge };

/** Visible-node count above which the `atlas-big` paint economies kick in. */
export const BIG_VIEW = 800;
/** A collapse/expand is laid out incrementally when the last full layout took longer than this, or the view is bigger than INCREMENTAL_MIN_NODES. */
export const INCREMENTAL_MIN_MS = 300;
export const INCREMENTAL_MIN_NODES = 400;

// Re-fit the viewport when a NEW graph lands (live graph.json swap). Collapse
// toggles deliberately do NOT refit — that would fight manual navigation.
function AutoFit({ epoch }: { epoch: number }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (epoch === 0) return; // nothing laid out yet; initial load uses the fitView prop
    const t = window.setTimeout(() => fitView({ padding: 0.1, duration: 400 }), 60);
    return () => window.clearTimeout(t);
  }, [epoch, fitView]);
  return null;
}

// A bad graph must never take the whole app down: the poller lives above this
// boundary and keeps running; the next good graph.json resets the boundary.
class CanvasBoundary extends Component<{ resetKey: unknown; children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  componentDidUpdate(prev: { resetKey: unknown }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  render() {
    if (this.state.error)
      return (
        <div className="error-panel">
          <strong>Render failed</strong>
          <div className="mono">{this.state.error}</div>
          <div>Waiting for the next valid graph.json…</div>
        </div>
      );
    return this.props.children;
  }
}

// Query string for /open: the loc file as-is (absolute or repo-relative) plus
// `root=` when the root node carries attrs.absRoot (fs2ir / schema2ir graphs).
export function openQuery(ir: GraphIR, file: string, line: number): string {
  const root = ir.nodes.find((n) => n.id === ir.root);
  const absRoot = root?.attrs?.absRoot;
  const q = new URLSearchParams({ file, line: String(line) });
  if (typeof absRoot === "string" && absRoot) q.set("root", absRoot);
  return q.toString();
}

// Which graph to poll: `?graph=<name>` → live/<name>.json (a candidate view
// that does not overwrite the shared live/graph.json), else live then sample.
export function pollSources(search: string): string[] {
  const name = new URLSearchParams(search).get("graph");
  if (name && /^[A-Za-z0-9_-]+$/.test(name)) return [`live/${name}.json`];
  return ["live/graph.json", "sample-graph.json"];
}

// --- key: dynamic legend of only what the current graph actually uses --------

function EdgeSwatch({ kind, dashed }: { kind: EdgeKind; dashed?: boolean }) {
  const st = edgeStyle(kind);
  return (
    <svg width="26" height="10" aria-hidden="true">
      <line x1="1" y1="5" x2="25" y2="5" stroke={st.color} strokeWidth="1.6" strokeDasharray={dashed ? "3 3" : st.dash} />
    </svg>
  );
}

function NodeSwatch({ kind, isContainer }: { kind: NodeKind; isContainer: boolean }) {
  const slot = slotFor(kind);
  const archetype: Archetype = isContainer ? "container" : classify(kind);
  const base: React.CSSProperties = { display: "inline-block", width: 18, height: 12, boxSizing: "border-box", flex: "none" };
  const accent = `var(--accent-${slot})`;
  if (kind === "overflow")
    return <span style={{ ...base, border: "1.5px dashed var(--overflow-border)", borderRadius: 3 }} />;
  if (archetype === "container")
    return <span style={{ ...base, border: `1.25px solid var(--accent-${slot}-dim)`, borderRadius: 4 }} />;
  if (archetype === "process") return <span style={{ ...base, background: "var(--process-fill)", borderRadius: 999 }} />;
  if (archetype === "store")
    return <span style={{ ...base, height: 10, borderTop: `2px solid ${accent}`, borderBottom: `2px solid ${accent}` }} />;
  return <span style={{ ...base, background: `var(--pastel-${slot})`, borderRadius: 3 }} />;
}

function Key({ ir, hasInferred, hasDelta }: { ir: GraphIR; hasInferred: boolean; hasDelta: boolean }) {
  const { nodeKinds, edgeKinds } = useMemo(() => {
    const parents = new Set(ir.nodes.map((n) => n.parent).filter(Boolean));
    const nk = new Map<string, boolean>(); // kind → does any node of it render as a container?
    for (const n of ir.nodes) {
      if (n.id === ir.root || (n.kind === "file" && parents.has(n.id))) continue;
      nk.set(n.kind, (nk.get(n.kind) ?? false) || parents.has(n.id));
    }
    const ek = [...new Set(ir.edges.filter((e) => e.kind !== "contains").map((e) => e.kind))].sort();
    return { nodeKinds: [...nk.entries()].sort(([a], [b]) => (a < b ? -1 : 1)), edgeKinds: ek };
  }, [ir]);
  return (
    <details className="key" open>
      <summary>Key</summary>
      <div className="key-body">
        <div className="key-section">
          {nodeKinds.map(([kind, isC]) => (
            <div className="key-row" key={kind}>
              <NodeSwatch kind={kind} isContainer={isC} />
              <span>{kind}</span>
            </div>
          ))}
        </div>
        {edgeKinds.length > 0 && (
          <div className="key-section">
            {edgeKinds.map((k) => (
              <div className="key-row" key={k}>
                <EdgeSwatch kind={k} />
                <span>{k}</span>
              </div>
            ))}
            {hasInferred && (
              <div className="key-row" key="__inferred">
                <EdgeSwatch kind="feeds" dashed />
                <span>? inferred (unverified)</span>
              </div>
            )}
          </div>
        )}
        {hasDelta && (
          <div className="key-section">
            <div className="key-row">
              <span className="swatch-delta added" />
              <span>added since last graph</span>
            </div>
            <div className="key-row">
              <span className="swatch-delta modified" />
              <span>modified</span>
            </div>
          </div>
        )}
      </div>
    </details>
  );
}

// The MiniMap paints SVG fills itself, so it gets concrete colours from the
// Theme object rather than CSS variables.
function minimapColorFor(t: Theme): (n: AtlasNode) => string {
  return (n) => {
    const d = n.data;
    if (d.isContainer || d.collapsed) return t.tokens["--minimap-container"];
    if (d.kind === "overflow") return t.tokens["--minimap-overflow"];
    const slot = slotFor(d.kind);
    if (classify(d.kind) === "process") return t.tokens["--process-fill"];
    if (classify(d.kind) === "store") return t.accents[slot];
    return t.pastels[slot];
  };
}

// --- position persistence (spec N3) -----------------------------------------
// Last layout positions per node id (relative to parent), also mirrored in
// localStorage per view root so a reload of the same view starts stable.

function posKey(root: string): string {
  return `codeatlas:pos:${root}`;
}
function loadPositions(root: string): Map<string, Point> {
  try {
    const raw = localStorage.getItem(posKey(root));
    if (!raw) return new Map();
    const obj = JSON.parse(raw) as Record<string, Point>;
    return new Map(Object.entries(obj));
  } catch {
    return new Map();
  }
}
/** Most-recently-used roots kept in localStorage; older ones are evicted. */
export const MAX_SAVED_ROOTS = 24;
const ROOTS_KEY = "codeatlas:pos-roots";
function savePositions(root: string, m: Map<string, Point>) {
  try {
    localStorage.setItem(posKey(root), JSON.stringify(Object.fromEntries(m)));
    let roots: string[] = [];
    try {
      roots = JSON.parse(localStorage.getItem(ROOTS_KEY) ?? "[]");
    } catch {
      roots = [];
    }
    roots = [root, ...roots.filter((r) => r !== root)];
    for (const old of roots.slice(MAX_SAVED_ROOTS)) localStorage.removeItem(posKey(old));
    localStorage.setItem(ROOTS_KEY, JSON.stringify(roots.slice(0, MAX_SAVED_ROOTS)));
  } catch {
    /* quota / private mode — in-memory map still works */
  }
}

// --- app ---------------------------------------------------------------------

export default function App() {
  const { ir, delta, collapsed, selected, status, budget, budgetInfo, lastToggle, setBudget, setIR, setPollError, toggleCollapse, select } = useAtlas();
  const [nodes, setNodes] = useState<AtlasNode[]>([]);
  const [edges, setEdges] = useState<ElkEdgeType[]>([]);
  const [layingOut, setLayingOut] = useState(false);
  const [layoutMode, setLayoutMode] = useState<LayoutMode | null>(null);
  // last layout (for incremental toggles) and the "Tidy" counter that forces a full pass
  const lastLayout = useRef<{ ir: GraphIR; result: LayoutResult; fullMs: number; tidy: number; collapsed: ReadonlySet<string> } | null>(null);
  const [tidyEpoch, setTidyEpoch] = useState(0);
  // `?incremental=0|1` forces the path (benchmarking aid); default: automatic
  const incrementalPref = new URLSearchParams(window.location.search).get("incremental");
  // previous React Flow objects by id — reused when unchanged so React Flow skips them
  const nodeObjs = useRef(new Map<string, AtlasNode>());
  const edgeObjs = useRef(new Map<string, ElkEdgeType>());
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [openResult, setOpenResult] = useState<string | null>(null);
  const [themeName, setThemeName] = useState<ThemeName>(() => initialTheme());
  // `?culling=0` disables React Flow's viewport culling (benchmarking aid)
  const culling = new URLSearchParams(window.location.search).get("culling") !== "0";
  // Above this many visible nodes, drop per-node shadows: panning a big view is
  // paint-bound (profiled 2026-09-05), and 2k blurred shadows are the bulk of it.
  const big = nodes.length > BIG_VIEW;
  const theme = THEMES[themeName];
  useEffect(() => applyTheme(themeName), [themeName]);
  const minimapColor = useMemo(() => minimapColorFor(theme), [theme]);
  const openSeq = useRef(0); // only the latest "Open in editor" click may report
  // bumped only when a layout for a NEW ir lands — drives AutoFit
  const [fitEpoch, setFitEpoch] = useState(0);
  const lastFitIr = useRef<GraphIR | null>(null);
  const positions = useRef<{ root: string | null; map: Map<string, Point> }>({ root: null, map: new Map() });

  // `?budget=<nodes>[,<edges>]` overrides the visibility budget (ir/budget.ts);
  // declared before the poller so it applies to the first graph.
  useEffect(() => {
    const b = parseBudget(window.location.search);
    if (b) setBudget(b);
  }, [setBudget]);

  // Build the ELK engine while the first graph is still being fetched.
  useEffect(() => {
    warmElk();
  }, []);

  // Live loop: poll live/graph.json (written by Claude or served by
  // the launcher's live dir); fall back to the bundled sample only when live is
  // ABSENT. A malformed or structurally wrong file keeps the last good graph
  // on screen and reports the reason in the status bar. Conditional requests
  // (If-None-Match) mean an unchanged 50 MB graph costs a 304 per second, not
  // a download; `last` remains the fallback for servers without ETags.
  useEffect(() => {
    const ctrl = new AbortController();
    let last = "";
    let liveSeen = false; // once live/ has served a graph, a 404 is a hiccup, not "absent"
    let timer = 0;
    const etags = new Map<string, string>();
    const sources = pollSources(window.location.search);
    const tick = async () => {
      if (ctrl.signal.aborted) return;
      // Everything below runs inside try/finally: the loop MUST re-arm even if the
      // shape guard, the visibility budget or the store throws on a graph we let
      // through. Before this, one such throw escaped here, the setTimeout below was
      // never reached, and the live loop was dead until a manual browser reload —
      // silently, since the canvas kept showing the last good graph.
      try {
      for (const url of sources) {
        let text: string;
        try {
          const etag = etags.get(url);
          const r = await fetch(url, {
            cache: "no-store",
            headers: { Accept: "application/json", ...(etag ? { "If-None-Match": etag } : {}) },
            signal: ctrl.signal,
          });
          if (r.status === 304) break; // unchanged since the last poll
          if (r.status === 404) {
            if (liveSeen && url.startsWith("live/")) {
              // a non-atomic rewrite (rm + write) must not swap in the sample:
              // keep the last good graph and say why
              setPollError(`${url}: missing (keeping last good graph)`);
              break;
            }
            continue; // absent → next source
          }
          const ct = r.headers.get("content-type") ?? "";
          if (!r.ok) {
            setPollError(`${url}: HTTP ${r.status}`);
            break;
          }
          if (!/json/i.test(ct)) continue; // dev-server HTML fallback for a missing file
          text = await r.text();
          const tag = r.headers.get("etag");
          if (tag) etags.set(url, tag);
        } catch {
          if (ctrl.signal.aborted) return;
          continue; // network hiccup — try next source / next tick
        }
        if (text === last) {
          if (useAtlas.getState().status.error) setPollError(null); // restored to the last good bytes
          break;
        }
        let g: unknown;
        try {
          g = JSON.parse(text);
        } catch (e) {
          setPollError(`${url}: invalid JSON (${e instanceof Error ? e.message : String(e)})`);
          break;
        }
        const problem = checkGraphShape(g);
        if (problem) {
          setPollError(`${url}: ${problem}`);
          break;
        }
        last = text;
        if (url.startsWith("live/")) liveSeen = true;
        setIR(g as GraphIR, url);
        break;
      }
      } catch (e) {
        // `last` was already advanced for a graph that parsed and passed the shape
        // guard, so we do not spin on the same bad bytes; the next change retries.
        if (!ctrl.signal.aborted) setPollError(`render failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        if (!ctrl.signal.aborted) timer = window.setTimeout(tick, 1000);
      }
    };
    tick();
    return () => {
      ctrl.abort();
      window.clearTimeout(timer);
    };
  }, [setIR, setPollError]);

  useEffect(() => {
    if (!ir) return;
    let cancelled = false;
    setLayingOut(true);
    // previous positions for this view (in memory, else the saved ones)
    if (positions.current.root !== ir.root) positions.current = { root: ir.root, map: loadPositions(ir.root) };
    const ann = ir.annotations ?? {};
    const inferredOf = (irIds: string[]) => irIds.some((id) => ann[id]?.inferred === true || /^inferred\b/i.test(ann[id]?.summary ?? ""));
    const labelFor = (e: { kind: string; count: number; irIds: string[] }) => {
      const custom = e.irIds.length === 1 ? ann[e.irIds[0]]?.label : undefined;
      const base = custom ?? (e.count > 1 ? `${e.kind} ×${e.count}` : e.kind);
      return inferredOf(e.irIds) ? `${base} ?` : base;
    };
    // Incremental path (layout/incremental.ts): one container toggled on the
    // same graph, no Tidy requested, and the last full pass was expensive.
    const prev = lastLayout.current;
    // exactly one toggle away from the base layout: a click that landed while a
    // pass was pending (cancelled, base not advanced) must take the full path
    const oneToggleAway = (a: ReadonlySet<string>, b: ReadonlySet<string>, id: string) => {
      let diff = 0;
      for (const x of a) if (!b.has(x)) { if (x !== id) return false; diff++; }
      for (const x of b) if (!a.has(x)) { if (x !== id) return false; diff++; }
      return diff === 1;
    };
    const eligible =
      !!lastToggle && !!prev && prev.ir === ir && prev.tidy === tidyEpoch && oneToggleAway(prev.collapsed, collapsed, lastToggle) &&
      (incrementalPref === "1" || (incrementalPref !== "0" && (prev.fullMs > INCREMENTAL_MIN_MS || prev.result.nodes.length > INCREMENTAL_MIN_NODES)));
    const full = () => layoutGraph(ir, collapsed, { pinned: positions.current.map, labelFor });
    const run = eligible ? incrementalToggle(ir, collapsed, lastToggle!, prev!.result, { labelFor }).then((r) => r ?? full()) : full();
    run
      .then((result) => {
        const { nodes: ln, edges: le, mode } = result;
        if (cancelled) return;
        // result.layoutMs excludes one-time ELK engine construction, so the first
        // layout of a session no longer looks expensive enough to push the next
        // collapse onto the approximate path
        lastLayout.current = { ir, result, fullMs: mode.incremental ? prev!.fullMs : result.layoutMs, tidy: tidyEpoch, collapsed };
        setLayoutMode(mode);
        const next = new Map<string, Point>();
        for (const n of ln) next.set(n.ir.id, { x: n.x, y: n.y });
        positions.current.map = next;
        savePositions(ir.root, next);
        // Reuse the previous object when nothing about a node/edge changed:
        // React Flow then leaves its DOM alone, which is most of the cost of an
        // incremental toggle in a big view.
        const nextNodeObjs = new Map<string, AtlasNode>();
        setNodes(
          ln.map((n) => {
            const fresh: AtlasNode = {
              id: n.ir.id,
              type: "atlas",
              position: { x: n.x, y: n.y },
              width: n.width,
              height: n.height,
              parentId: n.parentId,
              extent: n.parentId ? ("parent" as const) : undefined,
              selectable: true,
              // stacking: edges (2, pinned in CSS) < containers (3) < leaf marks (4)
              zIndex: n.isContainer ? 3 : 4,
              data: {
                label: n.ir.name,
                kind: n.ir.kind,
                typeKind: (n.ir.attrs?.typeKind as string | undefined) ?? null,
                isContainer: n.isContainer,
                collapsed: n.collapsed,
                delta: delta.added.has(n.ir.id) ? "added" : delta.modified.has(n.ir.id) ? "modified" : undefined,
                dim: false, // the filter effect below re-tags this without a relayout
              },
            };
            const old = nodeObjs.current.get(n.ir.id);
            const same =
              old &&
              old.position.x === fresh.position.x && old.position.y === fresh.position.y &&
              old.width === fresh.width && old.height === fresh.height && old.parentId === fresh.parentId &&
              old.zIndex === fresh.zIndex &&
              (["label", "kind", "typeKind", "isContainer", "collapsed", "delta"] as const).every((k) => old.data[k] === fresh.data[k]);
            const obj = same ? old! : fresh;
            nextNodeObjs.set(n.ir.id, obj);
            return obj;
          })
        );
        nodeObjs.current = nextNodeObjs;
        const nextEdgeObjs = new Map<string, ElkEdgeType>();
        setEdges(
          le.map((e) => {
            const st = edgeStyle(e.kind);
            const inferred = inferredOf(e.irIds);
            const importance = Math.max(...e.irIds.map((id) => ann[id]?.importance ?? 0.5));
            const width = 1.1 + Math.min(1, Math.max(0, importance)) * 1.2;
            const fresh = {
              id: e.id,
              type: "elk" as const,
              source: e.source,
              target: e.target,
              sourceHandle: e.reversed ? "s-top" : "s-bot",
              targetHandle: e.reversed ? "t-bot" : "t-top",
              markerEnd: { type: MarkerType.ArrowClosed, color: st.color, width: 14, height: 14 },
              zIndex: 2,
              data: {
                points: e.points,
                labelPos: e.labelPos,
                label: e.label,
                color: st.color,
                dash: inferred ? "4 4" : st.dash,
                width,
                inferred,
                delta: e.irIds.some((id) => delta.addedEdges.has(id)) ? ("added" as const) : undefined,
                faint: mode.dense,
              },
            } satisfies ElkEdgeType;
            const old = edgeObjs.current.get(e.id);
            const same =
              old && old.source === fresh.source && old.target === fresh.target &&
              old.sourceHandle === fresh.sourceHandle && old.data?.points === fresh.data.points &&
              old.data?.labelPos === fresh.data.labelPos && old.data?.label === fresh.data.label &&
              old.data?.color === fresh.data.color && old.data?.dash === fresh.data.dash &&
              old.data?.width === fresh.data.width && old.data?.delta === fresh.data.delta && old.data?.faint === fresh.data.faint;
            const obj = same ? old! : fresh;
            nextEdgeObjs.set(e.id, obj);
            return obj;
          })
        );
        edgeObjs.current = nextEdgeObjs;
        setLayoutError(null);
        setLayingOut(false);
        if (lastFitIr.current !== ir) {
          lastFitIr.current = ir;
          setFitEpoch((e) => e + 1);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLayingOut(false);
        setLayoutError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
    // lastToggle changes together with `collapsed`; tidyEpoch forces a full pass
  }, [ir, collapsed, delta, lastToggle, tidyEpoch]);

  // Filter box: re-tag `dim` on the laid-out nodes only — never a relayout, never
  // a localStorage write per keystroke. Matches INSIDE collapsed containers count
  // too: the container they render at stays lit, and the count says how many
  // are hidden, so a column name is findable in a 100k-node schema.
  const [hiddenMatches, setHiddenMatches] = useState(0);
  useEffect(() => {
    const q = query.trim().toLowerCase();
    const hit = (name: string, kind: string, id: string) =>
      name.toLowerCase().includes(q) || kind.toLowerCase().includes(q) || id.toLowerCase().includes(q);
    const lit = new Set<string>();
    let hidden = 0;
    if (q && ir) {
      const shown = new Set(nodes.map((n) => n.id));
      const byId = new Map(ir.nodes.map((n) => [n.id, n]));
      for (const n of ir.nodes) {
        if (shown.has(n.id) || n.id === ir.root || !hit(n.name, n.kind, n.id)) continue;
        hidden++;
        let p = n.parent ? byId.get(n.parent) : undefined;
        while (p && !shown.has(p.id)) p = p.parent ? byId.get(p.parent) : undefined;
        if (p) lit.add(p.id);
      }
    }
    setHiddenMatches(hidden);
    setNodes((prev) => {
      let changed = false;
      const next = prev.map((n) => {
        const d = n.data as AtlasNodeData;
        const dim = !!q && !hit(d.label, d.kind, n.id) && !lit.has(n.id);
        if (dim === d.dim) return n;
        changed = true;
        const obj = { ...n, data: { ...d, dim } };
        nodeObjs.current.set(n.id, obj); // the layout pass reuses these — keep dim current
        return obj;
      });
      return changed ? next : prev;
    });
  }, [query, nodes, ir]);

  const onNodeClick: NodeMouseHandler = (_ev, node) => {
    const d = node.data as AtlasNodeData;
    // every node is selectable (containers carry a loc too); containers also
    // toggle so a single click still expands/collapses
    select(node.id);
    setOpenResult(null);
    if (d.isContainer || d.collapsed) toggleCollapse(node.id);
  };

  const selectedNode = useMemo(
    () => (ir && selected ? ir.nodes.find((n) => n.id === selected) ?? null : null),
    [ir, selected]
  );
  const selectedAnn = ir && selected ? ir.annotations?.[selected] : undefined;
  const selectedIsContainer = !!selectedNode && ir!.nodes.some((n) => n.parent === selectedNode.id);

  const openQs = useMemo(
    () => (ir && selectedNode?.loc ? openQuery(ir, selectedNode.loc.file, selectedNode.loc.line) : null),
    [ir, selectedNode]
  );

  const rootNode = ir ? ir.nodes.find((n) => n.id === ir.root) : undefined;
  const title = ir?.title ?? rootNode?.name ?? null;
  const description = ir?.description ?? (ir ? ir.annotations?.[ir.root]?.summary : undefined) ?? null;
  const hasInferred = edges.some((e) => e.data?.inferred);
  const hasDelta = !isEmptyDelta(delta);
  const matchCount = query.trim() ? nodes.filter((n) => !n.data.dim).length : null;
  // Every display edge touching the selected node, biggest first — the
  // readable form of a dense view's edges (their chips are not drawn).
  const connections = useMemo(() => {
    if (!selected || !ir) return [];
    const names = new Map(ir.nodes.map((n) => [n.id, n.name]));
    const count = (l: string) => Number(/×(\d+)/.exec(l)?.[1] ?? 1);
    return edges
      .filter((e) => e.source === selected || e.target === selected)
      .map((e) => {
        const out = e.source === selected;
        const other = out ? e.target : e.source;
        return { id: e.id, out, otherName: names.get(other) ?? other, label: e.data?.label ?? "" };
      })
      .sort((a, b) => count(b.label) - count(a.label) || a.otherName.localeCompare(b.otherName));
  }, [edges, selected, ir]);
  const extraAttrs = selectedNode?.attrs
    ? Object.entries(selectedNode.attrs).filter(([k, v]) => !["typeKind", "access", "absRoot"].includes(k) && v != null)
    : [];

  return (
    <div className={"atlas-root" + (big ? " atlas-big" : "")}>
      <CanvasBoundary resetKey={ir}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeClick={onNodeClick}
          onPaneClick={() => select(null)}
          fitView
          minZoom={0.05}
          nodesDraggable={false}
          nodesConnectable={false}
          onlyRenderVisibleElements={culling}
          proOptions={{ hideAttribution: true }}
        >
          <AutoFit epoch={fitEpoch} />
          <Controls showInteractive={false} />
          {nodes.length <= 200 && (
            <Panel position="bottom-right" className="map-panel">
              {/* collapsible like the Key: the summary chip stays, the map folds away */}
              <details className="map" open>
                <summary>Map</summary>
                <MiniMap
                  pannable
                  zoomable
                  nodeColor={minimapColor}
                  nodeStrokeWidth={0}
                  maskColor={theme.tokens["--minimap-mask"]}
                />
              </details>
            </Panel>
          )}
        </ReactFlow>
      </CanvasBoundary>
      {ir && (
        <div className="key-stack">
          <Key ir={ir} hasInferred={hasInferred} hasDelta={hasDelta} />
          <div className="search">
            <input
              type="search"
              placeholder="filter name / kind / id"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="filter nodes"
            />
            {matchCount !== null && (
              <span className="search-count" title={hiddenMatches ? `${hiddenMatches} more inside collapsed containers` : undefined}>
                {matchCount}
                {hiddenMatches > 0 ? ` +${hiddenMatches} hidden` : ""}
              </span>
            )}
            <button
              className="theme-toggle"
              title={`switch to ${themeName === "dark" ? "light" : "dark"} theme`}
              onClick={() => {
                const next: ThemeName = themeName === "dark" ? "light" : "dark";
                rememberTheme(next);
                setThemeName(next);
              }}
            >
              {themeName === "dark" ? "☀" : "☾"}
            </button>
          </div>
        </div>
      )}
      {title && (
        <div className="title-bar">
          <div className="title">{title}</div>
          {description && <div className="description">{description}</div>}
        </div>
      )}
      <div className={"status" + (status.error || layoutError ? " error" : "")}>
        {status.source ? (
          <span>{status.source}</span>
        ) : (
          <span>waiting for {pollSources(window.location.search)[0]}…</span>
        )}
        {ir && <span>{ir.nodes.length} nodes · {ir.edges.length} edges</span>}
        {budgetInfo && budgetInfo.autoCollapsed > 0 && (
          <span title={`visible ${budgetInfo.visible} of ${budgetInfo.total} · ${budgetInfo.edges} edges drawn · budget ${budget.maxVisible} nodes / ${budget.maxEdges} edges (?budget=N,E)`}>
            {budgetInfo.autoCollapsed} auto-collapsed · showing {nodes.length}/{budgetInfo.total}
          </span>
        )}
        {layingOut && <span className="busy">laying out…</span>}
        {layoutMode?.incremental && !layingOut && (
          <span title="only the toggled container was laid out; edges to moved nodes are plain curves until the next full layout">
            approximate layout ·{" "}
            <button className="link-button" onClick={() => setTidyEpoch((e) => e + 1)}>
              tidy
            </button>
          </span>
        )}
        {layoutMode?.dense && !layingOut && (
          <span title="dense view: more than 3 edges per node — edges are drawn faint; select a node to light up its edges">
            edges faint · select a node to trace them
          </span>
        )}
        {status.error && <span title="the last good graph stays on screen">⚠ {status.error}</span>}
        {layoutError && <span>⚠ layout: {layoutError}</span>}
        {delta.removed.length > 0 && (
          <span title={delta.removed.join("\n")}>−{delta.removed.length} removed</span>
        )}
        {delta.added.size + delta.modified.size > 0 && (
          <span>+{delta.added.size} added · ~{delta.modified.size} modified</span>
        )}
      </div>
      {selectedNode && (
        <aside className="details">
          <h2>{selectedNode.name}</h2>
          {selectedAnn?.summary && <p className="summary">{selectedAnn.summary}</p>}
          <dl>
            <dt>kind</dt>
            <dd>{selectedNode.kind}{selectedNode.attrs?.typeKind ? ` (${selectedNode.attrs.typeKind})` : ""}</dd>
            <dt>id</dt>
            <dd className="mono">{selectedNode.id}</dd>
            {selectedNode.loc && (
              <>
                <dt>location</dt>
                <dd className="mono">
                  {selectedNode.loc.file}:{selectedNode.loc.line}
                </dd>
              </>
            )}
            {selectedNode.attrs?.access != null && (
              <>
                <dt>access</dt>
                <dd>{String(selectedNode.attrs.access)}</dd>
              </>
            )}
            {extraAttrs.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd className="mono">{typeof v === "object" ? JSON.stringify(v) : String(v)}</dd>
              </div>
            ))}
            {selectedNode.metrics && Object.keys(selectedNode.metrics).length > 0 && (
              <>
                <dt>metrics</dt>
                <dd className="mono">
                  {Object.entries(selectedNode.metrics)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(" · ")}
                </dd>
              </>
            )}
            {selectedAnn?.importance !== undefined && (
              <>
                <dt>importance</dt>
                <dd>{selectedAnn.importance}</dd>
              </>
            )}
            {connections.length > 0 && (
              <>
                <dt>edges ({connections.length})</dt>
                <dd>
                  <ul className="edge-list">
                    {connections.slice(0, 60).map((c) => (
                      <li key={c.id}>
                        <span className="mono">{c.out ? "→" : "←"}</span> {c.label} {c.out ? "to" : "from"} <b>{c.otherName}</b>
                      </li>
                    ))}
                    {connections.length > 60 && <li>… +{connections.length - 60} more</li>}
                  </ul>
                </dd>
              </>
            )}
          </dl>
          {selectedIsContainer && (
            <button onClick={() => toggleCollapse(selectedNode.id)}>
              {collapsed.has(selectedNode.id) ? "Expand" : "Collapse"}
            </button>
          )}
          {openQs && (
            <button
              className="open-editor"
              onClick={() => {
                // vite middleware / DevServer resolve the path and shell to `xed -l` (fallback `open`)
                const seq = ++openSeq.current;
                setOpenResult("opening…");
                fetch(`/open?${openQs}`)
                  .then(async (r) => {
                    const text = `${r.ok ? "" : `HTTP ${r.status}: `}${await r.text()}`;
                    if (seq === openSeq.current) setOpenResult(text);
                  })
                  .catch((e) => {
                    if (seq === openSeq.current) setOpenResult(`failed: ${e instanceof Error ? e.message : String(e)}`);
                  });
              }}
            >
              Open in editor
            </button>
          )}
          <button onClick={() => select(null)}>Close</button>
          {openResult && <div className="open-result mono">{openResult}</div>}
        </aside>
      )}
    </div>
  );
}
