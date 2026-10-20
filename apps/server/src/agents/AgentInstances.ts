import {
  AGENT_KINDS,
  AgentAccent,
  type AgentInstanceConfig,
  AgentInstanceError,
  AgentInstanceId,
  AgentLogin,
  AgentProviderKind,
  CURSOR_API_KEY,
  defaultInstanceConfig,
  environmentNameProblem,
  isDefaultInstance,
  isReservedInstanceId,
} from "@prkit/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../config.ts";

const StoredVariable = Schema.Struct({
  name: Schema.String,
  value: Schema.String,
  sensitive: Schema.Boolean,
});
const InstanceRow = Schema.Struct({
  id: AgentInstanceId,
  kind: Schema.String,
  label: Schema.String,
  accent: Schema.NullOr(AgentAccent),
  enabled: Schema.Number,
  config_dir: Schema.NullOr(Schema.String),
  binary_path: Schema.NullOr(Schema.String),
  environment: Schema.fromJsonString(Schema.Array(StoredVariable)),
  login: AgentLogin,
});
const decodeRow = Schema.decodeUnknownResult(InstanceRow);
/** What a row prkit can't read still says of itself, so it can be shown and removed. */
const decodeIdentity = Schema.decodeUnknownOption(Schema.Struct({ id: AgentInstanceId }));
const decodeKind = Schema.decodeUnknownOption(Schema.Struct({ kind: AgentProviderKind }));
const decodeStoredId = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.String }));
const decodeEnvironments = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ environment: InstanceRow.fields.environment })),
);
const encodeEnvironment = Schema.encodeSync(Schema.fromJsonString(Schema.Array(StoredVariable)));
const isKind = Schema.is(AgentProviderKind);
/** Sensitive values by instance id, then variable name. */
const Secrets = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)),
);
const decodeSecrets = Schema.decodeUnknownEffect(Secrets);
type SecretMap = Readonly<Record<string, Readonly<Record<string, string>>>>;
const encodeSecrets = Schema.encodeSync(Secrets);
const NO_SECRETS: SecretMap = {};

/**
 * A stored instance prkit can't read. It never runs, and a default one never gives way to how it
 * shipped, which would run on another login.
 */
export interface DamagedInstance {
  readonly id: AgentInstanceId;
  /** Null when the kind can't be read either. */
  readonly kind: AgentProviderKind | null;
  readonly problem: string;
}

/** An instance with its real environment, for the server only: sensitive values included. */
export interface ResolvedInstance {
  readonly config: AgentInstanceConfig;
  readonly environment: Readonly<Record<string, string>>;
  /** It has sensitive variables, and the secrets file couldn't be read: they are missing. */
  readonly secretsLost: boolean;
}

/** What the app may see of an instance: sensitive values blanked and marked redacted. */
const redact = (config: AgentInstanceConfig, secrets: Readonly<Record<string, string>>) => ({
  ...config,
  environment: config.environment.map((variable) =>
    variable.sensitive
      ? { ...variable, value: "", valueRedacted: secrets[variable.name] !== undefined }
      : { ...variable, valueRedacted: false },
  ),
});

/**
 * The agent instances the user added or changed (Settings > Agents), plus each kind's default,
 * which exists without a row. Sensitive variable values live in `agent-secrets.json` under
 * PRKIT_HOME (mode 0600), never in the database, the app or a log.
 */
