import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { realPaths } from "../commandReach.ts";

/**
 * The boundary around Cursor's runner. Cursor's backend picks the tools a turn runs, the SDK runs
 * them locally, and prkit only tells the backend which ones it may pick: some never report that
 * they ran. So the runner itself runs in macOS's sandbox (`sandbox-exec`) with a profile prkit
 * writes for each run: nothing is open but what the runner needs, whatever runs inside it.
 */
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** What one runner may reach. Every path is resolved before it goes in the profile. */
export interface RunnerReach {
  /** Read, and load code from: the runtime running the runner, the runner, Cursor's SDK. */
  readonly code: ReadonlyArray<string>;
  /** Read only: a guide's checkout, a turn's diffs. */
  readonly reads: ReadonlyArray<string>;
  /** Read and written: the instance's home, the turn's temp folder, a fix's checkout. */
  readonly writes: ReadonlyArray<string>;
  /** Folders whose `.git` and `.cursor` entries stay closed to writes: a fix's checkout. */
  readonly guarded: ReadonlyArray<string>;
  /**
   * The instance's home, when its `.cursor` (the saved key) stays closed to writes: every run but
   * a sign-in or sign-out. Only `.cursor/projects`, where Cursor writes its transcripts, opens.
   */
  readonly sealedHome: string | null;
  /** prkit's MCP server's port, the one local address a turn may reach; null for none. */
  readonly mcpPort: number | null;
}

/**
 * What the runner reads besides its own folders. `/private/etc` holds the resolver and TLS
 * settings; the rest of the system's own folders come with `system.sb`.
 */
const SYSTEM_READS = [
  "/private/etc",
  "/Library/Preferences/com.apple.networkd.plist",
  "/private/var/db/timezone",
  // Homebrew's OpenSSL settings and CA bundle, which its node reads at start and for TLS.
  ...["/opt/homebrew", "/usr/local"].flatMap((prefix) => [
    `${prefix}/etc/openssl@3`,
    `${prefix}/etc/ca-certificates`,
  ]),
];

/**
 * Where Homebrew keeps installed programs' libraries, which its node links (libuv, OpenSSL,
 * ICU); without them dyld stops it before it starts. Its `etc` and `var` stay closed, but for
 * OpenSSL's settings (SYSTEM_READS).
 */
const HOMEBREW_CODE = ["/opt/homebrew", "/usr/local"].flatMap((prefix) =>
  ["opt", "Cellar", "lib"].map((folder) => `${prefix}/${folder}`),
);

const quoted = (text: string) => `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/** A regular expression matching `text` itself. */
const literalPattern = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A regular expression as the profile writes it: `#"..."` takes backslashes as they are, so only
 * a quote can't be written, and becomes any character, which only widens what it matches.
 */
const regexLiteral = (pattern: string) => `#"${pattern.replaceAll('"', ".")}"`;

/**
 * A name as APFS may spell it: any ASCII case, and the long s (ſ) for s. Writes through either
 * spelling land in the same folder.
 */
const anySpelling = (name: string) =>
  [...name]
    .map((char) => {
      if (char === ".") return "\\.";
      const lower = char.toLowerCase();
      const upper = char.toUpperCase();
      return lower === "s" ? "(s|S|ſ)" : lower === upper ? char : `(${lower}|${upper})`;
    })
    .join("");

const ancestorsOf = (path: Path.Path, target: string) => {
  const found: Array<string> = [];
  for (let dir = path.dirname(target); dir !== path.dirname(dir); dir = path.dirname(dir))
    found.push(dir);
  return [...found, path.parse(target).root];
};

/** The profile for one runner: closed by default, with `reach` and what the runtime needs. */
export const runnerProfile = (path: Path.Path, reach: RunnerReach) => {
  const all = [...reach.code, ...reach.reads, ...reach.writes];
  // Resolving a path stats each folder above it, so those answer stat, never a listing.
  const above = [...new Set(all.flatMap((target) => ancestorsOf(path, target)))];
  const subpaths = (targets: ReadonlyArray<string>) =>
    targets.map((target) => `(subpath ${quoted(target)})`).join(" ");
  const rules = [
    "(version 1)",
    "(deny default)",
    '(import "system.sb")',
    "(allow process-fork)",
    "(allow process-exec)",
    "(allow signal (target same-sandbox))",
    "(allow sysctl-read)",
    // Cursor's backend, anywhere but this machine, and the resolver's socket; no other local
    // socket (Docker's, an SSH agent's) and no local port but prkit's MCP server's.
    '(allow network-outbound (remote ip "*:*") (literal "/private/var/run/mDNSResponder"))',
    '(deny network-outbound (remote ip "localhost:*"))',
    ...(reach.mcpPort === null
      ? []
      : [`(allow network-outbound (remote ip "localhost:${reach.mcpPort}"))`]),
    "(allow system-socket)",
    '(allow mach-lookup (global-name "com.apple.SystemConfiguration.DNSConfiguration"))',
    `(allow file-read-metadata file-test-existence ${above.map((dir) => `(literal ${quoted(dir)})`).join(" ")})`,
    `(allow file-read* file-test-existence ${subpaths(SYSTEM_READS)})`,
    `(allow file-read* file-test-existence file-map-executable ${subpaths(reach.code)})`,
  ];
  if (reach.reads.length > 0)
    rules.push(`(allow file-read* file-test-existence ${subpaths(reach.reads)})`);
  if (reach.writes.length > 0)
    rules.push(`(allow file-read* file-write* file-test-existence ${subpaths(reach.writes)})`);
  const closed = (folder: string, name: string) =>
    `(deny file-write* (regex ${regexLiteral(`^${literalPattern(folder)}/${anySpelling(name)}(/|$)`)}))`;
  for (const folder of reach.guarded)
    for (const name of [".git", ".cursor"]) rules.push(closed(folder, name));
  if (reach.sealedHome !== null)
    rules.push(
      closed(reach.sealedHome, ".cursor"),
      `(allow file-write* (subpath ${quoted(path.join(reach.sealedHome, ".cursor", "projects"))}))`,
    );
  return `${rules.join("\n")}\n`;
};

