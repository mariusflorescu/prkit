import {
  type AppearanceSettings,
  AppearanceSettingsError,
  ThemePreference,
} from "@prkit/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const THEME = "appearance.theme";

const SettingRow = Schema.Struct({ value: Schema.String });
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(SettingRow));
const ThemeJson = Schema.fromJsonString(ThemePreference);

/** Settings > Appearance, stored by the server so it survives a relaunch on another port. */
export class AppearanceStore extends Context.Service<
  AppearanceStore,
  Effect.Success<typeof make>
>()("@prkit/server/appearance/AppearanceStore") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const failure = (message: string) => () => Effect.fail(new AppearanceSettingsError({ message }));

  const get = () =>
    Effect.gen(function* () {
      const rows = yield* sql`SELECT value FROM settings WHERE key = ${THEME}`.pipe(
        Effect.flatMap(decodeRows),
      );
      const stored = rows[0]?.value;
      const theme: ThemePreference =
        stored === undefined ? "system" : yield* Schema.decodeEffect(ThemeJson)(stored);
      const settings: AppearanceSettings = { theme };
      return settings;
    }).pipe(
      Effect.catchTags({
        SqlError: failure("prkit couldn't read your appearance. Try again."),
        SchemaError: failure("prkit read a damaged appearance setting. Choose it again."),
      }),
    );

  /** The theme for first paint. A setting that can't be read must not keep the window from opening. */
  const current = () =>
    get().pipe(
      Effect.map((settings) => settings.theme),
      Effect.catchTag("AppearanceSettingsError", (error) =>
        Effect.logWarning(error.message).pipe(Effect.as<ThemePreference>("system")),
      ),
    );

  const update = (theme: ThemePreference) =>
    Effect.gen(function* () {
      const value = yield* Schema.encodeEffect(ThemeJson)(theme);
      yield* sql`INSERT INTO settings (key, value) VALUES (${THEME}, ${value})
        ON CONFLICT (key) DO UPDATE SET value = excluded.value`;
      return yield* get();
    }).pipe(
      Effect.catchTags({
        SqlError: failure("prkit couldn't save your appearance. Try again."),
        SchemaError: failure("prkit couldn't save that appearance. Try again."),
      }),
    );

  return { get, current, update };
});

export const layer = Layer.effect(AppearanceStore, make);
