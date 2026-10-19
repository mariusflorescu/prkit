import type { ConfigDirProblem } from "@prkit/contracts";
import { Link } from "@tanstack/react-router";

import { Button } from "~/components/ui/button";

/**
 * Says which gh config directory prkit couldn't read and what that hides, above the rows of
 * every account it could. Retry looks into the directories again.
 */
export function ConfigDirNotice({
  problem,
  retry,
  retrying,
}: {
  problem: ConfigDirProblem;
  retry: () => void;
  retrying: boolean;
}) {
  return (
    <div
      role="alert"
      data-config-dir-problem=""
      className="flex flex-wrap items-center gap-2 rounded-md border border-warning/30 bg-warning-surface px-3 py-2 text-xs"
    >
      <p className="min-w-0 flex-1 break-words text-warning-foreground">{problem.message}</p>
      <Link
        to="/settings/accounts"
        className="text-warning-foreground underline underline-offset-2"
      >
        Accounts
      </Link>
      <Button size="sm" variant="outline" disabled={retrying} onClick={retry}>
        {retrying ? "Retrying..." : "Retry"}
      </Button>
    </div>
  );
}
