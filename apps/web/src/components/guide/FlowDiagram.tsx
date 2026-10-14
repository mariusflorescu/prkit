import { useId, useMemo } from "react";

import { FlowNode } from "./FlowNode";
import { FlowSkeleton } from "./FlowSkeleton";
import { flowEdgePath, flowVisible, layoutFlow } from "./flowLayout";
import type { FlowMode, GuideFlow, IndexedFlowNode } from "./types";
import { useElementWidth } from "./useElementWidth";

const statuses = ["unchanged", "added", "removed", "changed"] as const;

export function FlowDiagram({
  flow,
  nodes,
  mode,
  onChapter,
}: {
  flow: GuideFlow;
  nodes: ReadonlyArray<IndexedFlowNode>;
  mode: FlowMode;
  onChapter: (id: string) => void;
}) {
  const { ref, width } = useElementWidth();
  const id = useId().replaceAll(":", "");
  const layouts = useMemo(
    () => ({
      LR: layoutFlow(nodes, flow.edges, "LR"),
      TB: flow.direction === "LR" ? null : layoutFlow(nodes, flow.edges, "TB"),
    }),
    [nodes, flow.edges, flow.direction],
  );
  const layout =
    flow.direction === "TB" || (flow.direction === "auto" && layouts.LR.width > width)
      ? (layouts.TB ?? layouts.LR)
      : layouts.LR;
  const scale = width && layout.width > width ? Math.max(0.6, width / layout.width) : 1;
  return (
    <div data-flow-canvas="" ref={ref} aria-label={`${flow.title}, ${mode}`}>
      {width === 0 ? (
        <FlowSkeleton />
      ) : (
        <div
          data-flow-stage-wrap=""
          style={{ width: layout.width * scale, height: layout.height * scale }}
        >
          <div
            data-flow-stage=""
            style={{
              width: layout.width,
              height: layout.height,
              transform: scale < 1 ? `scale(${scale})` : undefined,
            }}
          >
            <svg data-flow-edges="" width={layout.width} height={layout.height} aria-hidden="true">
              <defs>
                {statuses.map((status) => (
                  <marker
                    key={status}
                    id={`${id}-${status}`}
                    viewBox="0 0 8 8"
                    refX="7"
                    refY="4"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto-start-reverse"
                  >
                    <path d="M0,0 L8,4 L0,8 z" data-flow-arrow="" data-status={status} />
                  </marker>
                ))}
              </defs>
              {layout.edges.map((edge) => (
                <path
                  key={edge.key}
                  d={flowEdgePath(edge.points)}
                  data-flow-edge=""
                  data-status={edge.status}
                  data-hidden={!flowVisible(edge.status, mode) || undefined}
                  markerEnd={`url(#${id}-${edge.status})`}
                />
              ))}
            </svg>
            {layout.edges
              .filter((edge) => edge.label)
              .map((edge) => (
                <span
                  key={edge.key}
                  data-flow-edge-label=""
                  data-hidden={!flowVisible(edge.status, mode) || undefined}
                  style={{ left: edge.labelX, top: edge.labelY }}
                >
                  {edge.label}
                </span>
              ))}
            {layout.nodes.map((node) => (
              <FlowNode
                key={node.id}
                node={node}
                hidden={!flowVisible(node.status, mode)}
                onChapter={onChapter}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
