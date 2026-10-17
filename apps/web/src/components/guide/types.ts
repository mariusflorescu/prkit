import type { NormalizedGuide } from "@prkit/contracts";

import type { RevealLine } from "~/components/diff/types";

export type GuideChapter = NormalizedGuide["chapters"][number];
export type GuideFlow = NonNullable<NormalizedGuide["flow"]>;
export type FlowGraph = Extract<GuideFlow, { readonly _tag: "graph" }>;
export type FlowBehavior = Extract<GuideFlow, { readonly _tag: "behavior" }>;
export type IndexedFlowNode = FlowGraph["nodes"][number] & { chapterIndex: number | null };
export type LineJump = { readonly path: string; readonly reveal: RevealLine };
