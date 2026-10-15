import {
  AGENT_KINDS,
  type AgentCatalog,
  type AgentCatalogEntry,
  type AgentInstanceConfig,
  AgentInstanceError,
  type AgentInstanceId,
  type AgentProviderKind,
  type AgentProviderState,
  AgentSignInError,
  defaultInstanceId,
  isDefaultInstance,
} from "@prkit/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { expandHome } from "../executables.ts";
import type { AgentError, AgentProvider, InstanceSetup } from "./AgentProvider.ts";
import * as AgentInstancesStore from "./AgentInstances.ts";
import * as ClaudeAgent from "./ClaudeAgent.ts";
import * as CodexAgent from "./codex/CodexAgent.ts";

export class Agents extends Context.Service<Agents, Effect.Success<typeof make>>()(
  "@prkit/server/agents/Agents",
) {}

type BuildServices =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | ServerConfig;

/** The variable each kind reads its config folder from. */
const CONFIG_DIR_VARIABLES: Record<AgentProviderKind, string> = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
};

/** How each kind's provider is made from an instance's setup. */
const FACTORIES: Record<
  AgentProviderKind,
  (setup: InstanceSetup) => Effect.Effect<AgentProvider, never, BuildServices>
> = {
  claude: ClaudeAgent.make,
  codex: CodexAgent.make,
};

/**
 * What an instance runs with. A default instance without a config folder of its own keeps the
 * one the server was started with, as before instances existed.
 */
export const setupOf = (
  resolved: AgentInstancesStore.ResolvedInstance,
  env: Readonly<Record<string, string | undefined>>,
): InstanceSetup => {
  const { config } = resolved;
  const inherited = isDefaultInstance(config.id)
    ? env[CONFIG_DIR_VARIABLES[config.kind]]
    : undefined;
  const configDir = config.configDir !== null ? expandHome(config.configDir) : (inherited ?? null);
  return {
    id: config.id,
    label: config.label,
    isDefault: isDefaultInstance(config.id),
    configDir: configDir === "" ? null : configDir,
    binaryPath: config.binaryPath === null ? null : expandHome(config.binaryPath),
    environment: resolved.environment,
    login: config.login,
  };
};

const off = (label: string): AgentProviderState => ({
  _tag: "unavailable",
  reason: "off",
  message: `${label} is turned off in Settings > Agents.`,
  fix: null,
  ownLogin: false,
});

const SECRETS_LOST: AgentProviderState = {
  _tag: "unavailable",
  reason: "secrets",
  message:
    "prkit couldn't read its saved secrets (agent-secrets.json in prkit's folder). Move that file aside, then enter them again in Edit.",
  fix: null,
  ownLogin: false,
};

/** Display order: kind, its default first, then label, then id. */
const order = (left: AgentInstanceConfig, right: AgentInstanceConfig) =>
  AGENT_KINDS.indexOf(left.kind) - AGENT_KINDS.indexOf(right.kind) ||
  Number(isDefaultInstance(right.id)) - Number(isDefaultInstance(left.id)) ||
  left.label.localeCompare(right.label) ||
  left.id.localeCompare(right.id);

/** Everything a provider is built from, so a change to any of it builds the provider again. */
const settingsKey = (config: AgentInstanceConfig, setup: InstanceSetup) =>
  [
    config.kind,
    String(config.enabled),
    setup.id,
    setup.label,
    setup.configDir ?? "",
    setup.binaryPath ?? "",
    setup.login,
    ...Object.entries(setup.environment)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `${name}=${value}`),
  ].join("\u0000");

interface Built {
  /** The settings the provider was built from; a change rebuilds it. */
  readonly key: string;
  readonly config: AgentInstanceConfig;
  readonly provider: AgentProvider;
  /** Its sensitive values couldn't be read, so it isn't offered until they are entered again. */
  readonly secretsLost: boolean;
}

