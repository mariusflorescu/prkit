import { queryOptions, skipToken } from "@tanstack/react-query";

import {
  type AccountId,
  type AgentInstanceId,
  type AttemptId,
  type PullRequestKey,
  type FileSide,
  type GuideScope,
  type PullRequestStatus,
  type ReviewFeedEntry,
  type FixerFeedEntry,
  type FixerTurnId,
} from "@prkit/contracts";
import {
  getAgentCatalog,
  getAppearance,
  getGitHubBudget,
  getAttemptDiff,
  getDraft,
  getGuide,
  getGuideScope,
  getGuideSettings,
  getPullRequestGuideConfig,
  listGuideRepositories,
  getTypicalDuration,
  getPullRequestDetail,
  getPullRequestCandidates,
  getPullRequestFiles,
  getPullRequestStack,
  getPullRequestTimeline,
  getFileContents,
  getReview,
  getWorkspace,
  listAccounts,
  listInbox,
  listRepositories,
  listRepositoryPullRequests,
  listPendingComments,
  listReviewThreads,
  getFixer,
  getFixerDiff,
  getPushAccess,
  getScriptAccess,
  listFixerSettings,
} from "./client.ts";

export const accountsQuery = queryOptions({
  queryKey: ["accounts"],
  queryFn: listAccounts,
  staleTime: 30_000,
  retry: false,
});
/**
 * GitHub reads below stay until the server says they changed (`useGitHubEvents`):
 * the server decides how fresh an answer must be and when GitHub is read again.
 */
export const inboxQuery = queryOptions({
  queryKey: ["inbox"],
  queryFn: () => listInbox(),
  staleTime: Infinity,
  retry: false,
});
/** Every repository the accounts can see; the server keeps it a day and says when it changed. */
export const repositoriesQuery = queryOptions({
  queryKey: ["repositories"],
  queryFn: () => listRepositories(),
  staleTime: Infinity,
  retry: false,
});
/** One repository's open pull requests, read through `accountId` on demand. */
export const repositoryPullRequestsQuery = (input: {
  accountId: AccountId;
  host: string;
  owner: string;
  name: string;
}) =>
  queryOptions({
    queryKey: ["repositoryPullRequests", input.accountId, input.host, input.owner, input.name],
    queryFn: () => listRepositoryPullRequests(input),
    staleTime: Infinity,
    retry: false,
  });
