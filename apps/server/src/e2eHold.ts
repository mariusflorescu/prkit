import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ServerConfig from "./config.ts";

/**
 * Verification only: in an e2e instance, `hold(point)` waits while `<home>/e2e-holds/<point>`
 * exists, so a journey can kill the server at a step no user action stops at. Anywhere else it
 * does nothing.
 */
export const makeE2eHold = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return (point: string) =>
    Effect.gen(function* () {
      if (!config.e2e) return;
      const file = path.join(config.home, "e2e-holds", point);
      while (yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))
        yield* Effect.sleep("100 millis");
    });
});
