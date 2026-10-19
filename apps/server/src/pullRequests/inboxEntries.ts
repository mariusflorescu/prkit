import {
  type Account,
  InboxEntry,
  type InboxLeftOut,
  type InboxResult,
  PullRequestSummary,
  inboxReasonPriority,
  primaryInboxReason,
  pullRequestKey,
} from "@prkit/contracts";
import * as Schema from "effect/Schema";

import type { GraphQLError } from "../github/GitHubApi.ts";
import { type InboxResponse, type PullRequestNode, readNodes } from "./inboxQuery.ts";
import { membershipOf } from "./stackQuery.ts";

export const CachedInboxEntry = Schema.Struct({
  ...PullRequestSummary.fields,
  reasons: InboxEntry.fields.reasons,
  nodeId: Schema.String,
});
export type CachedInboxEntry = typeof CachedInboxEntry.Type;

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
    labels: node.labels?.nodes ?? [],
    stack: membershipOf(node),
  };
};

/** The searches' own aliases, where an error names one pull request rather than the whole read. */
export const SEARCH_NODES = SEARCHES.map(([alias]) => [alias, "nodes"] as const);

/**
 * An account's inbox from its three searches. A pull request prkit can't read, or that GitHub
 * refused, is left out on its own; `problems` says where each one broke, for the log.
 */
export const accountEntries = (
  account: Account,
  response: InboxResponse,
  errors: ReadonlyArray<GraphQLError>,
) => {
  const entries = new Map<string, CachedInboxEntry>();
  const truncated: Array<InboxResult["truncated"][number]> = [];
  const leftOut = new Map<string, InboxLeftOut>();
  const problems: Array<{ readonly path: string; readonly problem: string }> = [];
  for (const [alias, reason] of SEARCHES) {
    const search = response[alias];
    const nodes = search.nodes ?? [];
    if (search.issueCount > nodes.length)
      truncated.push({
        accountId: account.id,
        reason,
        shown: nodes.length,
        total: search.issueCount,
      });
    const read = readNodes(account, [alias, "nodes"], nodes, errors);
    for (const item of read.leftOut)
      leftOut.set(
        item.pullRequest === null
          ? `message:${item.message ?? ""}`
          : pullRequestKey(item.pullRequest.ref),
        item,
      );
    problems.push(...read.problems);
    for (const node of read.rows) {
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
        nodeId: node.id,
      });
    }
  }
  return { entries: [...entries.values()], truncated, leftOut: [...leftOut.values()], problems };
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