/** Server memory only, never GitHub, so it can follow the headers as they move. */
export const githubBudgetQuery = queryOptions({
  queryKey: ["githubBudget"],
  queryFn: getGitHubBudget,
  refetchInterval: 15_000,
  retry: false,
});
/** Each open PR's state from the watcher's fingerprints, kept current by `useGitHubEvents`. */
export const pullRequestStatusQuery = queryOptions<ReadonlyMap<string, PullRequestStatus>>({
  queryKey: ["pullRequestStatus"],
  queryFn: () => new Map(),
  staleTime: Infinity,
});
/** Every query that holds a GitHub read of this PR, for invalidation. */
export const pullRequestQueryKeys = (key: PullRequestKey, accountId: AccountId) => [
  ["pullRequest", accountId, key],
  ["pullRequestTimeline", accountId, key],
  ["reviewThreads", accountId, key],
  ["pullRequestFiles", accountId, key],
  ["pullRequestStack", accountId, key],
];
export const workspaceQuery = queryOptions({
  queryKey: ["workspace"],
  queryFn: getWorkspace,
  staleTime: Infinity,
  retry: false,
});
export const pullRequestDetailQuery = (key: PullRequestKey, accountId: AccountId) =>
  queryOptions({
    queryKey: ["pullRequest", accountId, key],
    queryFn: () => getPullRequestDetail(key, accountId),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
/** The PR's stack, bottom to top, or null; refetched on the server's `stack` events. */
export const pullRequestStackQuery = (key: PullRequestKey, accountId: AccountId) =>
  queryOptions({
    queryKey: ["pullRequestStack", accountId, key],
    queryFn: () => getPullRequestStack(key, accountId),
    staleTime: Infinity,
    retry: false,
  });
export const pullRequestCandidatesQuery = (key: PullRequestKey, accountId: AccountId) =>
  queryOptions({
    queryKey: ["pullRequestCandidates", accountId, key],
    queryFn: () => getPullRequestCandidates(key, accountId),
    staleTime: 60_000,
    retry: false,
  });
/** Kept current by `reviews.watch`; see `useReviewWatch`. */
export const reviewQuery = (key: PullRequestKey) =>
  queryOptions({
    queryKey: ["review", key],
    queryFn: () => getReview(key),
    staleTime: Infinity,
    retry: false,
  });
/** A revision never changes once written. */
export const guideQuery = (key: PullRequestKey, revision: number) =>
  queryOptions({
    queryKey: ["guide", key, revision],
    queryFn: () => getGuide(key, revision),
    staleTime: Infinity,
    retry: false,
  });
/** Logins and models. The server keeps it until Check again, which refetches with `refresh`. */
export const agentCatalogQuery = queryOptions({
  queryKey: ["agentCatalog"],
  queryFn: () => getAgentCatalog(),
  staleTime: Infinity,
  retry: false,
});
export const guideSettingsQuery = queryOptions({
  queryKey: ["guideSettings"],
  queryFn: getGuideSettings,
  staleTime: Infinity,
  retry: false,
});
export const appearanceQuery = queryOptions({
  queryKey: ["appearance"],
  queryFn: getAppearance,
  staleTime: Infinity,
  retry: false,
});
/** An attempt's diff never changes once fetched. */
export const attemptDiffQuery = (key: PullRequestKey, attemptId: AttemptId) =>
  queryOptions({
    queryKey: ["attemptDiff", key, attemptId],
    queryFn: () => getAttemptDiff(key, attemptId),
    staleTime: Infinity,
    retry: false,
  });
/** One version of a draft; the version in the key comes from the review stream. */
export const draftQuery = (key: PullRequestKey, attemptId: AttemptId, version: number) =>
  queryOptions({
    queryKey: ["draft", key, attemptId, version],
    queryFn: () => getDraft(key, attemptId),
    staleTime: Infinity,
    retry: false,
  });
export const typicalDurationQuery = (instance: AgentInstanceId | null, lines: number) =>
  queryOptions({
    queryKey: ["typicalDuration", instance, lines],
    queryFn: instance === null ? skipToken : () => getTypicalDuration(instance, lines),
    staleTime: 5 * 60_000,
    retry: false,
  });
/** Every review by PR key, kept current by `reviews.feed`; see `useReviewFeed`. */
export const reviewFeedQuery = queryOptions<ReadonlyMap<PullRequestKey, ReviewFeedEntry>>({
  queryKey: ["reviewFeed"],
  queryFn: () => new Map(),
  staleTime: Infinity,
});

export const pullRequestFilesQuery = (
  key: PullRequestKey,
  accountId: AccountId,
  headSha: string,
  baseSha: string,
) =>
  queryOptions({
    queryKey: ["pullRequestFiles", accountId, key, headSha, baseSha],
    queryFn: () => getPullRequestFiles(key, accountId),
    // When the PR moves, the diffs shown stay, with any comment being written, until the
    // new head's files arrive.
    placeholderData: (previous, query) =>
      query?.queryKey[1] === accountId && query.queryKey[2] === key ? previous : undefined,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
export const pullRequestTimelineQuery = (key: PullRequestKey, accountId: AccountId) =>
  queryOptions({
    queryKey: ["pullRequestTimeline", accountId, key],
    queryFn: () => getPullRequestTimeline(key, accountId),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
export const pullRequestFileContentsQuery = (
  key: PullRequestKey,
  accountId: AccountId,
  path: string,
  side: FileSide,
  headSha: string,
  baseSha: string,
) =>
  queryOptions({
    queryKey: ["pullRequestContents", accountId, key, headSha, baseSha, path, side],
    queryFn: () => getFileContents(key, accountId, path, side),
    staleTime: Infinity,
    retry: false,
  });
/** Changed only through this window's own mutations, which write the answer back. */
export const pendingCommentsQuery = (key: PullRequestKey, accountId: AccountId) =>
  queryOptions({
    queryKey: ["pendingComments", accountId, key],
    queryFn: () => listPendingComments(key, accountId),
    staleTime: Infinity,
    retry: false,
  });
export const reviewThreadsQuery = (key: PullRequestKey, accountId: AccountId) =>
  queryOptions({
    queryKey: ["reviewThreads", accountId, key],
    queryFn: () => listReviewThreads(key, accountId),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });

/** Every guide settings query starts with this key, so a save refreshes them all. */
export const GUIDE_CONFIG_KEY = ["guideConfig"] as const;

const scopeKey = (scope: GuideScope) =>
  scope._tag === "global"
    ? "global"
    : scope._tag === "repository"
      ? `repository:${scope.repositoryId}`
      : `pull-request:${scope.key}`;

export const guideScopeQuery = (scope: GuideScope) =>
  queryOptions({
    queryKey: [...GUIDE_CONFIG_KEY, "scope", scopeKey(scope)],
    queryFn: () => getGuideScope(scope),
    staleTime: 30_000,
    retry: false,
  });

export const pullRequestGuideConfigQuery = (key: PullRequestKey, accountId: AccountId) =>
  queryOptions({
    queryKey: [...GUIDE_CONFIG_KEY, "pullRequest", accountId, key],
    queryFn: () => getPullRequestGuideConfig(key, accountId),
    staleTime: 30_000,
    retry: false,
  });

export const guideRepositoriesQuery = queryOptions({
  queryKey: [...GUIDE_CONFIG_KEY, "repositories"],
  queryFn: listGuideRepositories,
  staleTime: 30_000,
  retry: false,
});
/** Kept current by `fixers.watch`; see `useFixerWatch`. */
export const fixerQuery = (key: PullRequestKey) =>
  queryOptions({
    queryKey: ["fixer", key],
    queryFn: () => getFixer(key),
    staleTime: Infinity,
    retry: false,
  });
/** A turn's diff only changes when its commit does, which is in the key. */
export const fixerDiffQuery = (key: PullRequestKey, turnId: FixerTurnId, sha: string) =>
  queryOptions({
    queryKey: ["fixerDiff", key, turnId, sha],
    queryFn: () => getFixerDiff(key, turnId),
    staleTime: Infinity,
    retry: false,
  });
export const pushAccessQuery = (key: PullRequestKey, accountId: AccountId) =>
  queryOptions({
    queryKey: ["pushAccess", accountId, key],
    queryFn: () => getPushAccess(key, accountId),
    staleTime: 60_000,
    retry: false,
  });
/** Under `fixer`, so a repository setting saved anywhere refreshes it. */
export const scriptAccessQuery = (key: PullRequestKey, accountId: AccountId) =>
  queryOptions({
    queryKey: ["fixer", "scriptAccess", accountId, key],
    queryFn: () => getScriptAccess(key, accountId),
    staleTime: 60_000,
    retry: false,
  });
export const fixerSettingsQuery = queryOptions({
  queryKey: ["fixerSettings"],
  queryFn: listFixerSettings,
  staleTime: Infinity,
  retry: false,
});
/**
 * Every PR's fix session by key, kept current by `fixers.feed`; see `FixerNotifications`.
 * Pending until the feed's index arrives, so "no fixes" is never a guess.
 */
export const fixerFeedQuery = queryOptions<ReadonlyMap<PullRequestKey, FixerFeedEntry>>({
  queryKey: ["fixerFeed"],
  queryFn: skipToken,
  staleTime: Infinity,
});
