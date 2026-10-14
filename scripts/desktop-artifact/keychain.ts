/**
 * A keychain the signed build owns. electron-builder's own temporary keychain unlocks its keys
 * with the .p12 password instead of the keychain's, which macOS 26 rejects, so the build
 * imports the certificate itself and hands electron-builder the keychain and the identity
 * (CSC_KEYCHAIN, CSC_NAME) with no CSC_LINK. Every effect goes through `KeychainHost`, so
 * the unit tests check the commands and the cleanup without touching a real keychain.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

type Env = Readonly<Record<string, string | undefined>>;

export interface KeychainHost {
  /** Runs `/usr/bin/security` and returns its stdout. Never logs its arguments. */
  readonly security: (args: ReadonlyArray<string>) => string;
  /** Writes a file only the owner can read (0600). */
  readonly writeSecret: (path: string, data: Uint8Array) => void;
  /** Removes a file or a directory with what is in it. */
  readonly removeFile: (path: string) => void;
  readonly randomPassword: () => string;
  /** A fresh directory private to this build. */
  readonly dir: string;
}

export interface SigningIdentity {
  readonly keychain: string;
  /** The identity's SHA-1, which electron-builder matches against `find-identity` lines. */
  readonly identity: string;
}

const IDENTITY = /^\s*\d+\)\s+([0-9A-F]{40})\s+"Developer ID Application: [^"]+"/m;

/** The SHA-1 of the first valid Developer ID Application identity in `find-identity -v` output. */
export const developerIdIdentity = (findIdentityOutput: string) =>
  IDENTITY.exec(findIdentityOutput)?.[1];

/** The paths `security list-keychains` prints, one quoted path per line. */
export const parseKeychainList = (output: string) =>
  output
    .split("\n")
    .map((line) => line.trim().replace(/^"(.*)"$/, "$1"))
    .filter((line) => line !== "");

/** electron-builder's environment for the owned keychain: the identity, never the .p12. */
export const keychainBuilderEnv = (
  env: Readonly<Record<string, string>>,
  signing: SigningIdentity,
) => ({
  ...Object.fromEntries(
    Object.entries(env).filter(([name]) => name !== "CSC_LINK" && name !== "CSC_KEY_PASSWORD"),
  ),
  CSC_KEYCHAIN: signing.keychain,
  CSC_NAME: signing.identity,
});

/**
 * Imports CSC_LINK (a base64 .p12) into a new keychain, puts it first in the user's search
 * list, runs `build` with its identity, then restores the search list and deletes the
 * keychain and the .p12, whatever happened.
 */
export const withSigningKeychain = <A>(
  env: Env,
  host: KeychainHost,
  build: (signing: SigningIdentity) => A,
): A => {
  const p12 = `${host.dir}/certificate.p12`;
  const keychain = `${host.dir}/prkit-signing.keychain-db`;
  const password = host.randomPassword();
  let created = false;
  let searchList: ReadonlyArray<string> | undefined;
  try {
    const certificate = Buffer.from(env.CSC_LINK ?? "", "base64");
    if (certificate.length === 0) throw new Error("CSC_LINK must be the base64 of the .p12.");
    host.writeSecret(p12, certificate);
    host.security(["create-keychain", "-p", password, keychain]);
    created = true;
    host.security(["set-keychain-settings", "-lut", "21600", keychain]);
    host.security(["unlock-keychain", "-p", password, keychain]);
    host.security([
      "import",
      p12,
      "-k",
      keychain,
      "-P",
      env.CSC_KEY_PASSWORD ?? "",
      "-T",
      "/usr/bin/codesign",
      "-T",
      "/usr/bin/productbuild",
    ]);
    host.security([
      "set-key-partition-list",
      "-S",
      "apple-tool:,apple:",
      "-s",
      "-k",
      password,
      keychain,
    ]);
    const original = parseKeychainList(host.security(["list-keychains", "-d", "user"]));
    host.security(["list-keychains", "-d", "user", "-s", keychain, ...original]);
    searchList = original;
    const identity = developerIdIdentity(
      host.security(["find-identity", "-v", "-p", "codesigning", keychain]),
    );
    if (identity === undefined)
      throw new Error(
        "The certificate in CSC_LINK has no valid Developer ID Application identity.",
      );
    return build({ keychain, identity });
  } finally {
    // Each step runs even when one before it fails; the first failure is reported after.
    const failures: Array<string> = [];
    const attempt = (step: string, effect: () => void) => {
      try {
        effect();
      } catch {
        failures.push(step);
      }
    };
    if (searchList !== undefined) {
      const restore = searchList;
      attempt("restore the keychain search list", () =>
        host.security(["list-keychains", "-d", "user", "-s", ...restore]),
      );
    }
    if (created) attempt("delete the keychain", () => host.security(["delete-keychain", keychain]));
    attempt("remove the .p12", () => host.removeFile(p12));
    attempt("remove the signing directory", () => host.removeFile(host.dir));
    if (failures.length > 0)
      process.stderr.write(`[desktop-artifact] Cleanup could not ${failures.join(", ")}.\n`);
  }
};

/** The real host: `/usr/bin/security`, a private temp directory, and a random password. */
export const nodeKeychainHost = (): KeychainHost => ({
  dir: NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "prkit-signing-")),
  security: (args) => {
    const result = NodeChildProcess.spawnSync("/usr/bin/security", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Only the subcommand: the arguments carry passwords.
    if (result.status !== 0)
      throw new Error(
        `security ${args[0] ?? ""} failed (${result.error?.message ?? `exit ${result.status ?? result.signal}`}): ${(result.stderr ?? "").trim()}`,
      );
    return result.stdout;
  },
  writeSecret: (path, data) => NodeFS.writeFileSync(path, data, { mode: 0o600 }),
  removeFile: (path) => NodeFS.rmSync(path, { recursive: true, force: true }),
  randomPassword: () => NodeCrypto.randomBytes(32).toString("hex"),
});
