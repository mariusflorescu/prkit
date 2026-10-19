import type { AgentProviderState } from "@prkit/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { AgentError } from "../AgentProvider.ts";
import type { RequestWording } from "./JsonRpcClient.ts";
import type * as Protocol from "./protocol.ts";

const LOGIN = "codex login";
const LOGIN_HINT = "Codex isn't signed in. Sign in with your ChatGPT account, then check again.";
/** Keeps a login made in prkit's home in the keychain, a `codex login` run there by hand too. */
const OWN_CONFIG = 'cli_auth_credentials_store = "keyring"\n';

/**
 * Where prkit's Codex home gets its login. Codex names a keychain login after the path of its
 * home, the same home it reads the global AGENTS.md from, so only a login file can be shared.
 */
export type CodexHomeLogin =
  /** `auth.json` links to the user's; Codex writes refreshed tokens through it. */
  | { readonly _tag: "shared"; readonly authFile: string }
  /** No link, and prkit's own login in the keychain under prkit's home. */
  | { readonly _tag: "own" };

export const homeLogin = (userAuthFile: string, userHasFile: boolean): CodexHomeLogin =>
  userHasFile ? { _tag: "shared", authFile: userAuthFile } : { _tag: "own" };

/**
 * The `-c` override that pins a Codex process to the store its home was laid out for. Another
 * check can lay the home out again before Codex reads its config.toml, and a sign-out that
 * read the user's file through the link would revoke the user's own login.
 */
export const storeOverride = (login: CodexHomeLogin) =>
  `cli_auth_credentials_store="${login._tag === "shared" ? "file" : "keyring"}"`;

/**
 * Lays prkit's Codex home out for `login`. Safe to run again at any point. A config.toml means
 * prkit may still hold a login of its own, so before sharing the user's file `retire` signs it
 * out, or it would stay in the keychain with nothing in prkit to show or remove it. The config
 * goes only once that worked, so a failed sign-out is tried again next time.
 */
export const layOutHome = Effect.fn("CodexLogin.layOutHome")(function* (
  home: string,
  login: CodexHomeLogin,
  retire: Effect.Effect<boolean>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const link = path.join(home, "auth.json");
  const config = path.join(home, "config.toml");
  yield* fs.makeDirectory(home, { recursive: true });
  if (login._tag === "own") {
    // A link to a missing file would let Codex create one in the user's Codex home.
    yield* fs.remove(link, { force: true });
    if (Option.getOrNull(yield* fs.readFileString(config).pipe(Effect.option)) !== OWN_CONFIG)
      yield* fs.writeFileString(config, OWN_CONFIG);
    return;
  }
  if ((yield* fs.exists(config)) && (yield* retire)) yield* fs.remove(config, { force: true });
  if (Option.getOrNull(yield* fs.readLink(link).pipe(Effect.option)) !== login.authFile) {
    yield* fs.remove(link, { force: true });
    yield* fs.symlink(login.authFile, link);
  }
});

export const unavailable = (
  reason: Extract<AgentProviderState, { _tag: "unavailable" }>["reason"],
  message: string,
  fix: string | null = null,
  ownLogin = false,
): AgentProviderState => ({ _tag: "unavailable", reason, message, fix, ownLogin });

/** What prkit's Codex home says about its login: ready only on a ChatGPT subscription. */
export const accountState = (
  response: typeof Protocol.AccountResponse.Type,
  login: CodexHomeLogin,
): AgentProviderState => {
  const own = login._tag === "own";
  if (response.account === null) return unavailable("logged-out", LOGIN_HINT, LOGIN);
  if (response.account.type !== "chatgpt" || !response.requiresOpenaiAuth)
    return own
      ? unavailable(
          "not-subscription",
          "prkit's own Codex login isn't a ChatGPT subscription. Sign out of it, then sign in again with your ChatGPT account.",
          null,
          true,
        )
      : unavailable(
          "not-subscription",
          "Codex must use your ChatGPT login. Sign in with your ChatGPT account, then check again. API keys and other model providers aren't supported.",
          LOGIN,
        );
  const plan = response.account.planType;
  return {
    _tag: "ready",
    detail: `ChatGPT ${plan.charAt(0).toUpperCase()}${plan.slice(1)} subscription${own ? ", signed in for prkit" : ""}`,
    ownLogin: own,
  };
};

/**
 * The user's own Codex is signed in, but in the keychain, so prkit needs a login of its own.
 * The fix is the same sign-in in a terminal, for when the one in the browser fails.
 */
export const keychainLogin = (home: string) =>
  unavailable(
    "keychain-login",
    "Codex keeps its login in the keychain. Sign in once for prkit.",
    `CODEX_HOME='${home.replaceAll("'", `'\\''`)}' codex login`,
  );

/** An instance whose ChatGPT login prkit holds itself, before it signed in. */
export const signInForPrkit = (home: string) =>
  unavailable(
    "keychain-login",
    "Sign in with your ChatGPT account for this agent.",
    `CODEX_HOME='${home.replaceAll("'", `'\\''`)}' codex login`,
  );

/** Starting prkit's own sign-in, when Codex refuses it or doesn't answer. */
export const SIGN_IN: RequestWording = {
  refused: (reason) =>
    new AgentError({
      reason: "auth",
      message: `Codex couldn't start the sign-in (${reason}).`,
    }),
  tooSlow: new AgentError({
    reason: "auth",
    message: "Codex took too long to start the sign-in.",
  }),
};

/** Signing prkit's own login out, when Codex refuses it or doesn't answer. */
export const SIGN_OUT: RequestWording = {
  refused: (reason) =>
    new AgentError({
      reason: "auth",
      message: `Codex couldn't sign out prkit's login (${reason}).`,
    }),
  tooSlow: new AgentError({
    reason: "auth",
    message: "Codex took too long to sign out prkit's login.",
  }),
};
