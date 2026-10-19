import { useMutation, useQueryClient } from "@tanstack/react-query";

import { toastManager } from "~/components/ui/toast";
import { changeCliInstall, cliInstallQuery } from "~/rpc/cliInstall";

export function useCliInstall() {
  const client = useQueryClient();
  const change = useMutation({
    mutationFn: changeCliInstall,
    onSuccess: (next, action) => {
      if ("terminal" in next) {
        toastManager.add({
          title: `Skill installer opened in ${next.terminal}`,
          description: next.isDefault
            ? "It's your default terminal. You can change it from your terminal's menu."
            : "prkit couldn't use your default terminal.",
          type: "success",
        });
        return;
      }
      client.setQueryData(cliInstallQuery.queryKey, next);
      toastManager.add({
        title:
          action === "install" ? "Command line tool installed" : "Command line tool uninstalled",
        type: "success",
      });
    },
  });
  return { change };
}
