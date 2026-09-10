// Position persistence (App.tsx savePositions/loadPositions): the promise is
// that reopening a view starts from where it was. Before 2026-09-10 a single
// QuotaExceededError skipped the eviction that would have made room, so a full
// origin broke persistence permanently and silently.

import { describe, it, expect, beforeEach } from "vitest";
import { savePositions, loadPositions, MAX_SAVED_ROOTS } from "../src/App";

const POS = "codeatlas:pos:";
const ROOTS = "codeatlas:pos-roots";

/** localStorage with a byte budget, like a real origin near its quota. */
class FakeStorage {
  protected map = new Map<string, string>();
  constructor(private limit = Infinity) {}
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    if (this.bytes() - (k.length + (this.map.get(k)?.length ?? 0)) + k.length + v.length > this.limit) {
      const e = new Error("The quota has been exceeded.");
      e.name = "QuotaExceededError";
      throw e;
    }
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  /** Seed a fixture past the limit/refusal that setItem enforces. */
  setItemRaw(k: string, v: string) {
    this.map.set(k, v);
  }
  clear() {
    this.map.clear();
  }
  bytes() {
    let n = 0;
    for (const [k, v] of this.map) n += k.length + v.length;
    return n;
  }
  posKeys() {
    return [...this.map.keys()].filter((k) => k.startsWith(POS));
  }
  roots(): string[] {
    return JSON.parse(this.getItem(ROOTS) ?? "[]");
  }
}

function useStorage(limit?: number): FakeStorage {
  const s = new FakeStorage(limit);
  (globalThis as { localStorage?: unknown }).localStorage = s as unknown as Storage;
  return s;
}

const positions = (n: number) => new Map([...Array(n).keys()].map((i) => [`node:${i}`, { x: i, y: i * 2 }]));

describe("savePositions", () => {
  beforeEach(() => useStorage());

  it("round-trips a view's positions", () => {
    savePositions("view:a", positions(3));
    expect(loadPositions("view:a").get("node:2")).toEqual({ x: 2, y: 4 });
    expect(loadPositions("view:other").size).toBe(0);
  });

  it("keeps only the MAX_SAVED_ROOTS most recent views", () => {
    const s = useStorage();
    for (let i = 0; i < MAX_SAVED_ROOTS + 6; i++) savePositions(`view:${i}`, positions(2));
    expect(s.posKeys()).toHaveLength(MAX_SAVED_ROOTS);
    expect(s.roots()[0]).toBe(`view:${MAX_SAVED_ROOTS + 5}`);
    expect(s.roots()).toHaveLength(MAX_SAVED_ROOTS);
    expect(loadPositions("view:0").size).toBe(0); // evicted
    expect(loadPositions(`view:${MAX_SAVED_ROOTS + 5}`).size).toBe(2);
  });

  it("frees its own oldest views when the origin is full, instead of giving up", () => {
    // Room for roughly two views plus the roots list; a foreign page on the same
    // origin (localhost:5173) is holding the rest.
    const s = useStorage(3000);
    s.setItem("some-other-app", "x".repeat(1200));
    for (const v of ["view:a", "view:b", "view:c", "view:d"]) savePositions(v, positions(20));
    expect(loadPositions("view:d").get("node:19")).toEqual({ x: 19, y: 38 });
    // the list says exactly what is stored — no entry pointing at an evicted key
    expect(s.roots().map((r) => POS + r).sort()).toEqual(s.posKeys().sort());
    expect(s.roots()[0]).toBe("view:d");
    expect(s.getItem("some-other-app")).toHaveLength(1200); // never ours to evict
  });

  it("gives up cleanly when even one view does not fit", () => {
    const s = useStorage(400);
    savePositions("view:huge", positions(200));
    expect(s.posKeys()).toEqual([]);
    expect(s.roots()).toEqual([]);
  });

  it("recovers saved views from the key space when the roots list is corrupt", () => {
    const s = useStorage();
    for (let i = 0; i < 30; i++) s.setItem(`${POS}orphan:${i}`, "{}");
    s.setItem(ROOTS, "{ not json");
    savePositions("view:new", positions(2));
    // orphans are found and trimmed to the cap rather than kept forever
    expect(s.posKeys().length).toBe(MAX_SAVED_ROOTS);
    expect(s.roots()).toHaveLength(MAX_SAVED_ROOTS);
    expect(loadPositions("view:new").size).toBe(2);
  });

  it("survives storage being unavailable altogether", () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      get length(): number {
        throw new Error("SecurityError");
      },
      getItem() {
        throw new Error("SecurityError");
      },
      setItem() {
        throw new Error("SecurityError");
      },
      removeItem() {
        throw new Error("SecurityError");
      },
      key() {
        throw new Error("SecurityError");
      },
    };
    expect(() => savePositions("view:a", positions(2))).not.toThrow();
    expect(loadPositions("view:a").size).toBe(0);
  });
});

// A storage error that eviction cannot fix must not be answered by evicting. Chrome
// throws SecurityError when site data is blocked by policy; the retry loop used to treat
// every throw as "the origin is full" and deleted every other saved view before it gave
// up — losing data over a condition that had nothing to do with space.
describe("savePositions on a NON-quota storage failure", () => {
  class RefusingStorage extends FakeStorage {
    override setItem(k: string, v: string) {
      if (k.startsWith(POS)) {
        const e = new Error("The operation is insecure.");
        e.name = "SecurityError";
        throw e;
      }
      super.setItem(k, v);
    }
  }

  it("keeps every other view instead of evicting them one by one", () => {
    const ok = useStorage();
    for (const r of ["view:a", "view:b", "view:c"]) savePositions(r, positions(2));
    expect(ok.posKeys()).toHaveLength(3);

    // same contents, but position writes are now refused outright
    const refusing = new RefusingStorage();
    for (const k of ok.posKeys()) refusing.setItemRaw(k, ok.getItem(k)!);
    refusing.setItemRaw(ROOTS, ok.getItem(ROOTS)!);
    (globalThis as { localStorage?: unknown }).localStorage = refusing as unknown as Storage;

    savePositions("view:c", positions(9));
    expect(refusing.posKeys().sort(), "no view may be deleted over a SecurityError").toEqual(
      [`${POS}view:a`, `${POS}view:b`, `${POS}view:c`].sort()
    );
    // and the one we failed to update still holds its PREVIOUS positions
    expect(loadPositions("view:c").size).toBe(2);
    expect(refusing.roots()).toContain("view:c");
  });

  it("gives up on a full origin without deleting the positions already stored", () => {
    // room for exactly one view, which is already there
    savePositions("view:only", positions(2));
    const stored = (globalThis.localStorage as unknown as FakeStorage).bytes();
    const tight = useStorage(stored + 4);
    tight.setItemRaw(`${POS}view:only`, JSON.stringify({ "node:0": { x: 0, y: 0 }, "node:1": { x: 1, y: 2 } }));
    tight.setItemRaw(ROOTS, JSON.stringify(["view:only"]));

    savePositions("view:only", positions(400)); // far too big to fit
    expect(loadPositions("view:only").size, "a stale layout beats no layout").toBe(2);
    expect(tight.roots(), "the root stays listed, so its key stays evictable").toEqual(["view:only"]);
  });
});
