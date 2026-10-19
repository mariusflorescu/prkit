import type { ConfigDirProblem } from "@prkit/contracts";
import { FolderXIcon } from "lucide-react";

import { Button } from "~/components/ui/button";

/** A gh config directory prkit couldn't read and holds no account for, among the accounts. */
export function ConfigDirProblemRow({
  problem,
  removable,
  removing,
  remove,
  retry,
  retrying,
}: {
  problem: ConfigDirProblem;
  removable: boolean;
  removing: boolean;
  remove: (path: string) => void;
  retry: () => void;
  retrying: boolean;
}) {
  return (
    <li className="flex min-h-20 items-start gap-3 border-b border-border/60 py-4 last:border-0">
      <span
        aria-hidden="true"
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
      >
        <FolderXIcon className="size-4" />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-sm">gh config directory</span>
          <span className="text-xs text-error-foreground">Needs attention</span>
        </div>
        <div role="alert" className="space-y-2 pt-1 text-xs text-error-foreground">
          <p className="break-words">{problem.message}</p>
          <Button size="sm" variant="outline" disabled={retrying} onClick={retry}>
            Retry
          </Button>
        </div>
      </div>
      {removable && (
        <Button
          size="sm"
          variant="ghost-destructive"
          disabled={removing}
          onClick={() => remove(problem.configDir)}
        >
          Remove
        </Button>
      )}
    </li>
  );
}
