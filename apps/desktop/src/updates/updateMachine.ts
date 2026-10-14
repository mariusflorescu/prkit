import type { DesktopUpdateState, ReleaseNotes, UpdateChannel, WhatsNew } from "@prkit/contracts";

import { EMPTY_RELEASE_NOTES } from "./releaseNotes.ts";

/** Everything that moves the update state. The service feeds these; the reducer stays pure. */
export type UpdateEvent =
  | { readonly _tag: "Enabled"; readonly channel: UpdateChannel }
  | { readonly _tag: "Disabled"; readonly channel: UpdateChannel; readonly reason: string }
  | { readonly _tag: "CheckStarted" }
  | { readonly _tag: "CheckFailed"; readonly message: string; readonly at: string }
  | {
      readonly _tag: "UpdateAvailable";
      readonly version: string;
      readonly releaseNotes: ReleaseNotes;
      readonly at: string;
    }
  | { readonly _tag: "NoUpdate"; readonly at: string }
  | { readonly _tag: "OtherTrackIgnored"; readonly at: string }
  | { readonly _tag: "DownloadStarted" }
  | { readonly _tag: "DownloadProgress"; readonly percent: number }
  | { readonly _tag: "DownloadFailed"; readonly message: string }
  | { readonly _tag: "Downloaded"; readonly version: string }
  | { readonly _tag: "InstallFailed"; readonly message: string }
  | { readonly _tag: "WhatsNewDismissed" };

export const initialUpdateState = (options: {
  readonly currentVersion: string;
  readonly channel: UpdateChannel;
  readonly releasesUrl: string | null;
  readonly whatsNew: WhatsNew | null;
}): DesktopUpdateState => ({
  status: "disabled",
  disabledReason: null,
  channel: options.channel,
  currentVersion: options.currentVersion,
  availableVersion: null,
  downloadPercent: null,
  releaseNotes: EMPTY_RELEASE_NOTES,
  errorMessage: null,
  errorContext: null,
  lastCheckedAt: null,
  releasesUrl: options.releasesUrl,
  whatsNew: options.whatsNew,
});

const cleared = {
  availableVersion: null,
  downloadPercent: null,
  releaseNotes: EMPTY_RELEASE_NOTES,
  errorMessage: null,
  errorContext: null,
} as const;

const noError = { errorMessage: null, errorContext: null } as const;

/**
 * An update on offer stays on offer through later checks: the title bar button and its notes
 * don't flicker away during a poll, a failed poll, or one that finds nothing new.
 * electron-updater keeps what it found until a check finds something else, so Download
 * still fetches the offered version.
 */
const onOffer = (state: DesktopUpdateState) => state.status === "available";

export const reduceUpdateState = (
  state: DesktopUpdateState,
  event: UpdateEvent,
): DesktopUpdateState => {
  switch (event._tag) {
    case "Enabled":
      // A track switch starts over: what the other track offered no longer applies.
      return { ...state, ...cleared, status: "idle", disabledReason: null, channel: event.channel };
    case "Disabled":
      return {
        ...state,
        ...cleared,
        status: "disabled",
        disabledReason: event.reason,
        channel: event.channel,
      };
    case "CheckStarted":
      return onOffer(state) ? state : { ...state, ...noError, status: "checking" };
    case "CheckFailed":
      if (onOffer(state)) return state;
      return {
        ...state,
        ...cleared,
        status: "error",
        errorMessage: event.message,
        errorContext: "check",
        lastCheckedAt: event.at,
      };
    case "UpdateAvailable":
      return {
        ...state,
        ...noError,
        status: "available",
        availableVersion: event.version,
        downloadPercent: null,
        releaseNotes: event.releaseNotes,
        lastCheckedAt: event.at,
      };
    case "NoUpdate":
      return onOffer(state)
        ? { ...state, lastCheckedAt: event.at }
        : { ...state, ...cleared, status: "up-to-date", lastCheckedAt: event.at };
    case "OtherTrackIgnored":
      // electron-updater now holds the ignored version, so the offer can't be downloaded anymore.
      return { ...state, ...cleared, status: "up-to-date", lastCheckedAt: event.at };
    case "DownloadStarted":
      return { ...state, ...noError, status: "downloading", downloadPercent: 0 };
    case "DownloadProgress":
      return state.status === "downloading"
        ? { ...state, downloadPercent: Math.max(0, Math.min(100, event.percent)) }
        : state;
    case "DownloadFailed":
      // The update is still on offer, so the button says Update again and Retry downloads.
      return {
        ...state,
        status: state.availableVersion === null ? "error" : "available",
        downloadPercent: null,
        errorMessage: event.message,
        errorContext: "download",
      };
    case "Downloaded":
      return {
        ...state,
        ...noError,
        status: "downloaded",
        availableVersion: event.version,
        downloadPercent: 100,
      };
    case "InstallFailed":
      return {
        ...state,
        status: "downloaded",
        errorMessage: event.message,
        errorContext: "install",
      };
    case "WhatsNewDismissed":
      return { ...state, whatsNew: null };
  }
};
