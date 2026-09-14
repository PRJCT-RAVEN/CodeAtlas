// Synthetic graph generators shared by the budget, store, routing and incremental suites.
//
// These used to live in budget.test.ts and be imported from it. Importing a test file
// RE-REGISTERS its describe blocks in the importing file, so the whole budget suite ran
// four times per `npm test` — quadrupling its cost and reporting every budget failure
// against four different files at once. A plain module has no such side effect.

import type { GraphIR } from "../src/ir/types";

export function db(schemas: number, tablesPer: number, cols: number): GraphIR {
  const nodes: GraphIR["nodes"] = [{ id: "db:m", kind: "database", name: "m" }];
  const edges: GraphIR["edges"] = [];
  const add = (kind: string, from: string, to: string) => edges.push({ id: `e:${kind}:${from}->${to}`, kind, from, to });
  const tables: string[] = [];
  const col = (tid: string, c: number) => `${tid.replace("table:", "column:")}.c${c}`;
  for (let s = 0; s < schemas; s++) {
    nodes.push({ id: `schema:s${s}`, kind: "schema", name: `s${s}`, parent: "db:m" });
    add("contains", "db:m", `schema:s${s}`);
    for (let t = 0; t < tablesPer; t++) {
      const tid = `table:s${s}.t${t}`;
      nodes.push({ id: tid, kind: "table", name: `t${t}`, parent: `schema:s${s}` });
      add("contains", `schema:s${s}`, tid);
      tables.push(tid);
      for (let c = 0; c < cols; c++) {
        nodes.push({ id: col(tid, c), kind: "column", name: `c${c}`, parent: tid });
        add("contains", tid, col(tid, c));
      }
    }
  }
  // two foreign keys per table to pseudo-random EARLIER tables (multiplicative
  // hash — `(i * k) % i` is always 0 and would make a star, not a schema)
  const pick = (i: number, salt: number) => (Math.imul(i + salt, 2654435761) >>> 0) % i;
  for (let i = 1; i < tables.length; i++) {
    if (cols > 1) add("references", col(tables[i], 1), col(tables[pick(i, 1)], 0));
    // `cols > 2`, not just `i > 1`: this used to emit a foreign key on `c2` whatever `cols`
    // was, so `db(x, y, 2)` produced edges whose endpoints are not nodes — invalid IR that
    // `autoCollapse` happens to skip (`!parentOf.has(e.from)`), which quietly made those
    // tests exercise fewer edges than they read as exercising.
    if (i > 1 && cols > 2) add("references", col(tables[i], 2), col(tables[pick(i, 2)], 0));
  }
  return { irVersion: "0.2", generator: { tool: "t", version: "0", commit: null }, root: "db:m", nodes, edges } as GraphIR;
}

/**
 * The shape `tools/schema2ir.mjs` emits for a schema holding more than 200 tables:
 * db > schema > `group` name-range buckets (~sqrt(k) of ~sqrt(k)) > table > column,
 * with two hashed foreign keys per table. `db()` above has no bucket level, so it never
 * exercised the path a real big import actually takes.
 */
