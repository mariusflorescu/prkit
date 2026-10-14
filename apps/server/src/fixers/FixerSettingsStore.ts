import { FixerError, type RepositoryFixerSettings } from "@prkit/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const Row = Schema.Struct({
  repository: Schema.String,
  push_automatically: Schema.Int,
  resolve_automatically: Schema.Int,
  run_scripts_anywhere: Schema.Int,
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));
const toSettings = (row: typeof Row.Type): RepositoryFixerSettings => ({
  repository: row.repository,
  pushAutomatically: row.push_automatically === 1,
  resolveAutomatically: row.resolve_automatically === 1,
  runScriptsOnAnyPullRequest: row.run_scripts_anywhere === 1,
});

/** Per-repository fix agent settings; a repository without a row has all of them off. */
export class FixerSettingsStore extends Context.Service<
  FixerSettingsStore,
  Effect.Success<typeof make>
>()("@prkit/server/fixers/FixerSettingsStore") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const failure = (message: string) => () => Effect.fail(new FixerError({ message }));
  const storage = {
    SqlError: failure("prkit couldn't read or save the repository settings. Try again."),
    SchemaError: failure("prkit read damaged repository settings. Set them again."),
  };

  const get = (repository: string) =>
    sql`SELECT * FROM fixer_repository_settings WHERE repository = ${repository}`.pipe(
      Effect.flatMap(decodeRows),
      Effect.map((rows): RepositoryFixerSettings =>
        rows[0] === undefined
          ? {
              repository,
              pushAutomatically: false,
              resolveAutomatically: false,
              runScriptsOnAnyPullRequest: false,
            }
          : toSettings(rows[0]),
      ),
      Effect.catchTags(storage),
    );

  const list = () =>
    sql`SELECT * FROM fixer_repository_settings ORDER BY repository`.pipe(
      Effect.flatMap(decodeRows),
      Effect.map((rows) => rows.map(toSettings)),
      Effect.catchTags(storage),
    );

  const update = (patch: {
    readonly repository: string;
    readonly pushAutomatically?: boolean;
    readonly resolveAutomatically?: boolean;
    readonly runScriptsOnAnyPullRequest?: boolean;
  }) =>
    Effect.gen(function* () {
      if (!/^[^/\s]+\/[^/\s]+\/[^/\s]+$/.test(patch.repository))
        return yield* new FixerError({ message: "That isn't a repository prkit knows." });
      const current = yield* get(patch.repository);
      const next = {
        ...current,
        ...(patch.pushAutomatically === undefined
          ? {}
          : { pushAutomatically: patch.pushAutomatically }),
        ...(patch.resolveAutomatically === undefined
          ? {}
          : { resolveAutomatically: patch.resolveAutomatically }),
        ...(patch.runScriptsOnAnyPullRequest === undefined
          ? {}
          : { runScriptsOnAnyPullRequest: patch.runScriptsOnAnyPullRequest }),
      };
      yield* sql`
        INSERT INTO fixer_repository_settings
          (repository, push_automatically, resolve_automatically, run_scripts_anywhere)
        VALUES (${next.repository}, ${next.pushAutomatically ? 1 : 0}, ${next.resolveAutomatically ? 1 : 0},
          ${next.runScriptsOnAnyPullRequest ? 1 : 0})
        ON CONFLICT (repository) DO UPDATE SET push_automatically = excluded.push_automatically,
          resolve_automatically = excluded.resolve_automatically,
          run_scripts_anywhere = excluded.run_scripts_anywhere`.pipe(
        Effect.catchTag("SqlError", storage.SqlError),
      );
      yield* Effect.logInfo("Repository fix settings saved").pipe(
        Effect.annotateLogs({
          repository: next.repository,
          pushAutomatically: next.pushAutomatically,
          resolveAutomatically: next.resolveAutomatically,
          runScriptsOnAnyPullRequest: next.runScriptsOnAnyPullRequest,
        }),
      );
      return next;
    });

  /** Repositories whose conflicts the watcher may resolve without a click. */
  const autoResolving = () =>
    list().pipe(
      Effect.map(
        (rows) =>
          new Set(rows.filter((row) => row.resolveAutomatically).map((row) => row.repository)),
      ),
    );

  return { get, list, update, autoResolving };
});

export const layer = Layer.effect(FixerSettingsStore, make);
