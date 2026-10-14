import {
  pullRequestActionLabels,
  pullRequestActionReason,
  type PullRequestDetail,
  type PullRequestStateAction,
} from "@prkit/contracts";
import { useId } from "react";

import { MenuItem } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { usePullRequestActions } from "./actionContext";

/** One ⋯ menu action: blocked right now, it stays, disabled, with the reason as its tooltip. */
export function PullRequestMenuItem({
  detail,
  kind,
  onStart,
}: {
  detail: PullRequestDetail;
  kind: PullRequestStateAction;
  onStart: (kind: PullRequestStateAction) => void;
}) {
  const actions = usePullRequestActions();
  const reasonId = useId();
  const reason = pullRequestActionReason(detail, kind);
  return (
    <Tooltip>
      <TooltipTrigger render={<div />}>
        <MenuItem
          disabled={actions.pending || reason !== null}
          aria-describedby={reason === null ? undefined : reasonId}
          onClick={() => onStart(kind)}
        >
          {pullRequestActionLabels[kind]}
        </MenuItem>
        {reason !== null && (
          <span id={reasonId} hidden>
            {reason}
          </span>
        )}
      </TooltipTrigger>
      {reason !== null && <TooltipPopup side="left">{reason}</TooltipPopup>}
    </Tooltip>
  );
}
