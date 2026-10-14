import { RotateCwIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { useAppInfo } from "~/hooks/useAppInfo";

const startedAtFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/** Proves the UI -> WebSocket -> server path: shows what `app.info` returned. */
export function AppInfoFooter() {
  const appInfo = useAppInfo();

  if (appInfo.isPending) {
    return (
      <footer
        aria-busy="true"
        aria-label="Loading server info"
        className="flex h-9 items-center px-(--workspace-gutter-start)"
      >
        <Skeleton className="h-3 w-72" />
      </footer>
    );
  }

  if (appInfo.isError) {
    return (
      <footer
        className="flex h-9 items-center gap-2 px-(--workspace-gutter-start) text-error-foreground text-xs"
        role="alert"
      >
        <span className="min-w-0 truncate">{appInfo.error.message}</span>
        <Button
          disabled={appInfo.isFetching}
          onClick={() => appInfo.refetch()}
          size="xs"
          variant="outline"
        >
          <RotateCwIcon />
          Retry
        </Button>
      </footer>
    );
  }

  const { version, home, startedAt } = appInfo.data;
  return (
    <footer
      className="flex h-9 items-center gap-1.5 px-(--workspace-gutter-start) text-muted-foreground text-xs"
      data-testid="app-info"
    >
      <span>prkit {version}</span>
      <span aria-hidden="true">·</span>
      <span className="min-w-0 truncate font-mono">{home}</span>
      <span aria-hidden="true">·</span>
      <span>started {startedAtFormat.format(new Date(startedAt))}</span>
    </footer>
  );
}
