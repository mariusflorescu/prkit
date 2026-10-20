import { Button } from "~/components/ui/button";
import { ButtonLabel } from "~/components/ui/button-label";
import { desktopBridge } from "~/lib/desktop";

import { SettingsAlert } from "./SettingsAlert";
import { useCopyServerLog } from "./useCopyServerLog";

/** Settings > About > Server log: what the log is for, and a way to share it. */
export function ServerLog() {
  const copy = useCopyServerLog();
  const showLog = desktopBridge?.showServerLog;
  return (
    <section aria-label="Server log" className="mt-6 space-y-3 border-t border-border/60 pt-4">
      <div>
        <h3 className="text-sm">Server log</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          prkit keeps a log of what its server does, so you can share it when something goes wrong.
          It names your repositories, GitHub accounts and folders on this Mac, never a token or your
          code.
        </p>
      </div>
      {copy.isError && <SettingsAlert message={copy.error.message} retry={() => copy.mutate()} />}
      <div className="flex gap-2">
        {showLog !== undefined && (
          <Button size="sm" variant="outline" onClick={() => showLog()}>
            Show log file
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={copy.isPending}
          aria-busy={copy.isPending}
          onClick={() => copy.mutate()}
        >
          <ButtonLabel
            shown={copy.isPending ? "copying" : "copy"}
            labels={{ copy: "Copy recent log", copying: "Copying…" }}
          />
        </Button>
      </div>
    </section>
  );
}
