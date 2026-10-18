import { ChevronDown, ChevronRight } from "lucide-react";

import { GuideNote } from "~/components/diff/GuideNote";
import { InlineMarkdown } from "~/components/diff/InlineMarkdown";
import { ReviewedToggle } from "~/components/diff/ReviewedToggle";

import { KindTag } from "./KindTag";
import type { ChapterReviewedControl, GuideChapter } from "./types";
import { useStickyNarration } from "./useStickyNarration";
import { keyedItems } from "./keyedItems";

export function ChapterNarration({
  chapter,
  index,
  total,
  open,
  onToggle,
  onFile,
  prUrl,
  review,
}: {
  chapter: GuideChapter;
  index: number;
  /** Null while a draft is still adding chapters, so there is no total to show yet. */
  total: number | null;
  open: boolean;
  onToggle: () => void;
  onFile: (path: string) => void;
  prUrl?: string | undefined;
  review: ChapterReviewedControl | null;
}) {
  const ref = useStickyNarration();
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
            {keyedItems(chapter.body, (text) => text).map(({ key, value: text }) => (
              <p key={key}>
                <InlineMarkdown text={text} prUrl={prUrl} />
              </p>
            ))}
            {chapter.pseudocode && <pre data-guide-pseudocode="">{chapter.pseudocode}</pre>}
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
          </>
        )}
      </div>
    </aside>
  );
}
