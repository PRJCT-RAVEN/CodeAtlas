// Colour tokens: both themes define the same complete set; nothing else in
// the viewer may name a colour.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { THEMES, cssFor, resolveTheme } from "../src/theme";
import { EDGE_FAMILIES, DEFAULT_EDGE_STYLE } from "../src/ir/families";

const here = dirname(fileURLToPath(import.meta.url));

describe("theme tokens", () => {
  it("dark and light define exactly the same token names, all with values", () => {
    const d = Object.keys(THEMES.dark.tokens).sort();
    const l = Object.keys(THEMES.light.tokens).sort();
    expect(l).toEqual(d);
    for (const t of [THEMES.dark, THEMES.light]) for (const [k, v] of Object.entries(t.tokens)) expect(v, `${t.name} ${k}`).toMatch(/\S/);
    expect(d.length).toBeGreaterThan(50);
  });
  it("every var(--x) used by the stylesheet, App and families is a defined token", () => {
    const stripComments = (t: string) => t.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const src = ["src/styles.css", "src/App.tsx", "src/ir/families.ts", "src/edges/ElkEdge.tsx"]
      .map((f) => stripComments(readFileSync(join(here, "..", f), "utf8")))
      .join("\n");
    const used = new Set([...src.matchAll(/var\(--([a-z0-9-]+)/g)].map((m) => `--${m[1]}`));
    const perNode = new Set(["--accent", "--accent-dim", "--pastel"]); // set per node by App.tsx
    for (const u of used) {
      if (perNode.has(u)) continue;
      if (u.endsWith("-")) {
        // template: `var(--accent-${slot})` → every slot must exist
        for (let i = 0; i < 6; i++) expect(THEMES.dark.tokens[`${u}${i}`], `${u}${i}`).toBeDefined();
        continue;
      }
      expect(THEMES.dark.tokens[u], u).toBeDefined();
    }
    // and no stray colour literals outside theme.ts
    const files = readdirSync(join(here, "../src"), { recursive: true }) as string[];
    for (const f of files) {
      if (!/\.(tsx?|css)$/.test(f) || f.endsWith("theme.ts")) continue;
      const text = readFileSync(join(here, "../src", f), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(text, `${f} names a colour`).not.toMatch(/#[0-9a-fA-F]{6}\b|rgba?\(/);
    }
  });
  it("edge families resolve to edge tokens", () => {
    for (const f of EDGE_FAMILIES) expect(THEMES.light.tokens[f.style.color.slice(4, -1)], f.name).toBeDefined();
    expect(THEMES.dark.tokens[DEFAULT_EDGE_STYLE.color.slice(4, -1)]).toBeDefined();
  });
  it("cssFor emits a :root rule scoped to the theme name", () => {
    const css = cssFor(THEMES.light);
    expect(css.startsWith(':root, [data-theme="light"] {')).toBe(true);
    expect(css).toContain("--bg: #f6f5f0;");
  });
  it("resolves URL param over stored toggle over OS preference", () => {
    expect(resolveTheme("?theme=light", "dark", true)).toBe("light");
    expect(resolveTheme("?theme=bogus", "light", true)).toBe("light");
    expect(resolveTheme("", null, true)).toBe("dark");
    expect(resolveTheme("", null, false)).toBe("light");
    expect(resolveTheme("", "dark", false)).toBe("dark");
  });
});
