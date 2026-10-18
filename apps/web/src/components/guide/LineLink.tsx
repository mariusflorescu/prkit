import type { DiffLineRef } from "@prkit/contracts";

export function LineLink({
  at,
  label,
  onOpen,
}: {
  at: DiffLineRef;
  label: string;
  onOpen: ((at: DiffLineRef) => void) | null;
}) {
  if (onOpen === null)
    return (
      <span data-line-link="" title={`${at.path} line ${at.line}`}>
        {label}
      </span>
    );
  const name = `Open ${at.path} line ${at.line}`;
  return (
    <button
      type="button"
      data-line-link=""
      title={name}
      aria-label={name}
      onClick={() => onOpen(at)}
    >
      {label}
    </button>
  );
}
