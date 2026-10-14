import type { ThemePreference } from "@prkit/contracts";

export type PreviewTone = "light" | "dark";

/** The cards in Settings > Appearance. `system` previews both tones, split down the middle. */
export const THEME_OPTIONS = [
  { value: "system", label: "System", tones: ["light", "dark"] },
  { value: "light", label: "Light", tones: ["light"] },
  { value: "dark", label: "Dark", tones: ["dark"] },
] as const satisfies ReadonlyArray<{
  value: ThemePreference;
  label: string;
  tones: ReadonlyArray<PreviewTone>;
}>;
