import { channelOfVersion, type DesktopUpdateState, type UpdateChannel } from "@prkit/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
export const POLL_INTERVAL = "10 minutes";

type UpdateAction = "check" | "download" | "install" | "channel";

/** Whether the request started, and the state after it. What every IPC invoke answers. */
export interface ActionResult {
  readonly accepted: boolean;
  readonly state: DesktopUpdateState;
}

/** A check the caller started or joined, and why it failed; null when it finished. */
export interface CheckResult extends ActionResult {
  readonly failure: string | null;
}

const updaterChannel = (channel: UpdateChannel): UpdaterChannelOptions => ({
  channel: channel === "nightly" ? "nightly" : "latest",
  allowPrerelease: channel === "nightly",
  allowDowngrade: false,
});

/** A check would replace what's being downloaded or waits to install. */
const canCheck = (state: DesktopUpdateState) =>
  state.status !== "disabled" && state.status !== "downloading" && state.status !== "downloaded";

const PRERELEASE_PART = /^\d+$/;

/** Semver order of two plain versions (`1.2.3` or `1.2.3-nightly.20261016.1`); 0 when either isn't one. */
export const compareVersions = (left: string, right: string) => {
  const parse = (version: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
    return match === null
      ? undefined
      : {
          core: [Number(match[1]), Number(match[2]), Number(match[3])],
          pre: match[4] === undefined ? [] : match[4].split("."),
        };
  };
  const a = parse(left);
  const b = parse(right);
  if (a === undefined || b === undefined) return 0;
  for (let index = 0; index < 3; index++) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  // A release ranks above its prereleases.
  if (a.pre.length === 0 || b.pre.length === 0) return Math.sign(b.pre.length - a.pre.length);
  for (let index = 0; index < Math.min(a.pre.length, b.pre.length); index++) {
    const x = a.pre[index] ?? "";
    const y = b.pre[index] ?? "";
    if (x === y) continue;
    const xNumeric = PRERELEASE_PART.test(x);
    const yNumeric = PRERELEASE_PART.test(y);
    if (xNumeric && yNumeric) return Math.sign(Number(x) - Number(y));
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return Math.sign(a.pre.length - b.pre.length);
};

/**
 * Finds, downloads and installs app updates through electron-updater, one action at a time,
 * and keeps the state every window shows. Checks start 15 seconds after launch and repeat every
 * 10 minutes. The track (Stable or Nightly) is the user's, stored in the desktop settings.
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

  /** Runs `effect` unless another action holds the updater; none when it didn't run. */
  const exclusiveResult = <A, E>(action: UpdateAction, effect: Effect.Effect<A, E>) =>
    Ref.modify(activeRef, (active) =>
      Option.isSome(active) ? [false, active] : [true, Option.some(action)],
    ).pipe(
      Effect.flatMap((reserved) =>
        reserved
          ? effect.pipe(Effect.ensuring(Ref.set(activeRef, Option.none())), Effect.asSome)
          : Effect.succeedNone,
      ),
    );

  /** Like `exclusiveResult`, answering only whether it ran. */
  const exclusive = <A, E>(action: UpdateAction, effect: Effect.Effect<A, E>) =>
    exclusiveResult(action, effect).pipe(Effect.map(Option.isSome));

  const answer = <E>(accepted: Effect.Effect<boolean, E>) =>
    accepted.pipe(
      Effect.flatMap((value) => getState.pipe(Effect.map((state) => ({ accepted: value, state })))),
    );

  /** Completes with the failure message of the check now running, or null when it finished. */
  const runningCheckRef = yield* Ref.make(Option.none<Deferred.Deferred<string | null>>());

  /**
   * One check. `allowDowngrade` lets electron-updater offer an older version: the first check of
   * a new track, and every check while such an offer stands, or the next poll would drop it.
   */
  const runCheck = (allowDowngrade: boolean) =>
    Effect.gen(function* () {
      const done = yield* Deferred.make<string | null>();
      yield* Ref.set(runningCheckRef, Option.some(done));
      const failure = yield* Effect.gen(function* () {
        const { channel } = yield* getState;
        yield* updater.setAllowDowngrade(allowDowngrade);
        yield* dispatch({ _tag: "CheckStarted" });
        const result = yield* Effect.result(updater.check);
        const at = yield* nowIso;
        if (Result.isFailure(result)) {
          yield* Effect.logWarning(`update check failed: ${result.failure.message}`);
          yield* dispatch({ _tag: "CheckFailed", message: result.failure.message, at });
          return result.failure.message;
        }
        if (Option.isNone(result.success)) {
          yield* dispatch({ _tag: "NoUpdate", at });
          return null;
        }
        const found = result.success.value;
        if (channelOfVersion(found.version) !== channel) {
          yield* Effect.logInfo(`ignoring ${found.version}: it isn't on the ${channel} track`);
          yield* dispatch({ _tag: "OtherTrackIgnored", at });
          return null;
        }
        yield* Effect.logInfo(`update available: ${found.version}`);
        yield* dispatch({
          _tag: "UpdateAvailable",
          version: found.version,
          releaseNotes: normalizeReleaseNotes(found.releaseNotes, found.version, channel),
          at,
        });
        return null;
      }).pipe(
        // Whoever joined hears how it ended, an interruption included.
        Effect.onExit((exit) =>
          Ref.set(runningCheckRef, Option.none()).pipe(
            Effect.andThen(
              Deferred.succeed(
                done,
                Exit.isSuccess(exit) ? exit.value : "The check stopped before it finished.",
              ),
            ),
          ),
        ),
      );
      return failure;
    });

  /** Downgrades stay allowed while the offer is older than this version (Nightly to Stable). */
  const offersDowngrade = (state: DesktopUpdateState) =>
    state.status === "available" &&
    state.availableVersion !== null &&
    compareVersions(state.availableVersion, host.appVersion) < 0;

  const startCheck = getState.pipe(
    Effect.flatMap((state) =>
      canCheck(state)
        ? exclusiveResult("check", runCheck(offersDowngrade(state)))
        : Effect.succeed(Option.none<string | null>()),
    ),
  );

  const check = startCheck.pipe(Effect.map(Option.isSome));

  /** The check running now, if any, to wait for instead of starting another. */
  const runningCheck = Ref.get(runningCheckRef);

  /**
   * Check for Updates… in the app menu: joins a check that's already running (a poll or a
   * track switch) or starts one, and answers once it's over.
   */
  const checkNow = Effect.gen(function* () {
    const running = yield* runningCheck;
    const outcome = Option.isSome(running)
      ? Option.some(yield* Deferred.await(running.value))
      : yield* startCheck;
    const state = yield* getState;
    return Option.match(outcome, {
      onNone: (): CheckResult => ({ accepted: false, state, failure: null }),
      onSome: (failure): CheckResult => ({ accepted: true, state, failure }),
    });
  });

  const runDownload = Effect.scoped(
    Effect.gen(function* () {
      yield* updater.setAllowDowngrade(false);
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

  // A click on Update during a background check waits for it rather than being dropped.
  const download = runningCheck.pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: (done) => Effect.asVoid(Deferred.await(done)),
      }),
    ),
    Effect.andThen(getState),
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
        // Nightly to Stable goes to an older version, so this check may offer a downgrade.
        yield* runCheck(true);
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
    checkNow,
    download: answer(download),
    install: answer(install),
    setChannel: (channel: UpdateChannel) => answer(setChannel(channel)),
    dismissWhatsNew: answer(dismissWhatsNew.pipe(Effect.as(true))),
  };
});

export const layer = Layer.effect(DesktopUpdates, make);