export class AgentInstances extends Context.Service<AgentInstances, Effect.Success<typeof make>>()(
  "@prkit/server/agents/AgentInstances",
) {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const server = yield* ServerConfig;
  const secretsFile = path.join(server.home, "agent-secrets.json");
  /** One change at a time, so the rows and the secrets file move together. */
  const writing = yield* Semaphore.make(1);

  const fail = (message: string) => () => Effect.fail(new AgentInstanceError({ message }));

  /**
   * The saved sensitive values. Only a missing file is empty: one that can't be read or decoded
   * fails, so a save never rewrites it without the values it held.
   */
  const readSecrets = fs.readFileString(secretsFile).pipe(
    Effect.flatMap(decodeSecrets),
    Effect.map((secrets): SecretMap => secrets),
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed<SecretMap>({})
          : fail(
              `prkit couldn't read ${secretsFile}, where it keeps agents' sensitive values, so it left it as it is. Fix its permissions, or move it aside and enter the sensitive values again.`,
            )(),
      SchemaError: fail(
        `${secretsFile}, where prkit keeps agents' sensitive values, is damaged, so prkit left it as it is. Move it aside, then enter the sensitive values again.`,
      ),
    }),
  );
  /** All but `id`'s secrets, plus `own` for it when there are any. */
  const withSecrets = (secrets: SecretMap, id: string, own: Readonly<Record<string, string>>) => {
    const next: Record<string, Readonly<Record<string, string>>> = {};
    for (const [key, value] of Object.entries(secrets)) if (key !== id) next[key] = value;
    if (Object.keys(own).length > 0) next[id] = own;
    return next;
  };
  const writeSecrets = (secrets: SecretMap) =>
    Effect.gen(function* () {
      const temporary = `${secretsFile}.${process.pid}.tmp`;
      yield* fs.writeFileString(temporary, encodeSecrets(secrets), { mode: 0o600 });
      yield* fs.chmod(temporary, 0o600);
      yield* fs.rename(temporary, secretsFile);
    });

  /**
   * Each row, read on its own: one prkit can run, or one it can't (damaged, or of a kind only a
   * newer prkit knows) that still names an instance. A row whose ID can't be read is left out
   * with a warning: nothing prkit reads can point at it.
   */
  const rows = Effect.gen(function* () {
    const raw = yield* sql`SELECT id, kind, label, accent, enabled, config_dir, binary_path,
      environment, login FROM agent_instances ORDER BY created_at, id`;
    const readable: Array<typeof InstanceRow.Type & { readonly kind: AgentProviderKind }> = [];
    const damaged: Array<DamagedInstance> = [];
    for (const row of raw) {
      const read = decodeRow(row);
      if (Result.isSuccess(read) && isKind(read.success.kind)) {
        readable.push({ ...read.success, kind: read.success.kind });
        continue;
      }
      const identity = Option.getOrUndefined(decodeIdentity(row));
      const problem = Result.isFailure(read)
        ? read.failure.message
        : "Its kind is one prkit doesn't know.";
      if (identity === undefined) {
        yield* Effect.logWarning("Left out an agent setting whose ID prkit can't read").pipe(
          Effect.annotateLogs({ problem }),
        );
        continue;
      }
      const kind = Option.match(decodeKind(row), {
        onSome: (known) => known.kind,
        onNone: () => AGENT_KINDS.find((known) => known === identity.id) ?? null,
      });
      damaged.push({ id: identity.id, kind, problem });
    }
    // Two rows that read as one ID can't say which login is meant, so neither runs.
    const seen = new Map<string, number>();
    for (const { id } of [...readable, ...damaged]) seen.set(id, (seen.get(id) ?? 0) + 1);
    const shared = readable.filter((row) => (seen.get(row.id) ?? 0) > 1);
    for (const row of shared)
      if (!damaged.some((entry) => entry.id === row.id))
        damaged.push({ id: row.id, kind: row.kind, problem: "Another setting has the same ID." });
    return { readable: readable.filter((row) => !shared.includes(row)), damaged };
  });

  /**
   * Every instance with its real environment: each kind's default first, then the user's, and
   * those prkit can't read.
   */
  const resolved = Effect.gen(function* () {
    const { readable: stored, damaged } = yield* rows;
    // An unreadable secrets file loses only the sensitive values: every agent still builds,
    // and one that had any says so instead of running without them.
    const { secrets, unreadable } = yield* readSecrets.pipe(
      Effect.map((secrets) => ({ secrets, unreadable: false })),
      Effect.catchTag("AgentInstanceError", (error) =>
        Effect.logWarning("Couldn't read the agents' sensitive values").pipe(
          Effect.annotateLogs({ message: error.message }),
          Effect.as({ secrets: NO_SECRETS, unreadable: true }),
        ),
      ),
    );
    const toResolved = (config: AgentInstanceConfig): ResolvedInstance => {
      const own = secrets[config.id] ?? {};
      const environment: Record<string, string> = {};
      for (const variable of config.environment) {
        const value = variable.sensitive ? own[variable.name] : variable.value;
        // A name a newer rule refuses is skipped, never passed to the agent.
        if (
          value !== undefined &&
          environmentNameProblem(variable.name, config.kind, variable.sensitive) === null
        )
          environment[variable.name] = value;
      }
      return {
        config: redact(config, own),
        environment,
        secretsLost: unreadable && config.environment.some((variable) => variable.sensitive),
      };
    };
    const fromRow = (row: (typeof stored)[number]): AgentInstanceConfig => ({
      id: row.id,
      kind: row.kind,
      label: row.label,
      accent: row.accent,
      enabled: row.enabled !== 0,
      configDir: row.config_dir,
      binaryPath: row.binary_path,
      environment: row.environment.map((variable) => ({ ...variable, valueRedacted: false })),
      login: row.login,
    });
    const defaults = AGENT_KINDS.filter((kind) => !damaged.some((entry) => entry.id === kind)).map(
      (kind) => {
        const row = stored.find((entry) => entry.id === kind);
        return row === undefined ? defaultInstanceConfig(kind) : fromRow(row);
      },
    );
    const added = stored.filter((row) => !isDefaultInstance(row.id)).map(fromRow);
    return { instances: [...defaults, ...added].map(toResolved), damaged };
  }).pipe(Effect.catchTag("SqlError", fail("prkit couldn't read your agents.")));

  /**
   * `saved` holds the names the instance already has. One a newer rule refuses isn't checked
   * again, so turning the agent on or off never fails on it; `resolved` still never passes it.
   * CURSOR_API_KEY is always checked: a saved key must never be turned into a plain value.
   */
  const checkConfig = (config: AgentInstanceConfig, saved: ReadonlySet<string>) =>
    Effect.gen(function* () {
      if (isDefaultInstance(config.id) && config.id !== config.kind)
        return yield* new AgentInstanceError({
          message: `'${config.id}' is the default ${config.id} instance. Pick another ID.`,
        });
      if (config.kind === "cursor" && (config.configDir !== null || config.binaryPath !== null))
        return yield* new AgentInstanceError({
          message:
            "Cursor runs in a folder of prkit's own, through its SDK: leave Config folder and Binary path empty.",
        });
      const names = new Set<string>();
      for (const variable of config.environment) {
        const problem =
          saved.has(variable.name) && variable.name.toUpperCase() !== CURSOR_API_KEY
            ? null
            : environmentNameProblem(variable.name, config.kind, variable.sensitive);
        if (problem !== null)
          return yield* new AgentInstanceError({ message: `${variable.name}: ${problem}` });
        if (names.has(variable.name))
          return yield* new AgentInstanceError({
            message: `${variable.name} is set twice. Keep one.`,
          });
        names.add(variable.name);
      }
    });

  /**
   * Saves `config` as the instance's whole setting. A sensitive variable sent back empty and
   * redacted keeps the value the server holds; any other sensitive value replaces it.
   */
  const save = (config: AgentInstanceConfig, mode: "create" | "update") =>
    writing
      .withPermits(1)(
        Effect.gen(function* () {
          const savedRows =
            yield* sql`SELECT environment FROM agent_instances WHERE id = ${config.id}`.pipe(
              Effect.flatMap(decodeEnvironments),
            );
          yield* checkConfig(
            config,
            new Set(savedRows.flatMap((row) => row.environment.map((variable) => variable.name))),
          );
          // Ids are unique whatever their case: `Claude_Work` would pass for `claude_work`.
          const existing = yield* sql<{
            readonly id: string;
            readonly kind: string;
          }>`SELECT id, kind FROM agent_instances WHERE lower(id) = lower(${config.id})`;
          if (mode === "create" && (existing.length > 0 || isReservedInstanceId(config.id)))
            return yield* new AgentInstanceError({
              message: `An instance named '${config.id}' already exists.`,
            });
          const current = existing.find((row) => row.id === config.id);
          if (mode === "update" && current === undefined && !isDefaultInstance(config.id))
            return yield* new AgentInstanceError({
              message: "That agent was removed. Check again.",
            });
          if (current !== undefined && current.kind !== config.kind)
            return yield* new AgentInstanceError({
              message: "An instance can't change which agent it runs.",
            });
          // With no sensitive values to keep, a secrets file prkit can't read stays untouched,
          // so turning an agent on or off still works; any other save refuses to rewrite it.
          const hasSecrets = config.environment.some((variable) => variable.sensitive);
          const readable = hasSecrets
            ? yield* readSecrets
            : Option.getOrNull(yield* Effect.option(readSecrets));
          const held = readable?.[config.id] ?? {};
          const kept: Record<string, string> = {};
          for (const variable of config.environment) {
            if (!variable.sensitive) continue;
            const value =
              variable.value === "" && variable.valueRedacted
                ? held[variable.name]
                : variable.value;
            if (value !== undefined && value !== "") kept[variable.name] = value;
          }
          const stored = config.environment.map((variable) => ({
            name: variable.name,
            value: variable.sensitive ? "" : variable.value,
            sensitive: variable.sensitive,
          }));
          const at = DateTime.formatIso(yield* DateTime.now);
          const blank = (value: string | null) =>
            value === null || value.trim() === "" ? null : value.trim();
          yield* sql`
          INSERT INTO agent_instances (id, kind, label, accent, enabled, config_dir, binary_path,
            environment, login, created_at, updated_at)
          VALUES (${config.id}, ${config.kind}, ${config.label}, ${config.accent},
            ${config.enabled ? 1 : 0}, ${blank(config.configDir)}, ${blank(config.binaryPath)},
            ${encodeEnvironment(stored)}, ${config.kind === "codex" ? config.login : "shared"}, ${at}, ${at})
          ON CONFLICT (id) DO UPDATE SET label = excluded.label, accent = excluded.accent,
            enabled = excluded.enabled, config_dir = excluded.config_dir,
            binary_path = excluded.binary_path, environment = excluded.environment,
            login = excluded.login, updated_at = excluded.updated_at`;
          if (readable !== null) yield* writeSecrets(withSecrets(readable, config.id, kept));
          yield* Effect.logInfo(mode === "create" ? "Added an agent" : "Changed an agent").pipe(
            Effect.annotateLogs({
              instance: config.id,
              kind: config.kind,
              enabled: config.enabled,
              // Names only: values can be secrets.
              variables: config.environment.map((variable) => variable.name).join(","),
            }),
          );
        }),
      )
      .pipe(
        Effect.catchTags({
          SqlError: fail("prkit couldn't save that agent."),
          SchemaError: fail("prkit read a damaged agent setting. Check Settings > Agents."),
          PlatformError: fail("prkit couldn't save that agent's sensitive values."),
        }),
      );

  /** Drops the row and its secrets: a default instance goes back to how it shipped. */
  const drop = (id: AgentInstanceId) =>
    writing
      .withPermits(1)(
        Effect.gen(function* () {
          // Read first: a secrets file prkit can't read stops the removal before anything goes.
          const secrets = yield* readSecrets;
          // As stored: a damaged ID with spaces around it still reads as this instance.
          for (const row of yield* sql`SELECT id FROM agent_instances`) {
            const stored = Option.getOrUndefined(decodeStoredId(row));
            if (
              stored !== undefined &&
              Option.exists(decodeIdentity(row), (identity) => identity.id === id)
            )
              yield* sql`DELETE FROM agent_instances WHERE id = ${stored.id}`;
          }
          if (secrets[id] !== undefined) yield* writeSecrets(withSecrets(secrets, id, {}));
        }),
      )
      .pipe(
        Effect.catchTags({
          SqlError: fail("prkit couldn't remove that agent."),
          PlatformError: fail("prkit couldn't remove that agent's sensitive values."),
        }),
      );

  /** Turns an added instance on or off and nothing else; false when it has no row. */
  const setEnabled = (id: AgentInstanceId, enabled: boolean) =>
    Effect.gen(function* () {
      const at = DateTime.formatIso(yield* DateTime.now);
      const rows = yield* sql`UPDATE agent_instances SET enabled = ${enabled ? 1 : 0},
        updated_at = ${at} WHERE id = ${id} RETURNING id`;
      return rows.length > 0;
    }).pipe(Effect.catchTag("SqlError", fail("prkit couldn't change that agent.")));

  /** Whether a guide attempt, a fix turn or an answer is running on `id` now. */
  const busy = (id: AgentInstanceId) =>
    sql<{ readonly found: number }>`
      SELECT 1 AS found FROM review_attempts WHERE instance_id = ${id} AND finished_at IS NULL
      UNION ALL
      SELECT 1 AS found FROM fixer_turns WHERE instance_id = ${id}
        AND json_extract(status, '$._tag') IN ('preparing', 'running')
      UNION ALL
      SELECT 1 AS found FROM ask_questions WHERE instance_id = ${id}
        AND state IN ('starting', 'waiting', 'answering')
      LIMIT 1`.pipe(
      Effect.map((found) => found.length > 0),
      Effect.catchTag("SqlError", fail("prkit couldn't check whether that agent is busy.")),
    );

  return {
    resolved,
    busy,
    setEnabled,
    create: (config: AgentInstanceConfig) => save(config, "create"),
    update: (config: AgentInstanceConfig) => save(config, "update"),
    drop,
  };
});

export const layer = Layer.effect(AgentInstances, make);
