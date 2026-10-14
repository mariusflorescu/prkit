import * as NodeSqlite from "node:sqlite";

import { ServerHomeInUseLineJson } from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";

export class HomeInUse extends Schema.TaggedError<HomeInUse>()("HomeInUse", {
  home: Schema.String,
}) {
  override get message() {
    return `Another prkit is already using ${this.home}. Quit it, then start this one again.`;
  }
}

export class HomeLockFailed extends Schema.TaggedError<HomeLockFailed>()("HomeLockFailed", {
  home: Schema.String,
  reason: Schema.String,
}) {}

const SQLITE_BUSY = 5;
const encodeHomeInUseLine = Schema.encodeEffect(ServerHomeInUseLineJson);

/**
 * Opens `<home>/prkit.lock` and takes SQLite's exclusive lock on it for the life of the
 * process. The lock is the operating system's, so it goes away with the process however it
 * ends, and a crash never leaves the home locked.
 */
const acquire = (file: string, home: string) =>
  Effect.try({
    try: () => {
      const db = new NodeSqlite.DatabaseSync(file, { timeout: 0 });
      try {
        db.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;");
        return db;
      } catch (error) {
        db.close();
        throw error;
      }
    },
    catch: (cause) =>
      Predicate.hasProperty(cause, "errcode") && cause.errcode === SQLITE_BUSY
        ? new HomeInUse({ home })
        : new HomeLockFailed({ home, reason: String(cause) }),
  });

/**
 * One server per home: a second one (a dev run, the installed app, stable and nightly)
 * prints the home-in-use line and exits before it reads the database or listens. Build it
 * before every other layer.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const { home } = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stdio = yield* Stdio.Stdio;
    yield* fs.makeDirectory(home, { recursive: true });
    yield* Effect.acquireRelease(
      acquire(path.join(home, "prkit.lock"), home).pipe(
        Effect.tapError((error) =>
          error._tag === "HomeInUse"
            ? encodeHomeInUseLine({ type: "home-in-use", home }).pipe(
                Effect.flatMap((line) => Stream.make(`${line}\n`).pipe(Stream.run(stdio.stdout()))),
                Effect.ignore,
              )
            : Effect.void,
        ),
      ),
      (db) => Effect.sync(() => db.close()),
    );
  }),
);
