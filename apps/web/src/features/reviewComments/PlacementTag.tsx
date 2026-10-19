/** The tag on a comment whose code moved, or whose lines are no longer in the diff. */
export function PlacementTag({ moved }: { moved: boolean }) {
  return (
    <span className="rounded border border-border/60 px-1 text-3xs">
      {moved ? "Moved" : "Outdated"}
    </span>
  );
}
