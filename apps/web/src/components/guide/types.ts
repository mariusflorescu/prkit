import type { ChapterReview, DiffFile, FileReviewState, NormalizedGuide } from "@prkit/contracts";
import type { ReactNode } from "react";

export type GuideChapter = NormalizedGuide["chapters"][number];
export type GuideFlow = NonNullable<NormalizedGuide["flow"]>;
export type FlowGraph = Extract<GuideFlow, { readonly _tag: "graph" }>;
export type FlowBehavior = Extract<GuideFlow, { readonly _tag: "behavior" }>;
export type IndexedFlowNode = FlowGraph["nodes"][number] & { chapterIndex: number | null };

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

/** What only the pull request's own author sees next to the guide's pre-flight. */
export type PreflightView = {
  /** A line about the description itself, such as that it changed since the guide. */
  readonly note: string | null;
  /** What the author can do from here, such as update the description. */
  readonly action: ReactNode;
};
