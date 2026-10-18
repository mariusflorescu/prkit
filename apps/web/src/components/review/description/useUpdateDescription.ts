import type { PullRequestDetail } from "@prkit/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { toastManager } from "~/components/ui/toast";
import { invalidatePullRequestReads } from "~/features/github/pullRequestReads";
import { executePullRequest } from "~/rpc/client";
import { inboxQuery } from "~/rpc/queries";

/** A new description, written only if GitHub still has `before`. */
type DescriptionChange = { readonly before: string; readonly after: string };

/**
 * Writes the description through the PR's own account, with the title left alone. The
 * success toast's Undo writes `before` back the same way, so it is one click to reverse.
 */
export const useUpdateDescription = (detail: PullRequestDetail) => {
  const client = useQueryClient();
  const update = useMutation({
    mutationKey: ["updateDescription", detail.accountId, detail.key],
    mutationFn: (change: DescriptionChange & { readonly undo: boolean }) =>
      executePullRequest(detail.key, detail.accountId, {
        kind: "edit",
        body: change.after,
        expectedBody: change.before,
      }),
    retry: false,
    onSuccess: (_, change) => {
      if (change.undo) {
        toastManager.add({ type: "success", title: "Description put back" });
        return;
      }
      const toast = toastManager.add({
        type: "success",
        title: "Description updated on GitHub",
        actionProps: {
          children: "Undo",
          onClick: () => {
            toastManager.close(toast);
            update.mutate({ before: change.after, after: change.before, undo: true });
          },
        },
      });
    },
    onError: (error, change) => {
      if (change.undo)
        toastManager.add({
          type: "error",
          title: "Couldn't put the old description back",
          description: error.message,
        });
    },
    // The server marked this PR and its account's inbox stale when the edit ran.
    onSettled: () =>
      Promise.all([
        invalidatePullRequestReads(client, detail.key, detail.accountId),
        client.invalidateQueries({ queryKey: inboxQuery.queryKey }),
      ]),
  });
  return update;
};
