import { capture, type DiffFile, diffRows } from "@prkit/contracts";
import { useMemo } from "react";

import type { DiffAsk } from "~/components/diff";
import { toastManager } from "~/components/ui/toast";

import { askAbout, useAskedLines } from "./askStore";
import type { AskTarget } from "./askTarget";

/**
 * Picking lines in a chapter's diff as a way into Ask, as a function from a file to its layer
 * (none for a binary or too large file). The lines highlighted are the dock's own choice when
 * it asks about lines of this file on this revision, so clearing the chip or asking about
 * something else takes the highlight away.
 */
export function useLineAsks(target: AskTarget, headSha: string) {
  const { key, revision } = target;
  const lines = useAskedLines(key, revision);
  return useMemo(
    () =>
      (file: DiffFile): DiffAsk | undefined => {
        if (file.patch._tag !== "text") return undefined;
        const { patch } = file.patch;
        return {
          kind: "ask",
          selection: lines?.path === file.path ? { start: lines.start, end: lines.end } : null,
          onSelect: (range) => {
            const placement = capture(diffRows(patch), { path: file.path, ...range }, headSha);
            if (placement === null)
              // A drag from the Ask button reports twice, so the toast has an id of its own.
              toastManager.add({
                id: "ask-lines-outside-hunk",
                type: "warning",
                title: "Pick lines inside one part of the diff",
              });
            else askAbout(key, { scope: { _tag: "lines", anchor: placement.anchor }, revision });
          },
        };
      },
    [lines, key, revision, headSha],
  );
}
