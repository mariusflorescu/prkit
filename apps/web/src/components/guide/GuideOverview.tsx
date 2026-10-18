import type { DiffFile, DiffLineRef, NormalizedGuide } from "@prkit/contracts";
import { useMemo } from "react";

import { ChapterRoadmap } from "./ChapterRoadmap";
import { FlowCard } from "./FlowCard";
import { FocusAreasSection } from "./FocusAreasSection";
import { FocusList } from "./FocusList";
import { RiskOverview } from "./RiskOverview";
import { SummaryPanel } from "./SummaryPanel";
import { indexFlowNodes, layoutFlow } from "./flowLayout";

export function GuideOverview({
  guide,
  files,
  rated,
  onChapter,
  onLine,
  onFile,
  prUrl,
  prDescription,
  pendingChapterIds,
}: {
  guide: NormalizedGuide;
  files: ReadonlyMap<string, DiffFile>;
  rated: boolean;
  onChapter: (id: string) => void;
  onLine: (at: DiffLineRef) => void;
  onFile: (path: string) => void;
  prUrl?: string | undefined;
  prDescription?: string | undefined;
  pendingChapterIds: ReadonlySet<string>;
}) {
  const flow =
    guide.flow && (guide.flow._tag === "graph" ? guide.flow.nodes : guide.flow.rows).length > 0
      ? guide.flow
      : null;
  const layout = useMemo(() => {
    if (!flow) return "single";
    if (flow._tag === "behavior") return "side";
    const nodes = indexFlowNodes(flow, guide.chapters);
    const width =
      flow.direction === "auto"
        ? Math.min(
            layoutFlow(nodes, flow.edges, "LR").width,
            layoutFlow(nodes, flow.edges, "TB").width,
          )
        : layoutFlow(nodes, flow.edges, flow.direction).width;
    return width > 600 ? "stacked" : "side";
  }, [flow, guide.chapters]);
  return (
    <div data-guide-overview="">
      <RiskOverview
        guide={guide}
        rated={rated}
        onChapter={onChapter}
        onLine={onLine}
        onFile={onFile}
        prUrl={prUrl}
      />
      <div data-overview-grid="" data-layout={layout}>
        <SummaryPanel guide={guide} prUrl={prUrl} />
        {flow && (
          <FlowCard
            flow={flow}
            chapters={guide.chapters}
            onChapter={onChapter}
            onLine={onLine}
            prUrl={prUrl}
          />
        )}
      </div>
      <FocusAreasSection guide={guide} onChapter={onChapter} prUrl={prUrl} />
      <ChapterRoadmap
        chapters={guide.chapters}
        files={files}
        rated={rated}
        onChapter={onChapter}
        pendingChapterIds={pendingChapterIds}
      />
      <FocusList guide={guide} onChapter={onChapter} prUrl={prUrl} />
      {prDescription?.trim() && (
        <details data-pr-description="">
          <summary>Original PR description</summary>
          <pre>{prDescription}</pre>
        </details>
      )}
    </div>
  );
}
