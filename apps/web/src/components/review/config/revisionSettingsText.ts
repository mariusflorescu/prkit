import type { AttemptConfig } from "@prkit/contracts";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * "Written with 2 focus areas · 3 look-closely paths · skipped 7 files" for the status bar.
 * Guidance is in the popover; the bar stays short enough to sit next to the revision controls.
 */
export const revisionSettingsText = (config: AttemptConfig) => {
  const areas = config.focusAreas.filter((area) => area.active).length;
  const guided = config.guidance.some((block) => block.replacedBy === null);
  const close = config.sensitive.filter((rule) => rule.active).length;
  const settings = [
    ...(areas > 0 ? [plural(areas, "focus area")] : guided ? ["guidance"] : []),
    ...(close > 0 ? [plural(close, "look-closely path")] : []),
  ];
  const written =
    settings.length === 0
      ? "Written without guide settings"
      : `Written with ${settings.join(" · ")}`;
  return config.skipped.length === 0
    ? written
    : `${written} · skipped ${plural(config.skipped.length, "file")}`;
};
