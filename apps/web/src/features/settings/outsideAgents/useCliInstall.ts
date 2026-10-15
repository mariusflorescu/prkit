import { useMutation, useQueryClient } from "@tanstack/react-query";

import { toastManager } from "~/components/ui/toast";
import { changeCliInstall, cliInstallQuery } from "~/rpc/cliInstall";

export function useCliInstall() {
  const client = useQueryClient();
  const change = useMutation({
    mutationFn: changeCliInstall,
    onSuccess: (next, action) => {
      if (next !== undefined) client.setQueryData(cliInstallQuery.queryKey, next);
      toastManager.add({
        title:
          action === "skill"
            ? "Skill installer opened in Terminal"
            : action === "install"
              ? "Command line tool installed"
              : "Command line tool uninstalled",
        type: "success",
      });
    },
  });
  return { change };
}
