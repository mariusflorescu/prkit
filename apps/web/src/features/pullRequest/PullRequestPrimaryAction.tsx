import {
  primaryPullRequestAction,
  pullRequestActionLabels,
  pullRequestActionReason,
  type PullRequestDetail,
} from "@prkit/contracts";
import { ChevronDownIcon, GitMergeIcon } from "lucide-react";
import { useId } from "react";

import { Button } from "~/components/ui/button";
import { ButtonLabel } from "~/components/ui/button-label";
import { Group, GroupSeparator } from "~/components/ui/group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { ResolveConflictsButton } from "~/features/fixes/ResolveConflictsButton";
import { usePullRequestActions, useStartPullRequestAction } from "./actionContext";
import { mergeMethods, resolveMergeMethod } from "./actionPresentation";

/**
 * The one action the PR's state calls for. Merge, Update branch and auto-merge are a
 * split button whose arrow says a method is chosen next. Blocked right now, it stays in
 * place and focusable, and its tooltip and description say why.
 */
export function PullRequestPrimaryAction({ detail }: { detail: PullRequestDetail }) {
  const actions = usePullRequestActions();
  const start = useStartPullRequestAction();
  const reasonId = useId();
  const primary = primaryPullRequestAction(detail);
  if (primary === null) return null;
  if (primary === "resolve-conflicts") return <ResolveConflictsButton detail={detail} />;
  const reason = pullRequestActionReason(detail, primary);
  const blocked = actions.pending || reason !== null;
  const method = resolveMergeMethod(detail);
  const methods =
    primary === "merge" || primary === "update-branch" || primary === "enable-auto-merge";
  const unavailable = {
    "aria-disabled": blocked || undefined,
    "aria-describedby": reason === null ? undefined : reasonId,
  };
  const choose = (anchor: HTMLElement) => {
    if (!blocked) start(primary, anchor);
  };
  return (
    <Group aria-label={pullRequestActionLabels[primary]} aria-busy={actions.pending}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="xs"
              aria-label={primary === "merge" ? `Merge (${method})` : undefined}
              {...unavailable}
              onClick={(event) => choose(event.currentTarget)}
            />
          }
        >
          <ButtonLabel
            icon={<GitMergeIcon />}
            shown={actions.pending ? "working" : "idle"}
            labels={{ idle: pullRequestActionLabels[primary], working: "Working..." }}
          />
        </TooltipTrigger>
        {reason !== null && <TooltipPopup>{reason}</TooltipPopup>}
      </Tooltip>
      {methods && <GroupSeparator />}
      {methods && (
        <Button
          size="xs"
          aria-label={
            primary === "update-branch" ? "Choose branch update method" : "Choose merge method"
          }
          {...unavailable}
          onClick={(event) => choose(event.currentTarget)}
        >
          <ChevronDownIcon />
        </Button>
      )}
      {primary === "merge" && (
        <span className="sr-only">
          {mergeMethods.find((entry) => entry.method === method)?.label}
        </span>
      )}
      {reason !== null && (
        <span id={reasonId} hidden>
          {reason}
        </span>
      )}
    </Group>
  );
}
