import type { ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { ButtonLabel } from "~/components/ui/button-label";

/**
 * Why Generate can't run, beside the button: every file skipped, the start failed (Retry),
 * or no agent can write it (Check again). `fallback` shows when nothing is wrong.
 */
export function GuideSetupNotice({
  blocked,
  failure,
  checkFailure,
  problem,
  checking,
  pending,
  onRetry,
  onCheckAgain,
  fallback,
}: {
  /** Every changed file would be skipped, with the rules that decided. */
  blocked: string | null;
  /** Starting the guide failed. */
  failure: Error | null;
  /** Checking the agents again failed. */
  checkFailure: Error | null;
  /** The chosen agent can't run, or none is ready. */
  problem: string | null;
  checking: boolean;
  pending: boolean;
  onRetry: () => void;
  onCheckAgain: () => void;
  fallback: ReactNode;
}) {
  const issue = failure ?? checkFailure;
  if (blocked === null && issue === null && problem === null) return fallback;
  return (
    <div className="space-y-0.5 text-xs">
      {blocked !== null && (
        <p role="alert" aria-label="Generation blocked" className="text-error-foreground">
          {blocked}
        </p>
      )}
      {(issue !== null || problem !== null) && (
        <div className="flex flex-wrap items-center gap-x-2">
          {issue !== null ? (
            <p role="alert" className="text-error-foreground">
              {issue.message}
            </p>
          ) : (
            <p id="generate-blocked" role="status" className="text-muted-foreground">
              {problem}
            </p>
          )}
          <Button
            variant="link"
            size="xs"
            disabled={checking || pending}
            onClick={failure !== null ? onRetry : onCheckAgain}
          >
            <ButtonLabel
              shown={failure !== null ? "retry" : checking ? "checking" : "check"}
              labels={{ retry: "Retry", checking: "Checking…", check: "Check again" }}
            />
          </Button>
        </div>
      )}
    </div>
  );
}
