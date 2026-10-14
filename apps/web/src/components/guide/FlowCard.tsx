import { lazy, Suspense, useMemo, useState } from "react";

import { InlineMarkdown } from "~/components/diff/InlineMarkdown";
import { RenderBoundary } from "~/components/diff/RenderBoundary";
import { Button } from "~/components/ui/button";

import { FlowSkeleton } from "./FlowSkeleton";
import { indexFlowNodes } from "./flowLayout";
import type { FlowMode, GuideChapter, GuideFlow } from "./types";

const Diagram = lazy(() =>
  import("./FlowDiagram").then((module) => ({ default: module.FlowDiagram })),
);

export function FlowCard({
  flow,
  chapters,
  onChapter,
  prUrl,
}: {
  flow: GuideFlow;
  chapters: ReadonlyArray<GuideChapter>;
  onChapter: (id: string) => void;
  prUrl?: string | undefined;
}) {
  const [mode, setMode] = useState<FlowMode>("before");
  const nodes = useMemo(() => indexFlowNodes(flow, chapters), [flow, chapters]);
  return (
    <section data-flow-card="" aria-label="Before and after">
      <div data-flow-card-heading="">
        <h3>{flow.title}</h3>
        <div className="flex gap-1" aria-label="Flow view">
          <Button
            size="compact"
            variant={mode === "before" ? "secondary" : "ghost"}
            aria-pressed={mode === "before"}
            onClick={() => setMode("before")}
          >
            Before
          </Button>
          <Button
            size="compact"
            variant={mode === "after" ? "secondary" : "ghost"}
            aria-pressed={mode === "after"}
            onClick={() => setMode("after")}
          >
            After
          </Button>
        </div>
      </div>
      {flow.subtitle && (
        <p data-flow-subtitle="">
          <InlineMarkdown text={flow.subtitle} prUrl={prUrl} />
        </p>
      )}
      <RenderBoundary title="The flow diagram">
        <Suspense fallback={<FlowSkeleton />}>
          <Diagram flow={flow} nodes={nodes} mode={mode} onChapter={onChapter} />
        </Suspense>
      </RenderBoundary>
      <div data-flow-legend="">
        <span data-status="added">+ new</span>
        <span data-status="changed">~ changed</span>
        <span data-status="removed">- removed</span>
        <span>unchanged</span>
        <span>Numbers open chapters</span>
      </div>
    </section>
  );
}
