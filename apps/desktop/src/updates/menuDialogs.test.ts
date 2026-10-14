import { describe, expect, it } from "vite-plus/test";

import { checkResultDialog } from "./menuDialogs.ts";
import { initialUpdateState, reduceUpdateState } from "./updateMachine.ts";

const NAME = "prkit Nightly";
const AT = "2026-10-15T09:00:00.000Z";
const enabled = reduceUpdateState(
  initialUpdateState({
    currentVersion: "0.1.0-nightly.20261015.1",
    channel: "nightly",
    releasesUrl: null,
    whatsNew: null,
  }),
  { _tag: "Enabled", channel: "nightly" },
);
const NOTES = { versions: [], omittedVersions: 0 };
const offered = reduceUpdateState(enabled, {
  _tag: "UpdateAvailable",
  version: "0.1.0-nightly.20261016.1",
  releaseNotes: NOTES,
  at: AT,
});

describe("checkResultDialog", () => {
  it("answers Check for Updates… with what the check found", () => {
    const current = reduceUpdateState(enabled, { _tag: "NoUpdate", at: AT });
    expect(
      checkResultDialog(NAME, { accepted: true, failure: null, state: current }),
    ).toMatchObject({
      message: "You're up to date",
      detail: "prkit Nightly 0.1.0-nightly.20261015.1 is the newest version on the Nightly track.",
    });
    expect(
      checkResultDialog(NAME, { accepted: true, failure: null, state: offered }),
    ).toMatchObject({
      message: "prkit Nightly 0.1.0-nightly.20261016.1 is available",
      buttons: ["Download", "Later"],
    });
  });

  it("says a check failed, and that an earlier offer still stands", () => {
    expect(
      checkResultDialog(NAME, { accepted: true, failure: "Offline.", state: offered }),
    ).toMatchObject({
      message: "Couldn't check for updates",
      detail: "Offline. prkit Nightly 0.1.0-nightly.20261016.1 is still ready to download.",
      buttons: ["OK"],
    });
  });

  it("never stays silent when another action holds the updater", () => {
    expect(
      checkResultDialog(NAME, { accepted: false, failure: null, state: enabled }),
    ).toMatchObject({ message: "prkit is already busy with an update", buttons: ["OK"] });
  });
});
