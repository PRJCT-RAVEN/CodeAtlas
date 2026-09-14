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
import type { EdgeKind, GraphIR, NodeKind, IRNode } from "./ir/types";
import { checkGraphShape } from "./ir/shape";
import type { Delta } from "./ir/delta";
import { skipForBudget } from "./ir/grouping";
import { edgeKey } from "./ir/density";
import { ElkEdge, type ElkEdgeType } from "./edges/ElkEdge";
import { useAtlas, crossesSelection, edgeIsPainted } from "./store";
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
  const isBox = drawnAsBox(data);
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
export const BIG_VIEW = RENDER_WARN;
/** A collapse/expand is laid out incrementally when the last full layout took longer than this, or the view is bigger than INCREMENTAL_MIN_NODES. */
export const INCREMENTAL_MIN_MS = 300;
export const INCREMENTAL_MIN_NODES = 400;
/**
 * …but never below this many visible nodes, however slow the last pass was measured to be.
 *
 * A full pass over a handful of nodes is cheap by definition, so an approximate one saves
 * nothing and costs exactly what the incremental path trades away: routed edges become
 * plain curves and chips land at path midpoints. One slow measurement (a cold engine, a
 * busy machine, a background tab) used to be enough to answer the first collapse of an
 * 18-node diagram with a visibly worse one — and `fullMs` is carried forward, so it stayed
 * that way until "Tidy". `?incremental=1` still forces the path for benchmarking.
 */
export const INCREMENTAL_MIN_VISIBLE = 150;

/**
 * Incremental relayout, or a full ELK pass? Pure, and exported, so the three thresholds
 * above are actually covered: this decision used to live inline in the layout effect,
 * where no test could reach it, and two rounds of fixes to it shipped with none.
 *
 * `ready` is the structural half the caller establishes — same graph, same tidy epoch,
 * exactly one container toggled away from the base layout. An explicit `?incremental=1`
 * overrides the COST thresholds but never `ready`: there is no previous layout to splice
 * a toggle into, so forcing the path would have nothing to splice onto.
 */
export function incrementalEligible(
  prev: { fullMs: number; visible: number } | null,
  ready: boolean,
  pref: string | null,
): boolean {
  if (!prev || !ready) return false;
  if (pref === "1") return true;
  if (pref === "0") return false;
  // expensive enough to be worth approximating…
  const costly = prev.fullMs > INCREMENTAL_MIN_MS || prev.visible > INCREMENTAL_MIN_NODES;
  // …and big enough that a full pass is not simply cheap. One slow measurement on a small
  // view (a cold engine, a busy machine) otherwise downgraded every later toggle of it.
  const worthIt = prev.visible >= INCREMENTAL_MIN_VISIBLE;
  return costly && worthIt;
}

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
  const raw = new URLSearchParams(search).get("graph");
  if (raw === null || raw === "") return ["live/graph.json", "sample-graph.json"];
  // `?graph=my-view.json` is the obvious mistake — the manual names the FILE it is staged
  // as — so the extension is dropped rather than rejected.
  const name = raw.replace(/\.json$/i, "");
  if (/^[A-Za-z0-9_-]+$/.test(name)) return [`live/${name}.json`];
  // A name that is still not a name must NOT fall through to the live pair. `?graph=` is a
  // promise that the shared view is left alone (CLAUDE.md: "never falls back to the
  // sample"), and falling back showed the user's live graph under the draft's URL — with
  // `shot.mjs` writing a png of the wrong graph and exiting 0. This path cannot exist (the
  // leading dot is unreachable through the charset above) so the viewer says what it is
  // waiting for and nothing resolves.
  return ["live/.invalid-graph-name.json"];
}

