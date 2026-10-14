import {
  type Account,
  type InboxEntry,
  type InboxResult,
  type PullRequestSummary,
  inboxReasonPriority,
  primaryInboxReason,
  pullRequestKey,
} from "@prkit/contracts";

import type { InboxResponse, PullRequestNode } from "./inboxQuery.ts";
import { membershipOf } from "./stackQuery.ts";

const SEARCHES = [
  ["reviewRequested", "review-requested"],
  ["authored", "authored"],
  ["involved", "involved"],
] as const;

const refOf = (account: Account, node: PullRequestNode) => ({
  host: account.host,
  owner: node.repository.owner.login,
  repo: node.repository.name,
  number: node.number,
});

/** A pull request as a list row shows it, read through `account`. */
export const summaryOf = (account: Account, node: PullRequestNode): PullRequestSummary => {
  const rollup = node.commits.nodes[0]?.commit.statusCheckRollup?.state;
  return {
    accountId: account.id,
    ref: refOf(account, node),
    title: node.title,
    url: node.url,
    state: node.state === "OPEN" ? "open" : node.state === "MERGED" ? "merged" : "closed",
    isDraft: node.isDraft,
    author: node.author,
    headBranch: node.headRefName,
    baseBranch: node.baseRefName,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    additions: node.additions,
    deletions: node.deletions,
    changedFiles: node.changedFiles,
    reviewDecision: node.reviewDecision,
    checks:
      rollup == null
        ? null
        : rollup === "SUCCESS"
          ? "passing"
          : rollup === "FAILURE" || rollup === "ERROR"
            ? "failing"
            : "pending",
    labels: node.labels.nodes.filter((label) => label !== null),
    stack: membershipOf(node),
  };
};

export const accountEntries = (account: Account, response: InboxResponse) => {
  const entries = new Map<string, InboxEntry>();
  const truncated: Array<InboxResult["truncated"][number]> = [];
  for (const [alias, reason] of SEARCHES) {
    const search = response[alias];
    const nodes = search.nodes.filter((node) => node !== null);
    if (search.issueCount > nodes.length)
      truncated.push({
        accountId: account.id,
        reason,
        shown: nodes.length,
        total: search.issueCount,
      });
    for (const node of nodes) {
      // GitHub's search index trails a merge or close by a few seconds, so `is:open`
      // can still find a PR whose node already says it is merged.
      if (node.state !== "OPEN") continue;
      const key = pullRequestKey(refOf(account, node));
      const previous = entries.get(key);
      if (previous) {
        if (!previous.reasons.includes(reason))
          entries.set(key, { ...previous, reasons: [...previous.reasons, reason] });
        continue;
      }
      entries.set(key, {
        ...summaryOf(account, node),
        reasons: [reason],
      });
    }
  }
  return { entries: [...entries.values()], truncated };
};

const strongestReason = (reasons: InboxEntry["reasons"]) =>
  inboxReasonPriority[primaryInboxReason(reasons)];
export const mergeAccounts = (entries: ReadonlyArray<InboxEntry>) => {
  const byKey = new Map<string, InboxEntry>();
  for (const entry of entries) {
    const key = pullRequestKey(entry.ref);
    const previous = byKey.get(key);
    if (
      !previous ||
      strongestReason(entry.reasons) < strongestReason(previous.reasons) ||
      (strongestReason(entry.reasons) === strongestReason(previous.reasons) &&
        entry.accountId.localeCompare(previous.accountId) < 0)
    )
      byKey.set(key, entry);
  }
  return [...byKey.values()].sort(
    (a, b) =>
      b.updatedAt.localeCompare(a.updatedAt) ||
      pullRequestKey(a.ref).localeCompare(pullRequestKey(b.ref)),
  );
};
