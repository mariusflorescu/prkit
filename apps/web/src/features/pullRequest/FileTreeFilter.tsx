import { SearchIcon, XIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { Button } from "~/components/ui/button";
import { Kbd } from "~/components/ui/kbd";

/** The tree's path filter. It knows nothing of the tree: the panel answers its keys. */
export function FileTreeFilter({
  text,
  onText,
  focusRequest,
  onOpenFirst,
  onFocusTree,
  onLeave,
}: {
  text: string;
  onText: (text: string) => void;
  /** Goes up each time the field is asked for; a value it already saw does nothing. */
  focusRequest: number;
  onOpenFirst: () => void;
  onFocusTree: () => void;
  onLeave: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const seen = useRef(focusRequest);
  useEffect(() => {
    if (seen.current === focusRequest) return;
    seen.current = focusRequest;
    input.current?.focus();
    input.current?.select();
  }, [focusRequest]);
  return (
    <div className="relative min-w-0 flex-1">
      <SearchIcon
        aria-hidden="true"
        className="pointer-events-none absolute top-1.5 left-2 size-3.5 text-muted-foreground"
      />
      <input
        ref={input}
        aria-label="Filter files"
        type="search"
        placeholder="Filter by path"
        autoComplete="off"
        spellCheck={false}
        value={text}
        onChange={(event) => onText(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            onOpenFirst();
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            onFocusTree();
          } else if (event.key === "Escape") {
            event.preventDefault();
            if (text === "") onLeave();
            else onText("");
          }
        }}
        className="h-7 w-full rounded-lg border border-input bg-background pr-8 pl-7 text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24 [&::-webkit-search-cancel-button]:appearance-none"
      />
      <span className="absolute top-1 right-1 flex items-center">
        {text === "" ? (
          <Kbd aria-hidden="true">/</Kbd>
        ) : (
          <Button
            size="icon-tiny"
            variant="ghost-muted"
            aria-label="Clear filter"
            onClick={() => {
              onText("");
              input.current?.focus();
            }}
          >
            <XIcon />
          </Button>
        )}
      </span>
    </div>
  );
}
