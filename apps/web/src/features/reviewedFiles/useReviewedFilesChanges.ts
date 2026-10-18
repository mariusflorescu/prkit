import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { watchReviewedFiles } from "~/rpc/client";
import { reviewedFilesQuery } from "~/rpc/queries";

/**
 * Reads a PR's reviewed files again when anything saves them: another window, an outside
 * agent, the CLI. A new connection reads them all, since changes while it was down were missed.
 */
export function useReviewedFilesChanges() {
  const client = useQueryClient();
  useEffect(
    () =>
      watchReviewedFiles((change) => {
        void client.invalidateQueries({
          queryKey:
            change._tag === "connected"
              ? ["reviewedFiles"]
              : reviewedFilesQuery(change.key, change.accountId).queryKey,
        });
      }),
    [client],
  );
}
