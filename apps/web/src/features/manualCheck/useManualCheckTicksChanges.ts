import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { watchManualCheckTicks } from "~/rpc/client";
import { manualCheckTicksQuery } from "~/rpc/queries";

/**
 * Reads a review's manual check ticks again when anything saves them: another window, an
 * outside agent, the CLI. A new connection reads them all, since changes while it was down
 * were missed.
 */
export function useManualCheckTicksChanges() {
  const client = useQueryClient();
  useEffect(
    () =>
      watchManualCheckTicks((change) => {
        void client.invalidateQueries({
          queryKey:
            change._tag === "connected"
              ? ["manualCheckTicks"]
              : manualCheckTicksQuery(change.subject).queryKey,
        });
      }),
    [client],
  );
}
