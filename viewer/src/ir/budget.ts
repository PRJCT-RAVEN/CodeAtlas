// Visibility budget for big graphs (2026-09-05, "database scale").
//
// ELK and React Flow only ever see the VISIBLE display graph, so a 100k-node
// file is fine as long as most of it starts collapsed. This module decides
// which containers to collapse on first sight so the visible node and edge
// counts stay under a budget: whole depth levels at a time, deepest first
// (every table before any schema, every type before any module -- the view
// stays uniform and the coarse structure stays on screen), largest subtree
// first within a level, ids as the tie-break, so the result is deterministic.
// The LAST level goes only as far as it has to (2026-09-10): folding it whole
// because the view was three nodes over budget cost a whole level of context --
// a 600-table Postgres import landed on one schema chip -- so there the biggest
// subtrees fold and the rest stay open, and the one fold that is always refused is the
// one that would leave a single chip on the canvas (see MIN_OVERVIEW). A PARTIAL level is
// deliberately absent from `levels`: the store remembers those depths and collapses
// newcomers there unconditionally, which would finish the level off on the next poll.
// The user's own expand/collapse decisions are never revisited (the store
// passes them as `exclude`), and neither are the display ancestors of a
// container the user expanded: collapsing a schema would hide the table the
// user just opened.
//
// Both counts are maintained INCREMENTALLY as containers fold (a hidden-node set,
// and display edges bucketed by the id they render at). Recomputing them per level
// was O(levels x graph) -- 5.7 s on a 20,000-deep chain -- and the per-container
// decision above would have made that O(candidates x graph).

import type { GraphIR, IRNode } from "./types";
import { FASTEST_EDGES, edgeKey, isHairball } from "./density";
import { skipForBudget, VIEW_NODE_CAP } from "./grouping";


export interface BudgetOptions {
  /** Max visible display nodes (leaves + containers) after auto-collapse. */
  maxVisible: number;
  /** Max aggregated display edges after auto-collapse. */
  maxEdges: number;
}

/**
 * Measured 2026-09-05: about 1 s of ELK for ~600 visible nodes/edges with cross-container edges.
 * The edge cap IS `FASTEST_EDGES` (imported, not a third copy of 800) — a budgeted view
 * stays inside the tier that still routes edges orthogonally.
 */
export const DEFAULT_BUDGET: BudgetOptions = { maxVisible: VIEW_NODE_CAP, maxEdges: FASTEST_EDGES };

/**
 * Above this many VISIBLE nodes the viewer says so and offers to collapse back.
 *
 * PROJECT_SPEC §3(C)/N4 asked for a hard cap that force-collapses instead of
 * rendering. The budget already does that for a graph as it ARRIVES; the gap this
 * fills is a user expanding their way past it afterwards. Forcing a collapse there
 * would undo the click the user just made, so this warns and offers the action
 * instead — the spec's protection, without fighting the person using it.
 */
export const RENDER_WARN = 800;

/**
 * One chip is not a view: the pass never folds the canvas down to a single node.
 *
 * Two rules were tried and both were wrong. Refusing a fold that hid more than HALF of
 * what was on screen, but only while the view was within 2x a cap, inverted the product
 * for real `tools/schema2ir.mjs` output — the bigger the database, the less of it opened,
 * 1,200 tables showing 36 of 10,836 display nodes and 4,000+ showing ONE, because the
 * aggregated foreign keys sit far past 2x the edge cap and the phases then folded the
 * bucket level and the schema level unchecked. Applying that same half-the-view rule
 * ALWAYS fixed those but broke the flagship 104k-node case: `MOST` is measured against a
 * `visible` that shrinks as a level folds, so the first container in a level is judged
 * against a big denominator and the last against a small one, and a clean 40-schema
 * overview (780 edges, all drawn) became 39 chips plus one arbitrary schema exploded into
 * 200 tables (1,648 edges, past FASTEST_EDGES, none drawn).
 *
 * The pathological case was never "more than half" — it is always "fold the last container
 * standing and leave the canvas empty". So that is what is refused: every level folds as
 * far as the caps ask, right up to the point where one node would be left. Cap compliance
 * is what yields there, because `layoutTier` has a cheaper tier for edge overflow and no
 * tier can recover context that has been folded away.
 *
 * In practice `MOST_OF_A_VIEW` below SHADOWS this floor for every budget of 3 or more: a
 * fold that leaves exactly one node hides `visible - 1`, which is always past a
 * half-of-the-view ceiling; below 3 the `keepsEnough` escape fires first. So this is a
 * backstop rather than the rule doing the work — changing it to 1 alters no outcome the
 * suite can produce. It stays because `MOST_OF_A_VIEW` is a tuning number that has been
 * retuned four times, while "never a single chip" is the invariant all of this states.
 */
