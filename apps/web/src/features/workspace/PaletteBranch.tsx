// Characters kept at the end, so a long branch loses its middle and keeps what tells it apart.
const TAIL = 12;

/**
 * A branch name that truncates from the middle when the row is short of room. The two halves
 * are flex items, which assistive tech would read as two words, so it reads the whole name.
 */
export function PaletteBranch({ name }: { name: string }) {
  const cut = Math.max(0, name.length - TAIL);
  return (
    <span title={name} className="flex min-w-0 font-mono text-2xs">
      <span aria-hidden className="truncate">
        {name.slice(0, cut)}
      </span>
      <span aria-hidden className="shrink-0">
        {name.slice(cut)}
      </span>
      <span className="sr-only">{name}</span>
    </span>
  );
}
