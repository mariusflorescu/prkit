import type { NormalizedGuide } from "@prkit/contracts";

export type GuideChapter = NormalizedGuide["chapters"][number];
export type GuideFlow = NonNullable<NormalizedGuide["flow"]>;
export type FlowMode = "before" | "after";
export type IndexedFlowNode = GuideFlow["nodes"][number] & { chapterIndex: number | null };
