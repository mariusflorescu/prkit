import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import {
  developerIdIdentity,
  type KeychainHost,
  keychainBuilderEnv,
  withSigningKeychain,
} from "./keychain.ts";

const SHA = "0123456789ABCDEF0123456789ABCDEF01234567";
const FIND_IDENTITY = [
  `  1) ${"F".repeat(40)} "Apple Development: Octo Cat (AAAAAAAAAA)"`,
  `  2) ${SHA} "Developer ID Application: Octo Cat (TEAMID1234)"`,
  "     2 valid identities found",
].join("\n");
// Made per run: the tests only need two different passwords to tell apart.
const P12_PASSWORD = NodeCrypto.randomUUID();
const KEYCHAIN_PASSWORD = NodeCrypto.randomUUID();
const ENV = {
  CSC_LINK: Buffer.from("p12 bytes").toString("base64"),
  CSC_KEY_PASSWORD: P12_PASSWORD,
};
const KEYCHAIN = "/tmp/sign/prkit-signing.keychain-db";

/** Records every effect in order; `failOn` makes one security subcommand fail. */
const fakeHost = (failOn?: string) => {
  const calls: Array<string> = [];
  const secrets = new Map<string, string>();
  const host: KeychainHost = {
    dir: "/tmp/sign",
    randomPassword: () => KEYCHAIN_PASSWORD,
    writeSecret: (path, data) => {
      calls.push(`write ${path}`);
      secrets.set(path, Buffer.from(data).toString());
    },
    removeFile: (path) => {
      calls.push(`remove ${path}`);
    },
    security: (args) => {
      calls.push(`security ${args.join(" ")}`);
      if (args[0] === failOn) throw new Error(`security ${failOn} failed`);
      if (args[0] === "list-keychains" && args.length === 3)
        return '    "/Users/octocat/Library/Keychains/login.keychain-db"\n    "/Library/Keychains/System.keychain"\n';
      if (args[0] === "find-identity") return FIND_IDENTITY;
      return "";
    },
  };
  return { calls, secrets, host };
};

describe("signing keychain", () => {
  it("imports the .p12 into its own keychain, unlocks the keys with that keychain's password, and signs with its identity", () => {
    const { calls, secrets, host } = fakeHost();
    const seen = withSigningKeychain(ENV, host, (signing) => {
      calls.push("build");
      return signing;
    });
    expect(seen).toEqual({ keychain: KEYCHAIN, identity: SHA });
    expect(secrets.get("/tmp/sign/certificate.p12")).toBe("p12 bytes");
    expect(calls).toEqual([
      "write /tmp/sign/certificate.p12",
      `security create-keychain -p ${KEYCHAIN_PASSWORD} ${KEYCHAIN}`,
      `security set-keychain-settings -lut 21600 ${KEYCHAIN}`,
      `security unlock-keychain -p ${KEYCHAIN_PASSWORD} ${KEYCHAIN}`,
      `security import /tmp/sign/certificate.p12 -k ${KEYCHAIN} -P ${P12_PASSWORD} -T /usr/bin/codesign -T /usr/bin/productbuild`,
      // The keychain's password, not the .p12's: what macOS 26 insists on.
      `security set-key-partition-list -S apple-tool:,apple: -s -k ${KEYCHAIN_PASSWORD} ${KEYCHAIN}`,
      "security list-keychains -d user",
      `security list-keychains -d user -s ${KEYCHAIN} /Users/octocat/Library/Keychains/login.keychain-db /Library/Keychains/System.keychain`,
      `security find-identity -v -p codesigning ${KEYCHAIN}`,
      "build",
      "security list-keychains -d user -s /Users/octocat/Library/Keychains/login.keychain-db /Library/Keychains/System.keychain",
      `security delete-keychain ${KEYCHAIN}`,
      "remove /tmp/sign/certificate.p12",
      "remove /tmp/sign",
    ]);
  });

  it("cleans up in the same order when the build fails", () => {
    const { calls, host } = fakeHost();
    expect(() =>
      withSigningKeychain(ENV, host, () => {
        throw new Error("electron-builder failed");
      }),
    ).toThrow("electron-builder failed");
    expect(calls.slice(-4)).toEqual([
      "security list-keychains -d user -s /Users/octocat/Library/Keychains/login.keychain-db /Library/Keychains/System.keychain",
      `security delete-keychain ${KEYCHAIN}`,
      "remove /tmp/sign/certificate.p12",
      "remove /tmp/sign",
    ]);
  });

  it("leaves the search list alone when it never changed it, and still deletes what it made", () => {
    const { calls, host } = fakeHost("import");
    expect(() => withSigningKeychain(ENV, host, () => "built")).toThrow("security import failed");
    expect(calls.filter((call) => call.startsWith("security list-keychains"))).toEqual([]);
    expect(calls.slice(-3)).toEqual([
      `security delete-keychain ${KEYCHAIN}`,
      "remove /tmp/sign/certificate.p12",
      "remove /tmp/sign",
    ]);
  });

  it("refuses a certificate with no Developer ID Application identity", () => {
    const { host } = fakeHost();
    const noDeveloperId: KeychainHost = {
      ...host,
      security: (args) =>
        args[0] === "find-identity" ? "     0 valid identities found\n" : host.security(args),
    };
    expect(() => withSigningKeychain(ENV, noDeveloperId, () => "built")).toThrow(
      "no valid Developer ID Application identity",
    );
  });

  it("refuses an empty CSC_LINK before it creates anything, and removes its directory", () => {
    const { calls, host } = fakeHost();
    expect(() => withSigningKeychain({ CSC_LINK: "" }, host, () => "built")).toThrow("base64");
    expect(calls).toEqual(["remove /tmp/sign/certificate.p12", "remove /tmp/sign"]);
  });

  it("finds the Developer ID Application identity's SHA-1 only", () => {
    expect(developerIdIdentity(FIND_IDENTITY)).toBe(SHA);
    expect(
      developerIdIdentity(`  1) ${SHA} "Apple Development: Octo Cat (AAAAAAAAAA)"`),
    ).toBeUndefined();
  });

  it("gives electron-builder the keychain and identity, never the .p12 or its password", () => {
    expect(
      keychainBuilderEnv(
        {
          PATH: "/usr/bin",
          CSC_LINK: "base64",
          CSC_KEY_PASSWORD: P12_PASSWORD,
          APPLE_API_KEY: "/k.p8",
        },
        { keychain: KEYCHAIN, identity: SHA },
      ),
    ).toEqual({ PATH: "/usr/bin", APPLE_API_KEY: "/k.p8", CSC_KEYCHAIN: KEYCHAIN, CSC_NAME: SHA });
  });
});
