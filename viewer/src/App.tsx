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
import { parseBudget, RENDER_WARN } from "./ir/budget";
import "./styles.css";

// --- visual language ---------------------------------------------------------
// Node KIND → accent slot (validated categorical set per theme, src/theme.ts)
// and pastel fill (entity archetype). Unknown kinds hash into the same six
// slots so any freeform vocabulary stays on-palette.

const KIND_SLOT: Record<string, number> = {
  package: 5,
  database: 3,
  schema: 5,
  group: 5, // schema2ir's name-range buckets: same slot as the schema they sit in
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

/** What the live loop carries between ticks (mutated by `pollOnce`). */
export interface PollState {
  /** Bytes of the last accepted graph — identical bytes are never re-parsed. */
  last: string;
  /** Once live/ has served a graph, a 404 there is a hiccup, not "absent". */
  liveSeen: boolean;
  /** Per-source ETag for the next If-None-Match. */
  etags: Map<string, string>;
}
export const newPollState = (): PollState => ({ last: "", liveSeen: false, etags: new Map() });

/** One tick's decision: install a graph, show an error (`null` clears one), or neither. */
export interface PollResult {
  ir?: GraphIR;
  source?: string;
  error?: string | null;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * One pass over the poll sources, first answer wins. Every branch of the live
 * loop is here and nowhere else, because this is the product's core promise:
 * a 304 or unchanged bytes change nothing, a 404 on live/ AFTER live has served
 * a graph keeps the last good one on screen (a non-atomic rewrite must never
 * swap in the sample), a 404 before that falls through to the next source, and
 * anything unreadable — HTML from the dev server, invalid JSON, a graph the
 * shape guard rejects — is reported without touching what is rendered.
 */
export async function pollOnce(
  sources: string[],
  state: PollState,
  fetchFn: FetchLike,
  signal?: AbortSignal
): Promise<PollResult> {
  for (const url of sources) {
    let text: string;
    try {
      const etag = state.etags.get(url);
      const r = await fetchFn(url, {
        cache: "no-store",
        headers: { Accept: "application/json", ...(etag ? { "If-None-Match": etag } : {}) },
        signal,
      });
      // `error: null`, not `{}`: 304 means this source is present and serving the bytes we
      // already have. Returning nothing left a previous tick's "missing (keeping last good
      // graph)" on screen forever once the file came back unchanged — the ETag still
      // matched, so no 200 ever arrived to clear it.
      if (r.status === 304) return { error: null }; // unchanged since the last poll
      if (r.status === 404) {
        if (state.liveSeen && url.startsWith("live/")) return { error: `${url}: missing (keeping last good graph)` };
        continue; // absent → next source
      }
      if (!r.ok) return { error: `${url}: HTTP ${r.status}` };
      if (!/json/i.test(r.headers.get("content-type") ?? "")) continue; // dev-server HTML fallback for a missing file
      text = await r.text();
      const tag = r.headers.get("etag");
      if (tag) state.etags.set(url, tag);
    } catch {
      if (signal?.aborted) return {};
      continue; // network hiccup — try next source / next tick
    }
    if (text === state.last) return { error: null }; // restored to the last good bytes
    let g: unknown;
    try {
      g = JSON.parse(text);
    } catch (e) {
      return { error: `${url}: invalid JSON (${e instanceof Error ? e.message : String(e)})` };
    }
    const problem = checkGraphShape(g);
    if (problem) return { error: `${url}: ${problem}` };
    // Advance `last` BEFORE the caller renders: if installing the graph throws,
    // we must not spin on the same bad bytes — the next change retries.
    state.last = text;
    if (url.startsWith("live/")) state.liveSeen = true;
    return { ir: g as GraphIR, source: url };
  }
  return {};
}

// --- filter index ------------------------------------------------------------
// The filter effect re-runs after EVERY layout pass (it re-tags `dim` on the new
// node objects), so a scan of the whole IR inside it was paid again on each
// incremental toggle and each poll while a query was up. Name/kind/id are
// lowercased once per graph here and the match set is memoised per query, which
// leaves the effect O(visible).

export interface SearchIndex {
  ids: string[];
  parents: (string | undefined)[];
  /** name + kind + id, lowercased, one entry per IR node. */
  hay: string[];
  at: Map<string, number>;
  root: string;
}

export function buildSearchIndex(ir: GraphIR): SearchIndex {
  const ids: string[] = [];
  const parents: (string | undefined)[] = [];
  const hay: string[] = [];
  const at = new Map<string, number>();
  for (const n of ir.nodes) {
    at.set(n.id, ids.length);
    ids.push(n.id);
    parents.push(n.parent);
    hay.push(`${n.name}\u0000${n.kind}\u0000${n.id}`.toLowerCase());
  }
  return { ids, parents, hay, at, root: ir.root };
}

/** Ids whose name, kind or id contains the query; null when nothing is filtered. */
export function searchMatches(index: SearchIndex | null, query: string): Set<string> | null {
  const q = query.trim().toLowerCase();
  if (!index || !q) return null;
  const out = new Set<string>();
  for (let i = 0; i < index.hay.length; i++) if (index.hay[i].includes(q)) out.add(index.ids[i]);
  return out;
}

/**
 * Matches that are not on screen (inside collapsed containers), and the visible
 * ancestors that must stay lit so a column name is findable in a 100k-node schema.
 */
export function hiddenMatchesOf(
  index: SearchIndex,
  matched: ReadonlySet<string>,
  shown: ReadonlySet<string>
): { hidden: number; lit: Set<string> } {
  const lit = new Set<string>();
  let hidden = 0;
  const parentOf = (id: string): string | undefined => {
    const i = index.at.get(id);
    return i === undefined ? undefined : index.parents[i];
  };
  for (const id of matched) {
    if (shown.has(id) || id === index.root) continue;
    hidden++;
    let p = parentOf(id);
    while (p && !shown.has(p)) p = parentOf(p);
    if (p) lit.add(p);
  }
  return { hidden, lit };
}

// --- keyboard activation ------------------------------------------------------

/** Keys that activate the focused node — React Flow's own set, bound to OUR selection. */
const ACTIVATE_KEYS = ["Enter", " "];

/** Just enough of an Element for `keyActivation` (and for a test to fake). */
export interface KeyTarget {
  closest(selector: string): { dataset?: { id?: string } } | null;
}

/**
 * Which node id an Enter/Space press activates, if any. React Flow focuses the
 * wrapper it renders AROUND AtlasNodeView, so the key event never reaches our
 * own div: the canvas listens and resolves the wrapper's data-id instead. Its
 * built-in handler only ever touches React Flow's internal selection, which is
 * not what the details panel, collapse/expand or "Open in editor" read.
 */
export function keyActivation(key: string, target: KeyTarget | null): string | null {
  if (!ACTIVATE_KEYS.includes(key)) return null;
  return target?.closest?.(".react-flow__node")?.dataset?.id ?? null;
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
export function loadPositions(root: string): Map<string, Point> {
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

/** Saved roots, newest first. A lost/corrupt list is rebuilt from the key space
 *  — it is the only record of what we wrote, so without it every `codeatlas:pos:`
 *  key would be an orphan nothing ever removes. */
function readRoots(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(ROOTS_KEY) ?? "[]");
    if (Array.isArray(v)) return v.filter((r): r is string => typeof r === "string");
  } catch {
    /* corrupt — fall through to the sweep */
  }
  const found: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(posKey(""))) found.push(k.slice(posKey("").length));
  }
  return found;
}

