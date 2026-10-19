import {
  AccountId,
  AgentSelection,
  type GuideSettings,
  GuideSettingsError,
} from "@prkit/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const DEFAULT_AGENT = "guides.defaultAgent";
const AUTO_ACCOUNTS = "guides.autoAccounts";

const SettingRow = Schema.Struct({ key: Schema.String, value: Schema.String });
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(SettingRow));
const DefaultAgentJson = Schema.fromJsonString(Schema.NullOr(AgentSelection));
const AutoAccountsJson = Schema.fromJsonString(Schema.Array(AccountId));

/** Settings > Guides, stored by the server so they survive a relaunch on another port. */
export class GuideSettingsStore extends Context.Service<
  GuideSettingsStore,
  Effect.Success<typeof make>
>()("@prkit/server/reviews/GuideSettingsStore") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  /** Signals every saved change, so auto mode can act on a new setting at once. */
  const changes = yield* PubSub.unbounded<void>();

  const failure = (message: string) => () => Effect.fail(new GuideSettingsError({ message }));

  const get = () =>
    Effect.gen(function* () {
      const rows =
        yield* sql`SELECT key, value FROM settings WHERE key IN ${sql.in([DEFAULT_AGENT, AUTO_ACCOUNTS])}`.pipe(
          Effect.flatMap(decodeRows),
        );
      const value = (key: string) => rows.find((row) => row.key === key)?.value;
      const defaultAgent = value(DEFAULT_AGENT);
      const autoAccounts = value(AUTO_ACCOUNTS);
      const settings: GuideSettings = {
        defaultAgent:
          defaultAgent === undefined
            ? null
            : yield* Schema.decodeEffect(DefaultAgentJson)(defaultAgent),
        autoAccounts:
          autoAccounts === undefined
            ? []
            : yield* Schema.decodeEffect(AutoAccountsJson)(autoAccounts),
      };
      return settings;
    }).pipe(
      Effect.catchTags({
        SqlError: failure("prkit couldn't read your guide settings."),
        SchemaError: failure("prkit read damaged guide settings. Choose them again."),
      }),
    );

  const update = (patch: {
    readonly defaultAgent?: GuideSettings["defaultAgent"];
    readonly autoAccounts?: GuideSettings["autoAccounts"];
  }) =>
    Effect.gen(function* () {
      const writes: Array<readonly [string, string]> = [];
      if (patch.defaultAgent !== undefined)
        writes.push([
          DEFAULT_AGENT,
          yield* Schema.encodeEffect(DefaultAgentJson)(patch.defaultAgent),
        ]);
      if (patch.autoAccounts !== undefined)
        writes.push([
          AUTO_ACCOUNTS,
          yield* Schema.encodeEffect(AutoAccountsJson)([...new Set(patch.autoAccounts)]),
        ]);
      yield* sql.withTransaction(
        Effect.forEach(
          writes,
          ([key, value]) =>
            sql`INSERT INTO settings (key, value) VALUES (${key}, ${value})
              ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
          { discard: true },
        ),
      );
      yield* PubSub.publish(changes, undefined);
      return yield* get();
    }).pipe(
      Effect.catchTags({
        SqlError: failure("prkit couldn't save your guide settings."),
        SchemaError: failure("prkit couldn't save those guide settings."),
      }),
    );

  return { get, update, changes };
});

export const layer = Layer.effect(GuideSettingsStore, make);
