import { describe, expect, it } from "vite-plus/test";

import { type Json, pickDownload, repositoryOf } from "./release.ts";

const RELEASES = "https://github.com/acme/widgets/releases";
const DOWNLOAD = `${RELEASES}/download`;

const asset = (name: string): Json => ({
  name,
  browser_download_url: `${DOWNLOAD}/v0.1.0/${name}`,
});

/** GitHub's `releases/latest` answer for a stable release, with the assets the release job uploads. */
const release = (overrides: { [key: string]: Json } = {}): Json => ({
  tag_name: "v0.1.0",
  name: "prkit 0.1.0",
  draft: false,
  prerelease: false,
  html_url: `${RELEASES}/tag/v0.1.0`,
  assets: [
    asset("prkit-0.1.0-arm64.dmg"),
    asset("prkit-0.1.0-arm64.dmg.blockmap"),
    asset("prkit-0.1.0-arm64.zip"),
    asset("prkit-0.1.0-arm64.zip.blockmap"),
    asset("latest-mac.yml"),
  ],
  ...overrides,
});

describe("pickDownload", () => {
  it("offers the Apple Silicon disk image of a stable release", () => {
    expect(pickDownload(release(), RELEASES)).toEqual({
      version: "0.1.0",
      dmgUrl: `${DOWNLOAD}/v0.1.0/prkit-0.1.0-arm64.dmg`,
      notesUrl: `${RELEASES}/tag/v0.1.0`,
      releasesUrl: RELEASES,
    });
  });

  it("offers nothing from a nightly, a prerelease or a draft", () => {
    const nightly = "0.1.0-nightly.20261014.1";
    expect(
      pickDownload(
        release({
          tag_name: `v${nightly}`,
          assets: [asset(`prkit-nightly-${nightly}-arm64.dmg`), asset("nightly-mac.yml")],
        }),
        RELEASES,
      ),
    ).toBeNull();
    expect(
      pickDownload(release({ assets: [asset(`prkit-nightly-0.1.0-arm64.dmg`)] }), RELEASES),
    ).toBeNull();
    expect(pickDownload(release({ prerelease: true }), RELEASES)).toBeNull();
    expect(pickDownload(release({ draft: true }), RELEASES)).toBeNull();
  });

  it("offers nothing without an Apple Silicon disk image", () => {
    expect(pickDownload(release({ assets: [] }), RELEASES)).toBeNull();
    expect(
      pickDownload(
        release({ assets: [asset("prkit-0.1.0-arm64.zip"), asset("prkit-0.1.0-x64.dmg")] }),
        RELEASES,
      ),
    ).toBeNull();
    // A disk image of another version is not this release's.
    expect(
      pickDownload(release({ assets: [asset("prkit-0.0.9-arm64.dmg")] }), RELEASES),
    ).toBeNull();
  });

  it("offers nothing from a malformed answer", () => {
    for (const payload of [
      null,
      "Not Found",
      [],
      { message: "Not Found", status: "404" },
      release({ tag_name: 1 }),
      release({ tag_name: "0.1.0" }),
      release({ html_url: null }),
      release({ assets: "prkit-0.1.0-arm64.dmg" }),
      release({ assets: [{ name: "prkit-0.1.0-arm64.dmg" }] }),
      release({
        assets: [{ name: "prkit-0.1.0-arm64.dmg", browser_download_url: "javascript:alert(1)" }],
      }),
    ]) {
      expect(pickDownload(payload, RELEASES)).toBeNull();
    }
  });
});

describe("repositoryOf", () => {
  it("reads owner and name from a repository URL, and nothing from any other", () => {
    expect(repositoryOf("https://github.com/acme/widgets")).toBe("acme/widgets");
    expect(repositoryOf("https://github.com/acme/widgets.git/")).toBe("acme/widgets");
    expect(repositoryOf("https://github.com")).toBeNull();
    expect(repositoryOf("https://github.com/acme")).toBeNull();
    expect(repositoryOf("https://example.com/acme/widgets")).toBeNull();
    expect(repositoryOf("not a url")).toBeNull();
  });
});
