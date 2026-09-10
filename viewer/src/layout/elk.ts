// ELK layered layout over the Graph IR display hierarchy.
//
// Display rules:
// - The root node is the canvas. `file` nodes are skipped only when they are
//   grouping levels (they have children); a leaf `file` in a
//   conceptual view is drawn like any other node.
// - `contains` edges are never drawn — containment renders as nesting.
// - Edges whose endpoints are hidden (inside a collapsed container) re-route to
//   the nearest visible ancestor; parallel edges aggregate with summed counts.
//   Edges that collapse onto one node (both ends inside the same collapsed
//   container) are dropped; authored self-loops (recursion) are kept.
// - Read-family edges are fed to ELK reversed so the data source lands above
//   its reader (the flow-down convention); the drawn arrow keeps the authored
//   direction.
// - ELK routes the edges (ORTHOGONAL) and places the label chips; both come
//   back in ROOT coordinates and are rendered by the custom `elk` edge type,
//   so edges no longer cut through nodes and chips no longer collide.
// - `pinned` (previous positions, relative to parent) makes the layout
//   INTERACTIVE: cycle breaking and crossing minimisation keep the previous
//   order, so a live refresh moves as little as possible (spec N3).
// - ELK runs in a real Web Worker in the browser (elk-worker.min.js); node
//   (tests) falls back to the bundled in-process build.

import type { ElkNode, ElkExtendedEdge, ElkLabel } from "elkjs/lib/elk-api";
import elkWorkerUrl from "elkjs/lib/elk-worker.min.js?url";
import type { GraphIR, IRNode, EdgeKind } from "../ir/types";
import { isReadFamily } from "../ir/families";
import { placeLabels, type Box } from "./labels";

export interface Point {
  x: number;
  y: number;
}

