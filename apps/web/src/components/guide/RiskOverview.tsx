import type { DiffLineRef, NormalizedGuide } from "@prkit/contracts";
import { useId } from "react";

import { InlineMarkdown } from "~/components/diff/InlineMarkdown";

import { LineLink } from "./LineLink";
import { RiskSignalChip } from "./RiskSignalChip";
import { RiskTag } from "./RiskTag";
import { keyedItems } from "./keyedItems";
import { fileLabel, RISK_LEVELS } from "./riskLevels";

/**
 * How carefully to read the whole pull request: the agent's level and its reasons, each
 * opening the chapter that explains it, next to the facts prkit found in the diff.
 */
export function RiskOverview({
  guide,
  rated,
  onChapter,
  onLine,
  onFile,
  prUrl,
}: {
  guide: NormalizedGuide;
  rated: boolean;
  onChapter: (id: string) => void;
  onLine: (at: DiffLineRef) => void;
  onFile: (path: string) => void;
  prUrl?: string | undefined;
}) {
  const titleId = useId();
  if (!rated) return null;
  const numbered = new Map(
    guide.chapters.map((chapter, index) => [chapter.id, { chapter, index }]),
  );
  const written = new Set(
    guide.chapters.flatMap((chapter) => chapter.files.map((file) => file.path)),
  );
  const reasons = guide.risk?.reasons ?? [];
  const label = fileLabel([
    ...new Set(reasons.flatMap((reason) => (reason.at === null ? [] : [reason.at.path]))),
  ]);
  return (
    <section data-guide-risk="" aria-labelledby={titleId}>
      <div data-risk-head="">
        <h2 id={titleId}>Risk</h2>
        {guide.risk === null ? (
          <span data-risk-quiet="">The agent rates this after writing the chapters.</span>
        ) : (
          <>
            <RiskTag level={guide.risk.level} />
            <span data-risk-quiet="">{RISK_LEVELS[guide.risk.level].meaning}</span>
          </>
        )}
      </div>
      {reasons.length > 0 && (
        <ul data-risk-reasons="">
          {keyedItems(reasons, (reason) => reason.text).map(({ key, value: reason }) => {
            const linked = reason.chapter === null ? undefined : numbered.get(reason.chapter);
            return (
              <li key={key}>
                {linked ? (
                  <button
                    type="button"
                    data-flow-badge=""
                    title={linked.chapter.title}
                    aria-label={`Open chapter ${linked.index + 1}: ${linked.chapter.title}`}
                    onClick={() => onChapter(linked.chapter.id)}
                  >
                    {String(linked.index + 1).padStart(2, "0")}
                  </button>
                ) : (
                  <span data-risk-unlinked="" title="The agent hasn't written this chapter yet">
                    ··
                  </span>
                )}
                <span>
                  <InlineMarkdown text={reason.text} prUrl={prUrl} />
                  {reason.at && (
                    <LineLink
                      at={reason.at}
                      label={`${label(reason.at.path)}:${reason.at.line}`}
                      onOpen={written.has(reason.at.path) ? onLine : null}
                    />
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <div data-risk-signals="">
        <span>From the diff</span>
        {guide.signals.length === 0 ? (
          <span data-risk-quiet="">None of prkit's checks fired.</span>
        ) : (
          guide.signals.map((signal) => (
            <RiskSignalChip key={signal._tag} signal={signal} written={written} onFile={onFile} />
          ))
        )}
      </div>
    </section>
  );
}
