const widths = [62, 78, 45, 88, 54, 70, 38, 82];

export function DiffSkeleton({ lines = 8 }: { lines?: number }) {
  return (
    <div data-diff-skeleton="" role="status" aria-label="Loading diff" aria-busy="true">
      {Array.from({ length: Math.max(3, Math.min(lines, 14)) }, (_, index) => (
        <div key={index} style={{ width: `${widths[index % widths.length]}%` }} />
      ))}
    </div>
  );
}
