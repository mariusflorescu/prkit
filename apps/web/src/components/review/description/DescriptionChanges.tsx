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

/** Exactly what saving changes in the description, as a diff of its Markdown. */
export function DescriptionChanges({ before, after }: { before: string; after: string }) {
  const fileDiff = useMemo(
    () =>
      parseDiffFromFile(
        { name: "description.md", contents: before },
        { name: "description.md", contents: after },
      ),
    [before, after],
  );
  if (before === after)
    return (
      <p role="status" data-description-unchanged="">
        Nothing would change: the description already says this.
      </p>
    );
  return (
    <div data-description-changes="">
      <FileDiff fileDiff={fileDiff} options={options} className="block [color-scheme:inherit]" />
    </div>
  );
}
