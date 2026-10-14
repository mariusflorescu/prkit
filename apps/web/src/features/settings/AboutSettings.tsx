import { BrandMark } from "~/components/BrandMark";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { useAppInfo } from "~/hooks/useAppInfo";

import { SettingsSection } from "./SettingsSection";

/** Settings > About: the lockup, the tagline, the version, and the build when this is one. */
export function AboutSettings() {
  const appInfo = useAppInfo();
  return (
    <SettingsSection title="About prkit">
      <BrandMark wordmark className="mt-5 h-7 w-auto text-foreground" />
      <p className="mt-4 text-sm text-muted-foreground">
        Stay in the loop when agents write the code.
      </p>
      <div className="mt-3 flex h-7 items-center gap-3 text-xs text-muted-foreground">
        {appInfo.isPending ? (
          <Skeleton aria-busy="true" aria-label="Loading version" className="h-3 w-24" />
        ) : appInfo.isError ? (
          <div role="alert" className="flex items-center gap-3 text-error-foreground">
            <span>Couldn't read the version: {appInfo.error.message}</span>
            <Button
              size="xs"
              variant="outline"
              disabled={appInfo.isFetching}
              onClick={() => void appInfo.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : (
          <>
            <span>
              Version <span className="font-mono tabular-nums">{appInfo.data.version}</span>
            </span>
            {appInfo.data.buildId !== "development" && (
              <span>
                Build <span className="font-mono tabular-nums">{appInfo.data.buildId}</span>
              </span>
            )}
          </>
        )}
      </div>
    </SettingsSection>
  );
}
