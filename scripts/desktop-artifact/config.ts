/**
 * The pure half of scripts/build-desktop-artifact.ts: channel naming, the electron-builder
 * config, the signing and update-feed environment, and the server bundle's external check.
 * Nothing here reads the disk or the process, so the unit tests call it directly.
 */
import * as NodeModule from "node:module";

import type { Configuration } from "electron-builder";

export type Channel = "stable" | "nightly";
export type Arch = "arm64" | "x64";
type Env = Readonly<Record<string, string | undefined>>;

const NIGHTLY_VERSION = /-nightly\.\d{8}\.\d+$/;

export const resolveChannel = (version: string): Channel =>
  NIGHTLY_VERSION.test(version) ? "nightly" : "stable";

/** Names and files per channel. Paths are relative to the stage directory. */
export const CHANNELS = {
  stable: {
    productName: "prkit",
    artifactPrefix: "prkit",
    icon: "build/icon.icns",
    updateManifest: "latest-mac.yml",
  },
  nightly: {
    productName: "prkit Nightly",
    artifactPrefix: "prkit-nightly",
    icon: "build/icon-nightly.icns",
    updateManifest: "nightly-mac.yml",
  },
} as const;

/** Unsigned builds only; a signed build names its bundle id in PRKIT_DESKTOP_APP_ID. */
export const UNSIGNED_APP_ID = "dev.prkit.local";

/** Everything `--signed` needs. electron-builder notarizes on its own once the APPLE_API_* are set. */
export const SIGNING_ENV = [
  "PRKIT_DESKTOP_APP_ID",
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "APPLE_TEAM_ID",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
] as const;

const isSet = (value: string | undefined) => value !== undefined && value.trim() !== "";

export const missingSigningEnv = (env: Env) => SIGNING_ENV.filter((name) => !isSet(env[name]));

export const resolveAppId = (env: Env) => env.PRKIT_DESKTOP_APP_ID?.trim() || UNSIGNED_APP_ID;

export type UpdateRepository =
  | { readonly _tag: "None" }
  | { readonly _tag: "Invalid"; readonly name: string }
  | { readonly _tag: "Repository"; readonly owner: string; readonly repo: string };

const REPOSITORY = /^([\w.-]+)\/([\w.-]+)$/;

/** PRKIT_DESKTOP_UPDATE_REPOSITORY, else GITHUB_REPOSITORY (set in GitHub Actions). */
export const resolveUpdateRepository = (env: Env): UpdateRepository => {
  const [name, value] = isSet(env.PRKIT_DESKTOP_UPDATE_REPOSITORY)
    ? ["PRKIT_DESKTOP_UPDATE_REPOSITORY", env.PRKIT_DESKTOP_UPDATE_REPOSITORY]
    : ["GITHUB_REPOSITORY", env.GITHUB_REPOSITORY];
  if (value === undefined || !isSet(value)) return { _tag: "None" };
  const match = REPOSITORY.exec(value.trim());
  if (match === null) return { _tag: "Invalid", name };
  const [, owner = "", repo = ""] = match;
  return { _tag: "Repository", owner, repo };
};

/** The feed electron-builder records in app-update.yml and names the update manifest after. */
export const publishConfig = (channel: Channel, owner: string, repo: string) => ({
  provider: "github" as const,
  owner,
  repo,
  releaseType: channel === "stable" ? ("release" as const) : ("prerelease" as const),
  ...(channel === "nightly" ? { channel: "nightly" } : {}),
});

const SIGNING_PREFIXES = ["CSC_", "APPLE_"];

/**
 * The environment electron-builder runs with. It treats a set-but-empty CSC_LINK as set, so
 * empty values go. Unsigned, every signing variable goes too and identity discovery is off,
 * so nothing tries to sign. GitHub tokens never reach it: it publishes nothing.
 */
export const builderEnv = (env: Env, signed: boolean) => {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value === "") continue;
    if (name === "GH_TOKEN" || name === "GITHUB_TOKEN") continue;
    if (!signed && SIGNING_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    result[name] = value;
  }
  if (!signed) result.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  return result;
};

/**
 * What the app files leave out: source maps, and the Claude Agent SDK's platform packages
 * (a native claude binary per platform). prkit always runs the user's own claude.
 */
export const FILE_EXCLUSIONS = [
  "!**/*.map",
  "!**/node_modules/@anthropic-ai/claude-agent-sdk-*",
  "!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**",
] as const;

export interface BuildConfigOptions {
  readonly version: string;
  readonly signed: boolean;
  readonly appId: string;
  readonly electronVersion: string;
  readonly repository: Extract<UpdateRepository, { _tag: "Repository" }> | undefined;
}

