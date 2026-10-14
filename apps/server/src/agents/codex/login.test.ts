import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { accountState, homeLogin, keychainLogin, layOutHome, storeOverride } from "./login.ts";

const SHARED = homeLogin("/Users/octocat/.codex/auth.json", true);
const OWN = homeLogin("/Users/octocat/.codex/auth.json", false);

describe("Codex sign-in", () => {
  it("shares the user's login file, and keeps its own keychain login without one", () => {
    expect(SHARED).toEqual({ _tag: "shared", authFile: "/Users/octocat/.codex/auth.json" });
    expect(OWN).toEqual({ _tag: "own" });
  });

  it("pins each Codex process to the store its home was laid out for", () => {
    expect([storeOverride(SHARED), storeOverride(OWN)]).toEqual([
      'cli_auth_credentials_store="file"',
      'cli_auth_credentials_store="keyring"',
    ]);
  });

  it("is ready only on a ChatGPT subscription, and says when prkit holds the login", () => {
    const plus = {
      account: { type: "chatgpt", planType: "plus" },
      requiresOpenaiAuth: true,
    } as const;
    expect(accountState(plus, SHARED)).toEqual({
      _tag: "ready",
      detail: "ChatGPT Plus subscription",
      ownLogin: false,
    });
    expect(accountState(plus, OWN)).toEqual({
      _tag: "ready",
      detail: "ChatGPT Plus subscription, signed in for prkit",
      ownLogin: true,
    });
    const apiKey = { account: { type: "apiKey" }, requiresOpenaiAuth: true } as const;
    expect(accountState(apiKey, SHARED)).toEqual({
      _tag: "unavailable",
      reason: "not-subscription",
      message:
        "Codex must use your ChatGPT login. Sign in with your ChatGPT account, then check again. API keys and other model providers aren't supported.",
      fix: "codex login",
      ownLogin: false,
    });
    expect(accountState(apiKey, OWN)).toEqual({
      _tag: "unavailable",
      reason: "not-subscription",
      message:
        "prkit's own Codex login isn't a ChatGPT subscription. Sign out of it, then sign in again with your ChatGPT account.",
      fix: null,
      ownLogin: true,
    });
    expect(accountState({ account: null, requiresOpenaiAuth: true }, OWN)).toEqual({
      _tag: "unavailable",
      reason: "logged-out",
      message: "Codex isn't signed in. Sign in with your ChatGPT account, then check again.",
      fix: "codex login",
      ownLogin: false,
    });
  });

  it("offers the same sign-in in a terminal, in prkit's own Codex home", () => {
    expect(keychainLogin("/Users/octocat/.prkit/codex")).toEqual({
      _tag: "unavailable",
      reason: "keychain-login",
      message: "Codex keeps its login in the keychain. Sign in once for prkit.",
      fix: "CODEX_HOME='/Users/octocat/.prkit/codex' codex login",
      ownLogin: false,
    });
    expect(keychainLogin("/Users/octo'cat/.prkit/codex")).toMatchObject({
      fix: "CODEX_HOME='/Users/octo'\\''cat/.prkit/codex' codex login",
    });
  });
});

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

describe("prkit's Codex home", () => {
  let root = "";
  beforeAll(async () => {
    root = await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.makeTempDirectory({ prefix: "prkit-codex-" });
      }),
    );
  });
  afterAll(() =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(root, { recursive: true });
      }),
    ),
  );

  /** Where a home's auth.json links, and its config.toml. */
  const contents = (home: string) =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        return {
          authJson: Option.getOrElse(
            yield* fs.readLink(path.join(home, "auth.json")).pipe(Effect.option),
            () => "absent",
          ),
          config: Option.getOrElse(
            yield* fs.readFileString(path.join(home, "config.toml")).pipe(Effect.option),
            () => "absent",
          ),
        };
      }),
    );
  const setUp = (name: string) => {
    const home = `${root}/${name}`;
    const userFile = `${root}/${name}-user/auth.json`;
    const signOuts: Array<"signed out" | "failed"> = [];
    const retire = (works: boolean) =>
      Effect.sync(() => {
        signOuts.push(works ? "signed out" : "failed");
        return works;
      });
    const layOut = (userHasFile: boolean, works = true) =>
      run(layOutHome(home, homeLogin(userFile, userHasFile), retire(works)));
    return { home, userFile, signOuts, layOut };
  };

  it("keeps prkit's own login in the keychain, with no link into the user's Codex home", async () => {
    const { home, signOuts, layOut } = setUp("own");
    await layOut(true);
    await layOut(false);
    await layOut(false);
    expect(await contents(home)).toEqual({
      authJson: "absent",
      config: 'cli_auth_credentials_store = "keyring"\n',
    });
    expect(signOuts).toEqual([]);
  });

  it("signs prkit's own login out once before sharing the user's file", async () => {
    const { home, userFile, signOuts, layOut } = setUp("flip");
    await layOut(false);
    await layOut(true);
    await layOut(true);
    expect(await contents(home)).toEqual({ authJson: userFile, config: "absent" });
    expect(signOuts).toEqual(["signed out"]);
  });

  it("keeps the config to try again when prkit's own login couldn't be signed out", async () => {
    const { home, userFile, signOuts, layOut } = setUp("retry");
    await layOut(false);
    await layOut(true, false);
    expect(await contents(home)).toEqual({
      authJson: userFile,
      config: 'cli_auth_credentials_store = "keyring"\n',
    });
    await layOut(true);
    expect(await contents(home)).toEqual({ authJson: userFile, config: "absent" });
    expect(signOuts).toEqual(["failed", "signed out"]);
  });
});
