import { loginOf, type RepositoryList } from "@prkit/contracts";

import { Button } from "~/components/ui/button";
import { ComboboxStatus } from "~/components/ui/combobox";
import { Skeleton } from "~/components/ui/skeleton";

/**
 * What the repository filter says above its list: that it is still reading, that it
 * couldn't, or which accounts' lists are old or cut short.
 */
export function RepositoryListStatus({
  loading,
  error,
  rows,
  retry,
}: {
  loading: boolean;
  error: string | null;
  rows: RepositoryList["accounts"];
  retry: () => void;
}) {
  if (loading)
    return (
      <div aria-busy="true" aria-label="Loading repositories" className="space-y-1.5 px-3 pt-2">
        <Skeleton className="h-3.5 w-40" />
        <Skeleton className="h-3.5 w-32" />
      </div>
    );
  if (error !== null)
    return (
      <div
        role="alert"
        className="flex items-center gap-2 px-3 pt-2 text-2xs text-error-foreground"
      >
        <span className="min-w-0 flex-1">Couldn't list your repositories. {error}</span>
        <Button variant="outline" size="micro" onClick={retry}>
          Retry
        </Button>
      </div>
    );
  return rows.map((row) =>
    row.problem !== null ? (
      <ComboboxStatus key={row.accountId} role="status">
        {loginOf(row.accountId)}: {row.problem.message}
      </ComboboxStatus>
    ) : row.total !== null ? (
      <ComboboxStatus key={row.accountId} role="status">
        {loginOf(row.accountId)}: the first {row.count.toLocaleString()} of{" "}
        {row.total.toLocaleString()} repositories.
      </ComboboxStatus>
    ) : null,
  );
}
