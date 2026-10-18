import { type KeyboardEvent, useRef } from "react";

import type { RailTick } from "./railTicks";
import { ChapterRailTick } from "./ChapterRailTick";
import { useReadingChapter } from "./useReadingChapter";

/** A column of ticks in the guide's left gutter, one per chapter: where you are, and what you ticked. */
export function ChapterRail({
  ticks,
  total,
  pinned,
  onChapter,
}: {
  ticks: ReadonlyArray<RailTick>;
  /** Null while a draft is still adding chapters. */
  total: number | null;
  pinned: string | null;
  onChapter: (id: string) => void;
}) {
  const railRef = useRef<HTMLElement>(null);
  const current = useReadingChapter(railRef, pinned);
  const tabStop = ticks.some((tick) => tick.id === current) ? current : ticks[0]?.id;

  const onKeyDown = (event: KeyboardEvent<HTMLOListElement>) => {
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>("[data-rail-tick]"),
    );
    const at = buttons.findIndex((button) => button === event.target);
    const moves: Record<string, number> = {
      ArrowDown: at + 1,
      ArrowUp: at - 1,
      Home: 0,
      End: buttons.length - 1,
    };
    const to = moves[event.key];
    if (to === undefined || at < 0) return;
    event.preventDefault();
    buttons[Math.min(Math.max(to, 0), buttons.length - 1)]?.focus();
  };

  return (
    <nav ref={railRef} data-chapter-rail="" aria-label="Chapters">
      <ol onKeyDown={onKeyDown}>
        {ticks.map((tick) => (
          <li key={tick.id} data-gap={tick.gapBefore ? "" : undefined}>
            <ChapterRailTick
              tick={tick}
              total={total}
              current={tick.id === current}
              tabStop={tick.id === tabStop}
              onChapter={onChapter}
            />
          </li>
        ))}
      </ol>
    </nav>
  );
}
