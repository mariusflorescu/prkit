import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { toastManager } from "~/components/ui/toast";
import { updateAppearance } from "~/rpc/client";
import { appearanceQuery } from "~/rpc/queries";

const SAVE_KEY = ["appearance", "guideNotesOnFiles"];

/**
 * Whether Files shows the latest guide's notes, kept by the server beside the theme. The
 * cache changes first, so the notes go or come with the click. One save runs at a time, in any
 * Files tab, so a failed save rolls back to the value it replaced, which is the one stored.
 */
export function useGuideNotesOnFiles() {
  const client = useQueryClient();
  const appearance = useQuery(appearanceQuery);
  const write = (shown: boolean) =>
    client.setQueryData(
      appearanceQuery.queryKey,
      (cached) => cached && { ...cached, guideNotesOnFiles: shown },
    );
  const saving = useIsMutating({ mutationKey: SAVE_KEY }) > 0;
  const save = useMutation({
    mutationKey: SAVE_KEY,
    mutationFn: (shown: boolean) => updateAppearance({ guideNotesOnFiles: shown }),
    onMutate: async (shown) => {
      await client.cancelQueries({ queryKey: appearanceQuery.queryKey });
      const before = client.getQueryData(appearanceQuery.queryKey)?.guideNotesOnFiles;
      write(shown);
      return { before };
    },
    onError: (error, _shown, context) => {
      if (context?.before !== undefined) write(context.before);
      toastManager.add({ type: "error", title: "Couldn't save that", description: error.message });
    },
    onSuccess: (saved) =>
      client.setQueryData(appearanceQuery.queryKey, (cached) => cached ?? saved),
  });
  return {
    shown: appearance.data?.guideNotesOnFiles ?? true,
    pending: appearance.isPending,
    saving,
    set: (next: boolean) => {
      if (client.isMutating({ mutationKey: SAVE_KEY }) === 0) save.mutate(next);
    },
  };
}