export interface DisplayNode {
  ir: IRNode;
  /** Display parent id (grouping files/root skipped), undefined for top-level. */
  parentId?: string;
  isContainer: boolean;
  collapsed: boolean;
  /** Relative to the parent (React Flow convention). */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayEdge {
  id: string;
  kind: EdgeKind;
  source: string;
  target: string;
  count: number;
  /** IR edge ids aggregated into this display edge (for annotations lookup). */
  irIds: string[];
  /**
   * ELK was fed target→source: a read-family edge (the data source lands ABOVE
   * its reader) or a `feedback: true` edge (drawn upward, out of ELK's cycle
   * breaking). The arrow still points in the authored direction.
   */
  reversed: boolean;
  /** Routed polyline in ROOT (absolute) coordinates, source → target order. */
  points?: Point[];
  /** Label chip centre in ROOT coordinates, when ELK placed it. */
  labelPos?: Point;
  /** Text ELK was asked to reserve room for (kind, count, and "?" for inferred). */
  label: string;
  selfLoop: boolean;
}

export interface LayoutMode {
  tier: LayoutTier;
  /** Edge-heavy view: more than DENSE_RATIO edges per visible node (and > DENSE_MIN_EDGES). */
  dense: boolean;
  /** Fastest tier or dense: polyline routing, containers laid out separately, chips at midpoints. */
  heavy: boolean;
  /** Produced by layout/incremental.ts: only the toggled subtree was laid out; "Tidy" runs a full pass. */
  incremental?: boolean;
}

export interface LayoutResult {
  /** DFS order — parents always precede children (React Flow requirement). */
  nodes: DisplayNode[];
  edges: DisplayEdge[];
  mode: LayoutMode;
  /**
   * Time spent laying this graph out, EXCLUDING one-time ELK engine construction
   * (worker boot, chunk load). The caller uses it to decide whether the next
   * collapse should take the incremental path — counting the boot made the first
   * toggle on even a tiny graph look expensive, so it silently dropped to
   * approximate layout and plain curves on the user's first interaction.
   */
  layoutMs: number;
}

export const LEAF_HEIGHT = 40;
/** Above this many display edges the label pass is skipped (layout time dominates anyway). */
export const LABEL_PASS_MAX_EDGES = 2500;

/**
 * Layout speed tier by visible size (measured 2026-09-05, database-shaped
 * graphs with cross-container edges, in-process ELK):
 *   quality  network-simplex placement, full crossing thoroughness, orthogonal
 *            — 800 visible: 1.8 s · 2000: 10.6 s · 4000: 51 s (8000: stack overflow)
 *   fast     longest-path layering, simple placement, thoroughness 1, orthogonal
 *            — 800: 1.0 s · 2000: 3.1 s · 4000: 14 s
 *   fastest  as fast, polyline routing — 800: 0.6 s · 2000: 2.2 s · 4000: 8.3 s · 8000: 29 s
 * The visibility budget (ir/budget.ts) keeps normal views in the quality tier.
 */
export type LayoutTier = "quality" | "fast" | "fastest";

/**
 * Wide containers: a layered layout puts every child without a visible
 * dependency into ONE layer, so 200 tables become a 30,000 px row. Above this
 * many visible direct children a container (or the root) switches to ELK's
 * MIN_WIDTH layering with a width bound derived from the count, which folds
 * the row into a roughly 1.6:1 block (measured 2026-09-05: 200 isolated nodes
 * 36796×94 → 2572×1550, 20 ms). Smaller containers keep the default layering,
 * so every existing view is unchanged.
 */
export const WIDE_CHILDREN = 12;
/** A view is "dense" when it has more than this many edges AND more than DENSE_RATIO edges per visible node. */
export const DENSE_MIN_EDGES = 200;
export const DENSE_RATIO = 3;
/** `isolated` = siblings with no edge ELK will see; a hub with 15 targets is NOT wide. */
export function wideLayering(isolated: number): Record<string, string> {
  if (isolated <= WIDE_CHILDREN) return {};
  // node ≈ 184 px incl. spacing, layer ≈ 104 px: b·184 = 1.6·(k/b)·104 → b ≈ 0.95·√k
  const bound = Math.max(4, Math.round(0.95 * Math.sqrt(isolated)));
  return {
    "elk.layered.layering.strategy": "MIN_WIDTH",
    "elk.layered.layering.minWidth.upperBoundOnWidth": String(bound),
  };
}
export const FAST_THRESHOLD = 400;
export const FASTEST_THRESHOLD = 1500;
/** Edges are the expensive part of hierarchical orthogonal routing: 1,200 cross-container edges cost 3 s to lay out and 2.4 s per pan (measured); above this many, the heavy path. */
export const FASTEST_EDGES = 800;
export function layoutTier(visibleNodes: number, displayEdges: number): LayoutTier {
  if (visibleNodes > FASTEST_THRESHOLD || displayEdges > FASTEST_EDGES) return "fastest";
  return Math.max(visibleNodes, displayEdges) > FAST_THRESHOLD ? "fast" : "quality";
}
const CHAR_W = 7.3;
const LABEL_H = 18;

/** Width ELK should reserve for a label chip (see .edge-chip in styles.css). */
export function labelWidth(text: string): number {
  return Math.round(text.length * 6.3 + 16);
}

/** Leaf pill width: name at ~7.3px/char + uppercase badge + padding/gap/border. */
export function leafWidth(n: IRNode): number {
  const badge = String(n.attrs?.typeKind ?? n.kind);
  const scale = leafScale(n);
  return Math.round(Math.max(132, n.name.length * CHAR_W + badge.length * 6.2 + 58) * scale);
}

/** Collapsed chip is wider than a pill: "+ BADGE" + bold name, no ellipsis allowed. */
export function collapsedWidth(n: IRNode): number {
  const badge = "+ " + String(n.attrs?.typeKind ?? n.kind);
  return Math.round(Math.max(132, badge.length * 7.4 + n.name.length * 7.6 + 48));
}

/** Floating title chip of an expanded container — the container must be at least this wide. */
export function containerMinWidth(n: IRNode): number {
  const badge = String(n.attrs?.typeKind ?? n.kind);
  return Math.round(badge.length * 7.4 + n.name.length * 7.6 + 60);
}

function leafScale(n: IRNode): number {
  const s = n.attrs?.scale;
  return typeof s === "number" && Number.isFinite(s) ? Math.min(3, Math.max(1, s)) : 1;
}

// --- ELK instance --------------------------------------------------------

type ElkInstance = { layout(graph: ElkNode): Promise<ElkNode> };
let elkPromise: Promise<ElkInstance> | null = null;

async function createElk(): Promise<ElkInstance> {
  if (typeof Worker !== "undefined") {
    // browser: real worker so a 1000-node layout never freezes the UI
    const { default: ELKApi } = await import("elkjs/lib/elk-api.js");
    return new ELKApi({ workerFactory: () => new Worker(elkWorkerUrl) }) as unknown as ElkInstance;
  }
  const { default: ELKBundled } = await import("elkjs/lib/elk.bundled.js");
  return new ELKBundled() as unknown as ElkInstance;
}

/** Start building the engine now: the first layout should not pay for worker boot. */
export function warmElk(): void {
  void getElk().catch(() => {}); // a failure here is retried by the real layout
}

function getElk(): Promise<ElkInstance> {
  if (!elkPromise) {
    // a failed worker start (chunk load, CSP) must not poison the session:
    // drop the rejected promise so the next layout retries
    elkPromise = createElk().catch((err) => {
      elkPromise = null;
      throw err;
    });
  }
  return elkPromise;
}

/** A hung worker must not leave the UI in "laying out…" forever. */
export const LAYOUT_TIMEOUT_MS = 60_000;
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`layout timed out after ${ms / 1000}s`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Display-edge id: unambiguous whatever characters the node ids contain. */
export function edgeKey(kind: string, source: string, target: string): string {
  return JSON.stringify([kind, source, target]);
}

// --- layout ----------------------------------------------------------------

export interface LayoutOptions {
  /** Previous positions (relative to parent) — enables ELK's interactive modes. */
  pinned?: ReadonlyMap<string, Point>;
  /** Extra per-edge label text, e.g. an annotation label or "?" for inferred. */
  labelFor?: (e: { kind: EdgeKind; count: number; irIds: string[] }) => string;
  /** Run the chip placement pass (layout/labels.ts). Default true; tests compare both. */
  labelPass?: boolean;
  /** Override the automatic edge routing choice (tier/density). */
  routing?: "ORTHOGONAL" | "POLYLINE";
  /** Override whether ELK reserves room for inline label chips (else chips sit at path midpoints). */
  elkLabels?: boolean;
  /** Extra ELK options merged into the root graph / every layered container (experiments, tests). */
  extraRootOptions?: Record<string, string>;
  extraContainerOptions?: Record<string, string>;
}

/** The display model behind a layout: what is visible, what renders where, which edges exist. */
export interface DisplayModel {
  byId: Map<string, IRNode>;
  /** IR child counts (a collapsed node with children renders as a wide chip). */
  irChildren: Map<string, number>;
  /** Display parent (root and grouping files skipped); undefined for top-level. */
  parentOf: Map<string, string | undefined>;
  childrenOf: Map<string, string[]>;
  visibleNodes: IRNode[];
  visibleIds: Set<string>;
  displayEdges: DisplayEdge[];
  /** Visible container: expanded and with at least one visible child. */
  isContainer: (id: string) => boolean;
  /** Leaf/collapsed-chip size for a visible non-container node. */
  leafSize: (id: string) => { width: number; height: number };
}

export function buildDisplay(
  ir: GraphIR,
  collapsed: ReadonlySet<string>,
  labelFor?: LayoutOptions["labelFor"]
): DisplayModel {
  const byId = new Map(ir.nodes.map((n) => [n.id, n]));
  const irChildren = new Map<string, number>();
  for (const n of ir.nodes) if (n.parent) irChildren.set(n.parent, (irChildren.get(n.parent) ?? 0) + 1);
  const skip = (n: IRNode) => n.id === ir.root || (n.kind === "file" && (irChildren.get(n.id) ?? 0) > 0);
  const displayParent = (n: IRNode): string | undefined => {
    let p = n.parent ? byId.get(n.parent) : undefined;
    while (p && skip(p)) p = p.parent ? byId.get(p.parent) : undefined;
    return p?.id;
  };

  const displayNodes = ir.nodes.filter((n) => !skip(n));
  const parentOf = new Map<string, string | undefined>();
  const childrenOf = new Map<string, string[]>();
  for (const n of displayNodes) {
    const p = displayParent(n);
    parentOf.set(n.id, p);
    if (p) {
      if (!childrenOf.has(p)) childrenOf.set(p, []);
      childrenOf.get(p)!.push(n.id);
    }
  }

  // --- visibility & edge re-routing -------------------------------------
  // rep(id) = the node an IR endpoint renders at: itself if visible, else the
  // outermost collapsed ancestor that is itself visible.
  const rep = (id: string): string | undefined => {
    let cur: string | undefined = id;
    while (cur && (!byId.has(cur) || skip(byId.get(cur)!))) cur = byId.get(cur)?.parent;
    if (!cur || !parentOf.has(cur)) return undefined;
    const chain: string[] = [];
    const seen = new Set<string>();
    for (let a: string | undefined = cur; a && !seen.has(a); a = parentOf.get(a)) {
      seen.add(a);
      chain.push(a);
    }
    for (let i = chain.length - 1; i >= 1; i--) if (collapsed.has(chain[i])) return chain[i];
    return cur;
  };

  const visible = (id: string): boolean => rep(id) === id;
  const visibleNodes = displayNodes.filter((n) => visible(n.id));
  const visibleIds = new Set(visibleNodes.map((n) => n.id));

  // `feedback: true` (annotation) marks the edge of a cycle the author wants
  // drawn UPWARD (retry / backorder loop). It is fed to ELK reversed exactly like
  // a read-family edge, so ELK never sees the cycle and the mainline keeps
  // flowing down; the drawn arrow keeps the authored direction. (ELK's own
  // per-edge priority is ignored for cycles that cross container boundaries.)
  const ann = ir.annotations ?? {};
  const agg = new Map<string, DisplayEdge>();
  for (const e of ir.edges) {
    if (e.kind === "contains") continue;
    const s = rep(e.from);
    const t = rep(e.to);
    if (!s || !t || !visibleIds.has(s) || !visibleIds.has(t)) continue;
    // both ends inside one collapsed container → nothing to draw; an authored
    // self-loop on a visible node is real information (recursion) and stays.
    if (s === t && e.from !== e.to) continue;
    const key = edgeKey(e.kind, s, t);
    const prev = agg.get(key);
    const count = e.count ?? e.locs?.length ?? 1;
    const feedback = ann[e.id]?.feedback === true && s !== t;
    if (prev) {
      prev.count += count;
      prev.irIds.push(e.id);
      prev.reversed ||= feedback;
    } else {
      agg.set(key, {
        id: key,
        kind: e.kind,
        source: s,
        target: t,
        count,
        irIds: [e.id],
        reversed: (isReadFamily(e.kind) && s !== t) || feedback,
        label: "",
        selfLoop: s === t,
      });
    }
  }
  const displayEdges = [...agg.values()];
  for (const e of displayEdges) {
    const base = e.count > 1 ? `${e.kind} ×${e.count}` : e.kind;
    e.label = labelFor ? labelFor(e) : base;
  }
  const isContainer = (id: string) =>
    !collapsed.has(id) && (childrenOf.get(id) ?? []).some((c) => visibleIds.has(c));
  const leafSize = (id: string) => {
    const n = byId.get(id)!;
    return {
      width: collapsed.has(id) && (irChildren.get(id) ?? 0) > 0 ? collapsedWidth(n) : leafWidth(n),
      height: Math.round(LEAF_HEIGHT * leafScale(n)),
    };
  };
  return { byId, irChildren, parentOf, childrenOf, visibleNodes, visibleIds, displayEdges, isContainer, leafSize };
}

export async function layoutGraph(
  ir: GraphIR,
  collapsed: ReadonlySet<string>,
  opts: LayoutOptions | ReadonlyMap<string, Point> = {}
): Promise<LayoutResult> {
  const options: LayoutOptions = opts instanceof Map ? { pinned: opts } : (opts as LayoutOptions);
  const pinned = options.pinned;
  const model = buildDisplay(ir, collapsed, options.labelFor);
  const { byId, irChildren, parentOf, childrenOf, visibleNodes, visibleIds, displayEdges, isContainer } = model;

  // --- build ELK graph ---------------------------------------------------

  // Containers whose visible SUBTREE is edge-free get grid packing; `touched`
  // holds every edge endpoint AND all of its display ancestors, so a container
  // is "connected" if any descendant carries an edge (rectpacking a container
  // whose grandchild has a cross-hierarchy edge makes ELK layered throw).
  const touched = new Set<string>();
  for (const e of displayEdges) {
    for (const end of [e.source, e.target]) {
      for (let a: string | undefined = end; a && !touched.has(a); a = parentOf.get(a)) touched.add(a);
    }
  }

  // Interactive modes only pay off when most of what is on screen was pinned;
  // otherwise ELK would order unpinned nodes by their default (0,0).
  let pinnedVisible = 0;
  if (pinned) for (const n of visibleNodes) if (pinned.has(n.id)) pinnedVisible++;
  const interactive = !!pinned && visibleNodes.length > 0 && pinnedVisible / visibleNodes.length >= 0.5;
  // Measured on the DFD example + sample graphs (2026-08-27): NETWORK_SIMPLEX placement
  // gives ~20% less area and ~15% shorter edges than the Brandes-Köpf default
  // once edges are routed orthogonally. ROOT ONLY: set on a nested container ELK
  // throws "NEdge must have a source and target". (Post-compaction was tried and
  // rejected: it shifts nodes by fractions of a pixel and un-squares the routes.)
  const tier = layoutTier(visibleNodes.length, displayEdges.length);
  // Edge-heavy views: every inline label is a dummy node in a layer, so 1,600
  // labels make a 200-table schema 32,000 px wide; orthogonal routing reserves
  // a channel per edge between layers, so 780 edges between 40 schemas make a
  // 165,000 px tower. Above the density threshold both go: polyline routing and
  // chips at path midpoints (measured 2026-09-05, see LayoutTier notes).
  const dense = displayEdges.length > DENSE_MIN_EDGES && displayEdges.length > DENSE_RATIO * visibleNodes.length;
  const heavy = tier === "fastest" || dense;
  const routing = options.routing ?? (heavy ? "POLYLINE" : "ORTHOGONAL");
  const elkLabels = options.elkLabels ?? (tier === "quality" && !dense);
  // Heavy views also drop INCLUDE_CHILDREN: routing every hierarchy-crossing
  // edge THROUGH a container's layering inserts a dummy per crossed layer
  // (1,600 cross edges made a 200-table schema 31,000 px wide). With
  // SEPARATE_CHILDREN each container is laid out on its own (that schema:
  // 1,692 px) and cross edges are drawn as plain curves between the nodes.
  const hierarchy = heavy ? "SEPARATE_CHILDREN" : "INCLUDE_CHILDREN";
  // Dense views get NO edges in ELK's input: a near-complete graph layered by
  // its edges is a 40-deep chain (each node its own layer); without them the
  // nodes fold into a grid (MIN_WIDTH) and the edges are drawn as faint curves
  // that light up on selection (App/ElkEdge). Layering conveys nothing in a
  // hairball anyway, and the routed alternative measured 165,000 px tall.
  const elkSeesEdges = !dense;
  // degree as ELK sees it (dense: no edges; separate children: same-parent edges only)
  const elkDegree = new Map<string, number>();
  if (elkSeesEdges)
    for (const e of displayEdges) {
      if (hierarchy === "SEPARATE_CHILDREN" && parentOf.get(e.source) !== parentOf.get(e.target)) continue;
      elkDegree.set(e.source, (elkDegree.get(e.source) ?? 0) + 1);
      elkDegree.set(e.target, (elkDegree.get(e.target) ?? 0) + 1);
    }
  const isolated = (ids: string[]) => ids.filter((id) => !(elkDegree.get(id) ?? 0)).length;
  const COMPACT: Record<string, string> =
    tier === "quality"
      ? { "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX" }
      : {
          "elk.layered.nodePlacement.strategy": "SIMPLE",
          "elk.layered.layering.strategy": "LONGEST_PATH",
          "elk.layered.crossingMinimization.thoroughness": "1",
          "elk.layered.crossingMinimization.greedySwitch.type": "OFF",
        };
  // semiInteractive keeps the previous in-layer order (from elk.position) while
  // still using the robust layer-sweep; the full INTERACTIVE strategy throws
  // "Invalid hitboxes" on hierarchical graphs once a container is collapsed.
  const INTERACTIVE: Record<string, string> = interactive
    ? {
        "elk.layered.cycleBreaking.strategy": "INTERACTIVE",
        "elk.layered.crossingMinimization.semiInteractive": "true",
      }
    : {};

  const toElk = (id: string): ElkNode => {
    const n = byId.get(id)!;
    const kids = (childrenOf.get(id) ?? []).filter((c) => visibleIds.has(c));
    const node: ElkNode = { id };
    if (!collapsed.has(id) && kids.length > 0) {
      node.children = kids.map(toElk);
      const connected = kids.some((k) => touched.has(k));
      node.layoutOptions = {
        // top clears the floating label chip; sides give the outline air
        "elk.padding": "[top=34,left=20,bottom=20,right=20]",
        // never narrower than the title chip
        "elk.nodeSize.constraints": "MINIMUM_SIZE",
        "elk.nodeSize.minimum": `(${containerMinWidth(n)},60)`,
        ...(connected
          ? {
              "elk.layered.spacing.nodeNodeBetweenLayers": "64",
              "elk.spacing.nodeNode": "44",
              "elk.spacing.edgeNode": "28",
              "elk.spacing.edgeEdge": "16",
              "elk.spacing.edgeLabel": "6",
              ...INTERACTIVE,
              ...wideLayering(isolated(kids)),
              ...(options.extraContainerOptions ?? {}),
            }
          : {
              "elk.algorithm": "rectpacking",
              "elk.aspectRatio": "2.2",
              "elk.spacing.nodeNode": "14",
            }),
      };
    } else {
      node.width = collapsed.has(id) && (irChildren.get(id) ?? 0) > 0 ? collapsedWidth(n) : leafWidth(n);
      node.height = Math.round(LEAF_HEIGHT * leafScale(n));
    }
    const pin = pinned?.get(id);
    if (pin && interactive) {
      node.x = pin.x;
      node.y = pin.y;
      node.layoutOptions = { ...node.layoutOptions, "elk.position": `(${pin.x},${pin.y})` };
    }
    return node;
  };

  const roots = visibleNodes.filter((n) => {
    const p = parentOf.get(n.id);
    return !p || !visibleIds.has(p);
  });

  const elkEdges: ElkExtendedEdge[] = displayEdges.map((e) => {
    const label: ElkLabel = {
      text: e.label,
      width: labelWidth(e.label),
      height: LABEL_H,
      layoutOptions: { "elk.edgeLabels.inline": "true" },
    };
    return {
      id: e.id,
      sources: [e.reversed ? e.target : e.source],
      targets: [e.reversed ? e.source : e.target],
      labels: elkLabels ? [label] : [],
    };
  });

  const graph: ElkNode = {
    id: "__root__",
    layoutOptions:
      displayEdges.length === 0 || !elkSeesEdges
        ? {
            "elk.algorithm": "rectpacking",
            "elk.aspectRatio": "2.2",
            "elk.spacing.nodeNode": "18",
          }
        : {
            "elk.algorithm": "layered",
            "elk.direction": "DOWN",
            "elk.hierarchyHandling": hierarchy,
            "elk.edgeRouting": routing,
            // edge sections + labels come back relative to the root, whatever
            // container the edge lives in — no offset accounting needed
            "elk.json.edgeCoords": "ROOT",
            "elk.edgeLabels.placement": "CENTER",
            "elk.layered.spacing.nodeNodeBetweenLayers": "72",
            "elk.spacing.nodeNode": "44",
            "elk.spacing.edgeNode": "28",
            "elk.spacing.edgeEdge": "16",
            "elk.spacing.edgeLabel": "6",
            "elk.spacing.componentComponent": "64",
            ...COMPACT,
            ...INTERACTIVE,
            ...wideLayering(isolated(roots.map((n) => n.id))),
            ...(options.extraRootOptions ?? {}),
          },
    children: roots.map((n) => toElk(n.id)),
    edges: elkSeesEdges ? elkEdges : [],
  };
  // Dense + a single connected level would otherwise rectpack: keep the layered
  // grid (MIN_WIDTH) so the result reads as rows, like every other big view.
  if (!elkSeesEdges && displayEdges.length > 0) {
    graph.layoutOptions = {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.hierarchyHandling": hierarchy,
      "elk.layered.spacing.nodeNodeBetweenLayers": "40",
      "elk.spacing.nodeNode": "28",
      "elk.spacing.componentComponent": "40",
      ...COMPACT,
      ...INTERACTIVE,
      ...wideLayering(isolated(roots.map((n) => n.id))),
      ...(options.extraRootOptions ?? {}),
    };
  }

  const elk = await getElk();
  const started = performance.now(); // after engine construction: that cost is once per session
  const laid = await withTimeout(elk.layout(graph), LAYOUT_TIMEOUT_MS);

  // --- flatten to DFS list (positions relative to parent, as RF expects) ---
  const out: DisplayNode[] = [];
  const walk = (elkNode: ElkNode, parentId?: string) => {
    for (const child of elkNode.children ?? []) {
      const irNode = byId.get(child.id)!;
      out.push({
        ir: irNode,
        parentId,
        isContainer: isContainer(child.id),
        collapsed: collapsed.has(child.id),
        x: child.x ?? 0,
        y: child.y ?? 0,
        width: child.width ?? 120,
        height: child.height ?? LEAF_HEIGHT,
      });
      walk(child, child.id);
    }
  };
  walk(laid);

  // --- routed edges (ROOT coordinates) ---------------------------------
  const routed = new Map<string, ElkExtendedEdge>();
  const collect = (n: ElkNode) => {
    for (const e of (n.edges ?? []) as ElkExtendedEdge[]) routed.set(e.id, e);
    for (const c of n.children ?? []) collect(c);
  };
  collect(laid);
  for (const e of displayEdges) {
    const r = routed.get(e.id);
    const sec = r?.sections?.[0];
    if (sec) {
      const pts: Point[] = [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint].map((p) => ({ x: p.x, y: p.y }));
      // NETWORK_SIMPLEX places nodes at fractional coordinates and the router
      // then returns segments that are off-axis by a fraction of a pixel —
      // square them so every segment is exactly horizontal or vertical.
      for (let i = 1; i < pts.length; i++) {
        if (Math.abs(pts[i].x - pts[i - 1].x) < 1) pts[i].x = pts[i - 1].x;
        else if (Math.abs(pts[i].y - pts[i - 1].y) < 1) pts[i].y = pts[i - 1].y;
      }
      // ELK routed in layout direction; the drawn arrow keeps the authored one
      e.points = e.reversed ? pts.reverse() : pts;
    }
    const lab = r?.labels?.[0];
    if (lab && typeof lab.x === "number" && typeof lab.y === "number") {
      e.labelPos = { x: lab.x + (lab.width ?? 0) / 2, y: lab.y + (lab.height ?? 0) / 2 };
    }
  }

  // --- label placement pass 2: slide chips along their own path ----------
  // (see layout/labels.ts; ELK's position is the first candidate and wins
  // whenever it is already clean)
  // (skipped in the polyline tier: diagonal segments make the grid index
  // pointless and at that scale chips at ELK's positions are good enough)
  if (options.labelPass !== false && tier !== "fastest" && displayEdges.length > 0 && displayEdges.length <= LABEL_PASS_MAX_EDGES) {
    const abs = new Map<string, Box>();
    const leaves: Box[] = [];
    const containers: Box[] = [];
    for (const n of out) {
      const p = n.parentId ? abs.get(n.parentId) : undefined;
      const b = { x: (p?.x ?? 0) + n.x, y: (p?.y ?? 0) + n.y, w: n.width, h: n.height };
      abs.set(n.ir.id, b);
      (n.isContainer ? containers : leaves).push(b);
    }
    const placed = placeLabels(
      displayEdges
        .filter((e) => e.points && e.points.length >= 2)
        .map((e) => ({ id: e.id, points: e.points!, w: labelWidth(e.label), h: LABEL_H, pos: e.labelPos })),
      { leaves, containers }
    );
    for (const e of displayEdges) {
      const p = placed.get(e.id);
      if (p) e.labelPos = p.pos;
    }
  }

  return { nodes: out, edges: displayEdges, mode: { tier, dense, heavy }, layoutMs: performance.now() - started };
}
