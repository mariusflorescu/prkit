import * as NodeFS from "node:fs/promises";

import { type DesktopUpdateState, DesktopUpdateIpc, UpdateChannel } from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  type MessageBoxOptions,
} from "electron";

import * as DesktopSettings from "./DesktopSettings.ts";
import { DesktopUpdates, layer as desktopUpdatesLayer } from "./DesktopUpdates.ts";
import * as ElectronUpdater from "./ElectronUpdater.ts";
import { ServerRestartFailed, UpdateHost } from "./UpdateHost.ts";

const decodeChannel = Schema.decodeUnknownOption(UpdateChannel);

class UpdateRequestFailed extends Schema.TaggedError<UpdateRequestFailed>()("UpdateRequestFailed", {
  message: Schema.String,
}) {}

const TRACK_NAMES = { stable: "Stable", nightly: "Nightly" } as const;

/**
 * Starts the updater in the main process: its Effect runtime, the IPC the page calls, and the
 * "Check for Updates…" dialogs. Only the app's own page may call, as with prkit:notify.
 */
export function startDesktopUpdates(options: {
  readonly userDataDir: string;
  readonly updateConfigPath: string;
  /** The origin of the page allowed to call; undefined until the window exists. */
  readonly allowedOrigin: () => string | undefined;
  readonly stopServer: () => Promise<void>;
  readonly restartServer: () => Promise<void>;
}) {
  const host = UpdateHost.of({
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    disabledByEnv: (process.env.PRKIT_DISABLE_AUTO_UPDATE ?? "") !== "",
    readUpdateConfig: Effect.tryPromise(() =>
      NodeFS.readFile(options.updateConfigPath, "utf8"),
    ).pipe(Effect.option),
    publish: (state) =>
      Effect.sync(() => {
        for (const window of BrowserWindow.getAllWindows())
          window.webContents.send(DesktopUpdateIpc.state, state);
      }),
    stopServer: Effect.promise(options.stopServer),
    restartServer: Effect.tryPromise({
      try: options.restartServer,
      catch: (cause) =>
        new ServerRestartFailed({
          message: `prkit couldn't start its server again${cause instanceof Error ? `: ${cause.message}` : "."}`,
        }),
    }),
  });
  const runtime = ManagedRuntime.make(
    desktopUpdatesLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ElectronUpdater.layer,
          DesktopSettings.layer(options.userDataDir),
          Layer.succeed(UpdateHost, host),
        ),
      ),
    ),
  );
  const run = <A, E>(f: (updates: DesktopUpdates["Service"]) => Effect.Effect<A, E>) =>
    runtime.runPromise(DesktopUpdates.use(f));

  const allowed = (event: IpcMainInvokeEvent) => {
    const origin = URL.parse(event.senderFrame?.url ?? "")?.origin;
    return origin !== undefined && origin === options.allowedOrigin();
  };
  const handle = <A, E>(
    channel: string,
    action: (
      updates: DesktopUpdates["Service"],
      payload: Option.Option<UpdateChannel>,
    ) => Effect.Effect<A, E>,
  ) =>
    ipcMain.handle(channel, (event, payload) => {
      if (!allowed(event)) throw new Error("Only prkit's own page can manage updates.");
      return run((updates) => action(updates, decodeChannel(payload)));
    });

  handle(DesktopUpdateIpc.getState, (updates) => updates.getState);
  handle(DesktopUpdateIpc.check, (updates) => updates.check);
  handle(DesktopUpdateIpc.download, (updates) => updates.download);
  handle(DesktopUpdateIpc.install, (updates) => updates.install);
  handle(DesktopUpdateIpc.dismissWhatsNew, (updates) => updates.dismissWhatsNew);
  handle(DesktopUpdateIpc.setChannel, (updates, channel) =>
    Option.match(channel, {
      onNone: () => Effect.fail(new UpdateRequestFailed({ message: "Pick Stable or Nightly." })),
      onSome: (value) =>
        updates
          .setChannel(value)
          .pipe(Effect.mapError((error) => new UpdateRequestFailed({ message: error.message }))),
    }),
  );

  const show = (message: MessageBoxOptions) => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    return window === undefined
      ? dialog.showMessageBox(message)
      : dialog.showMessageBox(window, message);
  };

  /** App menu > Check for Updates…: a check now, answered with a native dialog. */
  const checkFromMenu = async () => {
    const name = app.getName();
    const before = await run((updates) => updates.getState);
    const ready = readyDialog(name, before);
    if (ready !== undefined) {
      await show(ready);
      return;
    }
    const { state } = await run((updates) => updates.check);
    if (state.status === "up-to-date") {
      await show({
        type: "info",
        message: "You're up to date",
        detail: `${name} ${state.currentVersion} is the newest version on the ${TRACK_NAMES[state.channel]} track.`,
        buttons: ["OK"],
      });
    } else if (state.status === "error") {
      await show({
        type: "warning",
        message: "Couldn't check for updates",
        detail: state.errorMessage ?? "Try again in a moment.",
        buttons: ["OK"],
      });
    } else if (state.status === "available") {
      const { response } = await show({
        type: "info",
        message: `${name} ${state.availableVersion ?? ""} is available`,
        detail: "Download it now? Hover Update in the title bar to read what's new.",
        buttons: ["Download", "Later"],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) await run((updates) => updates.download);
    }
  };

  return { checkFromMenu, dispose: () => runtime.dispose() };
}

/** The dialog for a menu check that has nothing to check: updates are off, or one is already on its way. */
const readyDialog = (name: string, state: DesktopUpdateState): MessageBoxOptions | undefined => {
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