/** What the live loop carries between ticks (mutated by `pollOnce`). */
export interface PollState {
  /** Bytes of the last accepted graph — identical bytes are never re-parsed. */
  last: string;
  /** Once live/ has served a graph, a 404 there is a hiccup, not "absent". */
  liveSeen: boolean;
  /** Per-source ETag for the next If-None-Match. */
  etags: Map<string, string>;
  /**
   * Why the bytes in `last` failed to INSTALL (`setIR` threw), or null.
   *
   * The OTHER half of `failures` below, and it has to be separate because the two mean
   * different things about the same phrase "the bytes you already have". A rejection is
   * about bytes that were never accepted, so restoring the last good ones clears it. A
   * render failure is about `last` ITSELF — the graph parsed, passed the shape guard, and
   * `state.last` advanced (deliberately, so the poller does not spin on the same bytes) —
   * so the same bytes arriving again prove nothing and must not clear it. Without this the
   * warning lasted exactly one second and the status bar then looked healthy while a stale
   * graph sat on screen and nothing would ever arrive to replace it.
   */
  renderFailed: string | null;
  /**
   * Why the bytes currently CACHED for a source were rejected, per url.
   *
   * The ETag is recorded before the body is parsed (it belongs to the bytes, not to the
   * verdict), so a broken graph.json answers 304 from the next tick onwards. Without this
   * the 304 branch below cleared the message after one second and the status bar then
   * looked healthy while a STALE graph was on screen — the exact opposite of the promise
   * that the viewer names the problem it is keeping the last good graph for.
   */
  failures: Map<string, string>;
}
/**
 * The same question for a NODE, and the same generic answer.
 *
 * It was a hand-written list of six `data` keys beside four top-level ones, and it is
 * complete today only because every field it omits (`extent`, `domAttributes`, and —
 * redundantly — `zIndex` and `ariaLabel`) is derived from one it compares. That is the exact
 * accident that hid a missing `inferred` on the edge side until round 18, so the node half
 * gets the same treatment rather than waiting its turn.
 */
export function nodeUnchanged(
  old: AtlasNode | undefined,
  fresh: AtlasNode
): boolean {
  if (!old) return false;
  if (
    old.position.x !== fresh.position.x ||
    old.position.y !== fresh.position.y ||
    old.width !== fresh.width ||
    old.height !== fresh.height ||
    old.parentId !== fresh.parentId
  )
    return false;
  const a = (old.data ?? {}) as Record<string, unknown>;
  const b = fresh.data as Record<string, unknown>;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
}

/**
 * May the previous React Flow edge object be reused verbatim? (If so React Flow skips its
 * DOM — the point of keeping `edgeObjs`.)
 *
 * Every `data` key is compared GENERICALLY rather than field by field, because the field
 * list is what goes stale: `hairball` had to be added to it when the hairball economy
 * landed, and nothing would have failed if it had not — a spliced view that crosses
 * `FASTEST_EDGES` on an expand flips `hairball` while `dense` (and so `faint`) stays true,
 * and the reused object would keep painting the cloud the tier just turned off. `inferred`
 * was in fact missing from the hand-written list all along, saved only by `labelFor`
 * appending "?" so the label differed anyway. Identity comparison on `points`/`labelPos` is
 * deliberate and matches what the layout produces: unmoved edges keep the same array.
 */
export function edgeUnchanged(old: ElkEdgeType | undefined, fresh: ElkEdgeType): boolean {
  if (!old) return false;
  if (old.source !== fresh.source || old.target !== fresh.target || old.sourceHandle !== fresh.sourceHandle) return false;
  const a = (old.data ?? {}) as Record<string, unknown>;
  const b = fresh.data as Record<string, unknown>;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
}

/**
 * Should this tick write a status message at all?
 *
 * `undefined` is "this tick has no opinion" (leave whatever is showing); `null` is "clear
 * it". Only a CHANGE is written: writing unconditionally re-rendered on every quiet poll,
 * and now that a rejection is re-reported on every 304 (see `PollState.failures`), an
 * unchanged error string would do the same once a second for as long as a broken graph sits
 * in the live dir. Pure and exported because the decision otherwise lives in an effect
 * where no test can reach it — the same reason `incrementalEligible` was extracted.
 */
export function writesAMessage(next: string | null | undefined, current: string | null): boolean {
  return next !== undefined && next !== current;
}

