import type { PullRequestDetail, PullRequestMergeMethod } from "@prkit/contracts";

export const mergeMethods = [
  { method: "merge", label: "Merge commit" },
  { method: "squash", label: "Squash and merge" },
  { method: "rebase", label: "Rebase and merge" },
] as const;
export const resolveMergeMethod = (detail: PullRequestDetail): PullRequestMergeMethod => {
  const { preferences, preferredMergeMethod, mergeCapabilities } = detail.actions;
  if (preferences.mergeMethod !== null && mergeCapabilities[preferences.mergeMethod])
    return preferences.mergeMethod;
  if (mergeCapabilities[preferredMergeMethod]) return preferredMergeMethod;
  return mergeMethods.find(({ method }) => mergeCapabilities[method])?.method ?? "merge";
};
