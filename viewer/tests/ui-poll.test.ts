// The live loop (App.tsx `pollOnce`) — the product's core promise, and until
// 2026-09-10 the one thing with no test at all: every regression listed in
// docs/audit/2026-09-05-plugin-review.md ("a transient 404 swapped in the
// sample graph") lived in these branches.

import { describe, it, expect } from "vitest";
import { pollOnce, newPollState } from "../src/App";
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
