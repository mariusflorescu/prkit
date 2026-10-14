import type { PullRequestDetail } from "@prkit/contracts";
import {
  CheckCircle2Icon,
  CircleDashedIcon,
  CircleMinusIcon,
  XCircleIcon,
  ExternalLinkIcon,
} from "lucide-react";

const statuses = {
  passing: { Icon: CheckCircle2Icon, tone: "text-success-foreground", label: "Passed" },
  failing: { Icon: XCircleIcon, tone: "text-error-foreground", label: "Failed" },
  pending: { Icon: CircleDashedIcon, tone: "text-warning-foreground", label: "Pending" },
  neutral: { Icon: CircleMinusIcon, tone: "text-muted-foreground", label: "Skipped or neutral" },
};
export function PullRequestCheckList({ checks }: { checks: PullRequestDetail["checks"] }) {
  return (
    <>
      {checks.length === 0 ? (
        <p role="status" className="text-xs text-muted-foreground">
          No checks reported
        </p>
      ) : (
        <ul className="-mx-2">
          {checks.map((check) => {
            const status = statuses[check.status];
            return (
              <li
                key={check.id}
                className="flex items-start gap-2 rounded-md px-2 py-1.5 text-xs leading-5 hover:bg-accent/60"
              >
                <span className="flex h-5 shrink-0 items-center">
                  <status.Icon
                    role="img"
                    aria-label={status.label}
                    className={`size-3.5 ${status.tone}`}
                  />
                </span>
                {check.url ? (
                  <a
                    className="group/check flex min-w-0 flex-1 items-start gap-1"
                    href={check.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <span className="min-w-0 wrap-anywhere group-hover/check:underline">
                      {check.name}
                    </span>
                    <span className="flex h-5 shrink-0 items-center text-muted-foreground">
                      <ExternalLinkIcon aria-hidden className="size-3" />
                    </span>
                  </a>
                ) : (
                  <span className="min-w-0 flex-1 wrap-anywhere">{check.name}</span>
                )}
                <span className="shrink-0 text-muted-foreground">{status.label}</span>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
