import { describe, expect, it } from "vite-plus/test";

import { describeUpdaterError } from "./updaterErrors.ts";

describe("describeUpdaterError", () => {
  it("explains a signature Squirrel refused without naming the cached file", () => {
    const message = describeUpdaterError("install", {
      message:
        "Code signature at URL file:///Users/octocat/Library/Caches/app.ShipIt/update.x/prkit.app/ did not pass validation: code has no resources but signature indicates they must be present",
    });
    expect(message).toBe(
      "macOS couldn't verify the downloaded update, so prkit didn't install it. Download the newest version from the releases page instead.",
    );
  });

  it("keeps only the first line, with URLs and paths dropped", () => {
    const message = describeUpdaterError("download", {
      message:
        "Cannot write /Users/octocat/Library/Caches/prkit-updater/pending/update.zip from https://example.test/a.zip\nHeaders: secret",
    });
    expect(message).toBe("prkit couldn't download the update. Cannot write … from …");
  });

  it("says when the track has no release, and when the server can't be reached", () => {
    expect(describeUpdaterError("check", { code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" })).toBe(
      "There's no release on this track yet.",
    );
    expect(describeUpdaterError("check", { message: "connect ECONNREFUSED 127.0.0.1:7357" })).toBe(
      "prkit couldn't reach the update server to check for updates. Check your connection and try again.",
    );
  });

  it("cuts a long first line at a word", () => {
    const message = describeUpdaterError("check", { message: "word ".repeat(60) });
    expect(message.endsWith("word…")).toBe(true);
    expect(message.length).toBeLessThan(200);
  });
});
