import { channelOfVersion, type DesktopUpdateState, type UpdateChannel } from "@prkit/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";

import { DesktopSettings } from "./DesktopSettings.ts";
import { ElectronUpdater, type UpdaterChannelOptions } from "./ElectronUpdater.ts";
import { normalizeReleaseNotes } from "./releaseNotes.ts";
import { initialUpdateState, reduceUpdateState, type UpdateEvent } from "./updateMachine.ts";
import { parseUpdateFeed, UpdateHost } from "./UpdateHost.ts";

export const STARTUP_DELAY = "15 seconds";
export const POLL_INTERVAL = "30 minutes";

type UpdateAction = "check" | "download" | "install" | "channel";

/** Whether the request started, and the state after it. What every IPC invoke answers. */
export interface ActionResult {
  readonly accepted: boolean;
  readonly state: DesktopUpdateState;
}

const updaterChannel = (channel: UpdateChannel): UpdaterChannelOptions => ({
  channel: channel === "nightly" ? "nightly" : "latest",
  allowPrerelease: channel === "nightly",
  allowDowngrade: false,
});

/** A check would replace what's being downloaded or waits to install. */
const canCheck = (state: DesktopUpdateState) =>
  state.status !== "disabled" && state.status !== "downloading" && state.status !== "downloaded";

/**
 * Finds, downloads and installs app updates through electron-updater, one action at a time,
 * and keeps the state every window shows. Checks start 15 seconds after launch and repeat every
 * 30 minutes. The track (Stable or Nightly) is the user's, stored in the desktop settings.
 */
export class DesktopUpdates extends Context.Service<DesktopUpdates, Effect.Success<typeof make>>()(
  "@prkit/desktop/updates/DesktopUpdates",
) {}

