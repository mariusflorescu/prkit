import type { DiffFile, NormalizedGuide } from "@prkit/contracts";
import { useMemo } from "react";

import { ChapterRoadmap } from "./ChapterRoadmap";
import { FlowCard } from "./FlowCard";
import { FocusAreasSection } from "./FocusAreasSection";
import { FocusList } from "./FocusList";
import { SummaryPanel } from "./SummaryPanel";
import { indexFlowNodes, layoutFlow } from "./flowLayout";

export function GuideOverview({
  guide,
  files,
  onChapter,
  prUrl,
  prDescription,
  pendingChapterIds,
}: {
  guide: NormalizedGuide;
  files: ReadonlyMap<string, DiffFile>;
  onChapter: (id: string) => void;
  prUrl?: string | undefined;
  prDescription?: string | undefined;
  pendingChapterIds: ReadonlySet<string>;
}) {
  const layout = useMemo(() => {
    if (!guide.flow || guide.flow.nodes.length === 0) return "single";
    const nodes = indexFlowNodes(guide.flow, guide.chapters);
    const width =
      guide.flow.direction === "auto"
        ? Math.min(
            layoutFlow(nodes, guide.flow.edges, "LR").width,
            layoutFlow(nodes, guide.flow.edges, "TB").width,
          )
        : layoutFlow(nodes, guide.flow.edges, guide.flow.direction).width;
    return width > 600 ? "stacked" : "side";
  }, [guide]);
  return (
    <div data-guide-overview="">
      <div data-overview-grid="" data-layout={layout}>
        <SummaryPanel guide={guide} prUrl={prUrl} />
        {guide.flow && guide.flow.nodes.length > 0 && (
          <FlowCard
            flow={guide.flow}
            chapters={guide.chapters}
            onChapter={onChapter}
            prUrl={prUrl}
          />
        )}
      </div>
      <FocusAreasSection guide={guide} onChapter={onChapter} prUrl={prUrl} />
      <ChapterRoadmap
        chapters={guide.chapters}
        files={files}
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