export const newPollState = (): PollState => ({ last: "", liveSeen: false, etags: new Map(), failures: new Map(), renderFailed: null });

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
      // …but "the bytes we already have" are not necessarily GOOD bytes: if they failed to
      // parse or failed the shape guard, that verdict still stands and must keep standing.
      if (r.status === 304) return { error: state.failures.get(url) ?? state.renderFailed };
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
    // A rejection is remembered against the url, so the 304 that follows it re-reports the
    // reason instead of clearing it; every path that accepts bytes forgets it again.
    const reject = (msg: string): PollResult => {
      state.failures.set(url, msg);
      return { error: msg };
    };
    if (text === state.last) {
      state.failures.delete(url); // a REJECTION was about other bytes; these are the accepted ones
      return { error: state.renderFailed }; // …but "accepted" is not "rendered" — see renderFailed
    }
    let g: unknown;
    try {
      g = JSON.parse(text);
    } catch (e) {
      return reject(`${url}: invalid JSON (${e instanceof Error ? e.message : String(e)})`);
    }
    const problem = checkGraphShape(g);
    if (problem) return reject(`${url}: ${problem}`);
    // Advance `last` BEFORE the caller renders: if installing the graph throws,
    // we must not spin on the same bad bytes — the next change retries.
    state.failures.delete(url);
    state.last = text;
    state.renderFailed = null; // a new graph gets its own verdict
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
  /** Ids that are never display nodes (the root, and grouping `file`s) — see `groupingSkip`. */
  skipped: Set<string>;
  /** name + kind + id, lowercased, one entry per IR node. */
  hay: string[];
  at: Map<string, number>;
  root: string;
}

export function buildSearchIndex(ir: GraphIR, skip: (n: IRNode) => boolean): SearchIndex {
  const ids: string[] = [];
  const parents: (string | undefined)[] = [];
  const hay: string[] = [];
  const at = new Map<string, number>();
  // Every IR node is INDEXED — the parent chain has to stay complete, or the walk that
  // keeps a match's visible container lit stops at the first skipped ancestor. What the
  // skipped ones must not be is MATCHES.
  const skipped = new Set<string>();
  for (const n of ir.nodes) {
    at.set(n.id, ids.length);
    ids.push(n.id);
    parents.push(n.parent);
    hay.push(`${n.name}\u0000${n.kind}\u0000${n.id}`.toLowerCase());
    if (skip(n)) skipped.add(n.id);
  }
  return { ids, parents, hay, at, root: ir.root, skipped };
}

/** Ids whose name, kind or id contains the query; null when nothing is filtered. */
export function searchMatches(index: SearchIndex | null, query: string): Set<string> | null {
  const q = query.trim().toLowerCase();
  if (!index || !q) return null;
  const out = new Set<string>();
  // A node that is never a display node is not a match: no expand can reveal it, so
  // counting it as "+N hidden" promises something no click can deliver. Its children are
  // display nodes and match on their own ids, which carry the skipped file's path anyway.
  for (let i = 0; i < index.hay.length; i++)
    if (index.hay[i].includes(q) && !index.skipped.has(index.ids[i])) out.add(index.ids[i]);
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
    // `index.skipped`, not `id === index.root`: this was the FOURTH copy of the rule for
    // "which nodes are never drawn" (after the layout, the budget and the Key), and it was
    // the pre-grouping version. A grouping `file` counted as a hidden match that no expand
    // could ever reveal, and its display parent is often the root — the canvas — so there
    // was nothing to light either: "0 +1 hidden", with nothing to click.
    if (shown.has(id) || index.skipped.has(id)) continue;
    hidden++;
    let p = parentOf(id);
    while (p && !shown.has(p)) p = parentOf(p);
    if (p) lit.add(p);
  }
  return { hidden, lit };
}


/** One row of the details panel's edge list. */
export interface Connection {
  id: string;
  out: boolean;
  /** How many source relations this display edge stands for — what the chip shows as `×N`. */
  count: number;
  selfLoop: boolean;
  otherName: string;
  /** Which node inside the selection the edge leaves, when that is not the selected node itself. */
  nearName: string | null;
  label: string;
}

