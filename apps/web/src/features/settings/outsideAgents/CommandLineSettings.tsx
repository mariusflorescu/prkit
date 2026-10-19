import { useQuery } from "@tanstack/react-query";
import type { OutsideAccess } from "@prkit/contracts";

import { ListError } from "~/components/ListError";
import { ListSkeleton } from "~/components/ListSkeleton";
import { Button } from "~/components/ui/button";
import { ButtonLabel } from "~/components/ui/button-label";
import { FixCommand } from "~/features/settings/agents/FixCommand";
import { FailedSave } from "~/features/settings/FailedSave";
import { SettingsAlert } from "~/features/settings/SettingsAlert";

import { cliInstallQuery } from "~/rpc/cliInstall";
import { useCliInstall } from "./useCliInstall";

export function CommandLineSettings({
  enabled,
  access,
}: {
  enabled: boolean;
  access: OutsideAccess;
}) {
  const state = useQuery(cliInstallQuery);
  const { change } = useCliInstall();
  return (
    <section aria-label="Command line" className="space-y-3 border-t border-border/60 py-4">
      <div>
        <h3 className="text-sm">Command line</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Use prkit from a terminal or coding agent. Requires Outside agents to be on.
          {enabled
            ? access === "work"
              ? " Currently Read and start work."
              : " Currently Read only."
            : " Currently off."}
        </p>
      </div>
      {state.isPending ? (
        <ListSkeleton label="Loading command line" rows={2} />
      ) : state.isError ? (
        <ListError
          title="Couldn't load command line installation"
          message={state.error.message}
          retry={() => void state.refetch()}
        />
      ) : (
        <>
          {state.data.launcherProblem !== null && (
            <SettingsAlert
              message={state.data.launcherProblem}
              retry={() => void state.refetch()}
            />
          )}
          <p role="status" className="text-xs">
            {state.data.status === "installed"
              ? "Installed"
              : state.data.status === "foreign"
                ? "Another file uses this location"
                : "Not installed"}
            {state.data.status === "installed" && state.data.pathSource === "missing"
              ? " · Not on PATH"
              : ""}
          </p>
          <p className="break-all font-mono text-xs text-muted-foreground">{state.data.path}</p>
          {state.data.existing !== null && (
            <p className="text-xs text-muted-foreground">
              {state.data.existing}. Move it yourself to use this location. prkit will leave it
              alone.
            </p>
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={
                change.isPending ||
                state.data.status === "foreign" ||
                (state.data.status !== "installed" && state.data.launcherProblem !== null)
              }
              aria-busy={change.isPending}
              onClick={() =>
                change.mutate(state.data.status === "installed" ? "uninstall" : "install")
              }
            >
              <ButtonLabel
                shown={state.data.status === "installed" ? "uninstall" : "install"}
                labels={{
                  install: "Install command line tool",
                  uninstall: "Uninstall command line tool",
                }}
              />
            </Button>
            <Button
              size="sm"
              variant="ghost-muted"
              disabled={state.isFetching}
              onClick={() => void state.refetch()}
            >
              Check again
            </Button>
          </div>
          {state.data.pathSource === "missing" && (
            <div>
              <p className="text-xs text-muted-foreground">
                This folder isn't on prkit's PATH or the system's default PATH. Add this line to
                your shell profile, then open a new terminal. prkit never edits profiles.
              </p>
              <FixCommand command={state.data.pathCommand} />
            </div>
          )}
          {state.data.pathSource === "system" && (
            <p className="text-xs text-muted-foreground">
              This folder is on macOS's default PATH. An existing terminal may need to be reopened.
            </p>
          )}
          <div className="space-y-2 pt-2">
            <h4 className="text-sm">Teach your coding agent</h4>
            <p className="text-xs text-muted-foreground">
              Install the prkit-cli skill. The terminal installer asks which agents to use. You can
              run it again to update the skill for this app version.
            </p>
            {state.data.skillCommand === null ? (
              <p role="status" className="text-xs text-muted-foreground">
                This development build has no skill repository. Use a release build, or build with
                GITHUB_REPOSITORY set.
              </p>
            ) : (
              <>
                <FixCommand command={state.data.skillCommand} />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={change.isPending}
                  onClick={() => change.mutate("skill")}
                >
                  Open skill installer in terminal
                </Button>
                <p className="text-xs text-muted-foreground">
                  Uses your default terminal. Change it from your terminal's menu, for example
                  Ghostty &gt; Make Ghostty the Default Terminal.
                </p>
              </>
            )}
          </div>
        </>
      )}
      <FailedSave save={change} />
    </section>
  );
}
