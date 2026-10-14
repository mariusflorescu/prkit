import type { AttemptConfig } from "@prkit/contracts";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * "Written with 2 focus areas · skipped 7 files" for the status bar. Guidance is in the
 * popover; the bar stays short enough to sit next to the revision controls.
 */
export const revisionSettingsText = (config: AttemptConfig) => {
  const areas = config.focusAreas.filter((area) => area.active).length;
  const guided = config.guidance.some((block) => block.replacedBy === null);
  const written =
    areas > 0
      ? `Written with ${plural(areas, "focus area")}`
      : guided
        ? "Written with guidance"
        : "Written without guide settings";
  return config.skipped.length === 0
    ? written
    : `${written} · skipped ${plural(config.skipped.length, "file")}`;
};
