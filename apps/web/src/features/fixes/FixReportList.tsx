import type { FixerTurn } from "@prkit/contracts";

import { cn } from "~/lib/utils";

import { FIX_STATUS_LABEL, RESOLUTION_LABEL } from "./fixPresentation";

const TONE = {
  fixed: "text-success-foreground",
  partly: "text-warning-foreground",
  skipped: "text-muted-foreground",
  ours: "text-foreground",
  theirs: "text-foreground",
  combined: "text-foreground",
  "needs-human": "text-warning-foreground",
} as const;

/** What the agent did about each comment, or how it resolved each conflicted file. */
export function FixReportList({ turn }: { turn: FixerTurn }) {
  const { work } = turn;
  if (work._tag === "revert") return null;
  if (work._tag === "fix")
    return (
      <ul aria-label="What the agent did" className="mt-3 space-y-2">
        {work.comments.map((comment) => {
          const entry = work.report?.perComment.find((item) => item.commentId === comment.id);
          return (
            <li key={comment.id} className="rounded-md border border-border/60 px-3 py-2 text-xs">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "font-medium",
                    entry ? TONE[entry.status] : "text-muted-foreground",
                  )}
                >
                  {entry ? FIX_STATUS_LABEL[entry.status] : "Not reported yet"}
                </span>
                <span className="min-w-0 truncate font-mono text-muted-foreground">
                  {comment.path}
                  {comment.lines !== null &&
                    ` ${comment.lines.start === comment.lines.end ? `line ${comment.lines.start}` : `lines ${comment.lines.start}-${comment.lines.end}`}`}
                </span>
              </div>
              <p className="mt-1 line-clamp-2 text-muted-foreground">{comment.body}</p>
              {entry && <p className="mt-1 text-foreground">{entry.note}</p>}
            </li>
          );
        })}
      </ul>
    );
  if (work.conflicted.length === 0) return null;
  return (
    <ul aria-label="Conflicted files" className="mt-3 space-y-2">
      {work.conflicted.map((file) => {
        const entry = work.report?.perFile.find((item) => item.path === file.path);
        const resolution = file.needsHuman ? "needs-human" : entry?.resolution;
        return (
          <li key={file.path} className="rounded-md border border-border/60 px-3 py-2 text-xs">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "font-medium",
                  resolution ? TONE[resolution] : "text-muted-foreground",
                )}
              >
                {resolution ? RESOLUTION_LABEL[resolution] : "Not resolved yet"}
              </span>
              <span className="min-w-0 truncate font-mono text-muted-foreground">{file.path}</span>
            </div>
            {file.needsHuman && entry === undefined ? (
              <p className="mt-1 text-foreground">
                prkit kept the base branch's side. A lockfile needs an install, and a binary or
                deleted file needs a person.
              </p>
            ) : (
              entry && <p className="mt-1 text-foreground">{entry.note}</p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
