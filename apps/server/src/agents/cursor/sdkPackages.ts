import * as Schema from "effect/Schema";

/** The Cursor SDK release prkit drives. A new one is a change here, in the lockfile, and a new live proof. */
export const CURSOR_SDK_VERSION = "1.0.37";

export const SdkPackage = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  /** npm's `sha512-...` integrity, the same value the lockfile pins. */
  integrity: Schema.String,
  /** Where the tarball is read from: npm's registry, or a test's stand-in. */
  url: Schema.String,
  /** `darwin-arm64` for a package only that machine needs; absent for every machine. */
  platform: Schema.optionalKey(Schema.String),
});
export type SdkPackage = typeof SdkPackage.Type;

const tarball = (name: string, version: string) =>
  `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1) ?? name}-${version}.tgz`;

const pinned = (name: string, version: string, integrity: string, platform?: string) => ({
  name,
  version,
  integrity,
  url: tarball(name, version),
  ...(platform === undefined ? {} : { platform }),
});

/**
 * Everything the SDK needs at run time, at the versions and integrities pnpm-lock.yaml pins
 * (sdkPackages.test.ts checks they agree). Cursor's SDK is proprietary, so prkit never ships it:
 * the user asks for it in Settings > Agents and prkit downloads exactly these.
 */
export const SDK_PACKAGES: ReadonlyArray<SdkPackage> = [
  pinned(
    "@cursor/sdk",
    CURSOR_SDK_VERSION,
    "sha512-MWKMeqtkCOHOOi8uZqI7CYeUtOwwdWke1B4GEllERIGMsoKuxbk++tP/KzOXXxtOD9EUD1z3AQL6os6m3M1gIw==",
  ),
  pinned(
    "@cursor/sdk-darwin-arm64",
    CURSOR_SDK_VERSION,
    "sha512-VlIlLlt23bPmagSaetELwDho3E0GGwSMPEtaUqzweG14XVypHEWCBTaMOVxU2MV/vmgp0EpyA/T4WXIfSGpp9g==",
    "darwin-arm64",
  ),
  pinned(
    "@cursor/sdk-darwin-x64",
    CURSOR_SDK_VERSION,
    "sha512-yK8UoU2HJ1Q8gQyoluffwpcRjaFoK61MkpwyAHaBhWPp0vHKFVeUawdp1R81HrHvwwUqYvXIPaKXa+XG3CDVcQ==",
    "darwin-x64",
  ),
  pinned(
    "@bufbuild/protobuf",
    "1.10.0",
    "sha512-QDdVFLoN93Zjg36NoQPZfsVH9tZew7wKDKyV5qRdj8ntT4wQCOradQjRaTdwMhWUYsgKsvCINKKm87FdEk96Ag==",
  ),
  pinned(
    "@connectrpc/connect",
    "1.7.0",
    "sha512-iNKdJRi69YP3mq6AePRT8F/HrxWCewrhxnLMNm0vpqXAR8biwzRtO6Hjx80C6UvtKJ5sFmffQT7I4Baecz389w==",
  ),
  pinned(
    "@connectrpc/connect-web",
    "1.7.0",
    "sha512-qyP0YOnUPRWwCc/VfsoydMJvkb7EyUPr2q9sHgBuJzbADjiqck1gKH5V5ZPzPhTLBvmz5UvG+wiZ5sMRQHU1MQ==",
  ),
  pinned(
    "@statsig/js-client",
    "3.31.0",
    "sha512-LFa5E0LjT6sTfZv3sNGoyRLSZ1078+agdgOA+Vm1ecjG+KbSOfBLTW7hMwimrJ29slRwbYDzbtKaPJo/R37N2g==",
  ),
  pinned(
    "@statsig/client-core",
    "3.31.0",
    "sha512-SuxQD6TmVszPG7FoMKwTk/uyBuVFk7XnxI3T/E0uyb7PL7GNjONtfsoh+NqBBVUJVse0CUeSFfgJPoZy1ZOslQ==",
  ),
  pinned(
    "zod",
    "3.25.76",
    "sha512-gzUt/qt81nXsFGKIFcC3YnfEAx5NkunCfnDlvuBSSFS02bcXu4Lmea0AFIUwbLWxWPx3d9p8S5QoaujKcNQxcQ==",
  ),
];

/** This machine's platform, as the SDK names its platform packages. */
export const machinePlatform = () => `${process.platform}-${process.arch}`;

/** The SDK's own platform package must exist for a machine, or Cursor can't run there. */
export const supportsPlatform = (packages: ReadonlyArray<SdkPackage>, platform: string) =>
  packages.some((entry) => entry.platform === platform);

/** The packages one machine installs: every shared one, plus its own platform's. */
export const packagesFor = (packages: ReadonlyArray<SdkPackage>, platform: string) =>
  packages.filter((entry) => entry.platform === undefined || entry.platform === platform);
