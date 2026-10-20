import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "./config.ts";

/**
 * Verification only: in an e2e instance, `hold(point)` waits while `<home>/e2e-holds/<point>`
 * exists, so a journey can kill the server at a step no user action stops at, or keep a read in
 * flight. A file that holds a number of milliseconds holds each step that long instead, so a
 * journey can time a read without racing it. A held step first writes `<point>.reached` beside
 * it. Anywhere else it does nothing.
 */
export const makeE2eHold = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return (point: string) =>
    Effect.gen(function* () {
      if (!config.e2e) return;
      const file = path.join(config.home, "e2e-holds", point);
      const read = fs.readFileString(file).pipe(Effect.option);
      const held = yield* read;
      if (Option.isNone(held)) return;
      yield* fs.writeFileString(`${file}.reached`, "").pipe(Effect.ignore);
      const millis = Number(held.value);
      if (held.value.trim() !== "" && Number.isFinite(millis)) return yield* Effect.sleep(millis);
      while (Option.isSome(yield* read)) yield* Effect.sleep("100 millis");
    });
});
