import { describe, expect, it } from "vite-plus/test";

import {
  builderEnv,
  CHANNELS,
  createBuildConfig,
  externalPackages,
  missingSigningEnv,
  resolveAppId,
  resolveChannel,
  resolveUpdateRepository,
  SIGNING_ENV,
  UNSIGNED_APP_ID,
  unexpectedExternals,
} from "./config.ts";

const REPOSITORY = { _tag: "Repository", owner: "octocat", repo: "prkit" } as const;
const config = (version: string, repository: typeof REPOSITORY | null = REPOSITORY) =>
  createBuildConfig({
    version,
    signed: false,
    appId: UNSIGNED_APP_ID,
    electronVersion: "44.4.5",
    repository: repository ?? undefined,
  });

describe("channels", () => {
  it("builds nightly only for a dated nightly version", () => {
    expect(resolveChannel("0.1.0-nightly.20261014.1")).toBe("nightly");
    expect(resolveChannel("0.1.0")).toBe("stable");
    expect(resolveChannel("0.1.0-beta.1")).toBe("stable");
    expect(resolveChannel("0.1.0-nightly.2026101.1")).toBe("stable");
  });

  it("names, icons and the update manifest follow the channel", () => {
    const stable = config("0.1.0");
    expect(stable.productName).toBe("prkit");
    expect(stable.artifactName).toBe("prkit-${version}-${arch}.${ext}");
    expect(stable.mac?.icon).toBe("build/icon.icns");
    expect(stable.dmg?.title).toBe("prkit ${version}");
    expect(CHANNELS.stable.updateManifest).toBe("latest-mac.yml");

    const nightly = config("0.1.0-nightly.20261014.1");
    expect(nightly.productName).toBe("prkit Nightly");
    expect(nightly.artifactName).toBe("prkit-nightly-${version}-${arch}.${ext}");
    expect(nightly.mac?.icon).toBe("build/icon-nightly.icns");
    expect(nightly.dmg?.title).toBe("prkit Nightly ${version}");
    expect(CHANNELS.nightly.updateManifest).toBe("nightly-mac.yml");

    // One bundle id for both, so they share a data folder like any update would.
    expect(nightly.appId).toBe(stable.appId);
  });
});

describe("update feed", () => {
  it("publishes stable releases and nightly prereleases on their own channel", () => {
    expect(config("0.1.0").publish).toEqual([
      { provider: "github", owner: "octocat", repo: "prkit", releaseType: "release" },
    ]);
    expect(config("0.1.0-nightly.20261014.1").publish).toEqual([
      {
        provider: "github",
        owner: "octocat",
        repo: "prkit",
        releaseType: "prerelease",
        channel: "nightly",
      },
    ]);
  });

  it("has no publish block without a repository", () => {
    expect(config("0.1.0", null).publish).toBeNull();
  });

  it("reads the override first, then GITHUB_REPOSITORY, and rejects anything but owner/repo", () => {
    expect(
      resolveUpdateRepository({
        PRKIT_DESKTOP_UPDATE_REPOSITORY: "octocat/prkit",
        GITHUB_REPOSITORY: "acme/widgets",
      }),
    ).toEqual(REPOSITORY);
    expect(resolveUpdateRepository({ GITHUB_REPOSITORY: "acme/widgets" })).toEqual({
      _tag: "Repository",
      owner: "acme",
      repo: "widgets",
    });
    expect(resolveUpdateRepository({ PRKIT_DESKTOP_UPDATE_REPOSITORY: "  " })).toEqual({
      _tag: "None",
    });
    expect(resolveUpdateRepository({})).toEqual({ _tag: "None" });
    expect(
      resolveUpdateRepository({ PRKIT_DESKTOP_UPDATE_REPOSITORY: "https://github.com/a/b" }),
    ).toEqual({ _tag: "Invalid", name: "PRKIT_DESKTOP_UPDATE_REPOSITORY" });
  });
});

describe("signing", () => {
  it("lists every missing name, empty ones included", () => {
    expect(missingSigningEnv({})).toEqual([...SIGNING_ENV]);
    expect(missingSigningEnv({ CSC_LINK: "", APPLE_TEAM_ID: "TEAM" })).toEqual(
      SIGNING_ENV.filter((name) => name !== "APPLE_TEAM_ID"),
    );
    const complete = Object.fromEntries(SIGNING_ENV.map((name) => [name, "set"]));
    expect(missingSigningEnv(complete)).toEqual([]);
  });

  it("falls back to the local bundle id only when none is given", () => {
    expect(resolveAppId({})).toBe(UNSIGNED_APP_ID);
    expect(resolveAppId({ PRKIT_DESKTOP_APP_ID: "com.example.prkit" })).toBe("com.example.prkit");
  });

  it("signs with the hardened runtime and the static entitlements, or not at all", () => {
    const unsigned = config("0.1.0");
    expect(unsigned.mac?.identity).toBeNull();
    expect(unsigned.mac?.hardenedRuntime).toBe(true);
    expect(unsigned.mac?.entitlements).toBe("build/entitlements.mac.plist");
    const signed = createBuildConfig({
      version: "0.1.0",
      signed: true,
      appId: "com.example.prkit",
      electronVersion: "44.4.5",
      repository: undefined,
    });
    expect(signed.mac).not.toHaveProperty("identity");
    expect(signed.appId).toBe("com.example.prkit");
  });
});

describe("builder environment", () => {
  const host = {
    PATH: "/usr/bin",
    HOME: "/home/octocat",
    CSC_LINK: "/keys/cert.p12",
    CSC_KEY_PASSWORD: "",
    APPLE_API_KEY: "/keys/key.p8",
    APPLE_API_ISSUER: "",
    GH_TOKEN: "gho_example",
    GITHUB_TOKEN: "ghs_example",
    EMPTY: "",
  };

  it("unsigned, drops every signing variable and turns identity discovery off", () => {
    expect(builderEnv(host, false)).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/octocat",
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
    });
  });

  it("signed, keeps the set signing variables and drops the empty ones", () => {
    expect(builderEnv(host, true)).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/octocat",
      CSC_LINK: "/keys/cert.p12",
      APPLE_API_KEY: "/keys/key.p8",
    });
  });
});

describe("server bundle", () => {
  it("packages no Claude Agent SDK platform binary and no source maps", () => {
    const files = config("0.1.0").files;
    expect(files).toContain("!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**");
    expect(files).toContain("!**/*.map");
  });

  it("finds the packages a bundle still loads at run time", () => {
    const source = [
      'import { createRequire } from "node:module";',
      'import * as fs from "fs";',
      'import { query } from "@anthropic-ai/claude-agent-sdk";',
      'import "./chunk.mjs";',
      'const yaml = await import("yaml");',
      'const native = __require("@anthropic-ai/claude-agent-sdk-darwin-arm64/claude");',
      'try { __require("bufferutil"); } catch {}',
      // Code that only builds a string is not a load.
      'code: _`require("ajv/dist/runtime/validation_error").default`',
    ].join("\n");
    expect(externalPackages(source)).toEqual([
      "@anthropic-ai/claude-agent-sdk",
      "@anthropic-ai/claude-agent-sdk-darwin-arm64",
      "bufferutil",
      "yaml",
    ]);
    expect(unexpectedExternals(source)).toEqual([
      "@anthropic-ai/claude-agent-sdk",
      "@anthropic-ai/claude-agent-sdk-darwin-arm64",
      "yaml",
    ]);
  });
});
