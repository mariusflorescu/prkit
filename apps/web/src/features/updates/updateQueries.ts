import type { DesktopUpdateActionResult, UpdateChannel } from "@prkit/contracts";
import { queryOptions, skipToken, useMutation, useQueryClient } from "@tanstack/react-query";

import { updatesBridge } from "~/lib/desktop";

const bridge = updatesBridge;

/** The shell's update state. Its pushes land here too (UpdateNotifications). */
export const desktopUpdateQuery = queryOptions({
  queryKey: ["desktop-update"] as const,
  queryFn: bridge === undefined ? skipToken : () => bridge.getState(),
  staleTime: Number.POSITIVE_INFINITY,
});

/** Electron wraps a rejected call as "Error invoking remote method '…': Tag: message". */
export const updateErrorMessage = (error: Error) =>
  error.message.replace(/^Error invoking remote method '[^']+': (?:\w+: )?/, "");

type Action = "check" | "download" | "install" | "dismissWhatsNew";

/** One update action; its answer becomes the shown state. */
export function useUpdateAction(action: Action) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (): Promise<DesktopUpdateActionResult> => {
      if (updatesBridge === undefined) throw new Error("Updates run only in the desktop app.");
      return updatesBridge[action]();
    },
    onSuccess: (result) => client.setQueryData(desktopUpdateQuery.queryKey, result.state),
  });
}

export function useSetUpdateChannel() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (channel: UpdateChannel): Promise<DesktopUpdateActionResult> => {
      if (updatesBridge === undefined) throw new Error("Updates run only in the desktop app.");
      return updatesBridge.setChannel(channel);
    },
    onSuccess: (result) => client.setQueryData(desktopUpdateQuery.queryKey, result.state),
  });
}
