import type { DesktopUpdateState, UpdateChannel, WhatsNew } from "@prkit/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import type * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vite-plus/test";

import { DesktopSettings, type StoredNotes } from "./DesktopSettings.ts";
import { DesktopUpdates, layer as desktopUpdatesLayer } from "./DesktopUpdates.ts";
import {
  ElectronUpdater,
  type FoundUpdate,
  type UpdaterChannelOptions,
  UpdaterFailed,
} from "./ElectronUpdater.ts";
import { ServerRestartFailed, UpdateHost } from "./UpdateHost.ts";

const GITHUB_FEED =
  "provider: github\nowner: acme\nrepo: widgets\nreleaseType: prerelease\nchannel: nightly\n";
const NIGHTLY = "0.1.0-nightly.20261015.1";
const NEXT_NIGHTLY = "0.1.0-nightly.20261016.1";

interface HarnessOptions {
  readonly appVersion?: string;
  readonly isPackaged?: boolean;
  readonly updateConfig?: string | null;
  readonly disabledByEnv?: boolean;
  readonly storedChannel?: UpdateChannel;
  readonly storedNotes?: StoredNotes;
  /** What each check answers, in order; the last one repeats. */
  readonly checks?: ReadonlyArray<Effect.Effect<Option.Option<FoundUpdate>, UpdaterFailed>>;
  readonly download?: Effect.Effect<void, UpdaterFailed>;
  readonly quitAndInstall?: Effect.Effect<void, UpdaterFailed>;
  readonly restartServer?: Effect.Effect<void, ServerRestartFailed>;
}

/** DesktopUpdates over a fake electron-updater, shell and settings file. Everything it did lands in `steps`. */
const makeHarness = (options: HarnessOptions = {}) => {
  const steps: Array<string> = [];
  const published: Array<DesktopUpdateState> = [];
  const channels: Array<UpdaterChannelOptions> = [];
  const downgrade: Array<boolean> = [];
  let checkCount = 0;
  let storedChannel = options.storedChannel;
  let storedNotes = options.storedNotes;
  let progressListener: ((percent: number) => void) | undefined;
  const checks = options.checks ?? [Effect.succeedNone];

  const updater = Layer.succeed(
    ElectronUpdater,
    ElectronUpdater.of({
      configure: Effect.sync(() => steps.push("configure")),
      applyChannel: (value) => Effect.sync(() => channels.push(value)),
      setAllowDowngrade: (allow) => Effect.sync(() => downgrade.push(allow)),
      check: Effect.suspend(() => {
        const answer = checks[Math.min(checkCount, checks.length - 1)] ?? checks[0];
        checkCount += 1;
        steps.push("check");
        return answer ?? Effect.succeedNone;
      }),
      download: Effect.suspend(() => {
        steps.push("download");
        return options.download ?? Effect.void;
      }),
      onDownloadProgress: (listener) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            progressListener = listener;
          }),
          () =>
            Effect.sync(() => {
              progressListener = undefined;
            }),
        ),
      quitAndInstall: Effect.suspend(() => {
        steps.push("quitAndInstall");
        return options.quitAndInstall ?? Effect.void;
      }),
    }),
  );
  const host = Layer.succeed(
    UpdateHost,
    UpdateHost.of({
      appVersion: options.appVersion ?? NIGHTLY,
      isPackaged: options.isPackaged ?? true,
      disabledByEnv: options.disabledByEnv ?? false,
      readUpdateConfig: Effect.succeed(
        options.updateConfig === null
          ? Option.none()
          : Option.some(options.updateConfig ?? GITHUB_FEED),
      ),
      publish: (state) => Effect.sync(() => published.push(state)),
      stopServer: Effect.sync(() => steps.push("stopServer")),
      restartServer: Effect.suspend(() => {
        steps.push("restartServer");
        return options.restartServer ?? Effect.void;
      }),
    }),
  );
  const settings = Layer.succeed(
    DesktopSettings,
    DesktopSettings.of({
      updateChannel: Effect.sync(() => Option.fromNullishOr(storedChannel)),
      setUpdateChannel: (channel) =>
        Effect.sync(() => {
          storedChannel = channel;
        }),
      downloadedNotes: Effect.sync(() => Option.fromNullishOr(storedNotes)),
      saveDownloadedNotes: (notes: WhatsNew) =>
        Effect.sync(() => {
          storedNotes = { ...notes, shown: false };
        }),
      markNotesShown: (version) =>
        Effect.sync(() => {
          if (storedNotes?.version === version) storedNotes = { ...storedNotes, shown: true };
        }),
    }),
  );
  return {
    layer: desktopUpdatesLayer.pipe(Layer.provide(Layer.mergeAll(updater, host, settings))),
    steps,
    published,
    channels,
    downgrade,
    checkCount: () => checkCount,
    storedChannel: () => storedChannel,
    storedNotes: () => storedNotes,
    progress: (percent: number) => progressListener?.(percent),
  };
};

