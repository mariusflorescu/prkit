import type { DiffLineRef } from "@prkit/contracts";

import { InlineMarkdown } from "~/components/diff/InlineMarkdown";

import { LineLink } from "./LineLink";
import { keyedItems } from "./keyedItems";
import type { FlowBehavior, GuideChapter } from "./types";

const marks = {
  added: { marker: "+", spoken: "Added: " },
  removed: { marker: "-", spoken: "Removed: " },
  unchanged: { marker: "", spoken: "" },
} as const;

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export function BehaviorDiff({
  flow,
  chapters,
  onChapter,
  onLine,
  prUrl,
}: {
  flow: FlowBehavior;
  chapters: ReadonlyArray<GuideChapter>;
  onChapter: (id: string) => void;
  onLine: (at: DiffLineRef) => void;
  prUrl?: string | undefined;
}) {
  const numbered = new Map(chapters.map((chapter, index) => [chapter.id, { chapter, index }]));
  const written = new Set(chapters.flatMap((chapter) => chapter.files.map((file) => file.path)));
  const paths = [...new Set(flow.rows.map((row) => row.at.path))];
  const fileLabel = (path: string) =>
    paths.some((other) => other !== path && basename(other) === basename(path))
      ? path
      : basename(path);
  return (
    <ol data-behavior-diff="">
      {keyedItems(flow.rows, (row) => `${row.status}:${row.text}`).map(({ key, value: row }) => {
        const mark = marks[row.status];
        const linked = row.chapter === null ? undefined : numbered.get(row.chapter);
        return (
          <li
            key={key}
            data-behavior-row=""
            data-status={row.status}
            data-depth={row.depth}
            aria-level={row.depth + 1}
          >
            <span data-behavior-marker="" aria-hidden="true">
              {mark.marker}
            </span>
            <span data-behavior-text="">
              {mark.spoken && <span className="sr-only">{mark.spoken}</span>}
              <InlineMarkdown text={row.text} prUrl={prUrl} />
            </span>
            <span data-behavior-at="">
              <LineLink
                at={row.at}
                label={`${fileLabel(row.at.path)}:${row.at.line}`}
                onOpen={written.has(row.at.path) ? onLine : null}
              />
            </span>
            <span data-behavior-chapter="">
              {linked && (
                <button
                  type="button"
                  data-flow-badge=""
                  title={linked.chapter.title}
                  aria-label={`Open chapter ${linked.index + 1}`}
                  onClick={() => onChapter(linked.chapter.id)}
                >
                  {String(linked.index + 1).padStart(2, "0")}
                </button>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