export function bucketed(tables: number, cols: number): GraphIR {
  const nodes: GraphIR["nodes"] = [
    { id: "db:m", kind: "database", name: "m" },
    { id: "schema:s", kind: "schema", name: "s", parent: "db:m" },
  ];
  const edges: GraphIR["edges"] = [];
  const add = (kind: string, from: string, to: string) => edges.push({ id: `e:${kind}:${from}->${to}`, kind, from, to });
  add("contains", "db:m", "schema:s");
  const per = Math.ceil(Math.sqrt(tables));
  const ids: string[] = [];
  for (let t = 0; t < tables; t++) {
    const gid = `group:g${String(Math.floor(t / per)).padStart(4, "0")}`;
    if (t % per === 0) {
      nodes.push({ id: gid, kind: "group", name: gid, parent: "schema:s" });
      add("contains", "schema:s", gid);
    }
    const tid = `table:t${String(t).padStart(6, "0")}`;
    nodes.push({ id: tid, kind: "table", name: `t${t}`, parent: gid });
    add("contains", gid, tid);
    ids.push(tid);
    for (let c = 0; c < cols; c++) {
      const cid = `column:t${String(t).padStart(6, "0")}.c${c}`;
      nodes.push({ id: cid, kind: "column", name: `c${c}`, parent: tid });
      add("contains", tid, cid);
    }
  }
  const col = (tid: string, c: number) => `${tid.replace("table:", "column:")}.c${c}`;
  const pick = (i: number, salt: number) => (Math.imul(i + salt, 2654435761) >>> 0) % i;
  for (let i = 1; i < ids.length; i++) {
    // Guarded on `cols` exactly as `db()` is: emitting a key on a column that was never
    // created is invalid IR, and `autoCollapse` skips it silently.
    if (cols > 1) add("references", col(ids[i], 1), col(ids[pick(i, 1)], 0));
    if (i > 1 && cols > 2) add("references", col(ids[i], 2), col(ids[pick(i, 2)], 0));
  }
  return { irVersion: "0.2", generator: { tool: "t", version: "0", commit: null }, root: "db:m", nodes, edges } as GraphIR;
}

/**
 * One container holding most of the view, beside small siblings — the shape
 * `tools/fs2ir.mjs` produces for a directory with a big `generated/` next to a couple of
 * source folders, and the shape `db()`/`bucketed()` cannot express (their siblings are
 * always uniform). That blind spot is why a budget rewrite once folded a real 616-node
 * file tree down to SIX visible nodes with every operating point in the suite still green.
 */
export function lumpy(sizes: number[]): GraphIR {
  const nodes: GraphIR["nodes"] = [{ id: "dir:.", kind: "dir", name: "root" }];
  const edges: GraphIR["edges"] = [];
  sizes.forEach((n, i) => {
    const d = `dir:d${i}`;
    nodes.push({ id: d, kind: "dir", name: `d${i}`, parent: "dir:." });
    edges.push({ id: `e:contains:dir:.->${d}`, kind: "contains", from: "dir:.", to: d });
    for (let f = 0; f < n; f++) {
      const id = `doc:d${i}/f${String(f).padStart(5, "0")}`;
      nodes.push({ id, kind: "doc", name: `f${f}`, parent: d });
      edges.push({ id: `e:contains:${d}->${id}`, kind: "contains", from: d, to: id });
    }
  });
  const cmp = (a: { id: string }, b: { id: string }) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id));
  nodes.sort(cmp);
  edges.sort(cmp);
  return { irVersion: "0.2", generator: { tool: "t", version: "0", commit: null }, root: "dir:.", nodes, edges } as GraphIR;
}

/**
 * THREE levels of skew: `dir:.` > `generated/` > N module dirs > files, beside small
 * siblings. What `tools/fs2ir.mjs` emits for a monorepo with a codegen tree.
 *
 * `lumpy()` is depth-2 by construction, so its candidate set is always a SINGLE level and
 * a per-phase ceiling can never go stale in it. That is why a ceiling captured once per
 * phase — which fixed `lumpy` — still folded 2,084 real display nodes down to FOURTEEN:
 * by the time `dir:generated` was judged the view was 704 nodes and the ceiling was still
 * 1,042. Each new fixture here exists because the previous one could not express the bug.
 */
