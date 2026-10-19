import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type { ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vite-plus/test";

import * as JsonRpcClient from "./JsonRpcClient.ts";
import { SIGN_IN, SIGN_OUT } from "./login.ts";

const REFUSED = "failed to start login server: Port 127.0.0.1:1457 is already in use";

/**
 * A stand-in `codex app-server`: it answers `initialize`, refuses each method named in
 * REFUSE with that reason, and never answers anything else.
 */
const STAND_IN = `
const refuse = JSON.parse(process.env.REFUSE ?? "{}");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "initialize")
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
  else if (refuse[message.method] !== undefined)
    process.stdout.write(
      JSON.stringify({ id: message.id, error: { code: -32000, message: refuse[message.method] } }) + "\\n",
    );
});
`;

/** A client of the stand-in, refusing `refuse`'s methods with their reasons. */
const standIn = (refuse: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const executable = path.join(dir, "codex");
    yield* fs.writeFileString(executable, `#!${process.execPath}\n${STAND_IN}`);
    yield* fs.chmod(executable, 0o755);
    return yield* JsonRpcClient.make({
      executable,
      env: { PATH: process.env.PATH ?? "", REFUSE: JSON.stringify(refuse) },
      config: [],
    });
  });

/** The message a request Codex refuses fails with. */
const refusal = <A>(request: Effect.Effect<A, { readonly message: string }>) =>
  request.pipe(
    Effect.flip,
    Effect.map((error) => error.message),
  );

/** The message a request Codex never answers fails with, once 30 seconds pass on the test clock. */
const silence = <A>(request: Effect.Effect<A, { readonly message: string }>) =>
  Effect.gen(function* () {
    const fiber = yield* request.pipe(Effect.flip, Effect.forkChild);
    yield* TestClock.adjust("30 seconds");
    return (yield* Fiber.join(fiber)).message;
  });

const run = <A, E>(
  test: Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
  >,
) =>
  Effect.runPromise(
    test.pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(NodeServices.layer, TestClock.layer())),
      Effect.provideService(References.MinimumLogLevel, "Warn"),
    ),
  );

describe("Codex requests", () => {
  it("say in sign-in words when Codex refuses to start prkit's sign-in or sign-out", () =>
    run(
      Effect.gen(function* () {
        const codex = yield* standIn({
          "account/login/start": REFUSED,
          "account/logout": "no keyring entry for this home",
          "thread/start": "not signed in",
        });
        expect(yield* refusal(codex.request("account/login/start", {}, Schema.Json, SIGN_IN))).toBe(
          "Codex couldn't start the sign-in (failed to start login server: Port 127.0.0.1:1457 is already in use).",
        );
        expect(yield* refusal(codex.request("account/logout", null, Schema.Json, SIGN_OUT))).toBe(
          "Codex couldn't sign out prkit's login (no keyring entry for this home).",
        );
        expect(yield* refusal(codex.request("thread/start", {}, Schema.Json))).toBe(
          "Codex rejected a request (not signed in). Check your Codex login and retry.",
        );
      }),
    ));

  it("say in sign-in words when Codex gives no answer within 30 seconds", () =>
    run(
      Effect.gen(function* () {
        const codex = yield* standIn({});
        expect(yield* silence(codex.request("account/login/start", {}, Schema.Json, SIGN_IN))).toBe(
          "Codex took too long to start the sign-in.",
        );
        expect(yield* silence(codex.request("account/logout", null, Schema.Json, SIGN_OUT))).toBe(
          "Codex took too long to sign out prkit's login.",
        );
        expect(yield* silence(codex.request("thread/start", {}, Schema.Json))).toBe(
          "Codex took too long to answer thread/start. Retry the guide.",
        );
      }),
    ));
});
