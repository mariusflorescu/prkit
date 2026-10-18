import { readingLine } from "~/components/diff/readingLine";

const SLOP = 4;

export type ReadingPosition = {
  /** Every chapter in the guide, pending ones included, top first. */
  readonly chapters: ReadonlyArray<HTMLElement>;
  /** The last chapter that has reached the reading line; -1 while the overview is being read. */
  readonly index: number;
  /** That chapter starts at the line, so `k` goes to the one before it instead of back to it. */
  readonly aligned: boolean;
};

/**
 * Where the reader is, for the chapter rail and for j and k.
 *
 * A chapter jumped to cannot reach the line when the guide ends first, so while the scroller
 * is at its end the `pinned` chapter (the last one jumped to) stands for the position,
 * and counts as aligned: `k` steps back from it, `j` on to the next.
 */
export const readingPosition = (
  viewport: HTMLElement,
  pinned: string | null,
): ReadingPosition | null => {
  const line = readingLine(viewport);
  if (line === null) return null;
  const chapters = Array.from(viewport.querySelectorAll<HTMLElement>("[data-guide-chapter]"));
  // A chapter scrolled to sits its scroll margin below the reading line.
  const margin = chapters[0] ? Number.parseFloat(getComputedStyle(chapters[0]).scrollMarginTop) : 0;
  const top = line.top + (Number.isNaN(margin) ? 0 : margin);
  const tops = chapters.map((chapter) => chapter.getBoundingClientRect().top);
  const reached = tops.findLastIndex((chapterTop) => chapterTop <= top + SLOP);
  const { scroller } = line;
  const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
  const pin = pinned === null ? -1 : chapters.findIndex((c) => c.dataset.chapterId === pinned);
  if (atEnd && pin > reached) return { chapters, index: pin, aligned: true };
  const start = tops[reached];
  return { chapters, index: reached, aligned: start !== undefined && start >= top - SLOP };
};
