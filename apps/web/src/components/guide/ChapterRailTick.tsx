import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { tickLabel, tickSummary, type RailTick } from "./railTicks";

export function ChapterRailTick({
  tick,
  total,
  current,
  tabStop,
  onChapter,
}: {
  tick: RailTick;
  /** Null while a draft is still adding chapters. */
  total: number | null;
  current: boolean;
  tabStop: boolean;
  onChapter: (id: string) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-rail-tick=""
            data-state={tick.state}
            data-quiet={tick.quiet || undefined}
            aria-label={tickLabel(tick, total)}
            aria-current={current ? "location" : undefined}
            tabIndex={tabStop ? 0 : -1}
            onClick={() => onChapter(tick.id)}
          />
        }
      >
        <span data-rail-mark="" data-risk={tick.risk ?? undefined} />
        <span data-rail-bar="" />
      </TooltipTrigger>
      <TooltipPopup side="right">
        <span className="block">
          <span className="mr-2 font-mono">{String(tick.index + 1).padStart(2, "0")}</span>
          {tick.title}
        </span>
        <span className="block text-muted-foreground">{tickSummary(tick)}</span>
      </TooltipPopup>
    </Tooltip>
  );
}
