import type { PullRequestDetail } from "@prkit/contracts";
import type { ReactNode } from "react";

export const reviewStates: Record<string, string> = {
  APPROVED: "Approved",
  CHANGES_REQUESTED: "Changes requested",
  COMMENTED: "Commented",
  DISMISSED: "Dismissed",
  REVIEW_REQUIRED: "Review required",
};
export const relativeTime = (at: string) => {
  const elapsed = Math.max(0, Date.now() - new Date(at).getTime());
  if (elapsed < 60_000) return "just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return `${Math.floor(elapsed / 86_400_000)}d ago`;
};
/** "a", "a and b", "a, b and c". Elements among `items` need their own keys. */
export const andList = (items: readonly ReactNode[]) =>
  items.flatMap((item, index) =>
    index === 0 ? [item] : [index === items.length - 1 ? " and " : ", ", item],
  );
export const checkSummary = (checks: PullRequestDetail["checks"]) => {
  if (checks.length === 0) return "No checks reported";
  const failing = checks.filter((check) => check.status === "failing").length;
  const pending = checks.filter((check) => check.status === "pending").length;
  const passing = checks.filter((check) => check.status === "passing").length;
  return failing
    ? `${failing} failing`
    : pending
      ? `${pending} pending`
      : passing === checks.length
        ? "All checks passed"
        : `${passing} of ${checks.length} passing`;
};
