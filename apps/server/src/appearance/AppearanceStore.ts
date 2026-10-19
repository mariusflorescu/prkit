import {
  type AppearanceChange,
  type AppearanceSettings,
  AppearanceSettingsError,
  ThemePreference,
} from "@prkit/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const THEME = "appearance.theme";
const GUIDE_NOTES = "appearance.guideNotesOnFiles";

const SettingRow = Schema.Struct({ key: Schema.String, value: Schema.String });
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(SettingRow));
const ThemeJson = Schema.fromJsonString(ThemePreference);
const NotesJson = Schema.fromJsonString(Schema.Boolean);

/**
 * The theme from Settings > Appearance and whether Files shows the guide's notes, stored by
 * the server so they survive a relaunch on another port.
 */
export class AppearanceStore extends Context.Service<
  AppearanceStore,
  Effect.Success<typeof make>
>()("@prkit/server/appearance/AppearanceStore") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const failure = (message: string) => () => Effect.fail(new AppearanceSettingsError({ message }));

  const get = () =>
    Effect.gen(function* () {
      const rows = yield* sql`SELECT key, value FROM settings
        WHERE key IN ${sql.in([THEME, GUIDE_NOTES])}`.pipe(Effect.flatMap(decodeRows));
      const stored = (key: string) => rows.find((row) => row.key === key)?.value;
      const storedTheme = stored(THEME);
      const theme: ThemePreference =
        storedTheme === undefined ? "system" : yield* Schema.decodeEffect(ThemeJson)(storedTheme);
      const storedNotes = stored(GUIDE_NOTES);
      // A damaged choice shows the notes instead of failing the theme along with it.
      const guideNotesOnFiles =
        storedNotes === undefined ||
        Option.getOrElse(Schema.decodeOption(NotesJson)(storedNotes), () => true);
      const settings: AppearanceSettings = { theme, guideNotesOnFiles };
      return settings;
    }).pipe(
      Effect.catchTags({
        SqlError: failure("prkit couldn't read your appearance."),
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

  const write = (key: string, value: string) =>
    sql`INSERT INTO settings (key, value) VALUES (${key}, ${value})
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`;

  const update = (change: AppearanceChange) =>
    Effect.gen(function* () {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          if (change.theme !== undefined)
            yield* write(THEME, yield* Schema.encodeEffect(ThemeJson)(change.theme));
          if (change.guideNotesOnFiles !== undefined)
            yield* write(
              GUIDE_NOTES,
              yield* Schema.encodeEffect(NotesJson)(change.guideNotesOnFiles),
            );
        }),
      );
      return yield* get();
    }).pipe(
      Effect.catchTags({
        SqlError: failure("prkit couldn't save your appearance."),
        SchemaError: failure("prkit couldn't save that appearance."),
      }),
    );

  return { get, current, update };
});

export const layer = Layer.effect(AppearanceStore, make);
