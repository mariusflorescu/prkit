import type { ChapterReview, DiffFile, FileReviewState, NormalizedGuide } from "@prkit/contracts";

import type { RevealLine } from "~/components/diff/types";

export type GuideChapter = NormalizedGuide["chapters"][number];
export type GuideFlow = NonNullable<NormalizedGuide["flow"]>;
export type FlowGraph = Extract<GuideFlow, { readonly _tag: "graph" }>;
export type FlowBehavior = Extract<GuideFlow, { readonly _tag: "behavior" }>;
export type IndexedFlowNode = FlowGraph["nodes"][number] & { chapterIndex: number | null };
export type LineJump = { readonly path: string; readonly reveal: RevealLine };

/** Reviewed checkboxes for a guide's files and chapters. `set` resolves true once saved. */
export type ReviewedBinding = {
  stateOf: (file: DiffFile) => FileReviewState;
  set: (files: ReadonlyArray<DiffFile>, reviewed: boolean) => Promise<boolean>;
};

/** A chapter's Reviewed checkbox, derived from its files. */
export type ChapterReviewedControl = {
  review: ChapterReview;
  onChange: (reviewed: boolean) => Promise<boolean>;
};
