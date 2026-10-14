import dagre, { type EdgeLabel, type GraphLabel, type NodeLabel } from "@dagrejs/dagre";
import * as Schema from "effect/Schema";

import type { FlowMode, GuideFlow, IndexedFlowNode } from "./types";

const NodePosition = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});
const decodeNode = Schema.decodeUnknownSync(NodePosition);

export function flowVisible(status: GuideFlow["nodes"][number]["status"], mode: FlowMode) {
  return mode === "before" ? status !== "added" : status !== "removed";
}

export function layoutFlow(
  nodes: ReadonlyArray<IndexedFlowNode>,
  edges: GuideFlow["edges"],
  rankdir: "LR" | "TB",
) {
  const graph = new dagre.graphlib.Graph<GraphLabel, NodeLabel, EdgeLabel>({ multigraph: true });
  graph.setGraph({
    rankdir,
    nodesep: 22,
    ranksep: rankdir === "LR" ? 46 : 36,
    edgesep: 14,
    marginx: 6,
    marginy: 6,
  });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of nodes) {
    const marker = node.status === "unchanged" ? 0 : 18;
    const badge = node.chapterIndex ? 34 : 0;
    graph.setNode(node.id, {
      width: Math.round(Math.min(node.label.length, 32) * 7.9 + 32 + marker + badge),
      height: 40,
    });
  }
  const ids = new Set(nodes.map((node) => node.id));
  const validEdges = edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
  validEdges.forEach((edge, index) =>
    graph.setEdge(
      edge.from,
      edge.to,
      edge.label ? { width: edge.label.length * 6.4 + 10, height: 18, labelpos: "c" } : {},
      `e${index}`,
    ),
  );
  dagre.layout(graph);
  return {
    width: Math.ceil(graph.graph().width ?? 0),
    height: Math.ceil(graph.graph().height ?? 0),
    nodes: nodes.map((node) => {
      const position = decodeNode(graph.node(node.id));
      return {
        ...node,
        x: position.x - position.width / 2,
        y: position.y - position.height / 2,
        w: position.width,
        h: position.height,
      };
    }),
    edges: validEdges.map((edge, index) => {
      const position = graph.edge(edge.from, edge.to, `e${index}`);
      return {
        from: edge.from,
        to: edge.to,
        label: edge.label,
        status: edge.status,
        key: `e${index}`,
        points: position.points ?? [],
        labelX: position.x,
        labelY: position.y,
      };
    }),
  };
}

export type FlowLayout = ReturnType<typeof layoutFlow>;

export function flowEdgePath(points: ReadonlyArray<{ x: number; y: number }>) {
  const first = points[0];
  const second = points[1];
  if (!first || !second) return "";
  let path = `M${first.x},${first.y}`;
  if (points.length === 2) return `${path} L${second.x},${second.y}`;
  for (let index = 1; index < points.length - 1; index++) {
    const current = points[index];
    const next = points[index + 1];
    if (!current || !next) continue;
    const last = index === points.length - 2;
    path += ` Q${current.x},${current.y} ${last ? next.x : (current.x + next.x) / 2},${last ? next.y : (current.y + next.y) / 2}`;
  }
  return path;
}

export function indexFlowNodes(flow: GuideFlow, chapters: ReadonlyArray<{ id: string }>) {
  const indexes = new Map(chapters.map((chapter, index) => [chapter.id, index + 1]));
  return flow.nodes.map((node) => ({
    ...node,
    chapterIndex: node.chapter ? (indexes.get(node.chapter) ?? null) : null,
  }));
}
