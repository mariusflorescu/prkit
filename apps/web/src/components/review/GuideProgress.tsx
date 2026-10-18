import type {
  AttemptSummary,
  DiffSource,
  ReviewActivity,
  ReviewCore,
  ReviewKey,
} from "@prkit/contracts";
import { useQuery } from "@tanstack/react-query";

import { Button } from "~/components/ui/button";
import { agentCatalogQuery } from "~/rpc/queries";

import { agentLabel, agentName } from "./agent/agentSelection";
import { AttemptFileList } from "./AttemptFileList";
import { DraftView } from "./DraftView";
import { guideProgress } from "./progressModel";
import { NarrationLine } from "./NarrationLine";
import { ProgressBar } from "./ProgressBar";
import { ProgressHeader } from "./ProgressHeader";

/**
 * A first guide being written: what the agent is doing in one line, the files it
 * has read with its notes, then the draft itself as soon as it shares one.
 */
export function GuideProgress({
  reviewKey,
  review,
  attempt,
  activity,
  subject,
  expectedFiles,
  stop,
  source,
  prUrl,
  prDescription,
}: {
  reviewKey: ReviewKey;
  review: Pick<ReviewCore, "instance" | "provider" | "model" | "modelOptions">;
  attempt: AttemptSummary;
  activity: ReadonlyArray<ReviewActivity>;
  /** What the agent reads, in "Claude is reading …": "this PR", "your changes". */
  subject: string;
  /** How many file rows to sketch until the attempt lists them. */
  expectedFiles: number;
  /** Absent when the page around it has its own Stop. */
  stop?: { readonly pending: boolean; readonly error: Error | null; readonly run: () => void };
  /** Where the draft's scope lines read the new side; null reads none. */
  source: DiffSource | null;
  prUrl?: string;
  prDescription?: string;
}) {
  const catalog = useQuery(agentCatalogQuery);
  const progress = guideProgress(attempt);
  const name = agentName(catalog.data, review);
  const title =
    progress.stage === "reading"
      ? `${name} is reading ${subject}`
      : progress.stage === "writing"
        ? `${name} is writing the guide`
        : progress.stage === "checking"
          ? `${name} is checking the guide`
          : progress.label;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <section
        aria-labelledby="guide-progress-title"
        className="mx-auto w-full max-w-4xl shrink-0 space-y-3 px-6 pt-5 pb-3"
      >
        <ProgressHeader
          title={title}
          agent={agentLabel(catalog.data, {
            instance: review.instance,
            provider: review.provider,
            model: review.model,
            options: review.modelOptions,
          })}
          label={progress.label}
          startedAt={attempt.startedAt}
          stopping={stop?.pending ?? false}
          {...(stop === undefined ? {} : { onStop: stop.run })}
        />
        <ProgressBar fraction={progress.fraction} label={progress.label} />
        {attempt.startedBy !== null && (
          <p className="text-xs text-muted-foreground">Started from {attempt.startedBy}</p>
        )}
        {stop?.error && (
          <p role="alert" className="text-xs text-error-foreground">
            {stop.error.message}{" "}
            <Button variant="link" size="xs" onClick={stop.run}>
              Retry
            </Button>
          </p>
        )}
        <NarrationLine
          narration={attempt.narration}
          fallback={
            progress.stage === "queued" || progress.stage === "preparing"
              ? progress.label
              : `Waiting for ${name}'s first step`
          }
          activity={activity}
        />
      </section>
      {attempt.draft === null ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-4xl px-6 pb-8">
            <AttemptFileList
              reviewKey={reviewKey}
              attemptId={attempt.id}
              files={attempt.files}
              expected={expectedFiles}
              source={source}
            />
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <DraftView
            reviewKey={reviewKey}
            attemptId={attempt.id}
            version={attempt.draft.version}
            growing={attempt.draft.growing}
            source={source}
            {...(prUrl === undefined ? {} : { prUrl })}
            {...(prDescription === undefined ? {} : { prDescription })}
          />
        </div>
      )}
    </div>
  );
}
