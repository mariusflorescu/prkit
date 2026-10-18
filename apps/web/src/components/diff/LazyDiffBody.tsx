import { DiffBody } from "./DiffBody";
import { DiffSkeleton } from "./DiffSkeleton";
import { useFileMoves, useFileReveal } from "./diffListContext";
import { useDiffPrefs } from "./diffPrefs";
import { estimateDiffHeight } from "./fileDiff";
import { useDeferredMount } from "./useDeferredMount";
import type { ComponentProps } from "react";

export function LazyDiffBody(props: ComponentProps<typeof DiffBody>) {
  const diffStyle = useDiffPrefs((state) => state.diffStyle);
  const moves = useFileMoves(props.file.path);
  const reveal = useFileReveal(props.file.path);
  const { ref, ready } = useDeferredMount(reveal !== null);
  const height = estimateDiffHeight(
    props.file,
    diffStyle,
    props.annotations.length + (props.comments?.pins.length ?? 0),
    moves.cut.length + moves.landed.length,
  );
  return (
    <div
      ref={ref}
      data-diff-slot=""
      style={{ containIntrinsicSize: `auto ${height}px`, minHeight: ready ? undefined : height }}
    >
      {ready ? (
        <DiffBody {...props} />
      ) : (
        <DiffSkeleton lines={props.file.additions + props.file.deletions + 6} />
      )}
    </div>
  );
}
