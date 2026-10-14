import { type AgentCatalog, type AgentProviderKind, AgentSignInError } from "@prkit/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import type { AgentError, AgentProvider } from "./AgentProvider.ts";
import * as ClaudeAgent from "./ClaudeAgent.ts";
import * as CodexAgent from "./codex/CodexAgent.ts";

export class Agents extends Context.Service<Agents, Effect.Success<typeof make>>()(
  "@prkit/server/agents/Agents",
) {}

export const make = Effect.gen(function* () {
  const claude = yield* ClaudeAgent.make;
  const codex = yield* CodexAgent.make;
  const providers = { claude, codex } satisfies Record<AgentProviderKind, AgentProvider>;
  const loading = yield* Semaphore.make(1);
  /** At most two agent processes app-wide, guides and fixes together; a slot covers a whole attempt or turn. */
  const slots = yield* Semaphore.make(2);
  let cached: AgentCatalog | null = null;

  const get = (kind: AgentProviderKind) => providers[kind];

  const load = Effect.forEach(
    Object.values(providers),
    (provider) =>
      Effect.gen(function* () {
        const state = yield* provider.check;
        const models = yield* provider.models(state);
        return { kind: provider.kind, label: provider.label, state, models };
      }),
    { concurrency: "unbounded" },
  ).pipe(Effect.map((entries): AgentCatalog => ({ providers: entries })));

  /**
   * Logins and model lists, read once and kept until `refresh` (Check again) or
   * `invalidate` (a turn found the login changed). Concurrent readers share one load.
   */
  const catalog = (refresh = false) =>
    loading.withPermits(1)(
      Effect.gen(function* () {
        if (cached !== null && !refresh) return cached;
        const loaded = yield* load;
        cached = loaded;
        yield* Effect.logInfo("Read the agent catalog").pipe(
          Effect.annotateLogs(
            Object.fromEntries(
              loaded.providers.map((entry) => [
                entry.kind,
                entry.state._tag === "ready" ? `${entry.models.length} models` : entry.state.reason,
              ]),
            ),
          ),
        );
        return loaded;
      }),
    );

  const invalidate = Effect.sync(() => {
    cached = null;
  });

  const ownLogin = (kind: AgentProviderKind) =>
    Effect.gen(function* () {
      const login = providers[kind].ownLogin;
      if (login === null)
        return yield* new AgentSignInError({
          message: `${providers[kind].label} uses your own login, so prkit has none to sign in or out.`,
        });
      return login;
    });
  const toSignInError = (error: AgentError | AgentSignInError) =>
    error._tag === "AgentSignInError" ? error : new AgentSignInError({ message: error.message });
  /** prkit's own login for `kind`: the page to sign in on, then the end once signed in. */
  const signIn = (kind: AgentProviderKind) =>
    Stream.unwrap(Effect.map(ownLogin(kind), (login) => login.signIn)).pipe(
      Stream.mapError(toSignInError),
      Stream.ensuring(invalidate),
    );
  const signOut = (kind: AgentProviderKind) =>
    ownLogin(kind).pipe(
      Effect.flatMap((login) => login.signOut),
      Effect.mapError(toSignInError),
      Effect.andThen(catalog(true)),
    );

  return { get, catalog, invalidate, slots, signIn, signOut };
});

export const layer = Layer.effect(Agents, make);