const run = <A, E>(
  harness: ReturnType<typeof makeHarness>,
  test: Effect.Effect<A, E, DesktopUpdates | Scope.Scope>,
) =>
  Effect.runPromise(
    test.pipe(
      Effect.scoped,
      Effect.provide(harness.layer.pipe(Layer.provideMerge(TestClock.layer()))),
      Effect.provideService(References.MinimumLogLevel, "Warn"),
    ),
  );

/** Lets forked fibers and callbacks finish what the last step started. */
const settle = Effect.gen(function* () {
  for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow;
});

const found = (
  version: string,
  note = "### Features\n- Show what's new ([#7](https://github.com/acme/widgets/pull/7))",
) => Effect.succeedSome<FoundUpdate>({ version, releaseNotes: note });

describe("DesktopUpdates", () => {
  it("checks 15 seconds after launch, then every 30 minutes", async () => {
    const harness = makeHarness();
    await run(
      harness,
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates;
        expect((yield* updates.getState).status).toBe("idle");
        expect(harness.steps).toEqual(["configure"]);
        expect(harness.channels).toEqual([
          { channel: "nightly", allowPrerelease: true, allowDowngrade: false },
        ]);
        yield* TestClock.adjust("14 seconds");
        expect(harness.checkCount()).toBe(0);
        yield* TestClock.adjust("1 second");
        yield* settle;
        expect(harness.checkCount()).toBe(1);
        expect((yield* updates.getState).status).toBe("up-to-date");
        yield* TestClock.adjust("29 minutes");
        expect(harness.checkCount()).toBe(1);
        yield* TestClock.adjust("1 minute");
        yield* settle;
        expect(harness.checkCount()).toBe(2);
      }),
    );
  });

  it("stays off, with a reason, unless packaged with a feed and allowed", async () => {
    const reasons = await Promise.all(
      [{ isPackaged: false }, { updateConfig: null }, { disabledByEnv: true }].map((options) => {
        const harness = makeHarness(options);
        return run(
          harness,
          Effect.gen(function* () {
            const updates = yield* DesktopUpdates;
            yield* TestClock.adjust("1 hour");
            const checked = yield* updates.check;
            return {
              status: checked.state.status,
              accepted: checked.accepted,
              reason: checked.state.disabledReason,
              checks: harness.checkCount(),
            };
          }),
        );
      }),
    );
    expect(reasons).toEqual([
      {
        status: "disabled",
        accepted: false,
        reason: "Updates work only in the installed app.",
        checks: 0,
      },
      { status: "disabled", accepted: false, reason: "This build has no update feed.", checks: 0 },
      {
        status: "disabled",
        accepted: false,
        reason: "Updates are turned off by PRKIT_DISABLE_AUTO_UPDATE.",
        checks: 0,
      },
    ]);
  });

  it("offers a newer version on the track with its notes and the releases link", async () => {
    const harness = makeHarness({ checks: [found(NEXT_NIGHTLY)] });
    const state = await run(
      harness,
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates;
        return (yield* updates.check).state;
      }),
    );
    expect(state).toMatchObject({
      status: "available",
      availableVersion: NEXT_NIGHTLY,
      releasesUrl: "https://github.com/acme/widgets/releases",
      releaseNotes: {
        versions: [
          {
            version: NEXT_NIGHTLY,
            groups: [
              {
                title: "Features",
                items: [
                  { text: "Show what's new", prUrl: "https://github.com/acme/widgets/pull/7" },
                ],
              },
            ],
          },
        ],
      },
    });
  });

  it("ignores a version from the other track", async () => {
    const harness = makeHarness({ checks: [found("0.2.0")] });
    const state = await run(
      harness,
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates;
        return (yield* updates.check).state;
      }),
    );
    expect(state).toMatchObject({ status: "up-to-date", availableVersion: null });
  });

  it("runs one action at a time", async () => {
    const release = Deferred.makeUnsafe<void>();
    const harness = makeHarness({
      checks: [found(NEXT_NIGHTLY)],
      download: Deferred.await(release),
    });
    await run(
      harness,
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates;
        yield* updates.check;
        const downloading = yield* updates.download.pipe(Effect.forkChild);
        yield* settle;
        // The fake download waits on `release`, so the download holds the updater.
        expect((yield* updates.getState).status).toBe("downloading");
        expect((yield* updates.check).accepted).toBe(false);
        expect((yield* updates.setChannel("stable")).accepted).toBe(false);
        expect((yield* updates.download).accepted).toBe(false);
        harness.progress(40);
        yield* settle;
        expect((yield* updates.getState).downloadPercent).toBe(40);
        yield* Deferred.succeed(release, undefined);
        const done = yield* Fiber.join(downloading);
        expect(done.state.status).toBe("downloaded");
      }),
    );
    expect(harness.checkCount()).toBe(1);
    expect(harness.storedChannel()).toBeUndefined();
    expect(harness.steps.filter((step) => step === "download")).toHaveLength(1);
  });

  it("downloads, keeps the notes for after the update, and says so once on that version", async () => {
    const harness = makeHarness({ checks: [found(NEXT_NIGHTLY)] });
    const downloaded = await run(
      harness,
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates;
        yield* updates.check;
        return (yield* updates.download).state;
      }),
    );
    expect(downloaded).toMatchObject({ status: "downloaded", downloadPercent: 100 });
    expect(harness.storedNotes()).toMatchObject({ version: NEXT_NIGHTLY, shown: false });

    // The next launch, on the new version.
    const stored = harness.storedNotes();
    const relaunched = makeHarness({
      appVersion: NEXT_NIGHTLY,
      ...(stored ? { storedNotes: stored } : {}),
    });
    const [before, after] = await run(
      relaunched,
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates;
        const first = yield* updates.getState;
        const dismissed = yield* updates.dismissWhatsNew;
        return [first, dismissed.state] as const;
      }),
    );
    expect(before.whatsNew?.version).toBe(NEXT_NIGHTLY);
    expect(before.whatsNew?.releaseNotes.versions[0]?.groups[0]?.items[0]?.text).toBe(
      "Show what's new",
    );
    expect(after.whatsNew).toBeNull();
    expect(relaunched.storedNotes()?.shown).toBe(true);

    const third = makeHarness({
      appVersion: NEXT_NIGHTLY,
      ...(relaunched.storedNotes() ? { storedNotes: relaunched.storedNotes() } : {}),
    });
    const again = await run(
      third,
      DesktopUpdates.use((updates) => updates.getState),
    );
    expect(again.whatsNew).toBeNull();
  });

  it("switches track: saves it, reads the other manifest, and allows one downgrade", async () => {
    const harness = makeHarness({ checks: [found(NEXT_NIGHTLY), found("0.0.9")] });
    const state = await run(
      harness,
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates;
        yield* updates.check;
        return yield* updates.setChannel("stable");
      }),
    );
    expect(state).toMatchObject({
      accepted: true,
      state: { status: "available", channel: "stable", availableVersion: "0.0.9" },
    });
    expect(harness.storedChannel()).toBe("stable");
    expect(harness.channels.at(-1)).toEqual({
      channel: "latest",
      allowPrerelease: false,
      allowDowngrade: false,
    });
    expect(harness.downgrade).toEqual([true, false]);
    expect(harness.checkCount()).toBe(2);
  });

  it("starts on the stored track over the build's", async () => {
    const harness = makeHarness({ storedChannel: "stable" });
    const state = await run(
      harness,
      DesktopUpdates.use((updates) => updates.getState),
    );
    expect(state.channel).toBe("stable");
    expect(harness.channels).toEqual([
      { channel: "latest", allowPrerelease: false, allowDowngrade: false },
    ]);
  });

  it("installs: stops the server, then hands over to the installer", async () => {
    const harness = makeHarness({ checks: [found(NEXT_NIGHTLY)] });
    const result = await run(
      harness,
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates;
        yield* updates.check;
        yield* updates.download;
        return yield* updates.install;
      }),
    );
    expect(result.accepted).toBe(true);
    expect(harness.steps).toEqual([
      "configure",
      "check",
      "download",
      "stopServer",
      "quitAndInstall",
    ]);
  });

  it("a failed install restarts the server and shows the error", async () => {
    const harness = makeHarness({
      checks: [found(NEXT_NIGHTLY)],
      quitAndInstall: Effect.fail(
        new UpdaterFailed({ operation: "install", message: "prkit couldn't install the update." }),
      ),
    });
    const result = await run(
      harness,
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates;
        yield* updates.check;
        yield* updates.download;
        return yield* updates.install;
      }),
    );
    expect(harness.steps.slice(-3)).toEqual(["stopServer", "quitAndInstall", "restartServer"]);
    expect(result.state).toMatchObject({
      status: "downloaded",
      errorContext: "install",
      errorMessage: "prkit couldn't install the update.",
    });
  });

  it("refuses to install before a download", async () => {
    const harness = makeHarness({ checks: [found(NEXT_NIGHTLY)] });
    const result = await run(
      harness,
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates;
        yield* updates.check;
        return yield* updates.install;
      }),
    );
    expect(result.accepted).toBe(false);
    expect(harness.steps).not.toContain("stopServer");
  });

  it("a failed check shows the error, and the next check can clear it", async () => {
    const harness = makeHarness({
      checks: [
        Effect.fail(
          new UpdaterFailed({
            operation: "check",
            message: "prkit couldn't reach the update server.",
          }),
        ),
        Effect.succeedNone,
      ],
    });
    const [failed, retried] = await run(
      harness,
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates;
        const first = (yield* updates.check).state;
        const second = (yield* updates.check).state;
        return [first, second] as const;
      }),
    );
    expect(failed).toMatchObject({ status: "error", errorContext: "check" });
    expect(failed.lastCheckedAt).not.toBeNull();
    expect(retried).toMatchObject({ status: "up-to-date", errorMessage: null });
  });
});
