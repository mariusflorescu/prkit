import type { FixerTurn, PullRequestDetail } from "@prkit/contracts";

import { Button } from "~/components/ui/button";
import { ButtonLabel } from "~/components/ui/button-label";

import { short } from "./fixPresentation";
import { useTurnCommand } from "./useTurnCommand";

/** How an ended turn ended, with Retry for a failed one and Revert for a pushed merge. */
export function FixTurnOutcome({ detail, turn }: { detail: PullRequestDetail; turn: FixerTurn }) {
  const command = useTurnCommand(detail.key, turn.id);
  const { status } = turn;
  const revertable =
    status._tag === "pushed" && turn.work._tag === "conflicts" && turn.work.strategy === "merge";
  return (
    <div className="mt-3 space-y-2 text-xs">
      {status._tag === "pushed" && turn.commit !== null && (
        <p role="status">
          Pushed{" "}
          <a
            className="font-mono hover:underline"
            href={`${detail.url}/commits/${turn.commit.sha}`}
            target="_blank"
            rel="noreferrer"
          >
            {short(turn.commit.sha)}
          </a>{" "}
          to {turn.headRef ?? "the branch"}. The guide picks up the new head on its own.
        </p>
      )}
      {status._tag === "unchanged" && (
        <p role="status" className="text-muted-foreground">
          The agent changed nothing, so there is nothing to push. Your drafts are back.
        </p>
      )}
      {status._tag === "discarded" && (
        <p role="status" className="text-muted-foreground">
          {status.message}.
          {status.reason === "user" || status.reason === "ended"
            ? " Nothing reached GitHub, and your drafts are back."
            : ""}
        </p>
      )}
      {status._tag === "failed" && (
        <p role="alert" className="text-error-foreground">
          {status.message}
        </p>
      )}
      {(status._tag === "failed" || status._tag === "unchanged") && turn.work._tag !== "revert" && (
        <Button
          size="sm"
          variant="outline"
          disabled={command.isPending}
          onClick={() => command.mutate("retry")}
        >
          <ButtonLabel
            shown={command.isPending ? "retrying" : "retry"}
            labels={{ retry: "Retry", retrying: "Retrying…" }}
          />
        </Button>
      )}
      {revertable && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={command.isPending}
            onClick={() => command.mutate("revert")}
          >
            Revert resolution
          </Button>
          <span className="text-muted-foreground">
            Adds a commit that undoes the merge. You push it yourself.
          </span>
        </div>
      )}
      {command.error && (
        <p role="alert" className="text-error-foreground">
          {command.error.message}
        </p>
      )}
    </div>
  );
}
