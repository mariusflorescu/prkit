import { Button } from "~/components/ui/button";

import { useCursorInstall } from "./useCursorInstall";

const TERMS = "https://cursor.com/terms-of-service";

/**
 * Installs Cursor support on request: prkit doesn't ship Cursor's SDK, it downloads the exact
 * version it was built with from npm and checks every file, then the agent can sign in.
 */
export function CursorInstall() {
  const { state, start } = useCursorInstall();
  return (
    <div className="space-y-2 pt-1">
      <p className="text-xs text-muted-foreground">
        prkit downloads Cursor's SDK from npm and checks each file before using it. Cursor's SDK
        isn't open source: using it means agreeing to{" "}
        <a href={TERMS} target="_blank" rel="noreferrer" className="underline">
          Cursor's Terms of Service
        </a>
        .
      </p>
      {state._tag === "idle" && (
        <Button size="xs" onClick={start}>
          Install Cursor support
        </Button>
      )}
      {state._tag === "installing" && (
        <p
          role="status"
          aria-label="Installing Cursor support"
          aria-busy="true"
          className="text-xs tabular-nums text-muted-foreground"
        >
          {state.progress === null || state.progress.name === null
            ? "Installing Cursor support…"
            : `Downloading ${state.progress.name} (${state.progress.done + 1} of ${state.progress.total})…`}
        </p>
      )}
      {state._tag === "failed" && (
        <span
          role="alert"
          className="flex flex-wrap items-center gap-2 text-xs text-error-foreground"
        >
          {state.message}
          <Button size="xs" variant="outline" onClick={start}>
            Try again
          </Button>
        </span>
      )}
    </div>
  );
}
