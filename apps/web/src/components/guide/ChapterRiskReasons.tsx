import type { DiffLineRef } from "@prkit/contracts";

import { InlineMarkdown } from "~/components/diff/InlineMarkdown";

import { LineLink } from "./LineLink";
import { keyedItems } from "./keyedItems";
import { fileLabel } from "./riskLevels";
import type { GuideChapter } from "./types";

/** Why a chapter needs, or doesn't need, a careful read, each reason opening its file. */
export function ChapterRiskReasons({
  reasons,
  onLine,
  onFile,
  prUrl,
}: {
  reasons: NonNullable<GuideChapter["risk"]>["reasons"];
  onLine: (at: DiffLineRef) => void;
  onFile: (path: string) => void;
  prUrl?: string | undefined;
}) {
  const label = fileLabel([...new Set(reasons.map((reason) => reason.file))]);
  return (
    <ul data-chapter-risk-reasons="">
      {keyedItems(reasons, (reason) => reason.text).map(({ key, value: reason }) => (
        <li key={key}>
          <InlineMarkdown text={reason.text} prUrl={prUrl} />
          {reason.line === null ? (
            <button
              type="button"
              data-line-link=""
              title={`Open ${reason.file}`}
              aria-label={`Open ${reason.file}`}
              onClick={() => onFile(reason.file)}
            >
              {label(reason.file)}
            </button>
          ) : (
            <LineLink
              at={{ path: reason.file, line: reason.line }}
              label={`${label(reason.file)}:${reason.line}`}
              onOpen={onLine}
            />
          )}
        </li>
      ))}
    </ul>
  );
}
