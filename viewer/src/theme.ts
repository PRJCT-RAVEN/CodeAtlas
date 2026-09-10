// Colour tokens — the ONLY place a colour is defined. styles.css, the node
// renderer, the edge families and the Key all consume CSS custom properties;
// the MiniMap (SVG fills) reads the same values from the Theme object.
//
// Both palettes were validated with the dataviz six-checks (adjacent pairs,
// CVD-simulated, normal-vision floor, contrast vs surface):
//   dark  accents on #141413 — worst adjacent ΔE 8.4 protan, normal 19.3
//   light accents on #f6f5f0 — worst adjacent ΔE 8.5 deutan, normal 16.4
// Colour is never the only channel: every node carries a kind badge and every
// edge a text chip.
//
// Precedence: `?theme=light|dark` (screenshots) > localStorage
// `codeatlas:theme` (the toggle) > prefers-color-scheme. The tokens are
// injected as a <style> BEFORE the optional user stylesheet (/theme.css, i.e.
// ~/.codeatlas/theme.css), so an override file only has to redefine the
// tokens it wants to change: `[data-theme="dark"] { --bg: #000; }`.

export type ThemeName = "dark" | "light";

const SLOTS = 6;

function dim(hex: string): string {
  return `${hex}8C`; // 55 % alpha — container outlines
}

function palette(accents: string[], pastels: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  accents.forEach((a, i) => {
    out[`--accent-${i}`] = a;
    out[`--accent-${i}-dim`] = dim(a);
  });
  pastels.forEach((p, i) => (out[`--pastel-${i}`] = p));
  return out;
}

const DARK_ACCENTS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#9085e9"];
const DARK_PASTELS = ["#a9c0f2", "#f0c3a5", "#a9d8bd", "#e9d5a1", "#eeb7cb", "#c8c0f5"];
const LIGHT_ACCENTS = ["#2f6fd1", "#c24a1c", "#178a5f", "#9c6200", "#c2436f", "#6f63d6"];
const LIGHT_PASTELS = ["#c9d9f8", "#f6cfb8", "#c2e4d1", "#f0dcae", "#f4c9d8", "#d8d1fa"];

const DARK: Record<string, string> = {
  "--bg": "#141413",
  "--panel": "#201f1e",
  "--panel-2": "#2b2a28",
  "--panel-3": "#35342f",
  "--border": "rgba(255, 255, 255, 0.1)",
  "--border-soft": "rgba(255, 255, 255, 0.07)",
  "--ink": "#eceadf",
  "--ink-strong": "#ffffff",
  "--ink-2": "#c3c2b7",
  "--ink-3": "#898781",
  "--ink-4": "#6f6e66",
  "--shadow": "rgba(0, 0, 0, 0.55)",
  "--node-shadow": "rgba(0, 0, 0, 0.35)",
  "--process-fill": "#f3ead6",
  "--process-ink": "#20201d",
  "--process-badge": "#8a7c58",
  "--process-border": "rgba(20, 20, 19, 0.35)",
  "--entity-ink": "#20201d",
  "--entity-badge": "rgba(32, 32, 29, 0.55)",
  "--entity-border": "rgba(20, 20, 19, 0.3)",
  "--store-fill": "rgba(255, 255, 255, 0.02)",
  "--store-ink": "#eceadf",
  "--container-fill": "rgba(255, 255, 255, 0.028)",
  "--container-fill-collapsed": "rgba(255, 255, 255, 0.05)",
  "--container-border": "rgba(255, 255, 255, 0.35)",
  "--overflow-border": "rgba(255, 255, 255, 0.28)",
  "--select": "#3987e5",
  "--select-glow": "rgba(57, 135, 229, 0.35)",
  "--link": "#6da7ec",
  "--chip-bg": "#232220",
  "--chip-ink": "#d8d6cb",
  "--chip-border": "rgba(255, 255, 255, 0.06)",
  "--error-ink": "#f0c3a5",
  "--error-border": "rgba(217, 89, 38, 0.6)",
  "--status-bg": "rgba(32, 31, 30, 0.9)",
  "--delta-added": "#199e70",
  "--delta-modified": "#c98500",
  "--edge-imports": "#6f6e66",
  "--edge-references": "#8a887f",
  "--edge-inherits": "#9085e9",
  "--edge-instantiates": "#c98500",
  "--edge-writes": "#d95926",
  "--edge-reads": "#199e70",
  "--edge-triggers": "#d55181",
  "--edge-calls": "#3987e5",
  "--edge-runs": "#9085e9",
  "--edge-neutral": "#a5a39a",
  "--minimap-bg": "#1c1b1a",
  "--minimap-mask": "rgba(20, 20, 19, 0.78)",
  "--minimap-container": "rgba(255, 255, 255, 0.07)",
  "--minimap-overflow": "rgba(255, 255, 255, 0.12)",
  ...palette(DARK_ACCENTS, DARK_PASTELS),
};

