// Edge KIND → family. Single source of truth for everything that keys off an
// edge's kind: stroke colour/dash (App.tsx, the Key panel) and whether the
// layout engine should reverse the edge so data flows DOWN (elk.ts).
//
// One validated hue per TASK family (2026-08-24 note: "differentiate line
// color by task"); the hue itself is a theme token (src/theme.ts, dark + light),
// referenced here as `var(--edge-<family>)` so SVG strokes, markers and the
// Key follow the active theme. Chip-backed labels carry the kind as text, so
// colour is reinforcement, never the only channel. Solid = behavioural flow ·
// dashed = structural/read relations.
//
// Read-family arrows are authored reader → source, but the adopted convention is that
// a read's SOURCE sits above its reader; `layoutReversed` tells elk.ts to feed
// ELK the opposite direction for layering only — the drawn arrow is unchanged.

import type { EdgeKind } from "./types";

export interface EdgeStyle {
  color: string;
  dash?: string;
}

export interface EdgeFamily {
  /** Short name used in docs/tests. */
  name: string;
  /** One kind that must match `re` — pins the regex in tests. */
  canonical: EdgeKind;
  re: RegExp;
  style: EdgeStyle;
  /** Lay out target→source so the data source lands above the reader. */
  layoutReversed?: boolean;
}

export const EDGE_FAMILIES: readonly EdgeFamily[] = [
  { name: "imports", canonical: "imports", re: /^imports?$/, style: { color: "var(--edge-imports)", dash: "2 6" } },
  { name: "references", canonical: "references", re: /^(references?|conforms_to|implements)$/, style: { color: "var(--edge-references)", dash: "6 5" } },
  { name: "inherits", canonical: "inherits", re: /^(inherits|extends)$/, style: { color: "var(--edge-inherits)", dash: "3 5" } },
  { name: "instantiates", canonical: "instantiates", re: /^(instantiates|constructs|creates|spawns|derives?|builds?)$/, style: { color: "var(--edge-instantiates)" } },
  { name: "writes", canonical: "writes", re: /^(writes?|mutates?|serializes?|saves?|persists?|appends?)$/, style: { color: "var(--edge-writes)" } },
  { name: "reads", canonical: "reads", re: /^(reads?|quer(y|ies)|fetch(es)?|loads?|polls?)$/, style: { color: "var(--edge-reads)", dash: "7 5" }, layoutReversed: true },
  { name: "triggers", canonical: "triggers", re: /^(triggers?|emits?(_\w+)?|notifies|publishes|fires)$/, style: { color: "var(--edge-triggers)" } },
  { name: "calls", canonical: "calls", re: /^(calls?|sends?|submits?|requests?|reports_to)$/, style: { color: "var(--edge-calls)" } },
  { name: "runs", canonical: "runs", re: /^(runs?|plays?|routes_to|presents?|renders?|streams?|outputs?)$/, style: { color: "var(--edge-runs)" } },
];

/** Neutral fallback for kinds outside every family (e.g. `feeds`). */
export const DEFAULT_EDGE_STYLE: EdgeStyle = { color: "var(--edge-neutral)" };

export function familyOf(kind: EdgeKind): EdgeFamily | undefined {
  return EDGE_FAMILIES.find((f) => f.re.test(kind));
}

export function edgeStyle(kind: EdgeKind): EdgeStyle {
  return familyOf(kind)?.style ?? DEFAULT_EDGE_STYLE;
}

/** True for kinds whose authored direction (reader → source) runs against data flow. */
export function isReadFamily(kind: EdgeKind): boolean {
  return familyOf(kind)?.layoutReversed === true;
}
