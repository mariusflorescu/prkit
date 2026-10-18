import type { DiffLineRef } from "@prkit/contracts";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

import { GuideNote } from "~/components/diff/GuideNote";
import { InlineMarkdown } from "~/components/diff/InlineMarkdown";
import { ReviewedToggle } from "~/components/diff/ReviewedToggle";

import { ChapterRiskReasons } from "./ChapterRiskReasons";
import { KindTag } from "./KindTag";
import { PseudocodePair } from "./PseudocodePair";
import { RiskTag } from "./RiskTag";
import { chapterRisk } from "./riskLevels";
import type { ChapterReviewedControl, GuideChapter } from "./types";
import { useStickyNarration } from "./useStickyNarration";
import { keyedItems } from "./keyedItems";

export function ChapterNarration({
  chapter,
  index,
  total,
  open,
  rated,
  onToggle,
  onLine,
  onFile,
  prUrl,
  review,
  action,
}: {
  chapter: GuideChapter;
  index: number;
  /** Null while a draft is still adding chapters, so there is no total to show yet. */
  total: number | null;
  open: boolean;
  /** The guide rates risk, so prkit's skipped chapter says it wasn't reviewed. */
  rated: boolean;
  onToggle: () => void;
  onLine: (at: DiffLineRef) => void;
  onFile: (path: string) => void;
  prUrl?: string | undefined;
  review: ChapterReviewedControl | null;
  action?: ReactNode;
}) {
  const ref = useStickyNarration();
  const risk = chapterRisk(chapter, rated);
  return (
    <aside data-chapter-narration="">
      <div ref={ref} data-chapter-narration-inner="">
        <h2>
          <button type="button" data-chapter-toggle="" aria-expanded={open} onClick={onToggle}>
            {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            {chapter.title}
          </button>
        </h2>
        <div data-chapter-meta="">
          <span>
            {String(index + 1).padStart(2, "0")}
            {total === null ? null : ` / ${String(total).padStart(2, "0")}`}
          </span>
          <KindTag kind={chapter.kind} />
          {risk !== null && <RiskTag level={risk} />}
          {review !== null && (
            <span className="ml-auto font-sans">
              <ReviewedToggle
                name={`chapter ${chapter.title}`}
                state={review.review.state}
                title={`${review.review.progress.reviewed} of ${review.review.progress.total} files reviewed`}
                onChange={review.onChange}
              />
            </span>
          )}
        </div>
        {open && (
          <>
            {chapter.risk !== null && chapter.risk.reasons.length > 0 && (
              <ChapterRiskReasons
                reasons={chapter.risk.reasons}
                onLine={onLine}
                onFile={onFile}
                prUrl={prUrl}
              />
            )}
            {keyedItems(chapter.body, (text) => text).map(({ key, value: text }) => (
              <p key={key}>
                <InlineMarkdown text={text} prUrl={prUrl} />
              </p>
            ))}
            {typeof chapter.pseudocode === "string"
              ? chapter.pseudocode && <pre data-guide-pseudocode="">{chapter.pseudocode}</pre>
              : chapter.pseudocode !== null && <PseudocodePair pair={chapter.pseudocode} />}
            {keyedItems(chapter.callouts, (callout) => JSON.stringify(callout)).map(
              ({ key, value: callout }) => (
                <GuideNote key={key} text={callout.text} tone={callout.tone} prUrl={prUrl} />
              ),
            )}
            <ul data-chapter-file-list="">
              {chapter.files.map((entry) => (
                <li key={entry.path}>
                  <button type="button" onClick={() => onFile(entry.path)}>
                    {entry.path}
                  </button>
                </li>
              ))}
            </ul>
            {action !== undefined && action !== null && <div data-chapter-action="">{action}</div>}
          </>
        )}
      </div>
    </aside>
  );
}
