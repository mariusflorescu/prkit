import { useMutation } from "@tanstack/react-query";

import { toastManager } from "~/components/ui/toast";
import { getRecentLog } from "~/rpc/client";

/** Puts the newest lines of the server's log on the clipboard. An empty log copies nothing. */
export function useCopyServerLog() {
  return useMutation({
    mutationFn: async () => {
      const log = await getRecentLog();
      if (log.text === "") return "empty" as const;
      await navigator.clipboard.writeText(log.text).catch(() => {
        throw new Error("prkit couldn't reach your clipboard. Try again.");
      });
      return "copied" as const;
    },
    onSuccess: (outcome) =>
      toastManager.add(
        outcome === "copied"
          ? { type: "success", title: "Copied the recent log" }
          : { type: "info", title: "The log is empty so far." },
      ),
  });
}
