import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { toastManager } from "~/components/ui/toast";
import { updatesBridge } from "~/lib/desktop";

import { desktopUpdateQuery, useUpdateAction } from "./updateQueries";
import { useWhatsNewDialog } from "./whatsNewStore";
import { WhatsNewDialog } from "./WhatsNewDialog";

/**
 * Keeps the update state current from the shell's pushes, and tells two moments with a toast:
 * an update finished downloading, and the first launch after one installed (once per version).
 */
export function UpdateNotifications() {
  const client = useQueryClient();
  const state = useQuery(desktopUpdateQuery).data;
  const dismiss = useUpdateAction("dismissWhatsNew");
  const lastStatus = useRef(state?.status);
  const toldVersion = useRef<string | null>(null);

  useEffect(
    () => updatesBridge?.onState((next) => client.setQueryData(desktopUpdateQuery.queryKey, next)),
    [client],
  );

  useEffect(() => {
    if (state === undefined) return;
    const previous = lastStatus.current;
    lastStatus.current = state.status;
    if (state.status !== "downloaded" || previous !== "downloading") return;
    const version = state.availableVersion ?? "";
    toastManager.add({
      title: "Update downloaded",
      description: `Restart prkit from the title bar to install ${version}.`,
      type: "success",
      actionProps: {
        children: "What's new",
        onClick: () =>
          useWhatsNewDialog.getState().show({
            title: `What's new in ${version}`,
            notes: state.releaseNotes,
            releasesUrl: state.releasesUrl,
          }),
      },
    });
  }, [state]);

  const whatsNew = state?.whatsNew ?? null;
  const releasesUrl = state?.releasesUrl ?? null;
  const { mutate: markShown } = dismiss;
  useEffect(() => {
    if (whatsNew === null || toldVersion.current === whatsNew.version) return;
    toldVersion.current = whatsNew.version;
    toastManager.add({
      title: `Updated to ${whatsNew.version}`,
      type: "success",
      actionProps: {
        children: "What's new",
        onClick: () =>
          useWhatsNewDialog.getState().show({
            title: `What's new in ${whatsNew.version}`,
            notes: whatsNew.releaseNotes,
            releasesUrl,
          }),
      },
    });
    markShown();
  }, [whatsNew, releasesUrl, markShown]);

  return <WhatsNewDialog />;
}
