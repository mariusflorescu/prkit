import type { AppearanceSettings } from "@prkit/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { updateAppearance } from "~/rpc/client";
import { appearanceQuery } from "~/rpc/queries";

/** The stored theme, changed optimistically: AppearanceSync paints the cache, so a card click is instant. */
export function useAppearance() {
  const client = useQueryClient();
  const appearance = useQuery(appearanceQuery);
  const update = useMutation({
    mutationFn: updateAppearance,
    onMutate: async (theme) => {
      await client.cancelQueries({ queryKey: appearanceQuery.queryKey });
      const before = client.getQueryData(appearanceQuery.queryKey);
      client.setQueryData(appearanceQuery.queryKey, { theme } satisfies AppearanceSettings);
      return { before };
    },
    onError: (_error, _theme, context) => {
      if (context?.before !== undefined)
        client.setQueryData(appearanceQuery.queryKey, context.before);
    },
    onSuccess: (saved) => client.setQueryData(appearanceQuery.queryKey, saved),
  });
  return { appearance, update };
}
