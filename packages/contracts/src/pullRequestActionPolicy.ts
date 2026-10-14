import type { PullRequestDetail } from "./pullRequest.ts";
import type { PullRequestCommand } from "./pullRequestActions.ts";

export const pullRequestActionLabels = {
  merge: "Merge",
  ready: "Ready for review",
  draft: "Convert to draft",
  close: "Close pull request",
  reopen: "Reopen",
  "update-branch": "Update branch",
  "enable-auto-merge": "Enable auto-merge",
  "disable-auto-merge": "Disable auto-merge",
  revert: "Revert",
  "approve-workflows": "Approve workflows",
  edit: "Edit title and description",
  labels: "Set labels",
  reviewers: "Request reviewers",
} satisfies Record<PullRequestCommand["kind"], string>;

export const pullRequestActionReason = (
  detail: PullRequestDetail,
  kind: PullRequestCommand["kind"],
): string | null => {
  const { actions, state, isDraft } = detail;
  const permissions = actions.viewerPermissions;
  if (kind === "labels" || kind === "reviewers") {
    if (!(kind === "labels" ? permissions.labels : permissions.reviewers))
      return "This account cannot manage labels or reviewers in this repository.";
    if (kind === "reviewers" && (state !== "open" || isDraft))
      return "Review requests need an open pull request that is ready for review.";
    return null;
  }
  if (kind === "edit")
    return permissions.update ? null : "This account cannot edit this pull request.";
  if (kind === "revert")
    return state !== "merged"
      ? "Only a merged pull request can be reverted."
      : !permissions.merge
        ? "Write access is required to create a revert pull request."
        : null;
  if (kind === "reopen")
    return state !== "closed"
      ? "Only a closed pull request can be reopened."
      : !permissions.reopen
        ? "This account cannot reopen this pull request."
        : null;
  if (state !== "open") return "This pull request is no longer open.";
  if (kind === "ready" || kind === "draft" || kind === "close") {
    if (!(kind === "close" ? permissions.close : permissions.update))
      return "This account cannot change this pull request.";
    if (kind === "ready" && !isDraft) return "This pull request is already ready for review.";
    if (kind === "draft" && isDraft) return "This pull request is already a draft.";
    return null;
  }
  if (kind === "update-branch") {
    if (!permissions.updateBranch) return "This account cannot update the pull request branch.";
    if (actions.behindBy === null) return "GitHub has not determined whether the branch is behind.";
    if (actions.behindBy === 0) return "This branch is up to date.";
    return detail.mergeability === "conflicting"
      ? "Resolve conflicts on GitHub before updating this branch."
      : null;
  }
  if (!permissions.merge) return "Write access is required for this action.";
  if (kind === "approve-workflows")
    return actions.isFork ? null : "Workflow approval is only needed for pull requests from forks.";
  if (kind === "disable-auto-merge")
    return actions.autoMergeMethod === null
      ? "Auto-merge is not enabled."
      : !permissions.disableAutoMerge
        ? "This account cannot disable auto-merge."
        : null;
  if (isDraft) return "Mark this pull request ready for review first.";
  if (!Object.values(actions.mergeCapabilities).some(Boolean))
    return "This repository has no allowed merge methods.";
  if (kind === "enable-auto-merge") {
    // The header only offers it where allowed; the server's fresh read can still say no.
    if (!actions.autoMergeAllowed && !actions.mergeQueue)
      return "This repository does not allow auto-merge.";
    if (actions.autoMergeMethod !== null) return "Auto-merge is already enabled.";
    if (!permissions.enableAutoMerge)
      return "GitHub does not allow this account to enable auto-merge for this pull request.";
    return null;
  }
  if (detail.mergeability === "conflicting") return "Resolve the merge conflicts first.";
  if (actions.mergeQueue)
    return "This repository requires its merge queue. Enable auto-merge instead.";
  if (detail.mergeability === "unknown" || actions.mergeState === "UNKNOWN")
    return "GitHub is still checking mergeability. Refresh in a moment.";
  if (
    actions.mergeState === "BLOCKED" ||
    actions.mergeState === "BEHIND" ||
    detail.reviewDecision === "REVIEW_REQUIRED" ||
    detail.reviewDecision === "CHANGES_REQUESTED"
  )
    return "GitHub requires checks, approvals or an updated branch before merging.";
  return null;
};

