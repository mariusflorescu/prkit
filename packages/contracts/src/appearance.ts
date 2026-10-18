import * as Schema from "effect/Schema";

/** `system` follows the OS appearance, live. */
export const ThemePreference = Schema.Literals(["system", "light", "dark"]);
export type ThemePreference = typeof ThemePreference.Type;

/**
 * How prkit looks, stored by the server so a choice survives a relaunch on another port:
 * the theme from Settings > Appearance, and whether Files shows the guide's notes.
 */
export const AppearanceSettings = Schema.Struct({
  theme: ThemePreference,
  guideNotesOnFiles: Schema.Boolean,
});
export type AppearanceSettings = typeof AppearanceSettings.Type;

/** Sets what it names and leaves the rest, so a retry changes nothing. */
export const AppearanceChange = Schema.Struct({
  theme: Schema.optionalKey(ThemePreference),
  guideNotesOnFiles: Schema.optionalKey(Schema.Boolean),
});
export type AppearanceChange = typeof AppearanceChange.Type;

export class AppearanceSettingsError extends Schema.TaggedError<AppearanceSettingsError>()(
  "AppearanceSettingsError",
  { message: Schema.String },
) {}
