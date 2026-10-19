import type { FixerActivity, FixerTurn, PullRequestKey } from "@prkit/contracts";

import { ElapsedTime } from "~/components/review/ElapsedTime";
import { Button } from "~/components/ui/button";
import { ButtonLabel } from "~/components/ui/button-label";

import { FixActivityLog } from "./FixActivityLog";
import { useTurnCommand } from "./useTurnCommand";

/** A turn the agent is working on: what it says it is doing, its tool calls, and Stop. */
export function FixProgress({
  prKey,
  turn,
  activity,
}: {
  prKey: PullRequestKey;
  turn: FixerTurn;
  activity: ReadonlyArray<FixerActivity>;
}) {
  const command = useTurnCommand(prKey, turn.id);
  const latest = activity.findLast((line) => line.kind === "tool");
  const waiting = activity.at(-1)?.kind === "phase" && activity.at(-1)?.text === "queued";
  return (
    <div className="mt-3 space-y-2">
      <p role="status" aria-live="polite" className="text-sm">
        {turn.status._tag === "pushing"
          ? "Pushing to GitHub…"
          : waiting
            ? "Waiting for another agent to finish. prkit runs two at a time."
            : (turn.narration ??
              (turn.status._tag === "preparing"
                ? "Fetching the branch and preparing the checkout"
                : (latest?.text ?? "The agent is reading the code")))}
      </p>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        {turn.startedAt !== null && <ElapsedTime since={turn.startedAt} />}
        {turn.status._tag !== "pushing" && (
          <Button
            size="xs"
            variant="ghost"
            disabled={command.isPending}
            onClick={() => command.mutate("discard")}
          >
            <ButtonLabel
              shown={command.isPending ? "stopping" : "stop"}
              labels={{ stop: "Stop and discard", stopping: "Stopping…" }}
            />
          </Button>
        )}
      </div>
      {command.error && (
        <p role="alert" className="text-xs text-error-foreground">
          {command.error.message}
        </p>
      )}
      <FixActivityLog lines={activity} />
    </div>
  );
}
