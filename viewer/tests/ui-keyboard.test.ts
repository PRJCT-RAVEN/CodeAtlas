// Keyboard activation (App.tsx). React Flow makes every node a tab stop, but
// its own Enter/Space handler only touches React Flow's internal selection —
// until 2026-09-10 a keyboard user could focus all 600 nodes of a budgeted view
// and open none of them.

import { describe, it, expect } from "vitest";
import { keyActivation, isTextEntry, type KeyTarget } from "../src/App";

/** The DOM shape React Flow renders: our div inside a focusable wrapper. */
function focusedNode(id: string | undefined): KeyTarget {
  return { closest: (sel) => (sel === ".react-flow__node" && id ? { dataset: { id } } : null) };
}

describe("keyActivation", () => {
  it("activates on Enter and Space", () => {
    expect(keyActivation("Enter", focusedNode("type:A"))).toBe("type:A");
    expect(keyActivation(" ", focusedNode("type:A"))).toBe("type:A");
  });

  it("ignores every other key, so typing and panning still work", () => {
    for (const k of ["Escape", "Tab", "a", "ArrowDown", "Shift"]) expect(keyActivation(k, focusedNode("type:A")), k).toBeNull();
  });

  it("resolves the node through the wrapper React Flow focuses, not our own div", () => {
    // the event target is the inner .atlas-node div (or a span in it): only
    // walking up to .react-flow__node yields the id
    const inner: KeyTarget = { closest: (sel) => (sel === ".react-flow__node" ? { dataset: { id: "table:s1.t2" } } : null) };
    expect(keyActivation("Enter", inner)).toBe("table:s1.t2");
  });

  it("does nothing for a key press outside any node (pane, filter box, buttons)", () => {
    expect(keyActivation("Enter", focusedNode(undefined))).toBeNull();
    expect(keyActivation("Enter", null)).toBeNull();
    expect(keyActivation("Enter", {} as KeyTarget)).toBeNull(); // a target with no closest()
  });
});

// A focus ring the browser never paints is the same as no focus ring: React Flow's own
// stylesheet sets `outline: none` on a focused node at specificity (0,2,1), so our rule
// has to beat that, not merely exist. This compares the two stylesheets directly — a
// jsdom render cannot, because vitest never loads either file as a real sheet.
describe("the keyboard focus ring survives React Flow's own reset", () => {
  const specificity = (sel: string): [number, number, number] => {
    const ids = (sel.match(/#[\w-]+/g) ?? []).length;
    const classes = (sel.match(/\.[\w-]+/g) ?? []).length + (sel.match(/:(?!:)[\w-]+(\([^)]*\))?/g) ?? []).length + (sel.match(/\[[^\]]+\]/g) ?? []).length;
    const elements = (sel.replace(/[.#:[][^\s>+~]*/g, " ").match(/\b[a-z][\w-]*\b/g) ?? []).length;
    return [ids, classes, elements];
  };
  const beats = (a: [number, number, number], b: [number, number, number]) =>
    a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];

  it("out-specifies every `outline: none` React Flow puts on a focused node", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { join, dirname } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    // comments FIRST: `[^{}]*` happily swallows a comment that mentions a selector, and
    // the rule's own doc-comment names React Flow's — which made this test measure the
    // prose and pass against the very selector it exists to reject
    const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
    const ours = strip(readFileSync(join(here, "..", "src", "styles.css"), "utf8"));
    const theirs = strip(readFileSync(join(here, "..", "node_modules", "@xyflow", "react", "dist", "style.css"), "utf8"));

    const ring = ours.match(/([^{}]*:focus-visible)\s*\{[^}]*outline:\s*2px dashed/);
    expect(ring, "styles.css must set a focus-visible outline on the node").toBeTruthy();
    const oursSels = ring![1].split(",").map((s) => s.trim()).filter(Boolean);
    const classesOf = (sel: string) => new Set(sel.match(/\.[\w-]+/g) ?? []);

    // every rule in React Flow's sheet that zeroes the outline on a focused NODE
    const resets = [...theirs.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter(([, , body]) => /outline:\s*none/.test(body))
      .flatMap(([, sels]) => sels.split(","))
      .map((s) => s.trim())
      // `.react-flow__node` as a WHOLE class token: `.react-flow__nodesselection-rect` is
      // the marquee box, not a node, and an `includes` match pulled it in
      .filter((s) => /\.react-flow__node(?![\w-])/.test(s) && s.includes(":focus"));
    expect(resets.length, "React Flow is expected to reset the node outline").toBeGreaterThan(0);
    for (const r of resets) {
      // A reset only loses to one of OUR selectors that matches the same element — i.e. one
      // naming every class the reset names — AND out-specifies it. Ties are not enough:
      // they fall through to import order, which is not something a stylesheet should
      // depend on. (`:focus` resets count too: a :focus-visible element is also :focus.)
      const rc = classesOf(r);
      const answer = oursSels.find((o) => [...rc].every((c) => classesOf(o).has(c)) && beats(specificity(o), specificity(r)));
      expect(answer, `no selector in "${ring![1].trim()}" out-specifies React Flow's "${r}"`).toBeTruthy();
    }
  });
});

// Escape closes the details panel — but the filter box is a text field, and Escape there
// means "clear what I typed". Binding it at window level took it from the field and
// dismissed the panel the user was reading.
describe("isTextEntry", () => {
  it("recognises the places a user types", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) expect(isTextEntry({ tagName }), tagName).toBe(true);
    expect(isTextEntry({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });

  it("leaves the canvas, nodes and buttons alone", () => {
    for (const tagName of ["DIV", "BUTTON", "BODY", "SPAN"]) expect(isTextEntry({ tagName }), tagName).toBe(false);
    expect(isTextEntry(null)).toBe(false);
    expect(isTextEntry(undefined)).toBe(false);
    expect(isTextEntry({})).toBe(false); // window itself, which has no tagName
  });
});