/** A change to the PR's state, which the header offers; never its title or metadata. */
export type PullRequestStateAction = Exclude<
  PullRequestCommand["kind"],
  "edit" | "labels" | "reviewers"
>;

/** Whether the PR's state makes `kind` an action at all, whether or not it is blocked now. */
const applies = (detail: PullRequestDetail, kind: PullRequestStateAction) => {
  const { actions, state, isDraft } = detail;
  const open = state === "open";
  const ready = open && !isDraft;
  switch (kind) {
    case "merge":
      // A merge queue merges for you: enabling auto-merge is how a PR joins it.
      return ready && !actions.mergeQueue;
    case "update-branch":
      // Resolving the conflicts brings the base in, so Update branch waits for that.
      return open && (actions.behindBy ?? 0) > 0 && detail.mergeability !== "conflicting";
    case "enable-auto-merge":
      return (
        ready &&
        (actions.autoMergeAllowed || actions.mergeQueue) &&
        actions.autoMergeMethod === null
      );
    case "disable-auto-merge":
      return open && actions.autoMergeMethod !== null;
    case "approve-workflows":
      // Only a fork's workflow runs wait for approval.
      return open && actions.isFork;
    case "ready":
      return open && isDraft;
    case "draft":
      return ready;
    case "close":
      return open;
    case "reopen":
      return state === "closed";
    case "revert":
      return state === "merged";
  }
};

/** Whether GitHub lets this account take `kind` on this PR at all. */
const permitted = (detail: PullRequestDetail, kind: PullRequestStateAction) => {
  const can = detail.actions.viewerPermissions;
  switch (kind) {
    case "merge":
    case "revert":
    case "approve-workflows":
      return can.merge;
    case "update-branch":
      return can.updateBranch;
    case "enable-auto-merge":
      return can.enableAutoMerge;
    case "disable-auto-merge":
      return can.disableAutoMerge;
    case "ready":
    case "draft":
      return can.update;
    case "close":
      return can.close;
    case "reopen":
      return can.reopen;
  }
};

const offered = (detail: PullRequestDetail, kind: PullRequestStateAction) =>
  applies(detail, kind) && permitted(detail, kind);

/**
 * The one action the PR's state calls for, among those this account may take: the first
 * that applies, in this order. Conflicts come first, even on a draft, so resolving them
 * never needs the PR marked ready. `null` when the account may take none of them.
 */
export const primaryPullRequestAction = (
  detail: PullRequestDetail,
): PullRequestStateAction | "resolve-conflicts" | null => {
  const { actions } = detail;
  if (detail.state === "open" && detail.mergeability === "conflicting") return "resolve-conflicts";
  const waits =
    actions.mergeQueue ||
    actions.mergeState === "BLOCKED" ||
    detail.reviewDecision === "REVIEW_REQUIRED" ||
    detail.reviewDecision === "CHANGES_REQUESTED";
  const order: ReadonlyArray<PullRequestStateAction> = [
    "revert",
    "reopen",
    "ready",
    "update-branch",
    "disable-auto-merge",
    ...(waits ? (["enable-auto-merge"] as const) : []),
    "merge",
  ];
  return order.find((kind) => offered(detail, kind)) ?? null;
};

const MENU_GROUPS: ReadonlyArray<ReadonlyArray<PullRequestStateAction>> = [
  ["merge", "update-branch", "enable-auto-merge", "disable-auto-merge", "approve-workflows"],
  ["ready", "draft", "close", "reopen", "revert"],
];

/**
 * The header's ⋯ menu: every state change that applies to the PR now and that this
 * account may make, except the primary action, as a merge group and a lifecycle group.
 * An action that applies but is blocked right now (Merge waiting on checks) stays, and
 * `pullRequestActionReason` says why. Editing, reviewers and labels live on the page.
 */
export const pullRequestMenuActions = (
  detail: PullRequestDetail,
): ReadonlyArray<ReadonlyArray<PullRequestStateAction>> => {
  const primary = primaryPullRequestAction(detail);
  return MENU_GROUPS.map((group) =>
    group.filter((kind) => kind !== primary && offered(detail, kind)),
  ).filter((group) => group.length > 0);
};
