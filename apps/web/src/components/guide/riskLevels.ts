import { type RiskLevel, SKIPPED_CHAPTER_ID } from "@prkit/contracts";

import type { GuideChapter } from "./types";

/** How carefully to read, in the words the guide shows. Never whether it is safe to merge. */
export const RISK_LEVELS: Record<
  RiskLevel | "not-reviewed",
  { readonly label: string; readonly meaning: string }
> = {
  low: { label: "Low", meaning: "Nothing here needs a careful read." },
  medium: { label: "Medium", meaning: "Some parts need a careful read." },
  high: { label: "High", meaning: "Read this closely." },
  "not-reviewed": {
    label: "Not reviewed",
    meaning: "Your ignore rules skipped these files, so the agent didn't read them.",
  },
};

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** A file's name, or its whole path when another of `paths` has the same name. */
export const fileLabel = (paths: ReadonlyArray<string>) => (path: string) =>
  paths.some((other) => other !== path && basename(other) === basename(path))
    ? path
    : basename(path);

/** A chapter's tag: its own level, or "Not reviewed" on prkit's skipped chapter of a rated guide. */
export const chapterRisk = (
  chapter: GuideChapter,
  rated: boolean,
): RiskLevel | "not-reviewed" | null =>
  chapter.risk?.level ?? (rated && chapter.id === SKIPPED_CHAPTER_ID ? "not-reviewed" : null);
