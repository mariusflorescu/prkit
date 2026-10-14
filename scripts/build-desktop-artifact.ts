/**
 * Builds the installable macOS app: prkit.app in a DMG and a zip, their blockmaps, and the
 * update manifest electron-builder writes when an update feed is configured.
 *
 *   node scripts/build-desktop-artifact.ts [--arch arm64|x64] [--build-version <semver>]
 *        [--output-dir <dir>] [--skip-build] [--signed] [--keep-stage] [--verbose]
 *
 * A version ending in `-nightly.<yyyymmdd>.<n>` builds "prkit Nightly". The version is
 * stamped into the staged package.json only. Progress goes to stderr; the last line on
 * stdout is one JSON object: {"version","channel","arch","signed","files"}.
 * docs/operations/desktop-build.md lists the environment it reads.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { buildBlockMap } from "app-builder-lib/out/targets/blockmap/blockmap.js";
import * as Schema from "effect/Schema";

import {
  type Arch,
  builderEnv,
  CHANNELS,
  createBuildConfig,
  missingSigningEnv,
  notarizeDmgArgs,
  resolveAppId,
  resolveChannel,
  resolveUpdateRepository,
  unexpectedExternals,
  updateManifestEntry,
} from "./desktop-artifact/config.ts";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const desktopDir = NodePath.join(repoRoot, "apps/desktop");
const electronBuilderBin = NodePath.join(import.meta.dirname, "node_modules/.bin/electron-builder");

const say = (message: string) => process.stderr.write(`[desktop-artifact] ${message}\n`);

class BuildFailed extends Error {}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const Version = Schema.Struct({ version: Schema.String });
const decodeVersion = Schema.decodeUnknownSync(Schema.fromJsonString(Version));
const readVersion = (file: string) => decodeVersion(NodeFS.readFileSync(file, "utf8")).version;

const parseOptions = () => {
  const { values } = NodeUtil.parseArgs({
    options: {
      arch: { type: "string", default: process.arch },
      "build-version": { type: "string" },
      "output-dir": { type: "string", default: "release" },
      "skip-build": { type: "boolean", default: false },
      signed: { type: "boolean", default: false },
      "keep-stage": { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
    },
  });
  const arch = values.arch;
  if (arch !== "arm64" && arch !== "x64")
    throw new BuildFailed(`--arch must be arm64 or x64, not ${arch}.`);
  const version = values["build-version"] ?? readVersion(NodePath.join(desktopDir, "package.json"));
  if (!SEMVER.test(version)) throw new BuildFailed(`--build-version ${version} is not a semver.`);
  return {
    arch: arch satisfies Arch,
    version,
    outputDir: NodePath.resolve(repoRoot, values["output-dir"]),
    skipBuild: values["skip-build"],
    signed: values.signed,
    keepStage: values["keep-stage"],
    verbose: values.verbose,
  };
};

/** Runs a command; its output streams to stderr with --verbose, else it shows only on failure. */
const run = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv; readonly verbose: boolean },
) => {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: options.verbose ? ["ignore", process.stderr, process.stderr] : "pipe",
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status === 0) return;
  if (!options.verbose) process.stderr.write(`${result.stdout ?? ""}${result.stderr ?? ""}`);
  throw new BuildFailed(
    `${NodePath.basename(command)} ${args.join(" ")} failed (${result.error?.message ?? `exit ${result.status ?? result.signal}`}).`,
  );
};

const checkSigning = (signed: boolean) => {
  if (!signed) return;
  const missing = missingSigningEnv(process.env);
  if (missing.length > 0)
    throw new BuildFailed(`--signed needs these environment variables: ${missing.join(", ")}.`);
  const keyPath = process.env.APPLE_API_KEY ?? "";
  if (!NodeFS.existsSync(keyPath))
    throw new BuildFailed("APPLE_API_KEY must be the path of the App Store Connect .p8 key.");
};

const checkServerBundle = () => {
  const serverDist = NodePath.join(repoRoot, "apps/server/dist");
  for (const entry of NodeFS.readdirSync(serverDist)) {
    if (!entry.endsWith(".mjs")) continue;
    const externals = unexpectedExternals(
      NodeFS.readFileSync(NodePath.join(serverDist, entry), "utf8"),
    );
    if (externals.length > 0)
      throw new BuildFailed(
        `apps/server/dist/${entry} imports ${externals.join(", ")} at run time, and the packaged app has no node_modules. Bundle it (apps/server/vite.config.ts) or add it to SERVER_EXTERNAL_ALLOWLIST and stage it.`,
      );
  }
};