export const MIN_OVERVIEW = 2;

/**
 * …unless the view is already too big to render, where a chip beats a hang.
 *
 * The number is the size at which that is ACTUALLY true, from this project's own
 * measurements (see "Measured" in CLAUDE.md): 1,005 visible loads in 1.1 s and pans in
 * 250 ms, 2,010 in 2.0 s / 0.7 s, 4,020 in 7.6 s with multi-second pans. It was 1,500 —
 * below the point where anything is unrenderable — and because the check below bails out
 * BEFORE measuring, while the LARGEST container in a level is judged first and therefore
 * while `visible` is at its maximum, that container was exactly the one that escaped the
 * guard: a real `fs2ir` tree of 1,600 generated files beside src/ and docs/ opened on SIX
 * nodes of 1,606, with no render warning and no "collapse to fit" to recover with.
 *
 * Any threshold is a cliff when the only available fold is all-or-nothing, and this one
 * still is: past it the same tree becomes a chip. What the number buys is that the cliff
 * sits where the alternative is genuinely unusable rather than merely large.
 *
 * A flat 4,000-table schema has no intermediate level to fall back to: the only two views
 * are 4,001 chips and one. Measured in headless Chromium, 4,001 visible nodes with 7,989
 * display edges is 12.7 s to load and 29 s to drag — and 2.0 edges per node, so it is not
 * even dense enough for the hairball path to save it. Above the layout's own cheapest-tier
 * boundary the guard therefore stands down: one chip the user can open deliberately beats a
 * view that cannot be moved. `CLAUDE.md` says it plainly — author big graphs as containers;
 * a flat container cannot be budgeted. (NOT `FASTEST_THRESHOLD`, which is 1,500 and is a
 * layout-tier boundary, not a usability one — this was once described as mirroring it,
 * which would silently halve the threshold for anyone who "restored" the mirror.)
 */
const UNRENDERABLE = 3000;

/**
 * …and the same stand-down on aggregated display EDGES, because that is the axis the cost
 * actually lives on and `UNRENDERABLE` only counts nodes.
 *
 * Measured in the running viewer (headless Chromium, load = navigation until the layout
 * settles, drag = a 10-step pointer pan): `db(1,1200,8)` 1,201 visible / 2,390 edges →
 * 2.7 s / 1.3 s · `db(1,1999,8)` 2,000 / 3,991 → 4.8 s / 3.3 s · `db(1,2999,8)` 3,000 /
 * 5,987 → 8.3 s / 6.5 s. That last one sits INSIDE the node guard and is slower than the
 * 4,020-node case the guard's own docstring calls unusable — and it is not dense (2.0
 * edges per node, under `DENSE_RATIO`), so the hairball economy never engages either.
 *
 * Only for views the viewer would really PAINT: a hairball costs zero SVG paths, so this
 * never fires on one (see `isHairball`). And it is the larger of this and the caller's own
 * `maxEdges`, so an explicit `?budget=600,1000000` means what it says.
 *
 * Set well clear of the shapes the guard must keep protecting: `db(3,500,6)` aggregates to
 * ~3,000 display edges at the level where its schema fold is refused, and folding it is
 * exactly what must NOT happen. Only a hand-authored or third-party IR reaches this band —
 * `schema2ir` buckets above 200 tables (a 2,815-table catalog opens on 57 nodes) and
 * `fs2ir` trees have no edges at all.
 */
const UNRENDERABLE_EDGES = 5000;

