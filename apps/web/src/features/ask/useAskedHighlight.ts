import type { DiffFile } from "@prkit/contracts";
import { useMemo } from "react";

import type { DiffComments } from "~/components/diff";

import { askedRange, useAskedLines } from "./askStore";
import type { AskTarget } from "./askTarget";

/**
 * A pull request guide's comment layer with the lines the dock asks about to highlight, as a
 * local guide's diffs do, while the dock is `shown`. They are not the layer's selection, so a
 * comment being written keeps its own lines and its focus behavior.
 */
export function useAskedHighlight(
  target: AskTarget,
  shown: boolean,
  comments: (file: DiffFile) => DiffComments | undefined,
) {
  const lines = useAskedLines(target.key, target.revision);
  return useMemo(
    () =>
      !shown || lines === null
        ? comments
        : (file: DiffFile) => {
            const layer = comments(file);
            return layer && { ...layer, asked: askedRange(lines, file.path) };
          },
    [comments, lines, shown],
  );
}
