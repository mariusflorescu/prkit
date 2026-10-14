import type { DiffFile } from "@prkit/contracts";

import { DiffStat } from "~/components/diff/DiffStat";

import { KindTag } from "./KindTag";
import type { GuideChapter } from "./types";

export function ChapterRoadmap({
  chapters,
  files,
  onChapter,
  pendingChapterIds,
}: {
  chapters: ReadonlyArray<GuideChapter>;
  files: ReadonlyMap<string, DiffFile>;
  onChapter: (id: string) => void;
  pendingChapterIds: ReadonlySet<string>;
}) {
  if (chapters.length === 0)
    return (
      <p data-guide-empty="" role="status">
        This guide has no chapters yet.
      </p>
    );
  return (
    <section data-guide-roadmap="">
      <h2>
        Chapters <span>{chapters.length}</span>
      </h2>
      <ol>
        {chapters.map((chapter, index) => {
          const additions = chapter.files.reduce(
            (total, entry) => total + (files.get(entry.path)?.additions ?? 0),
            0,
          );
          const deletions = chapter.files.reduce(
            (total, entry) => total + (files.get(entry.path)?.deletions ?? 0),
            0,
          );
          const pending = pendingChapterIds.has(chapter.id);
          return (
            <li key={chapter.id}>
              <button
                type="button"
                data-roadmap-row=""
                data-pending={pending || undefined}
                onClick={() => onChapter(chapter.id)}
              >
                <span data-roadmap-index="">{String(index + 1).padStart(2, "0")}</span>
                <span data-roadmap-title="">{chapter.title}</span>
                {pending ? (
                  <span data-roadmap-files="">Being written</span>
                ) : (
                  <>
                    <KindTag kind={chapter.kind} />
                    <span data-roadmap-files="">
                      {chapter.files.length} file{chapter.files.length === 1 ? "" : "s"}
                    </span>
                    <DiffStat additions={additions} deletions={deletions} />
                  </>
                )}
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
