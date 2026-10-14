import {
  type PullRequestRef,
  pullRequestKey,
  type ReviewFeedEntry,
  type StackLayer,
} from "@prkit/contracts";

/** What a layer's guide is, as the strip and the composer show it. */
export type LayerGuide = "none" | "writing" | "ready";

export const LAYER_GUIDE_LABELS: Record<LayerGuide, string> = {
  none: "No guide",
  writing: "Writing guide",
  ready: "Guide ready",
};

export const layerGuide = (review: ReviewFeedEntry | undefined): LayerGuide => {
  if (review === undefined) return "none";
  if (review.status === "preparing" || review.status === "writing") return "writing";
  return review.latestRevision === null ? "none" : "ready";
};

/** A layer's PR in the same repository as the PR that read the stack. */
export const layerKey = (ref: PullRequestRef, layer: Pick<StackLayer, "number">) =>
  pullRequestKey({ ...ref, number: layer.number });
