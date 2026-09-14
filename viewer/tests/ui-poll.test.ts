// The live loop (App.tsx `pollOnce`) — the product's core promise, and until
// 2026-09-10 the one thing with no test at all: every regression the 2026-09-05
// plugin review listed ("a transient 404 swapped in the sample graph") lived in
// these branches.

import { describe, it, expect } from "vitest";
import { RENDER_WARN } from "../src/ir/budget";
import { pollOnce, newPollState, writesAMessage, edgeUnchanged, nodeUnchanged, pollSources, BIG_VIEW } from "../src/App";
import type { GraphIR } from "../src/ir/types";

const LIVE = "live/graph.json";
const SAMPLE = "sample-graph.json";

const graph = (name: string): GraphIR =>
  ({
    irVersion: "0.2",
    generator: { tool: "test", version: "0", commit: null },
    root: "r",
    nodes: [{ id: "r", kind: "view", name }],
    edges: [],
  }) as GraphIR;

type Reply = { status?: number; body?: string; type?: string; etag?: string; throws?: boolean };

/** A stub server: one reply per URL, or a queue of replies consumed in order. */
function server(replies: Record<string, Reply | Reply[]>) {
  const seen: { url: string; ifNoneMatch?: string }[] = [];
  const fetchFn = async (url: string, init: RequestInit) => {
    const h = (init.headers ?? {}) as Record<string, string>;
    seen.push({ url, ifNoneMatch: h["If-None-Match"] });
    const entry = replies[url];
    const r: Reply = (Array.isArray(entry) ? entry.shift() : entry) ?? { status: 404 };
    if (r.throws) throw new TypeError("Failed to fetch");
    const status = r.status ?? 200;
    const headers: Record<string, string> = { "content-type": r.type ?? "application/json" };
    if (r.etag) headers.etag = r.etag;
    return new Response(status === 304 || status === 404 ? null : (r.body ?? ""), { status, headers });
  };
  return { fetchFn, seen };
}

