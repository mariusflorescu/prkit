import {
  type AccountId,
  type FileReviewState,
  type FileVersion,
  fileReviewState,
  fileVersion,
  indexMarks,
  type PullRequestKey,
  type ReviewableFile,
  type ReviewedDecision,
  reviewedDecision,
  type ReviewedMarks,
} from "@prkit/contracts";
import { notifyManager, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { toastManager } from "~/components/ui/toast";
import { setReviewedFiles } from "~/rpc/client";
import { reviewedFilesQuery } from "~/rpc/queries";

/** A checkbox can only exist once the marks are here: `ready` is the only state with `set`. */
export type ReviewedFiles =
  | { readonly status: "pending" }
  | { readonly status: "error"; readonly message: string; readonly retry: () => void }
  | {
      readonly status: "ready";
      readonly stateOf: (file: ReviewableFile) => FileReviewState;
      /**
       * Resolves true once the server saved it and the saved marks reached the screen;
       * on failure it says so, changes nothing and resolves false.
       */
      readonly set: (files: ReadonlyArray<ReviewableFile>, reviewed: boolean) => Promise<boolean>;
    };

// Hashing a patch is the costly part, and a file object never changes.
const versions = new WeakMap<ReviewableFile, FileVersion | null>();
export const versionOf = (file: ReviewableFile) => {
  if (versions.has(file)) return versions.get(file) ?? null;
  const version = fileVersion(file);
  versions.set(file, version);
  return version;
};

const newest = ({ marks }: ReviewedMarks) =>
  marks.reduce((latest, mark) => Math.max(latest, mark.order), 0);

export function useReviewedFiles(key: PullRequestKey, accountId: AccountId): ReviewedFiles {
  const client = useQueryClient();
  const query = useQuery(reviewedFilesQuery(key, accountId));
  const save = useMutation({
    mutationFn: (decision: ReviewedDecision) => setReviewedFiles(key, accountId, decision),
    // A reply that took long can be older than marks a later read already brought.
    onSuccess: (marks) =>
      client.setQueryData(reviewedFilesQuery(key, accountId).queryKey, (current) =>
        current !== undefined && newest(current) > newest(marks) ? current : marks,
      ),
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Couldn't save reviewed files",
        description: error.message,
      }),
  });
  const index = useMemo(
    () => (query.data === undefined ? null : indexMarks(query.data)),
    [query.data],
  );
  const stateOf = useCallback(
    (file: ReviewableFile) =>
      index === null ? "unknown" : fileReviewState(file, index, versionOf(file)),
    [index],
  );
  const { mutateAsync } = save;
  const set = useCallback(
    (files: ReadonlyArray<ReviewableFile>, reviewed: boolean) => {
      const decision = reviewedDecision(files, reviewed);
      if (decision === null) return Promise.resolve(false);
      // The query hands new data to components in a later notify batch. Waiting for it means
      // a chapter the caller opens next mounts its files with the saved marks, not the old ones.
      return mutateAsync(decision).then(
        () => new Promise<boolean>((resolve) => notifyManager.schedule(() => resolve(true))),
        () => false,
      );
    },
    [mutateAsync],
  );
  const { refetch } = query;
  const retry = useCallback(() => void refetch(), [refetch]);
  // A failed refetch keeps the marks already read: only a first read that fails is an error.
  const loaded = query.data !== undefined;
  const { error } = query;
  return useMemo(() => {
    if (loaded) return { status: "ready", stateOf, set };
    if (error !== null) return { status: "error", message: error.message, retry };
    return { status: "pending" };
  }, [loaded, error, retry, stateOf, set]);
}
