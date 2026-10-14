import type { DesktopUpdateState } from "@prkit/contracts";
import type { MessageBoxOptions } from "electron";

import type { CheckResult } from "./DesktopUpdates.ts";

const TRACK_NAMES = { stable: "Stable", nightly: "Nightly" } as const;

/** The dialog for a menu check that has nothing to check: updates are off, or one is already on its way. */
export const readyDialog = (
  name: string,
  state: DesktopUpdateState,
): MessageBoxOptions | undefined => {
  switch (state.status) {
    case "disabled":
      return {
        type: "info",
        message: "Updates aren't available",
        detail: state.disabledReason ?? "",
        buttons: ["OK"],
      };
    case "downloading":
      return {
        type: "info",
        message: `${name} ${state.availableVersion ?? ""} is downloading`,
        detail: "The title bar shows its progress.",
        buttons: ["OK"],
      };
    case "downloaded":
      return {
        type: "info",
        message: `${name} ${state.availableVersion ?? ""} is ready to install`,
        detail: "Use Restart to update in the title bar.",
        buttons: ["OK"],
      };
    default:
      return undefined;
  }
};

/** Download or Later, when the check that just ended offers a version. */
export const offerDialog = (name: string, state: DesktopUpdateState): MessageBoxOptions => ({
  type: "info",
  message: `${name} ${state.availableVersion ?? ""} is available`,
  detail: "Download it now? Hover Update in the title bar to read what's new.",
  buttons: ["Download", "Later"],
  defaultId: 0,
  cancelId: 1,
});

/** The answer to Check for Updates… once its check (started or joined) is over. */
export const checkResultDialog = (name: string, result: CheckResult): MessageBoxOptions => {
  const { state } = result;
  if (!result.accepted)
    return (
      readyDialog(name, state) ?? {
        type: "info",
        message: "prkit is already busy with an update",
        detail: "Settings > Updates shows where it stands.",
        buttons: ["OK"],
      }
    );
  if (result.failure !== null)
    return {
      type: "warning",
      message: "Couldn't check for updates",
      detail:
        state.status === "available"
          ? `${result.failure} ${name} ${state.availableVersion ?? ""} is still ready to download.`
          : result.failure,
      buttons: ["OK"],
    };
  if (state.status === "available") return offerDialog(name, state);
  return (
    readyDialog(name, state) ?? {
      type: "info",
      message: "You're up to date",
      detail: `${name} ${state.currentVersion} is the newest version on the ${TRACK_NAMES[state.channel]} track.`,
      buttons: ["OK"],
    }
  );
};
