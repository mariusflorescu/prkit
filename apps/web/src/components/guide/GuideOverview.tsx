import type { DiffFile, DiffLineRef, NormalizedGuide } from "@prkit/contracts";
import { useMemo } from "react";

import { ChapterRoadmap } from "./ChapterRoadmap";
import { FlowCard } from "./FlowCard";
import { FocusAreasSection } from "./FocusAreasSection";
import { FocusList } from "./FocusList";
import { ManualCheckSection } from "./ManualCheckSection";
import { RiskOverview } from "./RiskOverview";
import { PreflightSection } from "./PreflightSection";
import { SummaryPanel } from "./SummaryPanel";
import { indexFlowNodes, layoutFlow } from "./flowLayout";
import type { ManualCheckBinding, PreflightView } from "./types";

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
  preflight,
  manualCheckTicks,
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
  /** Only for the pull request's own author. */
  preflight?: PreflightView | undefined;
  manualCheckTicks?: ManualCheckBinding | undefined;
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
      <ManualCheckSection
        guide={guide}
        files={files}
        ticks={manualCheckTicks}
        onChapter={onChapter}
        prUrl={prUrl}
      />
      {preflight !== undefined && guide.preflight !== null && (
        <PreflightSection
          preflight={guide.preflight}
          chapters={guide.chapters}
          files={files}
          onChapter={onChapter}
          onLine={onLine}
          prUrl={prUrl}
          note={preflight.note}
          action={preflight.action}
        />
      )}
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
