import { DiffBody } from "./DiffBody";
import { DiffSkeleton } from "./DiffSkeleton";
import { useDiffPrefs } from "./diffPrefs";
import { estimateDiffHeight } from "./fileDiff";
import { useDeferredMount } from "./useDeferredMount";
import type { ComponentProps } from "react";

export function LazyDiffBody(props: ComponentProps<typeof DiffBody>) {
  const diffStyle = useDiffPrefs((state) => state.diffStyle);
  const { ref, ready } = useDeferredMount();
  const height = estimateDiffHeight(
    props.file,
    diffStyle,
    props.annotations.length + (props.comments?.pins.length ?? 0),
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