/**
 * The selection's edges, biggest first — the readable form of a view whose chips are not drawn.
 *
 * `lit` is the selected node AND its subtree (store.litIds), because clicking a container
 * expands it and an expanded container is no longer an edge endpoint. An edge with BOTH
 * ends inside the selection is internal to it and says nothing about how it connects
 * outward — except a SELF-LOOP, which is recursion: `layout/elk.ts` only ever keeps one
 * that was authored on a visible node, and the canvas draws it, so dropping it here made
 * the panel and the picture disagree.
 */
export function connectionsOf(
  edges: readonly ElkEdgeType[],
  lit: ReadonlySet<string>,
  selected: string,
  names: ReadonlyMap<string, string>
): Connection[] {
  // The edge's own count, not a number scraped back out of its rendered label. The display
  // edge has carried `count` all along; recovering it from the chip text meant an author's
  // `annotations.<edge>.label` — which REPLACES that text — sorted as 1. The shipped
  // showcase graph has exactly that shape (`count: 2` with `label: "payment failed"`), so
  // its heaviest connection was listed last.
  return edges
    .filter((e) => crossesSelection(lit, e.source, e.target))
    .map((e) => {
      const out = lit.has(e.source);
      const other = out ? e.target : e.source;
      const near = out ? e.source : e.target;
      return {
        id: e.id,
        out,
        selfLoop: e.source === e.target,
        otherName: names.get(other) ?? other,
        // Selecting a container lights its whole subtree, so without the near end every row
        // of a 272-edge list read identically ("references ×4 from group:g0001").
        nearName: near === selected ? null : (names.get(near) ?? near),
        label: e.data?.label ?? "",
        count: e.data?.count ?? 1,
      };
    })
    .sort((a, b) => b.count - a.count || a.otherName.localeCompare(b.otherName));
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

/**
 * A DISPLAY edge's delta, from its own constituents. Several IR edges fold into one display
 * edge whenever a container is collapsed, so "some constituent was added" is the wrong
 * question: an edge that merely GREW from `calls ×3` to `calls ×4` was painted green as new,
 * and one that SHRANK got nothing while the status bar said "−1 removed" about a connection
 * still on screen. The right questions are the display edge's own — was any of me here
 * before, and if so has my summed multiplicity changed?
 */
export function displayEdgeDelta(
  irIds: readonly string[],
  count: number,
  delta: Pick<Delta, "compared" | "prevCount">,
  /** Summed multiplicity of REMOVED IR edges that used to fold into this display edge. */
  removedBefore = 0
): "added" | "modified" | undefined {
  if (!delta.compared) return undefined; // first load or a new root: nothing is a change
  let before = removedBefore;
  let any = removedBefore > 0;
  for (const id of irIds) {
    const c = delta.prevCount.get(id);
    if (c !== undefined) {
      any = true;
      before += c;
    }
  }
  if (!any) return "added";
  return before !== count ? "modified" : undefined;
}

/**
 * Where each REMOVED IR edge would fold today, summed by display-edge key — the part of a
 * display edge's previous multiplicity that its current `irIds` cannot see.
 */
export function removedByDisplayKey(
  removed: Delta["removedEdgeRecords"],
  rep: (id: string) => string | undefined
): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of removed) {
    const s = rep(r.from);
    const t = rep(r.to);
    if (s === undefined || t === undefined) continue; // an endpoint that renders nowhere now
    if (s === t && r.from !== r.to) continue; // folded onto one node: not a display edge
    const k = edgeKey(r.kind, s, t);
    out.set(k, (out.get(k) ?? 0) + r.count);
  }
  return out;
}

/**
 * What the status bar reports about a republish. Both halves count the same things — nodes
 * plus DRAWN edges — because they did not: "+N added" counted edges and "−N removed" counted
 * only nodes, so a display edge that vanished was reported nowhere at all (not the canvas,
 * not the Key, not here). `contains` is already excluded upstream in `diffIR`.
 */
export function deltaCounts(d: Delta): { added: number; modified: number; removed: number } {
  return {
    added: d.added.size + d.addedEdges.size,
    modified: d.modified.size + d.modifiedEdges.size,
    removed: d.removed.length + d.removedEdges.length,
  };
}

