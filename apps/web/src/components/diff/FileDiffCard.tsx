import type { DiffFile } from "@prkit/contracts";
import { ChevronDown, ChevronRight, FileCode2 } from "lucide-react";
import { useId, useState } from "react";

import { DiffStat } from "./DiffStat";
import { InlineMarkdown } from "./InlineMarkdown";
import { LazyDiffBody } from "./LazyDiffBody";
import { RenderBoundary } from "./RenderBoundary";
import type { DiffAnnotation, DiffComments, LoadContents, RevealLine } from "./types";
import "./diff.css";

const noAnnotations: ReadonlyArray<DiffAnnotation> = [];

export type FileDiffCardProps = {
  file: DiffFile;
  annotations?: ReadonlyArray<DiffAnnotation>;
  /** Review comments; without them the diff is read-only. */
  comments?: DiffComments | undefined;
  loadContents?: LoadContents | undefined;
  note?: string | null;
  defaultCollapsed?: boolean;
  id?: string;
  prUrl?: string | undefined;
  trailingLines?: number | undefined;
  reveal?: RevealLine | null | undefined;
};

export function FileDiffCard({
  file,
  annotations = noAnnotations,
  comments,
  loadContents,
  note,
  defaultCollapsed = false,
  id,
  prUrl,
  trailingLines,
  reveal = null,
}: FileDiffCardProps) {
  const [open, setOpen] = useState(!defaultCollapsed || reveal !== null);
  const [revealed, setRevealed] = useState(reveal);
  if (reveal !== revealed) {
    setRevealed(reveal);
    if (reveal !== null) setOpen(true);
  }
  const bodyId = useId();
  const risks = annotations.filter((annotation) => annotation.tone === "risk").length;
  const questions = annotations.filter((annotation) => annotation.tone === "question").length;
  return (
    <section
      data-file-diff-card=""
      id={id}
      data-path={file.path}
      data-open={open}
      aria-label={file.path}
      tabIndex={-1}
    >
      <header data-file-diff-header="">
        <button
          type="button"
          data-file-diff-toggle=""
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls={bodyId}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <FileCode2 size={15} />
          <span title={file.path}>{file.path}</span>
        </button>
        <div data-file-diff-meta="">
          {risks > 0 && (
            <span data-diff-tone-count="" data-tone="risk">
              {risks} risk{risks === 1 ? "" : "s"}
            </span>
          )}
          {questions > 0 && (
            <span data-diff-tone-count="" data-tone="question">
              {questions} question{questions === 1 ? "" : "s"}
            </span>
          )}
          {comments !== undefined && comments.count > 0 && (
            <span data-diff-comment-count="">
              {comments.count} comment{comments.count === 1 ? "" : "s"}
            </span>
          )}
          {file.status !== "modified" && (
            <span>{file.status === "removed" ? "deleted" : file.status}</span>
          )}
          <DiffStat additions={file.additions} deletions={file.deletions} />
        </div>
      </header>
      {open && (
        <div id={bodyId} data-file-diff-content="">
          {file.previousPath && <p data-diff-placeholder="">Previously {file.previousPath}</p>}
          {note && (
            <div data-file-diff-note="">
              <InlineMarkdown text={note} prUrl={prUrl} />
            </div>
          )}
          <RenderBoundary
            key={file.patch._tag === "text" ? file.patch.patch : file.patch._tag}
            title={`The diff for ${file.path}`}
          >
            <LazyDiffBody
              file={file}
              annotations={annotations}
              comments={comments}
              loadContents={loadContents}
              trailingLines={trailingLines}
              prUrl={prUrl}
              reveal={reveal}
            />
          </RenderBoundary>
          {comments?.footer}
        </div>
      )}
    </section>
  );
}
