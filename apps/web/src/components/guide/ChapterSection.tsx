import type { DiffFile } from "@prkit/contracts";

import { FileDiffCard, type DiffComments, type LoadContents } from "~/components/diff";

import { ChapterNarration } from "./ChapterNarration";
import type { ChapterReviewedControl, GuideChapter, LineJump, ReviewedBinding } from "./types";

export function ChapterSection({
  chapter,
  index,
  total,
  files,
  id,
  generation,
  fileId,
  open,
  onToggle,
  onFile,
  jump,
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
  /** Changes when the chapter is unticked, so its cards start over as unticked files. */
  generation: number;
  fileId: (path: string) => string;
  open: boolean;
  onToggle: () => void;
  onFile: (path: string) => void;
  jump: LineJump | null;
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
        onToggle={onToggle}
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
                key={`${generation}:${entry.path}`}
                file={file}
                id={fileId(entry.path)}
                note={entry.note}
                annotations={entry.annotations}
                defaultCollapsed={entry.collapsed || chapter.kind === "generated"}
                loadContents={loadContents}
                comments={comments?.(file)}
                prUrl={prUrl}
                reveal={jump?.path === entry.path ? jump.reveal : null}
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