/**
 * The most of a view ONE fold may hide (unless it still leaves a full budget — see
 * `refuseFold`).
 *
 * ONE fold — never a bound on what a LEVEL hides in total, and it must not be read as one.
 * For k roughly equal siblings every fold passes on its own (each is under half of what is
 * on screen when its turn comes) and the level still folds whole: two 200-file directories
 * with 2,394 references between them open on two chips. That is the intended answer, the
 * same one `db(2, 700, 6)` gives for the same shape, and better than the half-folded
 * alternative — one chip beside 200 exploded files, 933 display edges, still a hairball so
 * not one of them drawn. `MIN_OVERVIEW` is the floor that is absolute; this is a ceiling on
 * a single fold, and the edge phase's own stand-down (see `stuckAt`) is what stops a level
 * that has nothing left to gain.
 *
 * Applied by EVERY `foldLevel` call — the uniform pre-pass, the node phase and the edge
 * phase — against the count on screen as that LEVEL begins. This granularity has been
 * wrong in all three other directions, so it is worth stating why:
 *   per sibling — the denominator shrinks as the level folds, so the first container is
 *                 judged against a big number and the last against a small one: a uniform
 *                 40-chip overview of a 104k graph came back as 39 chips and one schema
 *                 exploded into 200 tables.
 *   per phase   — a constant only ever bounds the FIRST level it touches, so a tree with
 *                 two container levels lost the guard at the shallow end: 2,084 real
 *                 fs2ir nodes opened on fourteen.
 *   per graph   — never tried, and would be the per-phase bug with a bigger constant.
 */
const MOST_OF_A_VIEW = 0.5;

export interface BudgetResult {
  /** Container ids to collapse (in the order they were chosen). */
  collapse: string[];
  /** Display depths whose WHOLE level this pass (or `uniformLevels`) collapsed. */
  levels: number[];
  /** Display nodes in the graph (root and grouping files excluded). */
  total: number;
  visible: number;
  edges: number;
  /** Display nodes hidden by this pass. */
  hidden: number;
}

interface Model {
  byId: Map<string, IRNode>;
  /** Display parent (root and grouping `file` nodes skipped). */
  parentOf: Map<string, string | undefined>;
  childrenOf: Map<string, string[]>;
  display: string[];
  /**
   * The display node an IR endpoint belongs to: itself, or the nearest ancestor that is
   * not skipped. Mirrors the first stage of `rep()` in layout/elk.ts.
   *
   * BELT AND BRACES as of round 16, not the mechanism — the docstring here used to claim it
   * was what kept `package > module > file > function` from counting ZERO display edges
   * where the layout had 190. `groupingSkip` is what does that now: a `file` that carries an
   * edge is no longer skipped at all. Since this is called only with the endpoints of
   * non-`contains` edges, and the only nodes still skipped are the root and files that are
   * NOT such endpoints, the sole input that can walk even one step is the ROOT — whose
   * parent is undefined, so it terminates immediately and the edge is dropped, which is
   * right: the root is the canvas.
   */
  displayOf: (id: string) => string | undefined;
}

function buildModel(ir: GraphIR, skip: (n: IRNode) => boolean): Model {
  const byId = new Map(ir.nodes.map((n) => [n.id, n]));

  const parentOf = new Map<string, string | undefined>();
  const childrenOf = new Map<string, string[]>();
  const display: string[] = [];
  for (const n of ir.nodes) {
    if (skip(n)) continue;
    let p = n.parent ? byId.get(n.parent) : undefined;
    while (p && skip(p)) p = p.parent ? byId.get(p.parent) : undefined;
    parentOf.set(n.id, p?.id);
    display.push(n.id);
    if (p) {
      const arr = childrenOf.get(p.id);
      if (arr) arr.push(n.id);
      else childrenOf.set(p.id, [n.id]);
    }
  }
  const displayOf = (id: string): string | undefined => {
    let cur: string | undefined = id;
    while (cur !== undefined && !parentOf.has(cur)) cur = byId.get(cur)?.parent;
    return cur;
  };
  return { byId, parentOf, childrenOf, display, displayOf };
}

/** One aggregated display edge in flight: `s`/`t` are the ids its endpoints currently render at. */
interface DisplayEdge {
  kind: string;
  from: string;
  to: string;
  s: string;
  t: string;
  /** null once both endpoints render at the same id — an edge that folded into a node, and can never reappear. */
  key: string | null;
}