/**
 * Is this the origin being FULL, as opposed to storage being refused outright?
 * Only a full origin is worth evicting for. Every engine spells it differently, and the
 * numeric codes are the legacy spellings still thrown by older Safari.
 */
export function isQuotaError(e: unknown): boolean {
  if (typeof DOMException !== "undefined" && e instanceof DOMException) {
    return e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED" || e.code === 22 || e.code === 1014;
  }
  const name = (e as { name?: unknown } | null)?.name;
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED";
}

/** Is the event target somewhere the user is typing? Exported for ui-keyboard.test.ts. */
export function isTextEntry(target: unknown): boolean {
  const el = target as { tagName?: unknown; isContentEditable?: unknown } | null;
  if (!el || typeof el.tagName !== "string") return false;
  if (el.isContentEditable === true) return true;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

export function savePositions(root: string, m: Map<string, Point>) {
  try {
    const payload = JSON.stringify(Object.fromEntries(m));
    const roots = [root, ...readRoots().filter((r) => r !== root)];
    // Evict BEFORE writing: the write can throw on a full origin, and the
    // eviction used to sit after it, so a quota error left the list untrimmed
    // and position persistence dead for good.
    for (const old of roots.splice(MAX_SAVED_ROOTS)) localStorage.removeItem(posKey(old));
    let saved = false;
    while (!saved) {
      try {
        localStorage.setItem(posKey(root), payload);
        saved = true;
      } catch (e) {
        // A SecurityError (storage disabled by policy) used to land here too, and the loop
        // then deleted every other saved view one by one before giving up — destroying
        // data over a condition eviction could never fix. Only a full origin is evictable.
        if (!isQuotaError(e)) break;
        // The quota is shared with every other page on this origin, so dropping
        // our own oldest view is the only lever we have; give up once it is the
        // only one left, leaving the list consistent with what is stored.
        const old = roots[roots.length - 1];
        if (old === undefined || old === root) break;
        roots.pop();
        localStorage.removeItem(posKey(old));
      }
    }
    // A write that failed leaves whatever this root stored LAST time: stale, but a far
    // better starting layout than none, so it stays. (It used to be deleted here — on any
    // error at all — which turned "could not save the newest positions" into "lost the
    // positions you had".) The list must still name only keys that exist, so a root whose
    // FIRST save is the one that failed comes back out of it.
    if (!saved && localStorage.getItem(posKey(root)) === null) {
      const i = roots.indexOf(root);
      if (i >= 0) roots.splice(i, 1);
    }
    localStorage.setItem(ROOTS_KEY, JSON.stringify(roots));
  } catch {
    /* storage unavailable (private mode) — the in-memory map still works */
  }
}

// --- app ---------------------------------------------------------------------

export default function App() {
  const { ir, delta, collapsed, selected, status, budget, budgetInfo, lastToggle, setBudget, setIR, setPollError, toggleCollapse, collapseToFit, select } = useAtlas();
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
    const state = newPollState();
    const sources = pollSources(window.location.search);
    let timer = 0;
    const tick = async () => {
      if (ctrl.signal.aborted) return;
      // Everything below runs inside try/finally: the loop MUST re-arm even if the
      // shape guard, the visibility budget or the store throws on a graph we let
      // through. Before this, one such throw escaped here, the setTimeout below was
      // never reached, and the live loop was dead until a manual browser reload —
      // silently, since the canvas kept showing the last good graph.
      try {
        const r = await pollOnce(sources, state, (url, init) => fetch(url, init), ctrl.signal);
        if (ctrl.signal.aborted) return;
        // `error: null` only clears a message that is actually up; writing it
        // unconditionally would re-render on every quiet poll.
        if (r.error !== undefined && (r.error !== null || useAtlas.getState().status.error)) setPollError(r.error);
        if (r.ir) setIR(r.ir, r.source!);
      } catch (e) {
        // `state.last` was already advanced for a graph that parsed and passed the
        // shape guard, so we do not spin on the same bad bytes; the next change retries.
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
              // React Flow owns the focusable wrapper, so the accessible name of
              // a node has to be set on the node object, not inside AtlasNodeView.
              ariaLabel: `${n.ir.kind} ${n.ir.name}${n.collapsed ? ", collapsed" : n.isContainer ? ", expanded" : ""}`,
              // …and the STATE goes in the state attribute, not only baked into the name:
              // a screen reader announces an aria-expanded change on the same element,
              // where a changed label alone is silent. Only on nodes that actually toggle.
              domAttributes:
                n.isContainer || n.collapsed ? { "aria-expanded": n.collapsed ? "false" : "true" } : undefined,
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
              old.ariaLabel === fresh.ariaLabel &&
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
  // are hidden, so a column name is findable in a 100k-node schema. The scan
  // itself is memoised (see SearchIndex) so only the tagging repeats per layout.
  const [hiddenMatches, setHiddenMatches] = useState(0);
  const searchIndex = useMemo(() => (ir ? buildSearchIndex(ir) : null), [ir]);
  const matched = useMemo(() => searchMatches(searchIndex, query), [searchIndex, query]);
  useEffect(() => {
    const { hidden, lit } =
      matched && searchIndex
        ? hiddenMatchesOf(searchIndex, matched, new Set(nodes.map((n) => n.id)))
        : { hidden: 0, lit: new Set<string>() };
    setHiddenMatches(hidden);
    setNodes((prev) => {
      let changed = false;
      const next = prev.map((n) => {
        const d = n.data as AtlasNodeData;
        const dim = !!matched && !matched.has(n.id) && !lit.has(n.id);
        if (dim === d.dim) return n;
        changed = true;
        const obj = { ...n, data: { ...d, dim } };
        nodeObjs.current.set(n.id, obj); // the layout pass reuses these — keep dim current
        return obj;
      });
      return changed ? next : prev;
    });
  }, [matched, searchIndex, nodes]);

  // every node is selectable (containers carry a loc too); containers also
  // toggle so a single gesture still expands/collapses. Mouse and keyboard
  // share this body — a node that can be focused must be usable.
  const activate = (id: string, togglesContainer: boolean) => {
    // Also here, not only in the effect on `selected`: re-activating the node that is
    // ALREADY selected does not change `selected`, so the effect never fires and the
    // previous "Open in editor" reply stayed on screen looking like a fresh answer.
    setOpenResult(null);
    select(id);
    if (togglesContainer) toggleCollapse(id);
  };
  const onNodeClick: NodeMouseHandler = (_ev, node) => {
    const d = node.data as AtlasNodeData;
    activate(node.id, d.isContainer || d.collapsed);
  };
  const onCanvasKeyDown = (ev: React.KeyboardEvent<HTMLDivElement>) => {
    const id = keyActivation(ev.key, ev.target as unknown as KeyTarget);
    if (!id) return;
    ev.preventDefault(); // Space would scroll the pane
    const d = nodeObjs.current.get(id)?.data;
    activate(id, !!d && (d.isContainer || d.collapsed));
  };
  // Escape closes the details panel from anywhere — React Flow's own Escape
  // only clears its internal selection. Not while a text field has focus, though:
  // Escape in the filter box means "clear what I typed", and stealing it there
  // dismissed the panel the user was reading instead.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      if (isTextEntry(ev.target)) return;
      select(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [select]);
  // a different node was selected (however) — the last /open reply is stale
  useEffect(() => setOpenResult(null), [selected]);

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
    <div className={"atlas-root" + (big ? " atlas-big" : "")} onKeyDown={onCanvasKeyDown}>
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
          edgesFocusable={false} // an edge is not actionable; 600 of them are just tab stops
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
        {nodes.length > RENDER_WARN && (
          <span
            className="over-budget"
            title={`${nodes.length} nodes are on screen. Above about ${RENDER_WARN} the layout drops to a faster, rougher tier and panning slows down. "Collapse to fit" re-applies the visibility budget (${budget.maxVisible} nodes / ${budget.maxEdges} edges — change with ?budget=N,E).`}
          >
            ⚠ {nodes.length} visible
            <button onClick={collapseToFit}>collapse to fit</button>
          </span>
        )}
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