export const createBuildConfig = (options: BuildConfigOptions): Configuration => {
  const channel = resolveChannel(options.version);
  const names = CHANNELS[channel];
  return {
    appId: options.appId,
    productName: names.productName,
    artifactName: `${names.artifactPrefix}-\${version}-\${arch}.\${ext}`,
    electronVersion: options.electronVersion,
    electronLanguages: ["en-US"],
    directories: { buildResources: "build", output: "dist" },
    files: ["package.json", "apps/**/*", "dock-icons/*", ...FILE_EXCLUSIONS],
    asar: true,
    // The server serves the UI from disk; Electron's fs can't check paths inside app.asar.
    asarUnpack: ["apps/web/dist/**"],
    // The stage has no node_modules: the server and the shell are single bundles.
    npmRebuild: false,
    nodeGypRebuild: false,
    publish:
      options.repository === undefined
        ? null
        : [publishConfig(channel, options.repository.owner, options.repository.repo)],
    mac: {
      target: ["dmg", "zip"],
      category: "public.app-category.developer-tools",
      icon: names.icon,
      hardenedRuntime: true,
      entitlements: "build/entitlements.mac.plist",
      entitlementsInherit: "build/entitlements.mac.plist",
      // electron-builder notarizes and staples the app itself once the APPLE_API_* are set.
      notarize: options.signed,
      ...(options.signed ? {} : { identity: null }),
    },
    dmg: {
      // Signed here; the build then notarizes and staples it (notarizeDmgArgs).
      sign: options.signed,
      title: `${names.productName} \${version}`,
      window: { width: 640, height: 432 },
      iconSize: 120,
      iconTextSize: 12,
      contents: [
        { x: 166, y: 214, type: "file" },
        { x: 474, y: 214, type: "link", path: "/Applications" },
      ],
    },
  };
};

/**
 * Packages the server bundle may leave for node_modules. Empty: the packaged app ships no
 * node_modules, so anything listed here would also need staging.
 */
export const SERVER_EXTERNAL_ALLOWLIST: ReadonlyArray<string> = [];

/**
 * Optional native speedups `ws` loads inside a try block and does without when absent.
 * They are never installed, so the bundle may name them.
 */
export const SERVER_OPTIONAL_EXTERNALS: ReadonlyArray<string> = ["bufferutil", "utf-8-validate"];

const SPECIFIERS = [
  /^import\s[^;]*?\sfrom\s*"([^"]+)"/gm,
  /^import\s*"([^"]+)"/gm,
  /\bimport\(\s*"([^"]+)"\s*\)/g,
  /\b__require\(\s*"([^"]+)"\s*\)/g,
];

const packageName = (specifier: string) => {
  const [first = "", second = ""] = specifier.split("/");
  return first.startsWith("@") ? `${first}/${second}` : first;
};

/** The packages a built bundle still imports at run time, Node's builtins aside. */
export const externalPackages = (source: string) => {
  const found = new Set<string>();
  for (const pattern of SPECIFIERS) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier === undefined || specifier.startsWith(".") || specifier.startsWith("/"))
        continue;
      if (NodeModule.isBuiltin(specifier)) continue;
      found.add(packageName(specifier));
    }
  }
  return [...found].sort();
};

/** Externals that would fail at run time in the packaged app. */
export const unexpectedExternals = (source: string) =>
  externalPackages(source).filter(
    (name) =>
      !SERVER_EXTERNAL_ALLOWLIST.includes(name) && !SERVER_OPTIONAL_EXTERNALS.includes(name),
  );

/** `xcrun` arguments that notarize a signed DMG with the App Store Connect key and wait for the verdict. */
export const notarizeDmgArgs = (dmg: string, env: Env) => [
  "notarytool",
  "submit",
  dmg,
  "--key",
  env.APPLE_API_KEY ?? "",
  "--key-id",
  env.APPLE_API_KEY_ID ?? "",
  "--issuer",
  env.APPLE_API_ISSUER ?? "",
  "--wait",
  "--output-format",
  "json",
];

/**
 * Stapling changes the DMG after electron-builder hashed it, so its entry in the update
 * manifest gets the new hash and size. Undefined when the manifest doesn't list the file.
 */
export const updateManifestEntry = (
  manifest: string,
  fileName: string,
  file: { readonly sha512: string; readonly size: number },
) => {
  const lines = manifest.split("\n");
  const start = lines.findIndex((line) => line.trim() === `- url: ${fileName}`);
  if (start === -1) return undefined;
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line.trim().startsWith("- ") || !line.startsWith(" ")) break;
    const indent = line.slice(0, line.length - line.trimStart().length);
    if (line.trim().startsWith("sha512:")) lines[index] = `${indent}sha512: ${file.sha512}`;
    if (line.trim().startsWith("size:")) lines[index] = `${indent}size: ${file.size}`;
  }
  return lines.join("\n");
};
