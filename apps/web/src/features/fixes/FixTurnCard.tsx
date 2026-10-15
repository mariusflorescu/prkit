import type { FixerActivity, FixerTurn, PullRequestDetail } from "@prkit/contracts";

import { cn } from "~/lib/utils";
import { relativeTime } from "~/features/pullRequest/pullRequestPresentation";

import { FixActivityLog } from "./FixActivityLog";
import { FixDiffView } from "./FixDiffView";
import { FixProgress } from "./FixProgress";
import { FixReportList } from "./FixReportList";
import { FixTurnActions } from "./FixTurnActions";
import { FixTurnOutcome } from "./FixTurnOutcome";
import { TurnScriptsList } from "./TurnScriptsList";
import { isWorking, STATUS_LABEL, STATUS_TONE, TRIGGER_NOTE, turnTitle } from "./fixPresentation";

/** One job of the PR's fix agent, from queued to pushed, discarded or failed. */
export function FixTurnCard({
  detail,
  turn,
  activity,
  ahead,
  listsScripts,
}: {
  detail: PullRequestDetail;
  turn: FixerTurn;
  /** Only the current turn's activity is loaded; older turns show none. */
  activity: ReadonlyArray<FixerActivity>;
  /** For a queued turn: whether another turn still holds the checkout. */
  ahead: boolean;
  /** The first turn of the session to run with these scripts lists them. */
  listsScripts: boolean;
}) {
  const state = turn.status._tag;
  const title = turnTitle(turn);
  const trigger =
    turn.startedBy !== null ? `Started from ${turn.startedBy}` : TRIGGER_NOTE[turn.trigger];
  const summary =
    turn.work._tag === "conflicts" && turn.work.report !== null ? turn.work.report.summary : null;
  return (
    <article
      aria-label={`${title}: ${STATUS_LABEL[state]}`}
      data-fix-turn={turn.id}
      data-fix-state={state}
      className="rounded-lg border border-border bg-card px-4 py-3 text-card-foreground"
    >
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        <span className={cn("text-xs font-medium", STATUS_TONE[state])}>{STATUS_LABEL[state]}</span>
        {trigger !== null && <span className="text-xs text-muted-foreground">{trigger}</span>}
        {turn.rounds > 0 && (
          <span className="text-xs text-muted-foreground">
            Changed {turn.rounds === 1 ? "once" : `${turn.rounds} times`} on request
          </span>
        )}
        <time
          dateTime={turn.createdAt}
          title={new Date(turn.createdAt).toLocaleString()}
          className="ml-auto text-xs text-muted-foreground"
        >
          {relativeTime(turn.createdAt)}
        </time>
      </header>
      {state === "queued" && (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          {ahead
            ? "Waits for the turn above: push or discard it, and this one starts."
            : "Starting…"}
        </p>
      )}
      {listsScripts && turn.scripts?._tag === "allowed" && (
        <TurnScriptsList scripts={turn.scripts.scripts} />
      )}
      {isWorking(state) && <FixProgress prKey={detail.key} turn={turn} activity={activity} />}
      {summary !== null && state !== "queued" && (
        <p className="mt-2 text-sm whitespace-pre-line">{summary}</p>
      )}
      {(state === "ready" ||
        state === "pushed" ||
        state === "unchanged" ||
        state === "running") && <FixReportList turn={turn} />}
      {state === "ready" && turn.commit !== null && (
        <>
          <p className="mt-3 text-xs text-muted-foreground">
            prkit committed <span className="font-mono">{turn.commit.sha.slice(0, 7)}</span>:{" "}
            {turn.commit.message.split("\n")[0]}
          </p>
          <div className="mt-3">
            <FixDiffView prKey={detail.key} turn={turn} />
          </div>
          <FixTurnActions detail={detail} turn={turn} />
          {activity.length > 0 && (
            <div className="mt-3">
              <FixActivityLog lines={activity} />
            </div>
          )}
        </>
      )}
      {!isWorking(state) && state !== "ready" && state !== "queued" && (
        <FixTurnOutcome detail={detail} turn={turn} />
      )}
    </article>
  );
}