// The tree walks below are iterative: a graph deep enough to exhaust the JS stack
// passes shape.ts (which is iterative and memoised), so a recursive walk here would
// throw out of setIR and — before the poll loop re-armed in a finally — kill the
// live loop for good.
export function autoCollapse(
  ir: GraphIR,
  collapsed: ReadonlySet<string>,
  opts: BudgetOptions = DEFAULT_BUDGET,
  exclude: ReadonlySet<string> = new Set(),
  /** Depths collapsed by an earlier pass: a container that newly appears there is collapsed too, so the level stays uniform. */
  uniformLevels: ReadonlySet<number> = new Set(),
  /**
   * Drop the anti-gutting guard (MIN_OVERVIEW). Only for an explicit "collapse to fit":
   * the guard exists so the AUTOMATIC pass never empties the canvas, but someone who
   * clicks the button has asked for exactly that, and a guard that silently declines makes
   * the button a no-op. `over()` still stops the fold the moment the view fits, so a single
   * chip is the last resort, not the first move.
   */
  force = false
): BudgetResult {
  // The budget's own cap decides where the grouping tidy-up stops being free, and the layout
  // is handed the SAME predicate (see App.tsx) so the two models cannot disagree.
  const m = buildModel(ir, skipForBudget(ir, opts));
  const cur = new Set(collapsed);

  // One walk from the display roots answers both questions the pass keeps asking:
  // what is hidden under an already-collapsed container, and what each display node
  // RENDERS at (its highest collapsed ancestor, else itself).
  const hidden = new Set<string>();
  const repOf = new Map<string, string>();
  let before = 0;
  {
    const stack: Array<[string, string | null]> = [];
    for (const id of m.display) if (m.parentOf.get(id) === undefined) stack.push([id, null]);
    while (stack.length) {
      const [id, top] = stack.pop()!;
      if (top === null) before++;
      else hidden.add(id);
      repOf.set(id, top ?? id);
      const kids = m.childrenOf.get(id);
      if (kids) {
        const below = top ?? (cur.has(id) ? id : null);
        for (const c of kids) stack.push([c, below]);
      }
    }
  }
  let visible = before;

  // Display edges keyed by (kind, source rep, target rep), bucketed by the ids they
  // render at, so collapsing a container only re-keys the edges beneath it.
  const dedges: DisplayEdge[] = [];
  const incident = new Map<string, number[]>();
  const keyCount = new Map<string, number>();
  // `edgeKey` from the layout engine, not a hand-rolled `${kind} ${s} ${t}`: node ids may
  // contain spaces (`fs2ir` emits `doc:My Folder/x`), and two different pairs could then
  // key to the same string and undercount. One definition, shared.
  const keyOf = (d: DisplayEdge) => (d.s === d.t && d.from !== d.to ? null : edgeKey(d.kind, d.s, d.t));
  const addKey = (k: string | null) => {
    if (k !== null) keyCount.set(k, (keyCount.get(k) ?? 0) + 1);
  };
  const dropKey = (k: string | null) => {
    if (k === null) return;
    const n = keyCount.get(k)!;
    if (n > 1) keyCount.set(k, n - 1);
    else keyCount.delete(k);
  };
  const attach = (id: string, i: number) => {
    const arr = incident.get(id);
    if (arr) arr.push(i);
    else incident.set(id, [i]);
  };
  for (const e of ir.edges) {
    if (e.kind === "contains") continue;
    // Resolve each endpoint to the display node it belongs to first — see `displayOf`.
    const df = m.displayOf(e.from);
    const dt = m.displayOf(e.to);
    if (df === undefined || dt === undefined) continue; // an endpoint that is not drawn at all
    // `from`/`to` stay the ORIGINAL ir ids: `keyOf` uses them to tell an authored
    // self-loop (recursion — kept) from an edge whose two ends resolved to the same
    // display node (folded away — dropped), exactly as `buildDisplay` does. Using the
    // resolved ids there counted every same-module `imports` edge as a self-loop.
    const d: DisplayEdge = { kind: e.kind, from: e.from, to: e.to, s: repOf.get(df)!, t: repOf.get(dt)!, key: null };
    d.key = keyOf(d);
    if (d.key === null) continue; // already folded away; no further collapse can bring it back
    const i = dedges.length;
    dedges.push(d);
    addKey(d.key);
    attach(d.s, i);
    if (d.t !== d.s) attach(d.t, i);
  }
  /** Move every edge rendering at `from` onto `to` (the container `from` just folded into). */
  const rekey = (from: string, to: string) => {
    const list = incident.get(from);
    if (!list) return;
    incident.delete(from);
    const keep: number[] = [];
    for (const i of list) {
      const d = dedges[i];
      dropKey(d.key);
      if (d.s === from) d.s = to;
      if (d.t === from) d.t = to;
      d.key = keyOf(d);
      addKey(d.key);
      if (d.key !== null) keep.push(i);
    }
    const arr = incident.get(to);
    if (arr) for (const i of keep) arr.push(i);
    else incident.set(to, keep);
  };

  /**
   * Display edges left if every container in `fold` collapsed — EXACT, not an estimate:
   * everything still open beneath a folded container renders at it, and `keyOf`'s
   * self-loop rule is the same one the incremental counter uses.
   *
   * The edge phase needs this to answer one question: is there a drawable state left to
   * reach? Folding costs context that no layout tier can give back, so a fold is only
   * worth it when the level it belongs to can actually get under `maxEdges`. See
   * `stuckAt` below for when it is consulted (rarely — at most twice per level, and only
   * after something has already been refused).
   */
  const edgesIfFolded = (fold: Set<string>): number => {
    if (fold.size === 0) return keyCount.size;
    const memo = new Map<string, string>();
    const clamp = (id: string): string => {
      const seen = memo.get(id);
      if (seen !== undefined) return seen;
      let r = id;
      // The FIRST folding ancestor, and there is never a second: `fold` is always the open
      // members of ONE depth level, so no node can have two of them above it. Taking the
      // outermost instead would be indistinguishable — a branch no test could ever reach.
      for (let a = m.parentOf.get(id); a !== undefined; a = m.parentOf.get(a))
        if (fold.has(a)) {
          r = a;
          break;
        }
      memo.set(id, r);
      return r;
    };
    const keys = new Set<string>();
    for (const d of dedges) {
      if (d.key === null) continue; // already folded away; no further fold brings it back
      const s = clamp(d.s);
      const t = clamp(d.t);
      const k = keyOf({ ...d, s, t });
      if (k !== null) keys.add(k);
    }
    return keys.size;
  };

  // depth + subtree size per display node
  const depth = new Map<string, number>();
  const size = new Map<string, number>();
  // walk UP to the first known depth, then fill the chain back down
  const depthOf = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    const chain: string[] = [];
    let cur: string | undefined = id;
    let base = 0;
    while (cur !== undefined) {
      const d = depth.get(cur);
      if (d !== undefined) {
        base = d;
        break;
      }
      chain.push(cur);
      cur = m.parentOf.get(cur);
    }
    // cur === undefined → the last id pushed is a display root at depth 0
    for (let i = chain.length - 1, d = cur === undefined ? -1 : base; i >= 0; i--) depth.set(chain[i], ++d);
    return depth.get(id)!;
  };
  // post-order over an explicit stack: children are summed before their parent
  const sizeOf = (id: string): number => {
    const known = size.get(id);
    if (known !== undefined) return known;
    const stack: Array<{ id: string; expanded: boolean }> = [{ id, expanded: false }];
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (size.has(top.id)) {
        stack.pop();
        continue;
      }
      const kids = m.childrenOf.get(top.id) ?? [];
      if (!top.expanded) {
        top.expanded = true;
        for (const c of kids) if (!size.has(c)) stack.push({ id: c, expanded: false });
        continue;
      }
      stack.pop();
      let v = 1;
      for (const c of kids) v += size.get(c)!;
      size.set(top.id, v);
    }
    return size.get(id)!;
  };
  // ancestors of excluded-and-expanded containers are off limits too
  const protectedIds = new Set(exclude);
  for (const id of exclude) {
    if (cur.has(id) || !m.parentOf.has(id)) continue;
    for (let a = m.parentOf.get(id); a !== undefined; a = m.parentOf.get(a)) protectedIds.add(a);
  }
  const candidates = m.display
    .filter((id) => (m.childrenOf.get(id)?.length ?? 0) > 0 && !cur.has(id) && !protectedIds.has(id))
    .sort((a, b) => depthOf(b) - depthOf(a) || sizeOf(b) - sizeOf(a) || (a < b ? -1 : a > b ? 1 : 0));

  const chosen: string[] = [];
  const collapse = (id: string) => {
    // everything still visible under `id` folds into it
    const stack = [...(m.childrenOf.get(id) ?? [])];
    let n = 0;
    while (stack.length) {
      const c = stack.pop()!;
      if (hidden.has(c)) continue;
      hidden.add(c);
      n++;
      rekey(c, id);
      if (cur.has(c)) continue;
      // A LOOP, not `stack.push(...kids)`: spreading a container's children into a call
      // overflows the argument stack past ~125k (lower inside a deep stack, which `setIR`
      // is), and the throw escapes `setIR` — the status bar then reads "render failed" and
      // `state.last` has already advanced, so the same bytes are never retried and the
      // graph is unrenderable until the file changes. Reachable through the `uniformLevels`
      // pre-pass, which folds a NEWCOMER container while its own child is still expanded,
      // so the deepest-first ordering that shields the other call sites does not apply.
      // Same hazard as App.tsx's `Math.max(...irIds)` and incremental.ts's `childIndex`.
      const kids = m.childrenOf.get(c);
      if (kids) for (const k of kids) stack.push(k);
    }
    cur.add(id);
    chosen.push(id);
    visible -= n;
  };
  /**
   * Refuse folding `id`? `maxHidden` is the LEVEL's ceiling on what one fold may hide.
   *
   * An explicit tiny budget is honoured by `keepsEnough` below, not by a special case:
   * at `?budget=1` or `2`, half a budget is ≤ 1, and a fold always leaves at least the
   * container it folded — so "what is LEFT is still a view" is true and the fold is
   * allowed. (Two dedicated escapes used to sit here for that, and both were dead: with
   * them removed the outcome is byte-identical across every graph and budget the suite
   * can build. They are gone rather than kept as a backstop, because a dead clause that
   * LOOKS like the mechanism is how the next person mis-attributes the behaviour.)
   *
   * From `?budget=3` up the proportional ceiling takes over and has no escape, so a graph
   * whose only fold leaves almost nothing — a flat 1,499-table schema — returns 1,500 for
   * any larger budget: the request is about size, the guard is about usefulness, and
   * "collapse to fit" (`force`) is the way to overrule it.
   */
  const refuseFold = (id: string, maxHidden: number) => {
    // nothing to protect: the view is past the point of being renderable on either axis.
    // The `visible > opts.maxVisible` conjunct below means "and the NODE budget is not met
    // either" — a view already inside the size it was asked for is not gutted to satisfy an
    // edge cap, which is the same trade CLAUDE.md states the other way round ("the edge cap
    // is the one that yields"). It does NOT confine the stand-down to the node phase, as
    // this said until 2026-09-10: the node phase can end on a REFUSAL, and then the edge
    // phase runs with the node budget still unmet — `db(1,600,8)` reaches it at 601 visible
    // against a cap of 600. Under the DEFAULT budget the conjunct is implied (the clause
    // needs >5,000 edges at ≤3 per node, so ≥1,667 visible), which is why it looked
    // free-standing; it bites on a raised `?budget=`, where the view fits by construction.
    if (visible > UNRENDERABLE) return false;
    // …but NOT for a hairball. Past `FASTEST_EDGES` at more than DENSE_RATIO edges per
    // node the viewer draws no SVG paths at all until an edge is traced, so the view is
    // cheap however many edges it has: measured, a 616-node tree with 6,120 display edges
    // loads in 2.6 s and pans in 328 ms. Standing the guard down there folded it to SIX,
    // while the same shape with 4,194 edges — identical paint cost, also a hairball — kept
    // all 701. The threshold also yields to an explicit `?budget=<n>,<edges>`: raising the
    // edge budget by three orders of magnitude used to change nothing.
    if (
      visible > opts.maxVisible &&
      keyCount.size > Math.max(UNRENDERABLE_EDGES, opts.maxEdges) &&
      !isHairball(visible, keyCount.size)
    )
      return false;
    const floor = MIN_OVERVIEW;
    const limit = Math.min(visible - floor, maxHidden); // hiding MORE than this is refused
    if (limit < 0) return true;
    if (sizeOf(id) <= limit) return false; // the whole subtree is too small to do it
    // A fold that still LEAVES half a budget is never gutting, whatever fraction it hides.
    // The guard is a statement about what REMAINS, and reading it as a ratio on what goes
    // made two extra files flip a root of 599 loose leaves beside a 601-file directory
    // from 600 visible to 1,201 — twice the budget and 50% over the render guard — when
    // the one available fold would have landed exactly on `maxVisible` keeping 599 nodes.
    // (`lumpy`/`nested` cannot tell the two readings apart: their small siblings are 1-10
    // nodes, so "hides most of the view" and "leaves nothing" always coincide there.)
    const keepsEnough = opts.maxVisible * MOST_OF_A_VIEW; // half a budget is still a view
    const cap = Math.max(limit, visible - keepsEnough);
    let n = 0;
    const stack = [...(m.childrenOf.get(id) ?? [])];
    while (stack.length && n <= cap) {
      const c = stack.pop()!;
      if (hidden.has(c)) continue;
      n++;
      if (cur.has(c)) continue;
      // A LOOP, not `stack.push(...kids)`: spreading a container's children into a call
      // overflows the argument stack past ~125k (lower inside a deep stack, which `setIR`
      // is), and the throw escapes `setIR` — the status bar then reads "render failed" and
      // `state.last` has already advanced, so the same bytes are never retried and the
      // graph is unrenderable until the file changes. Reachable through the `uniformLevels`
      // pre-pass, which folds a NEWCOMER container while its own child is still expanded,
      // so the deepest-first ordering that shields the other call sites does not apply.
      // Same hazard as App.tsx's `Math.max(...irIds)` and incremental.ts's `childIndex`.
      const kids = m.childrenOf.get(c);
      if (kids) for (const k of kids) stack.push(k);
    }
    if (visible - n >= keepsEnough) return false; // what is LEFT is still a view
    return n > limit;
  };

  // candidates grouped by depth, deepest level first
  const levels: string[][] = [];
  for (const id of candidates) {
    const d = depthOf(id);
    const last = levels[levels.length - 1];
    if (last && depthOf(last[0]) === d) last.push(id);
    else levels.push([id]);
  }
  /** Fold this level (largest subtree first) while `over()` holds; true when the WHOLE level went. */
  /** Containers a phase declined to gut. The decision is final for this whole pass. */
  const refused = new Set<string>();
  const foldLevel = (level: string[], over: () => boolean, stuckAt?: (open: string[]) => boolean): boolean => {
    // The ceiling is taken HERE, once per level, against what is on screen as this level
    // begins. Per-level and not per-phase: a phase-wide constant only ever bounds the
    // FIRST level it is applied to, so a three-deep tree lost the guard entirely at the
    // shallow end — a real `fs2ir` run over 690 generated subdirectories beside src/ and
    // docs/ folded 2,084 display nodes to FOURTEEN, because by the time `dir:generated`
    // was judged the view was 704 nodes and the ceiling was still 1,042. Per-SIBLING would
    // be wrong in the other direction: the denominator would shrink as the level folds, so
    // the first container in a level is judged against a big number and the last against a
    // small one, which is what left the 104k flagship as 39 chips and one explosion.
    const maxHidden = visible * MOST_OF_A_VIEW;
    const open = level.filter((id) => !hidden.has(id) && !cur.has(id));
    let folded = 0;
    for (const id of open) {
      if (!over()) break;
      // A container the NODE phase protected stays protected in the EDGE phase — but this
      // disjunct is a MEMO, not the mechanism. Removing it changes no outcome the suite can
      // produce, because `refuseFold` is deterministic in `visible`, `keyCount`, `hidden`
      // and `maxHidden`, and every one of those only moves toward refusing between the two
      // visits: `collapse()` only ever decrements, and `maxHidden` is re-derived from the
      // smaller `visible`. So a second call would return true again; it just costs a subtree
      // walk to say so. The comment here used to credit it with keeping the "600 tables
      // became one chip" cliff closed, which is `refuseFold`'s own doing — and a clause that
      // LOOKS like the mechanism is how the next person mis-attributes the behaviour
      // (round 13 deleted two others for exactly that). `refused` itself IS load-bearing:
      // `stuckAt` reads it. (Left in `open`, so a level that ends here still counts as NOT
      // wholly folded.)
      if (refused.has(id) || (!force && refuseFold(id, maxHidden))) {
        refused.add(id);
        // Smaller siblings may still be worth folding — but only if folding them still
        // gets somewhere. Once a level has refused one container it can no longer come
        // back uniform, so the rest is paid for in context with nothing bought unless the
        // cap is actually reachable. `stuckAt` is the edge phase's answer; the node phase
        // passes none, because its own cap always is reachable (it folds deepest-first
        // until the count fits) and a partly folded level there is the documented outcome.
        if (stuckAt?.(open)) break;
        continue;
      }
      collapse(id);
      folded++;
    }
    return folded === open.length;
  };
  const always = () => true;
  const done: number[] = [];
  // Levels an earlier pass collapsed stay uniform for newcomers — but still guarded. This
  // used to fold unconditionally, on the theory that the decision had already been taken
  // (and guarded) on an earlier poll; the graph on a LATER poll is not the one that was
  // judged, so a modest follow-up under the same root came back as a single chip (595
  // visible standalone, 1 as a follow-up) and MIN_OVERVIEW's invariant was untrue on every
  // poll but the first.
  for (const level of levels) {
    const d = depthOf(level[0]);
    if (!uniformLevels.has(d)) continue;
    // Only record a level this pass really finished, the same rule the two phases below
    // use. Now that this loop is guarded it CAN decline (a level that is one container
    // holding the whole visible view), and recording it anyway contradicts the header:
    // a partial level is deliberately absent from `levels`.
    if (foldLevel(level, always)) done.push(d);
  }
  // Node phase: levels until the visible count fits, the last one only as far as it must —
  // and proportionately (`foldLevel` takes its own ceiling per level). `MIN_OVERVIEW` alone ("leave at least
  // two") is no protection for a SKEWED graph, where one container holds nearly the whole
  // view: real `tools/fs2ir.mjs` output for a directory with 610 generated files beside
  // three source files folded 99.3% of itself away to get 16 nodes under a 600 cap, and
  // opened on SIX. Refusing the one oversized fold leaves 613 and a cap overrun the layout
  // tiers already handle. Every measured operating point in this file is a `db()`/
  // `bucketed()` database with uniform siblings, which is exactly why that quadrant went
  // unnoticed.
  let li = 0;
  for (; li < levels.length && visible > opts.maxVisible; li++) {
    if (!foldLevel(levels[li], () => visible > opts.maxVisible)) break;
    done.push(depthOf(levels[li][0]));
  }
  // Edge phase: aggregated display edges must fit too — but PROPORTIONATELY. The node
  // budget is already met by the time we get here, so every fold from now on buys edges
  // with context the view will not get back, and `layoutTier` has a cheaper tier for edge
  // overflow. Without a ceiling this folded the last expanded schema of a 1,500-table
  // 3-schema database — 500 tables of context — to take 837 aggregated edges under a cap
  // of 800. `foldLevel` takes its own ceiling per level — see MOST_OF_A_VIEW.
  //
  // A level that has REFUSED a container stops as soon as folding what is left cannot get
  // under the cap: at that point every further fold is context spent for nothing. A skewed
  // pair — one 290-file directory beside a 10-file one, 2,990 display edges — used to fold
  // the small one, hiding ten nodes, removing four edges and leaving the view 3.7x over the
  // cap and still a hairball (zero SVG paths either way). The check is deliberately NOT
  // made before the first fold: `bucketed(10000, 8)` and the 104k flagship both leave the
  // node phase on a half-folded level whose fold cannot reach the cap either (4,666 and 780
  // edges), and finishing that level is exactly right — 100 uniform bucket chips beat 96
  // chips plus four exploded buckets. Nothing refused, nothing stuck.
  const stuckAt = (open: string[]) =>
    edgesIfFolded(new Set(open.filter((id) => !cur.has(id) && !refused.has(id)))) > opts.maxEdges;
  for (; li < levels.length && keyCount.size > opts.maxEdges; li++) {
    if (!foldLevel(levels[li], () => keyCount.size > opts.maxEdges, stuckAt)) break;
    done.push(depthOf(levels[li][0]));
  }
  return { collapse: chosen, levels: [...new Set(done)], total: m.display.length, visible, edges: keyCount.size, hidden: before - visible };
}

/** `?budget=<nodes>[,<edges>]` -> options, else null (defaults apply). */
export function parseBudget(search: string): BudgetOptions | null {
  const raw = new URLSearchParams(search).get("budget");
  if (!raw) return null;
  const [n, e] = raw.split(",").map((s) => Number(s));
  if (!Number.isFinite(n) || n < 1) return null;
  const maxEdges = Number.isFinite(e) && e >= 1 ? Math.floor(e) : Math.max(DEFAULT_BUDGET.maxEdges, Math.floor(n));
  return { maxVisible: Math.floor(n), maxEdges };
}
