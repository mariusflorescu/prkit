import { Popover } from "@base-ui/react/popover";
import type { PullRequestDetail } from "@prkit/contracts";
import { CheckCircle2Icon, CircleDashedIcon, CircleMinusIcon, XCircleIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { PullRequestCheckList } from "./PullRequestCheckList";
import { checkSummary } from "./pullRequestPresentation";

const presentations = {
  passing: { Icon: CheckCircle2Icon, tone: "text-success-foreground" },
  failing: { Icon: XCircleIcon, tone: "text-error-foreground" },
  pending: { Icon: CircleDashedIcon, tone: "text-warning-foreground" },
  neutral: { Icon: CircleMinusIcon, tone: "text-muted-foreground" },
};

export function PullRequestChecksPopover({
  checks,
  rollup,
}: {
  checks: PullRequestDetail["checks"];
  rollup: PullRequestDetail["actions"]["checksState"];
}) {
  const failed = checks.filter((check) => check.status === "failing").length;
  const pending = checks.filter((check) => check.status === "pending").length;
  const passed = checks.filter((check) => check.status === "passing").length;
  const status =
    failed > 0 || rollup === "failing"
      ? "failing"
      : pending > 0 || rollup === "pending"
        ? "pending"
        : passed === checks.length && passed > 0
          ? "passing"
          : "neutral";
  const { Icon, tone } = presentations[status];
  const summary = checkSummary(checks);
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={`Open checks: ${summary}`}
        data-checks-state={status}
        render={<Button variant="ghost-muted" size="compact" />}
      >
        <Icon aria-hidden className={tone} />
        <span className="tabular-nums">
          {failed > 0 ? `${failed} failed` : `${passed}/${checks.length}`}
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="start" sideOffset={6} className="z-50">
          <Popover.Popup className="w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-md">
            <Popover.Title className="text-sm font-medium">Checks</Popover.Title>
            <Popover.Description className="mt-1 text-xs text-muted-foreground">
              {summary}
            </Popover.Description>
            <div className="-mx-2 mt-2 max-h-64 overflow-y-auto px-2">
              <PullRequestCheckList checks={checks} />
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
