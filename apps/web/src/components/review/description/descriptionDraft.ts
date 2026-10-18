import { type NormalizedGuide, SKIPPED_CHAPTER_ID } from "@prkit/contracts";

// Hidden on GitHub. They let a later update replace the section instead of adding a second one.
const START = "<!-- prkit guide -->";
const END = "<!-- /prkit guide -->";

export type DescriptionMode = "section" | "replace";

/** The accepted guide as a description section: what changed, how, and what to read in order. */
const guideSection = (guide: NormalizedGuide) =>
  [
    START,
    "## What changed",
    "",
    ...guide.summary.flatMap((paragraph) => [paragraph, ""]),
    ...(guide.steps.length === 0
      ? []
      : ["### How it works", "", ...guide.steps.map((step, index) => `${index + 1}. ${step}`), ""]),
    "### Reading order",
    "",
    ...guide.chapters
      .filter((chapter) => chapter.id !== SKIPPED_CHAPTER_ID)
      .map((chapter, index) => `${index + 1}. ${chapter.title}`),
    END,
  ].join("\n");

/**
 * The description drafted from the guide. `section` keeps the author's text and adds the
 * guide's section, or puts it back where an earlier update left it; `replace` is the
 * section alone.
 */
export const draftDescription = (
  current: string,
  guide: NormalizedGuide,
  mode: DescriptionMode,
) => {
  const section = guideSection(guide);
  if (mode === "replace" || current.trim() === "") return section;
  const start = current.indexOf(START);
  const end = start === -1 ? -1 : current.indexOf(END, start);
  if (end !== -1) return current.slice(0, start) + section + current.slice(end + END.length);
  return `${current.trimEnd()}\n\n${section}`;
};
