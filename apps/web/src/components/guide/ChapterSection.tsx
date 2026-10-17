import type { DiffFile } from "@prkit/contracts";

import { FileDiffCard, type DiffComments, type LoadContents } from "~/components/diff";

import { ChapterNarration } from "./ChapterNarration";
import type { GuideChapter, LineJump } from "./types";

export function ChapterSection({
  chapter,
  index,
  total,
  files,
  id,
  fileId,
  open,
  onToggle,
  onFile,
  jump,
  loadContents,
  comments,
  prUrl,
}: {
  chapter: GuideChapter;
  index: number;
  total: number | null;
  files: ReadonlyMap<string, DiffFile>;
  id: string;
  fileId: (path: string) => string;
  open: boolean;
  onToggle: () => void;
  onFile: (path: string) => void;
  jump: LineJump | null;
  loadContents?: LoadContents | undefined;
  comments?: ((file: DiffFile) => DiffComments | undefined) | undefined;
  prUrl?: string | undefined;
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
      />
      {open && (
        <div data-chapter-diffs="">
          {chapter.files.map((entry) => {
            const file = files.get(entry.path);
            if (!file) throw new Error(`The snapshot does not contain ${entry.path}.`);
            return (
              <FileDiffCard
                key={entry.path}
                file={file}
                id={fileId(entry.path)}
                note={entry.note}
                annotations={entry.annotations}
                defaultCollapsed={entry.collapsed || chapter.kind === "generated"}
                loadContents={loadContents}
                comments={comments?.(file)}
                prUrl={prUrl}
                reveal={jump?.path === entry.path ? jump.reveal : null}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
