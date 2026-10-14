import type { StackLayer } from "@prkit/contracts";
import { BookOpenTextIcon } from "lucide-react";

import { pullRequestState } from "~/lib/pullRequestState";
import { cn } from "~/lib/utils";

import { LAYER_GUIDE_LABELS, type LayerGuide } from "./stackPresentation";

/** One layer of the stack strip: its state, number, title and guide. */
export function StackLayerButton({
  layer,
  size,
  current,
  guide,
  onOpen,
}: {
  layer: StackLayer;
  size: number;
  current: boolean;
  guide: LayerGuide;
  onOpen: () => void;
}) {
  const state = pullRequestState(layer);
  return (
    <button
      type="button"
      aria-current={current ? "page" : undefined}
      aria-label={`Layer ${layer.position} of ${size}: #${layer.number} ${layer.title}, ${state.label}, ${LAYER_GUIDE_LABELS[guide]}`}
      data-stack-layer={layer.number}
      data-layer-guide={guide}
      onClick={onOpen}
      className={cn(
        "flex h-7 max-w-64 min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        current
          ? "bg-accent text-foreground ring-1 ring-border"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      <span className="font-mono text-3xs tabular-nums text-muted-foreground/70">
        {layer.position}
      </span>
      <state.Icon aria-hidden className={cn("size-3.5 shrink-0", state.tone)} />
      <span className="shrink-0 font-mono text-2xs">#{layer.number}</span>
      <span className="min-w-0 truncate">{layer.title}</span>
      {guide !== "none" && (
        <BookOpenTextIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0",
            guide === "ready" ? "text-success-foreground" : "text-muted-foreground/60",
          )}
        />
      )}
    </button>
  );
}
