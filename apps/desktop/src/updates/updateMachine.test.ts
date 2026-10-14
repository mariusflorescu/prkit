import { describe, expect, it } from "vite-plus/test";

import { initialUpdateState, reduceUpdateState, type UpdateEvent } from "./updateMachine.ts";

const NOTES = {
  versions: [
    {
      version: "0.2.0",
      groups: [{ title: "Features", items: [{ text: "Group PRs by why they need you" }] }],
      summary: null,
      omittedItems: 0,
    },
  ],
  omittedVersions: 0,
};
const AT = "2026-10-15T09:00:00.000Z";

const start = initialUpdateState({
  currentVersion: "0.1.0",
  channel: "stable",
  releasesUrl: "https://github.com/acme/widgets/releases",
  whatsNew: null,
});

const run = (...events: ReadonlyArray<UpdateEvent>) => events.reduce(reduceUpdateState, start);

describe("reduceUpdateState", () => {
  it("starts disabled and turns idle when enabled", () => {
    expect(start.status).toBe("disabled");
    expect(run({ _tag: "Enabled", channel: "stable" }).status).toBe("idle");
    const off = run({ _tag: "Disabled", channel: "nightly", reason: "No feed." });
    expect(off).toMatchObject({
      status: "disabled",
      disabledReason: "No feed.",
      channel: "nightly",
    });
  });

  it("walks a check, a download and its progress to downloaded", () => {
    const steps: Array<UpdateEvent> = [
      { _tag: "Enabled", channel: "stable" },
      { _tag: "CheckStarted" },
      { _tag: "UpdateAvailable", version: "0.2.0", releaseNotes: NOTES, at: AT },
      { _tag: "DownloadStarted" },
      { _tag: "DownloadProgress", percent: 42.5 },
    ];
    const downloading = run(...steps);
    expect(downloading).toMatchObject({
      status: "downloading",
      availableVersion: "0.2.0",
      downloadPercent: 42.5,
      releaseNotes: NOTES,
      lastCheckedAt: AT,
    });
    const done = reduceUpdateState(downloading, { _tag: "Downloaded", version: "0.2.0" });
    expect(done).toMatchObject({ status: "downloaded", downloadPercent: 100, releaseNotes: NOTES });
  });

  it("checking shows checking, then up to date clears what an earlier check offered", () => {
    const offered = run(
      { _tag: "Enabled", channel: "stable" },
      { _tag: "UpdateAvailable", version: "0.2.0", releaseNotes: NOTES, at: AT },
    );
    expect(reduceUpdateState(offered, { _tag: "CheckStarted" }).status).toBe("checking");
    const current = reduceUpdateState(offered, { _tag: "NoUpdate", at: AT });
    expect(current).toMatchObject({
      status: "up-to-date",
      availableVersion: null,
      releaseNotes: { versions: [], omittedVersions: 0 },
    });
  });

  it("a failed check is an error with its message and time", () => {
    const failed = run(
      { _tag: "Enabled", channel: "stable" },
      { _tag: "CheckStarted" },
      { _tag: "CheckFailed", message: "prkit couldn't reach the update server.", at: AT },
    );
    expect(failed).toMatchObject({
      status: "error",
      errorContext: "check",
      errorMessage: "prkit couldn't reach the update server.",
      lastCheckedAt: AT,
    });
    expect(reduceUpdateState(failed, { _tag: "CheckStarted" })).toMatchObject({
      status: "checking",
      errorMessage: null,
    });
  });

  it("a failed download keeps the update on offer, and a failed install keeps it downloaded", () => {
    const offered = run(
      { _tag: "Enabled", channel: "stable" },
      { _tag: "UpdateAvailable", version: "0.2.0", releaseNotes: NOTES, at: AT },
      { _tag: "DownloadStarted" },
    );
    expect(
      reduceUpdateState(offered, { _tag: "DownloadFailed", message: "Offline." }),
    ).toMatchObject({ status: "available", errorContext: "download", downloadPercent: null });
    const downloaded = reduceUpdateState(offered, { _tag: "Downloaded", version: "0.2.0" });
    expect(
      reduceUpdateState(downloaded, { _tag: "InstallFailed", message: "Not signed." }),
    ).toMatchObject({ status: "downloaded", errorContext: "install", errorMessage: "Not signed." });
  });

  it("ignores progress once the download is over", () => {
    const downloaded = run(
      { _tag: "Enabled", channel: "stable" },
      { _tag: "UpdateAvailable", version: "0.2.0", releaseNotes: NOTES, at: AT },
      { _tag: "DownloadStarted" },
      { _tag: "Downloaded", version: "0.2.0" },
    );
    expect(reduceUpdateState(downloaded, { _tag: "DownloadProgress", percent: 80 })).toBe(
      downloaded,
    );
  });

  it("a track switch forgets what the other track offered", () => {
    const offered = run(
      { _tag: "Enabled", channel: "nightly" },
      { _tag: "UpdateAvailable", version: "0.2.0-nightly.20261016.1", releaseNotes: NOTES, at: AT },
    );
    expect(reduceUpdateState(offered, { _tag: "Enabled", channel: "stable" })).toMatchObject({
      status: "idle",
      channel: "stable",
      availableVersion: null,
      releaseNotes: { versions: [] },
      lastCheckedAt: AT,
    });
  });

  it("forgets the post-update notes once shown", () => {
    const shown = reduceUpdateState(
      { ...start, whatsNew: { version: "0.1.0", releaseNotes: NOTES } },
      { _tag: "WhatsNewDismissed" },
    );
    expect(shown.whatsNew).toBeNull();
  });
});
