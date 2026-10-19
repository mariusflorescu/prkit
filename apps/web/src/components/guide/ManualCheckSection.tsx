import { type DiffFile, type NormalizedGuide, stepFiles } from "@prkit/contracts";
import { useId, useMemo } from "react";

import { InlineMarkdown } from "~/components/diff/InlineMarkdown";
import { Button } from "~/components/ui/button";

import { ManualCheckStep } from "./ManualCheckStep";
import { keyedItems } from "./keyedItems";
import type { ManualCheckBinding } from "./types";
import "./manualCheck.css";

/**
 * How a person sees the change working by hand, with a box to tick each step. The agent
 * wrote it from reading the code and ran nothing, and the card says so.
 */
export function ManualCheckSection({
  guide,
  files,
  ticks,
  onChapter,
  prUrl,
}: {
  guide: NormalizedGuide;
  /** The revision's snapshot files by path, which the code of each step's chapter comes from. */
  files: ReadonlyMap<string, DiffFile>;
  /** Without it the steps have no boxes and there is no progress. */
  ticks?: ManualCheckBinding | undefined;
  onChapter: (id: string) => void;
  prUrl?: string | undefined;
}) {
  const titleId = useId();
  const { manualCheck } = guide;
  // Hashing a chapter's patches is the costly part, so it follows the revision, not the ticks.
  const code = useMemo(
    () =>
      manualCheck?._tag === "steps"
        ? manualCheck.steps.map((step) => stepFiles(step, guide.chapters, files))
        : [],
    [manualCheck, guide.chapters, files],
  );
  if (manualCheck === null) return null;
  if (manualCheck._tag === "nothing")
    return (
      <section data-guide-manual-check="" aria-labelledby={titleId}>
        <div data-manual-check-head="">
          <h2 id={titleId}>How to check it</h2>
        </div>
        <p data-manual-check-quiet="">
          Nothing to check by hand. <InlineMarkdown text={manualCheck.reason} prUrl={prUrl} />
        </p>
      </section>
    );
  const { setup, steps } = manualCheck;
  const numbered = new Map(
    guide.chapters.map((chapter, index) => [
      chapter.id,
      { id: chapter.id, title: chapter.title, index },
    ]),
  );
  const states =
    ticks?.status === "ready"
      ? steps.map((step, index) => ticks.stateOf(step, code[index] ?? []))
      : [];
  const checked = states.filter((state) => state === "ticked").length;
  const changed = states.filter((state) => state === "changed").length;
  return (
    <section data-guide-manual-check="" aria-labelledby={titleId}>
      <div data-manual-check-head="">
        <h2 id={titleId}>How to check it</h2>
        {ticks?.status === "ready" && (
          <span
            data-manual-check-quiet=""
            data-manual-check-progress=""
            title={changed > 0 ? `${changed} changed since you checked` : undefined}
          >
            {checked === steps.length && steps.length > 1
              ? `All ${steps.length} checked`
              : `${checked} of ${steps.length} checked`}
          </span>
        )}
        {ticks?.status === "error" && (
          <span
            role="status"
            data-manual-check-quiet=""
            data-manual-check-trailing=""
            title={ticks.message}
          >
            Your ticks didn't load
            <Button variant="ghost-muted" size="micro" onClick={ticks.retry}>
              Retry
            </Button>
          </span>
        )}
      </div>
      <p data-manual-check-quiet="">
        The agent's suggestion from reading the code. It didn't run anything.
      </p>
      {setup !== null && (
        <p data-manual-check-line="">
          <span data-manual-check-label="">Setup</span>
          <InlineMarkdown text={setup} prUrl={prUrl} />
        </p>
      )}
      <ol>
        {keyedItems(steps, (step) => step.action).map(({ key, value: step }, index) => (
          <ManualCheckStep
            key={key}
            step={step}
            number={index + 1}
            ticks={ticks}
            files={code[index] ?? []}
            chapter={step.chapter === null ? null : (numbered.get(step.chapter) ?? null)}
            onChapter={onChapter}
            prUrl={prUrl}
          />
        ))}
      </ol>
    </section>
  );
}