const LIGHT: Record<string, string> = {
  "--bg": "#f6f5f0",
  "--panel": "#ffffff",
  "--panel-2": "#f0efe9",
  "--panel-3": "#e6e5de",
  "--border": "rgba(0, 0, 0, 0.12)",
  "--border-soft": "rgba(0, 0, 0, 0.08)",
  "--ink": "#1f1f1c",
  "--ink-strong": "#000000",
  "--ink-2": "#45443f",
  "--ink-3": "#6f6d66",
  "--ink-4": "#8f8d85",
  "--shadow": "rgba(0, 0, 0, 0.14)",
  "--node-shadow": "rgba(0, 0, 0, 0.12)",
  "--process-fill": "#fff1d2",
  "--process-ink": "#20201d",
  "--process-badge": "#8a7c58",
  "--process-border": "rgba(20, 20, 19, 0.45)",
  "--entity-ink": "#20201d",
  "--entity-badge": "rgba(32, 32, 29, 0.6)",
  "--entity-border": "rgba(20, 20, 19, 0.28)",
  "--store-fill": "rgba(0, 0, 0, 0.025)",
  "--store-ink": "#1f1f1c",
  "--container-fill": "rgba(0, 0, 0, 0.03)",
  "--container-fill-collapsed": "rgba(0, 0, 0, 0.05)",
  "--container-border": "rgba(0, 0, 0, 0.3)",
  "--overflow-border": "rgba(0, 0, 0, 0.25)",
  "--select": "#2f6fd1",
  "--select-glow": "rgba(47, 111, 209, 0.3)",
  "--link": "#2f6fd1",
  "--chip-bg": "#ffffff",
  "--chip-ink": "#3b3a35",
  "--chip-border": "rgba(0, 0, 0, 0.14)",
  "--error-ink": "#a53a12",
  "--error-border": "rgba(194, 74, 28, 0.6)",
  "--status-bg": "rgba(255, 255, 255, 0.92)",
  "--delta-added": "#178a5f",
  "--delta-modified": "#9c6200",
  "--edge-imports": "#8a887f",
  "--edge-references": "#6f6d65",
  "--edge-inherits": "#6f63d6",
  "--edge-instantiates": "#9c6200",
  "--edge-writes": "#c24a1c",
  "--edge-reads": "#178a5f",
  "--edge-triggers": "#c2436f",
  "--edge-calls": "#2f6fd1",
  "--edge-runs": "#6f63d6",
  "--edge-neutral": "#7d7b73",
  "--minimap-bg": "#ecebe5",
  "--minimap-mask": "rgba(246, 245, 240, 0.75)",
  "--minimap-container": "rgba(0, 0, 0, 0.08)",
  "--minimap-overflow": "rgba(0, 0, 0, 0.14)",
  ...palette(LIGHT_ACCENTS, LIGHT_PASTELS),
};

export interface Theme {
  name: ThemeName;
  tokens: Readonly<Record<string, string>>;
  accents: readonly string[];
  pastels: readonly string[];
}

export const THEMES: Record<ThemeName, Theme> = {
  dark: { name: "dark", tokens: DARK, accents: DARK_ACCENTS, pastels: DARK_PASTELS },
  light: { name: "light", tokens: LIGHT, accents: LIGHT_ACCENTS, pastels: LIGHT_PASTELS },
};

export const SLOT_COUNT = SLOTS;
export const THEME_STORAGE_KEY = "codeatlas:theme";
export const THEME_STYLE_ID = "codeatlas-theme";
export const USER_THEME_LINK_ID = "codeatlas-user-theme";

/** The `:root` rule for a theme (also what docs/theme.example.css lists). */
export function cssFor(theme: Theme): string {
  const body = Object.entries(theme.tokens)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
  return `:root, [data-theme="${theme.name}"] {\n${body}\n}\n`;
}

export function isThemeName(v: unknown): v is ThemeName {
  return v === "dark" || v === "light";
}

/**
 * Which theme to start with: URL param > stored toggle > OS preference.
 * Pure — `search`, `stored` and `prefersDark` are passed in for tests.
 */
export function resolveTheme(search: string, stored: string | null, prefersDark: boolean): ThemeName {
  const q = new URLSearchParams(search).get("theme");
  if (isThemeName(q)) return q;
  if (isThemeName(stored)) return stored;
  return prefersDark ? "dark" : "light";
}

/** Inject the tokens BEFORE the user stylesheet so ~/.codeatlas/theme.css wins. */
export function applyTheme(name: ThemeName, doc: Document = document): void {
  const theme = THEMES[name];
  let style = doc.getElementById(THEME_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = doc.createElement("style");
    style.id = THEME_STYLE_ID;
    const userLink = doc.getElementById(USER_THEME_LINK_ID);
    if (userLink?.parentNode) userLink.parentNode.insertBefore(style, userLink);
    else doc.head.appendChild(style);
  }
  style.textContent = cssFor(theme);
  doc.documentElement.setAttribute("data-theme", name);
  doc.documentElement.style.colorScheme = name;
}

export function initialTheme(): ThemeName {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    /* private mode */
  }
  const prefersDark = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)").matches : true;
  return resolveTheme(window.location.search, stored, prefersDark);
}

export function rememberTheme(name: ThemeName): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, name);
  } catch {
    /* private mode */
  }
}