export const make = Effect.gen(function* () {
  const store = yield* AgentInstancesStore.AgentInstances;
  const services = yield* Effect.context<BuildServices>();
  const building = yield* Semaphore.make(1);
  const loading = yield* Semaphore.make(1);
  /** At most two agent processes app-wide, guides and fixes together; a slot covers a whole attempt or turn. */
  const slots = yield* Semaphore.make(2);
  let built = new Map<AgentInstanceId, Built>();
  /** Each instance's last read login and models, by the settings they were read with. */
  const checked = new Map<
    AgentInstanceId,
    { readonly key: string; readonly entry: AgentCatalogEntry }
  >();

  const build = (kind: AgentProviderKind, setup: InstanceSetup) =>
    Effect.provideContext(FACTORIES[kind](setup), services);

  /** Every instance with its provider, built again only when its settings changed. */
  const instances = building.withPermits(1)(
    Effect.gen(function* () {
      const resolved = yield* store.resolved;
      const next = new Map<AgentInstanceId, Built>();
      for (const instance of resolved) {
        const setup = setupOf(instance, process.env);
        const key = `${settingsKey(instance.config, setup)}\u0000${String(instance.secretsLost)}`;
        const known = built.get(instance.config.id);
        next.set(
          instance.config.id,
          known !== undefined && known.key === key
            ? { ...known, config: instance.config }
            : {
                key,
                config: instance.config,
                provider: yield* build(instance.config.kind, setup),
                secretsLost: instance.secretsLost,
              },
        );
      }
      built = next;
      return [...next.values()].toSorted((left, right) => order(left.config, right.config));
    }).pipe(
      // A failed read keeps what was built last, so a running app keeps its agents.
      Effect.catchTag("AgentInstanceError", (error) =>
        Effect.logWarning("Couldn't read the agent instances").pipe(
          Effect.annotateLogs({ message: error.message }),
          Effect.as(
            [...built.values()].toSorted((left, right) => order(left.config, right.config)),
          ),
        ),
      ),
    ),
  );

  /** The instance's provider when it exists and is on; null otherwise. */
  const get = (id: AgentInstanceId) =>
    instances.pipe(
      Effect.map((list) => {
        const found = list.find((entry) => entry.config.id === id);
        return found !== undefined && found.config.enabled ? found.provider : null;
      }),
    );

  /**
   * The instance a review or fix session pointing at `id` runs on now: `id` itself while it is on,
   * else its kind's default instance while that is on. Null when neither is: the caller falls
   * back to the default agent.
   */
  const usable = (id: AgentInstanceId, kind: AgentProviderKind) =>
    Effect.gen(function* () {
      if ((yield* get(id)) !== null) return id;
      const fallback = defaultInstanceId(kind);
      return (yield* get(fallback)) === null ? null : fallback;
    });

  /** Every instance whose conversations `id`'s can continue: the same group, `id` included. */
  const sameGroup = (id: AgentInstanceId) =>
    instances.pipe(
      Effect.map((list) => {
        const group = list.find((entry) => entry.config.id === id)?.provider.group;
        const members = list
          .filter((entry) => group !== undefined && entry.provider.group === group)
          .map((entry) => entry.config.id);
        return members.includes(id) ? members : [id, ...members];
      }),
    );

  const read = (entry: Built): Effect.Effect<AgentCatalogEntry> =>
    Effect.gen(function* () {
      const { config, provider } = entry;
      const base = {
        instance: config.id,
        kind: config.kind,
        label: config.label,
        accent: config.accent,
        enabled: config.enabled,
        isDefault: isDefaultInstance(config.id),
        configDir: config.configDir,
        binaryPath: config.binaryPath,
        environment: config.environment,
        login: config.login,
        group: provider.group,
      };
      if (!config.enabled)
        return { ...base, version: yield* provider.version, state: off(config.label), models: [] };
      if (entry.secretsLost)
        return {
          ...base,
          version: yield* provider.version,
          state: SECRETS_LOST,
          models: [],
        };
      const [state, version] = yield* Effect.all([provider.check, provider.version], {
        concurrency: "unbounded",
      });
      return { ...base, version, state, models: yield* provider.models(state) };
    });

  /**
   * Logins and model lists, read once and kept until `refresh` (Check again), `invalidate` (a
   * turn found the login changed), or the instance's settings change. `only` reads just that
   * instance again. Concurrent readers share one load.
   */
  const catalog = (refresh = false, only?: AgentInstanceId) =>
    loading.withPermits(1)(
      Effect.gen(function* () {
        const list = yield* instances;
        const entries = yield* Effect.forEach(
          list,
          (entry) => {
            const known = checked.get(entry.config.id);
            const again = refresh && (only === undefined || only === entry.config.id);
            if (known !== undefined && known.key === entry.key && !again)
              return Effect.succeed({ fresh: false, entry: { ...known.entry, ...display(entry) } });
            return read(entry).pipe(
              Effect.tap((read) =>
                Effect.sync(() => checked.set(entry.config.id, { key: entry.key, entry: read })),
              ),
              Effect.map((read) => ({ fresh: true, entry: read })),
            );
          },
          { concurrency: "unbounded" },
        );
        for (const id of checked.keys())
          if (!list.some((entry) => entry.config.id === id)) checked.delete(id);
        if (entries.some((entry) => entry.fresh))
          yield* Effect.logInfo("Read the agent catalog").pipe(
            Effect.annotateLogs(
              Object.fromEntries(
                entries
                  .filter((entry) => entry.fresh)
                  .map(({ entry }) => [
                    entry.instance,
                    entry.state._tag === "ready"
                      ? `${entry.models.length} models`
                      : entry.state.reason,
                  ]),
              ),
            ),
          );
        const loaded: AgentCatalog = { providers: entries.map((entry) => entry.entry) };
        return loaded;
      }),
    );

  /** Settings that don't need a new check: label and accent show at once. */
  const display = (entry: Built) => ({
    label: entry.config.label,
    accent: entry.config.accent,
    environment: entry.config.environment,
  });

  const invalidate = Effect.sync(() => {
    checked.clear();
  });

  const ownLogin = (id: AgentInstanceId) =>
    Effect.gen(function* () {
      const provider = yield* get(id);
      if (provider === null)
        return yield* new AgentSignInError({
          message: "That agent is turned off or was removed. Check Settings > Agents.",
        });
      const login = provider.ownLogin;
      if (login === null)
        return yield* new AgentSignInError({
          message: `${provider.label} uses your own login, so prkit has none to sign in or out.`,
        });
      return login;
    });
  const toSignInError = (error: AgentError | AgentSignInError) =>
    error._tag === "AgentSignInError" ? error : new AgentSignInError({ message: error.message });
  /** prkit's own login for an instance: the page to sign in on, then the end once signed in. */
  const signIn = (id: AgentInstanceId) =>
    Stream.unwrap(Effect.map(ownLogin(id), (login) => login.signIn)).pipe(
      Stream.mapError(toSignInError),
      Stream.ensuring(invalidate),
    );
  const signOut = (id: AgentInstanceId) =>
    ownLogin(id).pipe(
      Effect.flatMap((login) => login.signOut),
      Effect.mapError(toSignInError),
      Effect.andThen(catalog(true, id)),
    );

  const create = (config: AgentInstanceConfig) =>
    store.create(config).pipe(Effect.andThen(catalog(true, config.id)));
  const update = (config: AgentInstanceConfig) =>
    store.update(config).pipe(Effect.andThen(catalog(true, config.id)));

  /**
   * Removes an added instance: its prkit-held login and folder first, then its settings. It is
   * turned off first, so no guide or fix can start on it while the busy check and the sign-out
   * run; if either refuses, it goes back to how it was.
   */
  const remove = (id: AgentInstanceId) =>
    Effect.gen(function* () {
      if (isDefaultInstance(id))
        return yield* new AgentInstanceError({
          message: "A default agent can't be removed. Reset it or turn it off instead.",
        });
      const found = (yield* instances).find((entry) => entry.config.id === id);
      const wasEnabled = found?.config.enabled ?? false;
      if (wasEnabled) yield* store.setEnabled(id, false);
      const restore = wasEnabled ? store.setEnabled(id, true).pipe(Effect.ignore) : Effect.void;
      yield* Effect.gen(function* () {
        if (yield* store.busy(id))
          return yield* new AgentInstanceError({
            message: `${found?.config.label ?? id} is busy with a guide or fix. Try again when it's done.`,
          });
        if (found !== undefined)
          yield* found.provider.retire.pipe(
            Effect.mapError((error) => new AgentInstanceError({ message: error.message })),
          );
      }).pipe(Effect.tapError(() => restore));
      yield* store.drop(id).pipe(Effect.tapError(() => restore));
      yield* Effect.logInfo("Removed an agent").pipe(Effect.annotateLogs({ instance: id }));
      return yield* catalog();
    });

  /** A default instance back to how it shipped. prkit's own login and folder for it stay. */
  const reset = (id: AgentInstanceId) =>
    Effect.gen(function* () {
      if (!isDefaultInstance(id))
        return yield* new AgentInstanceError({
          message: "Only a default agent can be reset. Edit or remove this one instead.",
        });
      yield* store.drop(id);
      return yield* catalog(true, id);
    });

  return {
    get,
    usable,
    sameGroup,
    catalog,
    invalidate,
    slots,
    signIn,
    signOut,
    create,
    update,
    remove,
    reset,
  };
});

export const layer = Layer.effect(Agents, make).pipe(Layer.provide(AgentInstancesStore.layer));
