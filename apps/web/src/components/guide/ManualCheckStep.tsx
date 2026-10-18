import type { ManualCheckStep as Step } from "@prkit/contracts";
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
  chapter,
  onChapter,
  prUrl,
}: {
  step: Step;
  number: number;
  /** Without it, or while it failed to load, the step has no box. */
  ticks: ManualCheckBinding | undefined;
  chapter: { readonly id: string; readonly title: string; readonly index: number } | null;
  onChapter: (id: string) => void;
  prUrl?: string | undefined;
}) {
  const actionId = useId();
  const [saving, setSaving] = useState(false);
  const ready = ticks?.status === "ready" ? ticks : null;
  const ticked = ready?.isTicked(step) ?? false;
  return (
    <li data-manual-check-step="" data-ticked={ticked ? "true" : "false"}>
      <span data-manual-check-lead="">
        {(ready !== null || ticks?.status === "pending") && (
          <Checkbox
            size="sm"
            aria-label={`Checked step ${number}`}
            aria-describedby={actionId}
            checked={ticked}
            disabled={ready === null || saving}
            onCheckedChange={(next) => {
              if (ready === null) return;
              setSaving(true);
              void ready.set([step], next).finally(() => setSaving(false));
            }}
          />
        )}
        <span data-manual-check-number="">{number}</span>
      </span>
      <div data-manual-check-body="">
        <p id={actionId}>
          <InlineMarkdown text={step.action} prUrl={prUrl} />
        </p>
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