export const make = Effect.gen(function* () {
  const host = yield* UpdateHost;
  const updater = yield* ElectronUpdater;
  const settings = yield* DesktopSettings;

  const feed = Option.flatMap(yield* host.readUpdateConfig, parseUpdateFeed);
  const disabledReason = !host.isPackaged
    ? "Updates work only in the installed app."
    : Option.isNone(feed)
      ? "This build has no update feed."
      : host.disabledByEnv
        ? "Updates are turned off by PRKIT_DISABLE_AUTO_UPDATE."
        : null;
  // A nightly build starts on Nightly, a stable one on Stable, until the user picks.
  const startChannel = Option.getOrElse(yield* settings.updateChannel, () =>
    channelOfVersion(host.appVersion),
  );
  const stored = yield* settings.downloadedNotes;
  const whatsNew =
    Option.isSome(stored) && stored.value.version === host.appVersion && !stored.value.shown
      ? { version: stored.value.version, releaseNotes: stored.value.releaseNotes }
      : null;

  const stateRef = yield* Ref.make(
    initialUpdateState({
      currentVersion: host.appVersion,
      channel: startChannel,
      releasesUrl: Option.match(feed, { onNone: () => null, onSome: (value) => value.releasesUrl }),
      whatsNew,
    }),
  );
  const activeRef = yield* Ref.make(Option.none<UpdateAction>());

  const getState = Ref.get(stateRef);
  const dispatch = (event: UpdateEvent) =>
    Ref.updateAndGet(stateRef, (state) => reduceUpdateState(state, event)).pipe(
      Effect.flatMap(host.publish),
    );
  const nowIso = Clock.currentTimeMillis.pipe(
    Effect.map((millis) => new Date(millis).toISOString()),
  );

  /** Runs `effect` unless another action holds the updater; false when it didn't run. */
  const exclusive = <E>(action: UpdateAction, effect: Effect.Effect<void, E>) =>
    Ref.modify(activeRef, (active) =>
      Option.isSome(active) ? [false, active] : [true, Option.some(action)],
    ).pipe(
      Effect.flatMap((reserved) =>
        reserved
          ? effect.pipe(Effect.ensuring(Ref.set(activeRef, Option.none())), Effect.as(true))
          : Effect.succeed(false),
      ),
    );

  const answer = <E>(accepted: Effect.Effect<boolean, E>) =>
    accepted.pipe(
      Effect.flatMap((value) => getState.pipe(Effect.map((state) => ({ accepted: value, state })))),
    );

  const runCheck = Effect.gen(function* () {
    const { channel } = yield* getState;
    yield* dispatch({ _tag: "CheckStarted" });
    const result = yield* Effect.result(updater.check);
    const at = yield* nowIso;
    if (Result.isFailure(result)) {
      yield* Effect.logWarning(`update check failed: ${result.failure.message}`);
      return yield* dispatch({ _tag: "CheckFailed", message: result.failure.message, at });
    }
    if (Option.isNone(result.success)) return yield* dispatch({ _tag: "NoUpdate", at });
    const found = result.success.value;
    if (channelOfVersion(found.version) !== channel) {
      yield* Effect.logInfo(`ignoring ${found.version}: it isn't on the ${channel} track`);
      return yield* dispatch({ _tag: "NoUpdate", at });
    }
    yield* Effect.logInfo(`update available: ${found.version}`);
    yield* dispatch({
      _tag: "UpdateAvailable",
      version: found.version,
      releaseNotes: normalizeReleaseNotes(found.releaseNotes, found.version, channel),
      at,
    });
  });

  const check = getState.pipe(
    Effect.flatMap((state) =>
      canCheck(state) ? exclusive("check", runCheck) : Effect.succeed(false),
    ),
  );

  const runDownload = Effect.scoped(
    Effect.gen(function* () {
      yield* dispatch({ _tag: "DownloadStarted" });
      const progress = yield* Queue.unbounded<number>();
      yield* updater.onDownloadProgress((percent) => Queue.offerUnsafe(progress, percent));
      yield* Queue.take(progress).pipe(
        Effect.flatMap((percent) => dispatch({ _tag: "DownloadProgress", percent })),
        Effect.forever,
        Effect.forkScoped,
      );
      const result = yield* Effect.result(updater.download);
      if (Result.isFailure(result)) {
        yield* Effect.logWarning(`update download failed: ${result.failure.message}`);
        return yield* dispatch({ _tag: "DownloadFailed", message: result.failure.message });
      }
      const { availableVersion, releaseNotes } = yield* getState;
      if (availableVersion === null) return;
      yield* dispatch({ _tag: "Downloaded", version: availableVersion });
      // Shown once on the first launch of the new version.
      yield* settings.saveDownloadedNotes({ version: availableVersion, releaseNotes });
    }),
  );

  const download = getState.pipe(
    Effect.flatMap((state) =>
      state.status === "available" ? exclusive("download", runDownload) : Effect.succeed(false),
    ),
  );

  const runInstall = Effect.gen(function* () {
    yield* Effect.logInfo("stopping the server to install the update");
    yield* host.stopServer;
    // On success the app quits here and never returns.
    const installed = yield* Effect.result(updater.quitAndInstall);
    if (Result.isSuccess(installed)) return;
    yield* Effect.logWarning(`update install failed: ${installed.failure.message}`);
    const restarted = yield* Effect.result(host.restartServer);
    yield* dispatch({
      _tag: "InstallFailed",
      message: Result.isSuccess(restarted)
        ? installed.failure.message
        : `${installed.failure.message} ${restarted.failure.message}`,
    });
  });

  const install = getState.pipe(
    Effect.flatMap((state) =>
      state.status === "downloaded" ? exclusive("install", runInstall) : Effect.succeed(false),
    ),
  );

  const setChannel = (next: UpdateChannel) =>
    exclusive(
      "channel",
      Effect.gen(function* () {
        if ((yield* getState).channel === next) return;
        yield* settings.setUpdateChannel(next);
        if (disabledReason !== null)
          return yield* dispatch({ _tag: "Disabled", channel: next, reason: disabledReason });
        yield* dispatch({ _tag: "Enabled", channel: next });
        yield* updater.applyChannel(updaterChannel(next));
        // Nightly to Stable goes to an older version, so this one check may offer a downgrade.
        yield* updater.setAllowDowngrade(true);
        yield* runCheck.pipe(Effect.ensuring(updater.setAllowDowngrade(false)));
      }),
    );

  const dismissWhatsNew = Effect.gen(function* () {
    const { whatsNew: shown } = yield* getState;
    if (shown === null) return;
    yield* settings.markNotesShown(shown.version);
    yield* dispatch({ _tag: "WhatsNewDismissed" });
  });

  if (disabledReason === null) {
    yield* updater.configure;
    yield* updater.applyChannel(updaterChannel(startChannel));
    yield* dispatch({ _tag: "Enabled", channel: startChannel });
    yield* Effect.sleep(STARTUP_DELAY).pipe(
      Effect.andThen(check),
      Effect.andThen(Effect.sleep(POLL_INTERVAL).pipe(Effect.andThen(check), Effect.forever)),
      Effect.forkScoped,
    );
  } else {
    yield* Effect.logInfo(`updates are off: ${disabledReason}`);
    yield* dispatch({ _tag: "Disabled", channel: startChannel, reason: disabledReason });
  }

  return {
    getState,
    /** The reason updates are off, for the menu's dialog; null when they're on. */
    disabledReason,
    check: answer(check),
    download: answer(download),
    install: answer(install),
    setChannel: (channel: UpdateChannel) => answer(setChannel(channel)),
    dismissWhatsNew: answer(dismissWhatsNew.pipe(Effect.as(true))),
  };
});

export const layer = Layer.effect(DesktopUpdates, make);