describe("pollOnce", () => {
  it("installs the graph live/ serves and quotes its ETag on the next poll", async () => {
    const body = JSON.stringify(graph("first"));
    const { fetchFn, seen } = server({ [LIVE]: [{ body, etag: "W/v1" }, { status: 304 }] });
    const state = newPollState();

    const first = await pollOnce([LIVE, SAMPLE], state, fetchFn);
    expect(first.ir?.nodes[0].name).toBe("first");
    expect(first.source).toBe(LIVE);
    expect(first.error).toBeUndefined();
    expect(state.liveSeen).toBe(true);
    expect(seen[0].ifNoneMatch).toBeUndefined();

    const second = await pollOnce([LIVE, SAMPLE], state, fetchFn);
    // 304: nothing to install — and `error: null` rather than nothing at all, because a
    // source that answers 304 is demonstrably healthy and any error still showing is stale
    expect(second).toEqual({ error: null });
    expect(seen[1].ifNoneMatch).toBe("W/v1");
    expect(seen).toHaveLength(2); // and the sample was never asked for
  });

  it("falls through to the sample while live/ is absent", async () => {
    const { fetchFn, seen } = server({ [LIVE]: { status: 404 }, [SAMPLE]: { body: JSON.stringify(graph("sample")) } });
    const state = newPollState();
    const r = await pollOnce([LIVE, SAMPLE], state, fetchFn);
    expect(r.source).toBe(SAMPLE);
    expect(r.ir?.nodes[0].name).toBe("sample");
    expect(state.liveSeen).toBe(false); // only live/ counts
    expect(seen.map((s) => s.url)).toEqual([LIVE, SAMPLE]);
  });

  it("keeps the last good graph when live/ vanishes mid-rewrite, and never swaps in the sample", async () => {
    const { fetchFn, seen } = server({
      [LIVE]: [{ body: JSON.stringify(graph("live")) }, { status: 404 }],
      [SAMPLE]: { body: JSON.stringify(graph("sample")) },
    });
    const state = newPollState();
    await pollOnce([LIVE, SAMPLE], state, fetchFn);
    const r = await pollOnce([LIVE, SAMPLE], state, fetchFn);
    expect(r.ir).toBeUndefined();
    expect(r.error).toBe(`${LIVE}: missing (keeping last good graph)`);
    expect(seen.map((s) => s.url)).toEqual([LIVE, LIVE]);
  });

  it("skips a non-JSON reply (the dev server's HTML fallback for a missing file)", async () => {
    const { fetchFn } = server({
      [LIVE]: { body: "<!doctype html><title>vite</title>", type: "text/html" },
      [SAMPLE]: { body: JSON.stringify(graph("sample")) },
    });
    const state = newPollState();
    const r = await pollOnce([LIVE, SAMPLE], state, fetchFn);
    expect(r.source).toBe(SAMPLE);
    expect(r.error).toBeUndefined();
  });

  it("reports invalid JSON and installs nothing", async () => {
    const { fetchFn, seen } = server({ [LIVE]: { body: "{ nope" }, [SAMPLE]: { body: JSON.stringify(graph("sample")) } });
    const r = await pollOnce([LIVE, SAMPLE], newPollState(), fetchFn);
    expect(r.ir).toBeUndefined();
    expect(r.error).toMatch(/^live\/graph\.json: invalid JSON \(/);
    expect(seen).toHaveLength(1); // a broken live file does not fall back either
  });

  it("reports a graph the shape guard rejects", async () => {
    const bad = JSON.stringify({ ...graph("x"), root: "missing" });
    const { fetchFn } = server({ [LIVE]: { body: bad } });
    const state = newPollState();
    const r = await pollOnce([LIVE, SAMPLE], state, fetchFn);
    expect(r.ir).toBeUndefined();
    expect(r.error).toBe(`${LIVE}: root missing is not a node`);
    expect(state.last).toBe(""); // rejected bytes are not remembered as good
  });

  it("re-reads nothing when the bytes are unchanged, and clears a stale error", async () => {
    const body = JSON.stringify(graph("live"));
    const { fetchFn } = server({ [LIVE]: [{ body }, { body }] }); // no ETag: the byte compare is the fallback
    const state = newPollState();
    expect((await pollOnce([LIVE, SAMPLE], state, fetchFn)).ir).toBeDefined();
    expect(await pollOnce([LIVE, SAMPLE], state, fetchFn)).toEqual({ error: null });
  });

  it("reports an HTTP error on the source that gave it", async () => {
    const { fetchFn, seen } = server({ [LIVE]: { status: 500, body: "boom" }, [SAMPLE]: { body: JSON.stringify(graph("s")) } });
    const r = await pollOnce([LIVE, SAMPLE], newPollState(), fetchFn);
    expect(r.error).toBe(`${LIVE}: HTTP 500`);
    expect(r.ir).toBeUndefined();
    expect(seen).toHaveLength(1);
  });

  it("treats a network failure as a hiccup: next source, no error", async () => {
    const { fetchFn } = server({ [LIVE]: { throws: true }, [SAMPLE]: { body: JSON.stringify(graph("sample")) } });
    const r = await pollOnce([LIVE, SAMPLE], newPollState(), fetchFn);
    expect(r.source).toBe(SAMPLE);
    expect(r.error).toBeUndefined();
  });

  it("stops on an aborted signal instead of walking the remaining sources", async () => {
    const { fetchFn, seen } = server({ [LIVE]: { throws: true }, [SAMPLE]: { body: JSON.stringify(graph("s")) } });
    const ctrl = new AbortController();
    ctrl.abort();
    expect(await pollOnce([LIVE, SAMPLE], newPollState(), fetchFn, ctrl.signal)).toEqual({});
    expect(seen.map((s) => s.url)).toEqual([LIVE]);
  });

  it("a named candidate view (?graph=draft) never falls back to the sample", async () => {
    const { fetchFn, seen } = server({ "live/draft.json": { status: 404 }, [SAMPLE]: { body: JSON.stringify(graph("s")) } });
    const r = await pollOnce(["live/draft.json"], newPollState(), fetchFn);
    expect(r).toEqual({});
    expect(seen.map((s) => s.url)).toEqual(["live/draft.json"]);
  });
});

// A stuck error is a lie about the live loop: the graph on screen IS current, and the
// status bar says the file is missing. A 304 proves the source is there and unchanged.
describe("pollOnce after a hiccup", () => {
  it("clears a stale error when the source comes back with the same bytes (304)", async () => {
    const body = JSON.stringify(graph("live"));
    const { fetchFn } = server({
      [LIVE]: [{ body, etag: "W/v1" }, { status: 404 }, { status: 304, etag: "W/v1" }],
      [SAMPLE]: { body: JSON.stringify(graph("sample")), etag: "W/s1" },
    });
    const state = newPollState();
    expect((await pollOnce([LIVE, SAMPLE], state, fetchFn)).ir).toBeTruthy();
    expect((await pollOnce([LIVE, SAMPLE], state, fetchFn)).error).toMatch(/missing \(keeping last good graph\)/);
    // `undefined` here would leave the "missing" line up for the rest of the session:
    // the ETag still matches, so no 200 ever arrives to clear it.
    expect((await pollOnce([LIVE, SAMPLE], state, fetchFn)).error, "a 304 must clear the error").toBeNull();
  });
});

// A rejected graph must keep saying WHY, not for one second.
//
// The ETag belongs to the bytes, not to the verdict on them, so it is recorded before the
// body is parsed and every tick after the first answers 304. That branch used to return
// `{error: null}` unconditionally: measured in a real browser (2026-09-10), the reason for
// keeping the last good graph was on screen for exactly one poll and the status bar then
// looked healthy while a stale graph rendered.
describe("a standing rejection survives the 304s that follow it", () => {
  const broken = (body: string, etag: string) => ({
    [LIVE]: [
      { body: JSON.stringify(graph("good")), etag: "v1" },
      { body, etag },
      { status: 304 },
      { status: 304 },
      { body: JSON.stringify(graph("fixed")), etag: "v3" },
      { status: 304 },
    ],
    [SAMPLE]: { status: 404 },
  });

  it("re-reports invalid JSON on every 304 until the file is fixed", async () => {
    const { fetchFn } = server(broken("{ not json", "v2"));
    const state = newPollState();
    expect((await pollOnce([LIVE, SAMPLE], state, fetchFn)).ir).toBeDefined();
    const bad = await pollOnce([LIVE, SAMPLE], state, fetchFn);
    expect(bad.error).toMatch(/invalid JSON/);
    // …and again, from the cache, twice
    expect((await pollOnce([LIVE, SAMPLE], state, fetchFn)).error).toBe(bad.error);
    expect((await pollOnce([LIVE, SAMPLE], state, fetchFn)).error).toBe(bad.error);
    // fixed: the graph installs and the message is forgotten
    const ok = await pollOnce([LIVE, SAMPLE], state, fetchFn);
    expect(ok.ir).toBeDefined();
    expect(await pollOnce([LIVE, SAMPLE], state, fetchFn)).toEqual({ error: null });
  });

  it("does the same for a graph the shape guard rejects", async () => {
    const orphan = JSON.stringify({ ...graph("bad"), nodes: [{ id: "r", kind: "v", name: "r" }, { id: "x", kind: "v", name: "x", parent: "ghost" }] });
    const { fetchFn } = server(broken(orphan, "v2"));
    const state = newPollState();
    await pollOnce([LIVE, SAMPLE], state, fetchFn);
    const bad = await pollOnce([LIVE, SAMPLE], state, fetchFn);
    expect(bad.error).toMatch(/unknown parent ghost/);
    expect((await pollOnce([LIVE, SAMPLE], state, fetchFn)).error).toBe(bad.error);
  });

  it("re-reports a RENDER failure on every 304 too, not just a poll rejection", async () => {
    // Pattern (d): the `failures` map fixed "one second of warning, then a healthy-looking
    // status bar" for bytes the poller REJECTS. The other verdict has the same hole —
    // bytes that parse and pass the shape guard, then throw inside `setIR`. `state.last`
    // has already advanced by then (deliberately, so we do not spin on the same bytes), so
    // every following tick is a 304 and the message was cleared after one second while a
    // stale graph sat on screen and nothing would ever arrive to replace it.
    const { fetchFn } = server({
      [LIVE]: [{ body: JSON.stringify(graph("installs but throws")), etag: "v1" }, { status: 304 }, { status: 304 }],
      [SAMPLE]: { status: 404 },
    });
    const state = newPollState();
    expect((await pollOnce([LIVE, SAMPLE], state, fetchFn)).ir).toBeDefined();
    state.renderFailed = "render failed: Invalid array length"; // what the tick's catch records
    expect((await pollOnce([LIVE, SAMPLE], state, fetchFn)).error).toBe("render failed: Invalid array length");
    expect((await pollOnce([LIVE, SAMPLE], state, fetchFn)).error).toBe("render failed: Invalid array length");
  });

  it("…and the identical-bytes path does not clear it either, while still clearing a REJECTION", async () => {
    // Two different meanings of "the bytes you already have". A rejection is about bytes
    // that were never accepted, so restoring the last good ones clears it; a render failure
    // is about `state.last` ITSELF, so the same bytes coming back prove nothing.
    // ETAGS MATTER HERE. Written without them, the restore is the last reply the stub has
    // and no 304 ever follows it — so `state.failures.delete(url)` could be deleted with the
    // whole suite green, on the one line that stops a cleared rejection coming back. Vite
    // always sends an ETag, so a stub without one is an input the real caller never makes.
    const good = JSON.stringify(graph("good"));
    const { fetchFn } = server({
      [LIVE]: [
        { body: good, etag: "v1" },
        { body: "{ not json", etag: "v2" },
        { body: good, etag: "v3" },
        { status: 304 },
        { status: 304 },
      ],
      [SAMPLE]: { status: 404 },
    });
    const state = newPollState();
    await pollOnce([LIVE, SAMPLE], state, fetchFn);
    expect((await pollOnce([LIVE, SAMPLE], state, fetchFn)).error).toMatch(/invalid JSON/);
    expect((await pollOnce([LIVE, SAMPLE], state, fetchFn)).error).toBeNull(); // restored → cleared
    expect((await pollOnce([LIVE, SAMPLE], state, fetchFn)).error, "and STAYS clear on the 304").toBeNull();
    expect((await pollOnce([LIVE, SAMPLE], state, fetchFn)).error).toBeNull();
    const s2 = server({ [LIVE]: [{ body: good }, { body: good }], [SAMPLE]: { status: 404 } });
    const state2 = newPollState();
    await pollOnce([LIVE, SAMPLE], state2, s2.fetchFn);
    state2.renderFailed = "render failed: boom";
    expect((await pollOnce([LIVE, SAMPLE], state2, s2.fetchFn)).error).toBe("render failed: boom");
  });

  it("…and a FIXED graph clears it — the mirror bug, which is the worse one", async () => {
    // `renderFailed` is cleared where `state.last` advances. Without that the message
    // outlives the fix: the good graph installs and `setIR` clears `status.error`, then the
    // very next 1 s tick is a 304, `renderFailed` is still set, and the status bar goes back
    // to "render failed: …" permanently over a perfectly healthy graph. Same function, same
    // shape, opposite direction — and nothing covered it.
    const good = JSON.stringify(graph("good"));
    const fixed = JSON.stringify(graph("fixed"));
    const { fetchFn } = server({
      [LIVE]: [{ body: good, etag: "v1" }, { body: fixed, etag: "v2" }, { status: 304 }, { status: 304 }],
      [SAMPLE]: { status: 404 },
    });
    const state = newPollState();
    await pollOnce([LIVE, SAMPLE], state, fetchFn);
    state.renderFailed = "render failed: boom"; // the tick's catch, on the FIRST graph
    const next = await pollOnce([LIVE, SAMPLE], state, fetchFn); // the author fixes it
    expect(next.ir).toBeDefined();
    expect(state.renderFailed).toBeNull();
    expect(await pollOnce([LIVE, SAMPLE], state, fetchFn)).toEqual({ error: null });
    expect(await pollOnce([LIVE, SAMPLE], state, fetchFn)).toEqual({ error: null });
  });

  it("a 304 with nothing outstanding still clears a message", async () => {
    // the "missing (keeping last good graph)" case: a 404 then the file back, unchanged
    const { fetchFn } = server({
      [LIVE]: [{ body: JSON.stringify(graph("good")), etag: "v1" }, { status: 404 }, { status: 304 }],
      [SAMPLE]: { status: 404 },
    });
    const state = newPollState();
    await pollOnce([LIVE, SAMPLE], state, fetchFn);
    expect((await pollOnce([LIVE, SAMPLE], state, fetchFn)).error).toMatch(/missing/);
    expect(await pollOnce([LIVE, SAMPLE], state, fetchFn)).toEqual({ error: null });
  });
});

// The other half of the live loop: what the tick DOES with a verdict. Untested until now
// because it lived inline in the effect.
describe("only a message that changes is written", () => {
  it("distinguishes 'no opinion' from 'clear it'", () => {
    expect(writesAMessage(undefined, null)).toBe(false); // a quiet tick leaves the bar alone
    expect(writesAMessage(undefined, "boom")).toBe(false); // …even while an error stands
    expect(writesAMessage(null, null)).toBe(false); // already clear
    expect(writesAMessage(null, "boom")).toBe(true); // clear it
    expect(writesAMessage("boom", null)).toBe(true); // raise it
    expect(writesAMessage("boom", "boom")).toBe(false); // the 304-repeat case: once a second, forever
    expect(writesAMessage("other", "boom")).toBe(true);
  });
});

// React Flow skips an edge's DOM when the object is reused, so anything the reuse check
// misses is painted stale until the next full pass.
describe("reusing an edge object", () => {
  const pts = [{ x: 0, y: 0 }];
  const base = () => ({
    id: "e:calls:a->b", source: "a", target: "b", sourceHandle: "s-bot", type: "elk" as const,
    data: { points: pts, labelPos: undefined, label: "calls", color: "var(--x)", dash: undefined,
            width: 1.4, inferred: false, delta: undefined, faint: false, hairball: false },
  });
  const edge = (patch: Record<string, unknown> = {}, top: Record<string, unknown> = {}) =>
    ({ ...base(), ...top, data: { ...base().data, ...patch } }) as never;

  it("reuses only when nothing that is drawn has changed", () => {
    expect(edgeUnchanged(edge(), edge())).toBe(true);
    expect(edgeUnchanged(undefined, edge())).toBe(false);
    expect(edgeUnchanged(edge(), edge({}, { source: "z" }))).toBe(false);
    expect(edgeUnchanged(edge(), edge({}, { sourceHandle: "s-top" }))).toBe(false);
    expect(edgeUnchanged(edge(), edge({ points: [{ x: 0, y: 0 }] })).valueOf()).toBe(false); // identity, not deep
  });

  it("notices every data field, including the two a hand-written list missed", () => {
    // `hairball` flips on its own when a spliced view crosses FASTEST_EDGES while `dense`
    // (and so `faint`) stays true — the reused object would keep painting a cloud the tier
    // just turned off. `inferred` was never in the hand-written list at all.
    for (const patch of [
      { hairball: true }, { inferred: true }, { faint: true }, { label: "calls x2" },
      { color: "var(--y)" }, { dash: "4 4" }, { width: 2.2 }, { delta: "added" }, { labelPos: { x: 1, y: 1 } },
    ]) {
      expect(edgeUnchanged(edge(), edge(patch)), JSON.stringify(patch)).toBe(false);
    }
    // …and a key appearing or disappearing counts as a change, which is what makes this
    // robust to the next field someone adds to ElkEdgeData
    const stripped = edge();
    delete (stripped as unknown as { data: Record<string, unknown> }).data.hairball;
    expect(edgeUnchanged(stripped, edge())).toBe(false);
    expect(edgeUnchanged(edge(), stripped)).toBe(false);
  });
});

describe("?graph= never falls back to the shared view", () => {
  it("accepts a name, forgives the extension, and refuses anything else", () => {
    expect(pollSources("")).toEqual(["live/graph.json", "sample-graph.json"]);
    expect(pollSources("?graph=")).toEqual(["live/graph.json", "sample-graph.json"]);
    expect(pollSources("?graph=draft")).toEqual(["live/draft.json"]);
    expect(pollSources("?graph=my_draft-2")).toEqual(["live/my_draft-2.json"]);
    // the obvious mistake: the manual names the FILE, so the extension is dropped
    expect(pollSources("?graph=draft.json")).toEqual(["live/draft.json"]);
    expect(pollSources("?graph=draft.JSON")).toEqual(["live/draft.json"]);
    // …and a name that is still not a name resolves to nothing, rather than quietly
    // showing the user's live graph under the draft's URL
    for (const bad of ["../graph", "a/b", "a b", "a.b", "%2e%2e", "a?b"]) {
      const got = pollSources(`?graph=${encodeURIComponent(bad)}`);
      expect(got, bad).toEqual(["live/.invalid-graph-name.json"]);
    }
  });
});

describe("reusing a node object", () => {
  const base = () => ({
    id: "table:t0", type: "atlas" as const, position: { x: 1, y: 2 }, width: 10, height: 5,
    parentId: "schema:s0",
    data: { label: "t0", kind: "table", typeKind: undefined, isContainer: false, collapsed: false, delta: undefined, dim: false },
  });
  const node = (patch: Record<string, unknown> = {}, top: Record<string, unknown> = {}) =>
    ({ ...base(), ...top, data: { ...base().data, ...patch } }) as never;

  it("notices every data field, so the list cannot go stale", () => {
    expect(nodeUnchanged(node(), node())).toBe(true);
    expect(nodeUnchanged(undefined, node())).toBe(false);
    for (const patch of [
      { label: "t1" }, { kind: "view" }, { typeKind: "struct" }, { isContainer: true },
      { collapsed: true }, { delta: "added" },
      // `dim` is what SEARCH writes, and it was not in the hand-written list — it happened
      // not to matter only because the search effect updates the node objects itself.
      { dim: true },
    ])
      expect(nodeUnchanged(node(), node(patch)), JSON.stringify(patch)).toBe(false);
    for (const top of [{ position: { x: 9, y: 2 } }, { width: 11 }, { height: 6 }, { parentId: "schema:s1" }])
      expect(nodeUnchanged(node({}, top), node()), JSON.stringify(top)).toBe(false);
    const stripped = node();
    delete (stripped as unknown as { data: Record<string, unknown> }).data.delta;
    expect(nodeUnchanged(stripped, node())).toBe(false);
  });

  it("the render guard and the paint economy are the same threshold, once", () => {
    // Both were the literal 800 and CLAUDE.md documents them as one number.
    expect(BIG_VIEW).toBe(RENDER_WARN);
  });
});
