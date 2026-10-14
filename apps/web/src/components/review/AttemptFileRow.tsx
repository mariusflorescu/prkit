import type { AttemptFile } from "@prkit/contracts";
import { CheckIcon, CircleIcon } from "lucide-react";
import type { ReactNode } from "react";

import { DiffStat } from "~/components/diff/DiffStat";

/** A changed file as the agent works through it: read state, its note, and a way into its diff. */
export function AttemptFileRow({
  file,
  open,
  onToggle,
  diff,
}: {
  file: AttemptFile;
  open: boolean;
  onToggle: () => void;
  diff: ReactNode;
}) {
  const state =
    file.read === "read" ? "read" : file.read === "reading" ? "being read" : "not read yet";
  return (
    <li
      data-attempt-file={file.path}
      data-read={file.read}
      className="border-t border-border/50 first:border-t-0"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${file.path}, ${state}${file.note === null ? "" : `: ${file.note}`}`}
        onClick={onToggle}
        className="grid w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-2.5 px-1 py-2 text-left transition-colors duration-150 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span aria-hidden="true" className="mt-0.5 flex size-4 items-center justify-center">
          {file.read === "read" ? (
            <CheckIcon className="size-3.5 text-success-foreground" />
          ) : file.read === "reading" ? (
            <span className="size-2 rounded-full bg-primary" />
          ) : (
            <CircleIcon className="size-3 text-muted-foreground/50" />
          )}
        </span>
        <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-mono text-xs">{file.path}</span>
            <DiffStat additions={file.additions} deletions={file.deletions} />
          </span>
          {(file.note !== null || file.read === "reading") && (
            <span
              data-file-note={file.note === null ? undefined : ""}
              className="mt-0.5 block text-pretty text-xs text-muted-foreground"
            >
              {file.note ?? "Reading…"}
            </span>
          )}
        </span>
        <span className="text-xs text-muted-foreground">{open ? "Close" : "Open"}</span>
      </button>
      {open && <div className="pb-3">{diff}</div>}
    </li>
  );
}