const copyTree = (from: string, to: string) => {
  NodeFS.cpSync(from, to, {
    recursive: true,
    filter: (source) => !source.endsWith(".map"),
  });
};

/** A rename when the stage and the output share a volume, so a DMG never exists twice on disk. */
const moveFile = (from: string, to: string) => {
  try {
    NodeFS.renameSync(from, to);
  } catch {
    NodeFS.copyFileSync(from, to);
  }
};

const stageApp = (stageDir: string, version: string, buildConfig: object) => {
  for (const app of ["desktop/dist-electron", "server/dist", "web/dist"])
    copyTree(NodePath.join(repoRoot, "apps", app), NodePath.join(stageDir, "apps", app));
  copyTree(NodePath.join(desktopDir, "build"), NodePath.join(stageDir, "build"));

  // The Dock follows the appearance with these (apps/desktop/src/main.ts dockIcon). Nightly
  // keeps its own icon in both.
  const dockIcons = NodePath.join(stageDir, "dock-icons");
  NodeFS.mkdirSync(dockIcons);
  for (const appearance of ["light", "dark"]) {
    NodeFS.copyFileSync(
      resolveChannel(version) === "nightly"
        ? NodePath.join(desktopDir, "build/icon-nightly.png")
        : NodePath.join(
            repoRoot,
            `assets/brand/app-icon/png/prkit-icon-macos-${appearance}-1024.png`,
          ),
      NodePath.join(dockIcons, `${appearance}.png`),
    );
  }

  const packageJson = {
    name: "prkit",
    productName: CHANNELS[resolveChannel(version)].productName,
    version,
    description: "Review GitHub pull requests with a guide your own coding agent writes.",
    private: true,
    main: "apps/desktop/dist-electron/main.cjs",
    build: buildConfig,
  };
  NodeFS.writeFileSync(
    NodePath.join(stageDir, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );
};

const NotaryResult = Schema.fromJsonString(
  Schema.Struct({ id: Schema.String, status: Schema.String }),
);
const decodeNotaryResult = Schema.decodeUnknownSync(NotaryResult);

/**
 * electron-builder signs the DMG but neither notarizes nor staples it. Stapling changes the
 * file, so its blockmap is rebuilt and its hash and size in the update manifest follow.
 */
const notarizeDmgs = async (distDir: string, manifestName: string, verbose: boolean) => {
  const manifestPath = NodePath.join(distDir, manifestName);
  for (const name of NodeFS.readdirSync(distDir).filter((entry) => entry.endsWith(".dmg"))) {
    const dmg = NodePath.join(distDir, name);
    say(`Notarizing ${name}...`);
    const submitted = NodeChildProcess.spawnSync("xcrun", notarizeDmgArgs(dmg, process.env), {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    const result = submitted.status === 0 ? decodeNotaryResult(submitted.stdout) : undefined;
    if (result?.status !== "Accepted") {
      process.stderr.write(`${submitted.stdout ?? ""}${submitted.stderr ?? ""}`);
      throw new BuildFailed(
        `Notarizing ${name} ended ${result === undefined ? "with an error" : `${result.status} (submission ${result.id}; xcrun notarytool log ${result.id} explains)`}.`,
      );
    }
    run("xcrun", ["stapler", "staple", dmg], { cwd: distDir, verbose });
    const blockmap = await buildBlockMap(dmg, "gzip", `${dmg}.blockmap`);
    if (!NodeFS.existsSync(manifestPath)) continue;
    const updated = updateManifestEntry(NodeFS.readFileSync(manifestPath, "utf8"), name, {
      sha512: blockmap.sha512,
      size: NodeFS.statSync(dmg).size,
    });
    if (updated === undefined) throw new BuildFailed(`${manifestName} does not list ${name}.`);
    NodeFS.writeFileSync(manifestPath, updated);
  }
};

/** Where the release workflow finds the app: `<output>/mac-<arch>/<product>.app`. */
const moveAppDir = (distDir: string, outputDir: string) => {
  for (const entry of NodeFS.readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("mac")) continue;
    const to = NodePath.join(outputDir, entry.name);
    NodeFS.rmSync(to, { recursive: true, force: true });
    NodeFS.renameSync(NodePath.join(distDir, entry.name), to);
    return to;
  }
  throw new BuildFailed(`electron-builder left no app folder in ${distDir}.`);
};

const main = async () => {
  const options = parseOptions();
  const channel = resolveChannel(options.version);
  checkSigning(options.signed);

  const repository = resolveUpdateRepository(process.env);
  if (repository._tag === "Invalid")
    throw new BuildFailed(`${repository.name} must look like owner/repo.`);
  if (repository._tag === "None")
    say(
      "No update feed: set PRKIT_DESKTOP_UPDATE_REPOSITORY (or GITHUB_REPOSITORY) to owner/repo for app-update.yml and the update manifest.",
    );

  if (!options.skipBuild) {
    say("Building the server, web and desktop bundles...");
    run("pnpm", ["exec", "vp", "run", "--filter", "@prkit/desktop", "build"], {
      cwd: repoRoot,
      verbose: options.verbose,
    });
  }
  for (const required of [
    "apps/desktop/dist-electron/main.cjs",
    "apps/desktop/dist-electron/preload.cjs",
    "apps/server/dist/bin.mjs",
    "apps/web/dist/index.html",
  ]) {
    if (!NodeFS.existsSync(NodePath.join(repoRoot, required)))
      throw new BuildFailed(`${required} is missing; run without --skip-build.`);
  }
  checkServerBundle();

  const buildConfig = createBuildConfig({
    version: options.version,
    signed: options.signed,
    appId: resolveAppId(process.env),
    electronVersion: readVersion(NodePath.join(desktopDir, "node_modules/electron/package.json")),
    repository: repository._tag === "Repository" ? repository : undefined,
  });

  const stageDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "prkit-desktop-stage-"));
  try {
    stageApp(stageDir, options.version, buildConfig);
    say(
      `Packaging ${CHANNELS[channel].productName} ${options.version} for ${options.arch} (${options.signed ? "signed" : "unsigned"})...`,
    );
    run(
      electronBuilderBin,
      ["--projectDir", stageDir, "--mac", `--${options.arch}`, "--publish", "never"],
      {
        cwd: stageDir,
        env: {
          ...builderEnv(process.env, options.signed),
          ...(options.verbose
            ? { DEBUG: "electron-builder,electron-osx-sign*,electron-notarize*" }
            : {}),
        },
        verbose: options.verbose,
      },
    );

    const distDir = NodePath.join(stageDir, "dist");
    if (options.signed)
      await notarizeDmgs(distDir, CHANNELS[channel].updateManifest, options.verbose);
    NodeFS.mkdirSync(options.outputDir, { recursive: true });
    const appDir = moveAppDir(distDir, options.outputDir);
    const files = NodeFS.readdirSync(distDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith("builder-"))
      .map((entry) => {
        const to = NodePath.join(options.outputDir, entry.name);
        moveFile(NodePath.join(distDir, entry.name), to);
        return to;
      })
      .sort();
    const extensions = [".dmg", ".zip", ".dmg.blockmap", ".zip.blockmap"];
    const missing = extensions.filter((ext) => !files.some((file) => file.endsWith(ext)));
    if (
      repository._tag === "Repository" &&
      !files.some((file) => file.endsWith(CHANNELS[channel].updateManifest))
    )
      missing.push(CHANNELS[channel].updateManifest);
    if (missing.length > 0)
      throw new BuildFailed(`electron-builder produced no ${missing.join(", ")} in ${distDir}.`);

    for (const file of [...files, appDir]) say(`  ${NodePath.relative(repoRoot, file)}`);
    if (options.keepStage) say(`Stage kept at ${stageDir}`);
    process.stdout.write(
      `${JSON.stringify({ version: options.version, channel, arch: options.arch, signed: options.signed, files })}\n`,
    );
  } finally {
    if (!options.keepStage) NodeFS.rmSync(stageDir, { recursive: true, force: true });
  }
};

try {
  await main();
} catch (error) {
  say(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
