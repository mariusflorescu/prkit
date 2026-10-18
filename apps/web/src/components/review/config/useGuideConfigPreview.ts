import {
  ignoreMatcher,
  type PullRequestDetail,
  type PullRequestGuideConfig,
  resolveGuideConfig,
  sensitiveMatcher,
} from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { pullRequestFilesQuery, pullRequestGuideConfigQuery } from "~/rpc/queries";

/** The three scopes as they stand above this PR's own: what the PR inherits. */
export const aboveThePullRequest = (config: PullRequestGuideConfig) => ({
  global: config.global,
  repository: config.repositoryConfig,
  pullRequest: null,
});

/**
 * The PR's guide settings and what they would do to its files now, with the same
 * matcher an attempt uses. The attempt decides again on the diff it fetches.
 */
export function useGuideConfigPreview(detail: PullRequestDetail) {
  const config = useQuery(pullRequestGuideConfigQuery(detail.key, detail.accountId));
  const files = useQuery(
    pullRequestFilesQuery(detail.key, detail.accountId, detail.headSha, detail.baseSha),
  );
  const resolved = useMemo(
    () =>
      config.data === undefined
        ? null
        : resolveGuideConfig({
            global: config.data.global,
            repository: config.data.repositoryConfig,
            pullRequest: config.data.pullRequest,
          }),
    [config.data],
  );
  const decisions = useMemo(() => {
    if (resolved === null || files.data === undefined) return null;
    const decide = ignoreMatcher(resolved.ignore);
    return files.data.files.map((file) => ({ file, decision: decide(file) }));
  }, [resolved, files.data]);
  const sensitive = useMemo(() => {
    if (resolved === null || decisions === null) return null;
    const match = sensitiveMatcher(resolved.sensitive);
    return decisions.flatMap(({ file, decision }) => {
      const rule = match(file);
      return rule === null ? [] : [{ path: file.path, rule, skippedByIgnore: decision.skipped }];
    });
  }, [resolved, decisions]);
  const skipped = decisions?.filter((entry) => entry.decision.skipped) ?? null;
  return {
    config,
    files,
    resolved,
    decisions,
    skipped,
    /** The changed files the look-closely paths match, and whether the ignore rules skip them anyway. */
    sensitive,
    /** Every changed file would be skipped, so there is nothing to write a guide about. */
    everythingSkipped:
      decisions !== null && decisions.length > 0 && skipped?.length === decisions.length,
  };
}

export type GuideConfigPreview = ReturnType<typeof useGuideConfigPreview>;
