import type { FocusVerdict, NormalizedGuide } from "@prkit/contracts";

import { InlineMarkdown } from "~/components/diff/InlineMarkdown";
import { InlineButton } from "~/components/ui/button";

const VERDICTS: Record<FocusVerdict, string> = {
  notable: "Notable",
  "nothing-notable": "Nothing notable",
  "not-assessed": "Not assessed",
};

/**
 * The reviewer's own questions and the agent's answer to each. prkit checked that
 * every area got one answer, not that the answer is right.
 */
export function FocusAreasSection({
  guide,
  onChapter,
  prUrl,
}: {
  guide: NormalizedGuide;
  onChapter: (id: string) => void;
  prUrl?: string | undefined;
}) {
  if (guide.focusAreas.length === 0) return null;
  return (
    <section data-guide-focus-areas="" aria-labelledby="guide-focus-areas-title">
      <h2 id="guide-focus-areas-title">Your focus areas</h2>
      <ul>
        {guide.focusAreas.map((area) => {
          const chapter = guide.chapters.find((candidate) => candidate.id === area.chapter);
          return (
            <li key={area.id} aria-label={`${area.label}: ${VERDICTS[area.verdict]}`}>
              <p data-focus-area-head="">
                <span data-focus-area-label="">{area.label}</span>
                <span data-focus-verdict={area.verdict}>{VERDICTS[area.verdict]}</span>
              </p>
              {area.question !== "" && <p data-focus-area-question="">{area.question}</p>}
              {area.text !== "" && (
                <div data-focus-area-text="">
                  <InlineMarkdown text={area.text} prUrl={prUrl} />
                </div>
              )}
              {chapter !== undefined && (
                <div>
                  <InlineButton onClick={() => onChapter(chapter.id)}>
                    Open {chapter.title}
                  </InlineButton>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
