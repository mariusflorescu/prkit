import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { autoUpdater } from "electron-updater";

import type { RawReleaseNotes } from "./releaseNotes.ts";
import { describeUpdaterError } from "./updaterErrors.ts";

/** Squirrel.Mac verifies the downloaded app before it quits; a failure arrives as an error event. */
const INSTALL_VERDICT_TIMEOUT = Duration.minutes(2);

export class UpdaterFailed extends Schema.TaggedError<UpdaterFailed>()("UpdaterFailed", {
  operation: Schema.Literals(["check", "download", "install"]),
  message: Schema.String,
}) {}

export interface FoundUpdate {
  readonly version: string;
  readonly releaseNotes: RawReleaseNotes;
}

/** How the feed is read for a track. electron-updater's `channel` names the manifest: latest-mac.yml or nightly-mac.yml. */
export interface UpdaterChannelOptions {
  readonly channel: "latest" | "nightly";
  readonly allowPrerelease: boolean;
  readonly allowDowngrade: boolean;
}

const failed = (operation: UpdaterFailed["operation"]) => (cause: Error | string) =>
  new UpdaterFailed({
    operation,
    message: describeUpdaterError(
      operation,
      typeof cause === "string"
        ? { message: cause }
        : {
            message: cause.message,
            ...("code" in cause && typeof cause.code === "string" ? { code: cause.code } : {}),
          },
    ),
  });

/** electron-updater's autoUpdater, one Effect per call the updater service makes. */
export class ElectronUpdater extends Context.Service<
  ElectronUpdater,
  {
    readonly configure: Effect.Effect<void>;
    readonly applyChannel: (options: UpdaterChannelOptions) => Effect.Effect<void>;
    readonly setAllowDowngrade: (allow: boolean) => Effect.Effect<void>;
    /** The offered version, or none when the feed has nothing newer. */
    readonly check: Effect.Effect<Option.Option<FoundUpdate>, UpdaterFailed>;
    readonly download: Effect.Effect<void, UpdaterFailed>;
    readonly onDownloadProgress: (
      listener: (percent: number) => void,
    ) => Effect.Effect<void, never, Scope.Scope>;
    /** Hands the app to Squirrel.Mac, which quits it. Fails only when the install did not start. */
    readonly quitAndInstall: Effect.Effect<void, UpdaterFailed>;
  }
>()("@prkit/desktop/updates/ElectronUpdater") {}

export const make = ElectronUpdater.of({
  configure: Effect.sync(() => {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    // Every version between this one and the offered one brings its notes.
    autoUpdater.fullChangelog = true;
  }),
  applyChannel: (options) =>
    Effect.sync(() => {
      // Setting `channel` turns allowDowngrade on as a side effect, so it goes first.
      autoUpdater.channel = options.channel;
      autoUpdater.allowPrerelease = options.allowPrerelease;
      autoUpdater.allowDowngrade = options.allowDowngrade;
    }),
  setAllowDowngrade: (allow) =>
    Effect.sync(() => {
      autoUpdater.allowDowngrade = allow;
    }),
  check: Effect.tryPromise({
    try: () => autoUpdater.checkForUpdates(),
    catch: (cause) => failed("check")(cause instanceof Error ? cause : String(cause)),
  }).pipe(
    Effect.map((result) =>
      result === null || !result.isUpdateAvailable
        ? Option.none()
        : Option.some({
            version: result.updateInfo.version,
            releaseNotes: result.updateInfo.releaseNotes,
          }),
    ),
  ),
  download: Effect.tryPromise({
    try: () => autoUpdater.downloadUpdate(),
    catch: (cause) => failed("download")(cause instanceof Error ? cause : String(cause)),
  }).pipe(Effect.asVoid),
  onDownloadProgress: (listener) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const handler = (progress: { readonly percent: number }) => listener(progress.percent);
        autoUpdater.on("download-progress", handler);
        return handler;
      }),
      (handler) => Effect.sync(() => autoUpdater.off("download-progress", handler)),
    ).pipe(Effect.asVoid),
  quitAndInstall: Effect.callback<void, UpdaterFailed>((resume) => {
    const onError = (error: Error) => resume(Effect.fail(failed("install")(error)));
    autoUpdater.once("error", onError);
    try {
      autoUpdater.quitAndInstall(true, true);
    } catch (cause) {
      autoUpdater.off("error", onError);
      resume(Effect.fail(failed("install")(cause instanceof Error ? cause : String(cause))));
    }
    return Effect.sync(() => autoUpdater.off("error", onError));
  }).pipe(
    // The timeout can't disarm the `update-downloaded` handler MacUpdater set up inside
    // quitAndInstall, so a very late Squirrel success may still quit and install after the UI
    // said it failed. That's acceptable: the user asked to install this version, and the quit
    // runs through will-quit, which stops the server like any other quit.
    Effect.timeoutOrElse({
      duration: INSTALL_VERDICT_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new UpdaterFailed({
            operation: "install",
            message: "prkit didn't restart to install the update. Try again.",
          }),
        ),
    }),
  ),
});

export const layer = Layer.succeed(ElectronUpdater, make);
