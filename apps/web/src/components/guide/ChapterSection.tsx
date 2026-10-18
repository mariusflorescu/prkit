import type { DiffFile, DiffLineRef } from "@prkit/contracts";

import { FileDiffCard, type DiffComments, type LoadContents } from "~/components/diff";

import { ChapterNarration } from "./ChapterNarration";
import type { ChapterReviewedControl, GuideChapter, ReviewedBinding } from "./types";

export function ChapterSection({
  chapter,
  index,
  total,
  files,
  id,
  reopened,
  fileId,
  open,
  rated,
  onToggle,
  onLine,
  onFile,
  loadContents,
  comments,
  prUrl,
  reviewed,
  review,
}: {
  chapter: GuideChapter;
  index: number;
  total: number | null;
  files: ReadonlyMap<string, DiffFile>;
  id: string;
  /** Changes when the chapter is unticked, so its cards open again like unticked files. */
  reopened: number;
  fileId: (path: string) => string;
  open: boolean;
  rated: boolean;
  onToggle: () => void;
  onLine: (at: DiffLineRef) => void;
  onFile: (path: string) => void;
  loadContents?: LoadContents | undefined;
  comments?: ((file: DiffFile) => DiffComments | undefined) | undefined;
  prUrl?: string | undefined;
  reviewed?: ReviewedBinding | undefined;
  /** The chapter's Reviewed checkbox; null when nothing in it can be marked. */
  review: ChapterReviewedControl | null;
}) {
  return (
    <section data-guide-chapter="" data-chapter-id={chapter.id} id={id} tabIndex={-1}>
      <ChapterNarration
        chapter={chapter}
        index={index}
        total={total}
        open={open}
        rated={rated}
        onToggle={onToggle}
        onLine={onLine}
        onFile={onFile}
        prUrl={prUrl}
        review={review}
      />
      {open && (
        <div data-chapter-diffs="">
          {chapter.files.map((entry) => {
            const file = files.get(entry.path);
            if (!file) throw new Error(`The snapshot does not contain ${entry.path}.`);
            return (
              <FileDiffCard
                key={entry.path}
                reopened={reopened}
                file={file}
                id={fileId(entry.path)}
                note={entry.note}
                annotations={entry.annotations}
                defaultCollapsed={entry.collapsed || chapter.kind === "generated"}
                loadContents={loadContents}
                comments={comments?.(file)}
                prUrl={prUrl}
                reviewed={
                  reviewed && {
                    state: reviewed.stateOf(file),
                    onChange: (next) => reviewed.set([file], next),
                  }
                }
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
