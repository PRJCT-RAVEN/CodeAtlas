// Graph IR — mirrors schema/ir.schema.json (the contract, spec §4).

// v0.2: kinds are open vocabularies. Well-known values get dedicated styling;
// anything else (conceptual views authored by Claude) renders with derived styling.
export type WellKnownNodeKind = "package" | "module" | "file" | "type" | "function" | "property";
export type NodeKind = WellKnownNodeKind | (string & {});

export type WellKnownEdgeKind =
  | "imports"
  | "contains"
  | "calls"
  | "references"
  | "conforms_to"
  | "inherits"
  | "instantiates"
  | "reads"
  | "writes";
export type EdgeKind = WellKnownEdgeKind | (string & {});

export interface Loc {
  file: string;
  line: number;
  /** Optional since v0.2 — nobody has a meaningful column for a conceptual node. */
  col?: number;
}

export interface IRNode {
  id: string;
  kind: NodeKind;
  name: string;
  parent?: string;
  loc?: Loc;
  attrs?: Record<string, unknown> & {
    access?: string | null;
    isAsync?: boolean | null;
    isStatic?: boolean | null;
    isThrowing?: boolean | null;
    /** Free string since v0.2 (a fixed enum in v0.1). Rendered as the badge. */
    typeKind?: string | null;
    /** Root node only: absolute base for repo-relative locs ("Open in editor"). */
    absRoot?: string;
    /** Leaf size multiplier (fs2ir --sizes emits it from metrics.bytes). */
    scale?: number;
  };
  metrics?: Record<string, number>;
}

export interface IREdge {
  id: string;
  kind: EdgeKind;
  from: string;
  to: string;
  locs?: Loc[];
  count?: number;
}

export interface IRCluster {
  id: string;
  name: string;
  members: string[];
  source: "agent" | "mechanical";
}

export interface IRAnnotation {
  summary?: string;
  importance?: number;
  label?: string;
  collapsedByDefault?: boolean;
  /** Honesty rule: an edge Claude inferred rather than saw. Rendered dashed with "?". */
  inferred?: boolean;
  /** The edge of a cycle the author wants drawn UPWARD (retry / feedback loop); ELK reverses it instead of a mainline edge. */
  feedback?: boolean;
  [key: string]: unknown;
}

export interface GraphIR {
  irVersion: "0.1" | "0.2";
  generator: { tool: string; version: string; commit?: string | null };
  root: string;
  /** Optional view title/description (v0.2) — shown in the title bar. */
  title?: string;
  description?: string;
  nodes: IRNode[];
  edges: IREdge[];
  clusters?: IRCluster[];
  annotations?: Record<string, IRAnnotation>;
}
