import { AccountsError, childEnv } from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { executableAt, findOnPath } from "../executables.ts";

export const resolveGh = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const override = process.env.PRKIT_GH_PATH;

  if (override !== undefined) {
    const resolved = yield* executableAt(override);
    if (resolved) return resolved;
    return yield* new AccountsError({
      message: "PRKIT_GH_PATH must name an executable gh binary outside a shim directory.",
    });
  }
  const mise = yield* findOnPath("mise");
  if (mise) {
    const output = yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(mise, ["which", "gh"], {
            env: childEnv(process.env),
            extendEnv: false,
            stdin: "ignore",
            stderr: "ignore",
          }),
        );
        const output = yield* child.stdout.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (text, part) => text + part,
          ),
        );
        return (yield* child.exitCode) === 0 ? output.trim() : "";
      }),
    ).pipe(
      Effect.timeout("10 seconds"),
      Effect.catchTags({
        PlatformError: () => Effect.succeed(""),
        TimeoutError: () => Effect.succeed(""),
      }),
    );
    const resolved = yield* executableAt(output);
    if (resolved) return resolved;
    return yield* new AccountsError({
      message:
        "Couldn't resolve gh with mise which gh. Install gh or set PRKIT_GH_PATH to its real binary.",
    });
  }
  const resolved = yield* findOnPath("gh");
  if (resolved) return resolved;
  return yield* new AccountsError({
    message:
      "Couldn't find gh outside version manager shims. Install GitHub CLI or set PRKIT_GH_PATH to its real binary.",
  });
});
