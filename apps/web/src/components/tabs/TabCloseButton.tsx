import type { ReactNode } from "react";
import { XIcon } from "lucide-react";

export function TabCloseButton({
  children,
  label,
  onClose,
}: {
  children: ReactNode;
  label: string;
  onClose: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      className="relative flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onClose();
      }}
    >
      <span className="flex size-3 items-center justify-center group-hover/tab:hidden group-focus-within/tab:hidden">
        {children}
      </span>
      <XIcon
        aria-hidden="true"
        className="hidden size-3 group-hover/tab:block group-focus-within/tab:block"
      />
    </button>
  );
}
