import type { DiffFile, FileReviewState } from "@prkit/contracts";
import { ListChecksIcon } from "lucide-react";
import { useMemo, useRef } from "react";

import { FileTree } from "~/components/diff";
import { sectionsInView } from "~/components/diff/readingLine";
import { ToolbarIconButton } from "~/components/ToolbarIconButton";
import { Button } from "~/components/ui/button";

import { type FileFilter, filterFiles, isFiltering, NO_FILE_FILTER } from "./fileFilter";
import { FileTreeFilter } from "./FileTreeFilter";

/** The Files tree with its filter. Filtering narrows the tree only, never the diff list. */
export function FilesTreePanel({
  files,
  stateOf,
  filter,
  onFilter,
  activePath,
  onOpen,
  focusRequest,
}: {
  files: ReadonlyArray<DiffFile>;
  /** Null until the reviewed marks are known: there is no "to review" to filter by yet. */
  stateOf: ((file: DiffFile) => FileReviewState) | null;
  filter: FileFilter;
  onFilter: (filter: FileFilter) => void;
  activePath?: string | undefined;
  /** Scrolls to the file's card and focuses it. */
  onOpen: (path: string) => void;
  focusRequest: number;
}) {
  const root = useRef<HTMLDivElement>(null);
  const effective = useMemo(
    () => (stateOf === null ? { ...filter, toReview: false } : filter),
    [filter, stateOf],
  );
  const filtering = isFiltering(effective);
  const shown = useMemo(() => filterFiles(files, effective, stateOf), [files, effective, stateOf]);
  const filterInput = () => root.current?.querySelector<HTMLInputElement>("input");
  const firstRow = () => root.current?.querySelector<HTMLElement>("[data-file-tree-row]");
  const leave = () => {
    const list = root.current?.closest<HTMLElement>("[data-pr-files]");
    const card = list ? sectionsInView(list, "[data-file-diff-card]")[0] : undefined;
    if (card) card.focus({ preventScroll: true });
    else filterInput()?.blur();
  };
  return (
    <div ref={root} data-file-tree-panel="">
      <div className="sticky top-0 z-10 flex items-center gap-1.5 bg-background px-3 pt-3">
        <FileTreeFilter
          text={filter.text}
          onText={(text) => onFilter({ ...filter, text })}
          focusRequest={focusRequest}
          onOpenFirst={() => {
            const first = shown[0];
            if (first !== undefined) onOpen(first.path);
          }}
          onFocusTree={() => firstRow()?.focus()}
          onLeave={leave}
        />
        {stateOf !== null && (
          <ToolbarIconButton
            label="Only files to review"
            pressed={filter.toReview}
            onClick={() => onFilter({ ...filter, toReview: !filter.toReview })}
          >
            <ListChecksIcon />
          </ToolbarIconButton>
        )}
      </div>
      {filtering && shown.length === 0 ? (
        <div role="status" className="flex flex-col items-start gap-2 p-3 text-xs">
          <p className="text-muted-foreground">No files match</p>
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              onFilter(NO_FILE_FILTER);
              filterInput()?.focus();
            }}
          >
            Clear filter
          </Button>
        </div>
      ) : (
        <FileTree
          key={filtering ? "filtered" : "all"}
          files={shown}
          total={files.length}
          order="reading"
          activePath={activePath}
          onSelect={onOpen}
        />
      )}
    </div>
  );
}
