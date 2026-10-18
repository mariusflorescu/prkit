import { parseDiffFromFile } from "@pierre/diffs";
import { FileDiff, type FileDiffOptions } from "@pierre/diffs/react";
import { useMemo } from "react";

import { DIFF_THEMES } from "~/components/diff/DiffWorkerPoolProvider";
import { DIFF_CSS } from "~/components/diff/diffStyles";

const options: FileDiffOptions<undefined, undefined> = {
  theme: DIFF_THEMES,
  themeType: "system",
  diffStyle: "unified",
  overflow: "wrap",
  disableFileHeader: true,
  unsafeCSS: DIFF_CSS,
};

// GitHub keeps a description without a final newline. Shown as text, that difference is
// noise: it would mark the last unchanged line as removed and added again.
const asLines = (text: string) => (text === "" || text.endsWith("\n") ? text : `${text}\n`);

/** Exactly what saving changes in the description, as a diff of its Markdown. */
export function DescriptionChanges({ before, after }: { before: string; after: string }) {
  const fileDiff = useMemo(
    () =>
      parseDiffFromFile(
        { name: "description.md", contents: asLines(before) },
        { name: "description.md", contents: asLines(after) },
      ),
    [before, after],
  );
  if (before === after)
    return (
      <p role="status" className="text-xs text-muted-foreground">
        Nothing would change: the description already says this.
      </p>
    );
  return (
    <div data-description-changes="" className="overflow-hidden rounded-lg border border-border">
      <FileDiff fileDiff={fileDiff} options={options} className="block [color-scheme:inherit]" />
    </div>
  );
}
