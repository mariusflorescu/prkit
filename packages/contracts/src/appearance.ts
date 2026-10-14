import * as Schema from "effect/Schema";

/** `system` follows the OS appearance, live. */
export const ThemePreference = Schema.Literals(["system", "light", "dark"]);
export type ThemePreference = typeof ThemePreference.Type;

/** Settings > Appearance, stored by the server so the choice survives a relaunch on another port. */
export const AppearanceSettings = Schema.Struct({ theme: ThemePreference });
export type AppearanceSettings = typeof AppearanceSettings.Type;

export class AppearanceSettingsError extends Schema.TaggedError<AppearanceSettingsError>()(
  "AppearanceSettingsError",
  { message: Schema.String },
) {}
