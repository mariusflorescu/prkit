import type {
  DiffFile,
  DiffLineRef,
  NormalizedPreflight,
  PreflightClaimKind,
} from "@prkit/contracts";
import type { ReactNode } from "react";

import { InlineMarkdown } from "~/components/diff/InlineMarkdown";
import { keyedItems } from "./keyedItems";
import { PreflightLinks } from "./PreflightLinks";
import type { GuideChapter } from "./types";

const CLAIMS: Record<PreflightClaimKind, string> = {
  "missing-from-description": "Not in the description",
  "missing-from-code": "Not in the code",
  differs: "Says otherwise",
};

/**
 * What the author should look at before asking for review: what reviewers will ask,
 * where the description and the code disagree, and tests that look missing. prkit
 * checked that every point's evidence resolves, not that the point is right.
 */
export function PreflightSection({
  preflight,
  chapters,
  files,
  onChapter,
  onLine,
  prUrl,
  note,
  action,
}: {
  preflight: NormalizedPreflight;
  chapters: ReadonlyArray<GuideChapter>;
  files: ReadonlyMap<string, DiffFile>;
  onChapter: (id: string) => void;
  onLine: (at: DiffLineRef) => void;
  prUrl?: string | undefined;
  note: string | null;
  action: ReactNode;
}) {
  const chapterOf = (id: string) => chapters.find((chapter) => chapter.id === id);
  const ownerOf = (path: string) =>
    chapters.find((chapter) => chapter.files.some((file) => file.path === path));
  const { questions, description, tests } = preflight;
  const empty = questions.length + description.length + tests.length === 0;
  return (
    <section data-guide-preflight="" aria-labelledby="guide-preflight-title">
      <header>
        <h2 id="guide-preflight-title">Before you ask for review</h2>
        <p>Only you see this, because you opened this pull request.</p>
      </header>
      {empty && (
        <p data-preflight-empty="">
          Nothing to flag: no likely questions, no gaps between the description and the code, and no
          tests that look missing.
        </p>
      )}
      {questions.length > 0 && (
        <div data-preflight-group="">
          <h3>Reviewers will probably ask</h3>
          <ul aria-label="Reviewers will probably ask">
            {keyedItems(questions, (item) => item.text).map(({ key, value: question }) => (
              <li key={key}>
                <InlineMarkdown text={question.text} prUrl={prUrl} />
                <PreflightLinks
                  chapter={chapterOf(question.chapter)}
                  at={question.at}
                  onChapter={onChapter}
                  onLine={onLine}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
      {description.length > 0 && (
        <div data-preflight-group="">
          <h3>The description and the code</h3>
          <ul aria-label="The description and the code">
            {keyedItems(description, (item) => item.text).map(({ key, value: claim }) => (
              <li key={key} aria-label={`${CLAIMS[claim.kind]}: ${claim.text}`}>
                <span data-preflight-kind={claim.kind}>{CLAIMS[claim.kind]}</span>
                <InlineMarkdown text={claim.text} prUrl={prUrl} />
                {claim.kind !== "missing-from-description" && (
                  <blockquote data-preflight-quote="">{claim.quote}</blockquote>
                )}
                {claim.kind !== "missing-from-code" && (
                  <PreflightLinks
                    chapter={chapterOf(claim.chapter)}
                    at={claim.at}
                    onChapter={onChapter}
                    onLine={onLine}
                  />
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {tests.length > 0 && (
        <div data-preflight-group="">
          <h3>Tests that look missing</h3>
          <ul aria-label="Tests that look missing">
            {tests.map((test) => {
              const file = files.get(test.path);
              return (
                <li key={test.path}>
                  <p data-preflight-file="">
                    <code>{test.path}</code>
                    {file !== undefined && (
                      <span>
                        +{file.additions} -{file.deletions}
                      </span>
                    )}
                  </p>
                  <InlineMarkdown text={test.text} prUrl={prUrl} />
                  <PreflightLinks
                    chapter={ownerOf(test.path)}
                    at={test.line === null ? null : { path: test.path, line: test.line }}
                    onChapter={onChapter}
                    onLine={onLine}
                  />
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {note !== null && <p data-preflight-note="">{note}</p>}
      {action}
    </section>
  );
}
