import type { GuideSettings } from "@prkit/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { updateGuideSettings } from "~/rpc/client";
import { guideSettingsQuery } from "~/rpc/queries";

/** Settings > Guides with an optimistic update that rolls back if the server refuses it. */
export function useGuideSettings() {
  const client = useQueryClient();
  const settings = useQuery(guideSettingsQuery);
  const update = useMutation({
    mutationFn: updateGuideSettings,
    onMutate: async (patch) => {
      await client.cancelQueries({ queryKey: guideSettingsQuery.queryKey });
      const before = client.getQueryData(guideSettingsQuery.queryKey);
      if (before !== undefined)
        client.setQueryData(guideSettingsQuery.queryKey, {
          ...before,
          ...patch,
        } satisfies GuideSettings);
      return { before };
    },
    onError: (_error, _patch, context) => {
      if (context?.before !== undefined)
        client.setQueryData(guideSettingsQuery.queryKey, context.before);
    },
    onSuccess: (saved) => client.setQueryData(guideSettingsQuery.queryKey, saved),
  });
  return { settings, update };
}
