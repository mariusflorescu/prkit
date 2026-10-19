import type { ManualCheckStep as Step, StepFile } from "@prkit/contracts";
import { useId, useState } from "react";

import { InlineMarkdown } from "~/components/diff/InlineMarkdown";
import { Checkbox } from "~/components/ui/checkbox";

import type { ManualCheckBinding } from "./types";

/**
 * One manual check step. Its box shows only what the server saved: it stays as it was
 * until the save comes back, and is disabled meanwhile.
 */
export function ManualCheckStep({
  step,
  number,
  ticks,
  files,
  chapter,
  onChapter,
  prUrl,
}: {
  step: Step;
  number: number;
  /** Without it, or while it failed to load, the step has no box. */
  ticks: ManualCheckBinding | undefined;
  /** The files of the step's chapter in this revision, which a tick records and is read against. */
  files: ReadonlyArray<StepFile>;
  chapter: { readonly id: string; readonly title: string; readonly index: number } | null;
  onChapter: (id: string) => void;
  prUrl?: string | undefined;
}) {
  const actionId = useId();
  const changedId = useId();
  const [saving, setSaving] = useState(false);
  const ready = ticks?.status === "ready" ? ticks : null;
  const state = ready?.stateOf(step, files) ?? "unticked";
  const ticked = state === "ticked";
  return (
    <li data-manual-check-step="" data-ticked={ticked ? "true" : "false"}>
      <span data-manual-check-lead="">
        {(ready !== null || ticks?.status === "pending") && (
          <Checkbox
            size="sm"
            aria-label={`Checked step ${number}`}
            aria-describedby={state === "changed" ? `${changedId} ${actionId}` : actionId}
            checked={ticked}
            disabled={ready === null || saving}
            onCheckedChange={(next) => {
              if (ready === null) return;
              setSaving(true);
              void ready.set(step, files, next).finally(() => setSaving(false));
            }}
          />
        )}
        <span data-manual-check-number="">{number}</span>
      </span>
      <div data-manual-check-body="">
        <p id={actionId}>
          <InlineMarkdown text={step.action} prUrl={prUrl} />
        </p>
        {state === "changed" && (
          <span
            id={changedId}
            className="self-start rounded-md bg-warning-surface px-1.5 py-0.5 text-2xs text-warning-foreground"
          >
            Code changed since you checked
          </span>
        )}
        <p data-manual-check-line="">
          <span data-manual-check-label="">You should see</span>
          <InlineMarkdown text={step.expect} prUrl={prUrl} />
        </p>
        {step.watchFor !== null && (
          <p data-manual-check-line="" data-caution="">
            <span data-manual-check-label="">Watch for</span>
            <InlineMarkdown text={step.watchFor} prUrl={prUrl} />
          </p>
        )}
      </div>
      {chapter && (
        <button
          type="button"
          data-flow-badge=""
          title={chapter.title}
          aria-label={`Open chapter ${chapter.index + 1}: ${chapter.title}`}
          onClick={() => onChapter(chapter.id)}
        >
          {String(chapter.index + 1).padStart(2, "0")}
        </button>
      )}
    </li>
  );
}
