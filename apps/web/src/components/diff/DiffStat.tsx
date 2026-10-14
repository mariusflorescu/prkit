export function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span data-diff-stat="" aria-label={`${additions} added, ${deletions} deleted lines`}>
      <span>+{additions.toLocaleString()}</span>
      <span>-{deletions.toLocaleString()}</span>
    </span>
  );
}
