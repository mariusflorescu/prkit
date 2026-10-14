import { GuideConfigConflict, type GuideConfigSave } from "@prkit/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as Schema from "effect/Schema";

import { toastManager } from "~/components/ui/toast";
import { saveGuideConfig } from "~/rpc/client";
import { GUIDE_CONFIG_KEY } from "~/rpc/queries";

export const isConflict = Schema.is(GuideConfigConflict);

/** Saves one section of one scope, then refreshes every view of the guide settings. */
export function useSaveGuideSection(what: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: GuideConfigSave) => saveGuideConfig(input),
    onSuccess: () => {
      toastManager.add({ title: `${what} saved`, type: "success" });
      return client.invalidateQueries({ queryKey: GUIDE_CONFIG_KEY });
    },
  });
}
