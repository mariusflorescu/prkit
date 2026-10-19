import type { LocalReview, LocalRun } from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";
import { FolderGit2Icon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { ButtonLabel } from "~/components/ui/button-label";
import { relativeTime } from "~/features/pullRequest/pullRequestPresentation";
import { localReviewProblemQuery } from "~/rpc/queries";

import { HEAD_WORDS, isRunning, localTitle } from "./localPresentation";
import { LocalReviewMenu } from "./LocalReviewMenu";
import { LocalRunAgain } from "./LocalRunAgain";
import { useLocalReviewActions } from "./useLocalReviewActions";

/**
 * What a local review is about (the folder, its branch, the base and head of the last run)
 * and what can be done with it: Run again, or Stop while a guide is written, and Remove. Run
 * again and Stop follow the review's state, so neither shows while prkit can't read it.
 */
export function LocalReviewHeader({ review, run }: { review: LocalReview; run: LocalRun | null }) {
  const { generate, stop } = useLocalReviewActions(review.key);
  const unreadable = useQuery(localReviewProblemQuery(review.key)).data != null;
  const running = isRunning(review.status);
  const error = stop.error ?? generate.error;
  const title = localTitle(review.source);
  return (
    <header className="shrink-0 border-b border-border pt-2.5 pr-(--workspace-gutter-end) pb-2.5 pl-(--workspace-gutter-start)">
      <div className="flex min-h-7 min-w-0 items-center gap-2">
        <FolderGit2Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <h1 className="min-w-0 truncate text-sm font-medium" title={title}>
          {title}
        </h1>
        <span className="inline-flex shrink-0 items-center rounded-md border border-border/60 px-1.5 py-0.5 text-2xs text-muted-foreground">
          Local changes
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {unreadable ? null : running ? (
            <Button
              variant="outline"
              size="xs"
              disabled={stop.isPending}
              onClick={() => stop.mutate()}
            >
              <ButtonLabel
                shown={stop.isPending ? "stopping" : "stop"}
                labels={{ stop: "Stop", stopping: "Stopping…" }}
              />
            </Button>
          ) : (
            <LocalRunAgain review={review} generate={generate} />
          )}
          <LocalReviewMenu review={review} />
        </div>
      </div>
      <p className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        {run !== null && (
          <>
            <span className="shrink-0">
              into <span className="font-mono text-foreground">{run.baseRef}</span>
            </span>
            <span aria-hidden>·</span>
          </>
        )}
        <span className="shrink-0">{HEAD_WORDS[run?.head ?? review.source.head]}</span>
        <span aria-hidden>·</span>
        <span className="min-w-0 truncate font-mono" title={review.source.path}>
          {review.source.path}
        </span>
        {run !== null && (
          <>
            <span aria-hidden>·</span>
            <time
              className="shrink-0"
              dateTime={run.capturedAt}
              title={new Date(run.capturedAt).toLocaleString()}
            >
              captured {relativeTime(run.capturedAt)}
            </time>
          </>
        )}
      </p>
      {error && (
        <p role="alert" className="mt-1.5 flex items-center gap-2 text-xs text-error-foreground">
          {error.message}
          {!unreadable && (
            <Button
              variant="link"
              size="xs"
              disabled={stop.isPending || generate.isPending}
              onClick={() =>
                error === stop.error ? stop.mutate() : generate.mutate(generate.variables ?? {})
              }
            >
              Retry
            </Button>
          )}
        </p>
      )}
    </header>
  );
}
