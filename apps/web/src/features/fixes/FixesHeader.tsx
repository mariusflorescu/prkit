import type { FixerSnapshot, PullRequestDetail } from "@prkit/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SettingsIcon } from "lucide-react";

import { agentLabel } from "~/components/review/agent/agentSelection";
import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { stopFixer } from "~/rpc/client";
import { agentCatalogQuery } from "~/rpc/queries";

import { storeFixer } from "./fixerCache";
import { RepositoryFixToggles } from "./RepositoryFixToggles";
import { runsOnCursor } from "./cursorFixes";
import { ScriptAccessNotice } from "./ScriptAccessNotice";
import { useFixAgent } from "./useFixAgent";

/** The session line: which agent works on this PR, its repository's opt-ins, and Stop. */
export function FixesHeader({
  detail,
  snapshot,
}: {
  detail: PullRequestDetail;
  snapshot: FixerSnapshot;
}) {
  const client = useQueryClient();
  const catalog = useQuery(agentCatalogQuery);
  const agent = useFixAgent(detail.key, null);
  const cursor = runsOnCursor(agent.catalog, agent.selection);
  const stop = useMutation({
    mutationFn: () => stopFixer(snapshot.key),
    onSuccess: (next) => storeFixer(client, next),
  });
  const fixer = snapshot.fixer;
  const automatic = [
    snapshot.settings.pushAutomatically && "pushes automatically",
    snapshot.settings.resolveAutomatically && "resolves conflicts automatically",
  ].filter(Boolean);
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      {fixer !== null && (
        <span>
          {fixer.status._tag === "active" ? "Agent" : "Was"}:{" "}
          <span className="text-foreground">
            {agentLabel(catalog.data, {
              instance: fixer.instance,
              provider: fixer.provider,
              model: fixer.model,
              options: fixer.modelOptions,
            })}
          </span>
          {fixer.status._tag === "done" &&
            ` · ended (${fixer.status.reason === "stopped" ? "you stopped it" : `pull request ${fixer.status.reason}`})`}
        </span>
      )}
      <span>
        {automatic.length === 0
          ? "You push every fix yourself."
          : `This repository ${automatic.join(" and ")}.`}
      </span>
      <span className="ml-auto flex items-center gap-1">
        <Popover>
          <PopoverTrigger render={<Button size="xs" variant="ghost-muted" />}>
            <SettingsIcon />
            Repository settings
          </PopoverTrigger>
          <PopoverPopup width="lg" align="end">
            <p className="mb-3 text-xs text-muted-foreground">
              For every pull request in {snapshot.settings.repository}.
            </p>
            <RepositoryFixToggles settings={snapshot.settings} cursor={cursor} />
          </PopoverPopup>
        </Popover>
        {fixer?.status._tag === "active" && (
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={stop.isPending}
            onClick={() => stop.mutate()}
          >
            {stop.isPending ? "Stopping…" : "Stop agent"}
          </Button>
        )}
      </span>
      <div className="w-full">
        <ScriptAccessNotice detail={detail} cursor={cursor} />
      </div>
      {stop.error && (
        <p role="alert" className="w-full text-error-foreground">
          {stop.error.message}
        </p>
      )}
    </div>
  );
}