/**
 * How many matches are ON SCREEN — the left half of "N +M hidden", which with `hiddenMatchesOf`
 * must account for every match exactly once.
 *
 * MATCHES, not "nodes that are not dimmed": a container holding hidden matches is lit rather
 * than dimmed so the user can find their way to them, and counting those made the box read
 * "531 +216 hidden" where 720 nodes matched — the 27 lit tables counted once as matches and
 * again inside the 216. Pure and exported because it lived inline in JSX, where the fix that
 * corrected it could not be pinned by anything.
 */
export function visibleMatchCount(
  nodes: readonly { id: string }[],
  matched: ReadonlySet<string> | null,
  query: string
): number | null {
  if (!query.trim()) return null;
  return matched ? nodes.filter((n) => matched.has(n.id)).length : 0;
}

/**
 * Does this node get the container treatment? The ONE expression, and it had SIX copies: the
 * node renderer, the Key's swatch, the MiniMap colour, `aria-expanded`, the click handler and
 * the keyboard handler. A COLLAPSED container is still drawn as a box (a chip) — a legend
 * that asked only `isContainer` described a collapsed `module` with the leaf swatch — and it
 * is still the thing Enter/Space and a click toggle, so every one of them has to agree.
 * (`zIndex` and the `ariaLabel` text deliberately ask `isContainer` alone: an expanded
 * container is stacked and named differently from a collapsed one.)
 */
export const drawnAsBox = (d: { isContainer?: boolean; collapsed?: boolean }): boolean =>
  d.isContainer === true || d.collapsed === true;

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

/**
 * Legend rows: the kinds actually on screen, and whether each renders as a container.
 *
 * `groupingSkip`, not a copy of it. This was the THIRD copy of that rule and round 16
 * unified only the two in `elk.ts` and `budget.ts`, so the Key kept the pre-round-16
 * behaviour: a `file` with children was never listed, including the ones now drawn as
 * containers because they carry edges. The canvas showed four `FILE` containers and the
 * legend had no `file` row at all; in a mixed view it showed ONE `file` row with the store
 * swatch while two of the three files on screen were containers. Exported so this is
 * testable — the Key had no test of any kind.
 */
export function keyRows(
  nodes: readonly { data: { kind: string; isContainer?: boolean; collapsed?: boolean; delta?: string } }[],
  edges: readonly { data?: { kind?: string; inferred?: boolean; delta?: string } | undefined }[]
): { nodeKinds: [string, boolean][]; edgeKinds: string[]; inferred: boolean; added: boolean; modified: boolean } {
  // One row per (kind, TREATMENT) actually on screen, not per kind. A kind can be both:
  // since a `file` that carries an edge is drawn as a container while a leaf `file` is drawn
  // as a store, `package > {a,b,c}.ts + README.md` puts four `file` nodes on the canvas in
  // two different shapes. Folding them into one row with the treatments OR-ed described
  // whichever happened to win and left the other unexplained — in both directions, since the
  // legend is what a reader consults precisely when a shape is unfamiliar.
  const seen = new Set<string>();
  const rows: [string, boolean][] = [];
  for (const n of nodes) {
    const isContainer = drawnAsBox(n.data);
    const k = `${n.data.kind}\u0000${isContainer}`;
    if (seen.has(k)) continue;
    seen.add(k);
    rows.push([n.data.kind, isContainer]);
  }
  rows.sort(([a, ac], [b, bc]) => (a < b ? -1 : a > b ? 1 : ac === bc ? 0 : ac ? -1 : 1));
  // Edge kinds come from the DISPLAY edges, not the file: an `imports` row beside a canvas
  // with no arrows is exactly the tell rounds 16-18 each used to find silently destroyed
  // edges, so a legend that over-lists by construction retires the diagnostic.
  //
  // DISPLAY edges, not PAINTED ones. In a hairball view none of them is drawn until a node
  // is traced, and the row is still right: the edges exist, the status bar says how many are
  // hidden and why, and the legend explains the stroke the user is about to see. Filtering by
  // `edgeIsPainted` here would make the row vanish and reappear on every selection. The
  // diagnostic above survives because the hairball case ANNOUNCES itself — what it caught was
  // edges that were gone with nothing said anywhere.
  const ek = [...new Set(edges.map((e) => e.data?.kind).filter((k): k is string => !!k))].sort();
  // The delta and "inferred" rows come off the RENDERED objects too, for the same reason the
  // kinds do. They used to read `diffIR` over the whole IR, which knows nothing about
  // collapse state: a republish that added one node INSIDE a `collapsedByDefault` container
  // put a green "added since last graph" swatch in the legend with nothing green anywhere on
  // the canvas — and when the addition was an EDGE, the status bar stayed silent at the same
  // time, because it counts nodes only while the Key counted nodes plus edges. Two chrome
  // elements describing one event and disagreeing.
  return {
    nodeKinds: rows,
    edgeKinds: ek,
    inferred: edges.some((e) => e.data?.inferred === true),
    added: nodes.some((n) => n.data.delta === "added") || edges.some((e) => e.data?.delta === "added"),
    modified: nodes.some((n) => n.data.delta === "modified") || edges.some((e) => e.data?.delta === "modified"),
  };
}