export function nested(subdirs: number, leaves: number, siblings: number[]): GraphIR {
  const nodes: GraphIR["nodes"] = [{ id: "dir:.", kind: "dir", name: "root" }];
  const edges: GraphIR["edges"] = [];
  const add = (f: string, t: string) => edges.push({ id: `e:contains:${f}->${t}`, kind: "contains", from: f, to: t });
  nodes.push({ id: "dir:generated", kind: "dir", name: "generated", parent: "dir:." });
  add("dir:.", "dir:generated");
  for (let i = 0; i < subdirs; i++) {
    const d = `dir:generated/m${String(i).padStart(4, "0")}`;
    nodes.push({ id: d, kind: "dir", name: `m${i}`, parent: "dir:generated" });
    add("dir:generated", d);
    for (let f = 0; f < leaves; f++) {
      const id = `doc:${d.slice(4)}/f${f}.ts`;
      nodes.push({ id, kind: "doc", name: `f${f}`, parent: d });
      add(d, id);
    }
  }
  siblings.forEach((n, i) => {
    const d = `dir:sib${i}`;
    nodes.push({ id: d, kind: "dir", name: `sib${i}`, parent: "dir:." });
    add("dir:.", d);
    for (let f = 0; f < n; f++) {
      const id = `doc:sib${i}/f${f}.ts`;
      nodes.push({ id, kind: "doc", name: `f${f}`, parent: d });
      add(d, id);
    }
  });
  const cmp = (a: { id: string }, b: { id: string }) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id));
  nodes.sort(cmp);
  edges.sort(cmp);
  return { irVersion: "0.2", generator: { tool: "t", version: "0", commit: null }, root: "dir:.", nodes, edges } as GraphIR;
}

/**
 * `lumpy()` with cross-references: arbitrary sibling sizes AND a tunable edge density on a
 * flat level under the root.
 *
 * Every other fixture here is edge-heavy only where its siblings are UNIFORM (`db`,
 * `bucketed`, two foreign keys per table) or skewed only where there are no edges at all
 * (`lumpy`, `nested`). Nothing could express "skewed siblings, 3.7x the edge cap", which
 * is the quadrant where the edge phase folded a ten-file directory to remove four display
 * edges and left the view a hairball either way. Each fixture here exists because the
 * previous one could not express the bug.
 */
export function withEdges(sizes: number[], refs: number | number[]): GraphIR {
  const nodes: GraphIR["nodes"] = [{ id: "dir:.", kind: "dir", name: "root" }];
  const edges: GraphIR["edges"] = [];
  const add = (kind: string, from: string, to: string) => edges.push({ id: `e:${kind}:${from}->${to}`, kind, from, to });
  const leaves: string[] = [];
  const owner: number[] = [];
  sizes.forEach((n, i) => {
    const d = `dir:d${i}`;
    nodes.push({ id: d, kind: "dir", name: `d${i}`, parent: "dir:." });
    add("contains", "dir:.", d);
    for (let f = 0; f < n; f++) {
      const id = `doc:d${i}/f${String(f).padStart(5, "0")}`;
      nodes.push({ id, kind: "doc", name: `f${f}`, parent: d });
      add("contains", d, id);
      leaves.push(id);
      owner.push(i);
    }
  });
  // Coprime strides so the references spread across every sibling instead of clustering
  // inside one — a same-directory reference folds away and would not reach the edge phase.
  // `refs` PER DIRECTORY (an array) puts the edges where the fold is: one big edge-free
  // package beside small dense ones is the monorepo shape in which the big container is
  // refused and folding the small ones still reaches the cap. A single number is uniform,
  // where refusing the big one puts the cap out of reach for good — the two sides of the
  // edge phase's stand-down, and no other fixture can hold both.
  const rate = (i: number) => (typeof refs === "number" ? refs : (refs[i] ?? 0));
  for (let i = 0; i < leaves.length; i++) {
    for (let r = 1; r <= rate(owner[i]); r++) {
      const t = leaves[(i * 7919 + r * 104729) % leaves.length];
      if (t !== leaves[i]) add("references", leaves[i], t);
    }
  }
  const cmp = (a: { id: string }, b: { id: string }) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id));
  nodes.sort(cmp);
  edges.sort(cmp);
  return { irVersion: "0.2", generator: { tool: "t", version: "0", commit: null }, root: "dir:.", nodes, edges } as GraphIR;
}
