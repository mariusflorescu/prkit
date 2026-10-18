/** A guide being written, as a ring that fills only when a file is read or a chapter is written. */
export function TabProgressRing({ filled }: { filled: number }) {
  return (
    <svg viewBox="0 0 16 16" className="size-3 text-muted-foreground" data-guide-progress={filled}>
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        opacity="0.25"
      />
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        pathLength="100"
        strokeDasharray={`${Math.max(4, filled)} 100`}
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}