function Key({ nodes, edges }: { nodes: readonly AtlasNode[]; edges: readonly ElkEdgeType[] }) {
  const { nodeKinds, edgeKinds, inferred: hasInferred, added, modified } = useMemo(
    () => keyRows(nodes, edges),
    [nodes, edges]
  );
  return (
    <details className="key" open>
      <summary>Key</summary>
      <div className="key-body">
        <div className="key-section">
          {nodeKinds.map(([kind, isC]) => (
            <div className="key-row" key={`${kind}:${isC}`}>
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
        {(added || modified) && (
          <div className="key-section">
            {/* Each row gated on its OWN set. `!isEmptyDelta(delta)` is true for REMOVALS
                alone, which have no swatch at all, so a republish that only deletes nodes
                put both rows in the legend beside "+0 added · ~0 modified". */}
            {added && (
              <div className="key-row">
                <span className="swatch-delta added" />
                <span>added since last graph</span>
              </div>
            )}
            {modified && (
              <div className="key-row">
                <span className="swatch-delta modified" />
                <span>modified</span>
              </div>
            )}
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
    if (drawnAsBox(d)) return t.tokens["--minimap-container"];
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
  const { ir, delta, collapsed, selected, litIds, status, budget, budgetInfo, lastToggle, setBudget, setIR, setPollError, toggleCollapse, collapseToFit, select } = useAtlas();
  const [nodes, setNodes] = useState<AtlasNode[]>([]);
  const [edges, setEdges] = useState<ElkEdgeType[]>([]);
  // ONE display-node predicate for this (graph, budget) — the layout, the incremental
  // splicer, the Key and the search index all get this exact function, and `autoCollapse`
  // derives the same one from `skipForBudget`. Four separate copies of the rule is how it
  // came to be wrong in all of them at once.
  const skip = useMemo(() => (ir ? skipForBudget(ir, budget) : () => false), [ir, budget]);
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
  /** "Collapse to fit" was clicked: refit once the resulting layout lands, not before. */
  const refitPending = useRef(false);
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
        if (writesAMessage(r.error, useAtlas.getState().status.error)) setPollError(r.error!);
        if (r.ir) setIR(r.ir, r.source!);
      } catch (e) {
        // `state.last` was already advanced for a graph that parsed and passed the
        // shape guard, so we do not spin on the same bad bytes; the next change retries.
        if (!ctrl.signal.aborted) {
          const msg = `render failed: ${e instanceof Error ? e.message : String(e)}`;
          state.renderFailed = msg; // …and keep saying so on the 304s that follow
          setPollError(msg);
        }
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
    const ready =
      !!lastToggle && !!prev && prev.ir === ir && prev.tidy === tidyEpoch && oneToggleAway(prev.collapsed, collapsed, lastToggle);
    const eligible = incrementalEligible(
      prev ? { fullMs: prev.fullMs, visible: prev.result.nodes.length } : null,
      ready,
      incrementalPref,
    );
    const full = () => layoutGraph(ir, collapsed, { pinned: positions.current.map, labelFor, skip });
    const run = eligible ? incrementalToggle(ir, collapsed, lastToggle!, prev!.result, { labelFor, skip }).then((r) => r ?? full()) : full();
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
                drawnAsBox(n) ? { "aria-expanded": n.collapsed ? "false" : "true" } : undefined,
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
            const same = nodeUnchanged(old, fresh);
            const obj = same ? old! : fresh;
            nextNodeObjs.set(n.ir.id, obj);
            return obj;
          })
        );
        nodeObjs.current = nextNodeObjs;
        const nextEdgeObjs = new Map<string, ElkEdgeType>();
        // Removed IR edges resolved onto the display edges they used to belong to, under THIS
        // layout's collapse state — the half of a display edge's previous multiplicity that
        // its surviving `irIds` cannot see (a shrink).
        const removedByKey = removedByDisplayKey(delta.removedEdgeRecords, result.rep);
        setEdges(
          le.map((e) => {
            const st = edgeStyle(e.kind);
            const inferred = inferredOf(e.irIds);
            // reduce, not Math.max(...): one display edge can aggregate every IR edge
            // between two collapsed containers, and spreading ~125k of them into a call
            // overflows the argument stack (layout/incremental.ts:childIndex made the
            // same trade for the same reason)
            const importance = e.irIds.reduce((m, id) => Math.max(m, ann[id]?.importance ?? 0.5), 0);
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
                kind: e.kind, // the Key reads this: the kinds DRAWN, not the kinds in the file
                count: e.count, // the details panel orders by this — never by parsing the label
                points: e.points,
                labelPos: e.labelPos,
                label: e.label,
                color: st.color,
                dash: inferred ? "4 4" : st.dash,
                width,
                inferred,
                delta: displayEdgeDelta(e.irIds, e.count, delta, removedByKey.get(edgeKey(e.kind, e.source, e.target))),
                faint: mode.dense,
                hairball: mode.hairball,
              },
            } satisfies ElkEdgeType;
            const old = edgeObjs.current.get(e.id);
            const same = edgeUnchanged(old, fresh);
            const obj = same ? old! : fresh;
            nextEdgeObjs.set(e.id, obj);
            return obj;
          })
        );
        edgeObjs.current = nextEdgeObjs;
        setLayoutError(null);
        setLayingOut(false);
        // Refit on a NEW graph, and on an explicit "collapse to fit" — but only once the
        // layout that collapse produced has actually landed. Bumping the epoch in the
        // click handler fit the PREVIOUS node set: `AutoFit` runs 60 ms later and the ELK
        // pass takes 400-600 ms, so the viewport ended up bit-identical to where it was
        // and most survivors were off-screen. (It appeared to work only because React
        // Flow re-fits by itself when it meets an unmeasured node — luck, and gone with
        // `?culling=0`.)
        if (lastFitIr.current !== ir || refitPending.current) {
          lastFitIr.current = ir;
          refitPending.current = false;
          setFitEpoch((e) => e + 1);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLayingOut(false);
        // A pending refit belongs to the layout that just failed. Leaving it set would
        // hand it to the NEXT successful layout — typically an unrelated user collapse,
        // which must never refit. (A CANCELLED pass keeps it on purpose: the layout that
        // superseded it is the one the user is waiting for.)
        refitPending.current = false;
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
  const searchIndex = useMemo(() => (ir ? buildSearchIndex(ir, skip) : null), [ir, skip]);
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
    activate(node.id, drawnAsBox(d));
  };
  const onCanvasKeyDown = (ev: React.KeyboardEvent<HTMLDivElement>) => {
    const id = keyActivation(ev.key, ev.target as unknown as KeyTarget);
    if (!id) return;
    ev.preventDefault(); // Space would scroll the pane
    const d = nodeObjs.current.get(id)?.data;
    activate(id, !!d && drawnAsBox(d));
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
  // MATCHES on screen, not "nodes that are not dimmed": a container holding hidden matches
  // is lit rather than dimmed so the user can find their way to them, and counting those as
  // matches made the two numbers in the box contradict each other. Measured on a 3-schema x
  // 30-table x 8-column graph, query "col": 720 columns match, 504 are on screen and 216 are
  // inside the 27 collapsed tables — and the box read "531 +216 hidden", counting those 27
  // tables once as matches (their own text contains no "col") and again inside the 216,
  // advertising 747 matches where there are 720.
  const matchCount = visibleMatchCount(nodes, matched, query);
  const counts = deltaCounts(delta);
  // Every display edge touching the selected node, biggest first — the
  // readable form of a dense view's edges (their chips are not drawn).
  // Same subtree rule as the canvas (store.litIds): an expanded container is not an edge
  // endpoint, its children are, so listing only edges naming the selected id left the
  // panel empty for every container the user clicked open. An edge with BOTH ends inside
  // the selection is internal to it and says nothing about how it connects outward.
  const connections = useMemo(
    () => (selected && ir ? connectionsOf(edges, litIds, selected, new Map(ir.nodes.map((n) => [n.id, n.name]))) : []),
    [edges, selected, ir, litIds]
  );
  // What the status bar may honestly call "hidden": the ones that are actually not drawn.
  // It used to report `edges.length` — every display edge — so after a selection lit 355 of
  // them the bar still claimed all 1,229 were hidden.
  const hiddenEdges = useMemo(
    () =>
      edges.reduce(
        (n, e) =>
          n +
          (edgeIsPainted(litIds, e.source, e.target, e.data) ? 0 : 1),
        0
      ),
    [edges, litIds]
  );
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
          <Key nodes={nodes} edges={edges} />
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
            {/* Refit AFTER the resulting layout lands (see refitPending). Collapse toggles
                deliberately do not refit — that fights manual navigation — but this one can
                take 1,500 nodes down to a handful, and at the zoom fitted for 1,500 the
                survivors are off-screen: the button appeared to delete the graph. */}
            <button
              onClick={() => {
                // Only refit if it actually collapsed something: on a flat level under the
                // root there is no candidate to fold, and a refit would throw away the
                // user's pan in exchange for nothing.
                if (collapseToFit()) refitPending.current = true;
              }}
            >
              collapse to fit
            </button>
          </span>
        )}
        {budgetInfo && budgetInfo.autoCollapsed > 0 && (
          // `nodes.length`/`edges.length`, not `budgetInfo.visible`/`.edges`: those are the
          // budget PASS's figures and go stale the moment the user toggles anything, so the
          // tooltip said "visible 503" beside text reading "showing 757".
          <span title={`visible ${nodes.length} of ${budgetInfo.total} · ${edges.length} edges drawn · budget ${budget.maxVisible} nodes / ${budget.maxEdges} edges (?budget=N,E)`}>
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
          <span
            title={
              layoutMode.hairball
                ? `dense view: ${edges.length} edges between ${nodes.length} nodes — too many to read as a picture, so an edge is drawn only while it touches the selection (or is newly added). The details panel lists the selection's edges with counts.`
                : "dense view: more than 3 edges per node — edges are drawn faint; select a node to light up its edges"
            }
          >
            {layoutMode.hairball
              ? `${hiddenEdges} of ${edges.length} edges hidden · select a node to trace them`
              : "edges faint · select a node to trace them"}
          </span>
        )}
        {status.error && <span title="the last good graph stays on screen">⚠ {status.error}</span>}
        {layoutError && <span>⚠ layout: {layoutError}</span>}
        {counts.removed > 0 && (
          <span title={[...delta.removed, ...delta.removedEdges].join("\n")}>−{counts.removed} removed</span>
        )}
        {counts.added + counts.modified > 0 && (
          <span>
            +{counts.added} added · ~{counts.modified} modified
          </span>
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
                        <span className="mono">{c.selfLoop ? "↺" : c.out ? "→" : "←"}</span>{" "}
                        {c.nearName && <span className="near">{c.nearName} </span>}
                        {c.label}
                        {c.selfLoop ? " (self)" : <>{c.out ? " to " : " from "}<b>{c.otherName}</b></>}
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
