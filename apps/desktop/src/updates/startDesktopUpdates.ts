import * as NodeFS from "node:fs/promises";

import { DesktopUpdateIpc, UpdateChannel } from "@prkit/contracts";
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
import { checkResultDialog, readyDialog } from "./menuDialogs.ts";
import { ServerRestartFailed, UpdateHost } from "./UpdateHost.ts";

const decodeChannel = Schema.decodeUnknownOption(UpdateChannel);

class UpdateRequestFailed extends Schema.TaggedError<UpdateRequestFailed>()("UpdateRequestFailed", {
  message: Schema.String,
}) {}

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
  // The runtime builds the service on first use; build it now so the first check is 15 s after launch.
  runtime.context().catch((error: Error) => {
    process.stderr.write(`[desktop] updates could not start: ${error.message}\n`);
  });

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
    // A check already running (a poll, a track switch) is joined, and its result shown.
    const result = await run((updates) => updates.checkNow);
    const { response } = await show(checkResultDialog(name, result));
    if (
      result.accepted &&
      result.failure === null &&
      result.state.status === "available" &&
      response === 0
    )
      await run((updates) => updates.download);
  };

  return { checkFromMenu, dispose: () => runtime.dispose() };
}
