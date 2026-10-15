import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";

import { CURSOR_SDK_VERSION, SDK_PACKAGES } from "./sdkPackages.ts";

const Lockfile = Schema.Struct({
  importers: Schema.Record(
    Schema.String,
    Schema.Struct({
      devDependencies: Schema.optionalKey(
        Schema.Record(Schema.String, Schema.Struct({ version: Schema.String })),
      ),
    }),
  ),
  packages: Schema.Record(
    Schema.String,
    Schema.Struct({ resolution: Schema.Struct({ integrity: Schema.String }) }),
  ),
  snapshots: Schema.Record(
    Schema.String,
    Schema.Struct({
      dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
      optionalDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    }),
  ),
});

const lockfile = Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(
      new URL("../../../../../pnpm-lock.yaml", import.meta.url).pathname,
    );
    return yield* Schema.decodeUnknownEffect(Lockfile)(parse(text));
  }).pipe(Effect.provide(NodeServices.layer)),
);

describe("Cursor's SDK packages", () => {
  it("download exactly what the lockfile pins", async () => {
    const { packages } = await lockfile;
    for (const entry of SDK_PACKAGES)
      expect(
        packages[`${entry.name}@${entry.version}`]?.resolution.integrity,
        `${entry.name}@${entry.version}`,
      ).toBe(entry.integrity);
  });

  it("cover the SDK's whole runtime closure on macOS, at the dev dependency's version", async () => {
    const { importers, snapshots } = await lockfile;
    expect(importers["apps/server"]?.devDependencies?.["@cursor/sdk"]?.version).toBe(
      CURSOR_SDK_VERSION,
    );
    const pinned = new Set(SDK_PACKAGES.map((entry) => `${entry.name}@${entry.version}`));
    const needed = new Set<string>();
    const visit = (key: string) => {
      const name = key.replace(/\(.*$/, "");
      if (needed.has(name)) return;
      needed.add(name);
      const snapshot = snapshots[key];
      const optional = Object.entries(snapshot?.optionalDependencies ?? {}).filter(([dep]) =>
        dep.startsWith("@cursor/sdk-darwin-"),
      );
      for (const [dep, version] of [...Object.entries(snapshot?.dependencies ?? {}), ...optional])
        visit(`${dep}@${version}`);
    };
    visit(`@cursor/sdk@${CURSOR_SDK_VERSION}`);
    expect([...needed].toSorted()).toEqual([...pinned].toSorted());
  });
});
