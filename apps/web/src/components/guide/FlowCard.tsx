import type { DiffLineRef } from "@prkit/contracts";
import { lazy, Suspense } from "react";

import { InlineMarkdown } from "~/components/diff/InlineMarkdown";
import { RenderBoundary } from "~/components/diff/RenderBoundary";

import { BehaviorDiff } from "./BehaviorDiff";
import { FlowSkeleton } from "./FlowSkeleton";
import type { GuideChapter, GuideFlow } from "./types";

const Diagram = lazy(() =>
  import("./FlowDiagram").then((module) => ({ default: module.FlowDiagram })),
);

const legends = {
  graph: {
    statuses: [
      ["added", "+ added"],
      ["changed", "~ changed"],
      ["removed", "- removed"],
      ["unchanged", "unchanged"],
    ],
    hint: "Numbers open chapters",
  },
  behavior: {
    statuses: [
      ["added", "+ added"],
      ["removed", "- removed"],
      ["unchanged", "context"],
    ],
    hint: "A file:line opens the diff, numbers open chapters",
  },
} as const;

export function FlowCard({
  flow,
  chapters,
  onChapter,
  onLine,
  prUrl,
}: {
  flow: GuideFlow;
  chapters: ReadonlyArray<GuideChapter>;
  onChapter: (id: string) => void;
  onLine: (at: DiffLineRef) => void;
  prUrl?: string | undefined;
}) {
  const legend = legends[flow._tag];
  return (
    <section data-flow-card="" aria-label="Before and after">
      <h3>{flow.title}</h3>
      {flow.subtitle && (
        <p data-flow-subtitle="">
          <InlineMarkdown text={flow.subtitle} prUrl={prUrl} />
        </p>
      )}
      <RenderBoundary title="The before and after">
        {flow._tag === "graph" ? (
          <Suspense fallback={<FlowSkeleton />}>
            <Diagram flow={flow} chapters={chapters} onChapter={onChapter} />
          </Suspense>
        ) : (
          <BehaviorDiff
            flow={flow}
            chapters={chapters}
            onChapter={onChapter}
            onLine={onLine}
            prUrl={prUrl}
          />
        )}
      </RenderBoundary>
      <ul data-flow-legend="" data-form={flow._tag} aria-label="Legend">
        {legend.statuses.map(([status, label]) => (
          <li key={status}>
            <span data-flow-swatch="" data-status={status} aria-hidden="true" />
            {label}
          </li>
        ))}
        <li>{legend.hint}</li>
      </ul>
    </section>
  );
}