/**
 * What the runner's runtime loads: the app bundle's `Contents` for Electron's binary
 * (`Contents/MacOS/prkit`), else node's binary alone, which is all an official build needs. A
 * prefix would open too much: `/usr/local` for nodejs.org's installer, the home for `~/bin/node`.
 * Homebrew's node also loads its libraries, from HOMEBREW_CODE.
 */
export const runtimeOf = (path: Path.Path, executable: string) => {
  const macos = path.dirname(executable);
  const contents = path.dirname(macos);
  return path.basename(macos) === "MacOS" &&
    path.basename(contents) === "Contents" &&
    path.extname(path.dirname(contents)) === ".app"
    ? [contents, ...HOMEBREW_CODE]
    : [executable, ...HOMEBREW_CODE];
};

/**
 * The SDK's packages: the `node_modules` folder above its own package, where prkit installs its
 * dependencies next to it (pnpm's store too, for the dev dependency), else the package itself.
 */
const sdkRootOf = (path: Path.Path, packageDir: string) => {
  const parts = packageDir.split(path.sep);
  const at = parts.indexOf("node_modules");
  return at === -1 ? packageDir : parts.slice(0, at + 1).join(path.sep);
};

/**
 * The code a runner loads. The built runner is one file next to its chunks; the source, in
 * development and tests, loads prkit's own packages and dependencies from the repository.
 */
const runnerCode = (path: Path.Path, script: string) => {
  const dir = path.dirname(script);
  if (path.extname(script) !== ".ts") return [dir];
  const root = path.resolve(dir, "..", "..", "..", "..", "..");
  return [
    path.join(root, "apps", "server"),
    path.join(root, "packages"),
    path.join(root, "node_modules"),
    path.join(root, "package.json"),
  ];
};

/** What the runner on `script`, hosting the SDK at `sdk`, may reach for a check or a turn. */
export const runnerReach = (input: {
  readonly script: string;
  readonly sdk: string;
  readonly home: string;
  /** More to read: the checkout a session check names, the instance's extra CA file. */
  readonly reads: ReadonlyArray<string>;
  /** A sign-in or sign-out, the only runs that write the saved key. */
  readonly signs: boolean;
  readonly turn: {
    readonly cwd: string;
    readonly readableDirs: ReadonlyArray<string>;
    readonly tmpDir: string;
    readonly writes: boolean;
    readonly mcpPort: number;
  } | null;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const [executable = process.execPath] = yield* realPaths(fs, [process.execPath]);
    const code = yield* realPaths(fs, [
      ...runtimeOf(path, executable),
      ...runnerCode(path, input.script),
      sdkRootOf(path, input.sdk),
    ]);
    const home = yield* realPaths(fs, [input.home]);
    const extra = yield* realPaths(fs, input.reads);
    const sealedHome = input.signs ? null : (home[0] ?? null);
    if (input.turn === null)
      return { code, reads: extra, writes: home, guarded: [], sealedHome, mcpPort: null };
    const [cwd] = yield* realPaths(fs, [input.turn.cwd]);
    const dirs = yield* realPaths(fs, input.turn.readableDirs);
    const tmp = yield* realPaths(fs, [input.turn.tmpDir]);
    const checkout = cwd === undefined ? [] : [cwd];
    const mcpPort = input.turn.mcpPort;
    return input.turn.writes
      ? {
          code,
          reads: [...dirs, ...extra],
          writes: [...home, ...tmp, ...checkout],
          guarded: checkout,
          sealedHome,
          mcpPort,
        }
      : {
          code,
          reads: [...checkout, ...dirs, ...extra],
          writes: [...home, ...tmp],
          guarded: [],
          sealedHome,
          mcpPort,
        };
  });
