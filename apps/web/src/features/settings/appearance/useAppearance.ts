import type { ThemePreference } from "@prkit/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { updateAppearance } from "~/rpc/client";
import { appearanceQuery } from "~/rpc/queries";

/** The stored theme, changed optimistically: AppearanceSync paints the cache, so a card click is instant. */
export function useAppearance() {
  const client = useQueryClient();
  const appearance = useQuery(appearanceQuery);
  // Only the theme is written back, so a guide notes choice saved meanwhile stays.
  const setTheme = (theme: ThemePreference) =>
    client.setQueryData(appearanceQuery.queryKey, (cached) => cached && { ...cached, theme });
  const update = useMutation({
    mutationFn: (theme: ThemePreference) => updateAppearance({ theme }),
    onMutate: async (theme) => {
      await client.cancelQueries({ queryKey: appearanceQuery.queryKey });
      const before = client.getQueryData(appearanceQuery.queryKey)?.theme;
      setTheme(theme);
      return { before };
    },
    onError: (_error, _theme, context) => {
      if (context?.before !== undefined) setTheme(context.before);
    },
    onSuccess: (saved) => setTheme(saved.theme),
  });
  return { appearance, update };
}
